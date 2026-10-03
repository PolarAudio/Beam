import { reactive } from 'vue';
import Preferences from '../../plugins/visualizer/preferences';
import { DMX_UNIVERSE_LENGTH } from './patch.model';

/**
 * @file How a DMX address is written on screen.
 *
 * One address, three spellings, and which one is right depends on the system
 * on the other end: MadMapper writes a universe, a separator and a channel;
 * some consoles count one number straight across every universe. A setting of
 * the installation, not the show -- it is about what the user reads beside,
 * not about the rig.
 *
 * Universes are counted as Beam counts them, from zero, and channels from one.
 */

/** The spellings, in the order the setting offers them. */
export const ADDRESS_FORMATS = [
  { id: 'dot', label: 'Universe.Channel (2.37)' },
  { id: 'colon', label: 'Universe:Channel (2:37)' },
  { id: 'absolute', label: 'Absolute (1061)' },
];

const PREFERENCE = 'addressFormat';
const FALLBACK = 'dot';

/**
 * The chosen spelling, reactive so every address on screen redraws when it
 * changes. Filled from the preferences once they have loaded; see `refresh`.
 */
const state = reactive({ format: FALLBACK });

/**
 * Takes the spelling from the stored preferences. Called once they are loaded,
 * since anything drawn before that used the fallback.
 *
 * @public
 */
export function refreshAddressFormat() {
  const stored = Preferences.get(PREFERENCE);
  state.format = ADDRESS_FORMATS.some((f) => f.id === stored) ? stored : FALLBACK;
}

/**
 * @public
 * @returns {String} the chosen spelling's id
 */
export function addressFormat() {
  return state.format;
}

/**
 * Chooses a spelling and remembers it.
 *
 * @public
 * @param {String} id one of `ADDRESS_FORMATS`
 */
export function setAddressFormat(id) {
  if (!ADDRESS_FORMATS.some((f) => f.id === id)) return;
  state.format = id;
  Preferences.set(PREFERENCE, id);
}

/**
 * An address as the user has chosen to read it.
 *
 * @public
 * @param {Number} address absolute and zero-based, as Beam holds it
 * @returns {String}
 */
export function formatAddress(address) {
  const at = Math.max(Math.floor(Number(address) || 0), 0);
  const universe = Math.floor(at / DMX_UNIVERSE_LENGTH);
  const channel = (at % DMX_UNIVERSE_LENGTH) + 1;
  switch (state.format) {
    case 'colon': return `${universe}:${channel}`;
    case 'absolute': return `${at + 1}`;
    default: return `${universe}.${channel}`;
  }
}
