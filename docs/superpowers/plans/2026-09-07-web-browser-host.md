# Web Amber browser host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hosted `/app` uses the daemon machine’s resident Electron browser host instead of stubbing `BROWSER_HOST_UNAVAILABLE`, while Pi keeps the existing local broker.

**Architecture:** Add a UI role on `browser-host.sock`. `amber web` cookie-proxies commands/frames/events. Web `BrowserRail` paints host screenshots and maps input onto existing commands.

**Tech Stack:** TypeScript (Electron host + web shim + BrowserRail), Rust (`amber web` unix-socket client + HTTP), existing token/ensure helpers.

**Spec:** `docs/superpowers/specs/2026-09-07-web-browser-host-design.md`

## Global Constraints

- Chromium stays in Electron main; daemon protocol unchanged.
- Cookie-gated loopback only; `browser-host-token` never enters the browser.
- Pi `BrokerRequest` path stays byte-compatible.
- Control WS JSON only (binary is backlog).
- Windows fail-closed. Pocket/mobile and SSH remote windows out of scope.
- TDD: failing test first.

---

### Task 1: UI-role parser

**Files:**
- Modify: `app/src/main/tabBrowserBroker.ts`
- Test: `app/src/main/tabBrowserBroker.test.ts`

**Produces:** `parseUiHello`, `parseUiRequest`, `UiRequest` types.

- [ ] Failing tests for exact-key hello/requests and rejection of BrokerRequest smuggling
- [ ] Minimal parser
- [ ] Tests pass

### Task 2: Broker UI mode

**Files:**
- Modify: `app/src/main/tabBrowserBroker.ts`
- Test: `app/src/main/tabBrowserBroker.test.ts`

**Produces:** `TabBrowserBrokerServer` optional `handleUi`; sibling Pi connections still work.

- [ ] Failing integration test: token → `{role:ui}` → command hits UI handler, not Pi handler
- [ ] Implement UI mode after hello
- [ ] Tests pass

### Task 3: Renderer dispatch reuse

**Files:**
- Create: `app/src/main/browserUiDispatch.ts`
- Modify: `app/src/main/index.ts` to call it from IPC and from UI handler
- Test: `app/src/main/browserUiDispatch.test.ts`

**Produces:** `handleRendererBrowserCommand` used by local IPC and UI-role connections.

### Task 4: Remote show + frames

**Files:**
- Modify: `app/src/main/tabBrowserService.ts`, `app/src/main/browserAutomation.ts` as needed
- Test: host/unit tests for `presentation:'remote'` bounds rewrite and frame capture

### Task 5: Rust `browser_ops`

**Files:**
- Create: `crates/amber/src/browser_ops.rs`
- Modify: `crates/amber/src/lib.rs`, `crates/amber/src/browser_host_ctl.rs` (export socket path)
- Test: `crates/amber/src/browser_ops.rs` fake unix host

### Task 6: `amber web` routes + event fan-out

**Files:**
- Modify: `crates/amber/src/web.rs`
- Test: `crates/amber/tests/web.rs` cookie 401 and no-token-leak

### Task 7: Web shim

**Files:**
- Modify: `app/src/web/amber.ts`, `app/src/web/install.ts`
- Test: `app/src/web/amber.test.ts`

### Task 8: BrowserRail remote surface

**Files:**
- Modify: `app/src/renderer/BrowserRail.tsx`, `app/src/renderer/BrowserRail.css`
- Test: `app/src/renderer/BrowserRail.test.ts`

### Task 9: Live verify hosted `/app` against private host
