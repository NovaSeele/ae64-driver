import type { Plugin } from 'vite';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ReleaseManifest {
  version: string;
  builtAt: string;
  files: string[];
}

export function formatUtcStamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const min = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  return `${y}${m}${d}${h}${min}${s}`;
}

export function buildVersionString(pkgVersion: string, date: Date = new Date()): string {
  return `${pkgVersion}+${formatUtcStamp(date)}`;
}

/**
 * Pure function: takes a list of bundle keys or a bundle object,
 * excludes release.json and sw.js, normalises paths, and ensures "./" and "index.html" are present.
 */
export function computeReleaseFileList(bundle: Record<string, unknown> | string[]): string[] {
  const keys = Array.isArray(bundle) ? bundle : Object.keys(bundle);
  const set = new Set<string>();
  set.add('./');
  set.add('index.html');
  for (const f of keys) {
    const normalised = f.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalised || normalised === 'release.json' || normalised === 'sw.js') continue;
    set.add(normalised);
  }
  return Array.from(set).sort();
}

export interface ReleasePluginOptions {
  version?: string;
  builtAt?: string;
}

export function releasePlugin(options: ReleasePluginOptions = {}): Plugin {
  let resolvedDistPath = '';
  let resolvedRoot = '';
  const finalVersion = options.version;
  const finalBuiltAt = options.builtAt;

  return {
    name: 'ae64-release',
    apply: 'build',
    configResolved(config) {
      resolvedRoot = config.root;
      resolvedDistPath = path.resolve(config.root, config.build.outDir || 'dist');
    },
    closeBundle() {
      const now = new Date();
      let version = finalVersion;
      if (!version) {
        try {
          const pkgPath = resolvedRoot ? path.resolve(resolvedRoot, 'package.json') : path.resolve('package.json');
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          version = buildVersionString(pkg.version, now);
        } catch {
          version = buildVersionString('0.0.0', now);
        }
      }
      const builtAt = finalBuiltAt || now.toISOString();

      const distPath = resolvedDistPath || (resolvedRoot ? path.resolve(resolvedRoot, 'dist') : path.resolve('dist'));
      if (!fs.existsSync(distPath)) return;

      function scanDir(dir: string, base = ''): string[] {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const list: string[] = [];
        for (const entry of entries) {
          const rel = base ? `${base}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            list.push(...scanDir(path.join(dir, entry.name), rel));
          } else if (entry.isFile()) {
            list.push(rel);
          }
        }
        return list;
      }

      const allFiles = scanDir(distPath);
      const files = computeReleaseFileList(allFiles);

      const manifest: ReleaseManifest = {
        version,
        builtAt,
        files,
      };

      fs.writeFileSync(path.join(distPath, 'release.json'), JSON.stringify(manifest, null, 2), 'utf8');
    },
  };
}
