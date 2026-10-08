import PatchSingleton, { DMX_UNIVERSE_LENGTH } from '@/models/DMX/patch.model';
import { subscribeFrames } from '@/plugins/artnet.frames';
import EventBus from '@/plugins/eventbus';
import Preferences from '@/plugins/visualizer/preferences';

/**
 * Renderer-side Art-Net connection manager.
 *
 * Bridges the main-process DMX sockets -- Art-Net and sACN, exposed together as
 * `window.artnet` because both deliver the same frames -- to the DMX model
 * layer:
 *  - input:  inbound frames are written straight into the show's address space,
 *            which fans the 512-byte buffer out to patched fixtures — the same
 *            path that drives the 3D visualizer from manual faders.
 *
 * When `window.artnet` is unavailable (plain browser), every method is a safe
 * no-op.
 */

/**
 * How often the patched universes are re-checked, in ms.
 *
 * Polled rather than announced. The patch has no change event, and the set is
 * read off a run list that is short even for a rig of hundreds -- so a compare
 * every couple of seconds costs nothing and needs no hook in the model that
 * every future caller would have to remember to fire.
 */
const UNIVERSE_WATCH_MS = 2000;

/**
 * How often sender mode looks for changed values, in ms. DMX's own refresh
 * rate is about 44 Hz; this is the common 40.
 */
const SEND_TICK_MS = 25;

/**
 * How long an unchanged universe goes before it is sent again, in ms. Well
 * inside E1.31's 2.5 s loss timeout, so a receiver never drops the source
 * while nothing on the panels moves.
 */
const KEEPALIVE_MS = 1000;

/** How often sender mode checks for another sender on its universes, in ms. */
const SENDER_CHECK_MS = 2000;

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {Boolean} whether the two hold the same bytes
 */
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

class ArtNetConnection {
  constructor() {
    this.inputEnabled = false;
    this.unsubscribe = null;
    this.universeTimer = null;
    /** The last set announced, as a string, so a compare is one comparison. */
    this.announced = '';
    /** Whether Beam is driving the wire rather than listening to it. */
    this.sending = false;
    this.sendTimer = null;
    this.senderCheckTimer = null;
    /** Per universe: `{ data, at }`, the bytes last sent and when. */
    this.sent = new Map();
    /** Scratch universe, filled from the fixtures each tick. */
    this.scratch = new Uint8Array(DMX_UNIVERSE_LENGTH);
    /** Other sources heard on a universe Beam is sending: `{ name, universes }`. */
    this.otherSenders = [];
  }

  /** Whether a native Art-Net bridge is present (i.e. running under Electron). */
  // eslint-disable-next-line class-methods-use-this
  get available() {
    return typeof window !== 'undefined' && !!window.artnet;
  }

  /**
   * Opens the receive socket and starts routing inbound frames to universes.
   */
  enableInput() {
    if (!this.available || this.inputEnabled) return;
    window.artnet.start({});
    // A page reload leaves main in whatever mode the last page set. Every
    // launch starts as a receiver.
    if (window.artnet.setSending) window.artnet.setSending(false);
    this.unsubscribe = subscribeFrames((universe, data) => {
      // The universe number is an offset into the show's address space, not a
      // lookup key: a frame is delivered whether or not a Universe object
      // exists for it, and a fixture straddling the boundary is filled by the
      // two frames that cover its channels.
      PatchSingleton.writeUniverse(universe, data);
    });
    this.watchUniverses();
    this.inputEnabled = true;
  }

  /**
   * Keeps sACN's multicast memberships in step with what the show has patched.
   *
   * Art-Net needs none of this -- it is broadcast or unicast, and arrives
   * whatever is patched. sACN normally arrives on a multicast group per
   * universe, and a group has to be joined before anything from it is seen, so
   * a fixture patched into a universe nobody has joined is a fixture that
   * never lights.
   *
   * @public
   */
  watchUniverses() {
    if (!this.available || !window.artnet.listenTo || this.universeTimer) return;
    const announce = () => {
      const universes = PatchSingleton.patchedUniverses();
      const key = universes.join();
      if (key === this.announced) return;
      this.announced = key;
      window.artnet.listenTo(universes);
    };
    announce();
    this.universeTimer = setInterval(announce, UNIVERSE_WATCH_MS);
  }

  /**
   * Stops routing inbound frames.
   */
  disableInput() {
    // Only stop routing frames locally; the socket itself stays open and owned
    // by the main process.
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.universeTimer) {
      clearInterval(this.universeTimer);
      this.universeTimer = null;
    }
    this.inputEnabled = false;
  }

  /**
   * Makes Beam the sender, or a receiver again.
   *
   * Sending: inbound DMX is held back and every patched universe goes out on
   * the protocol in `sendOptions`, built from the values the fixtures hold
   * now, so nothing moves at the switch. A universe is sent when it changes,
   * and once a second regardless.
   *
   * Receiving again: the fixtures keep their values until a frame arrives, and
   * the first frame of every universe is written through in full -- diffed
   * against the frame before sender mode, a channel set by hand would stay set
   * wherever the wire had not moved.
   *
   * @public
   * @param {Boolean} enabled
   */
  async setSending(enabled) {
    const sending = !!enabled;
    if (!this.available || !window.artnet.setSending || sending === this.sending) return;
    this.sending = sending;
    if (sending) {
      await window.artnet.setSending(true, this.sendOptions);
      this.sent.clear();
      this.sendTimer = setInterval(() => this.sendChanged(), SEND_TICK_MS);
      this.senderCheckTimer = setInterval(() => this.checkOtherSenders(), SENDER_CHECK_MS);
      this.sendChanged();
    } else {
      clearInterval(this.sendTimer);
      clearInterval(this.senderCheckTimer);
      this.sendTimer = null;
      this.senderCheckTimer = null;
      this.otherSenders = [];
      PatchSingleton.invalidateInputShadow();
      await window.artnet.setSending(false);
    }
    this.announceMode();
  }

  /**
   * What sender mode speaks and where to: `{ protocol, target }`.
   *
   * @readonly
   * @type {Object}
   */
  // eslint-disable-next-line class-methods-use-this
  get sendOptions() {
    return {
      protocol: Preferences.get('dmxSendProtocol') === 'artnet' ? 'artnet' : 'sacn',
      target: String(Preferences.get('dmxSendTarget') || '').trim(),
    };
  }

  /**
   * Changes what sender mode speaks, and switches over at once if sending.
   *
   * @public
   * @async
   * @param {Object} options `{ protocol, target }`, either may be left out
   */
  async setSendOptions({ protocol, target } = {}) {
    if (protocol !== undefined) Preferences.set('dmxSendProtocol', protocol);
    if (target !== undefined) Preferences.set('dmxSendTarget', String(target).trim());
    if (!this.sending) return;
    await window.artnet.setSending(true, this.sendOptions);
    // Everything goes out at once on the new protocol rather than waiting for
    // a change or the keepalive.
    this.sent.clear();
    this.sendChanged();
  }

  /**
   * Sends every patched universe whose values changed, or that has not been
   * sent for a second.
   *
   * @private
   */
  sendChanged() {
    const now = Date.now();
    const { scratch } = this;
    PatchSingleton.patchedUniverses().forEach((universe) => {
      PatchSingleton.readUniverse(universe, scratch);
      let last = this.sent.get(universe);
      if (last && now - last.at < KEEPALIVE_MS && bytesEqual(last.data, scratch)) return;
      if (!last) {
        last = { data: new Uint8Array(DMX_UNIVERSE_LENGTH), at: 0 };
        this.sent.set(universe, last);
      }
      last.data.set(scratch);
      last.at = now;
      window.artnet.send(universe, scratch);
    });
  }

  /**
   * Looks for anyone else sending a universe Beam is sending, which is the
   * thing that makes a real fixture twitch between two masters.
   *
   * @private
   * @async
   */
  async checkOtherSenders() {
    if (!this.sending) return;
    const { sources } = await this.sources();
    const ours = new Set(PatchSingleton.patchedUniverses());
    const others = sources
      .filter((source) => !source.stale)
      .map((source) => ({
        name: source.name,
        universes: source.universes.filter((universe) => ours.has(universe)),
      }))
      .filter((source) => source.universes.length);
    const key = JSON.stringify(others);
    if (key === JSON.stringify(this.otherSenders)) return;
    this.otherSenders = others;
    this.announceMode();
  }

  /**
   * Tells the panels which mode Beam is in.
   *
   * @private
   */
  announceMode() {
    EventBus.emit('dmx_mode', { sending: this.sending, otherSenders: this.otherSenders });
  }

  /**
   * Who is sending on either wire, and where two of them collide.
   *
   * @public
   * @async
   * @returns {Promise<Object>} `{ sources, conflicts }`, empty outside Electron
   */
  async sources() {
    if (!this.available || !window.artnet.sources) return { sources: [], conflicts: [] };
    return window.artnet.sources();
  }
}

export default new ArtNetConnection();
