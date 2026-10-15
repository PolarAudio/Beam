<template>
  <uk-flex
    col
    :gap="10"
  >
    <p class="sheet_hint">
      {{ scopeText }}
    </p>
    <uk-flex
      col
      :gap="6"
    >
      <span class="sheet_label">Print</span>
      <uk-checkbox
        v-for="section in sections"
        :key="section.key"
        v-model="options[section.key]"
        :label="section.label"
      />
    </uk-flex>
    <uk-flex
      col
      :gap="6"
    >
      <span class="sheet_label">Views, one page each</span>
      <uk-checkbox
        v-for="view in views"
        :key="view.key"
        v-model="options[view.key]"
        :label="view.label"
      />
      <uk-checkbox
        v-model="options.moverArrows"
        label="Mover arrows on the plan"
        :disabled="!options.viewTop"
      />
      <uk-checkbox
        v-model="options.grid"
        label="Grid"
        :disabled="!anyView"
      />
    </uk-flex>
    <uk-flex
      col
      :gap="6"
    >
      <span class="sheet_label">Fixtures</span>
      <uk-checkbox
        v-model="options.unpatched"
        label="Fixtures that are not patched"
      />
    </uk-flex>
    <uk-select-input
      v-model="paperIndex"
      style="width: 140px"
      label="Paper, landscape"
      :options="papers"
    />
    <p class="sheet_hint">
      {{ hint }}
    </p>
  </uk-flex>
</template>

<script>
import { PAPER, PATCH_SHEET_DEFAULTS } from '@/models/DMX/patch_sheet';
import MeasureTool from '@/plugins/visualizer/measure_tool';

/** Where the last choices are kept, on this machine only. */
const STORE_KEY = 'beam.patchSheetOptions';

/**
 * @returns {Object} the choices made last time, over the defaults
 */
function remembered() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}');
    const options = { ...PATCH_SHEET_DEFAULTS };
    Object.keys(options).forEach((key) => {
      if (typeof stored[key] === typeof options[key]) options[key] = stored[key];
    });
    return options;
  } catch (err) {
    return { ...PATCH_SHEET_DEFAULTS };
  }
}

/**
 * The patch sheet's choices, shown in the export popup. Reports them with
 * `change` as `{ options, anything }`; `remember` stores them for next time.
 */
export default {
  name: 'UkPatchSheetOptions',
  compatConfig: {
    MODE: 3,
  },
  props: {
    /** From `itemsScope`: what the sheet covers, or null for the whole scene. */
    scope: {
      type: Object,
      default: null,
    },
  },
  emits: ['change'],
  data() {
    return {
      options: remembered(),
      papers: Object.keys(PAPER),
      measure: MeasureTool.state,
    };
  },
  computed: {
    scopeText() {
      if (!this.scope) return 'Nothing is selected, so the whole scene is printed.';
      const fixtures = this.scope.fixtures.size;
      const objects = this.scope.objects.size;
      return `The selection only: ${fixtures} ${fixtures === 1 ? 'fixture' : 'fixtures'}`
        + `, ${objects} ${objects === 1 ? 'object' : 'objects'}.`;
    },
    sections() {
      const count = this.measure.measurements.length;
      return [
        { key: 'notes', label: this.$show.details.notes.trim() ? 'Project notes' : 'Project notes (none written)' },
        { key: 'instructions', label: 'Instructions for the crew' },
        { key: 'patchList', label: 'Patch list' },
        { key: 'fixtureTypes', label: 'Fixture types' },
        { key: 'measurements', label: count ? `Measurements (${count})` : 'Measurements (none made)' },
      ];
    },
    views() {
      return [
        { key: 'viewTop', label: 'Plan, from above' },
        { key: 'viewFront', label: 'Front, from the audience' },
        { key: 'viewBack', label: 'Back, from upstage' },
        { key: 'viewLeft', label: 'Side, from stage left' },
        { key: 'viewRight', label: 'Side, from stage right' },
      ];
    },
    anyView() {
      return this.views.some((view) => this.options[view.key]);
    },
    paperIndex: {
      get() {
        return Math.max(0, this.papers.indexOf(this.options.paper));
      },
      set(index) {
        this.options.paper = this.papers[index];
      },
    },
    /** Whether the sheet would have anything below its title. */
    anything() {
      const o = this.options;
      return o.patchList || o.fixtureTypes || this.anyView || o.instructions
        || (o.notes && !!this.$show.details.notes.trim())
        || (o.measurements && this.measure.measurements.length > 0);
    },
    hint() {
      if (!this.anything) return 'Choose at least one part to print.';
      if (this.options.measurements && !this.anyView && this.measure.measurements.length) {
        return 'Without a view, measurements are printed as a table only.';
      }
      return 'These choices are remembered for the next export.';
    },
  },
  watch: {
    options: {
      deep: true,
      immediate: true,
      handler() {
        this.$emit('change', { options: { ...this.options }, anything: this.anything });
      },
    },
    anything() {
      this.$emit('change', { options: { ...this.options }, anything: this.anything });
    },
  },
  methods: {
    /**
     * Stores the choices for the next export.
     *
     * @public
     */
    remember() {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(this.options));
      } catch (err) {
        // Not remembered; the export goes ahead.
      }
    },
  },
};
</script>

<style scoped>
.sheet_label {
  font-family: Roboto-Medium;
  font-size: 11px;
  color: var(--secondary-lighter);
}
.sheet_hint {
  font-family: Roboto-Regular;
  font-size: 11px;
  line-height: 1.45;
  color: var(--secondary-lighter-alt);
  margin: 0;
  width: 0;
  min-width: 100%;
}
</style>
