/* eslint-disable no-bitwise */
/**
 * @file Reads ILDA Image Data Transfer Format files (.ild).
 *
 * Follows the ILDA IDTF specification, revision 011 (November 2014): a file is
 * a run of sections, each a 32-byte header and its records, ended by a frame
 * header with no records. All five formats are read, as the standard requires:
 * 0 and 1 (3D and 2D, indexed colour), 2 (a palette for the indexed frames
 * after it) and 4 and 5 (3D and 2D, true colour). Values are big-endian.
 *
 * Frames come out as the point stream a DAC delivers to the renderer: six
 * 16-bit values per point, x and y as the bit pattern of the signed galvo
 * value, then red, green, blue and intensity at 0..65535. Z is not used: a
 * projector scans X and Y.
 *
 * The format carries no timing. How long a frame lasts is its point count over
 * the rate it is played at, which the player decides.
 */

/** Values per point in a frame, as the renderer's DAC streams carry them. */
export const POINT_STRIDE = 6;

/** Bytes in a section header. */
const HEADER_BYTES = 32;

/** Bytes per record, by format code. */
const RECORD_BYTES = {
  0: 8, 1: 6, 2: 3, 4: 10, 5: 8,
};

/** Status bit 6: the laser is off for this point. */
const BLANKING_BIT = 0x40;

/**
 * The suggested default palette, Appendix A of the specification: 64 colours
 * of the saturated hues and white, as `[r, g, b]`. Used by indexed frames until
 * a format 2 section sets a palette, and by the ILDA test pattern itself.
 *
 * @constant {Array<Array<Number>>}
 */
export const DEFAULT_PALETTE = [
  [255, 0, 0], [255, 16, 0], [255, 32, 0], [255, 48, 0],
  [255, 64, 0], [255, 80, 0], [255, 96, 0], [255, 112, 0],
  [255, 128, 0], [255, 144, 0], [255, 160, 0], [255, 176, 0],
  [255, 192, 0], [255, 208, 0], [255, 224, 0], [255, 240, 0],
  [255, 255, 0], [224, 255, 0], [192, 255, 0], [160, 255, 0],
  [128, 255, 0], [96, 255, 0], [64, 255, 0], [32, 255, 0],
  [0, 255, 0], [0, 255, 36], [0, 255, 73], [0, 255, 109],
  [0, 255, 146], [0, 255, 182], [0, 255, 219], [0, 255, 255],
  [0, 227, 255], [0, 198, 255], [0, 170, 255], [0, 142, 255],
  [0, 113, 255], [0, 85, 255], [0, 56, 255], [0, 28, 255],
  [0, 0, 255], [32, 0, 255], [64, 0, 255], [96, 0, 255],
  [128, 0, 255], [160, 0, 255], [192, 0, 255], [224, 0, 255],
  [255, 0, 255], [255, 32, 255], [255, 64, 255], [255, 96, 255],
  [255, 128, 255], [255, 160, 255], [255, 192, 255], [255, 224, 255],
  [255, 255, 255], [255, 224, 224], [255, 192, 192], [255, 160, 160],
  [255, 128, 128], [255, 96, 96], [255, 64, 64], [255, 32, 32],
];

/** A colour index past the end of the palette in use is drawn white. */
const MISSING_COLOUR = [255, 255, 255];

/** Thrown for a file that is not ILDA at all. */
export class IldaError extends Error {}

/**
 * Eight ASCII characters, ending at the first zero byte.
 *
 * @param {DataView} view
 * @param {Number} offset
 * @returns {String}
 */
function asciiAt(view, offset) {
  let text = '';
  for (let i = 0; i < 8; i += 1) {
    const code = view.getUint8(offset + i);
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return text.trim();
}

/**
 * Whether a section header starts at this offset.
 *
 * @param {DataView} view
 * @param {Number} offset
 * @returns {Boolean}
 */
function isHeaderAt(view, offset) {
  return offset + HEADER_BYTES <= view.byteLength
    && view.getUint8(offset) === 0x49 // I
    && view.getUint8(offset + 1) === 0x4c // L
    && view.getUint8(offset + 2) === 0x44 // D
    && view.getUint8(offset + 3) === 0x41; // A
}

/**
 * Reads one frame's records into the DAC point layout.
 *
 * @param {DataView} view
 * @param {Number} offset first record
 * @param {Number} format 0, 1, 4 or 5
 * @param {Number} count records
 * @param {Array} palette `[r, g, b]` entries for the indexed formats
 * @returns {Uint16Array}
 */
function readPoints(view, offset, format, count, palette) {
  const size = RECORD_BYTES[format];
  const threeD = format === 0 || format === 4;
  const points = new Uint16Array(count * POINT_STRIDE);
  for (let i = 0; i < count; i += 1) {
    const at = offset + i * size;
    const x = view.getInt16(at);
    const y = view.getInt16(at + 2);
    const tail = at + (threeD ? 6 : 4);
    const status = view.getUint8(tail);
    let rgb;
    if (format === 0 || format === 1) {
      rgb = palette[view.getUint8(tail + 1)] || MISSING_COLOUR;
    } else {
      // True colour is stored blue, green, red.
      rgb = [view.getUint8(tail + 3), view.getUint8(tail + 2), view.getUint8(tail + 1)];
    }
    // The blanking bit takes precedence over any colour (section 5.2.4).
    const blank = (status & BLANKING_BIT) !== 0;
    const o = i * POINT_STRIDE;
    points[o] = x & 0xffff;
    points[o + 1] = y & 0xffff;
    points[o + 2] = blank ? 0 : rgb[0] * 257;
    points[o + 3] = blank ? 0 : rgb[1] * 257;
    points[o + 4] = blank ? 0 : rgb[2] * 257;
    points[o + 5] = blank ? 0 : 65535;
  }
  return points;
}

/**
 * Reads an ILDA file.
 *
 * Palettes are kept per projector number, as the specification has them: a
 * format 2 section sets the palette for the indexed frames that follow it on
 * that projector. A file cut short keeps the frames read before the cut and
 * says so in `truncated`.
 *
 * @public
 * @param {ArrayBuffer|Uint8Array} data the file's bytes
 * @returns {Object} `{ frames, truncated }`, each frame
 *   `{ name, company, number, total, projector, format, count, points }`
 * @throws {IldaError} when the file does not start with an ILDA header
 */
export function readIlda(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!isHeaderAt(view, 0)) throw new IldaError('Not an ILDA file: it does not start with "ILDA".');

  const palettes = new Map();
  const frames = [];
  let truncated = false;
  let offset = 0;
  while (offset < view.byteLength) {
    if (!isHeaderAt(view, offset)) {
      truncated = true;
      break;
    }
    const format = view.getUint8(offset + 7);
    const count = view.getUint16(offset + 24);
    const projector = view.getUint8(offset + 30);
    const size = RECORD_BYTES[format];
    // An unknown format cannot be skipped, since its record size is unknown.
    if (!size) {
      truncated = true;
      break;
    }
    // A frame header with no records ends the file.
    if (count === 0 && format !== 2) break;
    const first = offset + HEADER_BYTES;
    if (first + count * size > view.byteLength) {
      truncated = true;
      break;
    }
    if (format === 2) {
      const palette = [];
      for (let i = 0; i < count; i += 1) {
        const at = first + i * 3;
        palette.push([view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2)]);
      }
      palettes.set(projector, palette);
    } else {
      frames.push({
        name: asciiAt(view, offset + 8),
        company: asciiAt(view, offset + 16),
        number: view.getUint16(offset + 26),
        total: view.getUint16(offset + 28),
        projector,
        format,
        count,
        points: readPoints(view, first, format, count, palettes.get(projector) || DEFAULT_PALETTE),
      });
    }
    offset = first + count * size;
  }
  return { frames, truncated };
}

/**
 * Which frame of a sequence is showing at a time, when each frame is played
 * once at a point rate and the sequence loops.
 *
 * @public
 * @param {Array} frames from `readIlda`
 * @param {Number} seconds time since the clip started
 * @param {Number} rate points per second
 * @returns {Number} index into `frames`, or -1 when there are none
 */
export function frameAt(frames, seconds, rate) {
  if (!frames || !frames.length) return -1;
  if (frames.length === 1 || !(rate > 0)) return 0;
  const total = frames.reduce((sum, frame) => sum + frame.count, 0);
  if (!total) return 0;
  const cycle = total / rate;
  let t = (((Number(seconds) || 0) % cycle) + cycle) % cycle;
  for (let i = 0; i < frames.length; i += 1) {
    const length = frames[i].count / rate;
    if (t < length) return i;
    t -= length;
  }
  return frames.length - 1;
}
