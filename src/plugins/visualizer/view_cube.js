import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * @file Navigation cube for the viewport corner.
 *
 * A cube whose faces are named for the view they give: click Top and the
 * camera goes overhead, click a corner for the isometric between three faces.
 * It reads as an object rather than a row of buttons, which is why every CAD
 * package has one -- an icon can only hint at "look from here", a labelled
 * face says it.
 *
 * Two choices here are better than the obvious approach: the six faces share
 * one texture atlas and hover by shifting its offset rather than redrawing,
 * and a merged copy of the faces is drawn back-side-on behind them, which is
 * what fills the gaps at glancing angles and makes it read as solid.
 *
 * It is drawn on a canvas of its own, pinned to the panel's top-right corner
 * rather than the scene canvas's. In studio mode the scene canvas is
 * letterboxed to the recording's frame, and a cube drawn into it moved with
 * the letterbox; on its own canvas it stays put, and it is never in a
 * recording.
 *
 * The rounded-rectangle geometry is by @hofk:
 * https://discourse.threejs.org/t/plane-mesh-with-rounded-corners-that-can-have-an-image-texture/46892/2
 */

/** Side of the gizmo's square, in pixels. */
const DIM = 105;
/**
 * How far the gizmo is held off the corner, in pixels.
 *
 * Applied to both edges: inset from one and flush against the other reads as
 * a mistake rather than a margin.
 */
const MARGIN = 14;
/** How far a press may travel and still be a click on a face, in pixels. */
const CLICK_SLOP_PX = 4;

const OPTIONS = {
  resolution: 512,
  cubeBackground: '#2c2e31',
  faceBackground: '#e9edf2',
  textColor: '#1c2126',
  hoverBackground: '#1ca6bd',
  hoverText: '#ffffff',
  circleColor: '#e9edf2',
  circleHoverColor: '#1ca6bd',
  radius: 0.2,
  smoothness: 18,
};

const HALF_PI = Math.PI / 2;

/**
 * The six faces: label, outward normal, and which way is up on the label.
 *
 * Orientation is built from both vectors rather than a single Euler angle. A
 * lone rotation gets the normal right and says nothing about the twist around
 * it, which is how text ends up sideways or upside down -- the prototype
 * dodged this by rotating Back about Y rather than X, a fix that does not
 * survive being remapped from its Y-up world to this Z-up one.
 *
 * The four sides stand upright against world up. Top and Bottom have no such
 * anchor, so they read with Back and Front at the top respectively, which is
 * the usual convention.
 *
 * @constant {Array}
 */
const FACES = [
  {
    label: 'Left', view: 'left', normal: [-1, 0, 0], up: [0, 0, 1],
  },
  {
    label: 'Right', view: 'right', normal: [1, 0, 0], up: [0, 0, 1],
  },
  {
    label: 'Front', view: 'front', normal: [0, -1, 0], up: [0, 0, 1],
  },
  {
    label: 'Back', view: 'back', normal: [0, 1, 0], up: [0, 0, 1],
  },
  {
    label: 'Top', view: 'top', normal: [0, 0, 1], up: [0, 1, 0],
  },
  {
    label: 'Bottom', view: 'bottom', normal: [0, 0, -1], up: [0, -1, 0],
  },
];

/** Reused while orienting the faces. */
const ORIGIN = new THREE.Vector3();
const faceNormal = new THREE.Vector3();
const faceUp = new THREE.Vector3();
const faceBasis = new THREE.Matrix4();

/** The eight corners, pulled in so they sit on the cube's shoulders. */
const CORNERS = [
  [1, 1, 1], [-1, 1, 1], [1, -1, 1], [-1, -1, 1],
  [1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1],
].map((corner) => corner.map((value) => value * 0.85));

/**
 * Rounded rectangle geometry, by @hofk.
 *
 * @param {Number} w width
 * @param {Number} h height
 * @param {Number} r corner radius
 * @param {Number} s smoothness
 * @returns {Object} THREE.BufferGeometry
 */
function roundedRectangle(w, h, r, s) {
  const wi = w / 2 - r;
  const hi = h / 2 - r;
  const ul = r / w;
  const ur = (w - r) / w;
  const vl = r / h;
  const vh = (h - r) / h;

  const positions = [wi, hi, 0, -wi, hi, 0, -wi, -hi, 0, wi, -hi, 0];
  const uvs = [ur, vh, ul, vh, ul, vl, ur, vl];
  const n = [
    3 * (s + 1) + 3, 3 * (s + 1) + 4, s + 4, s + 5, 2 * (s + 1) + 4, 2,
    1, 2 * (s + 1) + 3, 3, 4 * (s + 1) + 3, 4, 0,
  ];
  const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]
    .map((i) => n[i]);

  for (let i = 0; i < 4; i++) {
    const xc = i < 1 || i > 2 ? wi : -wi;
    const yc = i < 2 ? hi : -hi;
    const uc = i < 1 || i > 2 ? ur : ul;
    const vc = i < 2 ? vh : vl;

    for (let j = 0; j <= s; j++) {
      const phi = HALF_PI * (i + j / s);
      const cos = Math.cos(phi);
      const sin = Math.sin(phi);
      positions.push(xc + r * cos, yc + r * sin, 0);
      uvs.push(uc + ul * cos, vc + vl * sin);
      if (j < s) {
        const idx = (s + 1) * i + j + 4;
        indices.push(i, idx, idx + 1);
      }
    }
  }

  return new THREE.BufferGeometry()
    .setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1))
    .setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
    .setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
}

/**
 * One canvas holding every face in both states: two columns, plain and
 * hovered, six rows. Hovering then costs a texture offset rather than a
 * redraw.
 *
 * @returns {Object} HTMLCanvasElement
 */
function drawFaceAtlas() {
  const { resolution } = OPTIONS;
  const canvas = document.createElement('canvas');
  canvas.width = resolution * 2;
  canvas.height = resolution * FACES.length;
  const ctx = canvas.getContext('2d');

  const drawState = (x, y, background, foreground, label) => {
    ctx.fillStyle = background;
    ctx.fillRect(x, y, resolution, resolution);
    ctx.fillStyle = foreground;
    ctx.font = `600 ${resolution * 0.2}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + resolution / 2, y + resolution / 2);
  };

  FACES.forEach((face, index) => {
    const y = index * resolution;
    drawState(0, y, OPTIONS.faceBackground, OPTIONS.textColor, face.label);
    drawState(resolution, y, OPTIONS.hoverBackground, OPTIONS.hoverText, face.label);
  });
  return canvas;
}

class ViewCube {
  /**
   * @param {Object} camera the scene camera the cube reflects
   * @param {Object} domElement the scene canvas, whose panel holds the cube
   * @param {Object} handlers `{ pick(hit), orbit(dx, dy) }`: a click on a face
   *   or corner, and a drag in pixels
   */
  constructor(camera, domElement, handlers = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.handlers = handlers;
    this.hovered = null;
    this.mountCanvas();

    this.scene = new THREE.Scene();
    // Fixed and perspective, so the cube keeps its own sense of depth however
    // the scene camera is framed.
    this.gizmoCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    // Close enough that the cube and its corner discs nearly fill the square:
    // the corners reach sqrt(3) * 0.85 from the centre, and the visible half
    // height at this distance is a shade more than that.
    this.gizmoCamera.position.set(0, 0, 3.7);

    this.root = new THREE.Object3D();
    this.scene.add(this.root);

    this.planeGeometry = roundedRectangle(2, 2, OPTIONS.radius, OPTIONS.smoothness);
    const atlas = drawFaceAtlas();

    let backdropGeometry = null;
    this.planes = FACES.map((face, index) => {
      const map = new THREE.CanvasTexture(atlas);
      map.colorSpace = THREE.SRGBColorSpace;
      map.wrapS = THREE.RepeatWrapping;
      map.wrapT = THREE.RepeatWrapping;
      map.repeat.set(0.5, 1 / FACES.length);
      map.offset.set(0, 1 - (index + 1) / FACES.length);
      map.center.set(0, 0);
      map.anisotropy = 16;

      const plane = new THREE.Mesh(this.planeGeometry, new THREE.MeshBasicMaterial({ map }));
      faceNormal.set(face.normal[0], face.normal[1], face.normal[2]);
      faceUp.set(face.up[0], face.up[1], face.up[2]);
      plane.position.copy(faceNormal);
      // lookAt builds a basis whose +Z runs from the target to the eye, and a
      // plane is born facing +Z -- so looking from the normal back at the
      // centre points the face outward, with `up` fixing the twist.
      faceBasis.lookAt(faceNormal, ORIGIN, faceUp);
      plane.quaternion.setFromRotationMatrix(faceBasis);
      plane.userData = { type: 'face', view: face.view };

      // Measured at nearly full size for the backdrop, then shrunk: the
      // backdrop wants to meet at the edges, the faces want a margin.
      plane.scale.setScalar(0.9);
      plane.updateMatrix();
      const contribution = this.planeGeometry.clone().applyMatrix4(plane.matrix);
      backdropGeometry = backdropGeometry
        ? BufferGeometryUtils.mergeGeometries([backdropGeometry, contribution])
        : contribution;
      plane.scale.setScalar(0.72);

      this.root.add(plane);
      return plane;
    });

    this.backdrop = new THREE.Mesh(
      backdropGeometry,
      new THREE.MeshBasicMaterial({ color: OPTIONS.cubeBackground, side: THREE.BackSide }),
    );
    this.root.add(this.backdrop);

    this.circleGeometry = new THREE.CircleGeometry(0.2, 32);
    this.corners = CORNERS.map((corner) => {
      const circle = new THREE.Mesh(
        this.circleGeometry,
        new THREE.MeshBasicMaterial({ color: OPTIONS.circleColor }),
      );
      circle.position.set(corner[0], corner[1], corner[2]);
      // Turned to face outward along its own diagonal.
      circle.lookAt(circle.position.clone().multiplyScalar(2));
      circle.userData = { type: 'corner', direction: circle.position.clone().normalize() };
      this.root.add(circle);
      return circle;
    });

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.viewport = new THREE.Vector4();
  }

  /**
   * Turns a pointer event into gizmo-local normalised coordinates.
   *
   * @public
   * @param {Object} event pointer event
   * @returns {Boolean} whether the pointer is over the gizmo at all
   */
  locate(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return false;
    this.pointer.set(x * 2 - 1, -(y * 2) + 1);
    return true;
  }

  /**
   * Whatever part of the cube the pointer is over.
   *
   * @public
   * @param {Object} event pointer event
   * @returns {Object|null} the mesh under the pointer
   */
  pick(event) {
    if (!this.locate(event)) return null;
    this.raycaster.setFromCamera(this.pointer, this.gizmoCamera);
    const hits = this.raycaster.intersectObjects([...this.planes, ...this.corners], false);
    return hits.length ? hits[0].object : null;
  }

  /**
   * Highlights whatever the pointer is over.
   *
   * @public
   * @param {Object} event pointer event
   * @returns {Boolean} whether the pointer is over the gizmo
   */
  handlePointerMove(event) {
    const target = this.pick(event);
    if (target === this.hovered) return !!target;
    this.setHovered(this.hovered, false);
    this.setHovered(target, true);
    this.hovered = target;
    return !!target;
  }

  /**
   * Draws one piece in its plain or hovered state.
   *
   * @public
   * @param {Object} mesh piece to change, or null
   * @param {Boolean} state whether it is hovered
   */
  // eslint-disable-next-line class-methods-use-this
  setHovered(mesh, state) {
    if (!mesh) return;
    if (mesh.userData.type === 'face') {
      // The hovered artwork is the atlas's second column.
      mesh.material.map.offset.x = state ? 0.5 : 0;
    } else {
      mesh.material.color.set(state ? OPTIONS.circleHoverColor : OPTIONS.circleColor);
    }
  }

  /**
   * What a click selected.
   *
   * @public
   * @param {Object} event pointer event
   * @returns {Object|null} `{view}` for a face, `{direction}` for a corner
   */
  handleClick(event) {
    const target = this.pick(event);
    if (!target) return null;
    if (target.userData.type === 'face') return { view: target.userData.view };
    return { direction: target.userData.direction.clone() };
  }

  /**
   * Drops any highlight, for when the pointer leaves the canvas entirely.
   *
   * @public
   */
  clearHover() {
    this.setHovered(this.hovered, false);
    this.hovered = null;
  }

  /**
   * Draws the gizmo over the finished image.
   *
   * @public
   * @param {Object} renderer THREE.WebGLRenderer
   */
  render(renderer) {
    this.place();
    if (this.canvas.style.display === 'none') return;
    // Turned to match the camera, so a face points at the viewer exactly when
    // looking down that axis.
    this.root.quaternion.copy(this.camera.quaternion).invert();
    this.root.updateMatrixWorld();
    // Drawn as the scene's renderer would have drawn it.
    this.renderer.outputColorSpace = renderer.outputColorSpace;
    this.renderer.toneMapping = renderer.toneMapping;
    this.renderer.toneMappingExposure = renderer.toneMappingExposure;
    this.renderer.render(this.scene, this.gizmoCamera);
  }

  /**
   * Creates the cube's own canvas and renderer, in the scene canvas's panel.
   *
   * @private
   */
  mountCanvas() {
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute',
      width: `${DIM}px`,
      height: `${DIM}px`,
      right: `${MARGIN}px`,
      zIndex: 2,
    });
    const panel = this.domElement.parentElement;
    if (getComputedStyle(panel).position === 'static') panel.style.position = 'relative';
    panel.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(DIM, DIM, false);

    this.downAt = null;
    this.dragged = false;
    this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.downAt) this.clearHover();
    });
    this.canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.canvas.setPointerCapture(event.pointerId);
      this.downAt = { x: event.clientX, y: event.clientY };
      this.lastAt = { x: event.clientX, y: event.clientY };
      this.dragged = false;
    });
    this.canvas.addEventListener('pointerup', (event) => {
      const down = this.downAt;
      this.downAt = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      if (!down || this.dragged) return;
      const hit = this.handleClick(event);
      if (hit && this.handlers.pick) this.handlers.pick(hit);
    });
  }

  /**
   * Hovers, or, with the button held, turns the view: dragging the cube
   * orbits as dragging the scene does.
   *
   * @private
   * @param {Object} event pointer event
   */
  onPointerMove(event) {
    if (!this.downAt) {
      this.canvas.style.cursor = this.handlePointerMove(event) ? 'pointer' : 'grab';
      return;
    }
    const travelled = Math.hypot(event.clientX - this.downAt.x, event.clientY - this.downAt.y);
    if (travelled > CLICK_SLOP_PX) this.dragged = true;
    if (!this.dragged) return;
    const dx = event.clientX - this.lastAt.x;
    const dy = event.clientY - this.lastAt.y;
    this.lastAt = { x: event.clientX, y: event.clientY };
    if (this.handlers.orbit) this.handlers.orbit(dx, dy);
  }

  /**
   * Keeps the canvas at the top-right of the panel, just under its header,
   * and hidden with the scene canvas.
   *
   * @private
   */
  place() {
    const shown = this.domElement.offsetWidth > 0 && this.domElement.offsetHeight > 0;
    const display = shown ? '' : 'none';
    if (this.canvas.style.display !== display) this.canvas.style.display = display;
    if (!shown) return;
    const header = this.domElement.previousElementSibling;
    const top = (header ? header.offsetTop + header.offsetHeight : 0) + MARGIN;
    const css = `${top}px`;
    if (this.canvas.style.top !== css) this.canvas.style.top = css;
  }

  /**
   * Releases the textures and geometry.
   *
   * @public
   */
  dispose() {
    this.renderer.dispose();
    this.canvas.remove();
    this.planes.forEach((plane) => {
      plane.material.map.dispose();
      plane.material.dispose();
    });
    this.corners.forEach((circle) => circle.material.dispose());
    this.planeGeometry.dispose();
    this.circleGeometry.dispose();
    this.backdrop.geometry.dispose();
    this.backdrop.material.dispose();
  }
}

export default ViewCube;
