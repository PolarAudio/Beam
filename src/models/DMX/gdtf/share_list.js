/**
 * @file GDTF Share's list of revisions, as fixtures to browse.
 *
 * The Share lists every revision of every fixture. A fixture type keeps its
 * `uuid` from revision to revision, so revisions are grouped by it -- and by
 * who uploaded them, since a copy keeps the uuid too -- and the newest is the
 * one offered. Manufacturer uploads come first, then the rest, each by
 * manufacturer and name.
 *
 * Each fixture is marked against the user's library by its fixture type ID,
 * and against what Beam has imported from the Share before, by the revision
 * id each library file was imported as: not in the library; in it at the
 * Share's newest revision; in it at an older one only; or in it from a file,
 * at a revision Beam cannot tell. The library can hold several revisions of
 * one type side by side, so the files at an older revision are named too.
 */

import { searchWords, matchesWords } from '@/plugins/word_search';

/** What a fixture is to the library. */
export const SHARE_STATES = {
  NEW: 'new',
  CURRENT: 'current',
  OLDER: 'older',
  FROM_FILE: 'from file',
};

/**
 * Fixtures from the Share's list.
 *
 * @param {Array<Object>} list revisions as `getList.php` gives them
 * @param {Array<Object>} library GDTF fixtures in the library,
 *   `{ key, file, fixtureTypeId }`
 * @param {Object} imported revision id imported from the Share, by library
 *   key; a key without a `/` is a fixture type ID, as records were kept
 *   before revisions could sit side by side
 * @returns {Array<Object>} `{ uuid, manufacturer, fixture, latest, revisions,
 *   byManufacturer, state, inLibrary, older }`; `inLibrary` the library's
 *   files of the type, or null, and `older` the keys of those at an older
 *   revision of this upload while none is at its newest
 */
export function shareFixtures(list, library = [], imported = {}) {
  // By fixture type and by who uploaded it: a user's copy of a manufacturer's
  // file keeps its fixture type ID, and its revisions are not the
  // manufacturer's.
  const byType = new Map();
  (list || []).forEach((r) => {
    const id = String(r.uuid || `${r.manufacturer}/${r.fixture}`).toUpperCase();
    const group = `${id}|${r.creator || ''}`;
    if (!byType.has(group)) byType.set(group, { id, revisions: [] });
    byType.get(group).revisions.push(r);
  });
  const owned = new Map();
  library.filter((e) => e.fixtureTypeId).forEach((e) => {
    const id = String(e.fixtureTypeId).toUpperCase();
    if (!owned.has(id)) owned.set(id, []);
    owned.get(id).push(e);
  });
  const records = Object.entries(imported || {});
  const byKey = new Map(records.filter(([k]) => k.includes('/')));
  const byTypeId = new Map(records.filter(([k]) => !k.includes('/')).map(([k, v]) => [k.toUpperCase(), v]));
  // A type-wide record speaks for the type's file only while there is one.
  const ridOf = (entry, files) => (byKey.has(entry.key) ? byKey.get(entry.key)
    : (files.length === 1 && byTypeId.get(String(entry.fixtureTypeId).toUpperCase())) || null);
  const fixtures = [...byType.entries()].map(([group, { id: uuid, revisions }]) => {
    const sorted = revisions.slice().sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    const latest = sorted[0];
    const files = owned.get(uuid) || [];
    // Current or older only by a revision of this very upload; the library
    // holding the type from a file or from another uploader is neither.
    const rids = files.map((entry) => ridOf(entry, files));
    const ours = (rid) => sorted.some((r) => r.rid === rid);
    let state = SHARE_STATES.NEW;
    let older = [];
    if (files.length) {
      if (rids.includes(latest.rid)) state = SHARE_STATES.CURRENT;
      else if (rids.some(ours)) {
        state = SHARE_STATES.OLDER;
        older = files.filter((entry, i) => ours(rids[i])).map((entry) => entry.key);
      } else state = SHARE_STATES.FROM_FILE;
    }
    return {
      key: group,
      uuid,
      creator: latest.creator || '',
      manufacturer: latest.manufacturer,
      fixture: latest.fixture,
      latest,
      revisions: sorted,
      byManufacturer: latest.uploader === 'Manuf.',
      state,
      inLibrary: files.length ? files : null,
      older,
    };
  });
  return fixtures.sort((a, b) => (b.byManufacturer - a.byManufacturer)
    || a.manufacturer.localeCompare(b.manufacturer)
    || a.fixture.localeCompare(b.fixture));
}

/**
 * The fixtures a search matches: every word, in the manufacturer's name or
 * the fixture's, in any order.
 *
 * @param {Array<Object>} fixtures from `shareFixtures`
 * @param {String} text
 * @returns {Array<Object>}
 */
export function searchFixtures(fixtures, text) {
  const words = searchWords(text);
  if (!words.length) return fixtures;
  return fixtures.filter((f) => matchesWords(words, f.manufacturer, f.fixture));
}

/**
 * The fixture's name without its manufacturer in front of it again, as many
 * uploads have it: "AECO 15" for ACME's "ACME AECO 15".
 *
 * @param {Object} f from `shareFixtures`
 * @returns {String}
 */
export function shareFixtureName(f) {
  const maker = String(f.manufacturer || '').trim().toLowerCase();
  const name = String(f.fixture || '').trim();
  if (maker && name.toLowerCase().startsWith(`${maker} `)) return name.slice(maker.length + 1);
  return name;
}

/** Who uploaded it: the manufacturer, or a user by name. */
export function uploaderText(f) {
  return f.byManufacturer ? 'manufacturer' : `user · ${f.creator}`;
}

/**
 * The revision's name when it says something the fixture's name does not.
 * Uploads often put the fixture's name, with or without the manufacturer,
 * where the revision goes.
 *
 * @param {Object} f from `shareFixtures`
 * @returns {String} empty when it only repeats the name
 */
export function revisionText(f) {
  const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const revision = String(f.latest.revision || '').trim();
  const names = [f.fixture, shareFixtureName(f), `${f.manufacturer} ${f.fixture}`,
    `${f.manufacturer} ${shareFixtureName(f)}`].map(tidy);
  return revision && !names.includes(tidy(revision)) ? revision : '';
}

/** "6 modes, 24–37 ch" from a revision's mode list. */
export function modesText(r) {
  const modes = r.modes || [];
  if (!modes.length) return 'no modes listed';
  const footprints = modes.map((m) => Number(m.dmxfootprint) || 0);
  const low = Math.min(...footprints);
  const high = Math.max(...footprints);
  const span = low === high ? `${low} ch` : `${low}–${high} ch`;
  return `${modes.length} mode${modes.length > 1 ? 's' : ''}, ${span}`;
}

/**
 * The rating to one decimal, or nothing. The Share sends it as text, "N/A"
 * for a fixture nobody has rated.
 */
export function ratingText(r) {
  const n = parseFloat(r.rating);
  return Number.isFinite(n) && n > 0 ? `★ ${n.toFixed(1)}` : '';
}

/** A file size as kB or MB. */
export function sizeText(bytes) {
  const n = Number(bytes) || 0;
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(Math.round(n / 1e3), 1)} kB`;
}

/** When a revision was last changed, as a date; the Share gives seconds. */
export function dateText(r) {
  const s = Number(r.lastModified) || 0;
  return s ? new Date(s * 1000).toLocaleDateString() : '';
}
