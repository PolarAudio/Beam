/* eslint-disable no-console */
/**
 * OFL profiles translated into the GDTF fixture type model.
 *
 * What is pinned: a mover gets GDTF's base, yoke and head with pan on the
 * yoke; zoom keywords resolve to the lens range; only what the profile states
 * is listed as written on the beam; a switching channel becomes mode-master
 * functions on its controller; an empty slot keeps its address; a pixel grid
 * keeps every channel.
 *
 * Usage:
 *   npm test
 */
import translateOfl from '@/models/DMX/gdtf/ofl_to_gdtf';
import { patchedChannels } from '@/models/DMX/gdtf/gdtf_reader';
import { normaliseMatrixProfile } from '@/models/DMX/ofl_matrix';
import proteus from '../public/fixtures/elation/proteus-hybrid.json';
import cannon from '../public/fixtures/american-dj/cob-cannon-wash.json';
import megaBar from '../public/fixtures/american-dj/mega-bar-rgba.json';
import aurora from '../public/fixtures/light-sky/aurora.json';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

const footprints = (ofl) => {
  const { fixtureType: t } = translateOfl(ofl);
  return t.modes.map((m) => patchedChannels(t, m).footprint[1] || 0);
};
const lengths = (ofl) => normaliseMatrixProfile(ofl).modes.map((m) => m.channels.length);

{
  const { fixtureType: t, problems } = translateOfl(proteus, { manufacturer: 'Elation' });
  check('proteus: no problems', problems, []);
  check('proteus: manufacturer passed in', t.manufacturer, 'Elation');
  check('proteus: base, yoke, head shapes', t.models.map((m) => m.primitiveType), ['Base', 'Yoke', 'Head']);
  check('proteus: pan on the yoke', t.modes[0].channels.find((c) => c.logicalChannels[0].attribute === 'Pan').geometry, 'Yoke');
  const { beam } = t.index.geometry.get('Beam');
  check('proteus: lumens as stated', beam.luminousFlux, 23000);
  check('proteus: written is only what OFL states', beam.explicit, ['PowerConsumption', 'LuminousFlux', 'ColorTemperature', 'BeamAngle', 'FieldAngle']);
  const zoom = t.modes[0].channels.find((c) => c.logicalChannels[0].attribute === 'Zoom').logicalChannels[0].functions[0];
  check('proteus: zoom narrow..wide is the lens range', [zoom.physicalFrom, zoom.physicalTo], [2, 40]);
  check('proteus: 16-bit pan in the extended mode', t.modes[2].channels.find((c) => c.logicalChannels[0].attribute === 'Pan').offsets.length, 2);
  check('proteus: CMY are flags', t.modes[0].channels.some((c) => c.logicalChannels[0].attribute === 'ColorSub_C'), true);
  check('proteus: footprints', footprints(proteus), lengths(proteus));
}

{
  const { fixtureType: t, problems } = translateOfl(cannon);
  check('cannon: no problems', problems, []);
  const mode = t.modes.find((m) => m.name === '9-channel');
  const program = mode.channels.find((c) => c.offsets[0] === 8);
  const masters = program.logicalChannels[0].functions.map((f) => f.modeMaster && f.modeMaster[0]);
  check('cannon: switching channel has a mode master', masters.every((m) => m === mode.channels.find((c) => c.offsets[0] === 7).name), true);
  check('cannon: first choice applies over 0-51', [program.logicalChannels[0].functions[0].modeFrom, program.logicalChannels[0].functions[0].modeTo], [0, 51]);
  check('cannon: footprints', footprints(cannon), lengths(cannon));
}

check('aurora: trailing empty slot keeps its address', footprints(aurora), lengths(aurora));
check('mega bar: pixel modes keep every channel', footprints(megaBar), lengths(megaBar));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
