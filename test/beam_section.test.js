/* eslint-disable no-console */
/**
 * Profiles written with the old `asls` section are read as `beam`, and a
 * generic fixture's size is its parameters' alone.
 *
 * Usage:
 *   npm test
 */
import withBeamSection from '@/models/DMX/generic/beam_section';
import { kindOf } from '@/models/DMX/generic/fixture_kind';
import { buildLaserProfile } from '@/models/DMX/generic/laser';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

const old = {
  name: 'LaserCube Pro 2.5W',
  categories: ['Other'],
  physical: { dimensions: [100, 100, 160], bulb: { type: 'Laser' } },
  modes: [],
  asls: {
    laser: {
      power: 2.5, width: 0.1, height: 0.145, depth: 0.1, scanAngleH: 32, scanAngleV: 32,
    },
  },
};
const same = withBeamSection(old);
check('migrated in place', same === old, true);
check('asls is gone', 'asls' in old, false);
check('beam carries the parameters', old.beam.laser.power, 2.5);
check('the stale size copy is dropped', 'dimensions' in old.physical, false);
check('the rest of physical stays', old.physical.bulb.type, 'Laser');
check('size comes from the parameters', kindOf(old).sizeOf(old), [100, 145, 100]);

const both = { beam: { laser: { power: 1 } }, asls: { laser: { power: 9 } } };
withBeamSection(both);
check('beam wins over asls', both.beam.laser.power, 1);

const library = { name: 'Spot', physical: { dimensions: [300, 400, 250] } };
withBeamSection(library);
check('a library profile keeps its size', library.physical.dimensions, [300, 400, 250]);
check('nothing on null', withBeamSection(null), null);

const built = buildLaserProfile({ width: 0.2, height: 0.3, depth: 0.25 });
check('a new laser profile has no size copy', 'dimensions' in built.physical, false);
check('and reports its size through the kind', kindOf(built).sizeOf(built), [200, 300, 250]);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
