// window.__args = { set: { channelName: value, ... }, camera, haze, steps }
// Zeroes every channel of every test head, writes the base values and `set`
// (names a head lacks are skipped), settles with the clock frozen and returns
// a PNG data URL. The base opens the light: dimmer and shutter full, pan and
// tilt centred, which with the heads hung pointing down puts the pools on the floor.
(async () => {
  const bt = window.__bt;
  const heads = window.__heads;
  const a = window.__args;
  const base = {
    Dimmer: 255, 'Dimmer fine': 255, Shutter: 255, Zoom: 50, Focus: 127,
    Pan: 127, 'Pan fine': 255, Tilt: 127, 'Tilt fine': 255,
  };
  const values = { ...base, ...(a.set || {}) };
  Object.values(heads).forEach((f) => {
    const names = f.channels.map((c) => c.name || c);
    for (let i = 0; i < f.channels.length; i += 1) bt.setCh(f, i, 0);
    Object.entries(values).forEach(([name, v]) => {
      const i = names.indexOf(name);
      if (i >= 0) bt.setCh(f, i, v);
    });
  });
  bt.flush();
  if (bt.Studio.setActive) bt.Studio.setActive(false);
  bt.vis.setRecordingMode(true);
  bt.room('down');
  bt.size(1280, 720);
  bt.freeze();
  bt.haze(a.haze || 0);
  const cam = a.camera || { position: { x: 0, y: -7.5, z: 6.5 }, target: { x: 0, y: 0.6, z: 0 }, fov: 40 };
  bt.camera(cam.position, cam.target, cam.fov);
  Object.values(heads).forEach((f) => f._3DModel && f._3DModel.snapOrientation && f._3DModel.snapOrientation());
  for (let i = 0; i < (a.steps || 30); i += 1) bt.step(a.dt || 0.1);
  const frame = bt.capture();
  bt.thaw();
  return frame;
})()
