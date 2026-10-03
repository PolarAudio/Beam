/**
 * @file Where Beam reads a fixture file's words rather than its data.
 *
 * GDTF states most things as data: an attribute, a wheel slot index, a
 * physical value. A few things it states only in a name, or a file leaves
 * the data out and only the name is left: a shutter set called Closed, a
 * prism set called Open whose slot index is 0, a prism wheel slot called
 * "8-Facet Circular Prism" with no facets listed, an open gobo slot with no
 * name and no image. Each rule here reads such a name. They are heuristics,
 * kept together so each is written once, used the same way by the head and
 * by the range guide, and pinned by `test/gdtf_name_rules.test.js`.
 *
 * Data always wins: a rule is only asked where the data does not answer.
 */

/** A name that says the light is shut off: "Closed", "Shutter close". */
export function namesClosed(name) {
  return /\bclosed?\b/i.test(String(name || ''));
}

/** A name that says nothing is in the light path: "Open", "Open 1". */
export function namesOpen(name) {
  return /\bopen\b/i.test(String(name || ''));
}

/**
 * The name a channel set or its function goes by: the set's own when it has
 * one, else the function's.
 *
 * @param {Object} fn a channel function
 * @param {Object|null} set a channel set within it
 * @returns {String}
 */
export function nameOf(fn, set) {
  const own = set && String(set.name || '').trim();
  return own || String(fn.name || '');
}

/**
 * What a GDTF wheel slot is, as the head builds its optics.
 *
 * Facets make a prism. On a gobo or prism wheel, a slot named Open, or one
 * with neither a name nor an image, is the open hole, whatever colour the
 * file gives it. A prism wheel's other slots are prisms even without facets
 * listed; the head reads the facets from the name (see `prismFromText`). A
 * slot named for frost is frost. A colour wheel's slots are colours but for
 * one named Open; a gobo or animation wheel's are gobos.
 *
 * @param {String} family the wheel's family from the attributes that select
 *   it: 'Color', 'Gobo', 'Prism', 'Animation' or 'Effects'
 * @param {Object} slot a GDTF wheel slot, `{ name, mediaFileName, facets }`
 * @returns {String} 'Open', 'Color', 'Gobo', 'Prism' or 'Frost'
 */
export function slotKind(family, slot) {
  const name = String(slot.name || '').trim();
  const open = /^open$/i.test(name);
  const empty = !slot.mediaFileName && !name;
  if (slot.facets && slot.facets.length) return 'Prism';
  if (open || (family !== 'Color' && empty)) return 'Open';
  if (family === 'Prism') return 'Prism';
  if (/frost/i.test(name)) return 'Frost';
  return family === 'Color' ? 'Color' : 'Gobo';
}

/** Facets a prism has when its text does not say. */
export const PRISM_DEFAULT_FACETS = 3;

/** The most facets a prism is drawn with; matches PRISM_FACETS_MAX in the shaders. */
export const PRISM_MAX_FACETS = 8;

/**
 * What a prism describes itself as, from its text: "4-facet linear,
 * rotating", "8-facet 45° circular". Only the text has it in an OFL profile,
 * and in a GDTF file that lists no facets.
 *
 * @param {String} text
 * @returns {Object} `{ facets, linear }`, facets null when unstated
 */
export function prismFromText(text) {
  const t = String(text || '');
  const match = /(\d+)\s*-?\s*facet/i.exec(t);
  const facets = match ? Math.min(Math.max(parseInt(match[1], 10), 2), PRISM_MAX_FACETS) : null;
  return { facets, linear: /linear/i.test(t) };
}
