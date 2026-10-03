<template>
  <div
    ref="root"
    class="filter_menu"
  >
    <!-- Keyed by state: the button keeps its own toggle, and its state here
         is whether anything is filtered, not whether it was clicked. -->
    <uk-button
      :key="`filter-${active}`"
      icon="funnel"
      icon-only
      square
      toggleable
      :model-value="active"
      color="var(--accent-blue)"
      :label="summary"
      @click="toggleOpen"
    />
    <!-- On the page body: the dialog is transformed and clips, which would
         carry a fixed panel with it and cut it off. -->
    <teleport to="body">
      <div
        v-if="open"
        ref="panel"
        class="filter_menu_panel"
        :style="panelStyle"
      >
        <div
          v-for="group in groups"
          :key="group.id"
          class="filter_menu_group"
        >
          <h4 class="filter_menu_title">
            {{ group.title }}
          </h4>
          <div
            v-for="option in group.options"
            :key="option.id"
            class="filter_menu_option"
            @click="toggle(group.id, option.id)"
          >
            <span @click.stop>
              <uk-checkbox
                :model-value="isOn(group.id, option.id)"
                @update:model-value="toggle(group.id, option.id)"
              />
            </span>
            <uk-icon
              v-if="option.icon"
              class="filter_menu_icon"
              :name="option.icon"
            />
            <span class="filter_menu_label">{{ option.label }}</span>
            <span class="filter_menu_count">{{ option.count }}</span>
          </div>
        </div>
        <div
          class="filter_menu_clear"
          :class="{ disabled: !active }"
          @click="clear"
        >
          Clear filters
        </div>
      </div>
    </teleport>
  </div>
</template>

<script>
/**
 * A funnel button that opens a list of filters, in groups of checkboxes.
 *
 * Within a group the ticked options are alternatives; across groups each
 * must hold. A group with nothing ticked does not filter. The button is lit
 * while anything is ticked, and its tooltip names what is, so a short list
 * says why without opening the menu.
 */
export default {
  name: 'FilterMenu',
  compatConfig: {
    MODE: 3,
  },
  props: {
    /**
     * `[{ id, title, options: [{ id, label, icon, count }] }]`
     */
    groups: {
      type: Array,
      default: () => [],
    },
    /** The ticked options, by group: `{ <group id>: [<option id>] }`. */
    modelValue: {
      type: Object,
      default: () => ({}),
    },
  },
  emits: ['update:modelValue'],
  data() {
    return { open: false, panelStyle: {} };
  },
  computed: {
    active() {
      return Object.values(this.modelValue).some((ids) => ids && ids.length);
    },
    summary() {
      if (!this.active) return 'Filter by type and origin';
      const named = this.groups.flatMap((group) => (this.modelValue[group.id] || [])
        .map((id) => (group.options.find((o) => o.id === id) || { label: id }).label));
      return `Filtered: ${named.join(', ')}`;
    },
  },
  beforeUnmount() {
    this.listen(false);
  },
  methods: {
    isOn(group, option) {
      return (this.modelValue[group] || []).includes(option);
    },
    toggle(group, option) {
      const ids = this.modelValue[group] || [];
      const next = ids.includes(option) ? ids.filter((id) => id !== option) : [...ids, option];
      this.$emit('update:modelValue', { ...this.modelValue, [group]: next });
    },
    clear() {
      if (this.active) this.$emit('update:modelValue', {});
    },
    /** Opens below the button, its right edge on the button's. */
    toggleOpen() {
      this.open = !this.open;
      if (this.open) {
        const r = this.$refs.root.getBoundingClientRect();
        this.panelStyle = { top: `${r.bottom + 4}px`, right: `${window.innerWidth - r.right}px` };
      }
      this.listen(this.open);
    },
    listen(on) {
      const method = on ? 'addEventListener' : 'removeEventListener';
      document[method]('mousedown', this.closeOutside, true);
      document[method]('keydown', this.closeOnEscape, true);
    },
    closeOutside(e) {
      const inside = [this.$refs.root, this.$refs.panel].some((el) => el && el.contains(e.target));
      if (!inside) this.close();
    },
    closeOnEscape(e) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      this.close();
    },
    close() {
      this.open = false;
      this.listen(false);
    },
  },
};
</script>

<style scoped>
.filter_menu {
  position: relative;
  display: flex;
}
/* Opaque and square-cornered: text over a translucent or rounded layer
   loses its subpixel antialiasing. */
.filter_menu_panel {
  position: fixed;
  z-index: 250;
  min-width: 200px;
  padding: 6px 0;
  background: var(--primary-light);
  border: 1px solid var(--secondary-darker);
}
.filter_menu_group + .filter_menu_group {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--primary-dark);
}
.filter_menu_title {
  padding: 2px 10px 4px;
  font-family: Roboto-Bold;
  font-size: 11px;
  color: var(--secondary-light-alt);
}
.filter_menu_option {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 22px;
  padding: 0 10px;
  cursor: pointer;
}
.filter_menu_option:hover {
  background: var(--primary-lighter);
}
.filter_menu_icon {
  width: 14px !important;
  height: 14px !important;
  fill: var(--secondary-lighter);
}
.filter_menu_label {
  flex: 1;
  font-family: Roboto-Regular;
  font-size: 12px;
  color: var(--secondary-lighter);
}
.filter_menu_count {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-light-alt);
}
.filter_menu_clear {
  margin-top: 6px;
  padding: 6px 10px 2px;
  border-top: 1px solid var(--primary-dark);
  font-family: Roboto-Regular;
  font-size: 12px;
  color: var(--secondary-lighter);
  cursor: pointer;
}
.filter_menu_clear.disabled {
  color: var(--secondary-light);
  cursor: default;
}
</style>
