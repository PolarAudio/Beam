/* eslint-disable no-console */
/**
 * Framing blades as half-planes in the gate: where each blade sits, how far
 * it goes in, and how the shaper turns them.
 *
 * Usage:
 *   npm test
 */
import { bladePlanes, MAX_BLADES } from '@/plugins/visualizer/shapers';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

/** Whether any blade blocks the aperture point (x, y). */
const blocked = (planes, x, y) => planes.some(([nx, ny, c]) => nx * x + ny * y > c);

const out = () => ({ a: 0, b: 0, rot: 0 });
const half = () => ({ a: 0.5, b: 0.5, rot: 0, hasB: true });

console.log('\n-- blades out leave the field open --');
{
  const planes = bladePlanes([out(), out(), out(), out()]);
  check('four blades', planes.length, 4);
  check('the centre is open', blocked(planes, 0, 0), false);
  check('near the edge is open', blocked(planes, 0, 0.98), false);
}

console.log('\n-- four blades: top, right, bottom, left --');
{
  const top = bladePlanes([half(), out(), out(), out()]);
  check('blade 1 half in covers the top', blocked(top, 0, 0.5), true);
  check('and leaves the bottom', blocked(top, 0, -0.5), false);
  const right = bladePlanes([out(), half(), out(), out()]);
  check('blade 2 half in covers the right', blocked(right, 0.5, 0), true);
  check('and leaves the left', blocked(right, -0.5, 0), false);
  const bottom = bladePlanes([out(), out(), half(), out()]);
  check('blade 3 covers the bottom', blocked(bottom, 0, -0.5), true);
  const left = bladePlanes([out(), out(), out(), half()]);
  check('blade 4 covers the left', blocked(left, -0.5, 0), true);
}

console.log('\n-- insertion --');
{
  const full = bladePlanes([{ a: 1, b: 1, hasB: true }, out(), out(), out()]);
  check('fully in closes the field', blocked(full, 0, -0.95), true);
  const parallel = bladePlanes([{ a: 0.5 }, out(), out(), out()]);
  check('a blade with only A moves parallel', blocked(parallel, 0.9, 0.1), true);
  check('across its whole length', blocked(parallel, -0.9, 0.1), true);
  // A at 0.5 and B out: the edge runs from the middle on A's side, clockwise
  // of the top seen from the lamp (+x), up to the field's edge on B's side.
  const tilted = bladePlanes([{ a: 0.5, b: 0, hasB: true }, out(), out(), out()]);
  check('a tilted blade covers more on its A side', blocked(tilted, 0.8, 0.3), true);
  check('than on its B side', blocked(tilted, -0.8, 0.3), false);
}

console.log('\n-- rotation --');
{
  const turned = bladePlanes([half(), out(), out(), out()], 90);
  check('the shaper turned 90 takes blade 1 to the left', blocked(turned, -0.5, 0), true);
  check('off the top', blocked(turned, 0.5, 0.5), false);
  // Blade 1 half in, turned 45 degrees about its middle: its edge runs from
  // lower left to upper right, through the centre.
  const own = bladePlanes([{ ...half(), rot: 45 }, out(), out(), out()]);
  check('a turned blade frees the upper right', blocked(own, 0.5, 0.45), false);
  check('and covers the lower left', blocked(own, -0.5, -0.2), true);
}

console.log('\n-- many blades --');
{
  const many = bladePlanes(Array.from({ length: 12 }, out));
  check(`at most ${MAX_BLADES} are drawn`, many.length, MAX_BLADES);
  const six = bladePlanes(Array.from({ length: 6 }, half));
  check('six blades half in close the field', blocked(six, 0, 0) || blocked(six, 0.3, 0.3), true);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
