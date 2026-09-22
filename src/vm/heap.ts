/**
 * Object memory and dispatch for the SCI0 PMachine.
 *
 * Every object carries a `species`, and vocab.996 maps a species to the
 * script that defines its class.  Walking species -> superClass gives the
 * inheritance chain, and a selector resolves to the nearest definition
 * along it -- which is all `send` needs in order to mean anything.
 */
import type { Game } from '../resources.ts';
import { Script, SciObject, Index } from '../script.ts';

export const MAX_CHAIN = 32;   // damaged data can contain cycles

export class SpeciesTable {
  private byId = new Map<number, { script: number; cls: SciObject }>();
  readonly index: Index;

  constructor(game: Game, index?: Index) {
    this.index = index ?? new Index(game);
    for (const [species, scriptNo] of [...this.index.classScripts.entries()]
        .sort((a, b) => a[0] - b[0])) {
      const s = this.index.script(scriptNo);
      if (!s) continue;
      const cls = s.classes().find(c => c.species === species);
      if (cls) this.byId.set(species, { script: scriptNo, cls });
    }
  }

  get size() { return this.byId.size; }
  classOf(species: number | null): SciObject | null {
    return species === null ? null : (this.byId.get(species)?.cls ?? null);
  }

  /** species -> superClass -> ... to the root, cycle-guarded. */
  chain(species: number | null): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    let cur = species;
    while (cur !== null && cur !== undefined && this.byId.has(cur) &&
           !seen.has(cur) && out.length < MAX_CHAIN) {
      seen.add(cur);
      out.push(cur);
      const sup = this.byId.get(cur)!.cls.superclass;
      if (sup === 0xFFFF) break;
      cur = sup ?? null;
    }
    return out;
  }

  /**
   * Resolve a selector starting from a named class rather than from an
   * object.  This is what `super` needs: beginning at the object would
   * re-find the method currently running and recurse forever.
   */
  lookupFrom(species: number, selector: number):
      { script: number; offset: number } | null {
    for (const sp of this.chain(species)) {
      const entry = this.byId.get(sp)!;
      for (const [sid, off] of entry.cls.methods)
        if (sid === selector) return { script: entry.script, offset: off };
    }
    return null;
  }

  /** Where a class object lives, so the `class` opcode can name it. */
  locate(species: number): { script: number; offset: number } | null {
    const e = this.byId.get(species);
    return e ? { script: e.script, offset: e.cls.offset } : null;
  }

  /** selector -> code offset, nearest definition winning. */
  resolveMethods(obj: SciObject): Map<number, number> {
    const found = new Map<number, number>();
    for (const [sid, off] of obj.methods) if (!found.has(sid)) found.set(sid, off);
    for (const sp of this.chain(obj.species)) {
      const cls = this.byId.get(sp)!.cls;
      if (cls === obj) continue;
      for (const [sid, off] of cls.methods) if (!found.has(sid)) found.set(sid, off);
    }
    return found;
  }

  /**
   * What `send obj selector` dispatches to.
   *
   * The script matters as much as the offset: an inherited method's code
   * lives in the script that defines the *class*, not in the object's
   * own script.  Returning a bare offset and running it against the
   * object's script decodes unrelated bytes as instructions.
   */
  lookup(obj: SciObject, selector: number, objScript: number):
      { script: number; offset: number } | null {
    for (const [sid, off] of obj.methods)
      if (sid === selector) return { script: objScript, offset: off };
    for (const sp of this.chain(obj.species)) {
      const entry = this.byId.get(sp)!;
      if (entry.cls === obj) continue;
      for (const [sid, off] of entry.cls.methods)
        if (sid === selector) return { script: entry.script, offset: off };
    }
    return null;
  }
}
