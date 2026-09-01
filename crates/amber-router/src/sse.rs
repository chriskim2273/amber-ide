use std::time::Duration;

use bytes::Bytes;
use eventsource_stream::Eventsource;
use futures_util::stream::{self, Stream, StreamExt};

/// A frame is an error only when its JSON payload carries a top-level `error` key.
/// `[DONE]`, empty keep-alives, and non-JSON comments are not errors.
pub fn first_frame_is_error(frame: &str) -> bool {
    let trimmed = frame.trim();
    if trimmed.is_empty() || trimmed == "[DONE]" {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(trimmed)
        .map(|v| v.get("error").is_some())
        .unwrap_or(false)
}

#[derive(Debug)]
pub enum GateFailure {
    /// Upstream returned 200 and then an error frame. Failover is still allowed.
    UpstreamError { body: String },
    /// No usable frame arrived before the first-byte timeout.
    Timeout,
    /// The stream ended without producing any frame.
    Empty,
}

pub struct GatedStream {
    pub first: String,
    pub rest: std::pin::Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>,
}

/// Reads frames until the first meaningful one, validates it, and returns a stream that
/// replays that frame ahead of the remainder. Nothing is written downstream until this
/// returns Ok, so a 200-then-error response never reaches the client.
pub async fn gate_stream(
    resp: reqwest::Response,
    first_byte: Duration,
) -> Result<GatedStream, GateFailure> {
    let mut events = resp.bytes_stream().eventsource();
    let deadline = tokio::time::Instant::now() + first_byte;

    let first = loop {
        let next = tokio::time::timeout_at(deadline, events.next()).await;
        match next {
            Err(_) => return Err(GateFailure::Timeout),
            Ok(None) => return Err(GateFailure::Empty),
            Ok(Some(Err(_))) => return Err(GateFailure::Empty),
            Ok(Some(Ok(ev))) => {
                if ev.data.trim().is_empty() {
                    continue; // keep-alive; must not reset the first-byte deadline
                }
                if first_frame_is_error(&ev.data) {
                    return Err(GateFailure::UpstreamError { body: ev.data });
                }
                break ev.data;
            }
        }
    };

    let replay = first.clone();
    let rest = events.map(|ev| {
        ev.map(|e| Bytes::from(format!("data: {}\n\n", e.data)))
            .map_err(|e| std::io::Error::other(e.to_string()))
    });

    Ok(GatedStream {
        first: replay,
        rest: Box::pin(rest),
    })
}

/// Build the downstream byte stream: the validated first frame, then the rest.
pub fn into_body_stream(
    gated: GatedStream,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
    let head = stream::once(async move { Ok(Bytes::from(format!("data: {}\n\n", gated.first))) });
    head.chain(gated.rest)
}
