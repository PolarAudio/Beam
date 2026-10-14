<template>
  <uk-popup
    v-model="state"
    :header="headerData"
    no-validation
    @input="update()"
  >
    <uk-flex
      class="body"
      :gap="12"
      col
    >
      <p
        v-if="!device"
        class="subtitle"
      >
        No laser is selected.
      </p>
      <template v-else>
        <p class="subtitle">
          The ILDA files {{ fixture.name }} plays standalone. Drag a row to
          reorder: the number is what a Clip channel picks. Click a name to
          play it. A rate of 0 plays at the laser's maximum.
        </p>
        <!-- The card: a list kept in the library, the same in every project,
             as the card in a real laser. Local is a list of this laser's own. -->
        <uk-flex
          :gap="8"
          class="card_row"
        >
          <uk-select-input
            :model-value="cardIndex"
            style="flex: 1"
            label="Card"
            :options="cardOptions"
            @input="pickCard"
          />
          <template v-if="!cardKey">
            <uk-txt-input
              v-model="newCardName"
              style="width: 160px"
              label="Card name"
            />
            <uk-button
              label="Save as card"
              :disabled="!newCardName.trim()"
              @click="saveAsCard"
            />
          </template>
          <uk-button
            v-else-if="!cardInLibrary"
            label="Add to library"
            @click="adoptCard"
          />
        </uk-flex>
        <p
          v-if="cardNote"
          class="subtitle note"
        >
          {{ cardNote }}
        </p>
        <div
          class="clip_list"
          @dragover.prevent
        >
          <div class="clip_head">
            <span class="clip_grip" />
            <span class="clip_number">#</span>
            <span class="clip_name">Clip</span>
            <span class="clip_rate">Points/s</span>
            <span class="clip_actions" />
          </div>
          <div
            v-for="(clip, i) in clips"
            :key="clip.id"
            class="clip_row"
            :class="{
              playing: clip.id === playingId,
              dragging: i === dragFrom,
              over_above: i === dragOver && dragOver < dragFrom,
              over_below: i === dragOver && dragOver > dragFrom,
            }"
            draggable="true"
            @dragstart="dragStart(i, $event)"
            @dragenter.prevent="dragOver = i"
            @dragover.prevent
            @drop.prevent="drop(i)"
            @dragend="dragEnd"
          >
            <span
              class="clip_grip"
              title="Drag to reorder"
            >⠿</span>
            <span class="clip_number">{{ i + 1 }}</span>
            <span
              class="clip_name"
              :title="clip.file"
              @click="play(i)"
            >{{ clip.name }}</span>
            <uk-num-input
              class="clip_rate"
              :model-value="clip.rate || 0"
              :min="0"
              :max="200000"
              @update:model-value="setRate(i, $event)"
            />
            <span class="clip_actions">
              <button
                type="button"
                class="icon_button"
                title="Remove from the list"
                aria-label="Remove from the list"
                @click="remove(i)"
              >
                <uk-icon name="trash" />
              </button>
            </span>
          </div>
          <p
            v-if="!clips.length"
            class="subtitle empty"
          >
            The list is empty. Add ILDA files below.
          </p>
        </div>
        <uk-flex
          :gap="8"
          class="card_row"
        >
          <uk-button
            label="Add ILDA files…"
            @click="add"
          />
          <span style="flex: 1" />
          <uk-button
            label="Export to SD card…"
            :disabled="!clips.length"
            @click="exportToCard"
          />
        </uk-flex>
        <p
          v-if="exportNote"
          class="subtitle note"
        >
          {{ exportNote }}
        </p>
      </template>
    </uk-flex>
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';
import EventBus from '@/plugins/eventbus';
import { fileClip, selectedClip } from '@/models/DMX/laser_clips';
import { relistClipFiles } from '@/plugins/visualizer/laser_clip_player';
import {
  refreshCards, cardFor, listedCards, saveCard,
} from '@/plugins/visualizer/laser_cards';

/**
 * @file A laser's standalone clip list: the user's ILDA files, as a laser's
 * memory card holds them.
 *
 * Edits one placed laser, opened from its Fixture settings. Every change is
 * written to the device at once, marks the project changed and tells the
 * panel to read the device again.
 */
export default {
  name: 'LaserClipsPopup',
  compatConfig: { MODE: 3 },
  mixins: [PopupMixin],
  props: {
    /** The laser the window edits, by fixture id. */
    fixtureId: {
      type: Number,
      default: null,
    },
  },
  data() {
    return {
      headerData: { title: 'Clip list' },
      /** Bumped on every write, so the list reads the device again. */
      revision: 0,
      /** The row being dragged and the row it is over, or -1. */
      dragFrom: -1,
      dragOver: -1,
      /** The library's cards, read when the window opens. */
      cards: [],
      newCardName: '',
      /** What the last export did, said under the buttons. */
      exportNote: '',
    };
  },
  computed: {
    fixture() {
      const pool = this.$show && this.$show.fixturePool;
      const fixtures = (pool && pool.fixtures) || [];
      return fixtures.find((fixture) => fixture.id === this.fixtureId) || null;
    },
    device() {
      return this.fixture && this.fixture.device ? this.fixture.device : null;
    },
    clips() {
      void this.revision; // eslint-disable-line no-void
      const list = this.device ? this.device.value('clips') : null;
      return Array.isArray(list) ? list : [];
    },
    playingId() {
      void this.revision; // eslint-disable-line no-void
      const clip = this.device ? selectedClip(this.clips, this.device.value('clip')) : null;
      return clip ? clip.id : null;
    },
    /** The card this laser's list is a copy of, by key, or null. */
    cardKey() {
      void this.revision; // eslint-disable-line no-void
      return this.device ? this.device.value('card') : null;
    },
    /** The cards on offer, and this laser's own when the library lacks it. */
    cardChoices() {
      const list = this.cards.map((card) => ({ key: card.key, label: card.name }));
      if (this.cardKey && !list.some((card) => card.key === this.cardKey)) {
        list.push({ key: this.cardKey, label: `${this.cardKey} (not in the library)` });
      }
      return [{ key: null, label: 'Local list (this project only)' }, ...list];
    },
    cardOptions() {
      return this.cardChoices.map((choice) => choice.label);
    },
    cardIndex() {
      const at = this.cardChoices.findIndex((choice) => choice.key === this.cardKey);
      return at < 0 ? 0 : at;
    },
    /** Whether the library holds this laser's card, rather than only the project. */
    cardInLibrary() {
      const card = this.cards.find((entry) => entry.key === this.cardKey);
      return !!(card && card.origin === 'library');
    },
    cardNote() {
      if (!this.cardKey) return '';
      if (!this.cardInLibrary) {
        return 'This card came with the project. Add it to the library to use it in other projects.';
      }
      const users = this.cardUsers;
      return users > 1
        ? `Changes go to the card: ${users} lasers in this project and any other project using it.`
        : 'Changes go to the card, in this project and any other project using it.';
    },
    /** How many lasers in the project play this card. */
    cardUsers() {
      void this.revision; // eslint-disable-line no-void
      const pool = this.$show && this.$show.fixturePool;
      const fixtures = (pool && pool.fixtures) || [];
      return fixtures.filter((fixture) => fixture.device && fixture.device.value
        && fixture.device.value('card') === this.cardKey).length;
    },
  },
  watch: {
    modelValue(value) {
      if (value) {
        this.revision += 1;
        this.exportNote = '';
        this.readCards();
      }
    },
  },
  methods: {
    /**
     * Writes one device value, marks the project changed and tells the panel.
     * A list on a library card is written to the card too, which brings every
     * laser on it in line.
     */
    write(key, value) {
      if (!this.device) return;
      this.device.set(key, value);
      const model = this.fixture._3DModel;
      if (model && model.refresh) model.refresh();
      if (this.$show && this.$show.touch) this.$show.touch();
      this.revision += 1;
      EventBus.emit('laser_clips_changed');
      if (key === 'clips' && this.cardKey && this.cardInLibrary) {
        const card = cardFor(this.cardKey);
        saveCard(this.$show, card ? card.name : this.cardKey, value).then(() => {
          this.revision += 1;
          EventBus.emit('laser_clips_changed');
        });
      }
    },
    readCards() {
      refreshCards().then(() => { this.cards = listedCards(); }).catch(() => {});
    },
    /** Puts the laser on a card, taking its list, or back on a local list. */
    pickCard(index) {
      const choice = this.cardChoices[index];
      if (!choice || choice.key === this.cardKey) return;
      if (!choice.key) {
        // The list stays as it is, now the laser's own.
        this.write('card', null);
        return;
      }
      const card = cardFor(choice.key);
      this.write('card', choice.key);
      if (card) {
        this.write('clips', card.clips);
        this.write('clip', card.clips[0] ? card.clips[0].id : null);
      }
    },
    /** Makes this laser's own list a card in the library, and puts it on it. */
    async saveAsCard() {
      const name = this.newCardName.trim();
      if (!name) return;
      const result = await saveCard(this.$show, name, this.clips);
      if (!result || !result.ok) {
        this.exportNote = (result && result.reason) || 'The card could not be saved.';
        return;
      }
      this.newCardName = '';
      this.write('card', result.key);
      this.cards = listedCards();
    },
    /** Adds a card that came with the project to the library. */
    async adoptCard() {
      const card = cardFor(this.cardKey);
      const result = await saveCard(this.$show, card ? card.name : this.cardKey, this.clips);
      if (result && result.ok) this.cards = listedCards();
      this.revision += 1;
    },
    /** Copies the list's files to an SD card or folder, numbered in order. */
    async exportToCard() {
      if (!window.library || !window.library.exportLaserClips) return;
      const files = this.clips.map((clip) => ({ name: clip.name, file: clip.file }));
      const result = await window.library.exportLaserClips(files);
      if (!result || result.reason === 'cancelled') return;
      if (!result.ok) {
        this.exportNote = result.reason || 'Nothing was exported.';
        return;
      }
      const missing = result.missing && result.missing.length
        ? ` Not found: ${result.missing.join(', ')}.` : '';
      this.exportNote = `${result.written.length} files written to ${result.folder}.${missing}`;
    },
    play(index) {
      const clip = this.clips[index];
      if (clip) this.write('clip', clip.id);
    },
    setRate(index, rate) {
      const list = this.clips.map((clip) => ({ ...clip }));
      if (!list[index]) return;
      list[index].rate = Number(rate) > 0 ? Math.round(Number(rate)) : null;
      this.write('clips', list);
    },
    /** Takes a clip out of the list; the file stays in the library. */
    remove(index) {
      this.write('clips', this.clips.filter((clip, i) => i !== index));
    },
    dragStart(index, event) {
      this.dragFrom = index;
      this.dragOver = index;
      // Firefox drags nothing without data set.
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(index));
      }
    },
    /** Moves the dragged clip to where it was dropped. */
    drop(index) {
      const from = this.dragFrom;
      this.dragEnd();
      if (from < 0 || from === index || !this.clips[from]) return;
      const list = [...this.clips];
      const [moved] = list.splice(from, 1);
      list.splice(index, 0, moved);
      this.write('clips', list);
    },
    dragEnd() {
      this.dragFrom = -1;
      this.dragOver = -1;
    },
    /**
     * Asks for ILDA files and adds them to the end of the list. The picker
     * opens on the library's lasers folder; a file picked from there is used
     * as it is, one from anywhere else is copied in.
     */
    async add() {
      if (!window.library || !window.library.addLaserClips) return;
      const result = await window.library.addLaserClips();
      if (!result || !result.ok) return;
      const added = result.entries.map((entry) => fileClip(entry.key)).filter(Boolean);
      relistClipFiles();
      if (!added.length) return;
      this.write('clips', [...this.clips, ...added]);
      this.write('clip', added[0].id);
    },
  },
};
</script>

<style scoped>
.body {
  padding: 16px;
  width: 520px;
  max-width: 94vw;
  /* Nothing above the popup sets a text colour. */
  color: var(--secondary-lighter);
}
.clip_list {
  display: flex;
  flex-direction: column;
  max-height: 60vh;
  overflow-y: auto;
  background: var(--primary-dark-alt);
  border: 1px solid var(--primary-dark);
}
.clip_head,
.clip_row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
}
.clip_head {
  font-family: Roboto-Medium, sans-serif;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--secondary-light-alt);
}
.clip_row {
  border-top: 2px solid transparent;
  border-bottom: 2px solid transparent;
}
.clip_row:hover {
  background: var(--primary-dark);
}
.clip_row.dragging {
  opacity: 0.4;
}
.clip_row.over_above {
  border-top-color: var(--accent-blue);
}
.clip_row.over_below {
  border-bottom-color: var(--accent-blue);
}
.clip_grip {
  width: 12px;
  color: var(--secondary-lighter-alt);
  cursor: grab;
  user-select: none;
}
.clip_number {
  width: 22px;
  text-align: right;
  font-size: 11px;
  color: var(--secondary-lighter-alt);
}
.clip_name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  cursor: pointer;
}
.clip_row.playing .clip_name {
  font-family: Roboto-Medium, sans-serif;
}
.clip_rate {
  width: 80px;
}
.clip_actions {
  display: flex;
  width: 26px;
  justify-content: flex-end;
}
.icon_button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: var(--primary-dark);
  border: 1px solid var(--secondary-dark);
  color: var(--secondary-lighter);
  cursor: pointer;
}
/* Icons whose paths carry no fill of their own would draw black. */
.icon_button :deep(.icon path) {
  fill: currentColor;
}
.empty {
  padding: 8px 10px;
}
.card_row {
  align-items: flex-end;
}
.note {
  margin: 0;
  font-size: 11px;
  color: var(--secondary-lighter-alt);
}
</style>
