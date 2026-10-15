/**
 * @file The eye's response to a single wavelength, for laser lines: the CIE
 * 1931 2-degree photopic luminous efficiency V(lambda) and the chromaticity of
 * the spectral colour, every 5 nm from 440 to 660 nm, interpolated between.
 * Outside that span the nearest end is used; show-laser diodes sit inside it.
 *
 * Pure, so it runs in a test.
 */

/** First wavelength in the table and the step, in nm. */
const FIRST = 440;
const STEP = 5;

/** `[x, y, V]` per row, from 440 nm in 5 nm steps. */
const TABLE = [
  [0.1644, 0.0109, 0.0230], [0.1611, 0.0138, 0.0298], [0.1566, 0.0177, 0.0380],
  [0.1510, 0.0227, 0.0480], [0.1440, 0.0297, 0.0600], [0.1355, 0.0399, 0.0739],
  [0.1241, 0.0578, 0.0910], [0.1096, 0.0868, 0.1126], [0.0913, 0.1327, 0.1390],
  [0.0687, 0.2007, 0.1693], [0.0454, 0.2950, 0.2080], [0.0235, 0.4127, 0.2586],
  [0.0082, 0.5384, 0.3230], [0.0039, 0.6548, 0.4073], [0.0139, 0.7502, 0.5030],
  [0.0389, 0.8120, 0.6082], [0.0743, 0.8338, 0.7100], [0.1142, 0.8262, 0.7932],
  [0.1547, 0.8059, 0.8620], [0.1929, 0.7816, 0.9149], [0.2296, 0.7543, 0.9540],
  [0.2658, 0.7243, 0.9803], [0.3016, 0.6923, 0.9950], [0.3373, 0.6589, 1.0000],
  [0.3731, 0.6245, 0.9950], [0.4087, 0.5896, 0.9786], [0.4441, 0.5547, 0.9520],
  [0.4788, 0.5202, 0.9154], [0.5125, 0.4866, 0.8700], [0.5448, 0.4544, 0.8163],
  [0.5752, 0.4242, 0.7570], [0.6029, 0.3965, 0.6949], [0.6270, 0.3725, 0.6310],
  [0.6482, 0.3514, 0.5668], [0.6658, 0.3340, 0.5030], [0.6801, 0.3197, 0.4412],
  [0.6915, 0.3083, 0.3810], [0.7006, 0.2993, 0.3210], [0.7079, 0.2920, 0.2650],
  [0.7140, 0.2859, 0.2170], [0.7190, 0.2809, 0.1750], [0.7230, 0.2770, 0.1382],
  [0.7260, 0.2740, 0.1070], [0.7283, 0.2717, 0.0816], [0.7300, 0.2700, 0.0610],
];

/** Lumens per watt at the peak of V(lambda), 555 nm. */
export const LUMENS_PER_WATT_PEAK = 683;

/**
 * A table row interpolated at a wavelength.
 *
 * @param {Number} nm wavelength
 * @returns {Number[]} `[x, y, V]`
 */
function at(nm) {
  const last = TABLE.length - 1;
  const f = Math.min(Math.max((Number(nm) - FIRST) / STEP, 0), last);
  const i = Math.min(Math.floor(f), last - 1);
  const t = f - i;
  return TABLE[i].map((v, k) => v + (TABLE[i + 1][k] - v) * t);
}

/**
 * Lumens per optical watt of a single wavelength.
 *
 * @public
 * @param {Number} nm
 * @returns {Number}
 */
export function efficacyAt(nm) {
  return LUMENS_PER_WATT_PEAK * at(nm)[2];
}

/**
 * The CIE 1931 chromaticity of a spectral colour.
 *
 * @public
 * @param {Number} nm
 * @returns {Object} `{ x, y }`
 */
export function chromaticityAt(nm) {
  const [x, y] = at(nm);
  return { x, y };
}
