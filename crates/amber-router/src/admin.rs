//! The editing surface the desktop app drives.
//!
//! Everything here is behind the same bearer token as `/stats`, on the same
//! loopback listener. Two rules hold throughout: a listing NEVER carries a
//! provider key (only `has_key` and a masked hint), and the plaintext key is
//! reachable only through the one route a deliberate user gesture calls.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::live::{merge_keys, Live};
use crate::routes::{authorized, unauthorized};
use crate::slots::{self, Slot};

pub fn routes() -> Router<Live> {
    Router::new()
        .route("/admin/slots", get(list).put(replace))
        .route("/admin/slots/:name/key", get(reveal))
        .route("/admin/reload", post(reload))
        .route("/admin/status", get(status))
}

#[derive(Deserialize)]
struct SlotsBody {
    slots: Vec<Slot>,
}

fn guard(live: &Live, headers: &HeaderMap) -> Option<Response> {
    if !authorized(&live.current(), headers) {
        return Some(unauthorized());
    }
    if live.root().is_none() {
        return Some(
            (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": { "message": "this router has no editable config" } })),
            )
                .into_response(),
        );
    }
    None
}

fn failed(e: anyhow::Error) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": { "message": e.to_string() } })),
    )
        .into_response()
}

async fn list(State(live): State<Live>, headers: HeaderMap) -> Response {
    if let Some(deny) = guard(&live, &headers) {
        return deny;
    }
    match live.slots() {
        Ok(list) => {
            let views: Vec<_> = list.iter().map(slots::view).collect();
            Json(json!({ "slots": views, "alias": slots::DEFAULT_ALIAS })).into_response()
        }
        Err(e) => failed(e),
    }
}

/// Replace the whole list — add, edit, delete and reorder are all this one
/// call, so the order on screen is the order on disk with no merge to get
/// wrong. A slot sent with a blank key keeps the key already stored.
async fn replace(
    State(live): State<Live>,
    headers: HeaderMap,
    Json(body): Json<SlotsBody>,
) -> Response {
    if let Some(deny) = guard(&live, &headers) {
        return deny;
    }
    let mut incoming = body.slots;
    match live.slots() {
        Ok(stored) => merge_keys(&mut incoming, &stored),
        Err(e) => return failed(e),
    }
    match live.replace_slots(&incoming) {
        Ok(()) => list(State(live), headers).await,
        Err(e) => failed(e),
    }
}

/// The only route that returns a plaintext key.
async fn reveal(
    State(live): State<Live>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    if let Some(deny) = guard(&live, &headers) {
        return deny;
    }
    match live.slots() {
        Ok(list) => match list.into_iter().find(|s| s.name == name) {
            Some(slot) => Json(json!({ "name": slot.name, "api_key": slot.api_key })).into_response(),
            None => (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": { "message": format!("no slot named `{name}`") } })),
            )
                .into_response(),
        },
        Err(e) => failed(e),
    }
}

/// What the toolbar pill and dialog poll. Carries no token and no key.
async fn status(State(live): State<Live>, headers: HeaderMap) -> Response {
    if !authorized(&live.current(), &headers) {
        return unauthorized();
    }
    let state = live.current();
    let slots = live.slots().unwrap_or_default();
    Json(json!({
        "port": live.port(),
        "uptime_secs": live.uptime_secs(),
        "editable": live.root().is_some(),
        "alias": slots::DEFAULT_ALIAS,
        "slots": slots.iter().map(slots::view).collect::<Vec<_>>(),
        "queue_available": state.admission.available_permits(),
        "keys": state.selector.snapshot().into_iter().map(|k| json!({
            "label": k.label,
            "state": k.state,
            "cooling_secs_remaining": k.cooling_secs_remaining,
            "in_flight": k.in_flight,
            "requests": k.requests,
            "errors": k.errors,
            "last_error": k.last_error,
        })).collect::<Vec<_>>(),
    }))
    .into_response()
}

async fn reload(State(live): State<Live>, headers: HeaderMap) -> Response {
    if let Some(deny) = guard(&live, &headers) {
        return deny;
    }
    match live.reload() {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => failed(e),
    }
}
