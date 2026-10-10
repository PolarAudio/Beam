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
 * @file Image and video files used as a video source (main process).
 *
 * A file is a picture source beside the NDI senders: a still image, or a
 * video that plays muted and loops. Files live in `Library/Media`, copied in
 * by `add()`, for the reason `environmentstore` gives: the renderer is not
 * trusted to name a path, and serving from a known folder is the guarantee.
 *
 * Three places offer files, in the order a name resolves: what the open
 * document carries (an opened export), the user's library, and the files
 * that ship with Beam. A show names a file by its file name only, so the
 * same show finds its picture on any machine that has it.
 */

/** Where the user's media files live. */
function mediaRoot() {
  return path.join(library.libraryRoot(), objectstore.MEDIA_DIR);
}

/** Where the media files shipped with Beam live. */
function shippedRoot() {
  return paths.rendererAssets('media');
}

/** Where the open document's carried media files are, or null. */
function projectRoot() {
  const mounted = documentstore.mountRoot();
  return mounted ? path.join(mounted, objectstore.MEDIA_DIR) : null;
}

/** The media folder, created on demand so a file manager has somewhere to copy to. */
function ensureRoot() {
  const root = mediaRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    console.error('[media] cannot create folder:', err.message);
  }
  return root;
}

/** `image` or `video` for a media file name, or null for anything else. */
function kindOf(name) {
  const extension = path.extname(name).toLowerCase();
  if (objectstore.MEDIA_IMAGE_EXTENSIONS.includes(extension)) return 'image';
  if (objectstore.MEDIA_VIDEO_EXTENSIONS.includes(extension)) return 'video';
  return null;
}

/**
 * The media files in one folder.
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
    .filter((entry) => entry.isFile() && kindOf(entry.name))
    .map((entry) => ({
      key: entry.name,
      name: path.basename(entry.name, path.extname(entry.name)),
      kind: kindOf(entry.name),
      origin,
      url: `library://${host}/${encodeURIComponent(entry.name)}`,
    }));
}

/**
 * Every media file on offer, one entry per file name.
 *
 * A name carried by the open document hides the library's file of that name,
 * and the library's hides a shipped one: the order a show's file resolves in.
 *
 * @public
 * @returns {Array<Object>} `{ key, name, kind, origin, url }`, sorted by name
 */
function list() {
  ensureRoot();
  const byKey = new Map();
  [
    ...entriesIn(projectRoot(), 'projectmedia', 'project'),
    ...entriesIn(mediaRoot(), 'media', 'library'),
    ...entriesIn(shippedRoot(), 'shippedmedia', 'shipped'),
  ].forEach((entry) => {
    const folded = entry.key.toLowerCase();
    if (!byKey.has(folded)) byKey.set(folded, entry);
  });
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The file a media key resolves to, as `list` would resolve it.
 *
 * @public
 * @param {String} key file name
 * @returns {String|null} absolute path, or null when no folder has it
 */
function fileFor(key) {
  if (typeof key !== 'string' || !kindOf(key) || key !== path.basename(key)) return null;
  const roots = [projectRoot(), mediaRoot(), shippedRoot()].filter(Boolean);
  for (let i = 0; i < roots.length; i += 1) {
    const file = path.join(roots[i], key);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Asks for an image or video file and copies it into the library.
 *
 * @public
 * @async
 * @param {Object} window the browser window to attach the dialog to
 * @returns {Promise<Object>} `{ ok, entry }`, or `{ ok: false, reason }`
 */
async function add(window) {
  const strip = (extensions) => extensions.map((extension) => extension.slice(1));
  const result = await dialog.showOpenDialog(window, {
    title: 'Add image or video',
    properties: ['openFile'],
    filters: [
      {
        name: 'Images and videos',
        extensions: strip(objectstore.MEDIA_EXTENSIONS),
      },
      { name: 'Images', extensions: strip(objectstore.MEDIA_IMAGE_EXTENSIONS) },
      { name: 'Videos', extensions: strip(objectstore.MEDIA_VIDEO_EXTENSIONS) },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, reason: 'cancelled' };

  const source = result.filePaths[0];
  const extension = path.extname(source).toLowerCase();
  if (!kindOf(source)) {
    return { ok: false, reason: `${extension || 'that file'} is not an image or video Beam can play` };
  }

  const root = ensureRoot();
  const base = objectstore.safeName(path.basename(source, extension)) || 'media';
  let name = `${base}${extension}`;
  let target = path.join(root, name);
  // Never silently overwrite: two files with one name are two files.
  for (let n = 2; fs.existsSync(target); n += 1) {
    name = `${base} ${n}${extension}`;
    target = path.join(root, name);
  }

  try {
    fs.copyFileSync(source, target);
  } catch (err) {
    console.error('[media] copy failed:', err.message);
    return { ok: false, reason: err.message };
  }

  return {
    ok: true,
    entry: {
      key: name,
      name: path.basename(name, extension),
      kind: kindOf(name),
      origin: 'library',
      url: `library://media/${encodeURIComponent(name)}`,
    },
  };
}

export default {
  list, add, fileFor, kindOf, mediaRoot, shippedRoot,
};
