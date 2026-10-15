import * as THREE from 'three';
import BakeWorker from './gobo_bake.worker?worker';

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
 * centre x, y), texel 1 is (the window's radius, the turns the disc has made
 * either way, 0, 0). The discs' images
 * are drawn into their own atlas, larger than the gobo atlas's cells
 * because the gate sees only a part of the disc, with the same three baked
 * blur levels in red, green and blue. A disc is drawn into its cell by the
 * gobo bake worker and uploaded on its own; until then its cell is open.
 */

/**
 * Cells across the atlas, and their size in pixels: the usual window, 0.35
 * of the disc's diameter, then spans about 270 px, as a gobo's 256 px cell.
 * 3072 px square, 36 MB on the GPU.
 */
const ANIMATION_GRID = 4;
const ANIMATION_CELL = 768;

/**
 * Blur levels baked per cell, sharp to soft, in pixels: the gobo atlas's
 * levels (0, 5 and 14 px of a 128 px field radius) at the field radius the
 * usual window gives, 0.35 of the disc's half width, 134 px here.
 */
const ANIMATION_BLUR_SIGMAS = [0, 5.25, 14.7];

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
let worker = null;
const cells = new Map();
/** Bakes asked of the worker, by number: the cell each is for. */
const baking = new Map();
let bakes = 0;
/** Cells drawn since the last upload: `{ index, pixels }`. */
const pending = [];

/**
 * What each disc cell's image measured (see gobo_bake.worker.js), a row per
 * cell: texel 0 (glass 1 or 0, feature size in disc radii, low, high), texel
 * 1 (mean, stretch 0 to 1, angle of the features in radians, 0).
 */
const measures = new Float32Array(ANIMATION_GRID * ANIMATION_GRID * 2 * 4);
const MEASURE_ROWS = ANIMATION_GRID * ANIMATION_GRID;
const { RGBAFormat, FloatType } = THREE;
const measureTable = new THREE.DataTexture(measures, 2, MEASURE_ROWS, RGBAFormat, FloatType);
measureTable.magFilter = THREE.NearestFilter;
measureTable.minFilter = THREE.NearestFilter;
measureTable.needsUpdate = true;

/**
 * The fake caustics on glass discs: strength 0 (off) to 1, how far the web
 * flows per turn of the disc, and its size against the disc's own features.
 * The web moves only as the disc turns: a disc at rest throws a still web. The real glass
 * scatters light into a moving web of bright lines; this draws such a web,
 * shaped by the disc's measures, rather than tracing the light.
 */
export const GLASS_CAUSTIC = 0.7;
export const GLASS_FLOW = 2.5;
export const GLASS_SIZE = 1;

const glass = {
  animationParams: { value: measureTable },
  animationCaustic: { value: GLASS_CAUSTIC },
  animationFlow: { value: GLASS_FLOW },
  animationSize: { value: GLASS_SIZE },
};

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

/** A cell's top-left corner in the atlas, in pixels. */
function cellOrigin(index) {
  const x = (index % ANIMATION_GRID) * ANIMATION_CELL;
  return [x, Math.floor(index / ANIMATION_GRID) * ANIMATION_CELL];
}

/**
 * Asks the worker to draw a disc image into its cell: the whole image over
 * white, stretched to the cell, its luminance at each blur level in red,
 * green and blue.
 */
function bakeDisc(index, image) {
  bakes += 1;
  const id = bakes;
  baking.set(id, index);
  createImageBitmap(image).then((bitmap) => {
    worker.postMessage({
      id, bitmap, disc: true, size: ANIMATION_CELL, sigmas: ANIMATION_BLUR_SIGMAS,
    }, [bitmap]);
  }, () => baking.delete(id));
}

/** A baked disc back from the worker: into the atlas, and queued for upload. */
function onBaked({ data: baked }) {
  const index = baking.get(baked.id);
  baking.delete(baked.id);
  if (index === undefined) return;
  const [x, y] = cellOrigin(index);
  const pixels = new Uint8ClampedArray(baked.pixels.buffer);
  canvas.getContext('2d').putImageData(new ImageData(pixels, ANIMATION_CELL, ANIMATION_CELL), x, y);
  pending.push({ index, pixels: new Uint8Array(baked.pixels.buffer) });
  const m = baked.stats;
  const row = index * 8;
  if (m) {
    measures.set([m.glass ? 1 : 0, m.size, m.low, m.high, m.mean, m.stretch, m.angle, 0], row);
  } else {
    measures.fill(0, row, row + 8);
  }
  measureTable.needsUpdate = true;
}

const Animation = {
  /** @type {Object} the glass uniforms the beam and pool shaders share */
  glass,
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
    worker = new BakeWorker();
    worker.onmessage = onBaked;
    return texture;
  },

  /**
   * Uploads the discs drawn since the last call, each cell on its own.
   * Called once a frame, before drawing.
   *
   * @param {THREE.WebGLRenderer} renderer
   */
  flush(renderer) {
    if (!texture || !pending.length || !renderer) return;
    const at = new THREE.Vector2();
    pending.splice(0, pending.length).forEach(({ index, pixels }) => {
      const source = new THREE.DataTexture(pixels, ANIMATION_CELL, ANIMATION_CELL);
      source.flipY = false;
      source.needsUpdate = true;
      at.set(...cellOrigin(index));
      renderer.copyTextureToTexture(source, texture, null, at);
      source.dispose();
    });
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
    loadImage(url).then((image) => { if (image) bakeDisc(index, image); });
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
      data[at + 5] = disc.turns || 0;
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
 * luminance where it is in, at the blur the focus gives: `defocus` 0 sharp
 * to 2 the softest baked level and on to 3, and `blur` the lens's blur in
 * field radii.
 */
export const ANIMATION_GLSL = `
#define ANIMATION_GRID ${ANIMATION_GRID}.0
uniform sampler2D animationParams;
uniform float animationCaustic;
uniform float animationFlow;
uniform float animationSize;
// A web of bright lines, 0 to 1, tiling every unit of uv and flowing with
// t: the classic iterated water caustic. The exponent sets how thin its
// lines are, 8 crisp; its mean is then about 0.79 exp(-0.19 (exponent - 1)).
float animationWeb( vec2 uv, float t, float exponent ) {
  vec2 p = mod( uv * 6.2831853, 6.2831853 ) - 250.0;
  vec2 i = p;
  float c = 1.0;
  for ( int n = 0; n < 5; n ++ ) {
    float tn = t * ( 1.0 - 3.5 / float( n + 1 ) );
    i = p + vec2( cos( tn - i.x ) + sin( tn + i.y ), sin( tn - i.y ) + cos( tn + i.x ) );
    c += 1.0 / length( vec2( p.x / ( sin( i.x + tn ) / 0.005 ), p.y / ( cos( i.y + tn ) / 0.005 ) ) );
  }
  c = 1.17 - pow( c / 5.0, 1.4 );
  return clamp( pow( abs( c ), exponent ), 0.0, 1.0 );
}
// What a glass disc passes at a point of it, faked: the web sized and
// stretched as the disc's features, between the disc's own low and high
// levels, at the disc's own mean. Drawn on the disc, so it turns with it,
// and flowing as the disc turns, so its lines wander in every direction
// while it moves and stand still when it stops. The lens blurs it by its
// blur against the web's cell: crisp lines in focus, wider and fainter as
// the blur grows, even light once the blur spans a cell. The mean stays.
float animationGlass( vec4 a, vec4 b, vec2 q, float turns, float blurDisc ) {
  float c = cos( -b.z );
  float s = sin( -b.z );
  vec2 r = vec2( c * q.x - s * q.y, s * q.x + c * q.y );
  float cell = max( a.y, 0.02 ) * animationSize;
  vec2 uv = vec2( r.x / ( 1.0 + 2.0 * b.y ), r.y ) / cell;
  // One tile of the web holds three to four of its cells.
  float soft = clamp( blurDisc / ( cell / 3.5 ), 0.0, 1.0 );
  float exponent = mix( 8.0, 1.5, soft );
  float web = animationWeb( uv, turns * animationFlow, exponent );
  float webMean = 0.79 * exp( -0.19 * ( exponent - 1.0 ) );
  float shaped = mix( a.z, a.w, web / webMean * 0.5 );
  float meanShaped = mix( a.z, a.w, 0.5 );
  shaped = mix( shaped, meanShaped, smoothstep( 0.4, 1.0, soft ) );
  return shaped * b.x / max( meanShaped, 0.02 );
}
// The disc's softest level at a point of the disc image; 1 past the image,
// where there is no disc.
float animationSoftest( sampler2D atlas, vec2 cell, vec2 q ) {
  if ( max( abs( q.x ), abs( q.y ) ) >= 1.0 ) return 1.0;
  vec2 uv = clamp( vec2( q.x, -q.y ) * 0.5 + 0.5, 0.002, 0.998 );
  return textureLod( atlas, ( cell + uv ) / ANIMATION_GRID, 0.0 ).b;
}
float animationMask( sampler2D table, sampler2D atlas, float row, vec2 p, float defocus, float blur ) {
  if ( row < 0.0 ) return 1.0;
  vec4 disc = texelFetch( table, ivec2( 0, int( row ) ), 0 );
  if ( disc.x < 0.5 ) return 1.0;
  vec4 window = texelFetch( table, ivec2( 1, int( row ) ), 0 );
  float radius = window.x;
  // The point of the disc image the gate shows here: the window's centre
  // plus the gate scaled to the window, turned back by the disc's angle.
  vec2 q = disc.zw + p * radius;
  float c = cos( -disc.y );
  float s = sin( -disc.y );
  q = vec2( c * q.x - s * q.y, s * q.x + c * q.y );
  // The cell holds the disc with everything outside its circle open, its
  // edge blurred with the pattern at every level (gobo_bake.worker.js), so
  // the edge softens with the focus and stays where it is. Past the image
  // there is no disc.
  float spread = blur * radius;
  float index = disc.x - 1.0;
  vec2 cell = vec2( mod( index, ANIMATION_GRID ), floor( index / ANIMATION_GRID ) );
  float v = 1.0;
  if ( max( abs( q.x ), abs( q.y ) ) < 1.0 ) {
    vec2 uv = clamp( vec2( q.x, -q.y ) * 0.5 + 0.5, 0.002, 0.998 );
    vec3 levels = textureLod( atlas, ( cell + uv ) / ANIMATION_GRID, 0.0 ).rgb;
    v = mix( mix( levels.r, levels.g, clamp( defocus, 0.0, 1.0 ) ), levels.b,
      clamp( defocus - 1.0, 0.0, 1.0 ) );
  }
  // Past the softest level the pattern and its edge blur on: the softest
  // level averaged over a ring as wide as the lens's blur.
  float wash = clamp( defocus - 2.0, 0.0, 1.0 );
  if ( wash > 0.0 ) {
    float sum = animationSoftest( atlas, cell, q );
    for ( int k = 0; k < 6; k ++ ) {
      float a = float( k ) * 1.0472;
      sum += animationSoftest( atlas, cell, q + vec2( cos( a ), sin( a ) ) * spread * 0.6 );
    }
    v = mix( v, sum / 7.0, wash );
  }
  // Glass discs, faked: the web instead of the image, by the strength.
  if ( animationCaustic > 0.0 && max( abs( q.x ), abs( q.y ) ) < 1.0 && length( q ) < 1.0 ) {
    vec4 ma = texelFetch( animationParams, ivec2( 0, int( index ) ), 0 );
    if ( ma.x > 0.5 ) {
      vec4 mb = texelFetch( animationParams, ivec2( 1, int( index ) ), 0 );
      float rim = 1.0 - smoothstep( 0.9, 1.0, length( q ) );
      v = mix( v, animationGlass( ma, mb, q, window.y, blur * radius ), animationCaustic * rim );
    }
  }
  return v;
}
`;

export default Animation;
