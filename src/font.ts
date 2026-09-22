/**
 * Font and cursor resources.
 *
 *   font:   u16 0, u16 charCount, u16 lineHeight, u16 charOffset[count]
 *           char: u8 width, u8 height, then height rows of ceil(width/8)
 *           bytes, most significant bit leftmost.
 *
 * The width/height order is settled by arithmetic, not by eye: a glyph
 * occupies exactly the bytes up to the next glyph's offset, and only
 * this order makes the two agree.  Reading them the other way round
 * still renders something letter-shaped whenever the two widths need
 * the same number of bytes per row, which is most of the time.
 *
 *   cursor: u16 hotspotX, u16 hotspotY, 16x u16 plane A, 16x u16 plane B.
 *           A is the AND mask, so A=1 keeps the background: A=1 ->
 *           transparent; A=0,B=0 -> black; A=0,B=1 -> white.
 *
 * The sense of the AND mask is worth stating because getting it the
 * wrong way round still produces a plausible-looking bitmap -- SQ3's
 * arrow becomes a black square with an arrow-shaped hole -- so it is
 * settled by looking at the result, not by the byte layout alone.
 *
 * Note the char header is height first, then width -- the opposite order
 * to the way every other part of the format reports a size.
 */
const u16 = (d: Uint8Array, o: number) =>
  (o + 1 < d.length) ? (d[o] | (d[o + 1] << 8)) : 0;

export interface Glyph {
  width: number; height: number;
  /** One byte per pixel, row-major: 1 is ink. */
  bits: Uint8Array;
}

export class Font {
  data: Uint8Array;
  charCount: number;
  lineHeight: number;
  chars: Glyph[] = [];
  /** Where each glyph starts, which is what bounds its data. */
  offsets: number[] = [];

  constructor(data: Uint8Array) {
    this.data = data;
    this.charCount = u16(data, 2);
    this.lineHeight = u16(data, 4);
    for (let i = 0; i < this.charCount; i++) {
      const p = 6 + i * 2;
      if (p + 2 > data.length) break;
      const off = u16(data, p);
      this.offsets.push(off);
      this.chars.push(this.read(off));
    }
  }

  private read(off: number): Glyph {
    const d = this.data;
    if (off + 2 > d.length) return { width: 0, height: 0, bits: new Uint8Array(0) };
    const width = d[off], height = d[off + 1];
    const stride = (width + 7) >> 3;
    const bits = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const base = off + 2 + y * stride;
      for (let x = 0; x < width; x++) {
        const b = base + (x >> 3) < d.length ? d[base + (x >> 3)] : 0;
        bits[y * width + x] = (b >> (7 - (x & 7))) & 1;
      }
    }
    return { width, height, bits };
  }
}

export const CURSOR_SIZE = 16;
/** Transparent, since a cursor is drawn over the scene. */
export const CURSOR_CLEAR = -1;

export class Cursor {
  hotspotX: number;
  hotspotY: number;
  /** 16x16 row-major EGA indices, or CURSOR_CLEAR. */
  pixels: Int8Array;

  constructor(data: Uint8Array) {
    this.hotspotX = u16(data, 0);
    this.hotspotY = u16(data, 2);
    this.pixels = new Int8Array(CURSOR_SIZE * CURSOR_SIZE);
    for (let y = 0; y < CURSOR_SIZE; y++) {
      const a = u16(data, 4 + y * 2);
      const b = u16(data, 36 + y * 2);
      for (let x = 0; x < CURSOR_SIZE; x++) {
        const bit = 15 - x;
        const av = (a >> bit) & 1, bv = (b >> bit) & 1;
        this.pixels[y * CURSOR_SIZE + x] =
          av === 1 ? CURSOR_CLEAR : bv === 1 ? 15 : 0;
      }
    }
  }
}
