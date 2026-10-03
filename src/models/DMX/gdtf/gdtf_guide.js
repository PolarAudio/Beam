/**
 * @file The quick guide for a GDTF fixture, in the shape and the words
 * `fixtureGuide` gives an OFL one, so the panels and the range cards read
 * either alike.
 *
 * Each range is written from what the file states -- the attribute, the wheel
 * slot, the physical from and to -- in the guide's own vocabulary: "gobo 3",
 * "shake gobo 2", "spin fast→slow CW", "strobe 0.5→10Hz". Runs of numbered
 * ranges are then folded by the same `fold` the OFL guide uses, so a gobo
 * wheel is a line and its slots are blocks.
 *
 * Ranges are in the coarse byte, 0 to 255, which is what the cards and the
 * channel table show. A function that applies only while a mode channel is in
 * some range is listed under the mode the fixture starts in; the others are
 * named in the line's text.
 */

import { cieToHex, attributeLabel } from './fixture_parts';
import { fold } from '../fixture_guide';
import { stateAt } from './dmx_engine';
import {
  nameOf, namesClosed, namesOpen, slotKind,
} from './name_rules';

/** Attributes the moving head acts on; anything else is shown but marked. */
const DRAWN = [
  /^Dimmer$/, /^Pan$/, /^Tilt$/, /^Zoom$/, /^Color(Add|Sub)_/, /^CT[CBO]$/, /^Focus\d+$/, /^Iris$/,
  /^Frost\d+$/, /^(Color|Gobo|Prism)\d+/, /^Shutter\d+/, /^NoFeature$/,
];

/** What a shutter strobe attribute is called, and whether it is random. */
const STROBE_WORDS = [
  [/StrobeRandomPulse/, 'pulse', true],
  [/StrobeRandom/, 'strobe', true],
  [/StrobePulseOpen$/, 'ramp up', false],
  [/StrobePulseClose$/, 'ramp down', false],
  [/StrobePulse$/, 'pulse', false],
  [/StrobeEffect$/, 'lightning', false],
  [/Strobe$/, 'strobe', false],
];

/** A physical value as a number and its unit, for its attribute. */
function physical(attribute, value) {
  const round = (v) => (Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
  if (/^(Pan|Tilt|Zoom)$|Pos$/.test(attribute)) return [round(value), '°'];
  if (/Strobe|Rate|Frequency|Shake/.test(attribute)) return [round(value), 'Hz'];
  if (/Rotate$|Spin$/.test(attribute)) return [round(value), '°/s'];
  if (/^CT[CBO]$/.test(attribute) && Math.abs(value) > 100) return [round(value), 'K'];
  return [Math.round(value * 100), '%'];
}

/** A physical span in the guide's form: "0→540°", or one value. */
function spanOf(attribute, from, to) {
  const [a, unit] = physical(attribute, from);
  const [b] = physical(attribute, to);
  return a === b ? `${a}${unit}` : `${a}→${b}${unit}`;
}

/** "slow→fast", "fast→slow", or nothing, from two speeds. */
function speedWords(from, to) {
  if (from === to) return '';
  return Math.abs(to) > Math.abs(from) ? 'slow→fast' : 'fast→slow';
}

/** The coarse byte of a value at a channel's resolution. */
const coarse = (value, bytes) => Math.floor(value / 256 ** (bytes - 1));

/** A name as the guide writes it: lower case, "BeamMode" as "beam mode". */
function words(name) {
  return String(name || '').trim().replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * A wheel slot in the guide's words: "open", "red", "gobo 3". A slot the head
 * takes as open says so, whatever the file calls it.
 */
function slotText(family, set, slot, index) {
  if (slot && slotKind(family, slot) === 'Open') return 'open';
  const name = String((set && set.name) || (slot && slot.name) || '').trim();
  return name ? words(name) : `slot ${index}`;
}

/**
 * Named choices, and the function itself across whatever stretches of its
 * range they leave: a speed sweep with a few control values at its top is
 * both.
 */
function choicesAndRest(fn, bytes, choices, choicePart, restPart) {
  const lo = (v) => coarse(v, bytes);
  const parts = [];
  let next = lo(fn.dmxFrom);
  choices.slice().sort((p, q) => p.dmxFrom - q.dmxFrom).forEach((s) => {
    const from = lo(s.dmxFrom);
    if (from > next) parts.push(restPart(next, from - 1));
    parts.push(choicePart(s));
    next = Math.max(next, lo(s.dmxTo) + 1);
  });
  if (next <= lo(fn.dmxTo)) parts.push(restPart(next, lo(fn.dmxTo)));
  return parts;
}

/**
 * A slot's picture as the range cards show one, from the file's own wheel
 * images, or null where the file has none or they were not loaded.
 */
function slotImage(type, slot, title) {
  const url = slot && slot.mediaFileName && type.wheelImages
    ? type.wheelImages.get(slot.mediaFileName) : null;
  return url ? { url, title, named: true } : null;
}

/** A colour slot's colour: its filter's, which is the measured one, else its own. */
function slotColour(type, slot) {
  if (!slot) return null;
  const filter = slot.filter ? type.physical.filters.find((f) => f.name === slot.filter) : null;
  return cieToHex((filter && filter.color) || slot.color);
}

/**
 * A rotation function as the guide says it: a direction and whether it
 * speeds up or slows down. One that runs through nought, fast one way to
 * fast the other, is split there, with the set named Stop as the stop.
 * Positive is clockwise.
 */
function rotationParts(fn, bytes, verb, kind) {
  const lo = (v) => coarse(v, bytes);
  // The speed at each end as the engine reads it, named points included,
  // so the words say what the head does.
  const pf = stateAt(fn, fn.dmxFrom).physical;
  const pt = stateAt(fn, fn.dmxTo).physical;
  const dir = (v) => (v > 0 ? 'CW' : 'CCW');
  const part = (from, to, text, rotation) => ({
    lo: lo(from), hi: lo(to), type: kind, text, speed: '', colour: null, split: null, gobo: null, rotation,
  });
  if (pf === 0 && pt === 0) return [part(fn.dmxFrom, fn.dmxTo, `${verb} stop`, null)];
  if (pf * pt >= 0) {
    const d = dir(pf + pt);
    const text = `${verb} ${speedWords(pf, pt)} ${d}`.replace(/\s+/g, ' ');
    return [part(fn.dmxFrom, fn.dmxTo, text, {
      verb, dir: d, from: Math.abs(pf), to: Math.abs(pt),
    })];
  }
  // Through nought: where it crosses, and the stop set around it if named.
  const zero = fn.dmxFrom + (fn.dmxTo - fn.dmxFrom) * (pf / (pf - pt));
  const stop = fn.sets.find((s) => /stop/i.test(s.name || ''));
  const stopFrom = stop ? stop.dmxFrom : Math.floor(zero);
  const stopTo = stop ? stop.dmxTo : Math.floor(zero);
  const parts = [];
  if (stopFrom > fn.dmxFrom) {
    parts.push(part(fn.dmxFrom, stopFrom - 1, `${verb} fast→slow ${dir(pf)}`, {
      verb, dir: dir(pf), from: Math.abs(pf), to: 0,
    }));
  }
  parts.push(part(stopFrom, stopTo, `${verb} stop`, null));
  if (stopTo < fn.dmxTo) {
    parts.push(part(stopTo + 1, fn.dmxTo, `${verb} slow→fast ${dir(pt)}`, {
      verb, dir: dir(pt), from: 0, to: Math.abs(pt),
    }));
  }
  return parts;
}

/**
 * The ranges of one channel function, in the guide's words.
 *
 * @param {Object} type the fixture type
 * @param {Object} fn a channel function
 * @param {Number} bytes the channel's resolution
 * @returns {Array} parts for `fold`: `{ lo, hi, type, text, speed, colour, split, gobo }`
 */
function partsOf(type, fn, bytes) {
  const a = fn.attribute;
  const lo = (v) => coarse(v, bytes);
  const part = (from, to, kind, text, extra = {}) => ({
    lo: lo(from), hi: lo(to), type: kind, text, speed: '', colour: null, split: null, gobo: null, ...extra,
  });
  const whole = (kind, text, extra) => [part(fn.dmxFrom, fn.dmxTo, kind, text, extra)];
  const span = spanOf(a, fn.physicalFrom, fn.physicalTo);
  // Sets that are choices, not points along a sweep: they cover more than one
  // coarse value. Min, Center and 25 percent name places in one range.
  const choices = fn.sets.filter((s) => coarse(s.dmxTo, bytes) > coarse(s.dmxFrom, bytes)
    && String(s.name || '').trim());

  if (a === 'NoFeature') return whole('NoFunction', 'off');
  if (a === 'Dimmer') return whole('Intensity', `dimmer ${span}`);
  if (/^Color(Add|Sub)_/.test(a)) return whole('ColorIntensity', `${attributeLabel(a).toLowerCase()} ${span}`);
  if (/^CT[CBO]$/.test(a)) {
    return Math.max(fn.physicalFrom, fn.physicalTo) > 100
      ? whole('ColorTemperature', `white ${span}`) : whole('Effect', `${a} ${span}`);
  }
  if (a === 'Pan' || a === 'Tilt') return whole(a, `${a.toLowerCase()} ${span}`);
  if (a === 'Zoom') return whole('Zoom', `zoom ${span}`);
  if (/^Focus\d+$/.test(a)) return whole('Focus', `focus ${span}`);
  if (a === 'Iris') return whole('Iris', `iris ${span}`);
  if (/^Frost\d+$/.test(a)) return whole('Frost', `frost ${span}`);

  if (/^Shutter\d+$/.test(a)) {
    const shut = (s) => (namesClosed(nameOf(fn, s)) ? 'closed' : 'open');
    if (!choices.length) return whole('ShutterStrobe', shut(null));
    return choices.map((s) => part(s.dmxFrom, s.dmxTo, 'ShutterStrobe', shut(s)));
  }
  const strobe = /^Shutter\d+/.test(a) && STROBE_WORDS.find(([pattern]) => pattern.test(a));
  if (strobe) return whole('ShutterStrobe', `${strobe[1]} ${span}${strobe[2] ? ' random' : ''}`);

  const wheelMatch = /^(Color|Gobo|Prism|Animation)(\d+)(.*)$/.exec(a);
  if (wheelMatch) {
    const [, family, , suffix] = wheelMatch;
    const wheel = fn.wheel ? type.wheels.find((w) => w.name === fn.wheel) : null;
    const slotOf = (s) => (wheel && s.wheelSlotIndex ? wheel.slots[s.wheelSlotIndex - 1] : null);
    const slotted = fn.sets.filter((s) => s.wheelSlotIndex > 0);

    if (suffix === '' && slotted.length) {
      return slotted.map((s) => {
        const slot = slotOf(s);
        const text = slotText(family, s, slot, s.wheelSlotIndex);
        return part(s.dmxFrom, s.dmxTo, 'WheelSlot', text, {
          colour: family === 'Color' ? slotColour(type, slot) : null,
          gobo: family === 'Color' ? null : slotImage(type, slot, text),
        });
      });
    }
    if (suffix === '' && family === 'Prism') {
      if (!choices.length) return whole('Prism', 'prism in');
      return choices.map((s) => (namesOpen(nameOf(fn, s))
        ? part(s.dmxFrom, s.dmxTo, 'NoFunction', 'off')
        : part(s.dmxFrom, s.dmxTo, 'Prism', `prism in (${words(s.name)})`)));
    }
    if (/Shake$/.test(suffix)) {
      const speed = spanOf(`${a}Shake`, fn.physicalFrom, fn.physicalTo);
      if (!slotted.length) return whole('WheelShake', `shake ${speed}`, { speed });
      return slotted.map((s) => {
        const slot = slotOf(s);
        const name = slotText(family, s, slot, s.wheelSlotIndex);
        return part(s.dmxFrom, s.dmxTo, 'WheelShake', `shake ${name} ${speed}`, {
          speed, gobo: slotImage(type, slot, name),
        });
      });
    }
    if (/Rotate$|Spin$/.test(suffix)) {
      let verb = 'spin';
      let kind = 'WheelSlotRotation';
      if (suffix === 'WheelSpin') { verb = 'scroll'; kind = 'WheelRotation'; }
      if (family === 'Prism') { verb = 'prism spin'; kind = 'PrismRotation'; }
      return rotationParts(fn, bytes, verb, kind);
    }
    if (/Pos$/.test(suffix)) {
      return whole('WheelSlotRotation', `${family === 'Prism' ? 'prism at' : 'hold at'} ${span}`);
    }
  }

  // Anything else: its named choices, and the function across the rest. A
  // span is only said where it is a quantity -- a speed or a time; a
  // control's 0 to 1 is a placeholder.
  const kind = /^Control\d+$/.test(a) ? 'Maintenance' : 'Effect';
  const named = !fn.name || fn.name === a ? attributeLabel(a) : fn.name;
  const quantity = /Speed|Time|Rate|Fade/.test(a) && fn.physicalFrom !== fn.physicalTo;
  const restText = `${words(named)}${quantity ? ` ${span}` : ''}`;
  const choicePart = (s) => part(s.dmxFrom, s.dmxTo, kind, words(s.name));
  const restPart = (from, to) => ({
    lo: from, hi: to, type: kind, text: restText, speed: '', colour: null, split: null, gobo: null,
  });
  return choicesAndRest(fn, bytes, choices, choicePart, restPart);
}

/**
 * Joins neighbouring rotation ranges that turn the same way: a file may
 * write one sweep as several functions with single values between them,
 * "CW Fast", "CW Med", "CW Slow", which is one fast→slow CW.
 */
function joinRotations(parts) {
  const out = [];
  parts.forEach((p) => {
    const last = out[out.length - 1];
    if (last && last.rotation && p.rotation && last.type === p.type
      && last.rotation.verb === p.rotation.verb && last.rotation.dir === p.rotation.dir
      && p.lo <= last.hi + 1) {
      last.hi = Math.max(last.hi, p.hi);
      last.rotation = { ...last.rotation, to: p.rotation.to };
      const { rotation } = last;
      last.text = `${rotation.verb} ${speedWords(rotation.from, rotation.to)} ${rotation.dir}`
        .replace(/\s+/g, ' ');
      return;
    }
    out.push({ ...p });
  });
  return out.map(({ rotation, ...p }) => p);
}

/**
 * The guide for one fixture in one mode.
 *
 * @param {Object} type a GDTF fixture type
 * @param {Object} engine the fixture's DmxEngine, which knows its addresses
 *   and the mode channels' starting values
 * @returns {Object} `{ light: [String], channels: [{ n, name, text, ranges, drawn }] }`
 */
export default function gdtfGuide(type, engine) {
  const channels = [];
  const light = [];
  for (let address = 0; address < engine.footprint; address += 1) {
    const n = address + 1;
    const slot = engine.byAddress[address];
    if (!slot) {
      channels.push({
        n, name: 'unused', text: '', drawn: true,
      });
      // eslint-disable-next-line no-continue
      continue;
    }
    const c = slot.channel;
    const attribute = (c.channel.logicalChannels[0] || {}).attribute || 'NoFeature';
    const label = attributeLabel(attribute);
    const name = c.instanceOf ? `${c.instanceOf} ${label}` : label;
    if (slot.byte > 0) {
      channels.push({
        n, name: `${name} fine`, text: `fine for ${name}`, drawn: true,
      });
      // eslint-disable-next-line no-continue
      continue;
    }
    // Functions for the mode the fixture starts in, the rest named.
    const current = engine.candidates(c);
    const elsewhere = c.functions.filter((f) => !current.includes(f));
    const parts = joinRotations(current
      .flatMap((fn) => partsOf(type, fn, c.bytes))
      .sort((p, q) => p.lo - q.lo));
    const ranges = fold(parts);
    const drawn = c.functions.some((f) => f.attribute !== 'NoFeature'
      && DRAWN.some((pattern) => pattern.test(f.attribute)));
    let text = ranges.map((r) => (r.range ? `${r.range} ${r.text}` : r.text)).join(' · ');
    if (elsewhere.length) {
      const masters = [...new Set(elsewhere.map((f) => (f.modeMaster || []).join('.')))].join(', ');
      text += ` · other functions when ${masters} changes: ${[...new Set(elsewhere.map((f) => f.name))].join(', ')}`;
    }
    channels.push({
      n, name, ranges, text, drawn,
    });

    // What has to be set before there is light.
    if (attribute === 'Dimmer') light.push(`raise ${name} (ch ${n})`);
    const closed = ranges.find((r) => r.lo === 0 && r.text === 'closed');
    const open = ranges.find((r) => r.text === 'open');
    if (closed && open) light.unshift(`set ${name} (ch ${n}) to ${open.range}, open`);
  }
  if (!light.length) {
    const colours = channels.filter((ch) => /^(Red|Green|Blue|White|Amber|Cyan|Magenta|Yellow)/.test(ch.name));
    if (colours.length) light.push(`raise the colour channels (ch ${colours.map((ch) => ch.n).join(', ')})`);
  }
  return { light, channels };
}
