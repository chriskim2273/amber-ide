# amber-ide collaborative panes + SaaS auth — design

**Date:** 2026-07-14
**Status:** proposed design, pre-implementation
**Depends on:**
- amber session daemon (`docs/superpowers/specs/2026-07-12-amber-session-daemon-design.md`, shipped) — multi-client fan-out, subscriber registry, `Attach`/`Detach`/`Input`/`Resize`, raw-byte `Data` frames.
- amber-ide Electron app (`docs/superpowers/specs/2026-07-13-amber-ide-app-design.md`, shipped) — disposable client, one multiplexed utilityProcess, xterm+webgl panes.

Read the project constitution (`CLAUDE.md`) first. This spec obeys it. It adds a **collaboration surface** (a friend views/drives one of your panes 1‑1 over the network) and the **SaaS account + auth system** that gates it. It refines *how* the existing rules extend to remote clients; it never contradicts them.

---

## 0. DECISION — local-first (RESOLVED 2026-07-14)

**Is login required to open the app, or does the app run fully local-first with accounts gating only the cloud/collab surface?**

**RESOLVED: local-first.** The app runs fully offline; accounts/login gate the collab/cloud surface only. This honors constitution **core rule #1** ("daemon = single source of truth, app holds zero authoritative state" — implying offline-capable local operation) with no amendment. The login-required alternative is rejected.

This is now a binding constraint on the whole spec, not an open question. Rationale retained below.

- **Local-first (this spec's default):** the daemon + your panes work fully offline, forever. A cloud outage or an expired token disables *sharing only*; the local IDE is unaffected. Accounts/login gate: sharing, invites, discovery, teams, billing, cross-device.
- **Login-required (rejected here, possible on request):** the app refuses to open without a valid session. A control-plane outage bricks the local IDE. Only choose this if amber is repositioned as a cloud product.

Everything below assumes local-first. If the decision flips, §3/§4/§14 change materially.

---

## 1. Goal & scope

**Goal:** let a remote person view one of your panes 1‑1 ("like streaming"), and optionally drive it, over the public internet, behind SaaS accounts — without ever exposing the daemon to the network and without breaking local-first.

**In scope:** the three-plane split; device-key identity + account binding; PKCE desktop login; capability grants/tokens; the Fly relay + Noise E2E transport; the local **share-bridge**; daemon protocol additions (scoped `Attach`, control handoff); input arbitration; remote rendering; the end-to-end connection flow; revocation/audit; the collaboration UI/UX; billing/entitlement hooks.

**Out of scope:** running the daemon in the cloud (that is a different product — see §15); multiplexing inside a session; changing the local data path (raw bytes → xterm) at all; video/voice (a call is out-of-band).

---

## 2. Core invariant — the guest never touches the daemon

The single most important rule, from which the whole security model follows:

> **The remote guest connects to the relay. The relay bridges to a local `amber share` process on the owner's machine. That share-bridge is the daemon client.** The daemon stays unix-only and never sees the network, Noise, SaaS grants, or JWTs.

If any diagram or flow shows the guest doing `Attach` against the daemon directly, that is the tell that the model has been broken (it would require a network-reachable daemon, contradicting the constitution's "never bind the daemon socket to a network interface").

```
   OWNER MACHINE (local-first, offline-capable)              CLOUD                    GUEST MACHINE
 ┌───────────────────────────────────────────┐    ┌──────────────────────┐   ┌────────────────────────┐
 │ amber daemon    (unix socket, 0600)        │    │  control plane (API) │   │ amber-ide app OR browser│
 │   owns ptys, subscriber registry           │    │   users/devices/     │   │  xterm.js (guest view)  │
 │        ▲  Attach{name,identity,scope}      │    │   grants/billing      │   │        ▲                │
 │        │  Data / Input (scope-gated)       │    └──────────┬───────────┘   │        │ Noise E2E       │
 │ ┌──────┴───────────────┐                   │      grant/JWT │ authz        │        ▼                │
 │ │ amber share (BRIDGE) │◄────Noise E2E─────┼──────►  Fly relay  ◄──────────┼──── wss:// (outbound)   │
 │ │  daemon client       │   (ciphertext)    │      (dumb byte pump,         │                        │
 │ │  enforces token+scope│                   │       authorizes routing)     │                        │
 │ └──────────────────────┘                   │            ▲                  │                        │
 │   owner dials OUT ─────────────────────────┼────────────┘ (NAT-friendly)   │                        │
 └───────────────────────────────────────────┘                               └────────────────────────┘
```

**Three trust boundaries, three jobs:**
- **Daemon** — authorizes by OS filesystem perms (unix socket `0600`); enforces per-subscription **scope** it was told. Trusts its local clients.
- **Relay (Fly)** — authorizes *routing/billing* (is this JWT+grant allowed in this room?). It is a **dumb byte pump** for content; it can see plaintext unless E2E is applied, so it is **never** the content authenticator.
- **Share-bridge + Noise** — authenticates *content*: proves owner↔guest device identity, encrypts end-to-end so the relay pipes ciphertext it can neither read nor forge.

---

## 3. Three planes

| Plane | Where | Auth | Constitution impact |
|---|---|---|---|
| **Data** | owner-local: daemon ↔ share-bridge, raw bytes | unix socket perms | **unchanged** — core rules #1/#4 intact |
| **Identity / E2E** | device keypairs, Noise handshake, owner↔guest | ed25519 device keys | additive |
| **Control (SaaS)** | cloud: accounts, devices, grants, invites, billing | OAuth/OIDC + JWT | additive, gates collab only |

Local pane operation flows entirely in the **data plane** and requires zero accounts. The other two planes light up only when you share.

---

## 4. Identity & accounts

### 4.1 Device keypair (no account needed)
On first run each amber install generates an **ed25519 device keypair**, stored `0600` in the config dir. This is the machine's cryptographic identity — the SSH model: your key *is* you. E2E crypto (Noise, §6) keys off this and exists independently of accounts.

### 4.2 Desktop login — OAuth 2.0 + PKCE
Electron is a **public client**: it cannot ship a client secret. So:
- App opens the **system browser** → user authenticates at the provider → redirect to a **loopback** (`http://127.0.0.1:<ephemeral>`) or custom scheme (`amber://auth/callback`) → exchange the code (with PKCE verifier) for tokens.
- **Refresh token** → OS keychain via Electron `safeStorage` (never plaintext on disk). **Access token (JWT, short-lived)** → memory only.
- The JWT identifies the user to the control-plane API and, transitively, to the relay.

### 4.3 Device ⇄ account binding
On login the app **registers the device pubkey** to the account (`POST /devices`, authorized by the JWT). The control plane now maps `device → user`, enabling **invite-by-@user** (§5.2) while keeping E2E rooted in device keys the server never holds the private half of.

### 4.4 What the server never gets
The control plane stores **public** device keys, user profiles, grants, and billing state. It **never** receives device private keys, and (with §6 E2E) never sees terminal content. Compromise of the control plane leaks metadata (who shared what, when) — not session content and not the ability to forge a writable session.

---

## 5. Grants & capability tokens

### 5.1 Token shape
A grant is a signed statement scoping one share:

```jsonc
{
  "session":  "amber-<ws>-<tab>-<ord>-<id>",  // the pane being shared
  "scope":    "view" | "write",
  "audience": "open" | "<guest-device-pubkey>",
  "exp":      <unix-seconds>,                  // short TTL; see §5.3
  "room":     "<opaque relay room id>",
  "iss":      "<owner-device-pubkey | control-plane>"  // signer, see §5.4
}
```

### 5.2 Two flavors, chosen by scope

| Flavor | `audience` | Delivery | Use |
|---|---|---|---|
| **Bearer** | `open` | share link containing the token | quick **view-only**; anyone with the link, until `exp`. Zero-friction, no guest signup for browser view. |
| **Bound** | specific guest device pubkey | invite-by-@user (control plane resolves the account → its registered device pubkey(s)) | **writable**; the guest must prove they hold the matching private key in the Noise handshake. A stolen token alone is useless. |

**Hard rule:** `write` ⇒ **bound** token + short TTL + E2E required. A writable pane is a shell on the owner's box (§11).

### 5.3 TTL
- `view`: minutes to a couple hours (product choice); re-mint to extend.
- `write`: minutes. Re-issued on control handoff. Never long-lived.

### 5.4 Signer — trust-root decision
- **Owner-device-signed:** the control plane cannot forge access (strongest; backend is not a trust root for content). More client work.
- **Control-plane-signed:** standard SaaS; backend is the trust root. Simpler.
- **This spec:** **control plane signs the *room ticket* (routing + billing entitlement); the owner device drives the Noise handshake for *content* trust.** Two jobs, two mechanisms — the relay authorizes routing, device keys authenticate content. This preserves relay-can't-forge for the bytes even with a backend-signed routing ticket.

---

## 6. Transport & E2E (the layer auth rides on)

Carried forward from the prior design turns; auth sits on top of this substrate.

- **Relay = Fly Machine** running a dumb WebSocket byte-pump (parses nothing beyond the room ticket). 256 MB is ample — terminal streams are KB/s. `auto_stop_machines`/`auto_start_machines` → sleeps when idle, wakes on the owner's outbound dial.
- **NAT traversal:** the owner's share-bridge **dials outbound** to Fly (NAT-friendly, no inbound port at home); the guest connects inbound to Fly's anycast IP. Neither needs a public IP.
- **TLS:** Fly-proxy terminates certs → guest gets `wss://<app>.fly.dev` free. **Caveat:** TLS terminates at the edge, so Fly sees plaintext *unless* E2E is layered on top. That is exactly why Noise is not optional for `write`.
- **E2E:** a **Noise handshake** (e.g. `Noise_IK`) between owner share-bridge ↔ guest, keyed off device keys, run *inside* the relayed stream. Gives E2E encryption + mutual device-identity proof + relay-can't-forge in one step. Frames (§ daemon `Data`/`Input`) ride the Noise-encrypted channel.

Alternative substrates (unchanged from prior analysis, not the default): Tailscale/WireGuard + SSH tunnel (trusted friends, today, zero relay); WebRTC DataChannel (P2P, bytes skip your server — the eventual scale answer). Fly relay is the default for zero-install browser guests + simple ops.

---

## 7. Daemon protocol additions

Grounded in the existing `ControlMsg` enum (`crates/amber-core/src/proto.rs`). The precedent for backward-compatible extension is already in the codebase: `Attach.raw_client` uses `#[serde(default)]` so older clients that omit the field still decode. **Reuse that exact pattern** — new fields default such that the local Electron app and `amber attach` are unaffected.

### 7.1 Scoped Attach (daemon-enforced scope)
Extend `Attach` so the share-bridge tags the subscription with who the guest is and what they may do. The **daemon records identity+scope on the subscription and enforces it** — one authz path for local and remote (the constitution principle: authorize per-subscription, not per-transport). This is defense-in-depth even though the bridge is local-trusted and also filters.

```rust
Attach {
    name: String,
    #[serde(default)] raw_client: bool,
    // NEW — all #[serde(default)], wire-compatible with existing clients:
    #[serde(default)] identity: Option<String>,  // guest device pubkey; None = local owner
    #[serde(default)] scope: Scope,               // default = Write (local owner behavior unchanged)
}

#[derive(Default)] enum Scope { #[default] Write, View }
```

Enforcement in the daemon subscriber registry:
- `View` subscriptions: `Data` fans out to them as normal; inbound `Input`, `Resize`, `Kill`, `Rename` from that subscription are **rejected** (dropped + `Error`), never reach the pty.
- `Write` subscriptions: unchanged behavior.
- The local owner's own subscription is tagged `identity: None, scope: Write` — same enforcement code path, no special-case.

**Why daemon-enforced, not bridge-only:** the constitution principle is "one authz path." Bridge-only enforcement would create two divergent paths (bridge for remote, daemon-implicit for local) and make the daemon assume "attached = trusted," which is the assumption we must not bake in before remote clients exist.

### 7.2 Control handoff (soft-lock, for writable multi-party)
Two writers on one pty interleave bytes → garbage. Add a cooperative single-writer token:

```rust
RequestControl { name: String },   // subscription asks to become the writer
ReleaseControl { name: String },   // writer yields
ControlGranted { name: String, holder: Option<String> },  // daemon -> all subs: who holds the pen
```

The daemon tracks the current writer per session; `Input` from a non-holder `Write` subscription is dropped. Default holder = the owner. `View` subscriptions can never request control (scope gate first). See §8.

### 7.3 What does NOT change
`Data` framing, the raw-byte path, `Snapshot`, `WatchSessions`/`Sessions`/`SessionsChanged`, geometry sidecar — untouched. The share-bridge is just another local subscriber to the fan-out that already exists.

---

## 8. Input arbitration

- **Default: view-only.** Sharing opens a `View` grant. The guest watches; the daemon rejects their input. This is the safe, high-value, low-risk 80%.
- **Writable: soft-lock, one writer at a time.** With a `write` grant, control is a **token** (§7.2). Owner holds it by default; either party `RequestControl`, the other is notified and can `ReleaseControl` (or an auto-yield-on-idle policy). Non-holder keystrokes are dropped, not interleaved.
- **Never free-for-all by default.** Byte-interleaving two live typers corrupts TUIs; only offer it as an explicit "both type (chaotic)" toggle for pair sessions where the two are on a call.

---

## 9. Rendering — owner owns geometry, guests own pixels

The daemon streams raw bytes; rendering is 100% client-side (constitution core rule #5). Therefore:

- **Free to differ per guest** (client-owned xterm state): theme/colors, font + size, cursor style, renderer backend (WebGL vs DOM fallback), **scrollback position** (a guest can scroll history while the owner stays pinned), selection/search. Genuinely "two different renderings" of one session, for free.
- **Forced to match: columns/rows.** The pty has one size; output is wrapped to the owner's `cols`. A narrower guest double-wraps → garbage; wider → dead right margin. So **the owner's `Resize` is authoritative and shared; the daemon ignores guest `Resize`** (already dropped by the `View` scope gate; for `write` guests, geometry still stays owner-owned). The guest xterm is fixed to the owner's rows×cols and **letterboxes in CSS** (scale-to-fit / center / pad) → the guest sees the owner's exact grid, styled to guest taste. This is the "1‑1 streaming" feel.
- **Late-join repaint:** a guest attaching mid-session must not start blank. **Reuse the raw-attach backlog + repaint-nudge** built in the gap-fix pass (spec §5): the share-bridge attaches, the daemon replays capped scrollback + nudges a repaint at the current size, and the guest's fixed-size xterm paints correctly from frame one. (Set `raw_client` appropriately so alt-screen replay is handled per that spec.)

---

## 10. Connection flow — end to end

### 10.1 Happy path (view-only browser guest)
1. **Owner gesture** — clicks *Share* on pane P (§12). App is logged in (JWT in memory).
2. **Grant request** — app → control plane: `POST /shares { session: P, scope: "view", audience: "open" }`. Control plane checks **entitlement** (§13), allocates a `room`, returns a signed **room ticket** + a **share link** embedding a bearer token.
3. **Bridge up** — app spawns `amber share --session P --room <room> --scope view`. The share-bridge **dials outbound** to the Fly relay for `room` (wakes the Machine if asleep), presents the room ticket.
4. **Invite delivery** — owner sends the link (copy, or the app pushes it to an @user). No guest signup needed for bearer view.
5. **Guest connects** — opens the link → browser (or app) connects `wss://<app>.fly.dev/room/<room>`, presents the bearer token → relay validates ticket/token with the control plane, **bridges** guest ↔ owner streams.
6. **Noise handshake** — guest ↔ share-bridge complete `Noise_IK` inside the relayed stream. Now E2E: relay pipes ciphertext.
7. **Scoped attach** — the **share-bridge** (not the guest) sends the daemon `Attach { name: P, identity: <guest-pubkey>, scope: View }`. Daemon records the scoped subscription, replays backlog + repaint-nudge (§9).
8. **Live** — daemon `Data` → bridge → (Noise) → relay → guest xterm renders P 1‑1. Owner sees the **guest-attached banner** + guest appears in the **active-guests panel** (§12).

### 10.2 Writable path deltas
- Step 2: `scope: "write"`, `audience: <guest-device-pubkey>` (bound). Requires the guest to be an @user with a registered device (invite-by-user, not a bare link) and a paid entitlement (§13).
- Step 6: Noise proves the guest holds the bound audience key; mismatch → refused.
- Step 7: `scope: Write`. Owner holds the control token by default; guest must `RequestControl` (§8).

### 10.3 Non-happy paths
- **Token expiry mid-session:** relay/bridge detect `exp` passed → tear the room down → guest sees "share expired"; owner may re-share. Owner's local pane is unaffected.
- **Owner revokes:** owner clicks *Stop sharing* / kicks a guest → app → control plane revokes the grant + the share-bridge sends `Detach` for that subscription (daemon drops it instantly, reusing the existing subscription-release path). Guest disconnected within one round-trip.
- **Owner offline / control-plane outage:** sharing is **disabled** (no new grants, existing rooms drop). **The local IDE keeps working fully** — this is the local-first guarantee (§0).
- **Relay unreachable:** share-bridge retries outbound with backoff; owner UI shows "reconnecting share"; local pane unaffected.
- **Guest network drop / late join:** guest reconnects to the room (grant still valid) → §9 repaint brings them current.
- **Multiple guests:** free from the daemon's existing subscriber fan-out — the bridge opens one scoped subscription per guest (or fans out itself); each guest is independent (own scrollback/theme). Concurrency capped by entitlement (§13).

---

## 11. Security summary (highest-stakes section)

- **Never bind the daemon socket to the network.** Unix-only, `0600`. Remote always traverses relay → share-bridge → daemon (§2).
- **View-only everywhere by default.** The daemon enforces `View` scope; a view guest's `Input`/`Kill`/`Resize`/`Rename` never reach the pty.
- **Writable = remote code execution on the owner's box.** Therefore writable requires **all** of: bound token (audience = guest device key), short TTL, E2E (Noise). A bearer link to a writable pane is a leaked-link-equals-RCE bug — **forbidden by construction** (bearer ⇒ view only).
- **Relay authorizes routing; device-key Noise authenticates content.** The relay (and Fly) can see plaintext without E2E — that is why Noise is mandatory for writable and strongly recommended for all shares.
- **Server holds only public keys + metadata.** Control-plane compromise ⇒ metadata leak, not content, not forged writable access.
- **Revocation is immediate** (§10.3) and **every attach is audited**: owner banner + a persisted access log (who, scope, when, from where).
- **PKCE public client, refresh token in OS keychain, JWT in memory only** (§4.2).

---

## 12. UI / UX — actually using it

Design principle: sharing is a **peripheral, reversible, always-visible** state — never a mode you can forget you're in. The owner must always see, at a glance, *that* a pane is shared, *who* is watching, and *whether* anyone can type.

### 12.1 Owner: the Share sheet (per pane)
Triggered from a pane's header affordance (a small `⤴ Share` button) or command palette. It is a popover anchored to the pane.

```
┌─ Share “claude · api-refactor” ──────────────────────────┐
│                                                          │
│  Access     ( • ) View only        ( ) Can type          │  ← Can type disabled unless
│                                       ⚠ gives a shell     │     signed in + entitled;
│                                                          │     shows the RCE warning
│  Invite     [ @friend____________ ]  [ Invite ]          │  ← @user → bound grant
│             ── or ──                                     │
│             [ 🔗 Copy view link ]   expires in [1h ▾]    │  ← bearer, view-only only
│                                                          │
│  Sharing as  ● you@acme.com                              │
│  ────────────────────────────────────────────────────── │
│  Watching now                                            │
│   ○ (nobody yet — send an invite)                        │
│                                                          │
│                              [ Stop all ]   [ Done ]     │
└──────────────────────────────────────────────────────────┘
```

Rules baked into the sheet:
- **"Can type" is guarded:** disabled unless logged in *and* entitled; selecting it reveals an inline warning ("This lets @friend run commands on your machine") and forces the invite path (no link option — bearer can never be writable).
- **The link row is view-only, always**, with a required expiry selector.
- Not-logged-in state replaces the sheet body with a single **"Sign in to share"** button (local-first: the pane still works; only sharing needs auth).

### 12.2 Owner: in-session ambient indicators
While a pane is shared, its header carries a persistent, non-modal badge:

```
┌ claude · api-refactor ───────────────  ● LIVE · 2 watching  ⤴ ┐
│  (terminal content, unchanged)                                │
```

- `● LIVE` pulses softly; hovering lists watchers. Clicking opens the **active-guests panel** (12.3).
- A shared **writable** pane additionally shows a **control-token badge**: `✎ you` (you hold the pen) or `✎ @friend` (guest is driving) — see 12.4.
- The badge is the constitution's existing reconnect-banner surface, extended — one place for pane-level status.

### 12.3 Owner: active-guests panel + kill switch
```
┌─ Watching “claude · api-refactor” ──────────────┐
│  ● you@acme.com          owner · holds control   │
│  ● maria@corp.dev        view      · 12m    [⨯]  │
│  ● sam (link guest)      view      · 3m     [⨯]  │
│                                                  │
│  [ Pause sharing ]              [ Stop all ⨯ ]   │
└──────────────────────────────────────────────────┘
```
- Each `[⨯]` revokes that guest instantly (§10.3). `Stop all` tears the room down.
- Link guests are labeled as such (weaker identity than @users).

### 12.4 Writable: control handoff UX
- Owner holds the pen by default; guest keystrokes are ignored until they **Request control** (a button in the guest UI). The owner gets a **toast**: "maria wants to type — [Give control] / [Keep]".
- While the guest drives, the owner's pane shows `✎ maria is typing`; the owner can **reclaim** with a single click/hotkey (immediate — the daemon flips the token, no negotiation).
- Optional auto-yield: pen returns to owner after N seconds of guest idle (config).
- **Guest cursor hint:** because the pty has one cursor, the guest cannot have a separate caret; instead the UI shows *who holds the pen* (the badge) rather than faking a second cursor. Honest to the single-pty reality.

### 12.5 Guest experience
- **Bearer link (browser):** opens to a clean full-viewport xterm rendering the owner's pane 1‑1 (letterboxed, §9), with a slim top bar: `👁 Viewing you@acme.com’s “claude · api-refactor” · view only`. The guest can scroll history, pick their own theme/font — but cannot type (input box shows a subtle "view only" lock). No signup wall for view.
- **@user invite (app):** a notification "Alice shared a pane" → opens the pane inside the guest's own amber-ide as a **read-only (or writable) remote pane**, visually tagged (a colored border + `remote · alice` label) so it is never confused with the guest's local panes.
- **Requesting control** (writable only): a `Request control` button in the top bar; state reflects grant/hold.
- **Connection state:** guest sees the same reconnect/expiry banners ("share expired", "reconnecting") — reusing the app's existing banner components.

### 12.6 Account/onboarding surface
- **Sign in** entry points: the Share sheet (contextual), plus a persistent account chip in the app's corner (avatar / "Sign in"). Local use never forces it.
- **PKCE flow** opens the system browser; on return the app shows the signed-in account chip. Refresh handled silently; a hard re-auth prompt only on refresh-token expiry.
- **Teams** (if orgs, §13): an org switcher in the account chip; invite-by-@user autocompletes org members first.

---

## 13. Billing & entitlements (the SaaS part)

- **Managed auth + orgs:** Clerk or WorkOS (best org/SSO/desktop-OAuth DX) *or* Supabase (Auth+Postgres+Realtime in one vendor — cheapest single-vendor path). Do **not** roll your own auth.
- **Control plane:** small Rust/Node API + Postgres on Fly — users, device registry, grants, orgs, audit log.
- **Billing:** Stripe. Entitlements checked at **share time** by the control plane and re-checked by the relay per room:
  - free: view-only shares, short TTL, 1 concurrent guest.
  - paid: **writable** sharing, teams/seats, more concurrent guests, longer TTL, longer session/audit retention.
- Stripe webhooks → entitlement flags in Postgres → API/relay enforce. A downgrade never touches local operation (local-first).

---

## 14. Build sequence (each step shippable)

1. **Foundation (pre-collab, do first):** device keypair on first run; **daemon subscription identity+scope tag** with the local owner tagged `scope: Write` — one enforcement path, offline-capable. No sharing yet. Unit-test the scope gate (view rejects `Input`/`Kill`/`Resize`).
2. **Accounts:** managed auth + Electron PKCE login; device-pubkey registration; account chip UI.
3. **Control plane:** users/devices/grants API; entitlement stub (all-allowed) so flow works before billing.
4. **Relay + view-only sharing:** Fly relay byte-pump; `amber share` bridge; Noise E2E; bearer view link; Share sheet + LIVE badge + active-guests panel + guest browser view. **This is the demoable milestone.**
5. **Writable:** bound tokens + `RequestControl`/`ReleaseControl` + control-handoff UX, behind a loud gate + entitlement.
6. **Billing + teams:** Stripe, orgs, invite-by-@user, audit retention.
7. **(Optional) WebRTC transport** for P2P/scale; **Tailscale+SSH** documented as the trusted-friends no-relay path.

---

## 15. Open questions & out of scope

**Open:**
- ~~§0 login-required vs local-first~~ — **RESOLVED 2026-07-14: local-first** (binding).
- §5.4 signer trust-root — spec picks control-plane-signs-routing + owner-device-Noise-for-content; confirm.
- Free-tier TTL/concurrency numbers — product/billing call.
- Guest presence richness (do we show guest scroll position to the owner? default no — guests own pixels).

**Out of scope (do not build without a new decision):**
- Running the daemon in the cloud / cloud dev environments — a different product that moves the ptys off the user's machine and rewrites persistence onto cloud volumes; contradicts local-first as written.
- Video/voice — a call is out-of-band.
- Multi-pane / whole-workspace sharing — this spec shares **one pane**; workspace sharing is a later composition of per-pane grants.
- In-session multiplexing, floating panes (constitution out-of-scope, unchanged).
