import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'AE64 Max Control',
        short_name: 'AE64 Max',
        description: 'Driver cục bộ cho bàn phím Everglide AE64 Max',
        lang: 'vi',
        theme_color: '#0c0d0f',
        background_color: '#0c0d0f',
        display: 'standalone',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: 'index.html',
      },
    }),
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
