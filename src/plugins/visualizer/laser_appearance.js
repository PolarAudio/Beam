/**
 * @file How much brighter a laser line looks than the screen can show it.
 *
 * A saturated colour looks brighter than its luminance (the Helmholtz-Kohlrausch
 * effect), and a laser line is as saturated as light gets. The screen draws each
 * line at its own primary, which is less saturated, so the viewer's eye gives
 * the drawn colour less of that lift than the real line gets in the room. Each
 * colour is multiplied by the difference: the line's brightness-to-luminance
 * ratio over the primary's. Colours inside the screen's gamut need nothing,
 * because the eye applies the effect to the screen as it does to the room.
 *
 * The ratio is the Ware-Cowan conversion factor (Ware and Cowan, 1983), a fit
 * of brightness matches against CIE 1931 chromaticity:
 * log10(B/L) = 0.256 - 0.184y - 2.527xy + 4.656x^3y + 4.657xy^4.
 *
 * Pure, so it runs in a test.
 */

/**
 * CIE 1931 chromaticity of the usual RGB show-laser lines, 638, 520 and 450 nm,
 * and of the sRGB primaries they are drawn with.
 *
 * @constant {Object}
 */
export const LASER_LINES = Object.freeze({
  red: { x: 0.7128, y: 0.2871 },
  green: { x: 0.0743, y: 0.8338 },
  blue: { x: 0.1566, y: 0.0177 },
});

export const SRGB_PRIMARIES = Object.freeze({
  red: { x: 0.64, y: 0.33 },
  green: { x: 0.30, y: 0.60 },
  blue: { x: 0.15, y: 0.06 },
});

/**
 * Brightness over luminance for a colour, by the Ware-Cowan fit.
 *
 * @public
 * @param {Object} c `{ x, y }` CIE 1931 chromaticity
 * @returns {Number}
 */
export function brightnessRatio({ x, y }) {
  const log = 0.256 - 0.184 * y - 2.527 * x * y + 4.656 * x ** 3 * y + 4.657 * x * y ** 4;
  return 10 ** log;
}

/**
 * The factor each laser colour is drawn brighter by: the line's ratio over its
 * primary's.
 *
 * @constant {Object} `{ red, green, blue }`
 */
export const LASER_APPEARANCE = Object.freeze({
  red: brightnessRatio(LASER_LINES.red) / brightnessRatio(SRGB_PRIMARIES.red),
  green: brightnessRatio(LASER_LINES.green) / brightnessRatio(SRGB_PRIMARIES.green),
  blue: brightnessRatio(LASER_LINES.blue) / brightnessRatio(SRGB_PRIMARIES.blue),
});
