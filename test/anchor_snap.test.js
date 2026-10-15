/* eslint-disable no-console */
/**
 * Joining anchors: which pair meets, and what correction makes it so.
 *
 * The rules that decide *whether* two anchors may meet are in
 * `model_anchors.js`. This is the arithmetic that turns a pair of anchors being
 * near each other into a truss being in the right place at the right angle, and
 * it is where the feel of the feature lives: two tolerances, applied in the
 * right order, decide whether snapping helps or fights.
 *
 * So the cases worth testing are not "does it join" -- that is one line in the
 * other module -- but the ones where it must *not*: a truss on the far side of
 * the room at the right angle must not turn to face something it is nowhere
 * near, and a join within reach must not carry a rotation with it.
 *
 * The `world` helper takes its group and its label separately, because that is
 * the shape the rule has: a group says which connector system, a label says
 * which one of those. Getting that distinction wrong in a test makes the file
 * assert things about the code that the code does not say.
 *
 * Usage:
 *   npm test
 */
import {
  Object3D, Vector3, Quaternion, MathUtils,
} from 'three';
import {
  nearestJoin, joinMatrix, anchorsOf, headingOf, shortestTurn, availableAnchors, sameAnchor,
  SNAP_POSITION_TOLERANCE, SNAP_YAW_TOLERANCE,
} from '@/plugins/visualizer/anchor_snap';
import { parseAnchorName } from '@/plugins/visualizer/model_anchors';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

const deg = MathUtils.radToDeg;
const round = (n) => Math.round(n * 1000) / 1000;

/**
 * An anchor already in the world, which is what the search actually reads.
 *
 * `yaw` in degrees anticlockwise about the vertical, so the arithmetic in these
 * tests is the same arithmetic a 90 degree corner is made of. An empty `group`
 * is the wildcard case, so most of these name a group.
 */
const world = (group, label, at, yaw = 0) => ({
  group,
  label,
  name: `anchor_${[group, label].filter(Boolean).join('_')}`,
  position: new Vector3(at[0], at[1], at[2]),
  heading: MathUtils.degToRad(yaw),
});

/** A placement tag, for the anchors-of-a-placement and spent-anchor cases. */
const of = (name) => ({ name });

/** Where a point ended up, rounded so a float reads as the number meant. */
const at = (v) => [round(v.x), round(v.y), round(v.z)].join(',');

console.log('\n-- the two tolerances, and why they differ --');
check('position reach is half a metre', SNAP_POSITION_TOLERANCE, 0.5);
check('turn is allowed within 12 degrees', round(deg(SNAP_YAW_TOLERANCE)), 12);
check('and the turn tolerance is far tighter', SNAP_YAW_TOLERANCE < 0.3, true);

console.log('\n-- a straight span joins without turning --');
{
  // A span already laid with its end at the origin, and a new one's start
  // dropped 0.3 m short of it, pointing exactly the same way. Nothing turns,
  // because a straight connector already agrees with its neighbour.
  const stand = [world('coupler', 'end', [0, 0, 0], 0)];
  const join = nearestJoin([world('coupler', 'start', [-0.3, 0, 0], 0)], stand);
  check('a near pair is found', !!join, true);
  check('and it is the near one', round(join.distance), 0.3);
  check('already square, so no turn', deg(join.turn), 0);
  const moved = join.moving.position.clone().applyMatrix4(joinMatrix(join));
  check('and the start lands on the end', at(moved), '0,0,0');
}

console.log('\n-- a corner straightens into place --');
{
  // A corner's exit is rotated by the change of direction the run has to make,
  // which is `180 - corner angle`: a 90 degree corner exits at 90. The new span
  // is placed near it pointing 84, and the join takes the last 6.
  const stand = [world('coupler', 'end', [0, 0, 0], 90)];
  const join = nearestJoin([world('coupler', 'start', [-0.2, 0.1, 0], 84)], stand);
  check('the pair is found', !!join, true);
  check('and it is the last few degrees', round(deg(join.turn)), 6);
  const moved = join.moving.position.clone().applyMatrix4(joinMatrix(join));
  check('the start lands on the end', at(moved), '0,0,0');
  check('and the run carries on that way', round(deg(join.moving.heading + join.turn)), 90);
}

console.log('\n-- but a corner is never reached by swinging from the wrong way --');
{
  // The same corner, and a span dropped near it pointing along +X -- 90 degrees
  // out. The turn is too large to be trusted, so the piece is drawn into place
  // and left pointing where the user put it. This is what the tight turn
  // tolerance is for, and it is why a corner is placed roughly and then
  // straightened rather than dragged in sideways.
  const stand = [world('coupler', 'end', [0, 0, 0], 90)];
  const join = nearestJoin([world('coupler', 'start', [-0.2, 0.1, 0], 0)], stand);
  check('the pair is still found', !!join, true);
  check('but the turn is refused', join.turn, 0);
  check(
    'and only the position snaps',
    at(join.moving.position.clone().applyMatrix4(joinMatrix(join))),
    '0,0,0',
  );
}

console.log('\n-- the turn pivots about the join, not about the middle --');
{
  const stand = [world('coupler', 'end', [4, 1, 0], 0)];
  const moving = [world('coupler', 'start', [3.7, 0.9, 0], 8)];
  const join = nearestJoin(moving, stand);
  check('the pair is found', !!join, true);
  check('and the turn is taken', round(deg(join.turn)), -8);
  const delta = joinMatrix(join);
  const landed = join.moving.position.clone().applyMatrix4(delta);
  check('the joining anchor reaches the target', at(landed), '4,1,0');
  // The far end of the piece, two metres along its own axis. A slide would carry
  // it with everything else; a pivot swings it about the connection and leaves
  // it the same reach away, which is the claim worth checking.
  const reach = 2;
  const far = new Vector3(
    moving[0].position.x + reach * Math.cos(MathUtils.degToRad(8)),
    moving[0].position.y + reach * Math.sin(MathUtils.degToRad(8)),
    0,
  ).applyMatrix4(delta);
  check(
    'the rest of the piece keeps its reach from the join',
    round(far.distanceTo(landed)),
    reach,
  );
  check('and swings round it rather than going with it', at(far), '6,1,0');
}

console.log('\n-- a near piece at the wrong angle is moved, not turned --');
{
  const stand = [world('coupler', 'end', [0, 0, 0], 0)];
  const join = nearestJoin([world('coupler', 'start', [0.2, 0, 0], 90)], stand);
  check('the pair is still found', !!join, true);
  check('but the turn is dropped', join.turn, 0);
  check(
    'and the position still snaps',
    at(join.moving.position.clone().applyMatrix4(joinMatrix(join))),
    '0,0,0',
  );
}

console.log('\n-- the turn snaps when the piece is nearly square --');
{
  const stand = [world('coupler', 'end', [0, 0, 0], 0)];
  // The target points along +X, so the piece is turned *down* onto it, not up.
  check(
    '8 degrees is straightened',
    round(deg(nearestJoin([world('coupler', 'start', [0.2, 0, 0], 8)], stand).turn)),
    -8,
  );
  check(
    '20 degrees is left alone',
    nearestJoin([world('coupler', 'start', [0.2, 0, 0], 20)], stand).turn,
    0,
  );
  check(
    'and the tolerance is the boundary',
    round(deg(nearestJoin([world('coupler', 'start', [0.2, 0, 0], 12.5)], stand).turn)),
    0,
  );
}

console.log('\n-- out of reach is not a join --');
{
  const stand = [world('coupler', 'end', [0, 0, 0], 0)];
  check(
    'half a metre plus nothing',
    !!nearestJoin([world('coupler', 'start', [0.51, 0, 0], 0)], stand),
    false,
  );
  check(
    'the far side of the room',
    !!nearestJoin([world('coupler', 'start', [20, 0, 0], 0)], stand),
    false,
  );
  check('nothing at all is no join', !!nearestJoin([], []), false);
}

console.log('\n-- the reach is a setting, and it governs the gate --');
{
  // Half a metre is the default, which is what the test above measures against.
  // What matters here is that the caller can narrow it, because on a rig of
  // short pieces half a metre puts several connections in range at once.
  const stand = [world('coupler', 'end', [0, 0, 0], 0)];
  const near = [world('coupler', 'start', [0.3, 0, 0], 0)];
  check(
    '0.3 m is out of reach at a tight setting',
    !!nearestJoin(near, stand, { positionTolerance: 0.2 }),
    false,
  );
  check('and in reach at the default', !!nearestJoin(near, stand), true);
  check(
    'a wider setting reaches further',
    !!nearestJoin([world('coupler', 'start', [1.2, 0, 0], 0)], stand, { positionTolerance: 2 }),
    true,
  );
}

console.log('\n-- an anchor is recognised across a rebuild --');
{
  // The anchors are rebuilt every frame, so a choice has to survive on the
  // placement and the model's own name rather than on the object handed back.
  const placement = of('span');
  const before = { ...world('coupler', 'end', [0, 0, 0], 0), placement };
  const after = { ...world('coupler', 'end', [0, 0, 0], 0), placement };
  check('the same anchor, rebuilt, is the same', sameAnchor(before, after), true);
  check(
    'a different placement is not',
    sameAnchor(before, { ...after, placement: of('other') }),
    false,
  );
  check(
    'nor a different side of the same piece',
    sameAnchor(before, { ...after, side: 'start', name: 'anchor_coupler_start' }),
    false,
  );
  check('and nothing at all is not either', sameAnchor(before, null), false);
}

console.log('\n-- any side of a system meets any other --');
// The rule the first attempt got wrong. Sides were made complementary -- an end
// joins a start and never another end -- on the reasoning that a run joined end
// to end would stack on one end. That is true of a straight run and useless for
// real rigging, where a three- or four-way corner cannot be expressed by a
// two-sided rule at all.
{
  const at0 = [0, 0, 0];
  const near = [0.1, 0, 0];
  check('an end meets an end', !!nearestJoin([world('coupler', 'end', near)], [world('coupler', 'end', at0)]), true);
  check('a start meets a start', !!nearestJoin([world('coupler', 'start', near)], [world('coupler', 'start', at0)]), true);
  check('a north meets a west', !!nearestJoin([world('coupler', 'north', near)], [world('coupler', 'west', at0)]), true);
  check(
    'which is how a four-way corner is built',
    !!nearestJoin([world('coupler', 'north', near)], [world('coupler', 'east', at0)]),
    true,
  );
  check(
    'and the two halves of an adjustable corner',
    !!nearestJoin([world('center', 'pivot', near)], [world('center', 'pivot', at0)]),
    true,
  );
}

console.log('\n-- but a system is still a system --');
{
  const at0 = [0, 0, 0];
  const near = [0.1, 0, 0];
  check(
    'a pipe does not meet a coupler',
    !!nearestJoin([world('pipe', 'start', near)], [world('coupler', 'end', at0)]),
    false,
  );
  check(
    'a pivot is not a coupler',
    !!nearestJoin([world('center', 'pivot', near)], [world('coupler', 'end', at0)]),
    false,
  );
}

console.log('\n-- and an anchor with no group will meet anything --');
// The forgiving reading, and the useful one: a speaker that says `anchor_end`
// means "wherever I hang from", without having to know what the truss above it
// calls its connectors.
{
  const at0 = [0, 0, 0];
  const near = [0.1, 0, 0];
  check(
    'an ungrouped anchor joins a coupler',
    !!nearestJoin([world('', 'end', near)], [world('coupler', 'end', at0)]),
    true,
  );
  check('and a pipe', !!nearestJoin([world('', 'end', near)], [world('pipe', 'end', at0)]), true);
  check('and a pivot', !!nearestJoin([world('', 'end', near)], [world('center', 'pivot', at0)]), true);
}

console.log('\n-- a run of spans offers only its two ends --');
// The multi-selection question, and it needs no special case: five spans laid end
// to start make four internal joints, and at each of those two anchors occupy
// the same point and are therefore spent.
const run = (count, length = 2) => {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const placement = of(`span ${i}`);
    out.push({ ...world('coupler', 'start', [i * length, 0, 0]), placement });
    out.push({ ...world('coupler', 'end', [(i + 1) * length, 0, 0]), placement });
  }
  return out;
};
check('five spans, ten anchors, four joints', run(5).length, 10);
check('and only the two ends are free', availableAnchors(run(5)).length, 2);
check(
  'the free ones are the first start and the last end',
  availableAnchors(run(5)).map((a) => `${a.label}@${a.position.x}`).join(' '),
  'start@0 end@10',
);
check('two spans offer two ends', availableAnchors(run(2)).length, 2);
check('one span offers both of its own', availableAnchors(run(1)).length, 2);

console.log('\n-- a piece lying across a truss is not a joint --');
{
  // A truss with a pivot, and a span dropped over it so its start lands exactly
  // on that pivot. Different groups, so the two are not a connection -- and a
  // rule that went on coincidence alone would mark both spent and quietly take a
  // free end away. The span is placed so its far end clears the truss's, or the
  // two couplers would coincide and *would* be a joint, which is the point of
  // the next check.
  const truss = of('truss');
  const dropped = of('span');
  const all = [
    { ...world('coupler', 'start', [0, 0, 0]), placement: truss },
    { ...world('center', 'pivot', [2, 0, 0]), placement: truss },
    { ...world('coupler', 'end', [4, 0, 0]), placement: truss },
    { ...world('coupler', 'start', [2, 0, 0]), placement: dropped },
    { ...world('coupler', 'end', [6, 0, 0]), placement: dropped },
  ];
  check('a pivot is not a coupler, so nothing is spent', availableAnchors(all).length, 5);

  // With every side meeting every other, two couplers on top of each other *are*
  // a joint. That is the stacking the user asked for: a run is assembled end to
  // whatever the labels happen to say, and reversing a piece is allowed.
  const stacked = [
    { ...world('coupler', 'start', [0, 0, 0]), placement: truss },
    { ...world('coupler', 'end', [4, 0, 0]), placement: truss },
    { ...world('coupler', 'start', [4, 0, 0]), placement: dropped },
    { ...world('coupler', 'end', [6, 0, 0]), placement: dropped },
  ];
  check(
    'but a shared end is a joint',
    availableAnchors(stacked).map((a) => `${a.placement.name} ${a.label}`).join(' '),
    'truss start span end',
  );
}

console.log('\n-- how near is near enough to be a joint --');
{
  const a = of('a');
  const b = of('b');
  const pair = (gap) => availableAnchors([
    { ...world('coupler', 'start', [0, 0, 0]), placement: a },
    { ...world('coupler', 'end', [gap, 0, 0]), placement: b },
  ]);
  check('touching is a joint', pair(0).length, 0);
  check('a centimetre apart is a joint', pair(0.01).length, 0);
  // Past the joint tolerance but still well inside the snap reach, so a gap can
  // be close enough to be closed by a drag and still not be a joint yet. The two
  // tolerances are deliberately not the same number.
  check('five centimetres is not a joint yet', pair(0.05).length, 2);
  check('a full span apart is not', pair(2).length, 2);
  check('and the tolerance is settable', availableAnchors([
    { ...world('coupler', 'start', [0, 0, 0]), placement: a },
    { ...world('coupler', 'end', [0.4, 0, 0]), placement: b },
  ], 0.5).length, 0);
}

console.log('\n-- of several candidates, the nearest wins --');
{
  const stand = [
    world('coupler', 'end', [1.4, 0, 0]),
    world('coupler', 'end', [0.1, 0, 0]),
  ];
  const join = nearestJoin([world('coupler', 'start', [0, 0, 0])], stand);
  check('the closer end is the one joined', join.target.position.x, 0.1);
}

console.log('\n-- and where two are equally near, the squarer --');
{
  const stand = [
    world('coupler', 'end', [0.1, 0.1, 0], 40),
    world('coupler', 'end', [0.1, 0.1, 0], 4),
  ];
  const join = nearestJoin([world('coupler', 'start', [0, 0, 0], 0)], stand);
  check('the squarer one is joined', round(deg(join.turn)), 4);
}

console.log('\n-- the turn is the short way round --');
// Heading is measured anticlockwise, so 350 degrees ahead is 10 degrees back.
check('350 degrees ahead is 10 back', round(deg(shortestTurn(0, MathUtils.degToRad(350)))), -10);
check('and 10 the other way is -10', round(deg(shortestTurn(0, MathUtils.degToRad(-10)))), -10);
check('straight on is no turn', deg(shortestTurn(MathUtils.degToRad(45), MathUtils.degToRad(45))), 0);
check('half a turn is a half a turn', round(deg(shortestTurn(0, Math.PI))), 180);

console.log('\n-- reading a heading off a rotation --');
const identity = new Quaternion();
const quarter = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
// Order of composition must not matter, which is why a direction is read rather
// than an Euler triple.
const halfThenQuarter = new Quaternion()
  .setFromAxisAngle(new Vector3(0, 1, 0), Math.PI)
  .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2));
check('identity points along +X', round(deg(headingOf(identity))), 0);
check('a quarter turn about the vertical is 90', round(deg(headingOf(quarter))), 90);
check('a heading does not depend on Euler order', round(deg(headingOf(halfThenQuarter))), 90);

console.log('\n-- anchors of a placement, carried into the world --');
{
  const node = new Object3D();
  node.position.set(5, 0, 1);
  node.rotation.set(0, 0, MathUtils.degToRad(30));
  node.updateMatrixWorld();
  const placement = {
    owner: { transformNode: node },
    model: {
      anchors: [
        {
          ...parseAnchorName('anchor_coupler_start'),
          name: 'anchor_coupler_start',
          position: new Vector3(0, 0, 0),
          rotation: new Quaternion(),
        },
        {
          ...parseAnchorName('anchor_coupler_end'),
          name: 'anchor_coupler_end',
          position: new Vector3(2, 0, 0),
          rotation: new Quaternion(),
        },
      ],
    },
  };
  const found = anchorsOf(placement);
  check('both anchors come through', found.length, 2);
  check('the start is at the placement', `${found[0].position.x},${found[0].position.z}`, '5,1');
  // The end is 2 m along the placement's own +X, turned 30 degrees.
  check(
    'the end is placed along the turned axis',
    `${round(found[1].position.x)},${found[1].position.z}`,
    `${round(5 + 2 * Math.cos(Math.PI / 6))},1`,
  );
  check('and it turned with the placement', round(deg(found[1].heading)), 30);
  check('a placement with no model yields none', anchorsOf({}).length, 0);
  check('and a model with no anchors yields none', anchorsOf({ model: {} }).length, 0);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
