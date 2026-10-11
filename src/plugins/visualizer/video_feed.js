import * as THREE from 'three';
import VideoDecode from './video_decode';
import { FILE_PREFIX } from '../../models/DMX/video_input';

/**
 * @file A live video source, as a texture.
 *
 * The renderer's half of the NDI path. Frames arrive from the preload as
 * `window` messages carrying a **transferred** ArrayBuffer -- see `ndi.js` and
 * the `ndi` bridge in `preload.js` -- so by the time one reaches here it has
 * been moved, not copied, and this module owns it outright.
 *
 * What it deliberately does not do yet: slicing a frame into regions, or
 * connectors, or anything that consumes the texture. This is the pipe.
 *
 * A source named `file:<name>` is an image or video file from the media
 * library instead: `FileFeed` below, which hands over the same fields so
 * nothing downstream can tell the two apart.
 */

export { FILE_PREFIX };

/** Open feeds by handle, so an arriving frame can find the one it belongs to. */
const feeds = new Map();

/** Opens under way, by source name, so a second caller shares the first's. */
const opening = new Map();

/**
 * Whether video input is available at all.
 *
 * Absent in a plain browser, and absent if the addon would not load -- the
 * bridge is only exposed when `ndi.js` imported cleanly. Callers check this
 * rather than trapping on `window.ndi`.
 *
 * @returns {Boolean}
 */
function available() {
  return typeof window !== 'undefined' && !!window.ndi;
}

/**
 * A frame lands here for every open feed, on the page's own thread.
 *
 * A frame for a handle nobody holds is simply dropped: the buffer was
 * transferred to this world, so letting go of it is all that is needed to
 * release the 8 MB.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.channel !== 'ndi:frame') return;
    const feed = feeds.get(message.handle);
    if (feed) feed.accept(message);
  });
}

class VideoFeed {
  /**
   * @param {Number} handle from the bridge
   * @param {String} name the source it was opened from
   */
  constructor(handle, name) {
    this._handle = handle;
    this._name = name;
    this._texture = null;
    this._format = 'RGBA';
    this._width = 0;
    this._height = 0;
    // Only ever the newest. A 60 fps sender into a renderer that is busy would
    // otherwise build a queue of 8 MB frames, and every one but the last is
    // already stale by the time it could be drawn.
    this._pending = null;
    this._frames = 0;
    this._holders = 1;
  }

  get name() { return this._name; }

  /** 'UYVY' or 'RGBA' -- how the texture's bytes are packed. */
  get format() { return this._format; }

  /** Width of the *picture*, which for UYVY is twice the texture's. */
  get width() { return this._width; }

  /**
   * The bytes of the newest frame, exactly as uploaded.
   *
   * For anything that has to show this feed in a **second WebGL context** --
   * the slicing popup does, because a texture belongs to the context that
   * uploaded it and cannot be handed to another. The array is replaced each
   * frame rather than written into, so a holder must re-read it rather than
   * keep a reference; `frameCount` says when.
   *
   * @returns {Uint8Array|null}
   */
  get pixels() { return this._texture ? this._texture.image.data : null; }

  /**
   * The texture the **scene** should draw this feed from.
   *
   * Not `texture`: that one is the bytes as they arrived, which for UYVY cannot
   * be filtered or mipped at all. This is the unpacked RGBA copy, with a mip
   * chain, so a screen far enough away averages the pixels it covers instead of
   * picking one of them. Null until the first frame has been decoded.
   *
   * The slicing popup still uses `texture`, because a texture belongs to the
   * context that uploaded it and the popup renders in one of its own.
   *
   * @readonly
   * @type {Object|null}
   */
  get displayTexture() { return VideoDecode.textureFor(this); }

  /** Texture width, which is half the picture's when the format is UYVY. */
  get texels() { return this._texture ? this._texture.image.width : 0; }

  get height() { return this._height; }

  /** @returns {THREE.DataTexture|null} null until the first frame lands */
  get texture() { return this._texture; }

  /** How many frames have been taken up into the texture. */
  get frameCount() { return this._frames; }

  /** Claims this feed for one more holder. See `close`. */
  retain() { this._holders += 1; }

  /**
   * Takes delivery of a frame. Called from the message listener, not by users.
   *
   * @param {Object} message `{ width, height, stride, buffer }`
   */
  accept(message) {
    this._pending = message;
  }

  /**
   * Moves the newest frame into the texture, if one has arrived.
   *
   * Called once per rendered frame rather than on arrival, so that a source
   * running faster than the display costs one upload per *drawn* frame instead
   * of one per received frame.
   *
   * @returns {Boolean} whether the texture changed
   */
  update() {
    const frame = this._pending;
    if (!frame) return false;
    this._pending = null;

    const {
      width, height, stride, buffer,
    } = frame;
    const format = frame.format === 'UYVY' ? 'UYVY' : 'RGBA';
    // UYVY carries two pixels in four bytes, so a row is half as many texels
    // as it is pixels -- and the texture is uploaded at that width. The shader
    // in `video_material.js` unpacks it; nothing here interprets the bytes.
    const texels = format === 'UYVY' ? width / 2 : width;
    const tight = texels * 4;
    let pixels = new Uint8Array(buffer);

    // A sender is entitled to pad its rows, and then the buffer is not an
    // image -- it is rows with gaps. MadMapper sends tight (7680 bytes for
    // 1920), so this repack has not been exercised against a real padded
    // sender; it is here so that one does not render as a diagonal smear.
    if (stride !== tight) {
      const packed = new Uint8Array(tight * height);
      for (let row = 0; row < height; row += 1) {
        packed.set(pixels.subarray(row * stride, row * stride + tight), row * tight);
      }
      pixels = packed;
    }

    // A source can change resolution mid-stream -- switching composition in
    // MadMapper does exactly that -- so the texture is rebuilt rather than
    // assumed. `DataTexture` cannot be resized in place.
    if (!this._texture
      || this._texture.image.width !== texels
      || this._texture.image.height !== height
      || this._format !== format) {
      if (this._texture) this._texture.dispose();
      const { RGBAFormat, UnsignedByteType } = THREE;
      this._texture = new THREE.DataTexture(pixels, texels, height, RGBAFormat, UnsignedByteType);
      // Packed bytes are not a colour, so nothing may be interpolated or
      // colour-managed on the way in: blending a luma with a chroma produces
      // garbage that reads as ringing along every vertical edge. The shader
      // converts, and converts to sRGB itself.
      this._texture.colorSpace = format === 'UYVY'
        ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      const filter = format === 'UYVY' ? THREE.NearestFilter : THREE.LinearFilter;
      this._texture.minFilter = filter;
      this._texture.magFilter = filter;
      // No mipmaps: they would be rebuilt from scratch every frame, and
      // nothing samples this minified yet.
      this._texture.generateMipmaps = false;
      // NDI hands over rows top-down; GL's origin is bottom-left.
      this._texture.flipY = true;
    } else {
      this._texture.image.data = pixels;
    }

    this._texture.needsUpdate = true;
    this._format = format;
    this._width = width;
    this._height = height;
    this._frames += 1;
    return true;
  }

  /**
   * Stops the receiver and releases the texture, once nobody wants it.
   *
   * Reference counted, because two things legitimately want the same source
   * at once -- the scene and the slicing popup -- and a second receiver on one
   * sender is a second 16 MB frame every 33 ms for the same pixels.
   */
  close() {
    this._holders -= 1;
    if (this._holders > 0) return;
    feeds.delete(this._handle);
    if (available()) window.ndi.close(this._handle);
    VideoDecode.release(this);
    if (this._texture) {
      this._texture.dispose();
      this._texture = null;
    }
    this._pending = null;
  }
}

/**
 * An image or video file as a feed.
 *
 * The same fields as an NDI feed, so the decode step, the projectors and the
 * display panels take it unchanged: an sRGB RGBA texture, flipped as NDI's
 * is, and a frame count that moves when the picture does. A video plays muted
 * and loops, from the moment it is opened, and its frame count moves with
 * each decoded frame. An image moves it once, when it has loaded.
 */
class FileFeed {
  /**
   * @param {String} name the source name, `file:<key>`
   * @param {Object} entry from `window.library.media()`
   */
  constructor(name, entry) {
    this._name = name;
    this._entry = entry;
    this._texture = null;
    this._element = null;
    this._width = 0;
    this._height = 0;
    this._frames = 0;
    this._holders = 1;
    this._closed = false;
  }

  get name() { return this._name; }

  get format() { return 'RGBA'; }

  get width() { return this._width; }

  get height() { return this._height; }

  get texels() { return this._width; }

  get texture() { return this._texture; }

  get frameCount() { return this._frames; }

  get displayTexture() { return VideoDecode.textureFor(this); }

  /** No byte array: the picture is an element. See `element`. */
  get pixels() { return null; }

  /** The image or video element, for a second GL context that wants the picture. */
  get element() { return this._element; }

  /** `image` or `video`. */
  get kind() { return this._entry.kind; }

  retain() { this._holders += 1; }

  /**
   * Starts loading the file.
   *
   * @returns {Promise<FileFeed>} once the first picture is in the texture
   */
  load() {
    return this._entry.kind === 'video' ? this.loadVideo() : this.loadImage();
  }

  /** @private */
  textureFrom(element, width, height) {
    const texture = this._entry.kind === 'video'
      ? new THREE.VideoTexture(element)
      : new THREE.Texture(element);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.flipY = true;
    texture.needsUpdate = true;
    this._texture = texture;
    this._width = width;
    this._height = height;
  }

  /** @private */
  loadImage() {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        if (this._closed) { resolve(this); return; }
        this._element = image;
        this.textureFrom(image, image.naturalWidth, image.naturalHeight);
        this._frames += 1;
        resolve(this);
      };
      image.onerror = () => reject(new Error(`could not load ${this._entry.key}`));
      image.src = this._entry.url;
    });
  }

  /** @private */
  loadVideo() {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'auto';
      const counted = () => {
        if (this._closed) return;
        this._frames += 1;
        if (this._texture) this._texture.needsUpdate = true;
        video.requestVideoFrameCallback(counted);
      };
      video.onloadeddata = () => {
        // Once: a looping video can report loaded data again at each restart,
        // and a second run would build a second texture and a second counter.
        video.onloadeddata = null;
        if (this._closed) { resolve(this); return; }
        this._element = video;
        this.textureFrom(video, video.videoWidth, video.videoHeight);
        this._frames += 1;
        video.requestVideoFrameCallback(counted);
        video.play().catch(() => {});
        resolve(this);
      };
      video.onerror = () => reject(new Error(`could not play ${this._entry.key}`));
      video.src = this._entry.url;
    });
  }

  /** Nothing to move: the element is the frame. */
  // eslint-disable-next-line class-methods-use-this
  update() { return false; }

  /** Stops playback and releases the texture once nobody wants it. */
  close() {
    this._holders -= 1;
    if (this._holders > 0) return;
    this._closed = true;
    // Only its own entry: a feed opened again under this name may hold it.
    if (feeds.get(this._name) === this) feeds.delete(this._name);
    VideoDecode.release(this);
    if (this._element && this._element.tagName === 'VIDEO') {
      this._element.pause();
      this._element.removeAttribute('src');
      this._element.load();
    }
    this._element = null;
    if (this._texture) {
      this._texture.dispose();
      this._texture = null;
    }
  }
}

/**
 * Whether media files can be a source: the desktop app's library bridge.
 *
 * @returns {Boolean}
 */
function filesAvailable() {
  return typeof window !== 'undefined' && !!(window.library && window.library.media);
}

/**
 * The image and video files on offer.
 *
 * @returns {Promise<Array>} `{ key, name, kind, origin, url }`, empty when unavailable
 */
async function files() {
  if (!filesAvailable()) return [];
  return window.library.media();
}

/**
 * Asks for a file and copies it into the media library.
 *
 * @returns {Promise<Object>} `{ ok, entry }` or `{ ok: false, reason }`
 */
async function addFile() {
  if (!filesAvailable()) return { ok: false, reason: 'Files need the desktop app.' };
  return window.library.addMedia();
}

/**
 * Opens a media file as a feed.
 *
 * @param {String} name `file:<key>`
 * @returns {Promise<FileFeed|null>} null when no folder has the file
 */
async function openFile(name) {
  const key = name.slice(FILE_PREFIX.length);
  const entry = (await files()).find((candidate) => candidate.key === key);
  if (!entry) return null;
  const feed = new FileFeed(name, entry);
  feeds.set(name, feed);
  try {
    await feed.load();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[video] file source:', err.message);
    feed.close();
    return null;
  }
  return feed;
}

/**
 * Everything advertising itself on the network.
 *
 * @param {Number} [waitMs]
 * @returns {Promise<Array>} `{ name, urlAddress }`, empty when unavailable
 */
async function sources(waitMs) {
  if (!available()) return [];
  return window.ndi.sources(waitMs);
}

/**
 * Opens a named source.
 *
 * @param {String} name exactly as `sources` reported it
 * @returns {Promise<VideoFeed|null>} null when video input is unavailable
 */
async function open(name) {
  // Shared rather than duplicated. Whoever opens second gets the same feed and
  // a claim on it; `close` only tears down when the last claim goes.
  const existing = Array.from(feeds.values()).find((feed) => feed.name === name);
  if (existing) {
    existing.retain();
    return existing;
  }
  // Two callers asking for a name at once -- the scene and the Video window,
  // when an input's file changes -- must share one open. Each going ahead on
  // its own made two feeds for one name, and only one of them was decoded.
  if (opening.has(name)) {
    const feed = await opening.get(name);
    if (feed) feed.retain();
    return feed;
  }
  const started = (async () => {
    if (typeof name === 'string' && name.startsWith(FILE_PREFIX)) return openFile(name);
    if (!available()) return null;
    const handle = await window.ndi.open(name);
    const feed = new VideoFeed(handle, name);
    feeds.set(handle, feed);
    return feed;
  })();
  opening.set(name, started);
  try {
    return await started;
  } finally {
    opening.delete(name);
  }
}

/** Every feed currently open. */
function all() {
  return Array.from(feeds.values());
}

/** Moves the newest frame of every open feed into its texture. */
function updateAll() {
  feeds.forEach((feed) => feed.update());
}

export default {
  available,
  sources,
  open,
  all,
  updateAll,
  VideoFeed,
  filesAvailable,
  files,
  addFile,
  FileFeed,
  FILE_PREFIX,
};
