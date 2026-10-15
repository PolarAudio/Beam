(async () => {
  const show = document.querySelector('#app').__vue_app__.config.globalProperties.$show;
  const s = await show.placeStructure('Simple Light Tower', { position: {x:0,y:0,z:0}, rotation:{x:0,y:0,z:0}});
  const keys = s ? Object.keys(s) : null;
  return JSON.stringify({ returned: s, type: typeof s, keys, memberKinds: s?.members?.map((m)=> (m.kind||m.constructor.name)), structurePos: s?.position, rotation: s?.rotation, structureLibHas: !!show.structureLibrary['Simple Light Tower'] }, null,1);
})()