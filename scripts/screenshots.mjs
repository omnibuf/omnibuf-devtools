import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import console from 'node:console';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL, fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const docsOutDir = path.join(rootDir, 'docs', 'screenshots');
const storeOutDir = path.join(rootDir, 'artifacts', 'store-screenshots');

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const DOC_SHOTS = [
  {
    file: 'desktop-dark.png',
    width: 1440,
    height: 900,
    scale: 2,
    mobile: false,
    rgb24: false,
    outDir: docsOutDir,
    query: '?demo=1&theme=dark&item=synthetic-connect-stream',
  },
  {
    file: 'desktop-light.png',
    width: 1440,
    height: 900,
    scale: 2,
    mobile: false,
    rgb24: false,
    outDir: docsOutDir,
    query: '?demo=1&theme=light&item=synthetic-connect-unary',
  },
  {
    file: 'desktop-hex.png',
    width: 1440,
    height: 900,
    scale: 2,
    mobile: false,
    rgb24: false,
    outDir: docsOutDir,
    query: '?demo=1&theme=dark&item=synthetic-connect-stream&hex=1',
  },
  {
    file: 'mobile-traffic.png',
    width: 390,
    height: 844,
    scale: 2,
    mobile: true,
    rgb24: false,
    outDir: docsOutDir,
    query: '?demo=1&theme=dark&mobileScreen=list',
  },
  {
    file: 'mobile-fields.png',
    width: 390,
    height: 844,
    scale: 2,
    mobile: true,
    rgb24: false,
    outDir: docsOutDir,
    query: '?demo=1&theme=dark&item=synthetic-connect-stream',
  },
  {
    file: 'mobile-hex.png',
    width: 390,
    height: 844,
    scale: 2,
    mobile: true,
    rgb24: false,
    outDir: docsOutDir,
    query: '?demo=1&theme=dark&item=synthetic-connect-stream&hex=1',
  },
];

// Chrome Web Store & Firefox AMO listing screenshots: exact 1280x800, 24-bit RGB PNG (no alpha).
const STORE_SHOTS = [
  {
    file: 'store-1-dark.png',
    width: 1280,
    height: 800,
    scale: 1,
    mobile: false,
    rgb24: true,
    outDir: storeOutDir,
    query: '?demo=1&theme=dark&item=synthetic-connect-stream',
  },
  {
    file: 'store-2-light.png',
    width: 1280,
    height: 800,
    scale: 1,
    mobile: false,
    rgb24: true,
    outDir: storeOutDir,
    query: '?demo=1&theme=light&item=synthetic-connect-unary',
  },
  {
    file: 'store-3-hex.png',
    width: 1280,
    height: 800,
    scale: 1,
    mobile: false,
    rgb24: true,
    outDir: storeOutDir,
    query: '?demo=1&theme=dark&item=synthetic-connect-stream&hex=1',
  },
];

function resolveChromeBinary() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }

  const macCandidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  for (const candidate of macCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const resolved = execFileSync('which', [bin], { encoding: 'utf8' }).trim();
      if (resolved) return resolved;
    } catch {
      // Try next binary name
    }
  }

  throw new Error('Could not locate a Chrome or Chromium binary. Set CHROME_BIN=/path/to/chrome.');
}

function makePngChunk(type, payload) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payload.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, payload])) >>> 0, 0);
  return Buffer.concat([lenBuf, typeBuf, payload, crcBuf]);
}

function injectPngTextChunk(pngBuf, keyword, text) {
  const iendOffset = pngBuf.length - 12;
  const payload = Buffer.from(`${keyword}\0${text}`, 'latin1');
  return Buffer.concat([
    pngBuf.subarray(0, iendOffset),
    makePngChunk('tEXt', payload),
    pngBuf.subarray(iendOffset),
  ]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Converts an 8-bit RGBA PNG (colorType 6) into a 24-bit RGB PNG (colorType 2, no alpha)
 * as required by Chrome Web Store screenshot validation.
 */
function convertPngToRgb24(pngBuf) {
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!pngBuf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Invalid PNG signature');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let ihdrExtra = null;
  const idatParts = [];

  while (offset < pngBuf.length) {
    const len = pngBuf.readUInt32BE(offset);
    const type = pngBuf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = pngBuf.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      ihdrExtra = Buffer.from(data.subarray(10, 13));
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (colorType === 2) return pngBuf;
  if (bitDepth !== 8 || colorType !== 6 || !ihdrExtra) {
    throw new Error(`Unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType})`);
  }

  const raw = inflateSync(Buffer.concat(idatParts));
  const bpp = 4;
  const inStride = width * bpp;
  const outRowLen = 1 + width * 3;
  const rgbRaw = Buffer.alloc(height * outRowLen);

  let prevRow = new Uint8Array(inStride);
  let currRow = new Uint8Array(inStride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + inStride);
    const filter = raw[rowStart];
    for (let x = 0; x < inStride; x++) {
      const byte = raw[rowStart + 1 + x];
      const left = x >= bpp ? currRow[x - bpp] : 0;
      const up = prevRow[x];
      const upLeft = x >= bpp ? prevRow[x - bpp] : 0;
      let recon = byte;
      if (filter === 1) recon = (byte + left) & 0xff;
      else if (filter === 2) recon = (byte + up) & 0xff;
      else if (filter === 3) recon = (byte + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) recon = (byte + paethPredictor(left, up, upLeft)) & 0xff;
      currRow[x] = recon;
    }

    const outStart = y * outRowLen;
    rgbRaw[outStart] = 0; // Filter 0 (None)
    for (let px = 0; px < width; px++) {
      const srcIdx = px * 4;
      const dstIdx = outStart + 1 + px * 3;
      rgbRaw[dstIdx] = currRow[srcIdx];
      rgbRaw[dstIdx + 1] = currRow[srcIdx + 1];
      rgbRaw[dstIdx + 2] = currRow[srcIdx + 2];
    }

    const swap = prevRow;
    prevRow = currRow;
    currRow = swap;
  }

  const ihdrPayload = Buffer.alloc(13);
  ihdrPayload.writeUInt32BE(width, 0);
  ihdrPayload.writeUInt32BE(height, 4);
  ihdrPayload[8] = 8;
  ihdrPayload[9] = 2; // Truecolor 24-bit RGB (no alpha)
  ihdrExtra.copy(ihdrPayload, 10);

  const compressed = deflateSync(rgbRaw, { level: 9 });
  return Buffer.concat([
    PNG_SIG,
    makePngChunk('IHDR', ihdrPayload),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function captureScreenshots() {
  if (!existsSync(path.join(distDir, 'panel.html'))) {
    throw new Error('Missing dist/panel.html. Run `pnpm run build` first.');
  }

  const storeOnly = process.argv.includes('--store');
  const includeStore = storeOnly || process.argv.includes('--all');
  const shots = storeOnly ? STORE_SHOTS : includeStore ? [...DOC_SHOTS, ...STORE_SHOTS] : DOC_SHOTS;

  const chromeBin = resolveChromeBinary();
  for (const shot of shots) {
    await mkdir(shot.outDir, { recursive: true });
  }
  const tmpProfile = await mkdtemp(path.join(os.tmpdir(), 'omnibuf-screenshots-'));

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rel = parsed.pathname === '/' ? '/panel.html' : parsed.pathname;
    const filePath = path.resolve(distDir, `.${rel}`);
    if (!filePath.startsWith(distDir)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const st = await stat(filePath);
      if (!st.isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream' });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}/panel.html`;

  const chrome = spawn(
    chromeBin,
    [
      '--headless=new',
      `--user-data-dir=${tmpProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let ws = null;
  try {
    const wsEndpoint = await new Promise((resolve, reject) => {
      let stderr = '';
      chrome.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) resolve(match[1]);
      });
      chrome.once('exit', (code) =>
        reject(new Error(`Chrome exited before DevTools opened (${code}): ${stderr}`)),
      );
    });

    const debugHost = new URL(wsEndpoint).host;
    const targets = await globalThis.fetch(`http://${debugHost}/json/list`).then((r) => r.json());
    const pageTarget = targets.find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('No page target exposed by headless Chrome');

    ws = new globalThis.WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    let nextId = 1;
    const sendCdp = (method, params = {}) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const onMessage = (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === id) {
            ws.removeEventListener('message', onMessage);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        };
        ws.addEventListener('message', onMessage);
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    await sendCdp('Page.enable');
    await sendCdp('Runtime.enable');

    for (const shot of shots) {
      await sendCdp('Emulation.setDeviceMetricsOverride', {
        width: shot.width,
        height: shot.height,
        deviceScaleFactor: shot.scale,
        mobile: shot.mobile,
      });
      await sendCdp('Page.navigate', { url: `${baseUrl}${shot.query}` });
      await delay(350);
      await sendCdp('Runtime.evaluate', {
        expression: `document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`,
        awaitPromise: true,
      });

      const snap = await sendCdp('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      let pngBuf = Buffer.from(snap.data, 'base64');
      if (shot.rgb24) {
        pngBuf = convertPngToRgb24(pngBuf);
      }
      const taggedPng = injectPngTextChunk(
        pngBuf,
        'impeccable:prompt',
        `Origin: deterministic headless Chrome CDP capture of dist/panel.html${shot.query} (${shot.width}x${shot.height}@${shot.scale}x)`,
      );
      const outPath = path.join(shot.outDir, shot.file);
      await writeFile(outPath, taggedPng);
      console.log(
        `Captured ${path.relative(rootDir, outPath)} (${shot.width}x${shot.height}@${shot.scale}x${shot.rgb24 ? ', 24-bit RGB' : ''})`,
      );
    }
  } finally {
    if (ws) ws.close();
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill('SIGTERM');
    await exited;
    server.close();
    await rm(tmpProfile, { recursive: true, force: true });
  }
}

captureScreenshots().catch((err) => {
  console.error(err);
  process.exit(1);
});
