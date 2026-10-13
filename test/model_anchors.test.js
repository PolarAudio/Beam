/* eslint-disable no-console */
/**
 * Anchors: the labelled empty nodes in a model, and which of them join.
 *
 * The convention itself is the whole of the decision here -- glTF has no
 * first-class anchor, so a node says what it is in its name, and everything
 * downstream rests on reading that name the way an author meant it. That is why
 * this is worth a suite of its own rather than a few assertions inside the
 * visualizer's tests: a rule that is quietly wrong joins a truss to a speaker,
 * and there is no renderer involved for a test to notice.
 *
 * The traversal is checked against a hand-built scene rather than a loaded
 * file, because reaching a `.glb`'s node tree needs a loader and a fetch, and
 * everything worth checking here happens before that.
 *
 * Usage:
 *   npm test
 */
import {
  Group,
  Object3D,
  Mesh,
  BoxGeometry,
  Matrix4,
  Vector3,
  MathUtils,
} from 'three';
import {
  parseAnchorName, anchorsJoin, anchorLabel, collectAnchors, isPivot,
} from '@/plugins/visualizer/model_anchors';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** The pair as the join rule sees it: group and label. */
const pair = (anchor) => (anchor ? `${anchor.group || '-'}/${anchor.label}` : null);

/** Rounded, so a float from a matrix reads as the number that was meant. */
const at = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1000) / 1000).join(',');

console.log('\n-- a name says what a node is --');
check('a lone label is one', pair(parseAnchorName('anchor_end')), '-/end');
check('a group and a label are two', pair(parseAnchorName('anchor_coupler_end')), 'coupler/end');
check('the prefix is not case sensitive', pair(parseAnchorName('Anchor_End')), '-/end');
check('nor is the label', pair(parseAnchorName('ANCHOR_END')), '-/end');
check('a dash separates as well', pair(parseAnchorName('anchor-end')), '-/end');
check('and a space', pair(parseAnchorName('anchor end')), '-/end');

console.log('\n-- a group tells one connector system from another --');
check('the group is the middle', pair(parseAnchorName('anchor_coupler_start')), 'coupler/start');
check('and it is case folded', pair(parseAnchorName('anchor_Coupler_End')), 'coupler/end');
check('a longer group is kept whole', pair(parseAnchorName('anchor_b truss_start')), 'b_truss/start');
// Two tokens is a label and no group, which makes it a wildcard -- see below.
// Three or more is a group and a label, and that is the strict form an
// adjustable corner wants, so its pivot does not also answer to a coupler.
check('two tokens is a label and no group', pair(parseAnchorName('anchor_center')), '-/center');
check('three is a group and a label', pair(parseAnchorName('anchor_center_pivot')), 'center/pivot');
check('which is what an adjustable corner writes', pair(parseAnchorName('anchor_center_pivot')), 'center/pivot');

console.log('\n-- a label is free, because a corner may have four --');
// This is the rule the first attempt got wrong. Sides were made complementary
// on the reasoning that a run joined end to end would stack -- true of a straight
// run, and useless for real rigging, where a three- or four-way corner cannot be
// expressed by two-sided rules at all and truss is multi-directional.
check('north is as good as anything', pair(parseAnchorName('anchor_coupler_north')), 'coupler/north');
check('so is east', pair(parseAnchorName('anchor_coupler_east')), 'coupler/east');
check('and a', pair(parseAnchorName('anchor_coupler_a')), 'coupler/a');
check('and whatever else the author likes', pair(parseAnchorName('anchor_coupler_leg1')), 'coupler/leg1');

console.log('\n-- and what is not an anchor is not --');
// The three kinds in the shipped models today: a group, and the scene's own
// light and camera, all meshless and all named.
check('a plain group is not', parseAnchorName('moving_head_assembly'), null);
check('nor a light', parseAnchorName('Light'), null);
check('nor a camera', parseAnchorName('Camera'), null);
check('nor a mesh named after one', parseAnchorName('speaker_anchor'), null);
check('a product code is not', parseAnchorName('QCV19|2way45dg'), null);
check('anchor alone says nothing', parseAnchorName('anchor'), null);
check('nothing is not', parseAnchorName(''), null);
check('nor is a missing name', parseAnchorName(undefined), null);
check('nor a non-string', parseAnchorName(42), null);

console.log('\n-- all sides of one system join all sides of another --');
const couplerStart = parseAnchorName('anchor_coupler_start');
const couplerEnd = parseAnchorName('anchor_coupler_end');
const couplerNorth = parseAnchorName('anchor_coupler_north');
const pipeStart = parseAnchorName('anchor_pipe_start');
const centre = parseAnchorName('anchor_center');
check('a start joins an end', anchorsJoin(couplerStart, couplerEnd), true);
check('and the way round', anchorsJoin(couplerEnd, couplerStart), true);
check('an end joins another end', anchorsJoin(couplerEnd, couplerEnd), true);
check('because that is how a four-way corner is built', anchorsJoin(couplerNorth, couplerStart), true);
check('a centre joins a centre', anchorsJoin(centre, centre), true);
check('the two halves of an adjustable corner', anchorsJoin(centre, parseAnchorName('anchor_center_b')), true);
check('nothing joins nothing', anchorsJoin(null, null), false);
check('nor a missing one', anchorsJoin(couplerStart, null), false);

console.log('\n-- but a system is still a system --');
check('a coupler does not meet a pipe', anchorsJoin(couplerStart, pipeStart), false);
check('nor the other way round', anchorsJoin(pipeStart, couplerStart), false);
check('a centre is a label, and so a wildcard', anchorsJoin(centre, couplerStart), true);
check('the strict form is a group of its own', pair(parseAnchorName('anchor_center_pivot')), 'center/pivot');
check('and that does not meet a coupler', anchorsJoin(parseAnchorName('anchor_center_pivot'), couplerStart), false);

console.log('\n-- and an anchor with no group will meet anything --');
// The forgiving reading, and the useful one: a speaker that says `anchor_end`
// means "wherever I hang from", without having to know what the truss above it
// calls its connectors.
const plain = parseAnchorName('anchor_end');
check('an ungrouped anchor joins a coupler', anchorsJoin(plain, couplerEnd), true);
check('and a pipe', anchorsJoin(plain, pipeStart), true);
check('and a centre', anchorsJoin(plain, centre), true);
check('and another ungrouped one', anchorsJoin(plain, parseAnchorName('anchor_start')), true);
check('but a stated group is still respected', anchorsJoin(couplerEnd, pipeStart), false);
check('the same system joins', anchorsJoin(couplerStart, couplerEnd), true);
check('a different one does not', anchorsJoin(couplerStart, pipeStart), false);
check('nothing joins nothing', anchorsJoin(null, null), false);
check('nor a missing one', anchorsJoin(couplerStart, null), false);

console.log('\n-- a label to show --');
check('an ungrouped anchor is its label', anchorLabel(plain), 'end');
check('a grouped one reads as words', anchorLabel(couplerEnd), 'coupler end');
check('a wildcard label reads as itself', anchorLabel(parseAnchorName('anchor_center')), 'center');
check('and nothing labels as nothing', anchorLabel(null), '');

// -- the traversal ------------------------------------------------------------

/** A named empty, the way GLTFLoader hands one over. */
function empty(name, at0 = [0, 0, 0]) {
  const node = new Object3D();
  node.name = name;
  // What the loader does with the file's own name, in both places.
  node.userData = { name };
  node.position.set(at0[0], at0[1], at0[2]);
  return node;
}

/** A mesh, which must never be taken for an anchor however it is named. */
function mesh(name, at0 = [0, 0, 0]) {
  const node = new Mesh(new BoxGeometry(1, 1, 1));
  node.name = name;
  node.userData = { name };
  node.position.set(at0[0], at0[1], at0[2]);
  return node;
}

console.log('\n-- the anchors of a model --');
const nested = new Group();
const truss = new Object3D(); // a group, the way a .blend nests one
truss.name = 'truss';
truss.position.set(1, 0, 2);
truss.add(empty('anchor_start'));
truss.add(empty('anchor_end', [2, 0, 0]));
truss.add(mesh('chord', [1, 0, 0]));
nested.add(truss);
nested.add(mesh('Light', [9, 9, 9]));
nested.add(empty('Camera', [4, 4, 4]));

const found = collectAnchors(nested, new Matrix4());
check('only the named empties are anchors', found.length, 2);
check('in the order they were walked', found.map((a) => a.label).join(','), 'start,end');
// The group is nested and offset, so these are world positions and not the
// local ones the empties were authored at.
check('a nested anchor is placed in world space', at(found[0].position), '1,0,2');
check('and the second is offset within it', at(found[1].position), '3,0,2');
check('the name from the file is kept', found[0].name, 'anchor_start');

console.log('\n-- the corrections land on the anchors too --');
const scaled = new Group();
scaled.add(empty('anchor_end', [2, 0, 0]));
// What `correction` builds for a model authored Y-up at half size: a scale, then
// the quarter turn that takes glTF's Y up to Beam's Z up.
const fixScaleTurn = new Matrix4()
  .makeScale(0.5, 0.5, 0.5)
  .premultiply(new Matrix4().makeRotationX(Math.PI / 2));
const [turned] = collectAnchors(scaled, fixScaleTurn);
// Scaled: 2 becomes 1. Turned a quarter turn about X, so the point that was
// along +X is still along +X and the Y axis is what becomes Z.
check('a corrected anchor is scaled and turned', at(turned.position), '1,0,0');

console.log('\n-- a translation, which a pivot depends on --');
const offset = new Group();
const offsetChild = new Object3D();
offsetChild.position.set(10, 0, 0);
offsetChild.add(empty('anchor_start'));
offset.add(offsetChild);
const [moved] = collectAnchors(offset, new Matrix4().makeTranslation(0, 0, 3));
check('the offset is applied after the node', at(moved.position), '10,0,3');

console.log('\n-- and a model with no anchors in it --');
const anchorless = new Group();
anchorless.add(mesh('body'));
anchorless.add(empty('Light'));
check('yields none', collectAnchors(anchorless, new Matrix4()).length, 0);
check('and no root is not a crash', collectAnchors(null, new Matrix4()).length, 0);

console.log('\n-- an anchor points as well as sits --');
/** Where the anchor's own +X ends up, which is the direction it declares. */
const heading = (anchor) => {
  const x = new Vector3(1, 0, 0).applyQuaternion(anchor.rotation);
  return [x.x, x.y, x.z].map((n) => Math.round(n * 1000) / 1000).join(',');
};
/** An empty with a rotation, as a corner's would be authored. */
const turnedEmpty = (name, degrees, at0) => {
  const node = empty(name, at0);
  node.rotation.set(0, 0, MathUtils.degToRad(degrees));
  return node;
};
{
  const straight = new Group();
  straight.add(empty('anchor_start'));
  straight.add(empty('anchor_end', [2, 0, 0]));
  const [s] = collectAnchors(straight, new Matrix4());
  // Unrotated, an anchor carries the model's own frame, so a straight span
  // already agrees with its neighbour and needs no turn to line up.
  check('an unrotated anchor carries the model frame', heading(s), '1,0,0');

  // A 90 degree corner: the end's empty is rotated to point along the new
  // direction, so its +X now lies along +Y.
  const corner = new Group();
  corner.add(turnedEmpty('anchor_end', 90, [2, 0, 0]));
  const [c] = collectAnchors(corner, new Matrix4());
  check('a 90 degree corner points along the new direction', heading(c), '0,1,0');

  // A 45 degree corner, the other common truss angle.
  const fortyFive = new Group();
  fortyFive.add(turnedEmpty('anchor_end', 45, [2, 0, 0]));
  const [f] = collectAnchors(fortyFive, new Matrix4());
  check('a 45 degree corner points between', heading(f), '0.707,0.707,0');

  // The correction has to reach the direction too, or a Y-up model would place
  // its joins correctly and then point them the wrong way up.
  const upAxisModel = new Group();
  upAxisModel.add(turnedEmpty('anchor_end', 90, [2, 0, 0]));
  const upAxisFix = new Matrix4()
    .makeScale(1, 1, 1)
    .premultiply(new Matrix4().makeRotationX(Math.PI / 2));
  const [u] = collectAnchors(upAxisModel, upAxisFix);
  // The quarter turn takes +Y to +Z, so the corner that pointed along the new
  // horizontal now points along the room's up.
  check('the up-axis correction reaches the direction', heading(u), '0,0,1');
}

console.log('\n-- Blender renames a duplicate, and the number is not meaning --');
// Blender will not let two objects share a name. It appends `.001`, and that
// lands on the side -- so without this a truss with two identical connectors
// works with one of them and there is nothing on screen to say so.
check('a second identical start is still a start', pair(parseAnchorName('anchor_start.001')), '-/start');
check('a third', pair(parseAnchorName('anchor_start.002')), '-/start');
check('and the twentieth', pair(parseAnchorName('anchor_start.020')), '-/start');
check(
  'a numbered coupler keeps its group',
  pair(parseAnchorName('anchor_coupler_end.002')),
  'coupler/end',
);
check(
  'a four-digit one, past a thousand duplicates',
  pair(parseAnchorName('anchor_start.1001')),
  '-/start',
);
check('and the other form Blender uses', pair(parseAnchorName('anchor_start###')), '-/start');
// The suffix is bookkeeping, so the result is the same anchor as the plain name.
check(
  'and it is the same anchor as the plain name',
  JSON.stringify(parseAnchorName('anchor_coupler_end.002')),
  JSON.stringify(parseAnchorName('anchor_coupler_end')),
);

// Two connectors of one kind on one model are two anchors, not one -- and
// because they belong to the same placement they are not a joint with each
// other, so both stay free for a neighbouring piece to snap to.
console.log('\n-- a model with two of the same connector keeps both --');
const twin = new Group();
twin.add(empty('anchor_coupler_start', [0, 0, 0]));
twin.add(empty('anchor_coupler_start.001', [2, 0, 0]));
const both = collectAnchors(twin, new Matrix4());
check('both are found', both.length, 2);
check('and they are at their own places', both.map((a) => at(a.position)).join(' '), '0,0,0 2,0,0');
check('with the name the file gave', both[1].name, 'anchor_coupler_start.001');
check(
  'and the same kind',
  `${both[0].group}/${both[0].label} ${both[1].group}/${both[1].label}`,
  'coupler/start coupler/start',
);

console.log('\n-- and the stripping can be refused, for a name that means it --');
// Nothing legitimate here ends in a dot and three digits, so this is a way to
// read the name exactly as written. It no longer decides whether the name is an
// anchor at all -- a label is free, so `start.001` is a perfectly good label --
// it only decides what the label reads.
check('and the number stays in the label', pair(parseAnchorName('anchor_start.001', { blenderSuffix: false })), '-/start.001');
check(
  'and an ordinary name is unaffected either way',
  pair(parseAnchorName('anchor_start', { blenderSuffix: false })),
  '-/start',
);

console.log('\n-- what the stripping must leave alone --');
// A dot and fewer than three digits is not Blender's form, and a name that
// happens to contain a number elsewhere must keep it. Note these are all still
// anchors -- a free label accepts anything -- so what is being checked is that
// the text survives, not that the name is rejected.
check('a short number is kept, not stripped', pair(parseAnchorName('anchor_start.1')), '-/start.1');
check('nor is a number in the group', pair(parseAnchorName('anchor_v2_start')), 'v2/start');
check(
  'a misspelt label is still just a label',
  pair(parseAnchorName('anchor_coupler_stort.001')),
  'coupler/stort',
);
check('a group with a number keeps it', pair(parseAnchorName('anchor_coupler_a001_end')), 'coupler_a001/end');

console.log('\n-- a pivot is the point a model turns about --');
// The gizmo turns a selection about the middle of its box, which is wrong for
// anything with a joint: an adjustable corner is two arms about a shared
// centre, and rotating an arm about its middle swings the pivot instead of
// turning the arm in place. So a model says where it turns, in the same name as
// everything else.
check('a centre is a pivot', isPivot(parseAnchorName('anchor_center')), true);
check('and the strict form of it', isPivot(parseAnchorName('anchor_center_pivot')), true);
check('so is the British spelling', isPivot(parseAnchorName('anchor_centre')), true);
check('and a group called pivot', isPivot(parseAnchorName('anchor_pivot_hub')), true);
// Three tokens is grouped, so this one is a `centre` group with an `arm` on it
// -- which is a pivot, whatever the arm is called. The group says what the
// point is for.
check('and any label in a centre group', isPivot(parseAnchorName('anchor_centre_arm')), true);
check('a coupler is not', isPivot(parseAnchorName('anchor_coupler_start')), false);
check('nor a plain ungrouped label', isPivot(parseAnchorName('anchor_end')), false);
check('and nothing at all', isPivot(null), false);
// A label alone never makes a pivot while a group is stated: it is the group
// that says what the point is for, or a model with a tip labelled "pivot" would
// turn about its tip.
check(
  'a label of pivot in another group is not',
  isPivot(parseAnchorName('anchor_coupler_pivot')),
  false,
);
check(
  'and one on an ungrouped name neither',
  isPivot(parseAnchorName('anchor_tip')),
  false,
);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
