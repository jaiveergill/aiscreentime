#!/usr/bin/env node
/**
 * Bundles the dashboard into `public/`.
 *
 * esbuild is the only build dependency. The output is fully self-contained:
 * no CDN, no external fonts, no runtime dependencies — which is what lets the
 * server ship a strict Content-Security-Policy with `default-src 'none'`.
 */
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'public', 'assets');
const watch = process.argv.includes('--watch');

fs.mkdirSync(outdir, { recursive: true });

const options = {
  entryPoints: [path.join(root, 'src/ui/app.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outfile: path.join(outdir, 'app.js'),
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  legalComments: 'none',
  logLevel: 'info',
};

async function copyStatic() {
  // Concatenated so the page loads a single stylesheet: base tokens and
  // components first, then the app shell that composes them.
  const css = ['src/ui/styles.css', 'src/ui/shell.css']
    .map((f) => fs.readFileSync(path.join(root, f), 'utf8'))
    .join('\n');
  fs.writeFileSync(path.join(outdir, 'styles.css'), css);
  fs.copyFileSync(path.join(root, 'src/ui/index.html'), path.join(root, 'public', 'index.html'));
}

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  await copyStatic();
  fs.watch(path.join(root, 'src/ui'), (_e, file) => {
    if (file && (file.endsWith('.css') || file.endsWith('.html'))) void copyStatic();
  });
  console.log('watching src/ui …');
} else {
  const result = await esbuild.build({ ...options, metafile: true });
  await copyStatic();
  const out = Object.values(result.metafile.outputs)[0];
  console.log(`built public/assets/app.js — ${(out.bytes / 1024).toFixed(1)} KB`);
}
