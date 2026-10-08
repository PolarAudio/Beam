// Which show is open, whether it has unsaved changes, and what is in it.
// Run with tools/dev/eval.ps1 -File tools/dev/probes/show-state.js
(async () => {
  const show = document.querySelector('#app').__vue_app__.config.globalProperties.$show;
  const fixtures = show.fixturePool ? show.fixturePool.fixtures.length : null;
  const objects = show.objects ? [...show.objects].length : null;
  return JSON.stringify({
    path: show.documentPath,
    saved: show.isSaved,
    fixtures,
    objects,
  });
})()
