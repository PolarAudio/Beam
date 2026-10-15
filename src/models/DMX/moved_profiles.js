/**
 * @file Profiles that moved: a key a saved project may still name, and the key
 * of the file that took its place.
 *
 * A project names a fixture's profile by `manufacturer/model`. When a shipped
 * profile is replaced by another file -- an OFL profile by a GDTF fixture --
 * its key changes, and a project saved before the change would otherwise open
 * with that fixture missing.
 */

/** Old key to new key. */
export const MOVED_PROFILES = {
  'wicked-lasers/LaserCube Pro 2.5W': 'Wicked Lasers/Wicked_Lasers@LaserCube_Pro_2.5W@Beam_1',
  'wicked-lasers/LaserCube Pro 2.5W Wide Angle': 'Wicked Lasers/Wicked_Lasers@LaserCube_Pro_2.5W_Wide_Angle@Beam_1',
  'wicked-lasers/LaserCube 7.5W Ultra': 'Wicked Lasers/Wicked_Lasers@LaserCube_Ultra_7.5W@Beam_1',
  'wicked-lasers/LaserCube 7.5W Ultra Wide Angle': 'Wicked Lasers/Wicked_Lasers@LaserCube_Ultra_7.5W_Wide_Angle@Beam_1',
};

/**
 * Where a profile is now.
 *
 * @param {String} manufacturer
 * @param {String} model
 * @returns {Object} `{ manufacturer, model }`, unchanged for a profile that
 *   has not moved
 */
export default function movedProfile(manufacturer, model) {
  const to = MOVED_PROFILES[`${manufacturer}/${model}`];
  if (!to) return { manufacturer, model };
  const at = to.indexOf('/');
  return { manufacturer: to.slice(0, at), model: to.slice(at + 1) };
}
