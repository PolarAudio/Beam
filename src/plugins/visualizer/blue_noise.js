import * as THREE from 'three';

/**
 * @file A tile of blue noise, made once at startup.
 *
 * Blue noise is a dither with no pattern for the eye to find: every value is
 * as far as it can be from its neighbours of similar value, so the error is
 * spread evenly like an ordered dither, but with no period. An ordered 4x4
 * Bayer pattern did the same job in the room's haze and showed through as a
 * fine regular grid on dark air.
 *
 * Built by void-and-cluster (Ulichney, 1993): start from a scatter of points,
 * even it out by moving the most crowded point into the emptiest gap, then
 * rank every pixel by the order it would be removed or filled. Generated here
 * rather than shipped as an image so there is no asset to carry, and it is
 * seeded, so every run makes the same tile.
 */

/** Tile side, in pixels. Large enough that its repeat does not read. */
export const BLUE_NOISE_SIZE = 64;

/** Width of the energy filter, in pixels: how far "crowded" reaches. */
const SIGMA = 1.5;
/** How far the filter is evaluated; beyond three sigma it is negligible. */
const REACH = 5;

/**
 * A seeded random source, so the tile is the same every run.
 *
 * @param {Number} seed
 * @returns {Function} `() => 0..1`
 */
function seeded(seed) {
  const MODULUS = 4294967296;
  let state = Math.abs(Math.floor(seed)) % MODULUS;
  return () => {
    // Exact in doubles: the product stays below 2^53.
    state = (1664525 * state + 1013904223) % MODULUS;
    return state / MODULUS;
  };
}

/**
 * The ranks, 0..1, of a size x size blue-noise tile.
 *
 * @public
 * @param {Number} [size]
 * @returns {Float32Array} row-major
 */
export function blueNoiseRanks(size = BLUE_NOISE_SIZE) {
  const count = size * size;
  const kernel = [];
  for (let dy = -REACH; dy <= REACH; dy += 1) {
    for (let dx = -REACH; dx <= REACH; dx += 1) {
      kernel.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA))]);
    }
  }
  const on = new Uint8Array(count);
  const energy = new Float64Array(count);
  // Energy is how crowded each pixel's neighbourhood is, on a torus so the
  // tile repeats without a seam.
  const spread = (index, sign) => {
    const x = index % size;
    const y = (index - x) / size;
    for (let k = 0; k < kernel.length; k += 1) {
      const [dx, dy, w] = kernel[k];
      const nx = (x + dx + size) % size;
      const ny = (y + dy + size) % size;
      energy[ny * size + nx] += sign * w;
    }
  };
  const tightest = () => {
    let best = -1;
    let most = -Infinity;
    for (let i = 0; i < count; i += 1) {
      if (on[i] && energy[i] > most) { most = energy[i]; best = i; }
    }
    return best;
  };
  const emptiest = () => {
    let best = -1;
    let least = Infinity;
    for (let i = 0; i < count; i += 1) {
      if (!on[i] && energy[i] < least) { least = energy[i]; best = i; }
    }
    return best;
  };

  // A tenth of the pixels, scattered at random.
  const random = seeded(0x5eed);
  const initial = Math.floor(count / 10);
  let placed = 0;
  while (placed < initial) {
    const i = Math.floor(random() * count);
    if (!on[i]) {
      on[i] = 1;
      spread(i, 1);
      placed += 1;
    }
  }
  // Evened out: the most crowded point moves to the emptiest gap until the
  // gap it would move to is the place it left.
  for (let guard = 0; guard < count; guard += 1) {
    const from = tightest();
    on[from] = 0;
    spread(from, -1);
    const to = emptiest();
    if (to === from) {
      on[from] = 1;
      spread(from, 1);
      break;
    }
    on[to] = 1;
    spread(to, 1);
  }

  const rank = new Float32Array(count);
  const start = on.slice();
  const startEnergy = energy.slice();
  // The initial points ranked by removal, most crowded first, so they take
  // the ranks below the count.
  for (let r = initial - 1; r >= 0; r -= 1) {
    const i = tightest();
    on[i] = 0;
    spread(i, -1);
    rank[i] = r;
  }
  // Every other pixel ranked by filling the emptiest gap in turn.
  on.set(start);
  energy.set(startEnergy);
  for (let r = initial; r < count; r += 1) {
    const i = emptiest();
    on[i] = 1;
    spread(i, 1);
    rank[i] = r;
  }
  for (let i = 0; i < count; i += 1) rank[i] = (rank[i] + 0.5) / count;
  return rank;
}

let shared = null;

/**
 * The tile as a texture: one byte a pixel, wrapping, read texel for texel.
 *
 * @public
 * @returns {THREE.DataTexture}
 */
export function blueNoiseTexture() {
  if (shared) return shared;
  const ranks = blueNoiseRanks(BLUE_NOISE_SIZE);
  const bytes = new Uint8Array(ranks.length);
  for (let i = 0; i < ranks.length; i += 1) bytes[i] = Math.min(255, Math.floor(ranks[i] * 256));
  shared = new THREE.DataTexture(
    bytes,
    BLUE_NOISE_SIZE,
    BLUE_NOISE_SIZE,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  shared.wrapS = THREE.RepeatWrapping;
  shared.wrapT = THREE.RepeatWrapping;
  shared.magFilter = THREE.NearestFilter;
  shared.minFilter = THREE.NearestFilter;
  shared.generateMipmaps = false;
  shared.needsUpdate = true;
  return shared;
}
