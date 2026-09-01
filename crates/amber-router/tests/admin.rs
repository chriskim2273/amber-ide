//! The editing surface, driven the way the desktop app drives it.

mod support;
use support::mock_provider::{MockProvider, Reply};

use amber_router::live::Live;
use amber_router::routes::build_live_router;
use amber_router::{slots::Slot, store};
use router_core::config::ServerConfig;
use serde_json::{json, Value};

const TOKEN: &str = "router-secret";

fn server() -> ServerConfig {
    toml::from_str(&format!("auth_token = \"{TOKEN}\"")).unwrap()
}

fn slot(name: &str, url: &str, model: &str) -> Slot {
    Slot {
        name: name.into(),
        base_url: url.into(),
        api_key: format!("sk-{name}-secret-tail"),
        model: model.into(),
        enabled: true,
    }
}

struct Harness {
    base: String,
    root: tempfile::TempDir,
    http: reqwest::Client,
}

impl Harness {
    async fn start(initial: &[Slot]) -> Harness {
        let root = tempfile::tempdir().unwrap();
        store::save(root.path(), initial).unwrap();
        let live = Live::from_store(root.path(), server()).unwrap();
        let app = build_live_router(live);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Harness { base: format!("http://{addr}"), root, http: reqwest::Client::new() }
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let r = self
            .http
            .get(format!("{}{path}", self.base))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        (r.status().as_u16(), r.json().await.unwrap_or(Value::Null))
    }

    async fn put_slots(&self, slots: &[Slot]) -> (u16, Value) {
        let r = self
            .http
            .put(format!("{}/admin/slots", self.base))
            .bearer_auth(TOKEN)
            .json(&json!({ "slots": slots }))
            .send()
            .await
            .unwrap();
        (r.status().as_u16(), r.json().await.unwrap_or(Value::Null))
    }
}

#[tokio::test]
async fn listing_slots_never_carries_a_key() {
    let h = Harness::start(&[slot("a", "https://a.example/v1", "m1")]).await;
    let (status, body) = h.get("/admin/slots").await;
    assert_eq!(status, 200);
    let text = body.to_string();
    assert!(!text.contains("sk-a-secret-tail"), "{text}");
    assert_eq!(body["slots"][0]["has_key"], json!(true));
    assert_eq!(body["slots"][0]["key_hint"], json!("••••tail"));
    assert_eq!(body["alias"], json!("auto"));
}

#[tokio::test]
async fn the_admin_surface_is_behind_the_token() {
    let h = Harness::start(&[slot("a", "https://a.example/v1", "m1")]).await;
    for path in ["/admin/slots", "/admin/slots/a/key"] {
        let r = h.http.get(format!("{}{path}", h.base)).send().await.unwrap();
        assert_eq!(r.status(), 401, "{path} must not answer without a token");
        let r = h
            .http
            .get(format!("{}{path}", h.base))
            .bearer_auth("wrong")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 401, "{path} must reject a wrong token");
    }
}

#[tokio::test]
async fn revealing_is_the_only_way_to_see_a_key() {
    let h = Harness::start(&[slot("a", "https://a.example/v1", "m1")]).await;
    let (status, body) = h.get("/admin/slots/a/key").await;
    assert_eq!(status, 200);
    assert_eq!(body["api_key"], json!("sk-a-secret-tail"));

    let (status, _) = h.get("/admin/slots/nope/key").await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn a_blank_key_edit_does_not_wipe_the_stored_one() {
    let h = Harness::start(&[slot("a", "https://a.example/v1", "m1")]).await;
    let mut edited = slot("a", "https://a.example/v2", "m9");
    edited.api_key = String::new(); // what the GUI round-trips: it only ever saw a mask
    let (status, _) = h.put_slots(&[edited]).await;
    assert_eq!(status, 200);

    let (_, body) = h.get("/admin/slots/a/key").await;
    assert_eq!(body["api_key"], json!("sk-a-secret-tail"), "key survived the edit");
    let stored = store::load(h.root.path()).unwrap();
    assert_eq!(stored[0].model, "m9", "the rest of the edit landed");
}

#[tokio::test]
async fn reorder_changes_which_slot_is_tried_first_without_a_restart() {
    let first = MockProvider::start(vec![
        Reply::Ok { body: json!({ "who": "first" }) },
        Reply::Ok { body: json!({ "who": "first" }) },
    ]);
    let second = MockProvider::start(vec![
        Reply::Ok { body: json!({ "who": "second" }) },
        Reply::Ok { body: json!({ "who": "second" }) },
    ]);
    let a = slot("a", &first.base_url(), "m1");
    let b = slot("b", &second.base_url(), "m2");
    let h = Harness::start(&[a.clone(), b.clone()]).await;

    let ask = || async {
        let r = h
            .http
            .post(format!("{}/v1/chat/completions", h.base))
            .bearer_auth(TOKEN)
            .json(&json!({ "model": "auto", "messages": [] }))
            .send()
            .await
            .unwrap();
        r.json::<Value>().await.unwrap()["who"].clone()
    };

    assert_eq!(ask().await, json!("first"));
    let (status, _) = h.put_slots(&[b, a]).await;
    assert_eq!(status, 200);
    assert_eq!(ask().await, json!("second"), "the new order took effect live");

    let names: Vec<String> =
        store::load(h.root.path()).unwrap().into_iter().map(|s| s.name).collect();
    assert_eq!(names, ["b", "a"], "and it is what a restart would read back");
}

#[tokio::test]
async fn an_invalid_edit_is_refused_and_the_live_config_stands() {
    let dup = slot("a", "https://a.example/v1", "m1");
    let h = Harness::start(std::slice::from_ref(&dup)).await;
    let (status, body) = h.put_slots(&[dup.clone(), dup.clone()]).await;
    assert_eq!(status, 400);
    assert!(body["error"]["message"].as_str().unwrap().contains("more than once"));
    assert_eq!(store::load(h.root.path()).unwrap(), vec![dup]);
}
