import { readIlda, frameAt } from '@/models/DMX/ilda';
import { CLIP_KINDS, patternFrames } from '@/models/DMX/laser_clips';

/**
 * @file Turns a laser's current clip into the frame the beam is built from.
 *
 * Generated patterns are built once and kept. ILDA files are fetched by URL
 * from the library, read once and kept by file name; the first frames after a
 * clip is chosen draw nothing while the file loads. The file list comes from
 * the main process and is asked again when a name is not on it, so a file
 * added from another laser's panel is found.
 *
 * A clip plays each frame once at its point rate and loops, so an animation
 * runs at the speed it would on a laser scanning at that rate.
 */

/** Seconds between asking again for a file list that lacked a name. */
const RELIST_SECONDS = 2;

/** File name to `{ state, frames, error }`, state `loading`, `ready` or `error`. */
const files = new Map();

/** Pattern key to its frames. */
const patterns = new Map();

/** File name to URL, from the last list. */
let urls = new Map();
let listing = null;
let listedAt = -Infinity;

/** Asks the main process which files exist, at most every RELIST_SECONDS. */
function relist() {
  const now = performance.now() / 1000;
  if (listing || now - listedAt < RELIST_SECONDS) return;
  const library = typeof window !== 'undefined' ? window.library : null;
  if (!library || !library.laserClips) return;
  listedAt = now;
  listing = Promise.resolve(library.laserClips())
    .then((list) => {
      urls = new Map((list || []).map((entry) => [entry.key.toLowerCase(), entry.url]));
    })
    .catch(() => {})
    .finally(() => { listing = null; });
}

/** Starts reading a file, once its URL is known. */
function load(file) {
  const url = urls.get(file.toLowerCase());
  if (!url) {
    relist();
    return;
  }
  const entry = { state: 'loading', frames: null, error: null };
  files.set(file, entry);
  fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`${file} could not be read (${response.status})`);
      return response.arrayBuffer();
    })
    .then((buffer) => {
      const { frames } = readIlda(buffer);
      if (!frames.length) throw new Error(`${file} holds no frames`);
      entry.frames = frames;
      entry.state = 'ready';
    })
    .catch((err) => {
      entry.state = 'error';
      entry.error = err.message;
    });
}

/**
 * The frames of a clip, or null while they are not available.
 *
 * @param {Object} clip
 * @returns {Array|null}
 */
function framesOf(clip) {
  if (!clip) return null;
  if (clip.kind === CLIP_KINDS.PATTERN) {
    if (!patterns.has(clip.pattern)) patterns.set(clip.pattern, patternFrames(clip.pattern));
    return patterns.get(clip.pattern);
  }
  const entry = files.get(clip.file);
  if (!entry) {
    load(clip.file);
    return null;
  }
  return entry.state === 'ready' ? entry.frames : null;
}

/**
 * The frame a clip shows at a time, in the DAC layout.
 *
 * @public
 * @param {Object|null} clip
 * @param {Number} seconds the scene clock
 * @param {Number} fallbackRate points per second when the clip names none
 * @returns {Object|null} `{ count, points, frame, frames }`
 */
export function clipFrame(clip, seconds, fallbackRate) {
  const frames = framesOf(clip);
  if (!frames || !frames.length) return null;
  const rate = clip.rate || fallbackRate;
  const index = frameAt(frames, seconds, rate);
  const frame = frames[index];
  return {
    count: frame.count, points: frame.points, frame: index, frames: frames.length,
  };
}

/**
 * How a clip is doing, for the panel.
 *
 * @public
 * @param {Object|null} clip
 * @returns {Object} `{ state, error, frames }`, state `none`, `loading`,
 *   `missing`, `error` or `ready`
 */
export function clipStatus(clip) {
  if (!clip) return { state: 'none', error: null, frames: 0 };
  if (clip.kind === CLIP_KINDS.PATTERN) {
    const frames = framesOf(clip);
    return { state: frames ? 'ready' : 'missing', error: null, frames: frames ? frames.length : 0 };
  }
  const entry = files.get(clip.file);
  if (!entry) {
    framesOf(clip);
    return { state: urls.size && !urls.has(clip.file.toLowerCase()) ? 'missing' : 'loading', error: null, frames: 0 };
  }
  return {
    state: entry.state, error: entry.error, frames: entry.frames ? entry.frames.length : 0,
  };
}

/**
 * Forgets the file list, so the next lookup asks again; called after files
 * are added.
 *
 * @public
 */
export function relistClipFiles() {
  listedAt = -Infinity;
  relist();
}
