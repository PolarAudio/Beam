/* eslint-disable no-console */
/**
 * Every GDTF file in a corpus folder, against what Beam made of each before.
 *
 * A fix made for one fixture runs in every file Beam reads, so this records,
 * per file and mode: each wheel's slot kinds, the head's inputs (lumens,
 * power, zoom, pan and tilt), and, per channel, what the dispatcher tells the
 * head at every set and function boundary and midway between. A change to any
 * of them fails the test and names the file, the mode and the channel, with
 * what the head is told now.
 *
 * The corpus is the user's own downloads, not part of the repository; the
 * snapshot holds only what Beam derived from them. Without the folder the
 * test says so and passes.
 *
 * Usage:
 *   npm test                                   compare with the snapshot
 *   BEAM_GDTF_CORPUS=<folder> npm test         another corpus folder
 *   BEAM_GDTF_SNAPSHOT=update npm test         record the snapshot again
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { DOMParser } from '@xmldom/xmldom';
import readGdtf from '@/models/DMX/gdtf/gdtf_reader';
import DmxEngine from '@/models/DMX/gdtf/dmx_engine';
import HeadDispatch from '@/models/DMX/gdtf/head_dispatch';
import { headInputs, wheelsForHead } from '@/models/DMX/gdtf/fixture_parts';

const corpus = process.env.BEAM_GDTF_CORPUS || path.join(os.homedir(), 'Downloads', 'gdtf');
const snapshotFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gdtf_corpus.snapshot.json');
const updating = process.env.BEAM_GDTF_SNAPSHOT === 'update';

if (!fs.existsSync(corpus)) {
  console.log(`no corpus at ${corpus}; skipped`);
  process.exit(0);
}

const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');
const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
const coarse = (value, bytes) => Math.floor(value / 256 ** (bytes - 1));

/** The values a channel is sampled at: every boundary, and midway between. */
function samplesOf(c) {
  const points = new Set();
  c.functions.forEach((f) => {
    [f.dmxFrom, f.dmxTo, ...f.sets.flatMap((s) => [s.dmxFrom, s.dmxTo])]
      .forEach((v) => points.add(coarse(v, c.bytes)));
  });
  const sorted = [...points].filter((v) => v >= 0 && v <= 255).sort((a, b) => a - b);
  const mids = sorted.slice(1).map((v, i) => Math.floor((sorted[i] + v) / 2));
  return [...new Set([...sorted, ...mids])].sort((a, b) => a - b);
}

/** What the dispatcher tells a head, value by value, for one channel. */
function actionsOf(type, mode, offset) {
  const engine = new DmxEngine(type, mode);
  const lines = [];
  let at = null;
  const head = new Proxy({}, {
    get(o, k) {
      if (k in o) return o[k];
      if (typeof k === 'string' && /^set[A-Z]/.test(k)) {
        return (...a) => lines.push(`${at}:${k}(${JSON.stringify(a, (_, v) => round(v))})`);
      }
      return undefined;
    },
    set(o, k, v) { lines.push(`${at}:${String(k)}=${JSON.stringify(v, (_, x) => round(x))}`); o[k] = v; return true; },
  });
  const dispatch = new HeadDispatch(head, engine);
  const c = engine.channels.find((x) => x.offsets && x.offsets[0] === offset);
  samplesOf(c).forEach((v) => {
    at = v;
    engine.write(offset - 1, v);
    dispatch.applyChannel(c);
  });
  return lines;
}

const hash = (lines) => crypto.createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16);

const now = {};
const details = {};
fs.readdirSync(corpus).filter((f) => f.endsWith('.gdtf')).sort().forEach((file) => {
  const { fixtureType: type } = readGdtf(fs.readFileSync(path.join(corpus, file)), { parseXml });
  const wheels = {};
  Object.entries(wheelsForHead(type)).forEach(([name, w]) => {
    wheels[name] = w.slots.map((s) => s.type).join(' ');
  });
  const modes = {};
  type.modes.forEach((mode) => {
    const i = headInputs(type, mode);
    const dispatch = {};
    new DmxEngine(type, mode).channels.forEach((c) => {
      if (!c.offsets) return;
      const lines = actionsOf(type, mode, c.offsets[0]);
      const key = `${c.offsets[0]} ${c.channel.name}`;
      dispatch[key] = hash(lines);
      details[`${file} | ${mode.name} | ${key}`] = lines;
    });
    modes[mode.name] = {
      inputs: {
        category: i.category,
        lumens: round(i.lumens),
        power: round(i.power),
        zoom: [round(i.minAngle), round(i.maxAngle)],
        pan: round(i.panSpan),
        tilt: round(i.tiltSpan),
        speed: [round(i.panSpeed), round(i.tiltSpeed)],
      },
      dispatch,
    };
  });
  now[file] = { wheels, modes };
});

if (updating || !fs.existsSync(snapshotFile)) {
  fs.writeFileSync(snapshotFile, `${JSON.stringify(now, null, 1)}\n`);
  console.log(`snapshot written: ${Object.keys(now).length} files`);
  process.exit(0);
}

const before = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
let failures = 0;
const fail = (label, detail) => {
  failures += 1;
  console.log(`FAIL  ${label}`);
  if (detail) detail.slice(0, 12).forEach((line) => console.log(`        ${line}`));
};
Object.keys(now).forEach((file) => {
  const was = before[file];
  if (!was) { console.log(`new   ${file} (not in the snapshot)`); return; }
  Object.keys(now[file].wheels).forEach((w) => {
    if (now[file].wheels[w] !== was.wheels[w]) {
      fail(`${file} wheel ${w}: ${was.wheels[w]} -> ${now[file].wheels[w]}`);
    }
  });
  Object.keys(now[file].modes).forEach((m) => {
    const a = now[file].modes[m];
    const b = was.modes[m];
    if (!b) { fail(`${file} | ${m}: mode not in the snapshot`); return; }
    if (JSON.stringify(a.inputs) !== JSON.stringify(b.inputs)) {
      fail(`${file} | ${m} inputs: ${JSON.stringify(b.inputs)} -> ${JSON.stringify(a.inputs)}`);
    }
    Object.keys(a.dispatch).forEach((ch) => {
      if (a.dispatch[ch] !== b.dispatch[ch]) {
        fail(`${file} | ${m} | ch ${ch}: what the head is told changed; now:`, details[`${file} | ${m} | ${ch}`]);
      }
    });
  });
});
console.log(failures ? `\n${failures} FAILED` : `\nall passed (${Object.keys(now).length} files)`);
process.exit(failures ? 1 : 0);
