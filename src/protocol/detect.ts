import { base64ToUint8Array } from '@omnibuf/core';

export type ConcreteProtocolId =
  'raw' | 'connect-unary' | 'connect-streaming' | 'grpc-web' | 'grpc-web-text';

export type ProtocolId = 'auto' | ConcreteProtocolId;

export type DetectionReason =
  'content-type' | 'file-extension' | 'connect-error' | 'manual' | 'none';

export interface HeaderPair {
  name: string;
  value: string;
}

export interface TrafficMetadata {
  url?: string;
  method?: string;
  status?: number;
  mimeType?: string;
  headers?: HeaderPair[] | Record<string, string>;
  requestHeaders?: HeaderPair[] | Record<string, string>;
}

export interface TrafficClassification {
  detected: boolean;
  protocol: ConcreteProtocolId;
  reason: DetectionReason;
  badge: string;
  mediaType: string;
  isConnectUnaryError: boolean;
}

/**
 * Normalizes an array of HAR `{ name, value }` headers or a header map into
 * a lowercased `Record<string, string>`.
 */
export function normalizeHeaders(
  input?: HeaderPair[] | Record<string, string> | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  if (Array.isArray(input)) {
    for (const pair of input) {
      if (!pair || typeof pair.name !== 'string') continue;
      const key = pair.name.trim().toLowerCase();
      if (!key) continue;
      const val = typeof pair.value === 'string' ? pair.value.trim() : '';
      out[key] = key in out && out[key] ? `${out[key]}, ${val}` : val;
    }
    return out;
  }
  for (const [rawKey, rawVal] of Object.entries(input)) {
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    out[key] = typeof rawVal === 'string' ? rawVal.trim() : String(rawVal ?? '');
  }
  return out;
}

/**
 * Extracts the lowercased `type/subtype` essence from a Content-Type header,
 * stripping parameters such as `; charset=utf-8` or `; proto=...`.
 */
export function parseMediaType(contentType?: string | null): string {
  if (!contentType) return '';
  const semi = contentType.indexOf(';');
  const raw = semi >= 0 ? contentType.slice(0, semi) : contentType;
  return raw.trim().toLowerCase();
}

const DIRECT_OMNIBUF_SUBTYPES = new Set(['omnibuf', 'x-omnibuf', 'vnd.omnibuf', 'obuf', 'x-obuf']);

function hasOmniBufSuffix(subtype: string): boolean {
  if (DIRECT_OMNIBUF_SUBTYPES.has(subtype)) return true;
  if (
    subtype.endsWith('+omnibuf') ||
    subtype.endsWith('+x-omnibuf') ||
    subtype.endsWith('+vnd.omnibuf') ||
    subtype.endsWith('+obuf') ||
    subtype.endsWith('+x-obuf')
  ) {
    return true;
  }
  if (subtype.startsWith('vnd.omnibuf.')) {
    return true;
  }
  return false;
}

/**
 * Returns true if the media type (`type/subtype` or full Content-Type header)
 * identifies an OmniBuf payload.
 */
export function isOmniBufMediaType(contentTypeOrMediaType?: string | null): boolean {
  const media = parseMediaType(contentTypeOrMediaType);
  if (!media) return false;
  const slash = media.indexOf('/');
  if (slash <= 0 || slash === media.length - 1) return false;
  const subtype = media.slice(slash + 1);
  return hasOmniBufSuffix(subtype);
}

function headerMentionsOmniBuf(headerValue?: string): boolean {
  if (!headerValue) return false;
  for (const part of headerValue.split(',')) {
    if (isOmniBufMediaType(part)) return true;
  }
  return false;
}

/**
 * Returns true if the URL path ends with `.obuf` or `.obuf.gz` (ignoring query and hash).
 */
export function hasObufExtension(url?: string | null): boolean {
  if (!url) return false;
  let pathname = url;
  try {
    const parsed = new URL(url, 'http://localhost');
    pathname = parsed.pathname;
  } catch {
    const q = pathname.indexOf('?');
    if (q >= 0) pathname = pathname.slice(0, q);
    const h = pathname.indexOf('#');
    if (h >= 0) pathname = pathname.slice(0, h);
  }
  const lower = pathname.toLowerCase();
  return lower.endsWith('.obuf') || lower.endsWith('.obuf.gz');
}

function hasConnectHeaders(
  headers: Record<string, string>,
  reqHeaders: Record<string, string>,
): boolean {
  return Boolean(
    headers['connect-protocol-version'] ||
    headers['connect-content-encoding'] ||
    headers['connect-accept-encoding'] ||
    reqHeaders['connect-protocol-version'] ||
    reqHeaders['connect-content-encoding'] ||
    reqHeaders['connect-accept-encoding'] ||
    reqHeaders['connect-timeout-ms'],
  );
}

/**
 * Infers the best concrete protocol adapter for a request even when manually
 * overriding Content-Type detection via "Decode as OmniBuf".
 */
export function inferProtocolFromMetadata(meta: TrafficMetadata): ConcreteProtocolId {
  const headers = normalizeHeaders(meta.headers);
  const reqHeaders = normalizeHeaders(meta.requestHeaders);
  const media = parseMediaType(headers['content-type'] || meta.mimeType);

  if (media.startsWith('application/connect+')) {
    return 'connect-streaming';
  }
  if (media.startsWith('application/grpc-web-text')) {
    return 'grpc-web-text';
  }
  if (media.startsWith('application/grpc-web')) {
    return 'grpc-web';
  }
  if (hasConnectHeaders(headers, reqHeaders)) {
    return 'connect-unary';
  }
  return 'raw';
}

/**
 * Classifies an HTTP response by Content-Type, Connect headers, and URL `.obuf` extension.
 */
export function classifyTraffic(meta: TrafficMetadata): TrafficClassification {
  const headers = normalizeHeaders(meta.headers);
  const reqHeaders = normalizeHeaders(meta.requestHeaders);
  const media = parseMediaType(headers['content-type'] || meta.mimeType);

  if (isOmniBufMediaType(media)) {
    if (media.startsWith('application/connect+')) {
      return {
        detected: true,
        protocol: 'connect-streaming',
        reason: 'content-type',
        badge: 'CONNECT STREAM',
        mediaType: media,
        isConnectUnaryError: false,
      };
    }
    if (media.startsWith('application/grpc-web-text')) {
      return {
        detected: true,
        protocol: 'grpc-web-text',
        reason: 'content-type',
        badge: 'GRPC-WEB TEXT',
        mediaType: media,
        isConnectUnaryError: false,
      };
    }
    if (media.startsWith('application/grpc-web')) {
      return {
        detected: true,
        protocol: 'grpc-web',
        reason: 'content-type',
        badge: 'GRPC-WEB',
        mediaType: media,
        isConnectUnaryError: false,
      };
    }
    if (hasConnectHeaders(headers, reqHeaders)) {
      return {
        detected: true,
        protocol: 'connect-unary',
        reason: 'content-type',
        badge: 'CONNECT',
        mediaType: media,
        isConnectUnaryError: false,
      };
    }
    return {
      detected: true,
      protocol: 'raw',
      reason: 'content-type',
      badge: 'RAW',
      mediaType: media,
      isConnectUnaryError: false,
    };
  }

  // Connect unary calls return application/json error envelopes on non-2xx statuses
  const requestUsedOmniBuf =
    headerMentionsOmniBuf(reqHeaders['content-type']) ||
    headerMentionsOmniBuf(reqHeaders['accept']);
  if (
    requestUsedOmniBuf &&
    media === 'application/json' &&
    ((meta.status !== undefined && meta.status >= 400) || hasConnectHeaders(headers, reqHeaders))
  ) {
    return {
      detected: true,
      protocol: 'connect-unary',
      reason: 'connect-error',
      badge: 'CONNECT ERR',
      mediaType: media,
      isConnectUnaryError: true,
    };
  }

  if (hasObufExtension(meta.url)) {
    return {
      detected: true,
      protocol: 'raw',
      reason: 'file-extension',
      badge: '.OBUF',
      mediaType: media || 'application/x-omnibuf',
      isConnectUnaryError: false,
    };
  }

  return {
    detected: false,
    protocol: inferProtocolFromMetadata(meta),
    reason: 'none',
    badge: 'MANUAL',
    mediaType: media,
    isConnectUnaryError: false,
  };
}

/**
 * Decodes base64 strings, including concatenated multi-segment base64 payloads
 * where `=` padding appears mid-stream (used by `application/grpc-web-text+*`).
 */
export function decodeMultiSegmentBase64(b64: string): Uint8Array {
  const clean = b64.replace(/[\r\n\s]/g, '');
  if (clean.length === 0) return new Uint8Array(0);

  // Split after any padding run `=+` so each chunk has padding only at its tail
  const segments: Uint8Array[] = [];
  let segStart = 0;
  let i = 0;
  while (i < clean.length) {
    if (clean[i] === '=') {
      while (i < clean.length && clean[i] === '=') {
        i++;
      }
      const chunk = clean.slice(segStart, i);
      segments.push(decodeSingleBase64Segment(chunk));
      segStart = i;
    } else {
      i++;
    }
  }
  if (segStart < clean.length) {
    segments.push(decodeSingleBase64Segment(clean.slice(segStart)));
  }

  if (segments.length === 1) return segments[0]!;
  let total = 0;
  for (const s of segments) total += s.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const s of segments) {
    out.set(s, offset);
    offset += s.byteLength;
  }
  return out;
}

function decodeSingleBase64Segment(segment: string): Uint8Array {
  // Normalize URL-safe base64 alphabet and missing trailing `=` padding if needed
  let norm = segment.replace(/-/g, '+').replace(/_/g, '/');
  const rem = norm.length % 4;
  if (rem === 2) norm += '==';
  else if (rem === 3) norm += '=';
  else if (rem === 1) {
    throw new Error('Invalid base64 segment length');
  }
  return base64ToUint8Array(norm);
}

export interface CapturedBytesResult {
  bytes: Uint8Array;
  warning?: string;
}

export interface DecodeCapturedContentHints {
  harEncoding?: string | null;
  mimeType?: string | null;
  expectedByteLength?: number | null;
}

function isTextLikeMimeType(mediaOrHeader?: string | null): boolean {
  const media = parseMediaType(mediaOrHeader);
  if (!media) return false;
  if (media.startsWith('text/')) return true;
  return (
    media === 'application/json' ||
    media.endsWith('+json') ||
    media === 'application/xml' ||
    media.endsWith('+xml') ||
    media === 'application/javascript' ||
    media === 'application/x-javascript' ||
    media === 'application/ecmascript' ||
    media === 'application/x-www-form-urlencoded' ||
    media === 'application/graphql'
  );
}

function looksLikeBase64Payload(raw: string): boolean {
  const clean = raw.replace(/[\r\n\s]/g, '');
  if (clean.length === 0 || clean.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/_-]{4})*(?:[A-Za-z0-9+/_-]{2}==|[A-Za-z0-9+/_-]{3}=)?$/.test(clean);
}

/**
 * Converts Chrome/Firefox DevTools `request.getContent(content, encoding)` payloads
 * into raw bytes while surfacing text-encoding mangling warnings when applicable.
 *
 * Note: Firefox's `devtools.network.Request.getContent()` passes `response.content.mimeType`
 * (e.g. `"application/omnibuf"`) as the second argument rather than `"base64"`, even though
 * binary response bodies are base64-encoded in `content`.
 */
export function decodeCapturedContent(
  content: string | null | undefined,
  encoding?: string | null,
  hints?: DecodeCapturedContentHints,
): CapturedBytesResult {
  if (content === null || content === undefined || content.length === 0) {
    return { bytes: new Uint8Array(0) };
  }
  const enc = (encoding ?? '').trim().toLowerCase();
  const harEnc = (hints?.harEncoding ?? '').trim().toLowerCase();
  if (enc === 'base64' || harEnc === 'base64') {
    return { bytes: decodeMultiSegmentBase64(content) };
  }

  // Firefox passes the response MIME type (containing '/') as the 2nd argument of getContent()
  // while base64-encoding non-text bodies.
  if (enc.includes('/') && !isTextLikeMimeType(enc) && looksLikeBase64Payload(content)) {
    return { bytes: decodeMultiSegmentBase64(content) };
  }

  // Fallback when encoding is omitted on a binary response whose length matches base64(Content-Length)
  if (
    enc === '' &&
    !isTextLikeMimeType(hints?.mimeType) &&
    typeof hints?.expectedByteLength === 'number' &&
    hints.expectedByteLength > 0
  ) {
    const cleanLen = content.replace(/[\r\n\s]/g, '').length;
    if (
      cleanLen > hints.expectedByteLength &&
      cleanLen === Math.ceil(hints.expectedByteLength / 3) * 4 &&
      looksLikeBase64Payload(content)
    ) {
      return { bytes: decodeMultiSegmentBase64(content) };
    }
  }

  let maxCode = 0;
  let hasReplacementChar = false;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code > maxCode) maxCode = code;
    if (code === 0xfffd) hasReplacementChar = true;
  }

  if (maxCode <= 0xff) {
    const bytes = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) {
      bytes[i] = content.charCodeAt(i) & 0xff;
    }
    return { bytes };
  }

  const utf8Bytes = new TextEncoder().encode(content);
  const warning = hasReplacementChar
    ? 'Browser DevTools returned UTF-8 decoded text containing replacement characters (U+FFFD). Serve binary responses with Content-Type: application/x-omnibuf so DevTools preserves raw base64 bytes.'
    : 'Browser DevTools returned decoded text rather than base64 bytes; multi-byte code points were re-encoded as UTF-8.';
  return { bytes: utf8Bytes, warning };
}
