/* eslint-disable no-bitwise */
import { POINT_STRIDE } from './ilda';

/**
 * @file What a laser plays on its own: its test patterns and its standalone
 * clip list.
 *
 * The test patterns are built in: the ILDA test patterns and the files that
 * ship with Beam, and patterns drawn here. A laser's test pattern overrides
 * whatever it is fed, as a projector's service test does.
 *
 * The standalone list is the user's ILDA files, by file name, as a laser's own
 * memory card holds them. A file is found where a show's files are found --
 * the open project, then the user's `Library/Lasers`, then the files that ship
 * with Beam. The list belongs to the placement and is saved with the show. The
 * playing clip is picked by id by hand, or by a DMX channel as a one-based
 * position in the list.
 *
 * A clip may name the point rate it was made for. ILDA frames carry no timing,
 * so the rate decides how long each frame of an animation lasts; without one,
 * the laser's own maximum rate is used.
 */

/** What a clip is. */
export const CLIP_KINDS = { PATTERN: 'pattern', FILE: 'file' };

/** The extension a clip file has. */
export const CLIP_EXTENSION = '.ild';

/** Points per unit of field travelled along a drawn line: 100 across the full width. */
const POINTS_PER_UNIT = 50;

/** Points held at a corner, so the scanner reaches it before turning. */
const CORNER_DWELL = 4;

/** Blanked points at each end of a jump, so the beam is off while it moves. */
const JUMP_DWELL = 6;

/** Points in a full circle. */
const CIRCLE_POINTS = 200;

/** Points a held dot repeats. */
const DOT_POINTS = 64;

const WHITE = [255, 255, 255];
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];

/**
 * Builds a frame point by point in the DAC layout `readIlda` produces.
 * Coordinates are -1..1 across the scan field.
 */
class FrameBuilder {
  constructor() {
    this.values = [];
    this.x = 0;
    this.y = 0;
  }

  /** One point at the current position. */
  put(rgb) {
    const lit = rgb[0] + rgb[1] + rgb[2] > 0;
    this.values.push(
      Math.round(this.x * 32767) & 0xffff,
      Math.round(this.y * 32767) & 0xffff,
      rgb[0] * 257,
      rgb[1] * 257,
      rgb[2] * 257,
      lit ? 65535 : 0,
    );
  }

  /** Holds the current position for `n` points. */
  dwell(n, rgb) {
    for (let i = 0; i < n; i += 1) this.put(rgb);
  }

  /** Moves with the beam off, waiting at both ends. */
  jump(x, y) {
    this.dwell(JUMP_DWELL, [0, 0, 0]);
    this.x = x;
    this.y = y;
    this.dwell(JUMP_DWELL, [0, 0, 0]);
  }

  /** Draws a straight line to a point, then holds the corner. */
  line(x, y, rgb) {
    const steps = Math.max(1, Math.round(Math.hypot(x - this.x, y - this.y) * POINTS_PER_UNIT));
    const x0 = this.x;
    const y0 = this.y;
    for (let i = 1; i <= steps; i += 1) {
      this.x = x0 + ((x - x0) * i) / steps;
      this.y = y0 + ((y - y0) * i) / steps;
      this.put(rgb);
    }
    this.dwell(CORNER_DWELL, rgb);
  }

  /** The frame, as `readIlda` gives one. */
  frame(name) {
    const points = Uint16Array.from(this.values);
    return {
      name,
      company: 'Beam',
      number: 0,
      total: 1,
      projector: 0,
      format: 5,
      count: points.length / POINT_STRIDE,
      points,
    };
  }
}

/** A closed polyline, entered blanked at its first point. */
function polygon(builder, corners, rgb) {
  builder.jump(corners[0][0], corners[0][1]);
  builder.dwell(CORNER_DWELL, rgb);
  corners.slice(1).forEach(([x, y]) => builder.line(x, y, rgb));
  builder.line(corners[0][0], corners[0][1], rgb);
}

/** The generated patterns, each a function returning its frames. */
const PATTERNS = {
  circle: () => {
    const b = new FrameBuilder();
    b.jump(1, 0);
    for (let i = 0; i <= CIRCLE_POINTS; i += 1) {
      const a = (i / CIRCLE_POINTS) * Math.PI * 2;
      b.x = Math.cos(a);
      b.y = Math.sin(a);
      b.put(WHITE);
    }
    return [b.frame('Circle')];
  },
  square: () => {
    const b = new FrameBuilder();
    polygon(b, [[-1, -1], [1, -1], [1, 1], [-1, 1]], WHITE);
    return [b.frame('Square')];
  },
  crosshair: () => {
    const b = new FrameBuilder();
    // A 5 x 5 grid over the field, with the centre lines as the crosshair.
    [-1, -0.5, 0, 0.5, 1].forEach((y, i) => {
      const [from, to] = i % 2 ? [1, -1] : [-1, 1];
      b.jump(from, y);
      b.line(to, y, WHITE);
    });
    [-1, -0.5, 0, 0.5, 1].forEach((x, i) => {
      const [from, to] = i % 2 ? [-1, 1] : [1, -1];
      b.jump(x, from);
      b.line(x, to, WHITE);
    });
    return [b.frame('Crosshair')];
  },
  rgbLines: () => {
    const b = new FrameBuilder();
    [[0.5, RED], [0, GREEN], [-0.5, BLUE]].forEach(([y, rgb], i) => {
      const [from, to] = i % 2 ? [1, -1] : [-1, 1];
      b.jump(from * 0.8, y);
      b.line(to * 0.8, y, rgb);
    });
    return [b.frame('RGB lines')];
  },
  dot: () => {
    const b = new FrameBuilder();
    b.dwell(DOT_POINTS, WHITE);
    return [b.frame('Centre dot')];
  },
};

/**
 * The clips every laser can play without anything added, in the order a new
 * list is filled with. File clips name the files in `public/lasers`.
 *
 * @constant {Array<Object>}
 */
const fileEntry = (id, name, rate = null) => ({
  id, name, kind: CLIP_KINDS.FILE, file: `${name}${CLIP_EXTENSION}`, rate,
});
const patternEntry = (id, name, key) => ({
  id, name, kind: CLIP_KINDS.PATTERN, pattern: key, rate: null,
});
export const BUILT_IN_CLIPS = Object.freeze([
  fileEntry('ilda-12k', 'ILDA test pattern 12K', 12000),
  fileEntry('ilda-30k', 'ILDA test pattern 30K', 30000),
  fileEntry('lasermedia', 'LaserMedia test'),
  fileEntry('quadrature', 'Quadrature square wave'),
  patternEntry('circle', 'Circle', 'circle'),
  patternEntry('square', 'Square', 'square'),
  patternEntry('crosshair', 'Crosshair and grid', 'crosshair'),
  patternEntry('rgb-lines', 'RGB lines', 'rgbLines'),
  patternEntry('dot', 'Centre dot', 'dot'),
]);

/** The test pattern value that plays nothing. */
export const TEST_PATTERN_OFF = 'off';

/** Every test pattern value, Off first: the order a DMX channel splits into. */
export const TEST_PATTERN_IDS = Object.freeze([
  TEST_PATTERN_OFF, ...BUILT_IN_CLIPS.map((clip) => clip.id),
]);

/** What each test pattern is called on screen. */
export const TEST_PATTERN_LABELS = Object.freeze({
  [TEST_PATTERN_OFF]: 'Off',
  ...Object.fromEntries(BUILT_IN_CLIPS.map((clip) => [clip.id, clip.name])),
});

/**
 * The clip a test pattern value plays, or null for Off or an unknown value.
 *
 * @public
 * @param {String} id
 * @returns {Object|null}
 */
export function testPatternClip(id) {
  return BUILT_IN_CLIPS.find((clip) => clip.id === id) || null;
}

/**
 * The frames of a generated pattern.
 *
 * @public
 * @param {String} pattern key into the generated patterns
 * @returns {Array|null} frames as `readIlda` gives them
 */
export function patternFrames(pattern) {
  const make = PATTERNS[pattern];
  return make ? make() : null;
}

let nextId = 1;

/** A clip id unique within a list. */
function newClipId() {
  nextId += 1;
  return `clip-${Date.now().toString(36)}-${nextId}`;
}

/**
 * One clip as stored, or null when it names nothing playable.
 *
 * @public
 * @param {Object} raw
 * @returns {Object|null} `{ id, name, kind, pattern|file, rate }`
 */
export function coerceClip(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rate = Number(raw.rate) > 0 ? Math.round(Number(raw.rate)) : null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : newClipId();
  if (raw.kind === CLIP_KINDS.PATTERN && PATTERNS[raw.pattern]) {
    return {
      id,
      name: String(raw.name || raw.pattern),
      kind: CLIP_KINDS.PATTERN,
      pattern: raw.pattern,
      rate,
    };
  }
  if (raw.kind === CLIP_KINDS.FILE && typeof raw.file === 'string'
    && raw.file.toLowerCase().endsWith(CLIP_EXTENSION) && !/[\\/]/.test(raw.file)) {
    return {
      id,
      name: String(raw.name || raw.file.slice(0, -CLIP_EXTENSION.length)),
      kind: CLIP_KINDS.FILE,
      file: raw.file,
      rate,
    };
  }
  return null;
}

/**
 * A stored clip list, cleaned: unplayable entries dropped, ids made unique.
 *
 * @public
 * @param {*} raw
 * @returns {Array<Object>}
 */
export function coerceClipList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.map(coerceClip).filter(Boolean).map((clip) => {
    if (!seen.has(clip.id)) {
      seen.add(clip.id);
      return clip;
    }
    const fresh = { ...clip, id: newClipId() };
    seen.add(fresh.id);
    return fresh;
  });
}

/**
 * A file clip for a file just added to the library.
 *
 * @public
 * @param {String} file file name
 * @returns {Object|null}
 */
export function fileClip(file) {
  return coerceClip({ kind: CLIP_KINDS.FILE, file, id: newClipId() });
}

/**
 * The clip a selection names: by id when picked by hand, or by one-based
 * position when a channel picks it. Null when the list is empty or a position
 * is past its end; the first clip when an id is not in the list.
 *
 * @public
 * @param {Array} clips
 * @param {String|Number|null} selection
 * @returns {Object|null}
 */
export function selectedClip(clips, selection) {
  if (!Array.isArray(clips) || !clips.length) return null;
  if (typeof selection === 'number') return clips[Math.round(selection) - 1] || null;
  return clips.find((clip) => clip.id === selection) || clips[0];
}
