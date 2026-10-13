/* eslint-disable no-bitwise */
/**
 * @file Anchors: the labelled empty nodes in a model, and which of them join.
 *
 * A model marks its own connection points by naming a node that has no mesh.
 * glTF has no first-class anchor -- a node with no `mesh` is how an exporter
 * writes one -- and Beam already carries such nodes and throws them away. A
 * Blender empty arrives as a bare `Object3D` with a name and a full transform,
 * and `scene_objects.js` collects them into the model record here.
 *
 * **Why the name has to carry the meaning.** glTF gives a node an arbitrary
 * string, so a meshless node could be anything. Two of the three kinds in this
 * codebase are demonstrably not anchors: `moving_head_assembly` is the group
 * whose three children are a moving head's base, head and yoke, and `Light` and
 * `Camera` are the scene's own camera and light dragged out of the `.blend` it
 * was exported from. So a node is only an anchor if it says so, and saying so
 * starts the name with `anchor_`.
 *
 * **What follows the prefix is a group and a label, and neither has a fixed
 * meaning.** A group says which connector system it is -- `coupler`, `pipe`,
 * `centre` for a pivot -- and a label says which one of those it is, so a
 * four-way corner can be `anchor_coupler_north` / `_east` / `_south` / `_west`
 * and every one of them joins every one of another piece's.
 *
 * **All sides join all sides.** This was the rule to get right and it took two
 * attempts. The first made sides *complementary* -- an end joins a start and
 * never another end -- on the reasoning that a run of spans joined end to end
 * would stack on one end. That is true of a straight run and irrelevant to real
 * rigging: a three-way or four-way corner cannot be expressed by two-sided rules
 * at all, and truss is multi-directional, so a connector has no fixed "away
 * from the body" that could decide the question. A compatibility rule between
 * labels is therefore the wrong shape for the problem. The label is for the
 * user to read; the group is what decides what may meet.
 *
 * **A group with no group matches anything.** A model may leave the group out
 * -- `anchor_end` -- and such an anchor joins both a coupler and a centre. That
 * is the forgiving reading and it is the useful one: a speaker hung under a
 * truss should be able to say `anchor_end` and mean "wherever I hang from",
 * rather than have to know what the thing above it calls its connectors. A
 * group that *is* stated is respected, which is what keeps a pipe from joining a
 * coupler.
 *
 * **An anchor points the way the run continues.** The empty's own rotation is
 * the turn the *incoming* piece has to make to line up there, so the piece being
 * dragged rotates to match the piece that is standing still. A straight span's
 * empties are unrotated and nothing turns. A corner's exit is rotated by the
 * change of direction, which is `180 - corner angle` because the two arms of a
 * 45 degree corner are 45 degrees apart but the run swings 135.
 *
 * Turn is applied about the room's vertical only. Tilting a truss is a separate
 * move from turning it, and turning in three axes would fight a gizmo that is
 * axis-constrained to begin with.
 *
 * All of this is pure and deliberately separate from the loader, so the rule
 * can be tested without a GPU, a scene, or a file.
 */

import { Vector3, Quaternion, Matrix4 } from 'three';

/** What a name must begin with to be an anchor at all. */
const ANCHOR_PREFIX = 'anchor';

/**
 * Groups whose anchor is a point the model *turns about*.
 *
 * The gizmo rotates a selection about the middle of its bounding box, which is
 * right for everything that has fixed shape and wrong for anything that has a
 * joint. An adjustable corner is two arms about a shared `anchor_center`: the
 * pivot is at one end of each arm, so rotating it about the middle swings the
 * pivot away instead of turning the arm in place.
 *
 * Spelling the pivot in the same name as everything else means it needs no
 * separate authoring and no extra field in the sidecar -- a model that turns
 * about a point already says so, because it has an anchor there.
 *
 * Both spellings are accepted because both are in common use, and `pivot` is
 * there for a model that turns about something that is not its middle.
 */
const PIVOT_GROUPS = ['centre', 'center', 'pivot'];

/**
 * Whether an anchor is a point its model turns about.
 *
 * The group is what says what the point is *for*, so a group named here is a
 * pivot whatever its label is -- `anchor_center_pivot` and `anchor_center_hub`
 * are both the same thing. Where no group is stated the label is all there is,
 * so `anchor_center` is one too, having been written in the two-word form.
 *
 * A label is never enough while a group *is* stated, or a coupler with a tip
 * labelled `pivot` would turn about its tip.
 *
 * @param {Object} anchor `{ group, label }`
 * @returns {Boolean}
 */
export function isPivot(anchor) {
  if (!anchor) return false;
  const group = String(anchor.group || '').toLowerCase();
  if (group) return PIVOT_GROUPS.includes(group);
  return PIVOT_GROUPS.includes(String(anchor.label || '').toLowerCase());
}

/** Separators a name may use, so `anchor-start` and `anchor start` both read. */
const SEPARATORS = /[-_\s]+/;

/**
 * Blender's duplicate suffix, which comes off the end of the name.
 *
 * **Blender will not let two objects share a name.** It makes them unique by
 * appending `.001`, and names its data blocks the same way, so a truss carrying
 * two `anchor_coupler_start` empties has `anchor_coupler_start` and
 * `anchor_coupler_start.001` -- and without this the second is not an anchor at
 * all, because the suffix lands on the side and `start.001` is not a side.
 *
 * That is a silent failure with a nasty shape. A model with two identical
 * connectors works with one of them, and there is nothing on screen to say so.
 * The user cannot avoid it either: it is not a naming mistake to fix, it is
 * Blender refusing to let them type the same name twice.
 *
 * The number is bookkeeping, not meaning. The second connector is the same kind
 * of connector as the first; what tells them apart is where they sit, and that
 * is read from the transform. So the suffix is stripped, on by default.
 *
 * A dot and three or more digits, which is Blender's form, or a run of hashes.
 * Three digits rather than any number, because a name ending `.1` is a
 * different thing from one ending `.001` and nothing legitimate here does.
 */
const BLENDER_SUFFIX = /(?:\.\d{3,}|#+)$/;

/**
 * Reads an anchor out of a node's name.
 *
 * Accepts the name a glTF carried rather than the one three.js settled on.
 * `GLTFLoader` puts the original in `userData.name` and the sanitised, and
 * uniquified, form in `name` -- so two nodes both called `anchor_start` become
 * `anchor_start` and `anchor_start_1`, and only the former is worth matching.
 * That is the *loader's* numbering. Blender's own, which arrives in
 * `userData.name` intact, is stripped by `BLENDER_SUFFIX` above.
 *
 * @param {String} name the node's name from the file
 * @param {Object} [options]
 * @param {Boolean} [options.blenderSuffix=true] keep Blender's `.001` on the
 *   end, which makes such a name not an anchor
 * @returns {{group: String, side: String}|null} null when the name is not an
 *   anchor, which is the answer for a group, for a camera, and for `anchor`
 *   on its own
 */
export function parseAnchorName(name, options = {}) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return null;
  const text = options.blenderSuffix === false ? raw : raw.replace(BLENDER_SUFFIX, '');

  // Split on separators, so the prefix and the tokens around it are all that
  // matters and the case of none of it does.
  const tokens = text.split(SEPARATORS).filter(Boolean);
  if (!tokens.length) return null;
  if (tokens[0].toLowerCase() !== ANCHOR_PREFIX) return null;

  // Something must follow the prefix, or the name says nothing at all. A bare
  // `anchor` is not one.
  if (tokens.length < 2) return null;

  // With two tokens the last is the label, and there is no group. With three or
  // more, the middle is the group and the last the label -- so a group of two
  // words is written the same either way.
  const label = tokens[tokens.length - 1].toLowerCase();
  const group = tokens.slice(1, -1).join('_').toLowerCase();

  return { group, label };
}

/**
 * Whether two anchors are meant to meet.
 *
 * **The group decides, and nothing else does.** A coupler never meets a pipe.
 * Within a group, every anchor meets every other, which is what a three-way or
 * four-way corner needs: it has three or four labelled anchors and each of them
 * is a place another piece can go.
 *
 * An anchor with no group meets anything, which is the forgiving reading and the
 * useful one -- a speaker that says `anchor_end` means "wherever I hang from"
 * without having to know what the truss above calls its connectors.
 *
 * @param {{group: String, label: String}} a
 * @param {{group: String, label: String}} b
 * @returns {Boolean}
 */
export function anchorsJoin(a, b) {
  if (!a || !b) return false;
  if (!a.group || !b.group) return true;
  return a.group === b.group;
}

/** Scratch, so collecting a model's anchors allocates nothing. */
const scratch = { matrix: new Matrix4(), position: new Vector3(), rotation: new Quaternion() };

/**
 * The name a node carried in its file, rather than the one three.js gave it.
 *
 * `GLTFLoader` sets `name` to a sanitised and uniquified form and keeps the
 * original in `userData.name` -- so two nodes both called `anchor_start` in one
 * model arrive as `anchor_start` and `anchor_start_1`, and only the first would
 * ever be recognised if the sanitised name were the one read.
 *
 * @param {Object} node any Object3D
 * @returns {String} the original name, falling back to three's
 */
function originalName(node) {
  return (node.userData && node.userData.name) || node.name || '';
}

/**
 * Walks a loaded model and returns its anchors, in corrected model space.
 *
 * **Meshless named nodes are the anchors.** An empty has no geometry, and
 * `scene_objects.js` flattens geometry, so without this the two would never
 * meet: a Blender empty is in the file and gone from the renderer. Bones are
 * skipped for the same reason -- they are a meshless node that means something
 * else entirely.
 *
 * **An anchor is a position and a turn.** The turn is the empty's own rotation,
 * and it is what the *incoming* piece must make to line up there -- so the piece
 * being dragged rotates to match the piece standing still. A straight span's
 * empties are unrotated and nothing turns. A corner's exit is rotated by the
 * change of direction, so the run carries on around it.
 *
 * An author who leaves the empty unrotated still gets the right answer for a
 * straight run, which is the common case: an unrotated anchor simply carries
 * the model's own frame, and a truss along its own length already agrees with
 * its neighbour.
 *
 * Both the position and the turn go through the same matrix that bakes the
 * geometry, so a model's `scale`, `upAxis` and `offset` corrections land on its
 * anchors for free. A model authored in millimetres then has its connections in
 * the same wrong place as its geometry, which is at least consistently wrong and
 * is fixed by editing one number in one sidecar.
 *
 * @param {Object} root the loaded scene, any Object3D
 * @param {Object} fix THREE.Matrix4 from `scene_objects.js`'s `correction`
 * @returns {Array} `{ name, group, label, position, rotation }`
 */
export function collectAnchors(root, fix) {
  const anchors = [];
  if (!root) return anchors;
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    if (node === root || node.isMesh || node.isBone) return;
    const named = parseAnchorName(originalName(node));
    if (!named) return;
    scratch.matrix.copy(fix).multiply(node.matrixWorld);
    anchors.push({
      name: originalName(node),
      group: named.group,
      label: named.label,
      position: new Vector3().setFromMatrixPosition(scratch.matrix),
      // Decomposed off the same matrix, so the direction is in the room's frame
      // and not the file's. A placement then only has to apply its own
      // transform on top to bring it into the world.
      rotation: new Quaternion().setFromRotationMatrix(scratch.matrix),
    });
  });
  return anchors;
}

/**
 * A name for an anchor, for a readout or a marker.
 *
 * @param {{group: String, label: String}} anchor
 * @returns {String}
 */
export function anchorLabel(anchor) {
  if (!anchor) return '';
  return anchor.group ? `${anchor.group} ${anchor.label}` : anchor.label;
}

export { ANCHOR_PREFIX, PIVOT_GROUPS };
