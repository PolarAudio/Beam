<template>
  <uk-popup
    v-model="state"
    :header="headerData"
    no-validation
    @input="update()"
  >
    <uk-flex
      col
      class="body"
      :gap="10"
    >
      <p
        v-if="!fixture"
        class="subtitle"
      >
        No fixture is selected.
      </p>
      <p
        v-else
        class="subtitle"
      >
        Click a slot, then pick an image for it. A swap belongs to
        {{ targets.length > 1 ? `these ${targets.length} placements` : 'this placement' }},
        not to the fixture type.
      </p>
      <!-- Each gobo and animation wheel as a row of its slots, as they are
           now; a swapped slot is marked. Clicking one opens the picker. -->
      <uk-flex
        v-for="wheel in wheels"
        :key="wheel.name"
        col
        :gap="4"
      >
        <span class="wheel_title">
          {{ wheel.name }} <i>· {{ wheel.kind === 'animation' ? 'animation' : 'gobo' }}</i>
        </span>
        <div class="slots">
          <button
            v-for="slot in wheel.slots"
            :key="slot.number"
            type="button"
            class="slot"
            :class="{
              picked: isPicked(wheel, slot),
              swapped: !!slot.image,
              mixed: mixedSlot(wheel, slot),
            }"
            :title="`${slot.number} · ${slot.name}${slot.image ? ' (swapped)' : ''}`"
            @click="pick(wheel, slot)"
          >
            <img
              v-if="slot.thumbnail"
              :src="slot.thumbnail"
              :style="{ transform: `rotate(${slot.rotation}deg)` }"
              alt=""
            >
            <span
              v-else
              class="open"
            >open</span>
            <span class="number">{{ slot.number }}</span>
          </button>
        </div>
      </uk-flex>

      <!-- The picker for the chosen slot. -->
      <uk-flex
        v-if="picked"
        col
        :gap="6"
        class="picker"
      >
        <uk-flex :gap="6">
          <span class="picked_title">
            {{ picked.wheel }} · {{ pickedSlot ? pickedSlot.name : '' }}
          </span>
          <span style="flex: 1" />
          <uk-button
            label="Reset"
            :disabled="!pickedSlot || !pickedSlot.image"
            @click="reset"
          />
        </uk-flex>
        <uk-num-input
          v-if="pickedSlot && pickedSlot.image && pickedSlot.image !== 'open'"
          :model-value="pickedSlot.rotation"
          label="Turn in slot °"
          :min="-360"
          :max="360"
          @update:model-value="turn"
        />
        <uk-flex :gap="4">
          <uk-button
            v-for="source in sources"
            :key="source.key"
            toggleable
            :value="false"
            :label="source.label"
            :model-value="sourceKey === source.key"
            color="var(--accent-blue)"
            style="flex: 1"
            @click="sourceKey = source.key"
          />
        </uk-flex>
        <uk-txt-input
          v-if="sourceKey === 'beam' && pickedWheel && pickedWheel.kind !== 'animation'"
          v-model="search"
          label="Search"
        />
        <div class="choices">
          <!-- Open empties the slot, whatever the file put in it. -->
          <button
            type="button"
            class="choice"
            :class="{ current: pickedSlot && pickedSlot.image === 'open' }"
            title="Open: no picture in this slot"
            @click="put('open')"
          >
            <span class="open">open</span>
          </button>
          <button
            v-for="choice in choices"
            :key="choice.ref"
            type="button"
            class="choice"
            :class="{ current: pickedSlot && pickedSlot.image === choice.ref }"
            :title="choice.title"
            @click="put(choice.ref)"
          >
            <img
              :src="choice.url"
              alt=""
            >
          </button>
          <span
            v-if="!choices.length"
            class="hint"
          >{{ emptyHint }}</span>
        </div>
        <uk-button
          v-if="sourceKey === 'library'"
          label="Import image…"
          @click="importImages"
        />
      </uk-flex>
    </uk-flex>
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';
import GOBOS from '@/plugins/visualizer/gobo_manifest';
import GDTF_GOBOS from '@/plugins/visualizer/gdtf_gobos';
import { GOBO_URL } from '@/plugins/visualizer/gobo_pick';
import STOCK_DISCS, { ANIMATION_URL } from '@/plugins/visualizer/stock_discs';
import UserGobos from '@/plugins/visualizer/user_gobos';

/**
 * @file Swapping gobos and animation discs into placed fixtures' wheels,
 * opened from Fixture settings.
 *
 * Writes `overwrites` on every fixture given that has the wheel and slot;
 * see wheel_overwrites.js. The picker offers the fixture's own images, Beam's
 * stock gobos or discs, and the user's library.
 */
export default {
  name: 'WheelsPopup',
  compatConfig: { MODE: 3 },
  mixins: [PopupMixin],
  props: {
    /** The fixtures the window writes to, by id; the first is shown. */
    fixtureIds: { type: Array, default: () => [] },
  },
  data() {
    return {
      headerData: { title: 'Gobos and discs' },
      /** `{ wheel, slot }` being chosen for, or null. */
      picked: null,
      /** Which source the picker shows. */
      sourceKey: 'fixture',
      /** Words the stock gobos' titles must contain: a name or a maker. */
      search: '',
      /** The user's images, refreshed when the panel opens and on import. */
      library: UserGobos.list(),
      /** Bumped when a write changes the fixtures, to read them again. */
      revision: 0,
    };
  },
  computed: {
    targets() {
      const pool = this.$show && this.$show.fixturePool;
      const fixtures = (pool && pool.fixtures) || [];
      return this.fixtureIds.map((id) => fixtures.find((f) => f.id === id)).filter(Boolean);
    },
    fixture() {
      return this.targets[0] || null;
    },
    wheels() {
      // eslint-disable-next-line no-unused-expressions
      this.revision;
      const f = this.fixture;
      return f && f.swappableWheels ? f.swappableWheels : [];
    },
    pickedWheel() {
      return this.picked ? this.wheels.find((w) => w.name === this.picked.wheel) : null;
    },
    pickedSlot() {
      return this.pickedWheel ? this.pickedWheel.slots[this.picked.slot - 1] : null;
    },
    /** The fixture's own wheel images, by file name. */
    ownImages() {
      const type = this.fixture && this.fixture.fixtureType;
      const images = type && type.wheelImages ? [...type.wheelImages.entries()] : [];
      return images.map(([file, url]) => ({ ref: `fixture:${file}`, url, title: file }));
    },
    sources() {
      const animation = this.pickedWheel && this.pickedWheel.kind === 'animation';
      return [
        { key: 'fixture', label: 'Fixture' },
        { key: 'beam', label: animation ? 'Beam discs' : 'Beam gobos' },
        { key: 'library', label: 'Library' },
      ];
    },
    choices() {
      if (this.sourceKey === 'fixture') return this.ownImages;
      if (this.sourceKey === 'library') {
        return this.library.map((e) => ({ ref: `library:${e.key}`, url: e.url, title: e.name }));
      }
      if (this.pickedWheel && this.pickedWheel.kind === 'animation') {
        return STOCK_DISCS.map((d) => ({
          ref: `animation:${d.name}`, url: ANIMATION_URL + d.file, title: d.title,
        }));
      }
      const all = [
        ...GOBOS.map((g) => ({ ref: `gobo:${g.name}`, url: GOBO_URL + g.file, title: g.title })),
        ...GDTF_GOBOS.map((g) => ({ ref: `gobo:${g.name}`, url: GOBO_URL + g.file, title: g.title })),
      ];
      const words = this.search.toLowerCase().split(/\s+/).filter(Boolean);
      return all.filter((c) => words.every((w) => c.title.toLowerCase().includes(w)));
    },
    emptyHint() {
      if (this.sourceKey === 'fixture') return 'This fixture\'s file has no wheel images.';
      if (this.sourceKey === 'library') return 'No images in Library/Gobos yet.';
      if (this.pickedWheel && this.pickedWheel.kind !== 'animation') return 'No gobo matches the search.';
      return 'No stock discs yet: they go in public/animation.';
    },
  },
  watch: {
    fixture() {
      this.picked = null;
      this.revision += 1;
    },
    // Read the library again each time the window opens.
    state(open) {
      if (open) {
        this.revision += 1;
        this.refreshLibrary();
      }
    },
  },
  methods: {
    async refreshLibrary() {
      if (!window.library || !window.library.gobos) return;
      this.library = await window.library.gobos();
      UserGobos.set(this.library);
    },
    isPicked(wheel, slot) {
      const p = this.picked;
      return !!p && p.wheel === wheel.name && p.slot === slot.number;
    },
    /** Whether the fixtures the panel writes to differ in this slot. */
    mixedSlot(wheel, slot) {
      if (this.targets.length < 2) return false;
      const ref = (f) => {
        const here = (x) => x.wheel === wheel.name && x.slot === slot.number;
        const o = (f.overwrites || []).find(here);
        return o ? `${o.image}@${o.rotation}` : '';
      };
      const first = ref(this.targets[0]);
      return this.targets.some((t) => ref(t) !== first);
    },
    pick(wheel, slot) {
      this.picked = this.isPicked(wheel, slot) ? null : { wheel: wheel.name, slot: slot.number };
      if (this.picked && !this.ownImages.length && this.sourceKey === 'fixture') this.sourceKey = 'beam';
    },
    /**
     * Writes one slot's swap on every fixture the panel stands for that has
     * the slot: a picture and turn, or null to put the original back.
     */
    write(change) {
      if (!this.picked) return;
      const { wheel, slot } = this.picked;
      this.targets.forEach((target) => {
        const wheels = target.swappableWheels || [];
        if (!wheels.some((w) => w.name === wheel && w.slots[slot - 1])) return;
        const here = (o) => o.wheel === wheel && o.slot === slot;
        const rest = (target.overwrites || []).filter((o) => !here(o));
        const now = (target.overwrites || []).find(here);
        const next = change(now);
        target.overwrites = next ? [...rest, { wheel, slot, ...next }] : rest;
      });
      // Saved with the project, so changing one is an edit.
      if (this.$show && this.$show.touch) this.$show.touch();
      this.revision += 1;
    },
    put(ref) {
      this.write((now) => ({ image: ref, rotation: now && ref !== 'open' ? now.rotation : 0 }));
    },
    turn(degrees) {
      this.write((now) => (now ? { image: now.image, rotation: Number(degrees) || 0 } : null));
    },
    reset() {
      this.write(() => null);
    },
    async importImages() {
      if (!window.library || !window.library.addGobos) return;
      const result = await window.library.addGobos();
      await this.refreshLibrary();
      // One image picked: it goes straight into the slot.
      if (result && result.ok && result.entries.length === 1) this.put(`library:${result.entries[0].key}`);
    },
  },
};
</script>

<style scoped>
.body {
  padding: 16px;
  width: 520px;
  max-width: 94vw;
  max-height: 80vh;
  overflow-y: auto;
  box-sizing: border-box;
  /* Nothing above the popup sets a text colour. */
  color: var(--secondary-lighter);
}
.subtitle {
  margin: 0;
  font-size: 12px;
  color: var(--secondary-light);
}
.wheel_title,
.picked_title {
  color: var(--secondary-lighter);
  font-size: 12px;
}
.wheel_title i {
  color: var(--secondary-light);
  font-style: normal;
}
.slots,
.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.choices {
  max-height: 264px;
  overflow-y: auto;
}
.slot,
.choice {
  position: relative;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--secondary-dark);
  border-radius: 4px;
  background: #202226;
  cursor: pointer;
  overflow: hidden;
}
.choice {
  width: 40px;
  height: 40px;
}
.slot img,
.choice img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.slot .open,
.choice .open {
  color: var(--secondary-light);
  font-size: 10px;
}
.slot .number {
  position: absolute;
  left: 2px;
  top: 0;
  font-size: 9px;
  color: var(--secondary-lighter);
  text-shadow: 0 0 2px #000;
}
.slot.swapped {
  border-color: var(--accent-blue);
}
.slot.mixed {
  border-style: dashed;
}
.slot.picked,
.choice.current {
  outline: 2px solid var(--accent-blue);
  outline-offset: -2px;
}
.picker {
  border-top: 1px solid var(--secondary-dark);
  padding-top: 8px;
}
.hint {
  color: var(--secondary-light);
  font-size: 11px;
}
</style>
