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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ControlMsg {
    Hello,
    ListSessions,
    Create { name: String, cwd: String, kind: String },
    /// `raw_client: true` marks a plain-terminal client (`amber attach`),
    /// which cannot safely replay historical alt-screen bytes (spec §5).
    /// `#[serde(default)]` keeps the wire backward compatible: clients that
    /// omit the field (the Electron app, older binaries) keep getting the
    /// full backlog.
    Attach {
        name: String,
        #[serde(default)]
        raw_client: bool,
    },
    Detach { name: String },
    Resize { name: String, cols: u16, rows: u16 },
    Kill { name: String },
    Rename { from: String, to: String },
    /// Client -> daemon: a `claude` session's `amber run` supervisor reports
    /// its current supervision phase (`state`: one of `"claude"`,
    /// `"claude-retrying"`, `"shell-fallback"`). The daemon stores it on the
    /// session and broadcasts the change to watchers. Fire-and-forget: the
    /// supervisor never waits for a reply (the daemon replies `Error` only for
    /// an unknown session, a non-claude session, or an invalid state string).
    ReportRunState { name: String, state: String },
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
    /// Daemon -> client: the requested session's full scrollback bytes, in one
    /// frame (ring cap ≤2 MiB ≪ 64 MiB frame cap, so no chunking).
    Backlog { name: String, data: Vec<u8> },
    /// Client -> daemon: opt this connection in to pushed session-change events.
    WatchSessions,
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
    SessionList { names: Vec<String> },
    Created { name: String },
    Killed { name: String },
    Exit { name: String, code: i32 },
    Error { msg: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Control(ControlMsg),
    Data { session: String, bytes: Vec<u8> },
}

const TAG_CONTROL: u8 = 0;
const TAG_DATA: u8 = 1;

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
        Frame::Data { session, bytes } => {
            body.push(TAG_DATA);
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
    pub fn next_frame(&mut self) -> anyhow::Result<Option<Frame>> {
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
        self.buf.drain(..4 + len);

        let (&tag, rest) = body
            .split_first()
            .ok_or_else(|| anyhow::anyhow!("empty frame body"))?;
        let frame = match tag {
            TAG_CONTROL => Frame::Control(serde_json::from_slice(rest)?),
            TAG_DATA => {
                if rest.len() < 2 {
                    anyhow::bail!("truncated data frame header");
                }
                let name_len = u16::from_be_bytes([rest[0], rest[1]]) as usize;
                if rest.len() < 2 + name_len {
                    anyhow::bail!("truncated data frame name");
                }
                let session = std::str::from_utf8(&rest[2..2 + name_len])?.to_string();
                let bytes = rest[2 + name_len..].to_vec();
                Frame::Data { session, bytes }
            }
            other => anyhow::bail!("unknown frame tag {other}"),
        };
        Ok(Some(frame))
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

    #[test]
    fn control_frame_roundtrips() {
        let f = Frame::Control(ControlMsg::Attach { name: "a".into(), raw_client: true });
        assert_eq!(roundtrip(&f), f);
    }

    #[test]
    fn attach_without_raw_client_field_defaults_to_false() {
        // Backward compatibility lock: the Electron app (and older binaries)
        // send Attach without `raw_client`; they must decode as the
        // full-backlog behavior, not an error.
        let msg: ControlMsg = serde_json::from_str(r#"{"Attach":{"name":"a"}}"#).unwrap();
        assert_eq!(msg, ControlMsg::Attach { name: "a".into(), raw_client: false });
    }

    #[test]
    fn snapshot_control_roundtrips() {
        let req = Frame::Control(ControlMsg::Snapshot);
        assert_eq!(roundtrip(&req), req);
        let ack = Frame::Control(ControlMsg::SnapshotOk);
        assert_eq!(roundtrip(&ack), ack);
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
            run_state: Some("claude-retrying".into()),
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
    fn session_info_updated_defaults_when_absent() {
        // A peer that predates the `updated`/`run_state` fields omits them from
        // the JSON; `#[serde(default)]` must decode that as 0/None, not fail.
        let legacy = r#"{"name":"s","cwd":"/tmp","kind":"shell","alive":true}"#;
        let info: SessionInfo = serde_json::from_str(legacy).unwrap();
        assert_eq!(info.updated, 0);
        assert_eq!(info.run_state, None);
        assert_eq!(info.name, "s");
    }

    #[test]
    fn report_run_state_control_roundtrips() {
        let f = Frame::Control(ControlMsg::ReportRunState {
            name: "amber-1-1-0-a".into(),
            state: "claude-retrying".into(),
        });
        assert_eq!(roundtrip(&f), f);
        // Lock the externally-tagged JSON shape the supervisor emits.
        let json = serde_json::to_string(&ControlMsg::ReportRunState {
            name: "s".into(),
            state: "shell-fallback".into(),
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
            run_state: Some("shell-fallback".into()),
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
}
