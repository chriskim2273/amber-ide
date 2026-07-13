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
pub enum ControlMsg {
    Hello,
    ListSessions,
    Create { name: String, cwd: String, kind: String },
    Attach { name: String },
    Detach { name: String },
    Resize { name: String, cols: u16, rows: u16 },
    Kill { name: String },
    Rename { from: String, to: String },
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
        let f = Frame::Control(ControlMsg::Attach { name: "a".into() });
        assert_eq!(roundtrip(&f), f);
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
