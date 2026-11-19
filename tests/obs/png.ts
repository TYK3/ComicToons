// Tiny PNG reader for the transparency check (no new dependency). Handles what Chromium
// screenshots produce: 8-bit RGBA (colour type 6) or RGB (type 2), not interlaced.
// Format: https://www.w3.org/TR/png-3/ (chunks, IHDR, IDAT, filter types 0-4).
import {inflateSync} from 'node:zlib';

export interface Rgba {width: number; height: number; data: Uint8Array}

export function decodePng(buffer: Buffer): Rgba {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG.');
  let offset = 8, width = 0, height = 0, colourType = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      const depth = body[8], interlace = body[12]; colourType = body[9]!;
      if (depth !== 8 || interlace !== 0 || (colourType !== 6 && colourType !== 2)) throw new Error(`Unsupported PNG (depth ${depth}, colour ${colourType}, interlace ${interlace}).`);
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = colourType === 6 ? 4 : 3, stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? current[x - channels]! : 0, b = previous[x]!, c = x >= channels ? previous[x - channels]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      current[x] = (line[x]! + predictor) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4, source = x * channels;
      out[target] = current[source]!; out[target + 1] = current[source + 1]!; out[target + 2] = current[source + 2]!;
      out[target + 3] = channels === 4 ? current[source + 3]! : 255;
    }
    previous = current;
  }
  return {width, height, data: out};
}

/** Share of pixels that are fully transparent, overall and in a rectangle. */
export function transparentShare(image: Rgba, box = {x: 0, y: 0, width: image.width, height: image.height}): number {
  let clear = 0, total = 0;
  for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) { total++; if (image.data[(y * image.width + x) * 4 + 3] === 0) clear++; }
  return total ? clear / total : 0;
}
