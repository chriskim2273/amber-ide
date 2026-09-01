use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::header;
use axum::response::Response;
use serde_json::Value;

use router_core::taxonomy::{classify_status, Verdict};

use crate::selector::AcquireError;
use crate::sse::{gate_stream, into_body_stream, GateFailure};
use crate::state::AppState;
use crate::upstream::{chat_completions_url, is_stream_requested, prepare_body};

#[derive(Debug, Clone, serde::Serialize)]
pub struct Attempt {
    pub label: String,
    pub model: String,
    pub outcome: String,
    pub status: Option<u16>,
    pub latency_ms: u64,
}

#[derive(Debug)]
pub struct ProxyOutcome {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_type: String,
    pub attempts: Vec<Attempt>,
}

#[derive(Debug)]
pub enum ProxyError {
    UnknownAlias,
    QueueFull,
    AllDead(Vec<Attempt>),
    Exhausted(Vec<Attempt>, u16, Vec<u8>),
    Timeout(Vec<Attempt>),
}

/// The most informative error is the first non-429; a chain of pure rate limits
/// falls back to the last attempt.
pub fn pick_reportable(attempts: &[Attempt]) -> usize {
    attempts
        .iter()
        .position(|a| !matches!(a.status, Some(429) | None))
        .unwrap_or(attempts.len().saturating_sub(1))
}

/// `errors[i]` is `Some((status, body))` for attempts that got a response, and
/// `None` for transport/timeout attempts, so it stays index-aligned with `attempts`.
fn most_informative(attempts: &[Attempt], errors: &[Option<(u16, Vec<u8>)>]) -> (u16, Vec<u8>) {
    let idx = pick_reportable(attempts);
    errors
        .get(idx)
        .cloned()
        .flatten()
        .or_else(|| errors.iter().rev().find_map(|e| e.clone()))
        .unwrap_or((502, b"router: all endpoints exhausted".to_vec()))
}

pub async fn proxy_once(
    state: &AppState,
    alias: &str,
    body: Value,
) -> Result<ProxyOutcome, ProxyError> {
    let chain = state
        .registry
        .chain(alias)
        .ok_or(ProxyError::UnknownAlias)?
        .to_vec();

    let _admission = state
        .admission
        .clone()
        .try_acquire_owned()
        .map_err(|_| ProxyError::QueueFull)?;

    // The total timeout is the longest configured across the chain's providers.
    let total = chain
        .iter()
        .map(|e| state.registry.provider(e.provider_idx).total_timeout_ms)
        .max()
        .unwrap_or(300_000);
    let deadline = Instant::now() + Duration::from_millis(total);

    let mut attempts: Vec<Attempt> = Vec::new();
    // Index-aligned with `attempts`: the (status, body) when one exists, used to
    // pick the most informative error on exhaustion.
    let mut errors: Vec<Option<(u16, Vec<u8>)>> = Vec::new();

    loop {
        let lease = match state.selector.acquire(&chain, deadline).await {
            Ok(l) => l,
            Err(AcquireError::AllDead) => return Err(ProxyError::AllDead(attempts)),
            Err(AcquireError::Timeout) => {
                return if attempts.is_empty() {
                    Err(ProxyError::Timeout(attempts))
                } else {
                    let (status, body) = most_informative(&attempts, &errors);
                    Err(ProxyError::Exhausted(attempts, status, body))
                };
            }
        };

        let endpoint = lease.endpoint.clone();
        let provider = state.registry.provider(endpoint.provider_idx);
        let label = state.registry.key_label(&endpoint);
        let url = chat_completions_url(&provider.base_url);
        let sent = prepare_body(&body, &endpoint.model_id, &provider.drop_params);
        let key = state.registry.key(&endpoint).to_string();

        let started = Instant::now();
        let remaining = deadline.saturating_duration_since(Instant::now());
        let first_byte = Duration::from_millis(provider.first_byte_timeout_ms).min(remaining);
        // Header wait only. Do not apply reqwest's whole-request timeout here:
        // that would also kill a slow JSON body that arrives after first_byte.
        let result = tokio::time::timeout(
            first_byte,
            state.upstream.send(
                &url,
                &key,
                &sent,
                Duration::from_millis(provider.connect_timeout_ms),
            ),
        )
        .await;

        let resp = match result {
            Ok(Ok(resp)) => resp,
            Ok(Err(e)) => {
                let outcome = if e.is_timeout() {
                    "timeout"
                } else {
                    "transport"
                };
                attempts.push(Attempt {
                    label,
                    model: endpoint.model_id.to_string(),
                    outcome: outcome.to_string(),
                    status: None,
                    latency_ms: started.elapsed().as_millis() as u64,
                });
                state
                    .selector
                    .report_cooldown(&endpoint, None, format!("{outcome}: {e}"));
                errors.push(None);
                drop(lease);

                if attempts.len() >= chain.len() {
                    let (status, body) = most_informative(&attempts, &errors);
                    return Err(ProxyError::Exhausted(attempts, status, body));
                }
                continue;
            }
            Err(_) => {
                attempts.push(Attempt {
                    label,
                    model: endpoint.model_id.to_string(),
                    outcome: "timeout".to_string(),
                    status: None,
                    latency_ms: started.elapsed().as_millis() as u64,
                });
                state.selector.report_cooldown(
                    &endpoint,
                    None,
                    "timeout waiting for headers".into(),
                );
                errors.push(None);
                drop(lease);

                if attempts.len() >= chain.len() {
                    let (status, body) = most_informative(&attempts, &errors);
                    return Err(ProxyError::Exhausted(attempts, status, body));
                }
                continue;
            }
        };

        let status = resp.status().as_u16();
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/json")
            .to_string();
        let verdict = classify_status(status, retry_after.as_deref());

        let body_budget = deadline.saturating_duration_since(Instant::now()).min(
            Duration::from_millis(provider.total_timeout_ms).saturating_sub(started.elapsed()),
        );
        let body_result = tokio::time::timeout(body_budget, resp.bytes()).await;
        let latency_ms = started.elapsed().as_millis() as u64;

        if matches!(verdict, Verdict::Success) {
            let resp_body = match body_result {
                Ok(Ok(b)) => b.to_vec(),
                Ok(Err(e)) => {
                    let outcome = if e.is_timeout() {
                        "timeout"
                    } else {
                        "transport"
                    };
                    attempts.push(Attempt {
                        label,
                        model: endpoint.model_id.to_string(),
                        outcome: outcome.to_string(),
                        status: None,
                        latency_ms,
                    });
                    state
                        .selector
                        .report_cooldown(&endpoint, None, format!("{outcome}: {e}"));
                    errors.push(None);
                    drop(lease);
                    if attempts.len() >= chain.len() {
                        let (status, body) = most_informative(&attempts, &errors);
                        return Err(ProxyError::Exhausted(attempts, status, body));
                    }
                    continue;
                }
                Err(_) => {
                    attempts.push(Attempt {
                        label,
                        model: endpoint.model_id.to_string(),
                        outcome: "timeout".to_string(),
                        status: None,
                        latency_ms,
                    });
                    state
                        .selector
                        .report_cooldown(&endpoint, None, "timeout reading body".into());
                    errors.push(None);
                    drop(lease);
                    if attempts.len() >= chain.len() {
                        let (status, body) = most_informative(&attempts, &errors);
                        return Err(ProxyError::Exhausted(attempts, status, body));
                    }
                    continue;
                }
            };
            attempts.push(Attempt {
                label,
                model: endpoint.model_id.to_string(),
                outcome: "success".to_string(),
                status: Some(status),
                latency_ms,
            });
            state.selector.report_success(&endpoint);
            drop(lease);
            return Ok(ProxyOutcome {
                status,
                body: resp_body,
                content_type,
                attempts,
            });
        }

        let resp_body = match body_result {
            Ok(Ok(b)) => b.to_vec(),
            _ => Vec::new(),
        };

        attempts.push(Attempt {
            label,
            model: endpoint.model_id.to_string(),
            outcome: match verdict {
                Verdict::Success => unreachable!(),
                Verdict::CoolDown { .. } => "cooldown",
                Verdict::DeadKey => "dead_key",
                Verdict::Fatal => "fatal",
            }
            .to_string(),
            status: Some(status),
            latency_ms,
        });

        match verdict {
            Verdict::Success => unreachable!(),
            Verdict::Fatal => {
                // A 400 is the client's fault, not the provider's: it fails
                // identically on every endpoint, so do not cool the key down
                // and do not walk the chain. report_success is the only
                // method that counts the request without penalizing the key.
                state.selector.report_success(&endpoint);
                drop(lease);
                return Ok(ProxyOutcome {
                    status,
                    body: resp_body,
                    content_type,
                    attempts,
                });
            }
            Verdict::DeadKey => {
                state
                    .selector
                    .report_dead(&endpoint, format!("HTTP {status}"));
                errors.push(Some((status, resp_body)));
                drop(lease);
            }
            Verdict::CoolDown { retry_after } => {
                state
                    .selector
                    .report_cooldown(&endpoint, retry_after, format!("HTTP {status}"));
                errors.push(Some((status, resp_body)));
                drop(lease);
            }
        }

        // Stop once every endpoint has had its turn.
        if attempts.len() >= chain.len() {
            let (status, body) = most_informative(&attempts, &errors);
            return Err(ProxyError::Exhausted(attempts, status, body));
        }
    }
}

/// Same failover walk as `proxy_once`, except each attempt must pass the first-frame gate
/// before its response is committed. After commit, failover is over: a mid-stream error is
/// surfaced to the client rather than silently retried.
pub async fn proxy_stream(
    state: &AppState,
    alias: &str,
    body: Value,
) -> Result<Response, ProxyError> {
    debug_assert!(is_stream_requested(&body));

    let chain = state
        .registry
        .chain(alias)
        .ok_or(ProxyError::UnknownAlias)?
        .to_vec();
    let _admission = state
        .admission
        .clone()
        .try_acquire_owned()
        .map_err(|_| ProxyError::QueueFull)?;

    let total = chain
        .iter()
        .map(|e| state.registry.provider(e.provider_idx).total_timeout_ms)
        .max()
        .unwrap_or(300_000);
    let deadline = Instant::now() + Duration::from_millis(total);

    let mut attempts: Vec<Attempt> = Vec::new();
    // Index-aligned with `attempts`, including mixed transport+HTTP, same as `proxy_once`.
    let mut errors: Vec<Option<(u16, Vec<u8>)>> = Vec::new();

    loop {
        let lease = match state.selector.acquire(&chain, deadline).await {
            Ok(l) => l,
            Err(AcquireError::AllDead) => return Err(ProxyError::AllDead(attempts)),
            Err(AcquireError::Timeout) => {
                return if attempts.is_empty() {
                    Err(ProxyError::Timeout(attempts))
                } else {
                    let (status, body) = most_informative(&attempts, &errors);
                    Err(ProxyError::Exhausted(attempts, status, body))
                };
            }
        };

        let endpoint = lease.endpoint.clone();
        let provider = state.registry.provider(endpoint.provider_idx);
        let label = state.registry.key_label(&endpoint);
        let url = chat_completions_url(&provider.base_url);
        let sent = prepare_body(&body, &endpoint.model_id, &provider.drop_params);
        let key = state.registry.key(&endpoint).to_string();
        let first_byte = Duration::from_millis(provider.first_byte_timeout_ms);
        let started = Instant::now();

        // Bound waiting for response headers. Do not use reqwest's whole-request
        // `.timeout(first_byte)`: that would also kill a committed stream whose
        // later frames arrive after first_byte. First-token is gated below.
        let resp = match tokio::time::timeout(
            first_byte,
            state.upstream.send_stream(
                &url,
                &key,
                &sent,
                Duration::from_millis(provider.connect_timeout_ms),
            ),
        )
        .await
        {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                attempts.push(Attempt {
                    label: label.clone(),
                    model: endpoint.model_id.to_string(),
                    outcome: if e.is_timeout() {
                        "timeout".into()
                    } else {
                        "transport".into()
                    },
                    status: None,
                    latency_ms: started.elapsed().as_millis() as u64,
                });
                state
                    .selector
                    .report_cooldown(&endpoint, None, e.to_string());
                errors.push(None);
                drop(lease);
                if attempts.len() >= chain.len() {
                    let (status, body) = most_informative(&attempts, &errors);
                    return Err(ProxyError::Exhausted(attempts, status, body));
                }
                continue;
            }
            Err(_) => {
                attempts.push(Attempt {
                    label: label.clone(),
                    model: endpoint.model_id.to_string(),
                    outcome: "timeout".into(),
                    status: None,
                    latency_ms: started.elapsed().as_millis() as u64,
                });
                state.selector.report_cooldown(
                    &endpoint,
                    None,
                    "timeout waiting for headers".into(),
                );
                errors.push(None);
                drop(lease);
                if attempts.len() >= chain.len() {
                    let (status, body) = most_informative(&attempts, &errors);
                    return Err(ProxyError::Exhausted(attempts, status, body));
                }
                continue;
            }
        };

        let status = resp.status().as_u16();
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let verdict = classify_status(status, retry_after.as_deref());

        if !matches!(verdict, Verdict::Success) {
            let bytes = resp.bytes().await.unwrap_or_default().to_vec();
            attempts.push(Attempt {
                label: label.clone(),
                model: endpoint.model_id.to_string(),
                outcome: match verdict {
                    Verdict::Fatal => "fatal",
                    Verdict::DeadKey => "dead_key",
                    _ => "cooldown",
                }
                .to_string(),
                status: Some(status),
                latency_ms: started.elapsed().as_millis() as u64,
            });
            match verdict {
                Verdict::Success => unreachable!("non-success filtered above"),
                Verdict::Fatal => {
                    // A 400 is the client's fault, not the provider's.
                    state.selector.report_success(&endpoint);
                    drop(lease);
                    return Err(ProxyError::Exhausted(attempts, status, bytes));
                }
                Verdict::DeadKey => state
                    .selector
                    .report_dead(&endpoint, format!("HTTP {status}")),
                Verdict::CoolDown { retry_after } => {
                    state
                        .selector
                        .report_cooldown(&endpoint, retry_after, format!("HTTP {status}"))
                }
            }
            errors.push(Some((status, bytes)));
            drop(lease);
            if attempts.len() >= chain.len() {
                let (s, b) = most_informative(&attempts, &errors);
                return Err(ProxyError::Exhausted(attempts, s, b));
            }
            continue;
        }

        match gate_stream(resp, first_byte).await {
            Ok(gated) => {
                attempts.push(Attempt {
                    label: label.clone(),
                    model: endpoint.model_id.to_string(),
                    outcome: "success".into(),
                    status: Some(200),
                    latency_ms: started.elapsed().as_millis() as u64,
                });
                state.selector.report_success(&endpoint);

                // The lease rides along with the stream so the permit is held for the whole
                // response and released on completion or client disconnect.
                let stream = into_body_stream(gated);
                let guarded = LeaseGuardedStream {
                    inner: Box::pin(stream),
                    _lease: lease,
                };

                let header_value = attempts
                    .iter()
                    .map(|a| {
                        format!(
                            "{}:{}:{}",
                            a.label,
                            a.outcome,
                            a.status
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| "-".into())
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",");

                return Ok(Response::builder()
                    .status(200)
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .header(header::CACHE_CONTROL, "no-cache")
                    .header("x-router-attempts", header_value)
                    .body(Body::from_stream(guarded))
                    .unwrap());
            }
            Err(failure) => {
                let (outcome, body_text) = match failure {
                    GateFailure::UpstreamError { body } => ("sse_error", body),
                    GateFailure::Timeout => ("timeout", "no first token".to_string()),
                    GateFailure::Empty => ("empty_stream", "stream ended".to_string()),
                };
                attempts.push(Attempt {
                    label: label.clone(),
                    model: endpoint.model_id.to_string(),
                    outcome: outcome.to_string(),
                    status: Some(200),
                    latency_ms: started.elapsed().as_millis() as u64,
                });
                state
                    .selector
                    .report_cooldown(&endpoint, None, outcome.to_string());
                errors.push(Some((502, body_text.into_bytes())));
                drop(lease);
                if attempts.len() >= chain.len() {
                    let (s, b) = most_informative(&attempts, &errors);
                    return Err(ProxyError::Exhausted(attempts, s, b));
                }
            }
        }
    }
}

struct LeaseGuardedStream {
    inner: std::pin::Pin<
        Box<dyn futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send>,
    >,
    _lease: crate::selector::Lease,
}

impl futures_util::Stream for LeaseGuardedStream {
    type Item = Result<bytes::Bytes, std::io::Error>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}
