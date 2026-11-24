import {
  type ConcreteProtocolId,
  type ProtocolId,
  type TrafficMetadata,
  decodeMultiSegmentBase64,
  inferProtocolFromMetadata,
  normalizeHeaders,
  parseMediaType,
} from './detect.js';
import { decompressPayload, hasGzipMagic } from './compression.js';

export interface ConnectErrorBody {
  code?: string;
  message?: string;
  details?: unknown[];
}

export interface ConnectEndStreamBody {
  error?: ConnectErrorBody;
  metadata?: Record<string, string[]>;
  rawJson: unknown;
}

export interface ExtractedEnvelope {
  index: number;
  kind: 'message' | 'end-stream' | 'trailers' | 'error-json';
  /** Byte offset in the outer framed buffer where this envelope begins */
  wireOffset: number;
  /** Total byte length of this envelope in the outer framed buffer */
  wireByteLength: number;
  /**
   * Byte offset in the outer framed buffer where the uncompressed OmniBuf message starts.
   * `null` when the payload was decompressed or base64-decoded from text framing.
   */
  uncompressedWirePayloadOffset: number | null;
  flags: number;
  compressed: boolean;
  compressionEncoding?: string;
  payload: Uint8Array;
  endStream?: ConnectEndStreamBody;
  trailers?: Record<string, string>;
  error?: string;
}

export interface ProtocolExtractionOptions {
  maxDecompressedBytes?: number;
}

export interface ProtocolExtractionResult {
  protocol: ConcreteProtocolId;
  envelopes: ExtractedEnvelope[];
  warnings: string[];
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

function tryParseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.byteLength === 0) return null;
  // Skip leading ASCII whitespace
  let i = 0;
  while (
    i < bytes.byteLength &&
    (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)
  ) {
    i++;
  }
  if (i >= bytes.byteLength || bytes[i] !== 0x7b /* '{' */) return null;
  try {
    const parsed: unknown = JSON.parse(utf8Decoder.decode(bytes));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function parseConnectErrorObject(obj: Record<string, unknown>): ConnectErrorBody | undefined {
  const code = typeof obj.code === 'string' ? obj.code : undefined;
  const message = typeof obj.message === 'string' ? obj.message : undefined;
  const details = Array.isArray(obj.details) ? obj.details : undefined;
  if (!code && !message && !details) return undefined;
  return { code, message, details };
}

function parseGrpcTrailers(bytes: Uint8Array): Record<string, string> {
  const text = utf8Decoder.decode(bytes);
  const trailers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    let val = line.slice(colon + 1).trim();
    if (key === 'grpc-message' && val.includes('%')) {
      try {
        val = decodeURIComponent(val);
      } catch {
        // Keep raw header value if percent-encoding is malformed
      }
    }
    trailers[key] = Object.hasOwn(trailers, key) ? `${trailers[key]}, ${val}` : val;
  }
  return trailers;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

/**
 * Unpacks a captured HTTP response body according to the active protocol adapter
 * (`raw`, `connect-unary`, `connect-streaming`, `grpc-web`, or `grpc-web-text`).
 */
export async function extractProtocolEnvelopes(
  body: Uint8Array,
  protocol: ProtocolId,
  meta: TrafficMetadata = {},
  options: ProtocolExtractionOptions = {},
): Promise<ProtocolExtractionResult> {
  const resolved: ConcreteProtocolId =
    protocol === 'auto' ? inferProtocolFromMetadata(meta) : protocol;
  const headers = normalizeHeaders(meta.headers);
  const warnings: string[] = [];

  if (resolved === 'raw') {
    const isGzUrl = Boolean(
      meta.url && meta.url.toLowerCase().split(/[?#]/)[0]?.endsWith('.obuf.gz'),
    );
    if (isGzUrl && hasGzipMagic(body)) {
      try {
        const decompressed = await decompressPayload(body, 'gzip', options.maxDecompressedBytes);
        return {
          protocol: 'raw',
          warnings,
          envelopes: [
            {
              index: 0,
              kind: 'message',
              wireOffset: 0,
              wireByteLength: body.byteLength,
              uncompressedWirePayloadOffset: null,
              flags: 0,
              compressed: true,
              compressionEncoding: 'gzip',
              payload: decompressed,
            },
          ],
        };
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err));
      }
    }

    return {
      protocol: 'raw',
      warnings,
      envelopes: [
        {
          index: 0,
          kind: 'message',
          wireOffset: 0,
          wireByteLength: body.byteLength,
          uncompressedWirePayloadOffset: 0,
          flags: 0,
          compressed: false,
          payload: body,
        },
      ],
    };
  }

  if (resolved === 'connect-unary') {
    const media = parseMediaType(headers['content-type'] || meta.mimeType);
    const isErrorStatus = meta.status !== undefined && meta.status >= 400;

    // Connect unary error bodies are returned as application/json
    if (media === 'application/json' || isErrorStatus) {
      const jsonObj = tryParseJsonObject(body);
      if (jsonObj) {
        const errBody = parseConnectErrorObject(jsonObj);
        return {
          protocol: 'connect-unary',
          warnings,
          envelopes: [
            {
              index: 0,
              kind: 'error-json',
              wireOffset: 0,
              wireByteLength: body.byteLength,
              uncompressedWirePayloadOffset: 0,
              flags: 0,
              compressed: false,
              payload: body,
              endStream: {
                error: errBody,
                rawJson: jsonObj,
              },
            },
          ],
        };
      }
    }

    // Check Connect unary compression if wire bytes were not already decompressed by the browser
    const encodingHeader = headers['content-encoding'] || headers['connect-content-encoding'];
    const normEnc = (encodingHeader ?? '').trim().toLowerCase();
    const looksStillCompressed =
      normEnc === 'gzip' || normEnc === 'x-gzip'
        ? hasGzipMagic(body)
        : Boolean(normEnc && normEnc !== 'identity');

    if (looksStillCompressed && normEnc) {
      try {
        const decompressed = await decompressPayload(body, normEnc, options.maxDecompressedBytes);
        return {
          protocol: 'connect-unary',
          warnings,
          envelopes: [
            {
              index: 0,
              kind: 'message',
              wireOffset: 0,
              wireByteLength: body.byteLength,
              uncompressedWirePayloadOffset: null,
              flags: 0,
              compressed: true,
              compressionEncoding: normEnc,
              payload: decompressed,
            },
          ],
        };
      } catch (err) {
        // When HAR content-encoding: deflate was already decompressed by Chrome getContent(),
        // fall back cleanly to raw bytes if body is already uncompressed
        if (!headers['connect-content-encoding'] && headers['content-encoding']) {
          return {
            protocol: 'connect-unary',
            warnings,
            envelopes: [
              {
                index: 0,
                kind: 'message',
                wireOffset: 0,
                wireByteLength: body.byteLength,
                uncompressedWirePayloadOffset: 0,
                flags: 0,
                compressed: false,
                payload: body,
              },
            ],
          };
        }
        return {
          protocol: 'connect-unary',
          warnings,
          envelopes: [
            {
              index: 0,
              kind: 'message',
              wireOffset: 0,
              wireByteLength: body.byteLength,
              uncompressedWirePayloadOffset: null,
              flags: 0,
              compressed: true,
              compressionEncoding: normEnc,
              payload: new Uint8Array(0),
              error: err instanceof Error ? err.message : String(err),
            },
          ],
        };
      }
    }

    return {
      protocol: 'connect-unary',
      warnings,
      envelopes: [
        {
          index: 0,
          kind: 'message',
          wireOffset: 0,
          wireByteLength: body.byteLength,
          uncompressedWirePayloadOffset: 0,
          flags: 0,
          compressed: false,
          payload: body,
        },
      ],
    };
  }

  if (resolved === 'connect-streaming') {
    const envelopes: ExtractedEnvelope[] = [];
    const streamEncoding =
      headers['connect-content-encoding'] || headers['content-encoding'] || 'gzip';
    let pos = 0;
    let index = 0;

    while (pos < body.byteLength) {
      if (body.byteLength - pos < 5) {
        const rem = body.byteLength - pos;
        const msg = `Truncated Connect envelope header at +0x${pos.toString(16).padStart(4, '0')} (${rem} of 5 header bytes present)`;
        warnings.push(msg);
        envelopes.push({
          index: index++,
          kind: 'message',
          wireOffset: pos,
          wireByteLength: rem,
          uncompressedWirePayloadOffset: null,
          flags: body[pos] ?? 0,
          compressed: false,
          payload: body.subarray(pos),
          error: msg,
        });
        break;
      }

      const flags = body[pos]!;
      const frameLen = readUint32BE(body, pos + 1);
      const payloadStart = pos + 5;
      const available = body.byteLength - payloadStart;

      if (frameLen > available) {
        const msg = `Truncated Connect envelope #${index} at +0x${pos.toString(16).padStart(4, '0')}: header declared ${frameLen} bytes, ${available} bytes available`;
        warnings.push(msg);
        envelopes.push({
          index: index++,
          kind: (flags & 0x02) !== 0 ? 'end-stream' : 'message',
          wireOffset: pos,
          wireByteLength: 5 + available,
          uncompressedWirePayloadOffset: null,
          flags,
          compressed: (flags & 0x01) !== 0,
          payload: body.subarray(payloadStart),
          error: msg,
        });
        break;
      }

      const rawSlice = body.subarray(payloadStart, payloadStart + frameLen);
      const isCompressed = (flags & 0x01) !== 0;
      const isEndStream = (flags & 0x02) !== 0;
      const unknownFlags = flags & ~0x03;
      if (unknownFlags !== 0) {
        warnings.push(
          `Connect envelope #${index} carries reserved flag bits 0x${flags.toString(16).padStart(2, '0')}`,
        );
      }

      let payload = rawSlice;
      let frameError: string | undefined;
      if (isCompressed) {
        try {
          payload = await decompressPayload(rawSlice, streamEncoding, options.maxDecompressedBytes);
        } catch (err) {
          frameError = err instanceof Error ? err.message : String(err);
          warnings.push(`Envelope #${index}: ${frameError}`);
        }
      }

      if (isEndStream) {
        let endStream: ConnectEndStreamBody | undefined;
        if (!frameError) {
          try {
            const parsed: unknown =
              payload.byteLength === 0 ? {} : JSON.parse(utf8Decoder.decode(payload));
            const obj =
              parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
            const errObj =
              obj.error && typeof obj.error === 'object' && !Array.isArray(obj.error)
                ? parseConnectErrorObject(obj.error as Record<string, unknown>)
                : undefined;
            const metadata =
              obj.metadata && typeof obj.metadata === 'object' && !Array.isArray(obj.metadata)
                ? (obj.metadata as Record<string, string[]>)
                : undefined;
            endStream = {
              error: errObj,
              metadata,
              rawJson: parsed,
            };
          } catch (err) {
            frameError = `Malformed EndStreamResponse JSON: ${err instanceof Error ? err.message : String(err)}`;
            warnings.push(frameError);
          }
        }
        envelopes.push({
          index: index++,
          kind: 'end-stream',
          wireOffset: pos,
          wireByteLength: 5 + frameLen,
          uncompressedWirePayloadOffset: isCompressed ? null : payloadStart,
          flags,
          compressed: isCompressed,
          compressionEncoding: isCompressed ? streamEncoding : undefined,
          payload,
          endStream,
          error: frameError,
        });
      } else {
        envelopes.push({
          index: index++,
          kind: 'message',
          wireOffset: pos,
          wireByteLength: 5 + frameLen,
          uncompressedWirePayloadOffset: isCompressed ? null : payloadStart,
          flags,
          compressed: isCompressed,
          compressionEncoding: isCompressed ? streamEncoding : undefined,
          payload,
          error: frameError,
        });
      }

      pos = payloadStart + frameLen;
    }

    return {
      protocol: 'connect-streaming',
      envelopes,
      warnings,
    };
  }

  // gRPC-Web & gRPC-Web-Text framing
  let framedBytes = body;
  const isTextMode = resolved === 'grpc-web-text';
  if (isTextMode && body.byteLength > 0) {
    try {
      const ascii = utf8Decoder.decode(body);
      framedBytes = decodeMultiSegmentBase64(ascii);
    } catch (err) {
      const msg = `Invalid grpc-web-text base64 body: ${err instanceof Error ? err.message : String(err)}`;
      return {
        protocol: 'grpc-web-text',
        warnings: [msg],
        envelopes: [
          {
            index: 0,
            kind: 'message',
            wireOffset: 0,
            wireByteLength: body.byteLength,
            uncompressedWirePayloadOffset: null,
            flags: 0,
            compressed: false,
            payload: new Uint8Array(0),
            error: msg,
          },
        ],
      };
    }
  }

  const envelopes: ExtractedEnvelope[] = [];
  const grpcEncoding = headers['grpc-encoding'] || 'gzip';
  let pos = 0;
  let index = 0;

  while (pos < framedBytes.byteLength) {
    if (framedBytes.byteLength - pos < 5) {
      const rem = framedBytes.byteLength - pos;
      const msg = `Truncated gRPC-Web frame header at +0x${pos.toString(16).padStart(4, '0')} (${rem} of 5 header bytes present)`;
      warnings.push(msg);
      envelopes.push({
        index: index++,
        kind: 'message',
        wireOffset: pos,
        wireByteLength: rem,
        uncompressedWirePayloadOffset: null,
        flags: framedBytes[pos] ?? 0,
        compressed: false,
        payload: framedBytes.subarray(pos),
        error: msg,
      });
      break;
    }

    const flags = framedBytes[pos]!;
    const frameLen = readUint32BE(framedBytes, pos + 1);
    const payloadStart = pos + 5;
    const available = framedBytes.byteLength - payloadStart;

    if (frameLen > available) {
      const msg = `Truncated gRPC-Web frame #${index} at +0x${pos.toString(16).padStart(4, '0')}: header declared ${frameLen} bytes, ${available} bytes available`;
      warnings.push(msg);
      envelopes.push({
        index: index++,
        kind: (flags & 0x80) !== 0 ? 'trailers' : 'message',
        wireOffset: pos,
        wireByteLength: 5 + available,
        uncompressedWirePayloadOffset: null,
        flags,
        compressed: (flags & 0x01) !== 0,
        payload: framedBytes.subarray(payloadStart),
        error: msg,
      });
      break;
    }

    const rawSlice = framedBytes.subarray(payloadStart, payloadStart + frameLen);
    const isCompressed = (flags & 0x01) !== 0;
    const isTrailer = (flags & 0x80) !== 0;

    let payload = rawSlice;
    let frameError: string | undefined;
    if (isCompressed) {
      try {
        payload = await decompressPayload(rawSlice, grpcEncoding, options.maxDecompressedBytes);
      } catch (err) {
        frameError = err instanceof Error ? err.message : String(err);
        warnings.push(`Frame #${index}: ${frameError}`);
      }
    }

    if (isTrailer) {
      const trailers = frameError ? undefined : parseGrpcTrailers(payload);
      envelopes.push({
        index: index++,
        kind: 'trailers',
        wireOffset: pos,
        wireByteLength: 5 + frameLen,
        uncompressedWirePayloadOffset: isCompressed || isTextMode ? null : payloadStart,
        flags,
        compressed: isCompressed,
        compressionEncoding: isCompressed ? grpcEncoding : undefined,
        payload,
        trailers,
        error: frameError,
      });
    } else {
      envelopes.push({
        index: index++,
        kind: 'message',
        wireOffset: pos,
        wireByteLength: 5 + frameLen,
        uncompressedWirePayloadOffset: isCompressed || isTextMode ? null : payloadStart,
        flags,
        compressed: isCompressed,
        compressionEncoding: isCompressed ? grpcEncoding : undefined,
        payload,
        error: frameError,
      });
    }

    pos = payloadStart + frameLen;
  }

  // Include HTTP-header trailers if gRPC-Web unary sent grpc-status in HTTP response headers
  if (
    envelopes.length > 0 &&
    !envelopes.some((e) => e.kind === 'trailers') &&
    headers['grpc-status'] !== undefined
  ) {
    const headerTrailers: Record<string, string> = {
      'grpc-status': headers['grpc-status']!,
    };
    if (headers['grpc-message'] !== undefined) {
      let msg = headers['grpc-message']!;
      if (msg.includes('%')) {
        try {
          msg = decodeURIComponent(msg);
        } catch {
          // keep raw
        }
      }
      headerTrailers['grpc-message'] = msg;
    }
    envelopes.push({
      index: index++,
      kind: 'trailers',
      wireOffset: framedBytes.byteLength,
      wireByteLength: 0,
      uncompressedWirePayloadOffset: null,
      flags: 0x80,
      compressed: false,
      payload: new Uint8Array(0),
      trailers: headerTrailers,
    });
  }

  return {
    protocol: resolved,
    envelopes,
    warnings,
  };
}
