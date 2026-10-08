/* eslint-disable no-bitwise */
/**
 * What the sACN receiver and sender agree on about the wire.
 *
 * @see ANSI E1.31-2018
 */

/** The port every sACN source sends to. */
export const SACN_PORT = 5568;

/** ACN packet identifier, 12 bytes, the same in every E1.31 packet. */
export const ACN_ID = Buffer.from([
  0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00,
]);

/**
 * The multicast address a universe travels on.
 *
 * `239.255.<high byte>.<low byte>`, which is the whole of E1.31's addressing
 * scheme.
 *
 * @param {Number} universe sACN universe, counted from 1
 * @returns {String} dotted quad
 */
export function groupFor(universe) {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}
