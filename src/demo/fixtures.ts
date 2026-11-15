import { defineMessage, uint8ArrayToBase64 } from '@omnibuf/core';
import { type CapturedItem, createCapturedItem } from '../inspector.js';

const PeerLocation = defineMessage<{
  city: string;
  metro_code: string;
  rack_unit: number;
  latitude: number;
  longitude: number;
}>('routing.v1.PeerLocation', {
  city: { fieldNum: 1, type: 'string' },
  metro_code: { fieldNum: 2, type: 'string' },
  rack_unit: { fieldNum: 3, type: 'uint32' },
  latitude: { fieldNum: 4, type: 'float64' },
  longitude: { fieldNum: 5, type: 'float64' },
});

const PeerUpdate = defineMessage<{
  asn: number;
  router_id: string;
  established: boolean;
  uptime_sec: bigint;
  rssi_dbm: number;
  cpu_load: number;
  location: {
    city: string;
    metro_code: string;
    rack_unit: number;
    latitude: number;
    longitude: number;
  };
  advertised_prefixes: string[];
  hop_latencies_us: number[];
  interface_rx_packets: Record<string, number>;
  bgp_cookie: Uint8Array;
}>('routing.v1.PeerUpdate', {
  asn: { fieldNum: 1, type: 'fixed32' },
  router_id: { fieldNum: 2, type: 'string' },
  established: { fieldNum: 3, type: 'bool' },
  uptime_sec: { fieldNum: 4, type: 'uint64' },
  rssi_dbm: { fieldNum: 5, type: 'sint32' },
  cpu_load: { fieldNum: 6, type: 'float32' },
  location: { fieldNum: 7, type: 'submsg', subSchema: PeerLocation },
  advertised_prefixes: { fieldNum: 8, type: 'string[]' },
  hop_latencies_us: { fieldNum: 9, type: 'uint32[]' },
  interface_rx_packets: { fieldNum: 10, type: 'map', mapKey: 'string', mapVal: 'uint32' },
  bgp_cookie: { fieldNum: 11, type: 'bytes' },
});

const TelemetrySample = defineMessage<{
  sequence: number;
  stream_key: string;
  queue_depth: number;
  drop_detected: boolean;
  bucket_counts: number[];
}>('telemetry.v1.Sample', {
  sequence: { fieldNum: 1, type: 'uint32' },
  stream_key: { fieldNum: 2, type: 'string' },
  queue_depth: { fieldNum: 3, type: 'sint32' },
  drop_detected: { fieldNum: 4, type: 'bool' },
  bucket_counts: { fieldNum: 5, type: 'uint32[]' },
});

function packEnvelope(flags: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength);
  out[0] = flags & 0xff;
  const len = payload.byteLength >>> 0;
  out[1] = (len >>> 24) & 0xff;
  out[2] = (len >>> 16) & 0xff;
  out[3] = (len >>> 8) & 0xff;
  out[4] = len & 0xff;
  out.set(payload, 5);
  return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    return bytes;
  }
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const writeDone = writer.write(copy).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await writeDone;
  return concatBytes(chunks);
}

/**
 * Generates clearly marked synthetic sample traffic covering all supported protocols,
 * self-describing (`Field #0`) and blind schema-less packets, compressed streaming envelopes,
 * gRPC-Web base64 text frames, `.obuf` static files, and manual octet-stream override.
 */
export async function buildSyntheticTrafficFixtures(): Promise<CapturedItem[]> {
  const now = Date.now();
  const utf8 = new TextEncoder();

  // 1. ConnectRPC Unary (Self-Describing PeerUpdate)
  const peerFra = PeerUpdate.encode(
    {
      asn: 64512,
      router_id: 'edge-fra-01.omnibuf.internal',
      established: true,
      uptime_sec: 1489204n,
      rssi_dbm: -48,
      cpu_load: 0.3125,
      location: {
        city: 'Frankfurt',
        metro_code: 'FRA',
        rack_unit: 18,
        latitude: 50.1109,
        longitude: 8.6821,
      },
      advertised_prefixes: ['2001:db8:400::/48', '198.51.100.0/24', '203.0.113.0/24'],
      hop_latencies_us: [140, 285, 412, 890],
      interface_rx_packets: {
        'et-0/0/0': 984120,
        'et-0/0/1': 412809,
      },
      bgp_cookie: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x26, 0x01, 0x04, 0x9a]),
    },
    { selfDescribing: true },
  );

  // 2. ConnectRPC Server-Streaming (3 gzipped message envelopes + EndStreamResponse metadata)
  const streamMsg0 = PeerUpdate.encode(
    {
      asn: 64512,
      router_id: 'edge-fra-01',
      established: true,
      uptime_sec: 1489210n,
      rssi_dbm: -47,
      cpu_load: 0.29,
      location: {
        city: 'Frankfurt',
        metro_code: 'FRA',
        rack_unit: 18,
        latitude: 50.1109,
        longitude: 8.6821,
      },
      advertised_prefixes: ['2001:db8:400::/48'],
      hop_latencies_us: [138, 281],
      interface_rx_packets: { 'et-0/0/0': 985004 },
      bgp_cookie: Uint8Array.from([0x01, 0x02, 0x03, 0x04]),
    },
    { selfDescribing: true },
  );
  const streamMsg1 = PeerUpdate.encode(
    {
      asn: 64513,
      router_id: 'edge-ams-02',
      established: true,
      uptime_sec: 902140n,
      rssi_dbm: -51,
      cpu_load: 0.44,
      location: {
        city: 'Amsterdam',
        metro_code: 'AMS',
        rack_unit: 7,
        latitude: 52.3676,
        longitude: 4.9041,
      },
      advertised_prefixes: ['2001:db8:800::/48', '192.0.2.0/24'],
      hop_latencies_us: [210, 334, 519],
      interface_rx_packets: { 'et-0/1/0': 641200, 'et-0/1/1': 128940 },
      bgp_cookie: Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]),
    },
    { selfDescribing: true },
  );
  const canGzip = typeof CompressionStream !== 'undefined';
  const env0Bytes = canGzip ? await gzipBytes(streamMsg0) : streamMsg0;
  const env1Bytes = streamMsg1; // Mix compressed and uncompressed envelopes in same stream
  const endStreamJson = utf8.encode(
    JSON.stringify({
      metadata: {
        'x-omnibuf-pop': ['fra-core-2'],
        'x-snapshot-epoch': ['1763222400'],
      },
    }),
  );
  const connectStreamBody = concatBytes([
    packEnvelope(canGzip ? 0x01 : 0x00, env0Bytes),
    packEnvelope(0x00, env1Bytes),
    packEnvelope(0x02, endStreamJson),
  ]);

  // 3. Plain HTTP / REST Raw OmniBuf (Schema-less blind wire mode: no Field #0)
  const blindPacket = TelemetrySample.encode(
    {
      sequence: 48291,
      stream_key: 'ingress.quic.eu-central',
      queue_depth: -12,
      drop_detected: false,
      bucket_counts: [1204, 982, 411, 64, 3],
    },
    { selfDescribing: false },
  );

  // 4. Static .obuf snapshot URL
  const obufSnapshot = TelemetrySample.encode(
    {
      sequence: 9001,
      stream_key: 'archive.capture.2026-11-15',
      queue_depth: 4,
      drop_detected: true,
      bucket_counts: [512, 256, 128, 64],
    },
    { selfDescribing: true },
  );

  // 5. gRPC-Web Text (multi-segment base64 data frame + 0x80 trailer frame)
  const grpcDataFrame = packEnvelope(0x00, blindPacket);
  const grpcTrailerFrame = packEnvelope(
    0x80,
    utf8.encode('grpc-status: 0\r\ngrpc-message: OK\r\nx-trace-id: 7f9c2104b8e2\r\n'),
  );
  const grpcTextBody = utf8.encode(
    uint8ArrayToBase64(grpcDataFrame) + uint8ArrayToBase64(grpcTrailerFrame),
  );

  // 6. Untagged application/octet-stream HTTP response (demonstrates manual "Decode as OmniBuf")
  const untaggedBinary = TelemetrySample.encode(
    {
      sequence: 77,
      stream_key: 'untagged.edge.worker',
      queue_depth: 0,
      drop_detected: false,
      bucket_counts: [42, 19],
    },
    { selfDescribing: true },
  );

  return [
    createCapturedItem({
      id: 'synthetic-connect-unary',
      source: 'synthetic',
      url: 'https://synthetic.demo.local/routing.v1.PeerService/GetPeerUpdate',
      method: 'POST',
      status: 200,
      durationMs: 14,
      startedAt: now - 4200,
      responseHeaders: {
        'content-type': 'application/omnibuf',
        'connect-protocol-version': '1',
        'x-synthetic-fixture': 'true',
      },
      requestHeaders: {
        'content-type': 'application/omnibuf',
        'connect-protocol-version': '1',
      },
      body: peerFra,
    }),
    createCapturedItem({
      id: 'synthetic-connect-stream',
      source: 'synthetic',
      url: 'https://synthetic.demo.local/routing.v1.PeerService/WatchPeers',
      method: 'POST',
      status: 200,
      durationMs: 68,
      startedAt: now - 3100,
      responseHeaders: {
        'content-type': 'application/connect+omnibuf',
        'connect-content-encoding': 'gzip',
        'x-synthetic-fixture': 'true',
      },
      body: connectStreamBody,
    }),
    createCapturedItem({
      id: 'synthetic-rest-blind',
      source: 'synthetic',
      url: 'https://synthetic.demo.local/api/v1/telemetry/latest',
      method: 'GET',
      status: 200,
      durationMs: 6,
      startedAt: now - 2200,
      responseHeaders: {
        'content-type': 'application/x-omnibuf',
        'x-synthetic-fixture': 'true',
      },
      body: blindPacket,
    }),
    createCapturedItem({
      id: 'synthetic-obuf-file-url',
      source: 'synthetic',
      url: 'https://synthetic.demo.local/captures/ingress-2026-11-15.obuf?region=eu',
      method: 'GET',
      status: 200,
      durationMs: 9,
      startedAt: now - 1500,
      responseHeaders: {
        'content-type': 'application/octet-stream',
        'x-synthetic-fixture': 'true',
      },
      body: obufSnapshot,
    }),
    createCapturedItem({
      id: 'synthetic-grpc-web-text',
      source: 'synthetic',
      url: 'https://synthetic.demo.local/telemetry.v1.Collector/QuerySample',
      method: 'POST',
      status: 200,
      durationMs: 19,
      startedAt: now - 900,
      responseHeaders: {
        'content-type': 'application/grpc-web-text+omnibuf',
        'x-synthetic-fixture': 'true',
      },
      body: grpcTextBody,
    }),
    createCapturedItem({
      id: 'synthetic-untagged-octet',
      source: 'synthetic',
      url: 'https://synthetic.demo.local/debug/raw-worker-dump',
      method: 'POST',
      status: 200,
      durationMs: 4,
      startedAt: now - 300,
      responseHeaders: {
        'content-type': 'application/octet-stream',
        'x-synthetic-fixture': 'true',
      },
      body: untaggedBinary,
    }),
  ];
}
