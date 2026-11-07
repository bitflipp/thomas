import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  base: './', // The built UI is loaded from a file:// URL.
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  server: { fs: { allow: ['..'] } },
  build: { outDir: '../out/ui', emptyOutDir: true },
});
