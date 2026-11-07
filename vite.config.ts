import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  base: './', // The built UI is loaded from a file:// URL.
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  server: { host: '127.0.0.1', fs: { allow: ['..'] } },
  build: { outDir: '../out/ui', emptyOutDir: true },
});
