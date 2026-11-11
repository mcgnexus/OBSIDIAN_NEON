import { build } from 'esbuild';
await build({
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'],
  format: 'cjs', platform: 'browser', target: 'es2022', outfile: 'main.js',
  sourcemap: false, minify: false, logLevel: 'info',
});
