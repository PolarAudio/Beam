/* eslint-disable no-console */
/**
 * @file Writes the Wicked Lasers fixtures Beam ships as GDTF 1.2 files.
 *
 * Each file has the body as a Model, a Laser geometry with the optics, and
 * one mode in which every control is a channel: Fixed and Adjustable ones
 * are virtual (no DMX offset), as a lens focused by hand is. The LaserCube
 * bodies are `LaserCube Pro 2.5W.glb`, `LaserCube 7.5 Ultra.glb` and their
 * wide-angle versions with the lens fitted. All are measured off the units and
 * drawn in millimetres, Y up, the origin on the aperture's optical axis 20 mm
 * behind the chassis front. Each is written into its file in metres, in the
 * chassis colour, as both glTF and 3DS.
 *
 * Usage:
 *   node tools/gdtf/wicked-lasers.mjs
 *
 * Writes `public/profiles/Wicked Lasers/*.gdtf`.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { zipSync, strToU8 } from 'fflate';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const outDir = path.join(root, 'public', 'profiles', 'Wicked Lasers');

/** The chassis colour: dark grey, close to black. */
const BODY_COLOUR = '#252627';

/**
 * How each control is set on these lasers: the output stage is fixed at full,
 * and only the mounting flips are left to set by hand.
 */
const CONTROLS = {
  dimmer: { mode: 'fixed', value: 100 },
  shutter: { mode: 'fixed', value: true },
  red: { mode: 'fixed', value: 100 },
  green: { mode: 'fixed', value: 100 },
  blue: { mode: 'fixed', value: 100 },
  xScale: { mode: 'fixed', value: 100 },
  yScale: { mode: 'fixed', value: 100 },
  xPos: { mode: 'fixed', value: 0 },
  yPos: { mode: 'fixed', value: 0 },
  mirrorX: { mode: 'adjustable', value: false },
  mirrorY: { mode: 'adjustable', value: false },
};

/**
 * Each control's GDTF attribute, its feature, its physical range in Beam's
 * units, and its name in a channel function. Matches `gdtf/laser_parts.js`.
 */
const ATTRIBUTES = {
  dimmer: {
    name: 'Dimmer', pretty: 'Dim', feature: 'Dimmer.Dimmer', range: [0, 100], fn: 'Dimmer',
  },
  shutter: {
    name: 'Shutter1', pretty: 'Sh1', feature: 'Beam.Beam', range: [0, 1], fn: 'Open',
  },
  red: {
    name: 'ColorAdd_R', pretty: 'R', feature: 'Color.RGB', range: [0, 100], fn: 'Red Balance',
  },
  green: {
    name: 'ColorAdd_G', pretty: 'G', feature: 'Color.RGB', range: [0, 100], fn: 'Green Balance',
  },
  blue: {
    name: 'ColorAdd_B', pretty: 'B', feature: 'Color.RGB', range: [0, 100], fn: 'Blue Balance',
  },
  xScale: {
    name: 'LaserScaleX', pretty: 'X Scale', feature: 'Laser.Laser', range: [0, 100], fn: 'X Scale',
  },
  yScale: {
    name: 'LaserScaleY', pretty: 'Y Scale', feature: 'Laser.Laser', range: [0, 100], fn: 'Y Scale',
  },
  xPos: {
    name: 'LaserPositionX', pretty: 'X Pos', feature: 'Laser.Laser', range: [-100, 100], fn: 'X Position',
  },
  yPos: {
    name: 'LaserPositionY', pretty: 'Y Pos', feature: 'Laser.Laser', range: [-100, 100], fn: 'Y Position',
  },
  mirrorX: {
    name: 'LaserMirrorX', pretty: 'Mirror X', feature: 'Laser.Laser', range: [0, 1], fn: 'Mirror X',
  },
  mirrorY: {
    name: 'LaserMirrorY', pretty: 'Mirror Y', feature: 'Laser.Laser', range: [0, 1], fn: 'Mirror Y',
  },
};

/**
 * Wicked Lasers' wide-angle lens: it multiplies the scan angle and the beam
 * divergence. An estimate, not a published figure.
 */
const WIDE_LENS = 4.5;

/** The four models. A Wide Angle is the laser behind the wide-angle lens. */
const LASERS = [
  {
    name: 'LaserCube Pro 2.5W',
    id: '6E1B2A4C-3F5D-4B8E-9C21-7A0F4D3E2B11',
    power: 2.5,
    scan: 32,
    beamDiameter: 0.003,
    divergence: 1,
    body: { source: 'LaserCube Pro 2.5W.glb', stem: 'LaserCube Pro' },
  },
  {
    name: 'LaserCube Pro 2.5W Wide Angle',
    id: '6E1B2A4C-3F5D-4B8E-9C21-7A0F4D3E2B12',
    power: 2.5,
    scan: 32 * WIDE_LENS,
    beamDiameter: 0.0015,
    divergence: 1 * WIDE_LENS,
    body: { source: 'LaserCube Pro 2.5W Wide.glb', stem: 'LaserCube Pro Wide Angle' },
  },
  {
    // Wicked Lasers' figures: 37 degree scan, 4 mm beam, 1 mrad.
    name: 'LaserCube Ultra 7.5W',
    id: '6E1B2A4C-3F5D-4B8E-9C21-7A0F4D3E2B13',
    power: 7.5,
    scan: 37,
    beamDiameter: 0.004,
    divergence: 1,
    body: { source: 'LaserCube 7.5 Ultra.glb', stem: 'LaserCube Ultra' },
  },
  {
    name: 'LaserCube Ultra 7.5W Wide Angle',
    id: '6E1B2A4C-3F5D-4B8E-9C21-7A0F4D3E2B14',
    power: 7.5,
    scan: 37 * WIDE_LENS,
    beamDiameter: 0.004,
    divergence: 1 * WIDE_LENS,
    body: { source: 'LaserCube 7.5 Ultra wide.glb', stem: 'LaserCube Ultra Wide Angle' },
  },
];

const num = (v) => String(Math.round(v * 1e6) / 1e6);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const attrs = (o) => Object.entries(o).filter(([, v]) => v !== null && v !== undefined)
  .map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
const matrix = (rows) => rows.map((r) => `{${r.map(num).join(',')}}`).join('');

/* ------------------------------------------------------------ the mesh */

/**
 * A glTF binary's one mesh as triangles in metres, Z up:
 * `{ positions, normals }`, three vertices per triangle. Read as drawn: in
 * millimetres, Y up, so (x, y, z) becomes (x, -z, y) / 1000.
 */
function readGlb(file) {
  const bytes = fs.readFileSync(file);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.slice(20, 20 + jsonLength).toString('utf8'));
  const bin = bytes.slice(20 + jsonLength + 8);
  const primitive = json.meshes[0].primitives[0];
  const view = (index, Type, width) => {
    const accessor = json.accessors[index];
    const bufferView = json.bufferViews[accessor.bufferView];
    const start = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
    const copy = bin.slice(start, start + accessor.count * width * Type.BYTES_PER_ELEMENT);
    return new Type(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.length));
  };
  const p = view(primitive.attributes.POSITION, Float32Array, 3);
  const n = view(primitive.attributes.NORMAL, Float32Array, 3);
  const indexAccessor = json.accessors[primitive.indices];
  const indices = indexAccessor.componentType === 5125
    ? view(primitive.indices, Uint32Array, 1) : view(primitive.indices, Uint16Array, 1);
  const positions = new Float32Array(indices.length * 3);
  const normals = new Float32Array(indices.length * 3);
  indices.forEach((v, i) => {
    positions[i * 3] = p[v * 3] / 1000;
    positions[i * 3 + 1] = -p[v * 3 + 2] / 1000;
    positions[i * 3 + 2] = p[v * 3 + 1] / 1000;
    normals[i * 3] = n[v * 3];
    normals[i * 3 + 1] = -n[v * 3 + 2];
    normals[i * 3 + 2] = n[v * 3 + 1];
  });
  return { positions, normals };
}

function bounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      min[a] = Math.min(min[a], positions[i + a]);
      max[a] = Math.max(max[a], positions[i + a]);
    }
  }
  return { min, max };
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * A binary glTF of one mesh in one material. glTF is Y up, so Z-up
 * (x, y, z) is written (x, z, -y).
 */
function glbOf({ positions, normals }, colour) {
  const count = positions.length / 3;
  const pos = new Float32Array(positions.length);
  const nor = new Float32Array(normals.length);
  for (let i = 0; i < count; i += 1) {
    const o = i * 3;
    pos[o] = positions[o]; pos[o + 1] = positions[o + 2]; pos[o + 2] = -positions[o + 1];
    nor[o] = normals[o]; nor[o + 1] = normals[o + 2]; nor[o + 2] = -normals[o + 1];
  }
  const b = bounds(pos);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(nor.buffer)]);
  const [r, g, bl] = rgbOf(colour).map((c) => srgbToLinear(c / 255));
  const json = {
    asset: { version: '2.0', generator: 'Beatline Beam' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Body' }],
    meshes: [{ name: 'Body', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
    materials: [{
      name: 'Body',
      pbrMetallicRoughness: {
        baseColorFactor: [r, g, bl, 1], metallicFactor: 0, roughnessFactor: 0.6,
      },
    }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      {
        buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962,
      },
      {
        buffer: 0, byteOffset: pos.byteLength, byteLength: nor.byteLength, target: 34962,
      },
    ],
    accessors: [
      {
        bufferView: 0, componentType: 5126, count, type: 'VEC3', min: b.min, max: b.max,
      },
      {
        bufferView: 1, componentType: 5126, count, type: 'VEC3',
      },
    ],
  };
  const pad = (buf, fill) => (buf.length % 4
    ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4), fill)]) : buf);
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const binChunk = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, jsonChunk), chunk(0x004e4942, binChunk)]);
}

/** A 3DS chunk: id, length including the 6-byte header, then the data. */
function chunk3ds(id, ...parts) {
  const data = Buffer.concat(parts);
  const h = Buffer.alloc(6);
  h.writeUInt16LE(id, 0);
  h.writeUInt32LE(6 + data.length, 2);
  return Buffer.concat([h, data]);
}

const cstring = (s) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from([0])]);

/** A 3DS file of one mesh in one material, Z up, metres. */
function tdsOf({ positions }, colour) {
  const count = positions.length / 3;
  const verts = Buffer.alloc(2 + count * 12);
  verts.writeUInt16LE(count, 0);
  for (let i = 0; i < count * 3; i += 1) verts.writeFloatLE(positions[i], 2 + i * 4);
  const faces = Buffer.alloc(2 + (count / 3) * 8);
  faces.writeUInt16LE(count / 3, 0);
  for (let f = 0; f < count / 3; f += 1) {
    const o = 2 + f * 8;
    faces.writeUInt16LE(f * 3, o);
    faces.writeUInt16LE(f * 3 + 1, o + 2);
    faces.writeUInt16LE(f * 3 + 2, o + 4);
    faces.writeUInt16LE(7, o + 6);
  }
  const faceList = Buffer.alloc(2 + (count / 3) * 2);
  faceList.writeUInt16LE(count / 3, 0);
  for (let f = 0; f < count / 3; f += 1) faceList.writeUInt16LE(f, 2 + f * 2);
  const rgb = Buffer.from(rgbOf(colour));
  const material = chunk3ds(
    0xafff,
    chunk3ds(0xa000, cstring('Body')),
    chunk3ds(0xa010, chunk3ds(0x0011, rgb)),
    chunk3ds(0xa020, chunk3ds(0x0011, rgb)),
    chunk3ds(0xa030, chunk3ds(0x0011, Buffer.from([20, 20, 20]))),
  );
  const mesh = chunk3ds(
    0x4100,
    chunk3ds(0x4110, verts),
    chunk3ds(0x4120, faces, chunk3ds(0x4130, cstring('Body'), faceList)),
  );
  const object = chunk3ds(0x4000, cstring('Body'), mesh);
  const version = chunk3ds(0x0002, Buffer.from([3, 0, 0, 0]));
  return chunk3ds(0x4d4d, version, chunk3ds(0x3d3d, material, object));
}

/* ---------------------------------------------------- the description */

/** A control's default as a DMX byte: its place in its range. */
function dmxOf(key, value) {
  const [lo, hi] = ATTRIBUTES[key].range;
  const v = Number(value);
  return Math.round(((v - lo) / (hi - lo)) * 255);
}

function description(laser, body) {
  const x = [];
  x.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  x.push('<GDTF DataVersion="1.2">');
  x.push(`  <FixtureType${attrs({
    Name: laser.name,
    ShortName: laser.name,
    LongName: `Wicked Lasers ${laser.name}`,
    Manufacturer: 'Wicked Lasers',
    Description: 'Made by Beatline Beam. Body measured off the unit; its origin is the aperture\'s optical axis 20 mm behind the front face.',
    FixtureTypeID: laser.id,
    RefFT: '',
    Thumbnail: '',
    CanHaveChildren: 'No',
  })}>`);
  x.push('    <AttributeDefinitions>');
  x.push('      <ActivationGroups/>');
  x.push('      <FeatureGroups>');
  const groups = new Map();
  Object.values(ATTRIBUTES).forEach((a) => {
    const [group, feature] = a.feature.split('.');
    if (!groups.has(group)) groups.set(group, new Set());
    groups.get(group).add(feature);
  });
  groups.forEach((features, group) => {
    x.push(`        <FeatureGroup Name="${group}" Pretty="${group}">`);
    features.forEach((f) => x.push(`          <Feature Name="${f}"/>`));
    x.push('        </FeatureGroup>');
  });
  x.push('      </FeatureGroups>');
  x.push('      <Attributes>');
  Object.values(ATTRIBUTES).forEach((a) => x.push(`        <Attribute${attrs({
    Name: a.name, Pretty: a.pretty, Feature: a.feature, PhysicalUnit: 'None',
  })}/>`));
  x.push('      </Attributes>');
  x.push('    </AttributeDefinitions>');
  x.push('    <Wheels/>');
  x.push('    <PhysicalDescriptions>');
  x.push('      <Emitters/>');
  x.push('      <Filters/>');
  x.push('      <ColorSpace Mode="sRGB"/>');
  x.push('      <DMXProfiles/>');
  x.push('      <CRIs/>');
  x.push('      <Connectors/>');
  x.push('      <Properties/>');
  x.push('    </PhysicalDescriptions>');
  x.push('    <Models>');
  x.push(`      <Model${attrs({
    Name: 'Body',
    Length: num(body.size[0]),
    Width: num(body.size[1]),
    Height: num(body.size[2]),
    PrimitiveType: 'Undefined',
    File: body.file,
  })}/>`);
  x.push(`      <Model${attrs({
    Name: 'Aperture', Length: '0.02', Width: '0.02', Height: '0.002', PrimitiveType: 'Cylinder', File: '',
  })}/>`);
  x.push('    </Models>');
  // The body stands as the unit does, Z up, the beam leaving along -Y: the
  // Laser geometry is turned so its own -Z, where GDTF sends the light, is -Y.
  const [ax, ay, az] = body.aperture;
  x.push('    <Geometries>');
  x.push(`      <Geometry Name="Body" Model="Body" Position="${matrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])}">`);
  x.push(`        <Laser${attrs({
    Name: 'Laser',
    Model: 'Aperture',
    Position: matrix([[1, 0, 0, ax], [0, 0, 1, ay], [0, -1, 0, az], [0, 0, 0, 1]]),
    ColorType: 'RGB',
    Color: '0',
    OutputStrength: num(laser.power),
    Emitter: '',
    BeamDiameter: num(laser.beamDiameter),
    BeamDivergenceMin: num(laser.divergence),
    BeamDivergenceMax: num(laser.divergence),
    ScanAnglePan: num(laser.scan),
    ScanAngleTilt: num(laser.scan),
    ScanSpeed: '0',
  })}/>`);
  x.push('      </Geometry>');
  x.push('    </Geometries>');
  x.push('    <DMXModes>');
  x.push('      <DMXMode Name="Default" Geometry="Body">');
  x.push('        <DMXChannels>');
  Object.entries(CONTROLS).forEach(([key, control]) => {
    const a = ATTRIBUTES[key];
    // A switch is 0 or 1.
    const value = Number(control.value);
    const [lo, hi] = control.mode === 'fixed' ? [value, value] : a.range;
    const channel = `Laser_${a.name}`;
    x.push(`          <DMXChannel${attrs({
      DMXBreak: 1,
      // Not on DMX: set at the unit, or fixed by it.
      Offset: 'None',
      Highlight: 'None',
      Geometry: 'Laser',
      InitialFunction: `${channel}.${a.name}.${a.fn}`,
    })}>`);
    x.push(`            <LogicalChannel Attribute="${a.name}" Snap="No" Master="None" MibFade="0" DMXChangeTimeLimit="0">`);
    x.push(`              <ChannelFunction${attrs({
      Name: a.fn,
      Attribute: a.name,
      OriginalAttribute: '',
      DMXFrom: '0/1',
      Default: `${dmxOf(key, control.value)}/1`,
      PhysicalFrom: num(lo),
      PhysicalTo: num(hi),
      RealFade: 0,
      RealAcceleration: 0,
    })}/>`);
    x.push('            </LogicalChannel>');
    x.push('          </DMXChannel>');
  });
  x.push('        </DMXChannels>');
  x.push('        <Relations/>');
  x.push('        <FTMacros/>');
  x.push('      </DMXMode>');
  x.push('    </DMXModes>');
  x.push('    <Revisions>');
  x.push('      <Revision Text="Made by Beatline Beam" Date="2026-10-13T00:00:00" UserID="0" ModifiedBy="Beatline Beam"/>');
  x.push('    </Revisions>');
  x.push('    <FTPresets/>');
  x.push('    <Protocols/>');
  x.push('  </FixtureType>');
  x.push('</GDTF>');
  return `${x.join('\n')}\n`;
}

/* ----------------------------------------------------------- the files */

const fileSafe = (s) => String(s).replace(/[<>:"/\\|?*@\s]+/g, '_');
fs.mkdirSync(outDir, { recursive: true });

LASERS.forEach((laser) => {
  const files = {};
  const { stem } = laser.body;
  const mesh = readGlb(path.join(here, laser.body.source));
  const box = bounds(mesh.positions);
  files[`models/gltf/${stem}.glb`] = new Uint8Array(glbOf(mesh, BODY_COLOUR));
  files[`models/3ds/${stem}.3ds`] = new Uint8Array(tdsOf(mesh, BODY_COLOUR));
  const body = {
    file: stem,
    size: [0, 1, 2].map((a) => box.max[a] - box.min[a]),
    // The model's origin is the optical axis, where the scan starts.
    aperture: [0, 0, 0],
  };
  files['description.xml'] = strToU8(description(laser, body));
  const name = `${fileSafe('Wicked Lasers')}@${fileSafe(laser.name)}@Beam_1.gdtf`;
  // A fixed date, so the file changes only when what is in it does.
  fs.writeFileSync(path.join(outDir, name), zipSync(files, { mtime: new Date('2026-10-13T00:00:00Z') }));
  console.log(`${name}  ${fs.statSync(path.join(outDir, name)).size} bytes`);
});
