<template>
  <uk-popup
    v-model="state"
    validate-txt="OK"
    cancel-txt="Cancel"
    :header="headerData"
    backdrop
    @submit="submit()"
    @input="update()"
  >
    <uk-flex
      col
      :gap="8"
      class="project"
    >
      <uk-flex :gap="8">
        <uk-flex
          col
          :gap="4"
          class="project_field"
        >
          <label
            class="project_label"
            for="project_author"
          >Author</label>
          <input
            id="project_author"
            v-model="author"
            class="project_input"
            spellcheck="false"
          >
        </uk-flex>
        <uk-flex
          col
          :gap="4"
          class="project_field project_version"
        >
          <label
            class="project_label"
            for="project_version"
          >Version</label>
          <input
            id="project_version"
            v-model="version"
            class="project_input"
            spellcheck="false"
          >
        </uk-flex>
      </uk-flex>
      <label
        class="project_label"
        for="project_notes"
      >Notes</label>
      <textarea
        id="project_notes"
        v-model="notes"
        class="project_notes"
        spellcheck="true"
        placeholder="Venue, contact, power, rigging, anything the crew needs"
        @keydown.enter.ctrl.prevent="newLine"
      />
      <p class="project_hint">
        Saved with the project. Printed at the top of the patch sheet.
      </p>
    </uk-flex>
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';

export default {
  name: 'UkPopupProject',
  compatConfig: {
    MODE: 3,
  },
  mixins: [PopupMixin],
  data() {
    return {
      headerData: { title: 'Project Details', icon: 'wrench' },
      author: '',
      version: '',
      notes: '',
    };
  },
  watch: {
    modelValue(state) {
      this.state = state;
      if (state) Object.assign(this, this.$show.details);
    },
  },
  methods: {
    /**
     * Ctrl+Enter is a new line here as well; a textarea ignores it by default.
     *
     * @param {KeyboardEvent} e
     */
    newLine(e) {
      const box = e.target;
      const at = box.selectionStart;
      this.notes = `${this.notes.slice(0, at)}\n${this.notes.slice(box.selectionEnd)}`;
      this.$nextTick(() => { box.selectionStart = at + 1; box.selectionEnd = at + 1; });
    },
    /**
     * Writes the details to the show, which marks it changed when they differ.
     *
     * @public
     */
    submit() {
      this.$show.setDetails({ author: this.author, version: this.version, notes: this.notes });
      this.close();
    },
  },
};
</script>

<style scoped>
.project {
  padding: 16px;
  width: 420px;
  white-space: normal;
}
.project_label {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-lighter);
}
.project_field {
  flex: 1;
}
.project_version {
  flex: 0 0 110px;
}
.project_input {
  height: 25px;
  border: 1px solid var(--secondary-dark);
  background: var(--primary-dark);
  color: var(--secondary-lighter);
  font-family: Roboto-Regular;
  font-size: 11px;
  padding: 0 5px;
  outline: 0;
}
.project_input:focus {
  outline: 1px solid var(--accent-blue);
  outline-offset: -1px;
}
.project_notes {
  height: 180px;
  resize: vertical;
  border: 1px solid var(--secondary-dark);
  background: var(--primary-dark);
  color: var(--secondary-lighter);
  font-family: Roboto-Regular;
  font-size: 11px;
  line-height: 1.45;
  padding: 5px;
  outline: 0;
}
.project_notes:focus {
  outline: 1px solid var(--accent-blue);
  outline-offset: -1px;
}
.project_hint {
  font-family: Roboto-Regular;
  font-size: 11px;
  line-height: 1.45;
  color: var(--secondary-lighter-alt);
  margin: 0;
  width: 0;
  min-width: 100%;
}
</style>
