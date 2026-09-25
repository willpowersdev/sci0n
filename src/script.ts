/**
 * SCI0 script resources: the game's compiled objects.
 *
 * A script is a flat list of blocks (early SCI0 such as KQ4 puts one
 * extra word in front of the list, which Script.pickStart sniffs for):
 *
 *   u16 blockType, u16 blockSize   (size includes these 4 bytes)
 *
 * An object/class body, with base = blockOffset + 4:
 *
 *   base+0  u16 magic = 0x1234
 *   base+2  u16 local-variable offset
 *   base+4  u16 method-table offset, relative to blockOffset + 10
 *   base+6  u16 property count
 *   base+8  u16 property[propertyCount]
 *
 * The first four properties are always species, superClass, -info- and
 * name; `-info-` bit 0x8000 marks a class.  A class then carries a
 * parallel table of property *selector ids*, which an instance omits --
 * an instance borrows its layout from its species' class.  Then:
 *
 *   u16 methodCount
 *   u16 selectorId[methodCount]
 *   u16 0                          <- separator
 *   u16 codeOffset[methodCount]
 *
 * Those last two are parallel arrays, NOT interleaved pairs.
 */
import type { Game } from './resources.ts';
import { nameTable, classTable, SCI0_KERNEL, SELECTORS, KERNEL_NAMES, CLASS_TABLE } from './vocab.ts';
import { patchScript } from './patches.ts';

export const BLOCK_NAMES: Record<number, string> = {
  0: 'terminator', 1: 'object', 2: 'code', 3: 'synonyms', 4: 'said',
  5: 'strings', 6: 'class', 7: 'exports', 8: 'relocation',
  9: 'preload_text', 10: 'locals',
};

export const STD_PROPS = ['species', 'superClass', '-info-', 'name'];

const u16 = (d: Uint8Array, o: number) =>
  (o + 1 < d.length) ? (d[o] | (d[o + 1] << 8)) : 0;
export const s16 = (v: number) => (v & 0x8000) ? v - 0x10000 : v;

function cstring(d: Uint8Array, o: number): string | null {
  if (o <= 0 || o >= d.length) return null;
  let e = o;
  while (e < d.length && d[e] !== 0) e++;
  return Array.from(d.subarray(o, e), b => String.fromCharCode(b)).join('');
}

export class SciObject {
  script: Script; offset: number; isClass: boolean;
  magic: number; localVarOffset: number; methodOffset: number; propCount: number;
  properties: number[] = [];
  species: number | null; superclass: number | null; info: number; namePtr: number;
  name: string;
  propSelectors: number[] | null = null;
  methods: Array<[number, number]> = [];

  constructor(script: Script, blockOff: number, isClass: boolean) {
    this.script = script; this.offset = blockOff; this.isClass = isClass;
    const d = script.data, base = blockOff + 4;
    this.magic = u16(d, base);
    this.localVarOffset = u16(d, base + 2);
    this.methodOffset = u16(d, base + 4);
    this.propCount = u16(d, base + 6);
    for (let i = 0; i < this.propCount; i++) this.properties.push(u16(d, base + 8 + i * 2));
    this.species = this.propCount > 0 ? this.properties[0] : null;
    this.superclass = this.propCount > 1 ? this.properties[1] : null;
    this.info = this.propCount > 2 ? this.properties[2] : 0;
    this.namePtr = this.propCount > 3 ? this.properties[3] : 0;
    this.name = cstring(d, this.namePtr) ?? `<anon@${blockOff}>`;

    const selStart = base + 8 + this.propCount * 2;
    if (isClass) {
      this.propSelectors = [];
      for (let i = 0; i < this.propCount; i++)
        this.propSelectors.push(u16(d, selStart + i * 2));
    }

    const mt = blockOff + 10 + this.methodOffset;
    const count = u16(d, mt);
    for (let i = 0; i < count; i++)
      this.methods.push([u16(d, mt + 2 + i * 2),
                         u16(d, mt + 2 + (count + 1 + i) * 2)]);
  }

  /** Does property `i` hold a pointer into the script rather than a number? */
  isPointer(i: number): boolean {
    return this.script.relocations.has(this.offset + 12 + i * 2);
  }

  /** Resolve property names, borrowing from the species class if needed. */
  propertyNames(index: Index | null): string[] {
    let sels = this.propSelectors;
    if (!sels && index) sels = index.classForSpecies(this.species)?.propSelectors ?? null;
    const names: string[] = [];
    for (let i = 0; i < this.propCount; i++) {
      if (sels && i < sels.length) names.push(index ? index.selectorName(sels[i]) : String(sels[i]));
      else if (i < 4) names.push(STD_PROPS[i]);
      else names.push(`prop${i}`);
    }
    return names;
  }
}

export class Script {
  data: Uint8Array; number: number | null;
  start = 0;
  /**
   * Offsets of words in this script that hold a pointer into it.
   *
   * SCI's loader walks this list and turns each one into a real
   * address; here they are turned into script-tagged references, which
   * is what this port uses for the same thing.  Leaving them as the
   * bare offsets the file carries is not harmless, because the scripts
   * tell a pointer from a resource number by its size: script 255's
   * `Print` takes anything under 1000 to be a text module.  KQ4's
   * `User` holds a pointer to "Enter input" at offset 618, so the
   * parser's prompt was fetched as text module 618, which does not
   * exist, and the input line came up eight pixels wide with no field
   * to type into.
   */
  relocations = new Set<number>();
  blocks: Array<[string, number, number]> = [];
  objects: SciObject[] = [];
  exports: number[] = [];
  locals: number[] = [];
  /** Where the locals block's words start, for the relocation list. */
  localsAt = -1;
  strings = new Map<number, string>();
  said: Array<[number, Uint8Array]> = [];
  synonyms: Array<[number, number]> = [];

  constructor(data: Uint8Array, number: number | null = null) {
    this.data = data; this.number = number;
    this.parse();
  }

  /** Early SCI0 prefixes the block list with one word. */
  static pickStart(d: Uint8Array): number {
    const score = (start: number) => {
      let p = start, n = 0;
      while (p + 4 <= d.length) {
        const t = u16(d, p), sz = u16(d, p + 2);
        if (t === 0) break;
        if (t > 10 || sz < 4 || p + sz > d.length) return -1;
        n++; p += sz;
      }
      return n;
    };
    return score(2) > score(0) ? 2 : 0;
  }

  private parse() {
    const d = this.data;
    this.start = Script.pickStart(d);
    let p = this.start;
    while (p + 4 <= d.length) {
      const btype = u16(d, p), size = u16(d, p + 2);
      if (btype === 0 || size < 4) break;
      this.blocks.push([BLOCK_NAMES[btype] ?? `block${btype}`, p, size]);
      const body = d.subarray(p + 4, p + size);

      if (btype === 1 || btype === 6) {
        try { this.objects.push(new SciObject(this, p, btype === 6)); } catch { /* skip */ }
      } else if (btype === 5) {
        const off = p + 4;
        let cur: number[] = [], start = off;
        for (let i = 0; i < body.length; i++) {
          if (body[i] === 0) {
            if (cur.length)
              this.strings.set(start, cur.map(c => String.fromCharCode(c)).join(''));
            cur = []; start = off + i + 1;
          } else cur.push(body[i]);
        }
      } else if (btype === 7) {
        // A script may carry more than one exports block (KQ4 306,
        // Camelot 912).  The later one replaces the earlier -- appending
        // would silently merge two unrelated tables.
        const n = u16(body, 0);
        this.exports = [];
        for (let i = 0; i < n; i++) this.exports.push(u16(body, 2 + i * 2));
      } else if (btype === 8) {
        // A count, then that many offsets.  Some scripts carry a count
        // one larger than the entries that follow, so the block's own
        // size has the last word.
        const n = Math.min(u16(body, 0), Math.floor((body.length - 2) / 2));
        for (let i = 0; i < n; i++) this.relocations.add(u16(body, 2 + i * 2));
      } else if (btype === 10) {
        this.locals = [];
        this.localsAt = p + 4;
        for (let i = 0; i < Math.floor(body.length / 2); i++) this.locals.push(u16(body, i * 2));
      } else if (btype === 4) {
        // Specs are separated by 0xFF, but the block cannot be scanned
        // a byte at a time looking for one.  A byte below 0xF0 opens a
        // two-byte word group whose low byte may be anything at all --
        // including 0xFF -- so the pair has to be stepped over.  The
        // wildcard `*` is group 0x0fff, and reading its low byte as a
        // separator cut every pattern using it in half: the head kept a
        // dangling 0x0f that decoded as the nonexistent group 0x0f00,
        // and the tail became a fragment starting mid-pattern.
        let s = 0;
        for (let i = 0; i < body.length; i++) {
          const v = body[i];
          if (v < 0xF0) { i++; continue; }
          if (v === 0xFF) {
            if (i > s) this.said.push([p + 4 + s, body.subarray(s, i)]);
            s = i + 1;
          }
        }
      } else if (btype === 3) {
        for (let i = 0; i < Math.floor(body.length / 4); i++)
          this.synonyms.push([u16(body, i * 4), u16(body, i * 4 + 2)]);
      }
      p += size;
    }

    /**
     * Early SCI0 keeps no locals in the file, only a count.
     *
     * The word this script starts with -- the same one that makes
     * `pickStart` answer 2 -- says how many local variables it has, and
     * the interpreter allocates them zeroed.  The later games write a
     * locals block instead, with the initial values in it.
     *
     * Read as having none, every one of KQ4's 155 scripts ran with no
     * locals at all and the game with no globals, every access falling
     * down the out-of-range path.  That path leaves an indexed store's
     * index in the accumulator rather than the value it stored, and the
     * intro's credits are built as `credits[n] = (View new:)` followed
     * by sends to what that yielded -- so each credit was created, lost,
     * and left at view 0, and the screen held the first one for the
     * whole three minutes.
     */
    if (this.start === 2 && !this.locals.length && d.length >= 2)
      this.locals = new Array(u16(d, 0)).fill(0);
  }

  classes() { return this.objects.filter(o => o.isClass); }
  instances() { return this.objects.filter(o => !o.isClass); }
}

/** Cross-script name resolution: selectors, kernel names, species. */
export class Index {
  game: Game;
  selectors: string[] = [];
  kernel: string[] = [];
  classScripts = new Map<number, number>();
  selectorShift = 0;
  private scripts = new Map<number, Script | null>();
  private species = new Map<number, SciObject | null>();
  /**
   * Whether the games' own scripts are repaired on the way through.
   *
   * On, because the machine runs what this hands it.  Off gives the
   * bytes Sierra shipped, which is what anything asking what the game
   * actually does -- a disassembly, a test of the fault a patch is for
   * -- needs to see.
   */
  private readonly patching: boolean;

  constructor(game: Game, opts: { patch?: boolean } = {}) {
    this.game = game;
    this.patching = opts.patch ?? true;
    const sel = game.tryData('vocab', SELECTORS);
    if (sel) this.selectors = nameTable(sel);
    const ker = game.tryData('vocab', KERNEL_NAMES);
    if (ker) this.kernel = nameTable(ker);
    const cls = game.tryData('vocab', CLASS_TABLE);
    if (cls) this.classScripts = classTable(cls);

    // Early SCI0 (KQ4) stores selector ids as byte offsets into the
    // selector table -- twice the index.  The same games are the ones
    // whose scripts carry the extra leading word, so use that as the tell.
    for (const r of game.byType('script').slice(0, 5)) {
      try {
        const d = game.tryData('script', r.number);
        if (d && new Script(d, r.number).start === 2) { this.selectorShift = 1; break; }
      } catch { /* ignore */ }
    }
  }

  selectorName(sid: number): string {
    const i = sid >> this.selectorShift;
    return (i >= 0 && i < this.selectors.length && this.selectors[i])
      ? this.selectors[i] : `sel${sid}`;
  }

  /**
   * The id a script's method and property tables use for a selector.
   *
   * The inverse of `selectorName`, and not simply the table index: early
   * SCI0 stores byte offsets, so a game with shift=1 records `play` as 84
   * where the table holds it at 42.  Anything resolving a selector by
   * name has to go through here or it will match nothing in those games.
   */
  selectorId(name: string): number {
    const i = this.selectors.indexOf(name);
    return i < 0 ? -1 : i << this.selectorShift;
  }

  kernelName(kid: number): string {
    // A game that names fewer kernels than it calls falls back to the
    // numbering itself, which is the interpreter's -- see SCI0_KERNEL.
    // An entry that is not an identifier is not a name either: reading
    // one past the end of KQ4's table lands in the string data.
    const own = kid >= 0 && kid < this.kernel.length ? this.kernel[kid] : '';
    if (own && /^[A-Za-z][A-Za-z0-9_]*$/.test(own)) return own;
    return SCI0_KERNEL[kid] ?? (own || `kernel${kid}`);
  }

  /** What was changed in the games' own scripts, and why. */
  readonly patched: string[] = [];

  script(number: number): Script | null {
    if (!this.scripts.has(number)) {
      const d = this.game.tryData('script', number);
      if (!d) { this.scripts.set(number, null); return null; }
      const { data, applied } = this.patching
        ? patchScript(number, d) : { data: d, applied: [] };
      this.patched.push(...applied);
      this.scripts.set(number, new Script(data, number));
    }
    return this.scripts.get(number)!;
  }

  classForSpecies(species: number | null): SciObject | null {
    if (species === null) return null;
    if (this.species.has(species)) return this.species.get(species)!;
    let found: SciObject | null = null;
    const sn = this.classScripts.get(species);
    if (sn !== undefined) {
      const s = this.script(sn);
      if (s) found = s.classes().find(c => c.species === species) ?? null;
    }
    this.species.set(species, found);
    return found;
  }
}
