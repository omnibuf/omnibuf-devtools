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

type ThemeMode = 'dark' | 'light';
type ViewTab = 'tree' | 'json' | 'headers';
type MobileScreen = 'list' | 'detail';

interface PanelState {
  items: CapturedItem[];
  bodyLoaders: Map<string, () => Promise<void>>;
  scope: 'omnibuf' | 'all';
  requestFilter: string;
  fieldFilter: string;
  preserveLog: boolean;
  showField0: boolean;
  theme: ThemeMode;
  selectedItemId: string | null;
  selectedEnvelopeIdx: number;
  selectedNodeId: string | null;
  expandedNodeIds: Set<string>;
  activeTab: ViewTab;
  hexOpen: boolean;
  mobileScreen: MobileScreen;
  hexWindowStart: number;
  inspected: InspectedTrafficResult | null;
  inspectSeq: number;
}

const MAX_CAPTURED_ITEMS = 500;
const MAX_LOCAL_FILE_BYTES = 32 * 1024 * 1024;

const state: PanelState = {
  items: [],
  bodyLoaders: new Map(),
  scope: 'omnibuf',
  requestFilter: '',
  fieldFilter: '',
  preserveLog: false,
  showField0: false,
  theme: 'dark',
  selectedItemId: null,
  selectedEnvelopeIdx: 0,
  selectedNodeId: null,
  expandedNodeIds: new Set(),
  activeTab: 'tree',
  hexOpen: false,
  mobileScreen: 'list',
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
  }, 2000);
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

const SVG_NS = 'http://www.w3.org/2000/svg';

function createSvg(size: number, viewBox = `0 0 ${size} ${size}`): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon-svg');
  return svg;
}

function strokePath(d: string): SVGPathElement {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  return path;
}

function createBackArrowIcon(): SVGSVGElement {
  const svg = createSvg(14, '0 0 14 14');
  svg.appendChild(strokePath('M8.75 3L4.75 7L8.75 11'));
  return svg;
}

function createCloseIcon(): SVGSVGElement {
  const svg = createSvg(14, '0 0 14 14');
  svg.appendChild(strokePath('M3.75 3.75L10.25 10.25M10.25 3.75L3.75 10.25'));
  return svg;
}

function createMoreDotsIcon(): SVGSVGElement {
  const svg = createSvg(16, '0 0 16 16');
  for (const cx of [3.5, 8, 12.5]) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', '8');
    c.setAttribute('r', '1.2');
    c.setAttribute('fill', 'currentColor');
    svg.appendChild(c);
  }
  return svg;
}

function createThemeIcon(mode: ThemeMode): SVGSVGElement {
  const svg = createSvg(15, '0 0 16 16');
  if (mode === 'dark') {
    // Show sun icon to switch to light
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', '8');
    c.setAttribute('cy', '8');
    c.setAttribute('r', '3');
    c.setAttribute('stroke', 'currentColor');
    c.setAttribute('stroke-width', '1.5');
    svg.appendChild(c);
    svg.appendChild(
      strokePath(
        'M8 1.75V3M8 13V14.25M1.75 8H3M13 8H14.25M3.58 3.58L4.46 4.46M11.54 11.54L12.42 12.42M12.42 3.58L11.54 4.46M4.46 11.54L3.58 12.42',
      ),
    );
  } else {
    // Show moon icon to switch to dark
    svg.appendChild(strokePath('M13.25 9.75A5.5 5.5 0 0 1 6.25 2.75a5.5 5.5 0 1 0 7 7Z'));
  }
  return svg;
}

function createTreeChevronIcon(expanded: boolean): SVGSVGElement {
  const svg = createSvg(10, '0 0 10 10');
  svg.classList.add('twisty-chevron');
  if (expanded) svg.classList.add('is-expanded');
  svg.appendChild(strokePath('M3.25 2L6.75 5L3.25 8'));
  return svg;
}

function applyTheme(): void {
  document.documentElement.dataset.theme = state.theme;
  const btn = el<HTMLButtonElement>('btn-theme');
  const nextLabel = state.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  btn.title = nextLabel;
  btn.setAttribute('aria-label', nextLabel);
  btn.replaceChildren(createThemeIcon(state.theme));
}

function syncStaticIcons(): void {
  el<HTMLElement>('more-menu-trigger').replaceChildren(createMoreDotsIcon());
  el<HTMLButtonElement>('btn-close-hex').replaceChildren(createCloseIcon());
}

function syncLayoutAttributes(): void {
  const app = el<HTMLElement>('app');
  const screen: MobileScreen = state.selectedItemId ? state.mobileScreen : 'list';
  app.dataset.mobileScreen = screen;
  app.dataset.hexOpen = String(state.hexOpen);
  app.dataset.empty = String(state.items.length === 0);

  const hexPane = el<HTMLElement>('pane-hex');
  hexPane.hidden = !state.hexOpen;

  const hexBtn = el<HTMLButtonElement>('btn-toggle-hex');
  hexBtn.classList.toggle('is-active', state.hexOpen);
  hexBtn.setAttribute('aria-pressed', String(state.hexOpen));

  const backBtn = el<HTMLButtonElement>('btn-mobile-back');
  backBtn.replaceChildren(createBackArrowIcon(), document.createTextNode('Requests'));

  el<HTMLElement>('demo-badge').hidden = !state.items.some((i) => i.source === 'synthetic');
}

function trimCapturedItems(): void {
  if (state.items.length <= MAX_CAPTURED_ITEMS) return;
  const overflow = state.items.length - MAX_CAPTURED_ITEMS;
  const evicted = state.items.splice(0, overflow);
  let selectedEvicted = false;
  for (const item of evicted) {
    state.bodyLoaders.delete(item.id);
    if (item.id === state.selectedItemId) {
      selectedEvicted = true;
    }
  }
  if (selectedEvicted) {
    state.selectedItemId = null;
    state.inspected = null;
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

function formatQuietProtocol(item: CapturedItem): string {
  if (item.source === 'file') return 'Local .obuf';
  if (!item.classification.detected && !item.manualOverride) return 'Untagged';
  const proto =
    item.protocolOverride !== 'auto' ? item.protocolOverride : item.classification.protocol;
  switch (proto) {
    case 'connect-streaming':
      return 'Connect stream';
    case 'connect-unary':
      return 'Connect';
    case 'grpc-web':
      return 'gRPC-Web';
    case 'grpc-web-text':
      return 'gRPC-Web text';
    case 'raw':
      return item.classification.reason === 'file-extension' ? '.obuf' : 'HTTP';
  }
}

function updateCountsAndScopeUI(): void {
  const omniCount = state.items.filter(
    (it) => it.classification.detected || it.manualOverride,
  ).length;
  el<HTMLElement>('count-omnibuf').textContent = String(omniCount);
  el<HTMLElement>('count-all').textContent = String(state.items.length);
  syncLayoutAttributes();

  const btnOmni = el<HTMLButtonElement>('scope-omnibuf');
  const btnAll = el<HTMLButtonElement>('scope-all');
  const isOmni = state.scope === 'omnibuf';
  btnOmni.classList.toggle('is-active', isOmni);
  btnOmni.setAttribute('aria-pressed', String(isOmni));
  btnAll.classList.toggle('is-active', !isOmni);
  btnAll.setAttribute('aria-pressed', String(!isOmni));
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
      state.items.length > 0 ? 'No matching OmniBuf requests.' : 'No requests captured.';
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
    row.title = item.url;

    const top = document.createElement('div');
    top.className = 'req-row-top';

    const path = document.createElement('span');
    path.className = 'req-row-path';
    path.textContent = item.displayPath;
    top.appendChild(path);

    const isErr = item.status >= 400 || item.classification.isConnectUnaryError;
    if (isErr) {
      const status = document.createElement('span');
      status.className = 'status-pill status-err';
      status.textContent = String(item.status || 'ERR');
      top.appendChild(status);
    }

    const sub = document.createElement('div');
    sub.className = 'req-row-sub';
    sub.textContent =
      item.source === 'file' ? 'Local .obuf' : `${item.method} · ${formatQuietProtocol(item)}`;

    row.append(top, sub);
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

function updateInspectorBar(
  item: CapturedItem | null,
  activeView: InspectedEnvelopeView | null,
): void {
  const bar = el<HTMLElement>('inspector-bar');
  if (!item) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  const tabs: Array<{ key: ViewTab; id: string }> = [
    { key: 'tree', id: 'vtab-tree' },
    { key: 'json', id: 'vtab-json' },
    { key: 'headers', id: 'vtab-headers' },
  ];
  for (const t of tabs) {
    const btn = el<HTMLButtonElement>(t.id);
    const active = state.activeTab === t.key;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  }

  const decoded = activeView?.decoded ?? null;
  const typeHint = el<HTMLElement>('schema-type-hint');
  if (decoded?.typeName) {
    typeHint.hidden = false;
    typeHint.textContent = decoded.typeName;
    typeHint.title = `Embedded Field #0 schema: ${decoded.typeName}`;
  } else {
    typeHint.hidden = true;
    typeHint.textContent = '';
  }

  el<HTMLElement>('field-filter-wrap').hidden = state.activeTab !== 'tree' || !decoded;

  const protoSelect = el<HTMLSelectElement>('protocol-select');
  const autoOpt = protoSelect.querySelector<HTMLOptionElement>('option[value="auto"]');
  if (autoOpt) {
    autoOpt.textContent = `Auto (${item.classification.protocol})`;
  }
  protoSelect.value = item.protocolOverride;

  const hasCopyableJson = Boolean(
    decoded || activeView?.envelope.endStream || activeView?.envelope.trailers,
  );
  el<HTMLButtonElement>('btn-copy-json').disabled = !hasCopyableJson;
  el<HTMLButtonElement>('btn-export-json').disabled = !decoded;
  el<HTMLButtonElement>('btn-expand-all').disabled = !decoded;
  el<HTMLButtonElement>('btn-collapse-all').disabled = !decoded;
  el<HTMLButtonElement>('btn-save-obuf').disabled =
    !activeView || activeView.envelope.payload.byteLength === 0;
}

function renderEmptyWorkspace(): void {
  updateInspectorBar(null, null);
  el<HTMLElement>('warning-banner').hidden = true;
  el<HTMLElement>('envelope-strip').hidden = true;

  const viewport = el<HTMLElement>('main-viewport');
  viewport.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'empty-state';

  const title = document.createElement('h2');
  title.className = 'empty-title';
  title.textContent = isRunningInDevTools()
    ? 'Listening for OmniBuf responses'
    : 'No OmniBuf traffic yet';

  const copy = document.createElement('p');
  copy.className = 'empty-copy';
  copy.textContent = 'Capture network responses automatically, or drop a .obuf file.';

  const actions = document.createElement('div');
  actions.className = 'empty-actions';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn-signal';
  openBtn.textContent = 'Open .obuf';
  openBtn.addEventListener('click', () => el<HTMLInputElement>('obuf-file-input').click());

  const demoBtn = document.createElement('button');
  demoBtn.type = 'button';
  demoBtn.className = 'btn-tool';
  demoBtn.textContent = 'Load sample';
  demoBtn.addEventListener('click', () => {
    void loadSyntheticSamples();
  });

  actions.append(openBtn, demoBtn);

  if (state.items.length > 0 && state.scope === 'omnibuf') {
    const showAllBtn = document.createElement('button');
    showAllBtn.type = 'button';
    showAllBtn.className = 'btn-tool';
    showAllBtn.textContent = `Show all (${state.items.length})`;
    showAllBtn.addEventListener('click', () => {
      state.scope = 'all';
      renderRequestList();
    });
    actions.appendChild(showAllBtn);
  }

  wrap.append(title, copy, actions);
  viewport.appendChild(wrap);

  renderHexPane(null, null);
}

function renderManualOverrideGate(item: CapturedItem): void {
  updateInspectorBar(item, null);
  el<HTMLElement>('warning-banner').hidden = true;
  el<HTMLElement>('envelope-strip').hidden = true;

  if (state.activeTab === 'headers') {
    renderHeadersView(el<HTMLElement>('main-viewport'), item);
    renderHexPane(item, null);
    return;
  }

  const viewport = el<HTMLElement>('main-viewport');
  viewport.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'empty-state';

  const title = document.createElement('h2');
  title.className = 'empty-title';
  title.textContent = 'Untagged binary response';

  const media = item.classification.mediaType || 'unspecified Content-Type';
  const bodyLen = item.body ? item.body.byteLength : item.reportedSize;

  const copy = document.createElement('p');
  copy.className = 'empty-copy';
  copy.textContent = `${media} · ${formatBytes(bodyLen)}`;

  const actions = document.createElement('div');
  actions.className = 'empty-actions';

  const decodeBtn = document.createElement('button');
  decodeBtn.type = 'button';
  decodeBtn.className = 'btn-signal';
  decodeBtn.textContent = 'Decode as OmniBuf';
  decodeBtn.addEventListener('click', () => {
    item.manualOverride = true;
    void runInspectionForSelectedItem(true);
  });

  actions.appendChild(decodeBtn);
  wrap.append(title, copy, actions);
  viewport.appendChild(wrap);

  renderHexPane(item, null);
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

  let msgCounter = 0;
  result.envelopes.forEach((view, idx) => {
    const env = view.envelope;
    const btn = document.createElement('button');
    btn.type = 'button';
    const hasErr = Boolean(view.decodeError || env.error || env.endStream?.error);
    btn.className = `env-chip${idx === state.selectedEnvelopeIdx ? ' is-active' : ''}${hasErr ? ' is-error' : ''}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(idx === state.selectedEnvelopeIdx));

    if (env.kind === 'message') {
      msgCounter++;
      btn.textContent = `Message ${msgCounter}`;
      const compNote = env.compressed
        ? `${env.compressionEncoding ?? 'compressed'} -> ${formatBytes(env.payload.byteLength)}`
        : formatBytes(env.payload.byteLength);
      btn.title = `Frame #${idx} · ${compNote} · +${formatHex4(env.wireOffset)}`;
    } else if (env.kind === 'end-stream') {
      btn.textContent = env.endStream?.error ? 'End (error)' : 'End stream';
      btn.title = `${formatEndStreamSummary(env.endStream)} · +${formatHex4(env.wireOffset)}`;
    } else if (env.kind === 'trailers') {
      const status = env.trailers?.['grpc-status'];
      btn.textContent = status && status !== '0' ? `Trailers (${status})` : 'Trailers';
      btn.title = status ? `grpc-status: ${status}` : 'gRPC-Web trailers';
    } else {
      btn.textContent = 'Error';
      btn.title = formatEndStreamSummary(env.endStream);
    }

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

function valueToneClass(node: FieldTreeNode, hasChildren: boolean): string {
  if (hasChildren) return ' val-container';
  const wt = node.wireTypeLabel;
  if (wt === 'string' || wt.endsWith('-> string')) return ' val-string';
  if (wt === 'bytes' || wt.startsWith('extended') || wt.endsWith('-> bytes')) return ' val-bytes';
  return ' val-number';
}

function formatExpandedHint(node: FieldTreeNode): string {
  if (node.wireTypeLabel === 'submsg' || node.kind === 'schema') {
    const braceIdx = node.summary.indexOf('{');
    if (braceIdx > 0) {
      return node.summary.slice(0, braceIdx).trim();
    }
  }
  return '';
}

function formatHoverMeta(node: FieldTreeNode): string {
  const parts: string[] = [];
  if (node.fieldNumber !== null) {
    parts.push(`#${node.fieldNumber}`);
  }
  const cleanWt = node.wireTypeLabel.startsWith('bool=') ? 'bool' : node.wireTypeLabel;
  parts.push(cleanWt);
  parts.push(`${node.byteLength} B`);
  if (node.children.length === 0 && node.hexPreview) {
    const shortHex =
      node.hexPreview.length > 16 ? `${node.hexPreview.slice(0, 16)}…` : node.hexPreview;
    parts.push(`0x${shortHex}`);
  }
  return parts.join(' · ');
}

function renderFieldTree(
  decoded: DecodedOmniBufMessage,
  activeView: InspectedEnvelopeView,
  restoreFocus = false,
): void {
  const viewport = el<HTMLElement>('main-viewport');
  const hadTreeFocus =
    restoreFocus ||
    (document.activeElement instanceof HTMLElement && viewport.contains(document.activeElement));
  viewport.replaceChildren();

  if (decoded.byteLength === 0) {
    const empty = document.createElement('div');
    empty.className = 'pane-empty-note';
    empty.textContent = 'Empty message (0 B).';
    viewport.appendChild(empty);
    return;
  }

  const flatRows = flattenVisibleTree(decoded.nodes);
  if (flatRows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pane-empty-note';
    empty.textContent = state.fieldFilter
      ? `No fields matching "${state.fieldFilter}".`
      : 'Message contains only Field #0 metadata.';
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
    row.className = `tree-row${isSelected ? ' is-selected' : ''}${hasChildren ? ' is-branch' : ''}`;
    row.style.setProperty('--depth', String(depth));
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-selected', String(isSelected));
    if (hasChildren) {
      row.setAttribute('aria-expanded', String(isExpanded));
    }
    row.dataset.nodeId = node.id;

    const hoverText = formatHoverMeta(node);
    row.title = `${hoverText} · +${formatHex4(node.offset)}`;

    const twisty = document.createElement('span');
    twisty.className = 'tree-twisty';
    if (hasChildren) {
      twisty.appendChild(createTreeChevronIcon(isExpanded));
    }

    const key = document.createElement('span');
    key.className = `tree-key${!node.isSchemaResolved ? ' is-blind' : ''}${node.kind === 'schema' ? ' is-schema-key' : ''}`;
    key.textContent = hasChildren && isExpanded ? node.label : `${node.label}:`;

    row.append(twisty, key);

    const displaySummary = hasChildren && isExpanded ? formatExpandedHint(node) : node.summary;
    if (displaySummary) {
      const val = document.createElement('span');
      val.className = `tree-val${valueToneClass(node, hasChildren)}`;
      val.textContent = displaySummary;
      row.appendChild(val);
    }

    const hoverMeta = document.createElement('span');
    hoverMeta.className = 'tree-hover-meta';
    hoverMeta.textContent = hoverText;
    row.appendChild(hoverMeta);

    row.addEventListener('click', () => {
      if (hasChildren && !state.fieldFilter.trim()) {
        if (state.expandedNodeIds.has(node.id)) {
          state.expandedNodeIds.delete(node.id);
        } else {
          state.expandedNodeIds.add(node.id);
        }
      }
      state.selectedNodeId = node.id;
      state.hexWindowStart = alignHexWindow(node.offset);
      renderFieldTree(decoded, activeView, true);
      renderHexPane(getSelectedItem(), activeView);
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
        renderHexPane(getSelectedItem(), activeView);
      }
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      const prev = flatRows[Math.max(0, idx - 1)];
      if (prev) {
        state.selectedNodeId = prev.node.id;
        state.hexWindowStart = alignHexWindow(prev.node.offset);
        renderFieldTree(decoded, activeView);
        renderHexPane(getSelectedItem(), activeView);
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
        renderHexPane(getSelectedItem(), activeView);
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
        renderHexPane(getSelectedItem(), activeView);
      }
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      const first = flatRows[0]!;
      state.selectedNodeId = first.node.id;
      state.hexWindowStart = alignHexWindow(first.node.offset);
      renderFieldTree(decoded, activeView);
      renderHexPane(getSelectedItem(), activeView);
    } else if (ev.key === 'End') {
      ev.preventDefault();
      const last = flatRows[flatRows.length - 1]!;
      state.selectedNodeId = last.node.id;
      state.hexWindowStart = alignHexWindow(last.node.offset);
      renderFieldTree(decoded, activeView);
      renderHexPane(getSelectedItem(), activeView);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      void copyText(current.node.summary, current.node.label);
    }
  });

  treeEl.appendChild(frag);
  viewport.appendChild(treeEl);
  if (hadTreeFocus) {
    treeEl.focus({ preventScroll: true });
  }

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

function renderJsonView(viewport: HTMLElement, activeView: InspectedEnvelopeView | null): void {
  viewport.replaceChildren();
  const pre = document.createElement('pre');
  pre.className = 'json-pre';
  if (activeView?.decoded) {
    pre.textContent = activeView.decoded.jsonText;
  } else if (activeView?.envelope.endStream) {
    pre.textContent = formatDecodedJson(activeView.envelope.endStream.rawJson, 2);
  } else if (activeView?.envelope.trailers) {
    pre.textContent = formatDecodedJson(activeView.envelope.trailers, 2);
  } else {
    pre.textContent = '{}';
  }
  viewport.appendChild(pre);
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

function renderHeadersView(viewport: HTMLElement, item: CapturedItem): void {
  viewport.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'headers-wrap';

  renderKeyValueSection(wrap, 'General', {
    url: item.url,
    method: item.method,
    status: String(item.status),
    protocol: state.inspected?.protocol ?? item.classification.protocol,
    size: formatBytes(item.body ? item.body.byteLength : item.reportedSize),
  });
  renderKeyValueSection(wrap, 'Response Headers', item.responseHeaders);
  renderKeyValueSection(wrap, 'Request Headers', item.requestHeaders);

  if (state.inspected) {
    for (const view of state.inspected.envelopes) {
      if (view.envelope.trailers) {
        renderKeyValueSection(wrap, 'Trailers', view.envelope.trailers);
      }
      if (view.envelope.endStream?.metadata) {
        const flatMeta: Record<string, string> = {};
        for (const [k, vals] of Object.entries(view.envelope.endStream.metadata)) {
          flatMeta[k] = Array.isArray(vals) ? vals.join(', ') : String(vals);
        }
        renderKeyValueSection(wrap, 'Stream Metadata', flatMeta);
      }
    }
  }

  viewport.appendChild(wrap);
}

function renderNonMessageEnvelope(view: InspectedEnvelopeView): void {
  const viewport = el<HTMLElement>('main-viewport');
  viewport.replaceChildren();
  const env = view.envelope;

  const wrap = document.createElement('div');
  wrap.className = 'envelope-meta-view';

  const heading = document.createElement('div');
  heading.className = `envelope-meta-heading${env.kind === 'error-json' || env.endStream?.error ? ' is-error' : ''}`;
  if (env.kind === 'end-stream') {
    heading.textContent = env.endStream?.error
      ? `Stream ended with error (${env.endStream.error.code ?? 'unknown'})`
      : 'End of stream metadata';
  } else if (env.kind === 'error-json') {
    heading.textContent = `RPC error (${env.endStream?.error?.code ?? 'unknown'})`;
  } else {
    heading.textContent = 'gRPC-Web trailers';
  }

  const pre = document.createElement('pre');
  pre.className = 'json-pre';
  pre.textContent =
    env.kind === 'trailers'
      ? formatDecodedJson(env.trailers ?? {}, 2)
      : formatDecodedJson(env.endStream?.rawJson ?? {}, 2);

  wrap.append(heading, pre);
  viewport.appendChild(wrap);
}

function renderDecodeError(errText: string, item: CapturedItem): void {
  const viewport = el<HTMLElement>('main-viewport');
  viewport.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'empty-state is-error';

  const title = document.createElement('h2');
  title.className = 'empty-title';
  title.textContent = 'Could not decode as OmniBuf';

  const proto =
    item.protocolOverride === 'auto' ? item.classification.protocol : item.protocolOverride;
  const copy = document.createElement('p');
  copy.className = 'empty-copy';
  copy.textContent = `${errText} (${proto}). Check the protocol setting in the menu.`;

  wrap.append(title, copy);
  viewport.appendChild(wrap);
}

function renderHexPane(item: CapturedItem | null, activeView: InspectedEnvelopeView | null): void {
  syncLayoutAttributes();
  if (!state.hexOpen) return;

  const hexPanel = el<HTMLElement>('panel-hex');
  const metaEl = el<HTMLElement>('hex-bar-meta');

  if (!item) {
    metaEl.textContent = '';
    hexPanel.replaceChildren();
    const note = document.createElement('div');
    note.className = 'pane-empty-note';
    note.textContent = 'Select a request to inspect bytes.';
    hexPanel.appendChild(note);
    return;
  }

  const packetBytes = activeView ? activeView.envelope.payload : (item.body ?? new Uint8Array(0));
  const selectedNode = activeView?.decoded
    ? findNodeById(activeView.decoded.nodes, state.selectedNodeId)
    : null;

  if (selectedNode) {
    metaEl.textContent = `${selectedNode.label} · +${formatHex4(selectedNode.offset)} · ${selectedNode.byteLength} B`;
  } else {
    metaEl.textContent = formatBytes(packetBytes.byteLength);
  }

  const useCompact8ByteRow = window.innerWidth < 520;
  renderHexInspector(hexPanel, {
    packet: packetBytes,
    selectedNode,
    bytesPerRow: useCompact8ByteRow ? 8 : 16,
    windowStart: state.hexWindowStart,
    onChangeWindow(newStart) {
      state.hexWindowStart = newStart;
      renderHexPane(item, activeView);
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
      if (state.activeTab === 'tree') {
        renderFieldTree(activeView.decoded, activeView);
      }
      renderHexPane(item, activeView);
    },
  });
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

  const activeView = getActiveEnvelopeView();
  updateInspectorBar(item, activeView);

  const warnBanner = el<HTMLElement>('warning-banner');
  const warnings = state.inspected?.warnings ?? [];
  if (warnings.length > 0) {
    warnBanner.hidden = false;
    warnBanner.textContent = warnings.join(' · ');
  } else {
    warnBanner.hidden = true;
  }

  if (state.inspected) {
    renderEnvelopeStrip(state.inspected);
  } else {
    el<HTMLElement>('envelope-strip').hidden = true;
  }

  const viewport = el<HTMLElement>('main-viewport');

  if (state.activeTab === 'headers') {
    renderHeadersView(viewport, item);
    renderHexPane(item, activeView);
    return;
  }

  if (state.activeTab === 'json') {
    renderJsonView(viewport, activeView);
    renderHexPane(item, activeView);
    return;
  }

  if (!activeView) {
    viewport.replaceChildren();
    const note = document.createElement('div');
    note.className = 'pane-empty-note';
    note.textContent = 'Empty response body.';
    viewport.appendChild(note);
    renderHexPane(item, null);
    return;
  }

  if (activeView.decodeError) {
    renderDecodeError(activeView.decodeError, item);
  } else if (activeView.envelope.kind !== 'message') {
    renderNonMessageEnvelope(activeView);
  } else if (activeView.decoded) {
    renderFieldTree(activeView.decoded, activeView);
  }

  renderHexPane(item, activeView);
}

async function importObufFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  if (list.length === 0) return;

  let firstNewId: string | null = null;
  let importedCount = 0;
  let skippedOversize = 0;
  let failedCount = 0;
  let lastImportedName = '';

  for (const file of list) {
    if (file.size > MAX_LOCAL_FILE_BYTES) {
      skippedOversize++;
      continue;
    }
    try {
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
      trimCapturedItems();
      if (!firstNewId) firstNewId = id;
      importedCount++;
      lastImportedName = file.name;
    } catch {
      failedCount++;
    }
  }

  if (firstNewId) {
    await selectItem(firstNewId);
  }
  if (skippedOversize > 0 || failedCount > 0) {
    const parts: string[] = [];
    if (importedCount > 0) parts.push(`opened ${importedCount}`);
    if (skippedOversize > 0) parts.push(`skipped ${skippedOversize} over 32 MB`);
    if (failedCount > 0) parts.push(`failed to read ${failedCount}`);
    showToast(parts.join(' · '));
  } else if (importedCount > 0) {
    showToast(`Opened ${importedCount === 1 ? lastImportedName : `${importedCount} files`}`);
  }
}

async function loadSyntheticSamples(): Promise<void> {
  state.items = state.items.filter((i) => i.source !== 'synthetic');
  const fixtures = await buildSyntheticTrafficFixtures();
  state.items.push(...fixtures);
  trimCapturedItems();
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
  if (state.activeTab === 'tree') {
    renderFieldTree(activeView.decoded, activeView);
  }
}

function closeMoreMenu(): void {
  el<HTMLDetailsElement>('more-menu').open = false;
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
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
  });

  for (const [tabId, key] of [
    ['vtab-tree', 'tree'],
    ['vtab-json', 'json'],
    ['vtab-headers', 'headers'],
  ] as const) {
    el<HTMLButtonElement>(tabId).addEventListener('click', () => {
      state.activeTab = key;
      renderWorkspace();
    });
  }

  el<HTMLButtonElement>('btn-toggle-hex').addEventListener('click', () => {
    state.hexOpen = !state.hexOpen;
    renderHexPane(getSelectedItem(), getActiveEnvelopeView());
  });

  el<HTMLButtonElement>('btn-close-hex').addEventListener('click', () => {
    state.hexOpen = false;
    renderHexPane(getSelectedItem(), getActiveEnvelopeView());
  });

  el<HTMLSelectElement>('protocol-select').addEventListener('change', (ev) => {
    const item = getSelectedItem();
    if (!item) return;
    item.protocolOverride = (ev.target as HTMLSelectElement).value as ProtocolId;
    item.manualOverride = true;
    state.selectedEnvelopeIdx = 0;
    state.selectedNodeId = null;
    closeMoreMenu();
    void runInspectionForSelectedItem(true);
  });

  el<HTMLInputElement>('field-filter').addEventListener('input', (ev) => {
    state.fieldFilter = (ev.target as HTMLInputElement).value;
    const activeView = getActiveEnvelopeView();
    if (state.activeTab === 'tree' && activeView?.decoded) {
      renderFieldTree(activeView.decoded, activeView);
    }
  });

  el<HTMLInputElement>('toggle-field0').addEventListener('change', (ev) => {
    state.showField0 = (ev.target as HTMLInputElement).checked;
    renderWorkspace();
  });

  el<HTMLButtonElement>('btn-expand-all').addEventListener('click', () => {
    closeMoreMenu();
    expandOrCollapseAll(true);
  });
  el<HTMLButtonElement>('btn-collapse-all').addEventListener('click', () => {
    closeMoreMenu();
    expandOrCollapseAll(false);
  });

  el<HTMLButtonElement>('btn-copy-json').addEventListener('click', () => {
    const activeView = getActiveEnvelopeView();
    if (activeView?.decoded) {
      void copyText(activeView.decoded.jsonText, 'JSON');
    } else if (activeView?.envelope.endStream) {
      void copyText(formatDecodedJson(activeView.envelope.endStream.rawJson, 2), 'JSON');
    } else if (activeView?.envelope.trailers) {
      void copyText(formatDecodedJson(activeView.envelope.trailers, 2), 'trailers');
    }
  });

  el<HTMLButtonElement>('btn-export-json').addEventListener('click', () => {
    closeMoreMenu();
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
    showToast('Saved .json');
  });

  el<HTMLButtonElement>('btn-save-obuf').addEventListener('click', () => {
    closeMoreMenu();
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

  el<HTMLButtonElement>('btn-mobile-back').addEventListener('click', () => {
    state.mobileScreen = 'list';
    state.hexOpen = false;
    syncLayoutAttributes();
  });

  // Close `more-menu` when clicking outside or pressing Escape
  document.addEventListener('click', (ev) => {
    const menu = el<HTMLDetailsElement>('more-menu');
    if (!menu.open) return;
    if (!menu.contains(ev.target as Node)) {
      menu.open = false;
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      const menu = el<HTMLDetailsElement>('more-menu');
      if (menu.open) {
        menu.open = false;
      }
    }
  });

  let wasCompactHex = window.innerWidth < 520;
  window.addEventListener('resize', () => {
    const nowCompact = window.innerWidth < 520;
    if (nowCompact !== wasCompactHex && state.hexOpen) {
      wasCompactHex = nowCompact;
      renderHexPane(getSelectedItem(), getActiveEnvelopeView());
    }
  });

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
  state.theme =
    themeParam === 'light' || themeParam === 'dark' ? themeParam : getDevToolsThemeName();
  if (params.get('hex') === '1') {
    state.hexOpen = true;
  }
  const tabParam = params.get('tab');
  if (tabParam === 'tree' || tabParam === 'json' || tabParam === 'headers') {
    state.activeTab = tabParam;
  }

  syncStaticIcons();
  applyTheme();
  wireDomEvents();

  startNetworkCapture({
    onItemCaptured(item, loadBody) {
      state.items.push(item);
      state.bodyLoaders.set(item.id, loadBody);
      trimCapturedItems();
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
      const remaining: CapturedItem[] = [];
      for (const item of state.items) {
        if (item.source === 'network') {
          state.bodyLoaders.delete(item.id);
        } else {
          remaining.push(item);
        }
      }
      state.items = remaining;
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
    if (mTab === 'hex') {
      state.hexOpen = true;
      renderHexPane(getSelectedItem(), getActiveEnvelopeView());
    } else if (mTab === 'json' || mTab === 'headers') {
      state.activeTab = mTab;
      renderWorkspace();
    }
    syncLayoutAttributes();
    return;
  }

  renderRequestList();
  renderWorkspace();
}

void bootstrap();
