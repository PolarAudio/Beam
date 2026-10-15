/**
 * @file Gobos and animation discs swapped into one placed fixture.
 *
 * A placement may carry a list of overwrites, each putting another picture
 * in one slot of one of its wheels: `{ wheel, slot, image, rotation }`, the
 * wheel by name, the slot from 1, the picture by reference and turned by
 * `rotation` degrees in its holder. The definition is never edited; the
 * wheels the renderer is given are the definition's with these applied.
 *
 * The shape follows MVR's `Overwrite`: its `target` is a GDTF node link to a
 * wheel slot, `<wheel>.<slot name>`, and its `universal` a slot of a wheel in
 * the MVR's `Universal.gdtt` template, which holds the picture. A slot is kept
 * here by its place as well as its name, since OFL slots have none and a
 * GDTF wheel may name two alike; `mvrTarget` and `fromMvrTarget` convert.
 *
 * A picture reference is `<source>:<name>`:
 *   - `gobo:<name>` one of Beam's stock gobos in `public/gobos`: OFL's, or
 *     one taken from a GDTF file
 *   - `animation:<name>` one of Beam's stock animation discs, `public/animation`
 *   - `library:<file>` an image in the user's `Library/Gobos`
 *   - `fixture:<file>` one of the fixture's own wheel images
 *
 * `open` in place of a reference empties the slot: an open hole, with no
 * picture. In MVR it is an overwrite with no `universal`.
 */

/** The sources a picture reference may name. */
export const IMAGE_SOURCES = ['gobo', 'animation', 'library', 'fixture'];

/** The reference that empties a slot. */
export const OPEN_IMAGE = 'open';

/**
 * A list of overwrites as stored: well formed, one per slot (the last wins),
 * in wheel and slot order.
 *
 * @param {Array} list as read from a project, or given by the panel
 * @returns {Array<Object>} `{ wheel, slot, image, rotation }`
 */
export function normaliseOverwrites(list) {
  const bySlot = new Map();
  (Array.isArray(list) ? list : []).forEach((entry) => {
    if (!entry || typeof entry.wheel !== 'string' || !entry.wheel) return;
    const slot = Math.floor(Number(entry.slot));
    if (!(slot >= 1)) return;
    const image = String(entry.image || '');
    const source = image.split(':')[0];
    const open = image === OPEN_IMAGE;
    if (!open && (!IMAGE_SOURCES.includes(source) || image.length <= source.length + 1)) return;
    const rotation = open ? 0 : Number(entry.rotation) || 0;
    bySlot.set(`${entry.wheel}\u0000${slot}`, {
      wheel: entry.wheel, slot, image, rotation,
    });
  });
  return [...bySlot.values()].sort((a, b) => (a.wheel === b.wheel
    ? a.slot - b.slot : a.wheel.localeCompare(b.wheel)));
}

/**
 * The definition's wheels with the overwrites applied: each named slot gets
 * the picture its reference resolves to, as a gobo, and its rotation; `open`
 * makes it an open slot. A slot or wheel the definition does not have is
 * passed over; nothing else is touched, and the definition's objects are not
 * changed.
 *
 * @param {Object} wheels wheel name to `{ slots }`, as the head takes them
 * @param {Array} overwrites normalised
 * @param {Function} resolve picture reference to the slot fields that show
 *   it: `{ image: { key, url } }` or `{ resource }`; null when it cannot be
 *   found, which leaves the slot as it is
 * @returns {Object} wheels for the head
 */
export function applyOverwrites(wheels, overwrites, resolve) {
  if (!overwrites || !overwrites.length) return wheels;
  const out = { ...wheels };
  overwrites.forEach((o) => {
    const wheel = out[o.wheel];
    if (!wheel || !Array.isArray(wheel.slots) || !wheel.slots[o.slot - 1]) return;
    if (o.image === OPEN_IMAGE) {
      if (out[o.wheel] === wheels[o.wheel]) out[o.wheel] = { ...wheel, slots: [...wheel.slots] };
      const { name } = out[o.wheel].slots[o.slot - 1];
      out[o.wheel].slots[o.slot - 1] = { type: 'Open', name, overwritten: OPEN_IMAGE };
      return;
    }
    const shown = resolve(o.image);
    if (!shown) return;
    if (out[o.wheel] === wheels[o.wheel]) out[o.wheel] = { ...wheel, slots: [...wheel.slots] };
    const { slots } = out[o.wheel];
    const was = slots[o.slot - 1];
    // A picture in a slot makes it a gobo there, whatever the file called it:
    // an open hole with a gobo dropped in is a gobo.
    const { image: dropped, resource: droppedResource, ...rest } = was;
    slots[o.slot - 1] = {
      ...rest,
      type: 'Gobo',
      ...shown,
      rotation: o.rotation,
      overwritten: o.image,
    };
    if (!shown.image && dropped) delete slots[o.slot - 1].image;
    if (!shown.resource && droppedResource) delete slots[o.slot - 1].resource;
  });
  return out;
}

/**
 * Resolves a picture reference to the slot fields that show it.
 *
 * @param {String} ref `<source>:<name>`
 * @param {Object} where `{ goboNames, collectedUrl, animationUrl, libraryUrl,
 *   ownImages, typeKey }`: the OFL stock gobos' names, the URL builders of
 *   the gobos taken from GDTF files, the stock discs and the library, the
 *   fixture's own images by file name, and a key unique to its type
 * @returns {Object|null}
 */
export function resolveImage(ref, where) {
  const at = String(ref || '').indexOf(':');
  if (at < 0) return null;
  const source = ref.slice(0, at);
  const name = ref.slice(at + 1);
  if (!name) return null;
  if (source === 'gobo') {
    if (where.goboNames && where.goboNames.includes(name)) return { resource: `gobos/${name}` };
    // The gobos taken from GDTF files load into the atlas when used, as a
    // fixture's own images do.
    const url = where.collectedUrl && where.collectedUrl(name);
    return url ? { image: { key: `gobos/${name}`, url } } : null;
  }
  if (source === 'animation') {
    return where.animationUrl ? { image: { key: `animation/${name}`, url: where.animationUrl(name) } } : null;
  }
  if (source === 'library') {
    return where.libraryUrl ? { image: { key: `library/${name}`, url: where.libraryUrl(name) } } : null;
  }
  if (source === 'fixture') {
    const url = where.ownImages && where.ownImages.get(name);
    return url ? { image: { key: `${where.typeKey}/${name}`, url } } : null;
  }
  return null;
}

/**
 * An overwrite's slot as MVR's `target` names it, `<wheel>.<slot name>`, or
 * null where the slot has no name or shares it with another in its wheel.
 *
 * @param {Object} wheels the definition's wheels
 * @param {Object} entry `{ wheel, slot }`
 * @returns {String|null}
 */
export function mvrTarget(wheels, entry) {
  const slots = (wheels[entry.wheel] && wheels[entry.wheel].slots) || [];
  const slot = slots[entry.slot - 1];
  const name = slot && String(slot.name || '').trim();
  if (!name) return null;
  if (slots.filter((s) => s && String(s.name || '').trim() === name).length > 1) return null;
  return `${entry.wheel}.${name}`;
}

/**
 * The slot MVR's `target` names, as `{ wheel, slot }`, or null.
 *
 * @param {Object} wheels the definition's wheels
 * @param {String} target `<wheel>.<slot name>`
 * @returns {Object|null}
 */
export function fromMvrTarget(wheels, target) {
  const text = String(target || '');
  // Wheel names may hold dots; slot names may too. Try every split.
  for (let i = text.indexOf('.'); i > 0; i = text.indexOf('.', i + 1)) {
    const wheel = text.slice(0, i);
    const name = text.slice(i + 1);
    const slots = (wheels[wheel] && wheels[wheel].slots) || [];
    const at = slots.findIndex((s) => s && String(s.name || '').trim() === name);
    if (at >= 0) return { wheel, slot: at + 1 };
  }
  return null;
}
