//! Grok supervision helpers: build the resume/fresh argv and mint the session
//! id. Pure/testable; the supervisor loop lives in `supervisor`.
//!
//! Grok differs from claude in exactly one important way, and it makes this
//! module much smaller than `claude`: `grok --session-id <uuid>` *assigns* the
//! id of a NEW conversation, so amber picks the id itself and records it. There
//! is no `SessionStart` hook, no rotating id, and nothing to write into the
//! user's grok config. `grok --resume <uuid>` then reopens that exact
//! conversation, keeping the same id (rotating would need `--fork-session`).
//!
//! The one sharp edge: an assigned id can be used exactly once — grok errors
//! with "Session ID <uuid> is already in use" if it already exists. So a fresh
//! start ALWAYS mints a new uuid; re-passing the recorded one would fail
//! instantly and burn the supervisor's whole retry budget.

use std::io::Read;
use std::path::PathBuf;

/// How to start `grok`: reopen a recorded conversation, or begin a new one
/// under a freshly minted id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrokStart {
    Resume(String),
    /// Start a new conversation with this (unused) id.
    Fresh(String),
}

/// Build grok's argument vector (excluding the program itself).
///
/// `bypassPermissions` is grok's equivalent of claude's
/// `--dangerously-skip-permissions`: a pane runs detached in the daemon's pty,
/// so an approval prompt nobody is watching would hang the session.
pub fn grok_argv(start: &GrokStart) -> Vec<String> {
    let mut argv = vec![
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
    ];
    match start {
        GrokStart::Resume(id) => {
            argv.push("--resume".to_string());
            argv.push(id.clone());
        }
        GrokStart::Fresh(id) => {
            argv.push("--session-id".to_string());
            argv.push(id.clone());
        }
    }
    argv
}

/// Is `id` a plausible grok session id (a UUID)?
///
/// Guards the `Resume` arm: `--resume` takes an OPTIONAL value, so passing a
/// blank or malformed id would silently resume "the most recent session in this
/// cwd" — able to hijack an unrelated conversation, exactly the hazard the
/// claude ladder avoids by never using `--continue`.
pub fn is_session_id(id: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let mut parts = id.split('-');
    for want in groups {
        match parts.next() {
            Some(p) if p.len() == want && p.bytes().all(|b| b.is_ascii_hexdigit()) => {}
            _ => return false,
        }
    }
    parts.next().is_none()
}

/// Mint a random UUIDv4 for a new grok conversation. `/dev/urandom` is the only
/// randomness amber needs (same source as the web token) — no dependency.
pub fn new_session_id() -> String {
    let mut b = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .expect("/dev/urandom is readable");
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 1
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// Resolve the grok binary via the user's login shell — the same
/// distribution-safe path claude takes (spec §8); never the daemon's own PATH.
pub fn resolve_grok() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        let shell = crate::platform::default_shell();
        crate::claude::resolve_bin_with(&shell.to_string_lossy(), true, "grok", &[])
    }
    #[cfg(windows)]
    {
        crate::claude::resolve_bin_windows("grok")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_resumes_a_recorded_id() {
        let argv = grok_argv(&GrokStart::Resume("9d5ed578-38af-420e-9cb5-80b0d0b68c77".into()));
        let i = argv.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(argv[i + 1], "9d5ed578-38af-420e-9cb5-80b0d0b68c77");
        assert!(!argv.iter().any(|a| a == "--session-id"));
        assert!(argv.iter().any(|a| a == "bypassPermissions"));
    }

    #[test]
    fn argv_fresh_assigns_a_new_id() {
        // A fresh start must NAME its conversation, so the next launch can
        // resume it. Never `--resume` with no value (that hijacks whatever ran
        // last in the cwd) and never `--continue`.
        let argv = grok_argv(&GrokStart::Fresh("11111111-2222-4333-8444-555555555555".into()));
        let i = argv.iter().position(|a| a == "--session-id").unwrap();
        assert_eq!(argv[i + 1], "11111111-2222-4333-8444-555555555555");
        assert!(!argv.iter().any(|a| a == "--resume"));
        assert!(!argv.iter().any(|a| a == "--continue"));
    }

    #[test]
    fn minted_ids_are_uuids_and_unique() {
        let a = new_session_id();
        let b = new_session_id();
        assert!(is_session_id(&a), "{a} should be a uuid");
        assert!(is_session_id(&b));
        assert_ne!(a, b, "a fresh start must never reuse an id (grok rejects it)");
        assert_eq!(&a[14..15], "4", "uuid version nibble");
    }

    #[test]
    fn rejects_ids_that_would_make_resume_hijack() {
        // Anything not UUID-shaped must be refused rather than handed to
        // `--resume`, whose value is optional.
        assert!(!is_session_id(""));
        assert!(!is_session_id("latest"));
        assert!(!is_session_id("9d5ed578-38af-420e-9cb5"));
        assert!(!is_session_id("9d5ed578-38af-420e-9cb5-80b0d0b68c77-extra"));
        assert!(!is_session_id("9d5ed578_38af_420e_9cb5_80b0d0b68c77"));
        assert!(!is_session_id("zd5ed578-38af-420e-9cb5-80b0d0b68c77"));
    }
}
