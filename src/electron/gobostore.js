/* eslint-disable no-console */
/* eslint-disable import/no-extraneous-dependencies */
import fs from 'fs';
import path from 'path';
import { dialog } from 'electron';
import documentstore from './documentstore';
import library from './library';
import objectstore from './objectstore';

/**
 * @file Gobo and animation disc images a placement may swap into its wheels
 * (main process).
 *
 * Files live in `Library/Gobos`, copied in by `add()`, for the reason the
 * media store gives: the renderer is not trusted to name a path. A name
 * resolves as a show's files do: what the open document carries, then the
 * user's library. A placement names an image by its file name only. Beam's
 * own stock gobos and discs ship in the renderer's `public` folder and are
 * not listed here.
 *
 * Images are read as a GDTF wheel image is: white where light passes, black
 * where the metal is, and for a gobo, transparent round it as the holder.
 */

/** Where the user's images live. */
function goboRoot() {
  return path.join(library.libraryRoot(), objectstore.GOBOS_DIR);
}

/** Where the open document's carried images are, or null. */
function projectRoot() {
  const mounted = documentstore.mountRoot();
  return mounted ? path.join(mounted, objectstore.GOBOS_DIR) : null;
}

/** Whether a file name is one this store holds. */
function isGoboFile(name) {
  return objectstore.GOBO_EXTENSIONS.includes(path.extname(String(name)).toLowerCase());
}

/**
 * The images in one folder.
 *
 * @param {String|null} root
 * @param {String} host the `library://` host that serves it
 * @param {String} origin `project` or `library`
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
    .filter((entry) => entry.isFile() && isGoboFile(entry.name))
    .map((entry) => ({
      key: entry.name,
      name: path.basename(entry.name, path.extname(entry.name)),
      origin,
      url: `library://${host}/${encodeURIComponent(entry.name)}`,
    }));
}

/**
 * Every image on offer, one entry per file name: the open document's hides
 * the library's of that name.
 *
 * @public
 * @returns {Array<Object>} `{ key, name, origin, url }`, sorted by name
 */
function list() {
  const byKey = new Map();
  [
    ...entriesIn(projectRoot(), 'projectgobos', 'project'),
    ...entriesIn(goboRoot(), 'gobos', 'library'),
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
  if (typeof key !== 'string' || !isGoboFile(key) || key !== path.basename(key)) return null;
  const roots = [projectRoot(), goboRoot()].filter(Boolean);
  for (let i = 0; i < roots.length; i += 1) {
    const file = path.join(roots[i], key);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Asks for images and copies them into the library. The dialog opens on the
 * library's gobos folder, and an image picked from there is used as it is
 * rather than copied again.
 *
 * @public
 * @async
 * @param {Object} window the browser window to attach the dialog to
 * @returns {Promise<Object>} `{ ok, entries }`, or `{ ok: false, reason }`
 */
async function add(window) {
  const root = goboRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const result = await dialog.showOpenDialog(window, {
    title: 'Add gobo or animation disc images',
    defaultPath: root,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: objectstore.GOBO_EXTENSIONS.map((e) => e.slice(1)) }],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, reason: 'cancelled' };

  const entries = [];
  const refused = [];
  const entry = (name) => ({
    key: name,
    name: path.basename(name, path.extname(name)),
    origin: 'library',
    url: `library://gobos/${encodeURIComponent(name)}`,
  });
  result.filePaths.forEach((source) => {
    if (!isGoboFile(source)) {
      refused.push(path.basename(source));
      return;
    }
    // Already in the library: use it where it is.
    if (path.relative(root, path.dirname(source)) === '') {
      entries.push(entry(path.basename(source)));
      return;
    }
    const extension = path.extname(source).toLowerCase();
    const base = objectstore.safeName(path.basename(source, path.extname(source))) || 'gobo';
    let name = `${base}${extension}`;
    let target = path.join(root, name);
    // Never silently overwrite: two files with one name are two files.
    for (let n = 2; fs.existsSync(target); n += 1) {
      name = `${base} ${n}${extension}`;
      target = path.join(root, name);
    }
    try {
      fs.copyFileSync(source, target);
      entries.push(entry(name));
    } catch (err) {
      console.error('[gobos] copy failed:', err.message);
      refused.push(path.basename(source));
    }
  });
  if (!entries.length) return { ok: false, reason: `Could not add ${refused.join(', ')}` };
  return { ok: true, entries, refused };
}

export default {
  list, fileFor, add,
};
