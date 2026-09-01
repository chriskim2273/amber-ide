use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::proxy::{proxy_once, Attempt, ProxyError};
use crate::state::AppState;
use crate::upstream::is_stream_requested;

pub fn build_router(state: AppState) -> Router {
    let limit = state.max_body_bytes;
    Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route("/stats", get(stats))
        .route("/v1/chat/completions", post(chat_completions))
        .layer(DefaultBodyLimit::max(limit))
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(expected) = state.auth_token.as_deref() else {
        return true;
    };
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t == expected)
        .unwrap_or(false)
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": { "message": "invalid or missing bearer token" } })),
    )
        .into_response()
}

async fn models(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let data: Vec<Value> = state
        .registry
        .alias_names()
        .into_iter()
        .map(|name| json!({ "id": name, "object": "model", "owned_by": "token-router" }))
        .collect();
    Json(json!({ "object": "list", "data": data })).into_response()
}

async fn stats(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let keys: Vec<Value> = state
        .selector
        .snapshot()
        .into_iter()
        .map(|k| {
            json!({
                "label": k.label,
                "state": k.state,
                "cooling_secs_remaining": k.cooling_secs_remaining,
                "in_flight": k.in_flight,
                "requests": k.requests,
                "errors": k.errors,
                "last_error": k.last_error,
            })
        })
        .collect();
    Json(json!({
        "queue_available": state.admission.available_permits(),
        "keys": keys,
        "aliases": state.registry.alias_names(),
    }))
    .into_response()
}

fn attempts_header(attempts: &[Attempt]) -> String {
    attempts
        .iter()
        .map(|a| {
            let status = a
                .status
                .map(|s| s.to_string())
                .unwrap_or_else(|| "-".into());
            format!("{}:{}:{}", a.label, a.outcome, status)
        })
        .collect::<Vec<_>>()
        .join(",")
}

async fn chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Authenticate before parsing JSON so missing/wrong bearer yields 401
    // even when Content-Type/body would otherwise produce 415/422.
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let body: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({ "error": { "message": "invalid JSON body", "type": "invalid_request_error" } })),
            )
                .into_response();
        }
    };
    let alias = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if is_stream_requested(&body) {
        return match crate::proxy::proxy_stream(&state, &alias, body).await {
            Ok(resp) => resp,
            Err(e) => error_response(&alias, e),
        };
    }

    match proxy_once(&state, &alias, body).await {
        Ok(out) => {
            tracing::info!(
                alias = %alias,
                attempts = %attempts_header(&out.attempts),
                status = out.status,
                "request complete"
            );
            Response::builder()
                .status(out.status)
                .header(header::CONTENT_TYPE, out.content_type)
                .header("x-router-attempts", attempts_header(&out.attempts))
                .body(Body::from(out.body))
                .unwrap()
        }
        Err(e) => error_response(&alias, e),
    }
}

fn error_response(alias: &str, e: ProxyError) -> Response {
    let (status, attempts, body) = match e {
        ProxyError::UnknownAlias => (
            StatusCode::NOT_FOUND,
            Vec::new(),
            json!({ "error": { "message": format!("unknown model `{alias}`"), "type": "invalid_request_error" } }),
        ),
        ProxyError::QueueFull => (
            StatusCode::SERVICE_UNAVAILABLE,
            Vec::new(),
            json!({ "error": { "message": "router queue is full", "type": "overloaded" } }),
        ),
        ProxyError::AllDead(attempts) => (
            StatusCode::BAD_GATEWAY,
            attempts,
            json!({ "error": { "message": "every credential in the chain is dead", "type": "router_error" } }),
        ),
        ProxyError::Timeout(attempts) => (
            StatusCode::GATEWAY_TIMEOUT,
            attempts,
            json!({ "error": { "message": "router deadline exceeded", "type": "router_error" } }),
        ),
        ProxyError::Exhausted(attempts, upstream_status, upstream_body) => {
            let text = String::from_utf8_lossy(&upstream_body).to_string();
            let parsed: Value = serde_json::from_str(&text).unwrap_or_else(
                |_| json!({ "error": { "message": text, "type": "upstream_error" } }),
            );
            (
                StatusCode::from_u16(upstream_status).unwrap_or(StatusCode::BAD_GATEWAY),
                attempts,
                parsed,
            )
        }
    };

    tracing::warn!(alias = %alias, attempts = %attempts_header(&attempts), status = status.as_u16(), "request failed");

    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-router-attempts", attempts_header(&attempts))
        .body(Body::from(body.to_string()))
        .unwrap()
}
