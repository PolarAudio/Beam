/**
 * @file Which of the shipped gobo images a wheel slot shows.
 *
 * Pure, and apart from the atlas in `gobo_library.js`, so the renderer and
 * the channel guide answer from one rule: a guide's thumbnail is the pattern
 * the beam draws.
 *
 * An OFL slot names its image as `gobos/<name>`, but few profiles do. A slot
 * that names none, or names one Beam does not ship, is given an image by its
 * place among the wheel's gobos -- a stand-in, so that neighbouring slots at
 * least look different.
 */
import GOBOS from './gobo_manifest';

/** Where the images are served from, as the fixture profiles are. */
export const GOBO_URL = `${import.meta.env.VITE_STATIC_URL || ''}gobos/`;

/**
 * The shipped image a gobo slot shows, by its position in the manifest.
 *
 * @param {Object} slot the OFL wheel slot, `{ type, resource }`
 * @param {Number} index the slot's position among the wheel's gobo slots
 * @returns {Object|null} `{ image, named }`: the manifest position, and
 *   whether the profile named it rather than Beam standing one in; null for
 *   an open or non-gobo slot
 */
export function goboImageFor(slot, index) {
  if (!slot || slot.type !== 'Gobo') return null;
  const resource = String(slot.resource || '').replace(/^gobos\//, '');
  const named = GOBOS.findIndex((g) => g.name === resource);
  if (named >= 0) return { image: named, named: true };
  return { image: index % GOBOS.length, named: false };
}

/**
 * Which pattern a wheel slot shows, as the atlas numbers them.
 *
 * @param {Object} slot the OFL wheel slot, `{ type, resource }`
 * @param {Number} index the slot's position among the wheel's gobo slots
 * @returns {Number} a pattern index; 0 for an open or non-gobo slot
 */
export function goboLayerFor(slot, index) {
  const pick = goboImageFor(slot, index);
  return pick ? pick.image + 1 : 0;
}

/**
 * A gobo slot's thumbnail: the image the beam draws for it.
 *
 * @param {Object} wheel the OFL wheel, `{ slots }`
 * @param {Number} slotNumber one-based, as a capability states it
 * @returns {Object|null} `{ url, title, named }`, or null when the slot is
 *   not a gobo
 */
export function goboThumbnail(wheel, slotNumber) {
  const slots = (wheel && wheel.slots) || [];
  const at = Number(slotNumber) - 1;
  if (!Number.isInteger(at) || at < 0) return null;
  const index = slots.slice(0, at).filter((s) => s && s.type === 'Gobo').length;
  const pick = goboImageFor(slots[at], index);
  if (!pick) return null;
  const gobo = GOBOS[pick.image];
  return { url: GOBO_URL + gobo.file, title: gobo.title, named: pick.named };
}
