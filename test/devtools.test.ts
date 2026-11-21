import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { defineMessage, uint8ArrayToBase64 } from '@omnibuf/core';
import { decodeOmniBufTree, findNodeAtByteOffset, formatDecodedJson } from '../src/decoder/tree.js';
import { buildSyntheticTrafficFixtures } from '../src/demo/fixtures.js';
import { createCapturedItem, inspectCapturedItem } from '../src/inspector.js';
import { extractProtocolEnvelopes } from '../src/protocol/adapters.js';
import {
  classifyTraffic,
  decodeCapturedContent,
  decodeMultiSegmentBase64,
  hasObufExtension,
  isOmniBufMediaType,
} from '../src/protocol/detect.js';

function packBeEnvelope(flags: number, payload: Uint8Array): Uint8Array {
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

const NestedChild = defineMessage<{
  city: string;
  rack: number;
}>('test.v1.NestedChild', {
  city: { fieldNum: 1, type: 'string' },
  rack: { fieldNum: 2, type: 'uint32' },
});

const ComplexRoot = defineMessage<{
  id: bigint;
  name: string;
  active: boolean;
  child: { city: string; rack: number };
  ports: number[];
  labels: Record<string, string>;
}>('test.v1.ComplexRoot', {
  id: { fieldNum: 1, type: 'uint64' },
  name: { fieldNum: 2, type: 'string' },
  active: { fieldNum: 3, type: 'bool' },
  child: { fieldNum: 4, type: 'submsg', subSchema: NestedChild },
  ports: { fieldNum: 5, type: 'uint32[]' },
  labels: { fieldNum: 6, type: 'map', mapKey: 'string', mapVal: 'string' },
});

describe('Layer 1: Content-Type, URL extension, and DevTools capture decoding', () => {
  it('recognizes OmniBuf media types and rejects ordinary Protobuf media types', () => {
    assert.equal(isOmniBufMediaType('application/omnibuf'), true);
    assert.equal(isOmniBufMediaType('application/x-omnibuf; charset=binary'), true);
    assert.equal(isOmniBufMediaType('application/vnd.omnibuf'), true);
    assert.equal(isOmniBufMediaType('application/connect+omnibuf'), true);
    assert.equal(isOmniBufMediaType('application/grpc-web+omnibuf'), true);
    assert.equal(isOmniBufMediaType('application/grpc-web-text+x-omnibuf'), true);

    assert.equal(isOmniBufMediaType('application/proto'), false);
    assert.equal(isOmniBufMediaType('application/x-protobuf'), false);
    assert.equal(isOmniBufMediaType('application/connect+proto'), false);
    assert.equal(isOmniBufMediaType('application/grpc-web+proto'), false);
    assert.equal(isOmniBufMediaType('application/octet-stream'), false);
  });

  it('detects .obuf and .obuf.gz URL paths while ignoring query strings and hashes', () => {
    assert.equal(hasObufExtension('https://cdn.example.com/snapshots/peer.obuf?v=2#top'), true);
    assert.equal(hasObufExtension('/local/dump.OBUF.GZ?download=1'), true);
    assert.equal(hasObufExtension('https://cdn.example.com/api/data.json?ext=.obuf'), false);
  });

  it('classifies raw HTTP, Connect unary, Connect unary errors, Connect streaming, and gRPC-Web', () => {
    const raw = classifyTraffic({
      url: 'https://api.example.com/v1/peers',
      headers: { 'Content-Type': 'application/x-omnibuf' },
    });
    assert.equal(raw.detected, true);
    assert.equal(raw.protocol, 'raw');

    const connectUnary = classifyTraffic({
      url: 'https://api.example.com/routing.v1.PeerService/GetPeer',
      headers: {
        'Content-Type': 'application/omnibuf',
        'Connect-Protocol-Version': '1',
      },
    });
    assert.equal(connectUnary.detected, true);
    assert.equal(connectUnary.protocol, 'connect-unary');

    const connectErr = classifyTraffic({
      url: 'https://api.example.com/routing.v1.PeerService/GetPeer',
      status: 404,
      headers: { 'Content-Type': 'application/json' },
      requestHeaders: { 'Content-Type': 'application/omnibuf' },
    });
    assert.equal(connectErr.detected, true);
    assert.equal(connectErr.protocol, 'connect-unary');
    assert.equal(connectErr.isConnectUnaryError, true);

    const connectStream = classifyTraffic({
      url: 'https://api.example.com/routing.v1.PeerService/Watch',
      headers: { 'Content-Type': 'application/connect+omnibuf' },
    });
    assert.equal(connectStream.detected, true);
    assert.equal(connectStream.protocol, 'connect-streaming');

    const grpcText = classifyTraffic({
      url: 'https://api.example.com/routing.v1.PeerService/Watch',
      headers: { 'Content-Type': 'application/grpc-web-text+omnibuf' },
    });
    assert.equal(grpcText.detected, true);
    assert.equal(grpcText.protocol, 'grpc-web-text');
  });

  it('decodes getContent base64, multi-segment base64, Latin-1, and flags U+FFFD replacement', () => {
    const sample = Uint8Array.from([0x19, 0x00, 0xff, 0x80, 0x42]);
    const fromB64 = decodeCapturedContent(uint8ArrayToBase64(sample), 'base64');
    assert.deepEqual(fromB64.bytes, sample);
    assert.equal(fromB64.warning, undefined);

    const latin1 = String.fromCharCode(...sample);
    const fromLatin = decodeCapturedContent(latin1, '');
    assert.deepEqual(fromLatin.bytes, sample);
    assert.equal(fromLatin.warning, undefined);

    const mangled = decodeCapturedContent('abc\ufffddef', '');
    assert.ok(mangled.warning?.includes('U+FFFD'));

    // Multi-segment base64 where padding '=' appears mid-stream
    const segA = Uint8Array.from([1, 2, 3, 4]); // 4 bytes -> 'AQIDBA=='
    const segB = Uint8Array.from([5, 6, 7, 8, 9]); // 5 bytes -> 'BQYHCAk='
    const combinedB64 = uint8ArrayToBase64(segA) + uint8ArrayToBase64(segB);
    assert.ok(combinedB64.includes('=='));
    assert.deepEqual(
      decodeMultiSegmentBase64(combinedB64),
      Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );

    // Firefox WebExtensions quirk: getContent(content, mimeType) passes MIME type as 2nd arg
    // while base64-encoding binary responses (e.g. 720 raw bytes -> 960 base64 chars)
    const raw720 = new Uint8Array(720);
    for (let i = 0; i < raw720.length; i++) raw720[i] = (i * 37 + 0x19) & 0xff;
    const b64Of720 = uint8ArrayToBase64(raw720);
    assert.equal(b64Of720.length, 960);

    const ffMime = decodeCapturedContent(b64Of720, 'application/omnibuf');
    assert.equal(ffMime.bytes.byteLength, 720);
    assert.deepEqual(ffMime.bytes, raw720);

    const ffEmptyEncWithLength = decodeCapturedContent(b64Of720, '', {
      mimeType: 'application/omnibuf',
      expectedByteLength: 720,
    });
    assert.equal(ffEmptyEncWithLength.bytes.byteLength, 720);
    assert.deepEqual(ffEmptyEncWithLength.bytes, raw720);

    // Firefox JSON error body with MIME type as 2nd arg stays plain UTF-8 text
    const jsonText = '{"code":"not_found","message":"unknown route"}';
    const ffJson = decodeCapturedContent(jsonText, 'application/json');
    assert.equal(new TextDecoder().decode(ffJson.bytes), jsonText);
  });
});

describe('Layer 2: Protocol framing and envelope compression adapters', () => {
  const pktA = NestedChild.encode({ city: 'Zurich', rack: 11 }, { selfDescribing: true });
  const pktB = NestedChild.encode({ city: 'Tokyo', rack: 22 }, { selfDescribing: false });

  it('handles Connect unary uncompressed, gzipped, already-decompressed HAR, and JSON errors', async () => {
    // 1. Gzipped wire payload with connect-content-encoding: gzip
    const gz = new Uint8Array(gzipSync(pktA));
    const resGz = await extractProtocolEnvelopes(gz, 'connect-unary', {
      status: 200,
      headers: {
        'content-type': 'application/omnibuf',
        'connect-content-encoding': 'gzip',
      },
    });
    assert.equal(resGz.envelopes.length, 1);
    assert.equal(resGz.envelopes[0]!.compressed, true);
    assert.deepEqual(resGz.envelopes[0]!.payload, pktA);

    // 2. Chrome HAR getContent() already decompressed HTTP Content-Encoding: gzip
    const resHar = await extractProtocolEnvelopes(pktA, 'connect-unary', {
      status: 200,
      headers: {
        'content-type': 'application/omnibuf',
        'content-encoding': 'gzip',
      },
    });
    assert.equal(resHar.envelopes.length, 1);
    assert.equal(resHar.envelopes[0]!.compressed, false);
    assert.deepEqual(resHar.envelopes[0]!.payload, pktA);

    // 3. Connect unary JSON error
    const errBytes = new TextEncoder().encode(
      JSON.stringify({ code: 'permission_denied', message: 'token expired' }),
    );
    const resErr = await extractProtocolEnvelopes(errBytes, 'connect-unary', {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(resErr.envelopes[0]!.kind, 'error-json');
    assert.equal(resErr.envelopes[0]!.endStream?.error?.code, 'permission_denied');
  });

  it('splits Connect streaming envelopes, decompresses gzip/deflate, and parses EndStreamResponse', async () => {
    const gzA = new Uint8Array(gzipSync(pktA));
    const endJson = new TextEncoder().encode(
      JSON.stringify({
        metadata: { 'x-pop': ['zrh-1'] },
        error: { code: 'canceled', message: 'client closed' },
      }),
    );
    const stream = new Uint8Array(5 + gzA.length + 5 + pktB.length + 5 + endJson.length);
    let off = 0;
    for (const part of [
      packBeEnvelope(0x01, gzA),
      packBeEnvelope(0x00, pktB),
      packBeEnvelope(0x02, endJson),
    ]) {
      stream.set(part, off);
      off += part.byteLength;
    }

    const res = await extractProtocolEnvelopes(stream, 'connect-streaming', {
      headers: {
        'content-type': 'application/connect+omnibuf',
        'connect-content-encoding': 'gzip',
      },
    });
    assert.equal(res.warnings.length, 0);
    assert.equal(res.envelopes.length, 3);

    assert.equal(res.envelopes[0]!.kind, 'message');
    assert.equal(res.envelopes[0]!.compressed, true);
    assert.equal(res.envelopes[0]!.uncompressedWirePayloadOffset, null);
    assert.deepEqual(res.envelopes[0]!.payload, pktA);

    assert.equal(res.envelopes[1]!.kind, 'message');
    assert.equal(res.envelopes[1]!.compressed, false);
    assert.equal(res.envelopes[1]!.uncompressedWirePayloadOffset, 5 + gzA.length + 5);
    assert.deepEqual(res.envelopes[1]!.payload, pktB);

    assert.equal(res.envelopes[2]!.kind, 'end-stream');
    assert.equal(res.envelopes[2]!.endStream?.error?.code, 'canceled');
    assert.deepEqual(res.envelopes[2]!.endStream?.metadata?.['x-pop'], ['zrh-1']);

    // Deflate (RFC 1950 zlib-wrapped and raw deflate) compression check
    const deflated = new Uint8Array(deflateSync(pktA));
    const deflateStream = packBeEnvelope(0x01, deflated);
    const resDeflate = await extractProtocolEnvelopes(deflateStream, 'connect-streaming', {
      headers: { 'connect-content-encoding': 'deflate' },
    });
    assert.deepEqual(resDeflate.envelopes[0]!.payload, pktA);

    const rawDeflated = new Uint8Array(deflateRawSync(pktB));
    const rawDeflateStream = packBeEnvelope(0x01, rawDeflated);
    const resRawDeflate = await extractProtocolEnvelopes(rawDeflateStream, 'connect-streaming', {
      headers: { 'connect-content-encoding': 'deflate' },
    });
    assert.deepEqual(resRawDeflate.envelopes[0]!.payload, pktB);
  });

  it('retains earlier Connect streaming messages when a trailing frame is truncated', async () => {
    const valid = packBeEnvelope(0x00, pktA);
    const truncated = Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x20, 0xaa, 0xbb]);
    const combined = new Uint8Array(valid.length + truncated.length);
    combined.set(valid, 0);
    combined.set(truncated, valid.length);

    const res = await extractProtocolEnvelopes(combined, 'connect-streaming');
    assert.equal(res.envelopes.length, 2);
    assert.equal(res.envelopes[0]!.error, undefined);
    assert.deepEqual(res.envelopes[0]!.payload, pktA);
    assert.ok(res.envelopes[1]!.error?.includes('Truncated Connect envelope #1'));
  });

  it('unpacks gRPC-Web binary and multi-segment grpc-web-text frames with percent-decoded trailers', async () => {
    const dataFrame = packBeEnvelope(0x00, pktA);
    const trailerFrame = packBeEnvelope(
      0x80,
      new TextEncoder().encode('grpc-status: 14\r\ngrpc-message: upstream%20unavailable\r\n'),
    );
    const textPayload = new TextEncoder().encode(
      uint8ArrayToBase64(dataFrame) + uint8ArrayToBase64(trailerFrame),
    );

    const res = await extractProtocolEnvelopes(textPayload, 'grpc-web-text', {
      headers: { 'content-type': 'application/grpc-web-text+omnibuf' },
    });
    assert.equal(res.warnings.length, 0);
    assert.equal(res.envelopes.length, 2);
    assert.deepEqual(res.envelopes[0]!.payload, pktA);
    assert.equal(res.envelopes[1]!.kind, 'trailers');
    assert.equal(res.envelopes[1]!.trailers?.['grpc-status'], '14');
    assert.equal(res.envelopes[1]!.trailers?.['grpc-message'], 'upstream unavailable');
  });
});

describe('Layer 3: Recursive OmniBuf field tree, byte offsets, and JSON export', () => {
  it('builds a complete byte-accurate tree with Field #0 schema resolution and 64-bit BigInt JSON safety', () => {
    const largeId = 9007199254740999n; // > Number.MAX_SAFE_INTEGER
    const pkt = ComplexRoot.encode(
      {
        id: largeId,
        name: 'core-router',
        active: true,
        child: { city: 'Berlin', rack: 9 },
        ports: [80, 443, 8443],
        labels: { env: 'prod', tier: 'edge' },
      },
      { selfDescribing: true, deterministic: true },
    );

    const decoded = decodeOmniBufTree(pkt, { wireBaseOffset: 5 });
    assert.equal(decoded.byteLength, pkt.byteLength);
    assert.equal(decoded.typeName, 'ComplexRoot');
    assert.equal(decoded.fieldCount, 6);

    // Top-level byte spans cover [0 .. pkt.byteLength) contiguously
    let cursor = 0;
    for (const node of decoded.nodes) {
      assert.equal(node.offset, cursor);
      assert.equal(node.wireOffset, 5 + cursor);
      cursor += node.byteLength;
    }
    assert.equal(cursor, pkt.byteLength);

    // Verify nested submsg, array, and map children carry resolved names & valid sub-offsets
    const childNode = decoded.nodes.find((n) => n.label === 'child');
    assert.ok(childNode);
    assert.equal(childNode.children.length, 2);
    assert.equal(childNode.children[0]!.label, 'city');
    assert.equal(childNode.children[1]!.label, 'rack');

    const portsNode = decoded.nodes.find((n) => n.label === 'ports');
    assert.ok(portsNode);
    assert.equal(portsNode.wireTypeLabel, 'array<uint>');
    assert.equal(portsNode.children.length, 3);
    assert.equal(portsNode.children[2]!.summary, '8443');

    const labelsNode = decoded.nodes.find((n) => n.label === 'labels');
    assert.ok(labelsNode);
    assert.equal(labelsNode.wireTypeLabel, 'map<string, string>');
    assert.equal(labelsNode.children.length, 2);

    // Every byte in the packet resolves to a valid FieldTreeNode via findNodeAtByteOffset
    for (let b = 0; b < pkt.byteLength; b++) {
      const hit = findNodeAtByteOffset(decoded.nodes, b, true);
      assert.ok(hit, `Expected node hit at byte ${b}`);
      assert.ok(b >= hit.node.offset && b < hit.node.offset + hit.node.byteLength);
    }

    // 64-bit integer > MAX_SAFE_INTEGER serializes losslessly as an exact unquoted JSON literal
    assert.ok(decoded.jsonText.includes('"id": 9007199254740999'));
    const parsedJson = JSON.parse(decoded.jsonText) as Record<string, unknown>;
    assert.equal(parsedJson.name, 'core-router');
    assert.deepEqual(parsedJson.ports, [80, 443, 8443]);
  });

  it('falls back to numbered field_<N> labels when no Field #0 SchemaMeta is embedded', () => {
    const blindPkt = NestedChild.encode({ city: 'Oslo', rack: 3 }, { selfDescribing: false });
    const decoded = decodeOmniBufTree(blindPkt);
    assert.equal(decoded.schemaMeta, null);
    assert.equal(decoded.nodes.length, 2);
    assert.equal(decoded.nodes[0]!.label, 'field_1');
    assert.equal(decoded.nodes[0]!.isSchemaResolved, false);
    assert.equal(decoded.nodes[1]!.label, 'field_2');
    assert.deepEqual(JSON.parse(formatDecodedJson(decoded.jsonValue)), {
      field_1: 'Oslo',
      field_2: 3,
    });
  });

  it('supports manual Decode as OmniBuf override on untagged application/octet-stream responses', async () => {
    const rawBytes = NestedChild.encode({ city: 'Vienna', rack: 14 }, { selfDescribing: true });
    const item = createCapturedItem({
      id: 'manual-1',
      source: 'network',
      url: 'https://api.example.com/v1/raw-dump',
      method: 'POST',
      status: 200,
      responseHeaders: { 'content-type': 'application/octet-stream' },
      body: rawBytes,
    });
    assert.equal(item.classification.detected, false);
    assert.equal(item.manualOverride, false);

    item.manualOverride = true;
    const inspected = await inspectCapturedItem(item);
    assert.equal(inspected.protocol, 'raw');
    assert.equal(inspected.envelopes.length, 1);
    assert.deepEqual(JSON.parse(inspected.envelopes[0]!.decoded!.jsonText), {
      city: 'Vienna',
      rack: 14,
    });
  });

  it('inspects all synthetic demo fixtures end-to-end', async () => {
    const fixtures = await buildSyntheticTrafficFixtures();
    assert.equal(fixtures.length, 6);

    for (const item of fixtures) {
      item.manualOverride = true;
      const result = await inspectCapturedItem(item);
      assert.equal(result.warnings.length, 0);
      assert.ok(result.envelopes.length >= 1);
      const msgEnvs = result.envelopes.filter((e) => e.envelope.kind === 'message');
      assert.ok(msgEnvs.length >= 1);
      for (const m of msgEnvs) {
        assert.equal(m.decodeError, undefined);
        assert.ok(m.decoded && m.decoded.nodes.length >= 1);
      }
    }
  });
});

describe('Store packaging: Chrome Web Store and Firefox AMO compliance', () => {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  it('validates manifest constraints and emits separate Chrome, Firefox, and AMO source zips', () => {
    const rawManifest = JSON.parse(
      readFileSync(path.join(rootDir, 'public', 'manifest.json'), 'utf8'),
    );
    assert.equal(rawManifest.manifest_version, 3);
    assert.equal(rawManifest.permissions, undefined);
    assert.equal(rawManifest.host_permissions, undefined);
    assert.ok(rawManifest.description.length <= 132);
    assert.deepEqual(rawManifest.browser_specific_settings?.gecko?.data_collection_permissions, {
      required: ['none'],
    });

    if (!existsSync(path.join(rootDir, 'dist', 'manifest.json'))) {
      execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: rootDir });
    }

    execFileSync(process.execPath, ['scripts/pack.mjs'], {
      cwd: rootDir,
      env: { ...process.env, RELEASE_VERSION: 'v0.2.3' },
    });

    const chromeZip = path.join(rootDir, 'artifacts', 'omnibuf-devtools-chrome.zip');
    const firefoxZip = path.join(rootDir, 'artifacts', 'omnibuf-devtools-firefox.zip');
    const sourceZip = path.join(rootDir, 'artifacts', 'omnibuf-devtools-source.zip');
    assert.equal(existsSync(chromeZip), true);
    assert.equal(existsSync(firefoxZip), true);
    assert.equal(existsSync(sourceZip), true);

    const chromeManifest = JSON.parse(
      execFileSync('unzip', ['-p', chromeZip, 'manifest.json'], { encoding: 'utf8' }),
    );
    assert.equal(chromeManifest.version, '0.2.3');
    assert.equal(chromeManifest.browser_specific_settings, undefined);

    const chromeEntries = execFileSync('unzip', ['-Z1', chromeZip], { encoding: 'utf8' });
    assert.equal(chromeEntries.includes('.map'), false);

    const firefoxManifest = JSON.parse(
      execFileSync('unzip', ['-p', firefoxZip, 'manifest.json'], { encoding: 'utf8' }),
    );
    assert.equal(firefoxManifest.version, '0.2.3');
    assert.equal(firefoxManifest.browser_specific_settings?.gecko?.id, 'devtools@omnibuf.com');
    assert.deepEqual(
      firefoxManifest.browser_specific_settings?.gecko?.data_collection_permissions,
      { required: ['none'] },
    );

    // Restore default manifest version in artifacts/
    execFileSync(process.execPath, ['scripts/pack.mjs'], { cwd: rootDir });
  });
});
