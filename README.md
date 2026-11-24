# omnibuf-devtools

[![OmniBuf Spec: v1 DRAFT-1](https://img.shields.io/badge/OmniBuf%20Spec-v1%20DRAFT--1-FF4F18)](https://omnibuf.com/spec)

Manifest V3 browser DevTools extension for inspecting [OmniBuf](https://omnibuf.com) HTTP responses, ConnectRPC calls, gRPC-Web streams, and local `.obuf` files. Part of the [OmniBuf tooling suite](https://omnibuf.com/tooling).

## Build & Load

```bash
just install
just build
```

Load the built extension from `dist/`:

- **Chrome / Edge / Brave:** Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `omnibuf-devtools/dist`.
- **Firefox:** Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on...**, and select `omnibuf-devtools/dist/manifest.json`.

Open Developer Tools and select the **OmniBuf** panel.

## Supported Transports

| Transport                 | Media Types / Triggers                                                                                                   |
| :------------------------ | :----------------------------------------------------------------------------------------------------------------------- |
| HTTP / REST & local files | `application/omnibuf`, `application/x-omnibuf`, `application/vnd.omnibuf`, `*.obuf`, `*.obuf.gz`                         |
| ConnectRPC unary          | `application/omnibuf` with `Connect-Protocol-Version` or `Connect-Content-Encoding`                                      |
| ConnectRPC streaming      | `application/connect+omnibuf`, `application/connect+x-omnibuf` (5-byte envelopes, `gzip`/`deflate`, `EndStreamResponse`) |
| gRPC-Web / gRPC-Web Text  | `application/grpc-web+omnibuf`, `application/grpc-web-text+omnibuf` (binary/base64 frames, `0x80` trailers)              |

Untagged binary responses (`application/octet-stream`) can be decoded on demand by switching capture scope to **All HTTP** and clicking **Decode as OmniBuf**.

## Features

- Decodes schema-less payloads into an expandable field tree with exact wire types and byte offsets.
- Resolves inline `Field #0` metadata automatically for root and nested message names.
- Shows wire metadata on hover (`#field`, wire type, byte length, hex) and includes an optional synchronized 16-byte hex/ASCII side panel.
- Exports decoded JSON with lossless 64-bit integer string serialization.
- Requires zero host permissions; reads completed responses from `chrome.devtools.network` and local `.obuf` drag-and-drop.

## Development

```bash
just test               # Run unit, protocol, and packaging tests
just lint               # ESLint and TypeScript checks
just fmt-check          # Prettier format check
just pack               # Build Chrome, Firefox, and AMO source zips into artifacts/
just ci                 # Run fmt-check, lint, build, and test
```

## License

Apache-2.0
