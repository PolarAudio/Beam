/* eslint-disable no-console */
/**
 * A GDTF gobo shake, as the head is told it.
 *
 * What is pinned: the shake's rate is the function's physical value in Hz
 * along its range; the attribute's Amplitude sub-unit, the peak swing in
 * percent of the image, reaches the head with it; a file without one leaves
 * the swing to the head; and so does one that only repeats the spec's own
 * definition, 20 or 0.2, as GDTF Builder writes into every file.
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
const fixture = (amplitude) => `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="Spot" Manufacturer="Beam">
<AttributeDefinitions><Attributes>
  <Attribute Name="Gobo1"/>
  <Attribute Name="Gobo1SelectShake" PhysicalUnit="Frequency">${amplitude}</Attribute>
</Attributes></AttributeDefinitions>
<Wheels><Wheel Name="Gobo Wheel"><Slot Name="Open"/><Slot Name="Star"/></Wheel></Wheels>
<Geometries><Geometry Name="Base"><Axis Name="Yoke"><Axis Name="Head"><Beam Name="Beam"/></Axis></Axis></Geometry></Geometries>
<DMXModes><DMXMode Name="M" Geometry="Base"><DMXChannels>
  <DMXChannel DMXBreak="1" Offset="1" Geometry="Head"><LogicalChannel Attribute="Gobo1">
    <ChannelFunction Name="Star" Attribute="Gobo1" DMXFrom="0/1" Wheel="Gobo Wheel"><ChannelSet Name="Star" DMXFrom="0/1" WheelSlotIndex="2"/></ChannelFunction>
    <ChannelFunction Name="Star shake" Attribute="Gobo1SelectShake" DMXFrom="128/1" PhysicalFrom="1" PhysicalTo="4" Wheel="Gobo Wheel"><ChannelSet Name="Star shake" DMXFrom="128/1" WheelSlotIndex="2"/></ChannelFunction>
  </LogicalChannel></DMXChannel>
</DMXChannels></DMXMode></DMXModes>
</FixtureType></GDTF>`;

/** What the head is told when the channel goes to a value. */
function told(xml, value) {
  const { fixtureType: type } = readGdtf(zipSync({ 'description.xml': strToU8(xml) }), { parseXml });
  const engine = new DmxEngine(type, type.modes[0]);
  let shake = null;
  const head = { setWheelShake: (wheel, values) => { shake = values; } };
  new HeadDispatch(head, engine).apply(engine.write(0, value));
  return shake;
}
const round = (v) => Math.round(v * 100) / 100;

console.log('\nwith an amplitude');
const measured = fixture('<SubPhysicalUnit Type="Amplitude" PhysicalUnit="Percent" PhysicalFrom="25" PhysicalTo="25"/>');
check('slowest end: 1 Hz', round(told(measured, 128).rate), 1);
check('fastest end: 4 Hz', round(told(measured, 255).rate), 4);
check('the swing reaches the head', told(measured, 200).shakeAmplitude, 25);
check('on the slot the set names', told(measured, 200).slotNumber, 2);

console.log('\nwithout one');
const silent = fixture('');
check('no swing is stated', told(silent, 200).shakeAmplitude, undefined);

console.log('\nthe spec\'s template, as GDTF Builder copies it');
const template = (v) => fixture(`<SubPhysicalUnit Type="Amplitude" PhysicalUnit="Percent" PhysicalFrom="${v}" PhysicalTo="${v}"/>`);
check('20 is the template, not the fixture', told(template('20.000000'), 200).shakeAmplitude, undefined);
check('0.2 is the same template', told(template('0.200000'), 200).shakeAmplitude, undefined);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
