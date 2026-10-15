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
 *
 * Cards live beside the files, in `Library/Lasers/Cards`: one JSON file per
 * card, `{ name, clips }`, the content a physical laser's memory card holds
 * whatever show it is used in. The library's card wins over a copy an opened
 * export carries.
 */

/** The cards folder, under a lasers folder. */
const CARDS_DIR = 'Cards';

/** The extension a card is stored with. */
const CARD_EXTENSION = '.json';

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

/** Where the user's cards live. */
function cardsRoot() {
  return path.join(laserRoot(), CARDS_DIR);
}

/** Where the open document's carried cards are, or null. */
function projectCardsRoot() {
  const mounted = projectRoot();
  return mounted ? path.join(mounted, CARDS_DIR) : null;
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
 * Asks for ILDA files and copies them into the library. The dialog opens on
 * the library's lasers folder, and a file picked from there is used as it is
 * rather than copied again.
 *
 * @public
 * @async
 * @param {Object} window the browser window to attach the dialog to
 * @returns {Promise<Object>} `{ ok, entries }`, or `{ ok: false, reason }`
 */
async function add(window) {
  const root = laserRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const result = await dialog.showOpenDialog(window, {
    title: 'Add ILDA files',
    defaultPath: root,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'ILDA files', extensions: objectstore.LASER_EXTENSIONS.map((e) => e.slice(1)) }],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, reason: 'cancelled' };

  const entries = [];
  const refused = [];
  result.filePaths.forEach((source) => {
    if (!isClipFile(source)) {
      refused.push(path.basename(source));
      return;
    }
    // Already in the library: use it where it is.
    if (path.relative(root, path.dirname(source)) === '') {
      const name = path.basename(source);
      entries.push({
        key: name,
        name: path.basename(name, path.extname(name)),
        origin: 'library',
        url: `library://lasers/${encodeURIComponent(name)}`,
      });
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

/**
 * The cards in one folder.
 *
 * @param {String|null} root
 * @param {String} origin `library` or `project`
 * @returns {Array<Object>} `{ key, name, clips, origin }`
 */
function cardsIn(root, origin) {
  if (!root) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === CARD_EXTENSION)
    .map((entry) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(root, entry.name), 'utf8'));
        const key = path.basename(entry.name, path.extname(entry.name));
        return {
          key,
          name: typeof data.name === 'string' && data.name ? data.name : key,
          clips: Array.isArray(data.clips) ? data.clips : [],
          origin,
        };
      } catch (err) {
        console.error(`[lasers] unreadable card ${entry.name}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Every card on offer, one per key: the library's, then those only the open
 * document carries.
 *
 * @public
 * @returns {Array<Object>} `{ key, name, clips, origin }`, sorted by name
 */
function listCards() {
  const byKey = new Map();
  [...cardsIn(cardsRoot(), 'library'), ...cardsIn(projectCardsRoot(), 'project')]
    .forEach((card) => {
      const folded = card.key.toLowerCase();
      if (!byKey.has(folded)) byKey.set(folded, card);
    });
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The card file a key resolves to, as `listCards` resolves it.
 *
 * @public
 * @param {String} key
 * @returns {String|null}
 */
function cardFileFor(key) {
  if (typeof key !== 'string' || !key || key !== path.basename(key)) return null;
  const roots = [cardsRoot(), projectCardsRoot()].filter(Boolean);
  for (let i = 0; i < roots.length; i += 1) {
    const file = path.join(roots[i], `${key}${CARD_EXTENSION}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Writes a card to the library, new or over the one of that name. Files it
 * plays that only the open document carries are copied into the library too,
 * so the card plays on this machine after the document is closed.
 *
 * @public
 * @param {String} name
 * @param {Array} clips
 * @returns {Object} `{ ok, key }` or `{ ok: false, reason }`
 */
function saveCard(name, clips) {
  const shown = String(name || '').trim();
  const key = objectstore.safeName(shown);
  if (!key) return { ok: false, reason: 'A card needs a name.' };
  const cardClips = Array.isArray(clips) ? clips : [];
  try {
    fs.mkdirSync(cardsRoot(), { recursive: true });
    fs.mkdirSync(laserRoot(), { recursive: true });
    cardClips.forEach((clip) => {
      if (!clip || typeof clip.file !== 'string' || !isClipFile(clip.file)) return;
      const inLibrary = path.join(laserRoot(), clip.file);
      if (fs.existsSync(inLibrary)) return;
      const carried = projectRoot() ? path.join(projectRoot(), clip.file) : null;
      if (carried && fs.existsSync(carried)) fs.copyFileSync(carried, inLibrary);
    });
    const data = { name: shown, clips: cardClips };
    const target = path.join(cardsRoot(), `${key}${CARD_EXTENSION}`);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(data, null, 2));
    fs.renameSync(`${target}.tmp`, target);
  } catch (err) {
    console.error('[lasers] could not save card:', err.message);
    return { ok: false, reason: err.message };
  }
  return { ok: true, key };
}

/**
 * Copies a clip list's files to a folder -- a laser's SD card, most often --
 * in list order. Most standalone lasers play their files sorted by name, so
 * each is numbered: `001 Logo.ild`, `002 Tunnel.ild`, and the card's order
 * matches the clip numbers a DMX channel picks. Files already there under
 * the same name are replaced; nothing else in the folder is touched.
 *
 * @public
 * @async
 * @param {Object} window the browser window to attach the dialog to
 * @param {Array} clips `{ name, file }` in list order
 * @returns {Promise<Object>} `{ ok, folder, written, missing }` or
 *   `{ ok: false, reason }`
 */
async function exportToFolder(window, clips) {
  const files = (Array.isArray(clips) ? clips : [])
    .filter((clip) => clip && typeof clip.file === 'string' && isClipFile(clip.file));
  if (!files.length) return { ok: false, reason: 'The files has no ILDA files to export.' };
  const result = await dialog.showOpenDialog(window, {
    title: 'Export the clip files to an SD card or folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, reason: 'cancelled' };
  const folder = result.filePaths[0];
  const digits = Math.max(3, String(files.length).length);
  const written = [];
  const missing = [];
  files.forEach((clip, i) => {
    const source = fileFor(clip.file);
    if (!source) {
      missing.push(clip.file);
      return;
    }
    const number = String(i + 1).padStart(digits, '0');
    const base = objectstore.safeName(clip.name || path.basename(clip.file, path.extname(clip.file))) || 'clip';
    const name = `${number} ${base}${path.extname(clip.file).toLowerCase()}`;
    try {
      fs.copyFileSync(source, path.join(folder, name));
      written.push(name);
    } catch (err) {
      console.error(`[lasers] could not export ${clip.file}: ${err.message}`);
      missing.push(clip.file);
    }
  });
  return {
    ok: written.length > 0, folder, written, missing,
  };
}

export default {
  list,
  add,
  fileFor,
  laserRoot,
  shippedRoot,
  listCards,
  cardFileFor,
  saveCard,
  exportToFolder,
  CARDS_DIR,
};
