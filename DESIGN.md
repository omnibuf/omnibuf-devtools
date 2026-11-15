---
name: 'OmniBuf DevTools'
description: 'Browser Developer Tools inspector for OmniBuf HTTP, ConnectRPC, gRPC-Web, and .obuf wire traffic'
colors:
  signal-orange: '#ff4f18'
  acid-lime: '#d4ff33'
  scalar-sky: '#93c5fd'
  string-emerald: '#86efac'
  container-amber: '#fcd34d'
  payload-mint: '#10b981'
  obsidian-canvas: '#0f1115'
  slate-surface: '#151921'
  instrument-chrome: '#1b202b'
  elevated-slate: '#222836'
  selected-slate: '#283348'
  subtle-rule: '#2a3140'
  strong-rule: '#424e66'
  frost-ink: '#f3f5f8'
  pewter-ink: '#bcc4d4'
  muted-slate-ink: '#939db0'
  carbon-ink: '#111111'
  drafting-paper: '#f4f0e6'
  warm-cream: '#faf8f2'
  stone-chrome: '#e5e0d5'
typography:
  headline:
    fontFamily: 'IBM Plex Sans, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '1rem'
    fontWeight: 700
    lineHeight: 1.35
  title:
    fontFamily: 'IBM Plex Sans, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '0.875rem'
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.01em'
  body:
    fontFamily: 'IBM Plex Sans, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '0.875rem'
    fontWeight: 500
    lineHeight: 1.45
  label:
    fontFamily: 'IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    fontSize: '0.75rem'
    fontWeight: 600
    lineHeight: 1.4
  mono-data:
    fontFamily: 'IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    fontSize: '0.78125rem'
    fontWeight: 400
    lineHeight: 1.45
rounded:
  xs: '3px'
  sm: '4px'
  md: '6px'
spacing:
  2xs: '4px'
  xs: '6px'
  sm: '8px'
  md: '12px'
  lg: '18px'
  xl: '24px'
components:
  button-signal:
    backgroundColor: '{colors.signal-orange}'
    textColor: '{colors.carbon-ink}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    padding: '6px 12px'
  button-tool:
    backgroundColor: '{colors.slate-surface}'
    textColor: '{colors.frost-ink}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    padding: '4px 10px'
    height: '30px'
  button-tool-hover:
    backgroundColor: '{colors.elevated-slate}'
    textColor: '{colors.frost-ink}'
  badge-schema:
    backgroundColor: '{colors.acid-lime}'
    textColor: '{colors.carbon-ink}'
    typography: '{typography.label}'
    rounded: '{rounded.xs}'
    padding: '3px 8px'
  chip-envelope-active:
    backgroundColor: '{colors.selected-slate}'
    textColor: '{colors.frost-ink}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    padding: '5px 10px'
  card-state:
    backgroundColor: '{colors.obsidian-canvas}'
    textColor: '{colors.frost-ink}'
    rounded: '{rounded.md}'
    padding: '18px'
  input-filter:
    backgroundColor: '{colors.obsidian-canvas}'
    textColor: '{colors.frost-ink}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    padding: '4px 9px'
    height: '30px'
---

# Design System: OmniBuf DevTools

## Overview

**Creative North Star: "The Packet Oscilloscope"**

OmniBuf DevTools translates the Swiss Engineering Brutalist identity of `omnibuf.com` into a high-density Operate-mode browser inspector. Engineers open this panel inside Chrome or Firefox Developer Tools to dissect binary HTTP bodies, ConnectRPC streams, and gRPC-Web envelopes in milliseconds. Every pixel serves wire legibility. Decorative marketing flourishes, glassmorphism, soft ambient shadows, and oversized hero whitespace are absent.

Tonal slate surfaces establish clear pane boundaries in dark mode, paired with a warm drafting-paper light mode that matches host DevTools preferences. High-voltage brand accents appear strictly as semantic signals: Signal Orange marks active selection and primary decode actions, while Acid Lime certifies inline `Field #0` (`SchemaMeta`) self-describing packets. Bidirectional cursor coupling binds the decoded field tree directly to raw hexadecimal and ASCII byte slices.

**Key Characteristics:**

- Dark-first workstation slate surfaces paired with a warm drafting-paper light theme synced to `chrome.devtools.panels.themeName`.
- Dual-voice IBM Plex typography: geometric sans chrome framing tabular monospace wire data.
- Semantic high-chroma accents reserved for selection state, `Field #0` schema presence, and tag/header/payload byte boundaries.
- Flat 1px structural hairlines with zero drop shadows across all panes and toolbars.
- Adaptive three-tier layout scaling from a 3-pane desktop workstation down to a Master-Detail mobile inspector with an 8-byte hex grid.

## Colors

High-contrast instrument neutrals carry 95% of the viewport so saturated wire-role markers read at a glance.

### Primary

- **Signal Orange** (`#ff4f18`): Marks the active traffic row border, active stream envelope border, selected field-tree outline, keyboard focus ring, tag-byte underline, and primary manual-decode CTA buttons. Always pair solid fills with Carbon Ink (`#111111`) text for a 6.2:1 contrast ratio.

### Secondary

- **Acid Lime** (`#d4ff33`): Reserved exclusively for `Field #0` (`SchemaMeta`) self-describing packet badges and schema key labels in dark mode. Solid Acid Lime badges use Carbon Ink (`#111111`) text at 16.4:1 contrast.

### Tertiary

- **Scalar Sky** (`#93c5fd`): Highlights numeric and boolean wire-type pills (`uint`, `sint`, `fixed32`, `float64`, `bool=1`) in dark mode, shifting to deep cobalt (`#1e40af`) in light mode.
- **String Emerald** (`#86efac`): Marks UTF-8 `string` wire-type pills and string literal previews in dark mode, shifting to forest emerald (`#065f46`) in light mode.
- **Container Amber** (`#fcd34d`): Identifies nested `submsg`, `array<T>`, and `map<K, V>` wire-type pills plus container byte-length headers.
- **Payload Mint** (`#10b981`): Underlines payload value bytes in the hex slice inspector to separate content bytes from tag and length-header bytes.

### Neutral

- **Obsidian Canvas** (`#0f1115`): Deepest dark-mode ground used behind hex dumps, JSON previews, filter inputs, and envelope strips.
- **Slate Surface** (`#151921`): Primary pane background for the traffic list, field tree, and detail inspector.
- **Instrument Chrome** (`#1b202b`): Header and toolbar surface separating controls from scrollable data viewports.
- **Elevated Slate** (`#222836`) and **Selected Slate** (`#283348`): Interactive hover and active row states.
- **Subtle Rule** (`#2a3140`) and **Strong Rule** (`#424e66`): Crisp 1px structural pane dividers and active tab borders.
- **Frost Ink** (`#f3f5f8`), **Pewter Ink** (`#bcc4d4`), and **Muted Slate Ink** (`#939db0`): Three-step dark-mode text hierarchy maintaining WCAG AA legibility across 12px monospace readouts.
- **Drafting Paper** (`#f4f0e6`), **Warm Cream** (`#faf8f2`), **Stone Chrome** (`#e5e0d5`), and **Carbon Ink** (`#111111`): Light-mode architectural paper surfaces and ink inherited from `omnibuf.com`.

### Named Rules

**The Dark-Ink Accent Rule.** Solid Signal Orange and Acid Lime fills always carry Carbon Ink (`#111111`) text, never white text. Light mode frames both colored fills with a `1px solid #111111` border and crisp `1px 1px 0 #111111` offset edge so bright fills never bleed into Stone Chrome.

**The Semantic Lime Rule.** Acid Lime appears only when an OmniBuf payload carries inline `Field #0` schema metadata; never spend it on generic success pills or decorative badges.

## Typography

**Body & UI Chrome Font:** IBM Plex Sans (500, 600, 700, bundled offline as WOFF2)
**Label & Wire Data Font:** IBM Plex Mono (400, 500, 600, bundled offline as WOFF2)

**Character:** IBM Plex Sans keeps toolbar labels and state cards crisp at compact panel heights, while IBM Plex Mono aligns hexadecimal offsets, field tags, wire-type chips, and scalar values on a rigid character grid.

### Hierarchy

- **Headline** (700, `1rem` / 16px, line-height 1.35): State card titles (`Inspect OmniBuf packets and RPC streams`, `Connect EndStreamResponse Metadata`).
- **Title** (700, `0.875rem` / 14px, line-height 1.4, `-0.01em` tracking): Topbar brand wordmark.
- **Body** (500, `0.875rem` / 14px, line-height 1.45): Empty-state and diagnostic prose, constrained to `600px` max card width (~62ch).
- **Mono Data** (400/600, `0.78125rem` / 12.5px, line-height 1.45): Field-tree rows, request paths, and JSON previews.
- **Label** (600, `0.75rem` / 12px, line-height 1.4, `tabular-nums`): Toolbar buttons, protocol pills, byte-offset columns, envelope chips, and hex cells.

### Named Rules

**The Tabular Byte Rule.** Every element displaying byte counts, HTTP status codes, field numbers (`#1`), or hexadecimal offsets applies `font-variant-numeric: tabular-nums` so vertical columns never jitter during selection changes.

**The Offline Font Rule.** Extension bundles ship local WOFF2 subsets inside `dist/fonts/` with zero external stylesheet or CDN requests.

## Layout

The panel fills `100dvh` inside a locked outer flex frame (`overflow: hidden`) so each pane scrolls independently behind persistent headers.

- **Wide Workstation (`>= 1180px`):** Three-column CSS grid (`minmax(240px, 288px) minmax(380px, 1fr) minmax(360px, 456px)`). Captured traffic anchors the left rail, the protocol toolbar and expandable field tree occupy the center stage, and the synchronized Hex / JSON / Headers pane docks on the right.
- **Medium Docked Split (`768px .. 1179px`):** Two-column grid (`248px minmax(0, 1fr)`) keeping the traffic rail on the left while stacking the field tree over a `260px` detail pane on the right.
- **Narrow & Side-Docked Master-Detail (`< 768px`):** Switches cleanly between a full-height `Traffic List` screen and a `Request Detail` screen with a `Traffic (N)` back button, a 4-way segmented view switcher (`Fields | Hex | JSON | Headers`), an anchored bottom byte-slice bar, and an 8-byte-per-row hex/ASCII dump below `520px`.

## Elevation & Depth

OmniBuf DevTools uses zero Gaussian blur. Depth comes from stepped surface luminance (`--bg-canvas` recessed behind `--bg-surface`, framed by `--bg-chrome` headers), crisp `1px solid` structural borders, and hard-edged `2px 2px 0` architectural offset steps on standalone state cards. Selected rows use an inset 1px Signal Orange ring (`box-shadow: inset 0 0 0 1px var(--signal-orange)`) so selection never shifts layout geometry. Interactive buttons, tabs, and SVG disclosure chevrons snap across states in `120ms` (`cubic-bezier(0.2, 0, 0, 1)`).

### Named Rules

**The Zero-Blur Rule.** Never apply drop shadows, glow filters, or translucent backdrop blurs inside the DevTools workstation; separate regions with 1px rules and stepped slate or stone fills.

## Shapes

Tight, utilitarian radii keep dense toolbars aligned with browser DevTools chrome:

- **Micro pills (`3px`):** Wire-type chips (`fixed32`, `submsg`), HTTP status pills (`200`), and field-tree row selection bounds.
- **Controls & tabs (`4px`):** Toolbar buttons, search inputs, protocol selector, envelope chips, and segmented tab groups.
- **State & drop cards (`6px`):** Standalone onboarding card, untagged response override gate, and drag-and-drop `.obuf` target.

## Components

Controls feel crisp, immediate, and mechanical, built for rapid mouse and keyboard traversal across hundreds of RPC frames.

### Buttons

- **Shape:** Tight `4px` corners (`30px` standard toolbar height).
- **Primary Signal (`btn-signal`):** Solid Signal Orange (`#ff4f18`) fill, Carbon Ink (`#111111`) bold 12px monospace label, `6px 12px` padding. Used once per state card for primary actions (`Open .obuf file`, `Decode as OmniBuf`).
- **Toolbar (`btn-tool`):** Slate Surface (`#151921`) fill, `1px solid` Subtle Rule (`#2a3140`), `4px 10px` padding. Shifts to Elevated Slate (`#222836`) with Strong Rule (`#424e66`) on hover.
- **Focus:** `2px solid` Signal Orange outline with `1px` offset on `:focus-visible`.

### Chips

- **Envelope Chip (`env-chip`):** Monospace tab button inside the horizontal stream strip (`#0 MSG gzip -> 375 B @+0x0000`, `#2 END metadata`). Active envelope applies Selected Slate (`#283348`) and a `1px solid` Signal Orange border.
- **Schema Badge (`meta-badge.is-schema`):** Solid Acid Lime (`#d4ff33`) fill with Carbon Ink (`#111111`) text (`Field #0 · PeerUpdate`).

### Cards / Containers

- **Corner Style:** `6px` radius.
- **Background:** Recessed Obsidian Canvas (`#0f1115`) in dark mode, Warm Cream (`#faf8f2`) in light mode.
- **Shadow Strategy:** Flat, zero shadow.
- **Border:** `1px solid` Subtle Rule (`#2a3140`), switching to error crimson (`#fca5a5`) on wire-decode failure cards.
- **Internal Padding:** `18px` with `12px` vertical stack gap.

### Inputs / Fields

- **Style:** `30px` height, recessed `--bg-canvas` background, `1px solid var(--border-subtle)`, `4px` radius, `12px` IBM Plex Mono input text.
- **Focus:** Parent `.search-box:focus-within` shifts border to Signal Orange (`#ff4f18`).

### Navigation

- **Segmented Scope Switcher (`seg-group`):** Switches between `OmniBuf` (auto-detected traffic) and `All HTTP` (manual override candidates) with live tabular count badges.
- **Detail & Mobile View Tabs (`detail-tab`):** Switches right-pane or mobile detail view across `Fields`, `Hex`, `JSON`, and `Headers` using Elevated Slate active fills and Strong Rule borders.

### Synchronized Field Tree & Byte-Slice Hex Grid

- **Field Tree Row (`tree-row`):** Indents nested containers by `18px` per depth level (`12px` on mobile), pairing field number (`#7`), field name (`location`), color-coded wire-type badge (`submsg`), truncated summary preview, and right-aligned `+0x0113 · 39 B` span metrics.
- **Hex & ASCII Slice Grid (`hex-grid`):** Paginates payloads in 4 KiB windows (`16` bytes/row on desktop, `8` bytes/row below `520px`). Tag bytes carry Signal Orange tint and underline (`--byte-tag-bg` / `--byte-tag-line`), container headers carry Amber (`--byte-hdr-bg` / `--byte-hdr-line`), and payload bytes carry Emerald Mint (`--byte-pay-bg` / `--byte-pay-line`). Clicking any byte resolves and expands the deepest owning field-tree node.

## Do's and Don'ts

### Do:

- **Do** pair Signal Orange (`#ff4f18`) and Acid Lime (`#d4ff33`) solid fills with Carbon Ink (`#111111`) text.
- **Do** keep desktop monospace labels and byte readouts at `12px` or larger with `tabular-nums` enabled.
- **Do** collapse narrow viewports (`< 768px`) into the Master-Detail screen switcher (`Traffic List` vs. `Request Detail`) and 8-byte hex rows (`< 520px`) so zero horizontal overflow occurs.
- **Do** honor `prefers-reduced-motion: reduce` by collapsing transition and scroll durations.

### Don't:

- **Don't** stack all three workstation panes vertically on narrow viewports.
- **Don't** load fonts, icons, or stylesheets over the network; every asset must ship inside `dist/`.
- **Don't** auto-decode untagged `application/proto` or `application/octet-stream` responses without explicit user confirmation via **Decode as OmniBuf** or the protocol selector.
- **Don't** introduce drop shadows, glassmorphism, or decorative gradients onto inspector surfaces.
