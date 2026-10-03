/* eslint-disable no-console, import/no-extraneous-dependencies */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app, safeStorage, session } from 'electron';

/**
 * GDTF Share, the fixture library at gdtf-share.com (main process).
 *
 * Three calls make up its public API: log in with the account's user and
 * password, which starts a session cookie good for two hours; list every
 * revision of every fixture; download one revision by its id. The cookie is
 * kept in a session of its own, apart from the app's, and a call refused for
 * want of it logs in again once and retries.
 *
 * The account is stored encrypted by the operating system (`safeStorage`) and
 * never handed to the renderer, which only learns whether one is stored and
 * whose it is. The list is cached on disk, so browsing opens at once and
 * works offline; it is fetched again when asked. A download is written to a
 * temporary file named as the Share names it and imported from there by the
 * same path a file picked from disk takes.
 */

const API = 'https://gdtf-share.com/apis/public';
const PARTITION = 'gdtf-share';

/** Where the account and the cached list are kept. */
const accountFile = () => path.join(app.getPath('userData'), 'gdtf-share-account.bin');
const listFile = () => path.join(app.getPath('userData'), 'gdtf-share-list.json');
/** The revision id imported from the Share, by library key. */
const importedFile = () => path.join(app.getPath('userData'), 'gdtf-share-imported.json');

/** Which revision of each fixture type was imported from the Share. */
function imported() {
  try {
    return JSON.parse(fs.readFileSync(importedFile(), 'utf8')) || {};
  } catch (err) {
    return {};
  }
}

/**
 * Notes which Share revision a library file is, once the import took it, or
 * forgets it when `rid` is null.
 *
 * @param {String} key the library key the file was imported under
 * @param {Number|null} rid
 * @returns {Object} every record
 */
function recordImport(key, rid) {
  const records = imported();
  if (rid === null || rid === undefined) delete records[key];
  else records[key] = rid;
  fs.writeFileSync(importedFile(), JSON.stringify(records, null, 1));
  return records;
}

const shareSession = () => session.fromPartition(PARTITION);

/**
 * When this session last logged in, ms. The Share's session lasts two hours;
 * a call later than this margin logs in again first rather than finding out.
 */
let loggedInAt = 0;
const SESSION_MARGIN_MS = 100 * 60 * 1000;

/** The stored account, decrypted, or null. */
function account() {
  try {
    if (!fs.existsSync(accountFile()) || !safeStorage.isEncryptionAvailable()) return null;
    const parsed = JSON.parse(safeStorage.decryptString(fs.readFileSync(accountFile())));
    return parsed && parsed.user ? parsed : null;
  } catch (err) {
    console.error('[gdtf share] cannot read the stored account:', err.message);
    return null;
  }
}

/** Logs in with an account; resolves to `{ ok, error }`. */
async function logIn({ user, password }) {
  try {
    const response = await shareSession().fetch(`${API}/login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, password }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.result) {
      loggedInAt = Date.now();
      return { ok: true };
    }
    return { ok: false, error: body.error || `login refused (${response.status})` };
  } catch (err) {
    return { ok: false, error: `cannot reach GDTF Share: ${err.message}` };
  }
}

/**
 * A call that needs the session: logs in first if nothing is known to be
 * logged in, and once more if the call is refused.
 */
async function authorised(url) {
  const stored = account();
  if (!stored) return { ok: false, error: 'no GDTF Share account stored' };
  if (Date.now() - loggedInAt > SESSION_MARGIN_MS) {
    const login = await logIn(stored);
    if (!login.ok) return login;
  }
  let response;
  try {
    response = await shareSession().fetch(url);
  } catch (err) {
    return { ok: false, error: `cannot reach GDTF Share: ${err.message}` };
  }
  if (response.status === 401) {
    const login = await logIn(stored);
    if (!login.ok) return login;
    response = await shareSession().fetch(url);
  }
  return { ok: response.ok, response, error: response.ok ? null : `GDTF Share answered ${response.status}` };
}

/**
 * Whether an account is stored, and whose.
 *
 * @returns {Object} `{ available, user }`; `available` false where the
 *   operating system offers no encryption to store it with
 */
function status() {
  const stored = account();
  return { available: safeStorage.isEncryptionAvailable(), user: stored ? stored.user : null };
}

/**
 * Checks an account against GDTF Share and stores it when it is good.
 *
 * @param {String} user
 * @param {String} password
 * @returns {Promise<Object>} `{ ok, error }`
 */
async function saveAccount(user, password) {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'this system cannot store the account encrypted' };
  }
  const result = await logIn({ user, password });
  if (!result.ok) return result;
  fs.writeFileSync(accountFile(), safeStorage.encryptString(JSON.stringify({ user, password })));
  return { ok: true };
}

/** Forgets the stored account and the session. */
async function forgetAccount() {
  fs.rmSync(accountFile(), { force: true });
  loggedInAt = 0;
  await shareSession().clearStorageData({ storages: ['cookies'] });
  return { ok: true };
}

/** The cached list, or null. */
function cachedList() {
  try {
    return JSON.parse(fs.readFileSync(listFile(), 'utf8'));
  } catch (err) {
    return null;
  }
}

/**
 * Every revision on GDTF Share: the cached copy, or a fresh one when asked
 * or when there is none.
 *
 * @param {Boolean} [refresh]
 * @returns {Promise<Object>} `{ ok, list, fetched, error }`; `fetched` is
 *   when the list was taken from the Share, in ms
 */
async function list(refresh = false) {
  const cached = cachedList();
  if (cached && !refresh) return { ok: true, list: cached.list, fetched: cached.fetched };
  const result = await authorised(`${API}/getList.php`);
  if (!result.ok) {
    // Offline or refused: what was there before is still worth showing.
    if (cached) {
      return {
        ok: true, list: cached.list, fetched: cached.fetched, error: result.error,
      };
    }
    return { ok: false, error: result.error };
  }
  const body = await result.response.json().catch(() => ({}));
  if (!body.result || !Array.isArray(body.list)) {
    return { ok: false, error: body.error || 'GDTF Share sent no list' };
  }
  const fresh = { fetched: Date.now(), list: body.list };
  fs.writeFileSync(listFile(), JSON.stringify(fresh));
  return { ok: true, list: fresh.list, fetched: fresh.fetched };
}

/** A file name that is safe on Windows, from what the Share calls a file. */
function safeName(name) {
  // eslint-disable-next-line no-control-regex
  return String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'fixture';
}

/**
 * Downloads one revision to a temporary file, for the import to take in.
 *
 * Named as the Share names it, `Manufacturer@Fixture@Revision.gdtf`, which is
 * the name a file downloaded from the website has, so a fixture lands in the
 * library under the same key either way.
 *
 * @param {Number} rid revision id
 * @param {Object} [hint] `{ manufacturer, fixture, revision }` for the name
 *   when the Share gives none
 * @returns {Promise<Object>} `{ ok, path, error }`
 */
async function download(rid, hint = {}) {
  const result = await authorised(`${API}/downloadFile.php?rid=${encodeURIComponent(rid)}`);
  if (!result.ok) return { ok: false, error: result.error };
  const type = result.response.headers.get('content-type') || '';
  if (type.includes('json')) {
    const body = await result.response.json().catch(() => ({}));
    return { ok: false, error: body.error || 'GDTF Share sent no file' };
  }
  const disposition = result.response.headers.get('content-disposition') || '';
  const given = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const fallback = [hint.manufacturer, hint.fixture, hint.revision].filter(Boolean).join('@');
  let name = safeName(given ? decodeURIComponent(given[1]) : fallback || `rid${rid}`);
  if (!name.toLowerCase().endsWith('.gdtf')) name += '.gdtf';
  // Only the last download is kept: the import has copied the one before.
  const dir = path.join(os.tmpdir(), 'beam-gdtf-share');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(await result.response.arrayBuffer()));
  return { ok: true, path: file };
}

export default {
  status, saveAccount, forgetAccount, list, download, imported, recordImport,
};
