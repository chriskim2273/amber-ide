use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
#[cfg(unix)]
use std::process::Command;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

#[cfg(any(target_os = "linux", test))]
const DAEMON_MEMORY_LOW_BYTES: u64 = 128 * 1024 * 1024;
const DAEMON_CPU_WEIGHT: u64 = 10_000;
const FOREGROUND_CPU_WEIGHT: u64 = 1_000;
const BACKGROUND_CPU_WEIGHT: u64 = 100;
const KILL_TIMEOUT: Duration = Duration::from_secs(2);
const KILL_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CgroupRole {
    Supervisor,
    Workload,
}

/// Sentinel for "no session `memory.high` configured yet" in the atomic.
const SESSION_HIGH_UNSET: u64 = u64::MAX;

#[derive(Debug)]
pub struct CgroupManager {
    root: Option<PathBuf>,
    mount_point: Option<PathBuf>,
    /// Memory containment and CPU weighting are negotiated independently:
    /// missing CPU delegation must never turn off the required memory path.
    cpu_enabled: bool,
    /// A persistent cgroup permission/configuration error must not flood the
    /// daemon log on every focus/input event. A successful full reconciliation
    /// clears this latch so a later regression is still visible once.
    cpu_weight_error_reported: std::sync::atomic::AtomicBool,
    /// Shared with `SetMemoryBudget`'s live update path, which holds only
    /// `&self` — the manager is shared across connection threads. The unset
    /// sentinel is [`SESSION_HIGH_UNSET`] (0 is a REAL value: a test layout's
    /// leaves are written with `memory.high = 0`). Manual `Clone`: the std
    /// atomic integer types do not implement it, and a clone must snapshot
    /// the current ceiling, not reset it to "unset".
    session_high_bytes: std::sync::atomic::AtomicU64,
}

impl Clone for CgroupManager {
    fn clone(&self) -> Self {
        CgroupManager {
            root: self.root.clone(),
            mount_point: self.mount_point.clone(),
            cpu_enabled: self.cpu_enabled,
            cpu_weight_error_reported: std::sync::atomic::AtomicBool::new(
                self.cpu_weight_error_reported
                    .load(std::sync::atomic::Ordering::SeqCst),
            ),
            session_high_bytes: std::sync::atomic::AtomicU64::new(
                self.session_high_bytes
                    .load(std::sync::atomic::Ordering::SeqCst),
            ),
        }
    }
}

#[derive(Debug)]
#[cfg(any(target_os = "linux", test))]
struct CgroupMount {
    root: PathBuf,
    mount_point: PathBuf,
}

#[derive(Debug)]
struct SessionPaths {
    parent: PathBuf,
    supervisor: PathBuf,
    workload: PathBuf,
}

impl SessionPaths {
    fn new(root: &Path, slot: u32) -> io::Result<Self> {
        if slot == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cgroup slot must be at least 1",
            ));
        }
        validate_absolute(root)?;
        let parent = root.join(format!("session-{slot}"));
        Ok(Self {
            supervisor: parent.join("supervisor"),
            workload: parent.join("workload"),
            parent,
        })
    }
}

impl CgroupManager {
    pub fn disabled() -> Self {
        Self {
            root: None,
            mount_point: None,
            cpu_enabled: false,
            cpu_weight_error_reported: std::sync::atomic::AtomicBool::new(false),
            session_high_bytes: std::sync::atomic::AtomicU64::new(SESSION_HIGH_UNSET),
        }
    }

    #[cfg(test)]
    pub(crate) fn test_root(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        fs::create_dir_all(&root).expect("create fake cgroup root");
        Self {
            root: Some(root),
            mount_point: None,
            cpu_enabled: false,
            cpu_weight_error_reported: std::sync::atomic::AtomicBool::new(false),
            session_high_bytes: std::sync::atomic::AtomicU64::new(0),
        }
    }

    #[cfg(test)]
    pub(crate) fn test_root_with_cpu(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        fs::create_dir_all(root.join("_daemon")).expect("create fake cgroup daemon");
        fs::write(root.join("_daemon/cpu.weight"), "").expect("create fake daemon cpu weight");
        Self {
            root: Some(root),
            mount_point: None,
            cpu_enabled: true,
            cpu_weight_error_reported: std::sync::atomic::AtomicBool::new(false),
            session_high_bytes: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn activate() -> Self {
        #[cfg(target_os = "linux")]
        {
            match Self::activate_linux() {
                Ok(manager) => manager,
                Err(error) => {
                    eprintln!("amber: memory containment disabled: {error}");
                    Self::disabled()
                }
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            Self::disabled()
        }
    }

    #[cfg(target_os = "linux")]
    fn activate_linux() -> io::Result<Self> {
        let unified = parse_unified_path(&fs::read_to_string("/proc/self/cgroup")?)?;
        let mount = parse_cgroup2_mount(&fs::read_to_string("/proc/self/mountinfo")?, &unified)?;
        let root = resolve_cgroup_path(&mount, &unified)?;
        Self::activate_at(root, mount.mount_point)
    }

    /// Activate the mandatory memory controller and, when delegated, the
    /// optional CPU controller. Kept path-based so fake cgroup layouts can
    /// exercise the exact activation behavior without touching `/sys`.
    #[cfg(any(target_os = "linux", test))]
    fn activate_at(root: PathBuf, mount_point: PathBuf) -> io::Result<Self> {
        let controllers = fs::read_to_string(root.join("cgroup.controllers"))?;
        if !controllers.split_whitespace().any(|name| name == "memory") {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "delegated cgroup has no memory controller",
            ));
        }

        let daemon = root.join("_daemon");
        match fs::create_dir(&daemon) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        let pid = std::process::id().to_string();
        write_control(&daemon.join("cgroup.procs"), &pid)?;
        let cpu_offered = controllers.split_whitespace().any(|name| name == "cpu");
        let cpu_enabled = if cpu_offered {
            match write_control(&root.join("cgroup.subtree_control"), "+cpu +memory") {
                Ok(()) => true,
                Err(error) => {
                    eprintln!(
                        "amber: optional CPU cgroup delegation unavailable; continuing with memory containment: {error}"
                    );
                    if let Err(memory_error) =
                        write_control(&root.join("cgroup.subtree_control"), "+memory")
                    {
                        if let Err(rollback) = write_control(&root.join("cgroup.procs"), &pid) {
                            eprintln!("amber: cgroup activation rollback failed: {rollback}");
                        }
                        if let Err(cleanup) = fs::remove_dir(&daemon) {
                            eprintln!("amber: cgroup activation cleanup failed: {cleanup}");
                        }
                        return Err(memory_error);
                    }
                    false
                }
            }
        } else if let Err(error) = write_control(&root.join("cgroup.subtree_control"), "+memory") {
            if let Err(rollback) = write_control(&root.join("cgroup.procs"), &pid) {
                eprintln!("amber: cgroup activation rollback failed: {rollback}");
            }
            if let Err(cleanup) = fs::remove_dir(&daemon) {
                eprintln!("amber: cgroup activation cleanup failed: {cleanup}");
            }
            return Err(error);
        } else {
            false
        };
        if let Err(error) = write_control(
            &daemon.join("memory.low"),
            &DAEMON_MEMORY_LOW_BYTES.to_string(),
        ) {
            eprintln!("amber: could not reserve daemon memory.low: {error}");
        }
        let manager = Self {
            root: Some(root),
            mount_point: Some(mount_point),
            cpu_enabled,
            cpu_weight_error_reported: std::sync::atomic::AtomicBool::new(false),
            session_high_bytes: std::sync::atomic::AtomicU64::new(SESSION_HIGH_UNSET),
        };
        if cpu_enabled {
            manager.reconcile_cpu_weights(0);
        }
        Ok(manager)
    }

    pub fn set_session_high_kb(&self, session_high_kb: u64) {
        self.session_high_bytes.store(
            session_high_kb.saturating_mul(1024),
            std::sync::atomic::Ordering::SeqCst,
        );
    }

    fn current_session_high_bytes(&self) -> Option<u64> {
        match self
            .session_high_bytes
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            SESSION_HIGH_UNSET => None,
            value => Some(value),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.root.is_some() && self.mount_point.is_some()
    }

    /// Whether this manager can apply optional CPU weights. This says nothing
    /// about memory containment, which remains governed by [`Self::is_enabled`].
    pub fn cpu_enabled(&self) -> bool {
        self.cpu_enabled
    }

    /// Reapply CPU priority without imposing a CPU quota. The daemon is kept
    /// responsive at 10000, the focused session receives 1000, and every
    /// other session gets 100. Any filesystem/controller failure is strictly
    /// best-effort: session lifecycle and focus/input must continue normally.
    pub fn reconcile_cpu_weights(&self, foreground_slot: u32) {
        if !self.cpu_enabled {
            return;
        }
        let Some(root) = &self.root else {
            return;
        };

        let mut first_error = write_control_nonblocking(
            &root.join("_daemon/cpu.weight"),
            &DAEMON_CPU_WEIGHT.to_string(),
        )
        .err();
        match fs::read_dir(root) {
            Ok(entries) => {
                if let Some(error) = reconcile_session_cpu_weights(
                    entries.map(|entry| entry.map(|entry| (entry.file_name(), entry.path()))),
                    foreground_slot,
                ) {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
            Err(error) if first_error.is_none() => first_error = Some(error),
            Err(_) => {}
        }

        if let Some(error) = first_error {
            if self
                .cpu_weight_error_reported
                .compare_exchange(
                    false,
                    true,
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                )
                .is_ok()
            {
                eprintln!("amber: optional CPU weighting unavailable; continuing: {error}");
            }
        } else {
            self.cpu_weight_error_reported
                .store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }

    pub fn prepare_session(&self, slot: u32) -> io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        if self.mount_point.is_none() {
            #[cfg(test)]
            {
                let fail = root.join(format!(".fail-prepare-{slot}"));
                if fail.exists() {
                    fs::remove_file(fail)?;
                    return Err(io::Error::other("injected cgroup prepare failure"));
                }
            }
            let paths = SessionPaths::new(root, slot)?;
            self.remove_session(slot)?;
            for path in [&paths.parent, &paths.supervisor, &paths.workload] {
                fs::create_dir(path)?;
                fs::write(path.join("cgroup.procs"), "")?;
                fs::write(path.join("cgroup.events"), "populated 0\n")?;
            }
            fs::write(paths.parent.join("cgroup.subtree_control"), "+memory")?;
            fs::write(paths.parent.join("memory.high"), "0")?;
            if self.cpu_enabled {
                fs::write(paths.parent.join("cpu.weight"), "")?;
            }
            return Ok(());
        }
        let high = self.current_session_high_bytes().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "session memory.high is not configured",
            )
        })?;
        let paths = SessionPaths::new(root, slot)?;
        if paths.parent.exists() {
            if !self.kill_session(slot)? {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("session-{slot} cgroup stayed populated"),
                ));
            }
            self.remove_session(slot)?;
        }

        let result = (|| {
            fs::create_dir(&paths.parent)?;
            fs::create_dir(&paths.supervisor)?;
            fs::create_dir(&paths.workload)?;
            write_control(&paths.parent.join("cgroup.subtree_control"), "+memory")?;
            write_control_nonblocking(&paths.parent.join("memory.high"), &high.to_string())
        })();
        if result.is_err() {
            let _ = self.remove_session(slot);
        }
        result
    }

    pub fn aggregate_current_kb(&self) -> io::Result<Option<u64>> {
        self.read_current_kb(self.root.as_deref())
    }

    pub fn lowest_finite_limit_kb(&self) -> io::Result<Option<u64>> {
        let Some(root) = &self.root else {
            return Ok(None);
        };
        let mount_point = self.mount_point.as_deref().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "missing cgroup2 mount boundary")
        })?;
        if !root.starts_with(mount_point) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "cgroup root is outside its mount point",
            ));
        }
        let mut lowest: Option<u64> = None;
        for ancestor in root.ancestors() {
            for control in ["memory.high", "memory.max"] {
                if let Some(bytes) = read_finite_control(&ancestor.join(control))? {
                    lowest = Some(lowest.map_or(bytes, |current| current.min(bytes)));
                }
            }
            if ancestor == mount_point {
                break;
            }
        }
        Ok(lowest.map(|bytes| bytes / 1024))
    }

    pub fn session_current_kb(&self, slot: u32) -> io::Result<Option<u64>> {
        let Some(root) = &self.root else {
            return Ok(None);
        };
        let paths = SessionPaths::new(root, slot)?;
        self.read_current_kb(Some(&paths.parent))
    }

    /// Rewrite an EXISTING session leaf's `memory.high` — the live-budget
    /// path. Unlike [`prepare_session`](Self::prepare_session) this must not
    /// kill or recreate anything: the pane keeps running and only its soft
    /// ceiling moves. Returns `Ok(false)` when there is nothing to write
    /// (containment disabled, or the non-delegated test layout whose leaves
    /// are plain directories).
    pub fn rewrite_session_high(&self, slot: u32) -> io::Result<bool> {
        let Some(root) = &self.root else {
            return Ok(false);
        };
        let Some(high) = self.current_session_high_bytes() else {
            return Ok(false);
        };
        let paths = SessionPaths::new(root, slot)?;
        if !paths.parent.join("cgroup.procs").exists() {
            return Ok(false); // leaf not materialised (dead/unreaped): nothing to move
        }
        write_control_nonblocking(&paths.parent.join("memory.high"), &high.to_string())?;
        Ok(true)
    }

    pub fn kill_workload(&self, slot: u32) -> io::Result<bool> {
        let Some(root) = &self.root else {
            return Ok(false);
        };
        if self.mount_point.is_none() {
            return Ok(false);
        }
        kill_tree(&SessionPaths::new(root, slot)?.workload)
    }

    pub fn kill_session(&self, slot: u32) -> io::Result<bool> {
        let Some(root) = &self.root else {
            return Ok(false);
        };
        if self.mount_point.is_none() {
            return Ok(false);
        }
        kill_tree(&SessionPaths::new(root, slot)?.parent)
    }

    pub fn remove_session(&self, slot: u32) -> io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let paths = SessionPaths::new(root, slot)?;
        if self.mount_point.is_none() {
            for path in [&paths.workload, &paths.supervisor, &paths.parent] {
                if path.exists() {
                    for entry in fs::read_dir(path)? {
                        let entry = entry?;
                        if entry.file_type()?.is_file() {
                            fs::remove_file(entry.path())?;
                        }
                    }
                }
            }
        }
        for path in [&paths.workload, &paths.supervisor, &paths.parent] {
            match fs::remove_dir(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn read_current_kb(&self, path: Option<&Path>) -> io::Result<Option<u64>> {
        let Some(path) = path else {
            return Ok(None);
        };
        match read_u64_control(&path.join("memory.current")) {
            Ok(bytes) => Ok(Some(bytes / 1024)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
}

fn reconcile_session_cpu_weights<I>(entries: I, foreground_slot: u32) -> Option<io::Error>
where
    I: IntoIterator<Item = io::Result<(OsString, PathBuf)>>,
{
    let mut first_error = None;
    for entry in entries {
        let (file_name, path) = match entry {
            Ok(entry) => entry,
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
                continue;
            }
        };
        let Some(slot) = file_name
            .to_str()
            .and_then(|name| name.strip_prefix("session-"))
            .and_then(|slot| slot.parse::<u32>().ok())
            .filter(|slot| *slot > 0)
        else {
            continue;
        };
        let weight = if slot == foreground_slot {
            FOREGROUND_CPU_WEIGHT
        } else {
            BACKGROUND_CPU_WEIGHT
        };
        if let Err(error) =
            write_control_nonblocking(&path.join("cpu.weight"), &weight.to_string())
        {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    first_error
}

/// Move this short-lived launcher into a numeric session leaf, then replace it
/// with the requested process. A placement failure must not lose the pane.
pub fn exec_current_into(slot: u32, role: CgroupRole, command: Vec<OsString>) -> io::Result<()> {
    let Some((program, args)) = command.split_first() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "missing command",
        ));
    };
    #[cfg(target_os = "linux")]
    if let Err(error) = place_current(slot, role) {
        eprintln!("amber: cgroup placement failed; continuing uncontained: {error}");
    }
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        Err(Command::new(program).args(args).exec())
    }
    #[cfg(not(unix))] {
        let _ = (slot, role, program, args);
        Err(io::Error::new(io::ErrorKind::Unsupported, "cgroup process placement is only supported on Linux"))
    }
}

/// Open the workload placement control while the parent may safely allocate
/// and inspect `/proc`. The returned descriptor is written from `pre_exec`,
/// after fork and immediately before the real agent exec.
#[cfg(target_os = "linux")]
pub(crate) fn open_workload_procs_from_current(slot: u32) -> io::Result<Option<File>> {
    let unified = match parse_unified_path(&fs::read_to_string("/proc/self/cgroup")?) {
        Ok(path) => path,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mount = match parse_cgroup2_mount(&fs::read_to_string("/proc/self/mountinfo")?, &unified) {
        Ok(mount) => mount,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let current = resolve_cgroup_path(&mount, &unified)?;
    let Some(workload) = workload_from_current(&current, slot) else {
        return Ok(None);
    };
    OpenOptions::new()
        .write(true)
        .open(workload.join("cgroup.procs"))
        .map(Some)
}

#[cfg(target_os = "linux")]
fn place_current(slot: u32, role: CgroupRole) -> io::Result<()> {
    let unified = parse_unified_path(&fs::read_to_string("/proc/self/cgroup")?)?;
    let mount = parse_cgroup2_mount(&fs::read_to_string("/proc/self/mountinfo")?, &unified)?;
    let current = resolve_cgroup_path(&mount, &unified)?;
    let Some(target) = placement_target(&current, slot, role) else {
        return Ok(());
    };
    if !target.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("missing target cgroup {}", target.display()),
        ));
    }
    write_control(&target.join("cgroup.procs"), "0")
}

#[cfg(any(target_os = "linux", test))]
fn placement_target(current: &Path, slot: u32, role: CgroupRole) -> Option<PathBuf> {
    let service_root = match current.file_name()?.to_str()? {
        "_daemon" => current.parent()?,
        "supervisor" | "workload" => {
            let session = current.parent()?;
            let number = session.file_name()?.to_str()?.strip_prefix("session-")?;
            number.parse::<u32>().ok().filter(|slot| *slot > 0)?;
            session.parent()?
        }
        _ => return None,
    };
    let paths = SessionPaths::new(service_root, slot).ok()?;
    Some(match role {
        CgroupRole::Supervisor => paths.supervisor,
        CgroupRole::Workload => paths.workload,
    })
}

/// Kill the workload sibling of the current Amber supervisor. `None` means
/// this process is not inside the expected delegated session hierarchy.
pub fn kill_workload_from_current(slot: u32) -> io::Result<Option<bool>> {
    #[cfg(target_os = "linux")]
    {
        let cgroup = fs::read_to_string("/proc/self/cgroup")?;
        let unified = match parse_unified_path(&cgroup) {
            Ok(path) => path,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let mountinfo = fs::read_to_string("/proc/self/mountinfo")?;
        let mount = match parse_cgroup2_mount(&mountinfo, &unified) {
            Ok(mount) => mount,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let current = resolve_cgroup_path(&mount, &unified)?;
        let Some(workload) = workload_from_current(&current, slot) else {
            return Ok(None);
        };
        kill_tree(&workload).map(Some)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = slot;
        Ok(None)
    }
}

#[cfg(any(target_os = "linux", test))]
fn workload_from_current(current: &Path, slot: u32) -> Option<PathBuf> {
    if current.file_name()?.to_str()? != "supervisor" {
        return None;
    }
    let session = current.parent()?;
    if session.file_name()?.to_str()? != format!("session-{slot}") {
        return None;
    }
    Some(session.join("workload"))
}

#[cfg(any(target_os = "linux", test))]
fn parse_unified_path(body: &str) -> io::Result<PathBuf> {
    for line in body.lines() {
        let mut fields = line.splitn(3, ':');
        if fields.next() == Some("0") && fields.next() == Some("") {
            let path = PathBuf::from(fields.next().unwrap_or_default());
            validate_absolute(&path)?;
            return Ok(path);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "unified cgroup entry not found",
    ))
}

#[cfg(any(target_os = "linux", test))]
fn parse_cgroup2_mount(body: &str, unified: &Path) -> io::Result<CgroupMount> {
    validate_absolute(unified)?;
    for line in body.lines() {
        let Some((before, after)) = line.split_once(" - ") else {
            continue;
        };
        if after.split_whitespace().next() != Some("cgroup2") {
            continue;
        }
        let fields: Vec<_> = before.split_whitespace().collect();
        if fields.len() < 5 {
            continue;
        }
        let root = PathBuf::from(decode_proc_path(fields[3]));
        let mount_point = PathBuf::from(decode_proc_path(fields[4]));
        validate_absolute(&root)?;
        validate_absolute(&mount_point)?;
        if !unified.starts_with(&root) {
            continue;
        }
        return Ok(CgroupMount { root, mount_point });
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "cgroup2 mount not found",
    ))
}

#[cfg(any(target_os = "linux", test))]
fn resolve_cgroup_path(mount: &CgroupMount, unified: &Path) -> io::Result<PathBuf> {
    validate_absolute(unified)?;
    let relative = unified.strip_prefix(&mount.root).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "unified cgroup is outside the cgroup2 mount root",
        )
    })?;
    validate_relative(relative)?;
    let resolved = mount.mount_point.join(relative);
    validate_absolute(&resolved)?;
    Ok(resolved)
}

fn validate_absolute(path: &Path) -> io::Result<()> {
    let mut components = path.components();
    if components.next() != Some(Component::RootDir)
        || !components.all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsafe cgroup path: {}", path.display()),
        ));
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn validate_relative(path: &Path) -> io::Result<()> {
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsafe relative cgroup path: {}", path.display()),
        ));
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn decode_proc_path(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

fn open_control_nonblocking(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NONBLOCK);
    options.open(path)
}

fn write_control_nonblocking(path: &Path, value: &str) -> io::Result<()> {
    open_control_nonblocking(path)?.write_all(value.as_bytes())
}

fn write_control(path: &Path, value: &str) -> io::Result<()> {
    OpenOptions::new()
        .write(true)
        .open(path)?
        .write_all(value.as_bytes())
}

fn read_u64_control(path: &Path) -> io::Result<u64> {
    let value = fs::read_to_string(path)?;
    value.trim().parse().map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid {} value: {error}", path.display()),
        )
    })
}

fn read_finite_control(path: &Path) -> io::Result<Option<u64>> {
    let value = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if value.trim() == "max" {
        return Ok(None);
    }
    value.trim().parse().map(Some).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid {} value: {error}", path.display()),
        )
    })
}

fn kill_tree(target: &Path) -> io::Result<bool> {
    if !target.exists() {
        return Ok(true);
    }
    let fallback = match write_control(&target.join("cgroup.kill"), "1") {
        Ok(()) => false,
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Err(error) => return Err(error),
    };
    let deadline = Instant::now() + KILL_TIMEOUT;
    loop {
        if fallback && !kill_all_pids(target, deadline)? {
            return Ok(false);
        }
        if !read_populated(target)? {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(KILL_POLL_INTERVAL);
    }
}

fn read_populated(path: &Path) -> io::Result<bool> {
    let body = match fs::read_to_string(path.join("cgroup.events")) {
        Ok(body) => body,
        Err(error) if error.kind() == io::ErrorKind::NotFound && !path.exists() => {
            return Ok(false)
        }
        Err(error) => return Err(error),
    };
    body.lines()
        .find_map(|line| {
            let mut fields = line.split_whitespace();
            (fields.next() == Some("populated")).then(|| fields.next() == Some("1"))
        })
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "missing populated field in {}/cgroup.events",
                    path.display()
                ),
            )
        })
}

#[cfg(target_os = "linux")]
fn kill_all_pids(root: &Path, deadline: Instant) -> io::Result<bool> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        if Instant::now() >= deadline {
            return Ok(false);
        }
        match fs::read_to_string(path.join("cgroup.procs")) {
            Ok(body) => {
                for pid in body
                    .lines()
                    .filter_map(|line| line.trim().parse::<i32>().ok())
                {
                    if Instant::now() >= deadline {
                        return Ok(false);
                    }
                    let result = unsafe { libc::kill(pid, libc::SIGKILL) };
                    if result != 0 {
                        let error = io::Error::last_os_error();
                        if error.raw_os_error() != Some(libc::ESRCH) {
                            return Err(error);
                        }
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        for entry in fs::read_dir(&path)? {
            if Instant::now() >= deadline {
                return Ok(false);
            }
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(Instant::now() < deadline)
}

#[cfg(not(target_os = "linux"))]
fn kill_all_pids(_root: &Path, _deadline: Instant) -> io::Result<bool> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "cgroup process termination is only supported on Linux"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn fake_delegated_root(root: &Path, controllers: &str) {
        fs::create_dir_all(root.join("_daemon")).unwrap();
        fs::write(root.join("cgroup.controllers"), controllers).unwrap();
        fs::write(root.join("cgroup.subtree_control"), "").unwrap();
        fs::write(root.join("cgroup.procs"), "").unwrap();
        fs::write(root.join("_daemon/cgroup.procs"), "").unwrap();
        fs::write(root.join("_daemon/cpu.weight"), "").unwrap();
    }

    #[test]
    fn parses_only_the_unified_cgroup_entry() {
        let body = "11:memory:/legacy\n0::/user.slice/user-1000.slice/user@1000.service/app.slice/amber.service\n";
        assert_eq!(
            parse_unified_path(body).unwrap(),
            PathBuf::from("/user.slice/user-1000.slice/user@1000.service/app.slice/amber.service")
        );
    }

    #[test]
    fn rejects_parent_and_non_normal_components() {
        assert!(validate_relative(Path::new("../escape")).is_err());
        assert!(validate_relative(Path::new("session-1/../../escape")).is_err());
    }

    #[test]
    fn slot_paths_never_include_session_names() {
        let paths = SessionPaths::new(Path::new("/sys/fs/cgroup/x"), 7).unwrap();
        assert_eq!(paths.parent, PathBuf::from("/sys/fs/cgroup/x/session-7"));
        assert_eq!(paths.supervisor, paths.parent.join("supervisor"));
        assert_eq!(paths.workload, paths.parent.join("workload"));
    }

    #[test]
    fn launcher_derives_only_supported_service_roots_and_numeric_targets() {
        let service = Path::new("/run/cgroup/user.slice/amber.service");
        assert_eq!(
            placement_target(&service.join("_daemon"), 7, CgroupRole::Workload).unwrap(),
            service.join("session-7/workload")
        );
        assert_eq!(
            placement_target(
                &service.join("session-4/supervisor"),
                7,
                CgroupRole::Supervisor,
            )
            .unwrap(),
            service.join("session-7/supervisor")
        );
        assert!(placement_target(service, 7, CgroupRole::Workload).is_none());
        assert!(
            placement_target(&service.join("other/supervisor"), 7, CgroupRole::Workload,).is_none()
        );
    }

    #[test]
    fn workload_kill_target_requires_the_matching_supervisor_slot() {
        let service = Path::new("/run/cgroup/amber.service");
        assert_eq!(
            workload_from_current(&service.join("session-7/supervisor"), 7),
            Some(service.join("session-7/workload"))
        );
        assert!(workload_from_current(&service.join("session-7/supervisor"), 8).is_none());
        assert!(workload_from_current(&service.join("session-7/workload"), 7).is_none());
        assert!(workload_from_current(&service.join("_daemon"), 7).is_none());
    }

    #[test]
    fn fake_root_accounts_for_session_directories_without_claiming_kernel_support() {
        let temp = tempfile::tempdir().unwrap();
        let manager = CgroupManager::test_root(temp.path());
        assert!(!manager.is_enabled());

        manager.prepare_session(3).unwrap();
        assert!(temp.path().join("session-3/supervisor").is_dir());
        assert!(temp.path().join("session-3/workload").is_dir());
        assert!(!manager.kill_session(3).unwrap());

        manager.remove_session(3).unwrap();
        assert!(!temp.path().join("session-3").exists());
    }

    #[test]
    fn memory_delegation_stays_active_when_cpu_is_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        fake_delegated_root(temp.path(), "memory pids");

        let manager =
            CgroupManager::activate_at(temp.path().to_path_buf(), temp.path().to_path_buf())
                .unwrap();

        assert!(
            manager.is_enabled(),
            "memory containment must remain active"
        );
        assert!(!manager.cpu_enabled(), "CPU weighting is optional");
        assert_eq!(
            fs::read_to_string(temp.path().join("cgroup.subtree_control")).unwrap(),
            "+memory",
        );
    }

    #[test]
    fn cpu_delegation_enables_weights_and_prioritizes_the_foreground_slot() {
        let temp = tempfile::tempdir().unwrap();
        fake_delegated_root(temp.path(), "cpu memory pids");

        let manager =
            CgroupManager::activate_at(temp.path().to_path_buf(), temp.path().to_path_buf())
                .unwrap();
        assert!(manager.is_enabled());
        assert!(manager.cpu_enabled());
        assert_eq!(
            fs::read_to_string(temp.path().join("cgroup.subtree_control")).unwrap(),
            "+cpu +memory",
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("_daemon/cpu.weight")).unwrap(),
            "10000",
        );

        let weights = CgroupManager::test_root_with_cpu(temp.path());
        weights.prepare_session(1).unwrap();
        weights.prepare_session(2).unwrap();
        weights.reconcile_cpu_weights(2);

        assert_eq!(
            fs::read_to_string(temp.path().join("session-1/cpu.weight")).unwrap(),
            "100",
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("session-2/cpu.weight")).unwrap(),
            "1000",
        );
    }

    #[test]
    fn cpu_weight_reconcile_reports_directory_entry_errors() {
        let temp = tempfile::tempdir().unwrap();
        let session = temp.path().join("session-1");
        fs::create_dir(&session).unwrap();
        fs::write(session.join("cpu.weight"), "").unwrap();

        let error = reconcile_session_cpu_weights(
            [
                Ok((OsString::from("session-1"), session.clone())),
                Err(io::Error::other("broken read_dir entry")),
            ],
            1,
        )
        .expect("directory entry errors must be reported");

        assert_eq!(error.to_string(), "broken read_dir entry");
        assert_eq!(
            fs::read_to_string(session.join("cpu.weight")).unwrap(),
            "1000",
            "valid entries must still be reconciled before reporting the diagnostic",
        );
    }

    #[test]
    fn resolves_cgroup2_mount_without_assuming_sys_fs_cgroup() {
        let mountinfo = "31 22 0:27 / /run/cgroup rw,nosuid,nodev,noexec - cgroup2 cgroup rw\n";
        let unified = Path::new("/user.slice/amber.service");
        let mount = parse_cgroup2_mount(mountinfo, unified).unwrap();
        assert_eq!(
            resolve_cgroup_path(&mount, unified).unwrap(),
            PathBuf::from("/run/cgroup/user.slice/amber.service"),
        );
    }

    #[test]
    fn selects_the_cgroup2_mount_whose_root_contains_the_unified_path() {
        let mountinfo = concat!(
            "31 22 0:27 /other /wrong rw - cgroup2 cgroup rw\n",
            "32 22 0:28 /user.slice /right rw - cgroup2 cgroup rw\n",
        );
        let unified = Path::new("/user.slice/amber.service");
        let mount = parse_cgroup2_mount(mountinfo, unified).unwrap();
        assert_eq!(
            resolve_cgroup_path(&mount, unified).unwrap(),
            PathBuf::from("/right/amber.service"),
        );
    }

    #[test]
    fn resolves_mount_root_prefix_and_proc_escapes() {
        let mountinfo = "31 22 0:27 /user.slice /run/cgroup\\040v2 rw - cgroup2 cgroup rw\n";
        let unified = Path::new("/user.slice/amber.service");
        let mount = parse_cgroup2_mount(mountinfo, unified).unwrap();
        assert_eq!(
            resolve_cgroup_path(&mount, unified).unwrap(),
            PathBuf::from("/run/cgroup v2/amber.service"),
        );
        assert!(resolve_cgroup_path(&mount, Path::new("/other/amber.service")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn memory_high_writer_is_nonblocking() {
        use std::os::fd::AsRawFd;

        let file = tempfile::NamedTempFile::new().unwrap();
        let opened = open_control_nonblocking(file.path()).unwrap();
        let flags = unsafe { nix::libc::fcntl(opened.as_raw_fd(), nix::libc::F_GETFL) };
        assert_ne!(flags & nix::libc::O_NONBLOCK, 0);
    }

    #[test]
    fn reads_the_lowest_finite_ancestor_limit() {
        let temp = tempfile::tempdir().unwrap();
        let service = temp.path().join("parent/service");
        std::fs::create_dir_all(&service).unwrap();
        std::fs::write(temp.path().join("memory.high"), "max\n").unwrap();
        std::fs::write(temp.path().join("memory.max"), "8388608\n").unwrap();
        std::fs::write(temp.path().join("parent/memory.high"), "4194304\n").unwrap();
        std::fs::write(temp.path().join("parent/memory.max"), "max\n").unwrap();
        std::fs::write(service.join("memory.high"), "6291456\n").unwrap();
        std::fs::write(service.join("memory.max"), "max\n").unwrap();

        let manager = CgroupManager {
            root: Some(service),
            mount_point: Some(temp.path().to_path_buf()),
            cpu_enabled: false,
            cpu_weight_error_reported: std::sync::atomic::AtomicBool::new(false),
            session_high_bytes: std::sync::atomic::AtomicU64::new(SESSION_HIGH_UNSET),
        };
        assert_eq!(manager.lowest_finite_limit_kb().unwrap(), Some(4096));
    }

    #[test]
    fn finite_limit_scan_stops_at_the_cgroup2_mount_point() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("mount");
        let service = mount.join("parent/service");
        std::fs::create_dir_all(&service).unwrap();
        std::fs::write(temp.path().join("memory.max"), "1048576\n").unwrap();
        std::fs::write(mount.join("memory.max"), "8388608\n").unwrap();
        std::fs::write(mount.join("memory.high"), "max\n").unwrap();
        std::fs::write(mount.join("parent/memory.high"), "4194304\n").unwrap();
        std::fs::write(mount.join("parent/memory.max"), "max\n").unwrap();
        std::fs::write(service.join("memory.high"), "6291456\n").unwrap();
        std::fs::write(service.join("memory.max"), "max\n").unwrap();

        let manager = CgroupManager {
            root: Some(service),
            mount_point: Some(mount),
            cpu_enabled: false,
            cpu_weight_error_reported: std::sync::atomic::AtomicBool::new(false),
            session_high_bytes: std::sync::atomic::AtomicU64::new(SESSION_HIGH_UNSET),
        };
        assert_eq!(manager.lowest_finite_limit_kb().unwrap(), Some(4096));
    }

    #[test]
    fn fallback_pid_traversal_honors_an_expired_deadline() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("cgroup.procs"), "2147483647\n").unwrap();
        assert!(!kill_all_pids(temp.path(), Instant::now()).unwrap());
    }

    #[test]
    fn disabled_manager_is_harmless_and_unconfigured_prepare_fails_closed() {
        let disabled = CgroupManager::disabled();
        assert!(!disabled.is_enabled());
        assert_eq!(disabled.aggregate_current_kb().unwrap(), None);
        assert_eq!(disabled.session_current_kb(1).unwrap(), None);
        assert!(!disabled.kill_workload(1).unwrap());
        assert!(!disabled.kill_session(1).unwrap());
        disabled.remove_session(1).unwrap();
        disabled.prepare_session(1).unwrap();

        let temp = tempfile::tempdir().unwrap();
        let enabled = CgroupManager {
            root: Some(temp.path().to_path_buf()),
            mount_point: Some(temp.path().to_path_buf()),
            cpu_enabled: false,
            cpu_weight_error_reported: std::sync::atomic::AtomicBool::new(false),
            session_high_bytes: std::sync::atomic::AtomicU64::new(SESSION_HIGH_UNSET),
        };
        assert!(enabled.prepare_session(1).is_err());
        assert!(!temp.path().join("session-1").exists());
    }
}
