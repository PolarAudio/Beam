/**
 * @file A channel's DMX ranges as a map: what kind of thing each range does,
 * how it is drawn, and how far apart the ranges sit when dragged through.
 *
 * The kind is guessed from the range's name -- the words the fixture guide
 * writes, "gobo 1–7", "spin slow→fast CW", "strobe 1→20Hz" -- because that is
 * what the user reads, and a colour that disagreed with the words would be the
 * one they stopped trusting. The OFL capability type is the fallback for a name
 * that gives nothing away. A source that knows a range's kind or ramp outright
 * -- a GDTF channel function names its attribute and its physical from/to --
 * passes them in with the range, and nothing is guessed for it.
 *
 * The drag's stack gives every range, and every slot, travel in proportion to
 * its share of the byte, but never less than a minimum. A two-value "stop" is
 * otherwise a hair's breadth of a drag; with a floor it is a place you can
 * land on.
 */

/** Every kind, with the colour its card is edged in. */
export const RANGE_KINDS = {
  closed: '#5b5e64',
  open: '#a4a9ae',
  stop: 'var(--accent-red)',
  strobe: '#ecebe4',
  intensity: 'var(--accent-gold)',
  colour: 'var(--accent-pink)',
  slot: 'var(--accent-purple)',
  shake: 'var(--accent-orange)',
  cw: 'var(--accent-green)',
  ccw: 'var(--accent-teal)',
  spin: 'var(--accent-light-blue)',
  angle: 'var(--accent-blue)',
  speed: 'var(--accent-sea-green)',
  prism: 'var(--accent-violet)',
  optic: 'var(--accent-light-green)',
  macro: 'var(--accent-maroon)',
  maintenance: '#8c6f5c',
  other: '#767980',
};

/** What a capability type says when its name says nothing. */
const KIND_OF_TYPE = {
  NoFunction: 'closed',
  Intensity: 'intensity',
  ColorIntensity: 'intensity',
  ColorPreset: 'colour',
  ColorTemperature: 'colour',
  ShutterStrobe: 'strobe',
  StrobeSpeed: 'strobe',
  StrobeDuration: 'strobe',
  Pan: 'angle',
  Tilt: 'angle',
  PanContinuous: 'spin',
  TiltContinuous: 'spin',
  PanTiltSpeed: 'speed',
  Speed: 'speed',
  Time: 'speed',
  WheelSlot: 'slot',
  WheelShake: 'shake',
  WheelSlotRotation: 'spin',
  WheelRotation: 'spin',
  Prism: 'prism',
  PrismRotation: 'spin',
  Iris: 'optic',
  Zoom: 'optic',
  BeamAngle: 'optic',
  Focus: 'optic',
  Frost: 'optic',
  FrostEffect: 'optic',
  Effect: 'macro',
  Maintenance: 'maintenance',
};

/**
 * Words that name the name's kind, most specific first: "prism spin" is a
 * spin, "shake gobo 3" a shake, "strobe off" a strobe.
 */
const KIND_WORDS = [
  ['macro', /\b(macro|effect|program|auto|sound|chase|preset)/],
  ['maintenance', /\b(reset|maintenance|calibrat|lamp (on|off)|fan (mode|speed|auto|full|off|on))\b/],
  ['stop', /\bstop\b/],
  ['shake', /\bshake\b/],
  ['strobe', /\b(strobe|flash|lightning|pulse|ramp|spikes|burst)/],
  ['rotation', /\b(spin|scroll|rotat\w*|rotation)\b/],
  ['speed', /\b(speed|time|move in)\b/],
  ['prism', /\bprism\b/],
  ['optic', /\b(iris|zoom|focus|frost|beam angle|blade)/],
  ['intensity', /\b(dimmer|intensity|brightness)\b|\d\s*→\s*\d+\s*%/],
  ['angle', /\b(hold|index|pan|tilt|angle|position)\b|\bat\s+-?\d|°/],
  ['slot', /\b(gobo|slot|split)\b/],
  ['colour', new RegExp(`\\b(${[
    'colou?r', 'red', 'green', 'blue', 'amber', 'white', 'cyan', 'magenta', 'yellow', 'uv',
    'orange', 'pink', 'lime', 'lavender', 'purple', 'violet', 'indigo', 'teal', 'gold', 'rose',
    'turquoise', 'cto', 'ctb', 'rainbow',
  ].join('|')})\\b|\\d+\\s*k\\b`)],
  ['closed', /^(off|closed|blackout|no function|unused|nothing)\b/],
  ['open', /^open\b/],
];

/** The lesser end of a ramp's words, and the greater. */
const LESS = new Set(['slow', 'low', 'dim', 'narrow', 'near', 'small', 'short', 'min', 'off', 'closed', 'weak', 'soft']);
const MORE = new Set(['fast', 'high', 'bright', 'wide', 'far', 'large', 'long', 'max', 'full', 'open', 'strong', 'hard']);

/**
 * The kind of thing a range does, guessed from its name.
 *
 * @param {String} text the range's name
 * @param {String} [type] its OFL capability type, for when the name is mute
 * @returns {String} a key of {@link RANGE_KINDS}
 */
export function guessKind(text, type) {
  const lower = String(text || '').toLowerCase().trim();
  const found = KIND_WORDS.find(([, pattern]) => pattern.test(lower));
  if (found) {
    if (found[0] !== 'rotation') return found[0];
    // "ccw" before "cw": one is inside the other.
    if (/\b(ccw|counter|anti)/.test(lower)) return 'ccw';
    if (/\b(cw|clockwise)\b/.test(lower)) return 'cw';
    return 'spin';
  }
  return KIND_OF_TYPE[type] || 'other';
}

/**
 * Which way a range's quantity runs as the value rises, from the first
 * "a→b" in its name: 'up' for "slow→fast" or "0→100%", 'down' for
 * "fast→slow", null when the name states no ramp.
 *
 * @param {String} text
 * @returns {String|null}
 */
export function guessRamp(text) {
  const match = /(\S+)\s*→\s*(\S+)/.exec(String(text || '').toLowerCase());
  if (!match) return null;
  const [, a, b] = match;
  const from = parseFloat(a);
  const to = parseFloat(b);
  if (Number.isFinite(from) && Number.isFinite(to) && from !== to) return from < to ? 'up' : 'down';
  if (LESS.has(a)) return 'up';
  if (MORE.has(a)) return 'down';
  return null;
}

/** Kinds whose neighbours are read together, as a row of blocks. */
const GROUPED = { colour: 'colours', slot: 'gobos' };

/** A range's slots, or the range as its own one slot. */
function slotsOf(range) {
  if (range.steps.length) return range.steps;
  return [{
    lo: range.lo,
    hi: range.hi,
    text: range.text,
    colour: range.colour,
    split: range.split,
    gobo: range.gobo,
  }];
}

/** Whether the profile gave a range, or every slot in it, colours. */
function isColoured(range) {
  if (range.colour || range.split) return true;
  const steps = range.steps || [];
  return steps.length > 0 && steps.every((step) => step.colour || step.split);
}

/**
 * A kind the profile has stated rather than one read from a name: a range
 * with colours is a colour, and a wheel slot holding a gobo is a gobo slot,
 * whatever it is called -- a gobo named "Fan" is not a maintenance range.
 *
 * @param {Object} range
 * @returns {String|null}
 */
function statedKind(range) {
  if (isColoured(range)) return 'colour';
  if (range.type === 'WheelShake') return 'shake';
  if (range.type !== 'WheelSlot') return null;
  const steps = range.steps || [];
  if (range.gobo || (steps.length > 0 && steps.every((step) => step.gobo))) return 'slot';
  return null;
}

/**
 * Joins neighbouring slot ranges of one kind. A group of one is left alone;
 * a larger one is named for what it holds when its members have names of
 * their own.
 *
 * @param {Array} ranges bottom to top
 * @returns {Array}
 */
function groupSlots(ranges) {
  const out = [];
  ranges.forEach((range) => {
    const last = out[out.length - 1];
    const joins = GROUPED[range.kind] && !range.ramp
      && last && last.kind === range.kind && !last.ramp;
    if (!joins) {
      out.push({ ...range, members: 1 });
      return;
    }
    last.steps = [...slotsOf(last), ...slotsOf(range)];
    last.hi = range.hi;
    last.members += 1;
    last.text = GROUPED[range.kind];
    last.colour = null;
    last.split = null;
    last.gobo = null;
  });
  return out.map(({ members, ...range }) => range);
}

/**
 * A short label for each slot: the words every slot shares are said once, in
 * the range's name, not on every block. "shake gobo 1 slow→fast" and its
 * neighbours become "gobo 1", "gobo 2"; a slot is never cut to a bare number.
 * A split between two colours is its two slot numbers, "1/2": its two colours
 * say the rest.
 *
 * @param {Array} steps `{ text }`
 * @returns {Array} the steps, each with a `label`
 */
function labelSteps(steps) {
  if (steps.length < 2) return steps;
  if (steps.every((step) => /^split\s/.test(step.text || ''))) {
    return steps.map((step) => ({ ...step, label: step.text.replace(/^split\s+/, '') }));
  }
  let words = steps.map((step) => String(step.text || '').split(/\s+/).filter(Boolean));
  const allShare = (pick) => words.every((w) => w.length > 1 && pick(w) === pick(words[0]));
  while (allShare((w) => w[w.length - 1])) words = words.map((w) => w.slice(0, -1));
  while (allShare((w) => w[0]) && !words.every((w) => w.length === 2 && /^[\d/.]+$/.test(w[1]))) {
    words = words.map((w) => w.slice(1));
  }
  return steps.map((step, i) => ({
    ...step,
    label: step.split ? step.text.replace(/^split\s+/, '') : words[i].join(' ') || step.text,
  }));
}

/**
 * How a range is drawn.
 *
 * @param {Object} range
 * @returns {String} 'blocks', 'ramp' or 'strip'
 */
function railOf(range) {
  if (range.steps.length > 1) return 'blocks';
  if (range.ramp) return 'ramp';
  return 'strip';
}

/**
 * One channel of the fixture guide as a map, 0 to 255 with no gaps.
 *
 * A stretch the profile says nothing about is shown as "unused" rather than
 * left out: a value can land there, and the map has to say what is under it.
 *
 * Neighbouring colour slots, and neighbouring gobo slots, are one range of
 * blocks rather than a range each: a colour wheel is read as a row of
 * swatches, not as twelve lines.
 *
 * Each range says how it is drawn: `blocks` for slots, one block per slot;
 * `ramp` for a quantity that runs one way across the range; `strip` for the
 * rest.
 *
 * @param {Object} guideChannel one entry of `fixtureGuide().channels`, or
 *   anything carrying `ranges` of
 *   `{ lo, hi, text, type?, kind?, ramp?, colour?, steps? }`
 * @returns {Array|null} `{ lo, hi, text, kind, ramp, rail, colour, steps }`
 *   bottom to top, or null for a channel with no ranges of its own (a fine
 *   channel)
 */
export function channelRanges(guideChannel) {
  const source = guideChannel && guideChannel.ranges;
  if (!Array.isArray(source) || !source.length) return null;
  const sorted = source
    .filter((r) => Number.isFinite(r.lo) && Number.isFinite(r.hi))
    .slice()
    .sort((a, b) => a.lo - b.lo);
  const out = [];
  let next = 0;
  const unused = (lo, hi) => ({
    lo, hi, text: 'unused', kind: 'closed', ramp: null, colour: null, split: null, gobo: null, steps: [],
  });
  sorted.forEach((r) => {
    const lo = Math.max(r.lo, next);
    const hi = Math.min(r.hi, 255);
    if (hi < lo) return;
    if (lo > next) out.push(unused(next, lo - 1));
    out.push({
      lo,
      hi,
      text: r.text,
      kind: r.kind || statedKind(r) || guessKind(r.text, r.type),
      ramp: r.ramp !== undefined ? r.ramp : guessRamp(r.text),
      colour: r.colour || null,
      split: r.split || null,
      gobo: r.gobo || null,
      steps: (r.steps || []).filter((step) => step.lo >= lo && step.hi <= hi),
    });
    next = hi + 1;
  });
  if (!out.length) return null;
  if (next <= 255) out.push(unused(next, 255));
  return groupSlots(out).map((range) => ({
    ...range,
    steps: labelSteps(range.steps),
    rail: railOf(range),
  }));
}

/**
 * Stacks ranges bottom to top.
 *
 * @param {Array} ranges `{ lo, hi }` bottom to top, covering 0..255
 * @param {Object} options
 * @param {Number} options.pxPerValue height of one value in a wide range
 * @param {Number} options.minPx the least height any range is given
 * @returns {Object} `{ segs, total }`; each seg gains `width`, `px` and
 *   `bottom`, its distance from the foot of the stack
 */
export function stackRanges(ranges, { pxPerValue, minPx }) {
  let bottom = 0;
  const segs = ranges.map((range) => {
    const width = range.hi - range.lo + 1;
    const px = Math.max(width * pxPerValue, minPx);
    const seg = {
      ...range, width, px, bottom,
    };
    bottom += px;
    return seg;
  });
  return { segs, total: bottom };
}

/**
 * Where a value sits in a stack: the middle of its slice of its range.
 *
 * @param {Object} stack from {@link stackRanges}
 * @param {Number} value 0..255
 * @returns {Number} pixels from the foot
 */
export function valueToOffset(stack, value) {
  const { segs } = stack;
  const v = Math.min(Math.max(Math.round(Number(value) || 0), 0), 255);
  const seg = segs.find((s) => v >= s.lo && v <= s.hi) || segs[segs.length - 1];
  return seg.bottom + ((v - seg.lo + 0.5) / seg.width) * seg.px;
}

/**
 * The value at a place in a stack.
 *
 * @param {Object} stack from {@link stackRanges}
 * @param {Number} offset pixels from the foot
 * @returns {Number} 0..255
 */
export function offsetToValue(stack, offset) {
  const { segs, total } = stack;
  const at = Math.min(Math.max(offset, 0), total);
  const seg = segs.find((s) => at < s.bottom + s.px) || segs[segs.length - 1];
  const within = Math.floor(((at - seg.bottom) / seg.px) * seg.width);
  return Math.min(seg.lo + Math.max(within, 0), seg.hi);
}
