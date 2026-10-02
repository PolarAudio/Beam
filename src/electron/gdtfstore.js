/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { unzipSync, strFromU8 } from 'fflate';
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
 * each file is read to list it: its name, manufacturer and fixture type ID.
 *
 * A fixture's key is `<manufacturer folder>/<file name without .gdtf>`. The
 * file name, not the fixture name, because two revisions of one fixture are
 * two files and a show must name exactly one.
 */

const PROFILES_DIR = 'Profiles';
const EXTENSION = '.gdtf';

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
 * @returns {Object|null} `{ name, manufacturer, fixtureTypeId, dataVersion }`,
 *   or null when the bytes are not a GDTF file
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
  return {
    name: read(tag[1], 'Name'),
    manufacturer: read(tag[1], 'Manufacturer'),
    fixtureTypeId: read(tag[1], 'FixtureTypeID') || null,
    dataVersion: read(root[1], 'DataVersion') || null,
  };
}

/** Peeks at a file on disk, through the cache. */
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
    info = peek(new Uint8Array(fs.readFileSync(file)));
  } catch (err) {
    console.error(`[gdtf] cannot read ${file}: ${err.message}`);
  }
  peekCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, info });
  return info;
}

/** The Profiles folder of a library root. */
function profilesRoot(base) {
  return path.join(base || library.libraryRoot(), PROFILES_DIR);
}

/**
 * Every GDTF fixture in a library.
 *
 * @param {String} [base] a library root other than the user's, for the files
 *   an opened export carries
 * @returns {Array<Object>} `{ key, file, name, manufacturer, fixtureTypeId,
 *   dataVersion }`, `file` relative to the Profiles folder with `/` separators
 */
function list(base) {
  const root = profilesRoot(base);
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
 * Copies a GDTF file into the library.
 *
 * Filed under its manufacturer, by its own file name. A file of the same
 * fixture type -- another revision, or the same one again -- is not replaced
 * without being asked: the first call reports it, and a second with `replace`
 * removes it and copies the new one in.
 *
 * @param {String} source absolute path of the file to import
 * @param {Object} [options]
 * @param {Boolean} [options.replace] replace a file of the same fixture type
 * @returns {Object} `{ ok, entry }`, `{ ok: false, conflict }` naming the file
 *   it would replace, or `{ ok: false, reason }`
 */
function importFile(source, { replace = false } = {}) {
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
  const stem = library.safeSegment(path.basename(source, path.extname(source)));
  const target = path.join(dir, `${stem}${EXTENSION}`);

  // The same fixture already filed, under any file name -- another revision
  // -- and whatever already has this file name.
  const file = `${folder}/${stem}${EXTENSION}`;
  const conflicts = list().filter((e) => e.file === file
    || (e.fixtureTypeId && e.fixtureTypeId === info.fixtureTypeId));
  if (conflicts.length && !replace) {
    return {
      ok: false,
      conflict: { incoming: { ...info, file: path.basename(source) }, existing: conflicts },
    };
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    conflicts.forEach((c) => fs.rmSync(path.join(profilesRoot(), ...c.file.split('/')), { force: true }));
    fs.copyFileSync(source, target);
  } catch (err) {
    console.error('[gdtf] import failed:', err.message);
    return { ok: false, reason: err.message };
  }
  return { ok: true, entry: { key: `${folder}/${stem}`, file, ...info } };
}

export default {
  peek, list, pathFor, importFile, profilesRoot, EXTENSION,
};
