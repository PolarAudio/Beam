import { walkGeometry } from './gdtf_reader';
import { DEFAULT_LASER_PARAMS, CONTROL_DEFS } from '../generic/laser';

/**
 * @file A GDTF laser read as the parameters Beam's laser takes, so a laser
 * from a file is drawn by the same renderer as one made in Beam
 * (`generic/laser.js`).
 *
 * The optics come from the Laser geometry: OutputStrength in watts,
 * BeamDiameter in metres, divergence in milliradians and the scan angles in
 * degrees. The body is the root geometry's Model, and the beam starts where
 * the Laser geometry sits in it.
 *
 * The controls come from the mode's channels, one attribute each. A channel
 * with an offset is driven over DMX. A virtual channel, one with no offset,
 * is set by hand: Fixed when its only function's physical range is a single
 * value, Adjustable otherwise, its default the starting value.
 */

/** The GDTF attribute that carries each laser control. */
export const LASER_ATTRIBUTES = {
  dimmer: 'Dimmer',
  shutter: 'Shutter1',
  red: 'ColorAdd_R',
  green: 'ColorAdd_G',
  blue: 'ColorAdd_B',
  xScale: 'LaserScaleX',
  yScale: 'LaserScaleY',
  xPos: 'LaserPositionX',
  yPos: 'LaserPositionY',
  mirrorX: 'LaserMirrorX',
  mirrorY: 'LaserMirrorY',
};

/**
 * The first Laser geometry in a fixture type, and the root geometry it is
 * under.
 *
 * @param {Object} type a GDTF fixture type
 * @returns {Object|null} `{ root, laser }`
 */
export function laserGeometry(type) {
  let found = null;
  (type.geometries || []).some((root) => {
    walkGeometry(root, (g) => { if (!found && g.type === 'Laser') found = { root, laser: g }; });
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
 * A GDTF laser as Beam's laser parameters.
 *
 * @public
 * @param {Object} type a GDTF fixture type
 * @param {Object} [mode] the mode in use; the first when absent
 * @returns {Object|null} laser parameters, null for a type with no Laser geometry
 */
export function laserParams(type, mode = type.modes[0]) {
  const found = laserGeometry(type);
  if (!found) return null;
  const { root, laser } = found;
  const a = laser.attrs || {};
  const body = root.model ? type.index.model.get(root.model) : null;
  const apertureModel = laser.model ? type.index.model.get(laser.model) : null;
  // The Laser geometry's place in the body, in metres: the last column of the
  // row-major matrix the reader keeps flat.
  const p = laser.position || [];
  const at = (row) => Number(p[row * 4 + 3]) || 0;
  const controls = {};
  CONTROL_DEFS.forEach((def) => {
    const attribute = LASER_ATTRIBUTES[def.key];
    const channel = mode && mode.channels.find((c) => c.logicalChannels
      .some((l) => l.attribute === attribute));
    if (channel) controls[def.key] = controlOf(channel, def);
  });
  return {
    ...DEFAULT_LASER_PARAMS,
    power: number(a.OutputStrength, DEFAULT_LASER_PARAMS.power),
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
    aperture: { x: at(0), y: at(1), z: at(2) },
    controls,
  };
}
