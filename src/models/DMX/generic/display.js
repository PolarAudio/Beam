/**
 * @file Generic display: a flat surface showing a video connector.
 *
 * A screen, a video wall, a monitor on a desk. Built here from a handful of
 * numbers for the same reason a projector is -- there are thousands of them and
 * no library will carry them all -- and OFL-shaped for the same reason too, so
 * `Fixture` reads it through the path a library profile takes. Everything OFL
 * cannot express lives under `asls.display`.
 *
 * **This is not an LED panel, and the difference is the data path.** A
 * `led_bar` with rows is driven pixel by pixel over DMX: every emitter has an
 * address and the shader reads the DMX texture. A display is fed a *video
 * signal* -- it shows a connector, the same way a screen shows whatever is
 * plugged into it. The same physical object is sometimes sold as either, and
 * which one to place depends entirely on how it is being fed.
 *
 * It is also the simplest possible consumer of the video path, which is why it
 * is worth having early: the picture lands on the display's own surface, with
 * no projection maths and no occlusion in the way. If an image looks wrong here
 * the fault is in the connector or the feed; if it looks wrong only on a
 * projector, the fault is in the projection.
 */

import { COMMON_CONTROLS } from '../device_settings';
import { ControlSet, orderOf, labelsOf } from '../device_control';

/** Radians to degrees. The curve is authored in degrees and built in radians. */
const DEG = 180 / Math.PI;

/**
 * The parameters a display carries.
 *
 * The same three a projector shares, and no more: a screen has no lens to zoom
 * or shift. Most displays have no DMX at all -- a shop monitor certainly does
 * not -- so how each of these is decided is a choice made when the fixture is
 * defined, not a consequence of the geometry. See `device_control.js`.
 *
 * Declared in the order channels are laid out in, which is fixed here rather
 * than following the order someone filled the rows in, so that two displays
 * with the same parameters always address alike.
 *
 * @constant {Array}
 */
export const CONTROL_DEFS = [
  COMMON_CONTROLS.dimmer(),
  // Blanking a screen is the same act as closing a dowser: the picture is
  // there or it is not, so it reads as a shutter rather than a dimmer at nought.
  COMMON_CONTROLS.shutter('Blank', 'Showing'),
  COMMON_CONTROLS.source('Source Select', 'connectors'),
];

/**
 * The keys, for anything that still asks by key rather than by definition.
 *
 * @constant {Object}
 */
export const DISPLAY_CHANNELS = {
  DIMMER: 'dimmer',
  SHUTTER: 'shutter',
  SOURCE: 'source',
};

/** Derived, so a parameter cannot be in one of these and missing from another. */
export const CHANNEL_ORDER = orderOf(CONTROL_DEFS);

/** What each channel is called on a patch sheet. */
export const CHANNEL_LABELS = labelsOf(CONTROL_DEFS);

/**
 * A 55-inch 16:9 panel: the screen most people picture, and a size that reads
 * correctly beside a person in the scene.
 *
 * Lengths are metres, matching the rest of the scene.
 *
 * @constant {Object}
 */
export const DEFAULT_DISPLAY_PARAMS = {
  /** The picture itself, edge to edge of what lights up. */
  width: 1.21,
  height: 0.68,
  /**
   * Native resolution.
   *
   * Nothing samples it yet -- the connector's slice is stretched to the panel
   * -- but it is what the create dialog compares the panel's shape against, and
   * a video wall's pixel pitch is the number people quote.
   */
  pixelsWide: 1920,
  pixelsHigh: 1080,
  /** The dead border around the picture, and how deep the box is. */
  bezel: 0.02,
  depth: 0.06,
  /** The bezel and casing's colour, `#rrggbb`, part of the definition. */
  bodyColor: '#35383c',
  /**
   * Peak brightness in nits.
   *
   * Nothing reads it yet; the renderer will. It is the display's answer to a
   * projector's lumens, and the reason an outdoor wall reads in daylight where
   * a monitor does not.
   */
  nits: 600,
  /**
   * How wide the lit part of each pixel is, as a fraction of the pitch -- 0 to
   * 1, linear, not an area.
   *
   * A ratio rather than millimetres so that it survives resizing: an emitter
   * given in millimetres stays that size when the panel grows, and a 0.6 mm
   * emitter left in a 10 mm pitch is a wall that is 99.7% dark ground. A real
   * panel is mostly dark ground all the same -- a 1.5 mm emitter in a 2.6 mm
   * cell is a typical fine-pitch wall, and drawing pixels edge to edge is why a
   * naive LED wall looks like plastic sheet.
   *
   * `null` means the emitter a panel of this pitch is most likely built with;
   * see {@link likelyEmitter}. At 1 the pixels meet and the grid disappears,
   * which is right for an LCD.
   */
  emitterFill: null,
  /**
   * How far the panel bends, in degrees: 0 flat, positive convex, negative
   * concave.
   *
   * **An angle, not a radius.** Both describe the same arc -- the width is
   * fixed, so `radius = width / angle` -- but only one of them is a number
   * anybody has in mind. You know you want a quarter turn around a pillar or a
   * gentle ten degrees of bow; working out which radius that is for this
   * particular panel is arithmetic in the way of the idea. It also survives
   * resizing sensibly: a 90-degree panel made wider is still a quarter turn,
   * where a fixed radius would quietly become a half.
   *
   * Signed, because the direction is one property of one surface and the sign
   * is the convention a lens already uses. Convex bulges towards the room --
   * the outside of a pillar or a tower; concave wraps around it -- a backdrop
   * or a cove.
   *
   * The width is the arc *along* the screen, so bending a panel does not
   * stretch it: a 4 m wall bent through 90 degrees is still 4 m of pixels, it
   * simply spans less room.
   */
  curveAngle: 0,
  /**
   * Which channels this model actually has.
   *
   * **None by default**, because most displays have no DMX socket -- and
   * because a declared channel *owns* its row, so shipping a Source Select by
   * default handed the connector to a console nobody had patched and greyed out
   * the one control a new display most needs.
   */
  channels: [],
};

/**
 * The shape of the lit area, as width over height.
 *
 * Taken from the physical size rather than the resolution: a video wall is
 * often built from tiles whose pixel grid does not match its outline, and it is
 * the outline the picture has to fill.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {Number}
 */
export function panelAspect(params) {
  const width = Number(params.width) || DEFAULT_DISPLAY_PARAMS.width;
  const height = Number(params.height) || DEFAULT_DISPLAY_PARAMS.height;
  return width / height;
}

/**
 * The pixel grid's own shape, for comparison with the panel's.
 *
 * The two disagreeing is not an error -- plenty of walls are built that way --
 * but it is worth showing, because a mismatch is what stretches a picture.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {Number}
 */
export function pixelAspect(params) {
  const wide = Number(params.pixelsWide) || DEFAULT_DISPLAY_PARAMS.pixelsWide;
  const high = Number(params.pixelsHigh) || DEFAULT_DISPLAY_PARAMS.pixelsHigh;
  return wide / high;
}

/**
 * Millimetres per pixel across the panel -- the number a video wall is sold by.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {Number}
 */
export function pixelPitch(params) {
  const wide = Number(params.pixelsWide) || DEFAULT_DISPLAY_PARAMS.pixelsWide;
  const width = Number(params.width) || DEFAULT_DISPLAY_PARAMS.width;
  return wide > 0 ? (width * 1000) / wide : 0;
}

/**
 * Millimetres per pixel on each axis.
 *
 * The two differ whenever the panel's shape and its pixel grid disagree, and
 * then the cells are oblongs: a square emitter has to fit the narrow side and
 * leaves the most dark ground along the long one.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {Object} `{ x, y, finer, coarser }`
 */
export function cellPitch(params) {
  const high = Number(params.pixelsHigh) || DEFAULT_DISPLAY_PARAMS.pixelsHigh;
  const height = Number(params.height) || DEFAULT_DISPLAY_PARAMS.height;
  const x = pixelPitch(params);
  const y = high > 0 ? (height * 1000) / high : 0;
  return {
    x, y, finer: Math.min(x, y), coarser: Math.max(x, y),
  };
}

/**
 * The pitch in words: one number for square cells, both when they are not.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {String} e.g. `10.42 mm` or `10.42 × 11.11 mm`
 */
export function pitchText(params) {
  const { x, y } = cellPitch(params);
  return x.toFixed(2) === y.toFixed(2) ? `${x.toFixed(2)} mm` : `${x.toFixed(2)} × ${y.toFixed(2)} mm`;
}

/**
 * The LED packages video walls are built with, each at the pitch it is
 * typically used for.
 *
 * `size` is the package's side in millimetres, which is what its name says:
 * an SMD 2121 is 2.1 mm square. Real walls pair them this way because the
 * package is chosen for the pitch -- nobody puts a 3535 in a 2.5 mm cell or a
 * 0808 in a 10 mm one.
 *
 * @constant {Array}
 */
export const EMITTER_PACKAGES = [
  { name: 'SMD 0808', size: 0.8, pitch: 1.2 },
  { name: 'SMD 1010', size: 1.0, pitch: 1.5 },
  { name: 'SMD 1515', size: 1.5, pitch: 2.5 },
  { name: 'SMD 2121', size: 2.1, pitch: 3.9 },
  { name: 'SMD 2727', size: 2.7, pitch: 5 },
  { name: 'SMD 3535', size: 3.5, pitch: 8 },
  { name: 'SMD 5050', size: 5.0, pitch: 16 },
];

/**
 * Below this pitch, in millimetres, a panel is taken to be an LCD or OLED:
 * finer than any LED package, and a screen whose pixels meet.
 *
 * @constant {Number}
 */
export const LCD_PITCH = 0.8;

/**
 * An emitter narrower than this fraction of the pitch is not something panels
 * are built with. Real walls run from about a third to a half.
 *
 * @constant {Number}
 */
export const UNUSUAL_EMITTER_FILL = 0.25;

/**
 * The emitter a panel of this pitch is most likely built with.
 *
 * The nearest package by ratio rather than by difference, because pitches are
 * spaced geometrically: 10 mm is nearer 8 than 16 in the way that matters.
 *
 * @public
 * @param {Number} pitch millimetres
 * @returns {Object} `{ name, size, fill }` -- size in millimetres, fill 0-1
 */
export function likelyEmitter(pitch) {
  if (!(pitch >= LCD_PITCH)) return { name: 'LCD', size: pitch, fill: 1 };
  let best = EMITTER_PACKAGES[0];
  EMITTER_PACKAGES.forEach((pkg) => {
    if (Math.abs(Math.log(pitch / pkg.pitch)) < Math.abs(Math.log(pitch / best.pitch))) best = pkg;
  });
  return { name: best.name, size: best.size, fill: Math.min(best.size / pitch, 1) };
}

/**
 * How wide the lit part of each pixel is, in metres.
 *
 * Read from the fraction when a profile has one, from millimetres when it was
 * saved that way, and from the likely package when it says neither.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {Number}
 */
export function emitterSize(params) {
  const pitch = cellPitch(params).finer / 1000;
  if (typeof params.emitterFill === 'number') return Math.max(params.emitterFill, 0) * pitch;
  if (Number(params.pixelSize) > 0) return Number(params.pixelSize);
  if (typeof params.pixelFill === 'number') return Math.max(params.pixelFill, 0) * pitch;
  return likelyEmitter(pitch * 1000).fill * pitch;
}

/**
 * The emitter's width as a fraction of the finer pitch, 0-1: the number the
 * creator asks for.
 *
 * The finer pitch because that is the side the emitter has to fit: at 100% a
 * square emitter fills the narrow side of an oblong cell, and no more.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {Number}
 */
export function emitterFill(params) {
  const pitch = cellPitch(params).finer / 1000;
  return pitch > 0 ? Math.min(emitterSize(params) / pitch, 1) : 1;
}

/**
 * Why a panel's emitter is not one anybody builds with, or `null` when it is.
 *
 * Judged on the coarser pitch, the axis with the most dark ground: an
 * emitter that fits the narrow side of an oblong cell can still be a speck
 * along the long one.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {String|null}
 */
export function unusualEmitter(params) {
  const pitch = cellPitch(params);
  const fill = pitch.coarser > 0 ? (emitterSize(params) * 1000) / pitch.coarser : 1;
  if (fill >= UNUSUAL_EMITTER_FILL) return null;
  const likely = likelyEmitter(pitch.finer);
  const typical = Math.min(likely.size / pitch.coarser, 1);
  // Cells so oblong that even the package the narrow side calls for is a
  // speck along the long one: no emitter choice fixes that, the shape does.
  if (typical < UNUSUAL_EMITTER_FILL) {
    return `Unusual panel: each pixel is ${pitch.x.toFixed(1)} × ${pitch.y.toFixed(1)} mm, so an`
      + ` emitter that fits the narrow side lights only ${Math.round(fill * 100)}% of the long one.`
      + ' The panel\'s shape and its pixel grid disagree.';
  }
  let axis = '';
  if (pitch.x !== pitch.y) axis = pitch.x > pitch.y ? ' horizontal' : ' vertical';
  return `Unusual panel: the emitter is only ${Math.round(fill * 100)}% of the`
    + ` ${pitch.coarser.toFixed(1)} mm${axis} pitch. LED walls at this pitch use about`
    + ` ${Math.round(typical * 100)}% (${likely.name}).`;
}

/**
 * How much of each cell lights up, per axis, 0-1.
 *
 * Per axis rather than one number because the cells are only square when the
 * panel's shape and its pixel grid agree, and plenty of walls are built where
 * they do not. A square emitter in an oblong cell fills more of one axis than
 * the other, and saying so is the honest way to draw it.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {Object} `{ x, y }`, each 0-1
 */
export function pixelFill(params) {
  const wide = Number(params.pixelsWide) || DEFAULT_DISPLAY_PARAMS.pixelsWide;
  const high = Number(params.pixelsHigh) || DEFAULT_DISPLAY_PARAMS.pixelsHigh;
  const width = Number(params.width) || DEFAULT_DISPLAY_PARAMS.width;
  const height = Number(params.height) || DEFAULT_DISPLAY_PARAMS.height;
  // A profile carrying only the old ratio drew it on both axes alike.
  if (params.emitterFill == null && params.pixelSize === undefined
    && typeof params.pixelFill === 'number') {
    const legacy = Math.min(Math.max(params.pixelFill, 0), 1);
    return { x: legacy, y: legacy };
  }
  const size = emitterSize(params);
  return {
    x: Math.min(size / (width / wide), 1),
    y: Math.min(size / (height / high), 1),
  };
}

/**
 * The curve a display is bent on, resolved and made safe to build from.
 *
 * Given in degrees and returned as a radius and an arc in radians, which is
 * what the geometry wants. The width is arc length, so the two are the same
 * fact said twice: `radius = width / angle`.
 *
 * Capped at half a turn: past that a panel starts closing on itself and the far
 * edges face away from anyone looking at it, which is not a display any more.
 *
 * @public
 * @param {Object} params display parameters
 * @param {Number} [outerWidth] the width being bent, defaults to the picture's
 * @returns {Object} `{ radius, sign, angle }` -- radius 0 when flat
 */
export function displayCurve(params, outerWidth) {
  const width = Number(outerWidth) || Number(params.width) || DEFAULT_DISPLAY_PARAMS.width;

  let degrees = Number(params.curveAngle) || 0;
  // A panel that states its curve as a radius: the radius and the width give
  // the angle back exactly, so it opens curved the way it was saved rather
  // than flat.
  if (!degrees && Number(params.curveRadius)) {
    const legacy = Number(params.curveRadius);
    degrees = ((width / Math.abs(legacy)) * DEG) * (legacy > 0 ? 1 : -1);
  }
  if (!degrees) return { radius: 0, sign: 0, angle: 0 };

  // Capped at half a turn: past that the far edges face away from anyone
  // looking at it, which is not a display any more.
  const angle = Math.min(Math.abs(degrees) / DEG, Math.PI);
  return { radius: width / angle, sign: degrees > 0 ? 1 : -1, angle };
}

/**
 * The channels this display declares, in OFL's vocabulary.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {Object} `{ availableChannels, modes }`
 */
export function displayChannels(params) {
  return ControlSet.fromProfile(CONTROL_DEFS, params).buildChannels();
}

/**
 * Whether a profile was made here.
 *
 * Asked of the geometry rather than of a category, for the same reason
 * `prepare3DModelInstance` asks it of `asls.bar`: a category string says
 * nothing about what the thing actually is, and a display's is 'Other'.
 *
 * @public
 * @param {Object} profile
 * @returns {Boolean}
 */
export function isDisplayProfile(profile) {
  return !!(profile && profile.asls && profile.asls.display);
}

/**
 * Builds an OFL-shaped profile for a display.
 *
 * @public
 * @param {Object} [overrides] parameters replacing the defaults
 * @returns {Object} a profile the fixture parser can read
 */
export function buildDisplayProfile(overrides = {}) {
  const params = { ...DEFAULT_DISPLAY_PARAMS, ...overrides };
  // Stored resolved, so a definition keeps the emitter it was made with even
  // if the package table changes.
  if (params.emitterFill == null) params.emitterFill = emitterFill(params);
  const { availableChannels, modes } = displayChannels(params);
  const bezel = Number(params.bezel) || 0;

  return {
    name: `Display ${params.pixelsWide}x${params.pixelsHigh}`,
    // OFL's catch-all. It has no display category, and inventing one would put
    // a word in the fixture list that no library profile can match.
    categories: ['Other'],
    meta: { generated: true },
    physical: {
      // OFL's order is width, height, depth, in millimetres -- the whole box,
      // so the bezel counts on both sides.
      dimensions: [
        (params.width + bezel * 2) * 1000,
        (params.height + bezel * 2) * 1000,
        params.depth * 1000,
      ],
      bulb: { type: 'LED' },
    },
    availableChannels,
    modes,
    asls: { display: params },
  };
}

export default {
  CONTROL_DEFS,
  DISPLAY_CHANNELS,
  CHANNEL_ORDER,
  CHANNEL_LABELS,
  DEFAULT_DISPLAY_PARAMS,
  buildDisplayProfile,
  displayChannels,
  isDisplayProfile,
  panelAspect,
  pixelAspect,
  pixelPitch,
  cellPitch,
  pitchText,
  pixelFill,
  EMITTER_PACKAGES,
  LCD_PITCH,
  UNUSUAL_EMITTER_FILL,
  likelyEmitter,
  emitterSize,
  emitterFill,
  unusualEmitter,
  displayCurve,
};
