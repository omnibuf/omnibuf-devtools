import console from 'node:console';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URLSearchParams, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultZipPath = path.join(rootDir, 'artifacts', 'omnibuf-devtools-chrome.zip');

async function resolveAccessToken() {
  if (process.env.CHROME_ACCESS_TOKEN) {
    return process.env.CHROME_ACCESS_TOKEN.trim();
  }

  const clientId = process.env.CHROME_CLIENT_ID?.trim();
  const clientSecret = process.env.CHROME_CLIENT_SECRET?.trim();
  const refreshToken = process.env.CHROME_REFRESH_TOKEN?.trim();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing Chrome Web Store OAuth credentials. Set CHROME_ACCESS_TOKEN or CHROME_CLIENT_ID + CHROME_CLIENT_SECRET + CHROME_REFRESH_TOKEN.',
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await globalThis.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to obtain Google OAuth access token (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('OAuth token response did not contain access_token');
  }
  return data.access_token;
}

async function waitForUploadReady(accessToken, publisherId, extensionId) {
  const statusUrl = `https://chromewebstore.googleapis.com/v2/publishers/${publisherId}/items/${extensionId}:fetchStatus`;

  for (let attempt = 1; attempt <= 24; attempt++) {
    await delay(5000);
    const res = await globalThis.fetch(statusUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Chrome Web Store fetchStatus failed (${res.status}): ${text}`);
    }
    const status = await res.json();
    const state = status.lastAsyncUploadState;
    if (state === 'SUCCEEDED' || !state) return;
    if (state !== 'IN_PROGRESS') {
      throw new Error(`Chrome Web Store async upload failed with state ${state}`);
    }
    console.log(`Waiting for Chrome Web Store package processing (attempt ${attempt}/24)...`);
  }

  throw new Error('Timed out waiting for Chrome Web Store upload processing');
}

async function publishChrome() {
  const publisherId = process.env.CHROME_PUBLISHER_ID?.trim();
  const extensionId = process.env.CHROME_EXTENSION_ID?.trim();
  const zipPath = process.env.CHROME_ZIP_PATH
    ? path.resolve(process.env.CHROME_ZIP_PATH)
    : defaultZipPath;
  const publishType = process.env.CHROME_PUBLISH_TYPE?.trim() || 'DEFAULT_PUBLISH';

  if (!publisherId || !extensionId) {
    throw new Error(
      'Missing CHROME_PUBLISHER_ID or CHROME_EXTENSION_ID. Complete initial item setup once in the Chrome Developer Dashboard first.',
    );
  }
  if (!existsSync(zipPath)) {
    throw new Error(`Missing Chrome package archive at ${zipPath}. Run \`just pack\` first.`);
  }

  const accessToken = await resolveAccessToken();
  const zipBytes = await readFile(zipPath);

  console.log(`Uploading ${path.basename(zipPath)} to Chrome Web Store item ${extensionId}...`);
  const uploadUrl = `https://chromewebstore.googleapis.com/upload/v2/publishers/${publisherId}/items/${extensionId}:upload`;
  const uploadRes = await globalThis.fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/zip',
    },
    body: zipBytes,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`Chrome Web Store upload failed (${uploadRes.status}): ${text}`);
  }

  const uploadResult = await uploadRes.json();
  if (uploadResult.uploadState === 'IN_PROGRESS') {
    await waitForUploadReady(accessToken, publisherId, extensionId);
  } else if (uploadResult.uploadState && uploadResult.uploadState !== 'SUCCEEDED') {
    throw new Error(
      `Chrome Web Store upload rejected (${uploadResult.uploadState}): ${JSON.stringify(uploadResult)}`,
    );
  }

  console.log(`Submitting Chrome Web Store item ${extensionId} (${publishType})...`);
  const publishUrl = `https://chromewebstore.googleapis.com/v2/publishers/${publisherId}/items/${extensionId}:publish`;
  const publishRes = await globalThis.fetch(publishUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ publishType }),
  });

  if (!publishRes.ok) {
    const text = await publishRes.text();
    throw new Error(`Chrome Web Store publish failed (${publishRes.status}): ${text}`);
  }

  const publishData = await publishRes.json();
  console.log(`Chrome Web Store submission complete: state=${publishData.state ?? 'SUBMITTED'}`);
}

publishChrome().catch((err) => {
  console.error(err);
  process.exit(1);
});
