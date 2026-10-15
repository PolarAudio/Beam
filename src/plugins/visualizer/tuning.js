/**
 * @file Persistence for the debug panel's tuning values.
 *
 * The panel exists to find values worth keeping. This stores whatever has been
 * moved and puts it back at startup, so a session's work survives a restart.
 *
 * **Defaults deliberately live in their own modules.** Nothing here is
 * registered in `Preferences.DEFAULTS`: the constants in `led_field.js`,
 * `led_panel.js`, `ambient.js` and the rest remain the single source of truth,
 * and this only ever holds departures from them. Copying them into a second
 * table would be two versions of one fact, and the preference would silently
 * win -- so a constant changed in a new version would never reach anyone who
 * had opened the panel once -- see `departures()`.
 *
 * A key that has never been touched reads back `undefined` and is skipped,
 * which is what leaves the source constant in charge. The default of each key
 * is read from its target the first time this module touches it, before any
 * stored value is written over it, so a control can be put back without the
 * table of constants ever being copied here.
 */

import Preferences from './preferences';
import {
  hazeWarp, hazeTurn, setHazeWarp, setHazeTurn,
} from './haze_noise';
import { GLOW_UNIFORMS } from './led_field';
import LEDPanel from './led_panel';
import Laser from './laser';
import { ambientCeiling, setAmbientCeiling } from './ambient';
import ContactShadows from './contact_shadows';
import PatchSingleton from '../../models/DMX/patch.model';

const PREFIX = 'tune.';

/** The uniform object a group name refers to. */
function groupFor(group) {
  if (group === 'halo') return LEDPanel.tunables();
  return GLOW_UNIFORMS;
}

/** A control over one uniform: how to write it and how to read it. */
function uniform(group, name) {
  return {
    set: (value) => {
      const target = groupFor(group);
      if (target && target[name]) target[name].value = value;
    },
    get: () => {
      const target = groupFor(group);
      return target && target[name] ? target[name].value : undefined;
    },
  };
}

/**
 * Every control the panel offers: how to apply a value and how to read the
 * current one.
 *
 * The visualizer is passed in because some of these live on it rather than in
 * a uniform. Anything whose target is absent is skipped rather than throwing:
 * the ambient haze effect only exists once the composer has been built, and a
 * reader for it answers `undefined` until then.
 */
const CONTROLS = {
  // Scattered glow
  glowSize: uniform('glow', 'glowSize'),
  sizeAtFullHaze: uniform('glow', 'sizeAtFullHaze'),
  haloFalloff: uniform('halo', 'haloFalloff'),
  haloRadiance: uniform('halo', 'haloRadiance'),
  haloBackScatter: uniform('halo', 'haloBackScatter'),
  // Room
  roomAir: { set: (value) => setAmbientCeiling(value), get: () => ambientCeiling() },
  hazeWarp: { set: (value) => setHazeWarp(value / 100), get: () => Math.round(hazeWarp() * 100) },
  hazeTurn: { set: (value) => setHazeTurn(value / 100), get: () => Math.round(hazeTurn() * 100) },
  airHaze: {
    set: (value, vis) => { if (vis.ambientHaze) vis.ambientHaze.setCeiling(value); },
    get: (vis) => (vis.ambientHaze ? vis.ambientHaze.ceiling : undefined),
  },
  airGrain: {
    set: (value, vis) => { if (vis.ambientHaze) vis.ambientHaze.setFieldDepth(value); },
    get: (vis) => (vis.ambientHaze ? vis.ambientHaze.fieldDepth() : undefined),
  },
  airScale: {
    set: (value, vis) => { if (vis.ambientHaze) vis.ambientHaze.setScaleMultiplier(value); },
    get: (vis) => (vis.ambientHaze ? vis.ambientHaze.scaleMultiplier : undefined),
  },
  // Contact shadows. The toggle is also the rollback: off, nothing is drawn.
  contactShadows: {
    set: (value) => ContactShadows.setEnabled(value),
    get: () => ContactShadows.enabled(),
  },
  contactStrength: {
    set: (value) => ContactShadows.setStrength(value),
    get: () => ContactShadows.strength(),
  },
  contactReach: {
    set: (value) => ContactShadows.setReach(value),
    get: () => ContactShadows.reach(),
  },
  contactEdge: {
    set: (value) => ContactShadows.setEdge(value),
    get: () => ContactShadows.edge(),
  },
  // Off, the patch accepts any address and new fixtures keep the one given.
  strictPatch: {
    set: (value) => { PatchSingleton.strict = !!value; },
    get: () => PatchSingleton.strict,
  },
  // Laser. The air and the surface are two different renderers -- geometry
  // through haze, and a projected figure -- so they need separate hands.
  laserAir: { set: (value) => Laser.setScatterGain(value), get: () => Laser.scatterGain() },
  laserSurface: { set: (value) => Laser.setSurfaceGain(value), get: () => Laser.surfaceGain() },
  laserWidth: { set: (value) => Laser.setFigureWidth(value), get: () => Laser.figureWidth() },
  laserLength: { set: (value) => Laser.setBeamLength(value), get: () => Laser.beamLength() },
  laserTail: { set: (value) => Laser.setBeamTail(value), get: () => Laser.beamTail() },
  laserScatter: {
    set: (value) => Laser.setScatterAmount(value / 100),
    get: () => Math.round(Laser.scatterAmount() * 100),
  },
  laserDwell: { set: (value) => Laser.setDwellModel(value), get: () => Laser.dwellModel() },
};

/** Each control's source value, read before anything stored was written over it. */
const defaults = {};

/** Records a control's default if its target exists and none is recorded yet. */
function snapshot(key, visualizer) {
  if (key in defaults) return;
  const value = CONTROLS[key].get(visualizer);
  if (value !== undefined && value !== null) defaults[key] = value;
}

/**
 * Applies a value and remembers it.
 *
 * @param {String} key one of `CONTROLS`
 * @param {Number|Boolean} value
 * @param {Object} visualizer
 */
function write(key, value, visualizer) {
  const control = CONTROLS[key];
  if (!control) return;
  snapshot(key, visualizer);
  control.set(value, visualizer);
  Preferences.set(PREFIX + key, value);
}

/**
 * Forgets a stored value, so the source constant takes over again.
 *
 * @param {String} key
 */
function forget(key) {
  Preferences.set(PREFIX + key, undefined);
}

/**
 * Puts every stored value back, reading each control's default first.
 *
 * Called once the composer exists, since some targets are not built before.
 *
 * @param {Object} visualizer
 * @returns {Number} how many values were restored
 */
function applyStored(visualizer) {
  let restored = 0;
  Object.keys(CONTROLS).forEach((key) => {
    snapshot(key, visualizer);
    const value = Preferences.get(PREFIX + key);
    if (value === undefined || value === null) return;
    CONTROLS[key].set(value, visualizer);
    restored += 1;
  });
  return restored;
}

/**
 * The stored value for a control, or undefined when it has never been moved.
 *
 * @param {String} key
 * @returns {Number|Boolean|undefined}
 */
function stored(key) {
  return Preferences.get(PREFIX + key);
}

/**
 * The value a control holds now.
 *
 * @param {String} key
 * @param {Object} visualizer
 * @returns {Number|Boolean|undefined}
 */
function current(key, visualizer) {
  const control = CONTROLS[key];
  return control ? control.get(visualizer) : undefined;
}

/**
 * The value a control had before anything stored or moved touched it.
 *
 * @param {String} key
 * @returns {Number|Boolean|undefined}
 */
function defaultOf(key) {
  return defaults[key];
}

/**
 * Puts one control back to its default and forgets the stored value.
 *
 * @param {String} key
 * @param {Object} visualizer
 * @returns {Number|Boolean|undefined} the default it was put back to
 */
function reset(key, visualizer) {
  const control = CONTROLS[key];
  if (!control) return undefined;
  forget(key);
  const value = defaults[key];
  if (value !== undefined) control.set(value, visualizer);
  return value;
}

/**
 * Puts every control back to its default.
 *
 * @param {Object} visualizer
 */
function resetAll(visualizer) {
  Object.keys(CONTROLS).forEach((key) => reset(key, visualizer));
}

export default {
  write, forget, applyStored, stored, current, defaultOf, reset, resetAll, CONTROLS, PREFIX,
};
