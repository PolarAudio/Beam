/* eslint-disable no-console */
/* eslint-disable no-bitwise */
import dgram from 'dgram';
import crypto from 'crypto';
import { SACN_PORT, ACN_ID, groupFor } from './sacn_wire';

/**
 * sACN (E1.31) transmitter (main process), for sender mode.
 *
 * Beam is a receiver. Sender mode turns it round so the panels can drive a
 * real fixture through whatever sits on the wire -- ArtStream feeding a USB
 * interface, a node -- and the fixture can be checked against its virtual
 * twin with the same controls.
 *
 * Multicast, because the receiver is normally on the same machine: every
 * socket joined to the group gets a copy, where a unicast datagram to a port
 * two applications share reaches only one of them on Windows. Beam's own
 * receiver gets a copy too, and drops it by this sender's CID.
 *
 * @see ANSI E1.31-2018
 */

/** Slots in a universe. */
const SLOTS = 512;

/** A full data packet: 126 bytes of layers, then 512 slots. */
const PACKET_LENGTH = 126 + SLOTS;

/** What a source sends when it has no reason to claim more. */
const PRIORITY = 100;

/** The name receivers show for this source. */
const SOURCE_NAME = 'Beatline Beam';

/**
 * Who this source is. One per run: a receiver that still remembers the last
 * run's CID sees a new source, which is what it is.
 *
 * @constant {Buffer}
 */
const CID = crypto.randomBytes(16);

class SacnSender {
  constructor() {
    this.socket = null;
    /** Sequence number per universe, a byte that wraps. */
    this.sequences = new Map();
    /** One packet buffer, rebuilt in place for every send. */
    this.packet = SacnSender.template();
    this.sent = 0;
  }

  /** This source's CID as hex, the key the receiver files sources under. */
  static get cid() {
    return CID.toString('hex');
  }

  /**
   * A data packet with every fixed field filled in. Universe, sequence and
   * slots are written per send.
   *
   * @returns {Buffer}
   */
  static template() {
    const packet = Buffer.alloc(PACKET_LENGTH);
    // Root layer.
    packet.writeUInt16BE(0x0010, 0); // preamble size
    packet.writeUInt16BE(0x0000, 2); // post-amble size
    ACN_ID.copy(packet, 4);
    packet.writeUInt16BE(0x7000 | (PACKET_LENGTH - 16), 16);
    packet.writeUInt32BE(0x00000004, 18); // VECTOR_ROOT_E131_DATA
    CID.copy(packet, 22);
    // Framing layer.
    packet.writeUInt16BE(0x7000 | (PACKET_LENGTH - 38), 38);
    packet.writeUInt32BE(0x00000002, 40); // VECTOR_E131_DATA_PACKET
    packet.write(SOURCE_NAME, 44, 64, 'utf8');
    packet.writeUInt8(PRIORITY, 108);
    packet.writeUInt16BE(0, 109); // no synchronization
    packet.writeUInt8(0, 112); // options
    // DMP layer.
    packet.writeUInt16BE(0x7000 | (PACKET_LENGTH - 115), 115);
    packet.writeUInt8(0x02, 117); // VECTOR_DMP_SET_PROPERTY
    packet.writeUInt8(0xa1, 118); // address and data type
    packet.writeUInt16BE(0x0000, 119); // first property address
    packet.writeUInt16BE(0x0001, 121); // address increment
    packet.writeUInt16BE(SLOTS + 1, 123); // property values, start code included
    packet.writeUInt8(0, 125); // start code: dimmer data
    return packet;
  }

  /**
   * Opens the send socket.
   *
   * @param {Object} [opts]
   * @param {String} [opts.multicastInterface] interface to send multicast on
   */
  start(opts = {}) {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => {
      console.error('[sacn-out] socket error:', err.message);
    });
    socket.bind(0, () => {
      // A receiver on this machine is the normal case, and it only hears
      // multicast sent from here when loopback is on.
      socket.setMulticastLoopback(true);
      if (opts.multicastInterface) socket.setMulticastInterface(opts.multicastInterface);
      console.log(`[sacn-out] sending as "${SOURCE_NAME}" (${SacnSender.cid})`);
    });
    this.socket = socket;
  }

  /**
   * Sends one universe.
   *
   * @param {Number} universe Beam universe, counted from 0
   * @param {Uint8Array} data 512 slots
   */
  send(universe, data) {
    if (!this.socket) return;
    // E1.31 counts universes from 1.
    const wire = universe + 1;
    if (wire < 1 || wire > 63999) return;
    const sequence = ((this.sequences.get(wire) || 0) + 1) & 0xff;
    this.sequences.set(wire, sequence);

    const { packet } = this;
    packet.writeUInt8(sequence, 111);
    packet.writeUInt16BE(wire, 113);
    const count = Math.min(data.length, SLOTS);
    packet.set(data.subarray(0, count), 126);
    if (count < SLOTS) packet.fill(0, 126 + count);
    // Copied, because the buffer is reused before the datagram has gone.
    this.socket.send(Buffer.from(packet), SACN_PORT, groupFor(wire), (err) => {
      if (err) console.error(`[sacn-out] universe ${universe}: ${err.message}`);
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
    this.sequences.clear();
    console.log(`[sacn-out] stopped after ${this.sent} packet(s)`);
  }
}

export default new SacnSender();
export { SacnSender };
