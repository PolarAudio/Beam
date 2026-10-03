/* eslint-disable no-console */
/**
 * GDTF Share's revision list as fixtures to browse.
 *
 * What is pinned: revisions of one fixture type are one fixture, offered at
 * its newest; manufacturer uploads come first; a fixture is new, current,
 * older or from a file, by its fixture type ID in the library and the
 * revision Beam imported from the Share; a search matches every word in
 * any order, the same rule every list uses; a revision that only repeats the
 * fixture's name is not shown as one.
 *
 * Usage:
 *   npm test
 */
import {
  shareFixtures, searchFixtures, SHARE_STATES, shareFixtureName, revisionText,
} from '@/models/DMX/gdtf/share_list';
import { searchWords, matchesWords } from '@/plugins/word_search';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

const rev = (rid, uuid, manufacturer, fixture, revision, lastModified, uploader = 'Manuf.', creator = manufacturer) => ({
  rid, uuid, manufacturer, fixture, revision, lastModified, uploader, creator, rating: 'N/A', modes: [],
});
const list = [
  rev(1, 'aaa', 'Elation', 'Proteus Hybrid', 'v1', 100),
  rev(2, 'aaa', 'Elation', 'Proteus Hybrid', 'v2', 200),
  rev(3, 'bbb', 'Clay Paky', 'Sharpy', 'r1', 50),
  // A user's copy of the Sharpy: same fixture type ID, newer, another uploader.
  rev(6, 'bbb', 'Clay Paky', 'Sharpy', 'BOBY V1', 300, 'User', 'boby'),
  rev(4, 'ccc', 'Acme', 'Spot', 'u1', 70, 'User'),
  rev(7, 'ddd', 'Robe', 'MegaPointe', 'm0', 60),
  rev(5, 'ddd', 'Robe', 'MegaPointe', 'm1', 80),
];
const library = [
  { key: 'Elation/x', file: 'Elation/x.gdtf', fixtureTypeId: 'AAA' },
  { key: 'Clay Paky/y', file: 'Clay Paky/y.gdtf', fixtureTypeId: 'BBB' },
  { key: 'Robe/z', file: 'Robe/z.gdtf', fixtureTypeId: 'DDD' },
];
const imported = { AAA: 2, DDD: 7 };

const fixtures = shareFixtures(list, library, imported);
check('one fixture per type and uploader', fixtures.length, 5);
check(
  'manufacturer uploads first, then by name',
  fixtures.map((f) => `${f.fixture}/${f.creator}`),
  ['Sharpy/Clay Paky', 'Proteus Hybrid/Elation', 'MegaPointe/Robe', 'Spot/Acme', 'Sharpy/boby'],
);
const by = (name) => fixtures.find((f) => f.fixture === name && f.byManufacturer);
check('a user copy does not take over the manufacturer upload', by('Sharpy').latest.revision, 'r1');
check('the user copy listed on its own', fixtures.find((f) => f.creator === 'boby').latest.revision, 'BOBY V1');
check('offered at its newest revision', by('Proteus Hybrid').latest.rid, 2);
check('revisions newest first', by('Proteus Hybrid').revisions.map((r) => r.rid), [2, 1]);
check('imported at the newest: current', by('Proteus Hybrid').state, SHARE_STATES.CURRENT);
check('imported at another: older', by('MegaPointe').state, SHARE_STATES.OLDER);
check('in the library from a file', by('Sharpy').state, SHARE_STATES.FROM_FILE);
const spot = fixtures.find((f) => f.fixture === 'Spot');
check('not in the library: new', spot.state, SHARE_STATES.NEW);
check('user upload marked', spot.byManufacturer, false);

check('search, words in any order', searchFixtures(fixtures, 'hybrid elation').map((f) => f.fixture), ['Proteus Hybrid']);
check('search, every word must match', searchFixtures(fixtures, 'elation sharpy').length, 0);
check('no search, everything', searchFixtures(fixtures, '  ').length, 5);

// Two revisions of the Proteus side by side, recorded by library key.
const sideBySide = [
  { key: 'Elation/v1', file: 'Elation/v1.gdtf', fixtureTypeId: 'AAA' },
  { key: 'Elation/v2', file: 'Elation/v2.gdtf', fixtureTypeId: 'AAA' },
];
const proteus = (records) => shareFixtures(list, sideBySide, records)
  .find((f) => f.fixture === 'Proteus Hybrid');
check('both revisions kept, one at the newest: current', proteus({ 'Elation/v1': 1, 'Elation/v2': 2 }).state, SHARE_STATES.CURRENT);
check('nothing is newer when the newest is there', proteus({ 'Elation/v1': 1, 'Elation/v2': 2 }).older, []);
check('only the older one recorded: older', proteus({ 'Elation/v1': 1 }).state, SHARE_STATES.OLDER);
check('the newer mark goes on the older file only', proteus({ 'Elation/v1': 1 }).older, ['Elation/v1']);
check('a type-wide record does not speak for two files', proteus({ AAA: 1 }).state, SHARE_STATES.FROM_FILE);

const words = (text) => searchWords(text);
check('a list row is read with its folder', matchesWords(words('elation proteus'), 'Elation', 'Proteus Hybrid'), true);
check('hyphens read as spaces', matchesWords(words('b eye'), 'Clay Paky', 'Aleda B-EYE K20'), true);
check('a word missing fails', matchesWords(words('elation sharpy'), 'Elation', 'Proteus Hybrid'), false);
check('a blank search matches', matchesWords(words('   '), 'anything'), true);

const acme = { manufacturer: 'ACME', fixture: 'ACME AECO 15', latest: { revision: 'ACME AECO 15' } };
check('maker not repeated in the name', shareFixtureName(acme), 'AECO 15');
check('a revision repeating the name is dropped', revisionText(acme), '');
check('a real revision is kept', revisionText({ ...acme, latest: { revision: 'v1.2' } }), 'v1.2');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
