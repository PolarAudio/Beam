import { reactive } from 'vue';
import Preferences from '@/plugins/visualizer/preferences';

/**
 * @file How the window shows the 3D view: full window, full screen and stay
 * on top.
 *
 * Full window hides everything but the 3D view and its own toolbar. Full
 * screen is full window with the window across its monitor, and the toolbar
 * shown only while the pointer is at the top edge. Both start off on every
 * launch. Stay on top keeps the window above other applications and is
 * remembered.
 */

const state = reactive({
  fullWindow: false,
  fullScreen: false,
  stayOnTop: false,
});

/** Full window as it was before full screen, to go back to on leaving it. */
let fullWindowBefore = false;

/** The desktop app's window calls; absent in a browser. */
function bridge() {
  return typeof window !== 'undefined' ? window.appWindow : null;
}

function setFullWindow(on) {
  state.fullWindow = Boolean(on) || state.fullScreen;
}

function toggleFullWindow() {
  setFullWindow(!state.fullWindow);
}

/**
 * Follows the window into or out of full screen, whoever made the change:
 * the menu, F11, Escape or the system.
 *
 * @param {Boolean} on
 */
function followFullScreen(on) {
  if (on === state.fullScreen) return;
  if (on) fullWindowBefore = state.fullWindow;
  state.fullScreen = on;
  state.fullWindow = on ? true : fullWindowBefore;
}

async function setFullScreen(on) {
  const win = bridge();
  if (win) {
    followFullScreen(await win.setFullScreen(Boolean(on)));
  } else if (document.documentElement.requestFullscreen) {
    // The web build: the page's own full screen, which the browser leaves
    // on Escape by itself.
    if (on) await document.documentElement.requestFullscreen().catch(() => {});
    else if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    followFullScreen(Boolean(document.fullscreenElement));
  }
}

function toggleFullScreen() {
  return setFullScreen(!state.fullScreen);
}

async function setStayOnTop(on) {
  const win = bridge();
  state.stayOnTop = win ? await win.setAlwaysOnTop(Boolean(on)) : false;
  Preferences.set('stayOnTop', state.stayOnTop);
}

function toggleStayOnTop() {
  return setStayOnTop(!state.stayOnTop);
}

/**
 * Escape leaves full screen before it does anything else. Registered in the
 * capture phase, so the viewport's own Escape, which deselects, does not see
 * that press.
 */
function onKeyDown(event) {
  if (event.key !== 'Escape' || !state.fullScreen) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  setFullScreen(false);
}

let started = false;

/**
 * Applies the remembered stay-on-top and starts listening. Once per page.
 *
 * @public
 */
function start() {
  if (started) return;
  started = true;
  window.addEventListener('keydown', onKeyDown, true);
  const win = bridge();
  if (win) {
    win.onFullScreen((on) => followFullScreen(Boolean(on)));
    // A reload keeps the window as it was, so read it rather than assume.
    win.isFullScreen().then((on) => followFullScreen(Boolean(on)));
  } else {
    document.addEventListener('fullscreenchange', () => followFullScreen(Boolean(document.fullscreenElement)));
  }
  if (Preferences.get('stayOnTop')) setStayOnTop(true);
}

export default {
  state,
  start,
  setFullWindow,
  toggleFullWindow,
  setFullScreen,
  toggleFullScreen,
  setStayOnTop,
  toggleStayOnTop,
};
