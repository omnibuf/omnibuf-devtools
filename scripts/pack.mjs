import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const artifactsDir = path.join(rootDir, 'artifacts');
const outZip = path.join(artifactsDir, 'omnibuf-devtools.zip');

async function pack() {
  await mkdir(artifactsDir, { recursive: true });
  await rm(outZip, { force: true });
  execFileSync('zip', ['-r', '-q', outZip, '.'], { cwd: distDir, stdio: 'inherit' });
  console.log(`Packaged ${outZip}`);
}

pack().catch((err) => {
  console.error(err);
  process.exit(1);
});
