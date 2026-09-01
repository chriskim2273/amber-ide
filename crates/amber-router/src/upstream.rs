use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

pub fn prepare_body(original: &Value, model_id: &str, drop_params: &[String]) -> Value {
    let mut body = original.clone();
    if let Some(obj) = body.as_object_mut() {
        obj.insert("model".to_string(), Value::String(model_id.to_string()));
        for p in drop_params {
            obj.remove(p);
        }
    }
    body
}

pub fn is_stream_requested(body: &Value) -> bool {
    body.get("stream").and_then(Value::as_bool).unwrap_or(false)
}

pub fn chat_completions_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

#[derive(Clone)]
pub struct UpstreamClient {
    /// One client per distinct connect timeout. Clients own the connection pool,
    /// so they must be reused across requests, and reqwest fixes the connect
    /// timeout at client-build time — hence a cache rather than a single client.
    clients: Arc<Mutex<HashMap<Duration, reqwest::Client>>>,
}

impl UpstreamClient {
    pub fn new() -> UpstreamClient {
        UpstreamClient {
            clients: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn client_for(&self, connect: Duration) -> reqwest::Client {
        let mut guard = self.clients.lock().unwrap();
        guard
            .entry(connect)
            .or_insert_with(|| {
                reqwest::Client::builder()
                    .connect_timeout(connect)
                    .build()
                    .expect("reqwest client builds with a connect timeout")
            })
            .clone()
    }

    fn request(
        &self,
        url: &str,
        api_key: &str,
        body: &Value,
        connect: Duration,
    ) -> reqwest::RequestBuilder {
        self.client_for(connect)
            .post(url)
            .bearer_auth(api_key)
            .json(body)
    }

    /// Non-streaming send: no reqwest whole-request timeout. The caller bounds
    /// the header wait with first-byte and the body read with remaining total.
    pub async fn send(
        &self,
        url: &str,
        api_key: &str,
        body: &Value,
        connect: Duration,
    ) -> Result<reqwest::Response, reqwest::Error> {
        self.send_stream(url, api_key, body, connect).await
    }

    /// Streaming send: no whole-request timeout. First-byte is enforced by the SSE
    /// gate after headers arrive; a committed stream may outlive `first_byte`.
    pub async fn send_stream(
        &self,
        url: &str,
        api_key: &str,
        body: &Value,
        connect: Duration,
    ) -> Result<reqwest::Response, reqwest::Error> {
        self.request(url, api_key, body, connect).send().await
    }
}

impl Default for UpstreamClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rewrites_model_to_the_endpoint_id() {
        let original = json!({ "model": "smart", "messages": [] });
        let out = prepare_body(&original, "llama-3.3-70b-versatile", &[]);
        assert_eq!(out["model"], "llama-3.3-70b-versatile");
    }

    #[test]
    fn drops_configured_params_only() {
        let original = json!({
            "model": "smart",
            "messages": [],
            "frequency_penalty": 0.5,
            "temperature": 0.7
        });
        let out = prepare_body(&original, "m", &["frequency_penalty".to_string()]);
        assert!(out.get("frequency_penalty").is_none());
        assert_eq!(out["temperature"], 0.7);
    }

    #[test]
    fn leaves_the_original_untouched() {
        let original = json!({ "model": "smart", "messages": [] });
        let _ = prepare_body(&original, "m", &[]);
        assert_eq!(
            original["model"], "smart",
            "must be reusable for the next attempt"
        );
    }

    #[test]
    fn detects_streaming_requests() {
        assert!(is_stream_requested(&json!({ "stream": true })));
        assert!(!is_stream_requested(&json!({ "stream": false })));
        assert!(!is_stream_requested(&json!({})));
        assert!(
            !is_stream_requested(&json!({ "stream": "true" })),
            "non-bool is not streaming"
        );
    }

    #[test]
    fn url_join_never_doubles_the_slash() {
        assert_eq!(
            chat_completions_url("http://x/v1"),
            "http://x/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://x/v1/"),
            "http://x/v1/chat/completions"
        );
    }

    #[test]
    fn clients_are_cached_per_connect_timeout() {
        let up = UpstreamClient::new();
        let a = up.client_for(Duration::from_millis(1000));
        let b = up.client_for(Duration::from_millis(1000));
        let c = up.client_for(Duration::from_millis(5000));
        assert_eq!(
            up.clients.lock().unwrap().len(),
            2,
            "one client per distinct timeout"
        );
        drop((a, b, c));
    }
}
