// Zips the release exe as AE64-Max-Control_<version>_x64-portable.zip next to the NSIS setup.exe.
// Run by `npm run desktop:build` after `tauri build`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const release = join(root, 'src-tauri', 'target', 'release');
const exe = join(release, 'ae64-max-control.exe');
const outDir = join(release, 'bundle', 'nsis');
const zip = join(outDir, `AE64-Max-Control_${version}_x64-portable.zip`);

if (!existsSync(exe)) throw new Error(`Release exe not found: ${exe}`);
rmSync(zip, { force: true });
execFileSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:ZIP_SRC -DestinationPath $env:ZIP_OUT'],
  { stdio: 'inherit', env: { ...process.env, ZIP_SRC: exe, ZIP_OUT: zip } },
);
console.log(`Portable zip: ${zip}`);
