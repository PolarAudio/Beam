import * as THREE from 'three';
import GOBOS from './gobo_manifest';
import { GOBO_URL, goboLayerFor } from './gobo_pick';

/**
 * @file The gobo patterns every beam can project, in one atlas texture.
 *
 * A gobo is a stencil in the beam. The images are the Open Fixture
 * Library's own, shipped in `public/gobos` and listed in `gobo_manifest.js`;
 * a profile's wheel slot names one as `gobos/<name>`. Any beam reads its
 * gobo by pattern index, in the air and on the surfaces it lands on, from
 * the same texture.
 *
 * A slot that names an image gets it. A slot that names nothing, which is
 * most of them since few profiles reference OFL images at all, gets images
 * by slot order, so every gobo wheel shows something different in each slot.
 *
 * Pattern 0 is fully open and is what an open slot or a fixture without a
 * gobo wheel reads, so the shaders never read the atlas for it.
 *
 * **One rule for every image.** The OFL images come in two conventions:
 * black shapes on a transparent ground, and black on white. Composited over
 * white both read the same way, black the metal and white where light
 * passes, and glass comes out as the grey of its transmission. The images
 * carry no colour into the beam; a coloured glass gobo projects as a grey
 * pattern.
 */

/** Pixels across one pattern in the atlas. */
const GOBO_SIZE = 128;

/**
 * Patterns across and down the atlas: 256 cells, pattern 0 open, the 46 OFL
 * images after it, and the rest for the wheel images GDTF fixtures carry,
 * given out as their types load. At 128 px a cell the atlas is 2048 px
 * square. Must match `GOBO_GRID` in the beam shader and `FIELD_GOBO_GRID`
 * in the light field.
 */
export const GOBO_GRID = 16;

/**
 * The blur each level of the atlas is baked with, as a Gaussian's sigma in
 * the pattern's pixels: level 0 is sharp, the last is a gobo with the focus
 * wound fully out. Baked once, on the CPU, with the canvas's own blur, so a
 * defocused gobo is a true smooth blur: blurring in the shader either showed
 * a coarse mip's texels as blocks or, as a disc of taps, smeared copies.
 *
 * Three, because a stencil is one grey value and the atlas's pixels have
 * three colour channels: level i lives in channel i, so every level shares
 * one square image and one read returns them all.
 */
const GOBO_BLUR_SIGMAS = [0, 2.5, 7];

/** How many blur levels the atlas holds, one per colour channel. */
export const GOBO_BLUR_LEVELS = GOBO_BLUR_SIGMAS.length;

/**
 * The round aperture every image is cut to, as a fraction of its cell's
 * half-width: a little inside the edge, so a disc drawn a hair short of it
 * leaves no ring of light.
 */
const GOBO_APERTURE = 0.96;

let texture = null;
let canvas = null;
/** The sharp patterns, one per cell, from which every blur level is made. */
let sharp = null;
/** Cells given to fixture wheel images, by key, and the next one free. */
const imageCells = new Map();
let nextImageCell = GOBOS.length + 1;

/**
 * Where the image's metal disc sits, as a box in fractions of the image:
 * the bounds of its dark pixels. Several images draw the disc short of
 * their edge on a white ground, and not always centred, so the margin
 * differs side to side. For an image dark to its edges, or whose dark
 * pixels are a pattern rather than a disc (a margin over 8% on any side, or
 * a box far from square), the whole image.
 *
 * @param {HTMLImageElement} image
 * @returns {Object} `{ x, y, w, h }` in fractions of the image
 */
function discBox(image) {
  const size = 256;
  const probe = document.createElement('canvas');
  probe.width = size;
  probe.height = size;
  const p = probe.getContext('2d');
  p.fillStyle = '#fff';
  p.fillRect(0, 0, size, size);
  p.drawImage(image, 0, 0, size, size);
  const px = p.getImageData(0, 0, size, size).data;
  let minX = size; let minY = size; let maxX = -1; let maxY = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (px[(y * size + x) * 4] < 64) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const whole = {
    x: 0, y: 0, w: 1, h: 1,
  };
  if (maxX < 0) return whole;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const margin = Math.max(minX, minY, size - 1 - maxX, size - 1 - maxY) / size;
  if (margin > 0.08 || Math.abs(w - h) > size * 0.03) return whole;
  return {
    x: minX / size, y: minY / size, w: w / size, h: h / size,
  };
}

/** A cell's top-left corner in the atlas, in pixels. */
function cellOrigin(index) {
  return [(index % GOBO_GRID) * GOBO_SIZE, Math.floor(index / GOBO_GRID) * GOBO_SIZE];
}

/**
 * Draws one image into its cell of the sharp canvas.
 *
 * Two conventions: an OFL image is black metal on white or on nothing, so it
 * goes over white, refitted so its metal disc fills the cell; a GDTF image is
 * white light on black or on nothing and is already the whole aperture, so
 * it goes over black as it is. Either way nothing passes outside the round
 * aperture.
 *
 * @param {Number} index cell
 * @param {HTMLImageElement} image
 * @param {Boolean} lightOnDark whether white is light, as GDTF draws it
 */
function drawCell(index, image, lightOnDark) {
  const s = sharp.getContext('2d');
  const [x, y] = cellOrigin(index);
  // A proper downscale: the images are up to 1024 px, and the default
  // filter samples a few source pixels per cell pixel, which drew round dots
  // as ragged polygons.
  s.imageSmoothingEnabled = true;
  s.imageSmoothingQuality = 'high';
  s.save();
  s.beginPath();
  s.rect(x, y, GOBO_SIZE, GOBO_SIZE);
  s.clip();
  s.fillStyle = lightOnDark ? '#000' : '#fff';
  s.fillRect(x, y, GOBO_SIZE, GOBO_SIZE);
  if (lightOnDark) {
    s.drawImage(image, x, y, GOBO_SIZE, GOBO_SIZE);
  } else {
    // Placed so the metal disc fills the cell, centred. Several images draw
    // the disc short of their edge and off centre, and that margin passed
    // light as a thin crescent round the pool that turned with the gobo.
    const box = discBox(image);
    const scaleX = GOBO_SIZE / box.w;
    const scaleY = GOBO_SIZE / box.h;
    s.drawImage(image, x - box.x * scaleX, y - box.y * scaleY, scaleX, scaleY);
  }
  // Nothing passes outside the round aperture, whatever the image has
  // there: white corners, and any sliver of ground between a disc drawn a
  // hair short and the edge, otherwise showed as a faint ring round the
  // pool, worse once the focus blur spread the corners inwards.
  const centre = GOBO_SIZE / 2;
  s.fillStyle = '#000';
  s.beginPath();
  s.rect(x, y, GOBO_SIZE, GOBO_SIZE);
  s.arc(x + centre, y + centre, centre * GOBO_APERTURE, 0, Math.PI * 2);
  s.fill('evenodd');
  s.restore();
}

/**
 * Packs cells of the sharp canvas and their blurred copies into the atlas:
 * red sharp, green and blue blurred. Each cell is blurred inside its own
 * clip, so a blur never pulls a neighbouring pattern into it, and only the
 * cells asked for are redone, so a fixture type loading later costs its own
 * cells and no more.
 *
 * @param {Array<Number>} cells
 */
function packCells(cells) {
  const work = document.createElement('canvas');
  work.width = GOBO_SIZE;
  work.height = GOBO_SIZE;
  const w = work.getContext('2d', { willReadFrequently: true });
  const c = canvas.getContext('2d');
  cells.forEach((index) => {
    const [x, y] = cellOrigin(index);
    const packed = c.createImageData(GOBO_SIZE, GOBO_SIZE);
    GOBO_BLUR_SIGMAS.forEach((sigma, level) => {
      w.filter = 'none';
      w.fillStyle = '#000';
      w.fillRect(0, 0, GOBO_SIZE, GOBO_SIZE);
      w.filter = sigma > 0 ? `blur(${sigma}px)` : 'none';
      w.drawImage(sharp, x, y, GOBO_SIZE, GOBO_SIZE, 0, 0, GOBO_SIZE, GOBO_SIZE);
      const pixels = w.getImageData(0, 0, GOBO_SIZE, GOBO_SIZE).data;
      // Luminance, so a glass gobo passes its grey whatever its tint.
      for (let i = 0; i < pixels.length; i += 4) {
        packed.data[i + level] = 0.3 * pixels[i] + 0.59 * pixels[i + 1] + 0.11 * pixels[i + 2];
      }
    });
    for (let i = 3; i < packed.data.length; i += 4) packed.data[i] = 255;
    c.putImageData(packed, x, y);
  });
  if (texture) texture.needsUpdate = true;
}

/**
 * Loads one image, resolving to null if it cannot be read, so one bad file
 * leaves one dark cell rather than no gobos at all.
 *
 * @param {String} file
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
      console.warn(`[gobo] could not load ${url}`);
      resolve(null);
    };
    image.src = url;
  });
}

/**
 * The gobo atlas, built once. Returned at once with only the open pattern
 * in it; the OFL images load in the background and the texture is redrawn
 * when they are in, so nothing waits on them.
 *
 * @returns {THREE.CanvasTexture} one blur level per colour channel, 255 open
 */
export function goboTexture() {
  if (texture) return texture;
  const size = GOBO_SIZE * GOBO_GRID;
  canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  // Every cell metal, but the open one.
  sharp = document.createElement('canvas');
  sharp.width = size;
  sharp.height = size;
  const s = sharp.getContext('2d');
  s.fillStyle = '#000';
  s.fillRect(0, 0, size, size);
  s.fillStyle = '#fff';
  s.fillRect(0, 0, GOBO_SIZE, GOBO_SIZE);
  // A metal cell is black at every blur level, so only the open one needs
  // packing; the rest of the atlas starts black.
  const a = canvas.getContext('2d');
  a.fillStyle = '#000';
  a.fillRect(0, 0, size, size);
  packCells([0]);
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
  Promise.all(GOBOS.map((g) => loadImage(GOBO_URL + g.file))).then((images) => {
    const drawn = [];
    images.forEach((image, i) => {
      if (!image) return;
      drawCell(i + 1, image, false);
      drawn.push(i + 1);
    });
    packCells(drawn);
  });
  return texture;
}

/**
 * The cell a fixture's own wheel image is drawn in, given out the first time
 * it is asked for and drawn when the image has loaded. Fixtures of one type
 * ask with the same key and share the cell.
 *
 * @param {String} key unique to the fixture type and the image
 * @param {String} url where the image can be loaded from
 * @returns {Number} the cell, or 0 (open) once the atlas is full
 */
export function goboImageCell(key, url) {
  if (imageCells.has(key)) return imageCells.get(key);
  goboTexture();
  if (nextImageCell >= GOBO_GRID * GOBO_GRID) {
    // eslint-disable-next-line no-console
    console.warn(`[gobo] atlas full, ${key} not drawn`);
    imageCells.set(key, 0);
    return 0;
  }
  const index = nextImageCell;
  nextImageCell += 1;
  imageCells.set(key, index);
  loadImage(url).then((image) => {
    if (!image) return;
    drawCell(index, image, true);
    packCells([index]);
  });
  return index;
}

/** Which pattern a wheel slot shows; the rule lives in `gobo_pick.js`. */
export { goboLayerFor };
