# Remote Mosaic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `amber web` renders the desktop's workspace/tab/split tree as a tappable mosaic, with full pane parity (create/kill/move/suspend/resume) from the browser.

**Architecture:** A new `crates/amber/src/mosaic.rs` reads `<root>/ui-layout.json`, prunes every leaf that is not a live daemon session, and emits render-ready JSON. `web.rs` caches that JSON on `HubInner`, refreshes it on the existing 1 s poll thread, and ships it in both the `GET /api/sessions` body and the `{t:"sessions"}` WebSocket push. The browser protocol whitelist widens from `open`/`close` to also construct `Create`/`Kill`/`Rename`/`Suspend`/`Resume` — never `Resize`. No sidecar writes, no daemon protocol change, no Electron app change.

**Tech Stack:** Rust (std + serde + serde_json only — no new crates), vanilla ES5-style JS in `crates/amber/assets/app.js` (no bundler, no framework), CSS in `assets/style.css`.

**Spec:** `docs/superpowers/specs/2026-07-31-remote-mosaic-web-design.md` — read it before Task 1.

## Global Constraints

- **No new dependencies.** `amber` links std, serde, serde_json, portable-pty, clap, nix, signal-hook and nothing else. No openssl, no tokio.
- **No daemon protocol change.** `crates/amber-core/src/proto.rs` is not edited by this plan. Every control message used here already exists.
- **No write to `ui-layout.json`, ever.** The desktop app is its only writer.
- **`Resize` is never constructible from a browser message.** A pty has one shared winsize; a phone-sized resize would reflow the desktop and corrupt an agent TUI.
- **File IO never runs on the daemon read thread** (`Hub::on_frame`). The sidecar is read on the 1 s poll thread only.
- **The tree is never optimistic.** No browser gesture edits the local tree; the server push is the sole source of truth for pane existence (core rule #3).
- **`cargo clippy --workspace --all-targets` must stay clean** (`-D warnings` in CI).
- Pane name grammar, verbatim: `^amber-\d+-\d+-\d+-[A-Za-z0-9]+$`.
- Valid `Create` kinds, verbatim: `shell`, `claude`, `grok`.
- Run in a git worktree — invoke `superpowers:using-git-worktrees` before Task 1.

---

### Task 1: Sidecar parsing (`mosaic.rs`)

Deserialize `ui-layout.json` into Rust types. Nothing else — no pruning, no JSON output.

**Files:**
- Create: `crates/amber/src/mosaic.rs`
- Modify: `crates/amber/src/lib.rs` (add `pub mod mosaic;`)

**Interfaces:**
- Consumes: nothing.
- Produces: `pub enum Node { Leaf { pane_id: String }, Split { dir: String, ratio: f32, a: Box<Node>, b: Box<Node> } }`, `pub struct TabLayout { tree: Option<Node>, label: Option<String> }`, `pub struct WsLayout { active_tab: u32, tabs: HashMap<String, TabLayout>, label: Option<String>, tab_order: Option<Vec<u32>> }`, `pub struct LayoutFile { active_workspace: u32, workspaces: HashMap<String, WsLayout>, frozen: HashMap<String, FrozenEntry> }`, and `pub fn load(root: &Path) -> LayoutFile`.

- [ ] **Step 1: Write the failing test**

Create `crates/amber/src/mosaic.rs` containing ONLY this test module (no implementation yet):

```rust
//! Reads the desktop app's `ui-layout.json` sidecar and turns it into
//! render-ready mosaic JSON for `amber web`. Read-only: this module never
//! writes the sidecar (the Electron app is its sole writer).

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
        assert!(load(dir.path()).workspaces.is_empty());
        // Present but not JSON.
        std::fs::write(dir.path().join("ui-layout.json"), b"{ this is not json").unwrap();
        assert!(load(dir.path()).workspaces.is_empty());
        // Present, valid JSON, wrong shape.
        std::fs::write(dir.path().join("ui-layout.json"), b"[1,2,3]").unwrap();
        assert!(load(dir.path()).workspaces.is_empty());
    }

    #[test]
    fn load_reads_the_sidecar_from_the_state_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ui-layout.json"), SIDECAR).unwrap();
        let f = load(dir.path());
        assert_eq!(f.workspaces.len(), 1);
        assert_eq!(f.active_workspace, 1);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cargo test -p amber --lib mosaic
```

Expected: FAIL to compile — `cannot find type LayoutFile in this scope`, `cannot find function load`.

- [ ] **Step 3: Write minimal implementation**

Prepend to `crates/amber/src/mosaic.rs`, above the test module:

```rust
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

#[derive(Debug, Clone, Default, Deserialize)]
pub struct WsLayout {
    #[serde(default, rename = "activeTab")]
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
#[derive(Debug, Clone, Default, Deserialize)]
pub struct LayoutFile {
    #[serde(default, rename = "activeWorkspace")]
    pub active_workspace: u32,
    #[serde(default)]
    pub workspaces: HashMap<String, WsLayout>,
    #[serde(default)]
    pub frozen: HashMap<String, FrozenEntry>,
}

/// Read `<root>/ui-layout.json`. A missing, unreadable or malformed sidecar is
/// NOT an error: it degrades to empty, which renders as the equal-splits
/// fallback the desktop app itself uses. Core rule #3 — grouping must be
/// reconstructable from session names alone.
pub fn load(root: &Path) -> LayoutFile {
    std::fs::read_to_string(root.join(LAYOUT_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
```

Add to `crates/amber/src/lib.rs`, keeping the list alphabetical:

```rust
pub mod mosaic;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p amber --lib mosaic
cargo clippy -p amber --all-targets -- -D warnings
```

Expected: 3 tests PASS, clippy clean.

- [ ] **Step 5: Verify against the real sidecar on this box**

This is the check the spec calls for explicitly — the synthetic fixture could agree with a wrong struct.

```bash
cargo test -p amber --lib mosaic -- --nocapture
ls -l ~/.local/state/amber-ide/ui-layout.json
```

Then add this test (it skips cleanly on a machine with no sidecar, so CI stays green):

```rust
    #[test]
    fn parses_this_machines_real_sidecar_if_present() {
        let Some(home) = std::env::var_os("HOME") else { return };
        let p = std::path::Path::new(&home).join(".local/state/amber-ide/ui-layout.json");
        let Ok(raw) = std::fs::read_to_string(&p) else { return };
        let f: LayoutFile = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("real sidecar {} failed to parse: {e}", p.display()));
        assert!(!f.workspaces.is_empty(), "real sidecar has no workspaces");
    }
```

Run it and confirm it actually parsed something (not silently skipped):

```bash
cargo test -p amber --lib mosaic::tests::parses_this_machines_real_sidecar -- --nocapture
```

- [ ] **Step 6: Commit**

```bash
git add crates/amber/src/mosaic.rs crates/amber/src/lib.rs
git commit -m "feat(web): parse the ui-layout.json sidecar in Rust"
```

---

### Task 2: Prune, collapse, and render-ready JSON

Turn a `LayoutFile` + the daemon's live session list into the JSON the browser draws.

**Files:**
- Modify: `crates/amber/src/mosaic.rs`

**Interfaces:**
- Consumes: Task 1's `Node`, `LayoutFile`, `load`.
- Produces: `pub fn render(f: &LayoutFile, sessions: &[SessionInfo]) -> serde_json::Value` and `pub fn parse_pane_name(name: &str) -> Option<(u32, u32, u32)>` (returns `(ws, tab, ord)`).

The emitted shape, which Task 5's front end consumes verbatim:

```json
{
  "activeWorkspace": 1,
  "workspaces": [
    { "ws": 1, "label": "main", "activeTab": 2,
      "tabs": [ { "tab": 2, "label": "api", "tree": {…} },
                { "tab": 1, "label": null, "tree": {…} } ] }
  ]
}
```

`tree` nodes are `{"kind":"leaf","paneId":"…"}` / `{"kind":"split","dir":"h","ratio":0.6,"a":…,"b":…}` — the same shape as the sidecar, so the front end needs one renderer.

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests` in `crates/amber/src/mosaic.rs`:

```rust
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
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p amber --lib mosaic
```

Expected: FAIL to compile — `cannot find function render`, `cannot find function parse_pane_name`.

- [ ] **Step 3: Write minimal implementation**

Append to the implementation half of `crates/amber/src/mosaic.rs`:

```rust
use amber_core::proto::SessionInfo;

/// `amber-<ws>-<tab>-<ord>-<id>` → `(ws, tab, ord)`.
///
/// Hand-rolled rather than a regex: `regex` is not a dependency and this is the
/// whole grammar. Mirrors `app/src/shared/names.ts`'s
/// `^amber-(\d+)-(\d+)-(\d+)-([A-Za-z0-9]+)$` exactly — a `browser-*`/`editor-*`
/// id or a bare-`amber` `s<n>` name returns None.
pub fn parse_pane_name(name: &str) -> Option<(u32, u32, u32)> {
    let rest = name.strip_prefix("amber-")?;
    let mut it = rest.split('-');
    let ws = it.next()?.parse().ok()?;
    let tab = it.next()?.parse().ok()?;
    let ord = it.next()?.parse().ok()?;
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

/// Append `pane_id` as an even split of the whole tree (the equal-splits
/// fallback the desktop app uses for a leaf the sidecar never recorded).
fn append_leaf(tree: Option<Node>, pane_id: &str) -> Node {
    let leaf = Node::Leaf { pane_id: pane_id.to_string() };
    match tree {
        None => leaf,
        Some(t) => Node::Split {
            dir: "h".into(),
            ratio: 0.5,
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

    serde_json::json!({
        "activeWorkspace": f.active_workspace,
        "workspaces": out_ws,
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p amber --lib mosaic
cargo clippy -p amber --all-targets -- -D warnings
```

Expected: all `mosaic` tests PASS, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add crates/amber/src/mosaic.rs
git commit -m "feat(web): prune app-local leaves and emit render-ready mosaic JSON"
```

---

### Task 3: Serve the mosaic (`web.rs` wiring)

Cache the mosaic on the hub, refresh it on the existing 1 s poll, and ship it in both the HTTP body and the WebSocket push. Also add the missing `slot`.

**Files:**
- Modify: `crates/amber/src/web.rs` (`HubInner`, `Hub::new`, `session_json`, `sessions_json`, `sessions_msg`, `on_frame`, `serve`)
- Modify: `crates/amber/src/main.rs:524` (pass `root` to `web::serve`)
- Modify: `crates/amber/tests/web.rs` (fixture + the array-shape assertion at line 210-214)

**Interfaces:**
- Consumes: Task 2's `mosaic::load`, `mosaic::render`.
- Produces: `pub fn serve(listener: TcpListener, daemon_socket: PathBuf, root: PathBuf, token: String) -> anyhow::Result<()>` — note the new third parameter. `GET /api/sessions` returns `{"sessions":[…],"layout":{…}}`. The WebSocket `{t:"sessions"}` push gains a `layout` key.

- [ ] **Step 1: Write the failing tests**

In `crates/amber/tests/web.rs`, update the fixture to pass the root (the tempdir is already both state root and daemon dir):

```rust
        std::thread::spawn(move || {
            let _ = web::serve(tcp, sock, root, token);
        });
```

adding `let root = dir.path().to_path_buf();` above the spawn block, cloned like `sock`.

Then update the shape assertion in `good_token_yields_a_cookie_that_lists_daemon_sessions_with_real_geometry` — `/api/sessions` is no longer a bare array:

```rust
    let geometry = |body: &str| -> (u64, u64) {
        let v: serde_json::Value = serde_json::from_str(body).unwrap();
        let s = &v["sessions"].as_array().unwrap()[0];
        (s["cols"].as_u64().unwrap(), s["rows"].as_u64().unwrap())
    };
```

And append these tests:

```rust
#[test]
fn sessions_response_carries_the_mosaic_and_the_slot() {
    let f = fixture();
    let name = f.create_session();
    let cookie = f.login();

    // A sidecar placing that pane in ws 1 / tab 1, beside an editor pane that
    // must be pruned away.
    std::fs::write(
        f.dir.path().join("ui-layout.json"),
        format!(
            r#"{{"version":1,"activeWorkspace":1,"workspaces":{{"1":{{"activeTab":1,"label":"main","tabs":{{
               "1":{{"label":"api","tree":{{"kind":"split","dir":"h","ratio":0.7,
                 "a":{{"kind":"leaf","paneId":"{name}"}},
                 "b":{{"kind":"leaf","paneId":"editor-1-1-1-zz"}}}}}}}}}}}}}}"#
        ),
    )
    .unwrap();

    let mut body = String::new();
    let ok = wait_until(Duration::from_secs(10), || {
        let (status, _, b) = f.get("/api/sessions", Some(&cookie));
        body = b;
        if !status.contains("200") {
            return false;
        }
        let v: serde_json::Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(_) => return false,
        };
        v["layout"]["workspaces"][0]["tabs"][0]["tree"]["kind"] == "leaf"
    });
    assert!(ok, "mosaic never appeared / editor leaf never pruned: {body}");

    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    // The response is an object now, not a bare array.
    assert!(v["sessions"].is_array(), "{body}");
    // The editor leaf is gone and its split collapsed to the surviving pane.
    assert_eq!(v["layout"]["workspaces"][0]["tabs"][0]["tree"]["paneId"], name.as_str());
    assert_eq!(v["layout"]["workspaces"][0]["label"], "main");
    assert_eq!(v["layout"]["workspaces"][0]["tabs"][0]["label"], "api");
    // The mosaic tile shows `#slot` — the same number `amber attach <n>` takes.
    assert!(
        v["sessions"][0]["slot"].as_u64().is_some(),
        "sessions listing has no slot: {body}"
    );
}

#[test]
fn a_sidecar_only_change_still_reaches_the_browser() {
    // The trap (spec §3.1): `on_frame` returns early when the session set is
    // unchanged. Dragging a divider on the desktop rewrites ui-layout.json with
    // an IDENTICAL session set — that must still push.
    let f = fixture();
    let name = f.create_session();
    let cookie = f.login();
    let write_layout = |ratio: &str| {
        std::fs::write(
            f.dir.path().join("ui-layout.json"),
            format!(
                r#"{{"version":1,"activeWorkspace":1,"workspaces":{{"1":{{"activeTab":1,"tabs":{{
                   "1":{{"tree":{{"kind":"split","dir":"h","ratio":{ratio},
                     "a":{{"kind":"leaf","paneId":"{name}"}},
                     "b":{{"kind":"leaf","paneId":"{name}"}}}}}}}}}}}}}}"#
            ),
        )
        .unwrap();
    };
    write_layout("0.3");
    assert!(
        wait_until(Duration::from_secs(10), || {
            f.get("/api/sessions", Some(&cookie)).2.contains("0.3")
        }),
        "first layout never served"
    );

    let stream = TcpStream::connect(f.addr).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
    let uri: tungstenite::http::Uri = format!("ws://{}/ws", f.addr).parse().unwrap();
    let req = tungstenite::ClientRequestBuilder::new(uri).with_header("Cookie", cookie.clone());
    let (mut ws, _) = tungstenite::client::client(req, stream).unwrap();

    // Session set is untouched; only the sidecar changes.
    write_layout("0.8");

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut saw = false;
    while Instant::now() < deadline && !saw {
        if let Ok(tungstenite::Message::Text(t)) = ws.read() {
            if t.contains("\"t\":\"sessions\"") && t.contains("0.8") {
                saw = true;
            }
        }
    }
    assert!(saw, "a sidecar-only change never pushed to the browser");
}

#[test]
fn the_mosaic_is_behind_the_cookie_boundary() {
    let f = fixture();
    let (status, _, body) = f.get("/api/sessions", None);
    assert!(status.contains("401"), "{status}");
    assert!(!body.contains("layout"), "layout leaked to an unauthenticated caller: {body}");
    let (status, _, body) = f.get("/api/sessions", Some("amber_web=forged"));
    assert!(status.contains("401"), "{status}");
    assert!(!body.contains("layout"), "layout leaked to a forged cookie: {body}");
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p amber --test web
```

Expected: FAIL to compile — `web::serve` takes 3 arguments, not 4.

- [ ] **Step 3: Write minimal implementation**

In `crates/amber/src/web.rs`:

Add `slot` to `session_json`:

```rust
        // The mosaic tile leads with `#slot` — the same number `amber attach
        // <n>` resolves, so a pane can be reached from any terminal.
        "slot": s.slot,
```

Give `HubInner` a cached mosaic and a root:

```rust
struct HubInner {
    /// Write half of the single daemon connection; `None` while unreachable.
    daemon: Option<UnixStream>,
    sessions: Vec<SessionInfo>,
    /// Serialized mosaic (`mosaic::render`). Cached because it must be
    /// COMPARED, not just sent: a sidecar-only change leaves `sessions`
    /// byte-identical, and `on_frame`'s early return would swallow it.
    layout: String,
    clients: Vec<Client>,
}
```

`Hub` gains the state root:

```rust
pub struct Hub {
    socket: PathBuf,
    /// State root holding `ui-layout.json`. Read ONLY, and only from the poll
    /// thread — never from `on_frame` (the shared daemon read thread must not
    /// touch the filesystem).
    root: PathBuf,
    inner: Mutex<HubInner>,
    next_id: AtomicU64,
}
```

Update `Hub::new(socket, root)` to store both and initialise `layout: String::new()`.

Make the two payload builders take the cached layout:

```rust
    /// JSON body for `GET /api/sessions`.
    fn sessions_json(&self) -> String {
        let inner = self.inner.lock().unwrap();
        Self::payload(&inner.sessions, &inner.layout)
    }

    /// The one payload shape, shared by the HTTP body and the WS push, so the
    /// two can never drift.
    fn payload(sessions: &[SessionInfo], layout: &str) -> String {
        let list: Vec<_> = sessions.iter().map(session_json).collect();
        let layout: serde_json::Value =
            serde_json::from_str(layout).unwrap_or(serde_json::Value::Null);
        serde_json::to_string(&serde_json::json!({ "sessions": list, "layout": layout }))
            .unwrap_or_else(|_| r#"{"sessions":[],"layout":null}"#.into())
    }

    fn sessions_msg(sessions: &[SessionInfo], layout: &str) -> Out {
        let list: Vec<_> = sessions.iter().map(session_json).collect();
        let layout: serde_json::Value =
            serde_json::from_str(layout).unwrap_or(serde_json::Value::Null);
        Out::Text(Arc::new(
            serde_json::json!({ "t": "sessions", "sessions": list, "layout": layout }).to_string(),
        ))
    }
```

Fix the three existing `sessions_msg` call sites (`add_client`, and the two arms of `on_frame`) to pass `&inner.layout`.

Recompute the mosaic wherever the session set changes, and make the `Sessions` arm compare both fields:

```rust
            Frame::Control(ControlMsg::Sessions { sessions }) => {
                // The geometry poll thread has already refreshed `inner.layout`
                // for this tick. Push when EITHER the session set or the
                // layout changed — a divider drag changes only the latter.
                if inner.sessions == sessions && !inner.layout_dirty {
                    return;
                }
                inner.layout_dirty = false;
                inner.sessions = sessions;
                let msg = Self::sessions_msg(&inner.sessions, &inner.layout);
                Self::queue(&mut inner, |_| true, msg);
            }
```

That needs a `layout_dirty: bool` on `HubInner` (init `false`), set by the poll thread when the re-read mosaic differs from the cached one. `SessionsChanged` recomputes the mosaic inline from the new session set, since the tree depends on it:

```rust
            Frame::Control(ControlMsg::SessionsChanged { added, removed }) => {
                inner.sessions.retain(|s| {
                    !removed.contains(&s.name) && !added.iter().any(|a| a.name == s.name)
                });
                inner.sessions.extend(added);
                // The mosaic prunes against the live session set, so it is
                // stale the instant that set changes. Re-render from the CACHED
                // sidecar — no file IO on this thread.
                inner.layout = Self::render_layout(&inner.file, &inner.sessions);
                let msg = Self::sessions_msg(&inner.sessions, &inner.layout);
                Self::queue(&mut inner, |_| true, msg);
            }
```

So `HubInner` also caches the parsed sidecar:

```rust
    /// Last parsed `ui-layout.json`. Kept so `on_frame` can re-render the
    /// mosaic against a changed session set without touching the filesystem.
    file: mosaic::LayoutFile,
```

and a small helper:

```rust
    fn render_layout(file: &mosaic::LayoutFile, sessions: &[SessionInfo]) -> String {
        serde_json::to_string(&mosaic::render(file, sessions)).unwrap_or_else(|_| "null".into())
    }
```

Finally, the poll thread in `serve` re-reads the sidecar each tick, before asking the daemon for sessions:

```rust
        thread::spawn(move || loop {
            thread::sleep(GEOMETRY_POLL);
            // Sidecar IO on THIS thread only. `on_frame` (the shared daemon
            // read thread) must never touch the filesystem.
            let file = mosaic::load(&hub.root);
            let mut inner = hub.inner.lock().unwrap();
            let rendered = Hub::render_layout(&file, &inner.sessions);
            if rendered != inner.layout {
                inner.layout = rendered;
                inner.layout_dirty = true;
            }
            inner.file = file;
            if inner.daemon.is_some() {
                Hub::write_daemon(&mut inner, &Frame::Control(ControlMsg::ListSessionsDetailed));
            }
        });
```

Add `use crate::mosaic;` at the top of `web.rs`, change `serve`'s signature to take `root: PathBuf` and pass it to `Hub::new`, and update `crates/amber/src/main.rs:524`:

```rust
    amber::web::serve(listener, socket, root, token)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p amber --test web
cargo test -p amber
cargo clippy -p amber --all-targets -- -D warnings
```

Expected: all web tests PASS (including `a_sidecar_only_change_still_reaches_the_browser`), whole-crate suite green, clippy clean.

- [ ] **Step 5: Prove the change-detection test is real**

A test that passes for the wrong reason is worse than none. Temporarily revert just the dirty-flag check:

```bash
# In on_frame's Sessions arm, change the guard back to:
#   if inner.sessions == sessions { return; }
cargo test -p amber --test web a_sidecar_only_change
```

Expected: FAIL. Restore the `layout_dirty` guard and confirm it passes again.

- [ ] **Step 6: Commit**

```bash
git add crates/amber/src/web.rs crates/amber/src/main.rs crates/amber/tests/web.rs
git commit -m "feat(web): serve the mosaic on /api/sessions and the sessions push"
```

---

### Task 4: Widen the browser whitelist

Add `create` / `kill` / `move` / `suspend` / `resume` browser messages, validated at the boundary. `Resize` stays unreachable.

**Files:**
- Modify: `crates/amber/src/web.rs` (`BrowserMsg`, `parse_browser_msg`, `map_browser_msg`)
- Modify: `crates/amber/tests/web.rs`

**Interfaces:**
- Consumes: Task 2's `mosaic::parse_pane_name`.
- Produces: `BrowserMsg` gains `Create { name, cwd, kind }`, `Kill { name }`, `Move { from, to }`, `Suspend { name }`, `Resume { name }`. `map_browser_msg` gains a `sessions: &[SessionInfo]` parameter (replacing `live: &[String]`) so it can check `kind` for the agent gate.

- [ ] **Step 1: Write the failing tests**

`map_browser_msg` and `parse_browser_msg` are pure and already unit-tested somewhere in `web.rs`'s test module — find the existing tests for them and add alongside:

```rust
    fn s(name: &str, kind: &str) -> SessionInfo {
        SessionInfo {
            name: name.into(), cwd: "/tmp".into(), kind: kind.into(), alive: true,
            updated: 0, run_state: None, claude_id: None, cols: 80, rows: 24, slot: 1,
        }
    }

    #[test]
    fn create_requires_the_pane_grammar_and_a_known_kind() {
        let live = [s("amber-1-1-0-aa", "shell")];
        let mk = |name: &str, kind: &str| {
            map_browser_msg(
                &BrowserMsg::Create { name: name.into(), cwd: "/tmp".into(), kind: kind.into() },
                None,
                &live,
            )
        };
        assert_eq!(mk("amber-1-1-1-bb", "shell").len(), 1);
        assert_eq!(mk("amber-1-1-1-bb", "grok").len(), 1);
        // Outside the pane grammar: no pane could ever show it, and `s<n>`
        // would shadow the bare-`amber` CLI namespace.
        assert!(mk("s3", "shell").is_empty());
        assert!(mk("amber-1-1-1-bb!", "shell").is_empty());
        assert!(mk("browser-1-1-1-bb", "shell").is_empty());
        // Unknown kind.
        assert!(mk("amber-1-1-1-bb", "bash").is_empty());
        // A name that is already live.
        assert!(mk("amber-1-1-0-aa", "shell").is_empty());
    }

    #[test]
    fn create_requires_an_existing_cwd() {
        let live: [SessionInfo; 0] = [];
        let out = map_browser_msg(
            &BrowserMsg::Create {
                name: "amber-1-1-0-aa".into(),
                cwd: "/definitely/not/a/real/dir".into(),
                kind: "shell".into(),
            },
            None,
            &live,
        );
        assert!(out.is_empty(), "a non-existent cwd must be refused: {out:?}");
    }

    #[test]
    fn kill_and_move_only_touch_live_sessions_and_valid_targets() {
        let live = [s("amber-1-1-0-aa", "shell")];
        assert!(matches!(
            map_browser_msg(&BrowserMsg::Kill { name: "amber-1-1-0-aa".into() }, None, &live).as_slice(),
            [ControlMsg::Kill { .. }]
        ));
        assert!(map_browser_msg(&BrowserMsg::Kill { name: "nope".into() }, None, &live).is_empty());

        assert!(matches!(
            map_browser_msg(
                &BrowserMsg::Move { from: "amber-1-1-0-aa".into(), to: "amber-2-1-0-aa".into() },
                None, &live
            ).as_slice(),
            [ControlMsg::Rename { .. }]
        ));
        // Target outside the grammar.
        assert!(map_browser_msg(
            &BrowserMsg::Move { from: "amber-1-1-0-aa".into(), to: "s9".into() }, None, &live
        ).is_empty());
        // Source not live.
        assert!(map_browser_msg(
            &BrowserMsg::Move { from: "ghost".into(), to: "amber-2-1-0-aa".into() }, None, &live
        ).is_empty());
    }

    #[test]
    fn suspend_and_resume_are_refused_for_non_agent_sessions() {
        let live = [s("amber-1-1-0-aa", "shell"), s("amber-1-1-1-bb", "claude"), s("amber-1-1-2-cc", "grok")];
        for kind_name in ["amber-1-1-1-bb", "amber-1-1-2-cc"] {
            assert_eq!(
                map_browser_msg(&BrowserMsg::Suspend { name: kind_name.into() }, None, &live).len(),
                1, "agent {kind_name} should suspend"
            );
            assert_eq!(
                map_browser_msg(&BrowserMsg::Resume { name: kind_name.into() }, None, &live).len(),
                1, "agent {kind_name} should resume"
            );
        }
        // A shell has no supervisor to signal — refuse before the daemon has to.
        assert!(map_browser_msg(&BrowserMsg::Suspend { name: "amber-1-1-0-aa".into() }, None, &live).is_empty());
        assert!(map_browser_msg(&BrowserMsg::Resume { name: "amber-1-1-0-aa".into() }, None, &live).is_empty());
    }

    #[test]
    fn resize_and_the_other_forbidden_controls_remain_unreachable() {
        // There is no BrowserMsg that parses to them, so no mapping exists.
        for text in [
            r#"{"t":"resize","name":"amber-1-1-0-aa","cols":40,"rows":20}"#,
            r#"{"t":"snapshot"}"#,
            r#"{"t":"dumpbacklog","name":"amber-1-1-0-aa"}"#,
            r#"{"t":"reportrunstate","name":"amber-1-1-0-aa","state":"claude"}"#,
        ] {
            assert!(parse_browser_msg(text).is_none(), "{text} parsed");
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p amber --lib web
```

Expected: FAIL to compile — no `BrowserMsg::Create` variant, `map_browser_msg` takes `&[String]`.

- [ ] **Step 3: Write minimal implementation**

Replace `BrowserMsg`, `parse_browser_msg` and `map_browser_msg` in `crates/amber/src/web.rs`:

```rust
pub enum BrowserMsg {
    Open { name: String },
    Close { name: String },
    Create { name: String, cwd: String, kind: String },
    Kill { name: String },
    Move { from: String, to: String },
    Suspend { name: String },
    Resume { name: String },
}

/// Parse a browser control (JSON text) frame. `None` for malformed JSON, an
/// unknown `t`, or a missing/!string field — the caller ignores it.
pub fn parse_browser_msg(text: &str) -> Option<BrowserMsg> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let f = |k: &str| v.get(k)?.as_str().map(str::to_string);
    match v.get("t")?.as_str()? {
        "open" => Some(BrowserMsg::Open { name: f("name")? }),
        "close" => Some(BrowserMsg::Close { name: f("name")? }),
        "create" => Some(BrowserMsg::Create {
            name: f("name")?,
            cwd: f("cwd")?,
            kind: f("kind")?,
        }),
        "kill" => Some(BrowserMsg::Kill { name: f("name")? }),
        "move" => Some(BrowserMsg::Move { from: f("from")?, to: f("to")? }),
        "suspend" => Some(BrowserMsg::Suspend { name: f("name")? }),
        "resume" => Some(BrowserMsg::Resume { name: f("name")? }),
        // Anything else — including a hand-crafted `resize`/`snapshot` — has no
        // representation here, so it can never reach the daemon.
        _ => None,
    }
}

/// Valid `Create` kinds. A pty runs a shell or `amber run <name> [--kind grok]`
/// and nothing else — `Create` carries no argv, so this is the entire surface.
const CREATE_KINDS: [&str; 3] = ["shell", "claude", "grok"];

/// The ONLY mapping from a browser message to daemon control messages.
///
/// Every arm CONSTRUCTS its `ControlMsg` from validated parts; nothing from the
/// browser is passed through. By construction there is no path from any browser
/// input to **`Resize`**, `Snapshot`, `DumpBacklog` or `ReportRunState`.
pub fn map_browser_msg(
    msg: &BrowserMsg,
    open: Option<&str>,
    sessions: &[SessionInfo],
) -> Vec<ControlMsg> {
    let live = |n: &str| sessions.iter().any(|s| s.name == n);
    let is_agent = |n: &str| {
        sessions
            .iter()
            .any(|s| s.name == n && (s.kind == "claude" || s.kind == "grok"))
    };
    // Exhaustive match: adding a browser message forces a decision here, so a
    // forbidden control can never become reachable by accident.
    match msg {
        BrowserMsg::Open { name } => {
            if !live(name) {
                return Vec::new();
            }
            let mut out = Vec::new();
            if let Some(prev) = open {
                if prev != name {
                    out.push(ControlMsg::Detach { name: prev.to_string() });
                }
            }
            out.push(ControlMsg::Attach { name: name.clone(), raw_client: false });
            out
        }
        BrowserMsg::Close { name } => {
            if !live(name) {
                return Vec::new();
            }
            vec![ControlMsg::Detach { name: name.clone() }]
        }
        BrowserMsg::Create { name, cwd, kind } => {
            // Grammar first: a name outside it belongs to no workspace, and
            // `s<n>` would shadow the bare-`amber` CLI namespace.
            if mosaic::parse_pane_name(name).is_none()
                || live(name)
                || !CREATE_KINDS.contains(&kind.as_str())
                || !Path::new(cwd).is_dir()
            {
                return Vec::new();
            }
            vec![ControlMsg::Create { name: name.clone(), cwd: cwd.clone(), kind: kind.clone() }]
        }
        BrowserMsg::Kill { name } => {
            if !live(name) {
                return Vec::new();
            }
            vec![ControlMsg::Kill { name: name.clone() }]
        }
        BrowserMsg::Move { from, to } => {
            if !live(from) || mosaic::parse_pane_name(to).is_none() || live(to) {
                return Vec::new();
            }
            vec![ControlMsg::Rename { from: from.clone(), to: to.clone() }]
        }
        BrowserMsg::Suspend { name } => {
            if !is_agent(name) {
                return Vec::new();
            }
            vec![ControlMsg::Suspend { name: name.clone() }]
        }
        BrowserMsg::Resume { name } => {
            if !is_agent(name) {
                return Vec::new();
            }
            vec![ControlMsg::Resume { name: name.clone() }]
        }
    }
}
```

Update the one call site of `map_browser_msg` in the WebSocket loop to pass `&inner.sessions` instead of the name vector it builds today.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p amber --lib web
cargo test -p amber
cargo clippy -p amber --all-targets -- -D warnings
```

Expected: all PASS, clippy clean.

- [ ] **Step 5: Add the end-to-end whitelist test**

Append to `crates/amber/tests/web.rs`:

```rust
#[test]
fn a_forged_resize_from_the_browser_never_reaches_the_pty() {
    let f = fixture();
    let name = f.create_session();
    let cookie = f.login();
    assert!(
        wait_until(Duration::from_secs(10), || {
            f.get("/api/sessions", Some(&cookie)).2.contains(&name)
        }),
        "hub never saw the session"
    );
    let before: serde_json::Value =
        serde_json::from_str(&f.get("/api/sessions", Some(&cookie)).2).unwrap();
    let (cols, rows) = (
        before["sessions"][0]["cols"].as_u64().unwrap(),
        before["sessions"][0]["rows"].as_u64().unwrap(),
    );

    let stream = TcpStream::connect(f.addr).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let uri: tungstenite::http::Uri = format!("ws://{}/ws", f.addr).parse().unwrap();
    let req = tungstenite::ClientRequestBuilder::new(uri).with_header("Cookie", cookie.clone());
    let (mut ws, _) = tungstenite::client::client(req, stream).unwrap();
    ws.send(tungstenite::Message::Text(
        format!(r#"{{"t":"resize","name":"{name}","cols":40,"rows":10}}"#).into(),
    ))
    .unwrap();
    // Give the server more than a poll tick to act on it if it were going to.
    std::thread::sleep(Duration::from_secs(3));

    let after: serde_json::Value =
        serde_json::from_str(&f.get("/api/sessions", Some(&cookie)).2).unwrap();
    assert_eq!(after["sessions"][0]["cols"].as_u64().unwrap(), cols, "pty was resized");
    assert_eq!(after["sessions"][0]["rows"].as_u64().unwrap(), rows, "pty was resized");
    assert_eq!(after["sessions"][0]["alive"], true, "session died");
}

#[test]
fn create_and_kill_from_the_browser_reach_the_daemon() {
    let f = fixture();
    let existing = f.create_session();
    let cookie = f.login();
    assert!(
        wait_until(Duration::from_secs(10), || {
            f.get("/api/sessions", Some(&cookie)).2.contains(&existing)
        }),
        "hub never saw the session"
    );

    let stream = TcpStream::connect(f.addr).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let uri: tungstenite::http::Uri = format!("ws://{}/ws", f.addr).parse().unwrap();
    let req = tungstenite::ClientRequestBuilder::new(uri).with_header("Cookie", cookie.clone());
    let (mut ws, _) = tungstenite::client::client(req, stream).unwrap();

    let made = "amber-1-1-9-webmade";
    let cwd = f.dir.path().to_string_lossy().into_owned();
    ws.send(tungstenite::Message::Text(
        format!(r#"{{"t":"create","name":"{made}","cwd":"{cwd}","kind":"shell"}}"#).into(),
    ))
    .unwrap();
    assert!(
        wait_until(Duration::from_secs(15), || {
            f.get("/api/sessions", Some(&cookie)).2.contains(made)
        }),
        "browser Create never reached the daemon"
    );

    ws.send(tungstenite::Message::Text(
        format!(r#"{{"t":"kill","name":"{made}"}}"#).into(),
    ))
    .unwrap();
    assert!(
        wait_until(Duration::from_secs(15), || {
            let body = f.get("/api/sessions", Some(&cookie)).2;
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            v["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s["name"] != made || s["alive"] == false)
        }),
        "browser Kill never reached the daemon"
    );
}
```

```bash
cargo test -p amber --test web
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/amber/src/web.rs crates/amber/tests/web.rs
git commit -m "feat(web): widen the browser whitelist to create/kill/move/suspend/resume"
```

---

### Task 5: The mosaic view (front end)

Replace the flat session list with workspace pills → tab bar → split tree of tiles. Tapping a tile opens the existing full-screen terminal.

**Files:**
- Modify: `crates/amber/assets/app.js` (`renderList`, `row`, the `{t:'sessions'}` handler at line ~320, `main()`'s state block)
- Modify: `crates/amber/assets/index.html` (mosaic container inside `#view-list`)
- Modify: `crates/amber/assets/style.css`

**Interfaces:**
- Consumes: Task 3's payload — `{sessions: [{name, kind, cwd, run_state, alive, cols, rows, slot}], layout: {activeWorkspace, workspaces: [{ws, label, activeTab, tabs: [{tab, label, tree}]}]}}`.
- Produces: nothing consumed by later Rust tasks. Task 6 adds gesture handlers to the tiles this task renders.

The front end has no test harness (no bundler, no runner) — this is the repo's standing pattern, and it is exactly why Tasks 1–4 put the logic in Rust. Verification here is the live GUI.

- [ ] **Step 1: Add the mosaic container**

In `crates/amber/assets/index.html`, inside `#view-list` and above `#list`:

```html
      <div id="ws-bar" class="ws-bar" hidden></div>
      <div id="tab-bar" class="tab-bar" hidden></div>
      <div id="mosaic" class="mosaic" hidden></div>
```

`#list` stays — it is the fallback when `layout` is null (an older server, or a machine that has never run the desktop app).

- [ ] **Step 2: Track the layout and the selected ws/tab**

In `main()`'s state block in `app.js`, beside `var sessions = [];`:

```js
  var layout = null;      // server-rendered mosaic, or null (fall back to the flat list)
  var curWs = null;       // selected workspace id, null = follow the server's activeWorkspace
  var curTab = null;      // selected tab id within curWs
```

In the `{t:'sessions'}` handler (line ~320) and wherever the initial `/api/sessions` fetch lands, store both:

```js
    if (msg.t === 'sessions') {
      sessions = msg.sessions || [];
      layout = msg.layout || null;
      renderList();
      syncGeom();
    }
```

The initial fetch currently reads a bare array — update it to the object shape:

```js
      .then(function (r) { return r.json(); })
      .then(function (d) {
        sessions = (d && d.sessions) || [];
        layout = (d && d.layout) || null;
        renderList();
      });
```

- [ ] **Step 3: Render workspace pills, tab bar and the tree**

Replace `renderList()` in `app.js` with a dispatcher, keeping the old body as `renderFlatList()` for the null-layout fallback:

```js
  function renderList() {
    if (!layout || !layout.workspaces || !layout.workspaces.length) {
      wsBarEl.hidden = tabBarEl.hidden = mosaicEl.hidden = true;
      listEl.hidden = false;
      return renderFlatList();
    }
    listEl.hidden = true;
    wsBarEl.hidden = tabBarEl.hidden = mosaicEl.hidden = false;

    // Resolve the selection against what the server actually sent — the desktop
    // can close the ws/tab we were looking at at any moment.
    var wss = layout.workspaces;
    var ws = wss.filter(function (w) { return w.ws === curWs; })[0];
    if (!ws) ws = wss.filter(function (w) { return w.ws === layout.activeWorkspace; })[0] || wss[0];
    curWs = ws.ws;
    var tab = ws.tabs.filter(function (t) { return t.tab === curTab; })[0];
    if (!tab) tab = ws.tabs.filter(function (t) { return t.tab === ws.activeTab; })[0] || ws.tabs[0];
    curTab = tab.tab;

    renderWsBar(wss, ws);
    renderTabBar(ws, tab);
    mosaicEl.textContent = '';
    mosaicEl.appendChild(renderNode(tab.tree));
  }

  function pill(text, on, click) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill' + (on ? ' on' : '');
    b.textContent = text;
    b.addEventListener('click', click);
    return b;
  }

  function renderWsBar(wss, cur) {
    wsBarEl.textContent = '';
    wss.forEach(function (w) {
      wsBarEl.appendChild(pill(w.label || ('ws ' + w.ws), w.ws === cur.ws, function () {
        curWs = w.ws; curTab = null; renderList();
      }));
    });
  }

  function renderTabBar(ws, cur) {
    tabBarEl.textContent = '';
    ws.tabs.forEach(function (t) {
      tabBarEl.appendChild(pill(t.label || ('tab ' + t.tab), t.tab === cur.tab, function () {
        curTab = t.tab; renderList();
      }));
    });
  }

  // The tree the server sent, drawn as nested flexbox at its real ratios.
  function renderNode(n) {
    if (!n) return document.createElement('div');
    if (n.kind === 'leaf') return tile(n.paneId);
    var box = document.createElement('div');
    box.className = 'split ' + (n.dir === 'v' ? 'v' : 'h');
    var a = renderNode(n.a), b = renderNode(n.b);
    var r = Math.min(0.95, Math.max(0.05, n.ratio || 0.5));
    a.style.flex = r; b.style.flex = 1 - r;
    box.appendChild(a); box.appendChild(b);
    return box;
  }
```

- [ ] **Step 4: Render a tile**

Tiles carry **no terminal bytes** — an `Attach` per tile would replay up to 2 MiB each.

```js
  function sessionByName(name) {
    return sessions.filter(function (x) { return x.name === name; })[0] || null;
  }

  function tile(paneId) {
    var s = sessionByName(paneId);
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'tile' + (s && !s.alive ? ' dead' : '');
    el.dataset.pane = paneId;
    if (!s) { el.textContent = paneId; return el; }   // server/session race — next push fixes it

    var head = document.createElement('span');
    head.className = 'tile-head';
    var slot = document.createElement('span');
    slot.className = 'tile-slot';
    slot.textContent = s.slot ? '#' + s.slot : '';
    var dot = document.createElement('span');
    dot.className = 'dot k-' + (s.kind || 'shell');
    dot.title = s.kind || 'shell';
    head.appendChild(slot);
    head.appendChild(dot);

    var title = document.createElement('span');
    title.className = 'tile-title';
    title.textContent = shortCwd(s.cwd);

    var tag = document.createElement('span');
    tag.className = 'tile-tag';
    tag.textContent = !s.alive ? 'exited'
      : (s.run_state && s.run_state !== 'claude') ? s.run_state
      : (s.kind || 'shell');

    el.appendChild(head);
    el.appendChild(title);
    el.appendChild(tag);
    el.addEventListener('click', function () { openSession(paneId); });
    return el;
  }
```

Add the three element lookups beside the existing ones at the top of `main()`:

```js
  var wsBarEl = $('ws-bar'), tabBarEl = $('tab-bar'), mosaicEl = $('mosaic');
```

- [ ] **Step 5: Style it**

Append to `crates/amber/assets/style.css`:

```css
/* ---- mosaic ---- */
.ws-bar, .tab-bar { display: flex; gap: 6px; overflow-x: auto; padding: 6px 10px; }
.tab-bar { padding-top: 0; }
.pill {
  flex: 0 0 auto; padding: 5px 11px; border-radius: 999px;
  border: 1px solid #2a2a35; background: #16161d; color: #c8c8d2;
  font: inherit; font-size: 13px;
}
.pill.on { background: #7c6cff; border-color: #7c6cff; color: #fff; }

.mosaic { display: flex; flex: 1 1 auto; padding: 0 10px 10px; min-height: 0; }
.mosaic > * { flex: 1 1 auto; }
.split { display: flex; gap: 6px; min-width: 0; min-height: 0; }
.split.h { flex-direction: row; }
.split.v { flex-direction: column; }
.split > * { min-width: 0; min-height: 0; }

.tile {
  display: flex; flex-direction: column; gap: 4px; justify-content: space-between;
  padding: 8px; border-radius: 8px; text-align: left;
  border: 1px solid #2a2a35; background: #12121a; color: #e6e6ec;
  font: inherit; overflow: hidden;
}
.tile.dead { opacity: 0.5; }
.tile-head { display: flex; align-items: center; gap: 6px; }
.tile-slot { font-variant-numeric: tabular-nums; color: #9a9aa8; font-size: 12px; }
.tile-title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile-tag { font-size: 11px; color: #9a9aa8; }
```

- [ ] **Step 6: Verify live**

The mosaic cannot be unit-tested here. Use the project's `verify` skill against an **isolated private daemon** (never the user's) per the `verify-isolated-dev-instance` memory:

```bash
# in the worktree
cargo build -p amber
# private daemon + private state root with a real multi-ws sidecar
```

Confirm, in a browser at the printed URL:
1. workspace pills and tab bar appear and match the desktop's labels/order;
2. the split geometry matches the desktop screen (modulo pruned app-local panes);
3. an editor/browser pane on the desktop leaves **no** tile, and its sibling takes the space;
4. tapping a tile opens the full-screen terminal at the session's real grid and accepts input;
5. dragging a divider on the desktop updates the mosaic within ~1 s (this is §3.1);
6. a machine with no sidecar falls back to the flat list rather than a blank screen.

- [ ] **Step 7: Commit**

```bash
git add crates/amber/assets/
git commit -m "feat(web): render the workspace mosaic with tap-to-zoom"
```

---

### Task 6: Parity gestures (front end)

New pane, close pane, move pane, freeze/unfreeze an agent — plus the pending tile and the error toast.

**Files:**
- Modify: `crates/amber/assets/app.js`
- Modify: `crates/amber/assets/index.html`
- Modify: `crates/amber/assets/style.css`

**Interfaces:**
- Consumes: Task 4's browser messages (`create`/`kill`/`move`/`suspend`/`resume`) and Task 5's `tile()` / `renderList()`.
- Produces: nothing.

- [ ] **Step 1: Port the name minter**

`Create` needs a name in the pane grammar. Add beside `parseName` in `app.js` (which already parses it):

```js
  var idCounter = 0;
  function makeId() {
    idCounter = (idCounter + 1) % 0xffff;
    // Time + counter: unique within a page load, no crypto needed.
    return (Date.now().toString(36) + idCounter.toString(36)).replace(/[^a-z0-9]/g, '');
  }

  // Lowest ord not taken by a live session in this ws/tab.
  function freeOrd(ws, tab) {
    var used = {};
    sessions.forEach(function (s) {
      var p = parseName(s.name);
      if (p && p.ws === ws && p.tab === tab) used[p.ord] = true;
    });
    var n = 0;
    while (used[n]) n++;
    return n;
  }

  function paneName(ws, tab, ord, id) {
    return 'amber-' + ws + '-' + tab + '-' + ord + '-' + (id || makeId());
  }
```

- [ ] **Step 2: Send gestures**

There is already a `send`/`ws.send` helper for the `open`/`close` JSON. Add:

```js
  function control(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // The tree is NEVER edited locally (core rule #3) — the server's next push is
  // the only thing that adds or removes a pane. `pending` only draws a
  // placeholder so the tap feels answered.
  var pending = {};   // paneName -> expiry ms

  function newPane(kind, cwd) {
    var name = paneName(curWs, curTab, freeOrd(curWs, curTab));
    pending[name] = Date.now() + 3000;
    control({ t: 'create', name: name, cwd: cwd, kind: kind });
    renderList();
    setTimeout(function () { delete pending[name]; renderList(); }, 3000);
  }

  function killPane(name) { control({ t: 'kill', name: name }); }

  function movePane(name, ws, tab) {
    var p = parseName(name);
    if (!p) return;
    control({ t: 'move', from: name, to: paneName(ws, tab, freeOrd(ws, tab), p.id) });
  }

  function setFrozen(name, frozen) {
    control({ t: frozen ? 'suspend' : 'resume', name: name });
  }
```

- [ ] **Step 3: Draw pending tiles**

In `renderList()`, after `mosaicEl.appendChild(renderNode(tab.tree));`:

```js
    // Panes this client asked for that the server has not confirmed yet.
    Object.keys(pending).forEach(function (name) {
      var p = parseName(name);
      if (!p || p.ws !== curWs || p.tab !== curTab) return;
      if (sessionByName(name)) { delete pending[name]; return; }
      var ph = document.createElement('div');
      ph.className = 'tile pending';
      ph.textContent = 'starting…';
      mosaicEl.appendChild(ph);
    });
```

- [ ] **Step 4: Pane menu and toolbar**

Add a `+ pane` control to the tab bar and a long-press/⋯ menu per tile.

In `renderTabBar`, after the tab pills:

```js
    var add = pill('+ pane', false, function () {
      var kind = window.prompt('kind: shell, claude or grok', 'shell');
      if (!kind) return;
      var s = sessionByName(firstPaneOf(ws, cur)) || sessions[0];
      newPane(kind.trim(), (s && s.cwd) || '/');
    });
    add.classList.add('pill-add');
    tabBarEl.appendChild(add);
```

with

```js
  // cwd for a new pane: the tab's first pane, falling back to any session.
  function firstPaneOf(ws, tab) {
    var found = null;
    (function walk(n) {
      if (!n || found) return;
      if (n.kind === 'leaf') { found = n.paneId; return; }
      walk(n.a); walk(n.b);
    })(tab.tree);
    return found;
  }
```

In `tile()`, before the click handler, add the menu button:

```js
    var menu = document.createElement('span');
    menu.className = 'tile-menu';
    menu.textContent = '⋯';
    menu.addEventListener('click', function (e) {
      e.stopPropagation();          // don't open the terminal
      var agent = s.kind === 'claude' || s.kind === 'grok';
      var choices = ['close'];
      if (agent) choices.push(s.run_state === 'suspended' ? 'unfreeze' : 'freeze');
      choices.push('move to tab…');
      var pick = window.prompt(paneId + '\n' + choices.join(' / '), choices[0]);
      if (pick === 'close') killPane(paneId);
      else if (pick === 'freeze') setFrozen(paneId, true);
      else if (pick === 'unfreeze') setFrozen(paneId, false);
      else if (pick && pick.indexOf('move') === 0) {
        var t = window.prompt('move to tab number', String(curTab));
        if (t) movePane(paneId, curWs, parseInt(t, 10));
      }
    });
    head.appendChild(menu);
```

`window.prompt` is deliberate: it is native, zero-CSS, works on a phone, and this is a first cut. A styled sheet is a later, separate change.

- [ ] **Step 5: Surface daemon errors**

The `{t:'error'}` push already exists (`Hub::error_msg`). Confirm the handler shows it — if it only sets a connection banner, route it through `banner()`:

```js
      if (msg.t === 'error') { banner(msg.msg, 'warn'); setTimeout(function () { banner(''); }, 6000); }
```

Note in a comment that `Error` is broadcast to all clients (the daemon frame carries no correlation id), so with two phones open the other sees the toast too — accepted, out of scope.

- [ ] **Step 6: Style the additions**

```css
.tile.pending { opacity: 0.6; font-style: italic; align-items: center; justify-content: center; }
.tile-menu { margin-left: auto; padding: 0 4px; color: #9a9aa8; }
.pill-add { border-style: dashed; }
```

- [ ] **Step 7: Verify live**

Against the same isolated private daemon, with the desktop app running on it:

1. `+ pane` → shell appears in the browser **and** in the desktop app's tree, in the right tab;
2. the pending tile shows, then is replaced by the real one;
3. `⋯ → close` prunes the pane in both;
4. `⋯ → move to tab` moves it in both, and the pane keeps its child (`echo $$` before and after);
5. freeze a claude pane → its dot reads `suspended` in both; unfreeze → the **same** conversation resumes;
6. a rejected gesture (e.g. `+ pane` twice at once from two tabs) shows the daemon's real error text;
7. the desktop app and the browser attached at once: neither reflows the other.

- [ ] **Step 8: Commit**

```bash
git add crates/amber/assets/
git commit -m "feat(web): create/kill/move/freeze panes from the mosaic"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md` (build-status list)
- Modify: `docs/superpowers/specs/2026-07-31-remote-mosaic-web-design.md` (status header)

- [ ] **Step 1: Update the spec status header**

Change `**Status:** designed, not implemented.` to record the implemented state, any deviations found during the work, and what was live-verified vs. left manual.

- [ ] **Step 2: Add the CLAUDE.md build-status entry**

Append a `- [x] Remote mosaic (2026-07-31) — …` entry matching the file's existing style. It must record, per spec §10:

- `amber web` is no longer terminal-only — it renders the workspace/tab/split tree; the editor-pane spec's "the phone UI stays terminal-only" is narrowed to "renders no editor/browser panes";
- the browser whitelist now reaches `Create`/`Kill`/`Rename`/`Suspend`/`Resume` and **still** never reaches `Resize`;
- the prune rule is *"drop any leaf that is not a live daemon session"*, so a fourth app-local pane kind needs **zero** Rust change;
- a second reader of `ui-layout.json` now exists in Rust (`crates/amber/src/mosaic.rs`), read-only; a new `WsLayout`/`TabLayout` field the mosaic must display needs a matching Rust change;
- `web::serve` gained a `root` parameter;
- `GET /api/sessions` changed shape from a bare array to `{sessions, layout}`;
- **a running `amber web` must be restarted** to serve the mosaic.

- [ ] **Step 3: Run the full gate**

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cd app && npm run typecheck && npm test
```

The app suite must be untouched by this work — it is listed to prove that.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs: record the remote mosaic"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2.1 Rust-side parse | 1 |
| §2.2 types | 1 |
| §2.3 prune + collapse | 2 |
| §2.4 sessions not in the sidecar / non-pane names | 2 |
| §3 data flow, §3.1 change-detection trap, §3.2 response shape | 3 |
| §4.1 mosaic + tiles + `slot` | 3 (slot), 5 (tiles) |
| §4.2 tap-to-zoom | 5 |
| §5 never resize | 4 (whitelist), 6 (live check) |
| §6 parity table | 4 (transport), 6 (UI) |
| §6.1 shell freeze read-only | 4 (agent gate), 6 (menu only offers it for agents) |
| §6.2 name minting | 6 |
| §6.2.1 error channel | 6 |
| §6.2.2 pending tile | 6 |
| §6.3 cwd | 6 |
| §7.2 whitelist discipline, §7.3 validation | 4 |
| §8 tests | 1, 2, 3, 4 (Rust); 5, 6 (live) |
| §10 CLAUDE.md consequences | 7 |

**Type consistency:** `mosaic::load` → `LayoutFile` → `mosaic::render(&LayoutFile, &[SessionInfo]) -> serde_json::Value` is used identically in Tasks 2 and 3. `mosaic::parse_pane_name` is defined in Task 2 and consumed in Task 4. `map_browser_msg`'s third parameter changes from `&[String]` to `&[SessionInfo]` in Task 4 and its one call site is updated in the same task. The front-end payload keys (`sessions`, `layout`, `workspaces`, `ws`, `label`, `activeTab`, `tabs`, `tab`, `tree`, `kind`, `paneId`, `dir`, `ratio`, `a`, `b`, `slot`) are emitted in Tasks 2–3 and consumed with the same spelling in Tasks 5–6.

**Known gap, deliberate:** Task 5 and Task 6 have no automated tests. The front end has no runner, which is the repo's standing pattern and the stated reason Tasks 1–4 hold all the logic. Their verification is the live checklist, run against an isolated private daemon.
