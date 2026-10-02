import EventBus from './eventbus';
import confirm from './confirm';

/**
 * @file Brings .gdtf files into the user's library, from the File menu or
 * dropped on the window -- the same steps either way.
 *
 * Each file is copied in untouched. One that would replace a fixture already
 * in the library -- another revision of it, or the same file again -- is only
 * copied after asking.
 */

/**
 * Imports files by path and reports the outcome.
 *
 * @public
 * @async
 * @param {Array<String>} paths absolute paths of .gdtf files
 * @param {Object} show the show, whose fixture list is refreshed afterwards
 * @returns {Promise<Array<Object>>} the entries imported
 */
export default async function importGdtfFiles(paths, show) {
  if (!paths.length || !window.library || !window.library.importGdtf) return [];
  const imported = [];
  const failed = [];

  // One at a time: a question about one file must not be overtaken by the next.
  // eslint-disable-next-line no-restricted-syntax
  for (const source of paths) {
    // eslint-disable-next-line no-await-in-loop
    let result = await window.library.importGdtf(source);
    if (!result.ok && result.conflict) {
      const { incoming, existing } = result.conflict;
      // eslint-disable-next-line no-await-in-loop
      const replace = await confirm({
        title: 'Replace fixture',
        message: `${incoming.manufacturer} ${incoming.name} is already in your library. Replace it?`,
        detail: `In the library: ${existing.map((e) => e.file.split('/').pop()).join(', ')}\n`
          + `New file: ${incoming.file}`,
        yes: 'Replace',
        no: 'Keep',
      });
      // eslint-disable-next-line no-await-in-loop
      if (replace) result = await window.library.importGdtf(source, { replace: true });
    }
    if (result.ok) imported.push(result.entry);
    else if (result.reason) failed.push(result.reason);
  }

  if (imported.length && show) await show.refreshGdtfFixtures();
  if (failed.length) EventBus.emit('app_error', new Error(`Could not import: ${failed.join('; ')}`));
  if (imported.length) {
    await confirm({
      title: 'Import GDTF',
      message: `Imported ${imported.map((e) => `${e.manufacturer} ${e.name}`).join(', ')}.`,
      detail: 'Listed under GDTF in Add to Show.',
      yes: 'OK',
      no: 'Close',
    });
  }
  return imported;
}
