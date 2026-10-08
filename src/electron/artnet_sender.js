/* eslint-disable no-console */
/* eslint-disable no-bitwise */
import dgram from 'dgram';
import os from 'os';
import { ARTNET_PORT, ARTNET_ID, OP_DMX } from './artnet_wire';

/**
 * Art-Net transmitter (main process), for sender mode.
 *
 * The other way to reach a fixture: a node on the network, or a program on
 * this machine. Broadcast by default, because a receiver on this machine
 * shares Beam's port, and on Windows a datagram sent straight to a shared port
 * reaches only one of the sockets bound to it -- measured, where a broadcast
 * reached both. A target address is for a node elsewhere.
 *
 * Art-Net names no source, so Beam's receiver recognises its own packets by
 * where they come from: this socket's port, on one of this machine's
 * addresses.
 *
 * @see https://art-net.org.uk/ (ArtDMX / OpDmx = 0x5000)
 */

/** Slots in a universe. */
const SLOTS = 512;

/** ArtDmx header, then the slots. */
const HEADER = 18;

/** Art-Net protocol revision this speaks. */
const PROTOCOL_VERSION = 14;

/** Where a packet goes when no target is given. */
const BROADCAST = '255.255.255.255';

class ArtnetSender {
  constructor() {
    this.socket = null;
    /** The port this socket sends from, once bound. */
    this.localPort = 0;
    this.target = BROADCAST;
    /** This machine's addresses, read once per start rather than per packet. */
    this.addresses = new Set();
    /** ArtDmx's sequence, 1..255; zero would switch re-ordering off. */
    this.sequence = 0;
    this.packet = ArtnetSender.template();
    this.sent = 0;
  }

  /**
   * An ArtDmx packet with every fixed field filled in.
   *
   * @returns {Buffer}
   */
  static template() {
    const packet = Buffer.alloc(HEADER + SLOTS);
    ARTNET_ID.copy(packet, 0);
    packet.writeUInt16LE(OP_DMX, 8);
    packet.writeUInt16BE(PROTOCOL_VERSION, 10);
    packet.writeUInt8(0, 13); // physical port
    packet.writeUInt16BE(SLOTS, 16);
    return packet;
  }

  /**
   * Whether a datagram came from this sender.
   *
   * @param {Object} rinfo sender address and port
   * @returns {Boolean}
   */
  isOwn(rinfo) {
    if (!this.socket || !rinfo || rinfo.port !== this.localPort) return false;
    return this.addresses.has(rinfo.address);
  }

  /** This machine's IPv4 addresses, loopback included. */
  static localAddresses() {
    const addresses = new Set(['127.0.0.1']);
    Object.values(os.networkInterfaces()).forEach((list) => {
      (list || []).forEach((entry) => {
        if (entry.family === 'IPv4' || entry.family === 4) addresses.add(entry.address);
      });
    });
    return addresses;
  }

  /**
   * Opens the send socket.
   *
   * @param {Object} [opts]
   * @param {String} [opts.target] address to send to; broadcast when empty
   */
  start(opts = {}) {
    if (this.socket) return;
    this.target = (opts.target || '').trim() || BROADCAST;
    this.addresses = ArtnetSender.localAddresses();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => {
      console.error('[artnet-out] socket error:', err.message);
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      this.localPort = socket.address().port;
      console.log(`[artnet-out] sending to ${this.target}:${ARTNET_PORT} from port ${this.localPort}`);
    });
    this.socket = socket;
  }

  /**
   * Sends one universe.
   *
   * @param {Number} universe Beam universe, which is the Art-Net port address
   * @param {Uint8Array} data 512 slots
   */
  send(universe, data) {
    if (!this.socket || !this.localPort) return;
    if (universe < 0 || universe > 0x7fff) return;
    this.sequence = (this.sequence % 255) + 1;

    const { packet } = this;
    packet.writeUInt8(this.sequence, 12);
    packet.writeUInt8(universe & 0xff, 14); // SubUni
    packet.writeUInt8((universe >> 8) & 0x7f, 15); // Net
    const count = Math.min(data.length, SLOTS);
    packet.set(data.subarray(0, count), HEADER);
    if (count < SLOTS) packet.fill(0, HEADER + count);
    // Copied, because the buffer is reused before the datagram has gone.
    this.socket.send(Buffer.from(packet), ARTNET_PORT, this.target, (err) => {
      if (err) console.error(`[artnet-out] universe ${universe}: ${err.message}`);
    });
    this.sent += 1;
  }

  /** Closes the send socket. */
  stop() {
    if (!this.socket) return;
    try {
      this.socket.close();
    } catch (err) {
      // already closing
    }
    this.socket = null;
    this.localPort = 0;
    this.sequence = 0;
    console.log(`[artnet-out] stopped after ${this.sent} packet(s)`);
  }
}

export default new ArtnetSender();
