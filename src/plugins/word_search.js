/**
 * @file The one search rule every list uses: each word of the search must
 * appear in the text, in any order. "elation proteus" finds "Proteus Hybrid"
 * under Elation as readily as "proteus" does.
 */

/** Lower case, with hyphens and underscores read as spaces. */
function fold(text) {
  return String(text || '').toLowerCase().replace(/[-_]+/g, ' ');
}

/**
 * The words of a search, ready for `matchesWords`.
 *
 * @param {String} search
 * @returns {Array<String>} empty for a blank search
 */
export function searchWords(search) {
  return fold(search).split(/\s+/).filter(Boolean);
}

/**
 * Whether every word appears in the texts taken together.
 *
 * @param {Array<String>} words from `searchWords`
 * @param {...String} texts what is searched, e.g. a folder's name and a row's
 * @returns {Boolean} true for no words
 */
export function matchesWords(words, ...texts) {
  const hay = fold(texts.join(' '));
  return words.every((word) => hay.includes(word));
}
