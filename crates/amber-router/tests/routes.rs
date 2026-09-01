mod support;
use support::mock_provider::{MockProvider, Reply};

use serde_json::json;
use router_core::config::Config;
use amber_router::routes::build_router;
use amber_router::state::AppState;

async fn serve(cfg: Config) -> String {
    let app = build_router(AppState::new(cfg));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn cfg(url: &str, auth: Option<&str>) -> Config {
    let auth_line = match auth {
        Some(t) => format!("auth_token = \"{t}\"\n"),
        None => String::new(),
    };
    let src = format!(
        "[server]\n{auth_line}\n[[provider]]\nname = \"a\"\nbase_url = \"{url}\"\nkeys = [\"k\"]\n\n[[alias]]\nname = \"smart\"\nchain = [ {{ provider = \"a\", model = \"real-a\" }} ]\n"
    );
    Config::load_str(&src, &|_| None).unwrap()
}

#[tokio::test]
async fn health_is_open_and_ok() {
    let p = MockProvider::start(vec![Reply::Ok { body: json!({}) }]);
    let base = serve(cfg(&p.base_url(), Some("secret"))).await;
    let r = reqwest::get(format!("{base}/health")).await.unwrap();
    assert_eq!(r.status(), 200, "health must not require auth");
}

#[tokio::test]
async fn models_lists_aliases() {
    let p = MockProvider::start(vec![Reply::Ok { body: json!({}) }]);
    let base = serve(cfg(&p.base_url(), None)).await;
    let v: serde_json::Value = reqwest::get(format!("{base}/v1/models"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v["object"], "list");
    assert_eq!(v["data"][0]["id"], "smart");
}

#[tokio::test]
async fn missing_token_is_rejected_when_auth_is_configured() {
    let p = MockProvider::start(vec![Reply::Ok { body: json!({}) }]);
    let base = serve(cfg(&p.base_url(), Some("secret"))).await;
    let r = reqwest::Client::new()
        .post(format!("{base}/v1/chat/completions"))
        .json(&json!({ "model": "smart", "messages": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    assert_eq!(p.hits(), 0);
}

#[tokio::test]
async fn auth_rejects_before_body_parse_on_non_json() {
    let p = MockProvider::start(vec![Reply::Ok { body: json!({}) }]);
    let base = serve(cfg(&p.base_url(), Some("secret"))).await;
    let r = reqwest::Client::new()
        .post(format!("{base}/v1/chat/completions"))
        .header("content-type", "text/plain")
        .body("not-json")
        .send()
        .await
        .unwrap();
    assert_eq!(
        r.status(),
        401,
        "auth must run before JSON/Content-Type checks"
    );
    assert_eq!(p.hits(), 0);
}

#[tokio::test]
async fn correct_token_passes_through() {
    let p = MockProvider::start(vec![Reply::Ok {
        body: json!({ "id": "x" }),
    }]);
    let base = serve(cfg(&p.base_url(), Some("secret"))).await;
    let r = reqwest::Client::new()
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("secret")
        .json(&json!({ "model": "smart", "messages": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.headers().contains_key("x-router-attempts"));
}

#[tokio::test]
async fn unknown_alias_is_404() {
    let p = MockProvider::start(vec![Reply::Ok { body: json!({}) }]);
    let base = serve(cfg(&p.base_url(), None)).await;
    let r = reqwest::Client::new()
        .post(format!("{base}/v1/chat/completions"))
        .json(&json!({ "model": "nope", "messages": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
}

#[tokio::test]
async fn stats_reports_keys_without_leaking_secrets() {
    let p = MockProvider::start(vec![Reply::Ok { body: json!({}) }]);
    let base = serve(cfg(&p.base_url(), None)).await;
    let body = reqwest::get(format!("{base}/stats"))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(body.contains("a#0"));
    assert!(
        !body.contains("\"k\""),
        "raw key must never appear in stats"
    );
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["keys"][0]["state"], "live");
    assert_eq!(v["aliases"][0], "smart");
}
