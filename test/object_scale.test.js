/* eslint-disable no-console */
/**
 * An object's scale is per axis.
 *
 * What is pinned: a show saved with one number loads it on all three axes; a
 * per-axis scale is saved as it was set; one axis can be set alone; a zero or
 * missing axis falls back to 1 rather than collapsing the model.
 *
 * Usage:
 *   npm test
 */
import SceneObject from '@/models/DMX/object.model';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

check('older show: one number on every axis', new SceneObject({ model: 'm', scale: 2 }).scale, { x: 2, y: 2, z: 2 });
check('no scale: 1', new SceneObject({ model: 'm' }).scale, { x: 1, y: 1, z: 1 });

const object = new SceneObject({ model: 'm', scale: { x: 1, y: 2.5, z: 0.5 } });
check('per axis kept', object.scale, { x: 1, y: 2.5, z: 0.5 });
check('saved per axis', object.showData.scale, { x: 1, y: 2.5, z: 0.5 });

object.scale = { x: 3, y: 3, z: 0 };
check('a zero axis falls back to 1', object.scale, { x: 3, y: 3, z: 1 });

object.scale = { ...object.scale, y: 4 };
check('one axis changed alone', object.scale, { x: 3, y: 4, z: 1 });

check('stretched is not original size', object.isOriginalSize, false);
object.scale = 1;
check('scale 1 is original size', object.isOriginalSize, true);
check('a model from a file scales', object.isScalable, true);
const shape = new SceneObject({ primitive: { type: 'cube', size: { x: 1, y: 1, z: 1 } } });
check('a created shape does not', shape.isScalable, false);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
