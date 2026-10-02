/**
 * @file Parsers for GDTF's attribute value types (DIN SPEC 15800, GDTF 1.2,
 * "Generic Value Types"). Each takes the attribute string as written and
 * returns a plain value, or the fallback when the attribute is absent or
 * unreadable. None of them throw: a fixture file with one bad number should
 * still load, and the reader records what it could not read.
 */

/**
 * A DMX value as written, `value/bytes` with an optional `s` for byte
 * shifting: `127/1`, `65535/2`, `255/1s`. A bare integer is one byte.
 *
 * @param {String} text
 * @returns {{value: Number, bytes: Number, shift: Boolean}|null}
 */
export function parseDmxValue(text) {
  if (text === undefined || text === null || text === '') return null;
  const m = /^\s*(\d+)\s*(?:\/\s*(\d+)\s*(s)?)?\s*$/.exec(String(text));
  if (!m) return null;
  return { value: Number(m[1]), bytes: m[2] ? Number(m[2]) : 1, shift: !!m[3] };
}

/**
 * A DMX value expressed at a channel's resolution.
 *
 * GDTF writes a value at whatever byte count is convenient and converts it to
 * the channel's by byte mirroring -- the bytes repeat, so 255/1 in a 16-bit
 * channel is 65535 and 127/1 is 32639 -- or, with `s`, by shifting, so 255/1s
 * is 65280. Going down in resolution keeps the most significant bytes.
 *
 * @param {{value: Number, bytes: Number, shift: Boolean}|null} dmx
 * @param {Number} bytes the channel's resolution
 * @returns {Number|null}
 */
export function dmxAt(dmx, bytes) {
  if (!dmx) return null;
  const from = Math.max(1, dmx.bytes);
  const to = Math.max(1, bytes);
  if (to === from) return dmx.value;
  if (to < from) return Math.floor(dmx.value / 256 ** (from - to));
  if (dmx.shift) return dmx.value * 256 ** (to - from);
  // Mirroring: the written bytes, most significant first, repeated until the
  // channel's width is filled.
  const written = [];
  for (let i = from - 1; i >= 0; i -= 1) written.push(Math.floor(dmx.value / 256 ** i) % 256);
  let out = 0;
  for (let i = 0; i < to; i += 1) out = out * 256 + written[i % from];
  return out;
}

/** @returns {Number} the largest value a channel of this many bytes holds */
export function dmxMax(bytes) {
  return 256 ** Math.max(1, bytes) - 1;
}

/**
 * @param {String} text
 * @param {Number} [fallback]
 * @returns {Number}
 */
export function parseFloatValue(text, fallback = null) {
  if (text === undefined || text === null || text === '') return fallback;
  const n = Number(String(text).trim());
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {String} text
 * @param {Number} [fallback]
 * @returns {Number}
 */
export function parseIntValue(text, fallback = null) {
  const n = parseFloatValue(text, null);
  return n === null ? fallback : Math.trunc(n);
}

/**
 * A CIE 1931 colour, `x,y,Y`.
 *
 * @param {String} text
 * @returns {{x: Number, y: Number, Y: Number}|null}
 */
export function parseColorCIE(text) {
  if (!text) return null;
  const parts = String(text).split(',').map((p) => Number(p.trim()));
  if (parts.length < 2 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  return { x: parts[0], y: parts[1], Y: Number.isFinite(parts[2]) ? parts[2] : 100 };
}

/**
 * Rows of numbers in braces, `{a,b,c}{d,e,f}`.
 *
 * @param {String} text
 * @returns {Array<Array<Number>>|null}
 */
function parseRows(text) {
  if (!text) return null;
  const rows = [...String(text).matchAll(/\{([^}]*)\}/g)]
    .map((m) => m[1].split(',').map((p) => Number(p.trim())));
  if (!rows.length || rows.some((r) => r.some((n) => !Number.isFinite(n)))) return null;
  return rows;
}

/**
 * A 4x4 transform, written as four rows with the translation in the last
 * column of the first three, in metres. Returned row-major, 16 numbers.
 *
 * @param {String} text
 * @returns {Array<Number>|null} null when absent, which means identity
 */
export function parseMatrix(text) {
  const rows = parseRows(text);
  if (!rows || rows.length !== 4 || rows.some((r) => r.length !== 4)) return null;
  return rows.flat();
}

/**
 * A 3x3 rotation, three rows. Returned row-major, 9 numbers.
 *
 * @param {String} text
 * @returns {Array<Number>|null}
 */
export function parseRotation(text) {
  const rows = parseRows(text);
  if (!rows || rows.length !== 3 || rows.some((r) => r.length !== 3)) return null;
  return rows.flat();
}

/** The 4x4 identity, row-major. */
export const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * A DMX channel's offsets, `1,2` for a 16-bit channel coarse first. Empty or
 * `None` is a virtual channel, which has no address of its own.
 *
 * @param {String} text
 * @returns {Array<Number>|null} null for a virtual channel
 */
export function parseOffsets(text) {
  if (text === undefined || text === null) return null;
  const trimmed = String(text).trim();
  if (!trimmed || trimmed === 'None') return null;
  const offsets = trimmed.split(',').map((p) => Number(p.trim()));
  return offsets.every((n) => Number.isInteger(n) && n > 0) ? offsets : null;
}

/**
 * A reference to another node by name path, `Base_Dimmer.Dimmer.Dimmer`.
 *
 * @param {String} text
 * @returns {Array<String>|null}
 */
export function parseNode(text) {
  if (!text) return null;
  const parts = String(text).split('.').map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

/**
 * `Yes` / `No`, and the spec's defaults for each attribute that uses it.
 *
 * @param {String} text
 * @param {Boolean} fallback
 * @returns {Boolean}
 */
export function parseYesNo(text, fallback = false) {
  if (text === 'Yes' || text === 'yes' || text === 'true') return true;
  if (text === 'No' || text === 'no' || text === 'false') return false;
  return fallback;
}
