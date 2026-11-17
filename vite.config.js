import { defineConfig } from 'vite';
// GitHub Pages serveert de app onder /golf-bossenstein/
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/golf-bossenstein/' : '/',
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  server: { host: true },
}));
