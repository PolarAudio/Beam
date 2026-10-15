import { coerceClipList } from '@/models/DMX/laser_clips';

/**
 * @file Laser memory cards: named clip lists kept in the library, as the card
 * in a physical laser holds its content whatever show it is used in.
 *
 * A placed laser in Standalone names its card, or none for a list of its own.
 * Its clip list is the project's copy of the card: on a machine whose library
 * has the card, the library's version wins and the copy is brought in line;
 * on one that does not, the copy plays and the card can be added from it.
 */

/** Card key to `{ key, name, clips, origin }`, from the last listing. */
let cards = new Map();

/** Whether the main process can list and write cards. */
function available() {
  return typeof window !== 'undefined' && window.library && window.library.laserCards;
}

/**
 * Reads the cards the library and the open project hold.
 *
 * @public
 * @async
 * @returns {Promise<Array>} `{ key, name, clips, origin }`, sorted by name
 */
export async function refreshCards() {
  if (!available()) return [];
  const list = (await window.library.laserCards()) || [];
  cards = new Map(list.map((card) => [card.key, { ...card, clips: coerceClipList(card.clips) }]));
  return [...cards.values()];
}

/**
 * A card from the last listing, or null.
 *
 * @public
 * @param {String} key
 * @returns {Object|null}
 */
export function cardFor(key) {
  return (key && cards.get(key)) || null;
}

/** Every card from the last listing. */
export function listedCards() {
  return [...cards.values()];
}

/**
 * Brings every laser on a card in line with the library's version of it.
 *
 * Not an edit of the project: the card is where the content lives, and the
 * project's copy only follows it. A card the library does not have leaves
 * the copy as it is.
 *
 * @public
 * @param {Object} show
 * @param {String} [only] limit to the lasers on this card
 * @returns {Number} how many lasers changed
 */
export function syncCards(show, only = null) {
  const fixtures = (show && show.fixturePool && show.fixturePool.fixtures) || [];
  let changed = 0;
  fixtures.forEach((fixture) => {
    const device = fixture.device && fixture.device.value ? fixture.device : null;
    if (!device) return;
    const key = device.value('card');
    if (!key || (only && key !== only)) return;
    const card = cards.get(key);
    if (!card) return;
    if (JSON.stringify(card.clips) === JSON.stringify(device.value('clips'))) return;
    device.set('clips', card.clips);
    const model = fixture._3DModel;
    if (model && model.refresh) model.refresh();
    changed += 1;
  });
  return changed;
}

/**
 * Reads the cards, then brings a show's lasers in line with them.
 *
 * @public
 * @async
 * @param {Object} show
 */
export async function loadCards(show) {
  await refreshCards();
  // Following the card is not an edit: a project that opened saved stays so.
  const wasSaved = show && show.isSaved;
  syncCards(show);
  if (wasSaved) show.isSaved = true;
}

/**
 * Writes a card to the library -- a new one, or a new version of one -- and
 * brings every laser on it in line. Files the card plays that only the open
 * project carries are copied into the library with it.
 *
 * @public
 * @async
 * @param {Object} show
 * @param {String} name
 * @param {Array} clips
 * @returns {Promise<Object>} `{ ok, key }` or `{ ok: false, reason }`
 */
export async function saveCard(show, name, clips) {
  if (!available() || !window.library.saveLaserCard) return { ok: false, reason: 'not available' };
  const result = await window.library.saveLaserCard(name, coerceClipList(clips));
  if (!result || !result.ok) return result || { ok: false, reason: 'not saved' };
  await refreshCards();
  syncCards(show, result.key);
  return result;
}
