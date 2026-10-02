/* eslint-disable no-console */
/**
 * The GDTF reader: value types, implicit range ends, mode masters, virtual
 * channels, pixel geometry references and model file lookup.
 *
 * What is pinned: DMX values convert between resolutions by byte mirroring
 * and shifting; a channel function runs to the next one's start among those
 * under the same mode master condition; a channel set ends where its next
 * sibling starts or where its function ends; a geometry reference repeats its
 * template's channels at its break offset; a model's mesh is found in its
 * format's folder whatever the case of its path.
 *
 * Usage:
 *   npm test
 */
import { zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import readGdtf, { patchedChannels, modelFiles } from '@/models/DMX/gdtf/gdtf_reader';
import {
  parseDmxValue, dmxAt, parseMatrix, parseOffsets, parseColorCIE,
} from '@/models/DMX/gdtf/gdtf_values';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');

// Values.
check('255/1 in 16 bit mirrors', dmxAt(parseDmxValue('255/1'), 2), 65535);
check('127/1 in 16 bit mirrors', dmxAt(parseDmxValue('127/1'), 2), 32639);
check('255/1s in 16 bit shifts', dmxAt(parseDmxValue('255/1s'), 2), 65280);
check('65535/2 in 8 bit keeps the top byte', dmxAt(parseDmxValue('65535/2'), 1), 255);
check('bare integer is one byte', parseDmxValue('12'), { value: 12, bytes: 1, shift: false });
check('virtual channel has no offsets', parseOffsets(''), null);
check('16 bit offsets coarse first', parseOffsets('3,4'), [3, 4]);
check('matrix translation in the last column', parseMatrix('{1,0,0,0}{0,1,0,0}{0,0,1,-0.261}{0,0,0,1}')[11], -0.261);
check('colour CIE', parseColorCIE('0.3127,0.3290,100'), { x: 0.3127, y: 0.329, Y: 100 });

// A fixture: a head with a mode channel switching zoom ranges, a 16-bit
// dimmer, a gobo wheel channel with sets, a virtual master, and a pixel bar
// made of two references to one pixel.
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2">
<FixtureType Name="Test Head" Manufacturer="Beam" FixtureTypeID="00000000-0000-0000-0000-000000000001" Thumbnail="thumbnail">
<AttributeDefinitions>
  <ActivationGroups/>
  <FeatureGroups><FeatureGroup Name="Dimmer"><Feature Name="Dimmer"/></FeatureGroup></FeatureGroups>
  <Attributes>
    <Attribute Name="Dimmer" Feature="Dimmer.Dimmer" PhysicalUnit="LuminousIntensity"/>
    <Attribute Name="Zoom" Feature="Beam.Beam" PhysicalUnit="Angle"/>
    <Attribute Name="Control1" Feature="Control.Control"/>
    <Attribute Name="Gobo1" Feature="Gobo.Gobo"/>
    <Attribute Name="ColorAdd_R" Feature="Color.RGB"/>
  </Attributes>
</AttributeDefinitions>
<Wheels><Wheel Name="Gobo1"><Slot Name="Open"/><Slot Name="Star" MediaFileName="star"/></Wheel></Wheels>
<PhysicalDescriptions/>
<Models><Model Name="Head" File="Head" Length="0.3" Width="0.2" Height="0.5" PrimitiveType="Undefined"/></Models>
<Geometries>
  <Geometry Name="Base">
    <Axis Name="Head" Model="Head" Position="{1,0,0,0}{0,1,0,0}{0,0,1,0.4}{0,0,0,1}">
      <Beam Name="Lens" LuminousFlux="12000" BeamAngle="10" FieldAngle="14" BeamType="Spot"/>
    </Axis>
  </Geometry>
  <Geometry Name="Pixel"><Beam Name="PixelBeam" LuminousFlux="40"/></Geometry>
  <Geometry Name="Bar">
    <GeometryReference Name="Pixel 1" Geometry="Pixel"><Break DMXBreak="1" DMXOffset="1"/></GeometryReference>
    <GeometryReference Name="Pixel 2" Geometry="Pixel"><Break DMXBreak="1" DMXOffset="4"/></GeometryReference>
  </Geometry>
</Geometries>
<DMXModes>
  <DMXMode Name="Standard" Geometry="Base">
    <DMXChannels>
      <DMXChannel DMXBreak="1" Offset="1" Geometry="Base">
        <LogicalChannel Attribute="Control1">
          <ChannelFunction Name="Mode" Attribute="Control1" DMXFrom="0/1">
            <ChannelSet Name="Beam" DMXFrom="0/1"/>
            <ChannelSet Name="Spot" DMXFrom="1/1"/>
          </ChannelFunction>
        </LogicalChannel>
      </DMXChannel>
      <DMXChannel DMXBreak="1" Offset="2,3" Geometry="Head">
        <LogicalChannel Attribute="Dimmer">
          <ChannelFunction Name="Dimmer" Attribute="Dimmer" DMXFrom="0/1" Default="255/1"/>
        </LogicalChannel>
      </DMXChannel>
      <DMXChannel DMXBreak="1" Offset="4" Geometry="Head">
        <LogicalChannel Attribute="Zoom">
          <ChannelFunction Name="Zoom Beam" Attribute="Zoom" DMXFrom="0/1" PhysicalFrom="2" PhysicalTo="38" ModeMaster="Base_Control1" ModeFrom="0/1" ModeTo="0/1"/>
          <ChannelFunction Name="Zoom Spot" Attribute="Zoom" DMXFrom="0/1" PhysicalFrom="2.8" PhysicalTo="28.6" ModeMaster="Base_Control1" ModeFrom="1/1" ModeTo="1/1"/>
        </LogicalChannel>
      </DMXChannel>
      <DMXChannel DMXBreak="1" Offset="5" Geometry="Head">
        <LogicalChannel Attribute="Gobo1">
          <ChannelFunction Name="Gobo" Attribute="Gobo1" Wheel="Gobo1" DMXFrom="0/1">
            <ChannelSet Name="Open" DMXFrom="0/1" WheelSlotIndex="1"/>
            <ChannelSet Name="Star" DMXFrom="10/1" WheelSlotIndex="2"/>
          </ChannelFunction>
          <ChannelFunction Name="Spin" Attribute="Gobo1" DMXFrom="128/1" PhysicalFrom="-30" PhysicalTo="30"/>
        </LogicalChannel>
      </DMXChannel>
    </DMXChannels>
  </DMXMode>
  <DMXMode Name="Pixels" Geometry="Bar">
    <DMXChannels>
      <DMXChannel DMXBreak="1" Offset="1" Geometry="PixelBeam">
        <LogicalChannel Attribute="ColorAdd_R"><ChannelFunction Attribute="ColorAdd_R" DMXFrom="0/1"/></LogicalChannel>
      </DMXChannel>
      <DMXChannel DMXBreak="1" Offset="" Geometry="Bar">
        <LogicalChannel Attribute="Dimmer"><ChannelFunction Attribute="Dimmer" DMXFrom="0/2"/></LogicalChannel>
      </DMXChannel>
    </DMXChannels>
    <Relations><Relation Name="Virtual" Master="Bar_Dimmer" Follower="PixelBeam_ColorAdd_R.ColorAdd_R.ColorAdd_R 1" Type="Multiply"/></Relations>
  </DMXMode>
</DMXModes>
</FixtureType>
</GDTF>`;

const archive = zipSync({
  'description.xml': strToU8(xml),
  'models/3DS/Head.3ds': new Uint8Array([1]),
  'models/gltf/Head.glb': new Uint8Array([2]),
  'wheels/star.png': new Uint8Array([3]),
});
const { fixtureType: type, files, problems } = readGdtf(archive, { parseXml });

check('no problems', problems, []);
check('name and manufacturer', [type.name, type.manufacturer], ['Test Head', 'Beam']);
check('archive keeps the other files', Object.keys(files).sort(), ['models/3DS/Head.3ds', 'models/gltf/Head.glb', 'wheels/star.png']);

const lens = type.index.geometry.get('Lens');
check('beam reads what is written', [lens.beam.luminousFlux, lens.beam.beamAngle, lens.beam.fieldAngle, lens.beam.beamType], [12000, 10, 14, 'Spot']);
check('beam falls back to the spec default', lens.beam.beamRadius, 0.05);
check('beam records which were written', lens.beam.explicit, ['LuminousFlux', 'BeamAngle', 'FieldAngle', 'BeamType']);
check('geometry parent', type.index.parentOf.get('Lens'), 'Head');

const standard = type.index.mode.get('Standard');
const channel = (name) => standard.channels.find((c) => c.name === name);
check('channels named geometry_attribute', standard.channels.map((c) => c.name), ['Base_Control1', 'Head_Dimmer', 'Head_Zoom', 'Head_Gobo1']);
check('16 bit dimmer default mirrored', channel('Head_Dimmer').logicalChannels[0].functions[0].default, 65535);
check('16 bit dimmer runs to 65535', channel('Head_Dimmer').logicalChannels[0].functions[0].dmxTo, 65535);
const zooms = channel('Head_Zoom').logicalChannels[0].functions;
check('mode-master functions each span the channel', zooms.map((f) => [f.dmxFrom, f.dmxTo]), [[0, 255], [0, 255]]);
check('mode-master conditions', zooms.map((f) => [f.modeFrom, f.modeTo]), [[0, 0], [1, 1]]);
const gobo = channel('Head_Gobo1').logicalChannels[0].functions;
check('functions end before the next', gobo.map((f) => [f.dmxFrom, f.dmxTo]), [[0, 127], [128, 255]]);
check('sets end before the next or at the function end', gobo[0].sets.map((s) => [s.dmxFrom, s.dmxTo]), [[0, 9], [10, 127]]);
check('mode channel sets', channel('Base_Control1').logicalChannels[0].functions[0].sets.map((s) => [s.dmxFrom, s.dmxTo]), [[0, 0], [1, 255]]);
check('standard footprint', patchedChannels(type, standard).footprint, { 1: 5 });

const pixels = type.index.mode.get('Pixels');
const patched = patchedChannels(type, pixels);
check('pixel channel repeated per reference', patched.instances.filter((i) => i.instanceOf).map((i) => [i.instanceOf, i.offsets]), [['Pixel 1', [1]], ['Pixel 2', [4]]]);
check('virtual channel has no offsets', patched.instances.find((i) => !i.instanceOf).offsets, null);
check('virtual channel width from its values', pixels.channels[1].bytes, 2);
check('pixel footprint', patched.footprint, { 1: 4 });
check('relation kept', pixels.relations[0].type, 'Multiply');

check('model files by folder, case-insensitive', modelFiles(files, type.index.model.get('Head')), { gltf: 'models/gltf/Head.glb', '3ds': 'models/3DS/Head.3ds' });

let refused = '';
try {
  readGdtf(zipSync({ 'readme.txt': strToU8('hi') }), { parseXml });
} catch (err) {
  refused = err.message;
}
check('a zip without description.xml is refused', refused, 'not a GDTF file: no description.xml');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
