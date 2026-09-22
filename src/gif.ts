/**
 * A GIF89a encoder, enough for indexed animation.
 *
 * SCI art is already indexed -- sixteen EGA colours plus a transparent
 * key -- so GIF is close to a native container for it: no quantisation,
 * no colour loss, and per-frame transparency comes for free.
 *
 * The only real work is GIF's variable-width LZW, which packs codes
 * least-significant-bit first and grows the code width as the dictionary
 * fills.  Getting the moment of that growth wrong by one still produces
 * a file most decoders will open, so the encoder is checked by decoding
 * its own output back to the exact pixels (see test/gif.ts).
 */

export interface Frame {
  /** One palette index per pixel, width*height of them. */
  pixels: Uint8Array;
  /** Hundredths of a second this frame is shown. */
  delayCs: number;
  /** Palette index to leave transparent, or -1 for none. */
  transparent?: number;
}

/** Codes are packed LSB-first and the stream is cut into 255-byte blocks. */
class BitWriter {
  private out: number[] = [];
  private cur = 0;
  private bits = 0;
  write(code: number, width: number) {
    this.cur |= code << this.bits;
    this.bits += width;
    while (this.bits >= 8) {
      this.out.push(this.cur & 0xFF);
      this.cur >>= 8;
      this.bits -= 8;
    }
  }
  finish(): number[] {
    if (this.bits > 0) { this.out.push(this.cur & 0xFF); this.cur = 0; this.bits = 0; }
    return this.out;
  }
}

function lzw(pixels: Uint8Array, minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const bw = new BitWriter();
  let dict = new Map<number, number>();
  let codeSize = minCodeSize + 1;
  let next = end + 1;

  bw.write(clear, codeSize);
  if (pixels.length === 0) { bw.write(end, codeSize); return bw.finish(); }

  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i];
    const key = (prefix << 8) | k;
    const have = dict.get(key);
    if (have !== undefined) { prefix = have; continue; }
    bw.write(prefix, codeSize);
    if (next < 4096) {
      dict.set(key, next);
      next++;
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      // The dictionary is full: tell the decoder to start over, or the
      // two sides stop agreeing on what any code means.
      bw.write(clear, codeSize);
      dict = new Map();
      codeSize = minCodeSize + 1;
      next = end + 1;
    }
    prefix = k;
  }
  bw.write(prefix, codeSize);
  bw.write(end, codeSize);
  return bw.finish();
}

function subBlocks(data: number[], out: number[]) {
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
}

export interface GifOptions {
  width: number;
  height: number;
  /** Up to 256 RGB triples. */
  palette: ReadonlyArray<readonly [number, number, number]>;
  frames: Frame[];
  /** 0 loops forever. */
  loop?: number;
}

export function encodeGIF(opts: GifOptions): Uint8Array {
  const { width, height, palette, frames } = opts;
  const loop = opts.loop ?? 0;
  // The table size is a power of two and at least four entries.
  let bits = 2;
  while ((1 << bits) < palette.length) bits++;
  const tableSize = 1 << bits;
  const out: number[] = [];

  for (const c of 'GIF89a') out.push(c.charCodeAt(0));
  out.push(width & 0xFF, width >> 8, height & 0xFF, height >> 8);
  out.push(0x80 | ((bits - 1) << 4) | (bits - 1));   // global table, 2^bits entries
  out.push(0, 0);                                    // background, pixel aspect
  for (let i = 0; i < tableSize; i++) {
    const c = palette[i] ?? [0, 0, 0];
    out.push(c[0], c[1], c[2]);
  }

  if (frames.length > 1) {
    // NETSCAPE2.0, the de-facto way to say "loop".
    out.push(0x21, 0xFF, 0x0B);
    for (const c of 'NETSCAPE2.0') out.push(c.charCodeAt(0));
    out.push(0x03, 0x01, loop & 0xFF, (loop >> 8) & 0xFF, 0x00);
  }

  for (const f of frames) {
    const t = f.transparent ?? -1;
    const hasT = t >= 0 ? 1 : 0;
    // Disposal 2 clears the frame back to the background first, so a
    // transparent pixel shows the background rather than whatever the
    // previous frame left there.
    out.push(0x21, 0xF9, 0x04, (2 << 2) | hasT,
             f.delayCs & 0xFF, (f.delayCs >> 8) & 0xFF, hasT ? t : 0, 0x00);
    out.push(0x2C, 0, 0, 0, 0, width & 0xFF, width >> 8, height & 0xFF, height >> 8, 0x00);
    const minCodeSize = Math.max(2, bits);
    out.push(minCodeSize);
    subBlocks(lzw(f.pixels, minCodeSize), out);
  }
  out.push(0x3B);
  return Uint8Array.from(out);
}
