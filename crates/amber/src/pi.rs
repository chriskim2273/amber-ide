//! Pi supervision helpers: build resume/fresh argv and install the global
//! extension that records the exact session file. Pure/testable; the supervisor
//! loop lives in `supervisor`.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// How to start Pi: reopen an exact recorded conversation file, or begin a
/// new one. A bare session id is deliberately not enough: Pi accepts id
/// prefixes and forked sessions can make that lookup ambiguous.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PiStart {
    Resume(String),
    Fresh,
}

/// The extension filename amber owns under Pi's global extensions directory.
const EXTENSION_FILE: &str = "amber-hook.ts";

/// The Pi extension amber installs to record the exact parent session file.
/// Pi emits `reason: quit` for signals too. Observe TERM/HUP separately and
/// let signal dispatch finish before interpreting shutdown as a deliberate quit.
const EXTENSION_TS: &str = r#"import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { spawn } from "node:child_process"

export default function (pi: ExtensionAPI) {
  let signalled = false
  const signals = process.platform === "win32" ? ["SIGTERM"] as const : ["SIGTERM", "SIGHUP"] as const
  const onSignal = () => { signalled = true }
  const report = async (event: string, ctx: ExtensionContext) => {
    if (!process.env.AMBER_SESSION) return
    const session_id = ctx.sessionManager.getSessionId()
    const session_file = ctx.sessionManager.getSessionFile()
    if (!session_id || !session_file) return
    await new Promise<void>((resolve) => {
      const child = spawn(process.env.AMBER_BIN || "amber", ["hook"], {
        stdio: ["pipe", "ignore", "ignore"],
      })
      const timer = setTimeout(() => { child.kill(); resolve() }, 4000)
      const done = () => { clearTimeout(timer); resolve() }
      child.on("error", done)
      child.on("close", done)
      child.stdin.on("error", done)
      child.stdin.end(JSON.stringify({
        event, agent_kind: "pi", session_id, session_file,
        cwd: ctx.cwd, pid: process.pid,
      }))
    })
  }

  pi.on("session_start", async (_event, ctx) => {
    for (const signal of signals) process.on(signal, onSignal)
    await report("start", ctx)
  })
  pi.on("session_shutdown", async (event, ctx) => {
    // Pi may prepend its own handler after ours; don't depend on listener order.
    await new Promise<void>((resolve) => setImmediate(resolve))
    for (const signal of signals) process.off(signal, onSignal)
    if (event.reason === "quit" && !signalled) await report("quit", ctx)
  })
}
"#;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Build Pi's argument vector (excluding the program itself).
pub fn pi_argv(start: &PiStart) -> Vec<String> {
    match start {
        PiStart::Fresh => Vec::new(),
        PiStart::Resume(id) => vec!["--session".to_string(), id.clone()],
    }
}

/// Is `id` a conservative Pi session-id token? Kept for diagnostics and
/// legacy callers; automatic restore uses [`is_session_file`] instead.
pub fn is_session_id(id: &str) -> bool {
    id.len() >= 8
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && id.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && id.bytes().last().is_some_and(|b| b.is_ascii_alphanumeric())
}

/// Is `path` a safe exact Pi session-file argument? Pi's `--session` accepts a
/// path or an id, but id/prefix lookup is not deterministic across forks. Hook
/// paths are absolute JSONL files; parent-directory components are rejected so
/// the persisted value cannot change meaning after a cwd switch.
pub fn is_session_file(path: &str) -> bool {
    let path = Path::new(path);
    path.is_absolute()
        && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
        && !path.to_string_lossy().contains('\0')
        && path.components().all(|component| {
            !matches!(component, std::path::Component::CurDir | std::path::Component::ParentDir)
        })
}
/// Verify the exact saved file before a restore. Missing/corrupt files must
/// never turn `pi --session` into a fresh conversation or a prefix search.
/// Read only a bounded header, never a user's conversation body.
pub fn valid_recording(recording: &amber_core::state::ClaudeMeta) -> bool {
    use std::io::{BufRead, BufReader, Read};
    if recording.agent_kind != Some(amber_core::state::SessionKind::Pi) {
        return false;
    }
    let Some(path) = recording.session_file.as_deref() else { return false };
    if !is_session_file(&path.to_string_lossy()) || !recording.cwd.is_absolute() || !recording.cwd.is_dir() {
        return false;
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let Ok(file) = options.open(path) else { return false };
    if !file.metadata().is_ok_and(|m| m.is_file()) { return false }
    let mut header = String::new();
    if BufReader::new(file.take(16 * 1024)).read_line(&mut header).is_err() {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&header) else { return false };
    value["type"] == "session" && value["id"].as_str() == Some(recording.session_id.as_str())
}

/// Resolve the Pi binary via the user's login shell, never the daemon PATH.
pub fn resolve_pi() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        let shell = crate::platform::default_shell();
        crate::claude::resolve_bin_with(&shell.to_string_lossy(), true, "pi", &[])
    }
    #[cfg(windows)]
    {
        crate::claude::resolve_bin_windows("pi")
    }
}

/// Pi's agent directory, respecting its non-empty override before `$HOME`.
pub fn pi_agent_dir() -> Option<PathBuf> {
    std::env::var("PI_CODING_AGENT_DIR")
        .ok()
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            crate::platform::user_home().map(|home| home.join(".pi").join("agent"))
        })
}

/// Install or refresh Amber's global Pi extension and return its verified path.
/// This fallible form is for explicit repair commands, which must never claim
/// success if the exact-resume hook was not actually installed.
pub fn install_global_pi_extension() -> anyhow::Result<PathBuf> {
    let agent_dir = pi_agent_dir()
        .ok_or_else(|| anyhow::anyhow!("Pi extension install requires HOME or PI_CODING_AGENT_DIR"))?;
    install_extension_in(&agent_dir.join("extensions"))
}

/// Best-effort installation for daemon and supervisor launch paths. A broken
/// extension filesystem must not prevent an otherwise usable interactive Pi
/// pane from opening, but the exact failure remains visible to the operator.
pub fn ensure_global_pi_extension() {
    if let Err(e) = install_global_pi_extension() {
        eprintln!("amber: failed to install Pi extension: {e}");
    }
}

/// Testable core of [`install_global_pi_extension`]. Returns the owned file
/// only after it exists unchanged or has been atomically installed/refreshed.
pub fn install_extension_in(dir: &Path) -> anyhow::Result<PathBuf> {
    fs::create_dir_all(dir)?;

    let path = dir.join(EXTENSION_FILE);
    match fs::read_to_string(&path) {
        Ok(existing) if existing == EXTENSION_TS => return Ok(path),
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }

    atomic_write_extension(&path, EXTENSION_TS.as_bytes())?;
    Ok(path)
}

/// Atomically replace the owned extension from a unique same-directory file.
fn atomic_write_extension(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "extension path has no parent")
    })?;

    for _ in 0..16 {
        let sequence = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(
            ".{EXTENSION_FILE}.amber-tmp-{}-{sequence}",
            std::process::id()
        ));
        let mut file = match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
        {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };

        let write_result = file.write_all(contents).and_then(|()| file.sync_all());
        drop(file);
        if let Err(e) = write_result {
            let _ = fs::remove_file(&temporary);
            return Err(e);
        }
        if let Err(e) = crate::platform::replace_file(&temporary, path) {
            let _ = fs::remove_file(&temporary);
            return Err(e);
        }
        return Ok(());
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique Pi extension temporary file",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn argv_fresh_has_no_arguments() {
        assert_eq!(pi_argv(&PiStart::Fresh), Vec::<String>::new());
    }

    #[test]
    fn argv_resumes_an_exact_recorded_session_file() {
        let file = "/home/user/.pi/agent/sessions/--home-user--/2026-08-27T00-00-00-0198f8ea.jsonl";
        assert_eq!(
            pi_argv(&PiStart::Resume(file.into())),
            ["--session", file]
        );
    }

    #[test]
    fn session_ids_are_conservative_ascii_tokens() {
        assert!(is_session_id("0198f8ea-9c13-7000-a123-0123456789ab"));
        for bad in [
            "",
            "--continue",
            "../session.jsonl",
            "id with space",
            "id/slash",
        ] {
            assert!(!is_session_id(bad), "{bad:?} must not be resumed");
        }
    }

    #[test]
    fn session_files_require_absolute_normalized_jsonl_paths() {
        assert!(is_session_file(
            "/home/user/.pi/agent/sessions/--home-user--/2026-08-27_0198f8ea.jsonl"
        ));
        for bad in [
            "0198f8ea-9c13-7000-a123-0123456789ab",
            "relative/session.jsonl",
            "/tmp/../session.jsonl",
            "/tmp/session.txt",
            "/tmp/session.jsonl\0evil",
        ] {
            assert!(!is_session_file(bad), "{bad:?} must not be resumed");
        }
    }

    #[test]
    fn recording_requires_matching_real_header_but_allows_main_fork_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("forks/main.jsonl");
        fs::create_dir(path.parent().unwrap()).unwrap();
        let mut recording = amber_core::state::ClaudeMeta {
            session_id: "parent-session".into(), cwd: dir.path().into(), updated: 1,
            session_file: Some(path.clone()), agent_kind: Some(amber_core::state::SessionKind::Pi),
        };
        assert!(!valid_recording(&recording), "missing file is not a fresh launch");
        fs::write(&path, "{\"type\":\"session\",\"id\":\"child-session\"}\n").unwrap();
        assert!(!valid_recording(&recording), "file/ID mismatch");
        fs::write(&path, "{\"type\":\"session\",\"id\":\"parent-session\"}\n").unwrap();
        assert!(valid_recording(&recording), "a legitimate MAIN fork is allowed");
        recording.agent_kind = None;
        assert!(!valid_recording(&recording), "untagged legacy recording is ambiguous");
    }

    #[test]
    fn extension_installer_writes_the_required_session_hook_idempotently() {
        let dir = tempfile::tempdir().unwrap();
        let extensions = dir.path().join("extensions");

        install_extension_in(&extensions).unwrap();

        let path = extensions.join("amber-hook.ts");
        let first = fs::read_to_string(&path).unwrap();
        assert_eq!(first, EXTENSION_TS);
        assert!(first.contains("ExtensionAPI"));
        assert!(first.contains("@earendil-works/pi-coding-agent"));
        assert!(first.contains("session_start"));
        assert!(first.contains("AMBER_SESSION"));
        assert!(first.contains("getSessionId"));
        assert!(first.contains("getSessionFile"));
        assert!(first.contains("session_shutdown"));
        assert!(first.contains("event.reason === \"quit\""));
        assert!(first.contains("AMBER_BIN"));
        assert!(first.contains("agent_kind: \"pi\""));
        assert!(first.contains("session_id"));
        assert!(first.contains("session_file"));
        assert!(first.contains("pid: process.pid"));
        assert!(first.contains("cwd"));

        install_extension_in(&extensions).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), first);
    }

    #[test]
    fn extension_installer_refreshes_only_its_owned_file_without_temp_residue() {
        let dir = tempfile::tempdir().unwrap();
        let extensions = dir.path().join("extensions");
        fs::create_dir_all(&extensions).unwrap();
        let other = extensions.join("neighbor.ts");
        fs::write(&other, "export default 42\n").unwrap();
        let owned = extensions.join("amber-hook.ts");
        fs::write(&owned, "// stale owned content\n").unwrap();

        install_extension_in(&extensions).unwrap();

        assert_ne!(
            fs::read_to_string(&owned).unwrap(),
            "// stale owned content\n"
        );
        assert_eq!(fs::read_to_string(&other).unwrap(), "export default 42\n");
        assert!(fs::read_dir(&extensions).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".amber-tmp")
        }));
    }

    #[test]
    fn fallible_extension_installer_reports_an_unusable_destination() {
        // The explicit repair command must be able to distinguish a verified
        // install from an extension directory that cannot be created.
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("not-a-directory");
        fs::write(&blocked, "file blocks extension directory").unwrap();

        assert!(install_extension_in(&blocked).is_err());
    }
}
