/**
 * @file Channel states from the DMX engine, acted on by a moving head.
 *
 * Each state is turned into what the head was always given: a kind -- the
 * OFL capability type the head's inputs were written around -- and a value
 * object in the head's units. A translated OFL fixture carries its
 * capability's own values at both ends of each range, so it reaches the head
 * exactly as it did before translation. A GDTF fixture is read from its
 * attribute and physical value.
 *
 * Some states hold until the channel that set them moves on: a colour preset,
 * a prism, a pan/tilt speed and frost. Any other channel may be unrelated
 * and, with changed-only DMX input, never written again, so the release
 * belongs to the channel that set it.
 *
 * A fixture with several lenses has a light for each. A channel acts on the
 * lenses its geometry holds, as GDTF has it: a dimmer on the fixture's root
 * reaches every lens, a pixel's colour only that pixel's. A channel on a
 * geometry that holds no lens acts on the first light, as a fixture with one
 * lens has every channel do.
 */

import { nameOf, namesClosed, namesOpen } from './name_rules';

/** GDTF additive and subtractive colour attributes, by the head's colour names. */
const COLOR_NAMES = {
  ColorAdd_R: 'Red',
  ColorAdd_G: 'Green',
  ColorAdd_B: 'Blue',
  ColorAdd_W: 'White',
  ColorAdd_WW: 'Warm White',
  ColorAdd_CW: 'Cold White',
  ColorAdd_RY: 'Amber',
  ColorAdd_GY: 'Lime',
  ColorAdd_UV: 'UV',
  ColorAdd_C: 'Cyan',
  ColorAdd_M: 'Magenta',
  ColorAdd_Y: 'Yellow',
  ColorAdd_BM: 'Indigo',
  ColorSub_C: 'Cyan',
  ColorSub_M: 'Magenta',
  ColorSub_Y: 'Yellow',
};

/** GDTF shutter attributes, by the strobe effect the head knows them as. */
const SHUTTER_EFFECTS = [
  [/^Shutter\d+StrobeRandomPulse/, 'Pulse', true],
  [/^Shutter\d+StrobeRandom/, 'Strobe', true],
  [/^Shutter\d+StrobePulseOpen$/, 'RampUp', false],
  [/^Shutter\d+StrobePulseClose$/, 'RampDown', false],
  [/^Shutter\d+StrobePulse$/, 'Pulse', false],
  [/^Shutter\d+StrobeEffect$/, 'Lightning', false],
  [/^Shutter\d+Strobe$/, 'Strobe', false],
];

/** Degrees per second as revolutions per minute. */
const RPM_PER_DEGREE_PER_SECOND = 60 / 360;

/** A value's place in its function's range, 0 to 1. */
function fractionOf(c) {
  const { fn } = c.state;
  if (fn.dmxTo <= fn.dmxFrom) return 0;
  return Math.min(Math.max((c.value - fn.dmxFrom) / (fn.dmxTo - fn.dmxFrom), 0), 1);
}

/**
 * A translated OFL function's values at a channel's value: every number
 * interpolated between the two ends, everything else as stated.
 */
function oflValues(c) {
  const { from, to } = c.state.fn.ofl;
  const t = fractionOf(c);
  const values = {};
  Object.keys(from).forEach((key) => {
    const a = from[key];
    const b = to[key];
    values[key] = typeof a === 'number' && typeof b === 'number' ? a + (b - a) * t : a;
  });
  return values;
}

/**
 * What a GDTF state means to the head: a kind and its values.
 *
 * @param {Object} c a channel instance with a state
 * @param {Object} origins lowest physical pan and tilt, which the head's
 *   zero is
 * @returns {{kind: String, values: Object}|null} null for anything the head
 *   does not draw
 */
function gdtfAction(c, origins) {
  const { fn, set, physical } = c.state;
  const a = fn.attribute;
  if (a === 'Dimmer') return { kind: 'Intensity', values: { intensity: physical } };
  if (a === 'Pan') return { kind: 'Pan', values: { pan: physical - origins.pan } };
  if (a === 'Tilt') return { kind: 'Tilt', values: { tilt: physical - origins.tilt } };
  if (a === 'Zoom') return { kind: 'Zoom', values: { zoom: physical }, inDegrees: true };
  if (COLOR_NAMES[a]) {
    return { kind: 'ColorIntensity', values: { color: COLOR_NAMES[a], colorBrightness: physical } };
  }
  if (a === 'CTC') return { kind: 'ColorTemperature', values: { colorTemperature: physical } };
  // A CTO or CTB stated in kelvin is a white point too; one stated as a share
  // of the filter is not, and the head has no filter to draw it with.
  if ((a === 'CTO' || a === 'CTB') && Math.max(fn.physicalFrom, fn.physicalTo) > 100) {
    return { kind: 'ColorTemperature', values: { colorTemperature: physical } };
  }
  if (/^Focus\d+$/.test(a)) return { kind: 'Focus', values: { focus: physical * 100 } };
  if (a === 'Iris') return { kind: 'Iris', values: { openPercent: physical * 100 } };
  if (/^Frost\d+$/.test(a)) return { kind: 'Frost', values: { frostIntensity: physical * 100 } };

  const wheel = /^(Color|Gobo|Prism)(\d+)(.*)$/.exec(a);
  if (wheel && fn.wheel) {
    const [, , , suffix] = wheel;
    if (suffix === '' && set && set.wheelSlotIndex) {
      return { kind: 'WheelSlot', values: { wheel: fn.wheel, slotNumber: set.wheelSlotIndex } };
    }
    if (suffix === 'SelectShake' || suffix === 'WheelShake') {
      return {
        kind: 'WheelShake',
        values: {
          wheel: fn.wheel,
          slotNumber: set && set.wheelSlotIndex ? set.wheelSlotIndex : 1,
          isShaking: suffix === 'SelectShake' ? 'slot' : 'wheel',
          rate: physical,
        },
      };
    }
  }
  if (wheel) {
    const [, family, , suffix] = wheel;
    const rpm = physical * RPM_PER_DEGREE_PER_SECOND;
    if (suffix === 'WheelSpin') return { kind: 'WheelRotation', values: { wheel: fn.wheel || a, rpm } };
    if (family === 'Prism' && suffix === 'PosRotate') return { kind: 'PrismRotation', values: { rpm } };
    if (family === 'Prism' && suffix === 'Pos') return { kind: 'PrismRotation', values: { angle: physical } };
    if (suffix === 'PosRotate') return { kind: 'WheelSlotRotation', values: { wheel: fn.wheel || a, rpm } };
    if (suffix === 'Pos') return { kind: 'WheelSlotRotation', values: { wheel: fn.wheel || a, angle: physical } };
    if (family === 'Prism' && suffix === '') {
      // No usable slot: the name says what is in. Open is no prism; any
      // other names its prism, where the facets and layout are read from.
      const named = nameOf(fn, set);
      if (namesOpen(named)) return { kind: 'Prism', values: { off: true } };
      return { kind: 'Prism', values: { comment: named } };
    }
  }

  if (/^Shutter\d+$/.test(a)) {
    const closed = namesClosed(nameOf(fn, set));
    return {
      kind: 'Shutter',
      values: { strobeEffect: closed ? 'Closed' : 'Open', strobeRandom: false },
    };
  }
  const effect = SHUTTER_EFFECTS.find(([pattern]) => pattern.test(a));
  if (effect) {
    return {
      kind: 'Shutter',
      values: { strobeEffect: effect[1], strobeRandom: effect[2], strobeFrequency: physical },
    };
  }
  return null;
}

export default class HeadDispatch {
  /**
   * @param {Object} head the light it drives: a `Light`, or a `MovingHead`
   * @param {Object} engine a DmxEngine for the same fixture
   * @param {Array<Object>} [lenses] for a fixture with several, each lens's
   *   light and the names of the geometries that hold it: `{ head, path }`
   */
  constructor(head, engine, lenses = null) {
    this.head = head;
    this.engine = engine;
    this.lenses = lenses && lenses.length > 1 ? lenses : null;
    /** The lights each geometry's channels act on, by geometry name. */
    this.targets = new Map();
    this.preset = null;
    this.prism = null;
    this.panTiltSpeed = null;
    this.frost = null;
    /** The wheel each channel last put on a slot, by channel. */
    this.wheelOf = new Map();
    // The head counts pan and tilt up from zero, and GDTF often centres them
    // on it, -270 to 270, so its zero is the lowest angle any function gives.
    const lowest = (attribute) => {
      let low = Infinity;
      engine.channels.forEach((c) => c.functions.forEach((f) => {
        if (f.attribute === attribute && !f.ofl) low = Math.min(low, f.physicalFrom, f.physicalTo);
      }));
      return Number.isFinite(low) ? low : 0;
    };
    this.origins = { pan: lowest('Pan'), tilt: lowest('Tilt') };
  }

  /**
   * Acts on every channel a write changed.
   *
   * @param {Array<Object>} changed from `DmxEngine.write`
   */
  apply(changed) {
    for (let i = 0; i < changed.length; i += 1) this.applyChannel(changed[i]);
  }

  /**
   * Acts on every channel as it stands, changed or not. A write only reports
   * the channels whose function it changed, so a channel sitting at its
   * default would otherwise never reach a newly built or reset head.
   */
  applyAll() {
    // A light the mode controls without a dimmer runs at full, its colour
    // channels its only control: an RGB bar with red at full is lit. One no
    // channel reaches at all is not driven in this mode and stays dark.
    const reached = new Set();
    const dimmed = new Set();
    this.engine.channels.forEach((c) => {
      const heads = this.targetsOf(c);
      heads.forEach((head) => reached.add(head));
      if (c.functions.some((f) => f.attribute === 'Dimmer')) {
        heads.forEach((head) => dimmed.add(head));
      }
    });
    reached.forEach((head) => {
      if (!dimmed.has(head)) head.intensity = 1;
    });
    this.apply(this.engine.channels);
  }

  /**
   * The lights a channel acts on: the lenses its geometry holds, or the
   * first light where it holds none.
   *
   * @param {Object} c a channel instance
   * @returns {Array<Object>}
   */
  targetsOf(c) {
    if (!this.lenses) return [this.head];
    const geometry = c.geometry || '';
    let heads = this.targets.get(geometry);
    if (!heads) {
      heads = this.lenses.filter((lens) => lens.path.includes(geometry)).map((lens) => lens.head);
      if (!heads.length) heads = [this.head];
      this.targets.set(geometry, heads);
    }
    return heads;
  }

  /**
   * Acts on one channel's state, on every light it reaches.
   *
   * @param {Object} c a channel instance
   */
  applyChannel(c) {
    const heads = this.targetsOf(c);
    if (heads.length === 1) {
      this.applyTo(heads[0], c);
      return;
    }
    // What the channel holds is released or taken on every light it reaches,
    // so each starts from how it stood before this write.
    const before = {
      preset: this.preset,
      prism: this.prism,
      panTiltSpeed: this.panTiltSpeed,
      frost: this.frost,
      wheel: this.wheelOf.get(c),
    };
    for (let i = 0; i < heads.length; i += 1) {
      if (i > 0) {
        this.preset = before.preset;
        this.prism = before.prism;
        this.panTiltSpeed = before.panTiltSpeed;
        this.frost = before.frost;
        if (before.wheel === undefined) this.wheelOf.delete(c);
        else this.wheelOf.set(c, before.wheel);
      }
      this.applyTo(heads[i], c);
    }
  }

  /**
   * Acts on one channel's state, on one light.
   *
   * @param {Object} head
   * @param {Object} c a channel instance
   */
  applyTo(head, c) {
    const { state } = c;
    let action = null;
    if (state) {
      action = state.fn.ofl
        ? { kind: state.fn.ofl.type, values: oflValues(c), inDegrees: !!state.fn.ofl.inUnit.zoom }
        : gdtfAction(c, this.origins);
    }
    const kind = action ? action.kind : null;

    if (this.preset === c && kind !== 'ColorPreset') {
      head.colorPreset = null;
      this.preset = null;
    }
    if (this.prism === c && kind !== 'Prism' && kind !== 'PrismRotation'
      && typeof head.setPrism === 'function') {
      head.setPrism(false);
      this.prism = null;
    }
    if (this.panTiltSpeed === c && kind !== 'PanTiltSpeed'
      && typeof head.setPanTiltSpeed === 'function') {
      head.setPanTiltSpeed(null);
      this.panTiltSpeed = null;
    }
    if (this.frost === c && kind !== 'Frost' && kind !== 'FrostEffect'
      && typeof head.setFrost === 'function') {
      head.setFrost(0);
      this.frost = null;
    }
    // A wheel's place follows the channel's current value only. A range
    // whose function positions no slot -- a wheel mode such as
    // Gobo(n)WheelMode, which changes how the wheel is controlled, or a
    // stretch with no function -- leaves the wheel on its first slot.
    const turning = kind === 'WheelSlot' || kind === 'WheelShake'
      || kind === 'WheelRotation' || kind === 'WheelSlotRotation';
    if (this.wheelOf.has(c) && !turning) {
      if (typeof head.setWheelSlot === 'function') head.setWheelSlot(this.wheelOf.get(c), 0);
      this.wheelOf.delete(c);
    }
    // A value no function covers holds the head where it was.
    if (!action) return;
    const { values } = action;
    // OFL names wheels by channel; a translated function keeps that name.
    const channelName = state.fn.ofl ? state.fn.ofl.channel : c.channel.name;
    if (kind === 'WheelSlot' || kind === 'WheelShake') this.wheelOf.set(c, values.wheel || channelName);

    switch (kind) {
      case 'ColorIntensity':
        head.colorIntensity = values;
        break;
      case 'WheelSlot': {
        // Fractional on purpose: slot 2.5 is a split.
        const slot = values.slotNumber - 1.0;
        if (typeof head.setWheelSlot === 'function') head.setWheelSlot(values.wheel || channelName, slot);
        else head.colorWheelSlot = slot;
        break;
      }
      case 'WheelShake':
        if (typeof head.setWheelShake === 'function') head.setWheelShake(values.wheel || channelName, values);
        break;
      case 'WheelSlotRotation':
        if (typeof head.setWheelSlotRotation === 'function') {
          head.setWheelSlotRotation(values.wheel || channelName, values);
        }
        break;
      case 'WheelRotation':
        if (typeof head.setWheelRotation === 'function') head.setWheelRotation(values.wheel || channelName, values);
        break;
      case 'Prism':
        if (values.off) {
          if (typeof head.setPrism === 'function') head.setPrism(false);
          this.prism = null;
        } else if (typeof head.setPrism === 'function') {
          // The facet count and layout are only ever in the text.
          head.setPrism(true, `${values.comment || ''} ${channelName || ''}`);
          this.prism = c;
        }
        break;
      case 'PrismRotation':
        if (typeof head.setPrismRotation === 'function') head.setPrismRotation(values);
        break;
      case 'PanTiltSpeed':
        if (typeof head.setPanTiltSpeed === 'function') {
          head.setPanTiltSpeed({ speed: values.panTiltSpeed, duration: values.panTiltDuration });
          this.panTiltSpeed = c;
        }
        break;
      case 'Frost':
        if (typeof head.setFrost === 'function') {
          head.setFrost(values.frostIntensity / 100);
          this.frost = c;
        }
        break;
      case 'FrostEffect':
        if (typeof head.setFrostEffect === 'function') {
          head.setFrostEffect(`${values.effectName || ''} ${values.comment || ''}`, values.speed);
          this.frost = c;
        }
        break;
      case 'Iris':
        if (typeof head.setIris === 'function') head.setIris(values.openPercent / 100);
        break;
      case 'Zoom':
        if (typeof head.setZoom === 'function') head.setZoom(values.zoom, action.inDegrees);
        else head.zoom = values.zoom;
        break;
      case 'ColorTemperature':
        head.colorTemperature = values.colorTemperature;
        break;
      case 'ColorPreset': {
        const preset = values.color ? values.color[0] : null;
        head.colorPreset = preset;
        this.preset = preset ? c : null;
        break;
      }
      default:
        Object.keys(values).forEach((key) => {
          head[key] = values[key];
        });
        break;
    }
  }
}
