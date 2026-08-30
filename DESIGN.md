---
name: Amber
description: The preservation console for persistent terminal work.
colors:
  background: "#0c0c0f"
  surface: "#141419"
  surface-raised: "#1b1b22"
  surface-high: "#23232c"
  border: "#2a2a34"
  border-strong: "#3a3a48"
  text: "#e6e6ec"
  text-muted: "#9a9aa8"
  text-faint: "#64646f"
  primary: "#7c6cff"
  primary-filled: "#6553e6"
  primary-soft: "rgba(124, 108, 255, 0.16)"
  secondary: "#4d9fff"
  danger: "#ff5c5c"
  danger-soft: "rgba(255, 92, 92, 0.14)"
  warning: "#ffb454"
  success: "#52d273"
  suspended: "#4dd6c8"
  agent-grok: "#8ab4f8"
  agent-codex: "#3dd68c"
  agent-opencode: "#c084fc"
  agent-hermes: "#f472b6"
  drop-zone-fill: "rgba(80, 140, 255, 0.35)"
  drop-zone-border: "rgba(120, 170, 255, 0.9)"
typography:
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Roboto', sans-serif"
    fontSize: "14px"
    fontWeight: 600
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Roboto', sans-serif"
    fontSize: "13px"
    fontWeight: 400
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Roboto', sans-serif"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0.06em"
  mono:
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Menlo', 'Monaco', 'DejaVu Sans Mono', 'Consolas', monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.15
rounded:
  sm: "6px"
  md: "9px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
components:
  button-default:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "5px 10px"
  button-default-hover:
    backgroundColor: "{colors.surface-high}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "5px 10px"
  button-primary:
    backgroundColor: "{colors.primary-filled}"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "5px 10px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "5px 10px"
  input:
    backgroundColor: "{colors.surface-high}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "3px 6px"
  workspace-chip-active:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "13px"
    height: "26px"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "12px 16px 16px"
---

# Design System: Amber

## Overview

**Creative North Star: "The Preservation Console"**

Amber is a quiet technical instrument for work that must remain intact. Its near-black workspace recedes behind terminal content, while thin structural borders, compact controls, and precise state signals make many concurrent sessions legible without turning the interface into a spectacle.

The system is precise, resilient, focused, and deliberately low-light. It behaves like infrastructure rather than decoration: hierarchy comes from tonal layers, typography, focus, and operational color. It rejects flashy gamer-terminal styling, decorative glassmorphism, and attention-seeking gradients.

**Key Characteristics:**
- Dense, full-viewport workspace that gives terminal content priority.
- Near-black tonal layers separated by fine borders rather than large effects.
- Preservation Violet for interaction and focus; Signal Blue for secondary state.
- Compact system typography paired with machine-facing monospace.
- Strong color and elevation appear only when state or manipulation requires them.

## Colors

The palette is an obsidian-to-carbon neutral system with concentrated operational color.

### Primary
- **Preservation Violet** (`colors.primary`): the interaction and focus color for keyboard rings, active pane borders, selections, and the terminal cursor.
- **Filled Preservation Violet** (`colors.primary-filled`): the darker accessible fill for primary buttons and active workspace chips; white text exceeds 4.5:1 while the brighter focus violet remains distinct.
- **Preservation Violet Veil** (`colors.primary-soft`): a restrained wash behind selected, focused, or informational states; it supports the primary without competing with terminal content.

### Secondary
- **Signal Blue** (`colors.secondary`): secondary operational emphasis, shell/session identity, links within structured data, and parked or frozen state cues.
- **Suspended Cyan** (`colors.suspended`): a narrow semantic cue for resumable suspended work.
- **Drop Signal** (`colors.drop-zone-fill`, `colors.drop-zone-border`): a temporary high-visibility treatment used only while rearranging panes.

### Tertiary
- **Warning Amber** (`colors.warning`): warnings, selected agent states, dirty markers, and the amber brand mark. It is not a general-purpose surface color.
- **Success Green** (`colors.success`): healthy and successful outcomes.
- **Failure Red** (`colors.danger`, `colors.danger-soft`): destructive actions, disconnected states, failed checks, and exited sessions.
- **Agent Signals** (`colors.agent-grok`, `colors.agent-codex`, `colors.agent-opencode`, `colors.agent-hermes`): small identity dots that distinguish supervised agents at a glance. These hues remain semantic markers, not decorative palette expansion.

### Neutral
- **Obsidian** (`colors.background`): the application and terminal ground.
- **Carbon I–III** (`colors.surface`, `colors.surface-raised`, `colors.surface-high`): increasingly elevated chrome, fields, and hover states.
- **Structural Graphite** (`colors.border`, `colors.border-strong`): quiet default separation and stronger floating-surface edges.
- **Primary, Muted, and Faint Text** (`colors.text`, `colors.text-muted`, `colors.text-faint`): a three-step hierarchy for content, controls, metadata, and dormant state.

### Named Rules

**The Concentrated Accent Rule.** Preservation Violet is rare enough to mean active, focused, or actionable; never wash a large resting surface in it.

**The Operational Color Rule.** Amber, blue, green, red, cyan, and agent hues communicate state or identity. They are not interchangeable decoration.

## Typography

**Body Font:** system UI sans with native platform fallbacks.  
**Label Font:** system UI sans with native platform fallbacks.  
**Mono Font:** JetBrains Mono when installed, followed by native monospace fallbacks.

**Character:** Human controls, machine truth. Compact neutral sans-serif keeps application chrome fast to scan; monospace identifies terminal output, paths, session names, shortcuts, structured data, and state that came from the machine.

### Hierarchy
- **Title** (`typography.title`): small hierarchy peaks in dialogs, empty states, and prompts. Semibold is used sparingly.
- **Body** (`typography.body`): default application chrome and explanatory copy.
- **Label** (`typography.label`): compact navigation and control labels; contextual labels may use uppercase with tracked spacing.
- **Mono** (`typography.mono`): terminal content, paths, identifiers, memory values, key chords, code, and machine-facing metadata. Terminal rows use the tighter line-height defined by xterm.

### Named Rules

**The Human Controls, Machine Truth Rule.** Use sans-serif for actions and explanations; switch to monospace whenever the interface is showing what a process, path, protocol, or shortcut actually is.

**The Compact Hierarchy Rule.** Amber creates hierarchy inside a narrow 10–15px UI range through weight, color, spacing, and type family—not oversized display text.

## Layout

Amber occupies the full viewport and never allows the document itself to scroll. The desktop shell stacks a compact workspace toolbar, a tab strip, and a flexible split-pane stage. Panes use absolute geometry derived from the split tree so terminal instances remain outside ordinary React layout churn.

The spatial rhythm follows the four-step spacing scale, with the smallest step used inside dense controls and the largest step reserved for dialogs, overlays, and empty states. Desktop chrome is intentionally shallow: the toolbar, tab strip, and pane header remain subordinate to terminal content. Split handles use a broad invisible hit target around a one-pixel visible rule.

On coarse pointers at phone width, desktop chrome is replaced rather than compressed. Controls meet a 44px minimum target, navigation moves into a bottom drawer, context menus become bottom sheets, and the terminal key bar respects safe-area insets. This is an adaptive operating layout, not a separate visual identity.

**The Terminal Owns the Room Rule.** Chrome stays compact and peripheral; the pane body receives the overwhelming majority of every viewport.

**The No-Reflow Overlay Rule.** Search, freeze prompts, path actions, and transient controls overlay the pane instead of entering terminal layout and changing the PTY geometry.

## Elevation & Depth

Amber is tonally layered and structurally elevated. Resting surfaces use background steps and borders; shadows are reserved for floating context menus, dialogs, search controls, prompts, and explicit calls to action. Blur is limited to modal or frozen overlays where obscuring the inactive plane clarifies state.

### Shadow Vocabulary
- **Structural Low** (`0 1px 2px rgba(0, 0, 0, 0.4)`): subtle separation for a resting call-to-action or similarly light lift.
- **Floating High** (`0 4px 14px rgba(0, 0, 0, 0.5)`): menus, dialogs, search controls, and transient overlays.
- **Sheet Lift** (`0 -8px 32px rgba(0, 0, 0, 0.5)`): mobile bottom sheets rising above the workspace.

### Named Rules

**The Flat-at-Rest Rule.** Ordinary chrome is separated by tone and a one-pixel border. A shadow must explain that a surface is floating, temporary, or moving.

## Shapes

The form language is compact and gently technical. Standard controls and pane frames use the small radius; dialogs and empty-state containers use the medium radius. Pills are reserved for workspace selectors, compact badges, and state tags whose shape conveys a contained status.

Borders are one pixel and structural. Active panes add a second violet edge and a restrained outer halo without changing geometry. Circular forms appear only for status dots, the help trigger, and small indicators. Terminal and editor canvases remain rectilinear inside their frames.

**The Radius Has a Job Rule.** Use standard rounding for controls, medium rounding for floating containers, and full pills only for compact identity or state—not as a universal softness treatment.

## Components

### Buttons
- **Shape:** gently curved compact controls using the standard radius.
- **Primary:** Preservation Violet with white text; reserved for the clearest forward action in a local decision.
- **Default:** raised Carbon with muted text and a structural border; hover increases both surface and text contrast.
- **Ghost:** transparent at rest and tonal on hover; used for low-priority toolbar and cancellation actions.
- **Hover / Focus:** visual transitions complete quickly; keyboard focus uses the shared two-pixel violet ring and must never be removed.
- **Destructive:** red text and border, gaining a translucent red surface on hover. Destructive actions remain visually separate from benign action rows.

### Chips
- **Workspace chips:** compact pills; inactive chips resemble default controls, while the active chip becomes violet with a restrained halo.
- **State badges:** small, low-chroma containers with semantic text. Memory, frozen, zoomed, and process states remain readable without becoming primary actions.

### Cards / Containers
- **Pane frames:** the signature container. Obsidian content sits below a thin Carbon header; a fine graphite border defines each leaf of the split tree.
- **Focused pane:** Preservation Violet border plus a small halo. Focus is explicit because keyboard navigation and terminal input depend on it.
- **Empty state:** a small centered action card, not a dashboard-sized panel.

### Inputs / Fields
- **Style:** high Carbon field, primary text, one-pixel graphite border, and standard rounding.
- **Focus:** shift the border to Preservation Violet; overlays may add a restrained violet halo.
- **Technical values:** use monospace for paths, search counts, URLs, session identifiers, and code-facing input.

### Navigation
- **Desktop:** workspace pills occupy the toolbar; tabs form a separate dark strip with an active violet top rule and tonal active surface.
- **Activity:** small pulsing dots communicate background output without changing the tab label.
- **Mobile:** one breadcrumb bar opens a bottom drawer with full-width 48px rows, active tonal fill, and explicit checks.

### Dialogs and Menus
- **Dialogs:** medium-rounded Carbon containers with a stronger border and floating shadow; title and close action live in a separated header.
- **Menus:** compact raised lists with four-pixel internal padding; hover is tonal, and dangerous rows shift to red.
- **Sheets:** mobile menus and navigation dock to the bottom with rounded top corners and safe-area padding.

### Terminal Surface

The terminal is the visual center of Amber. It shares the Obsidian application ground, uses the mono stack, and carries a 1.15 line-height. Its ANSI palette mirrors Amber’s operational colors; the cursor, selection, and search match treatments use Preservation Violet. Terminal rendering must never be wrapped in decorative effects that reduce legibility or interfere with WebGL/canvas performance.

## Do's and Don'ts

### Do:
- **Do** keep the terminal or editor canvas visually dominant and the chrome compact.
- **Do** use tonal Carbon layers and one-pixel graphite borders before reaching for shadow.
- **Do** reserve Preservation Violet for focus, active state, selection, and primary action.
- **Do** preserve the three-level text hierarchy and use monospace for machine truth.
- **Do** maintain visible keyboard focus and 44px touch targets in the coarse-pointer mobile layout.
- **Do** communicate process and agent state with the established semantic dots and badges.

### Don't:
- **Don't** introduce gamer-neon spectacle, decorative glassmorphism, gradients, or ornamental glow.
- **Don't** use Warning Amber as a broad application accent; keep it tied to brand and operational meaning.
- **Don't** turn every container into a rounded card or every action into a pill.
- **Don't** add large headings that compete with live terminal content.
- **Don't** animate layout, terminal output, or controls continuously; motion should acknowledge state, hover, or activity.
- **Don't** allow transient pane controls to reflow the PTY or hide critical terminal content without an explicit modal state.
