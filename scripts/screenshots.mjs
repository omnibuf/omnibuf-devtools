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
import { crc32 } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'docs', 'screenshots');

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const SHOTS = [
  {
    file: 'desktop-dark.png',
    width: 1440,
    height: 900,
    mobile: false,
    query: '?demo=1&theme=dark&item=synthetic-connect-stream',
  },
  {
    file: 'desktop-light.png',
    width: 1440,
    height: 900,
    mobile: false,
    query: '?demo=1&theme=light&item=synthetic-connect-unary',
  },
  {
    file: 'desktop-hex.png',
    width: 1440,
    height: 900,
    mobile: false,
    query: '?demo=1&theme=dark&item=synthetic-connect-stream&hex=1',
  },
  {
    file: 'mobile-traffic.png',
    width: 390,
    height: 844,
    mobile: true,
    query: '?demo=1&theme=dark&mobileScreen=list',
  },
  {
    file: 'mobile-fields.png',
    width: 390,
    height: 844,
    mobile: true,
    query: '?demo=1&theme=dark&item=synthetic-connect-stream',
  },
  {
    file: 'mobile-hex.png',
    width: 390,
    height: 844,
    mobile: true,
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

function injectPngTextChunk(pngBuf, keyword, text) {
  // Insert tEXt chunk immediately before IEND
  const iendOffset = pngBuf.length - 12;
  const payload = Buffer.from(`${keyword}\0${text}`, 'latin1');
  const typeBuf = Buffer.from('tEXt', 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payload.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, payload])) >>> 0, 0);

  return Buffer.concat([
    pngBuf.subarray(0, iendOffset),
    lenBuf,
    typeBuf,
    payload,
    crcBuf,
    pngBuf.subarray(iendOffset),
  ]);
}

async function captureScreenshots() {
  if (!existsSync(path.join(distDir, 'panel.html'))) {
    throw new Error('Missing dist/panel.html. Run `pnpm run build` first.');
  }

  const chromeBin = resolveChromeBinary();
  await mkdir(outDir, { recursive: true });
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

    for (const shot of SHOTS) {
      await sendCdp('Emulation.setDeviceMetricsOverride', {
        width: shot.width,
        height: shot.height,
        deviceScaleFactor: 2,
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
      const rawPng = Buffer.from(snap.data, 'base64');
      const taggedPng = injectPngTextChunk(
        rawPng,
        'impeccable:prompt',
        `Origin: deterministic headless Chrome CDP capture of dist/panel.html${shot.query} (${shot.width}x${shot.height}@2x)`,
      );
      const outPath = path.join(outDir, shot.file);
      await writeFile(outPath, taggedPng);
      console.log(`Captured docs/screenshots/${shot.file} (${shot.width}x${shot.height}@2x)`);
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
