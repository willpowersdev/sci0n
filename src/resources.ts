/**
 * SCI0 resource container.
 *
 *   RESOURCE.MAP   flat 6-byte entries, terminated by 0xFFFF
 *                    u16 id   -> type = id >> 11, number = id & 0x7FF
 *                    u32 loc  -> volume = loc >> 26, offset = loc & 0x03FFFFFF
 *   RESOURCE.nnn   at `offset`, an 8-byte header:
 *                    u16 id, u16 compSize, u16 decompSize, u16 method
 *
 * `compSize` counts from after the id word, so the payload is
 * data[offset+8 .. offset+8+compSize-4].
 */
import { lzw, lzw1, huffman, lzwProbe, lzw1Probe, huffmanProbe } from './compress.ts';

export const TYPE_NAMES: Record<number, string> = {
  0: 'view', 1: 'pic', 2: 'script', 3: 'text', 4: 'sound',
  5: 'memory', 6: 'vocab', 7: 'font', 8: 'cursor', 9: 'patch',
};

/** Byte source: node reads from disk, the browser from a FileList. */
export interface ResourceSource {
  names(): string[];
  read(name: string): Uint8Array;
}

export interface ResourceInfo {
  type: number; number: number; volume: number; offset: number;
  compSize: number; decompSize: number; method: number;
}

type Probe = (d: Uint8Array, s: number) => [Uint8Array, number];
const CODECS: Array<[string, Probe]> = [
  ['lzw', lzwProbe], ['lzw1', lzw1Probe], ['huffman', huffmanProbe],
];
const DECODE: Record<string, (d: Uint8Array, s: number) => Uint8Array> = {
  lzw, lzw1, huffman,
};

export class Game {
  private src: ResourceSource;
  private volPaths = new Map<number, string>();
  private vols = new Map<number, Uint8Array>();
  private codecs = new Map<number, string | null>();
  readonly resources = new Map<string, ResourceInfo>();

  /**
   * A plain file from the game's directory, by name, ignoring case.
   *
   * Almost everything a game owns is inside its volumes, but not quite
   * everything: the earliest SCI0 games keep their AdLib instruments in
   * the driver they shipped with rather than in a patch resource.
   */
  file(name: string): Uint8Array | null {
    const want = name.toUpperCase();
    for (const n of this.src.names()) {
      if (n.toUpperCase() !== want) continue;
      try { return this.src.read(n); } catch { return null; }
    }
    return null;
  }

  constructor(src: ResourceSource) {
    this.src = src;
    let mapName: string | null = null;
    for (const n of src.names()) {
      const up = n.toUpperCase();
      if (up === 'RESOURCE.MAP') mapName = n;
      else if (up.startsWith('RESOURCE.') && /^\d+$/.test(up.slice(9)))
        this.volPaths.set(parseInt(up.slice(9), 10), n);
    }
    if (!mapName) throw new Error('no RESOURCE.MAP');
    this.readMap(src.read(mapName));
  }

  static key(type: number, number: number) { return `${type}:${number}`; }

  private readMap(m: Uint8Array) {
    for (let o = 0; o + 6 <= m.length; o += 6) {
      const id = m[o] | (m[o + 1] << 8);
      if (id === 0xFFFF) break;
      const loc = (m[o + 2] | (m[o + 3] << 8) | (m[o + 4] << 16)) + m[o + 5] * 16777216;
      const type = id >> 11, number = id & 0x7FF;
      const volume = Math.floor(loc / 67108864);        // >> 26
      const offset = loc % 67108864;                    // & 0x03FFFFFF
      const k = Game.key(type, number);
      // The same resource is duplicated across floppy volumes; keep the
      // first copy that lives in a volume we actually have.
      if (this.resources.has(k) || !this.volPaths.has(volume)) continue;
      this.resources.set(k, { type, number, volume, offset,
        compSize: -1, decompSize: -1, method: -1 });
    }
  }

  volume(n: number): Uint8Array {
    let v = this.vols.get(n);
    if (!v) {
      const p = this.volPaths.get(n);
      if (!p) throw new Error(`volume ${n} missing`);
      v = this.src.read(p); this.vols.set(n, v);
    }
    return v;
  }

  header(r: ResourceInfo): ResourceInfo {
    if (r.compSize >= 0) return r;
    const b = this.volume(r.volume), o = r.offset;
    if (o + 8 > b.length) throw new Error('header past end of volume');
    const id = b[o] | (b[o + 1] << 8);
    if ((id >> 11) !== r.type || (id & 0x7FF) !== r.number)
      throw new Error('header id mismatch');
    r.compSize = b[o + 2] | (b[o + 3] << 8);
    r.decompSize = b[o + 4] | (b[o + 5] << 8);
    r.method = b[o + 6] | (b[o + 7] << 8);
    return r;
  }

  private payload(r: ResourceInfo): Uint8Array {
    this.header(r);
    const b = this.volume(r.volume);
    return b.subarray(r.offset + 8, r.offset + 8 + r.compSize - 4);
  }

  /**
   * Which codec this game means by a method id.  SCI0 reads 1 as LZW and
   * 2 as Huffman; SCI01 (QFG2) reads 1 as Huffman and 2 as COMP3.  Score
   * candidates on real resources: a codec is right only if it yields
   * exactly decompSize bytes *and* consumes essentially all its input.
   */
  codecFor(method: number): string | null {
    if (this.codecs.has(method)) return this.codecs.get(method)!;
    const samples: Array<[Uint8Array, number]> = [];
    for (const r of this.resources.values()) {
      try { this.header(r); } catch { continue; }
      if (r.method !== method || r.decompSize === 0) continue;
      samples.push([this.payload(r), r.decompSize]);
      if (samples.length >= 8) break;
    }
    let best: string | null = null, bestScore = 0;
    for (const [name, fn] of CODECS) {
      let score = 0;
      for (const [raw, size] of samples) {
        try {
          const [out, used] = fn(raw, size);
          if (out.length === size && Math.abs(used - raw.length) <= 4) score++;
        } catch { /* candidate simply fails */ }
      }
      if (score > bestScore) { best = name; bestScore = score; }
    }
    this.codecs.set(method, best);
    return best;
  }

  /** Resource ids of one type, ascending. */
  byType(typeName: string): ResourceInfo[] {
    const t = Number(Object.entries(TYPE_NAMES).find(([, n]) => n === typeName)?.[0]);
    return [...this.resources.values()].filter(r => r.type === t)
      .sort((a, b) => a.number - b.number);
  }

  /** Decompressed bytes, or null when the game does not ship this one. */
  tryData(typeName: string, number: number): Uint8Array | null {
    const t = Number(Object.entries(TYPE_NAMES).find(([, n]) => n === typeName)?.[0]);
    if (!this.resources.has(Game.key(t, number))) return null;
    try { return this.data(t, number); } catch { return null; }
  }

  data(type: number, number: number): Uint8Array {
    const r = this.resources.get(Game.key(type, number));
    if (!r) throw new Error(`no resource ${type}.${number}`);
    this.header(r);
    const raw = this.payload(r);
    if (r.method === 0) return raw.subarray(0, r.decompSize);
    const name = this.codecFor(r.method);
    if (!name) throw new Error(`cannot identify codec for method ${r.method}`);
    return DECODE[name](raw, r.decompSize);
  }
}
