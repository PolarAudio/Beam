/* eslint-disable no-console */
/* eslint-disable no-bitwise */
/**
 * The ILDA reader against the shipped test patterns and against files built
 * here for each format the specification defines.
 *
 * Usage:
 *   npm test
 */
import fs from 'fs';
import path from 'path';
import {
  readIlda, frameAt, IldaError, DEFAULT_PALETTE, POINT_STRIDE,
} from '@/models/DMX/ilda';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

const dir = path.join(process.cwd(), 'public', 'lasers');
const shipped = (name) => readIlda(new Uint8Array(fs.readFileSync(path.join(dir, `${name}.ild`))));

/** Counts the blanked points of a frame: no colour and no intensity. */
function blanked(frame) {
  let n = 0;
  for (let i = 0; i < frame.count; i += 1) {
    if (frame.points[i * POINT_STRIDE + 5] === 0) n += 1;
  }
  return n;
}

/** A signed galvo value from the stored bit pattern. */
const signed = (v) => (v << 16) >> 16;

// The shipped patterns, counted by a separate reader over the raw bytes.
const t12 = shipped('ILDA test pattern 12K');
check('12K: one frame', t12.frames.length, 1);
check('12K: format 0, 1191 points', [t12.frames[0].format, t12.frames[0].count], [0, 1191]);
check('12K: 467 blanked', blanked(t12.frames[0]), 467);
check('12K: ends with an end header', t12.truncated, false);
const t30 = shipped('ILDA test pattern 30K');
check('30K: 1415 points, 500 blanked', [t30.frames[0].count, blanked(t30.frames[0])], [1415, 500]);
check('LaserMedia test: 256 points', shipped('LaserMedia test').frames[0].count, 256);
check('Quadrature square wave: 256 points', shipped('Quadrature square wave').frames[0].count, 256);

/**
 * Builds an ILDA file from sections `{ format, records, projector, name }`,
 * each record an array of bytes already laid out, and appends the end header.
 */
function build(sections) {
  const headers = [...sections, { format: 0, records: [] }];
  const parts = headers.map((s) => {
    const head = new Uint8Array(32);
    head.set([0x49, 0x4c, 0x44, 0x41], 0);
    head[7] = s.format;
    [...(s.name || '')].forEach((c, i) => { head[8 + i] = c.charCodeAt(0); });
    head[24] = s.records.length >> 8;
    head[25] = s.records.length & 0xff;
    head[30] = s.projector || 0;
    return [head, ...s.records.map((r) => new Uint8Array(r))];
  }).flat();
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  parts.forEach((p) => { out.set(p, o); o += p.length; });
  return out;
}
const be16 = (v) => [(v >> 8) & 0xff, v & 0xff];

// Format 1, indexed against the default palette, one point blanked.
const f1 = readIlda(build([{
  format: 1,
  name: 'IDX',
  records: [
    [...be16(-32768), ...be16(32767), 0x00, 24],
    [...be16(100), ...be16(-100), 0x40, 24],
  ],
}]));
check('format 1: name', f1.frames[0].name, 'IDX');
check('format 1: x -32768, y 32767', [signed(f1.frames[0].points[0]), signed(f1.frames[0].points[1])], [-32768, 32767]);
check('format 1: index 24 is the palette green', [...f1.frames[0].points.slice(2, 6)], [0, 65535, 0, 65535]);
check('format 1: the blanking bit wins over the colour', [...f1.frames[0].points.slice(8, 12)], [0, 0, 0, 0]);
check('default palette has 64 colours', DEFAULT_PALETTE.length, 64);

// A format 2 palette applies to the indexed frames after it, on its projector.
const pal = readIlda(build([
  { format: 2, projector: 1, records: [[10, 20, 30], [40, 50, 60]] },
  { format: 1, projector: 1, records: [[...be16(0), ...be16(0), 0x00, 1]] },
  { format: 1, projector: 0, records: [[...be16(0), ...be16(0), 0x00, 1]] },
]));
check('format 2: projector 1 uses its palette', [...pal.frames[0].points.slice(2, 5)], [40 * 257, 50 * 257, 60 * 257]);
check('format 2: projector 0 keeps the default', [...pal.frames[1].points.slice(2, 5)], [255 * 257, 16 * 257, 0]);
const past = readIlda(build([
  { format: 2, records: [[1, 2, 3], [4, 5, 6]] },
  { format: 1, records: [[...be16(0), ...be16(0), 0x00, 9]] },
]));
check('an index past the palette is white', [...past.frames[0].points.slice(2, 5)], [65535, 65535, 65535]);

// Formats 0, 4 and 5: Z is skipped, true colour is stored blue, green, red.
const r0 = [...be16(5), ...be16(6), ...be16(7), 0x00, 40];
const p0 = readIlda(build([{ format: 0, records: [r0] }])).frames[0].points;
check('format 0: x, y and the palette blue', [signed(p0[0]), signed(p0[1]), p0[4]], [5, 6, 65535]);
const r4 = [...be16(1), ...be16(2), ...be16(3), 0x00, 30, 20, 10];
const p4 = readIlda(build([{ format: 4, records: [r4] }])).frames[0].points;
check('format 4: blue, green, red read as r, g, b', [...p4.slice(2, 5)], [10 * 257, 20 * 257, 30 * 257]);
const f5 = readIlda(build([{ format: 5, records: [[...be16(-1), ...be16(1), 0x00, 3, 2, 1]] }]));
const p5 = f5.frames[0].points;
check('format 5: x -1, colour 1, 2, 3', [signed(p5[0]), ...p5.slice(2, 5)], [-1, 257, 514, 771]);

// Several frames, and a file cut short.
const seq = build([
  { format: 5, records: [[0, 0, 0, 0, 0, 0, 0, 255], [0, 0, 0, 0, 0, 0, 0, 255]] },
  { format: 5, records: [[0, 0, 0, 0, 0, 0, 0, 255]] },
]);
const two = readIlda(seq);
check('two frames read', two.frames.map((f) => f.count), [2, 1]);
const cut = readIlda(seq.slice(0, seq.length - 33));
check('cut short: the whole frames are kept', [cut.frames.length, cut.truncated], [1, true]);
let refused = false;
try {
  readIlda(new Uint8Array([0x4c, 0x41, 0x5a, 0x52, 0, 0, 0, 0]));
} catch (err) {
  refused = err instanceof IldaError;
}
check('a file not starting with ILDA is refused', refused, true);

// Each frame plays once at the point rate and the sequence loops.
const frames = [{ count: 100 }, { count: 300 }];
check('frameAt: 0 s is the first frame', frameAt(frames, 0, 1000), 0);
check('frameAt: 0.15 s is the second', frameAt(frames, 0.15, 1000), 1);
check('frameAt: 0.45 s has looped to the first', frameAt(frames, 0.45, 1000), 0);
check('frameAt: one frame is always 0', frameAt([{ count: 5 }], 99, 1000), 0);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
