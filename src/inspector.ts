import {
  type ConcreteProtocolId,
  type HeaderPair,
  type ProtocolId,
  type TrafficClassification,
  classifyTraffic,
  normalizeHeaders,
} from './protocol/detect.js';
import {
  type ConnectEndStreamBody,
  type ExtractedEnvelope,
  extractProtocolEnvelopes,
} from './protocol/adapters.js';
import { type DecodedOmniBufMessage, decodeOmniBufTree } from './decoder/tree.js';

export interface CapturedItem {
  id: string;
  source: 'network' | 'file' | 'synthetic';
  url: string;
  displayPath: string;
  host: string;
  method: string;
  status: number;
  mimeType: string;
  responseHeaders: Record<string, string>;
  requestHeaders: Record<string, string>;
  startedAt: number;
  durationMs?: number;
  classification: TrafficClassification;
  /** True when user clicked "Decode as OmniBuf" on a non-detected request */
  manualOverride: boolean;
  /** Selected protocol override ('auto' uses inferred protocol) */
  protocolOverride: ProtocolId;
  /** Raw captured response body (`null` before lazy `getContent()` runs) */
  body: Uint8Array | null;
  /** Reported wire size before `getContent()` loads */
  reportedSize: number;
  captureWarning?: string;
}

export interface InspectedEnvelopeView {
  envelope: ExtractedEnvelope;
  decoded: DecodedOmniBufMessage | null;
  decodeError?: string;
}

export interface InspectedTrafficResult {
  protocol: ConcreteProtocolId;
  envelopes: InspectedEnvelopeView[];
  warnings: string[];
}

export function parseUrlParts(rawUrl: string): { displayPath: string; host: string } {
  if (!rawUrl) return { displayPath: '(unknown)', host: '' };
  if (rawUrl.startsWith('file://')) {
    const base = rawUrl.split('/').pop() || rawUrl;
    return { displayPath: base, host: 'local .obuf' };
  }
  try {
    const parsed = new URL(rawUrl);
    const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
    return { displayPath: path, host: parsed.host };
  } catch {
    return { displayPath: rawUrl, host: '' };
  }
}

export function createCapturedItem(init: {
  id: string;
  source: 'network' | 'file' | 'synthetic';
  url: string;
  method?: string;
  status?: number;
  mimeType?: string;
  responseHeaders?: HeaderPair[] | Record<string, string>;
  requestHeaders?: HeaderPair[] | Record<string, string>;
  startedAt?: number;
  durationMs?: number;
  body?: Uint8Array | null;
  reportedSize?: number;
  captureWarning?: string;
  manualOverride?: boolean;
  protocolOverride?: ProtocolId;
}): CapturedItem {
  const responseHeaders = normalizeHeaders(init.responseHeaders);
  const requestHeaders = normalizeHeaders(init.requestHeaders);
  const mimeType = init.mimeType || responseHeaders['content-type'] || '';
  const classification = classifyTraffic({
    url: init.url,
    method: init.method,
    status: init.status,
    mimeType,
    headers: responseHeaders,
    requestHeaders,
  });
  const { displayPath, host } = parseUrlParts(init.url);
  const body = init.body ?? null;

  return {
    id: init.id,
    source: init.source,
    url: init.url,
    displayPath,
    host,
    method: (init.method || (init.source === 'file' ? 'FILE' : 'GET')).toUpperCase(),
    status: init.status ?? 200,
    mimeType,
    responseHeaders,
    requestHeaders,
    startedAt: init.startedAt ?? Date.now(),
    durationMs: init.durationMs,
    classification,
    manualOverride: init.manualOverride ?? init.source === 'file',
    protocolOverride: init.protocolOverride ?? 'auto',
    body,
    reportedSize: body ? body.byteLength : (init.reportedSize ?? 0),
    captureWarning: init.captureWarning,
  };
}

/**
 * Runs Layer 2 (protocol framing + decompression) followed by Layer 3
 * (recursive OmniBuf tree decoding) across all message envelopes in `item`.
 */
export async function inspectCapturedItem(item: CapturedItem): Promise<InspectedTrafficResult> {
  const rawBody = item.body ?? new Uint8Array(0);
  const extraction = await extractProtocolEnvelopes(rawBody, item.protocolOverride, {
    url: item.url,
    method: item.method,
    status: item.status,
    mimeType: item.mimeType,
    headers: item.responseHeaders,
    requestHeaders: item.requestHeaders,
  });

  const warnings = [...extraction.warnings];
  if (item.captureWarning) {
    warnings.unshift(item.captureWarning);
  }

  const envelopes: InspectedEnvelopeView[] = extraction.envelopes.map((env) => {
    if (env.kind !== 'message') {
      return { envelope: env, decoded: null, decodeError: env.error };
    }
    if (env.error) {
      return { envelope: env, decoded: null, decodeError: env.error };
    }
    if (env.payload.byteLength === 0) {
      return {
        envelope: env,
        decoded: {
          byteLength: 0,
          schemaMeta: null,
          nodes: [],
          jsonValue: {},
          jsonText: '{}',
          fieldCount: 0,
        },
      };
    }
    try {
      const decoded = decodeOmniBufTree(env.payload, {
        wireBaseOffset: env.uncompressedWirePayloadOffset,
      });
      return { envelope: env, decoded };
    } catch (err) {
      return {
        envelope: env,
        decoded: null,
        decodeError: err instanceof Error ? err.message : String(err),
      };
    }
  });

  return {
    protocol: extraction.protocol,
    envelopes,
    warnings,
  };
}

export function formatEndStreamSummary(endStream?: ConnectEndStreamBody): string {
  if (!endStream) return 'EndStream {}';
  if (endStream.error) {
    const code = endStream.error.code || 'unknown';
    const msg = endStream.error.message ? `: ${endStream.error.message}` : '';
    return `error (${code})${msg}`;
  }
  const metaKeys = endStream.metadata ? Object.keys(endStream.metadata) : [];
  if (metaKeys.length > 0) {
    return `${metaKeys.length} ${metaKeys.length === 1 ? 'header' : 'headers'}`;
  }
  return 'OK';
}
