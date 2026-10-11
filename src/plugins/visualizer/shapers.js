import * as THREE from 'three';

/**
 * @file Framing shutters: blades pushed into the gate from its edge.
 *
 * A blade is a straight edge cutting the gate image. Blade n of N rests at
 * the field's edge, its home direction 90 degrees minus n - 1 of N turns
 * counted from the top, so four blades are top, right, bottom and left. Each
 * end goes in separately: A is the end clockwise of the blade's middle seen
 * from the lamp, B the other; a blade with no B of its own moves parallel,
 * both ends as A. An insertion of 0 leaves the blade at the edge, 1 carries
 * it to the opposite edge, across the whole field. A blade's own
 * rotation turns it about its middle, and the shaper's rotation turns them
 * all about the axis.
 *
 * Every renderer reads a blade the same way: as a half-plane in the gate,
 * (nx, ny, c), blocking where dot(n, p) > c, p the aperture position with the
 * field's radius 1.
 */

/** Blades the renderers draw per light; a fixture with more keeps the first. */
export const MAX_BLADES = 8;

/** Rows in the table: one per light, as many as the renderer allows. */
const ROWS = 4096;

/**
 * The half-planes for a set of blades.
 *
 * @param {Array} blades `{ a, b, rot, hasB }` per blade, insertions 0..1, rot in degrees
 * @param {Number} [rotation] the shaper's rotation, degrees
 * @returns {Array} `[nx, ny, c]` per blade, at most MAX_BLADES
 */
export function bladePlanes(blades, rotation = 0) {
  const count = Math.min(blades.length, MAX_BLADES);
  const planes = [];
  for (let n = 0; n < count; n += 1) {
    const blade = blades[n] || {};
    const home = THREE.MathUtils.degToRad(90 - (n * 360) / blades.length + rotation);
    const dx = Math.cos(home);
    const dy = Math.sin(home);
    // Clockwise of the home direction, seen from the lamp.
    const tx = dy;
    const ty = -dx;
    const a = Math.min(Math.max(Number(blade.a) || 0, 0), 1);
    const b = blade.hasB ? Math.min(Math.max(Number(blade.b) || 0, 0), 1) : a;
    // The two ends, a field radius either side of the middle.
    let ax = dx * (1 - 2 * a) + tx;
    let ay = dy * (1 - 2 * a) + ty;
    let bx = dx * (1 - 2 * b) - tx;
    let by = dy * (1 - 2 * b) - ty;
    const turn = THREE.MathUtils.degToRad(Number(blade.rot) || 0);
    if (turn) {
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      const spin = (x, y) => [mx + (x - mx) * c - (y - my) * s, my + (x - mx) * s + (y - my) * c];
      [ax, ay] = spin(ax, ay);
      [bx, by] = spin(bx, by);
    }
    // The edge's normal, turned to point the way the blade comes in from.
    let nx = -(by - ay);
    let ny = bx - ax;
    const length = Math.hypot(nx, ny) || 1;
    nx /= length;
    ny /= length;
    if (nx * dx + ny * dy < 0) {
      nx = -nx;
      ny = -ny;
    }
    planes.push([nx, ny, nx * ax + ny * ay]);
  }
  return planes;
}

const data = new Float32Array(ROWS * MAX_BLADES * 4);
const texture = new THREE.DataTexture(data, MAX_BLADES, ROWS, THREE.RGBAFormat, THREE.FloatType);
texture.magFilter = THREE.NearestFilter;
texture.minFilter = THREE.NearestFilter;
texture.generateMipmaps = false;
texture.needsUpdate = true;

const Shapers = {
  /** @type {THREE.DataTexture} a row per light, a texel per blade; w 1 where a blade is */
  texture,

  /**
   * Writes one light's blades into its row.
   *
   * @public
   * @param {Number} row the light's id
   * @param {Array} planes from `bladePlanes`
   */
  write(row, planes) {
    if (!(row >= 0 && row < ROWS)) return;
    const at = row * MAX_BLADES * 4;
    for (let k = 0; k < MAX_BLADES; k += 1) {
      const plane = planes[k];
      const i = at + k * 4;
      data[i] = plane ? plane[0] : 0;
      data[i + 1] = plane ? plane[1] : 0;
      data[i + 2] = plane ? plane[2] : 0;
      data[i + 3] = plane ? 1 : 0;
    }
    texture.needsUpdate = true;
  },
};

/**
 * The blades as GLSL: how much light passes at an aperture position, given
 * the light's row. Shared by the pools and the beams so the two cut alike.
 */
export const SHAPER_GLSL = /* glsl */`
float shaperMask( sampler2D table, float row, vec2 p, float soft ) {
  if ( row < 0.0 ) return 1.0;
  float v = 1.0;
  for ( int k = 0; k < ${MAX_BLADES}; k++ ) {
    vec4 blade = texelFetch( table, ivec2( k, int( row ) ), 0 );
    if ( blade.w < 0.5 ) break;
    v *= 1.0 - smoothstep( -soft, soft, dot( blade.xy, p ) - blade.z );
  }
  return v;
}
`;

export default Shapers;
