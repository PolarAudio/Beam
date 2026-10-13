/**
 * What the Art-Net receiver and sender agree on about the wire.
 *
 * @see https://art-net.org.uk/ (ArtDMX / OpDmx = 0x5000)
 */

/** The port every Art-Net packet goes to. */
export const ARTNET_PORT = 6454;

/** "Art-Net" + null terminator (8 bytes) */
export const ARTNET_ID = Buffer.from('Art-Net\0', 'latin1');

/** OpDmx opcode, stored little-endian in the packet */
export const OP_DMX = 0x5000;
