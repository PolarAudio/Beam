import { walkGeometry } from './gdtf_reader';
import { laserByChannels } from './fixture_parts';
import {
  nameOf, namesNothing, numberInName, laserModeFromName, percentInName, namesScalePoint,
  NAMED_RATE_ENDS, namesFalling, namesStop, namesOriginal, namesAnticlockwise,
  namesClockwise, degreesInName,
} from './name_rules';
import { DEFAULT_LASER_PARAMS, CONTROL_DEFS } from '../generic/laser';
import { TEST_PATTERN_IDS, TEST_PATTERN_OFF } from '../laser_clips';
import { valueOnCurve } from '../device_settings';

/**
 * @file A GDTF laser read as the parameters Beam's laser takes, so a laser
 * from a file is drawn by the same renderer as one made in Beam
 * (`generic/laser.js`).
 *
 * The optics come from the Laser geometry: OutputStrength in watts,
 * BeamDiameter in metres, divergence in milliradians and the scan angles in
 * degrees. The body is the root geometry's Model, and the beam starts where
 * the Laser geometry sits in it. An RGB laser may instead be one Laser
 * geometry per diode, each SingleWaveLength with its wavelength in Color and
 * its own OutputStrength: those become the laser's lines and their watts add
 * up to its power; the optics and the aperture are the first one's.
 *
 * The controls come from the mode's channels, one attribute each. A channel
 * with an offset is driven over DMX. A virtual channel, one with no offset,
 * is set by hand: Fixed when its only function's physical range is a single
 * value, Adjustable otherwise, its default the starting value.
 *
 * Most laser files have no Laser geometry; they are known by their channels
 * (see `laserByChannels`) and take the default optics and the box body.
 * Their makers pick the content each in their own way: a cue, a media
 * content slot, an object slot or a gobo for the clip, a mode channel, a
 * test cue. Each such channel's ranges are the clips, modes or patterns.
 * A page, folder or bank channel beside the clip's makes one clip number:
 * (page - 1) times the cues a page holds, plus the cue.
 */

/** The GDTF attributes that carry each laser control, the first a mode has wins. */
export const LASER_ATTRIBUTES = {
  dimmer: 'Dimmer',
  shutter: 'Shutter1',
  red: 'ColorAdd_R',
  green: 'ColorAdd_G',
  blue: 'ColorAdd_B',
  // The cue's size; a zone's limit on it is the size limit below.
  xScale: ['LaserScaleX', 'LaserXSize', 'X_Size', 'Scale_X'],
  yScale: ['LaserScaleY', 'LaserYSize', 'Y_Size', 'Scale_Y'],
  xPos: ['LaserPositionX', 'XPosition', 'Pos_X'],
  yPos: ['LaserPositionY', 'YPosition', 'Pos_Y'],
  mirrorX: 'LaserMirrorX',
  mirrorY: 'LaserMirrorY',
  clip: ['LaserCue', 'MediaContent1', 'ObjectSlot', 'Gobo1', 'PatternSelect'],
  mode: 'Mode',
  testPattern: 'TestCue',
  scanRate: ['ScanRate', 'Scan_Rate'],
  speed: ['LaserSpeed', 'PlaySpeed'],
  // A zone's limits, multiplying the cue's dimmer and size.
  dimmerLimit: ['MaximumDimmer', 'Safety Zone Intensity'],
  xSizeLimit: ['MaximumXSize', 'MaxSize_X', 'Global X Size'],
  ySizeLimit: ['MaximumYSize', 'MaxSize_Y'],
  // A size on both axes at once.
  zoom: ['Zoom', 'Scale_XYZ'],
  // The zone's angle and the cue's, which add, and a spin on top.
  zoneRotation: ['ZIndexRotation', 'Master_Rot_Z'],
  rotation: ['LaserZRotate', 'Rot_Z', 'Z_Index', 'Rotation', 'Gobo1Pos'],
  spin: ['ZContinuousRotation', 'Z_Rot', 'Spin', 'Gobo1PosRotate'],
  // The cue's place in the zone. A file names it Pan and Tilt, GDTF having
  // no laser position; on a body with an axis they move the body instead.
  cueX: 'Pan',
  cueY: 'Tilt',
};

/** The controls a body on an axis reads as its own movement, not the figure's. */
const AXIS_CONTROLS = ['cueX', 'cueY'];

/** A physical range in percent: a range within 0-1 is a fraction. */
const percentOf = (from, to) => {
  const f = Math.max(Math.abs(from), Math.abs(to)) <= 1 ? 100 : 1;
  return [from * f, to * f];
};

/**
 * A percentage along a channel's one function: through the percentages its
 * sets name ("25%", "200%"), a set named Default at 100 %, Min and Max at the
 * ends of `range`; or, with no named sets, along the physical range. One
 * set over the whole function describes it, and may say the range falls.
 * Null when neither gives two values.
 */
function percentCurve(f, top, range) {
  const physical = (falling = false) => {
    if (f.physicalFrom === f.physicalTo) return null;
    const values = percentOf(f.physicalFrom, f.physicalTo);
    return { at: [f.dmxFrom, top], values: falling ? values.reverse() : values };
  };
  const lone = f.sets.length === 1 && f.sets[0].dmxFrom === f.dmxFrom ? f.sets[0] : null;
  if (lone && percentInName(lone.name) === null && !namesScalePoint(lone.name)) {
    return physical(namesFalling(lone.name));
  }
  const at = [];
  const values = [];
  f.sets.forEach((set, i) => {
    const next = f.sets[i + 1] ? f.sets[i + 1].dmxFrom - 1 : top;
    const point = namesScalePoint(set.name);
    const percent = percentInName(set.name);
    // A named value is a point at its range's start; Default is a setting
    // rather than a value, and holds across its range.
    if (percent !== null) {
      at.push(set.dmxFrom);
      values.push(percent);
    } else if (point === 'default') {
      at.push(set.dmxFrom, next);
      values.push(100, 100);
    } else if (point === 'min' || point === 'max') {
      at.push(set.dmxFrom);
      values.push(point === 'min' ? range.min : range.max);
    }
  });
  // Sets named for something else ("Scan speed", "Point speed") are a
  // choice, not a scale.
  const named = f.sets.some((set) => String(set.name || '').trim());
  if (!named) return physical();
  return new Set(values).size < 2 ? null : { at, values };
}

/** A percentage of full, 0 to 100 %. */
const ofFull = (f, top) => percentCurve(f, top, { min: 0, max: 100 });

/**
 * The controls read along a channel's one function, each as `{ at, values }`:
 * raw values and the control's value at each, straight between them. A scale
 * or limit is a percentage as `percentCurve` reads it, a position -100 to 100 % across
 * the range in the file's direction, a rate or speed a percentage as
 * `percentCurve` reads it.
 */
const CURVE_VALUES = {
  xScale: ofFull,
  dimmerLimit: ofFull,
  xSizeLimit: ofFull,
  xPos: (f, top) => (f.physicalFrom === f.physicalTo ? null : {
    at: [f.dmxFrom, top],
    values: f.physicalFrom <= f.physicalTo ? [-100, 100] : [100, -100],
  }),
  scanRate: (f, top) => percentCurve(f, top, NAMED_RATE_ENDS.scanRate),
  speed: (f, top) => percentCurve(f, top, NAMED_RATE_ENDS.speed),
};
CURVE_VALUES.yScale = ofFull;
CURVE_VALUES.ySizeLimit = ofFull;
/**
 * A zoom, 100 % being the figure's own size: 0-100 % as a size is read, but
 * ranges naming numbers are changes from 100 % when the file's default sits
 * on the one named 0.
 */
CURVE_VALUES.zoom = (f, top) => {
  const curve = ofFull(f, top);
  if (!curve || !f.sets.some((set) => percentInName(set.name) !== null)) return curve;
  if (valueOnCurve(curve, f.default) !== 0) return curve;
  return { at: curve.at, values: curve.values.map((v) => v + 100) };
};

/**
 * An angle in degrees, clockwise positive: along a physical range in
 * degrees, else through the degrees the range names give. Null for a channel
 * that states neither, or whose ranges name a choice rather than an angle.
 */
function angleCurve(f, top) {
  const named = f.sets.filter((set) => String(set.name || '').trim());
  if (named.length && named.every((set) => degreesInName(set.name) === null)) return null;
  const placeholder = f.physicalFrom === 0 && f.physicalTo === 1;
  if (f.physicalFrom !== f.physicalTo && !placeholder) {
    return { at: [f.dmxFrom, top], values: [f.physicalFrom, f.physicalTo] };
  }
  const at = [];
  const values = [];
  named.forEach((set) => {
    const degrees = degreesInName(set.name);
    if (degrees !== null) {
      at.push(set.dmxFrom);
      values.push(degrees);
    }
  });
  return new Set(values).size >= 2 ? { at, values } : null;
}

/**
 * A spin, -100 to 100 % of full speed, clockwise positive. Still across a
 * range named Stop; full at the ends of the
 * function, the side the names call anticlockwise negative. A first range
 * named Reset or Original puts the figure back at its own angle: `reset`,
 * the last raw value it covers. Null for a channel with no one stop.
 */
function spinCurve(f, top) {
  const { sets } = f;
  const next = (i) => (sets[i + 1] ? sets[i + 1].dmxFrom - 1 : top);
  const stops = sets.map((set, i) => (namesStop(set.name) ? i : -1)).filter((i) => i >= 0);
  if (stops.length !== 1) return null;
  const low = sets[stops[0]].dmxFrom;
  const high = next(stops[0]);
  const reset = sets.length > 1 && namesOriginal(sets[0].name) ? next(0) : null;
  const start = reset === null ? f.dmxFrom : reset + 1;
  // The low side turns anticlockwise unless its names say clockwise.
  const lowSide = sets.filter((set) => set.dmxFrom >= start && set.dmxFrom < low);
  const sign = lowSide.some((set) => namesClockwise(set.name))
    && !lowSide.some((set) => namesAnticlockwise(set.name)) ? 1 : -1;
  const at = [start, low, high, top];
  const values = [100 * sign, 0, 0, -100 * sign];
  if (reset !== null) {
    at.unshift(f.dmxFrom, reset);
    values.unshift(0, 0);
    return { at, values, reset };
  }
  return { at, values };
}

CURVE_VALUES.zoneRotation = angleCurve;
CURVE_VALUES.rotation = angleCurve;
CURVE_VALUES.spin = spinCurve;
CURVE_VALUES.yPos = CURVE_VALUES.xPos;
CURVE_VALUES.cueX = CURVE_VALUES.xPos;
CURVE_VALUES.cueY = CURVE_VALUES.xPos;

/**
 * A channel's single function, or null when it has several: a channel whose
 * ranges do different things is not one size or position.
 */
function onlyFunction(channel) {
  const functions = channel.logicalChannels.flatMap((l) => l.functions);
  return functions.length === 1 ? functions[0] : null;
}

/** The attributes that page through a laser's clips, the first a mode has wins. */
const PAGE_ATTRIBUTES = ['LaserPage', 'MediaFolder1', 'ObjectBank'];

/**
 * Which clip or pattern each range selects, 0 for none: the number its name
 * ends in when every named range has a distinct one or names nothing ("Cue
 * 0", "Wheel Slot 1"), an unnamed range selecting nothing; else its position
 * counted from the first that selects something.
 *
 * @param {Array} ranges `{ name }`, in channel order
 * @returns {Array} one number per range
 */
function selections(ranges) {
  const numbers = ranges.map((r) => numberInName(r.name));
  const given = numbers.filter((n) => n !== null);
  const usable = new Set(given).size === given.length
    && ranges.every((r, i) => numbers[i] !== null || namesNothing(r.name) || !r.name.trim());
  if (usable) return numbers.map((n) => n || 0);
  const skip = namesNothing(ranges[0].name) ? 0 : 1;
  return ranges.map((r, i) => i + skip);
}

/**
 * The value each range of a channel gives, for the controls a file splits
 * into named ranges rather than a scale. Null where the ranges say nothing a
 * control can read: a clip or pattern channel with one range that selects
 * something is that range's own count, which its raw value gives.
 */
const RANGE_VALUES = {
  clip: (ranges) => {
    const n = selections(ranges);
    return n.filter((v) => v > 0).length < 2 ? null : n.map((v) => v || null);
  },
  mode: (ranges) => ranges.map((r) => laserModeFromName(r.name)),
  testPattern: (ranges) => {
    const n = selections(ranges);
    return n.filter((v) => v > 0).length < 2
      ? null : n.map((v) => TEST_PATTERN_IDS[v] || TEST_PATTERN_OFF);
  },
};

/**
 * A channel's ranges as a control reads them: where each starts, in the
 * channel's resolution, and the value it gives. A function's sets are its
 * ranges; a function with none is one range. Functions that answer for a
 * state of another channel, a bank, are read for the first state only.
 *
 * @param {Object} channel a mode channel from the reader
 * @param {Function} valuesOf (ranges) => one value per range, or null
 * @returns {Object|null} `{ from, values }`, null for a channel with one range
 */
function rangesOf(channel, valuesOf) {
  const { functions } = channel.logicalChannels[0];
  const state = (f) => (f.modeMaster ? `${f.modeMaster.join('.')}|${f.modeFrom}` : '');
  const ranges = functions
    .filter((f) => state(f) === state(functions[0]))
    .flatMap((f) => (f.sets.length
      ? f.sets.map((set) => ({ dmxFrom: set.dmxFrom, name: String(set.name || '') }))
      : [{ dmxFrom: f.dmxFrom, name: nameOf(f, null) }]))
    .sort((a, b) => a.dmxFrom - b.dmxFrom);
  if (ranges.length < 2) return null;
  const values = valuesOf(ranges);
  return values ? { from: ranges.map((r) => r.dmxFrom), values } : null;
}

/**
 * The page channel beside a driven clip channel, as `LaserSettings` reads it.
 *
 * @param {Object} mode
 * @param {Object} clip the clip control, `{ channel, bits }`
 * @param {Object|null} clipSteps the clip channel's ranges
 * @returns {Object|null} `{ channel, bits, steps, perPage }`: `steps` the
 *   page each range names, null when the raw value is the page; `perPage`
 *   the highest cue the clip channel names
 */
function clipPageOf(mode, clip, clipSteps) {
  const channel = PAGE_ATTRIBUTES.map((attribute) => mode && mode.channels.find(
    (c) => c.offsets && c.logicalChannels.some((l) => l.attribute === attribute),
  )).find(Boolean);
  if (!channel) return null;
  const pages = rangesOf(channel, (ranges) => {
    const n = selections(ranges);
    return n.filter((v) => v > 0).length < 2 ? null : n;
  });
  const perPage = clipSteps
    ? Math.max(...clipSteps.values.map((v) => v || 0))
    : 2 ** clip.bits - 1;
  return {
    channel: channel.offsets[0], bits: channel.offsets.length * 8, steps: pages, perPage,
  };
}

/** The highest channel a mode addresses. */
function footprintOf(mode) {
  return (mode ? mode.channels : []).reduce(
    (max, c) => Math.max(max, ...(c.offsets || [0])),
    0,
  );
}

/**
 * The Laser geometries in a fixture type, all under the root geometry of the
 * first, and that root.
 *
 * @param {Object} type a GDTF fixture type
 * @returns {Object|null} `{ root, laser, lasers }`, `laser` the first
 */
export function laserGeometry(type) {
  let found = null;
  (type.geometries || []).some((root) => {
    const lasers = [];
    walkGeometry(root, (g) => { if (g.type === 'Laser') lasers.push(g); });
    if (lasers.length) found = { root, laser: lasers[0], lasers };
    return !!found;
  });
  return found;
}

const number = (text, fallback) => {
  const v = parseFloat(text);
  return Number.isFinite(v) ? v : fallback;
};

/**
 * A control as a mode's channel states it.
 *
 * @param {Object} channel a mode channel from the reader
 * @param {Object} def the control's ControlDef
 * @returns {Object} `{ mode, value, channel, bits }`
 */
function controlOf(channel, def) {
  const f = channel.logicalChannels[0].functions[0];
  if (channel.offsets) {
    return {
      mode: 'dmx', value: def.type.initial({}), channel: channel.offsets[0], bits: channel.offsets.length * 8,
    };
  }
  if (f.physicalFrom === f.physicalTo) {
    return { mode: 'fixed', value: def.type.coerce(f.physicalFrom, {}) };
  }
  const top = 256 ** channel.bytes - 1;
  return { mode: 'adjustable', value: def.type.fromLevel((f.default || 0) / top, {}) };
}

/**
 * Each byte of a mode's footprint by the attribute its channel carries: the
 * first byte by the attribute, further bytes numbered from 2, a repeated
 * attribute numbered from its second channel. Null where no channel sits.
 *
 * @param {Object} mode
 * @returns {Array}
 */
function channelNamesOf(mode) {
  const names = new Array(footprintOf(mode)).fill(null);
  const used = {};
  (mode ? mode.channels : []).forEach((channel) => {
    if (!channel.offsets) return;
    const attribute = channel.logicalChannels[0].attribute || 'Channel';
    used[attribute] = (used[attribute] || 0) + 1;
    const name = used[attribute] > 1 ? `${attribute} ${used[attribute]}` : attribute;
    channel.offsets.forEach((offset, i) => {
      names[offset - 1] = i ? `${name} ${i + 1}` : name;
    });
  });
  return names;
}

/**
 * A GDTF laser as Beam's laser parameters.
 *
 * @public
 * @param {Object} type a GDTF fixture type
 * @param {Object} [mode] the mode in use; the first when absent
 * @returns {Object|null} laser parameters, null for a type that is not a laser
 */
export function laserParams(type, mode = type.modes[0]) {
  const found = laserGeometry(type);
  if (!found && !laserByChannels(type)) return null;
  const { root, laser, lasers } = found || { root: null, laser: null, lasers: [] };
  const a = (laser && laser.attrs) || {};
  // One Laser geometry per diode: each a wavelength and its watts.
  const lines = lasers
    .filter((g) => (g.attrs || {}).ColorType === 'SingleWaveLength')
    .map((g) => ({ nm: number(g.attrs.Color, 0), watts: number(g.attrs.OutputStrength, 0) }))
    .filter((l) => l.nm > 0);
  const body = root && root.model ? type.index.model.get(root.model) : null;
  const apertureModel = laser && laser.model ? type.index.model.get(laser.model) : null;
  // The Laser geometry's place in the body, in metres: the last column of the
  // row-major matrix the reader keeps flat.
  const p = (laser && laser.position) || [];
  const at = (row) => Number(p[row * 4 + 3]) || 0;
  const controls = {};
  const dmxSteps = {};
  const dmxCurves = {};
  const axis = (g) => g.type === 'Axis' || g.children.some(axis);
  const onAxis = (type.geometries || []).some(axis);
  CONTROL_DEFS.forEach((def) => {
    if (onAxis && AXIS_CONTROLS.includes(def.key)) return;
    const attributes = [].concat(LASER_ATTRIBUTES[def.key] || []);
    const curveOf = CURVE_VALUES[def.key];
    // A curved control's channel is read only when it gives a curve.
    const curves = new Map();
    const channel = attributes.map((attribute) => mode && mode.channels.find((c) => {
      if (!c.logicalChannels.some((l) => l.attribute === attribute)) return false;
      if (!curveOf) return true;
      const f = onlyFunction(c);
      const curve = f && c.offsets ? curveOf(f, 256 ** c.offsets.length - 1) : null;
      if (curve) curves.set(c, curve);
      return !!curve || (!!f && !c.offsets);
    })).find(Boolean);
    if (!channel) return;
    controls[def.key] = controlOf(channel, def);
    if (curves.has(channel)) dmxCurves[def.key] = curves.get(channel);
    const valuesOf = RANGE_VALUES[def.key];
    const ranges = valuesOf && channel.offsets ? rangesOf(channel, valuesOf) : null;
    if (ranges) dmxSteps[def.key] = ranges;
  });
  const clip = controls.clip && controls.clip.mode === 'dmx' ? controls.clip : null;
  const clipPage = clip ? clipPageOf(mode, clip, dmxSteps.clip || null) : null;
  return {
    ...DEFAULT_LASER_PARAMS,
    power: lines.length
      ? lines.reduce((sum, l) => sum + l.watts, 0)
      : number(a.OutputStrength, DEFAULT_LASER_PARAMS.power),
    lines: lines.length ? lines : null,
    scanAngleH: number(a.ScanAnglePan, DEFAULT_LASER_PARAMS.scanAngleH),
    scanAngleV: number(a.ScanAngleTilt, DEFAULT_LASER_PARAMS.scanAngleV),
    beamDiameter: number(a.BeamDiameter, DEFAULT_LASER_PARAMS.beamDiameter / 1000) * 1000,
    divergence: number(
      a.BeamDivergenceMax,
      number(a.BeamDivergenceMin, DEFAULT_LASER_PARAMS.divergence),
    ),
    width: body && body.length > 0 ? body.length : DEFAULT_LASER_PARAMS.width,
    depth: body && body.width > 0 ? body.width : DEFAULT_LASER_PARAMS.depth,
    height: body && body.height > 0 ? body.height : DEFAULT_LASER_PARAMS.height,
    apertureDiameter: apertureModel && apertureModel.length > 0
      ? apertureModel.length : DEFAULT_LASER_PARAMS.apertureDiameter,
    // Where the beam starts, in the body's frame: x across, y forward
    // (negative), z up -- the frame the body's model is drawn in.
    aperture: laser ? { x: at(0), y: at(1), z: at(2) } : DEFAULT_LASER_PARAMS.aperture,
    controls,
    dmxSteps,
    dmxCurves,
    clipPage,
    // The file's channels the laser does not read still take their addresses
    // and their names.
    footprint: footprintOf(mode),
    channelNames: channelNamesOf(mode),
    modeName: mode ? mode.name : null,
  };
}
