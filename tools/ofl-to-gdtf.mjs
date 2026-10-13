/* eslint-disable no-console */
/**
 * @file Writes a shipped OFL profile as a GDTF 1.2 file.
 *
 * The conversion is Beam's own OFL translation, so the file describes the
 * fixture exactly as Beam already runs it. The converter imports the model
 * layer, which is written for Vite, so it is bundled with esbuild first, the
 * way test/build.mjs bundles the tests.
 *
 * Usage:
 *   node tools/ofl-to-gdtf.mjs tomshine/80w-led-gobo-moving-head
 *   node tools/ofl-to-gdtf.mjs tomshine/80w-led-gobo-moving-head --out C:\Users\Paul\Downloads\gdtf
 *
 * The file is named `Manufacturer@Fixture@Revision.gdtf`, as GDTF Share names
 * its files, and is read back with Beam's GDTF reader and compared with the
 * translation before the tool reports success.
 */
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out');
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : process.cwd();
if (!key || !fs.existsSync(path.join(root, 'public/fixtures', `${key}.json`))) {
  console.error('usage: node tools/ofl-to-gdtf.mjs <manufacturer>/<fixture> [--out <folder>]');
  console.error(key ? `no profile public/fixtures/${key}.json` : 'no profile given');
  process.exit(1);
}

const bundle = path.join(os.tmpdir(), 'beam-ofl-to-gdtf.mjs');
await build({
  entryPoints: [path.join(here, 'ofl-to-gdtf/convert.js')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: bundle,
  alias: { '@': path.join(root, 'src') },
  inject: [path.join(root, 'bench/shim.cjs')],
  define: { 'import.meta.env': JSON.stringify({ VITE_STATIC_URL: '/' }) },
  banner: {
    js: "import { createRequire as __createRequire } from 'module';\n"
      + 'const require = __createRequire(import.meta.url);',
  },
  logLevel: 'warning',
});

const result = spawnSync(process.execPath, [
  bundle,
  path.join(root, 'public/fixtures', `${key}.json`),
  path.join(root, 'public/fixtures/manufacturers.json'),
  key,
  outDir,
], { stdio: 'inherit' });
fs.rmSync(bundle, { force: true });
process.exit(result.status ?? 1);
