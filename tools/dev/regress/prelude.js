// Loads the app's own modules and the harness helpers into window.__bt.
// Run once per page load with tools/dev/eval.ps1 -File; it is idempotent.
(async () => {
  const gp = document.querySelector('#app').__vue_app__.config.globalProperties;
  const show = gp.$show.__v_raw;
  const vis = show.visualizerHandle;
  // The copy of a module the app is running: after a hot reload that is the
  // last `?t=` URL loaded, and a bare import would get a different instance
  // whose state is not the scene's.
  const live = (p) => {
    const loaded = performance.getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => n.split('?')[0].endsWith(p));
    return loaded.length ? loaded[loaded.length - 1] : p;
  };
  const M = (p) => import(live(p)).then((m) => m.default);
  window.__live = live;
  const bt = {
    show,
    vis,
    DMX: await M('/src/plugins/visualizer/dmx_store.js'),
    Patch: await M('/src/models/DMX/patch.model.js'),
    AM: await M('/src/plugins/visualizer/animation_manager.js'),
    Env: await M('/src/plugins/visualizer/scene_env.js'),
    Controls: await M('/src/plugins/visualizer/controls.js'),
    Tuning: await M('/src/plugins/visualizer/tuning.js'),
    LaserStream: await M('/src/plugins/laser_stream.js'),
    VideoRouter: await M('/src/plugins/visualizer/video_router.js'),
    Shutter: await M('/src/plugins/visualizer/shutter.js'),
    Studio: await M('/src/models/DMX/studio.js'),
    Light: await M('/src/plugins/visualizer/light.js'),
    Laser: await M('/src/plugins/visualizer/laser.js'),
    Artnet: await M('/src/plugins/artnet.connection.js'),
    barDefaults: (await import('/src/models/DMX/generic/led_bar.js')).DEFAULT_BAR_PARAMS,
  };

  // Live DMX on the network would overwrite what a scene sets.
  if (!window.__btDetached) {
    bt.DMX.attachArtNet()();
    bt.Artnet.disableInput();
    window.__btDetached = true;
  }

  // Universes the scene writes, whole rows at a time.
  bt.universes = new Map();
  bt.uni = (u) => {
    if (!bt.universes.has(u)) bt.universes.set(u, new Uint8Array(512));
    return bt.universes.get(u);
  };
  bt.setCh = (f, i, v) => {
    const a = f.addressOf(i);
    bt.uni(Math.floor(a / 512))[a % 512] = v;
  };
  bt.flush = () => bt.universes.forEach((bytes, u) => {
    bt.DMX.write(u, bytes);
    bt.Patch.writeUniverse(u, bytes);
  });

  bt.reset = async () => {
    bt.universes = new Map();
    bt.VideoRouter.drop(bt);
    const blank = await (await fetch('/demo/showfiles/blank.showfile.json')).json();
    await show.loadFromData(blank);
    await show.loadChain;
    // Not the document that was open before: a Save now must not write a
    // test scene over someone's show.
    show.documentPath = null;
  };

  bt.place = async (mfr, model, position, rotation, mode) => {
    const r = await show.resolveFixture(mfr, model);
    const f = show.fixturePool.addRaw({ ...r, manufacturer: mfr, model, mode, position, rotation });
    if (f.channels.length) {
      f.address = bt.Patch.findFreeAddress(f.channels.length, 1, 0, f.alignmentPixelSize);
      show.patchFixture(f);
    }
    return f;
  };
  // Opens an input's feed for the harness and waits for its first picture.
  bt.holdInput = async (id) => {
    bt.VideoRouter.use(bt, id);
    for (let i = 0; i < 100; i += 1) {
      const feed = bt.VideoRouter.feedFor(id);
      if (feed && feed.width) return feed;
      await new Promise((ok) => { setTimeout(ok, 20); });
    }
    throw new Error(`input ${id} did not open`);
  };
  bt.generic = async (name, params, kind, position, rotation) => {
    const [m, n] = show.createDefinition(name, params, kind).split('/');
    return bt.place(m, n, position, rotation);
  };
  bt.device = (f, values) => {
    Object.entries(values).forEach(([k, v]) => f.device.set(k, v));
    if (f._3DModel && f._3DModel.refresh) f._3DModel.refresh();
  };
  bt.channel = (f, name) => {
    const i = f.channels.findIndex((c) => (c.name || c) === name);
    if (i < 0) throw new Error(`${f.name} has no channel ${name}`);
    return i;
  };

  // Haze without writing preferences.
  bt.haze = (amount, scale = 5) => {
    const E = bt.Env;
    E._hazeEnabled = amount > 0;
    E._hazeDensity = amount / 100;
    E._hazeTurbulence = 0;
    E._hazeScale = scale;
    E.emit('changed', E);
  };

  // The room and the camera's look, fixed rather than read from the user's
  // preferences. These setters write preferences; run.ps1 restores the file.
  bt.room = () => {
    if (vis.houseLights) vis.houseLights = false;
    if (vis.houseLightsDown !== 2) vis.houseLightsDown = 2;
    if (vis.environmentHouseOff !== 'room') vis.environmentHouseOff = 'room';
    vis.setBloom('intensity', 0.45);
    vis.setBloom('threshold', 0.46);
    vis.setBloom('radius', 0.05);
    bt.Light.setOcclusion(true);
    if (bt.Laser.setOcclusion) bt.Laser.setOcclusion(true);
  };

  // The clock: every animation reads window.__T, advanced only by step().
  bt.freeze = () => {
    window.__T = 0;
    bt.AM.animations.forEach((a) => {
      a.state = 1;
      if (a._clock) a._clock.getElapsedTime = () => window.__T;
    });
    const ah = vis.ambientHaze;
    if (ah && !ah.__btFrozen) {
      const update = Object.getPrototypeOf(ah).update;
      ah.update = function frozen(renderer, input) {
        this.frame = -1;
        this.elapsed = 0;
        return update.call(this, renderer, input, 0);
      };
      ah.__btFrozen = true;
    }
    bt.Shutter.setSlotClock(() => ({ index: Math.round(window.__T * 60), seconds: window.__T, length: 1 / 60 }));
  };
  // Hands the app back: its own clocks and render loop running again, the
  // canvas back to the layout's size, recording mode off. Without it the
  // window is frozen to the person using it.
  bt.thaw = () => {
    bt.AM.animations.forEach((a) => {
      a.state = 0;
      if (a._clock) delete a._clock.getElapsedTime;
    });
    const c = vis.domElement;
    c.style.removeProperty('width');
    c.style.removeProperty('height');
    c.style.removeProperty('flex');
    c.style.removeProperty('min-height');
    vis.resize();
    vis.setRecordingMode(false);
    bt.Shutter.setSlotClock(null);
    const ah = vis.ambientHaze;
    if (ah && ah.__btFrozen) {
      delete ah.update;
      ah.__btFrozen = false;
    }
  };
  const loopOf = (text) => bt.AM.animations.find((a) => a.loop.toString().includes(text));
  bt.step = (dt) => {
    window.__T += dt;
    const update = loopOf('Light.update');
    const controls = loopOf('controls.update');
    if (update) update.loop(window.__T);
    if (controls) controls.loop(window.__T);
    vis.render();
  };

  bt.camera = (position, target, fov = 45) => {
    bt.Controls.cancelFly();
    vis.autoRotate = false;
    if (vis.orthographic) vis.orthographic = false;
    vis.viewpoint = { position, target };
    vis.perspectiveCamera.fov = fov;
    vis.perspectiveCamera.updateProjectionMatrix();
  };
  bt.size = (w, h) => {
    const c = vis.domElement;
    c.style.setProperty('width', `${w}px`, 'important');
    c.style.setProperty('height', `${h}px`, 'important');
    // A flex child, which the layout squeezes when the window is short:
    // 1280 x 720 came out 1280 x 708 once. The buffer follows the canvas's
    // own box, so the box must hold its size whatever the window is.
    c.style.setProperty('flex', '0 0 auto', 'important');
    c.style.setProperty('min-height', `${h}px`, 'important');
    vis.resize();
  };

  bt.capture = () => {
    bt.step(0);
    return vis.renderer.domElement.toDataURL('image/png');
  };

  window.__bt = bt;
  return 'ok';
})()
