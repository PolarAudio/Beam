/* eslint-disable no-console */
/**
 * The Wicked Lasers GDTF files Beam ships, read back the way Beam reads them:
 * a Laser geometry makes a laser, its optics and body become the laser's
 * parameters, and virtual channels become Fixed or Adjustable controls.
 *
 * Usage:
 *   npm test
 */
import fs from 'fs';
import path from 'path';
import { DOMParser } from '@xmldom/xmldom';
import readGdtf from '@/models/DMX/gdtf/gdtf_reader';
import { fixtureCategory } from '@/models/DMX/gdtf/fixture_parts';
import { laserParams } from '@/models/DMX/gdtf/laser_parts';
import { apertureOrigin } from '@/models/DMX/generic/laser';
import movedProfile from '@/models/DMX/moved_profiles';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

const dir = path.join(process.cwd(), 'public', 'profiles', 'Wicked Lasers');
const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');
const read = (stem) => readGdtf(new Uint8Array(fs.readFileSync(path.join(dir, `${stem}.gdtf`))), { parseXml });
const r1 = (n) => Math.round(n * 10) / 10;

const pro = read('Wicked_Lasers@LaserCube_Pro_2.5W@Beam_1');
check('reads without problems', pro.problems, []);
check(
  'carries the body as glTF and 3DS',
  Object.keys(pro.files).sort(),
  ['models/3ds/LaserCube Pro.3ds', 'models/gltf/LaserCube Pro.glb'],
);
const type = pro.fixtureType;
check('a Laser geometry is a laser', fixtureCategory(type), 'Laser');
const p = laserParams(type);
check('power in watts', p.power, 2.5);
check('scan angle', [p.scanAngleH, p.scanAngleV], [32, 32]);
check('beam diameter in mm', r1(p.beamDiameter), 3);
check('divergence in mrad', p.divergence, 1);
check('body size from the model, mm', [p.width, p.depth, p.height].map((m) => Math.round(m * 1000)), [100, 141, 151]);
check('the beam starts at the model origin', apertureOrigin(p), { x: 0, y: 0, z: 0 });
check('every control is read', Object.keys(p.controls).length, 11);
check('a fixed control keeps its value', p.controls.dimmer, { mode: 'fixed', value: 100 });
check('a fixed switch', p.controls.shutter, { mode: 'fixed', value: true });
check('a fixed offset', p.controls.xPos, { mode: 'fixed', value: 0 });
check('an adjustable switch starts off', p.controls.mirrorX, { mode: 'adjustable', value: false });
check('no channel takes an address', type.modes[0].channels.every((c) => c.offsets === null), true);

const wide = laserParams(read('Wicked_Lasers@LaserCube_Pro_2.5W_Wide_Angle@Beam_1').fixtureType);
check('the wide angle scans wider', wide.scanAngleH, 70);

const ultra = read('Wicked_Lasers@LaserCube_Ultra_7.5W@Beam_1');
check('the Ultra has no mesh', Object.keys(ultra.files), []);
const u = laserParams(ultra.fixtureType);
check('the Ultra is 7.5 W', u.power, 7.5);
check('its beam leaves the front face', apertureOrigin(u), { x: 0, y: -0.1, z: 0 });

check(
  'an old project finds the GDTF',
  movedProfile('wicked-lasers', 'LaserCube Pro 2.5W'),
  { manufacturer: 'Wicked Lasers', model: 'Wicked_Lasers@LaserCube_Pro_2.5W@Beam_1' },
);
check('every moved key names a shipped file', ['LaserCube Pro 2.5W', 'LaserCube Pro 2.5W Wide Angle',
  'LaserCube 7.5W Ultra', 'LaserCube 7.5W Ultra Wide Angle']
  .every((m) => fs.existsSync(path.join(dir, `${movedProfile('wicked-lasers', m).model}.gdtf`))), true);
check('other profiles stay put', movedProfile('martin', 'mac-aura'), { manufacturer: 'martin', model: 'mac-aura' });

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
