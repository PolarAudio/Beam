/* eslint-disable no-console */
/**
 * What a device does to its input's picture: crop, scale and turn, as one
 * map from a point of what it shows to the point of the input shown there.
 *
 * Coordinates run 0..1 from the top-left on both sides.
 *
 * Usage:
 *   npm test
 */
import { pictureOf, pictureMapping } from '@/models/DMX/picture_controls';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

const r = (n) => Math.round(n * 1000) / 1000;
const at = (m, u, v) => {
  const p = m.map(u, v);
  return `${r(p.x)},${r(p.y)}`;
};
const inside = (m, u, v) => {
  const p = m.map(u, v);
  const b = m.bounds;
  return p.x >= b.x0 - 1e-9 && p.x <= b.x1 + 1e-9 && p.y >= b.y0 - 1e-9 && p.y <= b.y1 + 1e-9;
};

/** A setting store with these values. */
const settings = (values) => ({ value: (key) => values[key] });

const WIDE = { aspect: 16 / 9, pixelsWide: 1920, pixelsHigh: 1080 };
const SQUARE = { width: 1080, height: 1080 };

console.log('\n-- nothing set changes nothing --');
{
  const m = pictureMapping(pictureOf(null), WIDE, SQUARE);
  check('top-left is top-left', at(m, 0, 0), '0,0');
  check('bottom-right is bottom-right', at(m, 1, 1), '1,1');
  check('every point is picture', inside(m, 0, 0) && inside(m, 1, 1), true);
}

console.log('\n-- a square input fitted to a 16:9 device --');
{
  const m = pictureMapping(pictureOf(settings({ scale: 'fit' })), WIDE, SQUARE);
  // The square is as tall as the picture and 9/16 of its width, centred: bars
  // of 7/32 either side.
  check('the middle is the middle', at(m, 0.5, 0.5), '0.5,0.5');
  const edge = 7 / 32;
  check('the square starts 7/32 in', at(m, edge, 0), '0,0');
  check('and ends 7/32 from the right', at(m, 1 - edge, 1), '1,1');
  check('the left edge of the device is bar', inside(m, 0.05, 0.5), false);
  check('the right edge of the device is bar', inside(m, 0.95, 0.5), false);
  check('the top is picture', inside(m, 0.5, 0), true);
}

console.log('\n-- the same square filling the device --');
{
  const m = pictureMapping(pictureOf(settings({ scale: 'fill' })), WIDE, SQUARE);
  check('as wide as the device', at(m, 0, 0.5), '0,0.5');
  check('cropped top and bottom: the top shows 7/32 down', at(m, 0.5, 0), `0.5,${r(0.5 - 0.5 * (9 / 16))}`);
  check('every point is picture', inside(m, 0, 0) && inside(m, 1, 1), true);
}

console.log('\n-- native: one input pixel to one device pixel --');
{
  const m = pictureMapping(pictureOf(settings({ scale: 'native' })), WIDE, { width: 960, height: 540 });
  check('a half-size input sits in the middle quarter', at(m, 0.25, 0.25), '0,0');
  check('ending at three quarters', at(m, 0.75, 0.75), '1,1');
  check('outside it is black', inside(m, 0.1, 0.1), false);
}

console.log('\n-- digital zoom --');
{
  const m = pictureMapping(pictureOf(settings({ pictureZoom: 200 })), WIDE, SQUARE);
  check('200% shows the middle half', at(m, 0, 0), '0.25,0.25');
  check('to three quarters', at(m, 1, 1), '0.75,0.75');
  const small = pictureMapping(pictureOf(settings({ pictureZoom: 50 })), WIDE, SQUARE);
  check('50% puts the whole input in the middle half', at(small, 0.25, 0.25), '0,0');
  check('with black around it', inside(small, 0.1, 0.1), false);
  const floor = pictureMapping(pictureOf(settings({ pictureZoom: 5 })), WIDE, SQUARE);
  check('zoom stops at 25%', at(floor, 0.375, 0.375), '0,0');
  check('a device with no zoom set shows 100%', pictureOf(settings({})).zoom, 1);
}

console.log('\n-- crop --');
{
  // Pixels of the input: 108 and 216 of a 1080 square.
  const m = pictureMapping(pictureOf(settings({ cropLeft: 108, cropTop: 216 })), WIDE, SQUARE);
  check('stretched, the device shows the cropped part', at(m, 0, 0), '0.1,0.2');
  check('to the far corner', at(m, 1, 1), '1,1');
  check('the crop is the picture\'s edge', `${r(m.bounds.x0)},${r(m.bounds.y0)}`, '0.1,0.2');
  const hd = pictureMapping(pictureOf(settings({ cropLeft: 192 })), WIDE, { width: 1920, height: 1080 });
  check('the same pixels are a share of a wider input', r(hd.bounds.x0), 0.1);
  check('a crop is whole pixels', pictureOf(settings({ cropLeft: 10.6 })).crop.left, 11);
  const over = pictureMapping(pictureOf(settings({ cropLeft: 540, cropRight: 540 })), WIDE, SQUARE);
  check('a crop leaves a sliver of the input', r(over.bounds.x0), 0.49);
  const early = pictureMapping(pictureOf(settings({ cropLeft: 192 })), WIDE, {});
  check('before a frame, the device\'s own size', r(early.bounds.x0), 0.1);
}

console.log('\n-- turned, then fitted --');
{
  // A 16:9 panel hung in portrait, showing a 16:9 picture turned upright and
  // fitted. For the viewer the picture spans the width, which is the panel's
  // short side, with bars above and below, which are the panel's long ends.
  // u and v are the panel's own coordinates.
  const m = pictureMapping(
    pictureOf(settings({ rotation: 90, scale: 'fit' })),
    WIDE,
    { width: 1920, height: 1080 },
  );
  check('the middle is still the middle', at(m, 0.5, 0.5), '0.5,0.5');
  check('the panel\'s long ends are bars', inside(m, 0.02, 0.5), false);
  check('across the panel\'s short side is picture', inside(m, 0.5, 0.02), true);
}

console.log('\n-- the map is affine and its coefficients agree with it --');
{
  const m = pictureMapping(
    pictureOf(settings({
      rotation: 270, mirrorH: true, scale: 'fit', pictureZoom: 150, cropRight: 108,
    })),
    WIDE,
    SQUARE,
  );
  const u = 0.3;
  const v = 0.7;
  const p = m.map(u, v);
  check('x from the coefficients', r(m.ax * u + m.bx * v + m.cx), r(p.x));
  check('y from the coefficients', r(m.ay * u + m.by * v + m.cy), r(p.y));
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
