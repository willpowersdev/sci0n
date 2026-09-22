/**
 * The GIF encoder, checked by decoding its own output.
 *
 * There is no reference implementation to diff against here, so the
 * assertion has to come from the format itself: a decoder written
 * independently of the encoder reads the file back and the pixels must
 * be identical, frame for frame.  That is what catches the failure this
 * code is actually prone to -- growing the LZW code width one code too
 * early or too late, which still yields a file many viewers will open.
 *
 * Real view cels are used as well as synthetic worst cases: one of them
 * is large enough that the dictionary genuinely fills, which is the only
 * way the encoder's table-reset path gets exercised at all.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { View } from '../src/view.ts';
import { EGA_RGB } from '../src/ega.ts';
import { encodeGIF, type Frame } from '../src/gif.ts';
import { ROOT } from './games.ts';

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

/** A minimal GIF89a reader: enough to recover indices and frame timing. */
function decodeGIF(d: Uint8Array) {
  let p = 0;
  const str = (n: number) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d[p++]); return s; };
  const u8 = () => d[p++];
  const u16 = () => { const v = d[p] | (d[p + 1] << 8); p += 2; return v; };
  if (str(6) !== 'GIF89a') throw new Error('not GIF89a');
  const width = u16(), height = u16();
  const packed = u8(); u8(); u8();
  const gctSize = 1 << ((packed & 7) + 1);
  const palette: Array<[number, number, number]> = [];
  for (let i = 0; i < gctSize; i++) palette.push([u8(), u8(), u8()]);

  const frames: Array<{ pixels: Uint8Array; delayCs: number; transparent: number }> = [];
  let delayCs = 0, transparent = -1;
  for (;;) {
    const b = u8();
    if (b === 0x3B) break;
    if (b === 0x21) {
      const label = u8();
      if (label === 0xF9) {
        const len = u8(); const flags = u8();
        delayCs = u16(); const t = u8(); u8();
        transparent = (flags & 1) ? t : -1;
        if (len !== 4) throw new Error('bad graphic control block');
      } else {
        for (;;) { const n = u8(); if (!n) break; p += n; }
      }
      continue;
    }
    if (b !== 0x2C) throw new Error(`unexpected block 0x${b.toString(16)}`);
    u16(); u16();                                  // left, top
    const fw = u16(), fh = u16();
    const fp = u8();
    if (fp & 0x80) throw new Error('local colour table not expected');
    const minCodeSize = u8();
    const data: number[] = [];
    for (;;) { const n = u8(); if (!n) break; for (let i = 0; i < n; i++) data.push(d[p++]); }

    // LZW, read LSB-first.
    const clear = 1 << minCodeSize, end = clear + 1;
    let codeSize = minCodeSize + 1;
    let dict: number[][] = [];
    const reset = () => {
      dict = [];
      for (let i = 0; i < clear; i++) dict.push([i]);
      dict.push([], []);                            // clear, end
      codeSize = minCodeSize + 1;
    };
    reset();
    const px: number[] = [];
    let bitPos = 0, prev: number[] | null = null;
    const read = () => {
      let v = 0;
      for (let i = 0; i < codeSize; i++) {
        const byte = data[bitPos >> 3];
        if (byte === undefined) return end;
        v |= ((byte >> (bitPos & 7)) & 1) << i;
        bitPos++;
      }
      return v;
    };
    for (;;) {
      const code = read();
      if (code === end) break;
      if (code === clear) { reset(); prev = null; continue; }
      let entry: number[];
      if (code < dict.length && dict[code].length) entry = dict[code];
      else if (code === dict.length && prev) entry = [...prev, prev[0]];
      else throw new Error(`bad LZW code ${code} (dict ${dict.length})`);
      px.push(...entry);
      if (prev) {
        dict.push([...prev, entry[0]]);
        if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
      }
      prev = entry;
    }
    if (px.length !== fw * fh) throw new Error(`frame is ${px.length} pixels, expected ${fw * fh}`);
    frames.push({ pixels: Uint8Array.from(px), delayCs, transparent });
  }
  return { width, height, palette, frames };
}

function check(label: string, width: number, height: number, frames: Frame[]): boolean {
  const bytes = encodeGIF({ width, height, palette: EGA_RGB, frames });
  const got = decodeGIF(bytes);
  if (got.width !== width || got.height !== height)
    { console.log(`  ${label}: size ${got.width}x${got.height}, expected ${width}x${height}`); return false; }
  if (got.frames.length !== frames.length)
    { console.log(`  ${label}: ${got.frames.length} frames, expected ${frames.length}`); return false; }
  for (let i = 0; i < frames.length; i++) {
    const a = frames[i], b = got.frames[i];
    for (let k = 0; k < a.pixels.length; k++)
      if (a.pixels[k] !== b.pixels[k])
        { console.log(`  ${label}: frame ${i} differs at pixel ${k} (${a.pixels[k]} vs ${b.pixels[k]})`); return false; }
    if (b.delayCs !== a.delayCs)
      { console.log(`  ${label}: frame ${i} delay ${b.delayCs}, expected ${a.delayCs}`); return false; }
    if (b.transparent !== (a.transparent ?? -1))
      { console.log(`  ${label}: frame ${i} transparent ${b.transparent}`); return false; }
  }
  return true;
}

let bad = 0, checked = 0, bytes = 0;

// Synthetic cases: a flat frame compresses to almost nothing, while noise
// fills the dictionary and forces the code width up and then round.
const rnd = (() => { let a = 12345; return () => (a = (a * 1103515245 + 12345) & 0x7FFFFFFF); })();
const cases: Array<[string, number, number, Frame[]]> = [
  ['flat', 64, 64, [{ pixels: new Uint8Array(64 * 64).fill(7), delayCs: 10 }]],
  ['single pixel', 1, 1, [{ pixels: Uint8Array.from([3]), delayCs: 5 }]],
  ['noise 200x200', 200, 200,
    [{ pixels: Uint8Array.from({ length: 200 * 200 }, () => rnd() & 15), delayCs: 7 }]],
  // 160,000 pixels of noise is where the dictionary actually fills and the
  // encoder has to emit a clear code and start over; at 200x200 it only
  // grows the code width and never resets, so that case alone would leave
  // the reset path untested.
  ['noise 400x400 (forces a dictionary reset)', 400, 400,
    [{ pixels: Uint8Array.from({ length: 400 * 400 }, () => rnd() & 15), delayCs: 7 }]],
  ['gradient, transparent 0', 96, 96,
    [{ pixels: Uint8Array.from({ length: 96 * 96 }, (_, i) => (i / 96 | 0) & 15), delayCs: 3, transparent: 0 }]],
];
for (const [label, w, h, frames] of cases) {
  checked++;
  bytes += encodeGIF({ width: w, height: h, palette: EGA_RGB, frames }).length;
  if (!check(label, w, h, frames)) bad++;
}

// Real cels, multi-frame, from every game.
for (const name of ['SQ3', 'LSL2', 'KQ4', 'CAMELOT', 'COLONEL', 'ICE', 'HERO', 'QFG2']) {
  const g = new Game(nodeSource(join(ROOT, name)));
  let did = 0;
  for (const r of [...g.byType('view')].sort((a, b) => a.number - b.number)) {
    if (did >= 6) break;
    let v: View;
    try { v = new View(g.data(0, r.number)); } catch { continue; }
    const loop = v.loops.find(l => l.length > 1);
    if (!loop) continue;
    const w = Math.max(...loop.map(c => c.width));
    const h = Math.max(...loop.map(c => c.height));
    const frames: Frame[] = loop.map(c => {
      const px = new Uint8Array(w * h).fill(c.key);
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) px[y * w + x] = c.pixels[y * c.width + x];
      return { pixels: px, delayCs: 14, transparent: c.key };
    });
    checked++; did++;
    bytes += encodeGIF({ width: w, height: h, palette: EGA_RGB, frames }).length;
    if (!check(`${name} view ${r.number}`, w, h, frames)) bad++;
  }
}
console.log(`${checked} GIFs encoded (${(bytes / 1024).toFixed(0)} KB) and decoded back, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
