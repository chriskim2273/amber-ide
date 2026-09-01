mod support;
use support::mock_provider::{MockProvider, Reply};

use serde_json::json;
use router_core::config::Config;
use amber_router::proxy::{proxy_once, ProxyError};
use amber_router::state::AppState;

fn cfg_for(urls: &[(&str, &str)]) -> Config {
    let providers: String = urls
        .iter()
        .map(|(name, url)| {
            format!(
                "\n[[provider]]\nname = \"{name}\"\nbase_url = \"{url}\"\nkeys = [\"k\"]\nmax_inflight_per_key = 2\ndefault_cooldown_ms = 50\nmax_cooldown_ms = 500\nfirst_byte_timeout_ms = 500\n"
            )
        })
        .collect();
    let chain: String = urls
        .iter()
        .map(|(name, _)| format!("  {{ provider = \"{name}\", model = \"real-{name}\" }},\n"))
        .collect();
    let src = format!("[server]\n{providers}\n[[alias]]\nname = \"smart\"\nchain = [\n{chain}]\n");
    Config::load_str(&src, &|_| None).unwrap()
}

fn ok_body() -> serde_json::Value {
    json!({ "id": "x", "choices": [{ "message": { "role": "assistant", "content": "hi" } }] })
}

#[tokio::test]
async fn falls_over_in_chain_order_and_succeeds() {
    let p1 = MockProvider::start(vec![Reply::Status {
        code: 429,
        body: "limit".into(),
        retry_after: Some("1".into()),
    }]);
    let p2 = MockProvider::start(vec![Reply::Status {
        code: 500,
        body: "boom".into(),
        retry_after: None,
    }]);
    let p3 = MockProvider::start(vec![Reply::Ok { body: ok_body() }]);

    let state = AppState::new(cfg_for(&[
        ("a", &p1.base_url()),
        ("b", &p2.base_url()),
        ("c", &p3.base_url()),
    ]));
    let out = proxy_once(&state, "smart", json!({ "model": "smart", "messages": [] }))
        .await
        .expect("third provider answers");

    assert_eq!(out.status, 200);
    assert_eq!(out.attempts.len(), 3);
    assert_eq!(out.attempts[0].label, "a#0");
    assert_eq!(out.attempts[2].label, "c#0");
    assert_eq!(
        out.attempts[2].model, "real-c",
        "model rewritten per endpoint"
    );
    assert_eq!(p1.hits(), 1);
    assert_eq!(p3.hits(), 1);
}

#[tokio::test]
async fn bad_request_does_not_cascade() {
    let p1 = MockProvider::start(vec![Reply::Status {
        code: 400,
        body: "context too long".into(),
        retry_after: None,
    }]);
    let p2 = MockProvider::start(vec![Reply::Ok { body: ok_body() }]);

    let state = AppState::new(cfg_for(&[("a", &p1.base_url()), ("b", &p2.base_url())]));
    let out = proxy_once(&state, "smart", json!({ "model": "smart", "messages": [] }))
        .await
        .expect("400 is returned, not an error");

    assert_eq!(out.status, 400);
    assert_eq!(out.attempts.len(), 1);
    assert_eq!(p2.hits(), 0, "second provider must never be tried");
    assert!(String::from_utf8_lossy(&out.body).contains("context too long"));
}

#[tokio::test]
async fn auth_failure_kills_the_key_for_good() {
    let p1 = MockProvider::start(vec![Reply::Status {
        code: 401,
        body: "bad key".into(),
        retry_after: None,
    }]);
    let p2 = MockProvider::start(vec![Reply::Ok { body: ok_body() }]);

    let state = AppState::new(cfg_for(&[("a", &p1.base_url()), ("b", &p2.base_url())]));
    for _ in 0..3 {
        let out = proxy_once(&state, "smart", json!({ "model": "smart", "messages": [] }))
            .await
            .unwrap();
        assert_eq!(out.status, 200);
    }
    assert_eq!(p1.hits(), 1, "dead key is not retried");
}

#[tokio::test]
async fn exhaustion_returns_the_most_informative_error() {
    let p1 = MockProvider::start(vec![Reply::Status {
        code: 429,
        body: "limit".into(),
        retry_after: Some("1".into()),
    }]);
    let p2 = MockProvider::start(vec![Reply::Status {
        code: 500,
        body: "upstream exploded".into(),
        retry_after: None,
    }]);
    let p3 = MockProvider::start(vec![Reply::Status {
        code: 429,
        body: "limit".into(),
        retry_after: Some("1".into()),
    }]);

    let state = AppState::new(cfg_for(&[
        ("a", &p1.base_url()),
        ("b", &p2.base_url()),
        ("c", &p3.base_url()),
    ]));
    let err = proxy_once(&state, "smart", json!({ "model": "smart", "messages": [] }))
        .await
        .unwrap_err();

    match err {
        ProxyError::Exhausted(attempts, status, body) => {
            assert_eq!(attempts.len(), 3);
            assert_eq!(
                status, 500,
                "the non-429 is more informative than the last 429"
            );
            assert!(String::from_utf8_lossy(&body).contains("upstream exploded"));
        }
        other => panic!("expected Exhausted, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn hung_upstream_times_out_and_releases_its_permit() {
    let p1 = MockProvider::start(vec![Reply::Hang]);
    let p2 = MockProvider::start(vec![Reply::Ok { body: ok_body() }]);

    let state = AppState::new(cfg_for(&[("a", &p1.base_url()), ("b", &p2.base_url())]));
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        proxy_once(&state, "smart", json!({ "model": "smart", "messages": [] })),
    )
    .await
    .expect("must not hang forever")
    .unwrap();

    assert_eq!(out.status, 200);
    assert_eq!(out.attempts[0].outcome, "timeout");
    let snap = state.selector.snapshot();
    assert_eq!(snap[0].in_flight, 0, "permit released after timeout");
}

#[tokio::test]
async fn unknown_alias_is_rejected() {
    let p1 = MockProvider::start(vec![Reply::Ok { body: ok_body() }]);
    let state = AppState::new(cfg_for(&[("a", &p1.base_url())]));
    let err = proxy_once(&state, "nope", json!({ "model": "nope", "messages": [] }))
        .await
        .unwrap_err();
    assert!(matches!(err, ProxyError::UnknownAlias));
}

#[tokio::test(flavor = "multi_thread")]
async fn exhaustion_reports_correctly_when_transport_and_http_failures_mix() {
    // a hangs (transport failure, no status), b returns a real 500, c rate-limits.
    // The most informative error is b's 500 — reporting a's or c's would mean the
    // attempt index and the error list have drifted apart.
    let p1 = MockProvider::start(vec![Reply::Hang]);
    let p2 = MockProvider::start(vec![Reply::Status {
        code: 500,
        body: "upstream exploded".into(),
        retry_after: None,
    }]);
    let p3 = MockProvider::start(vec![Reply::Status {
        code: 429,
        body: "limit".into(),
        retry_after: Some("1".into()),
    }]);

    let state = AppState::new(cfg_for(&[
        ("a", &p1.base_url()),
        ("b", &p2.base_url()),
        ("c", &p3.base_url()),
    ]));
    let err = proxy_once(&state, "smart", json!({ "model": "smart", "messages": [] }))
        .await
        .unwrap_err();

    match err {
        ProxyError::Exhausted(attempts, status, body) => {
            assert_eq!(attempts.len(), 3);
            assert_eq!(attempts[0].outcome, "timeout");
            assert_eq!(attempts[0].status, None);
            assert_eq!(
                status, 500,
                "must report b's 500, not a's absent status or c's 429"
            );
            assert!(String::from_utf8_lossy(&body).contains("upstream exploded"));
        }
        other => panic!("expected Exhausted, got {other:?}"),
    }
}

#[tokio::test]
async fn provider_not_found_fails_over() {
    let p1 = MockProvider::start(vec![Reply::Status {
        code: 404,
        body: "no such model".into(),
        retry_after: None,
    }]);
    let p2 = MockProvider::start(vec![Reply::Ok { body: ok_body() }]);

    let state = AppState::new(cfg_for(&[("a", &p1.base_url()), ("b", &p2.base_url())]));
    let out = proxy_once(&state, "smart", json!({ "model": "smart", "messages": [] }))
        .await
        .expect("404 cools down and the next provider answers");

    assert_eq!(out.status, 200);
    assert_eq!(out.attempts.len(), 2);
    assert_eq!(out.attempts[0].outcome, "cooldown");
    assert_eq!(p1.hits(), 1);
    assert_eq!(p2.hits(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn slow_json_body_is_not_cut_off_by_first_byte_timeout() {
    let p1 = MockProvider::start(vec![Reply::DelayedJson {
        body: ok_body(),
        delay: std::time::Duration::from_millis(800),
    }]);
    let state = AppState::new(cfg_for(&[("a", &p1.base_url())]));
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        proxy_once(&state, "smart", json!({ "model": "smart", "messages": [] })),
    )
    .await
    .expect("must not hang")
    .expect("slow body within total_timeout_ms is success");

    assert_eq!(out.status, 200);
    assert!(
        String::from_utf8_lossy(&out.body).contains("hi"),
        "body arriving after first_byte_timeout_ms must still be delivered"
    );
}

#[tokio::test]
async fn failed_body_read_after_2xx_fails_over() {
    let p1 = MockProvider::start(vec![Reply::BodyError]);
    let p2 = MockProvider::start(vec![Reply::Ok { body: ok_body() }]);

    let state = AppState::new(cfg_for(&[("a", &p1.base_url()), ("b", &p2.base_url())]));
    let out = proxy_once(&state, "smart", json!({ "model": "smart", "messages": [] }))
        .await
        .expect("body-read failure is transport, not success");

    assert_eq!(out.status, 200);
    assert_eq!(out.attempts[0].status, None);
    assert!(
        out.attempts[0].outcome == "timeout" || out.attempts[0].outcome == "transport",
        "2xx body-read failure must be recorded as transport, got {}",
        out.attempts[0].outcome
    );
    assert_eq!(p2.hits(), 1);
}
