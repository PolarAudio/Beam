/**
 * @file What a fixture needs from a GDTF fixture type: its channel rows, and
 * the moving head's inputs -- category, zoom range, output, pan and tilt
 * spans, wheels and body height.
 *
 * Read from the file as it stands. Where the file is silent the head's own
 * defaults apply, as they do for a profile that is silent.
 */

import { walkGeometry } from './gdtf_reader';

/** Old channel types by GDTF attribute, for the quick accessors and the UI. */
const CHANNEL_TYPES = [
  [/^Dimmer$/, 'Dimmer'],
  [/^Pan$/, 'Pan'],
  [/^Tilt$/, 'Tilt'],
  [/^PanRotate$/, 'PanContinuous'],
  [/^TiltRotate$/, 'TiltContinuous'],
  [/^Zoom$/, 'Zoom'],
  [/^Focus\d+$/, 'Focus'],
  [/^Shutter\d+/, 'Shutter'],
  [/^Color(Add|Sub)_/, 'Color'],
  [/^ColorMacro\d+$/, 'ColorPreset'],
  [/^Effects\d+/, 'Effect'],
  [/^Control\d+$/, 'Maintenance'],
];

/** Colour attribute letters, by the name a panel shows. */
const COLOUR_LETTERS = {
  R: 'Red',
  G: 'Green',
  B: 'Blue',
  C: 'Cyan',
  M: 'Magenta',
  Y: 'Yellow',
  W: 'White',
  WW: 'Warm white',
  CW: 'Cold white',
  RY: 'Amber',
  GY: 'Lime',
  UV: 'UV',
  BM: 'Indigo',
  GC: 'Blue-green',
  BC: 'Light blue',
  RM: 'Pink',
};

/** What follows a wheel's number, said in words. */
const WHEEL_SUFFIXES = {
  '': '',
  WheelSpin: ' wheel spin',
  WheelIndex: ' wheel index',
  WheelShake: ' wheel shake',
  WheelRandom: ' wheel random',
  SelectSpin: ' spin',
  SelectShake: ' shake',
  Pos: ' index',
  PosRotate: ' rotation',
  PosShake: ' shake',
  Macro: ' macro',
  Adjust: ' adjust',
  Distance: ' distance',
};

/**
 * A GDTF attribute as a channel's name on a panel: `ColorSub_C` is Cyan,
 * `Gobo1PosRotate` is Gobo 1 rotation. An attribute without a reading is
 * shown as it is written.
 *
 * @param {String} attribute
 * @returns {String}
 */
export function attributeLabel(attribute) {
  const colour = /^Color(Add|Sub)_(\w+)$/.exec(attribute);
  if (colour && COLOUR_LETTERS[colour[2]]) return COLOUR_LETTERS[colour[2]];
  const families = 'Color|Gobo|Prism|AnimationWheel|Animation|Effects|Frost|Focus|Shutter|Control|ColorMacro';
  const wheel = new RegExp(`^(${families})(\\d+)(\\w*)$`).exec(attribute);
  if (wheel && WHEEL_SUFFIXES[wheel[3]] !== undefined) {
    const renamed = { AnimationWheel: 'Animation', ColorMacro: 'Colour macro', Color: 'Colour' };
    const family = renamed[wheel[1]] || wheel[1];
    const single = ['Frost', 'Focus', 'Shutter', 'Control'].includes(wheel[1]) && wheel[2] === '1';
    return `${family}${single ? '' : ` ${wheel[2]}`}${WHEEL_SUFFIXES[wheel[3]]}`;
  }
  const named = {
    PositionMSpeed: 'Pan/tilt speed',
    ColorMixMSpeed: 'Colour mix speed',
    NoFeature: 'No function',
    PanRotate: 'Pan rotation',
    TiltRotate: 'Tilt rotation',
  };
  return named[attribute] || attribute;
}

/** A channel's type in the terms the rest of the app sorts by. */
export function channelType(attribute) {
  const found = CHANNEL_TYPES.find(([pattern]) => pattern.test(attribute));
  return found ? found[1] : attribute;
}

/**
 * A channel row whose value the panels read as `value.DMX`, the way a
 * channel parsed from OFL holds it, so one table reads both.
 */
class ChannelRow {
  constructor(fields) {
    Object.assign(this, fields);
    this._value = { DMX: 0 };
  }

  get value() {
    return this._value;
  }

  set value(value) {
    this._value.DMX = value;
  }
}

/**
 * One row per DMX address the fixture occupies, as the patch, the parked
 * values and the channel table count them. A 16-bit channel is two rows, the
 * second its fine byte.
 *
 * @param {Object} engine a DmxEngine
 * @returns {Array<Object>} `{ id, name, type, attribute, isFine, value,
 *   fineChannels, engineChannel }`, `id` 1-based
 */
export function channelRows(engine) {
  const rows = [];
  for (let address = 0; address < engine.footprint; address += 1) {
    const slot = engine.byAddress[address];
    const attribute = slot ? ((slot.channel.channel.logicalChannels[0] || {}).attribute || 'NoFeature') : 'NoFeature';
    const isFine = !!slot && slot.byte > 0;
    let base = slot ? attributeLabel(attribute) : 'Unset';
    if (slot && slot.channel.instanceOf) base = `${slot.channel.instanceOf} ${base}`;
    let type = slot ? channelType(attribute) : 'Unset';
    if (isFine) type = `${channelType(attribute)}Fine`;
    rows.push(new ChannelRow({
      id: address + 1,
      name: isFine ? `${base} fine${slot.byte > 1 ? ` ${slot.byte}` : ''}` : base,
      type,
      attribute,
      isFine,
      fineChannels: [],
      engineChannel: slot ? slot.channel : null,
    }));
  }
  rows.forEach((row) => {
    if (row.isFine || !row.engineChannel) return;
    // eslint-disable-next-line no-param-reassign
    row.fineChannels = row.engineChannel.offsets.slice(1).map((o) => rows[o - 1]);
  });
  return rows;
}

/** CIE 1931 xyY as `#rrggbb`, through linear sRGB under D65, at full value. */
export function cieToHex(cie) {
  if (!cie || !(cie.y > 0)) return null;
  const X = cie.x / cie.y;
  const Z = (1 - cie.x - cie.y) / cie.y;
  const linear = [
    3.2406 * X - 1.5372 - 0.4986 * Z,
    -0.9689 * X + 1.8758 + 0.0415 * Z,
    0.0557 * X - 0.2040 + 1.0570 * Z,
  ].map((v) => Math.max(v, 0));
  const peak = Math.max(...linear, 1e-6);
  return `#${linear.map((v) => {
    const c = v / peak;
    const g = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(Math.max(g, 0), 1) * 255).toString(16).padStart(2, '0');
  }).join('')}`;
}

/**
 * The fixture's wheels in the form the moving head builds its optics from.
 *
 * A translated OFL slot is the profile's own. A GDTF slot is read for what
 * it is: facets make a prism, an image a gobo, a colour a colour filter; an
 * empty slot is open. A wheel's kind is otherwise taken from the attributes
 * that select it.
 *
 * @param {Object} type a fixture type
 * @returns {Object} wheel name to `{ slots }`
 */
export function wheelsForHead(type) {
  const families = new Map();
  type.modes.forEach((mode) => mode.channels.forEach((c) => c.logicalChannels.forEach((l) => {
    l.functions.forEach((f) => {
      const m = /^(Color|Gobo|Prism|Effects|Animation)\d/.exec(f.attribute);
      if (f.wheel && m && !families.has(f.wheel)) families.set(f.wheel, m[1]);
    });
  })));
  const wheels = {};
  type.wheels.forEach((wheel) => {
    const family = families.get(wheel.name) || 'Gobo';
    wheels[wheel.name] = {
      slots: wheel.slots.map((slot) => {
        if (slot.ofl) return slot.ofl;
        const name = slot.name || '';
        let kind = family === 'Color' ? 'Color' : 'Gobo';
        if (slot.facets.length) kind = 'Prism';
        else if (/^open$/i.test(name) || (!slot.mediaFileName && !slot.color && family !== 'Color')) kind = 'Open';
        else if (/frost/i.test(name)) kind = 'Frost';
        const hex = cieToHex(slot.color);
        return {
          type: kind,
          name,
          ...(kind === 'Color' && hex ? { colors: [hex] } : {}),
          ...(kind === 'Prism' ? { facets: slot.facets.length } : {}),
          ...(slot.mediaFileName ? { resource: slot.mediaFileName } : {}),
        };
      }),
    };
  });
  return wheels;
}

/**
 * Whether a beam still has the output GDTF writes when nobody filled it in:
 * 10000 lm at 1000 W. Real fixtures do not land on both.
 *
 * @param {Object} beam a Beam geometry's beam
 * @returns {Boolean}
 */
export function isPlaceholderBeam(beam) {
  return Number(beam.luminousFlux) === 10000 && Number(beam.powerConsumption) === 1000;
}

/**
 * The moving head's inputs from a fixture type in one mode.
 *
 * @param {Object} type a fixture type
 * @param {Object} mode the mode it is patched in
 * @returns {Object} `{ category, minAngle, maxAngle, lumens, colorTemp,
 *   panSpan, tiltSpan, panSpeed, tiltSpeed, bodyHeight, unmeasured }`; null fields
 *   where the file is silent
 */
export function headInputs(type, mode) {
  // The fixture as this mode describes it: the mode's geometry, with each
  // geometry reference standing for the geometry it repeats. A file may
  // describe one emitter twice -- as a compound beam for one mode and as
  // pixels for another -- so beams outside the mode are not this fixture.
  const beams = [];
  let axes = 0;
  const root = type.index.geometry.get(mode.geometry) || type.geometries[0] || null;
  const visit = (geometry) => walkGeometry(geometry, (g) => {
    if (g.beam) beams.push(g.beam);
    if (g.type === 'Axis') axes += 1;
    if (g.type === 'GeometryReference') {
      const template = type.index.geometry.get(g.geometry);
      if (template) visit(template);
    }
  });
  if (root) visit(root);
  const span = (attribute) => {
    let low = Infinity;
    let high = -Infinity;
    mode.channels.forEach((c) => c.logicalChannels.forEach((l) => l.functions.forEach((f) => {
      if (f.attribute !== attribute) return;
      low = Math.min(low, f.physicalFrom, f.physicalTo);
      high = Math.max(high, f.physicalFrom, f.physicalTo);
    })));
    return Number.isFinite(low) ? [low, high] : null;
  };
  const zoom = span('Zoom');
  const pan = span('Pan');
  const tilt = span('Tilt');
  // A function's RealFade is the time it takes across its whole range, so
  // the head's top speed is the span over that.
  const speed = (attribute, range) => {
    let fade = 0;
    mode.channels.forEach((c) => c.logicalChannels.forEach((l) => l.functions.forEach((f) => {
      if (f.attribute === attribute && f.realFade > fade) fade = f.realFade;
    })));
    return range && fade > 0 ? (range[1] - range[0]) / fade : null;
  };
  const main = beams[0] || null;
  // A head without a zoom channel is drawn at its stated beam angle.
  const fixed = main ? main.beamAngle : null;
  // Every beam's output together: an LED head describes each emitter as a
  // beam of its own, and the head is all of them. A beam still carrying the
  // spec's placeholder output was never measured, and is only counted when
  // no beam in the mode was.
  const measured = beams.filter((b) => !isPlaceholderBeam(b));
  const counted = measured.length ? measured : beams;
  const lumens = counted.reduce((sum, b) => sum + (Number(b.luminousFlux) || 0), 0);
  // The body's height: the base and the part on it that leads to the beam,
  // the yoke, which is what stands when the head points along it. Found by
  // the path to the beam, since not every file models the yoke as an axis.
  const holdsBeam = (g) => {
    let found = false;
    walkGeometry(g, (n) => { if (n.beam) found = true; });
    return found;
  };
  const top = root;
  const yoke = top ? top.children.find(holdsBeam) || null : null;
  const heightOf = (g) => {
    const m = g && g.model ? type.index.model.get(g.model) : null;
    return m && m.height > 0 ? m.height : 0;
  };
  const height = heightOf(top) + heightOf(yoke);
  return {
    // A head that pans or tilts. Not every file models the yoke and head as
    // axes -- Martin's are plain geometry -- so the channels decide.
    category: (pan || tilt || axes > 0) && beams.length ? 'Moving Head' : 'Other',
    minAngle: zoom ? zoom[0] : fixed,
    maxAngle: zoom ? zoom[1] : fixed,
    lumens: lumens || null,
    unmeasured: beams.length > 0 && !measured.length,
    // The light sources' power, which is what GDTF's beams state: the
    // fixture's own draw is a separate figure most files leave out.
    power: counted.reduce((sum, b) => sum + (Number(b.powerConsumption) || 0), 0) || null,
    beam: counted[0] || null,
    beamCount: counted.length,
    colorTemp: main ? main.colorTemperature : null,
    panSpan: pan ? pan[1] - pan[0] : null,
    tiltSpan: tilt ? tilt[1] - tilt[0] : null,
    panSpeed: speed('Pan', pan),
    tiltSpeed: speed('Tilt', tilt),
    bodyHeight: height > 0 ? height : null,
  };
}
