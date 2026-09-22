/**
 * SCI0 view resource -> cels.
 *
 *   view  u16 loopCount, u16 mirrorMask, 4 unused, u16 loopOffset[]
 *   loop  u16 celCount, u16 unused, u16 celOffset[]
 *   cel   u16 w, u16 h, s8 xShift, s8 yShift, u8 transparent, RLE...
 *
 * RLE is one byte per run: (length << 4) | colour, as a SINGLE flat
 * stream over w*h pixels.  Runs cross row boundaries freely, so decoding
 * row-by-row is wrong.
 */
export class Cel {
  width: number; height: number;
  xShift: number; yShift: number;
  key: number; pixels: Uint8Array;
  loop: number; index: number; mirrored: boolean;
  constructor(w: number, h: number, xs: number, ys: number, key: number,
              pixels: Uint8Array, loop: number, index: number, mirrored: boolean) {
    this.width = w; this.height = h; this.xShift = xs; this.yShift = ys;
    this.key = key; this.pixels = pixels;
    this.loop = loop; this.index = index; this.mirrored = mirrored;
  }
}

const u16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);

export class View {
  data: Uint8Array;
  loopCount: number;
  mirrorMask: number;
  loops: Cel[][] = [];

  constructor(data: Uint8Array) {
    if (data.length < 8) throw new Error('view too small');
    this.data = data;
    this.loopCount = u16(data, 0);
    this.mirrorMask = u16(data, 2);
    for (let i = 0; i < this.loopCount; i++) {
      const o = 8 + i * 2;
      if (o + 2 > data.length) break;
      this.loops.push(this.readLoop(u16(data, o), i));
    }
  }

  private readLoop(off: number, loopIndex: number): Cel[] {
    const d = this.data;
    if (off + 4 > d.length) return [];
    const n = u16(d, off);
    const mirrored = (this.mirrorMask & (1 << loopIndex)) !== 0;
    const cels: Cel[] = [];
    for (let i = 0; i < n; i++) {
      const p = off + 4 + i * 2;
      if (p + 2 > d.length) break;
      cels.push(this.readCel(u16(d, p), loopIndex, i, mirrored));
    }
    return cels;
  }

  private readCel(off: number, loop: number, index: number, mirrored: boolean): Cel {
    const d = this.data;
    const w = u16(d, off), h = u16(d, off + 2);
    const xs = d[off + 4] > 127 ? d[off + 4] - 256 : d[off + 4];
    const ys = d[off + 5] > 127 ? d[off + 5] - 256 : d[off + 5];
    const key = d[off + 6];
    let p = off + 7;
    const total = w * h;
    let pixels = new Uint8Array(total);
    let n = 0;
    while (n < total && p < d.length) {
      const b = d[p++];
      const run = b >> 4, colour = b & 0x0F;
      if (!run) continue;
      const end = Math.min(n + run, total);
      if (colour) pixels.fill(colour, n, end);
      n += run;
    }
    if (mirrored) {
      const flipped = new Uint8Array(total);
      for (let row = 0; row < h; row++) {
        const s = row * w;
        for (let x = 0; x < w; x++) flipped[s + x] = pixels[s + w - 1 - x];
      }
      pixels = flipped;
    }
    return new Cel(w, h, xs, ys, key, pixels, loop, index, mirrored);
  }

  *allCels(): Generator<Cel> {
    for (const loop of this.loops) for (const cel of loop) yield cel;
  }
}
