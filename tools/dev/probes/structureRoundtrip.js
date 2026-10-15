(async () => {
  const show = document.querySelector('#app').__vue_app__.config.globalProperties.$show;
  const pick = 'Simple Light Tower';
  const p = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
  const snap = (s) => s.members.map((m) => ({
    class: m.constructor && m.constructor.name || kind(m),
    pos: [+(m.position.x ?? m.position?.x??0).toFixed(6), +m.position.y.toFixed(6), +m.position.z.toFixed(6)],
    rotDeg: [+(m.rotation?.x??0).toFixed(3), +m.rotation?.y.toFixed(3), +m.rotation?.z.toFixed(3)],
    rotRad: [+(m.rotationRad?.x??0).toFixed(6), +m.rotationRad?.y.toFixed(6), +m.rotationRad?.z.toFixed(6)],
    scale: m.scale !== undefined ? m.scale : m._scale
  }));
  const before = show.placeStructure(pick, p);
  const b = snap(before);
  const def = JSON.parse(JSON.stringify(show.structureLibrary[pick]));
  show.structureLibrary['__tmp__'] = def;
  const after = show.placeStructure('__tmp__', p);
  const a = snap(after);
  delete show.structureLibrary['__tmp__'];
  return JSON.stringify({ before: b, after: a, identical: JSON.stringify(b) === JSON.stringify(a) }, null, 1);
})()