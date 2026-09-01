#![allow(dead_code)] // vendored harness: not every test file uses every helper
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use bytes::Bytes;
use futures_util::stream::{self, StreamExt};

#[derive(Clone, Debug)]
#[allow(dead_code)] // shared across per-test binaries; not every variant is used in each
pub enum Reply {
    Ok {
        body: serde_json::Value,
    },
    Status {
        code: u16,
        body: String,
        retry_after: Option<String>,
    },
    Hang,
    SseOk {
        frames: Vec<String>,
    },
    SseErrorFirst {
        message: String,
    },
    /// First SSE frame is sent immediately; `rest` is delayed by `delay`.
    SseDelayedRest {
        first: String,
        rest: Vec<String>,
        delay: Duration,
    },
    /// Headers are sent immediately; JSON body is delayed by `delay`.
    DelayedJson {
        body: serde_json::Value,
        delay: Duration,
    },
    /// 200 headers, then the body stream errors.
    BodyError,
    /// Empty `data:` keep-alives forever.
    SseKeepAlives {
        interval: Duration,
    },
}

#[derive(Clone)]
struct MockState {
    script: Arc<Vec<Reply>>,
    hits: Arc<AtomicUsize>,
}

pub struct MockProvider {
    addr: std::net::SocketAddr,
    hits: Arc<AtomicUsize>,
}

impl MockProvider {
    pub fn start(script: Vec<Reply>) -> Self {
        assert!(!script.is_empty(), "script must have at least one reply");
        let hits = Arc::new(AtomicUsize::new(0));
        let state = MockState {
            script: Arc::new(script),
            hits: hits.clone(),
        };

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();

        let app = Router::new()
            .route("/chat/completions", post(handle).get(handle))
            .with_state(state);

        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            axum::serve(listener, app).await.unwrap();
        });

        MockProvider { addr, hits }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

async fn handle(State(state): State<MockState>) -> Response {
    let n = state.hits.fetch_add(1, Ordering::SeqCst);
    let idx = n.min(state.script.len() - 1);
    match state.script[idx].clone() {
        Reply::Ok { body } => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),

        Reply::Status {
            code,
            body,
            retry_after,
        } => {
            let mut b = Response::builder().status(code);
            if let Some(ra) = retry_after {
                b = b.header("retry-after", ra);
            }
            b.body(Body::from(body)).unwrap()
        }

        Reply::Hang => {
            // Never resolves: holds the connection open with no timer and no wakeup,
            // so a caller's first-byte timeout is what ends the request.
            std::future::pending::<Response>().await
        }

        Reply::SseOk { frames } => {
            let payload: String = frames.iter().map(|f| format!("data: {f}\n\n")).collect();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from(payload))
                .unwrap()
        }

        Reply::SseErrorFirst { message } => {
            let payload = format!("data: {{\"error\":{{\"message\":\"{message}\"}}}}\n\n");
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from(payload))
                .unwrap()
        }

        Reply::SseDelayedRest { first, rest, delay } => {
            let head = Bytes::from(format!("data: {first}\n\n"));
            let tail = Bytes::from(
                rest.iter()
                    .map(|f| format!("data: {f}\n\n"))
                    .collect::<String>(),
            );
            let body = stream::once(async move { Ok::<_, std::io::Error>(head) }).chain(
                stream::once(async move {
                    tokio::time::sleep(delay).await;
                    Ok(tail)
                }),
            );
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from_stream(body))
                .unwrap()
        }

        Reply::DelayedJson { body, delay } => {
            let payload = Bytes::from(body.to_string());
            let stream = stream::once(async move {
                tokio::time::sleep(delay).await;
                Ok::<_, std::io::Error>(payload)
            });
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from_stream(stream))
                .unwrap()
        }

        Reply::BodyError => {
            let stream = stream::once(async {
                Err::<Bytes, _>(std::io::Error::other("upstream body reset"))
            });
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from_stream(stream))
                .unwrap()
        }

        Reply::SseKeepAlives { interval } => {
            let body = stream::unfold(true, move |first| async move {
                if !first {
                    tokio::time::sleep(interval).await;
                }
                Some((Ok::<_, std::io::Error>(Bytes::from("data:\n\n")), false))
            });
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from_stream(body))
                .unwrap()
        }
    }
}
