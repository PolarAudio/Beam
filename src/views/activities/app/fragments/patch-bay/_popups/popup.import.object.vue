<template>
  <uk-popup
    v-model="state"
    cancelable
    backdrop
    validate-txt="import"
    :valid="valid"
    :header="headerData"
    @submit="finish"
  >
    <uk-flex
      col
      :gap="8"
      class="import_object"
    >
      <uk-txt-input
        v-model="name"
        auto-update
        label="Name"
      />
      <uk-flex :gap="8">
        <uk-select-input
          v-model="unitIndex"
          style="flex: 1"
          label="Units"
          :options="unitLabels"
        />
        <uk-select-input
          v-model="upIndex"
          style="flex: 1"
          label="Up axis"
          :options="upLabels"
        />
      </uk-flex>
      <p class="import_object_size">
        {{ sizeText }}
      </p>
      <p
        v-if="sizeHint"
        class="import_object_hint"
      >
        {{ sizeHint }}
      </p>
      <p
        v-if="skipped.length"
        class="import_object_hint"
      >
        Not brought along: {{ skipped.join('; ') }}.
      </p>
      <p
        v-if="error"
        class="import_object_warning"
      >
        {{ error }}
      </p>
    </uk-flex>
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';
import SceneObjects from '@/plugins/visualizer/scene_objects';

/** Units a model may have been authored in, as metres per unit. */
const UNITS = [
  { label: 'metres', scale: 1 },
  { label: 'centimetres', scale: 0.01 },
  { label: 'millimetres', scale: 0.001 },
  { label: 'inches', scale: 0.0254 },
  { label: 'feet', scale: 0.3048 },
];

/** Which of the file's axes points up. */
const UP_AXES = [
  { label: 'Y up', axis: 'y' },
  { label: 'Z up', axis: 'z' },
];

/** Sizes outside this, in metres, are called out as a likely wrong unit. */
const PLAUSIBLE_METRES = { min: 0.01, max: 100 };

/**
 * @file Describes a model just copied into the library.
 *
 * Only glTF says what its units are and which way is up, so the user says it
 * here instead -- and sees the model's size in metres change as they do. A
 * truss that reads as three kilometres long is a wrong unit anyone can spot,
 * which is the point: nothing is guessed from the file.
 *
 * The copy already sits in the library when this opens, because a model can
 * only be loaded, and so measured, from there. Import writes its sidecar;
 * any other way of closing takes the copy back out.
 */
export default {
  name: 'ImportObjectPopup',
  compatConfig: {
    MODE: 3,
  },
  mixins: [PopupMixin],
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
    /** `{ id, entry, skipped }` from `window.library.importObject()` */
    pending: {
      type: Object,
      default: null,
    },
  },
  emits: ['update:modelValue', 'imported'],
  data() {
    return {
      headerData: { title: 'Import object' },
      name: '',
      unitIndex: 0,
      upIndex: 0,
      /** The file's own extent along x, y and z, before units or axes. */
      raw: null,
      error: '',
      busy: false,
      /** Whether the import was finished, so closing does not undo it. */
      finished: false,
      unitLabels: UNITS.map((unit) => unit.label),
      upLabels: UP_AXES.map((up) => up.label),
    };
  },
  computed: {
    trimmedName() {
      return this.name.trim();
    },
    valid() {
      return !!this.trimmedName && !!this.raw && !this.busy;
    },
    scale() {
      return UNITS[this.unitIndex].scale;
    },
    upAxis() {
      return UP_AXES[this.upIndex].axis;
    },
    /**
     * Width, depth and height in metres, as the model will stand in the room.
     *
     * @returns {Object|null}
     */
    size() {
      if (!this.raw) return null;
      const { x, y, z } = this.raw;
      const s = this.scale;
      return this.upAxis === 'y'
        ? { width: x * s, depth: z * s, height: y * s }
        : { width: x * s, depth: y * s, height: z * s };
    },
    sizeText() {
      if (this.error && !this.raw) return '';
      if (!this.size) return 'Measuring…';
      const m = (value) => `${value < 10 ? value.toFixed(2) : value.toFixed(1)} m`;
      const { width, depth, height } = this.size;
      return `${m(width)} wide, ${m(depth)} deep, ${m(height)} high`;
    },
    sizeHint() {
      if (!this.size) return '';
      const largest = Math.max(this.size.width, this.size.depth, this.size.height);
      if (largest > PLAUSIBLE_METRES.max) return 'That is very large: the units are probably smaller.';
      if (largest < PLAUSIBLE_METRES.min) return 'That is very small: the units are probably larger.';
      return '';
    },
    skipped() {
      return (this.pending && this.pending.skipped) || [];
    },
  },
  watch: {
    /**
     * Keeps the parent's flag in step, and takes an unfinished import back out
     * of the library however the dialog was closed.
     */
    state(open) {
      this.update();
      if (open) {
        this.begin();
        return;
      }
      if (!this.finished && this.pending && window.library) {
        window.library.cancelImport(this.pending.id);
      }
    },
  },
  methods: {
    /**
     * Resets the fields for the model just copied in, and measures it.
     *
     * @public
     * @async
     */
    async begin() {
      this.finished = false;
      this.error = '';
      this.raw = null;
      this.unitIndex = 0;
      this.upIndex = 0;
      const entry = this.pending && this.pending.entry;
      this.name = entry ? entry.name : '';
      if (!entry) return;
      let built = null;
      try {
        // Measured with no scale and no axis change, so every choice in the
        // dialog is arithmetic on these numbers rather than another load.
        built = await SceneObjects.buildPreview({
          ...entry, scale: 1, upAxis: 'z', offset: { x: 0, y: 0, z: 0 },
        });
        if (!built.primitives.length || built.bounds.isEmpty()) {
          this.error = 'The file loaded but holds no geometry.';
          return;
        }
        const extent = built.bounds.max.clone().sub(built.bounds.min);
        this.raw = { x: extent.x, y: extent.y, z: extent.z };
      } catch (err) {
        this.error = `The file could not be loaded: ${err.message}`;
      } finally {
        if (built) {
          built.primitives.forEach(({ geometry, material }) => {
            if (geometry && geometry.dispose) geometry.dispose();
            if (material && material.dispose) material.dispose();
          });
        }
      }
    },
    /**
     * Writes the model's description, and hands its key to the patch bay.
     *
     * @public
     * @async
     */
    async finish() {
      if (!this.valid || !this.pending) return;
      this.busy = true;
      const result = await window.library.finishImport(this.pending.id, {
        name: this.trimmedName,
        scale: this.scale,
        upAxis: this.upAxis,
      });
      this.busy = false;
      if (!result || !result.ok) {
        this.error = (result && result.reason) || 'The model could not be added.';
        return;
      }
      this.finished = true;
      this.state = false;
      /**
       * A model was added to the library.
       *
       * @property {String} key its library key
       */
      this.$emit('imported', result.key);
    },
  },
};
</script>

<style scoped>
.import_object {
  padding: 12px 14px;
  min-width: 320px;
}
.import_object_size {
  margin: 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--secondary-lighter);
}
.import_object_hint {
  margin: 0;
  font-size: 12px;
  color: var(--secondary-lighter-alt);
}
.import_object_warning {
  margin: 0;
  font-size: 12px;
  color: var(--accent-red, #d9534f);
}
</style>
