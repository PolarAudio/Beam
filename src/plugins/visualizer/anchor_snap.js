/* eslint-disable no-bitwise */
/**
 * @file Joining two models' anchors: which pair meets, and the correction.
 *
 * The decision of *whether* two anchors may meet is in `model_anchors.js`, which
 * knows the naming convention. This is the rest: given the anchors of the thing
 * being dragged and the anchors of everything else in the room, find the pair
 * that should join, and work out the transform that makes it so.
 *
 * **Position and turn snap independently, and that is deliberate.** Sharing one
 * tolerance is what makes snapping get switched off: drag a truss within half a
 * metre of a neighbour and a single rule spins it a quarter turn, which feels
 * like the program fighting you. So a pair has to be *near* before it counts,
 * and once near, the turn is applied only if the two are already nearly square.
 * A truss dropped 30 cm away at the right angle gets straightened; a truss
 * dropped 30 cm away at the wrong angle gets moved but keeps its heading, and
 * the user rotates it with the gizmo afterwards. Both outcomes are the least
 * surprising thing available.
 *
 * The second thing that follows from it: a corner is not reached by swinging a
 * piece round from the wrong way. A truss pointing along +X will not be turned
 * to make a 90 degree corner, because that is the case where the turn is too
 * large to be trusted. It has to be placed roughly pointing the right way first,
 * and the join straightens it. Which is how a corner gets built in practice, and
 * it is why the tolerance can be as tight as it is.
 *
 * **Turn is about the room's vertical, and only about it.** Tilting a truss is a
 * different move from turning it, and a gizmo that is axis-constrained to begin
 * with (`controls.js`) should not be fought on two axes at once. The heading is
 * therefore read as a single angle from a direction rather than extracted from
 * an Euler, which is what makes it independent of rotation order.
 *
 * Everything here is pure arithmetic over three's maths types, so the rules can
 * be tested without a scene, a GPU, or a file.
 */

import {
  Vector3, Quaternion, Matrix4, MathUtils,
} from 'three';
import { anchorsJoin } from './model_anchors';

/**
 * How close, in metres, two anchors must be before they count as meeting.
 *
 * Generous on purpose, and the same order as the grid's default spacing: the
 * point of a snap is to save a fine adjustment, not to demand one.
 */
export const SNAP_POSITION_TOLERANCE = 0.5;

/**
 * How near square, in degrees, two anchors must already be before the turn is
 * applied.
 *
 * Tight on purpose. This is the difference between straightening a truss the
 * user has already lined up and hijacking one they have not.
 */
export const SNAP_YAW_TOLERANCE = MathUtils.degToRad(12);

/** The direction an anchor declares: its own +X, turned by its rotation. */
const AXIS_X = new Vector3(1, 0, 0);

/**
 * The angle an anchor points at, measured about the room's vertical.
 *
 * Read off a direction rather than pulled out of an Euler triple, so the answer
 * does not depend on the order somebody happened to compose in. A quarter turn
 * is a quarter turn whichever way round it was written.
 *
 * @param {Quaternion} rotation the anchor's own rotation
 * @returns {Number} radians, anticlockwise about +Z
 */
export function headingOf(rotation) {
  const x = AXIS_X.clone().applyQuaternion(rotation);
  return Math.atan2(x.y, x.x);
}

/**
 * The shortest signed turn from one heading to another.
 *
 * @param {Number} from radians
 * @param {Number} to radians
 * @returns {Number} radians in (-PI, PI]
 */
export function shortestTurn(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/**
 * An anchor carried into the world, for comparing against other objects.
 *
 * The position goes through the placement's matrix and the heading is the
 * placement's own turn added to the anchor's -- rotation composing by
 * multiplication, which is correct in any order and needs no Euler to say so.
 *
 * @param {Object} anchor a model-space anchor from the model record
 * @param {Object} placement a placement from `place`
 * @returns {Object|null} `{ group, side, name, position, heading }`
 */
export function worldAnchor(anchor, placement) {
  const owner = placement && placement.owner;
  const node = owner && owner.transformNode;
  if (!node) return null;
  node.updateMatrixWorld();
  const position = anchor.position.clone().applyMatrix4(node.matrixWorld);
  const rotation = new Quaternion().setFromRotationMatrix(node.matrixWorld)
    .multiply(anchor.rotation);
  return {
    group: anchor.group,
    side: anchor.side,
    name: anchor.name,
    position,
    heading: headingOf(rotation),
  };
}

/**
 * Every anchor of a placement, in the world.
 *
 * @param {Object} placement a placement from `place`
 * @returns {Array} see `worldAnchor`
 */
export function anchorsOf(placement) {
  const model = placement && placement.model;
  if (!model || !model.anchors) return [];
  return model.anchors
    .map((anchor) => worldAnchor(anchor, placement))
    .filter(Boolean);
}

/**
 * How near, in metres, two anchors must be before they count as already joined.
 *
 * A connection puts two anchors in the same place, so coincident is what joined
 * looks like from the outside. A couple of centimetres is tight enough that two
 * things merely overlapping do not read as a connection, and loose enough to
 * forgive the millimetre of error a chain of five spans accumulates.
 */
export const JOIN_EPSILON = 0.02;

/**
 * The anchors still free to join something.
 *
 * **A run of spans only has two ends, and this is how it knows.** Five pieces
 * already laid out make four internal joints, and at each joint two anchors
 * occupy the same point. Those are spent. What is left is the first span's
 * `start` and the last span's `end` -- which are the only two places another
 * piece can sensibly be added, and the reason a run is extended from either end
 * rather than dropped in the middle of itself.
 *
 * It also settles the one selection question there is: no separate rule for a
 * single object, because a lone piece has nothing coincident with it and every
 * anchor it has is free. What a selection brings to a drag is only the anchors
 * the rest of the room has not already used.
 *
 * The test is against every anchor in the room rather than the selection alone,
 * because an anchor sitting exactly on another one has been joined whether or
 * not the thing it is joined to happens to be selected. The cost is that two
 * objects placed in exactly the same spot cannot be snapped together, which is
 * rare, and the way out is to move one a little.
 *
 * **Coincidence is not enough on its own -- they have to be able to join.** A
 * truss's `anchor_center` and a span's `anchor_start` can easily land on the
 * same point, since a piece dropped over a truss lands over all of it. A
 * centre joins only a centre, so those two are not a connection, and treating
 * them as one would quietly mark a perfectly good free end as spent.
 *
 * @param {Array} anchors every anchor in the room, each tagged with its `placement`
 * @param {Number} [epsilon] metres; see `JOIN_EPSILON`
 * @returns {Array} the ones with nothing joined to them
 */
export function availableAnchors(anchors, epsilon = JOIN_EPSILON) {
  return anchors.filter((anchor) => !anchors.some((other) => other !== anchor
    // Two anchors of one placement coincide only if the model says so, which is
    // not a connection to anything.
    && other.placement !== anchor.placement
    && anchorsJoin(anchor, other)
    && anchor.position.distanceTo(other.position) <= epsilon));
}

/**
 * Finds the pair of anchors that should meet, and the correction that joins them.
 *
 * Every complementary pair within range is considered, and the nearest wins;
 * where two are equally near, the more nearly square wins, because that is the
 * one the user was obviously aiming at.
 *
 * @param {Array} moving the dragged object's anchors, in the world
 * @param {Array} candidates every other object's anchors, in the world
 * @param {Object} [options] `positionTolerance`, `yawTolerance`
 * @returns {Object|null} `{ moving, target, distance, turn }`, or null when
 *   nothing is in range
 */
export function nearestJoin(moving, candidates, options = {}) {
  const reach = options.positionTolerance === undefined
    ? SNAP_POSITION_TOLERANCE : options.positionTolerance;
  const square = options.yawTolerance === undefined
    ? SNAP_YAW_TOLERANCE : options.yawTolerance;

  let best = null;
  moving.forEach((from) => {
    candidates.forEach((to) => {
      if (!anchorsJoin(from, to)) return;
      const distance = from.position.distanceTo(to.position);
      // Near, or not at all. The turn is considered only inside this gate, so a
      // truss in the right attitude on the far side of the room is not turned
      // to face something it is nowhere near.
      if (distance > reach) return;
      const turn = shortestTurn(from.heading, to.heading);
      if (best
        && (best.distance < distance
          || (best.distance === distance && Math.abs(best.turn) <= Math.abs(turn)))) {
        return;
      }
      best = {
        moving: from, target: to, distance, turn,
      };
    });
  });

  if (!best) return null;
  // The gate got us here; the turn is applied only if it is already nearly
  // square, so a position snap never carries a rotation with it.
  if (Math.abs(best.turn) > square) best.turn = 0;
  return best;
}

/**
 * The transform that makes a join true, as a correction to premultiply.
 *
 * Turn first, about the point being joined to, so the object pivots around the
 * connection the way a hand would rather than swinging about its own middle.
 * Then whatever translation is left over, measured after the turn -- which is
 * how a piece dropped short of the join is drawn in.
 *
 * @param {Object} join from `nearestJoin`
 * @returns {Matrix4}
 */
export function joinMatrix(join) {
  const pivot = join.target.position.clone();
  const delta = new Matrix4()
    .makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new Matrix4().makeRotationZ(join.turn))
    .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));

  // Whatever is left over after the turn, which is the whole of the correction
  // when there was no turn at all. Measured *after* the turn, so a piece dropped
  // short of the join is drawn in rather than left swinging around it.
  const turned = join.moving.position.clone().applyMatrix4(delta);
  delta.premultiply(new Matrix4().makeTranslation(
    pivot.x - turned.x,
    pivot.y - turned.y,
    pivot.z - turned.z,
  ));
  return delta;
}
