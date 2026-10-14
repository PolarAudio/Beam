/* eslint-disable no-console */
/**
 * Laser lines as the eye takes them: lumens per watt and chromaticity from
 * the CIE 1931 tables, and the perceived-brightness factor each line is drawn
 * with against its sRGB primary (Ware-Cowan).
 *
 * Usage:
 *   npm test
 */
import { efficacyAt, chromaticityAt } from '@/models/DMX/generic/spectral';
import {
  brightnessRatio, laserAppearance, whiteBalance, SRGB_PRIMARIES,
} from '@/plugins/visualizer/laser_appearance';

let failures = 0;

function near(label, got, want, tolerance = 0.01) {
  const ok = Math.abs(got - want) <= tolerance;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got ${got.toFixed(4)}  want ${want}`);
}

near('683 lm/W at 555 nm', efficacyAt(555), 683, 0.001);
near('638 nm red, lm/W', efficacyAt(638), 131, 1);
near('525 nm green, lm/W', efficacyAt(525), 541.8, 1);
near('455 nm blue, lm/W', efficacyAt(455), 32.8, 0.5);
// Wicked Lasers rate the Ultra's 1.5 / 2 / 4 W at 638 / 525 / 455 nm as 1,405 lm.
near('the Ultra in lumens', 1.5 * efficacyAt(638) + 2 * efficacyAt(525) + 4 * efficacyAt(455), 1405, 10);
near('520 nm chromaticity x', chromaticityAt(520).x, 0.0743, 1e-4);
near('between table rows, 522.5 nm y', chromaticityAt(522.5).y, (0.8338 + 0.8262) / 2, 1e-4);

// Equal-energy white sits near 1: an unsaturated colour looks as bright as
// its luminance.
near('white is about its luminance', brightnessRatio({ x: 1 / 3, y: 1 / 3 }), 1, 0.1);
near('the sRGB red primary', brightnessRatio(SRGB_PRIMARIES.red), 1.258);
near('638 nm over the red primary', laserAppearance('red', 638), 1.25, 0.02);
near('520 nm over the green primary', laserAppearance('green', 520), 1.47, 0.02);
near('450 nm over the blue primary', laserAppearance('blue', 450), 1.05, 0.02);

// Colour balance: the LaserCube Pro 2.5W draws red, green and blue at 644,
// 831 and 316 at full, so blue runs at full and the others are held back.
const cube = { red: 644.3, green: 831.2, blue: 315.8 };
const held = whiteBalance(cube);
near('balance: blue, the weakest, runs at full', held.blue, 1, 1e-9);
near('balance: red held to 0.49', held.red, 0.49, 0.01);
near('balance: green held to 0.38', held.green, 0.38, 0.01);
near('balance: white draws equal red and green', cube.red * held.red, cube.green * held.green, 1e-9);
near('balance: a colour with no line stays off', whiteBalance({ red: 5, green: 0, blue: 10 }).green, 0, 0);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
