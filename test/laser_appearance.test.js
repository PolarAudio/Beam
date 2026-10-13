/* eslint-disable no-console */
/**
 * The perceived-brightness factors for laser lines: the Ware-Cowan fit, and
 * the factor each laser colour is drawn brighter by against its sRGB primary.
 *
 * Usage:
 *   npm test
 */
import {
  brightnessRatio, LASER_APPEARANCE, SRGB_PRIMARIES,
} from '@/plugins/visualizer/laser_appearance';

let failures = 0;

function near(label, got, want, tolerance = 0.01) {
  const ok = Math.abs(got - want) <= tolerance;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got ${got.toFixed(4)}  want ${want}`);
}

// Equal-energy white sits near 1: an unsaturated colour looks as bright as
// its luminance.
near('white is about its luminance', brightnessRatio({ x: 1 / 3, y: 1 / 3 }), 1, 0.1);
near('the sRGB red primary', brightnessRatio(SRGB_PRIMARIES.red), 1.258);
near('red line over the red primary', LASER_APPEARANCE.red, 1.24);
near('green line over the green primary', LASER_APPEARANCE.green, 1.47);
near('blue line over the blue primary', LASER_APPEARANCE.blue, 1.05);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
