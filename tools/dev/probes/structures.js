(async () => {
 const show = document.querySelector('#app').__vue_app__.config.globalProperties.$show;
 return JSON.stringify({
   structures: show.structures.map((s, i) => ({
     i,
     name: s.name,
     memberCount: s.members.length,
     pos: Object.values(s.position||{}),
     rot: [s.rotation?.x, s.rotation?.y, s.rotation?.z],
   })),
   libraries: Object.keys(show.structureLibrary || {}),
 }, null, 1);
})()