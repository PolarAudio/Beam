import * as THREE from 'three';
import GOBOS from './gobo_manifest';
import { GOBO_URL, goboImageFor } from './gobo_pick';
import BakeWorker from './gobo_bake.worker?worker';

/**
 * @file The gobo patterns every beam can project, in one atlas texture.
 *
 * A gobo is a stencil in the beam. Any beam reads its gobo by cell index, in
 * the air and on the surfaces it lands on, from the same texture.
 *
 * The atlas is a cache of the images lights show, not a store of every image
 * a project has. Each light holds the images in its beam (`holdGobos`); an
 * image takes a cell when it is first held and keeps it while any light holds
 * it. A cell no light holds is reused, the least recently held first, when
 * another image needs room. So the limit is how many different images are in
 * beams at one moment, not how many the project's fixtures carry.
 *
 * Drawing an image into a cell (its sharp pattern and two blurred copies)
 * runs in a worker, `gobo_bake.worker.js`, so a gobo coming into use never
 * stalls a frame; until its cell is drawn it reads open. A fixture's wheel
 * images are warmed when its wheels are set: loaded, and drawn into cells
 * nobody needs. A changed cell is uploaded on its own, not the whole texture.
 *
 * An OFL slot that names an image gets it. One that names nothing, which is
 * most of them since few profiles reference OFL images at all, gets an image
 * by slot order (`gobo_pick.js`), so every gobo wheel shows something
 * different in each slot.
 *
 * Cell 0 is fully open and is what an open slot or a fixture without a gobo
 * wheel reads, so the shaders never read the atlas for it.
 *
 * **One rule for every image.** The OFL images come in two conventions:
 * black shapes on a transparent ground, and black on white. Composited over
 * white both read the same way, black the metal and white where light
 * passes, and glass comes out as the grey of its transmission. The images
 * carry no colour into the beam; a coloured glass gobo projects as a grey
 * pattern.
 */

/** Pixels across one pattern in the atlas. */
const GOBO_SIZE = 256;

/**
 * Patterns across and down the atlas: 64 cells, cell 0 open and the rest
 * the cache. At 256 px a cell the atlas is 2048 px square, 16 MB on the GPU
 * before mipmaps. Must match `GOBO_GRID` in the beam shader and
 * `FIELD_GOBO_GRID` in the light field.
 */
export const GOBO_GRID = 8;

/** Cells in the atlas, the open one included. */
const CELLS = GOBO_GRID * GOBO_GRID;

/**
 * The blur each level of the atlas is baked with, as a Gaussian's sigma in
 * the pattern's pixels: level 0 is sharp, the last is a gobo with the focus
 * wound fully out. Baked on the CPU, with the canvas's own blur, so a
 * defocused gobo is a true smooth blur: blurring in the shader either showed
 * a coarse mip's texels as blocks or, as a disc of taps, smeared copies.
 *
 * Three, because a stencil is one grey value and the atlas's pixels have
 * three colour channels: level i lives in channel i, so every level shares
 * one square image and one read returns them all.
 */
const GOBO_BLUR_SIGMAS = [0, 5, 14];

/** How many blur levels the atlas holds, one per colour channel. */
export const GOBO_BLUR_LEVELS = GOBO_BLUR_SIGMAS.length;

/**
 * The round aperture every image is cut to, as a fraction of its cell's
 * half-width: a little inside the edge, so a disc drawn a hair short of it
 * leaves no ring of light.
 */
const GOBO_APERTURE = 0.96;

let texture = null;
/** The atlas as drawn, kept so a full upload of the texture is still right. */
let canvas = null;
let worker = null;

/**
 * Every image asked for, by key: `{ url, lightOnDark, image, failed, cell,
 * ready, bake, holds, used, warm }`. `cell` is 0 when it has none and `ready`
 * whether the cell has been drawn; `bake` numbers the drawing asked for, so
 * a late answer for a cell given away since is dropped. `holds` counts the
 * light references keeping it, `used` when it was last held.
 */
const entries = new Map();
/** The entry in each cell, by cell; null for a free one. */
const cellEntries = new Array(CELLS).fill(null);
/** Counts holds, so the least recently held free cell can be told. */
let clock = 0;
/** Numbers the bakes. */
let bakes = 0;
/** Bakes sent to the worker, by number: the entry it is for. */
const baking = new Map();
/** Cells drawn since the last upload: `{ index, pixels }`. */
const pending = [];
/** Called when a held image has been drawn and lights should read again. */
const drawnListeners = new Set();
let warnedFull = false;

/** A cell's top-left corner in the atlas, in pixels. */
function cellOrigin(index) {
  return [(index % GOBO_GRID) * GOBO_SIZE, Math.floor(index / GOBO_GRID) * GOBO_SIZE];
}

/**
 * Loads one image, resolving to null if it cannot be read, so one bad file
 * leaves one open slot rather than no gobos at all.
 *
 * @param {String} url
 * @returns {Promise<HTMLImageElement|null>}
 */
function loadImage(url) {
  return new Promise((resolve) => {
    const image = new Image();
    // Cross-origin in the installed app, which serves these over static://:
    // without CORS the canvas is tainted and reading its pixels back throws.
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => {
      // eslint-disable-next-line no-console
      console.warn(`[gobo] could not load ${url}`);
      resolve(null);
    };
    image.src = url;
  });
}

/**
 * A baked cell back from the worker: drawn into the atlas and queued for
 * upload, unless the cell has gone to another image since it was asked for.
 */
function onBaked({ data }) {
  const entry = baking.get(data.id);
  baking.delete(data.id);
  if (!entry || entry.bake !== data.id || !entry.cell) return;
  const [x, y] = cellOrigin(entry.cell);
  const pixels = new Uint8ClampedArray(data.pixels.buffer);
  canvas.getContext('2d').putImageData(new ImageData(pixels, GOBO_SIZE, GOBO_SIZE), x, y);
  pending.push({ index: entry.cell, pixels: new Uint8Array(data.pixels.buffer) });
  entry.ready = true;
  if (entry.holds > 0) drawnListeners.forEach((listener) => listener());
}

/**
 * The gobo atlas, built once with only the open pattern in it; the cache
 * fills it as lights ask for images.
 *
 * @returns {THREE.CanvasTexture} one blur level per colour channel, 255 open
 */
export function goboTexture() {
  if (texture) return texture;
  const size = GOBO_SIZE * GOBO_GRID;
  canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  // Every cell metal until something is drawn in it, and the open cell open
  // at every blur level.
  const a = canvas.getContext('2d');
  a.fillStyle = '#000';
  a.fillRect(0, 0, size, size);
  a.fillStyle = '#fff';
  a.fillRect(0, 0, GOBO_SIZE, GOBO_SIZE);
  worker = new BakeWorker();
  worker.onmessage = onBaked;
  texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  // The air reads the pattern averaged along a ray's stretch and sharp
  // across it; three clamps this to what the GPU supports.
  texture.anisotropy = 16;
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Uploads the cells drawn since the last call, each on its own, and makes
 * the mipmaps again once. Called once a frame, before drawing.
 *
 * @param {THREE.WebGLRenderer} renderer
 */
export function flushGoboCells(renderer) {
  if (!texture || !pending.length || !renderer) return;
  const at = new THREE.Vector2();
  const cells = pending.splice(0, pending.length);
  cells.forEach(({ index, pixels }, i) => {
    const source = new THREE.DataTexture(pixels, GOBO_SIZE, GOBO_SIZE);
    source.flipY = false;
    source.needsUpdate = true;
    const [x, y] = cellOrigin(index);
    at.set(x, y);
    // Mipmaps once, after the last cell.
    texture.generateMipmaps = i === cells.length - 1;
    renderer.copyTextureToTexture(source, texture, null, at);
    source.dispose();
  });
  texture.generateMipmaps = true;
}

/**
 * A free cell for an image: one never used, else the one held least
 * recently that no light holds now. 0 when every cell is held.
 *
 * @returns {Number}
 */
function freeCell() {
  let best = 0;
  let bestUsed = Infinity;
  for (let i = 1; i < CELLS; i += 1) {
    const entry = cellEntries[i];
    if (!entry) return i;
    if (entry.holds === 0 && entry.used < bestUsed) {
      best = i;
      bestUsed = entry.used;
    }
  }
  return best;
}

/**
 * Gives a loaded image a cell, taking it from whatever image had it, and
 * asks the worker to draw it there.
 *
 * @param {Object} entry
 * @param {Boolean} evict whether an image no light holds may lose its cell;
 *   warming only takes cells never used
 */
function place(entry, evict) {
  if (entry.cell || !entry.image) return;
  goboTexture();
  const index = freeCell();
  if (!index || (!evict && cellEntries[index])) {
    if (!index && !warnedFull) {
      warnedFull = true;
      // eslint-disable-next-line no-console
      console.warn('[gobo] every atlas cell is in a beam; further gobos read open');
    }
    return;
  }
  const was = cellEntries[index];
  if (was) {
    was.cell = 0;
    was.ready = false;
  }
  cellEntries[index] = entry;
  entry.cell = index;
  entry.ready = false;
  bakes += 1;
  const id = bakes;
  entry.bake = id;
  baking.set(id, entry);
  createImageBitmap(entry.image).then((bitmap) => {
    worker.postMessage({
      id,
      bitmap,
      lightOnDark: entry.lightOnDark,
      size: GOBO_SIZE,
      sigmas: GOBO_BLUR_SIGMAS,
      aperture: GOBO_APERTURE,
    }, [bitmap]);
  }, () => baking.delete(id));
}

/**
 * The entry for an image, made and its loading started the first time.
 *
 * @param {Object} source `{ key, url, lightOnDark }`
 * @returns {Object}
 */
function entryFor(source) {
  let entry = entries.get(source.key);
  if (entry) return entry;
  entry = {
    url: source.url,
    lightOnDark: source.lightOnDark,
    image: null,
    failed: false,
    cell: 0,
    ready: false,
    bake: 0,
    holds: 0,
    used: 0,
    warm: false,
  };
  entries.set(source.key, entry);
  loadImage(source.url).then((image) => {
    if (!image) {
      entry.failed = true;
      return;
    }
    entry.image = image;
    if (entry.holds > 0) place(entry, true);
    else if (entry.warm) place(entry, false);
  });
  return entry;
}

/**
 * What a wheel slot shows, as the cache keys it: `{ key, url, lightOnDark }`,
 * or null for an open or non-gobo slot.
 *
 * @param {Object} wheel `{ slots }`
 * @param {Number} index slot index
 * @returns {Object|null}
 */
export function goboSourceAt(wheel, index) {
  const slot = wheel.slots[index];
  if (!slot || slot.type !== 'Gobo') return null;
  // A fixture that carries its own picture of the gobo draws that one.
  if (slot.image) return { key: slot.image.key, url: slot.image.url, lightOnDark: true };
  const goboIndex = wheel.slots.slice(0, index).filter((s) => s && s.type === 'Gobo').length;
  const pick = goboImageFor(slot, goboIndex);
  const gobo = pick && GOBOS[pick.image];
  return gobo ? { key: `ofl/${gobo.name}`, url: GOBO_URL + gobo.file, lightOnDark: false } : null;
}

/**
 * Lets go of images a light held, as when it is deleted.
 *
 * @param {Array<String>} keys
 */
export function releaseGobos(keys) {
  (keys || []).forEach((key) => {
    const entry = entries.get(key);
    if (entry && entry.holds > 0) entry.holds -= 1;
  });
}

/**
 * Holds the images a light's beam now shows and lets go of those it showed
 * before, and gives their cells.
 *
 * @param {Array<String>} previous keys the light held, as last returned
 * @param {Array<Object|null>} sources what each place in the beam shows
 * @returns {Object} `{ held, cells }`: the keys to pass next time, and a
 *   cell per source, 0 for open or not yet drawn
 */
export function holdGobos(previous, sources) {
  clock += 1;
  const held = [];
  const cells = sources.map((source) => {
    if (!source) return 0;
    const entry = entryFor(source);
    entry.holds += 1;
    entry.used = clock;
    held.push(source.key);
    place(entry, true);
    return entry.ready ? entry.cell : 0;
  });
  releaseGobos(previous);
  return { held, cells };
}

/**
 * Loads a fixture's wheel images ahead of use, drawing each into a cell no
 * image has used yet, so the first time a wheel reaches one it is there.
 *
 * @param {Array<Object>} sources `{ key, url, lightOnDark }`
 */
export function warmGobos(sources) {
  sources.forEach((source) => {
    if (!source) return;
    const entry = entryFor(source);
    entry.warm = true;
    place(entry, false);
  });
}

/**
 * How full the cache is, for diagnostics: cells in use (the open one not
 * counted), of those how many some light holds and how many are drawn,
 * images known, and bakes in the worker.
 *
 * @returns {Object} `{ cells, held, drawn, images, free, baking }`
 */
export function goboCacheState() {
  const used = cellEntries.slice(1).filter(Boolean);
  return {
    cells: used.length,
    held: used.filter((entry) => entry.holds > 0).length,
    drawn: used.filter((entry) => entry.ready).length,
    images: entries.size,
    free: CELLS - 1 - used.length,
    baking: baking.size,
  };
}

/**
 * Calls back when an image a light holds has been drawn, so lights that
 * read it as open can read it again.
 *
 * @param {Function} listener
 */
export function onGoboDrawn(listener) {
  drawnListeners.add(listener);
}
