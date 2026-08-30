# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Amber is for individual developers who keep several long-running shell and AI coding-agent sessions active at once. They use it while moving among projects, workspaces, machines, and interruptions, and need to return to ongoing work without rebuilding terminal state or recovering agent conversations by hand.

## Product Purpose

Amber is a persistent terminal workspace for macOS and Linux. It keeps panes, tabs, workspaces, scrollback, running processes, and supervised coding-agent conversations available through app crashes and machine reboots.

Success means a developer can close or lose the interface, restart the computer, or reconnect from another supported client and continue the same work with minimal recovery effort.

## Positioning

**Your sessions are not the app’s to lose.** Amber differs from terminal applications whose process and workspace state belongs to the window: a long-lived local daemon owns the sessions, while every interface is a disposable client that can reconnect to them.

## Operating Context

- Developers work across multiple repositories, shells, tabs, split panes, and concurrent coding-agent conversations.
- The primary desktop experience is an Electron application on macOS and Linux.
- The `amber` CLI can create, inspect, and attach to the same daemon-owned sessions from another terminal.
- Browser access can expose the live workspace over a user-controlled Tailscale connection without making the daemon itself a network service.
- Workspace structure and scrollback can be saved to and loaded from portable `.amberws` files.
- Coding-agent processes may be long-running and memory-intensive, so Amber supervises their lifecycle and can suspend and precisely resume supported conversations.

## Capabilities and Constraints

- A local Rust daemon is the single source of truth for terminal session existence, process supervision, working directory, and scrollback.
- Session persistence must survive both client crashes and machine reboots.
- Terminal data remains raw PTY bytes interpreted by one terminal emulator; Amber does not use tmux or a second emulation layer.
- Supported pane types include shells, supervised coding agents, browser panes, and file-editor panes.
- Supported supervised agents include Claude Code, OpenAI Codex, Grok, OpenCode, Hermes, and Pi.
- The product is local-first and requires no Amber cloud account. Remote browser access is user-controlled and tailnet-oriented.
- macOS and Linux are supported. Windows support is deferred.
- The project is open source under GPL-3.0.
- Floating panes, multiplexing within one daemon session, an SSH connection manager, and a separate AI chat interface are outside the current product scope.

## Brand Commitments

- The product name is **Amber**.
- Amber refers to fossilized resin preserving what it captures intact; the name expresses the product’s promise that working sessions remain preserved through disruption.
- The defining product statement is: **“Your sessions are not the app’s to lose.”**
- Product language should be direct, technically credible, and explicit about operational tradeoffs. It must not imply cloud services, security guarantees, platform support, or recovery guarantees beyond what the implementation provides.

## Evidence on Hand

- `README.md` contains the public product explanation, feature inventory, architecture summary, platform support, installation instructions, and licensing.
- `AGENTS.md` records the architecture constitution, implemented feature history, validation evidence, and remaining manual-verification work.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` contain implementation designs and acceptance criteria for the daemon, desktop application, browser experience, supported agents, persistence, and resource containment.
- Automated Rust and TypeScript test suites cover core protocol, persistence, supervision, layout, and client behavior.
- The repository does not currently provide customer testimonials, adoption metrics, independent benchmarks, press coverage, or other market proof; future product work must not fabricate them.

## Product Principles

1. **Preserve continuity by default.** A crash, reboot, client restart, or temporary disconnect should not make the user reconstruct their workspace.
2. **Keep authority beneath the interface.** The daemon owns durable terminal truth; clients render and control it without becoming authoritative copies.
3. **Resume precisely, never approximately.** Supervised coding agents should return to the recorded conversation rather than silently substituting a nearby or fresh session.
4. **Keep ownership local and inspectable.** Core operation must not depend on an Amber account or hosted control plane.
5. **Expose tradeoffs honestly.** Persistence, remote access, memory management, and process supervision should remain predictable and technically explicit.

## Accessibility & Inclusion

Amber is keyboard-first: primary workspace, pane, search, zoom, navigation, and help actions must remain operable without a pointer. Interactive controls should retain visible focus states, meaningful labels, and predictable native keyboard behavior. No specific formal accessibility conformance level is currently committed.
