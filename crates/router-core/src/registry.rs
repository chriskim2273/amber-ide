use std::collections::HashMap;
use std::sync::Arc;

use crate::config::{Config, ProviderConfig};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub provider_idx: usize,
    pub key_idx: usize,
    pub model_id: Arc<str>,
}

#[derive(Debug)]
pub struct Registry {
    cfg: Config,
    chains: HashMap<String, Vec<Endpoint>>,
    /// `key_base[provider_idx]` is the flat index of that provider's first key.
    key_base: Vec<usize>,
    key_total: usize,
}

impl Registry {
    pub fn build(cfg: Config) -> Registry {
        let mut key_base = Vec::with_capacity(cfg.providers.len());
        let mut running = 0usize;
        for p in &cfg.providers {
            key_base.push(running);
            running += p.keys.len();
        }

        let mut chains = HashMap::new();
        for alias in &cfg.aliases {
            let mut endpoints = Vec::new();
            for entry in &alias.chain {
                let provider_idx = cfg
                    .providers
                    .iter()
                    .position(|p| p.name == entry.provider)
                    .expect("validated at config load");
                let model_id: Arc<str> = Arc::from(entry.model.as_str());
                for key_idx in 0..cfg.providers[provider_idx].keys.len() {
                    endpoints.push(Endpoint {
                        provider_idx,
                        key_idx,
                        model_id: model_id.clone(),
                    });
                }
            }
            chains.insert(alias.name.clone(), endpoints);
        }

        Registry {
            cfg,
            chains,
            key_base,
            key_total: running,
        }
    }

    pub fn chain(&self, alias: &str) -> Option<&[Endpoint]> {
        self.chains.get(alias).map(|v| v.as_slice())
    }

    pub fn alias_names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.chains.keys().map(|s| s.as_str()).collect();
        names.sort_unstable();
        names
    }

    pub fn provider(&self, idx: usize) -> &ProviderConfig {
        &self.cfg.providers[idx]
    }

    pub fn provider_count(&self) -> usize {
        self.cfg.providers.len()
    }

    pub fn key(&self, e: &Endpoint) -> &str {
        &self.cfg.providers[e.provider_idx].keys[e.key_idx]
    }

    pub fn key_label(&self, e: &Endpoint) -> String {
        format!("{}#{}", self.cfg.providers[e.provider_idx].name, e.key_idx)
    }

    pub fn key_count(&self) -> usize {
        self.key_total
    }

    pub fn flat_key_index(&self, provider_idx: usize, key_idx: usize) -> usize {
        self.key_base[provider_idx] + key_idx
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    const SRC: &str = r#"
[server]

[[provider]]
name = "groq"
base_url = "https://groq.example/v1"
keys = ["k1", "k2"]

[[provider]]
name = "cerebras"
base_url = "https://cerebras.example/v1"
keys = ["k3"]

[[alias]]
name = "smart"
chain = [
  { provider = "groq", model = "llama-70b" },
  { provider = "cerebras", model = "llama-70b-c" },
]
"#;

    fn reg() -> Registry {
        Registry::build(Config::load_str(SRC, &|_| None).unwrap())
    }

    #[test]
    fn chain_fans_out_across_keys_in_provider_order() {
        let r = reg();
        let chain = r.chain("smart").unwrap();
        assert_eq!(chain.len(), 3, "2 groq keys + 1 cerebras key");
        assert_eq!(r.key_label(&chain[0]), "groq#0");
        assert_eq!(r.key_label(&chain[1]), "groq#1");
        assert_eq!(r.key_label(&chain[2]), "cerebras#0");
        assert_eq!(&*chain[0].model_id, "llama-70b");
        assert_eq!(&*chain[2].model_id, "llama-70b-c");
    }

    #[test]
    fn unknown_alias_returns_none() {
        assert!(reg().chain("nope").is_none());
    }

    #[test]
    fn alias_names_are_listed() {
        assert_eq!(reg().alias_names(), vec!["smart"]);
    }

    #[test]
    fn flat_key_indices_are_unique_and_dense() {
        let r = reg();
        assert_eq!(r.key_count(), 3);
        let mut idx: Vec<usize> = r
            .chain("smart")
            .unwrap()
            .iter()
            .map(|e| r.flat_key_index(e.provider_idx, e.key_idx))
            .collect();
        idx.sort_unstable();
        assert_eq!(idx, vec![0, 1, 2]);
    }

    #[test]
    fn key_label_never_contains_the_secret() {
        let r = reg();
        let chain = r.chain("smart").unwrap();
        assert!(!r.key_label(&chain[0]).contains("k1"));
        assert_eq!(r.key(&chain[0]), "k1");
    }
}
