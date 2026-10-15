/* eslint-disable no-console, import/no-extraneous-dependencies */
/**
 * @file Renders a thumbnail of each Wicked Lasers body for its GDTF file.
 *
 * Reads the glTF body out of each file in `public/profiles/Wicked Lasers`,
 * renders it offscreen with the object thumbnailer's view and lighting on a
 * transparent background, and writes `tools/gdtf/thumbnails/<file>.png`, which
 * `wicked-lasers.mjs` puts in the file as GDTF's thumbnail.
 *
 * Usage:
 *   npx electron tools/gdtf/thumbnails.cjs
 *   node tools/gdtf/wicked-lasers.mjs
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { unzipSync } = require('fflate');

const root = path.join(__dirname, '..', '..');
const profiles = path.join(root, 'public', 'profiles', 'Wicked Lasers');
const outDir = path.join(__dirname, 'thumbnails');
/** Edge of the image, in pixels. */
const SIZE = 256;

const three = (p) => `file:///${path.join(root, 'node_modules', 'three', p).replace(/\\/g, '/')}`;

const page = `<!doctype html><html><body style="margin:0;background:transparent">
<script type="importmap">${JSON.stringify({
    imports: {
      three: three('build/three.module.js'),
      'three/addons/': three('examples/jsm/'),
    },
  })}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const SIZE = ${SIZE};
// The object thumbnailer's view, three-quarter from the front and slightly
// above, in glTF's axes: Y up, the beam leaving along +Z.
const VIEW = new THREE.Vector3(1, 0.85, 1.35).normalize();
const FILL = 0.82;
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(SIZE, SIZE);
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
window.render = async (base64) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(2, -3, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-3, 1, 1);
  scene.add(fill);
  scene.add(gltf.scene);
  const bounds = new THREE.Box3().setFromObject(gltf.scene);
  const centre = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
  const camera = new THREE.PerspectiveCamera(35, 1, 0.001, 100);
  const distance = radius / Math.sin((camera.fov * Math.PI) / 360) / FILL;
  camera.position.copy(centre).addScaledVector(VIEW, distance);
  camera.up.set(0, 1, 0);
  camera.lookAt(centre);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
};
window.ready = true;
</script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: SIZE,
    height: SIZE,
    webPreferences: { offscreen: true, webSecurity: false },
  });
  const html = path.join(app.getPath('temp'), 'beam-gdtf-thumbnails.html');
  fs.writeFileSync(html, page);
  await win.loadFile(html);
  while (!(await win.webContents.executeJavaScript('!!window.ready'))) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs.readdirSync(profiles).filter((name) => name.endsWith('.gdtf'));
  // One at a time: the page has one renderer.
  await files.reduce((previous, name) => previous.then(async () => {
    const zip = unzipSync(new Uint8Array(fs.readFileSync(path.join(profiles, name))));
    const glb = Object.keys(zip).find((entry) => entry.startsWith('models/gltf/'));
    if (!glb) return;
    const base64 = Buffer.from(zip[glb]).toString('base64');
    const dataUrl = await win.webContents.executeJavaScript(`window.render(${JSON.stringify(base64)})`);
    const png = path.join(outDir, `${path.basename(name, '.gdtf')}.png`);
    fs.writeFileSync(png, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`${path.relative(root, png)}  ${fs.statSync(png).size} bytes`);
  }), Promise.resolve());
  fs.unlinkSync(html);
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
