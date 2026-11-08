import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import pkg from './package.json' with { type: 'json' };
import { buildVersionString, releasePlugin } from './build/release';

const appVersion = process.env.BUILD_VERSION || buildVersionString(pkg.version);

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    vue(),
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
