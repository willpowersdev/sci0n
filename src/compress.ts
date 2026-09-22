/**
 * The three SCI0-era decompressors.
 *
 * Which codec a method id means is version-dependent, so the probe
 * variants also report how many input bytes they consumed: output length
 * alone is not enough to identify a codec, because a wrong one happily
 * fills the output buffer with noise.
 */

class BitsMSB {
  private d: Uint8Array;
  private p = 0; private acc = 0; private n = 0;
  constructor(d: Uint8Array, pos = 0) { this.d = d; this.p = pos; }
  get consumed() { return this.p; }
  bits(count: number): number {
    while (this.n < count) {
      this.acc = (this.acc * 256) + (this.p < this.d.length ? this.d[this.p] : 0);
      this.p++; this.n += 8;
    }
    this.n -= count;
    const v = Math.floor(this.acc / Math.pow(2, this.n)) & ((1 << count) - 1);
    this.acc = this.acc % Math.pow(2, this.n);
    return v;
  }
}

class BitsLSB {
  private d: Uint8Array;
  private p = 0; private acc = 0; private n = 0;
  constructor(d: Uint8Array, pos = 0) { this.d = d; this.p = pos; }
  get consumed() { return this.p; }
  bits(count: number): number {
    while (this.n < count) {
      this.acc += (this.p < this.d.length ? this.d[this.p] : 0) * Math.pow(2, this.n);
      this.p++; this.n += 8;
    }
    const v = this.acc % Math.pow(2, count);
    this.acc = Math.floor(this.acc / Math.pow(2, count));
    this.n -= count;
    return v;
  }
}

/**
 * Shared LZW core.  The dictionary stores (offset, length) slices of the
 * output produced so far rather than strings, and the stored length is
 * `written + 1` -- which is what makes the self-referencing KwKwK case
 * fall out without a special path.
 */
function lzwCore(data: Uint8Array, size: number, msb: boolean): [Uint8Array, number] {
  const r = msb ? new BitsMSB(data) : new BitsLSB(data);
  const out = new Uint8Array(size);
  let n = 0;
  const offs = new Int32Array(4096);
  const lens = new Int32Array(4096);
  let width = 9, table = 258;
  let limit = msb ? 511 : 512;

  while (n < size) {
    const code = r.bits(width);
    if (code >= table || code === 257) break;
    if (code === 256) { width = 9; table = 258; limit = msb ? 511 : 512; continue; }
    const start = n;
    if (code <= 255) {
      out[n++] = code;
    } else {
      const src = offs[code];
      for (let k = 0; k < lens[code] && n < size; k++) out[n++] = out[src + k];
    }
    if (table >= 4096) continue;
    if (table === limit && width < 12) { width++; limit = (1 << width) - (msb ? 1 : 0); }
    offs[table] = start; lens[table] = n - start + 1; table++;
  }
  return [out.subarray(0, n), r.consumed];
}

export function lzw(d: Uint8Array, size: number) { return lzwCore(d, size, false)[0]; }
export function lzw1(d: Uint8Array, size: number) { return lzwCore(d, size, true)[0]; }
export const lzwProbe = (d: Uint8Array, s: number) => lzwCore(d, s, false);
export const lzw1Probe = (d: Uint8Array, s: number) => lzwCore(d, s, true);

/**
 * Huffman with the tree carried in the resource: u8 node_count,
 * u8 terminator, then 2-byte (value, siblings) nodes.  `siblings` packs
 * the relative index of the left child in the high nibble and the right
 * in the low; a right index of 0 escapes to a raw 8-bit literal.
 */
function huffmanCore(data: Uint8Array, size: number): [Uint8Array, number] {
  if (data.length < 2) return [new Uint8Array(0), 0];
  const count = data[0], term = data[1] | 0x100;
  const nodes = data.subarray(2, 2 + count * 2);
  const r = new BitsMSB(data, 2 + count * 2);
  const out = new Uint8Array(size);
  let n = 0;
  while (n < size) {
    let node = 0, c = 0;
    for (;;) {
      const sib = node * 2 + 1 < nodes.length ? nodes[node * 2 + 1] : 0;
      if (sib === 0) { c = node * 2 < nodes.length ? nodes[node * 2] : 0; break; }
      let next: number;
      if (r.bits(1)) {
        next = sib & 0x0F;
        if (next === 0) { c = r.bits(8) | 0x100; break; }
      } else next = sib >> 4;
      node += next;
    }
    if (c === term) break;
    out[n++] = c & 0xFF;
    if (r.consumed > data.length) break;
  }
  return [out.subarray(0, n), r.consumed];
}

export function huffman(d: Uint8Array, size: number) { return huffmanCore(d, size)[0]; }
export const huffmanProbe = huffmanCore;
