// PNG decode/encode + RGBA pixel diff for the visual harness.
// pixelmatch is not in the dependency tree; this is a deliberately simple,
// dependency-free diff (pngjs arrives transitively via qrcode and is only
// used for decode/encode).

import * as fs from 'node:fs';
import { PNG } from 'pngjs';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Buffer;
}

export function readPng(filePath: string): DecodedPng {
  const png = PNG.sync.read(fs.readFileSync(filePath));
  return { width: png.width, height: png.height, data: png.data };
}

export function decodePng(buffer: Buffer): DecodedPng {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

export interface DiffResult {
  /** Pixels whose max per-channel delta exceeds the tolerance. */
  changedPixels: number;
  totalPixels: number;
  /** Largest per-channel delta observed anywhere in the image pair. */
  maxChannelDelta: number;
  /** Bounding box of thresholded changed pixels (inclusive), if any. */
  changedBBox?: { x0: number; y0: number; x1: number; y1: number };
  /** Set when dimensions differ — the diff is then meaningless. */
  dimensionMismatch?: { a: string; b: string };
}

/**
 * Compare two RGBA images. A pixel counts as changed when any channel differs
 * by more than `tolerance` (0-255). Returns per-pair stats; optionally writes
 * a red-on-faded-baseline diff visualization to `diffOutPath`.
 */
export function diffPng(
  a: DecodedPng,
  b: DecodedPng,
  tolerance: number,
  diffOutPath?: string,
): DiffResult {
  if (a.width !== b.width || a.height !== b.height) {
    return {
      changedPixels: Number.MAX_SAFE_INTEGER,
      totalPixels: a.width * a.height,
      maxChannelDelta: 255,
      dimensionMismatch: { a: `${a.width}x${a.height}`, b: `${b.width}x${b.height}` },
    };
  }
  const total = a.width * a.height;
  let changed = 0;
  let maxDelta = 0;
  let minX = Number.MAX_SAFE_INTEGER;
  let minY = Number.MAX_SAFE_INTEGER;
  let maxX = -1;
  let maxY = -1;
  const diff = diffOutPath ? new PNG({ width: a.width, height: a.height }) : null;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const dr = Math.abs(a.data[o] - b.data[o]);
    const dg = Math.abs(a.data[o + 1] - b.data[o + 1]);
    const db = Math.abs(a.data[o + 2] - b.data[o + 2]);
    const da = Math.abs(a.data[o + 3] - b.data[o + 3]);
    const d = Math.max(dr, dg, db, da);
    if (d > maxDelta) maxDelta = d;
    const isChanged = d > tolerance;
    if (isChanged) {
      changed++;
      const x = i % a.width;
      const y = Math.floor(i / a.width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (diff) {
      if (isChanged) {
        diff.data[o] = 255;
        diff.data[o + 1] = 0;
        diff.data[o + 2] = 0;
        diff.data[o + 3] = 255;
      } else {
        // Faded grayscale baseline for context.
        const gray = Math.round((a.data[o] + a.data[o + 1] + a.data[o + 2]) / 3);
        const faded = Math.round(gray * 0.25 + 255 * 0.75);
        diff.data[o] = faded;
        diff.data[o + 1] = faded;
        diff.data[o + 2] = faded;
        diff.data[o + 3] = 255;
      }
    }
  }
  if (diff && diffOutPath) {
    fs.writeFileSync(diffOutPath, PNG.sync.write(diff));
  }
  return {
    changedPixels: changed,
    totalPixels: total,
    maxChannelDelta: maxDelta,
    ...(changed > 0 ? { changedBBox: { x0: minX, y0: minY, x1: maxX, y1: maxY } } : {}),
  };
}
