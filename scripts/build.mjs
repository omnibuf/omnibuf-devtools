import console from 'node:console';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const require = createRequire(import.meta.url);

const FONT_FILES = [
  {
    pkg: '@fontsource/ibm-plex-sans',
    file: 'files/ibm-plex-sans-latin-500-normal.woff2',
  },
  {
    pkg: '@fontsource/ibm-plex-sans',
    file: 'files/ibm-plex-sans-latin-600-normal.woff2',
  },
  {
    pkg: '@fontsource/ibm-plex-sans',
    file: 'files/ibm-plex-sans-latin-700-normal.woff2',
  },
  {
    pkg: '@fontsource/ibm-plex-mono',
    file: 'files/ibm-plex-mono-latin-400-normal.woff2',
  },
  {
    pkg: '@fontsource/ibm-plex-mono',
    file: 'files/ibm-plex-mono-latin-500-normal.woff2',
  },
  {
    pkg: '@fontsource/ibm-plex-mono',
    file: 'files/ibm-plex-mono-latin-600-normal.woff2',
  },
];

async function build() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(path.join(distDir, 'icons'), { recursive: true });
  await mkdir(path.join(distDir, 'fonts'), { recursive: true });

  // Copy static manifest, HTML, and CSS
  await cp(path.join(rootDir, 'public', 'manifest.json'), path.join(distDir, 'manifest.json'));
  await cp(path.join(rootDir, 'public', 'devtools.html'), path.join(distDir, 'devtools.html'));
  await cp(path.join(rootDir, 'public', 'panel.html'), path.join(distDir, 'panel.html'));
  await cp(path.join(rootDir, 'src', 'panel', 'panel.css'), path.join(distDir, 'panel.css'));

  // Copy local .woff2 fonts so MV3 CSP never touches external font CDNs
  for (const font of FONT_FILES) {
    const pkgJsonPath = require.resolve(`${font.pkg}/package.json`);
    const srcPath = path.join(path.dirname(pkgJsonPath), font.file);
    const dstPath = path.join(distDir, 'fonts', path.basename(font.file));
    await cp(srcPath, dstPath);
  }

  // Copy extension PNG icons (with embedded PNG tEXt origin provenance)
  for (const size of [16, 32, 48, 128]) {
    await cp(
      path.join(rootDir, 'public', 'icons', `icon-${size}.png`),
      path.join(distDir, 'icons', `icon-${size}.png`),
    );
  }

  // Bundle DevTools bootstrap and Panel UI
  await esbuild.build({
    entryPoints: {
      devtools: path.join(rootDir, 'src', 'devtools.ts'),
      panel: path.join(rootDir, 'src', 'panel', 'panel.ts'),
    },
    outdir: distDir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    sourcemap: true,
    logLevel: 'info',
  });
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
