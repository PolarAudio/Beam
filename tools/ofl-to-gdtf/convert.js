/* eslint-disable no-console */
/**
 * @file The converter behind tools/ofl-to-gdtf.mjs, bundled and run by it.
 *
 * Translates an OFL profile with Beam's own translation and writes the result
 * as GDTF 1.2 XML. Two things are added that the translation does not carry
 * in GDTF form: names from the profile (slot names, split colours, strobe
 * ranges), and the slot each wheel-shake range shakes. Anything the profile
 * does not state is left out or written as the translation fills it in;
 * speeds and strobe rates OFL gives only as keywords stay at the
 * translation's stand-in numbers.
 *
 * The written file is read back with Beam's GDTF reader and every mode,
 * channel, function range, physical value, wheel and slot is compared with
 * the translation. Exits non-zero on any difference.
 *
 * Arguments: <profile.json> <manufacturers.json> <key> <out folder>
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import translateOfl from '@/models/DMX/gdtf/ofl_to_gdtf';
import readGdtf from '@/models/DMX/gdtf/gdtf_reader';
import { standardPretty } from '@/models/DMX/gdtf/standard_attributes';

const [profilePath, manufacturersPath, key, outDir] = process.argv.slice(2);
const ofl = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const makerKey = key.split('/')[0];
const manufacturer = (JSON.parse(fs.readFileSync(manufacturersPath, 'utf8'))[makerKey] || {}).name || makerKey;

const { fixtureType: t, notes, problems } = translateOfl(ofl, { manufacturer });
if (problems.length) {
  console.error(`translation problems: ${problems.join('; ')}`);
  process.exit(1);
}

/** Translated attributes that GDTF has a more specific name for. */
const RENAME = { Control1: 'FixtureGlobalReset' };
const attrName = (a) => RENAME[a] || a;

/**
 * Each attribute's feature, activation group and main attribute, as GDTF's
 * attribute list gives them. An attribute missing here stops the tool rather
 * than being written without a feature. Pretty names are the spec's, so a
 * name in the file is only the author's own once someone changes it.
 */
const FEATURES = {
  Pan: ['Position.PanTilt', 'PanTilt', null],
  Tilt: ['Position.PanTilt', 'PanTilt', null],
  PanRotate: ['Position.PanTilt', null, 'Pan'],
  TiltRotate: ['Position.PanTilt', null, 'Tilt'],
  PositionMSpeed: ['Control.Control', null, null],
  Dimmer: ['Dimmer.Dimmer', null, null],
  Shutter1: ['Beam.Beam', null, null],
  Shutter1Strobe: ['Beam.Beam', null, 'Shutter1'],
  Shutter1StrobePulse: ['Beam.Beam', null, 'Shutter1'],
  Shutter1StrobePulseOpen: ['Beam.Beam', null, 'Shutter1'],
  Shutter1StrobePulseClose: ['Beam.Beam', null, 'Shutter1'],
  Shutter1StrobeEffect: ['Beam.Beam', null, 'Shutter1'],
  StrobeRate: ['Beam.Beam', null, null],
  StrobeDuration: ['Beam.Beam', null, null],
  Zoom: ['Focus.Focus', null, null],
  Focus1: ['Focus.Focus', null, null],
  Iris: ['Beam.Beam', null, null],
  Frost1: ['Beam.Beam', null, null],
  Prism1: ['Beam.Beam', 'Prism', null],
  Prism1PosRotate: ['Beam.Beam', 'Prism', 'Prism1'],
  ColorAdd_R: ['Color.RGB', 'ColorRGB', null],
  ColorAdd_G: ['Color.RGB', 'ColorRGB', null],
  ColorAdd_B: ['Color.RGB', 'ColorRGB', null],
  ColorAdd_W: ['Color.RGB', 'ColorRGB', null],
  ColorMacro1: ['Color.Color', null, null],
  CTC: ['Color.Color', null, null],
  Color1: ['Color.Color', null, null],
  Color1WheelSpin: ['Color.Color', null, 'Color1'],
  Gobo1: ['Gobo.Gobo', 'Gobo1', null],
  Gobo1SelectShake: ['Gobo.Gobo', 'Gobo1', 'Gobo1'],
  Gobo1WheelSpin: ['Gobo.Gobo', 'Gobo1', 'Gobo1'],
  Gobo1Pos: ['Gobo.Gobo', 'Gobo1', 'Gobo1'],
  Gobo1PosRotate: ['Gobo.Gobo', 'Gobo1', 'Gobo1'],
  Effects1: ['Control.Control', null, null],
  Effects1Rate: ['Control.Control', null, 'Effects1'],
  FixtureGlobalReset: ['Control.Control', null, null],
};

const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const num = (n) => String(Math.round(n * 1e6) / 1e6);
const attrs = (o) => Object.entries(o)
  .filter(([, v]) => v !== null && v !== undefined)
  .map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
const lowered = (z) => `{1,0,0,0}{0,1,0,0}{0,0,1,${num(z)}}{0,0,0,1}`;

// --- names from the profile ---------------------------------------------------

const slotName = (wheel, n) => {
  const { slots } = ofl.wheels[wheel];
  const s = slots[(n - 1) % slots.length];
  return s.name || s.type;
};

/** The OFL capability a translated function came from. */
const capOf = (fn) => {
  const def = ofl.availableChannels[fn.ofl.channel];
  const caps = def.capabilities || [{ ...def.capability, dmxRange: [0, 255] }];
  return caps.find((c) => (c.dmxRange || [0])[0] === fn.dmxFromWritten.value) || {};
};

function functionName(fn) {
  const cap = capOf(fn);
  switch (cap.type) {
    case 'Pan': return 'Pan';
    case 'Tilt': return 'Tilt';
    case 'Intensity': return 'Dimmer';
    case 'PanTiltSpeed':
      return cap.speedStart ? `Pan/Tilt speed ${cap.speedStart}-${cap.speedEnd}` : 'Pan/Tilt speed';
    case 'WheelSlot': {
      const n = Number(cap.slotNumber);
      if (!fn.wheel || !ofl.wheels[fn.wheel] || !Number.isFinite(n)) return cap.comment || fn.name;
      return Number.isInteger(n)
        ? slotName(fn.wheel, n)
        : `${slotName(fn.wheel, Math.floor(n))} / ${slotName(fn.wheel, Math.floor(n) + 1)}`;
    }
    case 'WheelShake':
      return fn.wheel && ofl.wheels[fn.wheel] && cap.slotNumber !== undefined
        ? `${slotName(fn.wheel, Number(cap.slotNumber))} shake`
        : cap.comment || fn.name;
    case 'ShutterStrobe':
      if (cap.shutterEffect === 'Open' || cap.shutterEffect === 'Closed') return cap.shutterEffect;
      if (cap.speedStart) return `${cap.shutterEffect} ${cap.speedStart}-${cap.speedEnd}`;
      return cap.comment || cap.shutterEffect || fn.name;
    case 'Effect':
      return cap.effectName ? `${cap.effectName}${cap.soundControlled ? ' (sound)' : ''}` : cap.comment || fn.name;
    case 'NoFunction': return cap.comment || 'No function';
    default: return cap.comment || fn.name;
  }
}

/** The slot a shake range shakes, when the profile names one. */
const shakeSlot = (fn) => {
  if (!fn.ofl || fn.ofl.type !== 'WheelShake') return null;
  const n = Number(capOf(fn).slotNumber);
  return Number.isInteger(n) ? n : null;
};

// --- XML ----------------------------------------------------------------------

const used = new Set();
t.modes.forEach((m) => m.channels.forEach((c) => c.logicalChannels.forEach((l) => {
  l.functions.forEach((f) => { if (f.attribute !== 'NoFeature') used.add(attrName(f.attribute)); });
})));
const unknown = [...used].filter((a) => !FEATURES[a]);
if (unknown.length) {
  console.error(`no GDTF feature listed for ${unknown.join(', ')}: add them to FEATURES`);
  process.exit(1);
}

const groups = new Map();
used.forEach((a) => {
  const [group, feature] = FEATURES[a][0].split('.');
  if (!groups.has(group)) groups.set(group, new Set());
  groups.get(group).add(feature);
});
const activation = [...new Set([...used].map((a) => FEATURES[a][1]).filter(Boolean))];
const physicalUnit = (a) => {
  const def = t.attributeDefinitions.attributes.find((d) => attrName(d.name) === a);
  return def ? def.physicalUnit : 'None';
};

const x = [];
const fixtureTypeId = crypto.randomUUID().toUpperCase();
x.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
x.push('<GDTF DataVersion="1.2">');
x.push(`  <FixtureType${attrs({
  Name: t.name,
  ShortName: t.shortName,
  LongName: t.longName,
  Manufacturer: t.manufacturer,
  Description: `Generated by Beatline Beam from the Open Fixture Library profile ${key}. No 3D model; speeds and strobe rates the profile gives as keywords are stand-in values, not measurements.`,
  FixtureTypeID: fixtureTypeId,
  RefFT: '',
  Thumbnail: '',
  CanHaveChildren: 'Yes',
})}>`);

x.push('    <AttributeDefinitions>');
x.push('      <ActivationGroups>');
activation.forEach((a) => x.push(`        <ActivationGroup Name="${a}"/>`));
x.push('      </ActivationGroups>');
x.push('      <FeatureGroups>');
groups.forEach((features, group) => {
  x.push(`        <FeatureGroup Name="${group}" Pretty="${group}">`);
  features.forEach((f) => x.push(`          <Feature Name="${f}"/>`));
  x.push('        </FeatureGroup>');
});
x.push('      </FeatureGroups>');
x.push('      <Attributes>');
used.forEach((a) => {
  const [feature, group, main] = FEATURES[a];
  const pretty = standardPretty(a) || a;
  x.push(`        <Attribute${attrs({
    Name: a,
    Pretty: pretty,
    ActivationGroup: group,
    Feature: feature,
    MainAttribute: main,
    PhysicalUnit: physicalUnit(a),
  })}/>`);
});
x.push('      </Attributes>');
x.push('    </AttributeDefinitions>');

x.push('    <Wheels>');
t.wheels.forEach((w) => {
  x.push(`      <Wheel Name="${esc(w.name)}">`);
  w.slots.forEach((s) => {
    const color = s.color ? `${num(s.color.x)},${num(s.color.y)},${num(s.color.Y)}` : null;
    x.push(`        <Slot${attrs({ Name: s.name, Color: color })}/>`);
  });
  x.push('      </Wheel>');
});
x.push('    </Wheels>');

const props = t.physical.properties;
x.push('    <PhysicalDescriptions>');
x.push('      <Emitters/>');
x.push('      <Filters/>');
x.push('      <ColorSpace Mode="sRGB"/>');
x.push('      <DMXProfiles/>');
x.push('      <CRIs/>');
x.push('      <Connectors>');
/** OFL's connector names as GDTF's connector types. */
const CONNECTORS = { '3-pin': 'XLR3', '5-pin': 'XLR5' };
t.physical.connectors.forEach((c) => x.push(`        <Connector${attrs({
  Name: c.name, Type: CONNECTORS[c.type] || c.type, DMXBreak: 1, Gender: 0, Length: 0,
})}/>`));
x.push('      </Connectors>');
x.push('      <Properties>');
if (props.weight) x.push(`        <Weight Value="${num(props.weight)}"/>`);
props.powerConsumption.forEach((p) => x.push(`        <PowerConsumption Value="${num(p.value)}" PowerFactor="1"/>`));
x.push('      </Properties>');
x.push('    </PhysicalDescriptions>');

x.push('    <Models>');
t.models.forEach((m) => x.push(`      <Model${attrs({
  Name: m.name, Length: num(m.length), Width: num(m.width), Height: num(m.height), PrimitiveType: m.primitiveType, File: '',
})}/>`));
x.push('    </Models>');

// GDTF draws a fixture hanging: a mover's yoke below its base, the head
// between the yoke's arms, the beam leaving downwards (-Z).
const modelOf = (name) => t.models.find((m) => m.name === name);
let beamGeometry = null;
const findBeam = (g) => {
  if (g.type === 'Beam') beamGeometry = g;
  g.children.forEach(findBeam);
};
t.geometries.forEach(findBeam);
const b = beamGeometry.beam;
const beamAttrs = (z) => {
  const out = {
    Name: beamGeometry.name,
    Position: lowered(z),
    LampType: b.lampType,
    BeamRadius: num(b.beamRadius),
  };
  b.explicit.forEach((k) => { out[k] = num(b[k[0].toLowerCase() + k.slice(1)]); });
  return out;
};
x.push('    <Geometries>');
if (modelOf('Yoke')) {
  const base = modelOf('Base');
  const yoke = modelOf('Yoke');
  const head = modelOf('Head');
  x.push(`      <Geometry Name="Base" Model="Base" Position="${lowered(0)}">`);
  x.push(`        <Axis Name="Yoke" Model="Yoke" Position="${lowered(-base.height / 2 - yoke.height / 2)}">`);
  x.push(`          <Axis Name="Head" Model="Head" Position="${lowered(-yoke.height * 0.2)}">`);
  x.push(`            <Beam${attrs(beamAttrs(-head.height / 2))}/>`);
  x.push('          </Axis>');
  x.push('        </Axis>');
  x.push('      </Geometry>');
} else {
  const body = modelOf('Body');
  x.push(`      <Geometry Name="Body" Model="Body" Position="${lowered(0)}">`);
  x.push(`        <Beam${attrs(beamAttrs(-body.height / 2))}/>`);
  x.push('      </Geometry>');
}
x.push('    </Geometries>');

/** A mode's channels by address, those without one last. */
const placeOf = (c) => (c.offsets ? c.offsets[0] : Number.MAX_SAFE_INTEGER);
const byPlace = (list) => [...list].sort((p, q) => placeOf(p) - placeOf(q));

/** Each translated channel's name as the file names it, by mode. */
const fileChannelName = new Map();
x.push('    <DMXModes>');
t.modes.forEach((mode) => {
  x.push(`      <DMXMode${attrs({ Name: mode.name, Description: mode.description, Geometry: mode.geometry })}>`);
  x.push('        <DMXChannels>');
  const names = new Map();
  mode.channels.forEach((c) => {
    const l = c.logicalChannels[0];
    const logical = attrName((l.functions.find((f) => f.attribute !== 'NoFeature') || l.functions[0]).attribute);
    let name = `${c.geometry}_${logical}`;
    if ([...names.values()].includes(name)) name = `${name}_${c.offsets ? c.offsets[0] : 'virtual'}`;
    names.set(c, name);
    fileChannelName.set(`${mode.name}|${c.name}`, name);
  });
  byPlace(mode.channels).forEach((c) => {
    const l = c.logicalChannels[0];
    const logical = attrName((l.functions.find((f) => f.attribute !== 'NoFeature') || l.functions[0]).attribute);
    const taken = new Set();
    const fnNames = l.functions.map((f) => {
      let name = f.ofl ? functionName(f) : f.name;
      while (taken.has(name)) name = `${name} 2`;
      taken.add(name);
      return name;
    });
    x.push(`          <DMXChannel${attrs({
      DMXBreak: 1,
      // A channel without an address -- a lens wound by hand -- is virtual.
      Offset: c.offsets ? c.offsets.join(',') : 'None',
      Highlight: c.highlight !== null && c.highlight !== undefined ? `${c.highlight}/${c.bytes}` : 'None',
      Geometry: c.geometry,
      InitialFunction: `${names.get(c)}.${logical}.${fnNames[0]}`,
    })}>`);
    x.push(`            <LogicalChannel Attribute="${logical}" Snap="No" Master="None" MibFade="0" DMXChangeTimeLimit="0">`);
    l.functions.forEach((f, i) => {
      const master = f.modeMaster ? mode.channels.find((m) => m.name === f.modeMaster[0]) : null;
      const fa = {
        Name: fnNames[i],
        Attribute: attrName(f.attribute),
        OriginalAttribute: f.originalAttribute || '',
        DMXFrom: `${f.dmxFrom}/${c.bytes}`,
        Default: `${f.default}/${c.bytes}`,
        PhysicalFrom: num(f.physicalFrom),
        PhysicalTo: num(f.physicalTo),
        RealFade: 0,
        RealAcceleration: 0,
        Wheel: f.wheel,
        ModeMaster: master ? names.get(master) : null,
        ModeFrom: master ? `${f.modeFrom}/${master.bytes}` : null,
        ModeTo: master ? `${f.modeTo}/${master.bytes}` : null,
      };
      const sets = f.sets.map((s) => ({ dmxFrom: s.dmxFrom, wheelSlotIndex: s.wheelSlotIndex }));
      const shake = shakeSlot(f);
      if (shake) sets.push({ dmxFrom: f.dmxFrom, wheelSlotIndex: shake });
      if (!sets.length) {
        x.push(`              <ChannelFunction${attrs(fa)}/>`);
        return;
      }
      x.push(`              <ChannelFunction${attrs(fa)}>`);
      sets.forEach((s) => x.push(`                <ChannelSet${attrs({
        Name: fnNames[i], DMXFrom: `${s.dmxFrom}/${c.bytes}`, WheelSlotIndex: s.wheelSlotIndex,
      })}/>`));
      x.push('              </ChannelFunction>');
    });
    x.push('            </LogicalChannel>');
    x.push('          </DMXChannel>');
  });
  x.push('        </DMXChannels>');
  x.push('        <Relations/>');
  x.push('        <FTMacros/>');
  x.push('      </DMXMode>');
});
x.push('    </DMXModes>');
x.push('    <Revisions>');
x.push(`      <Revision Text="Generated from the OFL profile by Beatline Beam" Date="${new Date().toISOString().slice(0, 19)}" UserID="0" ModifiedBy="Beatline Beam"/>`);
x.push('    </Revisions>');
x.push('    <FTPresets/>');
x.push('    <Protocols/>');
x.push('  </FixtureType>');
x.push('</GDTF>');

const fileSafe = (s) => String(s).replace(/[<>:"/\\|?*@\s]+/g, '_');
const outPath = path.join(outDir, `${fileSafe(t.manufacturer)}@${fileSafe(t.name)}@Beam_from_OFL.gdtf`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, zipSync({ 'description.xml': strToU8(`${x.join('\n')}\n`) }));
console.log(`wrote ${outPath}`);
console.log(`FixtureTypeID ${fixtureTypeId}`);
console.log(`translation notes: ${notes.join('; ')}`);

// --- read back and compare -----------------------------------------------------

const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');
const back = readGdtf(fs.readFileSync(outPath), { parseXml });
if (back.problems.length) console.log(`reader problems: ${back.problems.join('; ')}`);
const r = back.fixtureType;
let diffs = back.problems.length;
const same = (label, a, z) => {
  if (JSON.stringify(a) === JSON.stringify(z)) return;
  diffs += 1;
  console.log(`DIFF ${label}: translation ${JSON.stringify(a)} file ${JSON.stringify(z)}`);
};
same('modes', t.modes.map((m) => m.name), r.modes.map((m) => m.name));
t.modes.forEach((m, mi) => {
  const tc = byPlace(m.channels);
  const rc = byPlace(r.modes[mi].channels);
  same(`${m.name} channel count`, tc.length, rc.length);
  tc.forEach((c, ci) => {
    const d = rc[ci] || { logicalChannels: [{ functions: [] }] };
    const label = `${m.name} ${c.offsets ? `offset ${c.offsets.join(',')}` : `virtual ${c.name}`}`;
    same(`${label} geometry`, c.geometry, d.geometry);
    same(`${label} bytes`, c.bytes, d.bytes);
    const tf = c.logicalChannels[0].functions;
    const rf = d.logicalChannels[0].functions;
    same(`${label} function count`, tf.length, rf.length);
    const fnKey = (h, master) => [
      attrName(h.attribute), h.dmxFrom, h.dmxTo,
      Number(num(h.physicalFrom)), Number(num(h.physicalTo)),
      h.wheel, master, h.modeFrom, h.modeTo,
    ];
    tf.forEach((f, fi) => {
      const g = rf[fi] || { sets: [] };
      const master = f.modeMaster ? fileChannelName.get(`${m.name}|${f.modeMaster[0]}`) : null;
      same(`${label} function ${fi}`, fnKey(f, master), fnKey(g, g.modeMaster ? g.modeMaster[0] : null));
      const slots = f.sets.map((s) => s.wheelSlotIndex);
      if (shakeSlot(f)) slots.push(shakeSlot(f));
      same(`${label} function ${fi} slots`, slots, g.sets.map((s) => s.wheelSlotIndex));
    });
  });
});
const wheelSlots = (type) => type.wheels.map((w) => [w.name, w.slots.map((s) => s.name)]);
same('wheels', wheelSlots(t), wheelSlots(r));
let beamBack = null;
const findBeamBack = (g) => {
  if (g.type === 'Beam') beamBack = g.beam;
  g.children.forEach(findBeamBack);
};
r.geometries.forEach(findBeamBack);
const photometry = (p) => [
  p.luminousFlux, p.powerConsumption, p.beamAngle, p.fieldAngle, p.lampType,
];
same('beam', photometry(b), photometry(beamBack));
if (diffs) {
  console.log(`${diffs} difference(s) between the file and the translation`);
  process.exit(1);
}
console.log('read back: the file matches the translation');
