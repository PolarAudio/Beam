import * as THREE from 'three';
import PatchSingleton, { DMX_UNIVERSE_LENGTH } from './patch.model';
import { SHOW_SCOPE } from './definition_store';
import MovingHead from '../../plugins/visualizer/moving_head';
import SceneObjects from '../../plugins/visualizer/scene_objects';
import logoUrl from '../../assets/images/beam_logo.png';

/**
 * @file The patch sheet: a PDF for the crew that sets each fixture's mode and
 * address, with a plan of the rig numbered to match.
 *
 * Universes are given twice, because Art-Net counts from 0 and sACN from 1;
 * Beam's universe is the Art-Net one.
 *
 * A mover's arrow is where its beam swings when tilt rises above centre with
 * pan at centre. A profile does not say which side of the base carries the
 * display, so the arrow is the one direction the crew can check on the unit.
 */

/** Where the sheet sends a reader who wants to know what made it. */
export const BEAM_URL = 'https://beatline.xyz/beam/';

/** Tilt applied when finding which way a head swings, in degrees. */
const TILT_PROBE_DEG = 30;

/** Plot area on an A4 landscape page, in CSS pixels at 96 dpi. */
const PLOT_WIDTH = 990;
const PLOT_HEIGHT = 560;

const scratchBox = new THREE.Box3();
const scratchVector = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();

/**
 * @param {String} text
 * @returns {String} safe inside HTML text and attributes
 */
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convex hull of 2D points, counter-clockwise (monotone chain).
 *
 * @param {Array<Array<Number>>} points `[x, y]` pairs
 * @returns {Array<Array<Number>>}
 */
export function hull(points) {
  const sorted = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  if (sorted.length < 3) return sorted;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const turnsRight = (chain, p) => chain.length >= 2
    && cross(chain[chain.length - 2], chain[chain.length - 1], p) <= 0;
  const lower = [];
  sorted.forEach((p) => {
    while (turnsRight(lower, p)) lower.pop();
    lower.push(p);
  });
  const upper = [];
  sorted.slice().reverse().forEach((p) => {
    while (turnsRight(upper, p)) upper.pop();
    upper.push(p);
  });
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * The eight corners of a local box under a matrix, flattened onto the floor.
 *
 * @param {THREE.Box3} box
 * @param {THREE.Matrix4} matrix
 * @returns {Array<Array<Number>>} `[x, y]` pairs
 */
function plannedCorners(box, matrix) {
  const corners = [];
  [box.min.x, box.max.x].forEach((x) => [box.min.y, box.max.y].forEach((y) => [box.min.z, box.max.z]
    .forEach((z) => {
      scratchVector.set(x, y, z).applyMatrix4(matrix);
      corners.push([scratchVector.x, scratchVector.y]);
    })));
  return corners;
}

/**
 * Outline of a renderer handle seen from above: its body at rest where the
 * handle knows it, otherwise its world bounding box.
 *
 * @param {Object} model a fixture's or object's `_3DModel`
 * @returns {Array<Array<Number>>|null}
 */
function footprintOf(model) {
  if (!model) return null;
  if (model._restBounds && !model._restBounds.isEmpty() && model._dummy) {
    model._dummy.updateMatrixWorld();
    return hull(plannedCorners(model._restBounds, model._dummy.matrixWorld));
  }
  if (!model.expandBounds) return null;
  scratchBox.makeEmpty();
  model.expandBounds(scratchBox);
  if (scratchBox.isEmpty()) return null;
  return hull(plannedCorners(scratchBox, new THREE.Matrix4()));
}

/**
 * Outline of a placed object seen from above, from its model's own bounds so
 * a turned truss is drawn turned.
 *
 * @param {Object} object a scene object
 * @returns {Array<Array<Number>>|null}
 */
function objectFootprint(object) {
  const local = SceneObjects.boundsOf(object.renderKey);
  if (!local || local.isEmpty() || !object.transformNode) return footprintOf(object._3DModel);
  object.transformNode.updateMatrixWorld();
  const { x, y, z } = object._scale || { x: 1, y: 1, z: 1 };
  const matrix = object.transformNode.matrixWorld.clone()
    .multiply(new THREE.Matrix4().makeScale(x, y, z));
  return hull(plannedCorners(local, matrix));
}

/**
 * How the fixture's base is mounted, from where its up axis points.
 *
 * @param {Object} model the fixture's `_3DModel`
 * @returns {String} `Hung`, `Standing`, `Sideways`, or empty when unknown
 */
function mountOf(model) {
  if (!model || !model._dummy) return '';
  model._dummy.updateMatrixWorld();
  model._dummy.getWorldQuaternion(scratchQuaternion);
  const up = scratchVector.set(0, 0, 1).applyQuaternion(scratchQuaternion).z;
  if (up < -0.7) return 'Hung';
  if (up > 0.7) return 'Standing';
  return 'Sideways';
}

/**
 * Which way a mover's beam swings across the floor when tilt rises from
 * centre with pan at centre, as a plan angle in degrees anticlockwise from +X.
 *
 * Poses the yoke and head, reads the beam, and puts them back within the same
 * call, so no frame is drawn with the probe pose.
 *
 * @param {Object} model the fixture's `_3DModel`
 * @param {Boolean} [rising] whether the head's tilt angle grows with DMX
 * @returns {Number|null} null for anything without a yoke
 */
export function panCentreBearing(model, rising = true) {
  if (!(model instanceof MovingHead) || !model._yokeDummy || !model._headDummy) return null;
  const yoke = model._yokeDummy.rotation.z;
  const head = model._headDummy.rotation.x;
  const beamAt = (tilt) => {
    model._yokeDummy.rotation.z = 0;
    model._headDummy.rotation.x = tilt;
    model._dummy.updateMatrixWorld(true);
    return model._beamDummy.getWorldDirection(new THREE.Vector3());
  };
  try {
    const centre = beamAt(0);
    const raised = beamAt(THREE.MathUtils.degToRad(rising ? TILT_PROBE_DEG : -TILT_PROBE_DEG));
    const swing = raised.sub(centre);
    if (Math.hypot(swing.x, swing.y) < 1e-4) return null;
    return THREE.MathUtils.radToDeg(Math.atan2(swing.y, swing.x));
  } finally {
    model._yokeDummy.rotation.z = yoke;
    model._headDummy.rotation.x = head;
    model._dummy.updateMatrixWorld(true);
  }
}

/**
 * Whether the profile's tilt angle grows as its DMX value does. A profile
 * that states it falling turns the head the other way for the same DMX.
 *
 * @param {Object} fixture
 * @returns {Boolean} true when the profile does not say
 */
export function tiltRises(fixture) {
  const engine = fixture._engine;
  if (!engine) return true;
  let rising = true;
  engine.channels.some((channel) => channel.functions.some((f) => {
    if (f.attribute !== 'Tilt' || f.ofl) return false;
    if (f.physicalFrom == null || f.physicalTo == null) return false;
    if (f.physicalFrom === f.physicalTo) return false;
    rising = (f.physicalTo - f.physicalFrom) * (f.dmxTo - f.dmxFrom) > 0;
    return true;
  }));
  return rising;
}

/**
 * Manufacturer and model as printed on the unit. A definition made in this
 * show has no manufacturer yet, so only its name is given.
 *
 * @param {Object} fixture
 * @returns {String}
 */
function typeName(fixture) {
  const name = (fixture.OFLData && fixture.OFLData.name) || fixture.model || '';
  const manufacturer = (fixture.fixtureType && fixture.fixtureType.manufacturer)
    || fixture.manufacturer;
  if (!manufacturer || manufacturer === SHOW_SCOPE) return name;
  return `${manufacturer} ${name}`;
}

/**
 * Universe and channel of an absolute zero-based address.
 *
 * @param {Number} address
 * @returns {{ universe: Number, channel: Number }} channel counted from 1
 */
export function splitAddress(address) {
  return {
    universe: Math.floor(address / DMX_UNIVERSE_LENGTH),
    channel: (address % DMX_UNIVERSE_LENGTH) + 1,
  };
}

/**
 * Everything the sheet prints, read from the show and its renderers.
 *
 * @param {Object} show the Show
 * @returns {Object} `{ title, date, rows, types, objects }`
 */
export function collectPatchSheet(show) {
  const fixtures = show.fixturePool.fixtures.slice();
  const patched = fixtures.filter((f) => PatchSingleton.isPatched(f))
    .sort((a, b) => a.address - b.address);
  const unpatched = fixtures.filter((f) => !PatchSingleton.isPatched(f))
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));

  const types = new Map();
  const rows = patched.concat(unpatched).map((fixture, index) => {
    const model = fixture._3DModel;
    const isPatched = index < patched.length;
    const start = splitAddress(fixture.address);
    const end = splitAddress(Math.max(fixture.addressStop - 1, fixture.address));
    const mode = fixture.modeNames[fixture.modeIndex] || '';
    const type = typeName(fixture);
    const channels = fixture.channels.length;
    const owner = fixture.structure || fixture.group;
    const typeKey = `${type}\u0000${mode}`;
    const bearing = panCentreBearing(model, tiltRises(fixture));
    if (!types.has(typeKey)) {
      types.set(typeKey, {
        type, mode, channels, count: 0,
      });
    }
    types.get(typeKey).count += 1;
    const { x, y, z } = fixture.position;
    return {
      number: index + 1,
      label: fixture.label,
      type,
      mode,
      channels,
      patched: isPatched,
      universe: start.universe,
      start: start.channel,
      endUniverse: end.universe,
      end: end.channel,
      location: owner ? (owner.label || owner.name || '') : '',
      position: { x, y, z },
      mount: mountOf(model),
      bearing,
      footprint: footprintOf(model),
    };
  });

  const objects = show.objects
    .filter((object) => !object.isHidden && !object._hidden)
    .map((object) => ({
      z: object.position ? object.position.z : 0,
      outline: objectFootprint(object),
    }))
    .filter((object) => object.outline && object.outline.length >= 3)
    .sort((a, b) => a.z - b.z);

  return {
    title: show.documentTitle,
    author: show.details.author.trim(),
    version: show.details.version.trim(),
    notes: show.details.notes,
    appVersion: import.meta.env.VITE_APP_VERSION || '',
    // Local date: the UTC one is a day out for half of each day east of Greenwich.
    date: new Date().toLocaleDateString('en-CA'),
    rows,
    types: [...types.values()]
      .sort((a, b) => a.type.localeCompare(b.type) || a.mode.localeCompare(b.mode)),
    objects,
  };
}

/**
 * A small arrow pointing along a plan bearing, for the table.
 *
 * @param {Number} bearing degrees anticlockwise from +X
 * @returns {String} inline SVG
 */
function arrowIcon(bearing) {
  // SVG turns clockwise with y down; the plan's y is up.
  return '<svg class="arrow" viewBox="-8 -8 16 16" width="14" height="14">'
    + `<g transform="rotate(${(-bearing).toFixed(1)})">`
    + '<line x1="-6" y1="0" x2="5" y2="0"/><path d="M6 0 L1 -4 L1 4 Z"/></g></svg>';
}

/**
 * Plan bearing as the side of the stage it faces. The audience is at -Y.
 *
 * @param {Number} bearing degrees anticlockwise from +X
 * @returns {String}
 */
export function bearingWords(bearing) {
  const names = ['stage left', 'upstage left', 'upstage', 'upstage right',
    'stage right', 'downstage right', 'downstage', 'downstage left'];
  // +X is stage left from the performer's view, facing the audience at -Y.
  const step = Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
  return names[step];
}

/**
 * The plan: objects in grey, fixtures numbered to match the table, movers with
 * the arrow `panCentreBearing` gives.
 *
 * @param {Object} sheet from `collectPatchSheet`
 * @returns {String} SVG markup
 */
export function plotSvg(sheet) {
  const points = [];
  sheet.objects.forEach((o) => o.outline.forEach((p) => points.push(p)));
  sheet.rows.forEach((r) => {
    points.push([r.position.x, r.position.y]);
    if (r.footprint) r.footprint.forEach((p) => points.push(p));
  });
  if (!points.length) return '<p>Nothing to draw.</p>';
  let minX = Math.min(...points.map((p) => p[0]));
  let maxX = Math.max(...points.map((p) => p[0]));
  let minY = Math.min(...points.map((p) => p[1]));
  let maxY = Math.max(...points.map((p) => p[1]));
  const margin = Math.max(maxX - minX, maxY - minY, 2) * 0.06 + 0.5;
  minX -= margin; maxX += margin; minY -= margin; maxY += margin;
  const scale = Math.min(PLOT_WIDTH / (maxX - minX), PLOT_HEIGHT / (maxY - minY));
  const width = (maxX - minX) * scale;
  const height = (maxY - minY) * scale;
  const px = (x) => ((x - minX) * scale).toFixed(1);
  const py = (y) => ((maxY - y) * scale).toFixed(1);
  const polygon = (outline, cls) => `<polygon class="${cls}" points="${
    outline.map((p) => `${px(p[0])},${py(p[1])}`).join(' ')}"/>`;

  // Grid lines every 1, 2, 5 or 10 m, whichever keeps them 40 px or more apart.
  const gridStep = [1, 2, 5, 10, 20, 50].find((s) => s * scale >= 40) || 100;
  const grid = [];
  for (let x = Math.ceil(minX / gridStep) * gridStep; x <= maxX; x += gridStep) {
    grid.push(`<line class="${x === 0 ? 'axis' : 'grid'}" x1="${px(x)}" y1="0" x2="${px(x)}" y2="${height.toFixed(1)}"/>`);
    grid.push(`<text class="gridlabel" x="${px(x)}" y="${(height - 3).toFixed(1)}">${x} m</text>`);
  }
  for (let y = Math.ceil(minY / gridStep) * gridStep; y <= maxY; y += gridStep) {
    grid.push(`<line class="${y === 0 ? 'axis' : 'grid'}" x1="0" y1="${py(y)}" x2="${width.toFixed(1)}" y2="${py(y)}"/>`);
    grid.push(`<text class="gridlabel" x="3" y="${(Number(py(y)) - 3).toFixed(1)}">${y} m</text>`);
  }

  const objects = sheet.objects.map((o) => polygon(o.outline, 'object'));
  const bodies = sheet.rows.filter((r) => r.footprint && r.footprint.length >= 3)
    .map((r) => polygon(r.footprint, 'body'));
  const RADIUS = 9;
  const markers = sheet.rows.map((r) => {
    const cx = Number(px(r.position.x));
    const cy = Number(py(r.position.y));
    let arrow = '';
    if (r.bearing !== null) {
      const a = THREE.MathUtils.degToRad(r.bearing);
      const dx = Math.cos(a);
      const dy = -Math.sin(a);
      const from = RADIUS;
      const to = RADIUS + 16;
      const tip = [cx + dx * to, cy + dy * to];
      const back = [cx + dx * (to - 6), cy + dy * (to - 6)];
      const side = [-dy * 4, dx * 4];
      arrow = `<line class="pan" x1="${(cx + dx * from).toFixed(1)}" y1="${(cy + dy * from).toFixed(1)}" `
        + `x2="${back[0].toFixed(1)}" y2="${back[1].toFixed(1)}"/>`
        + `<polygon class="panhead" points="${tip[0].toFixed(1)},${tip[1].toFixed(1)} `
        + `${(back[0] + side[0]).toFixed(1)},${(back[1] + side[1]).toFixed(1)} `
        + `${(back[0] - side[0]).toFixed(1)},${(back[1] - side[1]).toFixed(1)}"/>`;
    }
    return `${arrow}<circle class="${r.patched ? 'marker' : 'marker unpatched'}" cx="${cx}" cy="${cy}" r="${RADIUS}"/>`
      + `<text class="number" x="${cx}" y="${cy + 3.5}">${r.number}</text>`;
  });

  return `<svg class="plot" width="${width.toFixed(0)}" height="${height.toFixed(0)}" `
    + `viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}">`
    + `${grid.join('')}${objects.join('')}${bodies.join('')}${markers.join('')}</svg>`;
}

const STYLE = `
@page { size: A4 landscape; margin: 12mm 12mm 14mm 12mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI", Arial, sans-serif; font-size: 9pt; color: #111; margin: 0;
  width: 273mm; }
.pagebox { position: absolute; left: 0; top: 0; width: 1px; height: 184mm; visibility: hidden; }
h1 { font-size: 15pt; margin: 0 0 2mm 0; }
.brand { display: flex; align-items: center; justify-content: space-between; margin-bottom: 3mm;
  padding-bottom: 2.5mm; border-bottom: 0.8pt solid #111; }
.brand .titles h1 { margin: 0; }
.brand .mark { display: flex; align-items: center; gap: 3mm; text-align: right; }
.brand .mark img { width: 14mm; height: 14mm; }
.brand .wordmark { font-size: 13pt; font-weight: 700; letter-spacing: 0.4pt; }
.brand .wordmark span { color: #2fa84f; }
.brand .url { font-size: 8pt; color: #444; text-decoration: none; }
.usernotes { border: 0.6pt solid #888; border-left: 2.5pt solid #2fa84f; padding: 2mm 3mm;
  margin: 0 0 3mm 0; white-space: pre-wrap; font-size: 9.5pt; }
.usernotes h3 { margin: 0 0 1mm 0; font-size: 10pt; white-space: normal; }
h2 { font-size: 11pt; margin: 5mm 0 2mm 0; }
.meta { color: #444; margin-bottom: 3mm; }
.notes { margin: 0 0 3mm 0; padding-left: 5mm; color: #333; }
.notes li { margin: 0.5mm 0; }
table { border-collapse: collapse; width: 100%; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th { text-align: left; border-bottom: 1.2pt solid #111; padding: 1.2mm 1.5mm; font-weight: 600; white-space: nowrap; }
td { border-bottom: 0.4pt solid #bbb; padding: 1mm 1.5mm; vertical-align: middle; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.addr { font-weight: 700; font-size: 10pt; text-align: right; font-variant-numeric: tabular-nums; }
tr.universe td { background: #e8e8e8; font-weight: 700; border-bottom: 0.8pt solid #111; padding-top: 1.6mm; }
tr.unpatched td { color: #777; }
.dim { color: #666; }
.arrow line { stroke: #111; stroke-width: 1.6; }
.arrow path { fill: #111; }
.plotpage { page-break-before: always; }
.keep { break-inside: avoid; }
table.types { width: auto; min-width: 50%; }
.plotwrap { display: grid; grid-template-columns: auto auto auto; justify-content: center;
  align-items: center; gap: 1.5mm 2mm; }
.stage { font-weight: 700; letter-spacing: 1pt; text-align: center; font-size: 9pt; }
.stage.side { writing-mode: vertical-rl; }
.stage.right { transform: rotate(180deg); }
.plot { border: 0.6pt solid #888; }
.plot .grid { stroke: #e3e3e3; stroke-width: 0.6; }
.plot .axis { stroke: #b0b0b0; stroke-width: 0.9; }
.plot .gridlabel { font-size: 7px; fill: #999; }
.plot .object { fill: rgba(150,150,150,0.25); stroke: #8a8a8a; stroke-width: 0.8; }
.plot .body { fill: rgba(60,60,60,0.25); stroke: #555; stroke-width: 0.6; }
.plot .marker { fill: #fff; stroke: #111; stroke-width: 1.2; }
.plot .marker.unpatched { stroke-dasharray: 2 2; stroke: #888; }
.plot .number { font-size: 9px; font-weight: 700; text-anchor: middle; }
.plot .pan { stroke: #c0392b; stroke-width: 1.6; }
.plot .panhead { fill: #c0392b; }
`;

/**
 * Run in the print window: when the patch table would start in the lower half
 * of a page, it starts on the next one instead. The body is set to the
 * printed width (A4 landscape less margins, 273 x 184 mm) so the measured
 * layout is the printed one.
 */
const BREAK_IF_LOW = [
  '(function () {',
  "  var page = document.getElementById('pagebox').getBoundingClientRect().height;",
  "  var table = document.getElementById('patch');",
  '  var start = table.getBoundingClientRect().top + window.scrollY;',
  "  if (start % page > page / 2) table.style.breakBefore = 'page';",
  '}());',
].join('\n');

/**
 * The whole sheet as one HTML page, ready to print to PDF.
 *
 * @param {Object} sheet from `collectPatchSheet`
 * @returns {String}
 */
export function patchSheetHtml(sheet) {
  const patchedRows = sheet.rows.filter((r) => r.patched);
  const unpatchedRows = sheet.rows.filter((r) => !r.patched);
  const universes = [...new Set(patchedRows.map((r) => r.universe))];
  const movers = sheet.rows.some((r) => r.bearing !== null);
  // The Location column is left out when no fixture is in a group or structure.
  const located = sheet.rows.some((r) => r.location);
  const columns = located ? 13 : 12;

  const row = (r) => {
    const end = r.endUniverse !== r.universe ? `${r.endUniverse}/${r.end}` : `${r.end}`;
    const pan = r.bearing !== null
      ? `${arrowIcon(r.bearing)} <span class="dim">${bearingWords(r.bearing)}</span>` : '';
    return `<tr class="${r.patched ? '' : 'unpatched'}">`
      + `<td class="num">${r.number}</td>`
      + `<td>${escapeHtml(r.label)}</td>`
      + `<td>${escapeHtml(r.type)}</td>`
      + `<td>${escapeHtml(r.mode)}</td>`
      + `<td class="num">${r.channels}</td>`
      + `<td class="num">${r.patched ? r.universe : ''}</td>`
      + `<td class="num">${r.patched ? r.universe + 1 : ''}</td>`
      + `<td class="addr">${r.patched ? r.start : 'not patched'}</td>`
      + `<td class="num dim">${r.patched ? end : ''}</td>`
      + `${located ? `<td>${escapeHtml(r.location)}</td>` : ''}`
      + `<td class="num dim">${r.position.x.toFixed(2)}, ${r.position.y.toFixed(2)}, ${r.position.z.toFixed(2)}</td>`
      + `<td>${r.mount}</td>`
      + `<td>${pan}</td>`
      + '</tr>';
  };

  const body = [];
  universes.forEach((universe) => {
    const inUniverse = patchedRows.filter((r) => r.universe === universe);
    body.push(`<tr class="universe"><td colspan="${columns}">Art-Net universe ${universe} &nbsp;/&nbsp; `
      + `sACN universe ${universe + 1} &nbsp;&middot;&nbsp; ${inUniverse.length} `
      + `${inUniverse.length === 1 ? 'fixture' : 'fixtures'}</td></tr>`);
    inUniverse.forEach((r) => body.push(row(r)));
  });
  if (unpatchedRows.length) {
    body.push(`<tr class="universe"><td colspan="${columns}">Not patched &nbsp;&middot;&nbsp; ${unpatchedRows.length}</td></tr>`);
    unpatchedRows.forEach((r) => body.push(row(r)));
  }

  const types = sheet.types.map((t) => '<tr>'
    + `<td>${escapeHtml(t.type)}</td>`
    + `<td class="num">${t.channels}</td><td class="num">${t.count}</td>`
    + '</tr>').join('');

  const notes = [
    'Universes are given twice: Art-Net counts from 0, sACN counts from 1. Set the fixture to the start channel shown, in the universe of the protocol the console sends.',
    'Set every fixture to the mode shown. The address is only correct in that mode.',
    'A start and end in different universes means the fixture continues into the next universe.',
    'Position is x, y, z in metres. +x is stage left, +y is upstage, z is height. The audience is at -y.',
  ];
  if (movers) {
    notes.push('Movers: the arrow shows where the beam moves when tilt is raised above its centre with pan at its centre. '
      + 'The arrow does not show where the display or controls on the base face. '
      + 'To check a mover on site, set pan to centre and tilt slightly above centre, then turn the base until the beam points along the arrow.');
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(sheet.title)} patch sheet</title>`
    + `<style>${STYLE}</style></head><body>`
    + '<div class="brand"><div class="titles">'
    + `<h1>${escapeHtml(sheet.title)} &ndash; patch sheet</h1></div>`
    + '<div class="mark"><div>'
    + '<div class="wordmark">BEATLINE <span>BEAM</span></div>'
    + `<a class="url" href="${BEAM_URL}">${BEAM_URL}</a></div>`
    + `${sheet.logo ? `<img src="${sheet.logo}" alt="Beatline Beam">` : ''}</div></div>`
    + '<div class="meta">'
    + `${sheet.version ? `Version ${escapeHtml(sheet.version)} &nbsp;&middot;&nbsp; ` : ''}`
    + `${sheet.author ? `${escapeHtml(sheet.author)} &nbsp;&middot;&nbsp; ` : ''}`
    + `${sheet.date} &nbsp;&middot;&nbsp; ${patchedRows.length} patched `
    + `${patchedRows.length === 1 ? 'fixture' : 'fixtures'}${unpatchedRows.length ? `, ${unpatchedRows.length} not patched` : ''}`
    + ` &nbsp;&middot;&nbsp; ${universes.length} ${universes.length === 1 ? 'universe' : 'universes'}</div>`
    + `${sheet.notes.trim() ? `<div class="usernotes"><h3>Notes</h3>${escapeHtml(sheet.notes.trim())}</div>` : ''}`
    + `<ul class="notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>`
    + '<table id="patch"><thead><tr>'
    + '<th class="num">#</th><th>Fixture</th><th>Type</th><th>Mode</th><th class="num">Ch</th>'
    + '<th class="num">Art-Net</th><th class="num">sACN</th><th class="num">Start</th><th class="num">End</th>'
    + `${located ? '<th>Location</th>' : ''}`
    + '<th class="num">x, y, z (m)</th><th>Mount</th><th>Pan centre</th>'
    + `</tr></thead><tbody>${body.join('')}</tbody></table>`
    + '<div class="keep"><h2>Fixture types</h2>'
    + '<table class="types"><thead><tr><th>Type</th><th class="num">Channels</th><th class="num">Count</th>'
    + `</tr></thead><tbody>${types}</tbody></table></div>`
    + '<div class="plotpage"><h1>Plan</h1>'
    + '<div class="meta">Seen from above. Numbers match the # column. '
    + `${movers ? 'Red arrows: where each mover\'s beam moves when tilt is raised above centre with pan at centre. ' : ''}`
    + 'Dashed circles are not patched.</div>'
    // Stage directions are the performer's, facing the audience at the bottom,
    // so stage left is on the right of the page.
    + '<div class="plotwrap"><div></div><div class="stage">UPSTAGE</div><div></div>'
    + `<div class="stage side right">STAGE RIGHT</div>${plotSvg(sheet)}`
    + '<div class="stage side">STAGE LEFT</div>'
    + '<div></div><div class="stage">DOWNSTAGE &nbsp;&middot;&nbsp; AUDIENCE</div><div></div></div></div>'
    + `<div class="pagebox" id="pagebox"></div><script>${BREAK_IF_LOW}</script>`
    + '</body></html>';
}

/**
 * The logo as a data URL: the PDF is printed from a data URL page, which
 * cannot load the app's own asset URLs.
 *
 * @returns {Promise<String|null>}
 */
async function logoDataUrl() {
  try {
    const blob = await (await fetch(logoUrl)).blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    return null;
  }
}

/**
 * Builds the sheet and asks where to save it as a PDF.
 *
 * @param {Object} show the Show
 * @returns {Promise<String|null>} the path written, or null when cancelled
 */
export async function exportPatchSheet(show) {
  if (!window.fileExport) return null;
  const sheet = collectPatchSheet(show);
  sheet.logo = await logoDataUrl();
  return window.fileExport.save({
    pdfFromHtml: patchSheetHtml(sheet),
    pdfFooter: `Beatline Beam ${sheet.appVersion}  ·  ${BEAM_URL}`,
    defaultName: `${sheet.title} patch sheet.pdf`,
    startIn: 'documents',
    startDir: show.documentFolder,
    folderKey: `patch-sheet|${show.documentPath || ''}`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    title: 'Export patch sheet',
  });
}
