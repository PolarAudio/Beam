/* eslint-disable no-console */
/**
 * The transform every placeable scene item shares.
 *
 * `Fixture`, `Structure` and `SceneObject` share one implementation of the
 * per-axis accessors from `scene_item.transform.js`, and each supplies only
 * the step that differs:
 * a fixture pushes to its 3D model, a structure carries its members, an object
 * rewrites its instance matrix.
 *
 * What is checked here is the part that is easy to get wrong when hoisting
 * behaviour into a base: that the shared accessors still read and write the
 * same units, that the per-kind step still fires, and that the guard which
 * rejects a non-finite value is in force for all three.
 *
 * Usage:
 *   npm test
 */
import Controls from '@/plugins/visualizer/controls';
import Fixture from '@/models/DMX/fixture.model';
import Structure from '@/models/DMX/structure.model';
import SceneObject from '@/models/DMX/object.model';
import { SCENE_ITEM_KINDS, readMemberRef, rowId } from '@/models/DMX/scene_item';

// The gizmo is detached around every axis write so its cached handles cannot
// be left where the item no longer is. It needs a live viewport to do that,
// which there is none of here -- and it is not what this test is about. Stubbed
// rather than emulated, the same bargain `bench/shim.cjs` makes for the browser
// globals the model layer touches at import time.
Controls.detach = () => {};
Controls.attach = () => {};

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** Degrees a right angle is worth, to keep the float comparisons exact. */
const RIGHT_ANGLE = 90;

/**
 * Runs the shared contract against one kind.
 *
 * @param {String} label
 * @param {Object} item a constructed scene item
 * @param {String} kind the kind it should report
 */
function checkContract(label, item, kind) {
  console.log(`\n${label}`);
  check('reports its kind', item.kind, kind);
  check('has a uid', typeof item.uid === 'number' || typeof item.uid === 'string', true);

  // Per-axis position, in metres.
  item.posX = 2.5;
  check('posX round-trips', item.posX, 2.5);
  check('posX reached position', item.position.x, 2.5);

  // Per-axis rotation: degrees on the outside, radians within.
  item.rotZ = RIGHT_ANGLE;
  check('rotZ round-trips in degrees', Math.round(item.rotZ), RIGHT_ANGLE);
  check('rotZ stored as radians', Math.round(item.rotationRad.z * 1000) / 1000, 1.571);

  // The non-finite guard, which every kind must have.
  item.posY = 4;
  item.posY = Number.NaN;
  check('a NaN axis is refused, not stored', item.posY, 4);
  item.rotX = Number.NaN;
  check('a NaN angle is refused, not stored', Number.isFinite(item.rotationRad.x), true);
  item.posZ = Number.POSITIVE_INFINITY;
  check('an infinite axis is refused', Number.isFinite(item.posZ), true);

  // The per-kind step has to still run, or the item moves in the model and
  // stays put on screen -- which is the failure a shared base risks causing.
  let applied = 0;
  const original = item.applyTransform.bind(item);
  item.applyTransform = (field) => { applied += 1; return original(field); };
  item.posX = 3;
  check('the per-kind apply step fired', applied, 1);
  item.rotationRad = { x: 0, y: 0, z: 0 };
  check('rotationRad also applies', applied, 2);
}

// `isStub` is the constructor's own escape hatch for a fixture with no profile
// behind it, which is what this needs: the transform is the subject, and a real
// profile would drag in a renderer and a patch. A stub skips the branch that
// builds the transform, though, so
// the two fields are seeded here rather than pretending the class does it.
const stubFixture = new Fixture({ isStub: true });
stubFixture._position = { x: 0, y: 0, z: 0 };
stubFixture._rotation = { x: 0, y: 0, z: 0 };
checkContract('Fixture', stubFixture, SCENE_ITEM_KINDS.FIXTURE);
checkContract('Structure', new Structure({ name: 'test' }), SCENE_ITEM_KINDS.STRUCTURE);
checkContract('SceneObject', new SceneObject({ name: 'test' }), SCENE_ITEM_KINDS.OBJECT);

console.log('\nuids are unique across kinds');
const a = new Structure({ name: 'a' });
const b = new SceneObject({ name: 'b' });
check('a structure and an object never share a uid', a.uid === b.uid, false);

console.log('\na structure names its members by kind, because ids are per kind');
const truss = new Structure({ id: 1, name: 'Truss' });
const member = new Fixture({ isStub: true });
member.id = 3;
// A stub fixture skips the branch that builds its transform, so it is seeded
// here the way `stubFixture` above is -- `add` reads where the member stands.
member._position = { x: 0, y: 0, z: 0 };
member._rotation = { x: 0, y: 0, z: 0 };
// Deliberately the same number the object below carries: a bare id would be
// ambiguous, and the fixture would be the one that got claimed.
const weight = new SceneObject({ id: 3, name: 'Weight' });
truss.add(member);
truss.add(weight);
const refs = truss.showData.members;
check('two members', refs.length, 2);
check('the fixture is named a fixture', `${refs[0].kind}:${refs[0].id}`, 'fixture:3');
check('the object is named an object', `${refs[1].kind}:${refs[1].id}`, 'object:3');

console.log('\nand a show written before that still says what it meant');
// A bare id is a fixture: structures held nothing else until objects could
// be members, so no old record can be about anything but a fixture.
check(
  'a bare id reads as a fixture',
  `${readMemberRef(7).kind}:${readMemberRef(7).id}`,
  'fixture:7',
);
const written = readMemberRef({ kind: 'object', id: 2 });
check('a written ref reads as itself', `${written.kind}:${written.id}`, 'object:2');
// A showfile is a file somebody can edit, so a broken entry is skipped
// rather than resolved to fixture 0.
check('a half-written ref is refused', readMemberRef({ kind: 'object' }), null);
check('a nameless ref is refused', readMemberRef({ id: 3 }), null);
check('nothing at all is refused', readMemberRef(undefined), null);

console.log('\na structure of geometry has no address to order by');
const weights = new Structure({ name: 'Weights' });
weights.add(new SceneObject({ id: 1, name: 'Weight' }));
// Not Infinity: an ordering that sorts it would rather have a number it can
// compare than one that poisons every comparison it takes part in.
check('a structure of objects reports 0', weights.address, 0);
check('and so does an empty one', new Structure({ name: 'empty' }).address, 0);

console.log('\nrow ids stay namespaced, so the two never collide');
check('a fixture row id is the bare number', rowId(SCENE_ITEM_KINDS.FIXTURE, 3), 3);
check('an object row id is prefixed', rowId(SCENE_ITEM_KINDS.OBJECT, 3), 'object:3');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
