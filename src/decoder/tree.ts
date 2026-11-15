import {
  MaxNestingDepth,
  type SchemaMeta,
  WireArray,
  WireBoolFalse,
  WireBoolTrue,
  WireBytes,
  WireExtended,
  WireFixed32,
  WireFixed64,
  WireFloat32,
  WireFloat64,
  WireMap,
  WireSfixed32,
  WireSfixed64,
  WireSint,
  WireString,
  WireSubMsg,
  WireUint,
  decodeBlind,
  decodeSchemaMeta,
  decodeUTF8,
  decodeVarintAuto,
  decodeVarintBigInt,
  decodeZigZagAuto,
  float32FromBits,
  float64FromBits,
  mergeSchemaMeta,
  parseArrayHeader,
  parseMapHeader,
  readField0SchemaMeta,
  readLenSlice,
  roundFloat32Shortest,
  setStringCodec,
  uint8ArrayToBase64,
} from '@omnibuf/core';
import { BrowserStringCodec, toHex, wireTypeName } from '@omnibuf/web';

setStringCodec(BrowserStringCodec);

export type FieldNodeKind = 'field' | 'schema' | 'array-element' | 'map-entry';

export type ByteSegmentRole = 'tag' | 'header' | 'payload';

export interface FieldTreeNode {
  id: string;
  kind: FieldNodeKind;
  fieldNumber: number | null;
  label: string;
  isSchemaResolved: boolean;
  wireType: number;
  wireTypeLabel: string;
  /** Start byte offset relative to the decoded OmniBuf message */
  offset: number;
  /** Length of the field tag in bytes (`0` for array elements and map entries) */
  tagLength: number;
  /** Length of container framing header in bytes (`ByteLen` + array/map type-count header) */
  headerLength: number;
  /** Total byte span `[offset .. offset + byteLength)` */
  byteLength: number;
  /** Absolute offset in the outer wire payload when uncompressed, otherwise `null` */
  wireOffset: number | null;
  /** Compact inline preview string for tree rows */
  summary: string;
  /** Raw hex preview (up to 64 bytes) */
  hexPreview: string;
  /** Leaf value for copy/inspection */
  scalarValue?: string | number | bigint | boolean | Uint8Array | null;
  children: FieldTreeNode[];
}

export interface DecodedOmniBufMessage {
  byteLength: number;
  schemaMeta: SchemaMeta | null;
  typeName?: string;
  nodes: FieldTreeNode[];
  jsonValue: Record<string, unknown>;
  jsonText: string;
  fieldCount: number;
}

export interface DecodeTreeOptions {
  /** Base offset of this message inside an uncompressed framed stream body */
  wireBaseOffset?: number | null;
  /** Inherited schema if decoding a sub-message slice directly */
  inheritedSchema?: SchemaMeta | null;
}

function previewHex(packet: Uint8Array, start: number, end: number, maxBytes = 48): string {
  const sliceLen = Math.max(0, end - start);
  const capped = Math.min(sliceLen, maxBytes);
  const hex = toHex(packet.subarray(start, start + capped));
  return sliceLen > maxBytes ? `${hex}...` : hex;
}

function formatStringSummary(str: string, maxChars = 72): string {
  const escaped = JSON.stringify(str);
  if (escaped.length <= maxChars) return escaped;
  return `${escaped.slice(0, maxChars - 1)}..."`;
}

function formatScalarSummary(val: number | bigint | boolean | string): string {
  if (typeof val === 'string') return formatStringSummary(val);
  if (typeof val === 'bigint') return val.toString(10);
  if (typeof val === 'number') {
    if (Object.is(val, -0)) return '-0';
    return String(val);
  }
  return val ? 'true' : 'false';
}

function resolveFieldLabel(
  schema: SchemaMeta | null,
  fieldNumber: number,
): { label: string; resolved: boolean } {
  if (fieldNumber === 0) {
    return { label: '_schema', resolved: true };
  }
  const name =
    schema?.fields && Object.hasOwn(schema.fields, fieldNumber)
      ? schema.fields[fieldNumber]
      : undefined;
  if (name) {
    return { label: name, resolved: true };
  }
  return { label: `field_${fieldNumber}`, resolved: false };
}

function resolveChildSchema(schema: SchemaMeta | null, fieldNumber: number): SchemaMeta | null {
  if (!schema?.children || !Object.hasOwn(schema.children, fieldNumber)) {
    return null;
  }
  return schema.children[fieldNumber] ?? null;
}

function containerElemLabel(wt: number): string {
  if (wt === WireBoolFalse) return 'bool';
  return wireTypeName(wt);
}

function readLittleEndianU32(buf: Uint8Array, pos: number): number {
  return (buf[pos]! | (buf[pos + 1]! << 8) | (buf[pos + 2]! << 16) | (buf[pos + 3]! << 24)) >>> 0;
}

function readLittleEndianI32(buf: Uint8Array, pos: number): number {
  return buf[pos]! | (buf[pos + 1]! << 8) | (buf[pos + 2]! << 16) | (buf[pos + 3]! << 24) | 0;
}

function readLittleEndianU64(buf: Uint8Array, pos: number): bigint {
  let u64 = 0n;
  for (let b = 7; b >= 0; b--) {
    u64 = (u64 << 8n) | BigInt(buf[pos + b]!);
  }
  return u64;
}

interface ParsedContainerValue {
  nextPos: number;
  headerLength: number;
  wireTypeLabel: string;
  summary: string;
  scalarValue?: string | number | bigint | boolean | Uint8Array | null;
  children: FieldTreeNode[];
}

function parseRawElementAt(
  rootPacket: Uint8Array,
  elemType: number,
  pos: number,
  end: number,
  idPrefix: string,
  childSchema: SchemaMeta | null,
  wireBaseOffset: number | null,
  depth: number,
): ParsedContainerValue {
  if (depth > MaxNestingDepth) {
    throw new Error(`Nesting depth ${depth} exceeds maximum (${MaxNestingDepth})`);
  }

  switch (elemType) {
    case WireBoolFalse: {
      if (pos + 1 > end) throw new Error(`Truncated bool element at ${pos}`);
      const b = rootPacket[pos]!;
      if (b > 1) throw new Error(`Invalid bool byte 0x${b.toString(16)} at ${pos}`);
      const val = b === 1;
      return {
        nextPos: pos + 1,
        headerLength: 0,
        wireTypeLabel: 'bool',
        summary: String(val),
        scalarValue: val,
        children: [],
      };
    }
    case WireUint: {
      const [v, vn] = decodeVarintAuto(rootPacket, pos, end);
      if (vn === 0) throw new Error(`Truncated uint at ${pos}`);
      return {
        nextPos: pos + vn,
        headerLength: 0,
        wireTypeLabel: 'uint',
        summary: formatScalarSummary(v),
        scalarValue: v,
        children: [],
      };
    }
    case WireSint: {
      const [raw, vn] = decodeVarintBigInt(rootPacket, pos, end);
      if (vn === 0) throw new Error(`Truncated sint at ${pos}`);
      const val = decodeZigZagAuto(raw);
      return {
        nextPos: pos + vn,
        headerLength: 0,
        wireTypeLabel: 'sint',
        summary: formatScalarSummary(val),
        scalarValue: val,
        children: [],
      };
    }
    case WireFixed32: {
      if (end - pos < 4) throw new Error(`Truncated fixed32 at ${pos}`);
      const u32 = readLittleEndianU32(rootPacket, pos);
      return {
        nextPos: pos + 4,
        headerLength: 0,
        wireTypeLabel: 'fixed32',
        summary: String(u32),
        scalarValue: u32,
        children: [],
      };
    }
    case WireSfixed32: {
      if (end - pos < 4) throw new Error(`Truncated sfixed32 at ${pos}`);
      const i32 = readLittleEndianI32(rootPacket, pos);
      return {
        nextPos: pos + 4,
        headerLength: 0,
        wireTypeLabel: 'sfixed32',
        summary: String(i32),
        scalarValue: i32,
        children: [],
      };
    }
    case WireFloat32: {
      if (end - pos < 4) throw new Error(`Truncated float32 at ${pos}`);
      const u32 = readLittleEndianU32(rootPacket, pos);
      const f32 = roundFloat32Shortest(float32FromBits(u32));
      return {
        nextPos: pos + 4,
        headerLength: 0,
        wireTypeLabel: 'float32',
        summary: formatScalarSummary(f32),
        scalarValue: f32,
        children: [],
      };
    }
    case WireFixed64: {
      if (end - pos < 8) throw new Error(`Truncated fixed64 at ${pos}`);
      const u64 = readLittleEndianU64(rootPacket, pos);
      const val: number | bigint = u64 <= 9007199254740991n ? Number(u64) : u64;
      return {
        nextPos: pos + 8,
        headerLength: 0,
        wireTypeLabel: 'fixed64',
        summary: formatScalarSummary(val),
        scalarValue: val,
        children: [],
      };
    }
    case WireSfixed64: {
      if (end - pos < 8) throw new Error(`Truncated sfixed64 at ${pos}`);
      const s64 = BigInt.asIntN(64, readLittleEndianU64(rootPacket, pos));
      const val: number | bigint =
        s64 >= -9007199254740991n && s64 <= 9007199254740991n ? Number(s64) : s64;
      return {
        nextPos: pos + 8,
        headerLength: 0,
        wireTypeLabel: 'sfixed64',
        summary: formatScalarSummary(val),
        scalarValue: val,
        children: [],
      };
    }
    case WireFloat64: {
      if (end - pos < 8) throw new Error(`Truncated float64 at ${pos}`);
      const f64 = float64FromBits(readLittleEndianU64(rootPacket, pos));
      return {
        nextPos: pos + 8,
        headerLength: 0,
        wireTypeLabel: 'float64',
        summary: formatScalarSummary(f64),
        scalarValue: f64,
        children: [],
      };
    }
    case WireString: {
      const [slice, nextPos] = readLenSlice(rootPacket.subarray(0, end), pos, 0);
      const bodyStart = nextPos - slice.byteLength;
      const str = decodeUTF8(rootPacket, bodyStart, nextPos);
      return {
        nextPos,
        headerLength: bodyStart - pos,
        wireTypeLabel: 'string',
        summary: formatStringSummary(str),
        scalarValue: str,
        children: [],
      };
    }
    case WireBytes: {
      const [slice, nextPos] = readLenSlice(rootPacket.subarray(0, end), pos, 0);
      const bodyStart = nextPos - slice.byteLength;
      return {
        nextPos,
        headerLength: bodyStart - pos,
        wireTypeLabel: 'bytes',
        summary: `Uint8Array(${slice.byteLength})`,
        scalarValue: slice,
        children: [],
      };
    }
    case WireSubMsg: {
      const [slice, nextPos] = readLenSlice(rootPacket.subarray(0, end), pos, 0);
      const bodyStart = nextPos - slice.byteLength;
      const subResult = buildMessageNodes(
        rootPacket,
        bodyStart,
        nextPos,
        childSchema,
        wireBaseOffset,
        idPrefix,
        depth + 1,
      );
      const userFieldCount = subResult.nodes.filter((n) => n.kind !== 'schema').length;
      const typePrefix = subResult.schema?.typeName ? `${subResult.schema.typeName} ` : '';
      return {
        nextPos,
        headerLength: bodyStart - pos,
        wireTypeLabel: 'submsg',
        summary: `${typePrefix}{${userFieldCount}}`,
        children: subResult.nodes,
      };
    }
    case WireArray: {
      const [slice, nextPos] = readLenSlice(rootPacket.subarray(0, end), pos, 2);
      const bodyStart = nextPos - slice.byteLength;
      const arrResult = buildArrayNodes(
        rootPacket,
        bodyStart,
        nextPos,
        pos,
        idPrefix,
        childSchema,
        wireBaseOffset,
        depth + 1,
      );
      return {
        nextPos,
        headerLength: arrResult.headerLength,
        wireTypeLabel: arrResult.wireTypeLabel,
        summary: arrResult.summary,
        children: arrResult.children,
      };
    }
    case WireMap: {
      const [slice, nextPos] = readLenSlice(rootPacket.subarray(0, end), pos, 3);
      const bodyStart = nextPos - slice.byteLength;
      const mapResult = buildMapNodes(
        rootPacket,
        bodyStart,
        nextPos,
        pos,
        idPrefix,
        childSchema,
        wireBaseOffset,
        depth + 1,
      );
      return {
        nextPos,
        headerLength: mapResult.headerLength,
        wireTypeLabel: mapResult.wireTypeLabel,
        summary: mapResult.summary,
        children: mapResult.children,
      };
    }
    case WireExtended: {
      const [slice, nextPos] = readLenSlice(rootPacket.subarray(0, end), pos, 1);
      const bodyStart = nextPos - slice.byteLength;
      const extSubtype = rootPacket[bodyStart]!;
      return {
        nextPos,
        headerLength: bodyStart - pos + 1,
        wireTypeLabel: `extended(0x${extSubtype.toString(16).padStart(2, '0')})`,
        summary: `subtype 0x${extSubtype.toString(16).padStart(2, '0')} · ${slice.byteLength - 1} B`,
        scalarValue: slice.subarray(1),
        children: [],
      };
    }
    default:
      throw new Error(`Unsupported element wire type ${elemType} at ${pos}`);
  }
}

function buildArrayNodes(
  rootPacket: Uint8Array,
  bodyStart: number,
  bodyEnd: number,
  lenPrefixStart: number,
  idPrefix: string,
  childSchema: SchemaMeta | null,
  wireBaseOffset: number | null,
  depth: number,
): { headerLength: number; wireTypeLabel: string; summary: string; children: FieldTreeNode[] } {
  const [elemType, count, elemStart, ok] = parseArrayHeader(rootPacket, bodyStart, bodyEnd);
  if (!ok) {
    throw new Error(`Invalid WireArray header at +0x${bodyStart.toString(16)}`);
  }
  const elemTypeName = containerElemLabel(elemType);
  const wireTypeLabel = `array<${elemTypeName}>`;
  const children: FieldTreeNode[] = [];
  let p = elemStart;

  for (let i = 0; i < count; i++) {
    const elemOffset = p;
    const elemId = `${idPrefix}[${i}]`;
    const parsed = parseRawElementAt(
      rootPacket,
      elemType,
      p,
      bodyEnd,
      elemId,
      childSchema,
      wireBaseOffset,
      depth,
    );
    children.push({
      id: elemId,
      kind: 'array-element',
      fieldNumber: null,
      label: String(i),
      isSchemaResolved: true,
      wireType: elemType,
      wireTypeLabel: parsed.wireTypeLabel,
      offset: elemOffset,
      tagLength: 0,
      headerLength: parsed.headerLength,
      byteLength: parsed.nextPos - elemOffset,
      wireOffset: wireBaseOffset !== null ? wireBaseOffset + elemOffset : null,
      summary: parsed.summary,
      hexPreview: previewHex(rootPacket, elemOffset, parsed.nextPos),
      scalarValue: parsed.scalarValue,
      children: parsed.children,
    });
    p = parsed.nextPos;
  }

  if (p !== bodyEnd) {
    throw new Error(`WireArray trailing bytes (${bodyEnd - p} B) at +0x${p.toString(16)}`);
  }

  return {
    headerLength: elemStart - lenPrefixStart,
    wireTypeLabel,
    summary: `[${count}]`,
    children,
  };
}

function buildMapNodes(
  rootPacket: Uint8Array,
  bodyStart: number,
  bodyEnd: number,
  lenPrefixStart: number,
  idPrefix: string,
  childSchema: SchemaMeta | null,
  wireBaseOffset: number | null,
  depth: number,
): { headerLength: number; wireTypeLabel: string; summary: string; children: FieldTreeNode[] } {
  const [keyWT, valWT, count, entryStart, ok] = parseMapHeader(rootPacket, bodyStart, bodyEnd);
  if (!ok) {
    throw new Error(`Invalid WireMap header at +0x${bodyStart.toString(16)}`);
  }
  const keyTypeName = containerElemLabel(keyWT);
  const valTypeName = containerElemLabel(valWT);
  const wireTypeLabel = `map<${keyTypeName}, ${valTypeName}>`;
  const children: FieldTreeNode[] = [];
  let p = entryStart;

  for (let i = 0; i < count; i++) {
    const entryOffset = p;
    const keyParsed = parseRawElementAt(
      rootPacket,
      keyWT,
      p,
      bodyEnd,
      `${idPrefix}/k${i}`,
      null,
      wireBaseOffset,
      depth,
    );
    const keyDisplay =
      keyWT === WireString && typeof keyParsed.scalarValue === 'string'
        ? JSON.stringify(keyParsed.scalarValue)
        : String(keyParsed.scalarValue ?? i);
    const entryId = `${idPrefix}{${i}:${keyDisplay}}`;
    const valParsed = parseRawElementAt(
      rootPacket,
      valWT,
      keyParsed.nextPos,
      bodyEnd,
      entryId,
      childSchema,
      wireBaseOffset,
      depth,
    );
    const keyLen = keyParsed.nextPos - entryOffset;
    children.push({
      id: entryId,
      kind: 'map-entry',
      fieldNumber: null,
      label: keyDisplay,
      isSchemaResolved: true,
      wireType: valWT,
      wireTypeLabel: `${keyTypeName} -> ${valParsed.wireTypeLabel}`,
      offset: entryOffset,
      tagLength: keyLen,
      headerLength: valParsed.headerLength,
      byteLength: valParsed.nextPos - entryOffset,
      wireOffset: wireBaseOffset !== null ? wireBaseOffset + entryOffset : null,
      summary: valParsed.summary,
      hexPreview: previewHex(rootPacket, entryOffset, valParsed.nextPos),
      scalarValue: valParsed.scalarValue,
      children: valParsed.children,
    });
    p = valParsed.nextPos;
  }

  if (p !== bodyEnd) {
    throw new Error(`WireMap trailing bytes (${bodyEnd - p} B) at +0x${p.toString(16)}`);
  }

  return {
    headerLength: entryStart - lenPrefixStart,
    wireTypeLabel,
    summary: `{${count}}`,
    children,
  };
}

function buildMessageNodes(
  rootPacket: Uint8Array,
  msgStart: number,
  msgEnd: number,
  inheritedSchema: SchemaMeta | null,
  wireBaseOffset: number | null,
  idPrefix: string,
  depth: number,
): { nodes: FieldTreeNode[]; schema: SchemaMeta | null } {
  if (depth > MaxNestingDepth) {
    throw new Error(`Nesting depth ${depth} exceeds maximum (${MaxNestingDepth})`);
  }

  // Pre-pass: gather any inline Field #0 SchemaMeta blocks inside this message slice
  const msgSlice = rootPacket.subarray(msgStart, msgEnd);
  const [inlineSchema] = readField0SchemaMeta(msgSlice);
  let activeSchema = mergeSchemaMeta(inheritedSchema ?? undefined, inlineSchema ?? undefined);

  const nodes: FieldTreeNode[] = [];
  let pos = msgStart;

  while (pos < msgEnd) {
    const startOffset = pos;
    const [rawTag, tn] = decodeVarintBigInt(rootPacket, pos, msgEnd);
    if (tn === 0 || rawTag >> 4n > 536870911n) {
      throw new Error(
        `Invalid or truncated OmniBuf tag at +0x${pos.toString(16).padStart(4, '0')}`,
      );
    }
    const fieldNumber = Number(rawTag >> 4n);
    const wireType = Number(rawTag & 0x0fn);
    const tagEnd = pos + tn;
    const nodeId = `${idPrefix}/f${fieldNumber}@${startOffset}`;

    if (fieldNumber === 0) {
      if (wireType !== WireSubMsg) {
        throw new Error(`Field #0 must use WireSubMsg (12), got wire type ${wireType}`);
      }
      const [bodySlice, nextPos] = readLenSlice(rootPacket.subarray(0, msgEnd), tagEnd, 0);
      const bodyStart = nextPos - bodySlice.byteLength;
      const meta = decodeSchemaMeta(bodySlice);
      activeSchema = mergeSchemaMeta(activeSchema ?? undefined, meta);

      // Walk the SchemaMeta sub-message fields so expanding `_schema` shows exact byte layout
      const schemaSub = buildMessageNodes(
        rootPacket,
        bodyStart,
        nextPos,
        {
          typeName: 'omnibuf.v1.SchemaMeta',
          fields: { 1: 'type_name', 2: 'fields', 3: 'children' },
          children: {
            3: {
              typeName: 'omnibuf.v1.SchemaMeta',
              fields: { 1: 'type_name', 2: 'fields', 3: 'children' },
            },
          },
        },
        wireBaseOffset,
        nodeId,
        depth + 1,
      );
      const mappedCount = meta.fields ? Object.keys(meta.fields).length : 0;

      nodes.push({
        id: nodeId,
        kind: 'schema',
        fieldNumber: 0,
        label: '_schema',
        isSchemaResolved: true,
        wireType,
        wireTypeLabel: 'SchemaMeta',
        offset: startOffset,
        tagLength: tn,
        headerLength: bodyStart - tagEnd,
        byteLength: nextPos - startOffset,
        wireOffset: wireBaseOffset !== null ? wireBaseOffset + startOffset : null,
        summary: meta.typeName ? `${meta.typeName} {${mappedCount}}` : `{${mappedCount}}`,
        hexPreview: previewHex(rootPacket, startOffset, nextPos),
        children: schemaSub.nodes,
      });
      pos = nextPos;
      continue;
    }

    const { label, resolved } = resolveFieldLabel(activeSchema, fieldNumber);
    const childSchema = resolveChildSchema(activeSchema, fieldNumber);

    if (wireType === WireBoolFalse || wireType === WireBoolTrue) {
      const val = wireType === WireBoolTrue;
      nodes.push({
        id: nodeId,
        kind: 'field',
        fieldNumber,
        label,
        isSchemaResolved: resolved,
        wireType,
        wireTypeLabel: val ? 'bool=1' : 'bool=0',
        offset: startOffset,
        tagLength: tn,
        headerLength: 0,
        byteLength: tn,
        wireOffset: wireBaseOffset !== null ? wireBaseOffset + startOffset : null,
        summary: String(val),
        hexPreview: previewHex(rootPacket, startOffset, tagEnd),
        scalarValue: val,
        children: [],
      });
      pos = tagEnd;
      continue;
    }

    const parsed = parseRawElementAt(
      rootPacket,
      wireType,
      tagEnd,
      msgEnd,
      nodeId,
      childSchema,
      wireBaseOffset,
      depth,
    );

    nodes.push({
      id: nodeId,
      kind: 'field',
      fieldNumber,
      label,
      isSchemaResolved: resolved,
      wireType,
      wireTypeLabel: parsed.wireTypeLabel,
      offset: startOffset,
      tagLength: tn,
      headerLength: parsed.headerLength,
      byteLength: parsed.nextPos - startOffset,
      wireOffset: wireBaseOffset !== null ? wireBaseOffset + startOffset : null,
      summary: parsed.summary,
      hexPreview: previewHex(rootPacket, startOffset, parsed.nextPos),
      scalarValue: parsed.scalarValue,
      children: parsed.children,
    });
    pos = parsed.nextPos;
  }

  return { nodes, schema: activeSchema };
}

/**
 * Serializes any decoded blind value to JSON, preserving safe integers as JSON numbers
 * and formatting 64-bit `bigint` values outside JS safe integer range as decimal strings.
 */
export function formatDecodedJson(value: unknown, indent = 2): string {
  return JSON.stringify(
    value,
    (_key, val: unknown) => {
      if (typeof val === 'bigint') {
        if (val >= -9007199254740991n && val <= 9007199254740991n) {
          return Number(val);
        }
        return val.toString(10);
      }
      if (val instanceof Uint8Array) {
        return uint8ArrayToBase64(val);
      }
      return val;
    },
    indent,
  );
}

/**
 * Decodes an OmniBuf binary message into an expandable `FieldTreeNode` hierarchy
 * with exact byte spans, `Field #0` schema resolution, and JSON export.
 */
export function decodeOmniBufTree(
  packet: Uint8Array,
  options: DecodeTreeOptions = {},
): DecodedOmniBufMessage {
  const wireBase = options.wireBaseOffset === undefined ? 0 : options.wireBaseOffset;
  const jsonValue = decodeBlind(packet, {
    bytesAsBase64: true,
    inheritedSchema: options.inheritedSchema ?? undefined,
  });
  const { nodes, schema } = buildMessageNodes(
    packet,
    0,
    packet.byteLength,
    options.inheritedSchema ?? null,
    wireBase,
    'root',
    0,
  );
  const userFieldCount = nodes.filter((n) => n.kind !== 'schema').length;

  return {
    byteLength: packet.byteLength,
    schemaMeta: schema,
    typeName: schema?.typeName,
    nodes,
    jsonValue,
    jsonText: formatDecodedJson(jsonValue, 2),
    fieldCount: userFieldCount,
  };
}

export interface ByteHit {
  node: FieldTreeNode;
  path: FieldTreeNode[];
  role: ByteSegmentRole;
}

/**
 * Finds the deepest `FieldTreeNode` whose `[offset .. offset + byteLength)` span
 * contains `byteOffset`, along with whether that byte sits in the tag, header, or payload.
 */
export function findNodeAtByteOffset(
  nodes: FieldTreeNode[],
  byteOffset: number,
  includeSchema = true,
): ByteHit | null {
  function walk(list: FieldTreeNode[], ancestors: FieldTreeNode[]): ByteHit | null {
    for (const node of list) {
      if (!includeSchema && node.kind === 'schema') continue;
      const start = node.offset;
      const end = start + node.byteLength;
      if (byteOffset >= start && byteOffset < end) {
        const nextPath = [...ancestors, node];
        if (node.children.length > 0) {
          const deeper = walk(node.children, nextPath);
          if (deeper) return deeper;
        }
        const rel = byteOffset - start;
        let role: ByteSegmentRole = 'payload';
        if (rel < node.tagLength) {
          role = 'tag';
        } else if (rel < node.tagLength + node.headerLength) {
          role = 'header';
        }
        return { node, path: nextPath, role };
      }
    }
    return null;
  }
  return walk(nodes, []);
}
