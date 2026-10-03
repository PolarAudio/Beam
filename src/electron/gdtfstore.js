/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import readGdtf from '@/models/DMX/gdtf/gdtf_reader';
import { fixtureCategory } from '@/models/DMX/gdtf/fixture_parts';
import library from './library';

/**
 * GDTF fixture files in the user's library (main process).
 *
 * A .gdtf is kept exactly as it was downloaded, beside the JSON profiles:
 *
 *   Library/Profiles/<manufacturer>/<file>.gdtf
 *
 * Nothing in it is rewritten. The file is the fixture's definition, and a
 * definition is never edited -- a newer revision replaces it whole. The
 * renderer reads the bytes over `library://profiles/...`; here only enough of
 * each file is read to list it: its name, manufacturer, fixture type ID and
 * revision, and its type, which takes reading the whole file the way the
 * renderer does.
 *
 * Revisions of one fixture type can sit side by side, each its own file and
 * key, so a show keeps the revision it was built with. A file, or a GDTF
 * Share revision, can be marked bad, which hides it from Add to Show until it
 * is asked to show marked ones, and any library fixture or Share revision
 * can be a favourite, which Add to Show can show alone; the marks live beside
 * the files, in `gdtf-marks.json`.
 *
 * A fixture's key is `<manufacturer folder>/<file name without .gdtf>`. The
 * file name, not the fixture name, because two revisions of one fixture are
 * two files and a show must name exactly one.
 *
 * A file is never deleted, because a saved show names it by key and carries
 * no copy. Removing one, or replacing it on import, moves it to
 *
 *   Library/Removed/Profiles/<manufacturer>/<file>.gdtf
 *
 * where it is no longer listed but still resolves, so every show that uses
 * it still opens. Importing it again lists it again.
 */

const PROFILES_DIR = 'Profiles';
const EXTENSION = '.gdtf';
const REMOVED_DIR = 'Removed';

/** Listing results by path, kept while the file's size and time are unchanged. */
const peekCache = new Map();

/** XML's five predefined entities, which is all a GDTF header uses. */
function unescapeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * What a GDTF file says it is, read from its FixtureType element without
 * parsing the rest.
 *
 * @param {Uint8Array} bytes the .gdtf file
 * @returns {Object|null} `{ name, manufacturer, fixtureTypeId, dataVersion,
 *   revision }`, or null when the bytes are not a GDTF file; `revision` is
 *   the text of the file's last Revision, as written
 */
function peek(bytes) {
  let files;
  try {
    files = unzipSync(bytes, { filter: (file) => file.name.toLowerCase() === 'description.xml' });
  } catch (err) {
    return null;
  }
  const entry = Object.values(files)[0];
  if (!entry) return null;
  const xml = strFromU8(entry);
  const root = /<GDTF\b([^>]*)>/.exec(xml);
  const tag = /<FixtureType\b([^>]*)>/.exec(xml);
  if (!root || !tag) return null;
  const read = (attributes, name) => {
    const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);
    return m ? unescapeXml(m[1]) : '';
  };
  const revisions = [...xml.matchAll(/<Revision\b([^>]*)>/g)];
  const last = revisions.length ? revisions[revisions.length - 1][1] : '';
  return {
    name: read(tag[1], 'Name'),
    manufacturer: read(tag[1], 'Manufacturer'),
    fixtureTypeId: read(tag[1], 'FixtureTypeID') || null,
    dataVersion: read(root[1], 'DataVersion') || null,
    revision: read(last, 'Text').trim() || null,
  };
}

/**
 * What a fixture type is -- a moving head or not -- by the same reading and
 * the same rule as a placed fixture, so the list and the fixture agree.
 *
 * @param {Uint8Array} bytes the .gdtf file
 * @returns {String|null} null when the file cannot be read
 */
function categoryOf(bytes) {
  try {
    const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');
    return fixtureCategory(readGdtf(bytes, { parseXml }).fixtureType);
  } catch (err) {
    console.error(`[gdtf] cannot read the fixture type: ${err.message}`);
    return null;
  }
}

/** Peeks at a file on disk, through the cache, with its type. */
function peekFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return null;
  }
  const cached = peekCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.info;
  let info = null;
  try {
    const bytes = new Uint8Array(fs.readFileSync(file));
    info = peek(bytes);
    if (info) info.category = categoryOf(bytes);
  } catch (err) {
    console.error(`[gdtf] cannot read ${file}: ${err.message}`);
  }
  peekCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, info });
  return info;
}

/** The Profiles folder of a library root. */
function removedRoot() {
  return path.join(library.libraryRoot(), REMOVED_DIR, PROFILES_DIR);
}

function profilesRoot(base) {
  return path.join(base || library.libraryRoot(), PROFILES_DIR);
}

/** Where the marks are kept: beside the files they judge. */
const marksFile = () => path.join(profilesRoot(), 'gdtf-marks.json');

/**
 * Files and Share revisions marked bad, and fixtures and Share revisions
 * marked favourite.
 *
 * @returns {Object} `{ files, revisions, favourite: { files, revisions } }`:
 *   the bad library keys and GDTF Share revision ids, and the favourite
 *   profile keys and revision ids, each to the time it was marked. A
 *   favourite's key is any library fixture's: a GDTF file's key or a
 *   profile's `<manufacturer>/<file>`.
 */
function marks() {
  try {
    const read = JSON.parse(fs.readFileSync(marksFile(), 'utf8')) || {};
    const favourite = read.favourite || {};
    return {
      files: read.files || {},
      revisions: read.revisions || {},
      favourite: { files: favourite.files || {}, revisions: favourite.revisions || {} },
    };
  } catch (err) {
    return { files: {}, revisions: {}, favourite: { files: {}, revisions: {} } };
  }
}

/**
 * Sets or clears one kind of mark on a key, a Share revision or both.
 *
 * @param {Function} groupOf picks the `{ files, revisions }` to change
 * @param {Object} what `{ key, rid }`, either may be missing
 * @param {Boolean} on
 * @returns {Object} every mark, as `marks` gives them
 */
function setMark(groupOf, what, on) {
  const { key, rid } = what || {};
  const all = marks();
  const group = groupOf(all);
  const at = Date.now();
  if (key) {
    if (on) group.files[key] = at;
    else delete group.files[key];
  }
  if (rid !== undefined && rid !== null) {
    if (on) group.revisions[rid] = at;
    else delete group.revisions[rid];
  }
  fs.mkdirSync(profilesRoot(), { recursive: true });
  fs.writeFileSync(marksFile(), JSON.stringify(all, null, 1));
  return all;
}

/** Marks a file, a Share revision or both bad, or clears the mark. */
const setBad = (what, bad) => setMark((all) => all, what, bad);

/** Marks a fixture, a Share revision or both favourite, or clears the mark. */
const setFavourite = (what, favourite) => setMark((all) => all.favourite, what, favourite);

/**
 * Every GDTF file one folder down from a Profiles folder.
 *
 * @param {String} root
 * @returns {Array<Object>} as `list` gives them
 */
function listUnder(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).forEach((folder) => {
    const dir = path.join(root, folder.name);
    fs.readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.toLowerCase().endsWith(EXTENSION))
      .forEach((f) => {
        const info = peekFile(path.join(dir, f.name));
        // A file that is not GDTF is skipped by name, and the rest still list.
        if (!info) {
          console.error(`[gdtf] skipping ${f.name}: not a GDTF file`);
          return;
        }
        const stem = f.name.slice(0, -EXTENSION.length);
        found.push({ key: `${folder.name}/${stem}`, file: `${folder.name}/${f.name}`, ...info });
      });
  });
  return found;
}

/**
 * Every GDTF fixture in a library.
 *
 * @param {String} [base] a library root other than the user's, for the files
 *   an opened export carries
 * @returns {Array<Object>} `{ key, file, name, manufacturer, fixtureTypeId,
 *   dataVersion, revision, category }`, `file` relative to the Profiles
 *   folder with `/` separators
 */
function list(base) {
  return listUnder(profilesRoot(base));
}

/**
 * The GDTF fixtures removed from the user's library, which shows still
 * resolve.
 *
 * @returns {Array<Object>} as `list` gives them, `file` relative to the
 *   removed Profiles folder
 */
function listRemoved() {
  return listUnder(removedRoot());
}

/**
 * Absolute path of a GDTF fixture by key, in the user's library or the given
 * root, or null when there is none.
 *
 * @param {String} key `<manufacturer folder>/<file stem>`
 * @param {String} [base]
 * @returns {String|null}
 */
function pathFor(key, base) {
  const segments = String(key || '').split('/');
  if (segments.length !== 2 || segments.some((s) => !s || s === '.' || s === '..')) return null;
  const file = path.join(profilesRoot(base), segments[0], `${segments[1]}${EXTENSION}`);
  return fs.existsSync(file) ? file : null;
}

/**
 * Absolute path of a removed GDTF fixture by key, or null when there is none.
 *
 * @param {String} key
 * @returns {String|null}
 */
function removedPathFor(key) {
  const segments = String(key || '').split('/');
  if (segments.length !== 2 || segments.some((s) => !s || s === '.' || s === '..')) return null;
  const file = path.join(removedRoot(), segments[0], `${segments[1]}${EXTENSION}`);
  return fs.existsSync(file) ? file : null;
}

/**
 * Moves a library file to the removed folder, over any removed copy of the
 * same key.
 *
 * @param {String} relative `<manufacturer folder>/<file>.gdtf`
 */
function moveToRemoved(relative) {
  const parts = relative.split('/');
  const target = path.join(removedRoot(), ...parts);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { force: true });
  fs.renameSync(path.join(profilesRoot(), ...parts), target);
}

/**
 * Copies a GDTF file into the library.
 *
 * Filed under its manufacturer, by its own file name. A file of the same
 * fixture type -- another revision, or the same one again -- is not replaced
 * without being asked: the first call reports it, and a second either
 * `replace`s it, removing it and copying the new one in, or keeps both,
 * the new one under a name of its own when the file name is taken.
 *
 * @param {String} source absolute path of the file to import
 * @param {Object} [options]
 * @param {Boolean} [options.replace] replace a file of the same fixture type
 * @param {Boolean} [options.keepBoth] add it beside a file of the same type
 * @returns {Object} `{ ok, entry }`, `{ ok: false, conflict }` naming the file
 *   it would replace, or `{ ok: false, reason }`
 */
function importFile(source, { replace = false, keepBoth = false } = {}) {
  if (path.extname(source).toLowerCase() !== EXTENSION) {
    return { ok: false, reason: `${path.basename(source)} is not a .gdtf file` };
  }
  let bytes;
  try {
    bytes = new Uint8Array(fs.readFileSync(source));
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const info = peek(bytes);
  if (!info) return { ok: false, reason: `${path.basename(source)} is not a GDTF file` };

  const folder = library.safeSegment(info.manufacturer || 'Unknown');
  const dir = path.join(profilesRoot(), folder);
  const given = library.safeSegment(path.basename(source, path.extname(source)));
  // Kept beside a file of the same name: the same file again, numbered.
  let stem = given;
  for (let n = 2; keepBoth && fs.existsSync(path.join(dir, `${stem}${EXTENSION}`)); n += 1) {
    stem = `${given} (${n})`;
  }
  const target = path.join(dir, `${stem}${EXTENSION}`);

  // The same fixture already filed, under any file name -- another revision
  // -- and whatever already has this file name.
  const file = `${folder}/${stem}${EXTENSION}`;
  const conflicts = keepBoth ? [] : list().filter((e) => e.file === file
    || (e.fixtureTypeId && e.fixtureTypeId === info.fixtureTypeId));
  if (conflicts.length && !replace) {
    return {
      ok: false,
      conflict: { incoming: { ...info, file: path.basename(source) }, existing: conflicts },
    };
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    conflicts.forEach((c) => moveToRemoved(c.file));
    fs.copyFileSync(source, target);
    // Listed again: the removed copy of this key is the same fixture, older.
    fs.rmSync(path.join(removedRoot(), folder, `${stem}${EXTENSION}`), { force: true });
  } catch (err) {
    console.error('[gdtf] import failed:', err.message);
    return { ok: false, reason: err.message };
  }
  // A replaced file's mark goes with it; the new file is judged afresh.
  conflicts.forEach((c) => { if (marks().files[c.key]) setBad({ key: c.key }, false); });
  return { ok: true, entry: { key: `${folder}/${stem}`, file, ...info } };
}

/**
 * Removes a GDTF file from the user's library, and its marks. The file moves
 * to the removed folder, where shows that use it still find it.
 *
 * @param {String} key `<manufacturer folder>/<file stem>`
 * @returns {Object} `{ ok }` or `{ ok: false, reason }`
 */
function removeFile(key) {
  const file = pathFor(key);
  if (!file) return { ok: false, reason: `${key} is not in the library` };
  try {
    moveToRemoved(path.relative(profilesRoot(), file).split(path.sep).join('/'));
  } catch (err) {
    console.error('[gdtf] remove failed:', err.message);
    return { ok: false, reason: err.message };
  }
  const all = marks();
  if (all.files[key]) setBad({ key }, false);
  if (all.favourite.files[key]) setFavourite({ key }, false);
  return { ok: true };
}

export default {
  peek,
  list,
  listRemoved,
  pathFor,
  removedPathFor,
  importFile,
  removeFile,
  marks,
  setBad,
  setFavourite,
  profilesRoot,
  removedRoot,
  EXTENSION,
  REMOVED_DIR,
};
