# Amber Pocket interactive prototype

This code-led prototype validates the mobile product structure in
`docs/superpowers/specs/2026-08-29-amber-pocket-mobile-product-design.md`.
It does not connect to a daemon and is not production renderer code.

## Run

From the repository root:

```sh
python3 -m http.server 4173 --directory docs/prototypes/amber-pocket
```

Open `http://127.0.0.1:4173/`.

Useful routes:

- `/#sessions`
- `/#mosaic`
- `/#focus`

## Interactive paths

- Open any session row or mosaic pane.
- Switch between Sessions and Mosaic using the bottom navigation.
- Open New, Machines, Workspace, or session action sheets.
- Arm Ctrl and press another terminal key.
- Send a quick text macro.
- Type while the terminal has focus.
- Open the software keyboard on a phone: the shell binds to `visualViewport`,
  the key deck stays above the keyboard, and optional quick macros collapse to
  preserve terminal height.

## Review captures

Validated captures are in `screenshots/` for the command center, focus terminal,
keyboard-open focus, mosaic, action sheet, and desktop presentation. In
`mobile-keyboard.png`, the black lower region is the simulated 336px software
keyboard occlusion; the terminal and critical key row end at the visual viewport
boundary above it. Each PNG carries a provenance text chunk naming its local
Chrome capture route and viewport.

## Scope

The prototype tests information architecture, hierarchy, density, touch target
sizes, sheets, terminal focus, and adaptive key controls. Bottom-navigation
icons use Phosphor Icons regular paths under the MIT license. Production transport,
PTY resizing, grid borrowing, session mutation, and persistence remain in the
existing Amber implementation and are deliberately not simulated here.
