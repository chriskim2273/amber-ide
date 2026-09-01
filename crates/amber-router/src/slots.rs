//! The GUI-facing view of the router config.
//!
//! Amber presents a flat, reorderable list of **slots**. A slot is one
//! provider with exactly one key and one model, and the slot order *is* the
//! failover order. Underneath, that is still a normal token-router config:
//! providers plus an implicit alias whose chain is the enabled slots in order.
//! Keeping the alias/chain model intact is deliberate — named routes can be
//! added later without migrating anybody's `router.toml`.

use router_core::config::{AliasConfig, ChainEntry, Config, ProviderConfig, ServerConfig};
use serde::{Deserialize, Serialize};

/// The alias every request should ask for to get the whole chain.
pub const DEFAULT_ALIAS: &str = "auto";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Slot {
    pub name: String,
    pub base_url: String,
    /// Secret. Never leaves the process except through an explicit reveal.
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

/// A slot with its key removed, for any surface the GUI or CLI can see.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotView {
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub enabled: bool,
    pub has_key: bool,
    /// `••••1234`, or empty when there is no key.
    pub key_hint: String,
}

/// Show only enough of a key to tell two of them apart.
pub fn mask_key(key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("••••{tail}")
}

pub fn view(slot: &Slot) -> SlotView {
    SlotView {
        name: slot.name.clone(),
        base_url: slot.base_url.clone(),
        model: slot.model.clone(),
        enabled: slot.enabled,
        has_key: !slot.api_key.is_empty(),
        key_hint: mask_key(&slot.api_key),
    }
}

/// Move a slot within the list. Out-of-range indices leave the list untouched.
pub fn move_slot(slots: &mut Vec<Slot>, from: usize, to: usize) {
    if from >= slots.len() || to >= slots.len() || from == to {
        return;
    }
    let item = slots.remove(from);
    slots.insert(to, item);
}

/// Names that would break the generated config or shadow the chain alias.
pub fn validate(slots: &[Slot]) -> Result<(), String> {
    let mut seen: Vec<&str> = Vec::new();
    for slot in slots {
        if slot.name.trim().is_empty() {
            return Err("slot name must not be empty".into());
        }
        if slot.name == DEFAULT_ALIAS {
            return Err(format!("`{DEFAULT_ALIAS}` is reserved for the failover chain"));
        }
        if !slot.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(format!(
                "slot name `{}` may only use letters, digits, `-` and `_`",
                slot.name
            ));
        }
        if seen.contains(&slot.name.as_str()) {
            return Err(format!("slot `{}` is defined more than once", slot.name));
        }
        seen.push(&slot.name);
        if !slot.base_url.starts_with("http://") && !slot.base_url.starts_with("https://") {
            return Err(format!("slot `{}` needs an http(s) base URL", slot.name));
        }
        if slot.model.trim().is_empty() {
            return Err(format!("slot `{}` needs a model id", slot.name));
        }
        if slot.api_key.is_empty() {
            return Err(format!("slot `{}` needs an API key", slot.name));
        }
    }
    Ok(())
}

/// Build a runnable config: every slot becomes a provider, the enabled ones in
/// order become the `auto` chain, and each also gets a single-entry alias so a
/// caller can pin one slot by name.
pub fn to_config(server: ServerConfig, slots: &[Slot]) -> Config {
    let providers = slots
        .iter()
        .map(|s| ProviderConfig {
            name: s.name.clone(),
            base_url: s.base_url.clone(),
            keys: if s.api_key.is_empty() { vec![] } else { vec![s.api_key.clone()] },
            ..provider_defaults()
        })
        .collect();

    let entry = |s: &Slot| ChainEntry { provider: s.name.clone(), model: s.model.clone() };
    let enabled: Vec<&Slot> = slots.iter().filter(|s| s.enabled).collect();

    let mut aliases = Vec::with_capacity(slots.len() + 1);
    if !enabled.is_empty() {
        aliases.push(AliasConfig {
            name: DEFAULT_ALIAS.to_string(),
            chain: enabled.iter().map(|s| entry(s)).collect(),
        });
    }
    // One per slot, disabled included: it is how a pinned request reaches a
    // single slot, and it is where a disabled slot's model survives a restart.
    for s in slots {
        aliases.push(AliasConfig { name: s.name.clone(), chain: vec![entry(s)] });
    }

    Config { server, providers, aliases }
}

/// Recover the slot list from a config we wrote. Provider order is slot order;
/// the `auto` chain only says which slots are enabled.
pub fn from_config(cfg: &Config) -> Vec<Slot> {
    let enabled: Vec<&str> = cfg
        .aliases
        .iter()
        .find(|a| a.name == DEFAULT_ALIAS)
        .map(|a| a.chain.iter().map(|e| e.provider.as_str()).collect())
        .unwrap_or_default();

    cfg.providers
        .iter()
        .map(|p| Slot {
            name: p.name.clone(),
            base_url: p.base_url.clone(),
            api_key: p.keys.first().cloned().unwrap_or_default(),
            model: cfg
                .aliases
                .iter()
                .find(|a| a.name == p.name)
                .and_then(|a| a.chain.first())
                .map(|e| e.model.clone())
                .unwrap_or_default(),
            enabled: enabled.contains(&p.name.as_str()),
        })
        .collect()
}

fn provider_defaults() -> ProviderConfig {
    // Deserializing an empty provider table is the only way to pick up the
    // serde `default =` functions without restating every timeout here.
    toml::from_str::<ProviderConfig>("name = \"\"\nbase_url = \"\"\n")
        .expect("provider defaults must parse")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(name: &str, model: &str) -> Slot {
        Slot {
            name: name.into(),
            base_url: format!("https://{name}.example/v1"),
            api_key: format!("sk-{name}-abcd1234"),
            model: model.into(),
            enabled: true,
        }
    }

    #[test]
    fn mask_shows_only_the_last_four() {
        assert_eq!(mask_key("sk-secret-wxyz"), "••••wxyz");
        assert_eq!(mask_key(""), "");
        assert_eq!(mask_key("ab"), "••••ab");
    }

    #[test]
    fn view_never_carries_the_key() {
        let v = view(&slot("groq", "llama"));
        let json = serde_json::to_string(&v).unwrap();
        assert!(!json.contains("sk-groq-abcd1234"), "{json}");
        assert!(v.has_key);
        assert_eq!(v.key_hint, "••••1234");
    }

    #[test]
    fn slot_order_is_the_chain_order() {
        let slots = vec![slot("a", "m1"), slot("b", "m2")];
        let cfg = to_config(server(), &slots);
        let auto = cfg.aliases.iter().find(|a| a.name == "auto").unwrap();
        let names: Vec<&str> = auto.chain.iter().map(|e| e.provider.as_str()).collect();
        assert_eq!(names, ["a", "b"]);
        assert_eq!(auto.chain[0].model, "m1");
    }

    #[test]
    fn moving_a_slot_moves_the_failover_order() {
        let mut slots = vec![slot("a", "m1"), slot("b", "m2"), slot("c", "m3")];
        move_slot(&mut slots, 2, 0);
        let cfg = to_config(server(), &slots);
        let auto = cfg.aliases.iter().find(|a| a.name == "auto").unwrap();
        let names: Vec<&str> = auto.chain.iter().map(|e| e.provider.as_str()).collect();
        assert_eq!(names, ["c", "a", "b"]);
    }

    #[test]
    fn move_out_of_range_is_a_no_op() {
        let mut slots = vec![slot("a", "m1")];
        move_slot(&mut slots, 0, 9);
        move_slot(&mut slots, 5, 0);
        assert_eq!(slots.len(), 1);
    }

    #[test]
    fn each_slot_is_also_pinnable_by_name() {
        let cfg = to_config(server(), &[slot("a", "m1"), slot("b", "m2")]);
        let pinned = cfg.aliases.iter().find(|a| a.name == "b").unwrap();
        assert_eq!(pinned.chain.len(), 1);
        assert_eq!(pinned.chain[0].provider, "b");
    }

    #[test]
    fn disabled_slot_is_kept_but_never_routed_to() {
        let mut slots = vec![slot("a", "m1"), slot("b", "m2")];
        slots[0].enabled = false;
        let cfg = to_config(server(), &slots);
        assert_eq!(cfg.providers.len(), 2, "the slot is kept, not deleted");
        let auto = cfg.aliases.iter().find(|a| a.name == "auto").unwrap();
        assert_eq!(auto.chain.len(), 1);
        assert_eq!(auto.chain[0].provider, "b");
        let pinned = cfg.aliases.iter().find(|a| a.name == "a").unwrap();
        assert_eq!(pinned.chain[0].model, "m1", "a disabled slot keeps its model");
    }

    #[test]
    fn round_trips_through_toml() {
        let mut slots = vec![slot("a", "m1"), slot("b", "m2"), slot("c", "m3")];
        slots[1].enabled = false;
        let text = toml::to_string_pretty(&to_config(server(), &slots)).unwrap();
        let parsed: Config = toml::from_str(&text).unwrap();
        assert_eq!(from_config(&parsed), slots);
    }

    #[test]
    fn generated_config_is_valid_to_the_router() {
        let cfg = to_config(server(), &[slot("a", "m1"), slot("b", "m2")]);
        let text = toml::to_string_pretty(&cfg).unwrap();
        Config::load_str(&text, &|_| None).expect("generated config must load and validate");
    }

    #[test]
    fn validation_rejects_the_ways_a_slot_breaks_the_config() {
        let ok = slot("a", "m1");
        assert!(validate(std::slice::from_ref(&ok)).is_ok());

        let dup = vec![ok.clone(), ok.clone()];
        assert!(validate(&dup).unwrap_err().contains("more than once"));

        let mut reserved = ok.clone();
        reserved.name = "auto".into();
        assert!(validate(&[reserved]).unwrap_err().contains("reserved"));

        let mut spaced = ok.clone();
        spaced.name = "my slot".into();
        assert!(validate(&[spaced]).is_err());

        let mut bad_url = ok.clone();
        bad_url.base_url = "groq.example/v1".into();
        assert!(validate(&[bad_url]).unwrap_err().contains("base URL"));

        let mut no_model = ok.clone();
        no_model.model = "".into();
        assert!(validate(&[no_model]).unwrap_err().contains("model"));

        let mut no_key = ok.clone();
        no_key.api_key = "".into();
        // Even a disabled slot needs one: a keyless provider makes the
        // generated config fail the router's own validation.
        assert!(validate(&[no_key.clone()]).unwrap_err().contains("API key"));
        no_key.enabled = false;
        assert!(validate(&[no_key]).unwrap_err().contains("API key"));
    }

    fn server() -> ServerConfig {
        toml::from_str("").unwrap()
    }
}
