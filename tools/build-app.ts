// Builds the desktop app: the UI with Vite (skipped with the argument `main`), then the main and preload
// scripts with esbuild into out/app.

import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

if (process.argv[2] !== 'main') execFileSync('npx', ['vite', 'build'], { stdio: 'inherit' });
const common = { bundle: true, platform: 'node', target: 'node24', external: ['electron'], logLevel: 'info' } as const;
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'out/app/main.js', format: 'esm' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'out/app/preload.cjs', format: 'cjs' });
