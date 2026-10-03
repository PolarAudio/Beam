/* eslint-disable no-console */
/**
 * A channel's ranges as a map: the kinds guessed from range names, the ramps,
 * the gap filling, and the layout the popup draws and the drag travels.
 *
 * What is pinned: names map to the kinds a reader would give them; a source's
 * own kind wins over the guess; a two-value range gets the minimum travel; and
 * every value survives the trip to a place in the stack and back.
 *
 * Usage:
 *   npm test
 */
import fixtureGuide from '@/models/DMX/fixture_guide';
import GOBOS from '@/plugins/visualizer/gobo_manifest';
import { goboThumbnail, goboLayerFor } from '@/plugins/visualizer/gobo_pick';
import {
  guessKind, guessRamp, channelRanges, stackRanges, valueToOffset, offsetToValue,
} from '@/models/DMX/channel_ranges';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

console.log('--- kinds from names');
[
  ['off', 'closed'],
  ['open', 'open'],
  ['closed', 'closed'],
  ['strobe 1→20Hz', 'strobe'],
  ['dimmer 0→100%', 'intensity'],
  ['red 0→100%', 'intensity'],
  ['white 2700→6500K', 'colour'],
  ['colour Red', 'colour'],
  ['gobo 1–7', 'slot'],
  ['split 1/2–7/8', 'slot'],
  ['shake gobo 3 slow→fast', 'shake'],
  ['scroll fast→slow CCW', 'ccw'],
  ['spin slow→fast CW', 'cw'],
  ['prism spin slow→fast CW', 'cw'],
  ['spin stop', 'stop'],
  ['hold at 0→360°', 'angle'],
  ['pan 0→540°', 'angle'],
  ['zoom 10→40°', 'optic'],
  ['iris open→closed', 'optic'],
  ['prism in (8-facet)', 'prism'],
  ['move speed fast→slow', 'speed'],
  ['Prism/Gobo macro', 'macro'],
].forEach(([text, kind]) => check(text, guessKind(text), kind));
check('mute name falls back to the type', guessKind('generic', 'WheelSlot'), 'slot');
check('mute name and unknown type', guessKind('generic', 'Generic'), 'other');

console.log('--- ramps from names');
check('slow→fast rises', guessRamp('spin slow→fast CW'), 'up');
check('fast→slow falls', guessRamp('scroll fast→slow CCW'), 'down');
check('0→100% rises', guessRamp('dimmer 0→100%'), 'up');
check('360→0° falls', guessRamp('hold at 360→0°'), 'down');
check('no arrow, no ramp', guessRamp('gobo 1–7'), null);

console.log('--- a channel from a profile');
{
  const ofl = {
    availableChannels: {
      Gobo: {
        capabilities: [
          { dmxRange: [0, 9], type: 'WheelSlot', slotNumber: 1 },
          { dmxRange: [10, 19], type: 'WheelSlot', slotNumber: 2 },
          { dmxRange: [20, 29], type: 'WheelSlot', slotNumber: 3 },
          { dmxRange: [30, 31], type: 'WheelRotation', speed: 'stop' },
          {
            dmxRange: [40, 255], type: 'WheelRotation', speedStart: 'slow CW', speedEnd: 'fast CW',
          },
        ],
      },
    },
    wheels: {
      Gobo: { slots: [{ type: 'Open' }, { type: 'Gobo' }, { type: 'Gobo' }] },
    },
  };
  const guide = fixtureGuide(ofl, { name: 'm', channels: ['Gobo'] });
  const ranges = channelRanges(guide.channels[0]);
  check('open, gobos folded, stop, gap, scroll', ranges.length, 5);
  check('gobos folded into one range', ranges[1].text, 'gobo 1–2');
  check('the fold keeps its slots', ranges[1].steps.length, 2);
  check('a gobo is not cut to a number', ranges[1].steps[1].label, 'gobo 2');
  const shakes = channelRanges({
    ranges: [{
      lo: 0,
      hi: 255,
      text: 'shake each slot slow→fast',
      steps: [
        { lo: 0, hi: 127, text: 'shake gobo 1 slow→fast' },
        { lo: 128, hi: 255, text: 'shake gobo 2 slow→fast' },
      ],
    }],
  });
  check('shared words are said once', shakes[0].steps[0].label, 'gobo 1');
  check('the gap is shown as unused', ranges[3].text, 'unused');
  check('the gap spans 32–39', `${ranges[3].lo}-${ranges[3].hi}`, '32-39');
  check('the scroll is clockwise', ranges[4].kind, 'cw');
  check('the scroll rises', ranges[4].ramp, 'up');
  check('a fine channel has no map', channelRanges({ text: 'fine for Pan' }), null);
  const told = channelRanges({
    ranges: [{
      lo: 0, hi: 255, text: 'Gobo1WheelSpin', kind: 'ccw', ramp: 'down',
    }],
  });
  check('a stated kind wins over the guess', told[0].kind, 'ccw');
  check('a stated ramp wins over the guess', told[0].ramp, 'down');
}

console.log('--- a colour wheel');
{
  const ofl = {
    availableChannels: {
      Color: {
        capabilities: [
          { dmxRange: [0, 9], type: 'WheelSlot', slotNumber: 1 },
          { dmxRange: [10, 19], type: 'WheelSlot', slotNumber: 2 },
          { dmxRange: [20, 29], type: 'WheelSlot', slotNumber: 3 },
          { dmxRange: [30, 39], type: 'WheelSlot', slotNumber: 4 },
          {
            dmxRange: [40, 127], type: 'WheelRotation', speedStart: 'slow CW', speedEnd: 'fast CW',
          },
          {
            dmxRange: [128, 255], type: 'WheelRotation', speedStart: 'fast CCW', speedEnd: 'slow CCW',
          },
        ],
      },
    },
    wheels: {
      Color: {
        slots: [
          { type: 'Open' },
          { type: 'Color', name: 'Deep Red', colors: ['#dd0000'] },
          { type: 'Color', name: 'Deep Blue', colors: ['#0000dd'] },
          { type: 'Color', name: 'Green', colors: ['#00ff00'] },
        ],
      },
    },
  };
  const guide = fixtureGuide(ofl, { name: 'm', channels: ['Color'] });
  const ranges = channelRanges(guide.channels[0]);
  check('open, colours, two scrolls', ranges.length, 4);
  check('the colours are one range', ranges[1].text, 'colours');
  check('drawn as blocks', ranges[1].rail, 'blocks');
  check('one block per colour', ranges[1].steps.length, 3);
  check('each block carries its colour', ranges[1].steps[1].colour, '#0000dd');
  check('each block carries its name', ranges[1].steps[0].text, 'deep red');
  check('a colour keeps its whole name', ranges[1].steps[0].label, 'deep red');
  check('a scroll is drawn as a ramp', ranges[2].rail, 'ramp');
  check('the second scroll falls', ranges[3].ramp, 'down');
  check('open is a strip', ranges[0].rail, 'strip');
}

console.log('--- split colours');
{
  const ofl = {
    availableChannels: {
      Color: {
        capabilities: [
          { dmxRange: [0, 9], type: 'WheelSlot', slotNumber: 1 },
          { dmxRange: [10, 14], type: 'WheelSlot', slotNumber: 1.5 },
          { dmxRange: [15, 24], type: 'WheelSlot', slotNumber: 2 },
          { dmxRange: [25, 29], type: 'WheelSlot', slotNumber: 2.5 },
          { dmxRange: [30, 39], type: 'WheelSlot', slotNumber: 3 },
          { dmxRange: [40, 44], type: 'WheelSlot', slotNumber: 3.5 },
          {
            dmxRange: [45, 255], type: 'WheelRotation', speedStart: 'slow CW', speedEnd: 'fast CW',
          },
        ],
      },
    },
    wheels: {
      Color: {
        slots: [
          { type: 'Open' },
          { type: 'Color', name: 'Red', colors: ['#ff0000'] },
          { type: 'Color', name: 'Blue', colors: ['#0000ff'] },
        ],
      },
    },
  };
  const guide = fixtureGuide(ofl, { name: 'm', channels: ['Color'] });
  const ranges = channelRanges(guide.channels[0]);
  check('open, colours with splits, scroll', ranges.length, 3);
  check('splits join the colours', ranges[1].text, 'colours');
  const [openRed, red, redBlue, blue, blueOpen] = ranges[1].steps;
  check('a split between open and red', openRed.split.join(' '), '#ffffff #ff0000');
  check('a split between red and blue', redBlue.split.join(' '), '#ff0000 #0000ff');
  check('a split is labelled by its slots', redBlue.label, '2/3');
  check('a whole slot keeps its colour', `${red.colour} ${blue.colour}`, '#ff0000 #0000ff');
  check('the last split comes round to open', blueOpen.split.join(' '), '#0000ff #ffffff');
}

console.log('--- gobo thumbnails');
{
  const wheel = {
    slots: [
      { type: 'Open' },
      { type: 'Gobo', resource: 'gobos/5-pointed-star' },
      { type: 'Gobo', name: 'Dots' },
      { type: 'Gobo', resource: 'gobos/not-shipped' },
    ],
  };
  const star = goboThumbnail(wheel, 2);
  check('a named gobo is the profile\'s own', star.named, true);
  check('it is served from the gobo folder', star.url.endsWith('gobos/5-pointed-star.svg'), true);
  check('an unnamed gobo is a stand-in', goboThumbnail(wheel, 3).named, false);
  check('one Beam does not ship is a stand-in', goboThumbnail(wheel, 4).named, false);
  check('open has no thumbnail', goboThumbnail(wheel, 1), null);
  const starIndex = GOBOS.findIndex((g) => g.name === '5-pointed-star');
  check('the renderer draws the same pattern', goboLayerFor(wheel.slots[1], 0), starIndex + 1);
  check('a stand-in follows its place among gobos', goboLayerFor(wheel.slots[2], 1), 2);
  check('open draws no pattern', goboLayerFor(wheel.slots[0], 0), 0);
  const ofl = {
    availableChannels: {
      Gobo: {
        capabilities: [
          { dmxRange: [0, 9], type: 'WheelSlot', slotNumber: 1 },
          { dmxRange: [10, 19], type: 'WheelSlot', slotNumber: 2 },
          { dmxRange: [20, 29], type: 'WheelSlot', slotNumber: 3 },
          {
            dmxRange: [30, 255], type: 'WheelShake', slotNumber: 2, shakeSpeedStart: 'slow', shakeSpeedEnd: 'fast',
          },
        ],
      },
    },
    wheels: { Gobo: wheel },
  };
  const ranges = channelRanges(fixtureGuide(ofl, { name: 'm', channels: ['Gobo'] }).channels[0]);
  const gobos = ranges.find((r) => r.rail === 'blocks');
  check('each gobo block carries its thumbnail', gobos.steps.every((s) => !!s.gobo), true);
  check('a shake carries its gobo too', !!ranges[ranges.length - 1].gobo, true);
}

console.log('--- a gobo called Fan');
{
  const ofl = {
    availableChannels: {
      Gobo: {
        capabilities: [
          { dmxRange: [0, 7], type: 'WheelSlot', slotNumber: 1 },
          { dmxRange: [8, 15], type: 'WheelSlot', slotNumber: 2 },
          { dmxRange: [16, 23], type: 'WheelSlot', slotNumber: 3 },
          { dmxRange: [24, 31], type: 'WheelSlot', slotNumber: 4 },
          { dmxRange: [32, 255], type: 'WheelShake', slotNumber: 3 },
        ],
      },
    },
    wheels: {
      Gobo: {
        slots: [
          { type: 'Open' },
          { type: 'Gobo', name: 'Square Arrows' },
          { type: 'Gobo', name: 'Fan' },
          { type: 'Gobo', name: 'Star' },
        ],
      },
    },
  };
  const ranges = channelRanges(fixtureGuide(ofl, { name: 'm', channels: ['Gobo'] }).channels[0]);
  check('open, one card of gobos, the shake', ranges.length, 3);
  check('Fan is one of the gobos', ranges[1].steps.map((s) => s.label).join(','), 'square arrows,fan,star');
  check('a shake of one slot stays a shake', ranges[2].kind, 'shake');
}

console.log('--- the stack');
{
  const ranges = [{ lo: 0, hi: 99 }, { lo: 100, hi: 101 }, { lo: 102, hi: 255 }];
  const stack = stackRanges(ranges, { pxPerValue: 3, minPx: 24 });
  check('a wide range is 3 px a value', stack.segs[0].px, 300);
  check('a two-value range gets the minimum', stack.segs[1].px, 24);
  check('the total adds up', stack.total, 300 + 24 + 462);
  let roundTrip = 0;
  for (let v = 0; v <= 255; v += 1) {
    if (offsetToValue(stack, valueToOffset(stack, v)) === v) roundTrip += 1;
  }
  check('every value survives the trip', roundTrip, 256);
  check('below the foot is 0', offsetToValue(stack, -50), 0);
  check('above the top is 255', offsetToValue(stack, 1e6), 255);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
