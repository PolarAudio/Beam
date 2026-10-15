// One frame of one scene: window.__args = { scene, haze, camera, house, width, height }.
// Builds the scene if it is not the one standing, freezes the clock, settles
// it in fixed steps and returns the frame as a PNG data URL.
(async () => {
  const bt = window.__bt;
  const a = window.__args;
  if (bt.built !== a.scene) {
    await bt.reset();
    bt.setup = await window.__scenes[a.scene]();
    bt.built = a.scene;
    bt.settled = false;
  }
  if (bt.Studio.setActive) bt.Studio.setActive(false);
  bt.vis.setRecordingMode(true);
  bt.room(a.house);
  bt.size(a.width || 1280, a.height || 720);
  bt.freeze();
  bt.haze(a.haze);
  const view = bt.setup.cameras[a.camera];
  if (!view) throw new Error(`${a.scene} has no camera ${a.camera}`);
  bt.camera(view.position, view.target, view.fov || 45);
  // Slews, wheels and depth tiles need frames; later shots of the same scene
  // only need the haze and camera to take.
  const steps = bt.settled ? 3 : bt.setup.settle;
  for (let i = 0; i < steps; i++) bt.step(0.1);
  // A camera worked out from the scene (a getter) is placed again once the
  // heads have settled; a fixed one comes back as the same object.
  const settledView = bt.setup.cameras[a.camera];
  if (settledView !== view) {
    bt.camera(settledView.position, settledView.target, settledView.fov || 45);
    for (let i = 0; i < 3; i++) bt.step(0.1);
  }
  bt.settled = true;
  const frame = bt.capture();
  bt.thaw();
  return frame;
})()
