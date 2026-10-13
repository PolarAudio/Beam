// The regression scenes, built from the blank show each time so they depend
// on nothing in the user's library: shipped OFL profiles and generic kinds.
// Coordinates are metres, Z up; the cameras look along +Y.
// Run after prelude.js; defines window.__scenes.
(() => {
  const bt = window.__bt;

  const MOVER = ['martin', 'mac-axiom-hybrid'];

  async function wall(name, size, position, color = '#808080') {
    return bt.show.createObject({ type: 'cube', name, size, color }, { position });
  }

  async function movers() {
    // Six heads hung from a bar, crossing in pairs, with a wall in the way of
    // two of them, and the focus running from near to far across the row.
    const heads = [];
    for (let k = 0; k < 6; k++) {
      const x = -2.5 + k;
      heads.push(await bt.place(...MOVER, { x, y: 0, z: 4 }, { x: 180, y: 0, z: 0 }, 'Standard'));
    }
    await wall('wall', { x: 2.4, y: 0.2, z: 2.5 }, { x: 1.6, y: 1.2, z: 0 });
    heads.forEach((f, k) => {
      const ch = (name) => bt.channel(f, name);
      bt.setCh(f, ch('Strobe'), 30);
      bt.setCh(f, ch('Dimmer'), 255);
      bt.setCh(f, ch('Zoom'), 60);
      bt.setCh(f, ch('Focus'), [0, 60, 120, 180, 230, 255][k]);
      bt.setCh(f, ch('Pan'), 128);
      bt.setCh(f, ch('Tilt'), k % 2 ? 150 : 106);
    });
    bt.flush();
    heads.forEach((f) => f._3DModel && f._3DModel.snapOrientation && f._3DModel.snapOrientation());
    return {
      settle: 40,
      cameras: {
        front: { position: { x: 0, y: -12, z: 2 }, target: { x: 0, y: 0, z: 2 } },
        under: { position: { x: -2.5, y: -4, z: 0.6 }, target: { x: -2.5, y: 0, z: 4 } },
        // Behind and above the bar, looking along the beams that tilt away.
        behind: { position: { x: -1.5, y: -3, z: 6.5 }, target: { x: -1.5, y: 1.2, z: 0 } },
        top: { position: { x: 0, y: 0.3, z: 14 }, target: { x: 0, y: 0, z: 0 } },
      },
    };
  }

  async function leds() {
    const bar = await bt.generic('T Bar', { ...bt.barDefaults, columns: 60, rows: 1, emitterSize: 0.012, order: 'RGB' }, 'bar',
      { x: -1, y: 0, z: 2.8 }, { x: 0, y: 0, z: 0 });
    const panel = await bt.generic('T Panel', { ...bt.barDefaults, shape: 'panel', columns: 16, rows: 16, length: 1, width: 1, emitterSize: 0.05, order: 'RGB' }, 'bar',
      { x: 1, y: 0, z: 1.8 }, { x: 0, y: 0, z: 0 });
    for (let p = 0; p < 60; p++) {
      const t = p / 59;
      bt.setCh(bar, p * 3, Math.round(255 * (1 - t)));
      bt.setCh(bar, p * 3 + 1, Math.round(255 * Math.sin(Math.PI * t)));
      bt.setCh(bar, p * 3 + 2, Math.round(255 * t));
    }
    for (let p = 0; p < 256; p++) {
      const r = p % 16;
      const c = Math.floor(p / 16);
      bt.setCh(panel, p * 3, (r + c) % 2 ? 255 : 0);
      bt.setCh(panel, p * 3 + 1, r * 16);
      bt.setCh(panel, p * 3 + 2, c * 16);
    }
    bt.flush();
    return {
      settle: 5,
      cameras: { front: { position: { x: 0, y: -3, z: 6 }, target: { x: 0, y: 0, z: 2 } } },
    };
  }

  async function laser() {
    const l = await bt.generic('T Laser', {}, 'laser', { x: 0, y: 0, z: 1.5 }, { x: 0, y: 0, z: 180 });
    await wall('screen', { x: 8, y: 0.2, z: 5 }, { x: 0, y: 8, z: 0 });
    bt.device(l, { protocol: 'ponk', source: 'ponk:777', dimmer: 100, shutter: true });
    // A triangle with a red, a green and a blue side: three colours, and
    // three sharp corners where the scanner turns.
    const corners = [[0, 0.6], [0.52, -0.3], [-0.52, -0.3]];
    const colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
    const PER_SIDE = 24;
    const paths = corners.map((from, s) => {
      const to = corners[(s + 1) % 3];
      const xy = new Float32Array((PER_SIDE + 1) * 2);
      const rgb = new Uint8Array((PER_SIDE + 1) * 3);
      for (let k = 0; k <= PER_SIDE; k++) {
        const t = k / PER_SIDE;
        xy[2 * k] = from[0] + (to[0] - from[0]) * t;
        xy[2 * k + 1] = from[1] + (to[1] - from[1]) * t;
        rgb.set(colours[s], 3 * k);
      }
      return { count: PER_SIDE + 1, xy, rgb };
    });
    bt.LaserStream.push({ protocol: 'ponk', service: 777, name: 'test', paths });
    const stream = bt.LaserStream.ponk.get(777);
    if (stream) stream.stale = () => false;
    return {
      settle: 5,
      cameras: { front: { position: { x: 3, y: -6, z: 2.5 }, target: { x: 0, y: 3, z: 2 } } },
    };
  }

  async function projector() {
    const p = await bt.generic('T Proj', {}, 'projector', { x: 0, y: -4, z: 2 }, { x: 0, y: 0, z: 180 });
    await wall('screen', { x: 8, y: 0.2, z: 5 }, { x: 0, y: 6, z: 0 });
    // The built-in test card every project has.
    const input = bt.show.videoInputs.find((candidate) => candidate.builtIn);
    // Dimmed so the card's white on the grey screen reads about 195 at 0% haze:
    // every wedge step and colour bar stays below clipping, where a change can show.
    bt.device(p, { dimmer: 70, shutter: true, source: input.id });
    // Held open by the harness and waited for, so the first shot has the
    // picture: frames here are drawn on demand, not by the app's loop.
    await bt.holdInput(input.id);
    return {
      settle: 5,
      cameras: { front: { position: { x: 5, y: -10, z: 3 }, target: { x: 0, y: 1, z: 2 } } },
    };
  }

  async function display() {
    // 40 nits, so the card's white sits below clipping at EV 5.25 (about 46
    // nits fills the tone curve) and the wedge and bars can show a change.
    const d = await bt.generic('T Display', { nits: 40 }, 'display', { x: 0, y: 0, z: 0.7 }, { x: 0, y: 0, z: 0 });
    const input = bt.show.videoInputs.find((candidate) => candidate.builtIn);
    bt.device(d, { dimmer: 100, shutter: true, source: input.id });
    await bt.holdInput(input.id);
    return {
      settle: 5,
      cameras: { front: { position: { x: 0.6, y: -2.6, z: 1.1 }, target: { x: 0, y: 0, z: 0.75 } } },
    };
  }

  /**
   * A glossy floor with something to reflect: the test card on a display, a
   * grey cube under a head pointed straight down at it, and the head and its
   * beam above. Created shapes are always matte, so the slab is made glossy
   * here, on its material, for the harness only.
   */
  async function reflect() {
    const SLAB = '#1c1e21';
    await wall('slab', { x: 8, y: 8, z: 0.02 }, { x: 0, y: 2, z: 0 }, SLAB);
    await wall('cube', { x: 0.5, y: 0.5, z: 0.5 }, { x: 1.2, y: 1.5, z: 0.02 }, '#808080');
    const d = await bt.generic('T Display', { nits: 40 }, 'display', { x: -0.8, y: 1.5, z: 0.72 }, { x: 0, y: 0, z: 0 });
    const input = bt.show.videoInputs.find((candidate) => candidate.builtIn);
    bt.device(d, { dimmer: 100, shutter: true, source: input.id });
    await bt.holdInput(input.id);
    const head = await bt.place(...MOVER, { x: 1.2, y: 1.5, z: 4 }, { x: 180, y: 0, z: 0 }, 'Standard');
    const ch = (name) => bt.channel(head, name);
    bt.setCh(head, ch('Strobe'), 30);
    bt.setCh(head, ch('Dimmer'), 255);
    bt.setCh(head, ch('Zoom'), 120);
    bt.setCh(head, ch('Pan'), 128);
    bt.setCh(head, ch('Tilt'), 128);
    bt.flush();
    if (head._3DModel && head._3DModel.snapOrientation) head._3DModel.snapOrientation();
    const Scene = (await import(window.__live('/src/plugins/visualizer/scene_manager.js'))).default;
    let glossy = 0;
    Scene.traverse((o) => {
      const m = o.isMesh && o.material;
      if (m && m.isMeshStandardMaterial && m.color.getHex() === new m.color.constructor(SLAB).getHex()) {
        m.roughness = 0.1;
        glossy += 1;
      }
    });
    if (!glossy) throw new Error('reflect: slab material not found');
    return {
      settle: 40,
      cameras: { front: { position: { x: 0.4, y: -3.5, z: 1.3 }, target: { x: 0.2, y: 1.5, z: 0.5 } } },
    };
  }

  async function strobe() {
    const s = await bt.generic('T Strobe', {}, 'strobe', { x: 0, y: 0, z: 3 }, { x: 0, y: 0, z: 0 });
    bt.device(s, { dimmer: 100, mode: 'on' });
    return {
      settle: 5,
      cameras: { front: { position: { x: 0, y: -8, z: 2 }, target: { x: 0, y: 0, z: 2 } } },
    };
  }

  window.__scenes = { movers, leds, laser, projector, display, strobe, reflect };
  return Object.keys(window.__scenes).join(',');
})()
