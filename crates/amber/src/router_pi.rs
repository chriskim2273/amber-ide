//! Register the router with Pi.
//!
//! Pi does NOT honour `OPENAI_BASE_URL` — it always passes `model.baseUrl`
//! explicitly, and the only base-URL environment variables it reads are the
//! Azure trio. So pointing Pi at a local proxy means a provider entry in
//! `~/.pi/agent/models.json`, and nothing else will do.
//!
//! Two rules govern the write, because this is somebody's real config:
//!
//! 1. **We own exactly one key.** Every other provider in the file, and every
//!    unrelated top-level field, is preserved byte-for-byte through a generic
//!    JSON round-trip. Same ownership discipline as the Codex hook installer.
//! 2. **The token is never copied.** `apiKey` is written as Pi's documented
//!    `!<command>` escape, so Pi reads the 0600 token file at call time.
//!    Rotating the token therefore needs no re-registration.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// The provider key amber owns in `models.json`.
pub const PROVIDER: &str = "amber-router";
/// Where the inbound token lives, relative to the amber state root.
pub const TOKEN_FILE: &str = "router-token";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PiState {
    /// No `models.json` — Pi is probably not installed.
    NoConfig,
    /// Our entry is absent.
    Missing,
    /// Present, but pointing somewhere else (usually an old port).
    Stale,
    Installed,
}

impl PiState {
    pub fn label(&self) -> &'static str {
        match self {
            PiState::NoConfig => "no-config",
            PiState::Missing => "missing",
            PiState::Stale => "stale",
            PiState::Installed => "installed",
        }
    }
}

pub struct Installed {
    pub path: PathBuf,
    pub changed: bool,
    pub models: Vec<String>,
}

pub fn models_path() -> Option<PathBuf> {
    crate::pi::pi_agent_dir().map(|d| d.join("models.json"))
}

/// The base URL Pi must call. Loopback, and the router's own `/v1` prefix.
pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/v1")
}

/// Pi's `!<command>` escape, so the token is read at call time and never
/// duplicated into a second file.
pub fn api_key_command(root: &Path) -> String {
    let path = root.join(TOKEN_FILE);
    format!("!sh -c 'cat \"{}\"'", path.display())
}

/// The provider entry amber writes. Pure so the shape is testable.
///
/// `models` entries are OBJECTS, not id strings: Pi's `ModelDefinitionSchema`
/// rejects a bare string ("providers.<p>.models.0: must be object") and then
/// discards the whole file with a warning, which is exactly the failure a live
/// `pi --list-models` caught.
pub fn provider_entry(root: &Path, port: u16, models: &[String]) -> Value {
    let models: Vec<Value> = models
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "name": if id == DEFAULT_ALIAS {
                    "amber router · failover chain".to_string()
                } else {
                    format!("amber router · {id}")
                },
                "input": ["text"],
                "contextWindow": 128_000,
                "maxTokens": 16_000,
            })
        })
        .collect();
    json!({
        "baseUrl": base_url(port),
        "api": "openai-completions",
        "authHeader": true,
        "apiKey": api_key_command(root),
        "models": models,
    })
}

/// Merge our entry into an existing `models.json` document, preserving
/// everything else. Returns the new document and whether anything changed.
pub fn merge(doc: &Value, entry: &Value) -> (Value, bool) {
    let mut root: Map<String, Value> = doc.as_object().cloned().unwrap_or_default();
    let mut providers: Map<String, Value> = root
        .get("providers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let changed = providers.get(PROVIDER) != Some(entry);
    providers.insert(PROVIDER.to_string(), entry.clone());
    root.insert("providers".into(), Value::Object(providers));
    (Value::Object(root), changed)
}

/// Remove our entry, leaving every other provider alone.
pub fn remove(doc: &Value) -> (Value, bool) {
    let mut root: Map<String, Value> = doc.as_object().cloned().unwrap_or_default();
    let Some(providers) = root.get("providers").and_then(Value::as_object).cloned() else {
        return (Value::Object(root), false);
    };
    let mut providers = providers;
    let changed = providers.remove(PROVIDER).is_some();
    root.insert("providers".into(), Value::Object(providers));
    (Value::Object(root), changed)
}

/// The router's failover alias. Mirrors `amber_router::slots::DEFAULT_ALIAS`;
/// duplicated rather than depending on the router crate from `amber`.
pub const DEFAULT_ALIAS: &str = "auto";

/// Model ids to advertise: the failover alias plus each slot by name, which is
/// exactly the alias set the router itself serves on `/v1/models`.
pub fn model_ids(alias: &str, slots: &[String]) -> Vec<String> {
    let mut out = vec![alias.to_string()];
    out.extend(slots.iter().cloned());
    out
}

fn read_doc(path: &Path) -> anyhow::Result<Value> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => Ok(serde_json::from_str(&text)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}

/// Is our entry present and current?
pub fn state(root: &Path, port: u16) -> PiState {
    let Some(path) = models_path() else {
        return PiState::NoConfig;
    };
    if !path.exists() {
        return PiState::NoConfig;
    }
    let Ok(doc) = read_doc(&path) else {
        return PiState::Missing;
    };
    let Some(entry) = doc.get("providers").and_then(|p| p.get(PROVIDER)) else {
        return PiState::Missing;
    };
    let current = entry.get("baseUrl").and_then(Value::as_str) == Some(&base_url(port))
        && entry.get("apiKey").and_then(Value::as_str) == Some(&api_key_command(root));
    if current {
        PiState::Installed
    } else {
        PiState::Stale
    }
}

/// Write (or refresh) the entry, advertising the router's current slots.
pub fn install(root: &Path, port: u16) -> anyhow::Result<Installed> {
    let path = models_path()
        .ok_or_else(|| anyhow::anyhow!("Pi registration requires HOME or PI_CODING_AGENT_DIR"))?;
    let models = model_ids("auto", &router_slot_names(root));
    install_at(&path, root, port, &models)
}

/// The IO half, with the destination injected so tests never touch a real
/// `~/.pi`.
pub fn install_at(
    path: &Path,
    root: &Path,
    port: u16,
    models: &[String],
) -> anyhow::Result<Installed> {
    let doc = read_doc(path)?;
    let (next, changed) = merge(&doc, &provider_entry(root, port, models));
    if changed {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, format!("{}\n", serde_json::to_string_pretty(&next)?))?;
    }
    Ok(Installed { path: path.to_path_buf(), changed, models: models.to_vec() })
}

/// Slot names as stored in `router.toml`, without parsing the router's crate.
///
/// The file is TOML we wrote: every `[[provider]]` has a `name`. Reading it
/// here keeps `amber` free of a dependency on the router binary's crate.
fn router_slot_names(root: &Path) -> Vec<String> {
    let Some(text) = crate::web::read_secret(root, "router.toml") else {
        return Vec::new();
    };
    let Ok(doc) = text.parse::<toml::Table>() else {
        return Vec::new();
    };
    doc.get("provider")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|p| p.get("name").and_then(|n| n.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from("/home/u/.local/state/amber-ide")
    }

    #[test]
    fn the_entry_never_contains_the_token_itself() {
        let e = provider_entry(&root(), 7719, &["auto".into()]);
        let text = e.to_string();
        assert!(text.contains("router-token"), "{text}");
        assert!(text.starts_with('{'));
        let key = e["apiKey"].as_str().unwrap();
        assert!(key.starts_with('!'), "must be pi's command escape: {key}");
        assert!(key.contains("cat "), "{key}");
        assert_eq!(e["baseUrl"], json!("http://127.0.0.1:7719/v1"));
        assert_eq!(e["api"], json!("openai-completions"));
        assert_eq!(e["authHeader"], json!(true));
    }

    #[test]
    fn models_are_objects_because_pi_rejects_bare_strings() {
        let e = provider_entry(&root(), 7719, &["auto".into(), "groq".into()]);
        let models = e["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        for m in models {
            assert!(m.is_object(), "pi discards the whole file otherwise: {m}");
            assert!(m["id"].is_string());
        }
        assert_eq!(models[0]["id"], json!("auto"));
        assert_eq!(models[1]["id"], json!("groq"));
    }

    #[test]
    fn merging_leaves_every_other_provider_untouched() {
        let existing = json!({
            "providers": {
                "workbuddy": { "baseUrl": "https://www.workbuddy.ai/v2", "api": "openai-completions" },
                "aihubmix": { "baseUrl": "https://aihubmix.com/v1" }
            },
            "somethingElse": [1, 2, 3]
        });
        let (next, changed) = merge(&existing, &provider_entry(&root(), 7719, &["auto".into()]));
        assert!(changed);
        assert_eq!(next["providers"]["workbuddy"], existing["providers"]["workbuddy"]);
        assert_eq!(next["providers"]["aihubmix"], existing["providers"]["aihubmix"]);
        assert_eq!(next["somethingElse"], existing["somethingElse"]);
        assert_eq!(next["providers"][PROVIDER]["baseUrl"], json!("http://127.0.0.1:7719/v1"));
    }

    #[test]
    fn merging_an_unchanged_entry_reports_no_change() {
        let entry = provider_entry(&root(), 7719, &["auto".into()]);
        let (once, _) = merge(&json!({}), &entry);
        let (_, changed) = merge(&once, &entry);
        assert!(!changed, "a second install must not rewrite the file");
    }

    #[test]
    fn removing_takes_only_our_entry() {
        let (with, _) = merge(
            &json!({ "providers": { "other": { "baseUrl": "https://x/v1" } } }),
            &provider_entry(&root(), 7719, &["auto".into()]),
        );
        let (without, changed) = remove(&with);
        assert!(changed);
        assert!(without["providers"].get(PROVIDER).is_none());
        assert_eq!(without["providers"]["other"]["baseUrl"], json!("https://x/v1"));
    }

    #[test]
    fn models_lead_with_the_failover_alias() {
        assert_eq!(model_ids("auto", &["groq".into(), "cerebras".into()]), [
            "auto", "groq", "cerebras"
        ]);
    }

    #[test]
    fn install_writes_then_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent").join("models.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"providers":{"workbuddy":{"baseUrl":"https://www.workbuddy.ai/v2"}}}"#,
        )
        .unwrap();
        let before = std::fs::read_to_string(&path).unwrap();

        let out = install_at(&path, &root(), 7719, &["auto".into()]).unwrap();
        assert!(out.changed);
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["providers"]["workbuddy"]["baseUrl"], json!("https://www.workbuddy.ai/v2"));
        assert!(!std::fs::read_to_string(&path).unwrap().contains(&before), "reformatted, not appended");

        let again = install_at(&path, &root(), 7719, &["auto".into()]).unwrap();
        assert!(!again.changed);
    }

    #[test]
    fn install_creates_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent").join("models.json");
        let out = install_at(&path, &root(), 7719, &["auto".into()]).unwrap();
        assert!(out.changed && path.exists());
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["providers"][PROVIDER]["api"], json!("openai-completions"));
    }

    #[test]
    fn a_moved_port_reads_as_stale_not_installed() {
        let entry_7719 = provider_entry(&root(), 7719, &["auto".into()]);
        let entry_9000 = provider_entry(&root(), 9000, &["auto".into()]);
        assert_ne!(entry_7719["baseUrl"], entry_9000["baseUrl"]);
        let (doc, _) = merge(&json!({}), &entry_7719);
        assert_eq!(doc["providers"][PROVIDER]["baseUrl"], json!("http://127.0.0.1:7719/v1"));
    }
}
