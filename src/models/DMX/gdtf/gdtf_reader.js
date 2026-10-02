/**
 * @file Reads a .gdtf file into Beam's fixture type model.
 *
 * GDTF is the source of truth for a fixture, so the model is GDTF's own
 * structure (DIN SPEC 15800, GDTF 1.2) as plain objects: attribute
 * definitions, wheels, physical descriptions, models, the geometry tree and
 * the DMX modes. Names are kept as the file writes them and resolved through
 * the lookups in `index`; nothing is renamed into Beam's terms here.
 *
 * Two things are derived, because every consumer would otherwise derive them
 * again: each channel function's and channel set's DMX range end, which GDTF
 * leaves implicit, and every value at its channel's resolution.
 *
 * The XML parser is passed in, so the same code runs in the renderer with
 * `DOMParser` and outside the app with any DOM-compatible parser.
 *
 *     const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');
 *     const { fixtureType } = readGdtf(bytes, { parseXml });
 */

import { unzipSync } from 'fflate';
import {
  parseDmxValue, dmxAt, dmxMax, parseFloatValue, parseIntValue, parseColorCIE,
  parseMatrix, parseRotation, parseOffsets, parseNode, parseYesNo,
} from './gdtf_values';

/** Every geometry element GDTF 1.2 defines. */
export const GEOMETRY_TYPES = [
  'Geometry', 'Axis', 'FilterBeam', 'FilterColor', 'FilterGobo', 'FilterShaper',
  'Beam', 'MediaServerLayer', 'MediaServerCamera', 'MediaServerMaster', 'Display',
  'GeometryReference', 'Laser', 'WiringObject', 'Inventory', 'Structure',
  'Support', 'Magnet',
];

/**
 * A Beam geometry's attributes and the spec's value for each when the file
 * leaves it out. `explicit` on the parsed beam lists the ones actually written,
 * since a default is not a measurement.
 */
const BEAM_DEFAULTS = {
  LampType: 'Discharge',
  PowerConsumption: 1000,
  LuminousFlux: 10000,
  ColorTemperature: 6000,
  BeamAngle: 25,
  FieldAngle: 25,
  ThrowRatio: 1,
  RectangleRatio: 1.7777,
  BeamRadius: 0.05,
  BeamType: 'Wash',
  ColorRenderingIndex: 100,
};

/** The direct child elements of a node, optionally of one tag. */
function elements(node, tag) {
  if (!node) return [];
  const out = [];
  const kids = node.childNodes || [];
  for (let i = 0; i < kids.length; i += 1) {
    const kid = kids[i];
    if (kid.nodeType === 1 && (!tag || kid.tagName === tag)) out.push(kid);
  }
  return out;
}

/** The first direct child element of a tag. */
function child(node, tag) {
  return elements(node, tag)[0] || null;
}

/** Every attribute of an element as a plain object, as written. */
function attributes(node) {
  const out = {};
  const list = node.attributes || [];
  for (let i = 0; i < list.length; i += 1) out[list[i].name] = list[i].value;
  return out;
}

/** An attribute, or undefined when absent. */
function attr(node, name) {
  return node.hasAttribute(name) ? node.getAttribute(name) : undefined;
}

/** `x,y` as two numbers. */
function parsePoint(text) {
  if (!text) return null;
  const parts = String(text).split(',').map((p) => Number(p.trim()));
  return parts.length >= 2 && parts.every(Number.isFinite) ? parts.slice(0, 2) : null;
}

function readAttributeDefinitions(node) {
  const groups = child(node, 'FeatureGroups');
  return {
    activationGroups: elements(child(node, 'ActivationGroups'), 'ActivationGroup')
      .map((g) => attr(g, 'Name')),
    featureGroups: elements(groups, 'FeatureGroup').map((g) => ({
      name: attr(g, 'Name'),
      pretty: attr(g, 'Pretty'),
      features: elements(g, 'Feature').map((f) => attr(f, 'Name')),
    })),
    attributes: elements(child(node, 'Attributes'), 'Attribute').map((a) => ({
      name: attr(a, 'Name'),
      pretty: attr(a, 'Pretty'),
      activationGroup: attr(a, 'ActivationGroup') || null,
      feature: attr(a, 'Feature') || null,
      mainAttribute: attr(a, 'MainAttribute') || null,
      physicalUnit: attr(a, 'PhysicalUnit') || 'None',
      color: parseColorCIE(attr(a, 'Color')),
      subPhysicalUnits: elements(a, 'SubPhysicalUnit').map((s) => ({
        type: attr(s, 'Type'),
        physicalUnit: attr(s, 'PhysicalUnit') || 'None',
        physicalFrom: parseFloatValue(attr(s, 'PhysicalFrom'), 0),
        physicalTo: parseFloatValue(attr(s, 'PhysicalTo'), 1),
      })),
    })),
  };
}

function readWheels(node) {
  return elements(node, 'Wheel').map((w) => ({
    name: attr(w, 'Name'),
    slots: elements(w, 'Slot').map((s) => {
      const animation = child(s, 'AnimationSystem');
      return {
        name: attr(s, 'Name'),
        color: parseColorCIE(attr(s, 'Color')),
        filter: attr(s, 'Filter') || null,
        mediaFileName: attr(s, 'MediaFileName') || null,
        facets: elements(s, 'Facet').map((f) => ({
          color: parseColorCIE(attr(f, 'Color')),
          rotation: parseRotation(attr(f, 'Rotation')),
        })),
        animationSystem: animation ? {
          p1: parsePoint(attr(animation, 'P1')),
          p2: parsePoint(attr(animation, 'P2')),
          p3: parsePoint(attr(animation, 'P3')),
          radius: parseFloatValue(attr(animation, 'Radius'), null),
        } : null,
      };
    }),
  }));
}

function readMeasurements(node) {
  return elements(node, 'Measurement').map((m) => ({
    physical: parseFloatValue(attr(m, 'Physical'), null),
    luminousIntensity: parseFloatValue(attr(m, 'LuminousIntensity'), null),
    transmission: parseFloatValue(attr(m, 'Transmission'), null),
    interpolationTo: attr(m, 'InterpolationTo') || 'Linear',
    points: elements(m, 'MeasurementPoint').map((p) => ({
      waveLength: parseFloatValue(attr(p, 'WaveLength'), null),
      energy: parseFloatValue(attr(p, 'Energy'), null),
    })),
  }));
}

function readColorSpace(node) {
  if (!node) return null;
  return {
    name: attr(node, 'Name') || null,
    mode: attr(node, 'Mode') || 'sRGB',
    red: parseColorCIE(attr(node, 'Red')),
    green: parseColorCIE(attr(node, 'Green')),
    blue: parseColorCIE(attr(node, 'Blue')),
    whitePoint: parseColorCIE(attr(node, 'WhitePoint')),
  };
}

function readPhysicalDescriptions(node) {
  const properties = child(node, 'Properties');
  const temperature = child(properties, 'OperatingTemperature');
  const weight = child(properties, 'Weight');
  const legHeight = child(properties, 'LegHeight');
  return {
    emitters: elements(child(node, 'Emitters'), 'Emitter').map((e) => ({
      name: attr(e, 'Name'),
      color: parseColorCIE(attr(e, 'Color')),
      dominantWaveLength: parseFloatValue(attr(e, 'DominantWaveLength'), null),
      diodePart: attr(e, 'DiodePart') || null,
      measurements: readMeasurements(e),
    })),
    filters: elements(child(node, 'Filters'), 'Filter').map((f) => ({
      name: attr(f, 'Name'),
      color: parseColorCIE(attr(f, 'Color')),
      measurements: readMeasurements(f),
    })),
    colorSpace: readColorSpace(child(node, 'ColorSpace')),
    additionalColorSpaces: elements(child(node, 'AdditionalColorSpaces'), 'ColorSpace')
      .map(readColorSpace),
    gamuts: elements(child(node, 'Gamuts'), 'Gamut').map((g) => ({
      name: attr(g, 'Name'),
      points: [...String(attr(g, 'Points') || '').matchAll(/\{([^}]*)\}/g)]
        .map((m) => parseColorCIE(m[1])).filter(Boolean),
    })),
    dmxProfiles: elements(child(node, 'DMXProfiles'), 'DMXProfile').map((p) => ({
      name: attr(p, 'Name'),
      points: elements(p, 'Point').map((pt) => ({
        dmxPercentage: parseFloatValue(attr(pt, 'DMXPercentage'), 0),
        cfc0: parseFloatValue(attr(pt, 'CFC0'), 0),
        cfc1: parseFloatValue(attr(pt, 'CFC1'), 0),
        cfc2: parseFloatValue(attr(pt, 'CFC2'), 0),
        cfc3: parseFloatValue(attr(pt, 'CFC3'), 0),
      })),
    })),
    cris: elements(child(node, 'CRIs'), 'CRIGroup').map((g) => ({
      colorTemperature: parseFloatValue(attr(g, 'ColorTemperature'), 6000),
      cris: elements(g, 'CRI').map((c) => ({
        ces: attr(c, 'CES'),
        colorRenderingIndex: parseFloatValue(attr(c, 'ColorRenderingIndex'), 100),
      })),
    })),
    connectors: elements(child(node, 'Connectors'), 'Connector').map((c) => ({
      name: attr(c, 'Name'),
      type: attr(c, 'Type'),
      dmxBreak: parseIntValue(attr(c, 'DMXBreak'), null),
      gender: parseIntValue(attr(c, 'Gender'), 0),
      length: parseFloatValue(attr(c, 'Length'), 0),
    })),
    properties: {
      operatingTemperature: temperature ? {
        low: parseFloatValue(attr(temperature, 'Low'), 0),
        high: parseFloatValue(attr(temperature, 'High'), 40),
      } : null,
      weight: weight ? parseFloatValue(attr(weight, 'Value'), null) : null,
      legHeight: legHeight ? parseFloatValue(attr(legHeight, 'Value'), null) : null,
      powerConsumption: elements(properties, 'PowerConsumption').map((p) => ({
        value: parseFloatValue(attr(p, 'Value'), null),
        powerFactor: parseFloatValue(attr(p, 'PowerFactor'), 1),
        connector: attr(p, 'Connector') || null,
        voltageLow: parseFloatValue(attr(p, 'VoltageLow'), null),
        voltageHigh: parseFloatValue(attr(p, 'VoltageHigh'), null),
        frequencyLow: parseFloatValue(attr(p, 'FrequencyLow'), null),
        frequencyHigh: parseFloatValue(attr(p, 'FrequencyHigh'), null),
      })),
    },
  };
}

function readModels(node) {
  return elements(node, 'Model').map((m) => ({
    name: attr(m, 'Name'),
    length: parseFloatValue(attr(m, 'Length'), 0),
    width: parseFloatValue(attr(m, 'Width'), 0),
    height: parseFloatValue(attr(m, 'Height'), 0),
    primitiveType: attr(m, 'PrimitiveType') || 'Undefined',
    file: attr(m, 'File') || null,
  }));
}

/** A Beam geometry's photometric and optical attributes. */
function readBeam(node) {
  const explicit = Object.keys(BEAM_DEFAULTS).filter((k) => node.hasAttribute(k));
  const num = (k) => parseFloatValue(attr(node, k), BEAM_DEFAULTS[k]);
  return {
    lampType: attr(node, 'LampType') || BEAM_DEFAULTS.LampType,
    powerConsumption: num('PowerConsumption'),
    luminousFlux: num('LuminousFlux'),
    colorTemperature: num('ColorTemperature'),
    beamAngle: num('BeamAngle'),
    fieldAngle: num('FieldAngle'),
    throwRatio: num('ThrowRatio'),
    rectangleRatio: num('RectangleRatio'),
    beamRadius: num('BeamRadius'),
    beamType: attr(node, 'BeamType') || BEAM_DEFAULTS.BeamType,
    colorRenderingIndex: num('ColorRenderingIndex'),
    emitterSpectrum: attr(node, 'EmitterSpectrum') || null,
    explicit,
  };
}

function readGeometry(node) {
  const type = node.tagName;
  const geometry = {
    type,
    name: attr(node, 'Name'),
    model: attr(node, 'Model') || null,
    position: parseMatrix(attr(node, 'Position')),
    attrs: attributes(node),
    children: [],
  };
  if (type === 'Beam') geometry.beam = readBeam(node);
  if (type === 'GeometryReference') {
    geometry.geometry = attr(node, 'Geometry') || null;
    geometry.breaks = elements(node, 'Break').map((b) => ({
      dmxBreak: parseIntValue(attr(b, 'DMXBreak'), 1),
      dmxOffset: parseIntValue(attr(b, 'DMXOffset'), 1),
    }));
  }
  if (type === 'Display') geometry.texture = attr(node, 'Texture') || null;
  elements(node).forEach((kid) => {
    if (GEOMETRY_TYPES.includes(kid.tagName)) geometry.children.push(readGeometry(kid));
  });
  return geometry;
}

/** Visits every geometry in a tree, depth first. */
export function walkGeometry(geometry, visit, parent = null) {
  visit(geometry, parent);
  geometry.children.forEach((kid) => walkGeometry(kid, visit, geometry));
}

/**
 * One DMX mode. Values are read as written here; `resolveMode` converts them
 * to channel resolution once every channel's width is known.
 */
function readMode(node) {
  const channels = elements(child(node, 'DMXChannels'), 'DMXChannel').map((c) => {
    const offsets = parseOffsets(attr(c, 'Offset'));
    const breakText = attr(c, 'DMXBreak');
    const logicalChannels = elements(c, 'LogicalChannel').map((l) => ({
      attribute: attr(l, 'Attribute') || 'NoFeature',
      snap: attr(l, 'Snap') || 'No',
      master: attr(l, 'Master') || 'None',
      mibFade: parseFloatValue(attr(l, 'MibFade'), 0),
      dmxChangeTimeLimit: parseFloatValue(attr(l, 'DMXChangeTimeLimit'), 0),
      functions: elements(l, 'ChannelFunction').map((f) => {
        const physicalFrom = parseFloatValue(attr(f, 'PhysicalFrom'), 0);
        const physicalTo = parseFloatValue(attr(f, 'PhysicalTo'), 1);
        return {
          name: attr(f, 'Name') || null,
          attribute: attr(f, 'Attribute') || 'NoFeature',
          originalAttribute: attr(f, 'OriginalAttribute') || '',
          dmxFromWritten: parseDmxValue(attr(f, 'DMXFrom') || '0/1'),
          defaultWritten: parseDmxValue(attr(f, 'Default') || '0/1'),
          physicalFrom,
          physicalTo,
          realFade: parseFloatValue(attr(f, 'RealFade'), 0),
          realAcceleration: parseFloatValue(attr(f, 'RealAcceleration'), 0),
          wheel: attr(f, 'Wheel') || null,
          emitter: attr(f, 'Emitter') || null,
          filter: attr(f, 'Filter') || null,
          colorSpace: attr(f, 'ColorSpace') || null,
          gamut: attr(f, 'Gamut') || null,
          dmxProfile: attr(f, 'DMXProfile') || null,
          modeMaster: parseNode(attr(f, 'ModeMaster')),
          modeFromWritten: parseDmxValue(attr(f, 'ModeFrom')),
          modeToWritten: parseDmxValue(attr(f, 'ModeTo')),
          min: parseFloatValue(attr(f, 'Min'), physicalFrom),
          max: parseFloatValue(attr(f, 'Max'), physicalTo),
          customName: attr(f, 'CustomName') || '',
          sets: elements(f, 'ChannelSet').map((s) => ({
            name: attr(s, 'Name') || '',
            dmxFromWritten: parseDmxValue(attr(s, 'DMXFrom') || '0/1'),
            physicalFrom: parseFloatValue(attr(s, 'PhysicalFrom'), null),
            physicalTo: parseFloatValue(attr(s, 'PhysicalTo'), null),
            wheelSlotIndex: parseIntValue(attr(s, 'WheelSlotIndex'), null),
          })),
        };
      }),
    }));
    const geometry = attr(c, 'Geometry') || null;
    return {
      // DMX channels are not named in the file; GDTF names them by their
      // geometry and their first logical channel's attribute, and other
      // nodes (ModeMaster, Relations) refer to them by that name.
      name: `${geometry}_${(logicalChannels[0] || {}).attribute || 'NoFeature'}`,
      dmxBreak: breakText === 'Overwrite' ? 'Overwrite' : parseIntValue(breakText, 1),
      offsets,
      bytes: offsets ? offsets.length : 1,
      initialFunctionWritten: parseNode(attr(c, 'InitialFunction')),
      highlightWritten: parseDmxValue(attr(c, 'Highlight')),
      geometry,
      logicalChannels,
    };
  });
  return {
    name: attr(node, 'Name'),
    description: attr(node, 'Description') || '',
    geometry: attr(node, 'Geometry') || null,
    channels,
    relations: elements(child(node, 'Relations'), 'Relation').map((r) => ({
      name: attr(r, 'Name'),
      master: parseNode(attr(r, 'Master')),
      follower: parseNode(attr(r, 'Follower')),
      type: attr(r, 'Type'),
    })),
    macroCount: elements(child(node, 'FTMacros'), 'FTMacro').length,
  };
}

/**
 * Ends of ranges that GDTF leaves implicit: each starts where it is written
 * and runs to one below the next start in the same group, the last to `end`.
 */
function closeRanges(items, end) {
  const sorted = [...items].sort((a, b) => a.dmxFrom - b.dmxFrom);
  sorted.forEach((item, i) => {
    const next = sorted[i + 1];
    // eslint-disable-next-line no-param-reassign
    item.dmxTo = next ? Math.max(item.dmxFrom, next.dmxFrom - 1) : end;
  });
}

/**
 * Converts a mode's values to channel resolution and closes its ranges.
 *
 * A channel function's range ends at the next function's start among those
 * that apply under the same mode master condition: functions that depend on a
 * mode channel overlap on purpose, each pair answering for a different state
 * of the master.
 */
function resolveMode(mode, problems) {
  const byName = new Map(mode.channels.map((c) => [c.name, c]));
  mode.channels.forEach((channel) => {
    // A virtual channel has no address and so no width of its own; it is as
    // wide as the widest value its functions are written in.
    if (!channel.offsets) {
      let bytes = 1;
      channel.logicalChannels.forEach((l) => l.functions.forEach((f) => {
        bytes = Math.max(bytes, f.dmxFromWritten ? f.dmxFromWritten.bytes : 1);
      }));
      // eslint-disable-next-line no-param-reassign
      channel.bytes = bytes;
    }
    const { bytes } = channel;
    const end = dmxMax(bytes);
    // eslint-disable-next-line no-param-reassign
    channel.highlight = dmxAt(channel.highlightWritten, bytes);
    channel.logicalChannels.forEach((logical) => {
      const groups = new Map();
      logical.functions.forEach((f, i) => {
        /* eslint-disable no-param-reassign */
        f.dmxFrom = dmxAt(f.dmxFromWritten, bytes) || 0;
        f.default = dmxAt(f.defaultWritten, bytes) || 0;
        if (!f.name) f.name = `${f.attribute} ${i + 1}`;
        if (f.modeMaster) {
          const master = byName.get(f.modeMaster[0]);
          if (!master) problems.push(`${mode.name}: mode master ${f.modeMaster.join('.')} not found`);
          const masterBytes = master ? master.bytes : 1;
          f.modeFrom = dmxAt(f.modeFromWritten, masterBytes) || 0;
          f.modeTo = dmxAt(f.modeToWritten, masterBytes) || 0;
        } else {
          f.modeFrom = null;
          f.modeTo = null;
        }
        /* eslint-enable no-param-reassign */
        const key = f.modeMaster ? `${f.modeMaster.join('.')}|${f.modeFrom}|${f.modeTo}` : '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
      });
      groups.forEach((group) => closeRanges(group, end));
      logical.functions.forEach((f) => {
        f.sets.forEach((s) => {
          // eslint-disable-next-line no-param-reassign
          s.dmxFrom = dmxAt(s.dmxFromWritten, bytes) || 0;
        });
        closeRanges(f.sets, f.dmxTo);
      });
    });
    const initial = channel.initialFunctionWritten;
    // eslint-disable-next-line no-param-reassign
    channel.initialFunction = initial ? initial.slice(1).join('.') : null;
  });
}

/**
 * Builds the name lookups. Geometry names are unique within a fixture type,
 * so one map covers the whole tree.
 */
function buildIndex(type, problems) {
  const geometryByName = new Map();
  const parentOf = new Map();
  type.geometries.forEach((top) => walkGeometry(top, (g, parent) => {
    if (geometryByName.has(g.name)) problems.push(`geometry name used twice: ${g.name}`);
    geometryByName.set(g.name, g);
    parentOf.set(g.name, parent ? parent.name : null);
  }));
  return {
    attribute: new Map(type.attributeDefinitions.attributes.map((a) => [a.name, a])),
    wheel: new Map(type.wheels.map((w) => [w.name, w])),
    emitter: new Map(type.physical.emitters.map((e) => [e.name, e])),
    filter: new Map(type.physical.filters.map((f) => [f.name, f])),
    model: new Map(type.models.map((m) => [m.name, m])),
    geometry: geometryByName,
    parentOf,
    mode: new Map(type.modes.map((m) => [m.name, m])),
  };
}

/** Checks that every name a fixture refers to exists. */
function checkReferences(type, problems) {
  const { index } = type;
  const seen = new Set();
  const missing = (what, name) => {
    const key = `${what}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push(`${what} not defined: ${name}`);
  };
  index.geometry.forEach((g) => {
    if (g.model && !index.model.has(g.model)) missing('model', g.model);
    if (g.type === 'GeometryReference' && !index.geometry.has(g.geometry)) missing('referenced geometry', g.geometry);
  });
  type.modes.forEach((mode) => {
    if (mode.geometry && !index.geometry.has(mode.geometry)) missing('mode geometry', mode.geometry);
    mode.channels.forEach((c) => {
      if (c.geometry && !index.geometry.has(c.geometry)) missing('channel geometry', c.geometry);
      c.logicalChannels.forEach((l) => l.functions.forEach((f) => {
        if (!index.attribute.has(f.attribute) && f.attribute !== 'NoFeature') missing('attribute', f.attribute);
        if (f.wheel && !index.wheel.has(f.wheel)) missing('wheel', f.wheel);
        if (f.emitter && !index.emitter.has(f.emitter)) missing('emitter', f.emitter);
        if (f.filter && !index.filter.has(f.filter)) missing('filter', f.filter);
      }));
    });
  });
}

/**
 * Finishes a fixture type read from any format: values at channel
 * resolution, implicit range ends closed, the lookups built and every name
 * checked. Adds `index` to the type.
 *
 * @param {Object} type a fixture type with written values
 * @returns {Array<String>} problems found
 */
export function completeFixtureType(type) {
  const problems = [];
  type.modes.forEach((mode) => resolveMode(mode, problems));
  // eslint-disable-next-line no-param-reassign
  type.index = buildIndex(type, problems);
  checkReferences(type, problems);
  return problems;
}

/**
 * Reads a GDTF file.
 *
 * @param {Uint8Array} bytes the .gdtf file
 * @param {Object} options
 * @param {Function} options.parseXml string -> DOM Document
 * @returns {{fixtureType: Object, files: Object, problems: Array<String>}}
 *   `files` holds every other file in the archive by its path, for models,
 *   wheel images and the thumbnail
 */
export default function readGdtf(bytes, { parseXml }) {
  const files = unzipSync(bytes);
  const descriptionPath = Object.keys(files).find((p) => p.toLowerCase() === 'description.xml');
  if (!descriptionPath) throw new Error('not a GDTF file: no description.xml');
  let text = new TextDecoder('utf-8').decode(files[descriptionPath]);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  delete files[descriptionPath];

  const doc = parseXml(text);
  const root = doc.documentElement;
  if (!root || root.tagName !== 'GDTF') throw new Error('not a GDTF file: the root element is not GDTF');
  const node = child(root, 'FixtureType');
  if (!node) throw new Error('not a GDTF file: no FixtureType');

  const problems = [];
  const rdm = child(child(node, 'Protocols'), 'FTRDM');
  const type = {
    dataVersion: attr(root, 'DataVersion') || null,
    name: attr(node, 'Name'),
    shortName: attr(node, 'ShortName') || '',
    longName: attr(node, 'LongName') || '',
    manufacturer: attr(node, 'Manufacturer') || '',
    description: attr(node, 'Description') || '',
    fixtureTypeId: attr(node, 'FixtureTypeID') || null,
    refFT: attr(node, 'RefFT') || null,
    thumbnail: attr(node, 'Thumbnail') || null,
    canHaveChildren: parseYesNo(attr(node, 'CanHaveChildren'), true),
    attributeDefinitions: readAttributeDefinitions(child(node, 'AttributeDefinitions')),
    wheels: readWheels(child(node, 'Wheels')),
    physical: readPhysicalDescriptions(child(node, 'PhysicalDescriptions')),
    models: readModels(child(node, 'Models')),
    geometries: elements(child(node, 'Geometries'))
      .filter((g) => GEOMETRY_TYPES.includes(g.tagName))
      .map(readGeometry),
    modes: elements(child(node, 'DMXModes'), 'DMXMode').map(readMode),
    revisions: elements(child(node, 'Revisions'), 'Revision').map((r) => ({
      text: attr(r, 'Text') || '',
      date: attr(r, 'Date') || null,
      userId: parseIntValue(attr(r, 'UserID'), 0),
      modifiedBy: attr(r, 'ModifiedBy') || '',
    })),
    rdm: rdm ? {
      manufacturerId: attr(rdm, 'ManufacturerID') || null,
      deviceModelId: attr(rdm, 'DeviceModelID') || null,
    } : null,
  };
  problems.push(...completeFixtureType(type));
  return { fixtureType: type, files, problems };
}

/**
 * The geometry names under a geometry, itself included.
 *
 * @param {Object} geometry
 * @returns {Set<String>}
 */
function subtreeNames(geometry) {
  const names = new Set();
  walkGeometry(geometry, (g) => names.add(g.name));
  return names;
}

/**
 * A mode's channels as the fixture is patched: one entry per addressed
 * channel instance, with absolute offsets within its DMX break.
 *
 * A channel on a geometry in the mode's own tree is one instance. A channel
 * on a geometry that the tree only reaches through `GeometryReference`s --
 * the way a pixel bar declares one pixel and places it twenty times -- is one
 * instance per reference, moved by that reference's break offset.
 *
 * @param {Object} type a fixture type from `readGdtf`
 * @param {Object} mode one of its modes
 * @returns {{instances: Array<Object>, footprint: Object<Number, Number>}}
 *   `footprint` maps each DMX break to the highest offset used in it
 */
export function patchedChannels(type, mode) {
  const top = type.index.geometry.get(mode.geometry);
  const own = top ? subtreeNames(top) : new Set();
  const references = [];
  if (top) {
    walkGeometry(top, (g) => {
      if (g.type === 'GeometryReference') references.push(g);
    });
  }
  const templateNames = new Map();
  references.forEach((ref) => {
    if (!templateNames.has(ref.geometry)) {
      const template = type.index.geometry.get(ref.geometry);
      templateNames.set(ref.geometry, template ? subtreeNames(template) : new Set());
    }
  });

  const instances = [];
  const footprint = {};
  const place = (channel, dmxBreak, shift, instanceOf) => {
    const offsets = channel.offsets ? channel.offsets.map((o) => o + shift) : null;
    instances.push({
      channel, dmxBreak, offsets, instanceOf,
    });
    if (offsets) footprint[dmxBreak] = Math.max(footprint[dmxBreak] || 0, ...offsets);
  };

  mode.channels.forEach((channel) => {
    if (own.has(channel.geometry)) {
      place(channel, channel.dmxBreak === 'Overwrite' ? 1 : channel.dmxBreak, 0, null);
      return;
    }
    let placed = false;
    references.forEach((ref) => {
      if (!templateNames.get(ref.geometry).has(channel.geometry)) return;
      const brk = channel.dmxBreak === 'Overwrite'
        ? ref.breaks[ref.breaks.length - 1]
        : ref.breaks.find((b) => b.dmxBreak === channel.dmxBreak);
      if (!brk) return;
      place(channel, brk.dmxBreak, brk.dmxOffset - 1, ref.name);
      placed = true;
    });
    if (!placed) place(channel, channel.dmxBreak === 'Overwrite' ? 1 : channel.dmxBreak, 0, null);
  });
  return { instances, footprint };
}

/**
 * The archive paths that can hold a model's mesh, by format and level of
 * detail. GDTF names a model's file without folder or extension; `.glb` lives
 * under `models/gltf`, `.3ds` under `models/3ds`, with `_low` and `_high`
 * folders for other detail levels.
 *
 * @param {Object} files from `readGdtf`
 * @param {Object} model one of the fixture type's models
 * @returns {Object<String, String>} e.g. `{ gltf: 'models/gltf/Head.glb' }`
 */
export function modelFiles(files, model) {
  if (!model || !model.file) return {};
  const lower = new Map(Object.keys(files).map((p) => [p.toLowerCase(), p]));
  const found = {};
  ['gltf', 'gltf_low', 'gltf_high', '3ds', '3ds_low', '3ds_high', 'svg', 'svg_side', 'svg_front'].forEach((folder) => {
    const ext = folder.startsWith('gltf') ? 'glb' : folder.split('_')[0];
    const path = lower.get(`models/${folder}/${model.file}.${ext}`.toLowerCase());
    if (path) found[folder] = path;
  });
  return found;
}
