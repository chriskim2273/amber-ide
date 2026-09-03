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

/// The Pi extension amber installs for exact-resume recording and the optional
/// semantic GUI sideband. It uses only Pi's public extension API and Amber's
/// authenticated local daemon socket; the TUI remains the one Pi process.
const EXTENSION_TS: &str = r#"import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { spawn } from "node:child_process"
import { connect, type Socket } from "node:net"

const MAX_FRAME = 64 * 1024 * 1024
const MAX_EVENT = 3 * 1024 * 1024
const MAX_TEXT = 64 * 1024
const MAX_BUFFERED = 1024 * 1024
const UPDATE_INTERVAL_MS = 80

export default function (pi: ExtensionAPI) {
  const name = process.env.AMBER_SESSION
  const socketPath = process.env.AMBER_SOCK
  if (!name) return

  let socket: Socket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectDelay = 250
  let incoming = Buffer.alloc(0)
  let sequence = 0
  let stopped = false
  let latestContext: ExtensionContext | undefined
  let updateTimer: ReturnType<typeof setTimeout> | undefined
  let lastUpdateAt: number | undefined
  let pendingUpdate: { event: { type: string }; ctx: ExtensionContext } | undefined
  let pendingAfterUpdate: Array<() => void> = []

  function encodeControl(value: unknown): Buffer {
    const json = Buffer.from(JSON.stringify(value), "utf8")
    const frame = Buffer.allocUnsafe(json.length + 5)
    frame.writeUInt32BE(json.length + 1, 0)
    frame[4] = 0
    json.copy(frame, 5)
    return frame
  }

  function writeControl(value: unknown): boolean {
    if (!socket || socket.destroyed || !socket.writable || socket.writableLength > MAX_BUFFERED) return false
    const frame = encodeControl(value)
    if (frame.length > MAX_FRAME) return false
    socket.write(frame)
    return true
  }

  function jsonSafe(value: unknown): unknown {
    try {
      return JSON.parse(JSON.stringify(value, function (key, item) {
        if (/signature|encrypted/i.test(key)) return undefined
        if (typeof item === "bigint") return item.toString()
        if (item instanceof Error) return { name: item.name, message: item.message }
        if (key === "data" && this && typeof this === "object"
          && (this as Record<string, unknown>).type === "image" && typeof item === "string") {
          return `[image body omitted: ${item.length} characters]`
        }
        if (typeof item === "string" && item.length > MAX_TEXT) {
          return `${item.slice(0, MAX_TEXT)}\n[truncated by Amber]`
        }
        return item
      }))
    } catch {
      return { truncated: true }
    }
  }

  function sendEvent(event: Record<string, unknown>, lossy = false): void {
    const safe = jsonSafe(event) as Record<string, unknown>
    const encoded = JSON.stringify(safe)
    if (Buffer.byteLength(encoded, "utf8") > MAX_EVENT) {
      if (lossy) return
      writeControl({ PiEvent: { name, seq: ++sequence, event: {
        kind: "bridge_error",
        message: `Pi ${String(event.kind || "event")} exceeded the semantic bridge limit`,
      } } })
      return
    }
    writeControl({ PiEvent: { name, seq: ++sequence, event: safe } })
  }

  function modelSummary(ctx: ExtensionContext): unknown {
    if (!ctx.model) return null
    return {
      provider: ctx.model.provider,
      id: ctx.model.id,
      name: ctx.model.name,
      reasoning: ctx.model.reasoning,
      contextWindow: ctx.model.contextWindow,
      maxTokens: ctx.model.maxTokens,
    }
  }

  function sendSnapshot(ctx = latestContext): void {
    if (!ctx) return
    let entries = ctx.sessionManager.getBranch().slice(-200)
    let event: Record<string, unknown>
    do {
      event = {
        kind: "snapshot",
        sessionId: ctx.sessionManager.getSessionId(),
        sessionName: ctx.sessionManager.getSessionName(),
        cwd: ctx.cwd,
        idle: ctx.isIdle(),
        pending: ctx.hasPendingMessages(),
        model: modelSummary(ctx),
        thinkingLevel: ctx.thinkingLevel || pi.getThinkingLevel(),
        contextUsage: ctx.getContextUsage(),
        activeTools: pi.getActiveTools(),
        entries,
      }
      if (Buffer.byteLength(JSON.stringify(jsonSafe(event)), "utf8") <= MAX_EVENT || entries.length === 0) break
      entries = entries.slice(Math.max(1, Math.floor(entries.length / 4)))
    } while (true)
    sendEvent(event)
  }

  function commandError(message: string): void {
    sendEvent({ kind: "command_error", message })
  }

  function handleCommand(command: unknown): void {
    try {
      if (command === "Snapshot") {
        sendSnapshot()
        return
      }
      if (command === "Abort") {
        latestContext?.abort()
        return
      }
      if (!command || typeof command !== "object") throw new Error("invalid Pi command")
      const record = command as Record<string, unknown>
      if (record.Prompt && typeof record.Prompt === "object") {
        const prompt = record.Prompt as Record<string, unknown>
        if (typeof prompt.message !== "string" || !prompt.message.trim()) throw new Error("empty Pi prompt")
        const options: { deliverAs?: "steer" | "followUp"; expandPromptTemplates: boolean } = {
          expandPromptTemplates: true,
        }
        if (prompt.delivery === "steer") options.deliverAs = "steer"
        if (prompt.delivery === "follow_up") options.deliverAs = "followUp"
        pi.sendUserMessage(prompt.message, options)
        return
      }
      if (record.SetThinkingLevel && typeof record.SetThinkingLevel === "object") {
        const level = (record.SetThinkingLevel as Record<string, unknown>).level
        if (typeof level !== "string") throw new Error("invalid Pi thinking level")
        pi.setThinkingLevel(level as Parameters<typeof pi.setThinkingLevel>[0])
        return
      }
      throw new Error("unknown Pi command")
    } catch (error) {
      commandError(error instanceof Error ? error.message : String(error))
    }
  }

  function decodeFrames(chunk: Buffer): void {
    incoming = Buffer.concat([incoming, chunk])
    while (incoming.length >= 5) {
      const length = incoming.readUInt32BE(0)
      if (length < 1 || length > MAX_FRAME) {
        socket?.destroy()
        return
      }
      if (incoming.length < length + 4) return
      const frame = incoming.subarray(4, length + 4)
      incoming = incoming.subarray(length + 4)
      if (frame[0] !== 0) continue
      try {
        const decoded = JSON.parse(frame.subarray(1).toString("utf8"))
        const body = decoded?.PiBridgeCommand
        if (body?.name === name) handleCommand(body.command)
      } catch {
        // A malformed daemon frame cannot affect the Pi TUI.
      }
    }
  }

  function scheduleReconnect(): void {
    if (stopped || !socketPath || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      openBridge()
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000)
  }

  function openBridge(): void {
    if (stopped || !socketPath || socket) return
    incoming = Buffer.alloc(0)
    const next = connect(socketPath)
    socket = next
    next.on("connect", () => {
      reconnectDelay = 250
      writeControl({ PiBridgeHello: { name } })
      sendSnapshot()
    })
    next.on("data", decodeFrames)
    next.on("error", () => {})
    next.on("close", () => {
      if (socket === next) socket = undefined
      scheduleReconnect()
    })
  }

  function observe(type: string, event: { type: string }, ctx: ExtensionContext, lossy = false): void {
    latestContext = ctx
    const { type: _ignored, ...payload } = event
    const eventKind = "kind" in payload ? { eventKind: payload.kind } : {}
    sendEvent({ ...payload, ...eventKind, kind: type }, lossy)
  }

  function flushUpdate(after?: () => void): void {
    if (after) {
      if (!pendingUpdate) {
        after()
        return
      }
      pendingAfterUpdate.push(after)
    }
    if (updateTimer) clearTimeout(updateTimer)
    updateTimer = undefined
    const pending = pendingUpdate
    if (!pending) {
      const callbacks = pendingAfterUpdate
      pendingAfterUpdate = []
      for (const callback of callbacks) callback()
      return
    }
    const elapsed = lastUpdateAt === undefined ? UPDATE_INTERVAL_MS : Math.max(0, Date.now() - lastUpdateAt)
    const wait = Math.max(0, UPDATE_INTERVAL_MS - elapsed)
    if (wait > 0) {
      updateTimer = setTimeout(flushUpdate, wait)
      return
    }
    pendingUpdate = undefined
    observe("message_update", pending.event, pending.ctx, true)
    lastUpdateAt = Date.now()
    const callbacks = pendingAfterUpdate
    pendingAfterUpdate = []
    for (const callback of callbacks) callback()
  }

  function queueUpdate(event: { type: string }, ctx: ExtensionContext): void {
    latestContext = ctx
    pendingUpdate = { event, ctx }
    if (updateTimer) return
    updateTimer = setTimeout(flushUpdate, UPDATE_INTERVAL_MS)
  }

  pi.on("session_start", (event, ctx) => {
    latestContext = ctx
    const session_id = ctx.sessionManager.getSessionId()
    if (session_id) {
      const child = spawn(process.env.AMBER_BIN || "amber", ["hook"], {
        stdio: ["pipe", "ignore", "ignore"],
      })
      child.on("error", () => {})
      child.stdin.on("error", () => {})
      child.stdin.end(JSON.stringify({ session_id, cwd: ctx.cwd }))
    }
    openBridge()
    observe("session_start", event, ctx)
  })
  pi.on("session_info_changed", (event, ctx) => {
    observe("session_info_changed", event, ctx)
    sendSnapshot(ctx)
  })
  pi.on("agent_start", (event, ctx) => observe("agent_start", event, ctx))
  pi.on("agent_end", (event, ctx) => {
    observe("agent_end", event, ctx)
    sendSnapshot(ctx)
  })
  pi.on("agent_settled", (event, ctx) => {
    observe("agent_settled", event, ctx)
    sendSnapshot(ctx)
  })
  pi.on("ui_prompt_start", (event, ctx) => observe("ui_prompt_start", event, ctx))
  pi.on("ui_prompt_end", (event, ctx) => observe("ui_prompt_end", event, ctx))
  pi.on("turn_start", (event, ctx) => observe("turn_start", event, ctx))
  pi.on("turn_end", (event, ctx) => observe("turn_end", event, ctx))
  pi.on("message_start", (event, ctx) => observe("message_start", event, ctx))
  pi.on("message_update", (event, ctx) => queueUpdate(event, ctx))
  pi.on("message_end", (event, ctx) => {
    // Keep the final update before message_end, but never bypass the 80 ms
    // streaming throttle when the end event arrives immediately after one.
    flushUpdate(() => observe("message_end", event, ctx))
  })
  pi.on("tool_execution_start", (event, ctx) => observe("tool_execution_start", event, ctx))
  pi.on("tool_execution_update", (event, ctx) => observe("tool_execution_update", event, ctx, true))
  pi.on("tool_execution_end", (event, ctx) => observe("tool_execution_end", event, ctx))
  pi.on("model_select", (event, ctx) => {
    const summary = { type: event.type, model: modelSummary(ctx), source: event.source }
    observe("model_select", summary, ctx)
  })
  pi.on("thinking_level_select", (event, ctx) => observe("thinking_level_select", event, ctx))
  pi.on("session_compact", (event, ctx) => observe("session_compact", event, ctx))
  pi.on("session_compact_failed", (event, ctx) => observe("session_compact_failed", event, ctx))
  pi.on("session_shutdown", (_event, ctx) => {
    latestContext = ctx
    stopped = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (updateTimer) clearTimeout(updateTimer)
    pendingUpdate = undefined
    pendingAfterUpdate = []
    socket?.end()
    socket = undefined
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
        assert!(first.contains("AMBER_SOCK"));
        assert!(first.contains("PiBridgeHello"));
        assert!(first.contains("PiEvent"));
        assert!(first.contains("PiBridgeCommand"));
        assert!(first.contains("sendUserMessage"));
        assert!(first.contains("setThinkingLevel"));
        assert!(first.contains("MAX_BUFFERED"));
        assert!(first.contains("const MAX_TEXT = 64 * 1024"));
        assert!(first.contains("UPDATE_INTERVAL_MS = 80"));
        assert!(first.contains("lastUpdateAt: number | undefined"));
        assert!(first.contains("UPDATE_INTERVAL_MS - elapsed"));
        assert!(first.contains("getBranch().slice(-200)"));
        assert!(first.contains("signature|encrypted"));
        assert!(first.contains("image body omitted"));
        assert!(first.contains("(this as Record<string, unknown>).type === \"image\""));
        let image_guard = first
            .find("(this as Record<string, unknown>).type === \"image\"")
            .unwrap();
        let text_guard = first
            .find("typeof item === \"string\" && item.length > MAX_TEXT")
            .unwrap();
        assert!(
            image_guard < text_guard,
            "raw image bodies must be omitted before text clipping"
        );
        assert!(first.contains("flushUpdate(() => observe(\"message_end\""));
        assert!(
            !first.contains("prototype"),
            "bridge must use public Pi APIs only"
        );

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
