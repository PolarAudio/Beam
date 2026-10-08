/* eslint-disable no-console */
/**
 * A GDTF fixture's pan/tilt speed channel, as the head is told it.
 *
 * What is pinned: a speed the file states is a share of the head's top
 * speed, read along each function, several functions making a curve; a
 * function left at the spec's 0 to 1 runs fast to slow across its range as
 * a profile's speed channel does; leaving the channel for another function
 * releases the speed; and a function with no share above zero, a setting
 * that names a speed mode, tells the head nothing.
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
const fn = (name, from, physical) => `<ChannelFunction Name="${name}" Attribute="PositionMSpeed" DMXFrom="${from}/1" ${physical}/>`;
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="Mover" Manufacturer="Beam">
<AttributeDefinitions><Attributes>
  <Attribute Name="Pan"/><Attribute Name="PositionMSpeed"/><Attribute Name="Control1"/>
</Attributes></AttributeDefinitions>
<Geometries><Geometry Name="Base"><Axis Name="Yoke"><Axis Name="Head"><Beam Name="Beam"/></Axis></Axis></Geometry></Geometries>
<DMXModes>
  <DMXMode Name="Measured" Geometry="Base"><DMXChannels>
    <DMXChannel DMXBreak="1" Offset="1" Geometry="Yoke"><LogicalChannel Attribute="Pan">
      <ChannelFunction Name="Pan" Attribute="Pan" DMXFrom="0/1" PhysicalFrom="0" PhysicalTo="540"/>
    </LogicalChannel></DMXChannel>
    <DMXChannel DMXBreak="1" Offset="2" Geometry="Head"><LogicalChannel Attribute="PositionMSpeed">
      ${fn('Full to half', 0, 'PhysicalFrom="1" PhysicalTo="0.5"')}
      ${fn('Half to slowest', 128, 'PhysicalFrom="0.5" PhysicalTo="0.01"')}
    </LogicalChannel></DMXChannel>
  </DMXChannels></DMXMode>
  <DMXMode Name="Unstated" Geometry="Base"><DMXChannels>
    <DMXChannel DMXBreak="1" Offset="1" Geometry="Head"><LogicalChannel Attribute="PositionMSpeed">
      ${fn('Speed', 0, '')}
      <ChannelFunction Name="Reset" Attribute="Control1" DMXFrom="250/1"/>
    </LogicalChannel></DMXChannel>
  </DMXChannels></DMXMode>
  <DMXMode Name="Setting" Geometry="Base"><DMXChannels>
    <DMXChannel DMXBreak="1" Offset="1" Geometry="Head"><LogicalChannel Attribute="Control1">
      <ChannelFunction Name="Off" Attribute="NoFeature" DMXFrom="0/1"/>
      ${fn('Speed mode', 40, 'PhysicalFrom="0" PhysicalTo="0"')}
      <ChannelFunction Name="Rest" Attribute="NoFeature" DMXFrom="55/1"/>
    </LogicalChannel></DMXChannel>
  </DMXChannels></DMXMode>
</DMXModes>
</FixtureType></GDTF>`;
const { fixtureType: type, problems } = readGdtf(zipSync({ 'description.xml': strToU8(xml) }), { parseXml });
check('file reads', problems, []);

/** A dispatcher on a head that records what it is told. */
function rig(mode) {
  const engine = new DmxEngine(type, mode);
  const calls = [];
  const head = { setPanTiltSpeed: (v) => calls.push(v) };
  const dispatch = new HeadDispatch(head, engine);
  return (address, value) => {
    calls.length = 0;
    dispatch.apply(engine.write(address - 1, value));
    return calls.length ? calls[calls.length - 1] : 'not told';
  };
}
const round = (v) => (v && Number.isFinite(v.share) ? Math.round(v.share * 1000) / 1000 : v);
const percent = (v) => (v && Number.isFinite(v.speed) ? Math.round(v.speed) : v);

console.log('\na measured curve');
const measured = rig(type.modes[0]);
check('128 is half speed', round(measured(2, 128)), 0.5);
check('255 is the slowest stated', round(measured(2, 255)), 0.01);
check('64 is on the first stretch', round(measured(2, 64)), 0.748);
check('0 is full speed', round(measured(2, 0)), 1);

console.log('\na speed the file does not state');
const unstated = rig(type.modes[1]);
check('the end of the speed range is slow', percent(unstated(1, 249)), 0);
check('0 is fast', percent(unstated(1, 0)), 100);
check('another function releases the speed', unstated(1, 250), null);

console.log('\na speed mode setting');
const setting = rig(type.modes[2]);
check('a function with no share above zero tells nothing', setting(1, 45), 'not told');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
