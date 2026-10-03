/* eslint-disable no-console */
/**
 * GDTF channel states acted on by a moving head.
 *
 * What is pinned: a GDTF fixture reaches the head in the units it was always
 * given -- dimmer 0 to 1, pan and tilt counted up from the lowest angle the
 * file gives, zoom in degrees, CMY by colour name, a wheel slot as a 0-based
 * index, a rotation in rpm, a strobe as an effect and a rate; a prism is
 * released by the channel that set it; a value no function covers holds the
 * head where it was.
 *
 * Usage:
 *   npm test
 */
import { zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import readGdtf from '@/models/DMX/gdtf/gdtf_reader';
import DmxEngine from '@/models/DMX/gdtf/dmx_engine';
import HeadDispatch from '@/models/DMX/gdtf/head_dispatch';

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
const r = (n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n);

/** A stand-in head that records what it is told. */
function recordingHead() {
  const log = [];
  const head = new Proxy({
    setWheelSlot: (...a) => log.push(['setWheelSlot', ...a.map(r)]),
    setWheelSlotRotation: (w, v) => log.push(['setWheelSlotRotation', w, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, r(x)]))]),
    setPrism: (...a) => log.push(['setPrism', ...a]),
    setZoom: (...a) => log.push(['setZoom', ...a.map(r)]),
  }, {
    set(target, key, value) {
      log.push([key, typeof value === 'object' ? value : r(value)]);
      return true;
    },
  });
  return { head, log };
}

const channel = (offset, geometry, attribute, functions) => `
    <DMXChannel DMXBreak="1" Offset="${offset}" Geometry="${geometry}"><LogicalChannel Attribute="${attribute}">${functions}</LogicalChannel></DMXChannel>`;

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="Head" Manufacturer="Beam">
<AttributeDefinitions><Attributes>
  <Attribute Name="Pan"/><Attribute Name="Tilt"/><Attribute Name="Dimmer"/><Attribute Name="Zoom"/><Attribute Name="ColorSub_C"/>
  <Attribute Name="Gobo1"/><Attribute Name="Gobo1PosRotate"/><Attribute Name="Shutter1"/><Attribute Name="Shutter1Strobe"/><Attribute Name="Prism1"/>
</Attributes></AttributeDefinitions>
<Wheels><Wheel Name="Gobo Wheel"><Slot Name="Open"/><Slot Name="Star"/></Wheel></Wheels>
<Geometries><Geometry Name="Base"><Axis Name="Yoke"><Axis Name="Head"><Beam Name="Lens"/></Axis></Axis></Geometry></Geometries>
<DMXModes><DMXMode Name="Mode" Geometry="Base"><DMXChannels>
${channel(1, 'Yoke', 'Pan', '<ChannelFunction Name="Pan" Attribute="Pan" DMXFrom="0/1" PhysicalFrom="-270" PhysicalTo="270"/>')}
${channel(2, 'Head', 'Tilt', '<ChannelFunction Name="Tilt" Attribute="Tilt" DMXFrom="0/1" PhysicalFrom="-135" PhysicalTo="135"/>')}
${channel(3, 'Head', 'Dimmer', '<ChannelFunction Name="Dimmer" Attribute="Dimmer" DMXFrom="0/1"/>')}
${channel(4, 'Head', 'Zoom', '<ChannelFunction Name="Zoom" Attribute="Zoom" DMXFrom="0/1" PhysicalFrom="40" PhysicalTo="4"/>')}
${channel(5, 'Head', 'ColorSub_C', '<ChannelFunction Name="Cyan" Attribute="ColorSub_C" DMXFrom="0/1"/>')}
${channel(6, 'Head', 'Gobo1', `<ChannelFunction Name="Gobo" Attribute="Gobo1" Wheel="Gobo Wheel" DMXFrom="0/1">
      <ChannelSet Name="Open" DMXFrom="0/1" WheelSlotIndex="1"/><ChannelSet Name="Star" DMXFrom="10/1" WheelSlotIndex="2"/>
    </ChannelFunction>
    <ChannelFunction Name="Spin" Attribute="Gobo1PosRotate" Wheel="Gobo Wheel" DMXFrom="128/1" PhysicalFrom="-360" PhysicalTo="360"/>`)}
${channel(7, 'Head', 'Shutter1', `<ChannelFunction Name="Closed" Attribute="Shutter1" DMXFrom="0/1"/>
    <ChannelFunction Name="Open" Attribute="Shutter1" DMXFrom="10/1"/>
    <ChannelFunction Name="Strobe" Attribute="Shutter1Strobe" DMXFrom="20/1" PhysicalFrom="1" PhysicalTo="20"/>`)}
${channel(8, 'Head', 'Prism1', `<ChannelFunction Name="Out" Attribute="NoFeature" DMXFrom="0/1"/>
    <ChannelFunction Name="3-facet" Attribute="Prism1" DMXFrom="128/1"/>`)}
</DMXChannels></DMXMode></DMXModes>
</FixtureType></GDTF>`;

const { fixtureType: type } = readGdtf(zipSync({ 'description.xml': strToU8(xml) }), { parseXml });
const engine = new DmxEngine(type, type.modes[0]);
const { head, log } = recordingHead();
const dispatch = new HeadDispatch(head, engine);
const write = (address, value) => {
  log.length = 0;
  dispatch.apply(engine.write(address, value));
  return log.slice();
};

check('pan counted from the lowest angle', write(0, 255), [['pan', 540]]);
check('tilt counted from the lowest angle', write(1, 128), [['tilt', r((128 / 255) * 270)]]);
check('dimmer 0 to 1', write(2, 255), [['intensity', 1]]);
check('zoom in degrees', write(3, 255), [['setZoom', 4, true]]);
check('CMY by colour name', write(4, 255), [['colorIntensity', { color: 'Cyan', colorBrightness: 1 }]]);
check('gobo slot, 0-based', write(5, 20), [['setWheelSlot', 'Gobo Wheel', 1]]);
check('gobo rotation in rpm', write(5, 255), [['setWheelSlotRotation', 'Gobo Wheel', { wheel: 'Gobo Wheel', rpm: 60 }]]);
check('shutter open', write(6, 15), [['strobeEffect', 'Open'], ['strobeRandom', false]]);
check('strobe effect and rate', write(6, 255), [['strobeEffect', 'Strobe'], ['strobeRandom', false], ['strobeFrequency', 20]]);
check('prism in', write(7, 200), [['setPrism', true, '3-facet Head_Prism1']]);
check('prism released by its channel', write(7, 0), [['setPrism', false]]);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
