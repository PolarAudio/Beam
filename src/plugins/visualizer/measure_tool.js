import * as THREE from 'three';
import { reactive, markRaw, toRaw } from 'vue';
import SceneObjects from './scene_objects';
import {
  featureEdges, closestOnSegment, closestOnLine, footOnPlane, closestOnLineToRay,
  angleAt, distanceBetween, lineAngle, formatLength, formatAngle,
} from './measure_math';

/**
 * @file The measure tool: distances, angles and a fixture's throw, picked in
 * the 3D view with snapping to vertices, edges, faces and fixture points.
 *
 * Drawn as an HTML overlay over the canvas, so measurements are never in a
 * recording or a copied view. Measurements are kept until cleared, and are
 * not part of the project.
 *
 * The viewport hands its camera, canvas and pick targets over in `attach`;
 * this module does not import the controls, which import it.
 */

export const MEASURE_MODES = {
  DISTANCE: 'distance',
  ANGLE: 'angle',
  THROW: 'throw',
};

/** How close, in screen pixels, the pointer must be for each snap. */
const SNAP_PX = {
  vertex: 10,
  midpoint: 9,
  perpendicular: 14,
  axis: 10,
  edge: 7,
};

/** Snaps in the order they win, when several are within reach. */
const SNAP_ORDER = ['vertex', 'fixture', 'midpoint', 'perpendicular', 'axis', 'edge', 'face', 'floor'];

/** The axis colours: x red, y green, z blue, as the gizmo draws them. */
const AXES = {
  x: { dir: new THREE.Vector3(1, 0, 0), colour: '#e5484d' },
  y: { dir: new THREE.Vector3(0, 1, 0), colour: '#46a758' },
  z: { dir: new THREE.Vector3(0, 0, 1), colour: '#3e8ed0' },
};

/** Arrow keys that lock an axis, as SketchUp has them. */
const AXIS_KEYS = { ArrowRight: 'x', ArrowLeft: 'y', ArrowUp: 'z' };

const LINE_COLOUR = '#ffffff';
const HIGHLIGHT_COLOUR = '#1ca6bd';
const LABEL_HEIGHT = 18;

const FLOOR = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const UP = new THREE.Vector3(0, 0, 1);

const state = reactive({
  /** Whether clicks in the 3D view measure rather than select. */
  active: false,
  mode: MEASURE_MODES.DISTANCE,
  /** Finished measurements, in the order they were made. */
  measurements: [],
  /** The measurement shown highlighted in the view and the widget. */
  highlightId: null,
  /** Ends placed so far for the measurement under way. */
  pending: [],
  /** The axis an arrow key has locked, or null. */
  axisLock: null,
  /** A one-line note from the last click, such as a beam that meets nothing. */
  message: '',
});

let context = null;
let nextId = 1;
let pointer = null;
let pointerDirty = false;
let hover = null;
let overlay = null;
let frame = 0;

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const instanceMatrix = new THREE.Matrix4();
const inverseMatrix = new THREE.Matrix4();
const normalMatrix = new THREE.Matrix3();

/**
 * An end as a measurement keeps it: where it is, what it was snapped to, and
 * the face normal or edge direction that came with it.
 *
 * @param {Object} fields
 * @returns {Object} raw, so Vue leaves the vectors alone
 */
function makeEnd(fields) {
  return markRaw({
    point: fields.point.clone(),
    normal: fields.normal ? fields.normal.clone() : null,
    dir: fields.dir ? fields.dir.clone() : null,
    kind: fields.kind,
    label: fields.label,
    axis: fields.axis || null,
  });
}

/**
 * @param {Object} item a scene item
 * @returns {String} its name as the lists show it
 */
function nameOf(item) {
  if (!item) return '';
  return item.label || item.name || '';
}

/**
 * @param {THREE.Vector3} point
 * @returns {Object|null} `{ x, y }` in pixels within the canvas, or null
 *   behind the camera
 */
function toScreen(point) {
  const { camera, width, height } = context.view;
  const p = point.clone().project(camera);
  if (p.z > 1 || p.z < -1) return null;
  return { x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height };
}

function screenDistance(point, cursor) {
  const s = toScreen(point);
  return s ? Math.hypot(s.x - cursor.x, s.y - cursor.y) : Infinity;
}

/**
 * World length of one screen pixel at a point, so a pixel tolerance can be
 * turned into a search radius in the scene.
 *
 * @param {THREE.Vector3} point
 * @returns {Number}
 */
function worldPerPixel(point) {
  const { camera, height } = context.view;
  if (camera.isOrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / height;
  const depth = point.distanceTo(camera.position);
  return (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / height;
}

/**
 * The world matrix of the instance a ray hit.
 *
 * @param {Object} hit
 * @returns {THREE.Matrix4}
 */
function hitMatrix(hit) {
  if (hit.object.isInstancedMesh && hit.instanceId !== undefined) {
    hit.object.getMatrixAt(hit.instanceId, instanceMatrix);
    return instanceMatrix.clone().premultiply(hit.object.matrixWorld);
  }
  return hit.object.matrixWorld.clone();
}

/**
 * Vertices, midpoints and points on the feature edges of the hit object near
 * the pointer.
 *
 * @param {Object} hit
 * @param {THREE.Matrix4} matrix the hit instance's world matrix
 * @param {Object} cursor `{ x, y }` in canvas pixels
 * @param {String} name the object's name, for the snap's label
 * @returns {Array} candidates
 */
function edgeCandidates(hit, matrix, cursor, name) {
  const edges = featureEdges(hit.object.geometry);
  inverseMatrix.copy(matrix).invert();
  const local = hit.point.clone().applyMatrix4(inverseMatrix);
  const scale = new THREE.Vector3().setFromMatrixScale(matrix);
  const minScale = Math.max(Math.min(scale.x, scale.y, scale.z), 1e-6);
  const reach = Math.max(SNAP_PX.vertex, SNAP_PX.midpoint) * 1.5;
  const radius = (reach * worldPerPixel(hit.point)) / minScale;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const near = new THREE.Vector3();
  const out = [];
  for (let i = 0; i < edges.length; i += 6) {
    a.set(edges[i], edges[i + 1], edges[i + 2]);
    b.set(edges[i + 3], edges[i + 4], edges[i + 5]);
    // eslint-disable-next-line no-continue
    if (closestOnSegment(local, a, b, near).distanceTo(local) > radius) continue;
    const wa = a.clone().applyMatrix4(matrix);
    const wb = b.clone().applyMatrix4(matrix);
    const dir = wb.clone().sub(wa).normalize();
    [wa, wb].forEach((corner) => {
      out.push({
        kind: 'vertex', point: corner, dir, label: `vertex, ${name}`, d: screenDistance(corner, cursor),
      });
    });
    const middle = wa.clone().lerp(wb, 0.5);
    out.push({
      kind: 'midpoint', point: middle, dir, label: `midpoint, ${name}`, d: screenDistance(middle, cursor),
    });
    // The point on the edge nearest the pointer, found on screen and carried
    // back along the edge.
    const sa = toScreen(wa);
    const sb = toScreen(wb);
    if (sa && sb) {
      const ex = sb.x - sa.x;
      const ey = sb.y - sa.y;
      const length2 = ex * ex + ey * ey;
      const along2 = (cursor.x - sa.x) * ex + (cursor.y - sa.y) * ey;
      const t = length2 ? THREE.MathUtils.clamp(along2 / length2, 0, 1) : 0;
      const along = wa.clone().lerp(wb, t);
      out.push({
        kind: 'edge', point: along, dir, edgeA: wa, label: `edge, ${name}`, d: screenDistance(along, cursor),
      });
    }
  }
  return out;
}

/**
 * The points a fixture offers: its position, which on a mover is the tilt
 * axis; its lens; the middle of the bottom of its body; and the middle of its
 * body.
 *
 * @param {Object} fixture
 * @returns {Array} `{ name, point }`
 */
function fixturePoints(fixture) {
  const model = fixture && toRaw(fixture._3DModel);
  if (!model || !model._dummy) return [];
  const points = [];
  model._dummy.updateMatrixWorld(true);
  const position = model._dummy.getWorldPosition(new THREE.Vector3());
  points.push({ name: model._headDummy ? 'tilt axis' : 'position', point: position });
  if (model.lensWorldPosition) {
    points.push({ name: 'lens', point: model.lensWorldPosition(new THREE.Vector3()) });
  }
  const rest = model._restBounds;
  if (rest && !rest.isEmpty()) {
    const centre = rest.getCenter(new THREE.Vector3());
    const bottom = new THREE.Vector3(centre.x, centre.y, rest.min.z)
      .applyMatrix4(model._dummy.matrixWorld);
    // Under a hung fixture this is the top of its body: the face it hangs by.
    points.push({ name: 'body base', point: bottom });
  }
  if (model.expandBounds) {
    const box = new THREE.Box3();
    model.expandBounds(box);
    if (!box.isEmpty()) points.push({ name: 'centre', point: box.getCenter(new THREE.Vector3()) });
  }
  return points;
}

/**
 * What the pointer would place: the best snap within reach.
 *
 * @param {Object} event `{ clientX, clientY, shiftKey }`
 * @returns {Object|null} a candidate, or null at the sky
 */
function snapAt(event) {
  const { element, camera } = context.view;
  const rect = element.getBoundingClientRect();
  const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  ndc.set((cursor.x / rect.width) * 2 - 1, -(cursor.y / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const free = !!event.shiftKey;
  const candidates = [];

  const hit = raycaster.intersectObjects(context.pickTargets(), false)
    .find((h) => context.shown(context.ownerOfHit(h)));
  const owner = hit ? context.ownerOfHit(hit) : null;
  let surface = null;
  if (hit && hit.object.userData.sceneObjectModel && hit.face) {
    const matrix = hitMatrix(hit);
    normalMatrix.getNormalMatrix(matrix);
    const normal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
    // Toward the camera, so a face seen from behind still reads as itself.
    if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
    const name = nameOf(owner);
    surface = {
      kind: 'face', point: hit.point.clone(), normal, label: `face, ${name}`, d: 0,
    };
    if (!free) candidates.push(...edgeCandidates(hit, matrix, cursor, name));
  } else if (hit && owner) {
    // Fixtures are picked by an invisible box; their own points are what is
    // worth measuring to.
    fixturePoints(owner).forEach(({ name, point }) => {
      candidates.push({
        kind: 'fixture', point, label: `${name}, ${nameOf(owner)}`, d: screenDistance(point, cursor),
      });
    });
  } else {
    const point = raycaster.ray.intersectPlane(FLOOR, new THREE.Vector3());
    if (point) {
      surface = {
        kind: 'floor', point, normal: UP.clone(), label: 'floor', d: 0,
      };
    }
  }
  if (surface) candidates.push(surface);

  const from = state.mode === MEASURE_MODES.THROW ? null : state.pending[state.pending.length - 1];
  if (from && !free) {
    if (surface) {
      const foot = footOnPlane(from.point, surface.point, surface.normal, new THREE.Vector3());
      candidates.push({
        kind: 'perpendicular', point: foot, normal: surface.normal, label: `perpendicular to ${surface.label}`, d: screenDistance(foot, cursor),
      });
    }
    candidates.filter((c) => c.kind === 'edge' && c.d <= SNAP_PX.edge * 2).forEach((edge) => {
      const foot = closestOnLine(from.point, edge.edgeA, edge.dir, new THREE.Vector3());
      candidates.push({
        kind: 'perpendicular', point: foot, dir: edge.dir, label: `perpendicular to ${edge.label}`, d: screenDistance(foot, cursor),
      });
    });
    if (!state.axisLock) {
      Object.entries(AXES).forEach(([key, axis]) => {
        const point = closestOnLineToRay(raycaster.ray, from.point, axis.dir, new THREE.Vector3());
        candidates.push({
          kind: 'axis', axis: key, point, label: `on ${key} axis`, d: screenDistance(point, cursor),
        });
      });
    }
  }

  const within = (c) => c.kind === 'face' || c.kind === 'floor' || c.kind === 'fixture'
    || c.d <= SNAP_PX[c.kind];
  let best = null;
  SNAP_ORDER.some((kind) => {
    const matches = candidates.filter((c) => c.kind === kind && within(c));
    if (!matches.length) return false;
    best = matches.reduce((x, y) => (y.d < x.d ? y : x));
    return true;
  });

  // A locked axis keeps the end on the axis through the last point: the
  // snap found is carried onto it, or the pointer's nearest point if none.
  if (from && state.axisLock) {
    const axis = AXES[state.axisLock];
    const point = best && best.kind !== 'floor'
      ? from.point.clone()
        .addScaledVector(axis.dir, best.point.clone().sub(from.point).dot(axis.dir))
      : closestOnLineToRay(raycaster.ray, from.point, axis.dir, new THREE.Vector3());
    const label = best && best.kind !== 'floor' ? `on ${state.axisLock} axis, level with ${best.label}` : `on ${state.axisLock} axis`;
    best = {
      kind: 'axis', axis: state.axisLock, point, label, d: 0,
    };
  }
  if (best) best.cursor = cursor;
  return best;
}

/**
 * The text a measurement's label and its widget row lead with.
 *
 * @param {Object} measurement
 * @returns {String}
 */
function headline(measurement) {
  const v = measurement.values;
  if (measurement.kind === MEASURE_MODES.ANGLE) return formatAngle(v.angle);
  if (measurement.kind === MEASURE_MODES.THROW) return `throw ${formatLength(v.distance)}`;
  if (v.gap !== undefined) return `gap ${formatLength(v.gap)}`;
  const angle = v.faceAngle !== undefined ? v.faceAngle : v.edgeAngle;
  if (angle !== undefined) return `${formatLength(v.distance)} · ${formatAngle(angle)}`;
  return formatLength(v.distance);
}

/**
 * Every value a measurement has, as `[label, text]` rows for the widget and
 * the clipboard.
 *
 * @param {Object} measurement
 * @returns {Array}
 */
export function detailsOf(measurement) {
  const v = measurement.values;
  const rows = [];
  const add = (label, text) => rows.push([label, text]);
  if (measurement.kind === MEASURE_MODES.ANGLE) {
    add('angle', formatAngle(v.angle));
    add('arms', `${formatLength(v.armA)}, ${formatLength(v.armC)}`);
    return rows;
  }
  if (measurement.kind === MEASURE_MODES.THROW) {
    add('throw', formatLength(v.distance));
    add('lens height', formatLength(v.lensHeight));
    add('horizontal', formatLength(v.horizontal));
    if (v.incidence !== undefined) add('incidence', formatAngle(v.incidence));
    return rows;
  }
  if (v.gap !== undefined) add('gap', formatLength(v.gap));
  if (v.faceAngle !== undefined) add('face angle', formatAngle(v.faceAngle));
  if (v.edgeAngle !== undefined) add('edge angle', formatAngle(v.edgeAngle));
  add('distance', formatLength(v.distance));
  add('horizontal', formatLength(v.horizontal));
  add('vertical', formatLength(v.vertical));
  add('Δx Δy Δz', [v.dx, v.dy, v.dz].map((n) => (Math.round(n * 1000) / 1000).toFixed(3)).join('  '));
  if (v.gap === undefined && v.perpA !== undefined) add('⊥ to first face', formatLength(v.perpA));
  if (v.gap === undefined && v.perpB !== undefined) add('⊥ to second face', formatLength(v.perpB));
  return rows;
}

/**
 * A measurement as plain text, for the clipboard.
 *
 * @param {Object} measurement
 * @returns {String}
 */
export function textOf(measurement) {
  const ends = measurement.ends.map((end) => end.label).join(' → ');
  const values = detailsOf(measurement).map(([label, text]) => `${label} ${text}`).join(', ');
  return `${measurement.number}  ${values}  (${ends})`;
}

function addMeasurement(kind, ends, values) {
  const measurement = {
    id: nextId,
    number: (state.measurements.length
      ? state.measurements[state.measurements.length - 1].number : 0) + 1,
    kind,
    ends: markRaw(ends),
    values,
  };
  nextId += 1;
  measurement.headline = headline(measurement);
  state.measurements.push(measurement);
  state.highlightId = measurement.id;
  ensureLoop(); // eslint-disable-line no-use-before-define
}

/**
 * Measures a fixture's throw: from its lens along the beam to the first
 * surface, or the floor.
 *
 * @param {Object} event pointer event over the fixture
 */
function measureThrow(event) {
  const { element, camera } = context.view;
  const rect = element.getBoundingClientRect();
  ndc.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(context.pickTargets(), false)
    .find((h) => context.shown(context.ownerOfHit(h)));
  const fixture = hit ? context.ownerOfHit(hit) : null;
  const model = fixture && toRaw(fixture._3DModel);
  if (!model || !model.lensWorldPosition || hit.object.userData.sceneObjectModel) {
    state.message = 'Click a fixture with a lens to measure its throw.';
    return;
  }
  const lens = model.lensWorldPosition(new THREE.Vector3());
  const dir = model._beamDummy.getWorldDirection(new THREE.Vector3());
  const beam = new THREE.Raycaster(lens, dir, 0.01, 1000);
  const surfaces = SceneObjects.pickObjects();
  const landing = beam.intersectObjects(surfaces, false)
    .find((h) => context.shown(context.ownerOfHit(h)) && h.face);
  let end = null;
  if (landing) {
    normalMatrix.getNormalMatrix(hitMatrix(landing));
    const normal = landing.face.normal.clone().applyMatrix3(normalMatrix).normalize();
    end = {
      point: landing.point, normal, kind: 'face', label: `face, ${nameOf(context.ownerOfHit(landing))}`,
    };
  }
  const floor = beam.ray.intersectPlane(FLOOR, new THREE.Vector3());
  if (floor && (!end || floor.distanceTo(lens) < end.point.distanceTo(lens))) {
    end = {
      point: floor, normal: UP.clone(), kind: 'floor', label: 'floor',
    };
  }
  if (!end) {
    state.message = `The beam of ${nameOf(fixture)} meets nothing.`;
    return;
  }
  const values = {
    distance: end.point.distanceTo(lens),
    lensHeight: lens.z,
    horizontal: Math.hypot(end.point.x - lens.x, end.point.y - lens.y),
    incidence: lineAngle(dir.clone().negate(), end.normal),
  };
  state.message = '';
  addMeasurement(MEASURE_MODES.THROW, [
    makeEnd({
      point: lens, dir, kind: 'fixture', label: `lens, ${nameOf(fixture)}`,
    }),
    makeEnd(end),
  ], values);
}

/**
 * Places the end under the pointer, and finishes a measurement once it has
 * all its ends.
 *
 * @public
 * @param {Object} event pointer event in the 3D view
 */
function click(event) {
  if (!state.active || !context) return;
  if (state.mode === MEASURE_MODES.THROW) {
    measureThrow(event);
    return;
  }
  const snap = snapAt(event);
  if (!snap) return;
  state.message = '';
  state.pending.push(makeEnd(snap));
  state.axisLock = null;
  const needed = state.mode === MEASURE_MODES.ANGLE ? 3 : 2;
  if (state.pending.length < needed) return;
  const ends = state.pending.splice(0);
  if (state.mode === MEASURE_MODES.ANGLE) {
    const [a, vertex, c] = ends;
    addMeasurement(MEASURE_MODES.ANGLE, ends, {
      angle: angleAt(a.point, vertex.point, c.point),
      armA: a.point.distanceTo(vertex.point),
      armC: c.point.distanceTo(vertex.point),
    });
  } else {
    addMeasurement(MEASURE_MODES.DISTANCE, ends, distanceBetween(ends[0], ends[1]));
  }
}

/**
 * Follows the pointer, for the live snap and readout.
 *
 * @public
 * @param {Object} event pointer event in the 3D view
 */
function pointerMove(event) {
  if (!state.active) return;
  pointer = { clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey };
  pointerDirty = true;
  ensureLoop(); // eslint-disable-line no-use-before-define
}

function pointerLeave() {
  pointer = null;
  hover = null;
}

/* ---------------------------------------------------------------- drawing */

function ensureOverlay() {
  if (overlay) return overlay;
  const root = document.createElement('div');
  root.className = 'measure_overlay';
  root.style.cssText = 'position:fixed;pointer-events:none;overflow:hidden;z-index:50;'
    + 'font:11px Roboto-Regular, sans-serif;';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;';
  const labels = document.createElement('div');
  labels.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
  root.append(svg, labels);
  // A label picks its measurement. On pointerdown, because the labels are
  // rebuilt every frame and a click would land on a replaced element.
  labels.addEventListener('pointerdown', (e) => {
    const id = Number(e.target.closest('[data-id]') && e.target.closest('[data-id]').dataset.id);
    if (id) {
      state.highlightId = id;
      e.stopPropagation();
    }
  });
  document.body.appendChild(root);
  overlay = { root, svg, labels };
  return overlay;
}

const line = (a, b, colour, width, dash = '') => `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" `
  + `x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#000" stroke-opacity="0.55" `
  + `stroke-width="${width + 2}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
  + `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" `
  + `stroke="${colour}" stroke-width="${width}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

const dot = (p, colour, r = 3) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" `
  + `fill="${colour}" stroke="#000" stroke-opacity="0.6"/>`;

/** The marker that says what the pointer has snapped to. */
function marker(snap, p) {
  const x = p.x.toFixed(1);
  const y = p.y.toFixed(1);
  const stroke = 'stroke="#000" stroke-opacity="0.7" stroke-width="1"';
  switch (snap.kind) {
    case 'vertex':
      return `<rect x="${(p.x - 5).toFixed(1)}" y="${(p.y - 5).toFixed(1)}" width="10" height="10" fill="#22c55e" ${stroke}/>`;
    case 'midpoint':
      return `<polygon points="${x},${(p.y - 6).toFixed(1)} ${(p.x + 6).toFixed(1)},${(p.y + 5).toFixed(1)} ${(p.x - 6).toFixed(1)},${(p.y + 5).toFixed(1)}" fill="#22d3ee" ${stroke}/>`;
    case 'edge':
      return `<rect x="${(p.x - 4).toFixed(1)}" y="${(p.y - 4).toFixed(1)}" width="8" height="8" transform="rotate(45 ${x} ${y})" fill="#f87171" ${stroke}/>`;
    case 'perpendicular':
      return `<path d="M${(p.x - 6).toFixed(1)} ${(p.y + 6).toFixed(1)}h12M${x} ${(p.y + 6).toFixed(1)}v-12" stroke="#f472b6" stroke-width="2.5" fill="none"/>`;
    case 'axis':
      return dot(p, AXES[snap.axis].colour, 5);
    case 'fixture':
      return `<circle cx="${x}" cy="${y}" r="6" fill="none" stroke="#facc15" stroke-width="2"/>${dot(p, '#facc15', 2)}`;
    default:
      return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#e5e7eb" stroke-width="1.5"/>`;
  }
}

function labelHtml(text, p, id, highlighted, number) {
  const background = highlighted ? HIGHLIGHT_COLOUR : 'rgba(18,18,20,0.88)';
  const badge = number ? `<b style="opacity:.7;margin-right:5px">${number}</b>` : '';
  return `<div data-id="${id || ''}" style="position:absolute;left:${p.x.toFixed(1)}px;top:${p.y.toFixed(1)}px;`
    + 'transform:translate(-50%,-50%);padding:1px 6px;border-radius:3px;white-space:nowrap;color:#fff;'
    + `background:${background};pointer-events:${id ? 'auto' : 'none'};cursor:${id ? 'pointer' : 'default'};`
    + `line-height:${LABEL_HEIGHT - 2}px">${badge}${text}</div>`;
}

/**
 * Moves labels down until none overlaps another.
 *
 * @param {Array} placed `{ p, text }`
 */
function spreadLabels(placed) {
  const boxes = [];
  placed.forEach((label) => {
    const width = label.text.length * 6.2 + 24;
    for (let tries = 0; tries < 6; tries += 1) {
      const clash = boxes.some((b) => Math.abs(b.x - label.p.x) < (b.w + width) / 2
        && Math.abs(b.y - label.p.y) < LABEL_HEIGHT);
      if (!clash) break;
      label.p = { x: label.p.x, y: label.p.y + LABEL_HEIGHT + 2 };
    }
    boxes.push({ x: label.p.x, y: label.p.y, w: width });
  });
}

/** One frame of the overlay. */
function draw() {
  if (!context) return;
  const { element } = context.view;
  const rect = element.getBoundingClientRect();
  context.view.camera = context.camera();
  context.view.width = rect.width;
  context.view.height = rect.height;
  const o = ensureOverlay();
  Object.assign(o.root.style, {
    left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
  });
  if (pointer && pointerDirty && state.mode !== MEASURE_MODES.THROW) {
    hover = snapAt(pointer);
    pointerDirty = false;
  }
  if (!pointer || state.mode === MEASURE_MODES.THROW) hover = null;

  let svg = '';
  const labels = [];
  state.measurements.forEach((m) => {
    const lit = m.id === state.highlightId;
    const colour = lit ? HIGHLIGHT_COLOUR : LINE_COLOUR;
    const width = lit ? 2.5 : 1.5;
    const screens = m.ends.map((end) => toScreen(end.point));
    if (screens.some((s) => !s)) return;
    for (let i = 1; i < screens.length; i += 1) {
      svg += line(screens[i - 1], screens[i], colour, width, m.kind === MEASURE_MODES.THROW ? '6 4' : '');
    }
    screens.forEach((s) => { svg += dot(s, colour); });
    const at = m.kind === MEASURE_MODES.ANGLE
      ? screens[1]
      : { x: (screens[0].x + screens[1].x) / 2, y: (screens[0].y + screens[1].y) / 2 };
    labels.push({
      p: { x: at.x, y: at.y - (m.kind === MEASURE_MODES.ANGLE ? 14 : 0) },
      text: m.headline,
      id: m.id,
      lit,
      number: m.number,
    });
  });

  // The measurement under way: placed ends, and the leg to the pointer.
  const pending = state.pending.map((end) => toScreen(end.point));
  for (let i = 1; i < pending.length; i += 1) {
    const [a, b] = [pending[i - 1], pending[i]];
    if (a && b) svg += line(a, b, HIGHLIGHT_COLOUR, 1.5);
  }
  pending.forEach((s) => { if (s) svg += dot(s, HIGHLIGHT_COLOUR); });
  if (hover) {
    const p = toScreen(hover.point);
    const last = state.pending[state.pending.length - 1];
    if (p) {
      if (last) {
        const from = toScreen(last.point);
        const colour = hover.kind === 'axis' ? AXES[hover.axis].colour : HIGHLIGHT_COLOUR;
        if (from) svg += line(from, p, colour, 1.5, '5 3');
      }
      svg += marker(hover, p);
      let live = hover.label;
      if (last && state.mode === MEASURE_MODES.DISTANCE) {
        live = `${formatLength(last.point.distanceTo(hover.point))} · ${hover.label}`;
      } else if (state.pending.length === 2 && state.mode === MEASURE_MODES.ANGLE) {
        live = `${formatAngle(angleAt(state.pending[0].point, state.pending[1].point, hover.point))} · ${hover.label}`;
      }
      labels.push({ p: { x: p.x + 14 + live.length * 3.1, y: p.y + 16 }, text: live });
    }
  }

  spreadLabels(labels);
  o.svg.innerHTML = svg;
  o.labels.innerHTML = labels.map((l) => labelHtml(l.text, l.p, l.id, l.lit, l.number)).join('');
}

function loop() {
  frame = 0;
  if (!state.active && !state.measurements.length) {
    if (overlay) {
      overlay.svg.innerHTML = '';
      overlay.labels.innerHTML = '';
    }
    return;
  }
  draw();
  frame = requestAnimationFrame(loop);
}

function ensureLoop() {
  if (!frame) frame = requestAnimationFrame(loop);
}

/* -------------------------------------------------------------- controls */

/**
 * Connects the tool to the viewport.
 *
 * @public
 * @param {Object} options
 * @param {Function} options.camera returns the camera in use
 * @param {HTMLElement} options.element the canvas
 * @param {Function} options.pickTargets returns the meshes a click can hit
 * @param {Function} options.ownerOfHit the scene item a hit belongs to
 * @param {Function} options.shown whether an item is drawn
 * @param {Function} [options.onActive] told when the tool turns on or off
 */
function attach(options) {
  context = {
    ...options,
    view: {
      element: options.element, camera: options.camera(), width: 1, height: 1,
    },
  };
  options.element.addEventListener('pointerleave', pointerLeave);
}

/**
 * Turns the tool on or off. Measurements stay until cleared.
 *
 * @public
 * @param {Boolean} [on] the state wanted; flips when absent
 */
function toggle(on) {
  const next = on === undefined ? !state.active : !!on;
  if (next === state.active) return;
  state.active = next;
  state.pending.splice(0);
  state.axisLock = null;
  state.message = '';
  hover = null;
  if (context && context.onActive) context.onActive(next);
  ensureLoop();
}

/**
 * @public
 * @param {String} mode one of `MEASURE_MODES`
 */
function setMode(mode) {
  if (!Object.values(MEASURE_MODES).includes(mode)) return;
  state.mode = mode;
  state.pending.splice(0);
  state.axisLock = null;
  state.message = '';
  pointerDirty = true;
}

/** @public */
function clear() {
  state.measurements.splice(0);
  state.pending.splice(0);
  state.highlightId = null;
  state.message = '';
}

/**
 * @public
 * @param {Number} id
 */
function remove(id) {
  const at = state.measurements.findIndex((m) => m.id === id);
  if (at > -1) state.measurements.splice(at, 1);
  if (state.highlightId === id) state.highlightId = null;
}

/**
 * @public
 * @param {Number|null} id
 */
function highlight(id) {
  state.highlightId = id;
}

/**
 * The tool's keys while it is on: Escape steps back out, Delete removes the
 * highlighted measurement, A switches between distance and angle, and the
 * arrow keys lock an axis.
 *
 * @public
 * @param {KeyboardEvent} e
 * @returns {Boolean} whether the key was the tool's
 */
function handleKey(e) {
  if (!state.active) return false;
  if (e.key === 'Escape') {
    if (state.axisLock) state.axisLock = null;
    else if (state.pending.length) state.pending.splice(0);
    else toggle(false);
    return true;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.highlightId !== null) remove(state.highlightId);
    return true;
  }
  if (e.key.toLowerCase() === 'a') {
    setMode(state.mode === MEASURE_MODES.ANGLE ? MEASURE_MODES.DISTANCE : MEASURE_MODES.ANGLE);
    return true;
  }
  const axis = AXIS_KEYS[e.key];
  if (axis) {
    e.preventDefault();
    if (state.pending.length) state.axisLock = state.axisLock === axis ? null : axis;
    pointerDirty = true;
    return true;
  }
  return false;
}

export default {
  state,
  attach,
  toggle,
  setMode,
  clear,
  remove,
  highlight,
  click,
  pointerMove,
  handleKey,
};
