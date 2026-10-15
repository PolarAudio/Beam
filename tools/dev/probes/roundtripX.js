(async () => {
  const show = document.querySelector('#app').__vue_app__.config.globalProperties.$show;
  const snap = (s) => s.members.map((m) => ({
    pos: [m.position.x, m.position.y, m.position.z],
    rot: [m.rotation.x, m.rotation.y, m.rotation.z],
    rad: [m.rotationRad.x, m.rotationRad.y, m.rotationRad.z],
    scale: m.scale
  }));
  const s0 = await show.placeStructure('Simple Light Tower', { position: {x:0,y:0,z:0}, rotation:{x:0,y:0,z:0} });
  const before = snap(s0);
  show.structureLibrary['__tmp__'] = JSON.parse(JSON.stringify(show.structureLibrary['Simple Light Tower']));
  const s1 = await show.placeStructure('__tmp__', { position: {x:0,y:0,z:0}, rotation:{x:0,y:0,z:0} });
  const after = snap(s1);
  delete show.structureLibrary['__tmp__'];
  return JSON.stringify({ identical: JSON.stringify(before) === JSON.stringify(after), before, after }, null, 1);
})()