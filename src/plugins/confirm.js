import EventBus from './eventbus';

/**
 * @file Asks the user a yes/no question, or one with a third answer, and
 * waits for the answer.
 *
 *     if (!await confirm({ title, message })) return;
 *     const answer = await choose({ title, message, yes, also, no });
 *
 * The popup lives at the app root (`popup.confirm.vue`, hosted by
 * `app.activity.vue`), so any widget or model can ask without mounting a popup
 * of its own. Anything but "yes" -- cancel, the close cross, no host to ask --
 * answers false: an unanswered question is never consent.
 */

/**
 * @public
 * @param {Object} question
 * @param {String} question.title what is being decided
 * @param {String} question.message the question
 * @param {String} [question.detail] what it will cost
 * @param {String} [question.yes] the yes button's label
 * @param {String} [question.no] the no button's label
 * @returns {Promise<Boolean>}
 */
export default function confirm({
  title, message, detail = '', yes = 'yes', no = 'no',
}) {
  return new Promise((resolve) => {
    // Nobody to ask means nobody said yes.
    if (!EventBus.all.has('confirm')) {
      resolve(false);
      return;
    }
    EventBus.emit('confirm', {
      title, message, detail, yes, no, resolve: (answer) => resolve(answer === true),
    });
  });
}

/**
 * A question with three answers: the validate button, a third beside it, and
 * no. Anything but the first two -- cancel, the close cross, no host to ask --
 * is 'no'.
 *
 * @public
 * @param {Object} question as `confirm`'s, with `also` the third button's label
 * @returns {Promise<String>} 'yes', 'also' or 'no'
 */
export function choose({
  title, message, detail = '', yes = 'yes', also, no = 'no',
}) {
  return new Promise((resolve) => {
    if (!EventBus.all.has('confirm')) {
      resolve('no');
      return;
    }
    EventBus.emit('confirm', {
      title,
      message,
      detail,
      yes,
      also,
      no,
      resolve: (answer) => {
        if (answer === true) resolve('yes');
        else resolve(answer === 'also' ? 'also' : 'no');
      },
    });
  });
}
