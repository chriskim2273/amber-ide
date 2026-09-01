//! Pi supervision helpers: build resume/fresh argv and install the global
//! extension that records the session id. Pure/testable; the supervisor loop
//! lives in `supervisor`.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// How to start Pi: reopen a recorded conversation, or begin a new one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PiStart {
    Resume(String),
    Fresh,
}

/// The extension filename amber owns under Pi's global extensions directory.
const EXTENSION_FILE: &str = "amber-hook.ts";

/// The Pi extension amber installs to record session ids for exact resume.
const EXTENSION_TS: &str = r#"// amber-owned-extension:v2
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { spawn } from "node:child_process"
import { connect } from "node:net"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

function browserPaths() {
  const state = process.env.AMBER_STATE_DIR
  if (!state) throw new Error("Amber browser tools require a supervised Pi pane")
  const runtime = process.env.XDG_RUNTIME_DIR || tmpdir()
  return {
    token: join(state, "browser-host-token"),
    socket: process.env.AMBER_BROWSER_HOST_SOCKET || join(runtime, "amber-ide", "browser-host.sock"),
  }
}

function encode(value: unknown) {
  const body = Buffer.from(JSON.stringify(value))
  const out = Buffer.allocUnsafe(body.length + 4)
  out.writeUInt32BE(body.length); body.copy(out, 4)
  return out
}

async function browserRequest(action: unknown, signal?: AbortSignal) {
  const amberSession = process.env.AMBER_SESSION
  if (!amberSession) throw new Error("Amber browser tools are unavailable outside an Amber pane")
  const paths = browserPaths()
  const token = (await readFile(paths.token, "utf8")).trim()
  return await new Promise<unknown>((resolve, reject) => {
    const socket = connect(paths.socket)
    let buffer = Buffer.alloc(0), authenticated = false, settled = false
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy()
      if (error) reject(error); else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error("Amber browser host timed out")), 8000)
    const abort = () => finish(new Error("Amber browser request cancelled"))
    signal?.addEventListener("abort", abort, { once: true })
    socket.on("error", (error) => finish(error))
    socket.on("connect", () => socket.write(encode({ token })))
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0)
        if (length > 256 * 1024) return finish(new Error("Amber browser host sent an oversized reply"))
        if (buffer.length < length + 4) return
        const body = buffer.subarray(4, length + 4); buffer = buffer.subarray(length + 4)
        let reply: any
        try { reply = JSON.parse(body.toString("utf8")) } catch { return finish(new Error("Amber browser host sent invalid JSON")) }
        if (!authenticated) {
          if (!reply?.ok) return finish(new Error("Amber browser host authentication failed"))
          authenticated = true
          socket.write(encode({ version: 1, requestId: `${Date.now()}-${Math.random()}`, amberSession, action }))
          continue
        }
        if (!reply?.ok) return finish(new Error(String(reply?.error || "Amber browser request failed")))
        finish(undefined, reply.result)
      }
    })
  })
}

function result(value: unknown) {
  const text = JSON.stringify(value, null, 2)
  return { content: [{ type: "text" as const, text: text.length > 50000 ? text.slice(0, 50000) + "\\n…truncated" : text }], details: {} }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!process.env.AMBER_SESSION) return
    const session_id = ctx.sessionManager.getSessionId()
    if (!session_id) return
    const child = spawn(process.env.AMBER_BIN || "amber", ["hook"], {
      stdio: ["pipe", "ignore", "ignore"],
    })
    child.on("error", () => {})
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify({ session_id, cwd: ctx.cwd }))
  })

  pi.registerTool({
    name: "browser_open", label: "Open tab browser",
    description: "Create or reveal this Amber tab's shared browser. First use waits for visible user sharing approval.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal) { return result(await browserRequest({ type: "open" }, signal)) },
  })
  pi.registerTool({
    name: "browser_status", label: "Browser status",
    description: "Read this tab browser's current URL, lifecycle, page incarnation, and generation.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal) { return result(await browserRequest({ type: "status" }, signal)) },
  })
  pi.registerTool({
    name: "browser_navigate", label: "Navigate browser",
    description: "Navigate the shared tab browser when its page generation is still current.",
    parameters: Type.Object({
      url: Type.String({ maxLength: 8192 }),
      pageIncarnation: Type.String({ maxLength: 128 }),
      expectedGeneration: Type.Number({ minimum: 0 }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      return result(await browserRequest({ type: "navigate", url: params.url, pageIncarnation: params.pageIncarnation, expectedGeneration: params.expectedGeneration }, signal))
    },
  })
}
"#;

// Exact source shipped before browser tools. It had no ownership marker, so
// equality is the only safe proof that Amber owns a legacy file.
const LEGACY_EXTENSION_TS: &str = r#"import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { spawn } from "node:child_process"

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!process.env.AMBER_SESSION) return
    const session_id = ctx.sessionManager.getSessionId()
    if (!session_id) return
    const child = spawn(process.env.AMBER_BIN || "amber", ["hook"], {
      stdio: ["pipe", "ignore", "ignore"],
    })
    child.on("error", () => {})
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify({ session_id, cwd: ctx.cwd }))
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

/// Is `id` a conservative Pi session-id token safe for `pi --session <id>`?
pub fn is_session_id(id: &str) -> bool {
    id.len() >= 8
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && id.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && id.bytes().last().is_some_and(|b| b.is_ascii_alphanumeric())
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
        Ok(existing) if existing == LEGACY_EXTENSION_TS => {}
        Ok(_) => {
            anyhow::bail!(
                "refusing to replace modified/unowned Pi extension {}",
                path.display()
            )
        }
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
    fn argv_resumes_a_recorded_session_id() {
        assert_eq!(
            pi_argv(&PiStart::Resume(
                "0198f8ea-9c13-7000-a123-0123456789ab".into()
            )),
            ["--session", "0198f8ea-9c13-7000-a123-0123456789ab"]
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
        assert!(first.contains("AMBER_BIN"));
        assert!(first.contains("session_id"));
        assert!(first.contains("cwd"));
        assert!(first.contains("browser_open"));
        assert!(first.contains("browser_status"));
        assert!(first.contains("browser_navigate"));
        assert!(first.contains("browser-host-token"));
        assert!(!first.contains("Runtime.evaluate"));

        install_extension_in(&extensions).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), first);
    }

    #[test]
    fn extension_installer_migrates_exact_owned_legacy_without_temp_residue() {
        let dir = tempfile::tempdir().unwrap();
        let extensions = dir.path().join("extensions");
        fs::create_dir_all(&extensions).unwrap();
        let other = extensions.join("neighbor.ts");
        fs::write(&other, "export default 42\n").unwrap();
        let owned = extensions.join("amber-hook.ts");
        fs::write(&owned, LEGACY_EXTENSION_TS).unwrap();

        install_extension_in(&extensions).unwrap();

        assert_eq!(fs::read_to_string(&owned).unwrap(), EXTENSION_TS);
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
    fn extension_installer_preserves_modified_or_unowned_legacy_file() {
        let dir = tempfile::tempdir().unwrap();
        let extensions = dir.path().join("extensions");
        fs::create_dir_all(&extensions).unwrap();
        let path = extensions.join(EXTENSION_FILE);
        fs::write(&path, "// user-owned extension\n").unwrap();
        let error = install_extension_in(&extensions).unwrap_err();
        assert!(error.to_string().contains("modified/unowned"));
        assert_eq!(fs::read_to_string(path).unwrap(), "// user-owned extension\n");
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
