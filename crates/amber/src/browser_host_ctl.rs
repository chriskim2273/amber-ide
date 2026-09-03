use std::fs;
use std::io;
#[cfg(unix)]
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

pub const LAUNCHER_FILE: &str = "browser-host-launcher.json";
pub const INHIBIT_FILE: &str = "browser-host-inhibit";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LauncherRecord {
    pub version: u32,
    pub executable: String,
    pub args: Vec<String>,
    pub install_generation: String,
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_uid: Option<u32>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HostState {
    Ready,
    Stopped,
    Inhibited,
    Unregistered,
    Unsupported,
}

#[derive(Clone, Debug, Serialize)]
pub struct HostStatus {
    pub state: HostState,
    pub ready: bool,
    pub inhibited: bool,
    pub registered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unsupported"
    }
}

#[cfg(unix)]
pub fn current_uid() -> Option<u32> {
    // SAFETY: geteuid has no preconditions and does not retain pointers.
    Some(unsafe { libc::geteuid() })
}
#[cfg(not(unix))]
pub fn current_uid() -> Option<u32> {
    None
}

#[cfg(unix)]
fn private_directory(path: &Path) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let Ok(metadata) = fs::symlink_metadata(path) else { return false };
    metadata.file_type().is_dir()
        && !metadata.file_type().is_symlink()
        && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.permissions().mode() & 0o777 == 0o700
}

#[cfg(unix)]
fn private_file(path: &Path) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let Ok(metadata) = fs::symlink_metadata(path) else { return false };
    metadata.file_type().is_file()
        && !metadata.file_type().is_symlink()
        && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.permissions().mode() & 0o077 == 0
}

fn socket_ready(root: &Path, socket: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        let token_path = root.join("browser-host-token");
        let Some(socket_parent) = socket.parent() else { return false };
        if !private_directory(root) || !private_directory(socket_parent) || !private_file(&token_path) { return false; }
        let Ok(endpoint) = fs::symlink_metadata(socket) else { return false };
        if endpoint.file_type().is_symlink() || !endpoint.file_type().is_socket() || endpoint.uid() != unsafe { libc::geteuid() } { return false; }
        let Ok(token) = fs::read_to_string(token_path) else {
            return false;
        };
        let token = token.trim();
        if token.len() != 43
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return false;
        }
        let Ok(mut stream) = std::os::unix::net::UnixStream::connect(socket) else {
            return false;
        };
        let timeout = Some(Duration::from_millis(250));
        if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
            return false;
        }
        let Ok(body) = serde_json::to_vec(&serde_json::json!({ "token": token })) else {
            return false;
        };
        if body.len() > u32::MAX as usize
            || stream
                .write_all(&(body.len() as u32).to_be_bytes())
                .is_err()
            || stream.write_all(&body).is_err()
        {
            return false;
        }
        let mut prefix = [0_u8; 4];
        if stream.read_exact(&mut prefix).is_err() {
            return false;
        }
        let length = u32::from_be_bytes(prefix) as usize;
        if length == 0 || length > 1024 {
            return false;
        }
        let mut reply = vec![0_u8; length];
        stream.read_exact(&mut reply).is_ok()
            && serde_json::from_slice::<serde_json::Value>(&reply)
                .ok()
                .and_then(|value| value.get("ok").and_then(serde_json::Value::as_bool))
                .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = (root, socket);
        false
    }
}

#[cfg(unix)]
fn validate_executable_path(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let uid = unsafe { libc::geteuid() };
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 || metadata.permissions().mode() & 0o022 != 0 {
        bail!("registered app must be a regular executable and not group/world-writable");
    }
    if metadata.uid() != uid && metadata.uid() != 0 {
        bail!("registered app must be owned by the current user or trusted root");
    }
    let mut parent = path.parent();
    while let Some(directory) = parent {
        let value = fs::symlink_metadata(directory)?;
        if value.file_type().is_symlink() || !value.is_dir() || (value.uid() != uid && value.uid() != 0) {
            bail!("registered app has an unsafe parent directory");
        }
        let mode = value.permissions().mode() & 0o777;
        if mode & 0o022 != 0 { bail!("registered app has a group/world-writable parent directory"); }
        if value.uid() == uid && mode == 0o700 { break; }
        parent = directory.parent();
    }
    let text = path.to_string_lossy();
    if platform_name() == "darwin" && !text.contains(".app/Contents/MacOS/") {
        bail!("registered macOS app must be inside an app bundle");
    }
    if platform_name() == "linux" && text.contains(".app/Contents/MacOS/") {
        bail!("registered Linux app has a macOS bundle path");
    }
    Ok(())
}

pub fn load_launcher(root: &Path) -> anyhow::Result<LauncherRecord> {
    if platform_name() == "unsupported" {
        bail!("BROWSER_HOST_UNSUPPORTED: browser host launching is not supported on Windows");
    }
    #[cfg(unix)]
    if !private_directory(root) {
        bail!("browser host state directory must be current-user owned mode 0700 and not a symlink");
    }
    let path = root.join(LAUNCHER_FILE);
    let metadata = fs::symlink_metadata(&path).with_context(|| {
        "browser host is not registered; open Amber once or install the desktop app"
    })?;
    if !metadata.file_type().is_file() {
        bail!("browser host launcher registration is not a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            bail!("browser host launcher registration has unsafe ownership or permissions");
        }
    }
    let bytes = fs::read(&path)?;
    if bytes.len() > 16 * 1024 {
        bail!("browser host launcher registration is oversized");
    }
    let record: LauncherRecord =
        serde_json::from_slice(&bytes).context("browser host launcher registration is invalid")?;
    if record.version != 1
        || record.platform != platform_name()
        || record.args != ["--browser-host"]
        || record.install_generation.is_empty()
        || record.install_generation.len() > 128
    {
        bail!("browser host launcher registration is invalid");
    }
    if record.owner_uid.is_none() || record.owner_uid != current_uid() {
        bail!("browser host launcher registration belongs to another user or lacks owner identity");
    }
    let configured = PathBuf::from(&record.executable);
    if !configured.is_absolute() || record.executable.len() > 4096 {
        bail!("registered app path is invalid");
    }
    let canonical = configured
        .canonicalize()
        .context("registered app is missing; open Amber once or reinstall the desktop app")?;
    if canonical != configured || record.executable.contains("/.mount_") {
        bail!("registered app path is stale or ephemeral; open the installed Amber app once");
    }
    #[cfg(unix)]
    validate_executable_path(&canonical)?;
    Ok(record)
}

pub fn launch_argv(record: &LauncherRecord) -> (&Path, &[String]) {
    (Path::new(&record.executable), &record.args)
}

pub fn status(root: &Path, socket: &Path) -> HostStatus {
    if platform_name() == "unsupported" {
        return HostStatus {
            state: HostState::Unsupported,
            ready: false,
            inhibited: false,
            registered: false,
            detail: Some("BROWSER_HOST_UNSUPPORTED".into()),
        };
    }
    let inhibited = root.join(INHIBIT_FILE).exists();
    let registration = load_launcher(root);
    let registered = registration.is_ok();
    let ready = socket_ready(root, socket);
    let (state, detail) = if inhibited {
        (HostState::Inhibited, Some("browser host was explicitly stopped; run `amber ctl browser-host enable` or open Amber normally".into()))
    } else if ready {
        (HostState::Ready, None)
    } else if !registered {
        (
            HostState::Unregistered,
            Some(registration.unwrap_err().to_string()),
        )
    } else {
        (HostState::Stopped, None)
    };
    HostStatus {
        state,
        ready,
        inhibited,
        registered,
        detail,
    }
}

pub fn enable(root: &Path) -> anyhow::Result<()> {
    enable_for_platform(root, platform_name())
}

fn enable_for_platform(root: &Path, platform: &str) -> anyhow::Result<()> {
    if platform == "unsupported" {
        bail!("BROWSER_HOST_UNSUPPORTED: browser host launching is not supported on Windows");
    }
    #[cfg(unix)]
    if !private_directory(root) {
        bail!("browser host state directory must be current-user owned mode 0700 and not a symlink");
    }
    match fs::remove_file(root.join(INHIBIT_FILE)) {
        Ok(()) => {
            fs::File::open(root)?.sync_all()?;
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn spawn_registered(record: &LauncherRecord) -> anyhow::Result<()> {
    let (program, args) = launch_argv(record);
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("could not launch the registered Amber desktop app")?;
    Ok(())
}

fn ensure_with(
    root: &Path,
    socket: &Path,
    timeout: Duration,
    launch: impl FnOnce(&LauncherRecord) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    if root.join(INHIBIT_FILE).exists() {
        bail!("BROWSER_HOST_INHIBITED: browser host was explicitly stopped; run `amber ctl browser-host enable` or open Amber normally");
    }
    if socket_ready(root, socket) {
        return Ok(());
    }
    let record = load_launcher(root)?;
    launch(&record)?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if socket_ready(root, socket) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    bail!("BROWSER_HOST_UNAVAILABLE: Amber launched but the browser host did not become ready; open Amber and retry")
}

pub fn ensure(root: &Path, socket: &Path, timeout: Duration) -> anyhow::Result<()> {
    ensure_with(root, socket, timeout, spawn_registered)
}

#[cfg(test)]
mod tests {
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::path::Path;
    #[cfg(unix)]
    use std::time::Duration;

    use super::*;

    #[cfg(unix)]
    fn secure_root(path: &Path) {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[cfg(unix)]
    fn executable(path: &Path) {
        fs::write(path, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[cfg(unix)]
    fn write_record(root: &Path, executable: &Path) {
        let record = LauncherRecord {
            version: 1,
            executable: executable
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            args: vec!["--browser-host".into()],
            install_generation: "1.2.3".into(),
            platform: platform_name().into(),
            owner_uid: current_uid(),
        };
        let path = root.join(LAUNCHER_FILE);
        fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn validates_private_owned_registration_and_separate_argv() {
        let dir = tempfile::tempdir().unwrap();
        secure_root(dir.path());
        let exe = dir.path().join("Amber IDE");
        executable(&exe);
        write_record(dir.path(), &exe);
        let loaded = load_launcher(dir.path()).unwrap();
        assert_eq!(
            launch_argv(&loaded),
            (
                exe.canonicalize().unwrap().as_path(),
                &["--browser-host".to_string()][..]
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_writable_executable_and_parent_paths() {
        let dir = tempfile::tempdir().unwrap(); secure_root(dir.path());
        let executable_path = dir.path().join("amber"); executable(&executable_path); write_record(dir.path(), &executable_path);
        fs::set_permissions(&executable_path, fs::Permissions::from_mode(0o722)).unwrap();
        assert!(load_launcher(dir.path()).unwrap_err().to_string().contains("group/world-writable"));

        let unsafe_parent = dir.path().join("unsafe"); fs::create_dir(&unsafe_parent).unwrap();
        fs::set_permissions(&unsafe_parent, fs::Permissions::from_mode(0o777)).unwrap();
        let nested = unsafe_parent.join("amber"); executable(&nested); write_record(dir.path(), &nested);
        assert!(load_launcher(dir.path()).unwrap_err().to_string().contains("writable parent"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_inhibit_stale_paths_and_unsafe_registration_permissions() {
        let dir = tempfile::tempdir().unwrap();
        secure_root(dir.path());
        fs::write(dir.path().join(INHIBIT_FILE), "stopped").unwrap();
        assert_eq!(
            status(dir.path(), Path::new("missing.sock")).state,
            HostState::Inhibited
        );
        fs::remove_file(dir.path().join(INHIBIT_FILE)).unwrap();
        let launcher = dir.path().join(LAUNCHER_FILE);
        fs::write(&launcher, format!(r#"{{"version":1,"executable":"/missing","args":["--browser-host"],"installGeneration":"x","platform":"{}","ownerUid":{}}}"#, platform_name(), current_uid().unwrap())).unwrap();
        #[cfg(unix)]
        {
            fs::set_permissions(&launcher, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(load_launcher(dir.path())
                .unwrap_err()
                .to_string()
                .contains("unsafe ownership or permissions"));
            fs::set_permissions(&launcher, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(load_launcher(dir.path())
            .unwrap_err()
            .to_string()
            .contains("registered app"));
    }

    #[cfg(unix)]
    #[test]
    fn enable_only_clears_the_explicit_stop_inhibit() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        secure_root(dir.path());
        fs::write(dir.path().join(INHIBIT_FILE), "stopped").unwrap();
        enable_for_platform(dir.path(), "linux").unwrap();
        assert!(!dir.path().join(INHIBIT_FILE).exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_enable_is_unsupported_without_mutating_the_inhibit() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(INHIBIT_FILE), "stopped").unwrap();
        let error = enable(dir.path()).unwrap_err();
        assert!(error.to_string().contains("BROWSER_HOST_UNSUPPORTED"));
        assert_eq!(fs::read_to_string(dir.path().join(INHIBIT_FILE)).unwrap(), "stopped");
    }

    #[test]
    fn unsupported_enable_fails_before_mutating_the_inhibit() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        secure_root(dir.path());
        fs::write(dir.path().join(INHIBIT_FILE), "stopped").unwrap();
        let error = enable_for_platform(dir.path(), "unsupported").unwrap_err();
        assert!(error.to_string().contains("BROWSER_HOST_UNSUPPORTED"));
        assert!(dir.path().join(INHIBIT_FILE).exists());
    }

    #[cfg(unix)]
    #[test]
    fn runtime_directory_rejects_symlinks_and_non_private_modes() {
        let dir = tempfile::tempdir().unwrap(); secure_root(dir.path());
        assert!(private_directory(dir.path()));
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o770)).unwrap();
        assert!(!private_directory(dir.path()));
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let link = dir.path().with_extension("link"); std::os::unix::fs::symlink(dir.path(), &link).unwrap();
        assert!(!private_directory(&link)); fs::remove_file(link).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn ensure_launches_fake_executable_and_waits_for_readiness() {
        use std::os::unix::net::UnixListener;
        let dir = tempfile::tempdir().unwrap();
        secure_root(dir.path());
        let socket = dir.path().join("ready.sock");
        let exe = dir.path().join("fake app");
        executable(&exe);
        write_record(dir.path(), &exe);
        let token = dir.path().join("browser-host-token");
        fs::write(&token, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n").unwrap();
        fs::set_permissions(&token, fs::Permissions::from_mode(0o600)).unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen_launch = seen.clone();
        let mut server = None;
        ensure_with(dir.path(), &socket, Duration::from_millis(500), |record| {
            *seen_launch.lock().unwrap() = record.args.clone();
            let listener = UnixListener::bind(&socket).unwrap();
            server = Some(std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut prefix = [0_u8; 4];
                stream.read_exact(&mut prefix).unwrap();
                let mut request = vec![0_u8; u32::from_be_bytes(prefix) as usize];
                stream.read_exact(&mut request).unwrap();
                let reply = br#"{"ok":true}"#;
                stream
                    .write_all(&(reply.len() as u32).to_be_bytes())
                    .unwrap();
                stream.write_all(reply).unwrap();
            }));
            Ok(())
        })
        .unwrap();
        server.unwrap().join().unwrap();
        assert_eq!(*seen.lock().unwrap(), vec!["--browser-host"]);
    }
}
