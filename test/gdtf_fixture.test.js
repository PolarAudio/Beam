/* eslint-disable no-console */
/**
 * A fixture built from a GDTF fixture type.
 *
 * What is pinned: one channel row per address with fine bytes as rows of
 * their own; values read as `value.DMX` like an OFL channel's; a mode chosen
 * by its place in the list is kept by name; a fixture with nothing to draw
 * still holds its values; the listing names each mode's channels and gives
 * each channel its role and fine byte, which is what the MadMapper export
 * reads.
 *
 * Usage:
 *   npm test
 */
import { zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import readGdtf from '@/models/DMX/gdtf/gdtf_reader';
import Fixture from '@/models/DMX/fixture.model';
import { buildMadMapperFixture } from '@/models/DMX/generic/madmapper';
import { fixtureIslands } from '@/models/DMX/fixture_islands';

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
const channel = (offset, attribute) => `
    <DMXChannel DMXBreak="1" Offset="${offset}" Geometry="Body"><LogicalChannel Attribute="${attribute}">
      <ChannelFunction Name="${attribute}" Attribute="${attribute}" DMXFrom="0/1"/>
    </LogicalChannel></DMXChannel>`;

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="Par" Manufacturer="Beam">
<AttributeDefinitions><Attributes>
  <Attribute Name="Dimmer"/><Attribute Name="ColorAdd_R"/><Attribute Name="ColorAdd_G"/><Attribute Name="ColorAdd_B"/>
</Attributes></AttributeDefinitions>
<Geometries><Geometry Name="Body"/></Geometries>
<DMXModes>
  <DMXMode Name="RGB" Geometry="Body"><DMXChannels>${channel(1, 'ColorAdd_R')}${channel(2, 'ColorAdd_G')}${channel(3, 'ColorAdd_B')}</DMXChannels></DMXMode>
  <DMXMode Name="Dimmer RGB" Geometry="Body"><DMXChannels>${channel('1,2', 'Dimmer')}${channel(3, 'ColorAdd_R')}${channel(4, 'ColorAdd_G')}${channel(5, 'ColorAdd_B')}</DMXChannels></DMXMode>
</DMXModes>
</FixtureType></GDTF>`;

const { fixtureType } = readGdtf(zipSync({ 'description.xml': strToU8(xml) }), { parseXml });

const fixture = new Fixture({
  id: 1, manufacturer: 'Beam', model: 'Par', mode: 1, address: 0, OFLData: null, fixtureType,
});
check('mode by place, kept by name', fixture.modeName, 'Dimmer RGB');
check('one row per address', fixture.channels.length, 5);
check('row names', fixture.channels.map((c) => c.name), ['Dimmer', 'Dimmer fine', 'Red', 'Green', 'Blue']);
check('fine byte is a row of its own', fixture.channels.map((c) => c.isFine), [false, true, false, false, false]);
check('no beam: nothing to draw', fixture.category, 'Other');
fixture.setChannel(2, 200);
check('value held as value.DMX', fixture.channels[2].value.DMX, 200);
check('the show saves the mode by name', fixture.showData.mode, 'Dimmer RGB');

const listing = Fixture.gdtfListing(fixtureType);
check('listing modes', listing.modes.map((m) => m.channels.length), [3, 5]);
check('listing role of a colour', listing.availableChannels.Red.capability, { type: 'ColorIntensity', color: 'Red' });
check('listing fine byte', listing.availableChannels.Dimmer.fineChannelAliases, ['Dimmer fine']);
check('islands: dimmer folds its fine byte', fixtureIslands(listing, listing.modes[1]).map((island) => island.widths), [[16], [8, 8, 8]]);
const mmfl = buildMadMapperFixture(listing, { mode: listing.modes[1], product: 'Par', group: 'Beam' });
check('MadMapper fixture written', typeof mmfl === 'string' && mmfl.includes('Dimmer'), true);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
