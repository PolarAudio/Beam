import EventBus from './eventbus';
import { choose } from './confirm';

/**
 * @file Brings .gdtf files into the user's library, from the File menu,
 * dropped on the window or downloaded from GDTF Share -- the same steps every
 * way.
 *
 * Each file is copied in untouched. One of a fixture type already in the
 * library -- another revision of it, or the same file again -- is asked
 * about: kept beside the one there, the default since nothing is lost;
 * replacing it; or skipped. A show refers to a file, so replacing one costs
 * every saved show that uses it those fixtures.
 */

/**
 * Imports files by path and reports the outcome.
 *
 * @public
 * @async
 * @param {Array<String>} paths absolute paths of .gdtf files
 * @param {Object} show the show, whose fixture list is refreshed afterwards
 * @param {Object} [options]
 * @param {String} [options.conflict] what to do with a fixture type already
 *   in the library without asking: 'keepBoth' or 'replace'
 * @param {Boolean} [options.reveal] open Add to Show on the first fixture
 *   imported, ready to place; off where the import started there
 * @returns {Promise<Array<Object>>} the entries imported
 */
export default async function importGdtfFiles(
  paths,
  show,
  { conflict = null, reveal = true } = {},
) {
  if (!paths.length || !window.library || !window.library.importGdtf) return [];
  const imported = [];
  const failed = [];

  // One at a time: a question about one file must not be overtaken by the next.
  // eslint-disable-next-line no-restricted-syntax
  for (const source of paths) {
    // eslint-disable-next-line no-await-in-loop
    let result = await window.library.importGdtf(source, {
      replace: conflict === 'replace', keepBoth: conflict === 'keepBoth',
    });
    if (!result.ok && result.conflict) {
      const { incoming, existing } = result.conflict;
      const names = existing.map((e) => e.file.split('/').pop()).join(', ');
      // eslint-disable-next-line no-await-in-loop
      const answer = await choose({
        title: 'Fixture already in the library',
        message: `${incoming.manufacturer} ${incoming.name} is already in your library.`,
        detail: `In the library: ${names}\nNew file: ${incoming.file}\n\n`
          + 'Keep both adds the new file beside it. Replace deletes the file in the library, '
          + 'and saved shows that use it lose those fixtures.',
        yes: 'Keep both',
        also: 'Replace',
        no: 'Skip',
      });
      if (answer !== 'no') {
        // eslint-disable-next-line no-await-in-loop
        result = await window.library.importGdtf(source, {
          replace: answer === 'also', keepBoth: answer === 'yes',
        });
      }
    }
    if (result.ok) imported.push(result.entry);
    else if (result.reason) failed.push(result.reason);
  }

  if (imported.length && show) await show.refreshGdtfFixtures();
  if (failed.length) EventBus.emit('app_error', new Error(`Could not import: ${failed.join('; ')}`));
  if (imported.length && reveal) {
    const [first] = imported;
    EventBus.emit('reveal_fixture', { key: first.key, name: first.name });
  }
  return imported;
}
