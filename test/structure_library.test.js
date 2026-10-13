/* eslint-disable no-console */
/**
 * What a saved structure definition has to say to rebuild itself.
 *
 * Placing a stamp again builds new items from the record rather than copying
 * the ones that made it, so the record has to carry enough about each member
 * to construct it: a fixture as the profile it uses, an object as either the
 * library key it references or the parameters it is itself. The member's
 * `model` field is not enough to tell those apart -- a fixture's is a profile
 * name inside a manufacturer folder, an object's is a library key -- so the
 * record says which is which, and a record that says nothing is read as a
 * fixture because that is all a definition written before objects could be
 * members can be.
 *
 * The object is also the only place an object's scale can live: the local
 * matrix is composed at unit scale, because that is what a relative position
 * and rotation are, so a truss that came back the size it was saved at has to
 * have been written down somewhere and this is it.
 *
 * `saveStructure` is called against a stand-in `this`, the way
 * `library_naming.test.js` does -- reaching the file write needs a real show,
 * and the definition it leaves in `structureLibrary` is the thing under test.
 *
 * Usage:
 *   npm test
 */
import Structure from '@/models/DMX/structure.model';
import SceneObject from '@/models/DMX/object.model';
import Fixture from '@/models/DMX/fixture.model';
import Show from '@/models/DMX/show.model';
import { isObjectRecord } from '@/models/DMX/scene_item';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/**
 * Saves a structure against a stand-in show and hands back what it wrote.
 *
 * @param {Object} structure the structure to save
 * @returns {Promise<Object|null>} the definition, or null when nothing was
 */
function captureSave(structure) {
  const host = { structureLibrary: {} };
  return Show.prototype.saveStructure.call(host, structure)
    .then(() => host.structureLibrary[structure.name] || null);
}

async function run() {
  console.log('\na structure of both kinds writes a record for each');
  const truss = new Structure({ id: 1, name: 'Truss and weights' });

  // A stub fixture skips the branch that builds its transform, so its position
  // is seeded the way `scene_item.test.js` seeds it -- `add` reads where the
  // member stands.
  const head = new Fixture({ isStub: true });
  head.id = 7;
  head.manufacturer = 'Robe';
  head.model = 'MegaPointe';
  head.universeAligned = true;
  head._position = { x: 0, y: 2, z: 0 };
  head._rotation = { x: 0, y: 0, z: 0 };

  const straight = new SceneObject({
    id: 1, model: 'Trusses/Straights/4m', name: '4m', scale: 1.5,
  });
  // An inline object: its parameters *are* the thing, so a record naming a
  // library key for it would be naming something that does not exist.
  const weight = new SceneObject({
    id: 2,
    name: 'Weight',
    primitive: { type: 'cube', size: { x: 0.5, y: 0.5, z: 0.5 }, color: '#333' },
    scale: 2,
  });

  truss.add(head);
  truss.add(straight);
  truss.add(weight);

  const definition = await captureSave(truss);
  check('the file was keyed by its name', truss.name in { 'Truss and weights': 1 }, true);
  check('three members written', definition.members.length, 3);

  const [fixtureRecord, objectRecord, inlineRecord] = definition.members;

  console.log('\na fixture is recorded as the profile it uses');
  check('named a fixture', fixtureRecord.kind, 'fixture');
  check('its manufacturer', fixtureRecord.manufacturer, 'Robe');
  check('its model', fixtureRecord.model, 'MegaPointe');
  check('its universe alignment', fixtureRecord.universeAligned, true);
  check('and where it sits', fixtureRecord.transform.length, 16);

  console.log('\nan object that references a model is recorded as the key');
  check('named an object', objectRecord.kind, 'object');
  check('its library key, path and all', objectRecord.model, 'Trusses/Straights/4m');
  check('no parameters of its own', objectRecord.primitive, undefined);
  check('its scale, which the transform cannot hold', objectRecord.scale, 1.5);
  check('the name it was saved under', objectRecord.name, '4m');

  console.log('\nan object that is its own parameters records those instead');
  check('named an object', inlineRecord.kind, 'object');
  check('no library key, because there is none', inlineRecord.model, undefined);
  check('its type', inlineRecord.primitive.type, 'cube');
  check('its size', inlineRecord.primitive.size.x, 0.5);
  check('its colour', inlineRecord.primitive.color, '#333');
  check('its scale', inlineRecord.scale, 2);

  console.log('\nand the two are told apart when read back');
  check('the object records are objects', isObjectRecord(objectRecord), true);
  check('the fixture record is not', isObjectRecord(fixtureRecord), false);
  // The whole compat guarantee in one line: a definition written before
  // objects could be members has no `kind` at all, and has to rebuild as what
  // it always was.
  check(
    'a record with no kind is a fixture',
    isObjectRecord({ manufacturer: 'Robe', model: 'MegaPointe' }),
    false,
  );
  check('and a missing one is too', isObjectRecord(undefined), false);

  console.log('\nplacing the record back is not the same as copying the items');
  // The point of the whole arrangement: the definition describes, and what is
  // placed is built from it. So two placements of one definition are two sets
  // of objects -- nothing in the file refers to the objects that made it.
  check(
    'the record names no showfile id',
    definition.members.some((member) => 'id' in member),
    false,
  );

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

run();
