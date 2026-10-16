/**
 * @file Bakes one gobo or animation disc image into an atlas cell's pixels,
 * off the main thread: the sharp pattern in red and two blurred copies in
 * green and blue. See gobo_library.js and animation_wheel.js for the rules;
 * this only does the drawing.
 *
 * In: `{ id, bitmap, disc, lightOnDark, size, sigmas, aperture }`, the bitmap
 * transferred; `disc` for an animation disc, drawn whole over white. Out:
 * `{ id, pixels }`, RGBA bytes for one cell, transferred.
 */

/**
 * Where the image's metal disc sits, as a box in fractions of the image:
 * the bounds of its dark pixels. Several images draw the disc short of
 * their edge on a white ground, and not always centred, so the margin
 * differs side to side. For an image dark to its edges, or whose dark
 * pixels are a pattern rather than a disc (a margin over 8% on any side, or
 * a box far from square), the whole image.
 *
 * @param {ImageBitmap} image
 * @returns {Object} `{ x, y, w, h }` in fractions of the image
 */
function discBox(image) {
  const size = 256;
  const probe = new OffscreenCanvas(size, size);
  const p = probe.getContext('2d', { willReadFrequently: true });
  p.fillStyle = '#fff';
  p.fillRect(0, 0, size, size);
  p.drawImage(image, 0, 0, size, size);
  const px = p.getImageData(0, 0, size, size).data;
  let minX = size; let minY = size; let maxX = -1; let maxY = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (px[(y * size + x) * 4] < 64) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const whole = {
    x: 0, y: 0, w: 1, h: 1,
  };
  if (maxX < 0) return whole;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const margin = Math.max(minX, minY, size - 1 - maxX, size - 1 - maxY) / size;
  if (margin > 0.08 || Math.abs(w - h) > size * 0.03) return whole;
  return {
    x: minX / size, y: minY / size, w: w / size, h: h / size,
  };
}

/**
 * The sharp pattern. An OFL image is black metal on white or on nothing, so
 * it goes over white, refitted so its metal disc fills the cell; a GDTF image
 * is white light on black or on nothing and is already the whole aperture,
 * so it goes over black as it is. Either way nothing passes outside the
 * round aperture.
 */
function drawSharp(image, lightOnDark, size, aperture) {
  const sharp = new OffscreenCanvas(size, size);
  const s = sharp.getContext('2d');
  // A proper downscale: a fixture's own wheel images run to 1024 px, and the
  // default filter samples a few source pixels per cell pixel, which drew
  // round dots as ragged polygons.
  s.imageSmoothingEnabled = true;
  s.imageSmoothingQuality = 'high';
  s.fillStyle = lightOnDark ? '#000' : '#fff';
  s.fillRect(0, 0, size, size);
  if (lightOnDark) {
    s.drawImage(image, 0, 0, size, size);
  } else {
    // Placed so the metal disc fills the cell, centred: a margin left round
    // a disc drawn short passed light as a crescent that turned with it.
    const box = discBox(image);
    const scaleX = size / box.w;
    const scaleY = size / box.h;
    s.drawImage(image, -box.x * scaleX, -box.y * scaleY, scaleX, scaleY);
  }
  // Nothing passes outside the round aperture: white corners or a sliver of
  // ground showed as a faint ring round the pool, worse once blurred.
  const centre = size / 2;
  s.fillStyle = '#000';
  s.beginPath();
  s.rect(0, 0, size, size);
  s.arc(centre, centre, centre * aperture, 0, Math.PI * 2);
  s.fill('evenodd');
  return sharp;
}

/**
 * An animation disc: the whole image over white, so whatever it leaves
 * transparent passes light, stretched to the cell because its window path
 * is in the image's own coordinates, -1 to 1 along each side. The disc is
 * round: outside its inscribed circle is open whatever the image's corners
 * hold, set before the blur so every level holds the disc's real edge.
 */
function drawDisc(image, size) {
  const sharp = new OffscreenCanvas(size, size);
  const s = sharp.getContext('2d');
  s.imageSmoothingEnabled = true;
  s.imageSmoothingQuality = 'high';
  s.fillStyle = '#fff';
  s.fillRect(0, 0, size, size);
  s.drawImage(image, 0, 0, size, size);
  const centre = size / 2;
  s.beginPath();
  s.rect(0, 0, size, size);
  s.arc(centre, centre, centre, 0, Math.PI * 2);
  s.fill('evenodd');
  return sharp;
}

/**
 * Each blur level into its own channel; luminance, so glass passes its
 * grey. The ground is what the blur pulls in past the cell's edge: metal
 * for a gobo, open for a disc.
 */
function pack(sharp, size, sigmas, ground) {
  const work = new OffscreenCanvas(size, size);
  const w = work.getContext('2d', { willReadFrequently: true });
  const packed = new Uint8ClampedArray(size * size * 4);
  sigmas.forEach((sigma, level) => {
    w.filter = 'none';
    w.fillStyle = ground;
    w.fillRect(0, 0, size, size);
    w.filter = sigma > 0 ? `blur(${sigma}px)` : 'none';
    w.drawImage(sharp, 0, 0);
    const pixels = w.getImageData(0, 0, size, size).data;
    for (let i = 0; i < pixels.length; i += 4) {
      packed[i + level] = 0.3 * pixels[i] + 0.59 * pixels[i + 1] + 0.11 * pixels[i + 2];
    }
  });
  for (let i = 3; i < packed.length; i += 4) packed[i] = 255;
  return packed;
}

/**
 * What a disc's image says about its glass, from the packed levels: whether
 * it is glass (mostly mid greys inside the circle, where a metal stencil is
 * black and white), its feature size in disc radii (the mean run between
 * crossings of the sharp level over the softest), its low and high
 * levels (5th and 95th percentiles), its mean, and how much its features run
 * one way across the whole disc and at what angle (structure tensor of the
 * soft level).
 */
function measureDisc(pixels, size) {
  const step = 4;
  const n = Math.floor(size / step);
  const centre = n / 2;
  const at = (x, y, level) => pixels[((y * step) * size + x * step) * 4 + level];
  const hist = new Array(256).fill(0);
  let count = 0;
  let sum = 0;
  let grey = 0;
  let crossings = 0;
  let run = 0;
  let jxx = 0;
  let jyy = 0;
  let jxy = 0;
  const inside = (x, y) => Math.hypot(x - centre + 0.5, y - centre + 0.5) < centre * 0.85;
  for (let y = 1; y < n - 1; y += 1) {
    let previous = 0;
    for (let x = 1; x < n - 1; x += 1) {
      if (inside(x, y)) {
        const v = at(x, y, 0);
        hist[v] += 1;
        count += 1;
        sum += v;
        if (v > 40 && v < 215) grey += 1;
        // Above or below the softest level, with a dead band against noise.
        const high = v - at(x, y, 2);
        const sign = Math.abs(high) > 4 ? Math.sign(high) : 0;
        if (sign !== 0) {
          if (previous !== 0 && sign !== previous) crossings += 1;
          previous = sign;
        }
        run += 1;
        const gx = at(x + 1, y, 1) - at(x - 1, y, 1);
        const gy = at(x, y + 1, 1) - at(x, y - 1, 1);
        jxx += gx * gx;
        jyy += gy * gy;
        jxy += gx * gy;
      } else {
        previous = 0;
      }
    }
  }
  if (!count) return null;
  const percentile = (p) => {
    let target = p * count;
    for (let v = 0; v < 256; v += 1) {
      target -= hist[v];
      if (target <= 0) return v / 255;
    }
    return 1;
  };
  // A run of samples is step pixels each, a disc radius size / 2 pixels.
  const runRadii = (run * step) / (size / 2);
  const tr = jxx + jyy;
  return {
    glass: grey / count > 0.12,
    // The mean run between crossings: half a period by count, but crossings
    // inside the dead band go uncounted, and this matches the median of the
    // image's spectrum on the discs checked.
    size: crossings > 0 ? Math.min(Math.max(runRadii / crossings, 0.02), 1) : 0.3,
    low: percentile(0.05),
    high: percentile(0.95),
    mean: sum / count / 255,
    stretch: tr > 0 ? Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / tr : 0,
    // Along the features: across the mean gradient, in the image's own
    // coordinates, y down.
    angle: 0.5 * Math.atan2(2 * jxy, jxx - jyy) + Math.PI / 2,
  };
}

// eslint-disable-next-line no-restricted-globals
self.onmessage = ({ data }) => {
  const {
    id, bitmap, disc, lightOnDark, size, sigmas, aperture,
  } = data;
  const pixels = disc
    ? pack(drawDisc(bitmap, size), size, sigmas, '#fff')
    : pack(drawSharp(bitmap, lightOnDark, size, aperture), size, sigmas, '#000');
  bitmap.close();
  const stats = disc ? measureDisc(pixels, size) : null;
  // eslint-disable-next-line no-restricted-globals
  self.postMessage({ id, pixels, stats }, [pixels.buffer]);
};
