import { defineConfig } from 'vite';

// GitHub Pages: de publieke versie staat onder /golf-bossenstein/,
// de staging-versie (met Intekenen) onder /golf-bossenstein/staging/ en deelt dezelfde data.
export default defineConfig(({ command, isPreview, mode }) => {
  const staging = mode === 'staging';
  const pages = command === 'build' || isPreview;
  return {
    base: !pages ? '/' : staging ? '/golf-bossenstein/staging/' : '/golf-bossenstein/',
    publicDir: staging ? false : 'public', // geen tweede kopie van de luchtfoto's
    define: staging
      ? {
          'import.meta.env.VITE_STAGING': JSON.stringify('1'),
          'import.meta.env.VITE_DATA_BASE': JSON.stringify('/golf-bossenstein/data/'),
        }
      : {},
    build: staging
      ? { target: 'es2022', chunkSizeWarningLimit: 1200, outDir: 'dist/staging', emptyOutDir: true }
      : { target: 'es2022', chunkSizeWarningLimit: 1200 },
    server: { host: true },
  };
});
