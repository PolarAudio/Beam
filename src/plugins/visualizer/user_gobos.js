/**
 * @file The user's gobo and disc images on offer, as the main process lists
 * them: the open document's carried copies before the library's. Kept here
 * so a placement can turn a `library:<file>` reference into the URL a load
 * would find it at; refreshed whenever the show lists its library.
 */

let entries = [];

const UserGobos = {
  /** @param {Array<Object>} list `{ key, name, origin, url }` */
  set(list) {
    entries = Array.isArray(list) ? list : [];
  },

  /** @returns {Array<Object>} `{ key, name, origin, url }` */
  list() {
    return entries;
  },

  /**
   * The URL a file name resolves to: the open document's, else the library's.
   *
   * @param {String} file
   * @returns {String}
   */
  urlFor(file) {
    const folded = String(file).toLowerCase();
    const found = entries.find((e) => e.key.toLowerCase() === folded);
    return found ? found.url : `library://gobos/${encodeURIComponent(file)}`;
  },
};

export default UserGobos;
