import { toHex } from '@omnibuf/web';
import {
  getDevToolsThemeName,
  isRunningInDevTools,
  startNetworkCapture,
} from '../capture/network.js';
import {
  type DecodedOmniBufMessage,
  type FieldTreeNode,
  findNodeAtByteOffset,
  formatDecodedJson,
} from '../decoder/tree.js';
import { buildSyntheticTrafficFixtures } from '../demo/fixtures.js';
import {
  type CapturedItem,
  type InspectedEnvelopeView,
  type InspectedTrafficResult,
  createCapturedItem,
  formatEndStreamSummary,
  inspectCapturedItem,
} from '../inspector.js';
import type { ProtocolId } from '../protocol/detect.js';
import { alignHexWindow, renderHexInspector } from './hexView.js';

type ThemePref = 'auto' | 'dark' | 'light';
type DetailTab = 'hex' | 'json' | 'headers';
type MobileScreen = 'list' | 'detail';
type MobileTab = 'fields' | DetailTab;

interface PanelState {
  items: CapturedItem[];
  bodyLoaders: Map<string, () => Promise<void>>;
  scope: 'omnibuf' | 'all';
  requestFilter: string;
  fieldFilter: string;
  preserveLog: boolean;
  showField0: boolean;
  themePref: ThemePref;
  selectedItemId: string | null;
  selectedEnvelopeIdx: number;
  selectedNodeId: string | null;
  expandedNodeIds: Set<string>;
  detailTab: DetailTab;
  mobileScreen: MobileScreen;
  mobileTab: MobileTab;
  hexWindowStart: number;
  inspected: InspectedTrafficResult | null;
  inspectSeq: number;
}

const state: PanelState = {
  items: [],
  bodyLoaders: new Map(),
  scope: 'omnibuf',
  requestFilter: '',
  fieldFilter: '',
  preserveLog: false,
  showField0: false,
  themePref: 'auto',
  selectedItemId: null,
  selectedEnvelopeIdx: 0,
  selectedNodeId: null,
  expandedNodeIds: new Set(),
  detailTab: 'hex',
  mobileScreen: 'list',
  mobileTab: 'fields',
  hexWindowStart: 0,
  inspected: null,
  inspectSeq: 0,
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing DOM element #${id}`);
  return node as T;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatHex4(n: number): string {
  return `0x${n.toString(16).padStart(4, '0')}`;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string): void {
  const toast = el<HTMLDivElement>('toast');
  toast.textContent = msg;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2200);
}

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`Copied ${label}`);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast(`Copied ${label}`);
  }
}

function downloadBlob(bytes: Uint8Array | string, filename: string, mime: string): void {
  const part: BlobPart =
    typeof bytes === 'string'
      ? bytes
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
  const blob = new Blob([part], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function applyTheme(): void {
  const resolved = state.themePref === 'auto' ? getDevToolsThemeName() : state.themePref;
  document.documentElement.dataset.theme = resolved;
  const label =
    state.themePref === 'auto'
      ? `Auto (${resolved === 'dark' ? 'Dark' : 'Light'})`
      : state.themePref === 'dark'
        ? 'Theme: Dark'
        : 'Theme: Light';
  el<HTMLButtonElement>('btn-theme').textContent = label;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function createBackArrowIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon-svg');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M7.5 2.25L3.75 6L7.5 9.75');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function createTreeChevronIcon(expanded: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('twisty-chevron');
  if (expanded) svg.classList.add('is-expanded');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M3.25 2L6.75 5L3.25 8');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function syncMobileAttributes(): void {
  const app = el<HTMLElement>('app');
  const screen: MobileScreen = state.selectedItemId ? state.mobileScreen : 'list';
  app.dataset.mobileScreen = screen;
  app.dataset.mobileTab = state.mobileTab;
  app.dataset.empty = String(state.items.length === 0);

  const omniCount = state.items.filter(
    (it) => it.classification.detected || it.manualOverride,
  ).length;
  const totalShown = state.scope === 'omnibuf' ? omniCount : state.items.length;
  const backBtn = el<HTMLButtonElement>('btn-mobile-back');
  backBtn.replaceChildren(
    createBackArrowIcon(),
    document.createTextNode(`Traffic (${totalShown})`),
  );

  const mTabs: Array<{ key: MobileTab; id: string }> = [
    { key: 'fields', id: 'mtab-fields' },
    { key: 'hex', id: 'mtab-hex' },
    { key: 'json', id: 'mtab-json' },
    { key: 'headers', id: 'mtab-headers' },
  ];
  for (const t of mTabs) {
    const btn = el<HTMLButtonElement>(t.id);
    const active = state.mobileTab === t.key;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  }
}

function getSelectedItem(): CapturedItem | null {
  if (!state.selectedItemId) return null;
  return state.items.find((it) => it.id === state.selectedItemId) ?? null;
}

function getVisibleItems(): CapturedItem[] {
  const q = state.requestFilter.trim().toLowerCase();
  return state.items.filter((item) => {
    const inScope = state.scope === 'all' || item.classification.detected || item.manualOverride;
    if (!inScope) return false;
    if (!q) return true;
    return (
      item.displayPath.toLowerCase().includes(q) ||
      item.host.toLowerCase().includes(q) ||
      item.method.toLowerCase().includes(q) ||
      item.classification.badge.toLowerCase().includes(q)
    );
  });
}

function getActiveEnvelopeView(): InspectedEnvelopeView | null {
  if (!state.inspected || state.inspected.envelopes.length === 0) return null;
  const idx = Math.min(
    Math.max(0, state.selectedEnvelopeIdx),
    state.inspected.envelopes.length - 1,
  );
  return state.inspected.envelopes[idx] ?? null;
}

function findNodeById(nodes: FieldTreeNode[], id: string | null): FieldTreeNode | null {
  if (!id) return null;
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children.length > 0) {
      const found = findNodeById(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

function seedDefaultExpandedNodes(decoded: DecodedOmniBufMessage): void {
  state.expandedNodeIds.clear();
  for (const n of decoded.nodes) {
    if (n.kind !== 'schema' && n.children.length > 0 && n.children.length <= 16) {
      state.expandedNodeIds.add(n.id);
    }
  }
}

function nodeMatchesFilter(node: FieldTreeNode, q: string): boolean {
  if (!q) return true;
  if (node.label.toLowerCase().includes(q)) return true;
  if (
    node.fieldNumber !== null &&
    (`#${node.fieldNumber}` === q || String(node.fieldNumber) === q)
  ) {
    return true;
  }
  if (node.wireTypeLabel.toLowerCase().includes(q)) return true;
  if (node.summary.toLowerCase().includes(q)) return true;
  return node.children.some((ch) => nodeMatchesFilter(ch, q));
}

function updateCountsAndScopeUI(): void {
  const omniCount = state.items.filter(
    (it) => it.classification.detected || it.manualOverride,
  ).length;
  el<HTMLElement>('count-omnibuf').textContent = String(omniCount);
  el<HTMLElement>('count-all').textContent = String(state.items.length);
  syncMobileAttributes();

  const btnOmni = el<HTMLButtonElement>('scope-omnibuf');
  const btnAll = el<HTMLButtonElement>('scope-all');
  const isOmni = state.scope === 'omnibuf';
  btnOmni.classList.toggle('is-active', isOmni);
  btnOmni.setAttribute('aria-pressed', String(isOmni));
  btnAll.classList.toggle('is-active', !isOmni);
  btnAll.setAttribute('aria-pressed', String(!isOmni));

  const statusEl = el<HTMLElement>('capture-status');
  if (state.items.some((i) => i.source === 'synthetic')) {
    statusEl.textContent = 'Synthetic demo';
  } else if (isRunningInDevTools()) {
    statusEl.textContent = 'Listening';
  } else {
    statusEl.textContent = 'Standalone';
  }
}

function renderRequestList(): void {
  updateCountsAndScopeUI();
  const listEl = el<HTMLElement>('request-list');
  listEl.replaceChildren();
  const visible = getVisibleItems();

  if (visible.length === 0) {
    const note = document.createElement('div');
    note.className = 'pane-empty-note';
    note.textContent =
      state.items.length > 0
        ? 'No OmniBuf responses matched. Switch to "All HTTP" to decode untagged binary responses manually.'
        : 'No responses captured yet.';
    listEl.appendChild(note);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const item of visible) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `req-row${item.id === state.selectedItemId ? ' is-selected' : ''}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(item.id === state.selectedItemId));

    const top = document.createElement('div');
    top.className = 'req-row-top';

    const status = document.createElement('span');
    const isErr = item.status >= 400 || item.classification.isConnectUnaryError;
    status.className = `status-pill ${isErr ? 'status-err' : 'status-ok'}`;
    status.textContent = item.source === 'file' ? 'OBUF' : String(item.status || 200);

    const method = document.createElement('span');
    method.className = 'req-row-method';
    method.textContent = item.method;

    const path = document.createElement('span');
    path.className = 'req-row-path';
    path.textContent = item.displayPath;
    path.title = item.url;

    top.append(status, method, path);

    const bottom = document.createElement('div');
    bottom.className = 'req-row-bottom';

    const host = document.createElement('span');
    host.className = 'req-row-host';
    host.textContent = item.source === 'synthetic' ? 'synthetic fixture' : item.host || 'local';

    const right = document.createElement('span');
    right.className = 'req-row-meta-right';

    const badge = document.createElement('span');
    badge.className = `proto-pill${item.source === 'synthetic' ? ' is-synthetic' : ''}`;
    badge.textContent = item.classification.detected
      ? item.classification.badge
      : item.manualOverride
        ? 'MANUAL'
        : 'UNTAGGED';

    const size = document.createElement('span');
    size.textContent = formatBytes(item.body ? item.body.byteLength : item.reportedSize);

    right.append(badge, size);
    bottom.append(host, right);
    row.append(top, bottom);

    row.addEventListener('click', () => {
      void selectItem(item.id);
    });
    frag.appendChild(row);
  }
  listEl.appendChild(frag);
}

async function selectItem(itemId: string): Promise<void> {
  state.selectedItemId = itemId;
  state.mobileScreen = 'detail';
  state.selectedEnvelopeIdx = 0;
  state.selectedNodeId = null;
  state.hexWindowStart = 0;
  renderRequestList();

  const item = getSelectedItem();
  if (!item) {
    state.inspected = null;
    renderWorkspace();
    return;
  }

  const loader = state.bodyLoaders.get(item.id);
  if (item.body === null && loader) {
    await loader();
  }

  await runInspectionForSelectedItem(true);
}

async function runInspectionForSelectedItem(resetExpanded: boolean): Promise<void> {
  const item = getSelectedItem();
  if (!item) {
    state.inspected = null;
    renderWorkspace();
    return;
  }

  // Require explicit "Decode as OmniBuf" click for non-detected network responses
  if (!item.classification.detected && !item.manualOverride) {
    state.inspected = null;
    renderWorkspace();
    return;
  }

  const seq = ++state.inspectSeq;
  const result = await inspectCapturedItem(item);
  if (seq !== state.inspectSeq) return;

  state.inspected = result;
  if (state.selectedEnvelopeIdx >= result.envelopes.length) {
    state.selectedEnvelopeIdx = 0;
  }

  const activeEnv = getActiveEnvelopeView();
  if (activeEnv?.decoded) {
    if (resetExpanded) {
      seedDefaultExpandedNodes(activeEnv.decoded);
    }
    const firstVisible = activeEnv.decoded.nodes.find(
      (n) => state.showField0 || n.kind !== 'schema',
    );
    if (!state.selectedNodeId || !findNodeById(activeEnv.decoded.nodes, state.selectedNodeId)) {
      state.selectedNodeId = firstVisible?.id ?? null;
      state.hexWindowStart = firstVisible ? alignHexWindow(firstVisible.offset) : 0;
    }
  } else {
    state.selectedNodeId = null;
  }

  renderRequestList();
  renderWorkspace();
}

function wireTypeCategoryClass(wtLabel: string, kind: FieldTreeNode['kind']): string {
  if (kind === 'schema') return ' wt-schema';
  if (wtLabel === 'string') return ' wt-string';
  if (
    wtLabel === 'submsg' ||
    wtLabel.startsWith('array<') ||
    wtLabel.startsWith('map<') ||
    wtLabel.includes('->')
  ) {
    return ' wt-container';
  }
  return '';
}

function renderEmptyWorkspace(): void {
  el<HTMLElement>('inspector-header').hidden = true;
  el<HTMLElement>('warning-banner').hidden = true;
  el<HTMLElement>('envelope-strip').hidden = true;
  el<HTMLElement>('mobile-byte-footer').hidden = true;

  const viewport = el<HTMLElement>('tree-viewport');
  viewport.replaceChildren();

  const card = document.createElement('div');
  card.className = 'state-card';

  const title = document.createElement('h2');
  title.className = 'state-title';
  title.textContent = isRunningInDevTools()
    ? 'Listening for OmniBuf responses'
    : 'Inspect OmniBuf packets and RPC streams';

  const copy = document.createElement('p');
  copy.className = 'state-copy';
  copy.textContent =
    'Completed HTTP responses matching OmniBuf media types or .obuf file URLs decode automatically into an expandable field tree with byte offsets and JSON export. Drop any local .obuf file onto this panel, or switch to All HTTP to decode untagged binary responses manually.';

  const chips = document.createElement('div');
  chips.className = 'state-code-list';
  for (const label of [
    'application/omnibuf',
    'application/x-omnibuf',
    'application/connect+omnibuf',
    'application/grpc-web+omnibuf',
    '*.obuf',
  ]) {
    const c = document.createElement('code');
    c.className = 'code-chip';
    c.textContent = label;
    chips.appendChild(c);
  }

  const actions = document.createElement('div');
  actions.className = 'state-actions';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn-signal';
  openBtn.textContent = 'Open .obuf file';
  openBtn.addEventListener('click', () => el<HTMLInputElement>('obuf-file-input').click());

  const demoBtn = document.createElement('button');
  demoBtn.type = 'button';
  demoBtn.className = 'btn-tool';
  demoBtn.textContent = 'Load synthetic sample traffic';
  demoBtn.addEventListener('click', () => {
    void loadSyntheticSamples();
  });

  actions.append(openBtn, demoBtn);

  if (state.items.length > 0 && state.scope === 'omnibuf') {
    const showAllBtn = document.createElement('button');
    showAllBtn.type = 'button';
    showAllBtn.className = 'btn-tool';
    showAllBtn.textContent = `Show all HTTP (${state.items.length})`;
    showAllBtn.addEventListener('click', () => {
      state.scope = 'all';
      renderRequestList();
    });
    actions.appendChild(showAllBtn);
  }

  card.append(title, copy, chips, actions);
  viewport.appendChild(card);

  renderDetailPanes(null, null);
}

function renderManualOverrideGate(item: CapturedItem): void {
  el<HTMLElement>('inspector-header').hidden = false;
  updateInspectorHeaderBar(item, null);
  el<HTMLElement>('warning-banner').hidden = true;
  el<HTMLElement>('envelope-strip').hidden = true;
  el<HTMLElement>('mobile-byte-footer').hidden = true;

  const viewport = el<HTMLElement>('tree-viewport');
  viewport.replaceChildren();

  const card = document.createElement('div');
  card.className = 'state-card';

  const title = document.createElement('h2');
  title.className = 'state-title';
  title.textContent = 'Untagged HTTP response';

  const media = item.classification.mediaType || 'unspecified Content-Type';
  const bodyLen = item.body ? item.body.byteLength : item.reportedSize;
  const firstHex =
    item.body && item.body.byteLength > 0
      ? toHex(item.body.subarray(0, Math.min(16, item.body.byteLength)))
      : '(empty)';

  const copy = document.createElement('p');
  copy.className = 'state-copy';
  copy.textContent = `Response returned ${media} (${formatBytes(bodyLen)}). Leading bytes: 0x${firstHex}. Ordinary Protobuf or JSON payloads are not OmniBuf; decode manually when this endpoint emits an OmniBuf wire payload.`;

  const actions = document.createElement('div');
  actions.className = 'state-actions';

  const decodeBtn = document.createElement('button');
  decodeBtn.type = 'button';
  decodeBtn.className = 'btn-signal';
  decodeBtn.textContent = 'Decode as OmniBuf';
  decodeBtn.addEventListener('click', () => {
    item.manualOverride = true;
    void runInspectionForSelectedItem(true);
  });

  actions.appendChild(decodeBtn);
  card.append(title, copy, actions);
  viewport.appendChild(card);

  renderDetailPanes(item, null);
}

function updateInspectorHeaderBar(
  item: CapturedItem,
  activeView: InspectedEnvelopeView | null,
): void {
  el<HTMLElement>('req-method-badge').textContent = item.method;
  const pathEl = el<HTMLElement>('req-path');
  pathEl.textContent = item.displayPath;
  pathEl.title = item.url;

  const schemaBadge = el<HTMLElement>('schema-badge');
  const decoded = activeView?.decoded;
  if (decoded?.schemaMeta) {
    schemaBadge.className = 'meta-badge is-schema';
    schemaBadge.textContent = decoded.typeName
      ? `Field #0 · ${decoded.typeName}`
      : 'Field #0 · Self-describing';
  } else if (decoded) {
    schemaBadge.className = 'meta-badge';
    schemaBadge.textContent = 'Blind wire · Numbered fields';
  } else if (!item.classification.detected && !item.manualOverride) {
    schemaBadge.className = 'meta-badge';
    schemaBadge.textContent = item.classification.mediaType || 'untagged';
  } else {
    schemaBadge.className = 'meta-badge';
    schemaBadge.textContent = state.inspected?.protocol ?? item.classification.protocol;
  }

  const wireBadge = el<HTMLElement>('wire-size-badge');
  const rawBytes = item.body ? item.body.byteLength : item.reportedSize;
  wireBadge.textContent = formatBytes(rawBytes);

  const protoSelect = el<HTMLSelectElement>('protocol-select');
  const autoOpt = protoSelect.querySelector<HTMLOptionElement>('option[value="auto"]');
  if (autoOpt) {
    autoOpt.textContent = `Auto (${item.classification.protocol})`;
  }
  protoSelect.value = item.protocolOverride;

  const hasDecoded = Boolean(decoded);
  el<HTMLElement>('tree-controls-bar').hidden = !hasDecoded;
  el<HTMLButtonElement>('btn-copy-json').disabled = !hasDecoded;
  el<HTMLButtonElement>('btn-export-json').disabled = !hasDecoded;
  el<HTMLButtonElement>('btn-save-obuf').disabled =
    !activeView || activeView.envelope.payload.byteLength === 0;
}

function renderEnvelopeStrip(result: InspectedTrafficResult): void {
  const strip = el<HTMLElement>('envelope-strip');
  strip.replaceChildren();

  const isFramed =
    result.envelopes.length > 1 ||
    result.protocol === 'connect-streaming' ||
    result.protocol === 'grpc-web' ||
    result.protocol === 'grpc-web-text';

  if (!isFramed) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;

  result.envelopes.forEach((view, idx) => {
    const env = view.envelope;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `env-chip${idx === state.selectedEnvelopeIdx ? ' is-active' : ''}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(idx === state.selectedEnvelopeIdx));

    const kindSpan = document.createElement('span');
    kindSpan.className = 'env-chip-kind';
    if (env.kind === 'message') kindSpan.textContent = `#${idx} MSG`;
    else if (env.kind === 'end-stream') kindSpan.textContent = `#${idx} END`;
    else if (env.kind === 'trailers') kindSpan.textContent = `#${idx} TRAILERS`;
    else kindSpan.textContent = `#${idx} ERR`;

    const descSpan = document.createElement('span');
    if (env.kind === 'message') {
      const compNote = env.compressed
        ? `${env.compressionEncoding ?? 'compressed'} -> ${formatBytes(env.payload.byteLength)}`
        : formatBytes(env.payload.byteLength);
      descSpan.textContent = `${compNote} @+${formatHex4(env.wireOffset)}`;
    } else if (env.kind === 'end-stream') {
      descSpan.textContent = `${formatEndStreamSummary(env.endStream)} @+${formatHex4(env.wireOffset)}`;
    } else if (env.kind === 'trailers') {
      const status = env.trailers?.['grpc-status'] ?? '?';
      descSpan.textContent = `grpc-status: ${status}`;
    } else {
      descSpan.textContent = formatEndStreamSummary(env.endStream);
    }

    btn.append(kindSpan, descSpan);
    btn.addEventListener('click', () => {
      state.selectedEnvelopeIdx = idx;
      state.selectedNodeId = null;
      state.hexWindowStart = 0;
      const nextActive = getActiveEnvelopeView();
      if (nextActive?.decoded) {
        seedDefaultExpandedNodes(nextActive.decoded);
        const first = nextActive.decoded.nodes.find((n) => state.showField0 || n.kind !== 'schema');
        state.selectedNodeId = first?.id ?? null;
      }
      renderWorkspace();
    });
    strip.appendChild(btn);
  });

  requestAnimationFrame(() => {
    const activeChip = strip.querySelector<HTMLElement>('.env-chip.is-active');
    if (!activeChip) return;
    const chipLeft = activeChip.offsetLeft - strip.offsetLeft;
    const chipRight = chipLeft + activeChip.offsetWidth;
    if (chipLeft < strip.scrollLeft) {
      strip.scrollLeft = Math.max(0, chipLeft - 12);
    } else if (chipRight > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = chipRight - strip.clientWidth + 12;
    }
  });
}

interface FlatTreeRow {
  node: FieldTreeNode;
  depth: number;
  parentId: string | null;
}

function flattenVisibleTree(nodes: FieldTreeNode[]): FlatTreeRow[] {
  const q = state.fieldFilter.trim().toLowerCase();
  const rows: FlatTreeRow[] = [];

  function walk(list: FieldTreeNode[], depth: number, parentId: string | null): void {
    for (const node of list) {
      if (!state.showField0 && node.kind === 'schema') continue;
      if (q && !nodeMatchesFilter(node, q)) continue;
      rows.push({ node, depth, parentId });
      const isExpanded = Boolean(q) || state.expandedNodeIds.has(node.id);
      if (node.children.length > 0 && isExpanded) {
        walk(node.children, depth + 1, node.id);
      }
    }
  }

  walk(nodes, 0, null);
  return rows;
}

function renderFieldTree(decoded: DecodedOmniBufMessage, activeView: InspectedEnvelopeView): void {
  const viewport = el<HTMLElement>('tree-viewport');
  viewport.replaceChildren();

  if (decoded.byteLength === 0) {
    const empty = document.createElement('div');
    empty.className = 'pane-empty-note';
    empty.textContent = 'Empty OmniBuf message (0 bytes, all fields at default values).';
    viewport.appendChild(empty);
    return;
  }

  const flatRows = flattenVisibleTree(decoded.nodes);
  if (flatRows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pane-empty-note';
    empty.textContent = state.fieldFilter
      ? `No fields matched "${state.fieldFilter}".`
      : 'Packet contains only Field #0 metadata; enable "Field #0" above to inspect schema bytes.';
    viewport.appendChild(empty);
    return;
  }

  const treeEl = document.createElement('div');
  treeEl.className = 'field-tree';
  treeEl.setAttribute('role', 'tree');
  treeEl.setAttribute('aria-label', 'Decoded OmniBuf fields');
  treeEl.tabIndex = 0;

  const rowElements = new Map<string, HTMLElement>();
  const frag = document.createDocumentFragment();

  for (const { node, depth } of flatRows) {
    const hasChildren = node.children.length > 0;
    const isExpanded = Boolean(state.fieldFilter.trim()) || state.expandedNodeIds.has(node.id);
    const isSelected = node.id === state.selectedNodeId;

    const row = document.createElement('div');
    row.className = `tree-row${isSelected ? ' is-selected' : ''}`;
    row.style.setProperty('--depth', String(depth));
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-selected', String(isSelected));
    if (hasChildren) {
      row.setAttribute('aria-expanded', String(isExpanded));
    }
    row.dataset.nodeId = node.id;

    const twisty = document.createElement('span');
    twisty.className = 'tree-twisty';
    if (hasChildren) {
      twisty.appendChild(createTreeChevronIcon(isExpanded));
    }

    const fnum = document.createElement('span');
    fnum.className = 'tree-fnum';
    fnum.textContent = node.fieldNumber !== null ? `#${node.fieldNumber}` : '';

    const fname = document.createElement('span');
    fname.className = `tree-fname${!node.isSchemaResolved ? ' is-blind' : ''}${node.kind === 'schema' ? ' is-schema-key' : ''}`;
    fname.textContent = node.label;

    const wtype = document.createElement('span');
    wtype.className = `tree-wtype${wireTypeCategoryClass(node.wireTypeLabel, node.kind)}`;
    wtype.textContent = node.wireTypeLabel;

    const val = document.createElement('span');
    val.className = `tree-val${node.wireTypeLabel === 'string' ? ' val-string' : ''}`;
    val.textContent = node.summary;
    val.title = node.summary;

    const span = document.createElement('span');
    span.className = 'tree-span';
    span.textContent = `+${formatHex4(node.offset)} · ${node.byteLength} B`;

    row.append(twisty, fnum, fname, wtype, val, span);

    row.addEventListener('click', (ev) => {
      const clickedTwisty = (ev.target as HTMLElement | null)?.closest('.tree-twisty');
      if (hasChildren && (clickedTwisty || state.selectedNodeId === node.id)) {
        if (state.expandedNodeIds.has(node.id)) {
          state.expandedNodeIds.delete(node.id);
        } else {
          state.expandedNodeIds.add(node.id);
        }
      }
      state.selectedNodeId = node.id;
      state.hexWindowStart = alignHexWindow(node.offset);
      renderFieldTree(decoded, activeView);
      const item = getSelectedItem();
      renderDetailPanes(item, activeView);
      treeEl.focus({ preventScroll: true });
    });

    rowElements.set(node.id, row);
    frag.appendChild(row);
  }

  treeEl.addEventListener('keydown', (ev) => {
    const idx = flatRows.findIndex((r) => r.node.id === state.selectedNodeId);
    const current = idx >= 0 ? flatRows[idx]! : flatRows[0]!;
    if (!current) return;

    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      const next = flatRows[Math.min(flatRows.length - 1, idx + 1)];
      if (next) {
        state.selectedNodeId = next.node.id;
        state.hexWindowStart = alignHexWindow(next.node.offset);
        renderFieldTree(decoded, activeView);
        renderDetailPanes(getSelectedItem(), activeView);
      }
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      const prev = flatRows[Math.max(0, idx - 1)];
      if (prev) {
        state.selectedNodeId = prev.node.id;
        state.hexWindowStart = alignHexWindow(prev.node.offset);
        renderFieldTree(decoded, activeView);
        renderDetailPanes(getSelectedItem(), activeView);
      }
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      if (current.node.children.length > 0 && !state.expandedNodeIds.has(current.node.id)) {
        state.expandedNodeIds.add(current.node.id);
        renderFieldTree(decoded, activeView);
      } else if (current.node.children.length > 0 && idx + 1 < flatRows.length) {
        const child = flatRows[idx + 1]!;
        state.selectedNodeId = child.node.id;
        state.hexWindowStart = alignHexWindow(child.node.offset);
        renderFieldTree(decoded, activeView);
        renderDetailPanes(getSelectedItem(), activeView);
      }
    } else if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      if (current.node.children.length > 0 && state.expandedNodeIds.has(current.node.id)) {
        state.expandedNodeIds.delete(current.node.id);
        renderFieldTree(decoded, activeView);
      } else if (current.parentId) {
        state.selectedNodeId = current.parentId;
        const parentRow = flatRows.find((r) => r.node.id === current.parentId);
        if (parentRow) state.hexWindowStart = alignHexWindow(parentRow.node.offset);
        renderFieldTree(decoded, activeView);
        renderDetailPanes(getSelectedItem(), activeView);
      }
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      const first = flatRows[0]!;
      state.selectedNodeId = first.node.id;
      state.hexWindowStart = alignHexWindow(first.node.offset);
      renderFieldTree(decoded, activeView);
      renderDetailPanes(getSelectedItem(), activeView);
    } else if (ev.key === 'End') {
      ev.preventDefault();
      const last = flatRows[flatRows.length - 1]!;
      state.selectedNodeId = last.node.id;
      state.hexWindowStart = alignHexWindow(last.node.offset);
      renderFieldTree(decoded, activeView);
      renderDetailPanes(getSelectedItem(), activeView);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      void copyText(current.node.summary, current.node.label);
    }
  });

  treeEl.appendChild(frag);
  viewport.appendChild(treeEl);

  const selectedEl = state.selectedNodeId ? rowElements.get(state.selectedNodeId) : null;
  if (selectedEl) {
    requestAnimationFrame(() => {
      const top = selectedEl.offsetTop - viewport.offsetTop;
      const bottom = top + selectedEl.offsetHeight;
      if (top < viewport.scrollTop) {
        viewport.scrollTop = Math.max(0, top - 12);
      } else if (bottom > viewport.scrollTop + viewport.clientHeight) {
        viewport.scrollTop = bottom - viewport.clientHeight + 12;
      }
    });
  }
}

function renderNonMessageEnvelope(view: InspectedEnvelopeView): void {
  const viewport = el<HTMLElement>('tree-viewport');
  viewport.replaceChildren();
  const env = view.envelope;

  const card = document.createElement('div');
  card.className = `state-card${env.kind === 'error-json' || env.endStream?.error ? ' is-error' : ''}`;

  const title = document.createElement('h2');
  title.className = 'state-title';
  if (env.kind === 'end-stream') {
    title.textContent = env.endStream?.error
      ? `Connect EndStreamResponse Error: ${env.endStream.error.code ?? 'unknown'}`
      : 'Connect EndStreamResponse Metadata';
  } else if (env.kind === 'error-json') {
    title.textContent = `Connect Unary Error: ${env.endStream?.error?.code ?? 'error'}`;
  } else {
    title.textContent = 'gRPC-Web Stream Trailers';
  }

  const pre = document.createElement('pre');
  pre.className = 'json-pre';
  if (env.kind === 'trailers') {
    pre.textContent = formatDecodedJson(env.trailers ?? {}, 2);
  } else {
    pre.textContent = formatDecodedJson(env.endStream?.rawJson ?? {}, 2);
  }

  card.append(title, pre);
  viewport.appendChild(card);
}

function renderDecodeErrorCard(errText: string, item: CapturedItem): void {
  const viewport = el<HTMLElement>('tree-viewport');
  viewport.replaceChildren();

  const card = document.createElement('div');
  card.className = 'state-card is-error';

  const title = document.createElement('h2');
  title.className = 'state-title';
  title.textContent = 'OmniBuf wire decode failed';

  const copy = document.createElement('p');
  copy.className = 'state-copy';
  copy.textContent = `${errText}. Verify the endpoint emits OmniBuf rather than standard Protobuf, or switch the Protocol selector above (${item.protocolOverride === 'auto' ? item.classification.protocol : item.protocolOverride} active).`;

  card.append(title, copy);
  viewport.appendChild(card);
}

function renderWorkspace(): void {
  const item = getSelectedItem();
  if (!item) {
    renderEmptyWorkspace();
    return;
  }

  if (!item.classification.detected && !item.manualOverride) {
    renderManualOverrideGate(item);
    return;
  }

  el<HTMLElement>('inspector-header').hidden = false;
  const activeView = getActiveEnvelopeView();
  updateInspectorHeaderBar(item, activeView);

  const warnBanner = el<HTMLElement>('warning-banner');
  const warnings = state.inspected?.warnings ?? [];
  if (warnings.length > 0) {
    warnBanner.hidden = false;
    warnBanner.textContent = warnings.join(' | ');
  } else {
    warnBanner.hidden = true;
  }

  if (state.inspected) {
    renderEnvelopeStrip(state.inspected);
  } else {
    el<HTMLElement>('envelope-strip').hidden = true;
  }

  if (!activeView) {
    const viewport = el<HTMLElement>('tree-viewport');
    viewport.replaceChildren();
    const note = document.createElement('div');
    note.className = 'pane-empty-note';
    note.textContent = 'Empty response body (0 envelopes).';
    viewport.appendChild(note);
    renderDetailPanes(item, null);
    return;
  }

  if (activeView.decodeError) {
    renderDecodeErrorCard(activeView.decodeError, item);
  } else if (activeView.envelope.kind !== 'message') {
    renderNonMessageEnvelope(activeView);
  } else if (activeView.decoded) {
    renderFieldTree(activeView.decoded, activeView);
  }

  renderDetailPanes(item, activeView);
}

function renderKeyValueSection(
  parent: HTMLElement,
  heading: string,
  entries: Record<string, string>,
): void {
  const keys = Object.keys(entries);
  if (keys.length === 0) return;

  const sec = document.createElement('div');
  sec.className = 'kv-section';
  const h = document.createElement('h3');
  h.className = 'kv-heading';
  h.textContent = heading;

  const table = document.createElement('table');
  table.className = 'kv-table';
  const tbody = document.createElement('tbody');

  for (const k of keys) {
    const tr = document.createElement('tr');
    const tdK = document.createElement('td');
    tdK.textContent = k;
    const tdV = document.createElement('td');
    tdV.textContent = entries[k] ?? '';
    tr.append(tdK, tdV);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  sec.append(h, table);
  parent.appendChild(sec);
}

function updateMobileByteFooter(activeView: InspectedEnvelopeView | null): void {
  const footer = el<HTMLElement>('mobile-byte-footer');
  const summary = el<HTMLElement>('mobile-byte-summary');
  const selectedNode = activeView?.decoded
    ? findNodeById(activeView.decoded.nodes, state.selectedNodeId)
    : null;
  if (!selectedNode || state.mobileTab !== 'fields') {
    footer.hidden = true;
    return;
  }
  footer.hidden = false;
  const spacedHex = selectedNode.hexPreview.replace(/([0-9a-f]{2})(?=[0-9a-f])/gi, '$1 ');
  summary.textContent = `${selectedNode.label} · +${formatHex4(selectedNode.offset)} (${selectedNode.byteLength} B) · ${spacedHex}`;
}

function renderDetailPanes(
  item: CapturedItem | null,
  activeView: InspectedEnvelopeView | null,
): void {
  syncMobileAttributes();
  updateMobileByteFooter(activeView);
  const tabs: Array<{ key: DetailTab; btnId: string; panelId: string }> = [
    { key: 'hex', btnId: 'tab-hex', panelId: 'panel-hex' },
    { key: 'json', btnId: 'tab-json', panelId: 'panel-json' },
    { key: 'headers', btnId: 'tab-headers', panelId: 'panel-headers' },
  ];
  for (const t of tabs) {
    const active = state.detailTab === t.key;
    const btn = el<HTMLButtonElement>(t.btnId);
    const panel = el<HTMLElement>(t.panelId);
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
    panel.hidden = !active;
  }

  const hexPanel = el<HTMLElement>('panel-hex');
  const jsonPanel = el<HTMLElement>('panel-json');
  const headersPanel = el<HTMLElement>('panel-headers');

  if (!item) {
    hexPanel.replaceChildren();
    jsonPanel.replaceChildren();
    headersPanel.replaceChildren();
    const note = document.createElement('div');
    note.className = 'pane-empty-note';
    note.textContent = 'Select a response or open a .obuf file to inspect byte offsets.';
    hexPanel.appendChild(note);
    return;
  }

  // 1. Hex & Offsets
  if (state.detailTab === 'hex') {
    const packetBytes = activeView ? activeView.envelope.payload : (item.body ?? new Uint8Array(0));
    const selectedNode = activeView?.decoded
      ? findNodeById(activeView.decoded.nodes, state.selectedNodeId)
      : null;

    const useCompact8ByteRow = window.innerWidth < 520;
    renderHexInspector(hexPanel, {
      packet: packetBytes,
      selectedNode,
      isFieldNavigable: Boolean(activeView?.decoded),
      bytesPerRow: useCompact8ByteRow ? 8 : 16,
      windowStart: state.hexWindowStart,
      onChangeWindow(newStart) {
        state.hexWindowStart = newStart;
        renderDetailPanes(item, activeView);
      },
      onSelectByte(byteOffset) {
        if (!activeView?.decoded) return;
        const hit = findNodeAtByteOffset(activeView.decoded.nodes, byteOffset, state.showField0);
        if (!hit) return;
        for (const ancestor of hit.path.slice(0, -1)) {
          state.expandedNodeIds.add(ancestor.id);
        }
        state.selectedNodeId = hit.node.id;
        state.hexWindowStart = alignHexWindow(byteOffset);
        renderFieldTree(activeView.decoded, activeView);
        renderDetailPanes(item, activeView);
      },
    });
  }

  // 2. Decoded JSON
  if (state.detailTab === 'json') {
    jsonPanel.replaceChildren();
    const pre = document.createElement('pre');
    pre.className = 'json-pre';
    if (activeView?.decoded) {
      pre.textContent = activeView.decoded.jsonText;
    } else if (activeView?.envelope.endStream) {
      pre.textContent = formatDecodedJson(activeView.envelope.endStream.rawJson, 2);
    } else if (activeView?.envelope.trailers) {
      pre.textContent = formatDecodedJson(activeView.envelope.trailers, 2);
    } else {
      pre.textContent = '// No decoded OmniBuf message active';
    }
    jsonPanel.appendChild(pre);
  }

  // 3. Headers & Meta
  if (state.detailTab === 'headers') {
    headersPanel.replaceChildren();
    renderKeyValueSection(headersPanel, 'Transport Summary', {
      url: item.url,
      method: item.method,
      status: String(item.status),
      'detected-protocol': state.inspected?.protocol ?? item.classification.protocol,
      'detection-source': item.manualOverride ? 'manual override' : item.classification.reason,
      'wire-bytes': `${(item.body ? item.body.byteLength : item.reportedSize).toLocaleString()} B`,
    });
    renderKeyValueSection(headersPanel, 'Response Headers', item.responseHeaders);
    renderKeyValueSection(headersPanel, 'Request Headers', item.requestHeaders);

    if (state.inspected) {
      for (const view of state.inspected.envelopes) {
        if (view.envelope.trailers) {
          renderKeyValueSection(headersPanel, 'gRPC-Web Trailers', view.envelope.trailers);
        }
        if (view.envelope.endStream?.metadata) {
          const flatMeta: Record<string, string> = {};
          for (const [k, vals] of Object.entries(view.envelope.endStream.metadata)) {
            flatMeta[k] = Array.isArray(vals) ? vals.join(', ') : String(vals);
          }
          renderKeyValueSection(headersPanel, 'Connect EndStream Metadata', flatMeta);
        }
      }
    }
  }
}

async function importObufFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  if (list.length === 0) return;

  let firstNewId: string | null = null;
  for (const file of list) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const item = createCapturedItem({
      id,
      source: 'file',
      url: `file:///${file.name}`,
      method: 'FILE',
      status: 200,
      mimeType: 'application/x-omnibuf',
      body: buf,
      manualOverride: true,
    });
    state.items.push(item);
    if (!firstNewId) firstNewId = id;
  }

  if (firstNewId) {
    await selectItem(firstNewId);
    showToast(`Opened ${list.length === 1 ? list[0]!.name : `${list.length} files`}`);
  }
}

async function loadSyntheticSamples(): Promise<void> {
  state.items = state.items.filter((i) => i.source !== 'synthetic');
  const fixtures = await buildSyntheticTrafficFixtures();
  state.items.push(...fixtures);
  renderRequestList();
  if (fixtures[0]) {
    await selectItem(fixtures[0].id);
  }
}

function expandOrCollapseAll(expand: boolean): void {
  const activeView = getActiveEnvelopeView();
  if (!activeView?.decoded) return;
  if (!expand) {
    state.expandedNodeIds.clear();
  } else {
    const visit = (nodes: FieldTreeNode[]): void => {
      for (const n of nodes) {
        if (n.children.length > 0) {
          state.expandedNodeIds.add(n.id);
          visit(n.children);
        }
      }
    };
    visit(activeView.decoded.nodes);
  }
  renderFieldTree(activeView.decoded, activeView);
}

function wireDomEvents(): void {
  el<HTMLButtonElement>('scope-omnibuf').addEventListener('click', () => {
    state.scope = 'omnibuf';
    renderRequestList();
  });

  el<HTMLButtonElement>('scope-all').addEventListener('click', () => {
    state.scope = 'all';
    renderRequestList();
  });

  el<HTMLInputElement>('request-filter').addEventListener('input', (ev) => {
    state.requestFilter = (ev.target as HTMLInputElement).value;
    renderRequestList();
  });

  el<HTMLInputElement>('preserve-log').addEventListener('change', (ev) => {
    state.preserveLog = (ev.target as HTMLInputElement).checked;
  });

  const fileInput = el<HTMLInputElement>('obuf-file-input');
  el<HTMLButtonElement>('btn-open-obuf').addEventListener('click', () => {
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      void importObufFiles(fileInput.files);
      fileInput.value = '';
    }
  });

  el<HTMLButtonElement>('btn-clear').addEventListener('click', () => {
    state.items = [];
    state.bodyLoaders.clear();
    state.selectedItemId = null;
    state.inspected = null;
    renderRequestList();
    renderWorkspace();
  });

  el<HTMLButtonElement>('btn-theme').addEventListener('click', () => {
    const order: ThemePref[] = ['auto', 'dark', 'light'];
    const nextIdx = (order.indexOf(state.themePref) + 1) % order.length;
    state.themePref = order[nextIdx]!;
    applyTheme();
  });

  el<HTMLSelectElement>('protocol-select').addEventListener('change', (ev) => {
    const item = getSelectedItem();
    if (!item) return;
    item.protocolOverride = (ev.target as HTMLSelectElement).value as ProtocolId;
    item.manualOverride = true;
    state.selectedEnvelopeIdx = 0;
    state.selectedNodeId = null;
    void runInspectionForSelectedItem(true);
  });

  el<HTMLInputElement>('field-filter').addEventListener('input', (ev) => {
    state.fieldFilter = (ev.target as HTMLInputElement).value;
    const activeView = getActiveEnvelopeView();
    if (activeView?.decoded) {
      renderFieldTree(activeView.decoded, activeView);
    }
  });

  el<HTMLInputElement>('toggle-field0').addEventListener('change', (ev) => {
    state.showField0 = (ev.target as HTMLInputElement).checked;
    const activeView = getActiveEnvelopeView();
    if (activeView?.decoded) {
      renderFieldTree(activeView.decoded, activeView);
      renderDetailPanes(getSelectedItem(), activeView);
    }
  });

  el<HTMLButtonElement>('btn-expand-all').addEventListener('click', () =>
    expandOrCollapseAll(true),
  );
  el<HTMLButtonElement>('btn-collapse-all').addEventListener('click', () =>
    expandOrCollapseAll(false),
  );

  el<HTMLButtonElement>('btn-copy-json').addEventListener('click', () => {
    const activeView = getActiveEnvelopeView();
    if (activeView?.decoded) {
      void copyText(activeView.decoded.jsonText, 'JSON');
    }
  });

  el<HTMLButtonElement>('btn-export-json').addEventListener('click', () => {
    const item = getSelectedItem();
    const activeView = getActiveEnvelopeView();
    if (!item || !activeView?.decoded) return;
    const baseName =
      item.displayPath
        .split('/')
        .pop()
        ?.replace(/[^a-zA-Z0-9._-]/g, '_') || 'omnibuf-message';
    const suffix =
      (state.inspected?.envelopes.length ?? 0) > 1 ? `-${state.selectedEnvelopeIdx}` : '';
    downloadBlob(activeView.decoded.jsonText, `${baseName}${suffix}.json`, 'application/json');
    showToast('Exported .json');
  });

  el<HTMLButtonElement>('btn-save-obuf').addEventListener('click', () => {
    const item = getSelectedItem();
    const activeView = getActiveEnvelopeView();
    if (!item || !activeView) return;
    const baseName =
      item.displayPath
        .split('/')
        .pop()
        ?.replace(/\.obuf$/i, '')
        .replace(/[^a-zA-Z0-9._-]/g, '_') || 'packet';
    const suffix =
      (state.inspected?.envelopes.length ?? 0) > 1 ? `-${state.selectedEnvelopeIdx}` : '';
    downloadBlob(activeView.envelope.payload, `${baseName}${suffix}.obuf`, 'application/x-omnibuf');
    showToast('Saved .obuf');
  });

  for (const [tabId, key] of [
    ['tab-hex', 'hex'],
    ['tab-json', 'json'],
    ['tab-headers', 'headers'],
  ] as const) {
    el<HTMLButtonElement>(tabId).addEventListener('click', () => {
      state.detailTab = key;
      if (state.mobileTab !== 'fields') {
        state.mobileTab = key;
      }
      renderDetailPanes(getSelectedItem(), getActiveEnvelopeView());
    });
  }

  el<HTMLButtonElement>('btn-mobile-back').addEventListener('click', () => {
    state.mobileScreen = 'list';
    syncMobileAttributes();
  });

  el<HTMLButtonElement>('btn-mobile-jump-hex').addEventListener('click', () => {
    state.mobileTab = 'hex';
    state.detailTab = 'hex';
    renderDetailPanes(getSelectedItem(), getActiveEnvelopeView());
  });

  for (const [mTabId, key] of [
    ['mtab-fields', 'fields'],
    ['mtab-hex', 'hex'],
    ['mtab-json', 'json'],
    ['mtab-headers', 'headers'],
  ] as const) {
    el<HTMLButtonElement>(mTabId).addEventListener('click', () => {
      state.mobileTab = key;
      if (key !== 'fields') {
        state.detailTab = key;
      }
      renderDetailPanes(getSelectedItem(), getActiveEnvelopeView());
    });
  }

  let wasCompactHex = window.innerWidth < 520;
  window.addEventListener('resize', () => {
    const nowCompact = window.innerWidth < 520;
    if (nowCompact !== wasCompactHex && state.detailTab === 'hex') {
      wasCompactHex = nowCompact;
      renderDetailPanes(getSelectedItem(), getActiveEnvelopeView());
    }
  });

  // Full-panel .obuf drag and drop
  const dropOverlay = el<HTMLElement>('drop-overlay');
  let dragDepth = 0;

  window.addEventListener('dragenter', (ev) => {
    if (!ev.dataTransfer?.types.includes('Files')) return;
    ev.preventDefault();
    dragDepth++;
    dropOverlay.hidden = false;
  });

  window.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types.includes('Files')) return;
    ev.preventDefault();
  });

  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.hidden = true;
  });

  window.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    if (ev.dataTransfer?.files && ev.dataTransfer.files.length > 0) {
      void importObufFiles(ev.dataTransfer.files);
    }
  });
}

async function bootstrap(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const themeParam = params.get('theme');
  if (themeParam === 'light' || themeParam === 'dark') {
    state.themePref = themeParam;
  }
  applyTheme();
  wireDomEvents();

  startNetworkCapture({
    onItemCaptured(item, loadBody) {
      state.items.push(item);
      state.bodyLoaders.set(item.id, loadBody);
      renderRequestList();
      if (!state.selectedItemId && item.classification.detected) {
        void selectItem(item.id);
      }
    },
    onItemUpdated(updated) {
      renderRequestList();
      if (updated.id === state.selectedItemId) {
        void runInspectionForSelectedItem(false);
      }
    },
    onNavigated() {
      if (state.preserveLog) return;
      state.items = state.items.filter((i) => i.source !== 'network');
      if (state.selectedItemId && !state.items.some((i) => i.id === state.selectedItemId)) {
        state.selectedItemId = null;
        state.inspected = null;
      }
      renderRequestList();
      renderWorkspace();
    },
  });

  if (params.get('demo') === '1') {
    await loadSyntheticSamples();
    const envParam = params.get('envelope');
    if (envParam !== null && !Number.isNaN(Number(envParam))) {
      state.selectedEnvelopeIdx = Number(envParam);
    }
    const itemParam = params.get('item');
    if (itemParam && state.items.some((i) => i.id === itemParam)) {
      await selectItem(itemParam);
      if (envParam !== null && !Number.isNaN(Number(envParam))) {
        state.selectedEnvelopeIdx = Number(envParam);
        renderWorkspace();
      }
    }
    const mScreen = params.get('mobileScreen');
    if (mScreen === 'list' || mScreen === 'detail') {
      state.mobileScreen = mScreen;
    }
    const mTab = params.get('mobileTab');
    if (mTab === 'fields' || mTab === 'hex' || mTab === 'json' || mTab === 'headers') {
      state.mobileTab = mTab;
      if (mTab !== 'fields') state.detailTab = mTab;
      renderDetailPanes(getSelectedItem(), getActiveEnvelopeView());
    }
    syncMobileAttributes();
    return;
  }

  renderRequestList();
  renderWorkspace();
}

void bootstrap();
