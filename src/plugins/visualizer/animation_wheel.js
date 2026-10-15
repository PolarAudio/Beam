import * as THREE from 'three';

/**
 * @file Animation wheels: a patterned disc slid part way into the beam at
 * the gate, turning on its own centre, so its pattern moves across the gobo.
 *
 * GDTF describes the part of the disc the gate sees: a circle of `Radius`
 * whose centre travels along a spline through P1, P2 and P3 as the disc goes
 * in, in the disc image's own coordinates -- its middle at 0, its edges at
 * -1 and 1, y up. The disc turns about the image's middle.
 *
 * Every renderer reads a light's disc from one row of a table: texel 0 is
 * (atlas cell + 1, 0 for none; the disc's angle in radians; the window's
 * centre x, y), texel 1 is (the window's radius, 0, 0, 0). The discs' images
 * are drawn into their own atlas, larger than the gobo atlas's cells
 * because the gate sees only a part of the disc, with the same three baked
 * blur levels in red, green and blue.
 */

/** Cells across the atlas, and their size in pixels. */
const ANIMATION_GRID = 4;
const ANIMATION_CELL = 512;

/**
 * Blur levels baked per cell, sharp to soft, in pixels: the gobo atlas's
 * levels (0, 2.5 and 7 px of a 64 px field radius) at the field radius the
 * usual window gives, 0.35 of the disc's half width, 90 px here.
 */
const ANIMATION_BLUR_SIGMAS = [0, 3.5, 10];

/** Rows in the table: one per light, as many as the renderer allows. */
const ROWS = 4096;
const TEXELS = 2;

/**
 * The window and its path for a disc whose file gives no AnimationSystem:
 * the values GDTF Builder writes for Martin's discs, a third of the disc's
 * half width travelling from the image's corner to a point inside the disc.
 */
export const DEFAULT_ANIMATION_SYSTEM = {
  p1: [1, 1],
  p2: [0, 0.6],
  p3: [-0.6, 0],
  radius: 0.35,
};

let canvas = null;
let texture = null;
const cells = new Map();

const data = new Float32Array(ROWS * TEXELS * 4);
const table = new THREE.DataTexture(data, TEXELS, ROWS, THREE.RGBAFormat, THREE.FloatType);
table.magFilter = THREE.NearestFilter;
table.minFilter = THREE.NearestFilter;
table.needsUpdate = true;

/** Loads one image, resolving to null when it cannot be read. */
function loadImage(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => {
      // eslint-disable-next-line no-console
      console.warn(`[animation] could not load ${url}`);
      resolve(null);
    };
    image.src = url;
  });
}

/**
 * Draws a disc image into its cell: the whole image over white, so whatever
 * the image leaves transparent round the disc passes light, then its
 * luminance at each blur level into red, green and blue.
 */
function drawDisc(index, image) {
  const x = (index % ANIMATION_GRID) * ANIMATION_CELL;
  const y = Math.floor(index / ANIMATION_GRID) * ANIMATION_CELL;
  const sharp = document.createElement('canvas');
  sharp.width = ANIMATION_CELL;
  sharp.height = ANIMATION_CELL;
  const s = sharp.getContext('2d');
  s.fillStyle = '#fff';
  s.fillRect(0, 0, ANIMATION_CELL, ANIMATION_CELL);
  s.imageSmoothingEnabled = true;
  s.imageSmoothingQuality = 'high';
  // Stretched to the cell: the path is in the image's own coordinates,
  // -1 to 1 along each side whatever its proportions.
  s.drawImage(image, 0, 0, ANIMATION_CELL, ANIMATION_CELL);

  const work = document.createElement('canvas');
  work.width = ANIMATION_CELL;
  work.height = ANIMATION_CELL;
  const w = work.getContext('2d', { willReadFrequently: true });
  const c = canvas.getContext('2d');
  const packed = c.createImageData(ANIMATION_CELL, ANIMATION_CELL);
  ANIMATION_BLUR_SIGMAS.forEach((sigma, level) => {
    w.filter = 'none';
    w.fillStyle = '#fff';
    w.fillRect(0, 0, ANIMATION_CELL, ANIMATION_CELL);
    w.filter = sigma > 0 ? `blur(${sigma}px)` : 'none';
    w.drawImage(sharp, 0, 0);
    const pixels = w.getImageData(0, 0, ANIMATION_CELL, ANIMATION_CELL).data;
    for (let i = 0; i < pixels.length; i += 4) {
      packed.data[i + level] = 0.3 * pixels[i] + 0.59 * pixels[i + 1] + 0.11 * pixels[i + 2];
    }
  });
  for (let i = 3; i < packed.data.length; i += 4) packed.data[i] = 255;
  c.putImageData(packed, x, y);
  if (texture) texture.needsUpdate = true;
}

const Animation = {
  /**
   * The disc atlas, built once, every cell open until its image loads.
   *
   * @type {THREE.CanvasTexture}
   */
  get atlas() {
    if (texture) return texture;
    canvas = document.createElement('canvas');
    canvas.width = ANIMATION_GRID * ANIMATION_CELL;
    canvas.height = ANIMATION_GRID * ANIMATION_CELL;
    const c = canvas.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  },

  /** @type {THREE.DataTexture} a row per light; see the file header */
  table,

  /**
   * The atlas cell a disc image is drawn in, given out the first time it is
   * asked for and drawn when the image has loaded. Fixtures of one type ask
   * with the same key and share the cell.
   *
   * @param {String} key unique to the fixture type and the image
   * @param {String} url where the image can be loaded from
   * @returns {Number} the cell, or -1 once the atlas is full
   */
  cellFor(key, url) {
    if (cells.has(key)) return cells.get(key);
    // eslint-disable-next-line no-unused-expressions
    this.atlas;
    if (cells.size >= ANIMATION_GRID * ANIMATION_GRID) {
      // eslint-disable-next-line no-console
      console.warn(`[animation] atlas full, ${key} not drawn`);
      cells.set(key, -1);
      return -1;
    }
    const index = cells.size;
    cells.set(key, index);
    loadImage(url).then((image) => { if (image) drawDisc(index, image); });
    return index;
  },

  /**
   * Writes one light's disc, or clears its row.
   *
   * @param {Number} row the light's id
   * @param {Object|null} disc `{ cell, angle, x, y, radius }`, angle in
   *   radians, the window's centre and radius in the image's coordinates
   */
  write(row, disc) {
    if (!(row >= 0) || row >= ROWS) return;
    const at = row * TEXELS * 4;
    if (!disc || !(disc.cell >= 0)) {
      data.fill(0, at, at + TEXELS * 4);
    } else {
      data[at] = disc.cell + 1;
      data[at + 1] = disc.angle;
      data[at + 2] = disc.x;
      data[at + 3] = disc.y;
      data[at + 4] = disc.radius;
    }
    table.needsUpdate = true;
  },
};

/**
 * Where the window's centre is with the disc a share t of the way in: on
 * the spline through P1, P2 and P3, passing P2 halfway.
 *
 * @param {Object} system `{ p1, p2, p3 }`, each `[x, y]`
 * @param {Number} t 0 out to 1 fully in
 * @returns {Array} `[x, y]`
 */
export function windowCentre(system, t) {
  const u = Math.min(Math.max(t, 0), 1);
  const [p1, p2, p3] = [system.p1, system.p2, system.p3];
  // The quadratic through all three: its control point puts P2 at u = 0.5.
  const cx = 2 * p2[0] - (p1[0] + p3[0]) / 2;
  const cy = 2 * p2[1] - (p1[1] + p3[1]) / 2;
  const a = (1 - u) * (1 - u);
  const b = 2 * u * (1 - u);
  const c = u * u;
  return [a * p1[0] + b * cx + c * p3[0], a * p1[1] + b * cy + c * p3[1]];
}

/**
 * The disc's share of the light at a point of the gate, shared by the beam
 * and the pool shaders. 1 where the disc is out or open, the image's
 * luminance where it is in, at the blur the focus gives, `defocus` 0 sharp
 * to 2 the softest baked level.
 */
export const ANIMATION_GLSL = `
#define ANIMATION_GRID ${ANIMATION_GRID}.0
float animationMask( sampler2D table, sampler2D atlas, float row, vec2 p, float defocus ) {
  if ( row < 0.0 ) return 1.0;
  vec4 disc = texelFetch( table, ivec2( 0, int( row ) ), 0 );
  if ( disc.x < 0.5 ) return 1.0;
  float radius = texelFetch( table, ivec2( 1, int( row ) ), 0 ).x;
  // The point of the disc image the gate shows here: the window's centre
  // plus the gate scaled to the window, turned back by the disc's angle.
  vec2 q = disc.zw + p * radius;
  float c = cos( -disc.y );
  float s = sin( -disc.y );
  q = vec2( c * q.x - s * q.y, s * q.x + c * q.y );
  // The disc is round: past the circle its image is inscribed in there is
  // no disc and the light passes, its rim softened as the focus softens the
  // pattern. The image's square corners are not part of it.
  float r = length( q );
  float rim = 0.01 + 0.03 * defocus;
  if ( r >= 1.0 ) return 1.0;
  vec2 uv = clamp( vec2( q.x, -q.y ) * 0.5 + 0.5, 0.002, 0.998 );
  float index = disc.x - 1.0;
  vec2 cell = vec2( mod( index, ANIMATION_GRID ), floor( index / ANIMATION_GRID ) );
  vec3 levels = textureLod( atlas, ( cell + uv ) / ANIMATION_GRID, 0.0 ).rgb;
  float v = mix( mix( levels.r, levels.g, clamp( defocus, 0.0, 1.0 ) ), levels.b,
    clamp( defocus - 1.0, 0.0, 1.0 ) );
  return mix( v, 1.0, smoothstep( 1.0 - rim, 1.0, r ) );
}
`;

export default Animation;
