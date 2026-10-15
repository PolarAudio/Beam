<template>
  <div
    v-if="$show.visualizerHandle"
    class="pane"
  >
    <div class="section">
      Room
    </div>
    <div class="row">
      <span />
      <span class="head">House up</span>
      <span class="head">House down</span>
    </div>
    <div
      class="row"
      :title="tips.light"
    >
      <span class="label">Light (lux)</span>
      <uk-num-input
        v-model="$show.visualizerHandle.houseLightsUp"
        :min="0"
        :max="2000"
        :precision="1"
      />
      <uk-num-input
        v-model="$show.visualizerHandle.houseLightsDown"
        :min="0"
        :max="2000"
        :precision="1"
      />
    </div>
    <div
      class="row"
      :title="tips.exposure"
    >
      <span class="label">Exposure (EV)</span>
      <uk-num-input
        v-model="$show.visualizerHandle.houseExposureUp"
        :min="0"
        :max="16"
        :precision="2"
      />
      <uk-num-input
        v-model="$show.visualizerHandle.houseExposureDown"
        :min="0"
        :max="16"
        :precision="2"
      />
    </div>
    <div
      class="row"
      :title="tips.environment"
    >
      <span class="label">Environment</span>
      <uk-select-input
        v-model="environmentUpIndex"
        :options="environmentOptions"
      />
      <uk-select-input
        v-model="environmentDownIndex"
        :options="environmentOptions"
      />
    </div>
    <div
      class="row"
      :title="tips.addEnvironment"
    >
      <span class="label">Add an environment</span>
      <uk-button
        class="span"
        label="Add..."
        @click="addEnvironment"
      />
    </div>

    <div
      class="row"
      :title="tips.reflections"
    >
      <span class="label">Reflections</span>
      <uk-checkbox
        v-model="$show.visualizerHandle.reflections"
        class="span"
      />
    </div>

    <div class="section">
      Haze
    </div>
    <div
      class="row"
      :title="tips.hazeState"
    >
      <span class="label">State</span>
      <uk-select-input
        v-model="$show.visualizerHandle.globalFoggingState"
        class="span"
        :options="['disabled', 'enabled']"
      />
    </div>
    <div
      class="row"
      :title="tips.hazeIntensity"
    >
      <span class="label">Intensity</span>
      <uk-num-input
        v-model="$show.visualizerHandle.globalFoggingDensity"
        class="span"
        :min="0"
        :max="100"
      />
    </div>
    <div
      class="row"
      :title="tips.hazeScale"
    >
      <span class="label">Scale (m)</span>
      <uk-num-input
        v-model="$show.visualizerHandle.globalFoggingScale"
        class="span"
        :min="2"
        :max="15"
        :precision="1"
      />
    </div>
    <div
      class="row"
      :title="tips.hazeTurbulence"
    >
      <span class="label">Turbulence</span>
      <uk-num-input
        v-model="$show.visualizerHandle.globalFoggingTurbulences"
        class="span"
        :min="0"
        :max="100"
      />
    </div>

    <div class="section">
      Reference
    </div>
    <div
      class="row"
      :title="tips.grid"
    >
      <span class="label">Grid</span>
      <uk-checkbox
        v-model="$show.visualizerHandle.showGrid"
        class="span"
      />
    </div>
    <div
      class="row"
      :title="tips.gridSize"
    >
      <span class="label">Grid size (m)</span>
      <uk-num-input
        v-model="$show.visualizerHandle.snapSpacing"
        class="span"
        :precision="2"
        :min="0.01"
        :max="100"
      />
    </div>
    <div
      class="row"
      :title="tips.anchorReach"
    >
      <span class="label">Anchor snap (m)</span>
      <uk-num-input
        v-model="$show.visualizerHandle.anchorReach"
        class="span"
        :precision="2"
        :step="0.05"
        :min="0.02"
        :max="10"
      />
    </div>
    <div
      class="row"
      :title="tips.gridBrightness"
    >
      <span class="label">Grid brightness</span>
      <uk-num-input
        v-model="$show.visualizerHandle.gridOpacity"
        class="span"
        :precision="2"
        :step="0.05"
        :min="0"
        :max="1"
      />
    </div>
    <div
      class="row"
      :title="tips.gridLineWidth"
    >
      <span class="label">Grid line width (px)</span>
      <uk-num-input
        v-model="$show.visualizerHandle.gridLineWidth"
        class="span"
        :precision="2"
        :min="0.1"
        :max="4"
      />
    </div>
    <div
      class="row"
      :title="tips.axes"
    >
      <span class="label">Axes</span>
      <uk-checkbox
        v-model="$show.visualizerHandle.showAxes"
        class="span"
      />
    </div>
    <div
      class="row"
      :title="tips.background"
    >
      <span class="label">Background</span>
      <input
        v-model="backgroundColor"
        type="color"
        class="colour_swatch span"
      >
    </div>

    <div class="section">
      Interface
    </div>
    <div
      class="row"
      :title="tips.debug"
    >
      <span class="label">Debug</span>
      <uk-checkbox
        v-model="$show.visualizerHandle.debug"
        class="span"
      />
    </div>
  </div>
</template>

<script>
/**
 * @component The visualiser's preferences: room, haze, reference and
 * interface. Mounted each time the Preferences window opens, which is when
 * the values Cancel goes back to are read.
 */
export default {
  name: 'PreferencesVisualizerPane',
  compatConfig: {
    MODE: 3,
  },
  data() {
    return {
      /** Each row's explanation, shown as its tooltip. */
      tips: {
        reflections: 'Glossy surfaces reflect what is on screen. Off, they reflect only the environment image. Costs an extra pass over the scene.',
        light: 'Light on a white floor, in lux. House up is for looking at the rig, house down for watching the show; the toolbar swaps between them.',
        exposure: 'The camera\'s exposure at ISO 100. One higher halves the picture\'s brightness. Set it for the brightest thing you want to see, as on a camera.',
        environment: 'The image lighting the room. A dark room still wants something in it, or metal and gloss have nothing to reflect.',
        addEnvironment: 'Copies a .hdr or .exr into your library, where both lists read from.',
        hazeState: 'Turn the haze in the room on or off.',
        hazeIntensity: 'How much haze there is. None leaves a clean beam.',
        hazeScale: 'How wide one clump of haze is, in metres.',
        hazeTurbulence: 'How fast the haze moves and churns.',
        grid: 'Show the infinite reference grid.',
        gridSize: 'Metres between grid lines, and the distance the gizmo snaps by. The same on all three axes.',
        anchorReach: 'How close a truss end has to come to another before the two join. Not the grid: this is how near the connection has to be. A tight reach suits short trusses, where half a metre would put several connections in range at once.',
        gridBrightness: 'How strongly the grid draws. What reads as subtle depends on the background behind it.',
        gridLineWidth: 'In pixels. Below 1 the lines go fainter rather than narrower: a line thinner than a pixel cannot be drawn, only dimmed.',
        axes: 'Show the origin axis indicator.',
        background: 'Colour behind the scene.',
        debug: 'Show the frame timings and the tuning panel.',
      },
      /** Environment images in the library, as `{ key, name, url }`. */
      environments: [],
      /** The settings as they stood when the window opened. */
      initialValues: null,
    };
  },
  computed: {
    /**
     * Every choice the two environment lists offer.
     *
     * The sentinels first, then whatever is in the library. A setting whose
     * file has since been deleted is appended rather than dropped: silently
     * showing the first entry instead would look like the setting had changed
     * itself.
     *
     * @type {Array}
     */
    environmentEntries() {
      const entries = [
        { key: 'room', name: 'Built-in room' },
        { key: 'venue', name: 'Dark venue' },
        { key: 'none', name: 'None' },
        ...this.environments,
      ];
      const handle = this.$show.visualizerHandle;
      if (handle) {
        [handle.environmentHouseOn, handle.environmentHouseOff].forEach((spec) => {
          if (spec && !entries.some((entry) => entry.key === spec)) {
            entries.push({ key: spec, name: `${spec} (missing)` });
          }
        });
      }
      return entries;
    },
    /** @type {Array<String>} what the selects display */
    environmentOptions() {
      return this.environmentEntries.map((entry) => entry.name);
    },
    /**
     * The house-up environment, as the index the select works in. The setting
     * is a file name, so an index stored instead would move whenever the
     * library gained or lost a file.
     *
     * @type {Number}
     */
    environmentUpIndex: {
      get() {
        return this.indexOfEnvironment(this.$show.visualizerHandle
          && this.$show.visualizerHandle.environmentHouseOn);
      },
      set(index) {
        const entry = this.environmentEntries[index];
        if (entry && this.$show.visualizerHandle) {
          this.$show.visualizerHandle.environmentHouseOn = entry.key;
        }
      },
    },
    /** @type {Number} the house-down environment, as an index */
    environmentDownIndex: {
      get() {
        return this.indexOfEnvironment(this.$show.visualizerHandle
          && this.$show.visualizerHandle.environmentHouseOff);
      },
      set(index) {
        const entry = this.environmentEntries[index];
        if (entry && this.$show.visualizerHandle) {
          this.$show.visualizerHandle.environmentHouseOff = entry.key;
        }
      },
    },
    /** @type {String} the scene background, as the colour input's hex */
    backgroundColor: {
      get() {
        return this.$show.visualizerHandle
          ? this.$show.visualizerHandle.backgroundColor
          : '#0c0d0a';
      },
      set(value) {
        if (this.$show.visualizerHandle) {
          this.$show.visualizerHandle.backgroundColor = value;
        }
      },
    },
  },
  mounted() {
    if (this.$show.visualizerHandle) this.initialValues = this.$show.visualizerHandle.showData;
    // The library folder is read on every opening: a file put in it since is
    // otherwise never listed.
    this.loadEnvironments();
  },
  methods: {
    /**
     * Where a named environment sits in the option list.
     *
     * @param {String} spec a file name, or one of the sentinels
     * @returns {Number} an index, falling back to the built-in room
     */
    indexOfEnvironment(spec) {
      const index = this.environmentEntries.findIndex((entry) => entry.key === spec);
      return index < 0 ? 0 : index;
    },
    /** Reads the library's environment folder. */
    async loadEnvironments() {
      if (!window.library || !window.library.environments) return;
      this.environments = await window.library.environments();
    },
    /**
     * Asks for a radiance image and copies it into the library. It is not
     * selected for either state: which room it is meant to be is the user's
     * to say.
     */
    async addEnvironment() {
      if (!window.library || !window.library.addEnvironment) return;
      const result = await window.library.addEnvironment();
      if (result && result.ok) await this.loadEnvironments();
    },
    /**
     * Puts every setting back as it stood when the window opened.
     *
     * @public
     */
    revert() {
      const handle = this.$show.visualizerHandle;
      const initial = this.initialValues;
      if (!handle || !initial) return;
      handle.globalFoggingState = initial.globalFoggingState;
      handle.globalFoggingDensity = initial.globalFoggingDensity;
      handle.globalFoggingScale = initial.globalFoggingScale;
      handle.globalFoggingTurbulences = initial.globalFoggingTurbulences;
      handle.houseLightsUp = initial.houseLuxUp;
      handle.houseLightsDown = initial.houseLuxDown;
      handle.houseExposureUp = initial.houseEVUp;
      handle.houseExposureDown = initial.houseEVDown;
      handle.snapSpacing = initial.snapSpacing;
      handle.anchorReach = initial.anchorReach;
      handle.showGrid = initial.showGrid;
      handle.gridOpacity = initial.gridOpacity;
      handle.gridLineWidth = initial.gridLineWidth;
      handle.showAxes = initial.showAxes;
      handle.reflections = initial.reflections;
    },
  },
};
</script>

<style scoped src="./pane.css"></style>
