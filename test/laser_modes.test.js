/* eslint-disable no-console */
/**
 * A laser's test pattern, standalone clip and mode, set by hand and driven
 * from DMX channels.
 *
 * Usage:
 *   npm test
 */
import LaserSettings from '@/models/DMX/laser_settings';
import { TEST_PATTERN_IDS } from '@/models/DMX/laser_clips';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

const file = (id, name) => ({
  id, name, kind: 'file', file: `${name}.ild`,
});
const clips = [file('a', 'Logo'), file('b', 'Tunnel')];

// By hand.
const hand = new LaserSettings({}, { protocol: 'ponk', clips });
check('a new laser plays no test pattern', hand.testPattern, null);
check('no clip chosen by hand plays the first', hand.currentClip && hand.currentClip.id, 'a');
hand.set('clip', 'b');
check('a clip chosen by hand plays', hand.currentClip.id, 'b');
hand.set('testPattern', 'ilda-30k');
check('a test pattern by hand', hand.testPattern && hand.testPattern.name, 'ILDA test pattern 30K');
check('mode starts as set', hand.value('mode'), 'input');
const drivenByDefault = ['testPattern', 'clip', 'mode'].map((k) => hand.isDriven(k));
check('test pattern, clip and mode are not channels by default', drivenByDefault, [false, false, false]);

// From the desk: Test pattern on 1, Clip on 2, Mode on 3.
const driven = new LaserSettings({
  controls: {
    testPattern: { mode: 'dmx', channel: 1, bits: 8 },
    clip: { mode: 'dmx', channel: 2, bits: 8 },
    mode: { mode: 'dmx', channel: 3, bits: 8 },
  },
}, { clips });
check('three channels', driven.footprint, 3);
driven.writeChannel(0, 0);
check('test pattern 0 is Off', driven.testPattern, null);
const step = 256 / TEST_PATTERN_IDS.length;
driven.writeChannel(0, Math.ceil(step * 2));
check('test pattern: the third range is the second pattern', driven.value('testPattern'), TEST_PATTERN_IDS[2]);
driven.writeChannel(0, 255);
check('test pattern 255 is the last pattern', driven.value('testPattern'), TEST_PATTERN_IDS[TEST_PATTERN_IDS.length - 1]);
driven.writeChannel(1, 2);
check('clip 2 plays the second file', driven.currentClip && driven.currentClip.id, 'b');
driven.writeChannel(1, 0);
check('clip 0 plays nothing', driven.currentClip, null);
driven.writeChannel(1, 9);
check('a clip past the end plays nothing', driven.currentClip, null);
driven.writeChannel(2, 0);
check('mode, first range: as set', driven.value('mode'), 'input');
driven.writeChannel(2, 128);
check('mode, second range: standalone', driven.value('mode'), 'standalone');
driven.writeChannel(2, 255);
check('mode, third range: off', driven.value('mode'), 'off');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
