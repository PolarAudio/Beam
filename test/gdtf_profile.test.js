/* eslint-disable no-console */
/**
 * GDTF DMX profiles: a channel function's curve from DMX to physical value.
 *
 * What is pinned: GDTF Builder's own S-curve example (200x^2 to half way,
 * then -200(x-0.5)^2 + 200(x-0.5) + 50) read as a share of the way from
 * PhysicalFrom to PhysicalTo along the function's own DMX range; before the
 * first point the output is 0; a function without a profile stays a straight
 * line; a channel set with its own range still states itself; and a profile
 * named but not defined is reported.
 *
 * Usage:
 *   npm test
 */
import { zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import readGdtf from '@/models/DMX/gdtf/gdtf_reader';
import { stateAt } from '@/models/DMX/gdtf/dmx_engine';
import { profileAt } from '@/models/DMX/gdtf/gdtf_values';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

const round = (n) => Math.round(n * 1000) / 1000;
const sCurve = [
  {
    dmxPercentage: 0, cfc0: 0, cfc1: 0, cfc2: 200, cfc3: 0,
  },
  {
    dmxPercentage: 50, cfc0: 50, cfc1: 200, cfc2: -200, cfc3: 0,
  },
];

console.log('\nthe curve on its own');
check('start', profileAt(sCurve, 0), 0);
check('a quarter along', round(profileAt(sCurve, 0.25)), 0.125);
check('half way', round(profileAt(sCurve, 0.5)), 0.5);
check('three quarters along', round(profileAt(sCurve, 0.75)), 0.875);
check('end', round(profileAt(sCurve, 1)), 1);
check('before the first point is 0', profileAt([{ ...sCurve[1] }], 0.25), 0);

const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');
const fixture = (functions) => `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="Curve" Manufacturer="Beam">
<AttributeDefinitions><Attributes><Attribute Name="Zoom"/></Attributes></AttributeDefinitions>
<PhysicalDescriptions><DMXProfiles>
  <DMXProfile Name="S"><Point DMXPercentage="0" CFC2="200"/><Point DMXPercentage="50" CFC0="50" CFC1="200" CFC2="-200"/></DMXProfile>
</DMXProfiles></PhysicalDescriptions>
<Geometries><Geometry Name="Body"><Beam Name="Beam"/></Geometry></Geometries>
<DMXModes><DMXMode Name="M" Geometry="Body"><DMXChannels>
  <DMXChannel DMXBreak="1" Offset="1" Geometry="Body"><LogicalChannel Attribute="Zoom">${functions}</LogicalChannel></DMXChannel>
</DMXChannels></DMXMode></DMXModes>
</FixtureType></GDTF>`;
const read = (functions) => readGdtf(zipSync({ 'description.xml': strToU8(fixture(functions)) }), { parseXml });

console.log('\nthrough a file and the engine');
const curved = read('<ChannelFunction Name="Zoom" Attribute="Zoom" DMXFrom="0/1" PhysicalFrom="10" PhysicalTo="50" DMXProfile="S"/>');
check('file reads', curved.problems, []);
const zoom = curved.fixtureType.modes[0].channels[0].logicalChannels[0].functions[0];
check('0 is PhysicalFrom', stateAt(zoom, 0).physical, 10);
check('255 is PhysicalTo', round(stateAt(zoom, 255).physical), 50);
check('a quarter along follows the curve', round(stateAt(zoom, 63.75).physical), 15);
check('half way follows the curve', round(stateAt(zoom, 127.5).physical), 30);

const straight = read('<ChannelFunction Name="Zoom" Attribute="Zoom" DMXFrom="0/1" PhysicalFrom="10" PhysicalTo="50"/>');
const line = straight.fixtureType.modes[0].channels[0].logicalChannels[0].functions[0];
check('no profile: a straight line', round(stateAt(line, 63.75).physical), 20);

const withSet = read('<ChannelFunction Name="Zoom" Attribute="Zoom" DMXFrom="0/1" PhysicalFrom="10" PhysicalTo="50" DMXProfile="S">'
  + '<ChannelSet Name="Wide" DMXFrom="200/1" PhysicalFrom="45" PhysicalTo="45"/></ChannelFunction>');
const setFn = withSet.fixtureType.modes[0].channels[0].logicalChannels[0].functions[0];
check('a set with its own range states itself', stateAt(setFn, 220).physical, 45);

const missing = read('<ChannelFunction Name="Zoom" Attribute="Zoom" DMXFrom="0/1" DMXProfile="Nope"/>');
check('an undefined profile is reported', missing.problems, ['DMX profile not defined: Nope']);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
