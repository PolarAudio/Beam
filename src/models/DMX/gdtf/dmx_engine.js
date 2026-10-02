/**
 * @file DMX into GDTF terms, for one fixture in one mode.
 *
 * Bytes arrive by address. Each lands in a DMX channel, which assembles its
 * bytes coarse first into one value at the channel's resolution, finds the
 * channel function that value falls in -- among those whose mode master
 * condition currently holds -- and states it in the function's physical
 * units, with the channel set it falls in if there is one.
 *
 * A write reports every channel whose state may have changed: the one written,
 * and any whose functions take it as their mode master, since a mode channel
 * moving can change what an untouched channel means. The Proteus's zoom is
 * 2-38 degrees in beam mode and 2.8-28.6 in spot mode, and which applies is
 * decided by a different channel.
 *
 * Nothing here knows about rendering; `write` returns states and a
 * dispatcher acts on them.
 */

import { patchedChannels } from './gdtf_reader';

/**
 * The function a value falls in among candidates, by start and end. Ranges
 * that overlap only do so across mode master conditions, so among those that
 * currently apply at most one contains a value; when a file overlaps them
 * anyway, the latest start wins, as it would on a desk.
 */
function functionAt(candidates, value) {
  let found = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const f = candidates[i];
    if (value >= f.dmxFrom && value <= f.dmxTo && (!found || f.dmxFrom >= found.dmxFrom)) found = f;
  }
  return found;
}

/** A value's place in a range, as a physical value. */
function interpolate(value, dmxFrom, dmxTo, physicalFrom, physicalTo) {
  if (dmxTo <= dmxFrom) return physicalFrom;
  return physicalFrom + ((value - dmxFrom) / (dmxTo - dmxFrom)) * (physicalTo - physicalFrom);
}

/**
 * The state of a channel at a value: its function, the channel set the value
 * falls in, and the physical value.
 *
 * A set with its own physical range is stated in that range; one without
 * takes the function's, at the value's place in the function.
 *
 * @param {Object} fn a channel function
 * @param {Number} value at the channel's resolution
 * @returns {{fn: Object, set: Object|null, physical: Number}}
 */
export function stateAt(fn, value) {
  let set = null;
  for (let i = 0; i < fn.sets.length; i += 1) {
    const s = fn.sets[i];
    if (value >= s.dmxFrom && value <= s.dmxTo) {
      set = s;
      break;
    }
  }
  let physical;
  if (set && set.physicalFrom !== null && set.physicalTo !== null) {
    physical = interpolate(value, set.dmxFrom, set.dmxTo, set.physicalFrom, set.physicalTo);
  } else {
    physical = interpolate(value, fn.dmxFrom, fn.dmxTo, fn.physicalFrom, fn.physicalTo);
  }
  return { fn, set, physical };
}

export default class DmxEngine {
  /**
   * @param {Object} type a fixture type, from `readGdtf` or `translateOfl`
   * @param {Object} mode one of its modes
   */
  constructor(type, mode) {
    this.type = type;
    this.mode = mode;
    const { instances, footprint } = patchedChannels(type, mode);

    /**
     * Every channel instance. `value` is at the channel's resolution;
     * `functions` pools every logical channel's, since their ranges share the
     * one DMX channel.
     */
    this.channels = instances.map((instance, index) => ({
      index,
      channel: instance.channel,
      name: instance.instanceOf ? `${instance.instanceOf}.${instance.channel.name}` : instance.channel.name,
      instanceOf: instance.instanceOf,
      geometry: instance.instanceOf || instance.channel.geometry,
      dmxBreak: instance.dmxBreak,
      offsets: instance.offsets,
      bytes: instance.channel.bytes,
      functions: instance.channel.logicalChannels.flatMap((l) => l.functions),
      value: 0,
      state: null,
    }));

    /**
     * Footprint in the first DMX break, which is where the fixture is
     * patched. Channels in other breaks are kept but cannot be addressed yet.
     */
    this.footprint = footprint[1] || 0;
    this.otherBreaks = this.channels.filter((c) => c.offsets && c.dmxBreak !== 1).length;

    /** For each address in break 1, the channel and which of its bytes. */
    this.byAddress = new Array(this.footprint).fill(null);
    this.channels.forEach((c) => {
      if (!c.offsets || c.dmxBreak !== 1) return;
      c.offsets.forEach((offset, byte) => {
        this.byAddress[offset - 1] = { channel: c, byte };
      });
    });
    this.bytes = new Uint8Array(this.footprint);

    // Mode masters by the channel they name. A master is named by its DMX
    // channel's name, which within a mode identifies a channel template; when
    // the template is repeated, each instance answers to the master in its
    // own geometry reference, or the only one there is.
    const byName = new Map();
    this.channels.forEach((c) => {
      const key = c.channel.name;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(c);
    });
    this.dependents = new Map();
    this.channels.forEach((c) => {
      c.masters = new Map();
      c.functions.forEach((f) => {
        if (!f.modeMaster) return;
        const named = byName.get(f.modeMaster[0]) || [];
        const master = named.find((m) => m.instanceOf === c.instanceOf) || named[0];
        if (!master) return;
        c.masters.set(f, master);
        if (!this.dependents.has(master)) this.dependents.set(master, new Set());
        this.dependents.get(master).add(c);
      });
    });

    this.channels.forEach((c) => {
      // A channel starts at its initial function's default, else the first
      // function's: what the fixture does before any DMX arrives.
      const logicalOf = (f) => c.channel.logicalChannels.find((l) => l.functions.includes(f)) || {};
      const attributeOf = (f) => logicalOf(f).attribute;
      const initial = c.channel.initialFunction
        ? c.functions.find((f) => `${attributeOf(f)}.${f.name}` === c.channel.initialFunction)
        : null;
      const start = initial || c.functions[0];
      // eslint-disable-next-line no-param-reassign
      c.value = start ? start.default : 0;
      // The bytes hold the same value, so a desk that sends only a coarse
      // byte combines it with the default's fine byte, not with zero.
      if (c.offsets && c.dmxBreak === 1) {
        let rest = c.value;
        for (let i = c.offsets.length - 1; i >= 0; i -= 1) {
          this.bytes[c.offsets[i] - 1] = rest % 256;
          rest = Math.floor(rest / 256);
        }
      }
    });
    this.channels.forEach((c) => this.resolve(c));
  }

  /**
   * The functions that apply to a channel now: those without a mode master,
   * and those whose master's value is inside their condition.
   *
   * @param {Object} c a channel instance
   * @returns {Array<Object>}
   */
  // eslint-disable-next-line class-methods-use-this
  candidates(c) {
    if (!c.masters.size) return c.functions;
    return c.functions.filter((f) => {
      if (!f.modeMaster) return true;
      const master = c.masters.get(f);
      if (!master) return false;
      return master.value >= f.modeFrom && master.value <= f.modeTo;
    });
  }

  /**
   * Recomputes a channel's state from its value.
   *
   * @param {Object} c a channel instance
   * @returns {Object|null} the new state
   */
  resolve(c) {
    const fn = functionAt(this.candidates(c), c.value);
    // eslint-disable-next-line no-param-reassign
    c.state = fn ? stateAt(fn, c.value) : null;
    return c.state;
  }

  /**
   * Writes one byte at an address within the fixture.
   *
   * @param {Number} address 0-based, within the fixture's footprint
   * @param {Number} byte 0-255
   * @returns {Array<Object>} channel instances whose state was recomputed
   */
  write(address, byte) {
    const slot = this.byAddress[address];
    if (!slot) return [];
    this.bytes[address] = byte;
    const c = slot.channel;
    let value = 0;
    for (let i = 0; i < c.offsets.length; i += 1) {
      value = value * 256 + this.bytes[c.offsets[i] - 1];
    }
    if (value === c.value && c.state) return [];
    c.value = value;
    this.resolve(c);
    const changed = [c];
    const dependents = this.dependents.get(c);
    if (dependents) {
      // Only those whose meaning changed: one whose function is the same as
      // before still holds the same state.
      dependents.forEach((d) => {
        const before = d.state ? d.state.fn : null;
        this.resolve(d);
        if ((d.state ? d.state.fn : null) !== before) changed.push(d);
      });
    }
    return changed;
  }
}
