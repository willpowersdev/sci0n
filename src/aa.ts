/**
 * Morphological anti-aliasing (MLAA, after Reshetov 2009).
 *
 * Not a blur and not a rescale: it finds the staircases along colour
 * discontinuities, works out how much of each edge pixel a straight line
 * through the step pattern would actually cover, and blends by that
 * coverage.  Axis-aligned edges have no staircase and are left
 * untouched, which is what keeps pixel art crisp where it should be.
 *
 *   1. mark separating lines between differing neighbours, horizontally
 *      and vertically
 *   2. walk each maximal run of collinear separators
 *   3. look at what the edge does at each end of the run -- turn up,
 *      turn down, or nothing.  That end cap decides which side of the
 *      line the re-constructed triangle lies on
 *   4. blend each pixel under the triangle across the line by its area
 *
 * Run this on undithered art.  A chequerboard is discontinuous at every
 * pixel, so dithered input gives the edge detector nothing to work with.
 */

/** Area of the step triangle over pixel j, counted from the apex end. */
function coverage(n: number, j: number): number {
  const a = 0.5 * (1.0 - (j + 0.5) / n);
  return a > 0 ? a : 0;
}

/** RGB planes held as floats so repeated blends do not quantise. */
interface Plane { w: number; h: number; d: Float64Array }

function blend(out: Plane, ty: number, tx: number, oy: number, ox: number, a: number) {
  if (a <= 0) return;
  const t = (ty * out.w + tx) * 3, o = (oy * out.w + ox) * 3;
  for (let c = 0; c < 3; c++)
    out.d[t + c] = out.d[t + c] * (1 - a) + out.d[o + c] * a;
}

/**
 * One direction.  `sep` are the separators being walked, `perp` the ones
 * used to read end caps.
 */
function pass(out: Plane, sep: Uint8Array, perp: Uint8Array,
              horizontal: boolean, maxRun: number) {
  const h = out.h, w = out.w;
  const outerEnd = horizontal ? h : w;
  const inner = horizontal ? w : h;
  const at = (y: number, x: number) => sep[y * w + x];
  const atPerp = (y: number, x: number) => perp[y * w + x];

  for (let a = 1; a < outerEnd; a++) {
    let x = 0;
    while (x < inner) {
      const here = horizontal ? at(a, x) : at(x, a);
      if (!here) { x++; continue; }
      const start = x;
      while (x < inner && (horizontal ? at(a, x) : at(x, a))) x++;
      const length = x - start;
      if (length > maxRun) continue;

      // End caps: does the edge turn off the line here, and which way?
      const cap = (pos: number): number => {
        if (pos <= 0 || pos >= inner) return 0;
        const up = horizontal ? (a - 1 < h ? atPerp(a - 1, pos) : 0)
                              : (a - 1 < w ? atPerp(pos, a - 1) : 0);
        const dn = horizontal ? (a < h ? atPerp(a, pos) : 0)
                              : (a < w ? atPerp(pos, a) : 0);
        if (up && !dn) return -1;
        if (dn && !up) return 1;
        return 0;
      };

      const left = cap(start), right = cap(x);
      if (left === 0 && right === 0) continue;

      // Which pixels the triangle covers, and on which side.
      const spans: Array<[number, number, number, boolean]> = [];
      if (left && right) {
        const n1 = Math.floor((length + 1) / 2);
        const n2 = length - n1;
        if (n1) spans.push([start, n1, left, false]);
        if (n2) spans.push([start + n1, n2, right, true]);
      } else if (left) {
        spans.push([start, length, left, false]);
      } else {
        spans.push([start, length, right, true]);
      }

      for (const [s0, n, side, fromRight] of spans) {
        for (let k = 0; k < n; k++) {
          const j = fromRight ? (n - 1 - k) : k;
          const cov = coverage(n, j);
          if (cov <= 0) continue;
          const pos = s0 + k;
          if (horizontal) {
            // the line sits between rows a-1 and a, at column pos
            if (side < 0) blend(out, a - 1, pos, a, pos, cov);
            else blend(out, a, pos, a - 1, pos, cov);
          } else {
            // the line sits between columns a-1 and a, at row pos
            if (side < 0) blend(out, pos, a - 1, pos, a, cov);
            else blend(out, pos, a, pos, a - 1, cov);
          }
        }
      }
    }
  }
}

/**
 * `rgb` is width*height*3 bytes in, the same out.
 *
 * `threshold` is a luma difference; 0 treats any colour change as an
 * edge, which is right for flat indexed art.
 */
export function mlaa(rgb: Uint8Array, width: number, height: number,
                     threshold = 12, maxRun = 64): Uint8Array {
  const n = width * height;
  const out: Plane = { w: width, h: height, d: new Float64Array(n * 3) };
  const luma = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    out.d[i * 3] = r; out.d[i * 3 + 1] = g; out.d[i * 3 + 2] = b;
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  const hsep = new Uint8Array(n);   // between row a-1 and a
  const vsep = new Uint8Array(n);   // between col a-1 and a
  for (let y = 1; y < height; y++)
    for (let x = 0; x < width; x++)
      hsep[y * width + x] = Math.abs(luma[y * width + x] - luma[(y - 1) * width + x]) > threshold ? 1 : 0;
  for (let y = 0; y < height; y++)
    for (let x = 1; x < width; x++)
      vsep[y * width + x] = Math.abs(luma[y * width + x] - luma[y * width + x - 1]) > threshold ? 1 : 0;

  pass(out, hsep, vsep, true, maxRun);
  pass(out, vsep, hsep, false, maxRun);

  const res = new Uint8Array(n * 3);
  for (let i = 0; i < n * 3; i++)
    res[i] = Math.max(0, Math.min(255, Math.floor(out.d[i] + 0.5)));
  return res;
}
