/**
 * @file An item is known by a name and an instance number.
 *
 * The name is the user's, free text, and may end in digits of its own
 * (`Display 3`, `Par 64`). The instance is Beam's: a whole number from 1 that
 * keeps items of one kind with the same name apart. Neither is ever parsed out
 * of the other; they are shown and exported together as `name N`.
 *
 * The instance is the lowest number not already used by another item of the
 * same kind with the same name. An item that already carries one -- loaded
 * from a show, or pasted -- keeps it while it is still free, so a show reopens
 * numbered as it was saved and a copy lands on the next free number.
 */

/**
 * How an item is shown and exported.
 *
 * @public
 * @param {String} name
 * @param {Number} [instance]
 * @returns {String} `name N`, or the name alone when it has no number yet
 */
export function itemLabel(name, instance) {
  return instance ? `${name} ${instance}` : name;
}

/**
 * Gives an item its instance number among the items of its kind.
 *
 * Called before the item joins its list: the list draws a row the moment an
 * item is added, and a number given afterwards would not reach that row.
 *
 * @public
 * @param {Object} item anything with `name` and `instance`
 * @param {Array} siblings the other items of the same kind
 * @returns {Number} the instance it now has
 */
export function claimInstance(item, siblings) {
  const used = new Set(siblings
    .filter((other) => other !== item && other.name === item.name)
    .map((other) => other.instance));
  const kept = Number.isInteger(item.instance) && item.instance > 0 && !used.has(item.instance);
  if (!kept) {
    let n = 1;
    while (used.has(n)) n += 1;
    item.instance = n;
  }
  return item.instance;
}

/**
 * The name and instance an item saved before instances existed comes to.
 *
 * Split only where the split is known: the name is one of the bases given --
 * a fixture's model, or the base a copy recorded -- followed by a number.
 * Anything else keeps its whole name and is numbered as it joins the show.
 *
 * @public
 * @param {String} name the saved name
 * @param {Array} bases candidate names it may have been numbered from
 * @returns {Object} `{ name, instance }`, instance null when not split
 */
export function splitSavedName(name, bases) {
  const found = bases
    .filter((base) => typeof base === 'string' && base && name.startsWith(`${base} `))
    .map((base) => ({ base, rest: name.slice(base.length + 1) }))
    .find(({ rest }) => /^\d+$/.test(rest));
  if (!found) return { name, instance: null };
  return { name: found.base, instance: parseInt(found.rest, 10) };
}

/**
 * What an item is called outside Beam: its label where it has one, its name
 * where it is a plain record.
 *
 * @public
 * @param {Object} item
 * @returns {String}
 */
export function labelOf(item) {
  if (!item) return '';
  return item.label || item.name || '';
}

/**
 * Finds the other items of an item's kind. Set by the show, so that an item
 * can be named on screen without the models reaching for it.
 *
 * @type {Function}
 */
let siblingsOf = () => [];

/**
 * Tells this module how to find an item's siblings.
 *
 * @public
 * @param {Function} resolver `(item) => Array`
 */
export function setSiblingResolver(resolver) {
  siblingsOf = resolver;
}

/**
 * What an item is called on screen: its name alone while no other item of its
 * kind shares it, its name and instance once one does.
 *
 * Exports keep the full label whatever the count -- see `labelOf` -- so a name
 * another program has been handed never changes because of what is beside it.
 *
 * @public
 * @param {Object} item
 * @param {Number} [sharing] how many items of its kind carry its name, when the
 *   caller has counted them already
 * @returns {String}
 */
export function displayNameOf(item, sharing) {
  if (!item) return '';
  if (!item.instance) return item.name || '';
  const count = sharing !== undefined
    ? sharing
    : siblingsOf(item).filter((other) => other.name === item.name).length;
  return count > 1 ? itemLabel(item.name, item.instance) : item.name;
}
