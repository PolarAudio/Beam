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
        The pictures this show receives. A display or projector picks one and
        shows all of it; several can share one. Laying content out across
        outputs is the media server's job.
      </p>

      <uk-flex :gap="16">
        <!-- The show's inputs. -->
        <div class="inputs">
          <div class="inputs_head">
            Inputs in this show
          </div>
          <p
            v-if="!inputs.length"
            class="subtitle inputs_empty"
          >
            No inputs yet. Add an NDI input, a file, or the test card.
          </p>
          <button
            v-for="input in inputs"
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
            <uk-button
              label="Test card"
              :disabled="!filesAvailable"
              @click="addTestCard"
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
              label="Remove"
              @click="remove"
            />
          </uk-flex>
          <uk-txt-input
            :model-value="selected.name"
            label="Name"
            @update:model-value="rename"
          />
          <template v-if="selected.kind === 'ndi'">
            <uk-select-input
              :model-value="senderIndex"
              :options="senderOptions"
              label="Sender"
              :disabled="!ndiAvailable"
              @input="pickSender"
            />
            <p class="subtitle">
              Which sender fills this input is a setting of this machine. The
              show keeps only the input.
            </p>
          </template>
          <template v-else>
            <uk-select-input
              :model-value="fileIndex"
              :options="fileOptions"
              label="File"
              @input="pickFile"
            />
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

/** The shipped test card's file name. */
const TEST_CARD = 'Test card.png';

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
  data() {
    return {
      headerData: { title: 'Video inputs' },
      selectedId: null,
      senders: [],
      files: [],
      hasPicture: false,
      previewStatus: '',
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
      if (!this.selected && this.inputs.length) this.selectedId = this.inputs[0].id;
      this.unlisten = VideoRouter.listen(() => { this.tick += 1; });
      this.timer = setInterval(() => {
        this.tick += 1;
        this.drawPreview();
      }, 1000 / PREVIEW_FPS);
      await this.loadLists();
      this.$nextTick(() => this.openPreview());
    },

    closed() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
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
    },
    addTestCard() {
      const input = this.$show.addVideoInput({ kind: INPUT_KINDS.FILE, file: TEST_CARD, name: 'Test card' });
      this.selectedId = input.id;
    },
    remove() {
      if (!this.selected) return;
      const at = this.inputs.indexOf(this.selected);
      this.$show.removeVideoInput(this.selected.id);
      const next = this.inputs[Math.min(at, this.inputs.length - 1)];
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
      this.previewStatus = `${feed.width} × ${feed.height} ${feed.kind || feed.format}`;
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

.inputs_empty { padding: 8px 12px; }

.input_row {
  display: grid;
  grid-template-columns: 10px 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
  border: 0;
  border-top: 1px solid var(--primary-dark);
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.input_row:hover { background: var(--secondary-darker); }
.input_row.selected { background: var(--accent-blue); }
.input_row:focus-visible { outline: 1px solid var(--accent-teal); outline-offset: -1px; }

.input_text { display: flex; flex-direction: column; min-width: 0; }
.input_name { font-family: Roboto-Medium, sans-serif; }
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
.detail_title { margin: 0; }

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

.used { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.used_label {
  font-family: Roboto-Medium, sans-serif;
  margin-right: 6px;
}
.chip {
  background: var(--primary-lighter);
  padding: 2px 9px;
  border-radius: 10px;
  font-size: 11px;
}
</style>
