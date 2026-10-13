/* eslint-disable no-console */
/**
 * Measures and cuts PNGs, for comparing screenshots by numbers rather than by
 * eye. Runs under Electron, which already brings a PNG codec.
 *
 * Usage:
 *   npx electron tools/dev/png-tool.cjs diff a.png b.png [threshold]
 *     Pixels whose grey value differs by more than threshold (default 8),
 *     and the largest difference. 0 means the pictures are the same.
 *   npx electron tools/dev/png-tool.cjs crop in.png x y width height out.png
 *   npx electron tools/dev/png-tool.cjs stack out.png a.png b.png [...]
 *     One above the other, for a before-and-after; widths must match.
 *   npx electron tools/dev/png-tool.cjs row in.png y [x0 x1 step]
 *     Grey values along one row, to read an edge or a falloff.
 */
const fs = require('fs');
const { app, nativeImage } = require('electron');

function load(path) {
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) throw new Error(`cannot read ${path}`);
  return image;
}

/** Grey 0..255 of the pixel at an index into a BGRA bitmap. */
const grey = (bitmap, i) => Math.round(0.114 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.299 * bitmap[i + 2]);

const commands = {
  diff(a, b, threshold = '8') {
    const ia = load(a);
    const ib = load(b);
    const sa = ia.getSize();
    const sb = ib.getSize();
    if (sa.width !== sb.width || sa.height !== sb.height) {
      console.log(`sizes differ: ${sa.width}x${sa.height} and ${sb.width}x${sb.height}`);
      return;
    }
    const pa = ia.toBitmap();
    const pb = ib.toBitmap();
    const limit = Number(threshold);
    let changed = 0;
    let max = 0;
    for (let i = 0; i < pa.length; i += 4) {
      const d = Math.abs(grey(pa, i) - grey(pb, i));
      if (d > limit) changed += 1;
      if (d > max) max = d;
    }
    console.log(`differing > ${limit}: ${changed} of ${pa.length / 4} pixels, largest difference ${max}`);
  },

  crop(input, x, y, width, height, out) {
    const image = load(input).crop({
      x: Number(x), y: Number(y), width: Number(width), height: Number(height),
    });
    fs.writeFileSync(out, image.toPNG());
    console.log(out);
  },

  stack(out, ...inputs) {
    const images = inputs.map(load);
    const { width } = images[0].getSize();
    if (images.some((image) => image.getSize().width !== width)) throw new Error('widths differ');
    const height = images.reduce((sum, image) => sum + image.getSize().height, 0);
    const bitmap = Buffer.concat(images.map((image) => image.toBitmap()));
    fs.writeFileSync(out, nativeImage.createFromBitmap(bitmap, { width, height }).toPNG());
    console.log(out);
  },

  row(input, y, x0 = '0', x1 = '', step = '8') {
    const image = load(input);
    const { width } = image.getSize();
    const bitmap = image.toBitmap();
    const end = x1 === '' ? width : Number(x1);
    const values = [];
    for (let x = Number(x0); x < end; x += Number(step)) {
      values.push(grey(bitmap, (Number(y) * width + x) * 4));
    }
    console.log(values.join(' '));
  },
};

app.whenReady().then(() => {
  const [command, ...args] = process.argv.slice(2).filter((arg) => !arg.endsWith('png-tool.cjs'));
  try {
    if (!commands[command]) throw new Error(`commands: ${Object.keys(commands).join(', ')}`);
    commands[command](...args);
  } catch (err) {
    console.log(err.message);
  }
  app.quit();
});
