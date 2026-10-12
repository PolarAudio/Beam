import fs from 'fs';
import path from 'path';
import jsonstore from './jsonstore';

/**
 * The folder each kind of save last went to, so its dialog opens there next
 * time (main process).
 *
 * Kept in the application's data directory rather than in a project: a path
 * belongs to this machine, and a project travels. Only the dialog's starting
 * folder comes from here; every save still goes through the dialog.
 *
 * Keys are chosen by the caller: a kind of file, and the project it was saved
 * for when the folder depends on the project.
 */

const STORE = 'save-folders';

/**
 * @param {String} key
 * @returns {String|null} the folder last saved to under this key, while it
 *   still exists
 */
function folderFor(key) {
  if (!key) return null;
  const folders = jsonstore.read(STORE) || {};
  const folder = folders[key];
  try {
    return folder && fs.statSync(folder).isDirectory() ? folder : null;
  } catch (err) {
    return null;
  }
}

/**
 * Remembers the folder a file was saved into.
 *
 * @param {String} key
 * @param {String} target the file written
 */
function remember(key, target) {
  if (!key || !target) return;
  const folders = jsonstore.read(STORE) || {};
  folders[key] = path.dirname(target);
  jsonstore.write(STORE, JSON.stringify(folders, null, 2));
}

export default { folderFor, remember };
