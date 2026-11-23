/**
 * A small PNG codec and pixel comparison.
 *
 * It reads what the pinned Chromium screenshot writes (8-bit RGB or RGBA,
 * non-interlaced) and writes RGBA. Anything else is refused by name rather
 * than decoded approximately, because a comparison over wrongly decoded
 * pixels would be a false result.
 *
 * The comparison follows the common per-pixel rule: two pixels differ when
 * their YIQ colour distance exceeds a threshold between 0 and 1. Both the
 * threshold and the ratio of differing pixels are recorded with every result
 * (docs/SPEC.md section 8).
 */

import { crc32, deflateSync, inflateSync } from 'node:zlib';

export interface Image {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): Image {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');

  let width = 0;
  let height = 0;
  let channels = 0;
  const compressed: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${interlace})`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      compressed.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (channels === 0 || width === 0 || height === 0) throw new Error('PNG has no usable header');

  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG pixel data is truncated');

  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? (pixels[row + x - channels] as number) : 0;
      const up = y > 0 ? (pixels[row - stride + x] as number) : 0;
      const upLeft = y > 0 && x >= channels ? (pixels[row - stride + x - channels] as number) : 0;
      const value = raw[source + x] as number;
      let predicted: number;
      if (filter === 0) predicted = 0;
      else if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      else throw new Error(`unknown PNG filter ${filter}`);
      pixels[row + x] = (value + predicted) & 0xff;
    }
  }

  if (channels === 4) return { width, height, data: pixels };
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = pixels[index * 3] as number;
    data[index * 4 + 1] = pixels[index * 3 + 1] as number;
    data[index * 4 + 2] = pixels[index * 3 + 2] as number;
    data[index * 4 + 3] = 255;
  }
  return { width, height, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

export function encodePng(image: Image): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return new Uint8Array(
    Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
  );
}

export interface PixelComparison {
  width: number;
  height: number;
  /** The two images have the same dimensions. */
  sameSize: boolean;
  comparedPixels: number;
  differingPixels: number;
  /** Differing pixels over the union area. Area present in only one image counts as differing. */
  ratio: number;
  /** The smallest rectangle holding every differing pixel, or null when none differ. */
  bounds: { x: number; y: number; width: number; height: number } | null;
  /** Reference faded to grey, differing pixels in red. */
  diff: Image;
}

/** Squared YIQ distance of two opaque colours, after blending alpha over white. */
function colorDelta(a: Uint8Array, i: number, b: Uint8Array, j: number): number {
  const blend = (value: number, alpha: number): number => 255 + ((value - 255) * alpha) / 255;
  const aAlpha = a[i + 3] as number;
  const bAlpha = b[j + 3] as number;
  const dr = blend(a[i] as number, aAlpha) - blend(b[j] as number, bAlpha);
  const dg = blend(a[i + 1] as number, aAlpha) - blend(b[j + 1] as number, bAlpha);
  const db = blend(a[i + 2] as number, aAlpha) - blend(b[j + 2] as number, bAlpha);
  const y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
  const iq = dr * 0.59597799 - dg * 0.2741761 - db * 0.32180189;
  const q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
  return 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
}

/** The largest possible squared YIQ distance, black against white. */
const MAX_DELTA = 35215;

export function compareImages(reference: Image, candidate: Image, pixelThreshold: number): PixelComparison {
  const width = Math.max(reference.width, candidate.width);
  const height = Math.max(reference.height, candidate.height);
  const limit = MAX_DELTA * pixelThreshold * pixelThreshold;
  const diff: Image = { width, height, data: new Uint8Array(width * height * 4) };

  let differing = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inReference = x < reference.width && y < reference.height;
      const inCandidate = x < candidate.width && y < candidate.height;
      const r = (y * reference.width + x) * 4;
      const c = (y * candidate.width + x) * 4;
      const out = (y * width + x) * 4;
      const differs = !inReference || !inCandidate || colorDelta(reference.data, r, candidate.data, c) > limit;
      if (differs) {
        differing += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        diff.data.set([255, 0, 0, 255], out);
      } else {
        const grey = 255 - (255 - ((reference.data[r] as number) + (reference.data[r + 1] as number) + (reference.data[r + 2] as number)) / 3) / 4;
        diff.data.set([grey, grey, grey, 255], out);
      }
    }
  }

  return {
    width,
    height,
    sameSize: reference.width === candidate.width && reference.height === candidate.height,
    comparedPixels: width * height,
    differingPixels: differing,
    ratio: width * height === 0 ? 0 : differing / (width * height),
    bounds: differing === 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    diff,
  };
}
