/* eslint-disable no-console */
/**
 * A GDTF wheel spin stops when the channel leaves it.
 *
 * What is pinned: a gobo channel moved from a WheelSpin range to one that
 * positions no slot -- a wheel mode -- or to a slot leaves the wheel still,
 * as it does after a shake.
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
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="Spot" Manufacturer="Beam">
<AttributeDefinitions><Attributes>
  <Attribute Name="Gobo1WheelMode"/>
  <Attribute Name="Gobo1"/>
  <Attribute Name="Gobo1WheelSpin" PhysicalUnit="AngularSpeed"/>
</Attributes></AttributeDefinitions>
<Wheels><Wheel Name="Gobo Wheel"><Slot Name="Open"/><Slot Name="Star"/></Wheel></Wheels>
<Geometries><Geometry Name="Base"><Axis Name="Yoke"><Axis Name="Head"><Beam Name="Beam"/></Axis></Axis></Geometry></Geometries>
<DMXModes><DMXMode Name="M" Geometry="Base"><DMXChannels>
  <DMXChannel DMXBreak="1" Offset="1" Geometry="Head"><LogicalChannel Attribute="Gobo1">
    <ChannelFunction Name="Mode" Attribute="Gobo1WheelMode" DMXFrom="0/1"/>
    <ChannelFunction Name="Star" Attribute="Gobo1" DMXFrom="22/1" Wheel="Gobo Wheel"><ChannelSet Name="Star" DMXFrom="22/1" WheelSlotIndex="2"/></ChannelFunction>
    <ChannelFunction Name="Spin" Attribute="Gobo1WheelSpin" DMXFrom="190/1" PhysicalFrom="-1440" PhysicalTo="1440" Wheel="Gobo Wheel"/>
  </LogicalChannel></DMXChannel>
</DMXChannels></DMXMode></DMXModes>
</FixtureType></GDTF>`;

/** The wheel's turning speed after the channel visits each value in turn. */
function spinAfter(...values) {
  const { fixtureType: type } = readGdtf(zipSync({ 'description.xml': strToU8(xml) }), { parseXml });
  const engine = new DmxEngine(type, type.modes[0]);
  let rpm = 0;
  const head = {
    setWheelRotation: (wheel, v) => { if (Number.isFinite(v.rpm)) rpm = v.rpm; },
    setWheelSlot: () => { rpm = 0; },
    setWheelShake: () => { rpm = 0; },
  };
  const dispatch = new HeadDispatch(head, engine);
  values.forEach((value) => dispatch.apply(engine.write(0, value)));
  return rpm;
}

check('spinning in the spin range', spinAfter(190) !== 0, true);
check('stopped once back on the wheel mode', spinAfter(190, 0), 0);
check('stopped on a slot', spinAfter(190, 22), 0);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
