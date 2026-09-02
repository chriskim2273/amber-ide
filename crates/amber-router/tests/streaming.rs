mod support;
use support::mock_provider::{MockProvider, Reply};

use amber_router::routes::build_router;
use amber_router::sse::first_frame_is_error;
use amber_router::state::AppState;
use router_core::config::Config;
use serde_json::json;

#[test]
fn error_frames_are_detected_and_normal_frames_are_not() {
    assert!(first_frame_is_error(r#"{"error":{"message":"quota"}}"#));
    assert!(!first_frame_is_error(
        r#"{"choices":[{"delta":{"content":"hi"}}]}"#
    ));
    assert!(!first_frame_is_error("[DONE]"));
    assert!(!first_frame_is_error(""));
    assert!(!first_frame_is_error("not json"));
}

async fn serve(cfg: Config) -> String {
    let app = build_router(AppState::new(cfg));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn cfg_for(urls: &[(&str, &str)]) -> Config {
    let providers: String = urls
        .iter()
        .map(|(name, url)| {
            format!("\n[[provider]]\nname = \"{name}\"\nbase_url = \"{url}\"\nkeys = [\"k\"]\nfirst_byte_timeout_ms = 500\ndefault_cooldown_ms = 50\n")
        })
        .collect();
    let chain: String = urls
        .iter()
        .map(|(name, _)| format!("  {{ provider = \"{name}\", model = \"real-{name}\" }},\n"))
        .collect();
    Config::load_str(
        &format!("[server]\n{providers}\n[[alias]]\nname = \"smart\"\nchain = [\n{chain}]\n"),
        &|_| None,
    )
    .unwrap()
}

#[tokio::test]
async fn http_400_fails_over_to_next_provider() {
    let bad = MockProvider::start(vec![Reply::Status {
        code: 400,
        body: "model not found here".into(),
        retry_after: None,
    }]);
    let good = MockProvider::start(vec![Reply::SseOk {
        frames: vec![
            r#"{"choices":[{"delta":{"content":"hi"}}]}"#.into(),
            "[DONE]".into(),
        ],
    }]);

    let base = serve(cfg_for(&[
        ("bad", &bad.base_url()),
        ("good", &good.base_url()),
    ]))
    .await;
    let r = reqwest::Client::new()
        .post(format!("{base}/v1/chat/completions"))
        .json(&json!({ "model": "smart", "messages": [], "stream": true }))
        .send()
        .await
        .unwrap();

    assert_eq!(r.status(), 200);
    let body = r.text().await.unwrap();
    assert!(
        body.contains("hi"),
        "a lone HTTP 400 must walk to the next provider"
    );
    assert_eq!(bad.hits(), 1);
    assert_eq!(good.hits(), 1);
}

#[tokio::test]
async fn three_consecutive_http_400s_stop_the_stream_chain() {
    let a = MockProvider::start(vec![Reply::Status {
        code: 400,
        body: r#"{"error":{"message":"context too long a"}}"#.into(),
        retry_after: None,
    }]);
    let b = MockProvider::start(vec![Reply::Status {
        code: 400,
        body: r#"{"error":{"message":"context too long b"}}"#.into(),
        retry_after: None,
    }]);
    let c = MockProvider::start(vec![Reply::Status {
        code: 400,
        body: r#"{"error":{"message":"context too long c"}}"#.into(),
        retry_after: None,
    }]);
    let d = MockProvider::start(vec![Reply::SseOk {
        frames: vec![
            r#"{"choices":[{"delta":{"content":"hi"}}]}"#.into(),
            "[DONE]".into(),
        ],
    }]);

    let base = serve(cfg_for(&[
        ("a", &a.base_url()),
        ("b", &b.base_url()),
        ("c", &c.base_url()),
        ("d", &d.base_url()),
    ]))
    .await;
    let r = reqwest::Client::new()
        .post(format!("{base}/v1/chat/completions"))
        .json(&json!({ "model": "smart", "messages": [], "stream": true }))
        .send()
        .await
        .unwrap();

    assert_eq!(r.status(), 400);
    let body = r.text().await.unwrap();
    assert!(
        body.contains("context too long a"),
        "return the first of the consecutive 400s, got {body}"
    );
    assert!(!body.contains("hi"), "healthy tail must not be committed");
    assert_eq!(d.hits(), 0, "fourth provider must never be tried");
}

#[tokio::test]
async fn two_hundred_then_sse_error_fails_over_before_committing() {
    let bad = MockProvider::start(vec![Reply::SseErrorFirst {
        message: "quota exceeded".into(),
    }]);
    let good = MockProvider::start(vec![Reply::SseOk {
        frames: vec![
            r#"{"choices":[{"delta":{"content":"hi"}}]}"#.into(),
            "[DONE]".into(),
        ],
    }]);

    let base = serve(cfg_for(&[
        ("bad", &bad.base_url()),
        ("good", &good.base_url()),
    ]))
    .await;
    let r = reqwest::Client::new()
        .post(format!("{base}/v1/chat/completions"))
        .json(&json!({ "model": "smart", "messages": [], "stream": true }))
        .send()
        .await
        .unwrap();

    assert_eq!(r.status(), 200);
    let body = r.text().await.unwrap();
    assert!(
        body.contains("hi"),
        "client must receive the good provider's stream"
    );
    assert!(
        !body.contains("quota exceeded"),
        "the bad provider's error must never reach the client"
    );
    assert_eq!(bad.hits(), 1);
    assert_eq!(good.hits(), 1);
}

#[tokio::test]
async fn first_frame_is_replayed_not_swallowed() {
    let good = MockProvider::start(vec![Reply::SseOk {
        frames: vec![
            r#"{"choices":[{"delta":{"content":"one"}}]}"#.into(),
            r#"{"choices":[{"delta":{"content":"two"}}]}"#.into(),
            "[DONE]".into(),
        ],
    }]);
    let base = serve(cfg_for(&[("good", &good.base_url())])).await;
    let body = reqwest::Client::new()
        .post(format!("{base}/v1/chat/completions"))
        .json(&json!({ "model": "smart", "messages": [], "stream": true }))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();

    assert!(
        body.contains("one"),
        "gate must not consume the first frame"
    );
    assert!(body.contains("two"));
    assert!(body.contains("[DONE]"));
}

#[tokio::test]
async fn stream_lease_is_released_when_the_stream_ends() {
    let good = MockProvider::start(vec![Reply::SseOk {
        frames: vec![
            r#"{"choices":[{"delta":{"content":"x"}}]}"#.into(),
            "[DONE]".into(),
        ],
    }]);
    let app_cfg = cfg_for(&[("good", &good.base_url())]);
    let state = AppState::new(app_cfg);
    let selector = state.selector.clone();
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let _ = reqwest::Client::new()
        .post(format!("http://{addr}/v1/chat/completions"))
        .json(&json!({ "model": "smart", "messages": [], "stream": true }))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(
        state_in_flight(&selector),
        0,
        "permit released after stream completion"
    );
}

fn state_in_flight(selector: &std::sync::Arc<amber_router::selector::Selector>) -> usize {
    selector.snapshot().iter().map(|k| k.in_flight).sum()
}

#[tokio::test(flavor = "multi_thread")]
async fn committed_stream_is_not_cut_off_after_first_byte_timeout() {
    let good = MockProvider::start(vec![Reply::SseDelayedRest {
        first: r#"{"choices":[{"delta":{"content":"hello"}}]}"#.into(),
        rest: vec![
            r#"{"choices":[{"delta":{"content":" world"}}]}"#.into(),
            "[DONE]".into(),
        ],
        delay: std::time::Duration::from_millis(800),
    }]);
    let base = serve(cfg_for(&[("good", &good.base_url())])).await;
    let body = reqwest::Client::new()
        .post(format!("{base}/v1/chat/completions"))
        .json(&json!({ "model": "smart", "messages": [], "stream": true }))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();

    assert!(body.contains("hello"), "first frame must arrive");
    assert!(
        body.contains(" world"),
        "later frames after first_byte_timeout_ms must still be delivered"
    );
    assert!(body.contains("[DONE]"));
}

#[tokio::test(flavor = "multi_thread")]
async fn keep_alives_do_not_reset_first_byte_gate() {
    let keep = MockProvider::start(vec![Reply::SseKeepAlives {
        interval: std::time::Duration::from_millis(50),
    }]);
    let good = MockProvider::start(vec![Reply::SseOk {
        frames: vec![
            r#"{"choices":[{"delta":{"content":"hi"}}]}"#.into(),
            "[DONE]".into(),
        ],
    }]);

    let base = serve(cfg_for(&[
        ("keep", &keep.base_url()),
        ("good", &good.base_url()),
    ]))
    .await;
    let r = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        reqwest::Client::new()
            .post(format!("{base}/v1/chat/completions"))
            .json(&json!({ "model": "smart", "messages": [], "stream": true }))
            .send(),
    )
    .await
    .expect("keep-alives must not hang the first-byte gate")
    .unwrap();

    assert_eq!(r.status(), 200);
    let body = r.text().await.unwrap();
    assert!(
        body.contains("hi"),
        "after keep-alive timeout the next provider must be used"
    );
    assert_eq!(keep.hits(), 1);
    assert_eq!(good.hits(), 1);
}
