import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pkg from './package.json' with { type: 'json' };
import { buildVersionString, releasePlugin } from './build/release';

const appVersion = process.env.BUILD_VERSION || buildVersionString(pkg.version);

/** Preload the Latin Inter subset: otherwise it is found only once the CSS has been parsed. */
function preloadLatinFont(): Plugin {
  return {
    name: 'ae64-preload-latin-font',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const font = Object.keys(ctx.bundle ?? {}).find((f) => /inter-latin-wght-normal-[^/]*\.woff2$/.test(f));
        if (!font) return html;
        return [{ tag: 'link', attrs: { rel: 'preload', href: `/${font}`, as: 'font', type: 'font/woff2', crossorigin: '' }, injectTo: 'head' }];
      },
    },
  };
}

/**
 * The favicon lives in src/assets so Vite gives it a hashed name (/assets/favicon-[hash].svg) and a changed icon
 * never sits behind a CDN or browser cache. The manifest in public/ is copied verbatim, so point its icon at the
 * hashed file after the bundle is written (before the release plugin lists the files).
 */
function hashedManifestIcon(): Plugin {
  let outDir = 'dist';
  let icon = '';
  return {
    name: 'ae64-manifest-icon',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir || 'dist');
    },
    generateBundle(_options, bundle) {
      icon = Object.keys(bundle).find((f) => /^assets\/favicon-[^/]+\.svg$/.test(f)) ?? '';
    },
    writeBundle() {
      if (!icon) throw new Error('ae64-manifest-icon: no hashed favicon in the bundle (was it inlined?)');
      const file = path.join(outDir, 'manifest.webmanifest');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as { icons?: { src: string }[] };
      for (const i of manifest.icons ?? []) if (i.src === 'favicon.svg') i.src = icon;
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    },
  };
}

/** The desktop (Tauri) build is installed by hand and never updates itself: no service worker, no release.json. */
function desktopWithoutUpdates(): Plugin {
  let outDir = 'dist';
  return {
    name: 'ae64-desktop-no-updates',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir || 'dist');
    },
    closeBundle() {
      fs.rmSync(path.join(outDir, 'sw.js'), { force: true });
    },
  };
}

export default defineConfig(({ mode }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __DESKTOP__: JSON.stringify(mode === 'desktop'),
  },
  plugins: [
    vue(),
    preloadLatinFont(),
    hashedManifestIcon(),
    ...(mode === 'desktop' ? [desktopWithoutUpdates()] : [releasePlugin({ version: appVersion })]),
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: {
    target: 'es2022',
    rolldownOptions: {
      output: {
        // Vendor split (Vite 8 / Rolldown replacement for manualChunks): framework code changes
        // rarely, so it caches separately from app code. Pages stay lazy (see router.ts).
        codeSplitting: {
          groups: [
            { name: 'vue', test: /node_modules[\/](@vue|vue|vue-router|pinia)[\/]/ },
            { name: 'icons', test: /node_modules[\/]@tabler[\/]/ },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
}));
