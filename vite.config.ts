import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
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

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    vue(),
    preloadLatinFont(),
    releasePlugin({ version: appVersion }),
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
});
