/* eslint-disable no-console */
/**
 * A lens focused by hand, as a GDTF file states it: a focus channel with no
 * DMX address.
 *
 * What is pinned: such a channel takes no address, so the footprint is the
 * fixture's DMX channels only; a fixture in a mode with one offers manual
 * focus and one without does not; the placement's focus is kept and saved;
 * telling the head every channel's starting state leaves the hand-set lens
 * alone, while a focus channel on DMX still drives it; and a profile marked
 * `lens.focus: "manual"` translates to the same channel.
 *
 * Usage:
 *   npm test
 */
import { zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import readGdtf from '@/models/DMX/gdtf/gdtf_reader';
import DmxEngine from '@/models/DMX/gdtf/dmx_engine';
import HeadDispatch from '@/models/DMX/gdtf/head_dispatch';
import Fixture from '@/models/DMX/fixture.model';
import translateOfl from '@/models/DMX/gdtf/ofl_to_gdtf';
import tomshine from '../public/fixtures/tomshine/80w-led-gobo-moving-head.json';

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
const focus = (offset) => `<DMXChannel DMXBreak="1" Offset="${offset}" Geometry="Body"><LogicalChannel Attribute="Focus1">
  <ChannelFunction Name="Focus" Attribute="Focus1" DMXFrom="0/1" Default="128/1" PhysicalFrom="0" PhysicalTo="1"/>
</LogicalChannel></DMXChannel>`;
const dimmer = `<DMXChannel DMXBreak="1" Offset="1" Geometry="Body"><LogicalChannel Attribute="Dimmer">
  <ChannelFunction Name="Dimmer" Attribute="Dimmer" DMXFrom="0/1"/>
</LogicalChannel></DMXChannel>`;
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="Spot" Manufacturer="Beam">
<AttributeDefinitions><Attributes><Attribute Name="Dimmer"/><Attribute Name="Focus1"/></Attributes></AttributeDefinitions>
<Geometries><Geometry Name="Body"/></Geometries>
<DMXModes>
  <DMXMode Name="Hand" Geometry="Body"><DMXChannels>${dimmer}${focus('None')}</DMXChannels></DMXMode>
  <DMXMode Name="Plain" Geometry="Body"><DMXChannels>${dimmer}</DMXChannels></DMXMode>
  <DMXMode Name="Motor" Geometry="Body"><DMXChannels>${dimmer}${focus('2')}</DMXChannels></DMXMode>
</DMXModes>
</FixtureType></GDTF>`;
const { fixtureType, problems } = readGdtf(zipSync({ 'description.xml': strToU8(xml) }), { parseXml });
check('file reads', problems, []);

console.log('\nthe channel');
const hand = new DmxEngine(fixtureType, fixtureType.modes[0]);
check('no address: footprint is the dimmer alone', hand.footprint, 1);

console.log('\nthe fixture');
const make = (mode) => new Fixture({
  id: 1, manufacturer: 'Beam', model: 'Spot', mode, address: 0, OFLData: null, fixtureType, focusDistance: 7.5,
});
const byHand = make(0);
check('a mode with a hand-wound lens offers manual focus', byHand.hasManualFocus, true);
check('the placement keeps its focus distance', byHand.focusDistance, 7.5);
check('and saves it', byHand.showData.focusDistance, 7.5);
const legacy = (focus) => new Fixture({
  id: 1, manufacturer: 'Beam', model: 'Spot', mode: 0, address: 0, OFLData: null, fixtureType, focus,
}).focusDistance;
check('a show saved in percent: 50 is twice the nearest', legacy(50), 2);
check('a show saved in percent: 100 is the farthest', legacy(100), 100);
check('a show saved in percent: 0 is the nearest', legacy(0), 1);
check('a mode without one does not', make(1).hasManualFocus, false);
check('a focus on DMX is not by hand', make(2).hasManualFocus, false);

console.log('\nthe head');
const told = (mode) => {
  const engine = new DmxEngine(fixtureType, mode);
  const head = { focus: 30 };
  new HeadDispatch(head, engine).applyAll();
  return head.focus;
};
check('starting state leaves the hand-set lens alone', told(fixtureType.modes[0]), 30);
check('a focus channel on DMX still drives the lens', Math.round(told(fixtureType.modes[2])), 50);

console.log('\na profile marked lens.focus: "manual"');
const { fixtureType: translatedType } = translateOfl(tomshine, { manufacturer: 'Tomshine' });
const virtualIn = (mode) => mode.channels.filter((c) => !c.offsets).map((c) => c.name);
const everyMode = [['Head_Focus1'], ['Head_Focus1']];
check('every mode gets the hand-wound focus', translatedType.modes.map(virtualIn), everyMode);
check('the footprints are unchanged', translatedType.modes
  .map((m) => new DmxEngine(translatedType, m).footprint), [11, 9]);
const lens = { degreesMinMax: [11, 11] };
const unmarked = { ...tomshine, physical: { ...tomshine.physical, lens } };
check('an unmarked profile gets none', translateOfl(unmarked).fixtureType.modes.map(virtualIn), [[], []]);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
