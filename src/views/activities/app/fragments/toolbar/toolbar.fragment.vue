<template>
  <uk-flex
    tabindex="0"
    center-v
    class="navigation_header"
  >
    <uk-menu :menus="menus" />
    <uk-spacer />
    <p>{{ saveState ? "" : "*" }} {{ project }}</p>
    <uk-spacer />

    <visualizer-popup v-model="visualizerPopupState" />
    <license-popup v-model="licensePopupState" />
    <credits-popup v-model="creditsPopupState" />
    <newshow-popup v-model="newProjectPopupState" />
    <artnet-popup v-model="artnetPopupState" />
    <video-popup v-model="videoPopupState" />
  </uk-flex>
</template>

<script>
import EventBus from '@/plugins/eventbus';
import confirm from '@/plugins/confirm';
import Preferences from '@/plugins/visualizer/preferences';
import importGdtfFiles from '@/plugins/gdtf_import';
import VisualizerPopup from './_popups/popup.visualizer.vue';
import LicensePopup from './_popups/popup.license.vue';
import CreditsPopup from './_popups/popup.credits.vue';
import NewshowPopup from './_popups/popup.newshow.vue';
import ArtnetPopup from './_popups/popup.artnet.vue';
import VideoPopup from './_popups/popup.video.vue';

export default {
  name: 'ToolbarFragment',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  components: {
    VisualizerPopup,
    LicensePopup,
    CreditsPopup,
    NewshowPopup,
    ArtnetPopup,
    VideoPopup,
  },
  data() {
    return {
      /**
       * Current show project naem
       * @todo, change name/use show handle directly ?
       */
      project: this.$show.documentTitle,
      /**
       * Current show savestate
       */
      saveState: true,
      /**
       * Art-Net settings popup state
       */
      artnetPopupState: false,
      videoPopupState: false,
      /**
       * New project popup state
       */
      newProjectPopupState: false,
      /**
       * Visualizer popup state
       */
      visualizerPopupState: false,
      /**
       * License popup state
       */
      licensePopupState: false,
      /**
       * Credits popup state
       */
      creditsPopupState: false,
      /**
       * I/O popup state
       */
      /**
       * Toolbarmenu configuration object
       */
      menus: [
        {
          name: 'File',
          selected: false,
          items: [
            {
              name: 'New Project',
              icon: 'newfile',
              shortcut: 'Shift+N',
              callback: () => {
                this.displayNewProjectPopup();
              },
            },
            {
              name: 'Open Project',
              icon: 'folder',
              shortcut: 'Ctrl+O',
              callback: () => {
                this.openShow();
              },
            },
            {
              name: 'Import Showfile',
              icon: 'folder',
              callback: () => {
                this.loadFile();
              },
            },
            {
              name: 'Import GDTF...',
              icon: 'folder',
              callback: () => {
                this.importGdtf();
              },
            },
            {
              name: 'Save Project',
              shortcut: 'Ctrl+S',
              icon: 'save',
              callback: () => {
                this.saveShow();
              },
            },
            {
              name: 'Export Project to...',
              shortcut: 'Ctrl+Shift+S',
              icon: 'export',
              callback: () => {
                this.exportShow();
              },
            },
            {
              name: 'Refresh from Library',
              icon: 'folder',
              callback: () => {
                this.refreshFromLibrary();
              },
            },
          ],
        },
        {
          name: 'Edit',
          selected: false,
          items: [
            {
              name: 'Undo',
              shortcut: 'Ctrl+Z',
              icon: 'undo',
              callback: () => {
                this.$show.undo();
              },
            },
            {
              name: 'Redo',
              shortcut: 'Ctrl+Y',
              icon: 'redo',
              callback: () => {
                this.$show.redo();
              },
            },
          ],
        },
        {
          name: 'Preferences',
          selected: false,
          items: [
            {
              name: 'Visualizer',
              shortcut: 'Ctrl+Shift+V',
              icon: 'visualizer',
              callback: () => {
                this.displayVisualizerPopup();
              },
            },
            {
              name: 'Art-Net',
              shortcut: 'Ctrl+Shift+A',
              icon: 'zoom',
              callback: () => {
                this.artnetPopupState = true;
              },
            },
            {
              name: 'Video',
              shortcut: 'Ctrl+Shift+I',
              icon: 'visualizer',
              callback: () => {
                this.videoPopupState = true;
              },
            },
            {
              name: 'Reset to defaults',
              icon: 'undo',
              callback: () => {
                this.resetToDefaults();
              },
            },
          ],
        },
        {
          name: 'About',
          selected: false,
          items: [
            {
              // The version is worth reading without opening anything, so it
              // is the label; clicking shows the splash it comes from.
              name: `Version ${import.meta.env.VITE_APP_VERSION || 'unknown'}`,
              icon: 'bulb',
              callback: () => {
                EventBus.emit('show_about');
              },
            },
            {
              name: 'Manual',
              icon: 'help',
              callback: () => {
                window.open('https://github.com/dinther/Beam/blob/master/manual.md', '_blank');
              },
            },
            {
              name: 'License',
              icon: 'key',
              callback: () => {
                this.displayLicensePopup();
              },
            },
            {
              name: 'Credits',
              icon: 'opensource',
              callback: () => {
                this.displayCreditsPopup();
              },
            },
            {
              name: 'Contact',
              icon: 'contact',
              callback: () => {
                window.open('https://beatline.xyz/contact/', '_blank');
              },
            },
          ],
        },
      ],
    };
  },
  mounted() {
    this.$show.on('saveState', (state) => {
      this.saveState = state;
    });
    // The title follows the document, not the show's stored name: a show that
    // has never been saved is `untitled` whatever the template called itself.
    this.$show.on('document', ({ title }) => {
      this.project = title;
    });
    // A file that will not open has to say so. Silence would read as the app
    // ignoring the click, and the show that is loaded stays untouched.
    this.$show.on('documentError', (target) => {
      EventBus.emit('app_error', new Error(`Could not open ${target}. It may not be a Beam project.`));
    });
    // An export that could not be written, or that is missing something the
    // show names, has to say so: the file it leaves would open with holes in
    // it on another machine, which is the one thing an export is for.
    this.$show.on('exported', ({ target, ok, missing }) => {
      if (!ok) {
        EventBus.emit('app_error', new Error(`Could not write ${target}.`));
      } else if (missing && missing.length) {
        EventBus.emit('app_error', new Error(
          `Exported ${target}, but ${missing.length} item(s) the show uses could not be found `
          + `and are not in it: ${missing.join(', ')}`,
        ));
      }
    });
    EventBus.on('app_ready', () => {
      this.project = this.$show.documentTitle;
    });
    // The debug panel's button, so both ask the same question.
    EventBus.on('reset_defaults', () => this.resetToDefaults());
    // Files dropped anywhere on the window. A .gdtf is imported; anything
    // else is refused here, because the default for a dropped file is to
    // navigate to it, which would replace the app and lose the show.
    window.addEventListener('dragover', this.onFileDragOver);
    window.addEventListener('drop', this.onFileDrop);
  },
  beforeUnmount() {
    window.removeEventListener('dragover', this.onFileDragOver);
    window.removeEventListener('drop', this.onFileDrop);
  },
  methods: {
    /**
     * Resets every preference and debug value to its default, after asking,
     * and reloads so each module starts from its own constants.
     *
     * @public
     * @async
     */
    async importGdtf() {
      if (!window.library || !window.library.pickGdtf) return;
      await importGdtfFiles(await window.library.pickGdtf(), this.$show);
    },
    /**
     * Allows a file drop. Lists reorder by dragging too, but those drags
     * carry no files and are left alone.
     *
     * @public
     * @param {DragEvent} event
     */
    onFileDragOver(event) {
      if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
      event.preventDefault();
      // eslint-disable-next-line no-param-reassign
      event.dataTransfer.dropEffect = 'copy';
    },
    /**
     * Imports dropped .gdtf files and ignores the rest.
     *
     * @public
     * @async
     * @param {DragEvent} event
     */
    async onFileDrop(event) {
      const files = [...(event.dataTransfer?.files || [])];
      if (!files.length) return;
      event.preventDefault();
      const gdtf = files.filter((file) => file.name.toLowerCase().endsWith('.gdtf'));
      if (gdtf.length < files.length) {
        EventBus.emit('app_error', new Error('Only .gdtf fixture files can be dropped on Beam.'));
      }
      if (!gdtf.length || !window.library || !window.library.pathForFile) return;
      await importGdtfFiles(gdtf.map((file) => window.library.pathForFile(file)), this.$show);
    },
    async resetToDefaults() {
      const go = await confirm({
        title: 'Reset to defaults',
        message: 'Reset all preferences and debug values to their defaults?',
        detail: this.$show.isSaved
          ? 'Beam reloads.'
          : 'Beam reloads. This show has unsaved changes: save it first or they may be lost.',
        yes: 'Reset',
        no: 'Cancel',
      });
      if (!go) return;
      await Preferences.reset();
      window.location.reload();
    },
    /**
     * Load showfile from native file loader
     *
     * @public
     * @async
     */
    async loadFile() {
      const el = document.createElement('input');
      el.type = 'file';
      el.accept = '.json,';
      el.style.display = 'none';
      el.addEventListener('change', async () => {
        if (el.files) {
          try {
            this.$router.push('/');
            await this.$show.loadFromFile(el.files[0]);
            // Yeah it sucks... But cleaning up everything from the view was a nightmare so for now:
            window.location.reload();
          } catch (err) {
            EventBus.emit('app_error', err);
          }
        }
        document.body.removeChild(el);
      });
      document.body.appendChild(el);
      el.click();
    },
    /**
     * Saves the show to the application's show file.
     *
     * @public
     */
    /**
     * Opens a project the user picks.
     *
     * @public
     * @async
     */
    async openShow() {
      await this.$show.openDocument();
    },
    /**
     * Saves the show to its document, asking where the first time.
     *
     * @public
     * @async
     */
    async saveShow() {
      // Save means save the document. With nowhere to write yet this becomes
      // Save As, because choosing where a first save lands is the user's.
      await this.$show.saveDocument();
    },
    /**
     * Writes a frozen copy of the show, with everything it references, to a
     * file the user picks.
     *
     * @public
     * @async
     */
    async exportShow() {
      await this.$show.exportDocument();
    },
    /**
     * Replaces the profiles and objects an exported project carries with the
     * library's, after asking: the show reloads, and is unsaved afterwards.
     *
     * @public
     * @async
     */
    async refreshFromLibrary() {
      const notice = (message, detail = '') => confirm({
        title: 'Refresh from Library', message, detail, yes: 'OK', no: 'Close',
      });
      if (!this.$show.documentPath) {
        await notice('This project has not been saved, so it carries nothing to refresh.');
        return;
      }
      const go = await confirm({
        title: 'Refresh from Library',
        message: 'Replace the fixture profiles and objects this project carries with the ones in your library?',
        detail: 'The show reloads with the library copies. Save to keep them in the file; '
          + 'close without saving to keep the old ones.',
        yes: 'Refresh',
        no: 'Cancel',
      });
      if (!go) return;
      const { carried, refreshed, kept } = await this.$show.refreshFromLibrary();
      const onlyHere = kept.length
        ? `Not in your library, so kept as carried: ${kept.join(', ')}`
        : '';
      if (!carried) {
        await notice('This project carries no copies of its own. It already uses your library.');
      } else if (!refreshed.length) {
        await notice('Everything this project carries already matches your library.', onlyHere);
      } else if (onlyHere) {
        await notice(`Refreshed ${refreshed.length} item(s): ${refreshed.join(', ')}`, onlyHere);
      }
    },
    /**
     * Display visualizer popup
     *
     * @public
     */
    displayVisualizerPopup() {
      this.visualizerPopupState = true;
    },
    /**
     * Display new project popup
     *
     * @public
     */
    displayNewProjectPopup() {
      this.newProjectPopupState = true;
    },
    /**
     * Display license popup
     *
     * @public
     */
    displayLicensePopup() {
      this.licensePopupState = true;
    },
    /**
     * Display credits popup
     *
     * @public
     */
    displayCreditsPopup() {
      this.creditsPopupState = true;
    },
  },
};
</script>

<style scoped>
.navigation_header {
  min-height: 40px;
  width: 100%;
  background: var(--primary-light);
  border-bottom: 1px solid var(--primary-dark);
  z-index: 20;
}
.header_menu,
.bpm_container,
.tap_container,
.state_container {
  height: 100%;
  padding: 0 16px;
  border-left: 1px solid var(--primary-dark);
}
.state_container{
  width: 100px;
  min-width: 100px;
  max-width: 100px;
}
.tap_container:active, .state_container:active{
  background: var(--secondary-dark) !important;
}
.tap_container:hover, .state_container:hover {
  background: var(--secondary-darker);
  cursor: pointer;
}
.colored_dot {
  height: 10px;
  width: 10px;
  border-radius: 50%;
  margin-left: 16px;
  animation-name: softblink;
  animation-iteration-count: infinite;
  animation-direction: alternate;
}
.play_state_icon {
  height: 10px;
  width: 10px;
  margin-right: 8px;
}
.play_state_icon.playing {
  background: transparent;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-left: 10px solid var(--accent-sea-green);
}
.play_state_icon.stopped {
  background: #ce2d5e;
  border-radius: 2px;
}
.play_state_icon.paused {
  background-size: 10px;
  background:
    linear-gradient(
      90deg ,
      var(--accent-gold) 0px,
      var(--accent-gold) 3px,
      transparent 3px,
      transparent 7px,
      var(--accent-gold) 7px,
      var(--accent-gold) 10px
    );
}

@keyframes softblink {
  0% {
    background: var(--primary-light);
    border: 2px solid var(--accent-sea-green);
  }
  50% {
    background: transparent;
    border: 2px solid var(--accent-sea-green);
  }
  50% {
    background: var(--accent-sea-green);
    border: 2px solid transparent;
  }
  100% {
    background: var(--accent-sea-green);
    border: 2px solid transparent;
  }
}
</style>
