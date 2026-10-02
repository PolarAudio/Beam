/**
 * @file The quick guide for a GDTF fixture, in the shape `fixtureGuide`
 * gives an OFL one, so the panels and the range cards read either.
 *
 * Each range is a channel function, or a channel set within it, named as the
 * file names it and stated in its physical units. Its kind and direction come
 * from the attribute and the physical range rather than from the words, so
 * nothing is guessed.
 *
 * Ranges are in the coarse byte, 0 to 255, which is what the cards and the
 * channel table show. A function that applies only while a mode channel is in
 * some range is listed under the mode the fixture starts in; the others are
 * named in the line's text.
 */

import { cieToHex, attributeLabel } from './fixture_parts';

/** Attributes the moving head acts on; anything else is shown but marked. */
const DRAWN = [
  /^Dimmer$/, /^Pan$/, /^Tilt$/, /^Zoom$/, /^Color(Add|Sub)_/, /^CT[CBO]$/, /^Focus\d+$/, /^Iris$/,
  /^Frost\d+$/, /^(Color|Gobo|Prism)\d+/, /^Shutter\d+/, /^NoFeature$/,
];

/** A physical value as written for its attribute. */
function physicalText(attribute, value) {
  const round = (v) => (Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
  if (/^(Pan|Tilt|Zoom)$|Pos$/.test(attribute)) return `${round(value)}°`;
  if (/Strobe|Rate|Frequency/.test(attribute)) return `${round(value)}Hz`;
  if (/Rotate$|Spin$/.test(attribute)) return `${round(value)}°/s`;
  if (/^CT[CBO]$/.test(attribute) && Math.abs(value) > 100) return `${round(value)}K`;
  return `${Math.round(value * 100)}%`;
}

/** The range-card kind of a function or set, from what it does. */
function kindOf(attribute, fn, set) {
  const name = `${(set && set.name) || ''} ${fn.name}`.toLowerCase();
  if (attribute === 'NoFeature') return 'closed';
  if (attribute === 'Dimmer' || /^Color(Add|Sub)_/.test(attribute)) return 'intensity';
  if (/^Shutter\d+$/.test(attribute)) return /close/.test(name) ? 'closed' : 'open';
  if (/^Shutter\d+Strobe/.test(attribute)) return 'strobe';
  if (/Rotate$|Spin$/.test(attribute)) {
    if (fn.physicalFrom === 0 && fn.physicalTo === 0) return 'stop';
    return Math.max(fn.physicalFrom, fn.physicalTo) <= 0 ? 'ccw' : 'cw';
  }
  if (/Shake$/.test(attribute)) return 'shake';
  if (/^Color\d+$/.test(attribute)) return set ? 'colour' : 'slot';
  if (/^(Gobo|Animation)\d+$/.test(attribute)) return 'slot';
  if (/^Prism\d+/.test(attribute)) return 'prism';
  if (/^(Pan|Tilt)$|Pos$/.test(attribute)) return 'angle';
  if (/^(Zoom|Focus\d+|Iris|Frost\d+)$/.test(attribute)) return 'optic';
  if (/Speed|Time/.test(attribute)) return 'speed';
  if (/^(ColorMacro|Effects)\d+/.test(attribute)) return 'macro';
  if (/^Control\d+$/.test(attribute)) return 'maintenance';
  return 'other';
}

/** Which way a function's quantity runs as the value rises, or null. */
function rampOf(fn) {
  if (fn.physicalFrom === fn.physicalTo) return null;
  return fn.physicalTo > fn.physicalFrom ? 'up' : 'down';
}

/** The coarse byte of a value at a channel's resolution. */
const coarse = (value, bytes) => Math.floor(value / 256 ** (bytes - 1));

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
  const wheels = new Map(type.wheels.map((w) => [w.name, w]));
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
    const ranges = [];
    current.forEach((fn) => {
      const fnAttribute = fn.attribute;
      const wheel = fn.wheel ? wheels.get(fn.wheel) : null;
      // Sets are ranges of their own only when they are choices: wheel slots,
      // or named stretches -- Closed 0-31, Open 32-63. Points along a sweep,
      // Min, Center, 25 percent, name places in one range, and so does a
      // stretch that only repeats the function's own name.
      const named = (s) => {
        const text = (s.name || '').trim();
        return text && text !== fn.name && !/^empty/i.test(text)
          && coarse(s.dmxTo, c.bytes) > coarse(s.dmxFrom, c.bytes);
      };
      const choices = fn.sets.some((s) => s.wheelSlotIndex) || fn.sets.some(named);
      if (choices) {
        fn.sets.forEach((set) => {
          const slotDef = wheel && set.wheelSlotIndex ? wheel.slots[set.wheelSlotIndex - 1] : null;
          ranges.push({
            lo: coarse(set.dmxFrom, c.bytes),
            hi: coarse(set.dmxTo, c.bytes),
            text: (set.name || (slotDef && slotDef.name) || fn.name || '').trim() || fnAttribute,
            kind: kindOf(fnAttribute, fn, set),
            ramp: null,
            colour: slotDef && slotDef.color && /^Color\d+$/.test(fnAttribute) ? cieToHex(slotDef.color) : null,
          });
        });
        return;
      }
      const varies = fn.physicalFrom !== fn.physicalTo;
      const span = varies
        ? `${physicalText(fnAttribute, fn.physicalFrom)}→${physicalText(fnAttribute, fn.physicalTo)}`
        : '';
      ranges.push({
        lo: coarse(fn.dmxFrom, c.bytes),
        hi: coarse(fn.dmxTo, c.bytes),
        text: `${fn.name}${span ? ` ${span}` : ''}`,
        kind: kindOf(fnAttribute, fn, null),
        ramp: rampOf(fn),
      });
    });
    const drawn = c.functions.some((f) => f.attribute !== 'NoFeature'
      && DRAWN.some((pattern) => pattern.test(f.attribute)));
    let text = ranges.map((r) => (r.lo === 0 && r.hi === 255 ? r.text : `${r.lo}–${r.hi} ${r.text}`)).join(' · ');
    if (elsewhere.length) {
      const masters = [...new Set(elsewhere.map((f) => (f.modeMaster || []).join('.')))].join(', ');
      text += ` · other functions when ${masters} changes: ${[...new Set(elsewhere.map((f) => f.name))].join(', ')}`;
    }
    channels.push({
      n, name, ranges, text, drawn,
    });

    if (attribute === 'Dimmer') light.push(`raise ${name} (ch ${n})`);
    const shutters = current.filter((f) => /^Shutter\d+$/.test(f.attribute));
    const closedAtZero = shutters.find((f) => f.dmxFrom === 0 && /close/i.test(f.name));
    const open = shutters.find((f) => /open/i.test(f.name));
    if (closedAtZero && open) {
      light.unshift(`set ${name} (ch ${n}) to ${coarse(open.dmxFrom, c.bytes)}–${coarse(open.dmxTo, c.bytes)}, open`);
    }
  }
  if (!light.length) {
    const colours = channels.filter((ch) => /Color(Add|Sub)_/.test(ch.name));
    if (colours.length) light.push(`raise the colour channels (ch ${colours.map((ch) => ch.n).join(', ')})`);
  }
  return { light, channels };
}
