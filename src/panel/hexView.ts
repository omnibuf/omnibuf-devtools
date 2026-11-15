import type { FieldTreeNode } from '../decoder/tree.js';

export const HEX_BYTES_PER_ROW = 16;
export const HEX_WINDOW_BYTES = 4096; // 256 rows per page for 60fps DOM rendering

export interface HexViewOptions {
  packet: Uint8Array;
  selectedNode: FieldTreeNode | null;
  isFieldNavigable: boolean;
  bytesPerRow?: 8 | 16;
  windowStart: number;
  onSelectByte(byteOffset: number): void;
  onChangeWindow(newWindowStart: number): void;
}

function byteAsciiChar(b: number): string {
  return b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
}

function formatHexOffset(off: number): string {
  return off.toString(16).padStart(4, '0');
}

/**
 * Computes the aligned 4 KiB window containing `byteOffset`.
 */
export function alignHexWindow(byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  return Math.floor(byteOffset / HEX_WINDOW_BYTES) * HEX_WINDOW_BYTES;
}

/**
 * Renders the synchronized 16-byte hex + ASCII inspector into `container`.
 */
export function renderHexInspector(container: HTMLElement, opts: HexViewOptions): void {
  container.replaceChildren();
  const { packet, selectedNode, onSelectByte, onChangeWindow } = opts;

  if (packet.byteLength === 0) {
    const empty = document.createElement('div');
    empty.className = 'pane-empty-note';
    empty.textContent = '0 bytes in message payload.';
    container.appendChild(empty);
    return;
  }

  // Summary readout bar for the active node (or full packet when none selected)
  const summaryBar = document.createElement('div');
  summaryBar.className = 'hex-summary-bar';

  if (selectedNode) {
    const start = selectedNode.offset;
    const end = start + selectedNode.byteLength;
    const tagEnd = start + selectedNode.tagLength;
    const hdrEnd = tagEnd + selectedNode.headerLength;
    const payloadBytes = Math.max(0, end - hdrEnd);

    const spanMain = document.createElement('div');
    spanMain.className = 'hex-summary-metrics';

    const items: Array<{ label: string; value: string; role?: string }> = [
      {
        label: 'Packet',
        value: `+${start}..${end} (0x${formatHexOffset(start)})`,
      },
    ];
    if (selectedNode.wireOffset !== null && selectedNode.wireOffset !== start) {
      items.push({
        label: 'Stream',
        value: `+${selectedNode.wireOffset} (0x${formatHexOffset(selectedNode.wireOffset)})`,
      });
    }
    if (selectedNode.tagLength > 0) {
      items.push({
        label: selectedNode.kind === 'map-entry' ? 'Key' : 'Tag',
        value: `${selectedNode.tagLength} B`,
        role: 'tag',
      });
    }
    if (selectedNode.headerLength > 0) {
      items.push({
        label: 'Header',
        value: `${selectedNode.headerLength} B`,
        role: 'header',
      });
    }
    items.push({
      label: 'Payload',
      value: `${payloadBytes} B`,
      role: 'payload',
    });

    for (const entry of items) {
      const chip = document.createElement('span');
      chip.className = entry.role ? `hex-metric hex-metric-${entry.role}` : 'hex-metric';
      const k = document.createElement('span');
      k.className = 'hex-metric-key';
      k.textContent = entry.label;
      const v = document.createElement('span');
      v.className = 'hex-metric-val';
      v.textContent = entry.value;
      chip.append(k, v);
      spanMain.appendChild(chip);
    }
    summaryBar.appendChild(spanMain);
  } else {
    const spanMain = document.createElement('div');
    spanMain.className = 'hex-summary-metrics';
    spanMain.textContent = opts.isFieldNavigable
      ? `${packet.byteLength.toLocaleString()} bytes total · Select any byte to highlight its field`
      : `${packet.byteLength.toLocaleString()} bytes raw envelope payload`;
    summaryBar.appendChild(spanMain);
  }
  container.appendChild(summaryBar);

  // Window pagination controls for payloads > 4 KiB
  const maxWindowStart =
    Math.floor(Math.max(0, packet.byteLength - 1) / HEX_WINDOW_BYTES) * HEX_WINDOW_BYTES;
  const winStart = Math.min(Math.max(0, opts.windowStart), maxWindowStart);
  const winEnd = Math.min(packet.byteLength, winStart + HEX_WINDOW_BYTES);

  if (packet.byteLength > HEX_WINDOW_BYTES) {
    const pager = document.createElement('div');
    pager.className = 'hex-pager';

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'btn-quiet';
    prevBtn.textContent = 'Prev 4 KB';
    prevBtn.disabled = winStart === 0;
    prevBtn.addEventListener('click', () =>
      onChangeWindow(Math.max(0, winStart - HEX_WINDOW_BYTES)),
    );

    const rangeLabel = document.createElement('span');
    rangeLabel.className = 'hex-pager-label';
    rangeLabel.textContent = `0x${formatHexOffset(winStart)}..0x${formatHexOffset(winEnd - 1)} of ${packet.byteLength.toLocaleString()} B`;

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'btn-quiet';
    nextBtn.textContent = 'Next 4 KB';
    nextBtn.disabled = winEnd >= packet.byteLength;
    nextBtn.addEventListener('click', () =>
      onChangeWindow(Math.min(maxWindowStart, winStart + HEX_WINDOW_BYTES)),
    );

    pager.append(prevBtn, rangeLabel, nextBtn);
    container.appendChild(pager);
  }

  const gridWrap = document.createElement('div');
  gridWrap.className = 'hex-grid';
  gridWrap.setAttribute('role', 'region');
  gridWrap.setAttribute('aria-label', 'Packet hexadecimal and ASCII byte slice view');

  // Event delegation on gridWrap keeps listener count O(1)
  gridWrap.addEventListener('click', (ev) => {
    const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-byte]');
    if (!target) return;
    const idx = Number(target.dataset.byte);
    if (!Number.isNaN(idx)) {
      onSelectByte(idx);
    }
  });

  const selStart = selectedNode ? selectedNode.offset : -1;
  const selTagEnd = selectedNode ? selStart + selectedNode.tagLength : -1;
  const selHdrEnd = selectedNode ? selTagEnd + selectedNode.headerLength : -1;
  const selEnd = selectedNode ? selStart + selectedNode.byteLength : -1;

  const bytesPerRow = opts.bytesPerRow ?? HEX_BYTES_PER_ROW;
  let firstHighlightedRow: HTMLElement | null = null;
  let lastHighlightedRow: HTMLElement | null = null;
  const frag = document.createDocumentFragment();

  for (let rowOff = winStart; rowOff < winEnd; rowOff += bytesPerRow) {
    const rowEl = document.createElement('div');
    rowEl.className = 'hex-row';

    const offEl = document.createElement('span');
    offEl.className = 'hex-offset';
    offEl.textContent = formatHexOffset(rowOff);

    const bytesEl = document.createElement('span');
    bytesEl.className = 'hex-bytes';

    const asciiEl = document.createElement('span');
    asciiEl.className = 'hex-ascii';

    const rowLimit = Math.min(winEnd, rowOff + bytesPerRow);
    const midSplit = bytesPerRow === 16 ? 8 : 4;
    for (let i = rowOff; i < rowOff + bytesPerRow; i++) {
      if (i === rowOff + midSplit) {
        const gap = document.createElement('span');
        gap.className = 'hex-mid-gap';
        gap.textContent = ' ';
        bytesEl.appendChild(gap);
      }

      if (i >= rowLimit) {
        const pad = document.createElement('span');
        pad.className = 'hex-byte hex-byte-pad';
        pad.textContent = '  ';
        bytesEl.appendChild(pad);
        continue;
      }

      const b = packet[i]!;
      let roleClass = '';
      if (i >= selStart && i < selEnd) {
        if (i < selTagEnd) roleClass = ' is-tag';
        else if (i < selHdrEnd) roleClass = ' is-header';
        else roleClass = ' is-payload';
        if (!firstHighlightedRow) firstHighlightedRow = rowEl;
        lastHighlightedRow = rowEl;
      }

      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `hex-byte${roleClass}`;
      cell.dataset.byte = String(i);
      cell.title = `Offset +${i} (0x${formatHexOffset(i)}) = 0x${b.toString(16).padStart(2, '0')} (${b})`;
      cell.textContent = b.toString(16).padStart(2, '0');
      bytesEl.appendChild(cell);

      const ch = document.createElement('span');
      ch.className = `hex-char${roleClass}`;
      ch.dataset.byte = String(i);
      ch.textContent = byteAsciiChar(b);
      asciiEl.appendChild(ch);
    }

    rowEl.append(offEl, bytesEl, asciiEl);
    frag.appendChild(rowEl);
  }

  gridWrap.appendChild(frag);
  container.appendChild(gridWrap);

  if (firstHighlightedRow) {
    requestAnimationFrame(() => {
      if (!firstHighlightedRow) return;
      const lastRow = lastHighlightedRow ?? firstHighlightedRow;
      // gridWrap has position: relative, making it firstHighlightedRow's offsetParent
      const rowTop = firstHighlightedRow.offsetTop;
      const sliceBottom = lastRow.offsetTop + lastRow.offsetHeight;
      if (rowTop < gridWrap.scrollTop + 12) {
        gridWrap.scrollTop = Math.max(0, rowTop - 28);
      } else if (sliceBottom > gridWrap.scrollTop + gridWrap.clientHeight - 12) {
        gridWrap.scrollTop = sliceBottom - gridWrap.clientHeight + 32;
      }
    });
  }
}
