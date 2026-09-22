/**
 * Vocab resources: the names that make a script dump readable.
 *
 *   vocab.000 / vocab.900  parser words (SCI0 / SCI01 layouts)
 *   vocab.996              class table: species -> defining script
 *   vocab.997              selector names
 *   vocab.999              kernel function names
 */
import type { Game } from './resources.ts';

export const MAIN_VOCAB = 0, MAIN_VOCAB_SCI01 = 900;
export const SUFFIX_VOCAB = 901, SUFFIX_VOCAB_SCI01 = 902;
export const SELECTORS = 997, KERNEL_NAMES = 999, CLASS_TABLE = 996;

const u16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);
const latin1 = (d: Uint8Array) => Array.from(d, b => String.fromCharCode(b)).join('');

/** u16 count-1, u16 offset[count], each offset -> u16 len then bytes. */
export function stringTable(data: Uint8Array): string[] {
  if (data.length < 2) return [];
  const count = u16(data, 0) + 1;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = 2 + i * 2;
    if (p + 2 > data.length) break;
    const off = u16(data, p);
    if (off + 2 > data.length) { out.push(''); continue; }
    const len = u16(data, off);
    out.push(latin1(data.subarray(off + 2, off + 2 + len)));
  }
  return out;
}

/**
 * Kernel/selector names in whichever of the two layouts a game uses.
 * Most ship an offset table; some (QFG2) just concatenate NUL-terminated
 * names.  The validity test must be proportional -- one stray NUL in a
 * trailing entry is normal and must not reject a good table.
 */
export function nameTable(data: Uint8Array): string[] {
  const names = stringTable(data);
  const good = names.filter(n => n.length && !n.includes('\0'));
  if (names.length && good.length >= names.length * 0.8) return names;
  const flat = latin1(data).split('\0');
  while (flat.length && !flat[flat.length - 1]) flat.pop();
  return flat;
}

/** vocab.000: 52-byte header; a word's last character has the high bit set. */
export function parserWords(data: Uint8Array): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  let p = 26 * 2, cur = '';
  const n = data.length;
  while (p + 4 <= n) {
    const shared = data[p++];
    if (shared > cur.length) break;
    cur = cur.slice(0, shared);
    let done = false;
    while (p < n) {
      const c = data[p++];
      cur += String.fromCharCode(c & 0x7F);
      if (c & 0x80) { done = true; break; }
    }
    if (!done || p + 3 > n) break;
    const a = data[p], b = data[p + 1], c = data[p + 2];
    p += 3;
    out.push([cur, (a << 4) | (b >> 4), c | ((b & 0x0F) << 8)]);
  }
  return out;
}

/** vocab.900: 510-byte header, and words end with a NUL instead. */
export function parserWordsSci01(data: Uint8Array, header = 510):
    Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  let p = header, cur = '';
  const n = data.length;
  while (p + 4 < n) {
    const shared = data[p++];
    if (shared > cur.length) break;
    cur = cur.slice(0, shared);
    while (p < n && data[p] !== 0) cur += String.fromCharCode(data[p++] & 0x7F);
    if (p >= n) break;
    p++;                                  // the NUL
    if (p + 3 > n) break;
    const a = data[p], b = data[p + 1], c = data[p + 2];
    p += 3;
    out.push([cur, (a << 4) | (b >> 4), c | ((b & 0x0F) << 8)]);
  }
  return out;
}

export function gameWords(game: Game): Array<[string, number, number]> {
  const a = game.tryData('vocab', MAIN_VOCAB);
  if (a) return parserWords(a);
  const b = game.tryData('vocab', MAIN_VOCAB_SCI01);
  if (b) return parserWordsSci01(b);
  return [];
}

/**
 * The suffix rules, wherever this game keeps them.
 *
 * SCI01 repurposes 901 and moves the suffixes to 902 -- the same shift
 * that takes the main word list from 0 to 900 -- so the resource is
 * chosen by which one actually parses, not by number alone.
 */
export function gameSuffixes(game: Game): ReturnType<typeof suffixes> {
  for (const n of [SUFFIX_VOCAB, SUFFIX_VOCAB_SCI01]) {
    const d = game.tryData('vocab', n);
    if (!d) continue;
    const got = suffixes(d);
    if (got.length >= 4 && got.every(e => e.pattern)) return got;
  }
  return [];
}

export function gameGroups(game: Game): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const [w, , grp] of gameWords(game)) {
    const l = out.get(grp);
    if (l) l.push(w); else out.set(grp, [w]);
  }
  return out;
}

/**
 * vocab.901: the parser's suffix rules, as `pattern -> replacement`.
 *
 * Each entry is a NUL-terminated pattern, a 16-bit word-class mask, a
 * NUL-terminated replacement and a second mask -- so "*ies" reduces to
 * "*y" before the word is looked up.  The masks are reported as read;
 * what their bits select is not something this decoder claims to know.
 */
export function suffixes(data: Uint8Array):
    Array<{ pattern: string; replacement: string; inClass: number; outClass: number }> {
  const out: Array<{ pattern: string; replacement: string; inClass: number; outClass: number }> = [];
  let p = 0;
  const str = () => {
    let s = '';
    while (p < data.length && data[p]) s += String.fromCharCode(data[p++]);
    p++;                                   // the NUL
    return s;
  };
  while (p + 2 <= data.length) {
    const pattern = str();
    if (p + 2 > data.length) break;
    const inClass = u16(data, p); p += 2;
    const replacement = str();
    if (p + 2 > data.length) break;
    const outClass = u16(data, p); p += 2;
    if (!pattern && !replacement) break;
    out.push({ pattern, replacement, inClass, outClass });
  }
  return out;
}

/**
 * vocab.998: the interpreter's own opcode table, one entry per opcode.
 *
 * Each entry is a 16-bit type field followed by the mnemonic, and an
 * unused opcode has an empty name.  This is the games' own account of
 * the instruction set, which makes it an independent check on the
 * mnemonics the disassembler hardcodes.
 */
export function opcodes(data: Uint8Array): Array<{ type: number; name: string }> {
  return stringTable(data).map(e => ({
    type: (e.charCodeAt(0) & 0xFF) | ((e.charCodeAt(1) & 0xFF) << 8),
    name: e.slice(2),
  }));
}

export function classTable(data: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < Math.floor(data.length / 4); i++)
    out.set(i, u16(data, i * 4 + 2));
  return out;
}

const SAID_OPS: Record<number, string> = {
  0xF0: ',', 0xF1: '&', 0xF2: '/', 0xF3: '(', 0xF4: ')',
  0xF5: '[', 0xF6: ']', 0xF7: '#', 0xF8: '<', 0xF9: '>',
};

/** Bytes >= 0xF0 are operators; anything else is the high byte of a
 *  16-bit word-group id, so groups are read two bytes at a time. */
export function saidDecode(spec: Uint8Array, groups: Map<number, string[]>,
                           perGroup = 2): string {
  const out: string[] = [];
  let i = 0;
  while (i < spec.length) {
    const v = spec[i];
    if (v >= 0xF0) { out.push(SAID_OPS[v] ?? '?'); i++; continue; }
    if (i + 1 >= spec.length) break;
    const g = (v << 8) | spec[i + 1];
    i += 2;
    const ws = groups.get(g);
    out.push(ws ? [...ws].sort().slice(0, perGroup).join('/') : `group${g}`);
  }
  return out.join(' ');
}
