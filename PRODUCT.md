# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Frontend, full-stack, and backend engineers inspecting binary HTTP responses, ConnectRPC unary and server-streaming calls, gRPC-Web streams, or local `.obuf` capture files inside Chrome, Chromium, and Firefox Developer Tools.

## Product Purpose

OmniBuf DevTools (`omnibuf-devtools`) is a Manifest V3 browser Developer Tools extension powered by `@omnibuf/core` and `@omnibuf/web`. It captures completed HTTP responses from `chrome.devtools.network`, unpacks protocol framing and envelope compression, and renders OmniBuf binary payloads as an interactive field tree synchronized with byte offsets, raw hex slices, and JSON export.

## Positioning

Inspecting binary RPC traffic in browser DevTools normally requires loading `.proto` descriptor sets or decoding base64 strings in an external terminal. OmniBuf encodes explicit 4-bit wire types (`0..15`) in every field tag and supports optional inline `Field #0` (`SchemaMeta`) field-name metadata. That wire layout lets a single shared decoder inspect raw HTTP bodies, ConnectRPC envelopes, and gRPC-Web frames immediately inside DevTools: self-describing packets show named fields and nested message types, while schema-less packets still display numbered fields, exact wire types, decoded scalar/container values, and byte ranges.

## Operating Context

- Runs as an offline Manifest V3 DevTools panel (`OmniBuf`) inside Chrome/Chromium and Firefox Developer Tools, adapting automatically to `chrome.devtools.panels.themeName` (`dark` Night Workstation Slate and `default` Drafting Paper) with an explicit theme toggle in the toolbar.
- Structured around three explicit layers:
  1. **Browser network capture & classifier:** Listens to `chrome.devtools.network.onRequestFinished`, retrieves completed response bodies via `request.getContent()`, auto-detects OmniBuf traffic by `Content-Type` (`application/omnibuf`, `application/x-omnibuf`, `application/vnd.omnibuf`, `application/connect+omnibuf`, `application/grpc-web+omnibuf`, `application/grpc-web-text+omnibuf`) and `.obuf` URL extensions, supports manual **Decode as OmniBuf** override on any HTTP request, and opens local `.obuf` files via file picker or drag-and-drop.
  2. **Protocol framing adapters:** Unpacks Plain HTTP / REST raw payloads, ConnectRPC unary payloads (including Connect JSON error responses), ConnectRPC streaming 5-byte big-endian envelopes (decompressing `gzip` / `deflate` frames via `DecompressionStream` and separating `EndStreamResponse` metadata/error JSON), and gRPC-Web binary or multi-segment base64 text frames (separating `0x80` trailer blocks).
  3. **Recursive OmniBuf field-tree decoder:** Walks top-level and nested sub-messages, primitive and message arrays, typed maps, scalars, and `Field #0` `SchemaMeta`, recording exact packet and stream-envelope byte offsets (`tag`, `header`, `payload`) alongside `BigInt`-safe JSON export.

## Capabilities and Constraints

- **Scope boundary:** Inspects completed HTTP responses exposed through `getContent()` and local `.obuf` files. Live mid-stream capture of indefinitely open connections requires page-context fetch/XHR interception and stays outside v1 so the extension needs zero host permissions.
- **Protocol boundary:** Standard Protobuf wire traffic (`application/proto`, `application/grpc-web+proto`) is not OmniBuf. Only applications using an OmniBuf codec emit OmniBuf tags and length headers; misidentified or truncated payloads surface a byte-offset diagnostic in the inspector.

## Brand Commitments

- **Voice and tone:** Direct, technical, matter-of-fact workstation instrument copy. Every badge, column header, and diagnostic names concrete protocol flags, wire types, and byte offsets.
- **Copy bans:** Avoid legacy-tax clichés, dramatic historical hooks, marketing filler, and em-dashes anywhere in UI copy, code comments, or documentation.

## Evidence on Hand

- Wire-format decoder and inspection primitives in [`@omnibuf/core`](https://github.com/omnibuf/omnibuf-es/tree/main/packages/omnibuf) and [`@omnibuf/web`](https://github.com/omnibuf/omnibuf-es/tree/main/packages/omnibuf-web).
- Visual identity and token system established in [`omnibuf.com/DESIGN.md`](https://github.com/omnibuf/omnibuf.com/blob/main/DESIGN.md), adapted for dense Operate-mode DevTools panes in [`DESIGN.md`](./DESIGN.md).

## Product Principles

1. **Binary responses as legible as JSON:** Selecting a request immediately shows its decoded field tree, field numbers, wire types, and exportable JSON with zero setup.
2. **Bidirectional byte truth:** Every tree node maps to its exact `[offset..offset+length)` tag, header, and payload bytes, and clicking any byte in the hex slice selects its owning field node.
3. **Zero host permissions:** Operate strictly on `chrome.devtools.network` HAR capture and local `.obuf` files with no injected content scripts or remote network calls.
