/* eslint-disable no-console */
/**
 * GDTF lasers known by their channels, the way most laser files describe
 * one: no Laser geometry, a maker's own attributes, and content picked by
 * cue, media slot or gobo.
 *
 * What is pinned: a laser attribute or a laser name with a figure scale
 * makes a laser, and a named laser on a yoke stays a moving head unless a
 * channel picks its content; the clip, mode and test pattern channels are
 * found; each range's value comes from the number in its name or else its
 * position; a channel with one content range gives its raw value; a range
 * that answers for another channel's state reads the first state only; and
 * the file's footprint is kept.
 *
 * Usage:
 *   npm test
 */
import { zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import readGdtf from '@/models/DMX/gdtf/gdtf_reader';
import { fixtureCategory } from '@/models/DMX/gdtf/fixture_parts';
import { laserParams } from '@/models/DMX/gdtf/laser_parts';
import {
  namesNothing, numberInName, namesLaserAttribute, laserModeFromName,
} from '@/models/DMX/gdtf/name_rules';
import { buildLaserProfile } from '@/models/DMX/generic/laser';
import LaserSettings from '@/models/DMX/laser_settings';
import { TEST_PATTERN_IDS } from '@/models/DMX/laser_clips';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

console.log('\nthe rules on their own');
check('Disabled, Blackout and an open slot select nothing', ['Disabled', 'Blackout', 'Wheel Slot 0 OPEN', 'Cue 1'].map(namesNothing), [true, true, true, false]);
check('the number a name ends in', ['Cue 12', 'Wheel Slot 0 OPEN', '075', 'Patterns'].map(numberInName), [12, 0, 75, null]);
check('laser attributes', ['LaserCue', 'Scan_Rate', 'ScanFrequency', 'PatternSelection', 'Pan'].map(namesLaserAttribute), [true, true, true, false, false]);
check('mode names', ['Disabled', 'Playback Mode', 'Auto', 'Blackout'].map(laserModeFromName), ['input', 'standalone', 'standalone', 'off']);

const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');
const sets = (list) => list.map(([name, from]) => `<ChannelSet Name="${name}" DMXFrom="${from}/1"/>`).join('');
const fn = (attribute, from, inner = '', extra = '') => `<ChannelFunction Name="${attribute}" Attribute="${attribute}" DMXFrom="${from}/1" ${extra}>${inner}</ChannelFunction>`;
const dmx = (offset, attribute, functions) => `<DMXChannel DMXBreak="1" Offset="${offset}" Geometry="Body"><LogicalChannel Attribute="${attribute}">${functions}</LogicalChannel></DMXChannel>`;
const read = (name, geometry, channels) => readGdtf(zipSync({
  'description.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="${name}" Manufacturer="Maker">
<AttributeDefinitions><Attributes/></AttributeDefinitions>
<Geometries>${geometry}</Geometries>
<DMXModes><DMXMode Name="Std" Geometry="Body"><DMXChannels>${channels}</DMXChannels></DMXMode></DMXModes>
</FixtureType></GDTF>`),
}), { parseXml }).fixtureType;
const box = '<Geometry Name="Body"/>';
const yoke = '<Geometry Name="Body"><Axis Name="Yoke"><Axis Name="Head"><Beam Name="Beam"/></Axis></Axis></Geometry>';

/** The values a control takes at each DMX value. */
function drive(params, key, values) {
  const settings = new LaserSettings(params);
  const { channel } = params.controls[key];
  return values.map((v) => { settings.writeChannel(channel - 1, v); return settings.value(key); });
}

console.log('\na controller laser: mode, cue and test cue');
const cues = read('Controller', box, [
  dmx(1, 'Mode', fn('Mode', 0, sets([['Disabled', 0], ['Setup Mode', 240], ['Playback Mode', 251]]))),
  dmx(2, 'LaserCue', fn('LaserCue', 0, sets([['Cue 0', 0], ['Cue 1', 32], ['Cue 2', 36], ['', 40]]))),
  dmx(3, 'TestCue', fn('TestCue', 0, sets([['Disabled', 0], ['Test Cue 1', 1], ['Test Cue 2', 2]]))),
  dmx(5, 'Dimmer', fn('Dimmer', 0)),
].join(''));
check('a laser attribute makes a laser', fixtureCategory(cues), 'Laser');
const p = laserParams(cues);
check('the box body and the default aperture', [p.width, p.aperture], [0.30, null]);
check('mode, clip and test pattern are on their channels', ['mode', 'clip', 'testPattern'].map((k) => p.controls[k].channel), [1, 2, 3]);
check('the mode its range names', drive(p, 'mode', [0, 245, 255]), ['input', 'input', 'standalone']);
check('the cue its range names, Cue 0 none', drive(p, 'clip', [0, 31, 32, 36, 39, 40, 255]), [null, null, 1, 2, 2, null, null]);
check('the nth test pattern', drive(p, 'testPattern', [0, 1, 2]), TEST_PATTERN_IDS.slice(0, 3));
check('the file footprint is kept', buildLaserProfile(p).modes[0].channels.length, 5);

console.log('\npage and cue make one clip number');
const paged = read('Paged', box, [
  dmx(1, 'LaserPage', fn('LaserPage', 0, sets([['Disabled', 0], ['Page 1', 1], ['Page 2', 2], ['Page 3', 3]]))),
  dmx(2, 'LaserCue', fn('LaserCue', 0, sets([['Disabled', 0], ['Cue 1', 1], ['Cue 2', 2], ['Cue 3', 3], ['Cue 4', 4]]))),
].join(''));
const pp = laserParams(paged);
check('the page channel and the cues a page holds', [pp.clipPage.channel, pp.clipPage.perPage], [1, 4]);
const list = Array.from({ length: 12 }, (_, i) => ({ id: `c${i + 1}`, kind: 'file', file: `${i + 1}.ild` }));
const deck = new LaserSettings(pp, { protocol: 'clips', clips: list });
const playing = (page, cue) => {
  deck.writeChannel(0, page);
  deck.writeChannel(1, cue);
  const clip = deck.currentClip;
  return clip ? clip.id : null;
};
check('page 1 cue 2 is clip 2', playing(1, 2), 'c2');
check('page 3 cue 2 is clip 10', playing(3, 2), 'c10');
check('page Disabled is page 1', playing(0, 3), 'c3');
check('cue Disabled plays nothing on any page', playing(2, 0), null);
playing(3, 2);
const reloaded = new LaserSettings(pp, deck.showData);
check('the page and cue are saved', [reloaded.value('clip'), reloaded.currentClip && reloaded.currentClip.id], [2, 'c10']);
reloaded.set('clip', null);
check('a driven clip at 0 plays nothing after a load', reloaded.currentClip, null);

console.log('\nsize and position along the physical range');
const sized = read('Sized Laser', box, [
  dmx(1, 'MaximumXSize', fn('MaximumXSize', 0, '', 'PhysicalFrom="0" PhysicalTo="1"')),
  dmx(2, 'Scale_Y', fn('Scale_Y', 0, '', 'PhysicalFrom="100" PhysicalTo="0"')),
  dmx(3, 'XPosition', fn('XPosition', 0, '', 'PhysicalFrom="0" PhysicalTo="1"')),
  dmx(4, 'Scale_X', fn('Scale_X', 0, '', 'PhysicalFrom="0" PhysicalTo="1"')),
].join(''));
const sp = laserParams(sized);
check('a zone size is the size limit', sp.controls.xSizeLimit.channel, 1);
check('the cue size is the scale', sp.controls.xScale.channel, 4);
check('a fraction is a percent', drive(sp, 'xScale', [0, 255]), [0, 100]);
check('a scale running down', drive(sp, 'yScale', [0, 255]), [100, 0]);
check('a position across the range', drive(sp, 'xPos', [0, 255]), [-100, 100]);
const twoWays = read('Two Ways Laser', box, [
  dmx(1, 'Scale_X', fn('Scale_X', 0, '', 'PhysicalFrom="-180" PhysicalTo="180"') + fn('Scale_X', 128, '', 'PhysicalFrom="-360" PhysicalTo="360"')),
].join(''));
check('a channel with two functions is not a size', laserParams(twoWays).controls.xScale, undefined);
const named = read('Named Laser', box, [
  dmx(1, 'Scale_X', fn('Scale_X', 0, sets([['max', 0], ['', 1], ['min', 255]]), 'PhysicalFrom="0" PhysicalTo="1"')),
  dmx(2, 'MaximumDimmer', fn('MaximumDimmer', 0, sets([['Min', 0], ['', 1], ['Max', 255]]))),
  dmx(3, 'Dimmer', fn('Dimmer', 0)),
].join(''));
const np = laserParams(named);
check('named ends over the physical range', drive(np, 'xScale', [0, 255]), [100, 0]);
const signed = read('Signed Laser', box, [
  dmx(1, 'LaserXSize', fn('LaserXSize', 0, sets([['-100%', 0], ['', 1], ['0%', 127], ['', 128], ['100%', 255]]))),
  dmx(2, 'Scale_Y', fn('Scale_Y', 0)),
].join(''));
const described = read('Described Laser', box, [
  dmx(1, 'Scale_X', fn('Scale_X', 0, sets([['Size X from big to small', 0]]), 'PhysicalFrom="0" PhysicalTo="1"')),
  dmx(2, 'PlaySpeed', fn('PlaySpeed', 0, sets([['Scan speed', 0], ['Point speed', 128]]))),
].join(''));
const dp = laserParams(described);
check('one set describing the range, falling', drive(dp, 'xScale', [0, 255]), [100, 0]);
check('sets naming a choice are not a speed', dp.controls.speed, undefined);
const zoomed = read('Zoomed Laser', box, [
  dmx(1, 'Zoom', fn('Zoom', 0, sets([['Min', 0], ['', 1], ['Center', 128], ['', 129], ['Max', 255]]))),
  dmx(2, 'Scale_XYZ', fn('Scale_XYZ', 0, sets([['-100', 0], ['000', 128], ['100', 255]]))),
].join(''));
check('zoom Min to Max, no default', drive(laserParams(zoomed), 'zoom', [0, 255]), [0, 100]);
const centred = read('Centred Laser', box, [
  dmx(1, 'Zoom', fn('Zoom', 0, sets([['Min', 0], ['', 1], ['Max', 255]]), 'Default="128/1"')),
  dmx(2, 'Scale_X', fn('Scale_X', 0)),
].join(''));
check('zoom Min to Max is 0-100 %, wherever the default', drive(laserParams(centred), 'zoom', [0, 255]), [0, 100]);
const xyz = read('XYZ Laser', box, [
  dmx(1, 'Scale_XYZ', fn('Scale_XYZ', 0, sets([['-100', 0], ['000', 128], ['100', 255]]), 'Default="128/1"')),
].join(''));
check('a zoom named 0 at its default is a change from 100 %', drive(laserParams(xyz), 'zoom', [0, 128, 255]), [0, 100, 200]);
check('a size below 0 % turns the figure over', drive(laserParams(signed), 'xScale', [0, 127, 255]), [-100, 0, 100]);
const zone = new LaserSettings(np);
zone.writeChannel(1, 128);
zone.writeChannel(2, 255);
check('the light out is the dimmer times its limit', Math.round(zone.gain * 100), 50);

console.log('\nscan rate and speed through the percentages the ranges name');
const timed = read('Timed Laser', box, [
  dmx(1, 'ScanRate', fn('ScanRate', 0, sets([['25%', 0], ['', 1], ['100%', 255]]))),
  dmx(2, 'LaserSpeed', fn('LaserSpeed', 0, sets([
    ['Default Speed', 0], ['0%', 17], ['25%', 32], ['', 33], ['50%', 64], ['', 65],
    ['100%', 127], ['', 128], ['200%', 255],
  ]))),
  dmx(3, 'Scale_X', fn('Scale_X', 0)),
].join(''));
const tp = laserParams(timed);
check('scan rate 25 % to 100 %', drive(tp, 'scanRate', [0, 255]), [25, 100]);
check('speed: Default held, then 0 % to 200 %', drive(tp, 'speed', [0, 16, 17, 32, 48, 127, 191, 255]), [100, 100, 0, 25, 37.5, 100, 150, 200]);
const minMax = read('MinMax Laser', box, [
  dmx(1, 'LaserSpeed', fn('LaserSpeed', 0, sets([['Default Speed', 0], ['Min', 1], ['', 2], ['Max', 255]]))),
  dmx(2, 'Scale_X', fn('Scale_X', 0)),
].join(''));
check('Min and Max are the ends of the speed range', drive(laserParams(minMax), 'speed', [0, 1, 255]), [100, 0, 255]);
const unnamed = read('Unnamed Laser', box, [
  dmx(1, 'PlaySpeed', fn('PlaySpeed', 0, sets([['Default', 0], ['', 1]]))),
  dmx(2, 'Scale_X', fn('Scale_X', 0)),
].join(''));
check('a speed with no numbers is not read', laserParams(unnamed).controls.speed, undefined);
const clock = new LaserSettings(tp);
clock.writeChannel(0, 0);
clock.writeChannel(1, 255);
check('the clip clock is scan rate times speed', clock.clipClock, 0.5);

console.log('\nrotation');
const turning = read('Turning Laser', box, [
  dmx(1, 'ZIndexRotation', fn('ZIndexRotation', 0, sets([['0', 0], ['', 1], ['90', 64], ['180', 128], ['360', 255]]))),
  dmx(2, 'Rot_Z', fn('Rot_Z', 0, sets([['-180', 0], ['', 1], ['Home', 128], ['', 129], ['180', 255]]), 'PhysicalFrom="-180" PhysicalTo="180"')),
  dmx(3, 'ZContinuousRotation', fn('ZContinuousRotation', 0, sets([['Reset', 0], ['&lt;&lt;&lt;', 2], ['', 3], ['Stop', 127], ['', 129], ['&gt;&gt;&gt;', 255]]))),
  dmx(4, 'Scale_X', fn('Scale_X', 0)),
].join(''));
const rp = laserParams(turning);
check('the zone angle through the degrees named', drive(rp, 'zoneRotation', [0, 64, 96, 255]), [0, 90, 135, 360]);
check('a physical range in degrees over the names', drive(rp, 'rotation', [0, 255]), [-180, 180]);
check('spin: Reset, <<< full, Stop, >>> full', drive(rp, 'spin', [0, 1, 2, 127, 128, 255]), [0, 0, -100, 0, 0, 100]);
const spinning = new LaserSettings(rp);
spinning.writeChannel(2, 255);
spinning.writeChannel(1, 255);
check('full spin is a turn a second', spinning.spinRate, 360);
check('spinning is not a reset', spinning.spinResets, false);
spinning.writeChannel(2, 0);
check('Reset puts the figure back at its own angle', spinning.spinResets, true);
spinning.writeChannel(2, 127);
check('Stop holds the angle', spinning.spinResets, false);
const kolo = read('Kolo Laser', box, [
  dmx(1, 'Z_Index', fn('Z_Index', 0)),
  dmx(2, 'Z_Rot', fn('Z_Rot', 0, '', 'Default="128/1"')),
  dmx(3, 'Scale_X', fn('Scale_X', 0)),
].join(''));
const kp = laserParams(kolo);
check('an angle with no ranges and no degrees is not read', kp.controls.rotation, undefined);
check('a spin with no named stop is not read', kp.controls.spin, undefined);
const choices = read('Choosing Laser', box, [
  dmx(1, 'Rot_Z', fn('Rot_Z', 0, sets([['Rotation Angle', 0], ['Rotation CCW', 128], ['Rotation CW', 192]]))),
  dmx(2, 'Spin', fn('Spin', 0, sets([['No Spin Zone', 0], ['Forward Spin', 1], ['No Spin Zone', 128], ['Reverse Spin', 129]]))),
  dmx(3, 'Scale_X', fn('Scale_X', 0)),
].join(''));
const cp = laserParams(choices);
check('ranges that are choices are not an angle', cp.controls.rotation, undefined);
check('a spin with two stops is not read', cp.controls.spin, undefined);

console.log('\npan and tilt');
const panned = read('Panned Laser', box, [
  dmx(1, 'Pan', fn('Pan', 0, sets([['Min', 0], ['', 1], ['Max', 255]]))),
  dmx(2, 'Tilt', fn('Tilt', 0, '', 'PhysicalFrom="-45" PhysicalTo="45"')),
  dmx(3, 'Scale_X', fn('Scale_X', 0)),
].join(''));
const pp2 = laserParams(panned);
check('pan is the cue across the zone', drive(pp2, 'cueX', [0, 255]), [-100, 100]);
check('tilt in degrees is the cue across the zone', drive(pp2, 'cueY', [0, 255]), [-100, 100]);
const yoked = read('Yoked Laser', yoke, [
  dmx(1, 'Pan', fn('Pan', 0)),
  dmx(2, 'MediaContent1', fn('MediaContent1', 0, sets([['Disabled', 0], ['', 1]]))),
  dmx(3, 'Scale_X', fn('Scale_X', 0)),
].join(''));
check('on a body with an axis, pan moves the body', laserParams(yoked).controls.cueX, undefined);

console.log('\nranges by position, one content range, and a bank');
const gobos = read('Show Laser', box, [
  dmx(1, 'Scale_X', fn('Scale_X', 0)),
  dmx(2, 'Gobo1', fn('Gobo1', 0, sets([['Blackout', 0], ['Fan', 10], ['Circle', 20]]))),
].join(''));
check('a laser name with a figure scale makes a laser', fixtureCategory(gobos), 'Laser');
check('ranges by position after one that selects nothing', drive(laserParams(gobos), 'clip', [0, 10, 25]), [null, 1, 2]);
const content = read('Media Laser', yoke, [
  dmx(1, 'Scale_X', fn('Scale_X', 0)),
  dmx(2, 'MediaContent1', fn('MediaContent1', 0, sets([['Disabled', 0], ['', 1]]))),
].join(''));
check('a named laser on a yoke that picks content is a laser', fixtureCategory(content), 'Laser');
check('one content range gives the raw value', drive(laserParams(content), 'clip', [0, 1, 37]), [null, 1, 37]);
const banked = read('Bank Laser', box, [
  dmx(1, 'ObjectBank', fn('ObjectBank', 0)),
  dmx(2, 'ObjectSlot', fn('ObjectSlot', 0, sets([['A', 0], ['B', 128]]), 'ModeMaster="Body_ObjectBank" ModeFrom="0/1" ModeTo="127/1"')
    + fn('ObjectSlot', 0, sets([['C', 0], ['D', 128]]), 'ModeMaster="Body_ObjectBank" ModeFrom="128/1" ModeTo="255/1"')),
].join(''));
check('a slot in a bank reads the first bank', drive(laserParams(banked), 'clip', [0, 128]), [1, 2]);

console.log('\nlights that are not lasers');
const head = read('Moving Head RGB Laser', yoke, dmx(1, 'Scale_X', fn('Scale_X', 0)));
check('a named laser on a yoke is a moving head', fixtureCategory(head), 'Moving Head');
check('and has no laser parameters', laserParams(head), null);
const spot = read('Spot', yoke, dmx(1, 'PatternSelection', fn('PatternSelection', 0)));
check('a pattern effect is not a laser attribute', fixtureCategory(spot), 'Moving Head');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
