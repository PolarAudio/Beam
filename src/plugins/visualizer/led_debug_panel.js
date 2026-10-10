// eslint-disable-next-line import/extensions, import/no-unresolved
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js';
import Laser from './laser';
import Light from './light';
import LEDField from './led_field';
import Preferences from './preferences';
import Tuning from './tuning';

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
 * the top does the same for every control at once. Clearing every preference
 * is Preferences > Reset to defaults.
 *
 * The panel floats in the viewport's top-right corner, over the view cube,
 * and grows downwards as folders open; past the viewport's bottom it
 * scrolls. Only the top-level folders collapse; the groups inside them are
 * fixed headings. Which folders are open is stored with the tuning values.
 */

/** Gap between the panel and the 3D view's right and bottom edges, in px. */
const GAP = 8;

/** Gap between the panel and the top of the 3D view, in px. */
const TOP_GAP = 2;

/** Preference key for the folders' open state, beside the tuning values. */
const FOLDERS_KEY = `${Tuning.PREFIX}folders`;

/** Folders that start closed until the user opens them. */
const CLOSED_BY_DEFAULT = ['Room'];

/** A group heading inside a folder: no arrow, not clickable. */
const SECTION_CSS = `
.lil-gui .beam-section > .title { cursor: default; pointer-events: none; opacity: 0.7; }
.lil-gui .beam-section > .title:before { content: none; }
`;

/** Adds the heading style once per document. */
function installSectionStyle() {
  if (document.getElementById('beam-debug-sections')) return;
  const style = document.createElement('style');
  style.id = 'beam-debug-sections';
  style.textContent = SECTION_CSS;
  document.head.appendChild(style);
}

/**
 * Builds the panel. Safe to call when no bars exist -- it simply does nothing.
 *
 * @param {Object} visualizer Visualizer instance
 * @param {HTMLElement} host the viewport's container
 * @returns {Object|null} the GUI instance
 */
export default function createLEDDebugPanel(visualizer, host) {
  if (!LEDField.tunables()) return null;

  const container = host || document.body;
  if (container !== document.body && getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  const gui = new GUI({ title: 'Debug', container });
  Object.assign(gui.domElement.style, {
    position: 'absolute',
    right: `${GAP}px`,
    bottom: '',
    zIndex: '100',
  });

  // The container also holds the toolbar row, so the panel starts at the top
  // of the 3D canvas and is as tall as the canvas leaves room for. The root's
  // children scroll once the root is capped in height.
  const canvas = visualizer.domElement;
  const fit = () => {
    const top = (canvas && canvas.offsetParent === container ? canvas.offsetTop : 0) + TOP_GAP;
    gui.domElement.style.top = `${top}px`;
    gui.domElement.style.maxHeight = `${Math.max(container.clientHeight - top - GAP, 80)}px`;
  };
  if (typeof ResizeObserver !== 'undefined') {
    const watch = new ResizeObserver(fit);
    watch.observe(container);
    if (canvas) watch.observe(canvas);
  }
  window.addEventListener('resize', fit);
  fit();

  // Open or closed, per folder path, stored with the tuning values.
  const openState = { ...(Preferences.get(FOLDERS_KEY) || {}) };
  const remember = (folder, path) => {
    const closed = path in openState ? !openState[path] : CLOSED_BY_DEFAULT.includes(path);
    if (closed) folder.close();
    // lil-gui flips the folder synchronously on the title's click, which
    // Enter and Space also raise.
    folder.$title.addEventListener('click', () => {
      openState[path] = !folder._closed;
      Preferences.set(FOLDERS_KEY, { ...openState });
    });
    return folder;
  };
  remember(gui, '');
  const folder = (parent, title) => remember(parent.addFolder(title), title);

  // A heading that groups controls inside a folder. It never collapses.
  installSectionStyle();
  const section = (parent, title) => {
    const made = parent.addFolder(title);
    made.domElement.classList.add('beam-section');
    made.$title.tabIndex = -1;
    // Held open whatever asks: close() and a title click both come through these.
    made.open = () => made;
    made.openAnimated = () => made;
    return made;
  };

  /** The tuning keys, read as they stand: stored values have been applied. */
  const tuned = (keys) => Object.fromEntries(keys.map((k) => [k, Tuning.current(k, visualizer)]));

  const state = {
    ...tuned([
      'gain', 'haloStrength', 'backScatter', 'coreScale',
      'dimStartDistance', 'dimFloor',
      'glowSize', 'sizeAtFullHaze', 'haloFalloff', 'haloRadiance', 'haloBackScatter',
      'hazeWarp', 'hazeTurn', 'roomAir', 'airHaze', 'airGrain', 'airScale',
      'contactShadows', 'contactStrength', 'contactReach', 'contactEdge',
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
  function tune(parent, key, ...range) {
    const controller = parent.add(state, key, ...range)
      .onChange((v) => Tuning.write(key, v, visualizer));
    return resettable(controller, key);
  }

  gui.add({ reset: () => resets.forEach((fn) => fn()) }, 'reset')
    .name('Reset all');

  // The camera: fixed numbers in visualizer.js, moved here by hand to judge
  // a setting by eye; nothing is stored. See CAMERA_EXPOSURE and the glare
  // constants there.
  const camera = folder(gui, 'Camera');
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

  // Set once rather than reached for while working, so it starts closed.
  const room = folder(gui, 'Room');

  const roomLight = section(room, 'Light');
  // Environment fill at full house lights. With one directional light alone,
  // every surface facing away from it renders pure black. Too much washes the
  // show out, too little brings the black faces back.
  tune(roomLight, 'roomAir', 0, 1.5, 0.01).name('ambient fill');
  // Contact shadows: the stain under anything standing on the floor, so it
  // reads as touching. The toggle is the rollback and the A/B for gpuMs.
  tune(roomLight, 'contactShadows').name('contact shadows');
  tune(roomLight, 'contactStrength', 0, 1, 0.01).name('contact darkness');
  tune(roomLight, 'contactReach', 0.05, 20, 0.05).name('contact reach m');
  tune(roomLight, 'contactEdge', 0, 0.5, 0.005).name('contact edge blur m');

  const haze = section(room, 'Haze');
  // Haze in the air itself, rather than only where a fixture draws geometry.
  // Six samples over the whole screen, so watch gpuMs while dragging it; zero
  // draws none.
  tune(haze, 'airHaze', 0, 2, 0.01).name('room air');
  // How much of the air's density is the noise field rather than uniform.
  // Zero is perfectly smooth; grain is the variance of an 8-sample estimate.
  tune(haze, 'airGrain', 0, 1, 0.01).name('air texture');
  // Air feature size against the scene's haze scale. 1 matches the beams.
  tune(haze, 'airScale', 0.5, 4, 0.05).name('air feature size x');
  // The field folded around its own coarse structure, and the curl in each
  // octave's travel. Both ride the turbulence slider.
  tune(haze, 'hazeWarp', 0, 200, 1).name('swirl %');
  tune(haze, 'hazeTurn', 0, 400, 5).name('heading sweep %');

  const led = folder(gui, 'LED');

  const die = section(led, 'Die');
  tune(die, 'gain', 0, 8, 0.05);
  tune(die, 'coreScale', 0.25, 4, 0.05).name('die size x');
  tune(die, 'haloStrength', 0, 2, 0.01).name('halo strength');
  tune(die, 'backScatter', 0, 1, 0.01).name('back scatter');

  const distance = section(led, 'Distance');
  tune(distance, 'dimStartDistance', 0.2, 20, 0.1).name('full gain beyond');
  tune(distance, 'dimFloor', 0, 1, 0.01).name('closest dim');

  const glow = section(led, 'Glow');
  // The volume's only brightness: a second control over the same quantity
  // would leave neither readable.
  tune(glow, 'haloRadiance', 0, 4, 0.01).name('brightness');
  // Decides whether the glow reads as air or as a wash.
  tune(glow, 'haloFalloff', 1, 24, 0.25).name('falloff sharpness');
  // Reach is authored per fixture from its own size; these scale all of them.
  // Both stop at 1.5, the headroom the marched box is built with; past it the
  // shader clamps.
  tune(glow, 'glowSize', 0.01, 1.5, 0.005).name('reach x');
  tune(glow, 'sizeAtFullHaze', 0.5, 1.5, 0.01).name('reach at full haze x');
  tune(glow, 'haloBackScatter', 0, 1, 0.01).name('omnidirectional');

  const beam = folder(gui, 'Mover beam');
  // The beams' light scattered a second time, for comparing with and
  // without; not stored. See beam_halo.js.
  resettable(beam.add(state, 'beamHalo')
    .name('scattered glow')
    .onChange((v) => visualizer.setBeamHalo(v)));
  // A diagnostic, not a preference: not stored.
  resettable(beam.add(state, 'beamOcclusion')
    .name('stop at surfaces')
    .onChange((v) => Light.setOcclusion(v)));
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

  // A laser is drawn twice: the shaft through the haze is geometry, the
  // figure on the stone is a projected picture, so each has its own gain.
  const laser = folder(gui, 'Laser');

  const laserBright = section(laser, 'Brightness');
  tune(laserBright, 'laserAir', 0, 4, 0.05).name('beam in air');
  tune(laserBright, 'laserSurface', 0, 12, 0.05).name('figure on surface');
  // Haze scatters light forwards, so a beam pointed at you is brighter than
  // one crossing your view. Head-on is the reference; turning this up only
  // ever darkens the other angles.
  tune(laserBright, 'laserScatter', 0, 100, 1).name('side-on dimming %');
  // A Ponk frame is geometry before the scanner; this weights it by how long
  // the scanner would have lingered. Off shows every path equally bright, as
  // MadMapper's own preview does.
  tune(laserBright, 'laserDwell').name('scanner dwell');

  const laserShape = section(laser, 'Shape');
  tune(laserShape, 'laserWidth', 0.5, 12, 0.5).name('figure width (px)');
  tune(laserShape, 'laserLength', 5, 120, 1).name('beam length (m)');
  tune(laserShape, 'laserTail', 0.05, 0.95, 0.05).name('beam fade');

  const laserDiag = section(laser, 'Diagnostics');
  // A diagnostic, not a preference: not stored.
  resettable(laserDiag.add(state, 'laserOcclusion')
    .name('stop at surfaces')
    .onChange((v) => Laser.setOcclusion(v)));
  laserDiag.add({ dump: () => Laser.dumpDepthTiles() }, 'dump')
    .name('log depth tiles');

  return gui;
}
