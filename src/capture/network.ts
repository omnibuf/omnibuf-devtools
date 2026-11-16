import { type CapturedItem, createCapturedItem } from '../inspector.js';
import {
  type DecodeCapturedContentHints,
  type HeaderPair,
  decodeCapturedContent,
  normalizeHeaders,
} from '../protocol/detect.js';

interface DevToolsHarEntry {
  startedDateTime?: string;
  time?: number;
  request?: {
    method?: string;
    url?: string;
    headers?: HeaderPair[];
  };
  response?: {
    status?: number;
    headers?: HeaderPair[];
    content?: {
      size?: number;
      mimeType?: string;
      text?: string;
      encoding?: string;
    };
    _transferSize?: number;
  };
  getContent?: (callback: (content: string | null, encoding: string) => void) => void;
}

interface DevToolsNetworkApi {
  onRequestFinished: {
    addListener(callback: (request: DevToolsHarEntry) => void): void;
    removeListener(callback: (request: DevToolsHarEntry) => void): void;
  };
  onNavigated: {
    addListener(callback: (url: string) => void): void;
    removeListener(callback: (url: string) => void): void;
  };
  getHAR?: (callback: (harLog: { entries?: DevToolsHarEntry[] }) => void) => void;
}

function getDevToolsNetworkApi(): DevToolsNetworkApi | null {
  const g = globalThis as Record<string, any>;
  if (g.chrome?.devtools?.network) {
    return g.chrome.devtools.network as DevToolsNetworkApi;
  }
  if (g.browser?.devtools?.network) {
    return g.browser.devtools.network as DevToolsNetworkApi;
  }
  return null;
}

export function getDevToolsThemeName(): 'dark' | 'light' {
  const g = globalThis as Record<string, any>;
  const raw = g.chrome?.devtools?.panels?.themeName ?? g.browser?.devtools?.panels?.themeName;
  return raw === 'dark' ? 'dark' : 'light';
}

export function isRunningInDevTools(): boolean {
  return getDevToolsNetworkApi() !== null;
}

export interface NetworkCaptureCallbacks {
  onItemCaptured(item: CapturedItem, loadBody: () => Promise<void>): void;
  onItemUpdated(item: CapturedItem): void;
  onNavigated(url: string): void;
}

let nextSeq = 1;

function buildDecodeHints(entry: DevToolsHarEntry): DecodeCapturedContentHints {
  const headers = normalizeHeaders(entry.response?.headers);
  const rawCl = headers['content-length'];
  const clNum = rawCl !== undefined && rawCl !== '' ? Number(rawCl) : Number.NaN;
  const contentEncoding = (headers['content-encoding'] ?? '').trim().toLowerCase();
  const hasTransportCompression = Boolean(contentEncoding && contentEncoding !== 'identity');
  const expectedByteLength =
    !hasTransportCompression && Number.isFinite(clNum) && clNum >= 0
      ? clNum
      : entry.response?.content?.size;
  return {
    harEncoding: entry.response?.content?.encoding,
    mimeType: entry.response?.content?.mimeType || headers['content-type'],
    expectedByteLength,
  };
}

function readEntryBody(entry: DevToolsHarEntry): Promise<{ bytes: Uint8Array; warning?: string }> {
  const hints = buildDecodeHints(entry);
  return new Promise((resolve) => {
    if (typeof entry.getContent === 'function') {
      try {
        const g = globalThis as Record<string, any>;
        const usePromiseForm =
          !g.chrome?.devtools?.network && Boolean(g.browser?.devtools?.network);
        if (usePromiseForm) {
          (entry.getContent as unknown as () => Promise<[string | null, string]>)()
            .then(([content, encoding]) => {
              resolve(decodeCapturedContent(content, encoding, hints));
            })
            .catch((err: unknown) => {
              resolve({
                bytes: new Uint8Array(0),
                warning: `getContent() failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            });
          return;
        }

        const maybePromise: unknown = entry.getContent((content, encoding) => {
          resolve(decodeCapturedContent(content, encoding, hints));
        });
        if (
          maybePromise &&
          typeof (maybePromise as Promise<[string | null, string]>).then === 'function'
        ) {
          (maybePromise as Promise<[string | null, string]>)
            .then(([content, encoding]) => {
              resolve(decodeCapturedContent(content, encoding, hints));
            })
            .catch((err: unknown) => {
              resolve({
                bytes: new Uint8Array(0),
                warning: `getContent() failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            });
        }
        return;
      } catch (err) {
        resolve({
          bytes: new Uint8Array(0),
          warning: `getContent() threw: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }

    const harText = entry.response?.content?.text;
    const harEnc = entry.response?.content?.encoding;
    resolve(decodeCapturedContent(harText ?? null, harEnc ?? '', hints));
  });
}

/**
 * Attaches to `chrome.devtools.network` / `browser.devtools.network` when running
 * inside browser Developer Tools. Returns a cleanup function.
 */
export function startNetworkCapture(callbacks: NetworkCaptureCallbacks): () => void {
  const api = getDevToolsNetworkApi();
  if (!api) {
    return () => undefined;
  }

  const ingestEntry = (entry: DevToolsHarEntry): void => {
    const url = entry.request?.url ?? '';
    if (!url || url.startsWith('data:') || url.startsWith('chrome-extension:')) {
      return;
    }
    const id = `net-${nextSeq++}`;
    const startedAt = entry.startedDateTime ? Date.parse(entry.startedDateTime) : Date.now();
    const reportedSize = Math.max(
      0,
      entry.response?.content?.size ?? entry.response?._transferSize ?? 0,
    );

    const item = createCapturedItem({
      id,
      source: 'network',
      url,
      method: entry.request?.method ?? 'GET',
      status: entry.response?.status ?? 0,
      mimeType: entry.response?.content?.mimeType ?? '',
      responseHeaders: entry.response?.headers ?? [],
      requestHeaders: entry.request?.headers ?? [],
      startedAt: Number.isNaN(startedAt) ? Date.now() : startedAt,
      durationMs: typeof entry.time === 'number' ? Math.round(entry.time) : undefined,
      reportedSize,
      body: null,
    });

    let loadingPromise: Promise<void> | null = null;
    const loadBody = (): Promise<void> => {
      if (item.body !== null) return Promise.resolve();
      if (loadingPromise) return loadingPromise;
      loadingPromise = readEntryBody(entry).then(({ bytes, warning }) => {
        item.body = bytes;
        item.reportedSize = bytes.byteLength;
        if (warning) item.captureWarning = warning;
        callbacks.onItemUpdated(item);
      });
      return loadingPromise;
    };

    callbacks.onItemCaptured(item, loadBody);

    // Eagerly fetch body for auto-detected OmniBuf responses so size & tree are instant
    if (item.classification.detected) {
      void loadBody();
    }
  };

  const handleRequestFinished = (request: DevToolsHarEntry): void => {
    ingestEntry(request);
  };

  const handleNavigated = (url: string): void => {
    callbacks.onNavigated(url);
  };

  api.onRequestFinished.addListener(handleRequestFinished);
  api.onNavigated.addListener(handleNavigated);

  if (typeof api.getHAR === 'function') {
    try {
      api.getHAR((harLog) => {
        if (Array.isArray(harLog?.entries)) {
          for (const entry of harLog.entries) {
            ingestEntry(entry);
          }
        }
      });
    } catch {
      // Ignore if browser rejects initial HAR snapshot
    }
  }

  return () => {
    api.onRequestFinished.removeListener(handleRequestFinished);
    api.onNavigated.removeListener(handleNavigated);
  };
}
