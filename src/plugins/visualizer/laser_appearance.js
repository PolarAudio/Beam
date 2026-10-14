import { chromaticityAt } from '../../models/DMX/generic/spectral';

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
 * The sRGB primaries the lines are drawn with, CIE 1931 chromaticity.
 *
 * @constant {Object}
 */
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
 * The factor a line is drawn brighter by: its ratio over the ratio of the
 * primary it is drawn as.
 *
 * @public
 * @param {String} channel 'red' | 'green' | 'blue'
 * @param {Number} nm the line's wavelength
 * @returns {Number}
 */
export function laserAppearance(channel, nm) {
  return brightnessRatio(chromaticityAt(nm)) / brightnessRatio(SRGB_PRIMARIES[channel]);
}

/**
 * A laser's colour balance: the share of each colour's full output it runs at
 * so that equal red, green and blue values draw white.
 *
 * Laser content is colour balanced (ILDA IDTF section 2.5): full red, green
 * and blue is white. A projector meets that by holding back its stronger
 * colours, so the weakest one runs at full and sets how bright white can be.
 * White here is white as drawn: each colour's drawn brightness, its luminance
 * on the sRGB primary times `laserAppearance`, comes out equal.
 *
 * @public
 * @param {Object} drawn `{ red, green, blue }`, each colour's drawn
 *   brightness at full output
 * @returns {Object} `{ red, green, blue }`, each 0..1
 */
export function whiteBalance(drawn) {
  const keys = ['red', 'green', 'blue'];
  const lit = keys.map((c) => Number(drawn[c]) || 0).filter((v) => v > 0);
  const weakest = lit.length ? Math.min(...lit) : 0;
  const out = {};
  keys.forEach((c) => {
    const v = Number(drawn[c]) || 0;
    out[c] = v > 0 ? weakest / v : 0;
  });
  return out;
}
