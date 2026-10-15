// How a set of GDTF files describe one attribute family, read with Beam's own
// reader: each matching channel function (physical range, unit, filter,
// wheel, first sets) once per file, and wheel slots whose name matches.
//
// Bundle once, then run:
//   npx esbuild .claude/skills/gdtf/scripts/survey.js --bundle --platform=node --alias:@=./src --outfile=tools/dev/out/survey.cjs --log-level=error
//   node tools/dev/out/survey.cjs "<attribute regex>" "<slot-name regex>" <folder> [folder...]
// Example: node tools/dev/out/survey.cjs "^CT[OBC]" "\\bCT[OBC]\\b|\\d{4}\\s*K\\b" public/profiles
import fs from 'fs';
import path from 'path';
import { DOMParser } from '@xmldom/xmldom';
import readGdtf from '@/models/DMX/gdtf/gdtf_reader';

const [attrPattern, slotPattern, ...folders] = process.argv.slice(2);
const ATTR = new RegExp(attrPattern);
const SLOT = slotPattern ? new RegExp(slotPattern, 'i') : null;
const parseXml = (s) => new DOMParser({ onError: () => {} }).parseFromString(s, 'text/xml');

const files = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p);
  else if (/\.gdtf$/i.test(e.name)) files.push(p);
});
folders.forEach(walk);

let matched = 0;
for (const file of files) {
  let type;
  try {
    ({ fixtureType: type } = readGdtf(new Uint8Array(fs.readFileSync(file)), { parseXml }));
  } catch (err) {
    console.log(`\n${file}\n   cannot read: ${err.message}`);
    continue;
  }
  const filters = new Set(type.physical.filters.map((f) => f.name));
  const seen = new Map();
  type.modes.forEach((mode) => mode.channels.forEach((c) => c.logicalChannels.forEach((l) => l.functions.forEach((f) => {
    if (!ATTR.test(f.attribute)) return;
    const key = [f.attribute, f.physicalFrom, f.physicalTo, f.filter, f.wheel].join('|');
    if (seen.has(key)) return;
    const filter = f.filter ? ` filter=${f.filter}${filters.has(f.filter) ? '' : ' (MISSING)'}` : '';
    seen.set(key, `   fn   ${f.attribute}  ${f.physicalFrom} -> ${f.physicalTo}${filter}${f.wheel ? ` wheel=${f.wheel}` : ''}`
      + `  sets: ${f.sets.map((s) => s.name).filter(Boolean).slice(0, 4).join(' / ')}`);
  }))));
  const slots = [];
  if (SLOT) {
    type.wheels.forEach((w) => w.slots.forEach((s, i) => {
      if (SLOT.test(s.name || '') || (s.filter && SLOT.test(s.filter))) {
        slots.push(`   slot ${w.name}[${i + 1}] "${s.name}"${s.filter ? ` filter=${s.filter}` : ''}`);
      }
    }));
  }
  if (!seen.size && !slots.length) continue;
  matched += 1;
  console.log(`\n${type.manufacturer} ${type.name}   (${path.relative(process.cwd(), file)})`);
  [...seen.values(), ...slots].forEach((line) => console.log(line));
}
console.log(`\n${files.length} files, ${matched} matching`);
