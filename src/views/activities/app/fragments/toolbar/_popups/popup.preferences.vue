<template>
  <uk-popup
    v-model="state"
    :on-cancel="cancel"
    :header="headerData"
    @submit="close"
    @input="update()"
  >
    <div class="body">
      <div
        class="tabs"
        role="tablist"
      >
        <button
          v-for="(name, key) in tabs"
          :key="key"
          role="tab"
          class="tab"
          :class="{ active: current === key }"
          :aria-selected="current === key"
          @click="current = key"
        >
          {{ name }}
        </button>
      </div>
      <div class="content">
        <pane-visualizer
          v-show="current === 'visualizer'"
          ref="visualizer"
        />
        <pane-dmx v-show="current === 'dmx'" />
      </div>
    </div>
    <template #actions>
      <uk-button
        label="Reset all..."
        title="Every preference and debug value back to its default. Beam reloads."
        @click="resetToDefaults"
      />
    </template>
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';
import confirm from '@/plugins/confirm';
import Preferences from '@/plugins/visualizer/preferences';
import PaneVisualizer from './preferences/pane.visualizer.vue';
import PaneDmx from './preferences/pane.dmx.vue';

/**
 * @component The Preferences window: a tab for the visualizer and one for
 * DMX. Both panes are built each time it opens. Cancel puts the visualizer's
 * settings back; DMX settings apply at once and stay.
 */
export default {
  name: 'PreferencesPopup',
  compatConfig: {
    MODE: 3,
  },
  components: {
    PaneVisualizer,
    PaneDmx,
  },
  mixins: [PopupMixin],
  props: {
    /** The tab shown when the window opens: `visualizer` or `dmx`. */
    tab: {
      type: String,
      default: 'visualizer',
    },
  },
  data() {
    return {
      headerData: { title: 'Preferences' },
      tabs: { visualizer: 'Visualizer', dmx: 'DMX' },
      current: this.tab,
    };
  },
  watch: {
    modelValue(open) {
      if (open) this.current = this.tab;
    },
    tab(value) {
      this.current = value;
    },
  },
  methods: {
    cancel() {
      if (this.$refs.visualizer) this.$refs.visualizer.revert();
      this.close();
    },
    /**
     * Resets every preference and debug value to its default, after asking,
     * and reloads so each module starts from its own constants.
     */
    async resetToDefaults() {
      const go = await confirm({
        title: 'Reset to defaults',
        message: 'Reset all preferences and debug values to their defaults?',
        detail: this.$show.isSaved
          ? 'Beam reloads.'
          : 'Beam reloads. This project has unsaved changes: save it first or they may be lost.',
        yes: 'Reset',
        no: 'Cancel',
      });
      if (!go) return;
      await Preferences.reset();
      window.location.reload();
    },
  },
};
</script>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  width: 440px;
  max-width: 94vw;
  color: var(--secondary-lighter);
}
.tabs {
  display: flex;
  gap: 2px;
  padding: 8px 10px 0;
  border-bottom: 1px solid var(--primary-dark);
}
.tab {
  padding: 6px 14px;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 3px 3px 0 0;
  background: none;
  color: var(--secondary-light-alt);
  cursor: pointer;
}
.tab:hover {
  color: var(--secondary-lighter);
}
.tab.active {
  background: var(--primary-dark-alt);
  border-color: var(--primary-dark);
  color: var(--secondary-lighter);
}
.content {
  padding: 10px;
  max-height: 60vh;
  overflow: auto;
}
</style>
