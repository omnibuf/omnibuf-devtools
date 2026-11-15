---
name: 'OmniBuf DevTools'
description: 'Browser Developer Tools inspector for OmniBuf HTTP, ConnectRPC, gRPC-Web, and .obuf wire traffic'
colors:
  signal-orange: '#ff4f18'
  scalar-sky: '#93c5fd'
  string-emerald: '#86efac'
  container-amber: '#f59e0b'
  payload-mint: '#10b981'
  obsidian-canvas: '#0f1115'
  slate-surface: '#141820'
  instrument-chrome: '#181d27'
  elevated-slate: '#202736'
  selected-slate: '#232d40'
  subtle-rule: '#262e3d'
  strong-rule: '#3c485e'
  frost-ink: '#eef1f6'
  pewter-ink: '#b4bece'
  muted-slate-ink: '#7f8a9e'
  carbon-ink: '#111111'
  drafting-paper: '#f5f2ea'
  warm-cream: '#faf8f3'
  stone-chrome: '#ede9df'
typography:
  headline:
    fontFamily: 'IBM Plex Sans, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '0.9375rem'
    fontWeight: 600
    lineHeight: 1.35
  title:
    fontFamily: 'IBM Plex Sans, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '0.8125rem'
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-0.01em'
  body:
    fontFamily: 'IBM Plex Sans, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '0.8125rem'
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontFamily: 'IBM Plex Sans, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '0.75rem'
    fontWeight: 500
    lineHeight: 1.4
  mono-data:
    fontFamily: 'IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    fontSize: '0.78125rem'
    fontWeight: 400
    lineHeight: 1.5
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
  xl: '28px'
components:
  button-signal:
    backgroundColor: '{colors.signal-orange}'
    textColor: '{colors.carbon-ink}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    padding: '0 12px'
    height: '30px'
  button-quiet:
    backgroundColor: 'transparent'
    textColor: '{colors.pewter-ink}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    padding: '0 8px'
    height: '26px'
  button-quiet-active:
    backgroundColor: '{colors.selected-slate}'
    textColor: '{colors.frost-ink}'
  chip-envelope-active:
    backgroundColor: '{colors.selected-slate}'
    textColor: '{colors.frost-ink}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    padding: '0 9px'
  input-filter:
    backgroundColor: '{colors.slate-surface}'
    textColor: '{colors.frost-ink}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    padding: '2px 8px'
    height: '26px'
---

# Design System: OmniBuf DevTools

## Overview

**Creative North Star: "Quiet Packet Clarity"**

OmniBuf DevTools brings binary HTTP, ConnectRPC, and gRPC-Web inspection down to the calm clarity of Chrome DevTools' JSON Preview tab. Decoded fields read as clean `key: value` pairs at rest, free of competing wire-type pills, redundant hex conversions, or permanent byte-size columns. Wire-level details (`#field · wireType · byteLength · hex`) surface quietly on row hover, and the synchronized 16-byte Hex + ASCII inspector stays tucked inside an optional side panel until toggled open.

Tonal slate surfaces in dark mode and warm drafting-paper neutrals in light mode carry nearly the entire interface. Signal Orange appears strictly as a purposeful indicator: a 2px active bar on the selected request, active tab underlines, keyboard focus rings, tag-byte highlights inside the optional Hex panel, and primary decode buttons.

**Key Characteristics:**

- Calm 2-pane default split (`Requests` rail on the left, `Tree | JSON | Headers` stage on the right) with an on-demand `Hex` side panel.
- Clean `key: value` field tree with progressive hover disclosure for wire numbers, wire types, byte sizes, and raw hex slices.
- Dual-voice IBM Plex typography: geometric sans chrome framing tabular monospace paths, trees, and byte grids.
- Restrained neutral hierarchy that suppresses healthy `200` badges, bordered uppercase pills, and stacked toolbars.
- Adaptive layout scaling from a 2/3-pane desktop split down to a single-bar Master-Detail mobile inspector with 8-byte hex rows.

## Colors

Quiet instrument neutrals carry 97% of the viewport so syntax values and byte-slice highlights read immediately.

### Primary

- **Signal Orange** (`#ff4f18`): Marks the 2px active request indicator, active view-tab underline, keyboard focus ring, tag-byte underline in the Hex panel, and primary manual-decode CTA buttons. Solid fills always use Carbon Ink (`#111111`) text.

### Semantic Data Accents

- **Scalar Sky** (`#93c5fd`): Highlights numeric and boolean values in the field tree (`#1d4ed8` in light mode).
- **String Emerald** (`#86efac`): Highlights UTF-8 string literals in the field tree (`#047857` in light mode).
- **Container Amber** (`#f59e0b`): Underlines container length headers inside the optional Hex inspector.
- **Payload Mint** (`#10b981`): Underlines payload value bytes inside the optional Hex inspector.

### Neutral

- **Obsidian Canvas** (`#0f1115`): Recessed dark-mode ground for the request list, stream frame strip, and optional Hex panel.
- **Slate Surface** (`#141820`): Primary reading surface for the decoded field tree, JSON preview, and headers table.
- **Instrument Chrome** (`#181d27`): Slim 36px-38px topbar and response bar surface.
- **Elevated Slate** (`#202736`) and **Selected Slate** (`#232d40`): Subtle hover and selected row states.
- **Subtle Rule** (`#262e3d`) and **Strong Rule** (`#3c485e`): 1px structural pane dividers and popover borders.
- **Frost Ink** (`#eef1f6`), **Pewter Ink** (`#b4bece`), and **Muted Slate Ink** (`#7f8a9e`): Three-step dark-mode text hierarchy.
- **Drafting Paper** (`#f5f2ea`), **Warm Cream** (`#faf8f3`), **Stone Chrome** (`#ede9df`), and **Carbon Ink** (`#111111`): Warm light-mode surfaces synced with host DevTools preferences.

### Named Rules

**The Dark-Ink Accent Rule.** Solid Signal Orange fills always pair with Carbon Ink (`#111111`) text, never white text.

**The Quiet Default Rule.** Healthy HTTP `200` responses, resting field wire types, and resting byte sizes remain unbadged and hidden until needed; reserve color badges for HTTP/RPC errors (`>= 400`) and active Hex byte-slice inspection.

## Typography

**UI Chrome Font:** IBM Plex Sans (500, 600, 700, bundled offline as WOFF2)
**Wire Data Font:** IBM Plex Mono (400, 500, 600, bundled offline as WOFF2)

### Hierarchy

- **Headline** (600, `0.9375rem` / 15px, line-height 1.35): Empty-state and untagged-response titles.
- **Title** (600, `0.8125rem` / 13px, line-height 1.4, `-0.01em` tracking): Topbar brand wordmark.
- **Body** (500, `0.8125rem` / 13px, line-height 1.5): Concise empty-state guidance (`max-width: 440px`).
- **Mono Data** (400/500, `0.78125rem` / 12.5px, line-height 1.5): Field-tree `key: value` rows, request paths, and JSON output.
- **Label** (500/600, `0.75rem` / 12px, line-height 1.4, `tabular-nums`): Slim toolbar tabs, buttons, hover metadata, and hex cells.

### Named Rules

**The Tabular Byte Rule.** Every element displaying counts, status codes, hover byte lengths, or hexadecimal offsets applies `font-variant-numeric: tabular-nums`.

**The Offline Font Rule.** Extension bundles ship local WOFF2 subsets inside `dist/fonts/` with zero external network requests.

## Layout

The panel fills `100dvh` inside a locked outer flex container (`overflow: hidden`) with a single 38px topbar and a single 36px response bar.

- **Default 2-Pane Split (`>= 768px`, Hex closed):** Two-column CSS grid (`268px minmax(0, 1fr)`). Captured requests anchor the left rail while the decoded `Tree | JSON | Headers` stage occupies the full remaining width.
- **Wide 3-Pane Split (`>= 1080px`, Hex open):** Expands to `268px minmax(320px, 1fr) 496px` when the user toggles **Hex**, docking the synchronized 16-byte Hex + ASCII panel on the right (`768px .. 1079px` stacks the open Hex panel below the main viewport).
- **Narrow & Side-Docked Master-Detail (`< 768px`):** Switches between a full-height `Requests` list and a single-bar `Response` view (`< Requests`, `Tree | JSON | Headers`, `Copy`, `Hex`, and `⋯` options), using an 8-byte-per-row hex grid below `520px`.

## Elevation & Depth

Pane hierarchy relies on 1px structural borders (`--border-subtle`) and quiet stepped surface fills (`--bg-canvas` vs `--bg-surface` vs `--bg-chrome`). Only the floating `⋯` options popover uses an elevation shadow (`--popover-shadow`) to separate the menu from underlying tree rows. Interactive states snap in `100ms-120ms` (`cubic-bezier(0.2, 0, 0, 1)`).

## Shapes

- **Micro indicators (`3px`):** Error status pills and segmented scope buttons.
- **Controls (`4px`):** Quiet toolbar buttons, filter inputs, stream frame tabs, and protocol selects.
- **Floating menu (`6px`):** Overflow options popover (`#more-menu`) and `.obuf` drop target.

## Components

### Buttons & Tabs

- **View Tabs (`view-tab`):** Clean 36px text tabs (`Tree`, `JSON`, `Headers`) with a 2px Signal Orange bottom bar on the active tab.
- **Quiet Action (`btn-quiet`):** Borderless 26px text button (`Open`, `Clear`, `Copy`, `Hex`) that shifts to `--bg-selected` with `--border-strong` when toggled active (`Hex`).
- **Icon Action (`btn-icon`):** 26x26px inline SVG button (`stroke-width="1.5"`) for theme switching, overflow options (`⋯`), and closing the Hex panel (`×`).
- **Primary Signal (`btn-signal`):** Solid Signal Orange (`#ff4f18`) CTA with Carbon Ink (`#111111`) text (`Open .obuf`, `Decode as OmniBuf`).

### Simplified Field Tree & Optional Hex Grid

- **Field Tree Row (`tree-row`):** Renders `twisty` + `key:` + formatted value (`64512`, `"edge-fra-01"`, `PeerLocation {5}`, `[1]`). Expanding a container hides its collapsed item count so parent rows read cleanly above indented children. Hovering or keyboard-focusing a row reveals `.tree-hover-meta` (`#1 · fixed32 · 5 B · 0x2900fc0000`) aligned to the right.
- **Hex & ASCII Slice Grid (`hex-grid`):** Paginates payloads in 4 KiB windows inside the optional `#pane-hex` drawer, highlighting tag bytes (Signal Orange), length headers (Amber), and payload bytes (Mint) in lockstep with tree selection.

## Do's and Don'ts

### Do:

- **Do** keep resting field-tree rows focused on `key: value` legibility and reveal wire metadata (`#num`, wire type, byte size, hex) on hover or inside the optional Hex panel.
- **Do** keep the Hex panel closed by default so primary tree and JSON inspection gets full horizontal breathing room.
- **Do** keep secondary settings (`Protocol` override, `Field #0` visibility, `Preserve log`, `Expand/Collapse all`, file downloads) tucked inside the `⋯` menu.
- **Do** honor `prefers-reduced-motion: reduce`.

### Don't:

- **Don't** render green `200` pills, uppercase `[PROTOCOL]` badges, or inline `(0x0000fc00)` hex conversions on resting list or tree rows.
- **Don't** stack multiple toolbars above the response tree.
- **Don't** load fonts, icons, or stylesheets from external URLs.
- **Don't** auto-decode untagged `application/proto` or `application/octet-stream` responses without explicit confirmation.
