/* eslint-disable no-bitwise */
/**
 * @file Markers at the anchors a model offers, so a join can be aimed at.
 *
 * An anchor is an empty node inside a `.glb`, which means it is invisible from
 * outside: there is nothing on screen to drag towards and nothing in the
 * object browser that says a model can be joined at all. So the free anchors are
 * drawn as small dots, and a live join lights up.
 *
 * **Dots, not handles.** These are not controls -- nothing is dragged, and
 * they say where a connection *is*, not where the object should go. Drawing them
 * as gizmos would invite exactly the interaction the snapping already provides
 * more reliably: drag the piece near the dot.
 *
 * **Pickable, but only for choosing which anchor joins.** The nearest anchor wins
 * by default, and on a dense rig several are in reach at once, so the nearest can
 * be one the user never meant. A click on a dot therefore says *this* anchor is
 * the one to join from, and the drag then aims at it. That is a choice of which
 * anchor, not a handle to pull the object about, which is why the two are kept
 * apart.
 *
 * **One draw call.** A show can hold hundreds of anchors once a rig is
 * assembled, and a mesh per dot would be hundreds of draw calls to draw a
 * hundred pixels. One `Points` with a colour per vertex draws all of them, and
 * the capacity is allocated once.
 *
 * **A fixed pixel size, not a world size.** A dot a few centimetres across is
 * invisible from across a room and enormous up close, and the thing a user needs
 * to see is a marker at all -- so `sizeAttenuation` is off and every dot is the
 * same handful of pixels wherever it is. A view cube in the corner of the
 * viewport solves the same problem the same way.
 *
 * **Spent anchors are not drawn.** A run of five spans has four internal joints,
 * and at each of those two anchors share a point. Showing them would offer four
 * places to snap that cannot be used, so the markers are the free ends only --
 * which is also what makes a run look extendable. See `availableAnchors`.
 */

import {
  BufferGeometry, BufferAttribute, Points, PointsMaterial, Color, AdditiveBlending,
} from 'three';
import SceneManager from './scene_manager';
import { sameAnchor } from './anchor_snap';

/** How many dots may be on screen at once, allocated up front. */
const CAPACITY = 512;

/** A dot, in pixels, whatever the distance. */
const DOT_PIXELS = 7;

/**
 * Colours for a connector system, so a pivot reads differently from a tip.
 *
 * A model may carry several -- an adjustable corner has couplers at its tips and
 * a centre at the middle, and telling those apart at a glance is the whole
 * reason for colour. The group is a closed set in practice, so a small fixed
 * table covers it and a group nobody has seen gets the neutral one rather than
 * a hash, which would make the same group come out a different colour on a
 * different machine and mean nothing.
 */
const GROUP_COLOURS = {
  coupler: 0x35c9a8,
  centre: 0xf2a33c,
  center: 0xf2a33c,
  pipe: 0x8ab4f8,
};

/** For a group with no colour of its own. */
const NEUTRAL_COLOUR = 0xa8b0bd;

/** The colour a join takes while it is being made. */
const JOINED_COLOUR = 0xffffff;

/**
 * The colour an anchor takes when the user has picked it as the one to join.
 *
 * Brighter than the join's white and drawn before it, so a chosen anchor stays
 * visible while a live join is on top of it -- which is the state that matters,
 * since the join covers the anchor that was chosen to make it.
 */
const CHOSEN_COLOUR = 0xffe066;

/** The colour of a connector system, defaulting to the neutral one. */
function colourForGroup(group) {
  if (!group) return NEUTRAL_COLOUR;
  return GROUP_COLOURS[group.toLowerCase()] || NEUTRAL_COLOUR;
}

class AnchorMarkers {
  constructor() {
    this.positions = new Float32Array(CAPACITY * 3);
    this.colours = new Float32Array(CAPACITY * 3);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new BufferAttribute(this.colours, 3));
    // Drawn as points, and only the ones actually filled: the rest of the buffer
    // is left wherever it was and would otherwise appear as dots at the origin.
    this.geometry.setDrawRange(0, 0);
    this.material = new PointsMaterial({
      size: DOT_PIXELS,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      depthTest: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    // Over the scene, not in it: these are an aid, and must not be occluded by
    // the very object whose anchor is behind it.
    this.points.renderOrder = 1000;
    this.points.visible = false;
    this.scratch = new Color();
    this.shown = 0;
  }

  /**
   * Draws markers for the anchors given, and nothing for the rest.
   *
   * @param {Array} anchors free anchors, each `{ position, group }`
   * @param {Object|null} [joined] the live join, `{ moving, target }` from
   *   `nearestJoin`, whose two anchors are drawn white
   * @param {Object|null} [chosen] the anchor the user picked to join from, drawn
   *   in the chosen colour
   */
  show(anchors, joined = null, chosen = null) {
    const free = Array.isArray(anchors) ? anchors : [];
    const joinedAt = joined ? new Set([joined.moving, joined.target]) : null;
    let n = 0;

    const put = (anchor, colour) => {
      if (n >= CAPACITY) return;
      const at = n * 3;
      this.positions[at] = anchor.position.x;
      this.positions[at + 1] = anchor.position.y;
      this.positions[at + 2] = anchor.position.z;
      this.scratch.setHex(colour);
      this.colours[at] = this.scratch.r;
      this.colours[at + 1] = this.scratch.g;
      this.colours[at + 2] = this.scratch.b;
      n += 1;
    };

    // The choice first, then the join: the join covers the anchor it was made
    // from, so the chosen colour has to be underneath it to stay readable.
    if (chosen) put(chosen, CHOSEN_COLOUR);
    if (joinedAt) joinedAt.forEach((anchor) => put(anchor, JOINED_COLOUR));
    free.forEach((anchor) => {
      if (chosen && sameAnchor(anchor, chosen)) return;
      if (joinedAt && joinedAt.has(anchor)) return;
      put(anchor, colourForGroup(anchor.group));
    });

    this.shown = n;
    if (!n) {
      this.points.visible = false;
      return;
    }
    if (!this.points.parent) SceneManager.add(this.points);
    this.points.visible = true;
    this.geometry.setDrawRange(0, n);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  /** Takes the markers off the screen. */
  hide() {
    this.shown = 0;
    this.geometry.setDrawRange(0, 0);
    this.points.visible = false;
  }

  /** @public Releases the geometry and material. */
  dispose() {
    this.hide();
    if (this.points.parent) SceneManager.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

export default AnchorMarkers;
export {
  CAPACITY, DOT_PIXELS, GROUP_COLOURS, NEUTRAL_COLOUR, JOINED_COLOUR, CHOSEN_COLOUR,
};
