/**
 * @file Where Beam reads a fixture file's words rather than its data.
 *
 * GDTF states most things as data: an attribute, a wheel slot index, a
 * physical value. A few things it states only in a name, or a file leaves
 * the data out and only the name is left: a shutter set called Closed, a
 * prism set called Open whose slot index is 0, a prism wheel slot called
 * "8-Facet Circular Prism" with no facets listed, an open gobo slot with no
 * name and no image, a laser known only by its name and its makers' own
 * attributes. Each rule here reads such a name. They are heuristics,
 * kept together so each is written once, used the same way by the head and
 * by the range guide, and pinned by `test/gdtf_name_rules.test.js`.
 *
 * Data always wins: a rule is only asked where the data does not answer.
 */

/** A name that says the light is shut off: "Closed", "Shutter close". */
export function namesClosed(name) {
  return /\bclosed?\b/i.test(String(name || ''));
}

/** A name that says nothing is in the light path: "Open", "Open 1". */
export function namesOpen(name) {
  return /\bopen\b/i.test(String(name || ''));
}

/** A set that selects nothing: "Disabled", "Blackout", "Wheel Slot 0 OPEN". */
export function namesNothing(name) {
  return /\b(off|none|disabled?|blackout|open|idle)\b/i.test(String(name || ''));
}

/** The number a range's name ends in: "Cue 12", "Wheel Slot 0 OPEN", "075". */
export function numberInName(name) {
  const match = /(\d+)\D*$/.exec(String(name || ''));
  return match ? parseInt(match[1], 10) : null;
}

/**
 * The percentage a range's name gives: "25%", "Speed 200 %", or a name that
 * is only a number, "-050", on a channel read as a percentage. Null for none.
 */
export function percentInName(name) {
  const t = String(name || '').trim();
  const match = /(-?\d+(?:\.\d+)?)\s*%/.exec(t) || /^([-+]?\d+(?:\.\d+)?)$/.exec(t);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Where a range sits on its control's own scale, from its name: 'default' for
 * "Default Speed", 'min' for "Min" or "Zero", 'max' for "Max" or "Full". Null
 * for anything else.
 */
export function namesScalePoint(name) {
  const t = String(name || '').trim();
  if (/^default\b/i.test(t)) return 'default';
  if (/^(min(imum)?|zero)$/i.test(t)) return 'min';
  if (/^(max(imum)?|full)$/i.test(t)) return 'max';
  return null;
}

/**
 * The percentages a laser's scan rate and speed run between when a file
 * names their ends only "Min" and "Max". The speed is the 0-255 % of
 * Pangolin's FB4 table, one percent per step; the scan rate is 0-100 % of
 * the point rate.
 */
export const NAMED_RATE_ENDS = {
  scanRate: { min: 0, max: 100 },
  speed: { min: 0, max: 255 },
};

/** A range where a rotation stands still: "Stop", "No Rotation", "Home". */
export function namesStop(name) {
  return /\b(stop|no (rotation|spin)|home|cent(er|re))\b/i.test(String(name || ''));
}

/** A range that hands rotation back to the content: "Reset", "Original". */
export function namesOriginal(name) {
  return /^(reset|original)\b/i.test(String(name || '').trim());
}

/** A name for turning anticlockwise: "<<<", "acw 180", "CCW", "Reverse". */
export function namesAnticlockwise(name) {
  return /<<|\b(a?ccw|acw|anti-?clockwise|counter-?clockwise|reverse|left)\b/i
    .test(String(name || ''));
}

/** A name for turning clockwise: ">>>", "cw 180", "Forward". */
export function namesClockwise(name) {
  return />>|\b(cw|clockwise|forward|right)\b/i.test(String(name || ''))
    && !namesAnticlockwise(name);
}

/**
 * The angle a range's name gives, in degrees, clockwise positive: "90",
 * "-180", "acw 180" (-180), "Home" or "center" (0). Null for none.
 */
export function degreesInName(name) {
  const t = String(name || '').trim();
  if (namesStop(t)) return 0;
  const match = /^(?:[a-z]+\s+)?([-+]?\d+(?:\.\d+)?)\s*°?$/i.exec(t);
  if (!match) return null;
  const degrees = parseFloat(match[1]);
  return namesAnticlockwise(t) ? -Math.abs(degrees) : degrees;
}

/** A name that says its range runs downward: "Size X from big to small". */
export function namesFalling(name) {
  return /\b(big|large|max\w*|wide|full)\s+to\s+(small|min\w*|narrow|zero)\b/i
    .test(String(name || ''));
}

/** A fixture whose maker or name says it is a laser: "Phoenix 5000 Laser". */
export function namesLaser(text) {
  return /laser/i.test(String(text || ''));
}

/**
 * An attribute only a scanning laser has. GDTF has no laser attributes, so
 * makers name their own: Pangolin's LaserCue and TestCue, KOLO's Scan_Rate,
 * Laser-Zentrale's ScanFrequency and PatternSelect, LaserAnimation's
 * ObjectSlot.
 */
export function namesLaserAttribute(attribute) {
  return /^(Laser|Scan|VisiblePoints|TestCue$|PatternSelect$|ObjectSlot$)/i
    .test(String(attribute || ''));
}

/** An attribute that sizes a figure: Scale_X, Scale_XYZ, "Scale X". */
export function namesScaleAttribute(attribute) {
  return /^Scale[_ ]/i.test(String(attribute || ''));
}

/**
 * What a laser's mode set makes it do, from the set's name: 'off', play its
 * own content ('standalone': "Playback Mode", "Auto", "Sound"), or follow
 * its input ('input', anything else, Pangolin's "Disabled" included, which
 * turns DMX control off and leaves the laser on its input).
 */
export function laserModeFromName(name) {
  const t = String(name || '');
  if (/\b(off|blackout)\b/i.test(t)) return 'off';
  if (/playback|stand-?alone|auto|internal|program|sound|music/i.test(t)) return 'standalone';
  return 'input';
}

/**
 * The name a channel set or its function goes by: the set's own when it has
 * one, else the function's.
 *
 * @param {Object} fn a channel function
 * @param {Object|null} set a channel set within it
 * @returns {String}
 */
export function nameOf(fn, set) {
  const own = set && String(set.name || '').trim();
  return own || String(fn.name || '');
}

/**
 * What a GDTF wheel slot is, as the head builds its optics.
 *
 * Facets make a prism. On a gobo or prism wheel, a slot named Open, or one
 * with neither a name nor an image, is the open hole, whatever colour the
 * file gives it. A prism wheel's other slots are prisms even without facets
 * listed; the head reads the facets from the name (see `prismFromText`). A
 * slot named for frost is frost. A colour wheel's slots are colours but for
 * one named Open; a gobo or animation wheel's are gobos.
 *
 * @param {String} family the wheel's family from the attributes that select
 *   it: 'Color', 'Gobo', 'Prism', 'Animation' or 'Effects'
 * @param {Object} slot a GDTF wheel slot, `{ name, mediaFileName, facets }`
 * @returns {String} 'Open', 'Color', 'Gobo', 'Prism' or 'Frost'
 */
export function slotKind(family, slot) {
  const name = String(slot.name || '').trim();
  const open = /^open$/i.test(name);
  const empty = !slot.mediaFileName && !name;
  if (slot.facets && slot.facets.length) return 'Prism';
  if (open || (family !== 'Color' && empty)) return 'Open';
  if (family === 'Prism') return 'Prism';
  if (/frost/i.test(name)) return 'Frost';
  return family === 'Color' ? 'Color' : 'Gobo';
}

/** Facets a prism has when its text does not say. */
export const PRISM_DEFAULT_FACETS = 3;

/** The most facets a prism is drawn with; matches PRISM_FACETS_MAX in the shaders. */
export const PRISM_MAX_FACETS = 8;

/**
 * What a prism describes itself as, from its text: "4-facet linear,
 * rotating", "8-facet 45° circular". Only the text has it in an OFL profile,
 * and in a GDTF file that lists no facets.
 *
 * @param {String} text
 * @returns {Object} `{ facets, linear }`, facets null when unstated
 */
export function prismFromText(text) {
  const t = String(text || '');
  const match = /(\d+)\s*-?\s*facet/i.exec(t);
  const facets = match ? Math.min(Math.max(parseInt(match[1], 10), 2), PRISM_MAX_FACETS) : null;
  return { facets, linear: /linear/i.test(t) };
}
