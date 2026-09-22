/**
 * Optional: merge dithered pixel pairs in view cels.
 *
 * A pic needs no detection -- its visual plane stores the colour *pair*
 * per pixel, so merging is just a blend (see `BLENDED_RGB`).  A cel does
 * not: each pixel is a single 4-bit index, and the pair has to be
 * inferred from the pattern.
 *
 * This follows ScummVM's `GfxView::unditherBitmap`, whose key idea is
 * the cross-check: a combination is merged only if the *background pic*
 * used it as a dither too.  Thresholding on the sprite alone would also
 * eat deliberate chequerboard texture.
 *
 * After merging, a cel pixel holds a pair byte (>= 0x10) instead of a
 * colour index (0..15), which is why the replacement swaps the nibbles
 * when the high one is zero -- it keeps merged values out of the 0..15
 * range so the two can still be told apart.
 */
import type { Cel, View } from './view.ts';
import type { Picture } from './pic.ts';

export const CEL_THRESHOLD = 5;    // occurrences within this cel
export const PIC_THRESHOLD = 200;  // occurrences of the same pair in the background

/** How often each dither pair appears in a pic's visual plane. */
export function picHistogram(picture: Picture): Int32Array {
  const hist = new Int32Array(256);
  for (const pal of picture.visual)
    if ((pal >> 4) !== (pal & 0x0F)) hist[pal]++;
  return hist;
}

/**
 * Find runs of four alternating pixels whose next row is the reverse.
 *
 * Mirrors the original's byte arithmetic exactly -- every intermediate
 * is truncated to 8 bits, which is load-bearing.
 */
function countPairs(pix: Uint8Array, width: number, height: number): Int32Array {
  const counts = new Int32Array(256);
  if (width < 4 || height < 2) return counts;
  for (let y = 0; y < height - 1; y++) {
    let cur = y * width;
    let nxt = cur + width;
    let color1 = pix[cur];
    let color2 = ((pix[cur + 1] << 4) | pix[cur + 2]) & 0xFF;
    let next1 = (pix[nxt] << 4) & 0xFF;
    let next2 = ((pix[nxt + 2] << 4) | pix[nxt + 1]) & 0xFF;
    cur += 3;
    nxt += 3;
    for (let i = 3; i < width; i++) {
      color1 = ((color1 << 4) | (color2 >> 4)) & 0xFF;
      color2 = ((color2 << 4) | pix[cur]) & 0xFF;
      next1 = ((next1 >> 4) | (next2 << 4)) & 0xFF;
      next2 = ((next2 >> 4) | (pix[nxt] << 4)) & 0xFF;
      cur++;
      nxt++;
      if (color1 === color2 && color2 === next1 && next1 === next2) counts[color1]++;
    }
  }
  return counts;
}

/** Merge dithered pairs in place; returns the number of combinations merged. */
export function unditherCel(cel: Cel, picHist: Int32Array,
                            celThreshold = CEL_THRESHOLD,
                            picThreshold = PIC_THRESHOLD): number {
  if (cel.width < 4 || cel.height < 2) return 0;
  const counts = countPairs(cel.pixels, cel.width, cel.height);

  const table = new Uint8Array(256);
  let merged = 0;
  for (let color = 0; color < 255; color++) {
    if (counts[color] <= celThreshold || picHist[color] <= picThreshold) continue;
    const c1 = color & 0x0F, c2 = color >> 4;
    if (c1 === cel.key || c2 === cel.key || c1 === c2) continue;
    table[color] = 1;
    table[((c1 << 4) | c2) & 0xFF] = 1;
    merged++;
  }
  if (!merged) return 0;

  const pix = cel.pixels;
  for (let y = 0; y < cel.height; y++) {
    const row = y * cel.width;
    let color = pix[row];
    for (let x = 1; x < cel.width; x++) {
      const i = row + x;
      color = ((color << 4) | pix[i]) & 0xFF;
      if (!table[color]) continue;
      let out = color;
      if ((out & 0xF0) === 0) out = ((out << 4) | (out >> 4)) & 0xFF;
      pix[i - 1] = out;
      pix[i] = out;
    }
  }
  return merged;
}

export function unditherView(view: View, picHist: Int32Array,
                             celThreshold = CEL_THRESHOLD,
                             picThreshold = PIC_THRESHOLD): number {
  let total = 0;
  for (const loop of view.loops)
    for (const cel of loop)
      total += unditherCel(cel, picHist, celThreshold, picThreshold);
  return total;
}
