/**
 * @file Bakes one gobo image into an atlas cell's pixels, off the main
 * thread: the sharp pattern in red and two blurred copies in green and blue.
 * See gobo_library.js for the rules; this only does the drawing.
 *
 * In: `{ id, bitmap, lightOnDark, size, sigmas, aperture }`, the bitmap
 * transferred. Out: `{ id, pixels }`, RGBA bytes for one cell, transferred.
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

/** Each blur level into its own channel; luminance, so glass passes its grey. */
function pack(sharp, size, sigmas) {
  const work = new OffscreenCanvas(size, size);
  const w = work.getContext('2d', { willReadFrequently: true });
  const packed = new Uint8ClampedArray(size * size * 4);
  sigmas.forEach((sigma, level) => {
    w.filter = 'none';
    w.fillStyle = '#000';
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

// eslint-disable-next-line no-restricted-globals
self.onmessage = ({ data }) => {
  const {
    id, bitmap, lightOnDark, size, sigmas, aperture,
  } = data;
  const pixels = pack(drawSharp(bitmap, lightOnDark, size, aperture), size, sigmas);
  bitmap.close();
  // eslint-disable-next-line no-restricted-globals
  self.postMessage({ id, pixels }, [pixels.buffer]);
};
