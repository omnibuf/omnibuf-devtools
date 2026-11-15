import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const artifactsDir = path.join(rootDir, 'artifacts');

function normalizeReleaseVersion(raw) {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid RELEASE_VERSION "${raw}". Browser extension manifests require X.Y.Z numeric semver.`,
    );
  }
  return trimmed;
}

async function copyDistFiltered(targetDir) {
  await cp(distDir, targetDir, {
    recursive: true,
    filter: (src) => !src.endsWith('.map'),
  });
}

async function stripSourceMapComments(stageDir) {
  const entries = await readdir(stageDir);
  for (const name of entries) {
    if (!name.endsWith('.js')) continue;
    const jsPath = path.join(stageDir, name);
    const content = await readFile(jsPath, 'utf8');
    const cleaned = content.replace(/\n\/\/# sourceMappingURL=.*$/m, '');
    if (cleaned !== content) {
      await writeFile(jsPath, cleaned, 'utf8');
    }
  }
}

async function buildBrowserZip({ target, outZip, versionOverride }) {
  const stageRoot = await mkdtemp(path.join(os.tmpdir(), `omnibuf-pack-${target}-`));
  try {
    await copyDistFiltered(stageRoot);
    await stripSourceMapComments(stageRoot);

    const manifestPath = path.join(stageRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (versionOverride) {
      manifest.version = versionOverride;
    }
    if (target === 'chrome') {
      delete manifest.browser_specific_settings;
    }
    if (typeof manifest.description === 'string' && manifest.description.length > 132) {
      throw new Error(
        `manifest.json description exceeds Chrome Web Store 132-char limit (${manifest.description.length} chars).`,
      );
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await rm(outZip, { force: true });
    execFileSync('zip', ['-r', '-q', outZip, '.'], { cwd: stageRoot, stdio: 'inherit' });
    console.log(`Packaged ${path.relative(rootDir, outZip)} (${target}, v${manifest.version})`);
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

async function buildSourceZip(outZip) {
  await rm(outZip, { force: true });
  execFileSync('git', ['archive', '--format=zip', `--output=${outZip}`, 'HEAD'], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  console.log(`Packaged ${path.relative(rootDir, outZip)} (Mozilla AMO source archive)`);
}

async function pack() {
  if (!existsSync(path.join(distDir, 'manifest.json'))) {
    throw new Error('Missing dist/manifest.json. Run `pnpm run build` first.');
  }

  const versionOverride = normalizeReleaseVersion(process.env.RELEASE_VERSION);
  await mkdir(artifactsDir, { recursive: true });

  await buildBrowserZip({
    target: 'chrome',
    outZip: path.join(artifactsDir, 'omnibuf-devtools-chrome.zip'),
    versionOverride,
  });

  await buildBrowserZip({
    target: 'firefox',
    outZip: path.join(artifactsDir, 'omnibuf-devtools-firefox.zip'),
    versionOverride,
  });

  if (existsSync(path.join(rootDir, '.git'))) {
    await buildSourceZip(path.join(artifactsDir, 'omnibuf-devtools-source.zip'));
  }
}

pack().catch((err) => {
  console.error(err);
  process.exit(1);
});
