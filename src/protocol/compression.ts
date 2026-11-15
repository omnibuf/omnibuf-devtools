const DEFAULT_MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024; // 32 MiB cap

export type SupportedCompression = 'identity' | 'gzip' | 'deflate' | 'deflate-raw';

export function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function runDecompressionStream(
  bytes: Uint8Array,
  format: 'gzip' | 'deflate' | 'deflate-raw',
  maxBytes: number,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(`DecompressionStream('${format}') is unavailable in this runtime`);
  }
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // Attach error handler to write promise so corrupt payloads surface via reader.read()
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const writePromise = writer
    .write(copy)
    .then(() => writer.close())
    .catch(() => undefined);

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel('Decompressed payload exceeds safety limit');
          throw new Error(
            `Decompressed payload exceeds maximum size (${maxBytes.toLocaleString()} bytes)`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    await writePromise;
  }

  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

/**
 * Decompresses an envelope or body payload using standard Web `DecompressionStream`.
 * For `deflate`, falls back to `deflate-raw` if RFC 1950 zlib header validation fails.
 */
export async function decompressPayload(
  bytes: Uint8Array,
  encoding: string | undefined,
  maxBytes = DEFAULT_MAX_DECOMPRESSED_BYTES,
): Promise<Uint8Array> {
  const norm = (encoding ?? 'identity').trim().toLowerCase();
  if (!norm || norm === 'identity' || norm === 'none') {
    return bytes;
  }
  if (norm === 'gzip' || norm === 'x-gzip') {
    return runDecompressionStream(bytes, 'gzip', maxBytes);
  }
  if (norm === 'deflate') {
    try {
      return await runDecompressionStream(bytes, 'deflate', maxBytes);
    } catch {
      return runDecompressionStream(bytes, 'deflate-raw', maxBytes);
    }
  }
  if (norm === 'deflate-raw') {
    return runDecompressionStream(bytes, 'deflate-raw', maxBytes);
  }
  throw new Error(
    `Unsupported compression encoding "${encoding}" (supported: gzip, deflate, identity)`,
  );
}
