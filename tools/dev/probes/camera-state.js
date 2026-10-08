// The view: camera kind, place, orbit target, lens shift and frame time.
// Run with tools/dev/eval.ps1 -File tools/dev/probes/camera-state.js
(async () => {
  const show = document.querySelector('#app').__vue_app__.config.globalProperties.$show;
  const handle = show.visualizerHandle;
  const { camera } = handle;
  const target = handle.controls.target;
  const round = (v) => v.toArray().map((n) => +n.toFixed(3));
  const shift = camera.view && camera.view.enabled
    ? { x: camera.view.offsetX, y: camera.view.offsetY, width: camera.view.fullWidth, height: camera.view.fullHeight }
    : null;
  return JSON.stringify({
    kind: camera.type,
    position: round(camera.position),
    target: round(target),
    distance: +camera.position.distanceTo(target).toFixed(3),
    fov: camera.fov,
    halfHeight: camera.isOrthographicCamera ? camera.top / camera.zoom : undefined,
    lensShift: shift,
  });
})()
