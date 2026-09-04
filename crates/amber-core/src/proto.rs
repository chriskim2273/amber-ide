//! Wire protocol framing (client <-> daemon).
//!
//! Frame on the wire: `[u32 BE body_len][u8 tag][body]`.
//! - tag 0 = Control: body is JSON of [`ControlMsg`].
//! - tag 1 = Data:    body is `[u16 BE name_len][name utf8][raw bytes...]`.
//!
//! Data carries pty bytes verbatim — no escaping (the whole point of dropping
//! tmux control mode). The [`Decoder`] tolerates arbitrary chunk boundaries.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub name: String,
    pub cwd: String,
    pub kind: String,
    pub alive: bool,
    /// Optional friendly title chosen by the user. This is deliberately
    /// separate from `name`: names encode workspace/tab grouping and are the
    /// daemon's identity, while titles are display metadata that survive a
    /// rename/move unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Unix seconds of the session's last state-store write (creation, or a
    /// later cwd change) — the honest ordering key for "most recent" (e.g.
    /// `amber attach` with no name). `#[serde(default)]` keeps the wire
    /// backward compatible: peers that omit it (older binaries, the Electron
    /// app, which never constructs `SessionInfo` and ignores unknown fields)
    /// decode as `0`.
    #[serde(default)]
    pub updated: u64,
    /// Claude supervision phase for a `kind == "claude"` session, reported by
    /// its `amber run` supervisor: `"claude"` (running), `"claude-retrying"`
    /// (crashed, in the bounded-retry backoff), `"shell-fallback"` (claude
    /// gave up / the user quit — the pane is now a plain shell). `None` for a
    /// shell session or a claude session that has not reported yet.
    /// `#[serde(default)]` keeps the wire backward compatible: peers that omit
    /// it (older binaries, the Electron app, which never constructs
    /// `SessionInfo`) decode as `None`.
    #[serde(default)]
    pub run_state: Option<String>,
    /// The last Claude Code session id recorded for this session (from the
    /// `SessionStart` hook), if any — lets the app offer a "reload claude"
    /// action that resumes this exact conversation (`claude --resume <id>`).
    /// `#[serde(default)]` keeps the wire back-compatible.
    #[serde(default)]
    pub claude_id: Option<String>,
    /// The session pty's CURRENT winsize, read live from the master. A pty has
    /// ONE winsize shared by every subscriber, so a client that must not
    /// resize it (`amber web`, spec §4 — the phone) needs to know the real
    /// geometry to render at: guessing 80×24 reflows a shell messily and
    /// corrupts an alt-screen TUI, whose absolute cursor positioning lands on
    /// the wrong grid. `0` when the size cannot be read (a dead session).
    /// `#[serde(default)]` keeps the wire back-compatible: peers that omit
    /// them decode as 0.
    #[serde(default)]
    pub cols: u16,
    #[serde(default)]
    pub rows: u16,
    /// The session's STABLE number — what `amber ls` prints and
    /// `amber attach <n>` resolves (see `SessionMeta::slot`). Unlike a
    /// position in the listing it never changes when another session dies.
    /// `#[serde(default)]` keeps the wire back-compatible: peers that omit it
    /// (an older daemon) decode as `0` = unassigned, which never resolves.
    #[serde(default)]
    pub slot: u32,
}

/// One bounded, printable hit from a daemon-side retained-scrollback search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchResult {
    pub name: String,
    /// One-based logical line within the sanitized retained ring.
    pub line: u32,
    pub preview: String,
}

/// One bounded daemon lifecycle/recovery record persisted across restarts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryEvent {
    pub at: u64,
    #[serde(default)]
    pub sequence: u32,
    pub level: String,
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
}

/// Epochs ride the JSON wire as STRINGS: they are nanos-derived u64s whose
/// magnitude exceeds JavaScript's 2^53 integer precision. `JSON.parse` would
/// silently round one, and a rounded epoch fails its equality check on every
/// re-attach — silently disabling delta replay while everything looks fine.
mod epoch_string {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub(crate) fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        value.to_string().serialize(serializer)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// A client's "I have already been fed up to here" watermark, sent on an
/// Attach that wants delta backlog replay (the app's reconnect / pane remount
/// path). `epoch` identifies the ring lifetime (`Ring::epoch`), `offset` the
/// absolute byte position within it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachResume {
    #[serde(with = "epoch_string")]
    pub epoch: u64,
    pub offset: u64,
}

/// Valid host resource-pressure levels on the control wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourcePressureLevel {
    Normal,
    Critical,
}

/// A Linux PSI source contributing to host resource pressure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourcePressureCause {
    Cpu,
    Io,
    Memory,
}

/// One quota window a provider reports about itself.
///
/// `percent` is **used**, 0..=100, exactly as the provider states it. The UI
/// derives "remaining"; amber never computes a percentage of its own (a number
/// divided by a guessed plan limit would be this feature wearing a mask — see
/// the 2026-09-01 usage design's "No derived percentages" rule).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gauge {
    /// The provider's own window identity: "session" (5h) | "weekly" | other.
    pub kind: String,
    /// Short human label: "5h window", "weekly".
    pub label: String,
    pub percent: f64,
    /// Unix seconds this window resets. `None` when the provider omits it.
    #[serde(default)]
    pub resets_at: Option<i64>,
    /// `resets_at` is in the past: the window has rolled since this sample was
    /// written, so `percent` describes a window that no longer exists. The UI
    /// must render this as "rolled", never as a number.
    #[serde(default)]
    pub stale: bool,
}

/// One provider's quota snapshot. `state` is `"ok" | "unavailable" |
/// "needs-auth" | "error"`; anything but `"ok"` renders as words, not numbers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderUsage {
    pub provider: String,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub gauges: Vec<Gauge>,
    /// Unix seconds of this sample.
    #[serde(default)]
    pub updated: u64,
    pub state: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ControlMsg {
    Hello,
    ListSessions,
    Create {
        name: String,
        cwd: String,
        kind: String,
        /// Optional friendly display title. `#[serde(default)]` preserves the
        /// wire contract for older clients that only send name/cwd/kind.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    /// `raw_client: true` marks a plain-terminal client (`amber attach`),
    /// which cannot safely replay historical alt-screen bytes (spec §5).
    /// `#[serde(default)]` keeps the wire backward compatible: clients that
    /// omit the field (the Electron app, older binaries) keep getting the
    /// full backlog.
    Attach {
        name: String,
        #[serde(default)]
        raw_client: bool,
        /// A small mosaic tile, not a full view. Agent sessions get NO backlog
        /// plus a bounded repaint nudge; shell sessions get a bounded tail of
        /// the ring only (`Ring::tail`). `#[serde(default)]` keeps the wire
        /// backward compatible: a client that omits it (older binaries, the
        /// Electron app, which never sets it) decodes as `false` = today's
        /// full-backlog attach.
        #[serde(default)]
        preview: bool,
        /// Delta-replay watermark (the Electron app's re-attach). **Presence
        /// is the opt-in**: a client that sends `resume` understands the
        /// [`ControlMsg::AttachBacklog`] reply; a client that omits it (`amber
        /// attach`, `amber web`, older apps — whose strict decoders reject
        /// unknown variants) keeps today's legacy full-backlog `Data` replay
        /// and must never receive the new variant. `skip_serializing_if`
        /// keeps this build's own first-attach bytes identical to the legacy
        /// form, and `#[serde(default)]` accepts its absence from anyone.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume: Option<AttachResume>,
    },
    Detach { name: String },
    /// Client -> daemon: mark a live terminal session as recently used. This
    /// hint refreshes automatic-parking protection and resumes only a
    /// memory-parked session; it never overrides a manual suspend.
    Focus { name: String },
    Resize { name: String, cols: u16, rows: u16 },
    Kill { name: String },
    Rename { from: String, to: String },
    /// Client -> daemon: set or clear a session's friendly display title.
    /// This never changes the daemon identity/name (and therefore never moves
    /// a pane between workspaces or tabs).
    SetTitle { name: String, title: Option<String> },
    /// Daemon -> client: a requested title was persisted successfully. The
    /// explicit ack lets clients distinguish a supported daemon from an older
    /// one that silently skips the additive `SetTitle` request.
    TitleSet { name: String, title: Option<String> },
    /// Client -> daemon: a `claude` session's `amber run` supervisor reports
    /// its current supervision phase (`state`: one of `"claude"`,
    /// `"claude-retrying"`, `"shell-fallback"`). The daemon stores it on the
    /// session and broadcasts the change to watchers. Versioned reports are
    /// acknowledged with `RunStateAck` and retried in order; legacy sequence
    /// zero remains accepted during mixed-version upgrades.
    ReportRunState {
        name: String,
        state: String,
        /// Monotonic per-supervisor sequence. Zero denotes a legacy
        /// fire-and-forget reporter; nonzero reports are acknowledged and
        /// stale/duplicate sequences cannot overwrite newer truth.
        #[serde(default, skip_serializing_if = "is_zero")]
        seq: u64,
    },
    /// Supervisor-only registration for the daemon's private control link.
    SupervisorHello { name: String },
    /// Daemon -> registered supervisor only; ignored if a client sends it.
    SupervisorCommand { name: String, command: String },
    /// Client -> daemon: park a claude session's child to free its RAM (Slice 3,
    /// freeze grace). The daemon signals the session's `amber run` supervisor
    /// (SIGUSR1) to kill claude and idle; the session record + pty + attachments
    /// stay alive. Non-claude / unknown sessions reply `Error`.
    Suspend { name: String },
    /// Client -> daemon: un-park a suspended claude session — the daemon signals
    /// the supervisor (SIGUSR2) to relaunch `claude --resume`. Non-claude /
    /// unknown sessions reply `Error`.
    Resume { name: String },
    /// Ask the daemon to flush a snapshot to the state store now.
    Snapshot,
    /// Daemon reply: the snapshot completed successfully.
    SnapshotOk,
    /// Client -> daemon: request a one-shot copy of a session's scrollback ring
    /// (the same bytes an Attach backlog would replay), for the workspace
    /// save/load feature. Reply is a single `Backlog`; an unknown session
    /// replies `Error`. The reply is written off the connection read thread
    /// (forwarder path) — a multi-MiB `data` must never block control frames
    /// multiplexed on the same socket (backlog head-of-line lesson).
    DumpBacklog { name: String },
    /// Search the current retained rings. Scanning and the reply write run off
    /// the connection read thread; `names=[]` means all listed sessions.
    SearchScrollback {
        request_id: u32,
        query: String,
        #[serde(default)]
        names: Vec<String>,
        #[serde(default)]
        limit: u16,
    },
    /// Bounded printable search results. Daemon -> client only.
    SearchResults {
        request_id: u32,
        query: String,
        results: Vec<SearchResult>,
    },
    ListRecoveryEvents { #[serde(default)] limit: u16 },
    ClearRecoveryEvents,
    RecoveryEvents { events: Vec<RecoveryEvent> },
    RecoveryEventsCleared,
    /// Daemon -> client: the requested session's full scrollback bytes.
    ///
    /// **Superseded by [`Frame::Backlog`] (wire tag 2) and no longer emitted.**
    /// As a control message the bytes were serde-JSON, i.e. a numeric array —
    /// a 2 MiB scrollback became ~8 MB of decimal text, built here and parsed
    /// into a 2-million-element array on the client, per pane, per workspace
    /// save. Retained as a DECODE path only, so a new client still understands
    /// an older daemon.
    Backlog { name: String, data: Vec<u8> },
    /// Client -> daemon: opt this connection in to pushed session-change events.
    WatchSessions,
    /// Client -> daemon: explicitly opt this connection in to memory-pressure
    /// controls. Kept separate from `WatchSessions` because older Electron and
    /// amber-web clients used strict control decoders; sending a newly-added
    /// pressure variant to those clients would make them reconnect forever.
    /// `version` lets a future pressure payload evolve without guessing client
    /// support. Version 1 is the current `MemoryPressure` shape.
    WatchMemoryPressure { version: u16 },
    /// Client -> daemon: request the full session set with metadata.
    ListSessionsDetailed,
    /// Daemon -> client: the full session set (reply to ListSessionsDetailed
    /// and sent once after WatchSessions).
    Sessions { sessions: Vec<SessionInfo> },
    /// Daemon -> watchers: an incremental session-set delta.
    SessionsChanged { added: Vec<SessionInfo>, removed: Vec<String> },
    /// Daemon -> watchers: a session produced output. Rate-limited to at most
    /// one per session per 500 ms so a chatty pty can't flood watchers; the app
    /// uses it to light a background-activity dot on inactive tabs. Carries only
    /// the name — no bytes (raw output rides `Data` frames on the pane socket).
    Activity { name: String },
    /// Daemon -> watchers: a session's child-process-tree memory (KiB RSS),
    /// emitted periodically by the memory monitor (Slice 1). `growing` flags a
    /// sustained upward trend (leak signature) so the app can badge it without
    /// re-deriving. Rides the same bounded watcher broadcast as `Activity`.
    /// Additive `#[serde(default)]` fields keep the wire back-compatible.
    MemoryStat {
        name: String,
        #[serde(default)]
        rss_kb: u64,
        #[serde(default)]
        growing: bool,
    },
    /// Daemon -> watchers: aggregate memory pressure. Numeric/boolean fields
    /// are additive for older clients; `level` stays required so a malformed
    /// sender cannot silently invent a pressure state.
    MemoryPressure {
        level: String,
        #[serde(default)]
        current_kb: u64,
        #[serde(default)]
        budget_kb: u64,
        #[serde(default)]
        blocked: bool,
    },
    /// Daemon -> version-2 pressure watchers: host PSI pressure. Strict enum
    /// fields reject unknown values at decode time while preserving the
    /// approved lowercase JSON strings for clients.
    ResourcePressure {
        level: ResourcePressureLevel,
        causes: Vec<ResourcePressureCause>,
        #[serde(default)]
        blocked: bool,
    },
    /// Daemon -> supervisor: an ordered run-state report was accepted (or was
    /// already superseded by a report with a higher sequence).
    RunStateAck { name: String, seq: u64 },
    /// Daemon -> client: reply to an Attach that carried a `resume` watermark.
    /// Announces the replay that follows as ONE `Data` frame: `full` means the
    /// whole scrollback (the terminal must be reset first — stale epoch or an
    /// evicted offset), `false` means only the missing tail (append). `epoch`
    /// is the ring's current identity and `end_offset` the client's next
    /// watermark once that frame is consumed.
    ///
    /// Sent ONLY to clients whose Attach carried `resume` — they declared they
    /// understand this variant; legacy clients keep the untagged legacy replay.
    AttachBacklog {
        name: String,
        #[serde(with = "epoch_string")]
        epoch: u64,
        end_offset: u64,
        full: bool,
    },
    /// Client -> daemon: change amber's aggregate memory budget to `mb` MiB
    /// (0 = auto: half of physical RAM, still capped by the OS cgroup limit).
    /// The daemon persists it to config, re-derives the effective budget
    /// against the LIVE service cap, re-applies every session leaf's
    /// `memory.high`, and switches the running guardian over — no restart.
    /// Replies `BudgetApplied`, or `Error` on a rejected value.
    SetMemoryBudget { mb: u64 },
    /// Client -> daemon: report the current budget state. Replies
    /// `BudgetApplied`.
    GetMemoryBudget,
    /// Daemon -> client: the memory-budget truth. `mb` is the CONFIGURED
    /// budget in MiB (0 = auto). `effective_budget_kb` is what the guardian
    /// uses right now (0 = no usable aggregate: automatic parking disabled).
    /// `cgroup_limit_kb` is the live lowest finite ancestor cap (0 = none).
    /// `session_high_kb` is each session leaf's soft ceiling.
    BudgetApplied {
        mb: u64,
        #[serde(default)]
        effective_budget_kb: u64,
        #[serde(default)]
        cgroup_limit_kb: u64,
        #[serde(default)]
        session_high_kb: u64,
    },
    /// Client -> daemon: report each agent provider's plan-quota snapshot.
    /// Answered from the daemon's 60 s poller cache — NEVER a live fetch on the
    /// connection read thread, behind which every multiplexed control frame
    /// would queue (the backlog head-of-line lesson).
    GetUsage,
    /// Daemon -> client: the cached quota snapshot, one entry per provider.
    /// Never broadcast to watchers — a once-a-minute payload has no business on
    /// the bounded lifecycle queue; this is a poll reply only.
    Usage { providers: Vec<ProviderUsage> },
    SessionList { names: Vec<String> },
    Created { name: String },
    Killed { name: String },
    Exit { name: String, code: i32 },
    Error { msg: String },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Control(ControlMsg),
    Data { session: String, bytes: Vec<u8> },
    /// Daemon -> client: a one-shot scrollback dump (reply to `DumpBacklog`).
    ///
    /// Same body layout as [`Frame::Data`], and for the same reason: raw bytes
    /// belong on the wire verbatim. It used to ride `ControlMsg::Backlog`,
    /// whose serde-JSON turned a 2 MiB ring into ~8 MB of decimal text on the
    /// daemon and a 2-million-element JS array on the client.
    ///
    /// A separate tag rather than reusing `Data` because `Data` is pty output
    /// bound for a pane's terminal; a dump is a reply to a request and must not
    /// be written into the pane.
    Backlog { session: String, bytes: Vec<u8> },
}

/// Outcome of a lenient decode ([`Decoder::next_decoded`]). Distinguishes a
/// usable frame from a well-framed control body that failed serde decode — a
/// newer peer sending a control message this build doesn't know. Because
/// framing is length-prefixed, an undecodable body has already been consumed
/// and the stream stays in sync, so the daemon can log-and-skip it instead of
/// dropping the whole (multiplexed) connection over one unknown message.
#[derive(Debug)]
pub enum Decoded {
    Frame(Frame),
    UndecodableControl(anyhow::Error),
}

const TAG_CONTROL: u8 = 0;
const TAG_DATA: u8 = 1;
const TAG_BACKLOG: u8 = 2;

fn is_zero(value: &u64) -> bool {
    *value == 0
}

// Keep this exhaustive with `ControlMsg`: an omitted known variant would make
// a malformed instance look like a safely-skippable future message.
fn known_control_variant(name: &str) -> bool {
    matches!(
        name,
        "Hello"
            | "ListSessions"
            | "Create"
            | "Attach"
            | "Detach"
            | "Focus"
            | "Resize"
            | "Kill"
            | "Rename"
            | "SetTitle"
            | "TitleSet"
            | "ReportRunState"
            | "Suspend"
            | "Resume"
            | "Snapshot"
            | "SnapshotOk"
            | "DumpBacklog"
            | "SearchScrollback"
            | "SearchResults"
            | "ListRecoveryEvents"
            | "ClearRecoveryEvents"
            | "RecoveryEvents"
            | "RecoveryEventsCleared"
            | "Backlog"
            | "WatchSessions"
            | "WatchMemoryPressure"
            | "ListSessionsDetailed"
            | "Sessions"
            | "SessionsChanged"
            | "Activity"
            | "MemoryStat"
            | "MemoryPressure"
            | "ResourcePressure"
            | "RunStateAck"
            | "AttachBacklog"
            | "SetMemoryBudget"
            | "GetMemoryBudget"
            | "BudgetApplied"
            | "SessionList"
            | "Created"
            | "Killed"
            | "Exit"
            | "Error"
    )
}

fn control_variant_name(value: &serde_json::Value) -> Option<&str> {
    match value {
        serde_json::Value::String(name) => Some(name),
        serde_json::Value::Object(object) if object.len() == 1 => {
            object.keys().next().map(String::as_str)
        }
        _ => None,
    }
}

/// Maximum accepted frame body length. Generously above the largest
/// legitimate frame (a full 2 MiB scrollback backlog in one `Data` frame);
/// anything bigger is treated as a corrupt/hostile length prefix so the
/// decoder can never be made to buffer gigabytes. Also keeps `4 + len` from
/// overflowing `usize` on 32-bit targets.
pub const MAX_FRAME_LEN: usize = 64 * 1024 * 1024;

/// Serialize a frame to its length-prefixed wire form.
pub fn encode(frame: &Frame) -> Vec<u8> {
    let mut body = Vec::new();
    match frame {
        Frame::Control(msg) => {
            body.push(TAG_CONTROL);
            // ControlMsg is a plain enum of strings/ints — serialization cannot fail.
            let json = serde_json::to_vec(msg).expect("ControlMsg serializes");
            body.extend_from_slice(&json);
        }
        Frame::Data { session, bytes } | Frame::Backlog { session, bytes } => {
            body.push(if matches!(frame, Frame::Data { .. }) { TAG_DATA } else { TAG_BACKLOG });
            let name = session.as_bytes();
            body.extend_from_slice(&(name.len() as u16).to_be_bytes());
            body.extend_from_slice(name);
            body.extend_from_slice(bytes);
        }
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out
}

/// Streaming frame decoder: [`feed`](Decoder::feed) arbitrary chunks, then pull
/// complete frames with [`next_frame`](Decoder::next_frame).
#[derive(Debug, Default)]
pub struct Decoder {
    buf: Vec<u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Decoder::default()
    }

    /// Append received bytes. Chunk boundaries are irrelevant.
    pub fn feed(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
    }

    /// Pull the next complete frame, or `Ok(None)` if more bytes are needed.
    ///
    /// Strict: a control body that fails serde decode is a hard error, dropping
    /// the connection. Used by clients (attach/CLI), where an undecodable reply
    /// is unrecoverable. The daemon's inbound path uses [`next_decoded`] instead
    /// to log-and-skip such a frame (forward-compat).
    ///
    /// [`next_decoded`]: Self::next_decoded
    pub fn next_frame(&mut self) -> anyhow::Result<Option<Frame>> {
        match self.next_decoded()? {
            Some(Decoded::Frame(f)) => Ok(Some(f)),
            Some(Decoded::UndecodableControl(e)) => Err(e),
            None => Ok(None),
        }
    }

    /// Like [`next_frame`](Self::next_frame) but forward-tolerant: a well-framed
    /// control body that fails serde decode yields
    /// [`Decoded::UndecodableControl`] instead of an error, so the caller can
    /// skip it and keep the connection alive. Genuine framing violations
    /// (oversize length, truncated/malformed/unknown-tag frames) are still hard
    /// errors — skipping those would mean trusting a corrupt length prefix.
    pub fn next_decoded(&mut self) -> anyhow::Result<Option<Decoded>> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
        if len > MAX_FRAME_LEN {
            anyhow::bail!("frame length {len} exceeds maximum {MAX_FRAME_LEN}");
        }
        if self.buf.len() < 4 + len {
            return Ok(None);
        }
        let body: Vec<u8> = self.buf[4..4 + len].to_vec();
        // Drain BEFORE decoding the body: framing is length-prefixed, so once
        // the frame is consumed the stream stays in sync even if the body turns
        // out to be an undecodable control message we skip.
        self.buf.drain(..4 + len);

        let (&tag, rest) = body
            .split_first()
            .ok_or_else(|| anyhow::anyhow!("empty frame body"))?;
        let decoded = match tag {
            TAG_CONTROL => {
                // Parse syntax separately from the enum so forward-compatible
                // callers can distinguish a genuinely unknown future variant
                // from a KNOWN variant with malformed fields. Only the former
                // is safe to skip; accepting the latter would silently weaken
                // validation (notably MemoryPressure.level).
                let value: serde_json::Value = serde_json::from_slice(rest)?;
                match serde_json::from_value::<ControlMsg>(value.clone()) {
                    Ok(msg) => Decoded::Frame(Frame::Control(msg)),
                    Err(error)
                        if control_variant_name(&value)
                            .is_some_and(|name| !known_control_variant(name)) =>
                    {
                        Decoded::UndecodableControl(anyhow::Error::new(error))
                    }
                    Err(error) => return Err(anyhow::Error::new(error)),
                }
            }
            TAG_DATA | TAG_BACKLOG => {
                if rest.len() < 2 {
                    anyhow::bail!("truncated data frame header");
                }
                let name_len = u16::from_be_bytes([rest[0], rest[1]]) as usize;
                if rest.len() < 2 + name_len {
                    anyhow::bail!("truncated data frame name");
                }
                let session = std::str::from_utf8(&rest[2..2 + name_len])?.to_string();
                let bytes = rest[2 + name_len..].to_vec();
                Decoded::Frame(if tag == TAG_DATA {
                    Frame::Data { session, bytes }
                } else {
                    Frame::Backlog { session, bytes }
                })
            }
            other => anyhow::bail!("unknown frame tag {other}"),
        };
        Ok(Some(decoded))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(f: &Frame) -> Frame {
        let mut d = Decoder::new();
        d.feed(&encode(f));
        d.next_frame().unwrap().expect("one full frame")
    }

    /// Hand-encode a control frame with an arbitrary JSON body (bypassing
    /// `encode`, which only ever emits valid `ControlMsg`) — used to simulate a
    /// newer peer sending a control message this build can't decode.
    fn encode_raw_control(json: &[u8]) -> Vec<u8> {
        let mut body = vec![TAG_CONTROL];
        body.extend_from_slice(json);
        let mut out = (body.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn backlog_frame_roundtrips_raw_bytes_on_its_own_tag() {
        // A scrollback dump rides its own binary tag, NOT ControlMsg::Backlog:
        // as a control message the bytes were serde-JSON'd into a numeric array,
        // turning a 2 MiB ring into ~8 MB of decimal text.
        let f = Frame::Backlog {
            session: "amber-1-1-0-a".to_string(),
            bytes: vec![0, 27, 91, 50, 74, 255, 0, 10],
        };
        assert_eq!(roundtrip(&f), f);
        // Tag 2, and the body layout matches Data's (u16 name_len | name | raw).
        let wire = encode(&f);
        assert_eq!(wire[4], 2, "backlog must use its own tag");
    }

    #[test]
    fn backlog_and_data_with_identical_payloads_stay_distinct() {
        // They share a body layout, so a decode that ignored the tag would
        // silently write a scrollback dump into the pane's terminal.
        let session = "s".to_string();
        let bytes = vec![1, 2, 3];
        let d = Frame::Data { session: session.clone(), bytes: bytes.clone() };
        let b = Frame::Backlog { session, bytes };
        assert_ne!(encode(&d), encode(&b));
        assert_eq!(roundtrip(&d), d);
        assert_eq!(roundtrip(&b), b);
    }

    #[test]
    fn backlog_frame_survives_a_zero_length_payload() {
        // A pane with no scrollback yet: name present, zero bytes.
        let f = Frame::Backlog { session: "s".to_string(), bytes: Vec::new() };
        assert_eq!(roundtrip(&f), f);
    }

    #[test]
    fn undecodable_control_body_is_skippable_not_fatal() {
        // Forward-compat: a newer peer sends a control variant this build does
        // not know. Framing is length-prefixed, so the body is already consumed
        // and the stream stays in sync — `next_decoded` reports a skippable
        // signal instead of erroring, and the following good frame still decodes.
        let mut d = Decoder::new();
        d.feed(&encode_raw_control(br#"{"FutureMsg":{"x":1}}"#));
        d.feed(&encode(&Frame::Control(ControlMsg::Hello)));
        match d.next_decoded().unwrap() {
            Some(Decoded::UndecodableControl(_)) => {}
            other => panic!("expected UndecodableControl skip, got {other:?}"),
        }
        match d.next_decoded().unwrap() {
            Some(Decoded::Frame(Frame::Control(ControlMsg::Hello))) => {}
            other => panic!("stream out of sync after skip: {other:?}"),
        }
        assert!(d.next_decoded().unwrap().is_none());
    }

    #[test]
    fn next_decoded_still_hard_errors_on_framing_violation() {
        // Oversize length is a genuine framing violation, NOT a decodable body:
        // it must stay a hard error (the connection drops) even on the lenient
        // path — skipping it would mean trusting a corrupt/hostile length prefix.
        let mut d = Decoder::new();
        let mut bytes = ((MAX_FRAME_LEN as u32) + 1).to_be_bytes().to_vec();
        bytes.push(TAG_CONTROL);
        d.feed(&bytes);
        assert!(d.next_decoded().is_err());
    }

    #[test]
    fn next_decoded_skips_unknown_but_rejects_malformed_known_control() {
        let mut d = Decoder::new();
        d.feed(&encode_raw_control(
            br#"{"MemoryPressure":{"current_kb":42}}"#,
        ));
        assert!(
            d.next_decoded().is_err(),
            "a known control with invalid fields must not be mistaken for a future variant"
        );
    }

    #[test]
    fn next_frame_still_errors_on_undecodable_control() {
        // Back-compat: strict callers (attach/CLI) keep getting a hard error on
        // an undecodable control body — only the daemon opts into leniency via
        // `next_decoded`.
        let mut d = Decoder::new();
        d.feed(&encode_raw_control(br#"{"FutureMsg":{}}"#));
        assert!(d.next_frame().is_err());
    }

    #[test]
    fn control_frame_roundtrips() {
        let f = Frame::Control(ControlMsg::Attach { name: "a".into(), raw_client: true, preview: false, resume: None });
        assert_eq!(roundtrip(&f), f);
    }

    #[test]
    fn attach_without_raw_client_field_defaults_to_false() {
        // Backward compatibility lock: the Electron app (and older binaries)
        // send Attach without `raw_client`; they must decode as the
        // full-backlog behavior, not an error.
        let msg: ControlMsg = serde_json::from_str(r#"{"Attach":{"name":"a"}}"#).unwrap();
        assert_eq!(msg, ControlMsg::Attach { name: "a".into(), raw_client: false, preview: false, resume: None });
    }

    #[test]
    fn attach_without_preview_field_defaults_to_false() {
        // Same back-compat guarantee for the new field: an older client (or an
        // older binary's own recorded fixtures) that never heard of `preview`
        // must still decode, as `false` = today's full-backlog attach.
        let msg: ControlMsg =
            serde_json::from_str(r#"{"Attach":{"name":"a","raw_client":true}}"#).unwrap();
        assert_eq!(msg, ControlMsg::Attach { name: "a".into(), raw_client: true, preview: false, resume: None });
    }

    #[test]
    fn attach_resume_is_absent_from_the_wire_when_unset() {
        // The KEY's presence is the opt-in for AttachBacklog replies, so a
        // first attach must serialize byte-identically to the legacy form.
        let json = serde_json::to_string(&ControlMsg::Attach {
            name: "a".into(),
            raw_client: false,
            preview: false,
            resume: None,
        })
        .unwrap();
        assert_eq!(json, r#"{"Attach":{"name":"a","raw_client":false,"preview":false}}"#);
    }

    #[test]
    fn attach_resume_roundtrips_with_a_string_epoch() {
        // The epoch exceeds 2^53, so it MUST be a JSON string — a number would
        // be silently rounded by JS and never match again.
        let msg = ControlMsg::Attach {
            name: "a".into(),
            raw_client: false,
            preview: false,
            resume: Some(AttachResume { epoch: 1_712_345_678_901_234_567, offset: 42 }),
        };
        assert_eq!(roundtrip(&Frame::Control(msg.clone())), Frame::Control(msg.clone()));
        let json = serde_json::to_string(&msg).unwrap();
        assert!(
            json.contains(r#""resume":{"epoch":"1712345678901234567","offset":42}"#),
            "epoch must ride as a string: {json}"
        );
        // And decodes back from that exact shape.
        let decoded: ControlMsg = serde_json::from_str(
            r#"{"Attach":{"name":"a","resume":{"epoch":"7","offset":9}}}"#,
        )
        .unwrap();
        assert_eq!(
            decoded,
            ControlMsg::Attach {
                name: "a".into(),
                raw_client: false,
                preview: false,
                resume: Some(AttachResume { epoch: 7, offset: 9 }),
            }
        );
    }

    #[test]
    fn attach_backlog_roundtrips() {
        let msg = ControlMsg::AttachBacklog {
            name: "amber-1-1-0-a".into(),
            epoch: 9_007_199_254_740_993, // 2^53 + 1: string-encoded
            end_offset: 2048,
            full: false,
        };
        assert_eq!(roundtrip(&Frame::Control(msg.clone())), Frame::Control(msg.clone()));
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""epoch":"9007199254740993""#), "{json}");
    }

    #[test]
    fn memory_budget_messages_roundtrip_with_additive_defaults() {
        let set = Frame::Control(ControlMsg::SetMemoryBudget { mb: 20_480 });
        assert_eq!(roundtrip(&set), set);
        assert_eq!(roundtrip(&Frame::Control(ControlMsg::GetMemoryBudget)), Frame::Control(ControlMsg::GetMemoryBudget));

        // A peer that predates the numeric fields decodes them as 0.
        let applied: ControlMsg =
            serde_json::from_str(r#"{"BudgetApplied":{"mb":20480}}"#).unwrap();
        assert_eq!(
            applied,
            ControlMsg::BudgetApplied { mb: 20_480, effective_budget_kb: 0, cgroup_limit_kb: 0, session_high_kb: 0 }
        );

        let full = Frame::Control(ControlMsg::BudgetApplied {
            mb: 0, // auto
            effective_budget_kb: 8_388_608,
            cgroup_limit_kb: 8_388_608,
            session_high_kb: 4_194_304,
        });
        assert_eq!(roundtrip(&full), full);
    }

    #[test]
    fn snapshot_control_roundtrips() {
        let req = Frame::Control(ControlMsg::Snapshot);
        assert_eq!(roundtrip(&req), req);
        let ack = Frame::Control(ControlMsg::SnapshotOk);
        assert_eq!(roundtrip(&ack), ack);
    }

    #[test]
    fn focus_control_roundtrips() {
        let frame = Frame::Control(ControlMsg::Focus {
            name: "amber-1-1-0-x".into(),
        });
        assert_eq!(roundtrip(&frame), frame);
    }

    #[test]
    fn memory_pressure_roundtrips_with_additive_fields() {
        let frame = Frame::Control(ControlMsg::MemoryPressure {
            level: "critical".into(),
            current_kb: 7_000_000,
            budget_kb: 8_000_000,
            blocked: true,
        });
        assert_eq!(roundtrip(&frame), frame);
    }

    #[test]
    fn memory_pressure_defaults_only_additive_fields() {
        let msg: ControlMsg =
            serde_json::from_str(r#"{"MemoryPressure":{"level":"warning"}}"#).unwrap();
        assert_eq!(
            msg,
            ControlMsg::MemoryPressure {
                level: "warning".into(),
                current_kb: 0,
                budget_kb: 0,
                blocked: false,
            }
        );
        assert!(serde_json::from_str::<ControlMsg>(r#"{"MemoryPressure":{}}"#).is_err());
    }

    #[test]
    fn resource_pressure_uses_the_approved_json_shape() {
        // Watcher clients match this additive control message exactly; a field
        // rename or enum spelling change would silently break their banner.
        let message = ControlMsg::ResourcePressure {
            level: ResourcePressureLevel::Critical,
            causes: vec![ResourcePressureCause::Cpu, ResourcePressureCause::Io],
            blocked: false,
        };
        assert_eq!(
            serde_json::to_string(&message).unwrap(),
            r#"{"ResourcePressure":{"level":"critical","causes":["cpu","io"],"blocked":false}}"#,
        );
        assert_eq!(roundtrip(&Frame::Control(message.clone())), Frame::Control(message));
    }

    #[test]
    fn resource_pressure_rejects_unknown_levels_and_causes() {
        // Strict decode prevents a newer or corrupt peer from showing a
        // made-up pressure state as trustworthy host policy.
        assert!(serde_json::from_str::<ControlMsg>(
            r#"{"ResourcePressure":{"level":"urgent","causes":["cpu"],"blocked":false}}"#,
        )
        .is_err());
        assert!(serde_json::from_str::<ControlMsg>(
            r#"{"ResourcePressure":{"level":"critical","causes":["network"],"blocked":false}}"#,
        )
        .is_err());
    }

    #[test]
    fn malformed_resource_pressure_is_not_skipped_as_an_unknown_variant() {
        // Lenient decoding may skip future variants, but this build knows
        // ResourcePressure and must reject a malformed instance outright.
        let mut decoder = Decoder::new();
        decoder.feed(&encode_raw_control(
            br#"{"ResourcePressure":{"level":"urgent","causes":["cpu"],"blocked":false}}"#,
        ));
        assert!(decoder.next_decoded().is_err());
    }

    #[test]
    fn memory_pressure_serialization_remains_byte_compatible() {
        // ResourcePressure is additive. Existing version-1 watcher payloads
        // must retain their exact serialized form during mixed upgrades.
        let message = ControlMsg::MemoryPressure {
            level: "critical".into(),
            current_kb: 7_000_000,
            budget_kb: 8_000_000,
            blocked: true,
        };
        assert_eq!(
            serde_json::to_string(&message).unwrap(),
            r#"{"MemoryPressure":{"level":"critical","current_kb":7000000,"budget_kb":8000000,"blocked":true}}"#,
        );
    }

    #[test]
    fn data_frame_preserves_raw_bytes() {
        // bytes that look like length prefixes / contain NULs must survive.
        let f = Frame::Data {
            session: "s".into(),
            bytes: vec![0, 1, 255, 0, 0, 0, 5, 27, b'[', b'2', b'J'],
        };
        assert_eq!(roundtrip(&f), f);
    }

    #[test]
    fn data_frame_empty_bytes() {
        let f = Frame::Data { session: "x".into(), bytes: vec![] };
        assert_eq!(roundtrip(&f), f);
    }

    #[test]
    fn multibyte_session_name() {
        let f = Frame::Data { session: "amber-≈-café".into(), bytes: b"hi".to_vec() };
        assert_eq!(roundtrip(&f), f);
    }

    #[test]
    fn decoder_returns_none_until_full_frame() {
        let bytes = encode(&Frame::Control(ControlMsg::Hello));
        let mut d = Decoder::new();
        // split across the length prefix
        d.feed(&bytes[..2]);
        assert_eq!(d.next_frame().unwrap(), None);
        d.feed(&bytes[2..]);
        assert_eq!(
            d.next_frame().unwrap(),
            Some(Frame::Control(ControlMsg::Hello))
        );
        assert_eq!(d.next_frame().unwrap(), None);
    }

    #[test]
    fn decoder_yields_multiple_frames_from_one_buffer() {
        let a = Frame::Control(ControlMsg::ListSessions);
        let b = Frame::Data { session: "s".into(), bytes: b"abc".to_vec() };
        let mut buf = encode(&a);
        buf.extend_from_slice(&encode(&b));
        let mut d = Decoder::new();
        d.feed(&buf);
        assert_eq!(d.next_frame().unwrap(), Some(a));
        assert_eq!(d.next_frame().unwrap(), Some(b));
        assert_eq!(d.next_frame().unwrap(), None);
    }

    #[test]
    fn decoder_rejects_oversized_frame_length() {
        // A corrupt/malicious length prefix must error out instead of making
        // the decoder buffer up to 4 GiB.
        let mut d = Decoder::new();
        let mut bytes = ((MAX_FRAME_LEN as u32) + 1).to_be_bytes().to_vec();
        bytes.push(TAG_CONTROL);
        d.feed(&bytes);
        assert!(d.next_frame().is_err());
    }

    #[test]
    fn decoder_accepts_frame_at_exact_max_len() {
        // A Data frame whose body is exactly MAX_FRAME_LEN must still decode.
        let payload = vec![7u8; MAX_FRAME_LEN - 1 /*tag*/ - 2 /*name len*/ - 1 /*name*/];
        let f = Frame::Data { session: "s".into(), bytes: payload };
        let mut d = Decoder::new();
        d.feed(&encode(&f));
        assert_eq!(d.next_frame().unwrap(), Some(f));
    }

    #[test]
    fn session_info_variants_roundtrip() {
        let info = SessionInfo {
            name: "amber-1-1-0-abc".into(),
            cwd: "/home/u/proj".into(),
            kind: "claude".into(),
            alive: true,
            updated: 1_700_000_000,
            title: Some("Project shell".into()),
            run_state: Some("claude-retrying".into()),
            claude_id: Some("sid-abc".into()),
            cols: 120,
            rows: 40,
            slot: 3,
        };
        let full = Frame::Control(ControlMsg::Sessions { sessions: vec![info.clone()] });
        assert_eq!(roundtrip(&full), full);

        let delta = Frame::Control(ControlMsg::SessionsChanged {
            added: vec![info],
            removed: vec!["amber-1-1-1-def".into()],
        });
        assert_eq!(roundtrip(&delta), delta);

        for unit in [ControlMsg::WatchSessions, ControlMsg::ListSessionsDetailed] {
            let f = Frame::Control(unit);
            assert_eq!(roundtrip(&f), f);
        }
    }

    #[test]
    fn title_set_ack_roundtrips_with_name_and_title() {
        let set = Frame::Control(ControlMsg::TitleSet {
            name: "amber-1-1-0-a".into(),
            title: Some("Build".into()),
        });
        assert_eq!(roundtrip(&set), set);
        assert_eq!(
            serde_json::to_string(&ControlMsg::TitleSet {
                name: "amber-1-1-0-a".into(),
                title: None,
            })
            .unwrap(),
            r#"{"TitleSet":{"name":"amber-1-1-0-a","title":null}}"#,
        );
    }

    #[test]
    fn friendly_title_is_optional_on_the_wire() {
        let no_title = serde_json::to_string(&ControlMsg::Create {
            name: "amber-1-1-0-a".into(),
            cwd: "/tmp".into(),
            kind: "shell".into(),
            title: None,
        })
        .unwrap();
        assert_eq!(no_title, r#"{"Create":{"name":"amber-1-1-0-a","cwd":"/tmp","kind":"shell"}}"#);
        let titled = serde_json::to_string(&ControlMsg::Create {
            name: "amber-1-1-0-a".into(),
            cwd: "/tmp".into(),
            kind: "shell".into(),
            title: Some("Build".into()),
        })
        .unwrap();
        assert!(titled.contains(r#""title":"Build""#));
        let legacy: SessionInfo = serde_json::from_str(
            r#"{"name":"s","cwd":"/tmp","kind":"shell","alive":true}"#,
        )
        .unwrap();
        assert_eq!(legacy.title, None);
    }

    #[test]
    fn session_info_updated_defaults_when_absent() {
        // A peer that predates the `updated`/`run_state` fields omits them from
        // the JSON; `#[serde(default)]` must decode that as 0/None, not fail.
        let legacy = r#"{"name":"s","cwd":"/tmp","kind":"shell","alive":true}"#;
        let info: SessionInfo = serde_json::from_str(legacy).unwrap();
        assert_eq!(info.updated, 0);
        assert_eq!(info.run_state, None);
        assert_eq!((info.cols, info.rows), (0, 0));
        assert_eq!(info.name, "s");
    }

    #[test]
    fn report_run_state_control_roundtrips() {
        let f = Frame::Control(ControlMsg::ReportRunState {
            name: "amber-1-1-0-a".into(),
            state: "claude-retrying".into(),
            seq: 7,
        });
        assert_eq!(roundtrip(&f), f);
        // Lock the externally-tagged JSON shape the supervisor emits.
        let json = serde_json::to_string(&ControlMsg::ReportRunState {
            name: "s".into(),
            state: "shell-fallback".into(),
            seq: 0,
        })
        .unwrap();
        assert_eq!(json, r#"{"ReportRunState":{"name":"s","state":"shell-fallback"}}"#);
    }

    #[test]
    fn session_info_carries_run_state_on_the_wire() {
        // A claude session's reported phase must survive encode/decode so the
        // app can render the pane's supervision state.
        let info = SessionInfo {
            name: "amber-1-1-0-a".into(),
            cwd: "/tmp".into(),
            kind: "claude".into(),
            alive: true,
            updated: 0,
            title: None,
            run_state: Some("shell-fallback".into()),
            claude_id: None,
            cols: 80,
            rows: 24,
            slot: 1,
        };
        let f = Frame::Control(ControlMsg::Sessions { sessions: vec![info] });
        assert_eq!(roundtrip(&f), f);
    }

    #[test]
    fn activity_control_roundtrips() {
        let f = Frame::Control(ControlMsg::Activity { name: "amber-1-1-0-a".into() });
        assert_eq!(roundtrip(&f), f);
        // Lock the externally-tagged JSON shape the TS client decodes.
        let json = serde_json::to_string(&ControlMsg::Activity { name: "s".into() }).unwrap();
        assert_eq!(json, r#"{"Activity":{"name":"s"}}"#);
    }

    #[test]
    fn search_controls_roundtrip() {
        let request = Frame::Control(ControlMsg::SearchScrollback {
            request_id: 7,
            query: "needle".into(),
            names: vec!["a".into(), "b".into()],
            limit: 25,
        });
        assert_eq!(roundtrip(&request), request);
        let reply = Frame::Control(ControlMsg::SearchResults {
            request_id: 7,
            query: "needle".into(),
            results: vec![SearchResult {
                name: "a".into(),
                line: 3,
                preview: "a needle here".into(),
            }],
        });
        assert_eq!(roundtrip(&reply), reply);
        assert!(serde_json::to_string(&ControlMsg::SearchScrollback {
            request_id: 7,
            query: "needle".into(),
            names: vec![],
            limit: 0,
        })
        .unwrap()
        .contains("SearchScrollback"));
    }

    #[test]
    fn recovery_controls_roundtrip() {
        let event = RecoveryEvent {
            at: 1_700_000_000,
            sequence: 4,
            level: "error".into(),
            event: "session.restore_failed".into(),
            session: Some("s".into()),
            detail: "spawn failed".into(),
            code: Some(127),
        };
        for message in [
            ControlMsg::ListRecoveryEvents { limit: 200 },
            ControlMsg::ClearRecoveryEvents,
            ControlMsg::RecoveryEvents { events: vec![event] },
            ControlMsg::RecoveryEventsCleared,
        ] {
            let frame = Frame::Control(message);
            assert_eq!(roundtrip(&frame), frame);
        }
        let request: ControlMsg = serde_json::from_str(
            r#"{"ListRecoveryEvents":{}}"#,
        )
        .unwrap();
        assert_eq!(request, ControlMsg::ListRecoveryEvents { limit: 0 });
    }

    #[test]
    fn search_request_additive_fields_default() {
        let msg: ControlMsg = serde_json::from_str(
            r#"{"SearchScrollback":{"request_id":1,"query":"x"}}"#,
        )
        .unwrap();
        assert_eq!(
            msg,
            ControlMsg::SearchScrollback {
                request_id: 1,
                query: "x".into(),
                names: vec![],
                limit: 0,
            }
        );
    }

    #[test]
    fn dump_backlog_and_backlog_roundtrip() {
        let req = Frame::Control(ControlMsg::DumpBacklog { name: "amber-1-1-0-a".into() });
        assert_eq!(roundtrip(&req), req);
        let reply = Frame::Control(ControlMsg::Backlog {
            name: "amber-1-1-0-a".into(),
            data: vec![0, 1, 255, 27, b'[', b'2', b'J'],
        });
        assert_eq!(roundtrip(&reply), reply);
    }

    #[test]
    fn backlog_data_is_a_json_numeric_array() {
        // Shape-lock for the TS port: serde_json serializes `Vec<u8>` as a JSON
        // array of numbers (NOT base64). proto.ts must decode `data` the same
        // way. Locking it here catches a serde/serde_bytes change that would
        // silently break the wire.
        let json = serde_json::to_string(&ControlMsg::Backlog {
            name: "s".into(),
            data: vec![0, 65, 255],
        })
        .unwrap();
        assert_eq!(json, r#"{"Backlog":{"name":"s","data":[0,65,255]}}"#);
        // And the request side.
        let json = serde_json::to_string(&ControlMsg::DumpBacklog { name: "s".into() }).unwrap();
        assert_eq!(json, r#"{"DumpBacklog":{"name":"s"}}"#);
    }

    #[test]
    fn control_enum_is_externally_tagged() {
        // The TS client mirrors this exact JSON. Lock the shape so a serde
        // change that breaks the wire is caught here.
        let json = serde_json::to_string(&ControlMsg::WatchSessions).unwrap();
        assert_eq!(json, "\"WatchSessions\"");
        let json = serde_json::to_string(&ControlMsg::SessionsChanged {
            added: vec![],
            removed: vec!["x".into()],
        })
        .unwrap();
        assert_eq!(json, r#"{"SessionsChanged":{"added":[],"removed":["x"]}}"#);
    }

    #[test]
    fn decoder_handles_byte_at_a_time() {
        let f = Frame::Data { session: "s".into(), bytes: vec![0u8, 10, 13, 255] };
        let bytes = encode(&f);
        let mut d = Decoder::new();
        for b in &bytes {
            assert_eq!(d.next_frame().unwrap(), None);
            d.feed(std::slice::from_ref(b));
        }
        assert_eq!(d.next_frame().unwrap(), Some(f));
    }

    #[test]
    fn usage_control_roundtrips() {
        let msg = ControlMsg::Usage {
            providers: vec![ProviderUsage {
                provider: "claude".into(),
                plan: Some("pro".into()),
                gauges: vec![Gauge {
                    kind: "session".into(),
                    label: "5h window".into(),
                    percent: 15.0,
                    resets_at: Some(1_788_321_600),
                    stale: false,
                }],
                updated: 1_788_300_000,
                state: "ok".into(),
                detail: None,
            }],
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(serde_json::from_str::<ControlMsg>(&json).unwrap(), msg);
    }

    #[test]
    fn get_usage_is_a_unit_variant_on_the_wire() {
        // Unit variants serialize as a bare string; the TS decoder relies on it.
        assert_eq!(serde_json::to_string(&ControlMsg::GetUsage).unwrap(), "\"GetUsage\"");
    }

    #[test]
    fn provider_usage_tolerates_a_minimal_peer_payload() {
        // Every optional field defaults, so a leaner/older sender still decodes.
        let p: ProviderUsage =
            serde_json::from_str(r#"{"provider":"grok","state":"unavailable"}"#).unwrap();
        assert_eq!(p.provider, "grok");
        assert!(p.gauges.is_empty());
        assert_eq!(p.plan, None);
        assert_eq!(p.detail, None);
        assert_eq!(p.updated, 0);
    }
}
