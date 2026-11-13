// Minimale PNG-lezer voor tests (8 bit RGB/RGBA, zonder interlacing): geeft RGBA-pixels.
const fs = require('fs');
const zlib = require('zlib');

/**
 * Leest een PNG-bestand (8 bit RGB/RGBA, zonder interlacing) naar RGBA-pixels.
 * @param {string} file Pad van het bestand.
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }} Afmetingen en pixels (4 bytes per pixel).
 */
function readPng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, width = 0, height = 0, type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0 || (body[9] !== 2 && body[9] !== 6)) throw new Error('Alleen 8-bit RGB/RGBA zonder interlacing');
      type = body[9];
    } else if (name === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? px[y * stride + x - bpp] : 0, up = y ? px[(y - 1) * stride + x] : 0, upLeft = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let value = line[x];
      if (filterType === 1) value += left;
      else if (filterType === 2) value += up;
      else if (filterType === 3) value += (left + up) >> 1;
      else if (filterType === 4) { const predictor = left + up - upLeft, pa = Math.abs(predictor - left), pb = Math.abs(predictor - up), pc = Math.abs(predictor - upLeft); value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft; }
      px[y * stride + x] = value & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 3; channel++) data[pixel * 4 + channel] = px[pixel * bpp + channel];
    data[pixel * 4 + 3] = bpp === 4 ? px[pixel * bpp + 3] : 255;
  }
  return { width, height, data };
}

module.exports = { readPng };
