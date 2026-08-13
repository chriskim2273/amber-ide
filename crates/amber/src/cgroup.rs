use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const DAEMON_MEMORY_LOW_BYTES: u64 = 128 * 1024 * 1024;
const KILL_TIMEOUT: Duration = Duration::from_secs(2);
const KILL_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CgroupRole {
    Supervisor,
    Workload,
}

#[derive(Clone, Debug)]
pub struct CgroupManager {
    root: Option<PathBuf>,
    session_high_bytes: Option<u64>,
}

#[derive(Debug)]
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
            session_high_bytes: None,
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
        let mount = parse_cgroup2_mount(&fs::read_to_string("/proc/self/mountinfo")?)?;
        let root = resolve_cgroup_path(&mount, &unified)?;
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
        if let Err(error) = write_control(&root.join("cgroup.subtree_control"), "+memory") {
            if let Err(rollback) = write_control(&root.join("cgroup.procs"), &pid) {
                eprintln!("amber: cgroup activation rollback failed: {rollback}");
            }
            if let Err(cleanup) = fs::remove_dir(&daemon) {
                eprintln!("amber: cgroup activation cleanup failed: {cleanup}");
            }
            return Err(error);
        }
        if let Err(error) = write_control(
            &daemon.join("memory.low"),
            &DAEMON_MEMORY_LOW_BYTES.to_string(),
        ) {
            eprintln!("amber: could not reserve daemon memory.low: {error}");
        }
        Ok(Self {
            root: Some(root),
            session_high_bytes: None,
        })
    }

    pub fn set_session_high_kb(&mut self, session_high_kb: u64) {
        self.session_high_bytes = Some(session_high_kb.saturating_mul(1024));
    }

    pub fn is_enabled(&self) -> bool {
        self.root.is_some()
    }

    pub fn prepare_session(&self, slot: u32) -> io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let high = self.session_high_bytes.ok_or_else(|| {
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
        let mut lowest: Option<u64> = None;
        for ancestor in root.ancestors() {
            for control in ["memory.high", "memory.max"] {
                if let Some(bytes) = read_finite_control(&ancestor.join(control))? {
                    lowest = Some(lowest.map_or(bytes, |current| current.min(bytes)));
                }
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

    pub fn kill_workload(&self, slot: u32) -> io::Result<bool> {
        let Some(root) = &self.root else {
            return Ok(true);
        };
        kill_tree(&SessionPaths::new(root, slot)?.workload)
    }

    pub fn kill_session(&self, slot: u32) -> io::Result<bool> {
        let Some(root) = &self.root else {
            return Ok(true);
        };
        kill_tree(&SessionPaths::new(root, slot)?.parent)
    }

    pub fn remove_session(&self, slot: u32) -> io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let paths = SessionPaths::new(root, slot)?;
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

fn parse_cgroup2_mount(body: &str) -> io::Result<CgroupMount> {
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
        return Ok(CgroupMount { root, mount_point });
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "cgroup2 mount not found",
    ))
}

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
        if fallback {
            kill_all_pids(target)?;
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

fn kill_all_pids(root: &Path) -> io::Result<()> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        match fs::read_to_string(path.join("cgroup.procs")) {
            Ok(body) => {
                for pid in body
                    .lines()
                    .filter_map(|line| line.trim().parse::<i32>().ok())
                {
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
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

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
    fn resolves_cgroup2_mount_without_assuming_sys_fs_cgroup() {
        let mountinfo = "31 22 0:27 / /run/cgroup rw,nosuid,nodev,noexec - cgroup2 cgroup rw\n";
        let mount = parse_cgroup2_mount(mountinfo).unwrap();
        assert_eq!(
            resolve_cgroup_path(&mount, Path::new("/user.slice/amber.service")).unwrap(),
            PathBuf::from("/run/cgroup/user.slice/amber.service"),
        );
    }

    #[test]
    fn resolves_mount_root_prefix_and_proc_escapes() {
        let mountinfo = "31 22 0:27 /user.slice /run/cgroup\\040v2 rw - cgroup2 cgroup rw\n";
        let mount = parse_cgroup2_mount(mountinfo).unwrap();
        assert_eq!(
            resolve_cgroup_path(&mount, Path::new("/user.slice/amber.service")).unwrap(),
            PathBuf::from("/run/cgroup v2/amber.service"),
        );
        assert!(resolve_cgroup_path(&mount, Path::new("/other/amber.service")).is_err());
    }

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
            session_high_bytes: None,
        };
        assert_eq!(manager.lowest_finite_limit_kb().unwrap(), Some(4096));
    }

    #[test]
    fn disabled_manager_is_harmless_and_unconfigured_prepare_fails_closed() {
        let disabled = CgroupManager::disabled();
        assert!(!disabled.is_enabled());
        assert_eq!(disabled.aggregate_current_kb().unwrap(), None);
        assert_eq!(disabled.session_current_kb(1).unwrap(), None);
        assert!(disabled.kill_workload(1).unwrap());
        assert!(disabled.kill_session(1).unwrap());
        disabled.remove_session(1).unwrap();
        disabled.prepare_session(1).unwrap();

        let temp = tempfile::tempdir().unwrap();
        let enabled = CgroupManager {
            root: Some(temp.path().to_path_buf()),
            session_high_bytes: None,
        };
        assert!(enabled.prepare_session(1).is_err());
        assert!(!temp.path().join("session-1").exists());
    }
}
