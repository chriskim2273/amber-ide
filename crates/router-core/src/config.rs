use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("invalid TOML: {0}")]
    Toml(String),
    #[error("environment variable `{0}` is referenced in config but not set")]
    UnresolvedVar(String),
    #[error("alias `{alias}` names unknown provider `{provider}`")]
    UnknownProvider { alias: String, provider: String },
    #[error("alias `{0}` has an empty chain")]
    EmptyChain(String),
    #[error("provider `{0}` has no keys")]
    NoKeys(String),
    #[error("alias `{0}` is defined more than once")]
    DuplicateAlias(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    #[serde(default, rename = "provider")]
    pub providers: Vec<ProviderConfig>,
    #[serde(default, rename = "alias")]
    pub aliases: Vec<AliasConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    #[serde(default = "default_bind")]
    pub bind: String,
    #[serde(default)]
    pub auth_token: Option<String>,
    #[serde(default = "default_max_body")]
    pub max_body_bytes: usize,
    #[serde(default = "default_queue_capacity")]
    pub queue_capacity: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub keys: Vec<String>,
    #[serde(default = "default_inflight")]
    pub max_inflight_per_key: usize,
    #[serde(default)]
    pub drop_params: Vec<String>,
    #[serde(default = "default_connect_ms")]
    pub connect_timeout_ms: u64,
    #[serde(default = "default_first_byte_ms")]
    pub first_byte_timeout_ms: u64,
    #[serde(default = "default_total_ms")]
    pub total_timeout_ms: u64,
    #[serde(default = "default_cooldown_ms")]
    pub default_cooldown_ms: u64,
    #[serde(default = "default_max_cooldown_ms")]
    pub max_cooldown_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AliasConfig {
    pub name: String,
    pub chain: Vec<ChainEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainEntry {
    pub provider: String,
    pub model: String,
}

fn default_bind() -> String {
    "127.0.0.1:4000".to_string()
}
fn default_max_body() -> usize {
    4_000_000
}
fn default_queue_capacity() -> usize {
    256
}
fn default_inflight() -> usize {
    4
}
fn default_connect_ms() -> u64 {
    3_000
}
fn default_first_byte_ms() -> u64 {
    20_000
}
fn default_total_ms() -> u64 {
    300_000
}
fn default_cooldown_ms() -> u64 {
    30_000
}
fn default_max_cooldown_ms() -> u64 {
    21_600_000
}

/// Replace every `${VAR}` occurrence using `lookup`. Errors on the first unset variable.
pub fn interpolate(
    input: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<String, ConfigError> {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = match after.find('}') {
            Some(e) => e,
            None => {
                out.push_str(&rest[start..]);
                return Ok(out);
            }
        };
        let name = &after[..end];
        match lookup(name) {
            Some(v) => out.push_str(&v),
            None => return Err(ConfigError::UnresolvedVar(name.to_string())),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

impl Config {
    pub fn load_str(
        src: &str,
        lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Result<Config, ConfigError> {
        let mut cfg: Config = toml::from_str(src).map_err(|e| ConfigError::Toml(e.to_string()))?;

        if let Some(tok) = cfg.server.auth_token.take() {
            let resolved = interpolate(&tok, lookup)?;
            cfg.server.auth_token = if resolved.is_empty() {
                None
            } else {
                Some(resolved)
            };
        }
        for p in &mut cfg.providers {
            p.base_url = interpolate(&p.base_url, lookup)?;
            for k in &mut p.keys {
                *k = interpolate(k, lookup)?;
            }
        }

        cfg.validate()?;
        Ok(cfg)
    }

    fn validate(&self) -> Result<(), ConfigError> {
        for p in &self.providers {
            if p.keys.is_empty() {
                return Err(ConfigError::NoKeys(p.name.clone()));
            }
        }
        let mut seen = std::collections::HashSet::new();
        for a in &self.aliases {
            if !seen.insert(a.name.clone()) {
                return Err(ConfigError::DuplicateAlias(a.name.clone()));
            }
            if a.chain.is_empty() {
                return Err(ConfigError::EmptyChain(a.name.clone()));
            }
            for e in &a.chain {
                if !self.providers.iter().any(|p| p.name == e.provider) {
                    return Err(ConfigError::UnknownProvider {
                        alias: a.name.clone(),
                        provider: e.provider.clone(),
                    });
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k: &str| map.get(k).cloned()
    }

    const MINIMAL: &str = r#"
[server]
bind = "127.0.0.1:4000"

[[provider]]
name = "groq"
base_url = "https://api.groq.com/openai/v1"
keys = ["${GROQ_KEY_1}", "${GROQ_KEY_2}"]

[[alias]]
name = "smart"
chain = [ { provider = "groq", model = "llama-3.3-70b-versatile" } ]
"#;

    #[test]
    fn interpolates_env_vars_in_keys() {
        let cfg = Config::load_str(
            MINIMAL,
            &env(&[("GROQ_KEY_1", "aaa"), ("GROQ_KEY_2", "bbb")]),
        )
        .expect("should parse");
        assert_eq!(
            cfg.providers[0].keys,
            vec!["aaa".to_string(), "bbb".to_string()]
        );
    }

    #[test]
    fn applies_documented_defaults() {
        let cfg =
            Config::load_str(MINIMAL, &env(&[("GROQ_KEY_1", "a"), ("GROQ_KEY_2", "b")])).unwrap();
        assert_eq!(cfg.server.max_body_bytes, 4_000_000);
        assert_eq!(cfg.server.queue_capacity, 256);
        assert_eq!(cfg.providers[0].max_inflight_per_key, 4);
        assert_eq!(cfg.providers[0].connect_timeout_ms, 3_000);
        assert_eq!(cfg.providers[0].first_byte_timeout_ms, 20_000);
        assert_eq!(cfg.providers[0].total_timeout_ms, 300_000);
        assert_eq!(cfg.providers[0].default_cooldown_ms, 30_000);
        assert_eq!(cfg.providers[0].max_cooldown_ms, 21_600_000);
        assert!(cfg.server.auth_token.is_none());
    }

    #[test]
    fn unset_env_var_fails_loudly() {
        let err = Config::load_str(MINIMAL, &env(&[("GROQ_KEY_1", "a")])).unwrap_err();
        assert!(matches!(err, ConfigError::UnresolvedVar(v) if v == "GROQ_KEY_2"));
    }

    #[test]
    fn alias_naming_unknown_provider_fails() {
        let src = MINIMAL.replace(r#"provider = "groq""#, r#"provider = "nope""#);
        let err =
            Config::load_str(&src, &env(&[("GROQ_KEY_1", "a"), ("GROQ_KEY_2", "b")])).unwrap_err();
        assert!(matches!(err, ConfigError::UnknownProvider { .. }));
    }

    #[test]
    fn empty_chain_fails() {
        let src = MINIMAL.replace(
            r#"chain = [ { provider = "groq", model = "llama-3.3-70b-versatile" } ]"#,
            "chain = []",
        );
        let err =
            Config::load_str(&src, &env(&[("GROQ_KEY_1", "a"), ("GROQ_KEY_2", "b")])).unwrap_err();
        assert!(matches!(err, ConfigError::EmptyChain(a) if a == "smart"));
    }

    #[test]
    fn provider_with_no_keys_fails() {
        let src = MINIMAL.replace(r#"keys = ["${GROQ_KEY_1}", "${GROQ_KEY_2}"]"#, "keys = []");
        let err = Config::load_str(&src, &env(&[])).unwrap_err();
        assert!(matches!(err, ConfigError::NoKeys(p) if p == "groq"));
    }

    #[test]
    fn literal_values_pass_through_uninterpolated() {
        let src = MINIMAL.replace(r#""${GROQ_KEY_1}", "${GROQ_KEY_2}""#, r#""literal-key""#);
        let cfg = Config::load_str(&src, &env(&[])).unwrap();
        assert_eq!(cfg.providers[0].keys, vec!["literal-key".to_string()]);
    }

    #[test]
    fn adjacent_variables_both_resolve() {
        let out = interpolate("${A}${B}", &env(&[("A", "one"), ("B", "two")])).unwrap();
        assert_eq!(out, "onetwo");
    }

    #[test]
    fn text_around_variables_is_preserved() {
        let out = interpolate("pre-${A}-mid-${B}-post", &env(&[("A", "1"), ("B", "2")])).unwrap();
        assert_eq!(out, "pre-1-mid-2-post");
    }

    #[test]
    fn unterminated_or_bare_dollar_passes_through_literally() {
        assert_eq!(interpolate("${UNCLOSED", &env(&[])).unwrap(), "${UNCLOSED");
        assert_eq!(interpolate("costs $5", &env(&[])).unwrap(), "costs $5");
        assert_eq!(interpolate("plain", &env(&[])).unwrap(), "plain");
    }

    #[test]
    fn multibyte_text_around_a_variable_does_not_panic() {
        let out = interpolate("héllo-${A}-wörld→", &env(&[("A", "x")])).unwrap();
        assert_eq!(out, "héllo-x-wörld→");
    }
}
