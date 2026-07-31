//! Reads the desktop app's `ui-layout.json` sidecar and turns it into
//! render-ready mosaic JSON for `amber web`. Read-only: this module never
//! writes the sidecar (the Electron app is its sole writer).

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

/// Sidecar file name inside the state root, written by the Electron app.
pub const LAYOUT_FILE: &str = "ui-layout.json";

/// A node of the app's binary split tree. Mirrors `app/src/renderer/layout.ts`.
///
/// The sidecar writes an INTERNALLY tagged enum — `{"kind":"leaf","paneId":…}`,
/// tag alongside payload — so `tag = "kind"`, `rename_all = "lowercase"`
/// (serde would otherwise look for `"Leaf"`/`"Split"`) and the explicit
/// `paneId` rename are all load-bearing.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Node {
    Leaf {
        #[serde(rename = "paneId")]
        pane_id: String,
    },
    Split {
        dir: String,
        ratio: f32,
        a: Box<Node>,
        b: Box<Node>,
    },
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FrozenEntry {
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct TabLayout {
    #[serde(default)]
    pub tree: Option<Node>,
    #[serde(default)]
    pub label: Option<String>,
}

fn default_active_tab() -> u32 {
    1
}

fn default_active_workspace() -> u32 {
    1
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct WsLayout {
    #[serde(default = "default_active_tab", rename = "activeTab")]
    pub active_tab: u32,
    #[serde(default)]
    pub tabs: HashMap<String, TabLayout>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default, rename = "tabOrder")]
    pub tab_order: Option<Vec<u32>>,
}

/// The subset of the sidecar the mosaic needs.
///
/// `browsers`, `editors`, `fontSize` and `recentFiles` are deliberately NOT
/// deserialized — the mosaic renders no app-local panes, and `recentFiles` is a
/// list of arbitrary host paths with no business crossing the web boundary.
///
/// `version` must be 1 (the current LAYOUT_VERSION). If present and not 1, the
/// sidecar is treated as incompatible and returns an empty layout (same as the
/// TS parser). If version is missing, it's treated as 0 (pre-versioning), which
/// also returns empty — matching `layoutFile.ts:165` behavior.
#[derive(Debug, Clone, Deserialize)]
pub struct LayoutFile {
    #[serde(default)]
    pub version: u32,
    #[serde(default = "default_active_workspace", rename = "activeWorkspace")]
    pub active_workspace: u32,
    #[serde(default)]
    pub workspaces: HashMap<String, WsLayout>,
    #[serde(default)]
    pub frozen: HashMap<String, FrozenEntry>,
}

impl Default for LayoutFile {
    /// Returns an empty layout matching `layoutFile.ts:158-160 emptyLayout()`.
    /// Version 1, activeWorkspace 1, empty workspaces and frozen map.
    fn default() -> Self {
        LayoutFile {
            version: 1,
            active_workspace: 1,
            workspaces: HashMap::new(),
            frozen: HashMap::new(),
        }
    }
}

/// Read `<root>/ui-layout.json`. A missing, unreadable or malformed sidecar is
/// NOT an error: it degrades to empty, which renders as the equal-splits
/// fallback the desktop app itself uses. Core rule #3 — grouping must be
/// reconstructable from session names alone.
///
/// Version validation: if the sidecar's version is present and not 1, it is
/// treated as incompatible and returns empty (matching `layoutFile.ts:165`).
/// If version is missing, it defaults to 0, which is also treated as invalid.
pub fn load(root: &Path) -> LayoutFile {
    match std::fs::read_to_string(root.join(LAYOUT_FILE))
        .ok()
        .and_then(|s| serde_json::from_str::<LayoutFile>(&s).ok())
    {
        Some(layout) if layout.version == 1 => layout,
        _ => LayoutFile::default(),
    }
}

use amber_core::proto::SessionInfo;

/// Digits-only `u32` parse. `str::parse::<u32>` accepts a leading `+`
/// (`from_str_radix` strips it), which the JS grammar this mirrors
/// (`^amber-(\d+)-…`) does not — `"+1".parse::<u32>()` is `Ok(1)`.
fn num(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// `amber-<ws>-<tab>-<ord>-<id>` → `(ws, tab, ord)`.
///
/// Hand-rolled rather than a regex: `regex` is not a dependency and this is the
/// whole grammar. Mirrors `app/src/shared/names.ts`'s
/// `^amber-(\d+)-(\d+)-(\d+)-([A-Za-z0-9]+)$` exactly — a `browser-*`/`editor-*`
/// id or a bare-`amber` `s<n>` name returns None.
pub fn parse_pane_name(name: &str) -> Option<(u32, u32, u32)> {
    let rest = name.strip_prefix("amber-")?;
    let mut it = rest.split('-');
    let ws = num(it.next()?)?;
    let tab = num(it.next()?)?;
    let ord = num(it.next()?)?;
    let id = it.next()?;
    if it.next().is_some() || id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some((ws, tab, ord))
}

/// Drop `pane_id` from the tree; a split that loses one child is replaced by
/// its surviving child. Port of `removeLeaf` in `app/src/renderer/layout.ts`.
fn remove_leaf(n: &Node, pane_id: &str) -> Option<Node> {
    match n {
        Node::Leaf { pane_id: p } => (p != pane_id).then(|| n.clone()),
        Node::Split { dir, ratio, a, b } => match (remove_leaf(a, pane_id), remove_leaf(b, pane_id)) {
            (None, None) => None,
            (Some(x), None) | (None, Some(x)) => Some(x),
            (Some(x), Some(y)) => Some(Node::Split {
                dir: dir.clone(),
                ratio: *ratio,
                a: Box::new(x),
                b: Box::new(y),
            }),
        },
    }
}

fn leaves(n: &Node, out: &mut Vec<String>) {
    match n {
        Node::Leaf { pane_id } => out.push(pane_id.clone()),
        Node::Split { a, b, .. } => {
            leaves(a, out);
            leaves(b, out);
        }
    }
}

/// Append `pane_id` against the whole tree, for a leaf the sidecar never
/// recorded. Byte-for-byte the desktop app's own rule — `reconcile` in
/// `app/src/renderer/layout.ts:169-181` appends `{dir:'h', ratio:0.66,
/// a: tree, b: leaf}`. Matching it exactly is the point: this is the
/// reboot-restored / just-created case, and the mosaic must not visibly
/// disagree with the desktop about it.
fn append_leaf(tree: Option<Node>, pane_id: &str) -> Node {
    let leaf = Node::Leaf { pane_id: pane_id.to_string() };
    match tree {
        None => leaf,
        Some(t) => Node::Split {
            dir: "h".into(),
            ratio: 0.66,
            a: Box::new(t),
            b: Box::new(leaf),
        },
    }
}

fn node_json(n: &Node) -> serde_json::Value {
    match n {
        Node::Leaf { pane_id } => serde_json::json!({ "kind": "leaf", "paneId": pane_id }),
        Node::Split { dir, ratio, a, b } => serde_json::json!({
            "kind": "split", "dir": dir, "ratio": ratio,
            "a": node_json(a), "b": node_json(b),
        }),
    }
}

/// Build the render-ready mosaic for the browser.
///
/// The prune rule is stated as a property of the daemon's session list — *drop
/// any leaf that is not a live daemon session* — never as a list of known id
/// prefixes. That is why a future app-local pane kind needs no change here.
pub fn render(f: &LayoutFile, sessions: &[SessionInfo]) -> serde_json::Value {
    // Every daemon session whose name parses as a pane, grouped by (ws, tab).
    let mut by_tab: HashMap<(u32, u32), Vec<&str>> = HashMap::new();
    let mut live: Vec<&str> = Vec::new();
    for s in sessions {
        if let Some((ws, tab, _ord)) = parse_pane_name(&s.name) {
            by_tab.entry((ws, tab)).or_default().push(&s.name);
            live.push(&s.name);
        }
    }
    // Deterministic order for appended panes (sessions arrive unordered).
    for v in by_tab.values_mut() {
        v.sort_unstable();
    }

    // Every (ws, tab) mentioned by either source.
    let mut ws_ids: Vec<u32> = Vec::new();
    for k in f.workspaces.keys() {
        if let Ok(n) = k.parse::<u32>() {
            ws_ids.push(n);
        }
    }
    for (ws, _) in by_tab.keys() {
        ws_ids.push(*ws);
    }
    ws_ids.sort_unstable();
    ws_ids.dedup();

    let mut out_ws = Vec::new();
    for ws in ws_ids {
        let wl = f.workspaces.get(&ws.to_string());

        let mut tab_ids: Vec<u32> = Vec::new();
        if let Some(w) = wl {
            for k in w.tabs.keys() {
                if let Ok(n) = k.parse::<u32>() {
                    tab_ids.push(n);
                }
            }
        }
        for (w, t) in by_tab.keys() {
            if *w == ws {
                tab_ids.push(*t);
            }
        }
        tab_ids.sort_unstable();
        tab_ids.dedup();

        // `tabOrder` is the app's display order; anything it omits follows in
        // numeric order (the app's own fallback).
        if let Some(order) = wl.and_then(|w| w.tab_order.as_ref()) {
            tab_ids.sort_by_key(|t| order.iter().position(|o| o == t).unwrap_or(usize::MAX));
        }

        let mut out_tabs = Vec::new();
        for tab in tab_ids {
            let tl = wl.and_then(|w| w.tabs.get(&tab.to_string()));
            let mut tree = tl.and_then(|t| t.tree.clone());

            // Prune every leaf that is not a live daemon session.
            if let Some(t) = tree.as_ref() {
                let mut ids = Vec::new();
                leaves(t, &mut ids);
                let mut cur = Some(t.clone());
                for id in ids {
                    if !live.iter().any(|n| *n == id) {
                        cur = cur.and_then(|c| remove_leaf(&c, &id));
                    }
                }
                tree = cur;
            }

            // Append daemon sessions the sidecar never recorded.
            let placed: Vec<String> = tree.as_ref().map(|t| {
                let mut v = Vec::new();
                leaves(t, &mut v);
                v
            }).unwrap_or_default();
            if let Some(names) = by_tab.get(&(ws, tab)) {
                for n in names {
                    if !placed.iter().any(|p| p == n) {
                        tree = Some(append_leaf(tree, n));
                    }
                }
            }

            let Some(t) = tree else { continue };
            out_tabs.push(serde_json::json!({
                "tab": tab,
                "label": tl.and_then(|x| x.label.clone()),
                "tree": node_json(&t),
            }));
        }

        if out_tabs.is_empty() {
            continue;
        }
        out_ws.push(serde_json::json!({
            "ws": ws,
            "label": wl.and_then(|w| w.label.clone()),
            "activeTab": wl.map(|w| w.active_tab).unwrap_or(0),
            "tabs": out_tabs,
        }));
    }

    // Names only, never the `note` strings — a note is arbitrary user text with
    // the same "no reason to cross the web boundary" argument as `recentFiles`.
    let mut frozen_names: Vec<&str> = f.frozen.keys().map(|s| s.as_str()).collect();
    frozen_names.sort_unstable();

    serde_json::json!({
        "activeWorkspace": f.active_workspace,
        "workspaces": out_ws,
        "frozen": frozen_names,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sidecar with the exact shape `app/src/shared/layoutFile.ts` writes:
    /// an internally-tagged split tree, string-keyed ws/tab maps, and the
    /// app-local `browsers`/`editors`/`recentFiles` keys this module ignores.
    const SIDECAR: &str = r#"{
      "version": 1,
      "activeWorkspace": 1,
      "fontSize": 14,
      "workspaces": {
        "1": {
          "activeTab": 2,
          "label": "main",
          "tabOrder": [2, 1],
          "tabs": {
            "1": { "tree": { "kind": "leaf", "paneId": "amber-1-1-0-aa" } },
            "2": {
              "label": "api",
              "tree": {
                "kind": "split", "dir": "h", "ratio": 0.6,
                "a": { "kind": "leaf", "paneId": "amber-1-2-0-bb" },
                "b": {
                  "kind": "split", "dir": "v", "ratio": 0.5,
                  "a": { "kind": "leaf", "paneId": "amber-1-2-1-cc" },
                  "b": { "kind": "leaf", "paneId": "editor-1-2-2-dd" }
                }
              }
            }
          }
        }
      },
      "frozen": { "amber-1-1-0-aa": { "note": "parked" } },
      "editors": { "editor-1-2-2-dd": { "ws": 1, "tab": 2, "ord": 2, "path": null } },
      "recentFiles": ["/home/me/secret.txt"]
    }"#;

    #[test]
    fn parses_the_real_sidecar_shape_including_nested_boxed_splits() {
        let f: LayoutFile = serde_json::from_str(SIDECAR).unwrap();
        assert_eq!(f.active_workspace, 1);
        let ws = f.workspaces.get("1").expect("ws 1");
        assert_eq!(ws.active_tab, 2);
        assert_eq!(ws.label.as_deref(), Some("main"));
        assert_eq!(ws.tab_order.as_deref(), Some(&[2u32, 1][..]));

        // Tab 1: a bare leaf.
        let t1 = ws.tabs.get("1").expect("tab 1");
        match t1.tree.as_ref().expect("tree") {
            Node::Leaf { pane_id } => assert_eq!(pane_id, "amber-1-1-0-aa"),
            other => panic!("expected leaf, got {other:?}"),
        }

        // Tab 2: nested `Box<Node>` recursion through an internally-tagged
        // enum — the part worth proving rather than assuming.
        let t2 = ws.tabs.get("2").expect("tab 2");
        assert_eq!(t2.label.as_deref(), Some("api"));
        match t2.tree.as_ref().expect("tree") {
            Node::Split { dir, ratio, a, b } => {
                assert_eq!(dir, "h");
                assert!((ratio - 0.6).abs() < 1e-6, "ratio {ratio}");
                assert!(matches!(**a, Node::Leaf { .. }));
                assert!(matches!(**b, Node::Split { .. }));
            }
            other => panic!("expected split, got {other:?}"),
        }

        assert!(f.frozen.contains_key("amber-1-1-0-aa"));
    }

    #[test]
    fn a_missing_or_malformed_sidecar_degrades_to_empty_rather_than_erroring() {
        let dir = tempfile::tempdir().unwrap();
        // Missing entirely.
        let f = load(dir.path());
        assert!(f.workspaces.is_empty());
        assert_eq!(f.active_workspace, 1, "degraded layout has activeWorkspace == 1");
        // Present but not JSON.
        std::fs::write(dir.path().join("ui-layout.json"), b"{ this is not json").unwrap();
        let f = load(dir.path());
        assert!(f.workspaces.is_empty());
        assert_eq!(f.active_workspace, 1, "degraded layout has activeWorkspace == 1");
        // Present, valid JSON, wrong shape.
        std::fs::write(dir.path().join("ui-layout.json"), b"[1,2,3]").unwrap();
        let f = load(dir.path());
        assert!(f.workspaces.is_empty());
        assert_eq!(f.active_workspace, 1, "degraded layout has activeWorkspace == 1");
    }

    #[test]
    fn load_reads_the_sidecar_from_the_state_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ui-layout.json"), SIDECAR).unwrap();
        let f = load(dir.path());
        assert_eq!(f.workspaces.len(), 1);
        assert_eq!(f.active_workspace, 1);
    }

    #[test]
    fn parses_this_machines_real_sidecar_if_present() {
        let Some(home) = std::env::var_os("HOME") else {
            eprintln!("skipped: no sidecar at $HOME/.local/state/amber-ide/ui-layout.json (HOME not set)");
            return;
        };
        let p = std::path::Path::new(&home).join(".local/state/amber-ide/ui-layout.json");
        let Ok(raw) = std::fs::read_to_string(&p) else {
            eprintln!("skipped: no sidecar at {}", p.display());
            return;
        };
        let f: LayoutFile = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("real sidecar {} failed to parse: {e}", p.display()));
        eprintln!("parsed real sidecar at {}: {} workspaces", p.display(), f.workspaces.len());
        assert!(!f.workspaces.is_empty(), "real sidecar has no workspaces");
    }

    #[test]
    fn defaults_active_tab_and_workspace_to_1_when_missing() {
        let sidecar_no_defaults = r#"{"version": 1, "workspaces": {"1": {"tabs": {}}}}"#;
        let f: LayoutFile = serde_json::from_str(sidecar_no_defaults).unwrap();
        assert_eq!(f.active_workspace, 1, "activeWorkspace defaults to 1");
        let ws = f.workspaces.get("1").expect("ws 1");
        assert_eq!(ws.active_tab, 1, "activeTab defaults to 1");
    }

    #[test]
    fn rejects_incompatible_version_2_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        // Valid LayoutFile shape with one workspace, but version 2 (incompatible).
        let v2_sidecar = r#"{"version": 2, "activeWorkspace": 1, "workspaces": {"1": {"activeTab": 1, "tabs": {}}}}"#;
        std::fs::write(dir.path().join("ui-layout.json"), v2_sidecar).unwrap();
        let f = load(dir.path());
        assert!(f.workspaces.is_empty(), "version 2 sidecar rejected");
        assert_eq!(f.active_workspace, 1, "degraded to empty with activeWorkspace == 1");
    }

    #[test]
    fn rejects_sidecar_with_missing_version_key() {
        let dir = tempfile::tempdir().unwrap();
        // Valid LayoutFile shape with one workspace, but no version key (defaults to 0, invalid).
        let no_version_sidecar = r#"{"activeWorkspace": 1, "workspaces": {"1": {"activeTab": 1, "tabs": {}}}}"#;
        std::fs::write(dir.path().join("ui-layout.json"), no_version_sidecar).unwrap();
        let f = load(dir.path());
        assert!(f.workspaces.is_empty(), "missing version sidecar rejected");
        assert_eq!(f.active_workspace, 1, "degraded to empty with activeWorkspace == 1");
    }

    use amber_core::proto::SessionInfo;

    fn sess(name: &str) -> SessionInfo {
        SessionInfo {
            name: name.into(),
            cwd: "/tmp".into(),
            kind: "shell".into(),
            alive: true,
            updated: 0,
            run_state: None,
            claude_id: None,
            cols: 80,
            rows: 24,
            slot: 0,
        }
    }

    #[test]
    fn app_local_leaves_are_pruned_and_their_parent_collapses() {
        let f: LayoutFile = serde_json::from_str(SIDECAR).unwrap();
        // `editor-1-2-2-dd` is not a daemon session, so its split collapses to
        // its sibling `amber-1-2-1-cc`.
        let live = [sess("amber-1-1-0-aa"), sess("amber-1-2-0-bb"), sess("amber-1-2-1-cc")];
        let v = render(&f, &live);
        let tab2 = &v["workspaces"][0]["tabs"][0];
        assert_eq!(tab2["tab"], 2);
        let tree = &tab2["tree"];
        assert_eq!(tree["kind"], "split");
        // The surviving split keeps the sidecar's own dir/ratio (0.6) — proves
        // sidecar pass-through into the emitted JSON, not just `append_leaf`'s
        // constant.
        assert_eq!(tree["dir"], "h");
        assert!(
            (tree["ratio"].as_f64().unwrap() - 0.6).abs() < 1e-6,
            "ratio {}",
            tree["ratio"]
        );
        assert_eq!(tree["a"]["paneId"], "amber-1-2-0-bb");
        // The nested split is gone: b is now the surviving sibling leaf.
        assert_eq!(tree["b"]["kind"], "leaf");
        assert_eq!(tree["b"]["paneId"], "amber-1-2-1-cc");
    }

    #[test]
    fn a_tab_of_only_app_local_panes_is_omitted_not_emitted_empty() {
        let raw = r#"{ "activeWorkspace": 1, "workspaces": { "1": { "activeTab": 1, "tabs": {
            "1": { "tree": { "kind": "leaf", "paneId": "amber-1-1-0-aa" } },
            "2": { "tree": { "kind": "leaf", "paneId": "browser-1-2-0-zz" } } } } } }"#;
        let f: LayoutFile = serde_json::from_str(raw).unwrap();
        let v = render(&f, &[sess("amber-1-1-0-aa")]);
        let tabs = v["workspaces"][0]["tabs"].as_array().unwrap();
        assert_eq!(tabs.len(), 1, "tab 2 should be omitted: {tabs:?}");
        assert_eq!(tabs[0]["tab"], 1);
    }

    #[test]
    fn a_workspace_whose_every_tab_prunes_away_is_omitted() {
        let raw = r#"{ "activeWorkspace": 1, "workspaces": {
            "1": { "activeTab": 1, "tabs": { "1": { "tree": { "kind": "leaf", "paneId": "amber-1-1-0-aa" } } } },
            "2": { "activeTab": 1, "tabs": { "1": { "tree": { "kind": "leaf", "paneId": "editor-2-1-0-zz" } } } } } }"#;
        let f: LayoutFile = serde_json::from_str(raw).unwrap();
        let v = render(&f, &[sess("amber-1-1-0-aa")]);
        let wss = v["workspaces"].as_array().unwrap();
        assert_eq!(wss.len(), 1, "ws 2 should be omitted: {wss:?}");
        assert_eq!(wss[0]["ws"], 1);
    }

    #[test]
    fn a_session_absent_from_the_sidecar_is_appended_to_its_name_encoded_tab() {
        // The reboot-restored / just-created case: the daemon lists a pane the
        // sidecar has never seen. It must still appear, split evenly.
        let raw = r#"{ "activeWorkspace": 1, "workspaces": { "1": { "activeTab": 1, "tabs": {
            "1": { "tree": { "kind": "leaf", "paneId": "amber-1-1-0-aa" } } } } } }"#;
        let f: LayoutFile = serde_json::from_str(raw).unwrap();
        let v = render(&f, &[sess("amber-1-1-0-aa"), sess("amber-1-1-1-new")]);
        let tree = &v["workspaces"][0]["tabs"][0]["tree"];
        assert_eq!(tree["kind"], "split");
        // `append_leaf`'s documented constants, asserted on the EMITTED JSON —
        // not just the deserialized `Node` — so deleting them fails a test.
        assert_eq!(tree["dir"], "h");
        assert!(
            (tree["ratio"].as_f64().unwrap() - 0.66).abs() < 1e-6,
            "ratio {}",
            tree["ratio"]
        );
        assert_eq!(tree["a"]["paneId"], "amber-1-1-0-aa");
        assert_eq!(tree["b"]["paneId"], "amber-1-1-1-new");
    }

    #[test]
    fn a_session_in_a_workspace_the_sidecar_never_recorded_still_appears() {
        let f = LayoutFile::default();
        let v = render(&f, &[sess("amber-3-2-0-xx")]);
        let ws = &v["workspaces"][0];
        assert_eq!(ws["ws"], 3);
        assert_eq!(ws["tabs"][0]["tab"], 2);
        assert_eq!(ws["tabs"][0]["tree"]["paneId"], "amber-3-2-0-xx");
    }

    #[test]
    fn non_pane_session_names_are_not_shown_anywhere() {
        // A bare-`amber` CLI session (`s2`) belongs to no workspace. Adopting
        // it is the desktop dialog's job (spec §2.4 / §9).
        let f = LayoutFile::default();
        let v = render(&f, &[sess("s2")]);
        assert!(v["workspaces"].as_array().unwrap().is_empty(), "{v}");
    }

    #[test]
    fn tabs_follow_taborder_and_carry_their_labels() {
        let f: LayoutFile = serde_json::from_str(SIDECAR).unwrap();
        let live = [sess("amber-1-1-0-aa"), sess("amber-1-2-0-bb"), sess("amber-1-2-1-cc")];
        let v = render(&f, &live);
        let tabs = v["workspaces"][0]["tabs"].as_array().unwrap();
        // tabOrder is [2, 1].
        assert_eq!(tabs[0]["tab"], 2);
        assert_eq!(tabs[0]["label"], "api");
        assert_eq!(tabs[1]["tab"], 1);
        assert_eq!(v["workspaces"][0]["label"], "main");
        assert_eq!(v["activeWorkspace"], 1);
        assert_eq!(v["workspaces"][0]["activeTab"], 2);
    }

    #[test]
    fn parses_pane_names_and_rejects_everything_else() {
        assert_eq!(parse_pane_name("amber-1-2-3-ab12"), Some((1, 2, 3)));
        assert_eq!(parse_pane_name("s2"), None);
        assert_eq!(parse_pane_name("browser-1-2-3-ab"), None);
        assert_eq!(parse_pane_name("amber-1-2-3"), None);
        assert_eq!(parse_pane_name("amber-1-2-3-ab-cd"), None);
        assert_eq!(parse_pane_name("amber-1-2-3-"), None);
        assert_eq!(parse_pane_name("amber-x-2-3-ab"), None);
        // `"+1".parse::<u32>()` is `Ok(1)` (from_str_radix strips a leading `+`);
        // the JS `^amber-(\d+)-…` grammar this mirrors has no such leniency.
        assert_eq!(parse_pane_name("amber-+1-2-3-ab"), None);
    }

    #[test]
    fn frozen_names_are_emitted_but_notes_never_are() {
        let f: LayoutFile = serde_json::from_str(SIDECAR).unwrap();
        let v = render(&f, &[sess("amber-1-1-0-aa")]);
        let frozen = v["frozen"].as_array().expect("frozen array");
        assert!(
            frozen.iter().any(|n| n == "amber-1-1-0-aa"),
            "frozen session name missing: {frozen:?}"
        );
        let s = v.to_string();
        assert!(!s.contains("parked"), "note text leaked into the payload: {s}");
    }
}
