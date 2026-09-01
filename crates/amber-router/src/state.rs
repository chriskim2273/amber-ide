use std::sync::Arc;

use router_core::config::Config;
use router_core::registry::Registry;
use tokio::sync::Semaphore;

use crate::selector::Selector;
use crate::upstream::UpstreamClient;

#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<Registry>,
    pub selector: Arc<Selector>,
    pub upstream: UpstreamClient,
    /// Bounded admission queue: shapes bursts instead of stampeding every provider.
    pub admission: Arc<Semaphore>,
    pub auth_token: Option<String>,
    pub max_body_bytes: usize,
}

impl AppState {
    pub fn new(cfg: Config) -> AppState {
        let auth_token = cfg.server.auth_token.clone();
        let max_body_bytes = cfg.server.max_body_bytes;
        let queue_capacity = cfg.server.queue_capacity;
        let registry = Arc::new(Registry::build(cfg));
        let selector = Arc::new(Selector::new(registry.clone()));
        AppState {
            registry,
            selector,
            upstream: UpstreamClient::new(),
            admission: Arc::new(Semaphore::new(queue_capacity)),
            auth_token,
            max_body_bytes,
        }
    }
}
