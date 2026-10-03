/**
 * @file Translates an Open Fixture Library profile into Beam's fixture type
 * model, which is GDTF's.
 *
 * GDTF is the source of truth, so an OFL profile is read by turning it into
 * the fixture GDTF would describe. OFL says less: it has no geometry, one lens
 * range rather than a beam and field angle, no lamp type and no beam type.
 * What it does not say is left at GDTF's default and *not* listed in the
 * beam's `explicit`, and every assumption made is recorded in `notes`, so a
 * consumer can tell a fact from a fill-in.
 */

import { completeFixtureType } from './gdtf_reader';
import { normaliseMatrixProfile } from '../ofl_matrix';
import Capability from '../capabilityManager.model';

/** OFL colour names to GDTF additive attributes. Cyan/magenta/yellow are
 * decided per fixture: see `subtractive`. */
const COLOR_ADD = {
  Red: 'ColorAdd_R',
  Green: 'ColorAdd_G',
  Blue: 'ColorAdd_B',
  White: 'ColorAdd_W',
  'Warm White': 'ColorAdd_WW',
  'Cold White': 'ColorAdd_CW',
  Amber: 'ColorAdd_RY',
  Lime: 'ColorAdd_GY',
  UV: 'ColorAdd_UV',
  Cyan: 'ColorAdd_C',
  Magenta: 'ColorAdd_M',
  Yellow: 'ColorAdd_Y',
  Indigo: 'ColorAdd_BM',
};

/** OFL shutter effects to GDTF shutter attributes. */
const SHUTTER = {
  Open: 'Shutter1',
  Closed: 'Shutter1',
  Strobe: 'Shutter1Strobe',
  Pulse: 'Shutter1StrobePulse',
  RampUp: 'Shutter1StrobePulseOpen',
  RampDown: 'Shutter1StrobePulseClose',
  RampUpDown: 'Shutter1StrobePulse',
  Lightning: 'Shutter1StrobeEffect',
  Spikes: 'Shutter1StrobeEffect',
  Burst: 'Shutter1StrobeEffect',
};

/** The physical unit GDTF gives each attribute family. */
function physicalUnitOf(attribute) {
  if (/^(Pan|Tilt|Zoom)$/.test(attribute) || /Pos$/.test(attribute)) return 'Angle';
  if (attribute === 'Dimmer') return 'LuminousIntensity';
  if (/Strobe|StrobeRate/.test(attribute)) return 'Frequency';
  if (/Rotate|Spin/.test(attribute)) return 'AngularSpeed';
  if (attribute === 'CTC') return 'Temperature';
  return 'None';
}

/**
 * Each OFL capability type's main value, as the key Beam's capability parser
 * gives it and the factor into GDTF's unit: angles and frequencies as they
 * are, percentages of a range as 0 to 1, milliseconds as seconds. Speeds OFL
 * gives as a percentage stay percentages; GDTF has no unit for them.
 */
const PRIMARY = {
  Intensity: ['intensity', 1],
  ColorIntensity: ['colorBrightness', 1],
  Pan: ['pan', 1],
  Tilt: ['tilt', 1],
  ShutterStrobe: ['strobeFrequency', 1],
  StrobeSpeed: ['strobeFrequency', 1],
  StrobeDuration: ['strobeDuration', 0.001],
  ColorTemperature: ['colorTemperature', 1],
  ColorPreset: ['colorTemperature', 1],
  Focus: ['focus', 0.01],
  Iris: ['openPercent', 0.01],
  Frost: ['frostIntensity', 0.01],
  PanTiltSpeed: ['panTiltSpeed', 1],
  WheelSlot: ['slotNumber', 1],
  WheelShake: ['shakeSpeed', 1],
  WheelSlotRotation: ['speed', 1],
  WheelRotation: ['speed', 1],
  PrismRotation: ['speed', 1],
  BeamAngle: ['angle', 1],
  EffectSpeed: ['effectSpeed', 1],
  PanContinuous: ['panContinuousSpeed', 1],
  TiltContinuous: ['tiltContinuousSpeed', 1],
  FrostEffect: ['speed', 1],
};

/**
 * A capability's physical range from its values at both ends.
 *
 * Zoom is the one stated either way in OFL, in degrees or as a share of the
 * lens range, and is always degrees here, by the same rule the head applies.
 * A rotation that states an angle rather than a speed gives the angle.
 */
function primaryPhysical(type, from, to, inUnit, zoomRange) {
  if (type === 'Zoom') {
    const low = Math.min(zoomRange[0], zoomRange[1]);
    const high = Math.max(zoomRange[0], zoomRange[1]);
    const degrees = (v) => (inUnit.zoom
      ? v
      : low + (high - low) * (Math.min(Math.max(Number(v) || 0, 0), 100) / 100));
    return [degrees(from.zoom), degrees(to.zoom)];
  }
  const [key, scale] = PRIMARY[type] || [];
  if (key && Number.isFinite(from[key]) && Number.isFinite(to[key])) {
    return [from[key] * scale, to[key] * scale];
  }
  if (Number.isFinite(from.angle) && Number.isFinite(to.angle)) return [from.angle, to.angle];
  return [0, 1];
}

/** `#rrggbb` as CIE 1931 xyY, through linear sRGB under D65. */
function hexToCIE(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const lin = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const X = 0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2];
  const Y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  const Z = 0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2];
  const sum = X + Y + Z;
  if (sum <= 0) return { x: 0.3127, y: 0.329, Y: 0 };
  return { x: X / sum, y: Y / sum, Y: Y * 100 };
}

/** The wheel a capability names, the first when it names several. */
function firstWheel(cap) {
  return Array.isArray(cap.wheel) ? cap.wheel[0] : cap.wheel;
}

/** What a wheel holds, from its slots: Color, Gobo, Prism or other. */
function wheelKind(wheel) {
  const counts = {};
  (wheel.slots || []).forEach((s) => {
    const kind = /Gobo/.test(s.type) ? 'Gobo' : s.type;
    counts[kind] = (counts[kind] || 0) + 1;
  });
  return ['Color', 'Gobo', 'Prism'].find((k) => counts[k]) || 'Effects';
}

/**
 * Translates an OFL profile.
 *
 * @param {Object} ofl the profile JSON
 * @param {Object} [options]
 * @param {String} [options.manufacturer] display name, which OFL keeps outside the profile
 * @returns {{fixtureType: Object, notes: Array<String>, problems: Array<String>}}
 */
export default function translateOfl(ofl, { manufacturer = '' } = {}) {
  // Pixel grids written out first, so every mode lists plain channel names.
  const profile = normaliseMatrixProfile(ofl);
  const notes = [];
  const physical = ofl.physical || {};
  const bulb = physical.bulb || {};
  const lens = (physical.lens || {}).degreesMinMax || null;
  const categories = ofl.categories || [];
  const mover = categories.includes('Moving Head');

  // Geometry. OFL has none, so a mover is GDTF's own base, yoke and head
  // shapes and anything else one body, sized from the stated dimensions.
  const [w, h, d] = (physical.dimensions || [300, 300, 300]).map((mm) => mm / 1000);
  if (!physical.dimensions) notes.push('no dimensions: body is 300 mm a side');
  const beamExplicit = [];
  const beam = {
    lampType: /LED/i.test(bulb.type || '') ? 'LED' : 'Discharge',
    powerConsumption: physical.power || 1000,
    luminousFlux: bulb.lumens || 10000,
    colorTemperature: bulb.colorTemperature || 6000,
    beamAngle: lens ? lens[1] : 25,
    fieldAngle: lens ? lens[1] : 25,
    throwRatio: 1,
    rectangleRatio: 1.7777,
    beamRadius: Math.min(w, d) / 4,
    beamType: 'Wash',
    colorRenderingIndex: 100,
    emitterSpectrum: null,
    explicit: beamExplicit,
  };
  if (physical.power) beamExplicit.push('PowerConsumption');
  if (bulb.lumens) beamExplicit.push('LuminousFlux');
  else notes.push('no lumens stated');
  if (bulb.colorTemperature) beamExplicit.push('ColorTemperature');
  if (lens) {
    beamExplicit.push('BeamAngle', 'FieldAngle');
    notes.push('beam and field angle both taken from the widest lens angle');
  } else {
    notes.push('no lens range');
  }
  notes.push('beam type unknown (OFL has none), left at Wash');
  if (bulb.type) notes.push(`lamp type guessed from "${bulb.type}"`);

  const beamGeometry = {
    type: 'Beam', name: 'Beam', model: null, position: null, attrs: {}, children: [], beam,
  };
  let top;
  const models = [];
  if (mover) {
    models.push(
      {
        name: 'Base', length: w, width: d, height: h * 0.2, primitiveType: 'Base', file: null,
      },
      {
        name: 'Yoke', length: w, width: d * 0.4, height: h * 0.5, primitiveType: 'Yoke', file: null,
      },
      {
        name: 'Head', length: w * 0.7, width: d * 0.7, height: h * 0.5, primitiveType: 'Head', file: null,
      },
    );
    const head = {
      type: 'Axis', name: 'Head', model: 'Head', position: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, h * 0.25, 0, 0, 0, 1], attrs: {}, children: [beamGeometry],
    };
    const yoke = {
      type: 'Axis', name: 'Yoke', model: 'Yoke', position: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, h * 0.2, 0, 0, 0, 1], attrs: {}, children: [head],
    };
    top = {
      type: 'Geometry', name: 'Base', model: 'Base', position: null, attrs: {}, children: [yoke],
    };
    notes.push('body is GDTF\'s Base/Yoke/Head shapes scaled to the stated size');
  } else {
    models.push({
      name: 'Body', length: w, width: d, height: h, primitiveType: 'Cube', file: null,
    });
    top = {
      type: 'Geometry', name: 'Body', model: 'Body', position: null, attrs: {}, children: [beamGeometry],
    };
    notes.push('body is a box of the stated size');
  }

  // Wheels, numbered by kind in the order the profile lists them.
  const wheelNames = Object.keys(ofl.wheels || {});
  const wheelAttr = {};
  const kindCount = {};
  const wheels = wheelNames.map((name) => {
    const wheel = ofl.wheels[name];
    const kind = wheelKind(wheel);
    kindCount[kind] = (kindCount[kind] || 0) + 1;
    wheelAttr[name] = `${kind}${kindCount[kind]}`;
    return {
      name,
      slots: (wheel.slots || []).map((s) => ({
        name: s.name || s.type,
        color: s.colors && s.colors.length ? hexToCIE(s.colors[0]) : null,
        filter: null,
        mediaFileName: s.resource ? String(s.resource).split('/').pop() : null,
        facets: s.type === 'Prism' ? Array.from({ length: s.facets || 3 }, () => ({ color: null, rotation: null })) : [],
        animationSystem: null,
        // As the profile wrote it: the head draws a slot from its type,
        // colours and image, which GDTF spells differently.
        ofl: s,
      })),
    };
  });

  // Cyan, magenta and yellow are flags in a discharge head and emitters in an
  // LED one; a fixture with all three and no red is taken to mix by flags.
  const colorNames = new Set();
  Object.values(profile.availableChannels || {}).forEach((c) => {
    (c.capabilities || [c.capability]).forEach((cap) => {
      if (cap && cap.type === 'ColorIntensity') colorNames.add(cap.color);
    });
  });
  const subtractive = ['Cyan', 'Magenta', 'Yellow'].every((c) => colorNames.has(c)) && !colorNames.has('Red');

  const unmapped = {};
  const attributeOf = (cap, channelName) => {
    // OFL lets one capability move several wheels at once; GDTF names one.
    const wheel = firstWheel(cap) || channelName;
    switch (cap.type) {
      case 'Intensity': return 'Dimmer';
      case 'ColorIntensity':
        if (subtractive && /^(Cyan|Magenta|Yellow)$/.test(cap.color)) return `ColorSub_${cap.color[0]}`;
        return COLOR_ADD[cap.color] || null;
      case 'ColorPreset': return 'ColorMacro1';
      case 'ColorTemperature': return 'CTC';
      case 'ShutterStrobe': return SHUTTER[cap.shutterEffect] || 'Shutter1StrobeEffect';
      case 'StrobeSpeed': return 'StrobeRate';
      case 'StrobeDuration': return 'StrobeDuration';
      case 'Pan': return 'Pan';
      case 'Tilt': return 'Tilt';
      case 'PanContinuous': return 'PanRotate';
      case 'TiltContinuous': return 'TiltRotate';
      case 'PanTiltSpeed': return 'PositionMSpeed';
      case 'Zoom': case 'BeamAngle': return 'Zoom';
      case 'Focus': return 'Focus1';
      case 'Iris': return 'Iris';
      case 'Frost': return 'Frost1';
      case 'Prism': return 'Prism1';
      case 'PrismRotation': return 'Prism1PosRotate';
      case 'Effect': return 'Effects1';
      case 'EffectSpeed': return 'Effects1Rate';
      case 'Maintenance': return 'Control1';
      case 'Fog': case 'FogOutput': return 'Fog1';
      case 'NoFunction': return 'NoFeature';
      case 'WheelSlot': return wheelAttr[wheel] || null;
      case 'WheelRotation': return wheelAttr[wheel] ? `${wheelAttr[wheel]}WheelSpin` : null;
      case 'WheelShake': return wheelAttr[wheel] ? `${wheelAttr[wheel]}SelectShake` : null;
      case 'WheelSlotRotation':
        if (!wheelAttr[wheel]) return null;
        return cap.speed || cap.speedStart ? `${wheelAttr[wheel]}PosRotate` : `${wheelAttr[wheel]}Pos`;
      default: return null;
    }
  };

  // Channels. A fine channel is a further offset of its coarse channel, not
  // a channel of its own.
  const fineOf = new Map();
  Object.entries(profile.availableChannels || {}).forEach(([name, c]) => {
    (c.fineChannelAliases || []).forEach((alias, i) => {
      fineOf.set(alias, { coarse: name, level: i + 1 });
    });
  });
  const geometryFor = (attribute) => {
    if (!mover) return top.name;
    if (attribute === 'Pan' || attribute === 'PanRotate') return 'Yoke';
    return 'Head';
  };
  let untranslated = 0;

  const available = profile.availableChannels || {};
  const resolutionOf = (def) => ({ '8bit': 1, '16bit': 2, '24bit': 3 }[(def || {}).dmxValueResolution] || 1);

  /** One OFL channel's capabilities as GDTF channel functions. */
  // The lens range a percentage zoom is a share of: the profile's, or the
  // range a head is drawn with when it states none.
  const zoomRange = lens || [10, 25];

  /** One function, with the fields every function carries. */
  const makeFunction = (name, attribute, original, from, resolution, physicalFrom, physicalTo) => ({
    name,
    attribute,
    originalAttribute: original,
    // Shifted, not mirrored: an OFL range written in 8 bits on a 16-bit
    // channel is a range of the coarse byte, so 64 starts at 64 x 256.
    dmxFromWritten: { value: from, bytes: resolution, shift: true },
    defaultWritten: { value: 0, bytes: 1, shift: false },
    physicalFrom,
    physicalTo,
    realFade: 0,
    realAcceleration: 0,
    wheel: null,
    emitter: null,
    filter: null,
    colorSpace: null,
    gamut: null,
    dmxProfile: null,
    modeMaster: null,
    modeFromWritten: null,
    modeToWritten: null,
    min: physicalFrom,
    max: physicalTo,
    customName: '',
    sets: [],
  });

  /**
   * One OFL channel's capabilities as GDTF channel functions.
   *
   * Each function keeps what OFL said in `ofl`: the capability's type, its
   * values at both ends of its range from Beam's own capability parser, and
   * which of them were stated in their own unit. OFL describes things GDTF
   * has no field for -- a shutter's random timing, a shake on the slot rather
   * than the wheel, a preset's colour -- and a translated fixture must behave
   * exactly as the profile always did. Values are linear across a range, so
   * the two ends are the whole of it.
   *
   * A gap between ranges is a function with no feature, so each range ends
   * where the profile says rather than running on to the next.
   */
  const functionsFor = (def, key) => {
    const resolution = resolutionOf(def);
    const highest = 256 ** resolution - 1;
    const single = def.capability ? [{ ...def.capability, dmxRange: [0, highest] }] : [];
    const caps = [...(def.capabilities || single)]
      .sort((a, b) => (a.dmxRange || [0])[0] - (b.dmxRange || [0])[0]);
    const functions = [];
    let next = 0;
    caps.forEach((cap, i) => {
      const range = cap.dmxRange || [0, highest];
      if (range[0] > next) {
        functions.push(makeFunction('Unused', 'NoFeature', '', next, resolution, 0, 1));
      }
      const attribute = attributeOf(cap, key);
      if (!attribute) unmapped[cap.type] = (unmapped[cap.type] || 0) + 1;
      const parsed = new Capability(cap);
      const from = parsed.getValue(range[0]);
      const to = parsed.getValue(range[1]);
      const inUnit = {};
      Object.keys(parsed.entities).forEach((k) => { inUnit[k] = !!parsed.entities[k].inUnit; });
      const [physicalFrom, physicalTo] = primaryPhysical(cap.type, from, to, inUnit, zoomRange);
      const fn = makeFunction(
        cap.comment || `${key} ${i + 1}`,
        attribute || 'NoFeature',
        attribute ? '' : cap.type,
        range[0],
        resolution,
        physicalFrom,
        physicalTo,
      );
      // `channel` is the OFL channel's own name, which the head knows its
      // wheels by and reads a prism's facets from.
      fn.ofl = {
        type: cap.type, from, to, inUnit, comment: cap.comment || '', channel: key,
      };
      if (cap.type && cap.type.startsWith('Wheel')) fn.wheel = firstWheel(cap) || key;
      if (cap.type === 'WheelSlot' && cap.slotNumber !== undefined) {
        fn.sets.push({
          name: '',
          dmxFromWritten: fn.dmxFromWritten,
          physicalFrom: null,
          physicalTo: null,
          wheelSlotIndex: Math.floor(Number(cap.slotNumber)),
        });
      }
      functions.push(fn);
      next = range[1] + 1;
    });
    if (caps.length && next <= highest) {
      functions.push(makeFunction('Unused', 'NoFeature', '', next, resolution, 0, 1));
    }
    return functions;
  };

  // OFL's switching channels: a mode lists an alias whose meaning depends on
  // another channel's value. That is GDTF's mode master -- the alias becomes
  // one channel whose functions each apply over one range of the controller.
  const switching = new Map();
  Object.entries(available).forEach(([key, def]) => {
    (def.capabilities || []).forEach((cap) => {
      Object.entries(cap.switchChannels || {}).forEach(([alias, target]) => {
        if (!switching.has(alias)) switching.set(alias, { controller: key, choices: [] });
        switching.get(alias).choices.push({ range: cap.dmxRange || [0, 255], target });
      });
    });
  });

  const modes = (profile.modes || []).map((mode) => {
    const position = new Map();
    (mode.channels || []).forEach((key, i) => {
      if (typeof key === 'string') position.set(key, i + 1);
      else if (key && typeof key === 'object') untranslated += 1;
    });
    const channels = [];
    const names = new Set();
    const nameOf = new Map();
    // GDTF names a channel by its geometry and attribute. A translated profile
    // can repeat that pair -- a flattened pixel grid has a red per pixel --
    // so a repeat takes its OFL name as well.
    const uniqueName = (geometry, attribute, key) => {
      let name = `${geometry}_${attribute}`;
      if (names.has(name)) name = `${name}_${key}`;
      names.add(name);
      return name;
    };
    const addChannel = (key, offset, functions, def) => {
      const offsets = [offset];
      (def.fineChannelAliases || []).forEach((alias) => {
        if (position.has(alias)) offsets.push(position.get(alias));
      });
      const attribute = (functions[0] || {}).attribute || 'NoFeature';
      const geometry = geometryFor(attribute);
      const name = uniqueName(geometry, attribute, key);
      nameOf.set(key, name);
      channels.push({
        name,
        dmxBreak: 1,
        offsets,
        bytes: offsets.length,
        initialFunctionWritten: null,
        highlightWritten: def.highlightValue !== undefined
          ? { value: Number(def.highlightValue) || 0, bytes: resolutionOf(def), shift: false }
          : null,
        geometry,
        logicalChannels: [{
          attribute, snap: 'No', master: 'None', mibFade: 0, dmxChangeTimeLimit: 0, functions,
        }],
      });
    };

    // An empty slot is an address the fixture occupies and ignores. GDTF
    // writes that as a channel with no feature, which keeps the footprint.
    (mode.channels || []).forEach((key, i) => {
      if (key !== null) return;
      const name = uniqueName(top.name, 'NoFeature', i + 1);
      channels.push({
        name,
        dmxBreak: 1,
        offsets: [i + 1],
        bytes: 1,
        initialFunctionWritten: null,
        highlightWritten: null,
        geometry: top.name,
        logicalChannels: [{
          attribute: 'NoFeature',
          snap: 'No',
          master: 'None',
          mibFade: 0,
          dmxChangeTimeLimit: 0,
          functions: [{
            ...functionsFor({ capability: { type: 'NoFunction' } }, name)[0], name: 'Unused',
          }],
        }],
      });
    });

    const switched = [];
    position.forEach((offset, key) => {
      if (fineOf.has(key)) return;
      if (switching.has(key) && !available[key]) {
        switched.push([key, offset]);
        return;
      }
      const def = available[key];
      if (!def) {
        untranslated += 1;
        return;
      }
      addChannel(key, offset, functionsFor(def, key), def);
    });
    // After the others, so each controller already has its GDTF name.
    switched.forEach(([key, offset]) => {
      const { controller, choices } = switching.get(key);
      const master = nameOf.get(controller);
      // The controller's ranges are of its coarse byte, whatever its width
      // in this mode: 0-51 on a 16-bit controller is 0 to 51 x 256 + 255.
      const masterChannel = channels.find((c) => c.name === master);
      const masterBytes = masterChannel ? masterChannel.bytes : 1;
      const unit = 256 ** (masterBytes - 1);
      const functions = [];
      choices.forEach(({ range, target }) => {
        const def = available[target];
        if (!def) return;
        functionsFor(def, target).forEach((f) => functions.push({
          ...f,
          modeMaster: master ? [master] : null,
          modeFromWritten: { value: range[0] * unit, bytes: masterBytes, shift: false },
          modeToWritten: { value: (range[1] + 1) * unit - 1, bytes: masterBytes, shift: false },
        }));
      });
      if (!master) notes.push(`switching channel "${key}" has no controller in mode "${mode.name}"`);
      addChannel(key, offset, functions, {});
    });
    return {
      name: mode.name, description: mode.shortName || '', geometry: top.name, channels, relations: [], macroCount: 0,
    };
  });
  if (untranslated) notes.push(`${untranslated} matrix or template channel(s) not translated`);
  Object.entries(unmapped).forEach(([type, n]) => notes.push(`${n} ${type} capabilit${n === 1 ? 'y' : 'ies'} without a GDTF attribute`));

  const used = new Set(['NoFeature']);
  modes.forEach((m) => m.channels.forEach((c) => c.logicalChannels.forEach((l) => {
    l.functions.forEach((f) => used.add(f.attribute));
  })));
  const type = {
    dataVersion: null,
    source: 'ofl',
    name: ofl.name,
    shortName: ofl.shortName || '',
    longName: ofl.name,
    manufacturer,
    description: '',
    fixtureTypeId: null,
    refFT: null,
    thumbnail: null,
    canHaveChildren: true,
    attributeDefinitions: {
      activationGroups: [],
      featureGroups: [],
      attributes: [...used].map((name) => ({
        name,
        pretty: name,
        activationGroup: null,
        feature: null,
        mainAttribute: null,
        physicalUnit: physicalUnitOf(name),
        color: null,
        subPhysicalUnits: [],
      })),
    },
    wheels,
    physical: {
      emitters: [],
      filters: [],
      colorSpace: null,
      additionalColorSpaces: [],
      gamuts: [],
      dmxProfiles: [],
      cris: [],
      connectors: physical.DMXconnector ? [{
        name: physical.DMXconnector, type: physical.DMXconnector, dmxBreak: 1, gender: 0, length: 0,
      }] : [],
      properties: {
        operatingTemperature: null,
        weight: physical.weight || null,
        legHeight: null,
        powerConsumption: physical.power ? [{
          value: physical.power,
          powerFactor: 1,
          connector: null,
          voltageLow: null,
          voltageHigh: null,
          frequencyLow: null,
          frequencyHigh: null,
        }] : [],
      },
    },
    models,
    geometries: [top],
    modes,
    revisions: [],
    rdm: ofl.rdm ? {
      manufacturerId: null,
      deviceModelId: ofl.rdm.modelId !== undefined ? String(ofl.rdm.modelId) : null,
    } : null,
  };
  const problems = completeFixtureType(type);
  return { fixtureType: type, notes, problems };
}
