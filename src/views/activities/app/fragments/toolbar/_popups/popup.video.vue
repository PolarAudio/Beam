<template>
  <uk-popup
    v-model="state"
    :header="headerData"
    no-validation
    @input="update()"
  >
    <uk-flex
      class="body"
      :gap="16"
      col
    >
      <p class="subtitle intro">
        The pictures this project receives. A display or projector picks one and
        shows all of it; several can share one. Laying content out across
        outputs is the media server's job.
      </p>

      <uk-flex :gap="16">
        <!-- The show's inputs. -->
        <div class="inputs">
          <div class="inputs_head">
            Inputs in this project
          </div>
          <button
            v-for="input in listed"
            :key="input.uid"
            type="button"
            class="input_row"
            :class="{ selected: input.id === selectedId }"
            @click="selectedId = input.id"
          >
            <span
              class="dot"
              :class="statusOf(input)"
              :title="statusText(input)"
            />
            <span class="input_text">
              <span class="input_name">{{ input.name }}</span>
              <span class="input_sub">{{ describe(input) }}</span>
            </span>
            <span
              class="input_count"
              :title="`${usersOf(input).length} device(s) show this input`"
            >{{ usersOf(input).length }}</span>
          </button>
          <uk-flex
            :gap="6"
            class="inputs_add"
          >
            <uk-button
              label="Add NDI input"
              @click="addNdi"
            />
            <uk-button
              label="Add file…"
              :disabled="!filesAvailable"
              @click="addFile"
            />
            <!-- Puts the selected input on the devices the window was opened from. -->
            <uk-button
              v-if="forDevices.length"
              label="Apply"
              :title="useLabel"
              :disabled="alreadyUsed"
              @click="useSelected"
            />
          </uk-flex>
        </div>

        <!-- The selected input. -->
        <uk-flex
          v-if="selected"
          class="detail"
          :gap="12"
          col
        >
          <uk-flex
            :gap="8"
            center-h
          >
            <h4 class="detail_title">
              {{ selected.name }}
            </h4>
            <uk-spacer />
            <uk-button
              v-if="!selected.builtIn"
              label="Remove"
              @click="remove"
            />
          </uk-flex>
          <p
            v-if="selected.builtIn"
            class="subtitle"
          >
            Built in and always here: a grey wedge, colour bars, a fine grid, a
            circle and an F in one corner, to check brightness, colour,
            sharpness, shape and orientation.
          </p>
          <uk-txt-input
            v-if="!selected.builtIn"
            :model-value="selected.name"
            label="Name"
            @update:model-value="rename"
          />
          <template v-if="selected.builtIn" />
          <template v-else-if="selected.kind === 'ndi'">
            <uk-select-input
              :model-value="senderIndex"
              :options="senderOptions"
              label="Sender"
              :disabled="!ndiAvailable"
              @input="pickSender"
            />
            <p class="subtitle">
              Which sender fills this input is a setting of this machine. The
              project keeps only the input.
            </p>
          </template>
          <template v-else>
            <uk-select-input
              :model-value="fileIndex"
              :options="fileOptions"
              label="File"
              @input="pickFile"
            />
            <div
              v-if="playback"
              class="transport"
            >
              <uk-button
                :label="playback.playing ? 'Pause' : 'Play'"
                @click="togglePlay"
              />
              <input
                class="transport_position"
                type="range"
                min="0"
                :max="playback.duration"
                step="0.01"
                :value="playback.time"
                @input="seekTo($event.target.value)"
              >
              <span class="transport_time">
                {{ clock(playback.time) }} / {{ clock(playback.duration) }}
              </span>
            </div>
          </template>

          <div
            ref="stage"
            class="stage"
          >
            <canvas
              v-show="hasPicture"
              ref="canvas"
              class="picture"
            />
            <p
              v-if="!hasPicture"
              class="stage_empty"
            >
              {{ statusText(selected) }}
            </p>
          </div>
          <p class="subtitle">
            {{ previewStatus }}
          </p>

          <div class="used">
            <span class="used_label">Used by</span>
            <span
              v-if="!usersOf(selected).length"
              class="subtitle"
            >No device yet. Pick this input in a display's or projector's settings.</span>
            <span
              v-for="name in usersOf(selected)"
              :key="name"
              class="chip"
            >{{ name }}</span>
          </div>
        </uk-flex>
      </uk-flex>
    </uk-flex>
  </uk-popup>
</template>

<script>
import * as THREE from 'three';
import PopupMixin from '@/views/mixins/popup.mixin';
import VideoFeed from '@/plugins/visualizer/video_feed';
import VideoRouter from '@/plugins/visualizer/video_router';
import createVideoMaterial from '@/plugins/visualizer/video_material';
import { INPUT_KINDS } from '@/models/DMX/video_input';
import EventBus from '@/plugins/eventbus';

/**
 * @namespace views/activities/app/fragments/toolbar/popups
 * @component VideoPopup The show's video inputs.
 *
 * An input is one NDI stream or one file; devices pick inputs in their own
 * settings. This lists the inputs, says which are live and who uses them,
 * binds an NDI input to a sender on this machine, and previews the selected
 * one. Opening it changes nothing in the scene.
 */

/**
 * How often the preview redraws and the status rereads, in frames a second.
 * The preview is a second upload of the same frame into a second GL context,
 * so it runs well below the feed's own rate, and only while open.
 */
const PREVIEW_FPS = 10;

/** How often the sender and file lists are read again while open, in ms. */
const RESCAN_MS = 5000;

const STATUS_TEXT = {
  live: 'Live',
  waiting: 'Waiting for the first frame…',
  unbound: 'Not bound to a sender on this machine',
  missing: 'Not found',
  unused: 'No device shows this input, so it is not open',
};

export default {
  name: 'VideoPopup',
  compatConfig: { MODE: 3 },
  mixins: [PopupMixin],
  props: {
    /** The input to show when the window opens, or null for the last one shown. */
    focusId: {
      type: Number,
      default: null,
    },
    /** The devices the window was opened from, by fixture id. */
    forFixtures: {
      type: Array,
      default: () => [],
    },
  },
  data() {
    return {
      headerData: { title: 'Video inputs' },
      selectedId: null,
      senders: [],
      files: [],
      hasPicture: false,
      previewStatus: '',
      /** Measured frames a second of the previewed feed. */
      rate: 0,
      /** Bumped by the timer, so statuses and counts reread. */
      tick: 0,
    };
  },
  computed: {
    inputs() {
      return (this.$show && this.$show.videoInputs) || [];
    },
    selected() {
      return this.inputs.find((input) => input.id === this.selectedId) || null;
    },
    /** The previewed video file's transport, reread on every tick; null for anything else. */
    playback() {
      if (this.tick < 0) return null;
      const feed = this.previewFeed;
      if (!feed || feed.kind !== 'video' || !feed.duration) return null;
      return { playing: feed.playing, time: feed.currentTime, duration: feed.duration };
    },
    /** The devices the window was opened from, as fixtures. */
    forDevices() {
      const pool = this.$show && this.$show.fixturePool;
      const fixtures = (pool && pool.fixtures) || [];
      return this.forFixtures
        .map((id) => fixtures.find((fixture) => fixture.id === id))
        .filter((fixture) => fixture && fixture.device);
    },
    useLabel() {
      const devices = this.forDevices;
      return devices.length === 1 ? `Use for ${devices[0].name}` : `Use for ${devices.length} devices`;
    },
    /** Whether every device it was opened from already shows the selection. */
    alreadyUsed() {
      void this.tick; // eslint-disable-line no-void
      if (!this.selected) return true;
      return this.forDevices.every((fixture) => fixture.device.value('source') === this.selected.id);
    },
    /** The built-in test card first, then the project's own inputs. */
    listed() {
      return [
        ...this.inputs.filter((input) => input.builtIn),
        ...this.inputs.filter((input) => !input.builtIn),
      ];
    },
    ndiAvailable() {
      return VideoFeed.available();
    },
    filesAvailable() {
      return VideoFeed.filesAvailable();
    },
    senderOptions() {
      return ['— not bound —', ...this.senders.map((s) => s.name)];
    },
    senderIndex() {
      void this.tick; // eslint-disable-line no-void
      if (!this.selected) return 0;
      const bound = VideoRouter.binding(this.selected.uid);
      const at = this.senders.findIndex((s) => s.name === bound);
      return at < 0 ? 0 : at + 1;
    },
    fileOptions() {
      return this.files.map((file) => `${file.kind === 'video' ? 'Video' : 'Image'}: ${file.name}`);
    },
    fileIndex() {
      if (!this.selected) return 0;
      const at = this.files.findIndex((file) => file.key === this.selected.file);
      return at < 0 ? 0 : at;
    },
  },
  watch: {
    modelValue: {
      immediate: true,
      handler(value) {
        if (value) this.opened();
        else this.closed();
      },
    },
    selectedId() {
      this.openPreview();
    },
  },
  beforeUnmount() {
    this.closed();
  },
  methods: {
    async opened() {
      if (this.focusId !== null && this.inputs.some((input) => input.id === this.focusId)) {
        this.selectedId = this.focusId;
      } else if (!this.selected && this.listed.length) {
        this.selectedId = this.listed[0].id;
      }
      this.unlisten = VideoRouter.listen(() => { this.tick += 1; });
      this.timer = setInterval(() => {
        this.tick += 1;
        this.drawPreview();
        this.measureRate();
      }, 1000 / PREVIEW_FPS);
      // A sender started after the window opened is found within a few
      // seconds rather than never.
      this.rescan = setInterval(() => this.loadLists(), RESCAN_MS);
      await this.loadLists();
      this.$nextTick(() => this.openPreview());
    },

    closed() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this.rescan) { clearInterval(this.rescan); this.rescan = null; }
      if (this.unlisten) { this.unlisten(); this.unlisten = null; }
      this.closePreview();
      if (this.renderer) {
        if (this.quad) {
          if (this.quad.material) this.quad.material.dispose();
          this.quad.geometry.dispose();
        }
        this.renderer.dispose();
        this.renderer = null;
        this.quad = null;
      }
    },

    async loadLists() {
      this.senders = VideoFeed.available() ? await VideoFeed.sources() : [];
      this.files = await VideoFeed.files();
    },

    statusOf(input) {
      void this.tick; // eslint-disable-line no-void
      return VideoRouter.statusOf(input);
    },
    statusText(input) {
      return STATUS_TEXT[this.statusOf(input)] || '';
    },
    describe(input) {
      void this.tick; // eslint-disable-line no-void
      if (input.kind === INPUT_KINDS.FILE) return `File · ${input.file || 'none'}`;
      const sender = VideoRouter.binding(input.uid);
      return sender ? `NDI · ${sender}` : 'NDI · not bound on this machine';
    },
    /** The names of the devices whose input this is. */
    usersOf(input) {
      void this.tick; // eslint-disable-line no-void
      const pool = this.$show && this.$show.fixturePool;
      const fixtures = (pool && pool.fixtures) || [];
      return fixtures
        .filter((fixture) => fixture.device && fixture.device.value
          && fixture.device.value('source') === input.id)
        .map((fixture) => fixture.name);
    },

    addNdi() {
      const input = this.$show.addVideoInput({ kind: INPUT_KINDS.NDI });
      this.selectedId = input.id;
      this.assignNew(input);
    },
    /**
     * Sets devices to an input, the way their own panel would: the value,
     * then a redraw of each device.
     *
     * @param {Array} fixtures
     * @param {Number} id input id
     */
    assign(fixtures, id) {
      fixtures.forEach((fixture) => {
        fixture.device.set('source', id);
        const model = fixture._3DModel;
        if (model && model.refresh) model.refresh();
      });
      if (fixtures.length) {
        this.$show.touch();
        EventBus.emit('video_input_assigned');
        this.tick += 1;
      }
    },
    /** Puts the selected input on the devices the window was opened from. */
    useSelected() {
      if (this.selected) this.assign(this.forDevices, this.selected.id);
    },
    /** A new input made from a device's panel goes on the devices that had none. */
    assignNew(input) {
      const empty = this.forDevices.filter((fixture) => {
        const value = fixture.device.value('source');
        return value === null || value === undefined;
      });
      this.assign(empty, input.id);
    },
    async addFile() {
      const result = await VideoFeed.addFile();
      if (!result || !result.ok) {
        if (result && result.reason && result.reason !== 'cancelled') this.previewStatus = result.reason;
        return;
      }
      await this.loadLists();
      const input = this.$show.addVideoInput({ kind: INPUT_KINDS.FILE, file: result.entry.key });
      this.selectedId = input.id;
      this.assignNew(input);
    },
    remove() {
      if (!this.selected || this.selected.builtIn) return;
      const at = this.listed.indexOf(this.selected);
      this.$show.removeVideoInput(this.selected.id);
      const next = this.listed[Math.min(at, this.listed.length - 1)];
      this.selectedId = next ? next.id : null;
    },
    rename(value) {
      if (!this.selected) return;
      const name = String(value || '').trim();
      this.selected.name = name || this.selected.defaultName();
      this.$show.videoInputChanged();
    },
    pickSender(index) {
      const input = this.selected;
      if (!input) return;
      const sender = index > 0 ? (this.senders[index - 1] || {}).name || '' : '';
      // A numbered default takes the sender's name; a name someone chose stays.
      if (sender && input.name === input.defaultName()) {
        input.name = sender;
        this.$show.videoInputChanged();
      }
      VideoRouter.bind(input.uid, sender);
      this.tick += 1;
      this.openPreview();
    },
    pickFile(index) {
      const input = this.selected;
      const file = this.files[index];
      if (!input || !file) return;
      const wasDefault = input.name === input.defaultName();
      input.file = file.key;
      if (wasDefault) input.name = input.defaultName();
      this.$show.videoInputChanged();
      this.openPreview();
    },

    /**
     * Opens the selected input's feed for the preview: a claim of this
     * window's own, which shares the receiver with the scene when both hold
     * the same one.
     */
    async openPreview() {
      this.closePreview();
      const input = this.selected;
      if (!input) return;
      const name = input.feedName(VideoRouter.binding(input.uid));
      if (!name) {
        this.previewStatus = '';
        return;
      }
      const token = {};
      this.previewToken = token;
      const feed = await VideoFeed.open(name);
      if (this.previewToken !== token) {
        if (feed) feed.close();
        return;
      }
      this.previewFeed = feed;
      this.previewStatus = feed ? 'Opening…' : 'Could not open this input.';
      this.mountPreview();
    },
    closePreview() {
      this.previewToken = null;
      if (this.previewFeed) { this.previewFeed.close(); this.previewFeed = null; }
      if (this.texture) { this.texture.dispose(); this.texture = null; }
      this.textureSource = null;
      this.lastFrame = -1;
      this.hasPicture = false;
      this.rate = 0;
      this.rateFrom = null;
    },

    /**
     * Frames the preview's feed delivers a second, measured over about a
     * second: what the sender or the file is really doing, not what it says.
     */
    togglePlay() {
      const feed = this.previewFeed;
      if (!feed) return;
      if (feed.playing) feed.pause();
      else feed.play();
      this.tick += 1;
    },
    seekTo(seconds) {
      if (this.previewFeed) this.previewFeed.seek(seconds);
      this.tick += 1;
    },
    /**
     * Seconds as m:ss.t.
     *
     * @param {Number} seconds
     * @returns {String}
     */
    clock(seconds) {
      const tenths = Math.floor((Number(seconds) || 0) * 10);
      const minutes = Math.floor(tenths / 600);
      const rest = ((tenths % 600) / 10).toFixed(1).padStart(4, '0');
      return `${minutes}:${rest}`;
    },

    measureRate() {
      const feed = this.previewFeed;
      if (!feed) return;
      const now = performance.now();
      if (!this.rateFrom) {
        this.rateFrom = { at: now, frames: feed.frameCount };
        return;
      }
      const elapsed = now - this.rateFrom.at;
      if (elapsed < 1000) return;
      this.rate = ((feed.frameCount - this.rateFrom.frames) * 1000) / elapsed;
      this.rateFrom = { at: now, frames: feed.frameCount };
    },

    mountPreview() {
      const { canvas } = this.$refs;
      if (!canvas) return;
      // The detail pane is rebuilt when the selection empties and fills
      // again, so a renderer may be holding a canvas that is gone.
      if (this.renderer && this.renderer.domElement === canvas) return;
      if (this.renderer) {
        if (this.quad) {
          if (this.quad.material) this.quad.material.dispose();
          this.quad.geometry.dispose();
        }
        this.renderer.dispose();
      }
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.scene = new THREE.Scene();
      this.camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
      this.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
      this.scene.add(this.quad);
    },

    /**
     * Sampling for a picture shown smaller than it is: mipmaps average the
     * pixels a screen pixel covers, so a fine grid stays a grid. Packed UYVY
     * bytes are not a colour and keep nearest.
     *
     * @param {Object} texture THREE.Texture
     */
    /**
     * What the preview is showing, in a line: live or still, the size, and
     * the frame rate once one has been measured.
     *
     * @param {Object} feed
     * @returns {String}
     */
    describeFeed(feed) {
      const size = `${feed.width} × ${feed.height}`;
      if (feed.kind === 'image') return `Still image · ${size}`;
      if (feed.kind === 'video' && !feed.playing) return `Paused · ${size}`;
      const fps = this.rate >= 0.5 ? ` · ${Math.round(this.rate)} fps` : '';
      return `● Live · ${size}${fps}`;
    },

    smoothShrink(texture) {
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      if (this.renderer) texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    },

    drawPreview() {
      const feed = this.previewFeed;
      if (!feed || !this.renderer || !this.quad) return;
      const { pixels, element } = feed;
      if (!pixels && !element) return;
      const fresh = feed.frameCount !== this.lastFrame;
      if (!fresh) return;
      this.lastFrame = feed.frameCount;

      if (element) {
        if (!this.texture || this.textureSource !== element) {
          if (this.texture) this.texture.dispose();
          this.texture = feed.kind === 'video'
            ? new THREE.VideoTexture(element)
            : new THREE.Texture(element);
          this.texture.colorSpace = THREE.SRGBColorSpace;
          this.smoothShrink(this.texture);
          this.texture.flipY = true;
          this.textureSource = element;
          if (this.quad.material) this.quad.material.dispose();
          this.quad.material = createVideoMaterial(feed, this.texture);
        }
      } else if (!this.texture
        || this.textureSource
        || this.texture.image.width !== feed.texels
        || this.texture.image.height !== feed.height) {
        this.textureSource = null;
        if (this.texture) this.texture.dispose();
        const { RGBAFormat, UnsignedByteType } = THREE;
        const { texels, height } = feed;
        this.texture = new THREE.DataTexture(pixels, texels, height, RGBAFormat, UnsignedByteType);
        this.texture.colorSpace = feed.format === 'UYVY' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
        if (feed.format === 'UYVY') {
          this.texture.minFilter = THREE.NearestFilter;
          this.texture.magFilter = THREE.NearestFilter;
          this.texture.generateMipmaps = false;
        } else {
          this.smoothShrink(this.texture);
        }
        this.texture.flipY = true;
        if (this.quad.material) this.quad.material.dispose();
        this.quad.material = createVideoMaterial(feed, this.texture);
      } else {
        this.texture.image.data = pixels;
      }
      this.texture.needsUpdate = true;

      const { stage } = this.$refs;
      if (!stage || !stage.clientWidth || !feed.width || !feed.height) return;
      // Fitted inside the stage, keeping the picture's shape.
      const boxW = stage.clientWidth;
      const boxH = stage.clientHeight || Math.round(boxW * 0.5625);
      const scale = Math.min(boxW / feed.width, boxH / feed.height);
      const width = Math.max(1, Math.round(feed.width * scale));
      const height = Math.max(1, Math.round(feed.height * scale));
      this.renderer.setSize(width, height, false);
      const { canvas } = this.$refs;
      if (canvas) {
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      this.renderer.render(this.scene, this.camera);
      this.hasPicture = true;
      this.previewStatus = this.describeFeed(feed);
    },
  },
};
</script>

<style scoped>
/* Plain CSS, like every other component here. Colours come from the palette
   in `global.css`. */
.body {
  padding: 16px;
  width: 980px;
  max-width: 94vw;
  /* Stated here: nothing above the popup sets a text colour, so anything
     that inherits would otherwise come out black on the dark panel. */
  color: var(--secondary-lighter);
}

.intro { max-width: 640px; }

.inputs {
  width: 320px;
  flex: 0 0 320px;
  display: flex;
  flex-direction: column;
  background: var(--primary-dark-alt);
  border: 1px solid var(--primary-dark);
}

.inputs_head {
  padding: 10px 12px 6px;
  font-family: Roboto-Medium, sans-serif;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--secondary-light-alt);
}

.input_row {
  display: grid;
  grid-template-columns: 10px 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
  border: 0;
  border-top: 1px solid var(--primary-dark);
  background: none;
  /* A button: the global rule makes it uppercase at 11px, which suits a
     command and not a list of names. */
  color: var(--secondary-lighter);
  text-transform: none;
  font-family: Roboto-Regular, sans-serif;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.input_row:hover { background: var(--secondary-darker); }
.input_row.selected { background: var(--accent-blue); }
.input_row:focus-visible { outline: 1px solid var(--accent-teal); outline-offset: -1px; }

.input_text { display: flex; flex-direction: column; min-width: 0; }
.input_name { font-family: Roboto-Medium, sans-serif; color: var(--secondary-lighter); }
.input_sub {
  font-size: 11px;
  color: var(--secondary-light-alt);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.input_row.selected .input_sub { color: var(--secondary-lighter); }
.input_count { font-size: 11px; color: var(--secondary-light-alt); }

.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary-lighter); }
.dot.live { background: var(--accent-sea-green); }
.dot.waiting { background: var(--accent-gold); }
.dot.unbound, .dot.missing { background: var(--accent-orange); }

.inputs_add {
  margin-top: auto;
  padding: 10px 12px;
  border-top: 1px solid var(--primary-dark);
  flex-wrap: wrap;
}

.detail { flex: 1; min-width: 0; }
.detail_title { margin: 0; color: var(--secondary-lighter); }

.stage {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 320px;
  background: var(--primary-dark);
  border: 1px solid var(--primary-lighter);
  overflow: hidden;
}

.stage_empty { color: var(--secondary-light-alt); padding: 12px; text-align: center; }

.transport { display: flex; align-items: center; gap: 10px; }
.transport_position { flex: 1 1 auto; min-width: 0; accent-color: var(--accent-teal); }
.transport_time {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--secondary-light-alt);
}

.used { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.used_label {
  font-family: Roboto-Medium, sans-serif;
  font-size: 12px;
  color: var(--secondary-lighter);
  margin-right: 6px;
}
.chip {
  background: var(--primary-lighter);
  padding: 2px 9px;
  border-radius: 10px;
  font-size: 11px;
  color: var(--secondary-lighter);
}
</style>
