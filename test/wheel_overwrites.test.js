/* eslint-disable no-console */
/**
 * Gobos and animation discs swapped into one placed fixture.
 *
 * What is pinned: overwrites are kept one per slot and well formed; applying
 * them replaces exactly the named slots, makes them gobos, leaves the
 * definition's objects alone and passes over slots that do not exist; picture
 * references resolve by source; MVR targets convert both ways and refuse an
 * unnamed or doubled slot name.
 *
 * Usage:
 *   npm test
 */
import {
  normaliseOverwrites, applyOverwrites, resolveImage, mvrTarget, fromMvrTarget,
} from '@/models/DMX/wheel_overwrites';

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

const wheels = {
  'Gobo Wheel 1': {
    slots: [
      { type: 'Open', name: 'Open' },
      { type: 'Gobo', name: 'Star', image: { key: 'T/star', url: 'u-star' } },
      { type: 'Gobo', name: 'Dots', resource: 'gobos/bubbles' },
    ],
  },
  'Animation Wheel': { slots: [{ type: 'Open', name: 'Open' }, { type: 'Gobo', name: 'Disc' }] },
  Doubled: { slots: [{ name: 'A' }, { name: 'A' }, {}] },
};
const where = {
  goboNames: ['bubbles', 'biohazard'],
  animationUrl: (n) => `anim/${n}.png`,
  libraryUrl: (n) => `library://gobos/${n}`,
  collectedUrl: (n) => (n === 'robe-star' ? `gobos/${n}.png` : null),
  ownImages: new Map([['GOBO 8', 'blob:own8']]),
  typeKey: 'T',
};
const resolve = (ref) => resolveImage(ref, where);

check('normalised: one per slot, last wins, bad ones dropped', normaliseOverwrites([
  { wheel: 'Gobo Wheel 1', slot: 2, image: 'gobo:bubbles' },
  {
    wheel: 'Gobo Wheel 1', slot: 2, image: 'gobo:biohazard', rotation: '15',
  },
  { wheel: 'Gobo Wheel 1', slot: 0, image: 'gobo:bubbles' },
  { wheel: 'Gobo Wheel 1', slot: 3, image: 'web:http://x' },
  { slot: 3, image: 'gobo:bubbles' },
]), [{
  wheel: 'Gobo Wheel 1', slot: 2, image: 'gobo:biohazard', rotation: 15,
}]);

const list = normaliseOverwrites([
  { wheel: 'Gobo Wheel 1', slot: 1, image: 'library:flames.png' },
  {
    wheel: 'Gobo Wheel 1', slot: 2, image: 'gobo:biohazard', rotation: 30,
  },
  { wheel: 'Animation Wheel', slot: 2, image: 'fixture:GOBO 8' },
  { wheel: 'Gobo Wheel 1', slot: 9, image: 'gobo:bubbles' },
  { wheel: 'No Such Wheel', slot: 1, image: 'gobo:bubbles' },
]);
const out = applyOverwrites(wheels, list, resolve);
check('open slot with a picture becomes a gobo', out['Gobo Wheel 1'].slots[0], {
  type: 'Gobo',
  name: 'Open',
  image: { key: 'library/flames.png', url: 'library://gobos/flames.png' },
  rotation: 0,
  overwritten: 'library:flames.png',
});
check('stock gobo replaces the file image', out['Gobo Wheel 1'].slots[1], {
  type: 'Gobo',
  name: 'Star',
  resource: 'gobos/biohazard',
  rotation: 30,
  overwritten: 'gobo:biohazard',
});
check('untouched slot is the same object', out['Gobo Wheel 1'].slots[2] === wheels['Gobo Wheel 1'].slots[2], true);
check('fixture\'s own image in the disc slot', out['Animation Wheel'].slots[1].image, { key: 'T/GOBO 8', url: 'blob:own8' });
check('definition not changed', wheels['Gobo Wheel 1'].slots[1].image, { key: 'T/star', url: 'u-star' });
check('no overwrites: the same wheels', applyOverwrites(wheels, [], resolve) === wheels, true);
check('unknown stock gobo leaves the slot', applyOverwrites(wheels, normaliseOverwrites([
  { wheel: 'Gobo Wheel 1', slot: 2, image: 'gobo:no-such' }]), resolve)['Gobo Wheel 1'].slots[1].name, 'Star');
const opened = applyOverwrites(wheels, normaliseOverwrites([
  {
    wheel: 'Gobo Wheel 1', slot: 2, image: 'open', rotation: 40,
  }]), resolve);
check('open empties a gobo slot', opened['Gobo Wheel 1'].slots[1], { type: 'Open', name: 'Star', overwritten: 'open' });
check('open keeps no turn', normaliseOverwrites([
  {
    wheel: 'Gobo Wheel 1', slot: 2, image: 'open', rotation: 40,
  }])[0].rotation, 0);
check('gobo taken from a GDTF file', resolve('gobo:robe-star'), { image: { key: 'gobos/robe-star', url: 'gobos/robe-star.png' } });
check('unknown gobo name', resolve('gobo:nothing'), null);
check('stock disc reference', resolve('animation:flames'), { image: { key: 'animation/flames', url: 'anim/flames.png' } });

check('MVR target from a named slot', mvrTarget(wheels, { wheel: 'Gobo Wheel 1', slot: 2 }), 'Gobo Wheel 1.Star');
check('MVR target refuses a doubled name', mvrTarget(wheels, { wheel: 'Doubled', slot: 1 }), null);
check('MVR target refuses an unnamed slot', mvrTarget(wheels, { wheel: 'Doubled', slot: 3 }), null);
check('MVR target back to a slot', fromMvrTarget(wheels, 'Gobo Wheel 1.Dots'), { wheel: 'Gobo Wheel 1', slot: 3 });

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
