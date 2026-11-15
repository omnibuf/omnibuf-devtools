import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultZipPath = path.join(rootDir, 'artifacts', 'omnibuf-devtools-firefox.zip');
const defaultSourceZipPath = path.join(rootDir, 'artifacts', 'omnibuf-devtools-source.zip');
const AMO_BASE = 'https://addons.mozilla.org/api/v5';
const ADDON_ID = 'devtools@omnibuf.com';

const APPROVAL_NOTES = [
  'Build environment: Linux or macOS, Node.js 22 LTS, pnpm 10.x, zip.',
  'Reproduce dist/ from omnibuf-devtools-source.zip:',
  '  1. pnpm install --frozen-lockfile',
  '  2. pnpm run build',
  '  3. pnpm run pack',
  'Output in artifacts/omnibuf-devtools-firefox.zip matches the submitted bundle.',
].join('\n');

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createAmoJwt(apiKey, apiSecret) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: apiKey,
      jti: randomUUID(),
      iat: issuedAt,
      exp: issuedAt + 60,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const sig = createHmac('sha256', apiSecret)
    .update(signingInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${signingInput}.${sig}`;
}

async function pollUploadValidation(apiKey, apiSecret, uploadUuid) {
  const url = `${AMO_BASE}/addons/upload/${uploadUuid}/`;
  for (let attempt = 1; attempt <= 36; attempt++) {
    await delay(5000);
    const res = await globalThis.fetch(url, {
      headers: { Authorization: `JWT ${createAmoJwt(apiKey, apiSecret)}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AMO upload status check failed (${res.status}): ${text}`);
    }
    const detail = await res.json();
    if (!detail.processed) {
      console.log(`Waiting for Mozilla AMO package validation (attempt ${attempt}/36)...`);
      continue;
    }
    if (!detail.valid) {
      throw new Error(
        `Mozilla AMO validation rejected package:\n${JSON.stringify(detail.validation, null, 2)}`,
      );
    }
    return detail;
  }
  throw new Error('Timed out waiting for Mozilla AMO validation');
}

async function attachSourceArchive(apiKey, apiSecret, versionId, sourceBytes) {
  const form = new globalThis.FormData();
  form.append(
    'source',
    new globalThis.Blob([sourceBytes], { type: 'application/zip' }),
    'omnibuf-devtools-source.zip',
  );
  const res = await globalThis.fetch(
    `${AMO_BASE}/addons/addon/${encodeURIComponent(ADDON_ID)}/versions/${versionId}/`,
    {
      method: 'PATCH',
      headers: { Authorization: `JWT ${createAmoJwt(apiKey, apiSecret)}` },
      body: form,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AMO source archive attachment failed (${res.status}): ${text}`);
  }
}

async function publishFirefox() {
  const apiKey = process.env.FIREFOX_API_KEY?.trim();
  const apiSecret = process.env.FIREFOX_API_SECRET?.trim();
  const channel = process.env.FIREFOX_CHANNEL?.trim() || 'listed';
  const zipPath = process.env.FIREFOX_ZIP_PATH
    ? path.resolve(process.env.FIREFOX_ZIP_PATH)
    : defaultZipPath;
  const sourceZipPath = process.env.FIREFOX_SOURCE_ZIP_PATH
    ? path.resolve(process.env.FIREFOX_SOURCE_ZIP_PATH)
    : defaultSourceZipPath;

  if (!apiKey || !apiSecret) {
    throw new Error(
      'Missing FIREFOX_API_KEY or FIREFOX_API_SECRET from https://addons.mozilla.org/developers/addon/api/key/',
    );
  }
  if (!existsSync(zipPath)) {
    throw new Error(`Missing Firefox package archive at ${zipPath}. Run \`just pack\` first.`);
  }
  if (!existsSync(sourceZipPath)) {
    throw new Error(
      `Missing Mozilla AMO source archive at ${sourceZipPath}. Run \`just pack\` inside a git checkout.`,
    );
  }

  const zipBytes = await readFile(zipPath);
  const sourceBytes = await readFile(sourceZipPath);

  console.log(`Uploading ${path.basename(zipPath)} to Mozilla AMO (${channel})...`);
  const uploadForm = new globalThis.FormData();
  uploadForm.append(
    'upload',
    new globalThis.Blob([zipBytes], { type: 'application/zip' }),
    'omnibuf-devtools-firefox.zip',
  );
  uploadForm.append('channel', channel);

  const uploadRes = await globalThis.fetch(`${AMO_BASE}/addons/upload/`, {
    method: 'POST',
    headers: { Authorization: `JWT ${createAmoJwt(apiKey, apiSecret)}` },
    body: uploadForm,
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`AMO upload failed (${uploadRes.status}): ${text}`);
  }

  const uploadInit = await uploadRes.json();
  const validated = uploadInit.processed
    ? uploadInit
    : await pollUploadValidation(apiKey, apiSecret, uploadInit.uuid);
  if (!validated.valid) {
    throw new Error(
      `Mozilla AMO validation rejected package:\n${JSON.stringify(validated.validation, null, 2)}`,
    );
  }

  const checkRes = await globalThis.fetch(
    `${AMO_BASE}/addons/addon/${encodeURIComponent(ADDON_ID)}/`,
    {
      headers: { Authorization: `JWT ${createAmoJwt(apiKey, apiSecret)}` },
    },
  );

  if (checkRes.status === 200) {
    console.log(`Creating new version on existing AMO add-on ${ADDON_ID}...`);
    const verForm = new globalThis.FormData();
    verForm.append('upload', validated.uuid);
    verForm.append(
      'source',
      new globalThis.Blob([sourceBytes], { type: 'application/zip' }),
      'omnibuf-devtools-source.zip',
    );
    verForm.append('license', 'Apache-2.0');
    verForm.append('approval_notes', APPROVAL_NOTES);

    const verRes = await globalThis.fetch(
      `${AMO_BASE}/addons/addon/${encodeURIComponent(ADDON_ID)}/versions/`,
      {
        method: 'POST',
        headers: { Authorization: `JWT ${createAmoJwt(apiKey, apiSecret)}` },
        body: verForm,
      },
    );
    if (!verRes.ok) {
      const text = await verRes.text();
      throw new Error(`AMO version creation failed (${verRes.status}): ${text}`);
    }
    const verData = await verRes.json();
    console.log(`Mozilla AMO version ${verData.version} submitted (id=${verData.id}).`);
    return;
  }

  if (checkRes.status !== 404) {
    const text = await checkRes.text();
    throw new Error(`AMO add-on lookup failed (${checkRes.status}): ${text}`);
  }

  console.log(`Creating initial AMO add-on listing for ${ADDON_ID}...`);
  const createPayload =
    channel === 'listed'
      ? {
          categories: { firefox: ['web-development'] },
          summary: {
            'en-US':
              'Inspect OmniBuf HTTP, ConnectRPC, gRPC-Web, and .obuf payloads as an interactive field tree.',
          },
          version: {
            upload: validated.uuid,
            license: 'Apache-2.0',
            approval_notes: APPROVAL_NOTES,
          },
        }
      : {
          version: {
            upload: validated.uuid,
            approval_notes: APPROVAL_NOTES,
          },
        };

  const createRes = await globalThis.fetch(`${AMO_BASE}/addons/addon/`, {
    method: 'POST',
    headers: {
      Authorization: `JWT ${createAmoJwt(apiKey, apiSecret)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createPayload),
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`AMO initial add-on creation failed (${createRes.status}): ${text}`);
  }
  const created = await createRes.json();
  const verId = created.current_version?.id;
  if (verId) {
    await attachSourceArchive(apiKey, apiSecret, verId, sourceBytes);
  }
  console.log(`Mozilla AMO add-on ${ADDON_ID} created and submitted.`);
}

publishFirefox().catch((err) => {
  console.error(err);
  process.exit(1);
});
