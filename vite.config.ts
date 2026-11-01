import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  server: { fs: { allow: ['..'] } },
  build: { outDir: '../out/ui', emptyOutDir: true },
});
