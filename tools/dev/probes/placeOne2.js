(async () => {
  const show = document.querySelector('#app').__vue_app__.config.globalProperties.$show;
  const s = await show.placeStructure('Simple Light Tower', { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } });
  const snap = (m) => ({
    t: m.constructor && m.constructor.name,
    pos: [m.position.x, m.position.y, m.position.z],
    rot: [m.rotation.x, m.rotation.y, m.rotation.z],
    scale: m.scale,
    id: m.id,
    model: m.model
  });
  return JSON.stringify({
    members: s.members.length,
    sPos: [s.position.x, s.position.y, s.position.z],
    sRot: [s.rotation.x, s.rotation.y, s.rotation.z],
    snap: s.members.map(snap)
  }, null, 1);
})()