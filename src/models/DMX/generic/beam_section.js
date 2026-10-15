/**
 * @file The section of a profile where Beam keeps what OFL cannot express.
 *
 * A generic fixture's profile is OFL-shaped on the outside; its kind and
 * parameters -- a laser's power and scan, a projector's lens, a bar's grid --
 * live under `beam`. Files written before the section had that name carry it
 * as `asls`, the key ASLS Studio used, and are moved over as they are read.
 */

/** The `beam` keys that make a profile a generic fixture. */
const GENERIC_KEYS = ['bar', 'projector', 'display', 'laser', 'strobe'];

/**
 * Brings a profile up to date, in place: an `asls` section becomes `beam`,
 * and a generic fixture's `physical.dimensions` is dropped, since its size is
 * its parameters' and a second copy drifts from them.
 *
 * Safe on anything: a library profile without either is returned untouched,
 * and one carrying both section keys keeps `beam`.
 *
 * @param {Object} profile
 * @returns {Object} the same profile
 */
export default function withBeamSection(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  if (profile.asls) {
    if (!profile.beam) profile.beam = profile.asls;
    delete profile.asls;
  }
  const generic = profile.beam && GENERIC_KEYS.some((key) => profile.beam[key]);
  if (generic && profile.physical) delete profile.physical.dimensions;
  return profile;
}
