import {
  ControlDef, EnumType, PercentType, RangeType, SwitchType,
} from './device_control';
import { ROTATIONS, orientedSample } from './video_input';

/**
 * @file What a display or projector does to the picture it receives.
 *
 * A device shows the whole of its input, and what it can do to it on the way
 * depends on the make and model: a projector's ceiling and rear modes, a
 * panel's portrait rotation, overscan, an aspect mode, digital zoom. Each is a
 * control in the device's definition -- fixed, adjustable or DMX -- and a model
 * without the feature has it fixed at the value that changes nothing.
 *
 * The mapping runs backwards, from a point of what the device shows to the
 * point of the input it shows there: turn and mirror undone, then the scale,
 * then the crop. Every step is affine, so the whole of it is one 2x3 matrix,
 * which is what the renderers are handed.
 */

/** How the cropped input is fitted to the device's picture. */
export const SCALE_MODES = ['stretch', 'fit', 'fill', 'native'];

const SCALE_LABELS = {
  stretch: 'Stretch', fit: 'Fit', fill: 'Fill', native: 'Native',
};

const ROTATION_LABELS = {
  0: '0°', 90: '90° clockwise', 180: '180°', 270: '90° anticlockwise',
};

/** Digital zoom's range, in per cent: below 100 shrinks the picture. */
const ZOOM_MIN = 25;
const ZOOM_MAX = 400;

/**
 * Digital zoom: a range that rests at 100 % rather than at either end, so a
 * new device shows its picture at its own size.
 */
class ZoomType extends RangeType {
  // eslint-disable-next-line class-methods-use-this
  initial() { return 100; }
}

/** The most a crop may take from one side, in per cent. */
const MAX_CROP = 45;

/**
 * The picture controls, in addressing order, shared by displays and
 * projectors. Absent from a definition that predates them, they come up
 * adjustable at the values that change nothing.
 *
 * @constant {Array}
 */
export const PICTURE_DEFS = [
  new ControlDef('rotation', 'Rotation', new EnumType({
    options: ROTATIONS, initial: 0, labels: ROTATION_LABELS,
  })),
  new ControlDef('mirrorH', 'Mirror H', new SwitchType({ initial: false, onLabel: 'Mirrored' })),
  new ControlDef('mirrorV', 'Mirror V', new SwitchType({ initial: false, onLabel: 'Mirrored' })),
  new ControlDef('cropLeft', 'Crop Left', new PercentType({ initial: 0, max: MAX_CROP })),
  new ControlDef('cropRight', 'Crop Right', new PercentType({ initial: 0, max: MAX_CROP })),
  new ControlDef('cropTop', 'Crop Top', new PercentType({ initial: 0, max: MAX_CROP })),
  new ControlDef('cropBottom', 'Crop Bottom', new PercentType({ initial: 0, max: MAX_CROP })),
  new ControlDef('scale', 'Scale', new EnumType({
    options: SCALE_MODES, initial: 'stretch', labels: SCALE_LABELS,
  })),
  new ControlDef('pictureZoom', 'Digital Zoom', new ZoomType({
    bounds: () => ({ min: ZOOM_MIN, max: ZOOM_MAX }), unit: '%', precision: 0,
  })),
];

/** The picture keys, for anything asking by key. */
export const PICTURE_KEYS = PICTURE_DEFS.map((def) => def.key);

/**
 * The picture values a device's settings hold, with what changes nothing for
 * any the definition does not have.
 *
 * @param {Object} [settings] DeviceSettings, or null
 * @returns {Object} `{ rotation, mirrorH, mirrorV, crop, scale, zoom }`
 */
export function pictureOf(settings) {
  const read = (key, fallback) => {
    if (!settings || !settings.value) return fallback;
    const value = settings.value(key);
    return value === undefined || value === null ? fallback : value;
  };
  const pct = (key) => Math.min(Math.max(Number(read(key, 0)) || 0, 0), MAX_CROP) / 100;
  const rotation = Number(read('rotation', 0));
  const scale = read('scale', 'stretch');
  return {
    rotation: ROTATIONS.includes(rotation) ? rotation : 0,
    mirrorH: !!read('mirrorH', false),
    mirrorV: !!read('mirrorV', false),
    crop: {
      left: pct('cropLeft'), right: pct('cropRight'), top: pct('cropTop'), bottom: pct('cropBottom'),
    },
    scale: SCALE_MODES.includes(scale) ? scale : 'stretch',
    zoom: Math.min(Math.max(Number(read('pictureZoom', 100)) || 100, ZOOM_MIN), ZOOM_MAX) / 100,
  };
}

/**
 * Where each point of what a device shows comes from in its input.
 *
 * Coordinates run 0..1 from the top-left on both sides. The result is an
 * affine map, `x = ax u + bx v + cx` and `y = ay u + by v + cy`, and the
 * rectangle of the input that holds picture: a point mapped outside it is
 * black, as the bars of a fitted picture are.
 *
 * @param {Object} picture from `pictureOf`
 * @param {Object} device `{ aspect, pixelsWide, pixelsHigh }` of what it shows
 * @param {Object} [input] `{ width, height }` in pixels, or nothing yet
 * @returns {Object} `{ map(u, v), ax, bx, cx, ay, by, cy, bounds }`, bounds as
 *   `{ x0, y0, x1, y1 }`
 */
export function pictureMapping(picture, device, input = {}) {
  const { crop } = picture;
  // A crop that would leave less than a sliver is scaled back to leave one.
  let {
    left, right, top, bottom,
  } = crop;
  const wide = left + right;
  if (wide > 0.98) { left *= 0.98 / wide; right *= 0.98 / wide; }
  const tall = top + bottom;
  if (tall > 0.98) { top *= 0.98 / tall; bottom *= 0.98 / tall; }
  const keptW = 1 - left - right;
  const keptH = 1 - top - bottom;

  // The frame the picture is fitted to: the device's own, turned with it.
  const quarter = picture.rotation === 90 || picture.rotation === 270;
  const aspect = Number(device.aspect) > 0 ? Number(device.aspect) : 16 / 9;
  const frameAspect = quarter ? 1 / aspect : aspect;
  const pixW = Math.max(Number(quarter ? device.pixelsHigh : device.pixelsWide) || 1, 1);
  const pixH = Math.max(Number(quarter ? device.pixelsWide : device.pixelsHigh) || 1, 1);

  // The cropped input, in pixels. Before a frame has arrived it is taken as
  // the frame's own shape, so nothing jumps when it does.
  const inW = (Number(input.width) > 0 ? Number(input.width) : pixW) * keptW;
  const inH = (Number(input.height) > 0 ? Number(input.height) : pixH) * keptH;
  const contentAspect = inW / inH;

  // How much of the frame the content covers along each axis.
  let sx = 1;
  let sy = 1;
  if (picture.scale === 'fit') {
    if (contentAspect > frameAspect) sy = frameAspect / contentAspect;
    else sx = contentAspect / frameAspect;
  } else if (picture.scale === 'fill') {
    if (contentAspect > frameAspect) sx = contentAspect / frameAspect;
    else sy = frameAspect / contentAspect;
  } else if (picture.scale === 'native') {
    sx = inW / pixW;
    sy = inH / pixH;
  }
  sx *= picture.zoom;
  sy *= picture.zoom;

  const map = (u, v) => {
    const o = orientedSample(u, v, picture);
    const x = (o.x - 0.5) / sx + 0.5;
    const y = (o.y - 0.5) / sy + 0.5;
    return { x: left + x * keptW, y: top + y * keptH };
  };
  const p00 = map(0, 0);
  const p10 = map(1, 0);
  const p01 = map(0, 1);
  return {
    map,
    ax: p10.x - p00.x,
    bx: p01.x - p00.x,
    cx: p00.x,
    ay: p10.y - p00.y,
    by: p01.y - p00.y,
    cy: p00.y,
    bounds: {
      x0: left, y0: top, x1: 1 - right, y1: 1 - bottom,
    },
  };
}
