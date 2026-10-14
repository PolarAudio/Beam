/* eslint-disable no-console */
/* eslint-disable import/no-extraneous-dependencies */
import fs from 'fs';
import path from 'path';
import { dialog } from 'electron';
import documentstore from './documentstore';
import library from './library';
import objectstore from './objectstore';
import paths from './paths';

/**
 * @file ILDA files a laser plays from its clip list (main process).
 *
 * Files live in `Library/Lasers`, copied in by `add()`, for the reason the
 * media store gives: the renderer is not trusted to name a path. A name
 * resolves in the order a show's files do: what the open document carries,
 * the user's library, then the files that ship with Beam (the ILDA test
 * patterns among them). A show names a file by its file name only.
 */

/** Where the user's laser files live. */
function laserRoot() {
  return path.join(library.libraryRoot(), objectstore.LASERS_DIR);
}

/** Where the laser files shipped with Beam live. */
function shippedRoot() {
  return paths.rendererAssets('lasers');
}

/** Where the open document's carried laser files are, or null. */
function projectRoot() {
  const mounted = documentstore.mountRoot();
  return mounted ? path.join(mounted, objectstore.LASERS_DIR) : null;
}

/** Whether a file name is one this store holds. */
function isClipFile(name) {
  return objectstore.LASER_EXTENSIONS.includes(path.extname(String(name)).toLowerCase());
}

/**
 * The laser files in one folder.
 *
 * @param {String|null} root
 * @param {String} host the `library://` host that serves it
 * @param {String} origin `project`, `library` or `shipped`
 * @returns {Array<Object>}
 */
function entriesIn(root, host, origin) {
  if (!root) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && isClipFile(entry.name))
    .map((entry) => ({
      key: entry.name,
      name: path.basename(entry.name, path.extname(entry.name)),
      origin,
      url: `library://${host}/${encodeURIComponent(entry.name)}`,
    }));
}

/**
 * Every laser file on offer, one entry per file name: the open document's
 * hides the library's of that name, and the library's hides a shipped one.
 *
 * @public
 * @returns {Array<Object>} `{ key, name, origin, url }`, sorted by name
 */
function list() {
  const byKey = new Map();
  [
    ...entriesIn(projectRoot(), 'projectlasers', 'project'),
    ...entriesIn(laserRoot(), 'lasers', 'library'),
    ...entriesIn(shippedRoot(), 'shippedlasers', 'shipped'),
  ].forEach((entry) => {
    const folded = entry.key.toLowerCase();
    if (!byKey.has(folded)) byKey.set(folded, entry);
  });
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The file a name resolves to, as `list` would resolve it.
 *
 * @public
 * @param {String} key file name
 * @returns {String|null} absolute path, or null when no folder has it
 */
function fileFor(key) {
  if (typeof key !== 'string' || !isClipFile(key) || key !== path.basename(key)) return null;
  const roots = [projectRoot(), laserRoot(), shippedRoot()].filter(Boolean);
  for (let i = 0; i < roots.length; i += 1) {
    const file = path.join(roots[i], key);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Asks for ILDA files and copies them into the library.
 *
 * @public
 * @async
 * @param {Object} window the browser window to attach the dialog to
 * @returns {Promise<Object>} `{ ok, entries }`, or `{ ok: false, reason }`
 */
async function add(window) {
  const result = await dialog.showOpenDialog(window, {
    title: 'Add ILDA files',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'ILDA files', extensions: objectstore.LASER_EXTENSIONS.map((e) => e.slice(1)) }],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, reason: 'cancelled' };

  const root = laserRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const entries = [];
  const refused = [];
  result.filePaths.forEach((source) => {
    if (!isClipFile(source)) {
      refused.push(path.basename(source));
      return;
    }
    const extension = path.extname(source);
    const base = objectstore.safeName(path.basename(source, extension)) || 'laser';
    let name = `${base}${extension.toLowerCase()}`;
    let target = path.join(root, name);
    // Never silently overwrite: two files with one name are two files.
    for (let n = 2; fs.existsSync(target); n += 1) {
      name = `${base} ${n}${extension.toLowerCase()}`;
      target = path.join(root, name);
    }
    try {
      fs.copyFileSync(source, target);
      entries.push({
        key: name,
        name: path.basename(name, path.extname(name)),
        origin: 'library',
        url: `library://lasers/${encodeURIComponent(name)}`,
      });
    } catch (err) {
      console.error('[lasers] copy failed:', err.message);
      refused.push(path.basename(source));
    }
  });
  if (!entries.length) return { ok: false, reason: `Could not add ${refused.join(', ')}` };
  return { ok: true, entries, refused };
}

export default {
  list, add, fileFor, laserRoot, shippedRoot,
};
