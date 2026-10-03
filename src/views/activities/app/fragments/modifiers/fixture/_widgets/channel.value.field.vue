<template>
  <div
    class="channel_value"
    :class="{ disabled }"
  >
    <input
      ref="field"
      v-model="content"
      class="channel_value_text"
      :class="{ dragging }"
      :disabled="disabled"
      @pointerdown="startDrag"
      @wheel="onWheel"
      @keydown.up.prevent="stepBy(1, $event)"
      @keydown.down.prevent="stepBy(-1, $event)"
      @keydown.stop
      @keydown.enter="leaveEdit"
      @keydown.esc="closeGuide"
      @blur="commitTyped"
    >
    <!-- On the body so no panel clips it. A press on it never takes the focus
         from the number, so a value half typed survives a pick. -->
    <teleport to="body">
      <div
        v-if="shown"
        ref="guide"
        class="channel_guide"
        :style="box"
        @mousedown.prevent
        @pointerdown="guideDown"
        @wheel="onWheel"
      >
        <div
          ref="cards"
          class="guide_cards"
        >
          <div
            v-for="range in topDown"
            :key="range.lo"
            class="guide_card"
            :class="{ current: range === currentRange }"
            :style="{ borderLeftColor: kindColour(range) }"
            :data-lo="range.lo"
            :data-hi="range.hi"
          >
            <div class="card_head">
              <span class="card_name">{{ range.text }}</span>
              <span class="card_span">{{ spanOf(range) }}</span>
            </div>
            <div
              v-if="range.rail === 'blocks'"
              class="card_blocks"
              :style="{ gridTemplateColumns: `repeat(${columnsOf(range)}, minmax(0, 1fr))` }"
            >
              <div
                v-for="step in range.steps"
                :key="step.lo"
                class="card_block"
                :class="{ current: holds(step), swatch: !!swatchOf(step), gobo: !!step.gobo }"
                :style="blockStyle(step)"
                :data-lo="step.lo"
                :data-hi="step.hi"
                :title="goboTitle(step)"
              >
                <img
                  v-if="step.gobo"
                  class="block_gobo"
                  :class="{ stand_in: !step.gobo.named }"
                  :src="step.gobo.url"
                  alt=""
                  draggable="false"
                >
                <span>{{ step.label || step.text }}</span>
                <small>{{ step.lo }}</small>
              </div>
            </div>
            <div
              v-else
              class="card_rail"
              :class="range.rail"
              :style="stripStyle(range)"
              :data-lo="range.lo"
              :data-hi="range.hi"
              data-along
            >
              <svg
                v-if="range.rail === 'ramp'"
                class="card_wedge"
                viewBox="0 0 100 10"
                preserveAspectRatio="none"
              >
                <polygon
                  :points="range.ramp === 'up' ? '0,10 100,0 100,10' : '0,0 100,10 0,10'"
                  :style="{ fill: kindColour(range) }"
                />
              </svg>
              <div
                v-if="range === currentRange"
                class="card_marker"
                :style="{ left: `${markerPercent(range)}%` }"
              />
            </div>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<script>
/**
 * @component A DMX channel's value, with its ranges shown beside it while the
 * value is being worked.
 *
 * The guide is a column of the channel's ranges, highest at the top, each a
 * card with its name and span and a rail that says what the range does: a row
 * of blocks for slots -- a colour wheel's blocks filled with their colours --
 * a wedge for a quantity that runs one way, a plain strip for the rest. The
 * range the value is in is lit, and so is its slot or its place on the rail.
 *
 * A drag or a scroll on the number shows the guide while the value moves. A
 * click on the number keeps it up to be used: a block sets its slot, a press
 * on a rail sets the value at that point and slides it while held, and a drag
 * carries on across the cards. Letting go of that press closes it, and so
 * does a press anywhere else -- another number included -- or Escape. One
 * guide is open at a time.
 *
 * Drag, the wheel and the arrow keys travel through the ranges rather than
 * through raw numbers: every range and every slot gets a share of the travel
 * in proportion to its width, and never less than a minimum, so a two-value
 * "stop" can be landed on.
 *
 * A trackpad's scroll moves by its pixels, so a flick carries on with the
 * trackpad's own momentum. A mouse wheel's notch is one value, speeding up
 * while the wheel keeps turning, as in every other number field.
 */
import Preferences from '@/plugins/visualizer/preferences';
import {
  RANGE_KINDS, stackRanges, valueToOffset, offsetToValue,
} from '@/models/DMX/channel_ranges';

/** Travel for one value of a wide range, in pixels of drag or scroll. */
const TRAVEL_PX_PER_VALUE = 3;

/** The least travel any range or slot is given, in pixels. */
const TRAVEL_MIN_PX = 24;

/** A channel with no ranges travels as one. */
const WHOLE_BYTE = [{ lo: 0, hi: 255 }];

/** The most blocks in one row before a range's slots wrap. */
const BLOCKS_PER_ROW = 8;

/** Guide width, and its gap from the field and the screen edge, in pixels. */
const GUIDE_WIDTH = 260;
const GUIDE_GAP = 10;

/** How long the guide stays after the value last moved, in ms. */
const LINGER_MS = 700;

/** What Shift multiplies a step or a drag by; Alt divides a drag by it. */
const COARSE_SCALE = 10;

/** Wheel notches: one spin's longest gap, its grace, and its fastest. */
const WHEEL_RUN_GAP_MS = 180;
const WHEEL_RUN_GRACE = 2;
const MAX_WHEEL_RUN = 10;

/** A mouse notch reports its legacy delta in multiples of this. */
const WHEEL_NOTCH = 120;

/** The largest pointer movement treated as a hand's rather than a warp's. */
const MAX_PLAUSIBLE_MOVE = 250;

/** What the field shows while its fixtures disagree. */
const MIXED_TEXT = '*';

const clampByte = (v) => Math.min(Math.max(Math.round(Number(v) || 0), 0), 255);

/** The field whose guide is up, so opening another closes it. */
let openField = null;

/**
 * Whether a colour is light enough to want dark text on it.
 *
 * @param {String} colour a hex colour
 * @returns {Boolean}
 */
function isLight(colour) {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour || '');
  if (!hex) return false;
  const n = parseInt(hex[1], 16);
  // eslint-disable-next-line no-bitwise
  const luma = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luma > 150;
}

export default {
  name: 'ChannelValueField',
  compatConfig: { MODE: 3 },
  props: {
    /** The byte, 0..255. */
    modelValue: {
      type: Number,
      default: 0,
    },
    /** The selected fixtures disagree about this byte. */
    mixed: Boolean,
    disabled: Boolean,
    /**
     * The channel's ranges, bottom to top, from `channelRanges`. Null for a
     * channel with none, which travels as one plain range and shows nothing.
     */
    ranges: {
      type: Array,
      default: null,
    },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      content: this.mixed ? MIXED_TEXT : String(clampByte(this.modelValue)),
      value: clampByte(this.modelValue),
      dragging: false,
      typing: false,
      shown: false,
      /** Up until a press elsewhere, rather than until the value settles. */
      pinned: false,
      box: {},
    };
  },
  computed: {
    /**
     * The stack the hand travels through: every slot a stop of its own, so a
     * colour is as easy to land on as a range.
     */
    travel() {
      const stops = (this.ranges || WHOLE_BYTE)
        .flatMap((range) => (range.steps && range.steps.length ? range.steps : [range]));
      return stackRanges(stops, { pxPerValue: TRAVEL_PX_PER_VALUE, minPx: TRAVEL_MIN_PX });
    },
    /** The ranges as the guide lists them, highest first. */
    topDown() {
      return this.ranges ? [...this.ranges].reverse() : [];
    },
    /** What the guide points at: the byte, or what is being typed. */
    shownValue() {
      if (this.typing) {
        const typed = parseInt(this.content, 10);
        if (!Number.isNaN(typed)) return clampByte(typed);
      }
      return this.value;
    },
    currentRange() {
      if (!this.ranges) return null;
      const v = this.shownValue;
      return this.ranges.find((range) => v >= range.lo && v <= range.hi) || null;
    },
  },
  watch: {
    modelValue(value) {
      this.value = clampByte(value);
      if (!this.mixed && !this.typing) this.content = String(this.value);
    },
    mixed(state) {
      if (state) this.content = MIXED_TEXT;
      else this.content = String(this.value);
    },
    currentRange() {
      if (this.shown) this.$nextTick(this.revealCurrent);
    },
  },
  created() {
    this.drag = null;
    this.wheelRun = { notches: 0, at: 0, direction: 0 };
    this.wheelOffset = null;
    this.lingerTimer = null;
  },
  beforeUnmount() {
    this.dragEnd();
    this.guideUp();
    this.closeGuide();
  },
  methods: {
    /**
     * Writes a byte, if it is a new one.
     *
     * @param {Number} value
     */
    write(value) {
      const byte = clampByte(value);
      if (byte === this.value && !this.mixed) return;
      this.value = byte;
      this.content = String(byte);
      this.$emit('update:modelValue', byte);
    },
    /** The byte a gesture starts from, the first fixture's while mixed. */
    base() {
      return clampByte(this.mixed ? this.modelValue : this.value);
    },
    /**
     * Puts the guide up and keeps it there until `release`: for a press, a
     * drag, or a value being typed.
     */
    hold() {
      if (!this.ranges || !this.ranges.length || !Preferences.get('channelRangeGuide')) return;
      clearTimeout(this.lingerTimer);
      if (this.shown) return;
      if (openField && openField !== this) openField.closeGuide();
      openField = this;
      // Built now and gone again on close. Placed on the tick it is built,
      // measured at its real height, before the browser paints a frame of it.
      this.shown = true;
      this.$nextTick(() => {
        this.place();
        this.revealCurrent();
      });
      this.onOutside = this.outsidePress.bind(this);
      window.addEventListener('pointerdown', this.onOutside, true);
    },
    /** Lets the guide go a moment from now, unless it is pinned up. */
    release() {
      if (this.pinned) return;
      clearTimeout(this.lingerTimer);
      this.lingerTimer = setTimeout(this.closeGuide, LINGER_MS);
    },
    /** Shows the guide for a step of the wheel or the keys, then lets it go. */
    nudged() {
      this.hold();
      if (!this.dragging && !this.typing) this.release();
    },
    /** Takes the guide down now. */
    closeGuide() {
      clearTimeout(this.lingerTimer);
      this.shown = false;
      this.pinned = false;
      if (this.onOutside) window.removeEventListener('pointerdown', this.onOutside, true);
      this.onOutside = null;
      if (openField === this) openField = null;
    },
    /**
     * A press anywhere but this number and its guide closes the guide at
     * once. Heard before anything else gets the press, so a press on another
     * number closes this guide before that one opens its own.
     *
     * @param {PointerEvent} event
     */
    outsidePress(event) {
      const { guide } = this.$refs;
      if (this.$el.contains(event.target) || (guide && guide.contains(event.target))) return;
      this.closeGuide();
    },
    /**
     * A press on the guide: picks what is under it and follows the pointer
     * until release, which closes the guide. Pinned meanwhile, so a guide
     * shown by a drag on the number does not fade under the hand.
     *
     * @param {PointerEvent} event
     */
    guideDown(event) {
      if (this.disabled || event.button !== 0 || !this.shown) return;
      event.preventDefault();
      this.pinned = true;
      clearTimeout(this.lingerTimer);
      this.guideUp();
      this.picking = { rail: null };
      this.pickAt(event.clientX, event.clientY, true);
      this.onPickMove = (e) => this.pickAt(e.clientX, e.clientY, false);
      // The pick is made: letting go is done with the guide and the field.
      this.onPickUp = () => {
        this.guideUp();
        this.leaveEdit();
        this.closeGuide();
      };
      window.addEventListener('pointermove', this.onPickMove);
      window.addEventListener('pointerup', this.onPickUp);
      window.addEventListener('pointercancel', this.onPickUp);
    },
    /** Ends a press on the guide. */
    guideUp() {
      if (this.onPickMove) window.removeEventListener('pointermove', this.onPickMove);
      if (this.onPickUp) {
        window.removeEventListener('pointerup', this.onPickUp);
        window.removeEventListener('pointercancel', this.onPickUp);
      }
      this.onPickMove = null;
      this.onPickUp = null;
      this.picking = null;
    },
    /**
     * Sets the value from what is under a point of the guide: the place along
     * a rail, or the middle of a slot or a range. Off the guide's targets, a
     * rail already pressed keeps answering, clamped to its ends, so a slide
     * can run past them. A card's own middle answers only the first press: a
     * slide across a row of blocks passes over the card between them.
     *
     * @param {Number} x client pixels
     * @param {Number} y client pixels
     * @param {Boolean} first whether this is the press rather than a move
     */
    pickAt(x, y, first) {
      const { guide } = this.$refs;
      if (!guide || !this.picking) return;
      const hit = document.elementFromPoint(x, y);
      let target = hit && guide.contains(hit) ? hit.closest('[data-lo]') : null;
      if (target && !first && target.classList.contains('guide_card')) target = null;
      if (target && target.hasAttribute('data-along')) this.picking.rail = target;
      if (!target) target = this.picking.rail;
      if (!target) return;
      const lo = Number(target.dataset.lo);
      const hi = Number(target.dataset.hi);
      if (target.hasAttribute('data-along')) {
        const rect = target.getBoundingClientRect();
        const along = Math.min(Math.max((x - rect.left) / rect.width, 0), 1);
        this.write(Math.min(lo + Math.floor(along * (hi - lo + 1)), hi));
      } else {
        this.write(Math.round((lo + hi) / 2));
      }
    },
    /**
     * Puts the guide beside the field: to its left, where the panel is not,
     * or to its right when the screen has no room there. Placed once per
     * showing, so it holds still while the value moves.
     */
    place() {
      const { field, guide } = this.$refs;
      if (!field) return;
      const rect = field.getBoundingClientRect();
      const height = guide ? guide.offsetHeight : 200;
      let left = rect.left - GUIDE_WIDTH - GUIDE_GAP;
      if (left < GUIDE_GAP) left = rect.right + GUIDE_GAP;
      const top = Math.min(
        Math.max(rect.top + rect.height / 2 - height / 2, GUIDE_GAP),
        Math.max(window.innerHeight - height - GUIDE_GAP, GUIDE_GAP),
      );
      // Whole pixels: text placed between two is drawn across both, softly.
      this.box = {
        left: `${Math.round(left)}px`,
        top: `${Math.round(top)}px`,
        width: `${GUIDE_WIDTH}px`,
      };
    },
    /**
     * Keeps the current range in view when the channel has more ranges than
     * the screen has room for.
     */
    revealCurrent() {
      const { cards } = this.$refs;
      if (!cards || cards.scrollHeight <= cards.clientHeight) return;
      const current = cards.querySelector('.guide_card.current');
      if (!current) return;
      const target = current.offsetTop - cards.clientHeight / 2 + current.offsetHeight / 2;
      cards.scrollTop = Math.max(0, target);
    },
    kindColour(range) {
      return RANGE_KINDS[range.kind] || RANGE_KINDS.other;
    },
    spanOf(range) {
      return range.lo === range.hi ? `${range.lo}` : `${range.lo}–${range.hi}`;
    },
    /** Whether the value is on this slot. */
    holds(step) {
      return this.shownValue >= step.lo && this.shownValue <= step.hi;
    },
    /** Columns for a range's blocks: one row, or as many as it takes of eight. */
    columnsOf(range) {
      const count = range.steps.length;
      const rows = Math.ceil(count / BLOCKS_PER_ROW);
      return Math.ceil(count / rows);
    },
    /**
     * A slot's fill: the profile's colour, a split's two colours cut corner
     * to corner -- the lower slot above the diagonal, the upper below -- or
     * the slot's name when it is one the browser knows ("red", "magenta").
     *
     * @param {Object} step
     * @returns {String|null} a CSS background
     */
    swatchOf(step) {
      if (step.split) {
        const [lower, upper] = step.split;
        return `linear-gradient(to bottom right, ${lower} calc(50% - 0.5px), ${upper} calc(50% + 0.5px))`;
      }
      if (step.colour) return step.colour;
      const name = String(step.text || '').trim();
      if (/^[a-z]+$/i.test(name) && window.CSS && CSS.supports('color', name)) return name;
      return null;
    },
    /**
     * Text that reads on a fill: dark on light colours; light with a shadow
     * on a split whose halves disagree.
     *
     * @param {Object} step
     * @returns {Object} style
     */
    blockStyle(step) {
      const swatch = this.swatchOf(step);
      if (!swatch) return {};
      if (step.split) {
        const light = step.split.every(isLight);
        return {
          background: swatch,
          color: light ? '#111' : '#fff',
          // Tight, so the label stays crisp and still reads on either half.
          textShadow: light ? 'none' : '0 0 1px #000, 0 0 1px #000',
        };
      }
      return { background: swatch, color: isLight(swatch) ? '#111' : '#fff' };
    },
    /**
     * What a gobo block's image is: the profile's own pattern, or one Beam
     * stood in because the profile names none. The beam draws the same.
     *
     * @param {Object} step
     * @returns {String|null}
     */
    goboTitle(step) {
      if (!step.gobo) return null;
      return step.gobo.named
        ? step.gobo.title
        : `${step.gobo.title} (stand-in: the profile does not say which gobo this is)`;
    },
    /** A strip for a range that is one colour, or one split, wears it. */
    stripStyle(range) {
      if (range.rail !== 'strip') return {};
      const swatch = this.swatchOf({ colour: range.colour, split: range.split });
      return swatch ? { background: swatch } : {};
    },
    /** Where the value sits along a rail, 0..100. */
    markerPercent(range) {
      const width = range.hi - range.lo + 1;
      return ((this.shownValue - range.lo + 0.5) / width) * 100;
    },
    /**
     * The wheel: a mouse notch is one value, a trackpad's scroll travels the
     * stack by its pixels.
     *
     * Told apart by the legacy delta, which a notch reports in whole multiples
     * of 120 and a trackpad in whatever its fingers moved.
     *
     * @param {WheelEvent} event
     */
    onWheel(event) {
      if (this.disabled) return;
      event.preventDefault();
      if (!event.deltaY) return;
      const legacy = event.wheelDeltaY;
      const notch = event.deltaMode !== 0 || (legacy && legacy % WHEEL_NOTCH === 0);
      if (notch) {
        this.wheelOffset = null;
        const direction = event.deltaY < 0 ? 1 : -1;
        const scale = (event.shiftKey ? COARSE_SCALE : 1) * this.wheelRunScale(direction);
        this.write(this.base() + direction * scale);
      } else {
        // Carried between events so a slow scroll accumulates pixels rather
        // than rounding each one away; re-read when the value moved otherwise.
        const { travel } = this;
        if (this.wheelOffset === null || offsetToValue(travel, this.wheelOffset) !== this.base()) {
          this.wheelOffset = valueToOffset(travel, this.base());
        }
        this.wheelOffset = Math.min(Math.max(this.wheelOffset - event.deltaY, 0), travel.total);
        this.write(offsetToValue(travel, this.wheelOffset));
      }
      this.nudged();
    },
    /**
     * How much a sustained spin of a mouse wheel multiplies one notch by.
     *
     * @param {Number} direction 1 or -1
     * @returns {Number}
     */
    wheelRunScale(direction) {
      const now = Date.now();
      const run = this.wheelRun;
      const continues = direction === run.direction && now - run.at < WHEEL_RUN_GAP_MS;
      run.notches = continues ? run.notches + 1 : 1;
      run.direction = direction;
      run.at = now;
      return Math.min(Math.max(1, run.notches - WHEEL_RUN_GRACE), MAX_WHEEL_RUN);
    },
    /**
     * Arrow keys: one value, ten with Shift.
     *
     * @param {Number} direction
     * @param {KeyboardEvent} event
     */
    stepBy(direction, event) {
      if (this.disabled) return;
      this.write(this.base() + direction * (event.shiftKey ? COARSE_SCALE : 1));
      this.nudged();
    },
    /**
     * The press: the guide goes up at once, and a drag may follow. A press
     * that does not move is a click, which leaves the caret in the field to
     * type a value, and the guide stays while it is typed.
     *
     * @param {PointerEvent} event
     */
    startDrag(event) {
      if (this.disabled || event.button !== 0) return;
      this.releaseListeners();
      this.drag = {
        offset: valueToOffset(this.travel, this.base()),
        distance: 0,
        started: false,
      };
      this.onDragMove = this.dragMove.bind(this);
      this.onDragEnd = this.dragEnd.bind(this);
      window.addEventListener('pointermove', this.onDragMove);
      window.addEventListener('pointerup', this.onDragEnd);
      window.addEventListener('pointercancel', this.onDragEnd);
      window.addEventListener('blur', this.onDragEnd);
      this.hold();
    },
    releaseListeners() {
      if (this.onDragMove) window.removeEventListener('pointermove', this.onDragMove);
      if (this.onDragEnd) {
        window.removeEventListener('pointerup', this.onDragEnd);
        window.removeEventListener('pointercancel', this.onDragEnd);
        window.removeEventListener('blur', this.onDragEnd);
      }
      this.onDragMove = null;
      this.onDragEnd = null;
    },
    /**
     * Pointer movement through the stack. Right and up both raise the value.
     * Clamped at the ends, so turning back answers at once.
     *
     * @param {PointerEvent} event
     */
    dragMove(event) {
      if (!this.drag) return;
      if (Math.abs(event.movementX) > MAX_PLAUSIBLE_MOVE
        || Math.abs(event.movementY) > MAX_PLAUSIBLE_MOVE) return;
      const moved = event.movementX - event.movementY;
      this.drag.distance += moved;
      if (!this.drag.started) {
        if (Math.abs(this.drag.distance) < 2) return;
        this.drag.started = true;
        this.dragging = true;
        this.typing = false;
        const { field } = this.$refs;
        if (field) {
          field.blur();
          if (field.requestPointerLock) {
            const locking = field.requestPointerLock();
            if (locking && locking.catch) locking.catch(() => {});
          }
        }
      }
      let scale = 1;
      if (event.shiftKey) scale = COARSE_SCALE;
      else if (event.altKey) scale = 1 / COARSE_SCALE;
      this.drag.offset = Math.min(Math.max(this.drag.offset + moved * scale, 0), this.travel.total);
      this.write(offsetToValue(this.travel, this.drag.offset));
    },
    dragEnd(event) {
      const { drag } = this;
      this.releaseListeners();
      this.drag = null;
      if (!drag) return;
      if (drag.started) {
        this.dragging = false;
        if (document.pointerLockElement) document.exitPointerLock();
        this.release();
      } else if (event && event.type === 'pointerup' && this.$refs.field) {
        // A click: the value is there to be typed, and the guide stays up to
        // be used until something else is pressed.
        this.typing = true;
        this.pinned = true;
        this.$refs.field.select();
      } else {
        this.release();
      }
    },
    /** Enter: leaving the field is what commits it. */
    leaveEdit() {
      if (this.$refs.field) this.$refs.field.blur();
    },
    /** A typed value, or nothing when "*" or nothing was left in the field. */
    commitTyped() {
      const wasTyping = this.typing;
      this.typing = false;
      // Leaving the field -- Enter, Tab, a press elsewhere -- is done with it.
      // A drag on the number blurs it too, and is not.
      if (!this.dragging && (wasTyping || this.pinned)) this.closeGuide();
      const text = String(this.content).trim();
      if (this.mixed && (text === MIXED_TEXT || text === '')) {
        this.content = MIXED_TEXT;
        return;
      }
      const parsed = parseInt(text, 10);
      if (Number.isNaN(parsed)) {
        this.content = String(this.value);
        return;
      }
      this.write(parsed);
      this.content = String(this.value);
    },
  },
};
</script>

<style scoped>
.channel_value {
  display: flex;
  width: 62px;
  height: 25px;
  border: 1px solid transparent;
}
.channel_value:hover:not(:focus-within) {
  background: var(--primary-dark-alt);
}
.channel_value:focus-within {
  border-color: var(--secondary-dark);
}
.channel_value_text {
  font-family: Roboto-Regular;
  border: none;
  background: transparent;
  color: var(--accent-teal);
  font-size: 12px;
  width: 100%;
  padding: 0;
  text-align: center;
  cursor: ns-resize;
}
.channel_value_text:focus {
  cursor: text;
  outline: none;
  background: var(--primary-dark);
}
.channel_value_text.dragging {
  cursor: ns-resize;
}
.disabled .channel_value_text {
  color: var(--secondary-light);
  cursor: default;
}
</style>

<style>
/* Unscoped: the guide is teleported to the body. */
.channel_guide {
  position: fixed;
  z-index: 10000;
  padding: 6px;
  /* A plain opaque rectangle: no rounded corners and no shadow. Over the
     scene the guide is a compositing layer of its own, and Chromium only
     draws ClearType text on a layer it knows to be opaque edge to edge;
     either corners or a shadow leave it greyscale and soft beside the
     panel's text. The border stands in for the shadow. */
  border: 1px solid var(--secondary-light);
  background: var(--primary-dark-alt);
  user-select: none;
  /* No fade in, for the same reason as the square frame: while its opacity
     is below one the layer is not opaque, and its text goes greyscale. */
}
.channel_guide [data-lo] {
  cursor: pointer;
}
.channel_guide .card_rail[data-along] {
  cursor: ew-resize;
}
.channel_guide .guide_card:not(.current):hover {
  border-top-color: var(--secondary-light);
  border-right-color: var(--secondary-light);
  border-bottom-color: var(--secondary-light);
}
/* An outline rather than a filter: a filter redraws the text softly too. */
.channel_guide .card_block:not(.current):hover {
  box-shadow: inset 0 0 0 1px var(--secondary-lighter-alt);
}
.channel_guide .card_rail:hover {
  box-shadow: inset 0 0 0 1px var(--secondary-light);
}
.channel_guide .guide_cards {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: calc(100vh - 34px);
  overflow: hidden;
}
.channel_guide .guide_card {
  flex: none;
  padding: 5px 7px 6px;
  border: 1px solid var(--secondary-darker);
  border-left: 3px solid;
  border-radius: 5px;
  background: var(--primary-light);
}
.channel_guide .guide_card.current {
  border-top-color: var(--accent-teal);
  border-right-color: var(--accent-teal);
  border-bottom-color: var(--accent-teal);
  box-shadow: 0 0 12px color-mix(in srgb, var(--accent-teal) 20%, transparent);
}
.channel_guide .card_head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 11px;
  line-height: 13px;
}
/* Each Roboto weight is a family of its own here; a font-weight on
   Roboto-Regular is a bold the browser fakes by smearing, and it blurs. */
.channel_guide .card_name {
  color: var(--secondary-lighter);
  font-family: Roboto-Medium, sans-serif;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.channel_guide .guide_card.current .card_name {
  color: #fff;
}
.channel_guide .card_span {
  flex: none;
  color: var(--secondary-light-alt);
  font-family: Roboto-Regular;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.channel_guide .card_blocks {
  display: grid;
  gap: 4px 1px;
}
.channel_guide .card_block {
  min-width: 0;
  height: 27px;
  padding: 1px 2px;
  border-radius: 2px;
  background: var(--primary-lighter-alt);
  color: var(--secondary-light-alt);
  text-align: center;
  overflow: hidden;
  box-sizing: border-box;
}
.channel_guide .card_block span {
  display: block;
  font-size: 9px;
  line-height: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.channel_guide .card_block small {
  display: block;
  font-size: 8px;
  line-height: 10px;
  color: color-mix(in srgb, currentColor 70%, transparent);
  font-variant-numeric: tabular-nums;
}
/* A gobo block shows its pattern as the beam draws it: over white, the image
   is black metal and white light. */
.channel_guide .card_block.gobo {
  height: auto;
  padding-top: 3px;
}
.channel_guide .block_gobo {
  display: block;
  width: 22px;
  height: 22px;
  margin: 0 auto 1px;
  border-radius: 50%;
  background: #fff;
  object-fit: contain;
}
/* A pattern Beam chose because the profile names none: ringed with a dash,
   so it is not taken for the fixture's own. */
.channel_guide .block_gobo.stand_in {
  outline: 1px dashed var(--secondary-lighter-alt);
  outline-offset: 1px;
}
.channel_guide .card_block.current {
  background: color-mix(in srgb, var(--accent-teal) 40%, var(--primary-dark));
  color: var(--secondary-lighter);
  box-shadow: inset 0 0 0 1px var(--accent-teal);
}
.channel_guide .card_block.swatch.current {
  box-shadow: inset 0 0 0 2px #fff, 0 0 8px rgba(255, 255, 255, 0.5);
}
.channel_guide .card_rail {
  position: relative;
  height: 12px;
  border-radius: 3px;
  background: var(--primary-lighter-alt);
}
.channel_guide .card_rail.ramp {
  background: transparent;
}
/* A plain range has nothing to show along its rail but the marker; tall
   enough to press. */
.channel_guide .card_rail.strip {
  height: 8px;
}
.channel_guide .card_wedge {
  display: block;
  width: 100%;
  height: 100%;
  opacity: 0.85;
}
.channel_guide .card_marker {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  margin-left: -1px;
  background: var(--secondary-lighter);
  box-shadow: 0 0 6px var(--accent-teal);
}
</style>
