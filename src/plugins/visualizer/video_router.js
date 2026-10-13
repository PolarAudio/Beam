import VideoFeed from './video_feed';
import Preferences from './preferences';

/**
 * @file Which feed fills each video input, and which inputs are in use.
 *
 * An input is show data (`models/DMX/video_input.js`); a device names one by
 * id. This module turns an input into a running feed: a file input opens its
 * file, an NDI input opens the sender this machine has bound to it. The
 * binding is a preference keyed by the input's `uid`, because a sender's name
 * means nothing on another computer.
 *
 * **A feed is open only while a device uses its input.** Devices say which
 * input they show with `use` and let go with `drop`, and the feed opens on the
 * first user and closes after the last. A feed is a network receiver or a
 * playing video, so an input nobody shows costs nothing.
 */

/** Preference key: input uid to NDI sender name. */
const BINDINGS_KEY = 'videoBindings';

/** The show's input lookup, installed by the show: id to input. */
let resolver = () => null;
/** Every input in the show, installed by the show. */
let lister = () => [];

/** Device to the input id it shows. */
const users = new Map();
/** Input uid to `{ name, feed, pending }`. */
const open = new Map();

let generation = 0;
const listeners = new Set();
let announcing = false;

/**
 * Tells listeners the feeds changed, once per turn of the event loop.
 *
 * Deferred because a listener redraws devices, and a device redrawing calls
 * `use`, which can change the feeds again: done in place, that is re-entry.
 */
function announce() {
  generation += 1;
  if (announcing) return;
  announcing = true;
  queueMicrotask(() => {
    announcing = false;
    listeners.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        // A listener that throws must not stop the others hearing about it.
        // eslint-disable-next-line no-console
        console.error('[video] router listener failed', err);
      }
    });
  });
}

/** This machine's sender for an input, or empty. */
function binding(uid) {
  const bindings = Preferences.get(BINDINGS_KEY) || {};
  return bindings[uid] || '';
}

/** The feed name an input should have open now. */
function feedNameOf(input) {
  return input.feedName(binding(input.uid));
}

/** Closes an input's feed and forgets it. */
function close(uid) {
  const entry = open.get(uid);
  open.delete(uid);
  if (entry && entry.feed) entry.feed.close();
}

/**
 * Opens the feed an input should have, replacing one opened for an older
 * binding or file.
 *
 * @param {Object} input VideoInput
 */
async function ensure(input) {
  const name = feedNameOf(input);
  const entry = open.get(input.uid);
  if (entry && entry.name === name) return;
  if (entry) close(input.uid);
  if (!name) {
    announce();
    return;
  }
  const slot = { name, feed: null, pending: true };
  open.set(input.uid, slot);
  let feed = null;
  try {
    feed = await VideoFeed.open(name);
  } catch (err) {
    feed = null;
  }
  // Superseded while it opened: a rebinding or the last user leaving.
  if (open.get(input.uid) !== slot) {
    if (feed) feed.close();
    return;
  }
  slot.feed = feed;
  slot.pending = false;
  announce();
}

/** Opens what is used and closes what is not. */
function reconcile() {
  const needed = new Map();
  users.forEach((id) => {
    const input = resolver(id);
    if (input) needed.set(input.uid, input);
  });
  let closed = false;
  [...open.keys()].forEach((uid) => {
    if (!needed.has(uid)) {
      close(uid);
      closed = true;
    }
  });
  needed.forEach((input) => { ensure(input); });
  if (closed) announce();
}

export default {
  /**
   * Installs the show's inputs. Called by the show.
   *
   * @public
   * @param {Function} find (id) => VideoInput or null
   * @param {Function} all () => every VideoInput
   */
  resolveWith(find, all) {
    resolver = find || (() => null);
    lister = all || (() => []);
  },

  /**
   * The input behind an id, or null.
   *
   * @public
   * @param {*} id
   * @returns {Object|null}
   */
  input(id) {
    if (id === null || id === undefined) return null;
    return resolver(id);
  },

  /** @public @returns {Array} every input in the show */
  inputs() {
    return lister() || [];
  },

  /**
   * Says which input a device shows, or none.
   *
   * @public
   * @param {Object} owner the device's renderer
   * @param {*} id input id, or null
   */
  use(owner, id) {
    const next = id === undefined ? null : id;
    if (next === null) {
      if (!users.has(owner)) return;
      users.delete(owner);
    } else {
      if (users.get(owner) === next) return;
      users.set(owner, next);
    }
    reconcile();
  },

  /**
   * Forgets a device, as it is disposed.
   *
   * @public
   * @param {Object} owner
   */
  drop(owner) {
    this.use(owner, null);
  },

  /**
   * The open feed for an input, or null while it opens, is unbound or unused.
   *
   * @public
   * @param {*} id input id
   * @returns {Object|null}
   */
  feedFor(id) {
    const input = this.input(id);
    if (!input) return null;
    const entry = open.get(input.uid);
    return entry ? entry.feed : null;
  },

  /**
   * What an input is doing, for a list that says so.
   *
   * @public
   * @param {Object} input VideoInput
   * @returns {String} `live`, `waiting`, `unbound`, `missing` or `unused`
   */
  statusOf(input) {
    if (!input) return 'missing';
    const name = feedNameOf(input);
    if (!name) return 'unbound';
    const entry = open.get(input.uid);
    if (!entry) return 'unused';
    if (entry.pending) return 'waiting';
    if (!entry.feed) return 'missing';
    return entry.feed.width ? 'live' : 'waiting';
  },

  /**
   * The devices showing an input.
   *
   * @public
   * @param {*} id input id
   * @returns {Array} the owners
   */
  usersOf(id) {
    return [...users.entries()].filter(([, used]) => used === id).map(([owner]) => owner);
  },

  /**
   * This machine's sender for an NDI input.
   *
   * @public
   * @param {String} uid
   * @returns {String}
   */
  binding(uid) {
    return binding(uid);
  },

  /**
   * Binds an NDI input to a sender on this machine, or unbinds it.
   *
   * @public
   * @param {String} uid
   * @param {String} sender
   */
  bind(uid, sender) {
    const bindings = { ...(Preferences.get(BINDINGS_KEY) || {}) };
    if (sender) bindings[uid] = sender;
    else delete bindings[uid];
    Preferences.set(BINDINGS_KEY, bindings);
    this.refresh();
  },

  /**
   * Re-reads every input: after a show loads, an input is edited, added or
   * removed, or a binding changes.
   *
   * @public
   */
  refresh() {
    reconcile();
    open.forEach((entry, uid) => {
      const input = (lister() || []).find((candidate) => candidate.uid === uid);
      if (input) ensure(input);
    });
    announce();
  },

  /**
   * Changes as feeds open and close, so a renderer can tell a rebuild is due.
   *
   * @public
   * @returns {Number}
   */
  generation() {
    return generation;
  },

  /**
   * @public
   * @param {Function} fn called whenever a feed opens, closes or changes
   * @returns {Function} call it to stop listening
   */
  listen(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
