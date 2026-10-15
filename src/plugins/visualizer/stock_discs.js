/**
 * @file The animation discs Beam ships, in `public/animation`, for any
 * placement to swap into an animation wheel.
 *
 * Each disc is a square image, the disc centred and filling it, black where
 * it is metal and white where light passes, transparent or white round it;
 * beside it a JSON with its title and source. Listed here because the
 * renderer cannot list a folder it is served from. Beam's own discs come
 * first, then those taken from GDTF files (`gdtf_discs.js`).
 */
import GDTF_DISCS from './gdtf_discs';

/** Where the discs are served from. */
export const ANIMATION_URL = `${import.meta.env.VITE_STATIC_URL || ''}animation/`;

/** `{ name, file, title }` per disc, `file` relative to `public/animation`. */
const STOCK_DISCS = [
  { name: 'flames', file: 'flames.png', title: 'Flames' },
  { name: 'moving', file: 'moving.png', title: 'Moving' },
  { name: 'warbly', file: 'warbly.png', title: 'Warbly' },
  ...GDTF_DISCS,
];

export default STOCK_DISCS;
