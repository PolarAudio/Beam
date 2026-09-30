/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import documentstore from './documentstore';
import library from './library';
import objectstore from './objectstore';
import paths from './paths';

/**
 * Collecting what a show references into its document (main process).
 *
 * An ordinary save writes the show and nothing else: a fixture is named by
 * `manufacturer/model`, an object by its library key, and both are resolved
 * against whatever library the machine has when the file is opened. That is
 * what keeps a profile edit reaching every show that uses it. An export is the
 * one deliberate exception -- a frozen copy, carrying the files it names so
 * that it opens the same way on a machine with a different library, or none.
 *
 * The renderer says *what* is referenced -- it is the only side that knows
 * which profiles and models the show actually places -- and this module finds
 * the files, because the library and the shipped assets are on disk in the
 * main process. Bytes never cross IPC: a model is megabytes.
 *
 * Collected entries sit under `Library/` in the container, laid out exactly as
 * the user's library is, so that an export unpacked by hand is a library
 * folder, and so that a reader resolving project-local first can walk it the
 * way it walks the real one:
 *
 *   Library/Profiles/<manufacturer>/<model>.json
 *   Library/Overrides/<manufacturer>/<model>.json
 *   Library/Objects/[<folder>/]<file>
 *
 * A shipped profile or model is collected too. It is part of *this* version
 * of Beam, and the export may be opened by another.
 */

/** Where collected resources sit in the container. */
const PREFIX = documentstore.LIBRARY_PREFIX;

/** Where shipped fixture profiles live, under the renderer's assets. */
const SHIPPED_FIXTURES_DIR = 'fixtures';

/** Preview images that may sit beside a model or a shape. */
const THUMBNAIL_EXTENSIONS = ['.png', '.jpg', '.webp'];

/**
 * Where the fixture profiles shipped with the app live on disk.
 *
 * @returns {String} absolute path
 */
function shippedFixturesRoot() {
  return paths.rendererAssets(SHIPPED_FIXTURES_DIR);
}

/**
 * The entry name of a library item, from its path under the library root.
 *
 * Forward slashes whatever the platform: this names a zip entry, not a file.
 *
 * @param {String} relative path relative to the library root
 * @returns {String} entry name
 */
function entryFor(relative) {
  return `${PREFIX}${relative.split(path.sep).join('/')}`;
}

/**
 * Reads one file, or says why not.
 *
 * @param {String} file absolute path
 * @returns {Uint8Array|null} contents, or null when unreadable
 */
function bytesOf(file) {
  try {
    return new Uint8Array(fs.readFileSync(file));
  } catch (err) {
    return null;
  }
}

/**
 * A profile's place in the library, whether or not it is there.
 *
 * `pathFor` spells the key the way the library would file it -- sanitised for
 * Windows, digest-suffixed on a collision -- so a shipped profile that was
 * never in the library still lands where the library would put it.
 *
 * @param {String} kind `profiles` or `overrides`
 * @param {String} key `manufacturer/model`
 * @returns {String|null} path relative to the library root, or null for a key
 *   that does not fit
 */
function libraryRelative(kind, key) {
  const absolute = library.pathFor(kind, key);
  return absolute ? path.relative(library.libraryRoot(), absolute) : null;
}

/**
 * The first existing file for a library item, in resolution order.
 *
 * What the open document carries, then the user's library -- the order a
 * load resolves in, so that exporting an opened export freezes what it
 * actually shows rather than what this machine's library happens to hold.
 *
 * @param {String} kind `profiles` or `overrides`
 * @param {String} key `manufacturer/model`
 * @param {Boolean} [fromMount] whether the open document's copy counts
 * @returns {String|null} absolute path, or null when neither has it
 */
function libraryFile(kind, key, fromMount = true) {
  const relative = libraryRelative(kind, key);
  if (!relative) return null;
  const mounted = fromMount ? documentstore.mountRoot() : null;
  const candidates = [
    mounted ? path.join(mounted, relative) : null,
    library.pathFor(kind, key),
  ];
  return candidates.find((file) => file && fs.existsSync(file)) || null;
}

/**
 * Collects one fixture profile and its override, if any.
 *
 * The open document, then the user's library, then the shipped set, the
 * order a load resolves in. A shipped profile is wrapped in the library's own
 * file format on the way in, so that the entry carries its key exactly as a
 * library file would and reads back through the same code.
 *
 * @param {String} key `manufacturer/model`
 * @param {Object} entries collected so far, added to
 * @param {Boolean} [fromMount] whether the open document's copy counts
 * @returns {Boolean} whether the profile was found
 */
function collectProfile(key, entries, fromMount = true) {
  const relative = libraryRelative('profiles', key);
  if (!relative) return false;

  const override = libraryFile('overrides', key, fromMount);
  const overrideBytes = override ? bytesOf(override) : null;
  if (overrideBytes) entries[entryFor(libraryRelative('overrides', key))] = overrideBytes;

  const own = libraryFile('profiles', key, fromMount);
  const ownBytes = own ? bytesOf(own) : null;
  if (ownBytes) {
    entries[entryFor(relative)] = ownBytes;
    return true;
  }

  const shipped = `${path.join(shippedFixturesRoot(), ...key.split('/'))}.json`;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(shipped, 'utf8'));
  } catch (err) {
    return false;
  }
  entries[entryFor(relative)] = JSON.stringify({
    format: 1, kind: 'profiles', key, data,
  }, null, 2);
  return true;
}

/**
 * Collects one object: a model with its sidecar and preview, or a shape.
 *
 * Found through the catalogue rather than by spelling a path from the key,
 * because the catalogue already knows which root the object came from,
 * whether the key was matched without regard to case, and whether it is a
 * model or a shape.
 *
 * @param {Object} entry a catalogue entry from `objectstore.list()`
 * @param {Object} entries collected so far, added to
 * @returns {Boolean} whether the object's own file was found
 */
function collectObject(entry, entries) {
  let root = entry.shipped ? objectstore.shippedRoot() : objectstore.objectsRoot();
  if (entry.collected) {
    // Carried by the open document: copied on from where it was unpacked.
    const mounted = documentstore.mountRoot();
    if (!mounted) return false;
    root = path.join(mounted, objectstore.OBJECTS_DIR);
  }
  const dir = entry.folder ? path.join(root, entry.folder) : root;
  const base = path.basename(entry.file, path.extname(entry.file));
  const relativeDir = [objectstore.OBJECTS_DIR, ...(entry.folder ? [entry.folder] : [])];

  const add = (name) => {
    const bytes = bytesOf(path.join(dir, name));
    if (bytes) entries[entryFor(path.join(...relativeDir, name))] = bytes;
    return !!bytes;
  };

  if (!add(entry.file)) return false;
  if (entry.kind === 'model') {
    add(`${base}.json`);
    // Buffers, material libraries and textures the model refers to: a copy
    // without them is a model that does not load, or loads grey.
    objectstore.companionsOf(path.join(dir, entry.file)).forEach(add);
  }
  THUMBNAIL_EXTENSIONS.forEach((extension) => add(`${base}${extension}`));
  return true;
}

/**
 * Everything a show references, as container entries.
 *
 * @public
 * @param {Object} wanted `{ profiles, objects }`, each an array of keys
 * @returns {Object} `{ entries, missing }` -- entry name to bytes, and the keys
 *   that no file could be found for
 */
function collect(wanted) {
  const entries = {};
  const missing = [];
  const profiles = Array.isArray(wanted && wanted.profiles) ? wanted.profiles : [];
  const objects = Array.isArray(wanted && wanted.objects) ? wanted.objects : [];

  [...new Set(profiles)].forEach((key) => {
    if (typeof key !== 'string' || !collectProfile(key, entries)) missing.push(`profile ${key}`);
  });

  if (objects.length) {
    // Folded the way the catalogue folds: a key is a file name, and a file name
    // on Windows can change case without anything looking changed.
    const catalogue = new Map();
    objectstore.list().forEach((entry) => {
      catalogue.set(String(entry.key).toLowerCase(), entry);
      const name = String(entry.name).toLowerCase();
      if (!catalogue.has(name)) catalogue.set(name, entry);
    });
    [...new Set(objects)].forEach((key) => {
      const entry = typeof key === 'string' ? catalogue.get(key.toLowerCase()) : null;
      if (!entry || !collectObject(entry, entries)) missing.push(`object ${key}`);
    });
  }

  if (missing.length) {
    console.warn(`[export] ${missing.length} item(s) referenced but not found: ${missing.join(', ')}`);
  }
  return { entries, missing };
}

/**
 * Writes an export: the show with everything it references collected in.
 *
 * @public
 * @param {String} target absolute path of the document
 * @param {String} json serialised show
 * @param {Object} wanted `{ profiles, objects }`, each an array of keys
 * @returns {Object} `{ ok, collected, missing }` -- whether the file was
 *   written, how many entries went in, and the keys no file was found for
 */
function exportTo(target, json, wanted) {
  const { entries, missing } = collect(wanted);
  const ok = documentstore.write(target, json, entries);
  return { ok, collected: Object.keys(entries).length, missing };
}

/**
 * Saves a document: the show, plus what it carries if it carries anything.
 *
 * A document that carries nothing is an ordinary save and stays one. One that
 * carries files -- an opened export -- is collected again for what the show
 * references now, the carried copy first: an item still in use keeps the copy
 * it was frozen with, an item the show no longer uses is dropped, and one
 * added since comes from the library, so the file stays complete. The mount is
 * replaced with the same set, so a fixture placed after the save does not
 * resolve to a copy the file no longer has.
 *
 * @public
 * @param {String} target absolute path of the document
 * @param {String} json serialised show
 * @param {Object} wanted `{ profiles, objects }`, each an array of keys
 * @returns {Object} `{ ok, carried, profiles, overrides }` -- whether the file
 *   was written, whether it carries files, and the profiles and overrides it
 *   now carries
 */
function saveTo(target, json, wanted) {
  if (!documentstore.mountRoot()) {
    return { ok: documentstore.write(target, json, {}), carried: false };
  }
  const { entries } = collect(wanted);
  const ok = documentstore.write(target, json, entries);
  const now = ok ? documentstore.replaceMounted(entries) : null;
  return { ok, carried: true, ...(now || {}) };
}

/**
 * Whether two sets of entries differ in any name or any byte.
 *
 * @param {Object} a entry name to bytes or text
 * @param {Object} b entry name to bytes or text
 * @returns {Boolean}
 */
function entriesDiffer(a, b) {
  const names = Object.keys(a);
  if (names.length !== Object.keys(b).length) return true;
  return names.some((name) => !(name in b)
    || Buffer.compare(Buffer.from(a[name]), Buffer.from(b[name])) !== 0);
}

/**
 * The carried entries of one kind, by the key each file declares.
 *
 * @param {Object} carried entry name to bytes
 * @param {String} dir `Profiles` or `Overrides`
 * @returns {Map<String, String>} key to entry name
 */
function carriedByKey(carried, dir) {
  const prefix = `${PREFIX}${dir}/`;
  const byKey = new Map();
  Object.keys(carried).filter((name) => name.startsWith(prefix)).forEach((name) => {
    let key = name.slice(prefix.length).replace(/\.json$/i, '');
    try {
      const parsed = JSON.parse(Buffer.from(carried[name]).toString('utf8'));
      if (parsed && typeof parsed.key === 'string') key = parsed.key;
    } catch (err) {
      // Named by its path, as the library reads a file without a key.
    }
    byKey.set(key, name);
  });
  return byKey;
}

/**
 * Catalogue entries by folded key, and by folded name where no key took it.
 *
 * @param {Array<Object>} entries from `objectstore.list()`
 * @returns {Map<String, Object>}
 */
function catalogueIndex(entries) {
  const byKey = new Map();
  entries.forEach((entry) => {
    byKey.set(String(entry.key).toLowerCase(), entry);
    const name = String(entry.name).toLowerCase();
    if (!byKey.has(name)) byKey.set(name, entry);
  });
  return byKey;
}

/**
 * Replaces what the open document carries with this machine's copies.
 *
 * An export is frozen on purpose, and opening one resolves what it carries
 * ahead of the library, so an edit made in the library afterwards never
 * reaches it. This is the deliberate way to let it: every item the show
 * references is collected again as a fresh export would collect it -- the
 * user's library, then the shipped set -- ignoring the carried copy. An item
 * this machine cannot supply keeps its carried copy. A profile's override
 * follows the profile, so one the library no longer has is dropped with it.
 *
 * Only the mount changes. The `.beam` takes the new copies on the next save.
 *
 * @public
 * @param {Object} wanted `{ profiles, objects }`, each an array of keys
 * @returns {Object} `{ carried, refreshed, kept, objects, profiles, overrides }`
 *   -- whether the document carries anything, the items whose copy changed,
 *   the items only the document has, the object keys that changed, and the
 *   profiles and overrides now carried
 */
function refresh(wanted) {
  if (!documentstore.mountRoot()) {
    return {
      carried: false, refreshed: [], kept: [], objects: [],
    };
  }
  const carried = documentstore.mountedEntries();
  const next = { ...carried };
  const refreshed = [];
  const kept = [];
  const objects = [];

  const replace = (label, before, after) => {
    if (!entriesDiffer(before, after)) return false;
    Object.keys(before).forEach((name) => { delete next[name]; });
    Object.assign(next, after);
    refreshed.push(label);
    return true;
  };
  const pick = (names) => Object.fromEntries(names
    .filter((name) => name && name in carried)
    .map((name) => [name, carried[name]]));

  const carriedProfiles = carriedByKey(carried, 'Profiles');
  const carriedOverrides = carriedByKey(carried, 'Overrides');
  const profiles = Array.isArray(wanted && wanted.profiles) ? wanted.profiles : [];
  [...new Set(profiles)].forEach((key) => {
    if (typeof key !== 'string') return;
    const fresh = {};
    if (!collectProfile(key, fresh, false)) {
      if (carriedProfiles.has(key)) kept.push(`profile ${key}`);
      return;
    }
    replace(`profile ${key}`, pick([carriedProfiles.get(key), carriedOverrides.get(key)]), fresh);
  });

  const wantedObjects = Array.isArray(wanted && wanted.objects) ? wanted.objects : [];
  if (wantedObjects.length) {
    // Once without the carried copies and once with, so each key finds both
    // the file this machine could supply and the one the document has.
    const machine = catalogueIndex(objectstore.list({ project: false }));
    const withCarried = catalogueIndex(objectstore.list());
    [...new Set(wantedObjects)].forEach((key) => {
      if (typeof key !== 'string') return;
      const had = withCarried.get(key.toLowerCase());
      const own = had && had.collected ? had : null;
      const available = machine.get(key.toLowerCase());
      if (!available) {
        if (own) kept.push(`object ${key}`);
        return;
      }
      const fresh = {};
      if (!collectObject(available, fresh)) return;
      const before = {};
      if (own) {
        // Everything carried under the object's base name: the model, its
        // sidecar and its preview.
        const dir = [objectstore.OBJECTS_DIR, ...(own.folder ? [own.folder] : [])].join('/');
        const base = path.basename(own.file, path.extname(own.file));
        const stem = `${PREFIX}${dir}/${base}.`.toLowerCase();
        Object.keys(carried)
          .filter((name) => name.toLowerCase().startsWith(stem))
          .forEach((name) => { before[name] = carried[name]; });
      }
      if (replace(`object ${key}`, before, fresh)) objects.push(key);
    });
  }

  const now = refreshed.length ? documentstore.replaceMounted(next) : null;
  return {
    carried: true,
    refreshed,
    kept,
    objects,
    ...(now || {}),
  };
}

export default {
  collect, exportTo, refresh, saveTo,
};
