/* eslint-disable no-console */
/**
 * A GDTF file's pretty names, as the channel names a panel shows.
 *
 * What is pinned: the spec's own pretty names are known, numbered ones
 * included; a file that repeats the spec's pretty name keeps Beam's reading
 * of the attribute; a file that gives its own name has it shown; and
 * channel rows read the names from the fixture type.
 *
 * Usage:
 *   npm test
 */
import translateOfl from '@/models/DMX/gdtf/ofl_to_gdtf';
import DmxEngine from '@/models/DMX/gdtf/dmx_engine';
import { attributeLabel, channelRows } from '@/models/DMX/gdtf/fixture_parts';
import { standardPretty, isOwnPretty } from '@/models/DMX/gdtf/standard_attributes';
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

console.log('\nthe spec\'s pretty names');
check('Dimmer', standardPretty('Dimmer'), 'Dim');
check('Shutter1, numbered', standardPretty('Shutter1'), 'Sh1');
check('Gobo2WheelSpin, number in the name only', standardPretty('Gobo2WheelSpin'), 'Wheel Spin');
check('Effects2Adjust3, two numbers', standardPretty('Effects2Adjust3'), 'FX2 Adjust3');
check('an attribute the spec does not list', standardPretty('PatternSelection'), null);

console.log('\nwhose name it is');
check('the spec\'s name is not the file\'s own', isOwnPretty('Color1', 'C1'), false);
check('case and space do not make it the file\'s own', isOwnPretty('ColorAdd_BC', ' light-blue '), false);
check('a different name is the file\'s own', isOwnPretty('Color1', 'Color'), true);
check('any name for an unlisted attribute is the file\'s own', isOwnPretty('PatternSelection', 'Pattern'), true);
check('no name is nobody\'s', isOwnPretty('Color1', ''), false);

console.log('\nlabels');
check('standard pretty keeps Beam\'s reading', attributeLabel('Gobo1PosRotate', 'Rotate'), 'Gobo 1 rotation');
check('own pretty is shown', attributeLabel('Effects1', 'Sound'), 'Sound');
check('animation system, spec pretty', attributeLabel('AnimationSystem1', 'Anim System'), 'Animation system 1');
check('animation system rotation', attributeLabel('AnimationSystem1PosRotate', 'Anim System Rotate'), 'Animation system 1 rotation');
check('own pretty is trimmed', attributeLabel('Shutter1', ' Strobe '), 'Strobe');
check('no reading and the spec\'s pretty shows the attribute', attributeLabel('Dimmer', 'Dim'), 'Dimmer');
check('no reading and no pretty shows the attribute', attributeLabel('PatternSelection'), 'PatternSelection');

console.log('\nchannel rows');
const { fixtureType: type } = translateOfl(tomshine, { manufacturer: 'Tomshine' });
const names = () => channelRows(new DmxEngine(type, type.modes[0])).map((r) => r.name);
const readings = ['Pan/tilt speed', 'Dimmer', 'Shutter', 'Colour 1', 'Gobo 1'];
check('translated profile: Beam\'s readings', names().slice(4, 9), readings);
type.index.attribute.get('Shutter1').pretty = 'Strobe';
type.index.attribute.get('Color1').pretty = 'Color';
type.index.attribute.get('Gobo1').pretty = 'Gobo';
const renamed = ['Pan/tilt speed', 'Dimmer', 'Strobe', 'Color', 'Gobo'];
check('renamed in the file: the file\'s names', names().slice(4, 9), renamed);
check('a fine byte follows its channel\'s name', names().slice(0, 2), ['Pan', 'Pan fine']);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
