/**
 * @file A video input: one picture the show receives, from an NDI stream or a
 * file.
 *
 * Beam receives video and does not compose it. Laying content out across
 * outputs is the media server's job; Beam models the cabling, which picture
 * reaches which device. So an input is a whole picture, and a display or
 * projector picks one by id and shows all of it. Any number of devices can
 * share an input, as a distribution amplifier does.
 *
 * An input is show data. Which NDI sender fills it is a fact about one
 * machine -- a sender's name means nothing on another computer -- so that
 * binding is a preference keyed by the input's `uid`, never stored here. A
 * file input names its file, which travels with the show.
 *
 * See `docs/video-inputs-plan.md`.
 */

/** The prefix that marks a feed name as a media file. */
export const FILE_PREFIX = 'file:';

/** What an input can be. */
export const INPUT_KINDS = { NDI: 'ndi', FILE: 'file' };

/** Rotations a device can turn its picture by, clockwise. */
export const ROTATIONS = [0, 90, 180, 270];

let nextId = 1;

/** A stable identity for the machine's binding, unique across shows. */
function newUid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `in-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A file name without its folder or extension. */
function baseName(file) {
  const name = String(file || '').split(/[\\/]/).pop();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

class VideoInput {
  /**
   * @param {Object} [data] as stored in the show
   */
  constructor(data = {}) {
    const id = Math.round(Number(data.id));
    this._id = Number.isFinite(id) && id > 0 ? id : nextId;
    if (this._id >= nextId) nextId = this._id + 1;
    this.uid = typeof data.uid === 'string' && data.uid ? data.uid : newUid();
    this.kind = data.kind === INPUT_KINDS.FILE ? INPUT_KINDS.FILE : INPUT_KINDS.NDI;
    this.file = this.kind === INPUT_KINDS.FILE ? String(data.file || '') : '';
    const name = String(data.name || '').trim();
    this.name = name || this.defaultName();
  }

  /** @type {Number} what a device's source names */
  get id() { return this._id; }

  /**
   * The name an input gets until someone gives it one: the file's, or a
   * numbered NDI input until it is bound.
   *
   * @returns {String}
   */
  defaultName() {
    if (this.kind === INPUT_KINDS.FILE) return baseName(this.file) || `File ${this._id}`;
    return `NDI input ${this._id}`;
  }

  /**
   * The feed to open for this input.
   *
   * @param {String} [sender] this machine's binding, for an NDI input
   * @returns {String} a feed name, or empty when there is nothing to open
   */
  feedName(sender = '') {
    if (this.kind === INPUT_KINDS.FILE) return this.file ? `${FILE_PREFIX}${this.file}` : '';
    return sender || '';
  }

  /** @type {Object} what the show saves */
  get showData() {
    const data = {
      id: this._id, uid: this.uid, name: this.name, kind: this.kind,
    };
    if (this.kind === INPUT_KINDS.FILE) data.file = this.file;
    return data;
  }
}

/**
 * Where an output pixel samples the input, after the device's turn and
 * mirrors.
 *
 * Output space has its origin at the top-left of what the device shows. The
 * picture is turned **clockwise** first, and the mirrors are applied after, in
 * the output's own axes -- so Mirror H mirrors what the viewer sees
 * left-to-right whatever the turn.
 *
 * @param {Number} u 0..1 across the output
 * @param {Number} v 0..1 down the output
 * @param {Object} [orientation] `{ rotation, mirrorH, mirrorV }`
 * @returns {Object} `{ x, y }` in the input, 0..1 from its top-left
 */
export function orientedSample(u, v, orientation = {}) {
  const uf = orientation.mirrorH ? 1 - u : u;
  const vf = orientation.mirrorV ? 1 - v : v;
  // Turning clockwise carries the input's bottom-left corner to the output's
  // top-left, so an output row reads down an input column.
  switch (orientation.rotation) {
    case 90: return { x: vf, y: 1 - uf };
    case 180: return { x: 1 - uf, y: 1 - vf };
    case 270: return { x: 1 - vf, y: uf };
    default: return { x: uf, y: vf };
  }
}

/** Whether a stored connector rectangle covers its whole frame. */
function coversFrame(connector) {
  const rect = connector.rect || {};
  const frame = connector.frame || {};
  const scaleX = frame.width > 0 ? frame.width : 1;
  const scaleY = frame.height > 0 ? frame.height : 1;
  const x = (Number(rect.x) || 0) / scaleX;
  const y = (Number(rect.y) || 0) / scaleY;
  const w = rect.width === undefined ? 1 : Number(rect.width) / scaleX;
  const h = rect.height === undefined ? 1 : Number(rect.height) / scaleY;
  const near = (a, b) => Math.abs(a - b) < 0.002;
  return near(x, 0) && near(y, 0) && near(w, 1) && near(h, 1);
}

/**
 * Brings a show saved with connectors to inputs.
 *
 * A show from before inputs had one picture for the whole scene, cut into
 * connectors, and either a file (`videoFile`) or this machine's NDI sender
 * behind it. It becomes one input of that kind. Each device on a connector
 * moves to that input and keeps the connector's turn and mirrors; a device on
 * a connector smaller than the frame now shows the whole frame, and is listed
 * so the user can be told.
 *
 * Pure: returns new data and changes nothing it is given.
 *
 * @param {Object} showData as read from the file
 * @param {String} [legacySender] this machine's old `videoSource` preference
 * @returns {Object} `{ showData, binding, lostCrop }` -- the migrated data, the
 *   `{ uid, sender }` to bind on this machine or null, and the names of the
 *   devices that lost a crop
 */
export function migrateVideo(showData, legacySender = '') {
  const data = showData || {};
  if (Array.isArray(data.videoInputs)) return { showData: data, binding: null, lostCrop: [] };

  const connectors = Array.isArray(data.videoConnectors) ? data.videoConnectors : [];
  const file = typeof data.videoFile === 'string' ? data.videoFile : '';
  const fixtures = Array.isArray(data.fixtures) ? data.fixtures : [];
  const onSource = fixtures.some((f) => f && f.device && f.device.source !== undefined
    && f.device.source !== null);

  const next = { ...data };
  delete next.videoConnectors;
  delete next.videoFile;

  if (!file && !connectors.length && !onSource) {
    next.videoInputs = [];
    return { showData: next, binding: null, lostCrop: [] };
  }

  const input = file
    ? new VideoInput({ id: 1, kind: INPUT_KINDS.FILE, file })
    : new VideoInput({ id: 1, kind: INPUT_KINDS.NDI, name: legacySender || '' });
  next.videoInputs = [input.showData];

  const lostCrop = [];
  next.fixtures = fixtures.map((fixture) => {
    if (!fixture || !fixture.device) return fixture;
    const { source } = fixture.device;
    if (source === undefined || source === null) return fixture;
    const connector = connectors.find((c) => c && c.id === source);
    const device = { ...fixture.device, source: input.id };
    if (connector) {
      if (ROTATIONS.includes(connector.rotation)) device.rotation = connector.rotation;
      if (connector.flipH) device.mirrorH = true;
      if (connector.flipV) device.mirrorV = true;
      if (!coversFrame(connector)) lostCrop.push(fixture.name || `fixture ${fixture.id}`);
    }
    return { ...fixture, device };
  });

  const binding = input.kind === INPUT_KINDS.NDI && legacySender
    ? { uid: input.uid, sender: legacySender } : null;
  return { showData: next, binding, lostCrop };
}

export default VideoInput;
