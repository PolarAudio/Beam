/* eslint-disable no-console */
/**
 * The DMX engine: bytes in, GDTF channel states out.
 *
 * What is pinned: coarse and fine bytes assemble into one value; the value
 * picks a function and a channel set and is stated in physical units; a mode
 * channel moving changes which function an untouched channel is in, and that
 * channel is reported; a channel starts at its function's default; a pixel
 * template's channels are addressed per reference; an address outside the
 * footprint is ignored.
 *
 * Usage:
 *   npm test
 */
import { zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import readGdtf from '@/models/DMX/gdtf/gdtf_reader';
import DmxEngine from '@/models/DMX/gdtf/dmx_engine';

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
const round = (n) => Math.round(n * 1000) / 1000;

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2">
<FixtureType Name="Test" Manufacturer="Beam">
<AttributeDefinitions><Attributes>
  <Attribute Name="Dimmer"/><Attribute Name="Zoom"/><Attribute Name="Control1"/><Attribute Name="Gobo1"/><Attribute Name="ColorAdd_R"/>
</Attributes></AttributeDefinitions>
<Wheels><Wheel Name="Gobo1"><Slot Name="Open"/><Slot Name="Star"/></Wheel></Wheels>
<Geometries>
  <Geometry Name="Base"><Axis Name="Head"><Beam Name="Lens"/></Axis></Geometry>
  <Geometry Name="Pixel"><Beam Name="PixelBeam"/></Geometry>
  <Geometry Name="Bar">
    <GeometryReference Name="Pixel 1" Geometry="Pixel"><Break DMXBreak="1" DMXOffset="1"/></GeometryReference>
    <GeometryReference Name="Pixel 2" Geometry="Pixel"><Break DMXBreak="1" DMXOffset="2"/></GeometryReference>
  </Geometry>
</Geometries>
<DMXModes>
  <DMXMode Name="Standard" Geometry="Base"><DMXChannels>
    <DMXChannel DMXBreak="1" Offset="1" Geometry="Base"><LogicalChannel Attribute="Control1">
      <ChannelFunction Name="Mode" Attribute="Control1" DMXFrom="0/1"/>
    </LogicalChannel></DMXChannel>
    <DMXChannel DMXBreak="1" Offset="2,3" Geometry="Head"><LogicalChannel Attribute="Dimmer">
      <ChannelFunction Name="Dimmer" Attribute="Dimmer" DMXFrom="0/1" Default="255/1"/>
    </LogicalChannel></DMXChannel>
    <DMXChannel DMXBreak="1" Offset="4" Geometry="Head"><LogicalChannel Attribute="Zoom">
      <ChannelFunction Name="Zoom Beam" Attribute="Zoom" DMXFrom="0/1" PhysicalFrom="2" PhysicalTo="38" ModeMaster="Base_Control1" ModeFrom="0/1" ModeTo="127/1"/>
      <ChannelFunction Name="Zoom Spot" Attribute="Zoom" DMXFrom="0/1" PhysicalFrom="2.8" PhysicalTo="28.6" ModeMaster="Base_Control1" ModeFrom="128/1" ModeTo="255/1"/>
    </LogicalChannel></DMXChannel>
    <DMXChannel DMXBreak="1" Offset="5" Geometry="Head"><LogicalChannel Attribute="Gobo1">
      <ChannelFunction Name="Gobo" Attribute="Gobo1" Wheel="Gobo1" DMXFrom="0/1">
        <ChannelSet Name="Open" DMXFrom="0/1" WheelSlotIndex="1"/>
        <ChannelSet Name="Star" DMXFrom="10/1" WheelSlotIndex="2"/>
      </ChannelFunction>
      <ChannelFunction Name="Spin" Attribute="Gobo1" DMXFrom="128/1" PhysicalFrom="-30" PhysicalTo="30"/>
    </LogicalChannel></DMXChannel>
  </DMXChannels></DMXMode>
  <DMXMode Name="Pixels" Geometry="Bar"><DMXChannels>
    <DMXChannel DMXBreak="1" Offset="1" Geometry="PixelBeam"><LogicalChannel Attribute="ColorAdd_R">
      <ChannelFunction Attribute="ColorAdd_R" DMXFrom="0/1"/>
    </LogicalChannel></DMXChannel>
  </DMXChannels></DMXMode>
</DMXModes>
</FixtureType>
</GDTF>`;

const { fixtureType: type } = readGdtf(zipSync({ 'description.xml': strToU8(xml) }), { parseXml });
const engine = new DmxEngine(type, type.index.mode.get('Standard'));
const ch = (name) => engine.channels.find((c) => c.name === name);

check('footprint', engine.footprint, 5);
check('dimmer starts at its default', ch('Head_Dimmer').value, 65535);
check('zoom starts in beam mode', ch('Head_Zoom').state.fn.name, 'Zoom Beam');

const coarseOnly = engine.write(1, 128);
check('coarse alone keeps the default fine byte', ch('Head_Dimmer').value, 33023);
check('a write reports the channel', coarseOnly.map((c) => c.name), ['Head_Dimmer']);
engine.write(2, 0);
check('coarse and fine assemble', ch('Head_Dimmer').value, 32768);
check('physical is the value in its range', round(ch('Head_Dimmer').state.physical), round(32768 / 65535));

engine.write(3, 255);
check('zoom at full in beam mode', ch('Head_Zoom').state.physical, 38);
const flipped = engine.write(0, 200);
check('mode channel reports its dependents', flipped.map((c) => c.name), ['Base_Control1', 'Head_Zoom']);
check('zoom now in spot mode', [ch('Head_Zoom').state.fn.name, ch('Head_Zoom').state.physical], ['Zoom Spot', 28.6]);

engine.write(4, 20);
check('gobo slot set', [ch('Head_Gobo1').state.fn.name, ch('Head_Gobo1').state.set.name, ch('Head_Gobo1').state.set.wheelSlotIndex], ['Gobo', 'Star', 2]);
engine.write(4, 255);
check('gobo spin physical', [ch('Head_Gobo1').state.fn.name, ch('Head_Gobo1').state.physical], ['Spin', 30]);
check('same value again reports nothing', engine.write(4, 255), []);
check('address outside the footprint ignored', engine.write(9, 1), []);

const pixels = new DmxEngine(type, type.index.mode.get('Pixels'));
check('pixel channels per reference', pixels.channels.map((c) => [c.name, c.offsets]), [['Pixel 1.PixelBeam_ColorAdd_R', [1]], ['Pixel 2.PixelBeam_ColorAdd_R', [2]]]);
pixels.write(1, 255);
check('second pixel written alone', pixels.channels.map((c) => c.value), [0, 255]);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
