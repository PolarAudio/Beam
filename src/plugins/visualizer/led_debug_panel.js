// eslint-disable-next-line import/extensions, import/no-unresolved
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js';
import Laser from './laser';
import Light from './light';
import LEDField from './led_field';
import LEDPanel from './led_panel';
import Tuning from './tuning';
import EventBus from '../eventbus';

/**
 * @file The debug panel: every render tuning value, written straight into its
 * uniform or module so a change shows on the next frame.
 *
 * Tuning controls go through `Tuning`, which stores them and knows their
 * defaults. Diagnostics (occlusion switches, the draw term, the camera) are
 * not stored, so a session cannot start with beams through walls because a
 * switch was left off.
 *
 * Double-clicking a control's name puts it back to its default. The button at
 * the top does the same for every control at once.
 */

/**
 * Every tunable uniform, by group.
 *
 * `halo` belongs to the panel path -- the marched glow volume -- and is kept
 * apart from `glow`, which is the billboard blob. They mean different things by
 * a falloff, so one control cannot serve both.
 *
 * @returns {Object|null} `{ emitter, glow, halo }`
 */
function tunableGroups() {
  const field = LEDField.tunables();
  if (!field) return null;
  return { ...field, halo: LEDPanel.tunables() };
}

/**
 * Builds the panel. Safe to call when no bars exist -- it simply does nothing.
 *
 * @param {Object} visualizer Visualizer instance, for the haze controls
 * @returns {Object|null} the GUI instance
 */
export default function createLEDDebugPanel(visualizer, host) {
  if (!tunableGroups()) return null;

  // Anchored inside the 3D viewport rather than the window, so it stays clear
  // of the panels beside it. Absolute positioning needs a positioned
  // ancestor, and without one it would fall back to the document.
  const container = host || document.body;
  if (container !== document.body && getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  const gui = new GUI({ title: 'Debug', container });
  gui.domElement.style.position = 'absolute';
  // Bottom right: the navigation cube owns the opposite corner.
  gui.domElement.style.bottom = '8px';
  gui.domElement.style.right = '8px';
  gui.domElement.style.top = '';
  gui.domElement.style.zIndex = '100';

  /** The tuning keys, read as they stand: stored values have been applied. */
  const tuned = (keys) => Object.fromEntries(keys.map((k) => [k, Tuning.current(k, visualizer)]));

  const state = {
    ...tuned([
      'gain', 'haloStrength', 'backScatter', 'coreScale',
      'dimStartDistance', 'dimFloor',
      'glowSize', 'sizeAtFullHaze', 'haloFalloff', 'haloRadiance', 'haloBackScatter',
      'hazeWarp', 'hazeTurn', 'roomAir', 'airHaze', 'airGrain', 'airScale',
      'contactShadows', 'contactStrength', 'contactReach', 'contactEdge', 'strictPatch',
      'laserAir', 'laserSurface', 'laserWidth', 'laserLength', 'laserTail',
      'laserScatter', 'laserDwell',
    ]),
    // Mover beams
    beamOcclusion: Light.occlusion(),
    beamHalo: true,
    beamDebug: 0,
    // Camera
    cameraExposure: visualizer.cameraSettings.exposure,
    cameraCurve: visualizer.cameraSettings.curve || 'ACES_FILMIC',
    glareStrength: visualizer.bloom ? visualizer.bloom.intensity : 0,
    glareSpread: visualizer.bloom ? visualizer.bloom.radius : 0,
    // Laser
    laserOcclusion: Laser.occlusion(),
  };

  /** What puts each control back, for the button at the top. */
  const resets = [];

  /**
   * Makes a control resettable by a double-click on its name.
   *
   * A tuning control goes back to the source default through `Tuning`, which
   * also forgets the stored value. Anything else goes back to the value it was
   * built with, which for a diagnostic is the constant in its module.
   */
  function resettable(controller, key = null) {
    const reset = () => {
      if (key) {
        const value = Tuning.reset(key, visualizer);
        if (value === undefined) return;
        controller.object[controller.property] = value;
        controller.updateDisplay();
      } else {
        controller.reset();
      }
    };
    controller.$name.title = 'Double-click to reset';
    controller.$name.addEventListener('dblclick', reset);
    resets.push(reset);
    return controller;
  }

  /** A stored tuning control: writes through `Tuning`, resets through it. */
  function tune(folder, key, ...range) {
    const controller = folder.add(state, key, ...range)
      .onChange((v) => Tuning.write(key, v, visualizer));
    return resettable(controller, key);
  }

  gui.add({ reset: () => resets.forEach((fn) => fn()) }, 'reset')
    .name('Reset all');
  gui.add({ reset: () => EventBus.emit('reset_defaults') }, 'reset')
    .name('Reset preferences (reloads)');

  const die = gui.addFolder('Emitter die');
  tune(die, 'gain', 0, 8, 0.05);
  tune(die, 'haloStrength', 0, 2, 0.01);
  tune(die, 'coreScale', 0.25, 4, 0.05).name('die size x');
  tune(die, 'backScatter', 0, 1, 0.01).name('back scatter');

  const distance = gui.addFolder('Distance dimming');
  tune(distance, 'dimStartDistance', 0.2, 20, 0.1).name('full gain beyond');
  tune(distance, 'dimFloor', 0, 1, 0.01).name('closest dim');

  const scatter = gui.addFolder('Scattered glow');
  // Falloff first: it is the one that decides whether the glow reads as air or
  // as a wash, and the one worth reaching for before anything else.
  tune(scatter, 'haloFalloff', 1, 24, 0.25).name('falloff sharpness');
  // The volume's only brightness: a second control over the same quantity
  // would leave neither readable.
  tune(scatter, 'haloRadiance', 0, 4, 0.01).name('brightness');
  // Reach is authored per fixture from its own size; this scales all of them
  // together. Stops at 1.5 because the marched box is built with exactly that
  // much headroom; past it the shader clamps.
  tune(scatter, 'glowSize', 0.01, 1.5, 0.005).name('reach x');
  tune(scatter, 'haloBackScatter', 0, 1, 0.01).name('omnidirectional');
  // How far the glow reaches once the air is thick, against its authored size.
  // The same 1.5 headroom as above.
  tune(scatter, 'sizeAtFullHaze', 0.5, 1.5, 0.01).name('reach at full haze x');

  // Set-once tuning rather than something to reach for while working, so it
  // starts closed.
  const room = gui.addFolder('Room');
  room.close();

  // Haze in the air itself, rather than only where a fixture draws geometry.
  // This is the one with a real per-pixel cost -- six samples over the whole
  // screen -- so watch gpuMs while dragging it; zero draws none.
  tune(room, 'airHaze', 0, 2, 0.01).name('room air');

  // The field folded around its own coarse structure, and the curl in each
  // octave's travel -- numbers only the eye can settle.
  tune(room, 'hazeWarp', 0, 200, 1).name('swirl %');
  tune(room, 'hazeTurn', 0, 400, 5).name('heading sweep %');

  // Contact shadows: the stain under anything standing on the floor, so it
  // reads as touching. The toggle is the rollback and the A/B for gpuMs.
  tune(room, 'contactShadows').name('contact shadows');
  tune(room, 'contactStrength', 0, 1, 0.01).name('contact darkness');
  tune(room, 'contactReach', 0.05, 20, 0.05).name('contact reach m');
  tune(room, 'contactEdge', 0, 0.5, 0.005).name('contact edge blur m');

  // Off, any DMX address is accepted, overlaps included, and new or pasted
  // fixtures keep the address they were given instead of the first free one.
  tune(room, 'strictPatch').name('strict DMX patch');

  // Environment fill at full house lights. With one directional light alone,
  // every surface facing away from it renders pure black. Too much washes the
  // show out, too little brings the black faces back.
  tune(room, 'roomAir', 0, 1.5, 0.01).name('ambient fill');

  // How much of the air's density is the noise field rather than uniform.
  // Zero is perfectly smooth and cannot grain at all; grain is the variance of
  // an 8-sample estimate.
  tune(room, 'airGrain', 0, 1, 0.01).name('air texture');

  // Air feature size against the scene's haze scale. 1 matches the beams
  // exactly: one field, one source. Larger is coarser air and less grain.
  tune(room, 'airScale', 0.5, 4, 0.05).name('air feature size x');

  // The camera: fixed numbers in visualizer.js, moved here by hand to judge
  // a setting by eye; nothing is stored. See CAMERA_EXPOSURE and the glare
  // constants there.
  const camera = gui.addFolder('Camera');
  resettable(camera.add(state, 'cameraExposure', 0.1, 16, 0.05)
    .name('exposure')
    .onChange((v) => visualizer.setCamera({ exposure: v })));
  resettable(camera.add(state, 'cameraCurve', ['ACES_FILMIC', 'NEUTRAL', 'AGX'])
    .name('tone curve')
    .onChange((v) => visualizer.setCamera({ curve: v })));
  resettable(camera.add(state, 'glareStrength', 0, 0.3, 0.005)
    .name('glare strength')
    .onChange((v) => visualizer.setBloom('intensity', v)));
  resettable(camera.add(state, 'glareSpread', 0.05, 1, 0.05)
    .name('glare spread')
    .onChange((v) => visualizer.setBloom('radius', v)));

  const beam = gui.addFolder('Mover beam');
  // A diagnostic, not a preference: not stored.
  resettable(beam.add(state, 'beamOcclusion')
    .name('stop at surfaces')
    .onChange((v) => Light.setOcclusion(v)));
  // The beams' light scattered a second time, for comparing with and
  // without; not stored. See beam_halo.js.
  resettable(beam.add(state, 'beamHalo')
    .name('scattered glow')
    .onChange((v) => visualizer.setBeamHalo(v)));
  // One shader term as greyscale, to see which one carries a fault.
  resettable(beam.add(state, 'beamDebug', {
    beam: 0,
    'field fraction': 1,
    profile: 2,
    'path integral': 3,
    irradiance: 4,
    phase: 5,
    haze: 6,
    intensity: 7,
  })
    .name('draw term')
    .onChange((v) => Light.setDebugTerm(v)));

  // Two separate hands, because a laser is drawn twice: the shaft through the
  // haze is geometry, the figure on the stone is a projected picture. Turning
  // one down should not drag the other with it.
  const laser = gui.addFolder('Laser');
  tune(laser, 'laserAir', 0, 4, 0.05).name('beam in air');
  tune(laser, 'laserSurface', 0, 12, 0.05).name('figure on surface');
  tune(laser, 'laserWidth', 0.5, 12, 0.5).name('figure width (px)');
  tune(laser, 'laserLength', 5, 120, 1).name('beam length (m)');
  tune(laser, 'laserTail', 0.05, 0.95, 0.05).name('beam fade');
  // A beam pointed at you is far brighter than one crossing your view, because
  // haze scatters light forwards. Head-on is the reference; this is how far the
  // other angles fall below it, so turning it up only ever darkens.
  tune(laser, 'laserScatter', 0, 100, 1).name('side-on dimming %');
  // A Ponk frame is geometry before the scanner; this weights it by how long
  // the scanner would have lingered -- dots hot, crowded frames dim. Off shows
  // every path equally bright, which is what MadMapper's own preview does.
  tune(laser, 'laserDwell').name('scanner dwell');
  // A diagnostic, not a preference: not stored.
  resettable(laser.add(state, 'laserOcclusion')
    .name('stop at surfaces')
    .onChange((v) => Laser.setOcclusion(v)));
  laser.add({ dump: () => Laser.dumpDepthTiles() }, 'dump')
    .name('log depth tiles');

  return gui;
}
