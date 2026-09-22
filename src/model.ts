/**
 * Stage 1: a per-room behavioural model of a parser game.
 *
 * For every room this records what the player can *do* there and what it
 * changes, read straight out of the compiled scripts:
 *
 *   exits       newRoom targets reachable from the room's own code
 *   commands    each Said pattern the room handles, with the globals it
 *               tests and the globals it sets
 *   objects     the room's instances
 *   strings     text embedded in the room's script
 *
 * How a command is found: the compiler emits `lofsa <spec>` then
 * `callk Said`, so walking the disassembly to a Said call and looking
 * back for the pointer gives the exact pattern.  The handler body then
 * runs to the next Said call or the next `ret`, and everything that
 * window reads from or writes to a global is that command's condition or
 * effect.
 *
 * The result is a hypothesis, not a proof:
 *
 *  - a tested global is not necessarily a precondition of the command:
 *    the scan covers the whole handler body, so tests belonging to a
 *    nested branch are attributed to the command as a whole
 *  - conditions held in object properties rather than globals are missed
 *  - a global compared against a computed value records as a bare read
 *  - transitions whose destination is computed cannot be resolved at all
 *
 * so treat it as a map of what is *possible* per room, not a guarantee of
 * what will work.
 */
import { Script, SciObject, Index } from './script.ts';
import { sweep, type Instruction } from './disasm.ts';
import { gameGroups, saidDecode } from './vocab.ts';
import { strings as textStrings } from './text.ts';
import * as RG from './roomgraph.ts';
import * as RL from './roomlinks.ts';
import type { Game } from './resources.ts';

const CMP: Record<string, string> = {
  'eq?': '==', 'ne?': '!=', 'lt?': '<', 'gt?': '>', 'le?': '<=',
  'ge?': '>=', 'ult?': '<', 'ugt?': '>',
};
const LOADS = ['lag', 'lsg'];
const STORES = ['sag', 'ssg'];

export type Condition = [string, string, number | null];
export type Effect = [string, string, number | string];
export type Say = [number, number, string];

export interface CommandJSON {
  command: string; script: number; offset: number;
  conditions: Condition[]; effects: Effect[];
  goto: number[]; calls: string[]; says: Say[];
}

export class Command {
  text: string; script: number; offset: number;
  conditions: Condition[] = [];
  effects: Effect[] = [];
  goto: number[] = [];
  calls: string[] = [];
  says: Say[] = [];
  constructor(text: string, script: number, offset: number) {
    this.text = text; this.script = script; this.offset = offset;
  }
  toJSON(): CommandJSON {
    return { command: this.text, script: this.script, offset: this.offset,
             conditions: this.conditions, effects: this.effects,
             goto: this.goto, calls: this.calls, says: this.says };
  }
}

export interface State {
  state: number; conditions: Condition[]; effects: Effect[];
  goto: number[]; calls: string[]; says: Say[];
}

export class Room {
  number: number; name: string | null; picture: number | null;
  exits: number[] = [];
  commands: Command[] = [];
  objects: string[] = [];
  strings: string[] = [];
  machines = new Map<string, State[]>();
  constructor(number: number, name: string | null, picture: number | null) {
    this.number = number; this.name = name; this.picture = picture;
  }
  toJSON() {
    return { room: this.number, name: this.name, picture: this.picture,
             exits: [...this.exits].sort((a, b) => a - b),
             objects: this.objects,
             commands: this.commands.map(c => c.toJSON()),
             machines: Object.fromEntries([...this.machines].sort(
               (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
             strings: this.strings };
  }
}

/** Target of the lofsa/lofss at index j (PC-relative, signed). */
function resolveLofs(ins: Instruction[], j: number): number {
  const nxt = j + 1 < ins.length ? ins[j + 1].pc : ins[j].pc;
  return nxt + ins[j].args[0];
}

/** A resolved object reference inside the abstract scan. */
class Ref { name: string; constructor(name: string) { this.name = name; } }
type Slot = number | Ref | null;

interface Ctx {
  owner: SciObject | null;
  objs: Map<number, SciObject>;
  selname: (sid: number) => string;
  ownprops: string[];
  sayText: (res: number, line: number) => string;
  printer: [number, number] | null;
}

function uniq<T>(seq: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of seq) {
    const k = JSON.stringify(x);
    if (seen.has(k)) continue;
    seen.add(k); out.push(x);
  }
  return out;
}

/**
 * Conditions, effects and transitions inside one Said handler body.
 *
 * Tracks the accumulator and the send stack well enough to name what a
 * command changes.  Three sources of effect: `aTop`/`sTop` writes a
 * property of the enclosing object (the operand is a byte offset, so the
 * index is operand / 2); a send with arguments writes a property of
 * another object or calls a method on it; and `newRoom` is a transition.
 */
function scanRange(ins: Instruction[], lo: number, hi: number, ctx: Ctx) {
  const { owner, objs, selname, ownprops, sayText, printer } = ctx;
  const conds: Condition[] = [], effects: Effect[] = [], goto: number[] = [];
  const calls: string[] = [], says: Say[] = [];
  const stack: Slot[] = [];
  let acc: Slot = null;
  // Whatever symbolic value was loaded most recently -- a global, one of
  // our own properties, or another object's property via a zero-argument
  // send.  Holding it until a comparison arrives turns "reads x" into
  // "x == 3".
  let pendSym: string | null = null;
  let pendImm: number | null = null;

  /**
   * Name a property of the enclosing object, qualified by its owner:
   * "self.state" means a different thing in every object, and leaving it
   * unqualified collapses every object's state into one symbol so that
   * nothing a handler tests ever matches what another one writes.
   */
  const propOf = (operand: number) => {
    const i = Math.floor(operand / 2);
    const base = owner ? owner.name : 'self';
    if (owner && i < ownprops.length) return `${base}.${ownprops[i]}`;
    return `${base}.prop${i}`;
  };

  for (let k = lo; k < hi; k++) {
    const { pc: p, name: n, args: a } = ins[k];
    if (LOADS.includes(n) && a.length) {
      pendSym = `global${a[0]}`; pendImm = null;
      if (n === 'lsg') stack.push(null);
    } else if (n === 'ldi' && a.length) { pendImm = a[0]; acc = a[0]; }
    else if (n === 'pushi' && a.length) stack.push(a[0]);
    else if (n === 'push0') stack.push(0);
    else if (n === 'push1') stack.push(1);
    else if (n === 'push2') stack.push(2);
    else if (n === 'push') stack.push(acc);
    else if (n === 'pushSelf') stack.push(new Ref('self'));
    else if (n === 'toss') { if (stack.length) stack.pop(); }
    else if ((n === 'lofsa' || n === 'lofss') && a.length) {
      const nxt = k + 1 < ins.length ? ins[k + 1].pc : p;
      const o = objs.get(nxt + a[0]);
      const ref = o ? new Ref(o.name) : null;
      if (n === 'lofsa') acc = ref; else stack.push(ref);
    }
    else if ((n === 'pToa' || n === 'pTos') && a.length) {
      pendSym = propOf(a[0]); pendImm = null;
      if (n === 'pTos') stack.push(null);
    }
    else if ((n === 'aTop' || n === 'sTop') && a.length) {
      effects.push([propOf(a[0]), '=',
                    (n === 'aTop' && pendImm !== null) ? pendImm : '?']);
      pendImm = null;
    }
    else if (n in CMP) {
      if (pendSym !== null) {
        if (pendImm !== null) conds.push([pendSym, CMP[n], pendImm]);
        else conds.push([pendSym, 'read', null]);
      }
      pendSym = null; pendImm = null;
    }
    else if (STORES.includes(n) && a.length) {
      effects.push([`global${a[0]}`, '=', pendImm !== null ? pendImm : '?']);
      pendImm = null;
    }
    else if (n === 'send' || n === 'self' || n === 'super') {
      const nwords = Math.max(0, Math.floor(a[a.length - 1] / 2));
      const args = nwords ? stack.slice(Math.max(0, stack.length - nwords)) : [];
      stack.length = stack.length - args.length;
      const target = n === 'send' ? acc : new Ref(owner ? owner.name : 'self');
      const tname = target instanceof Ref ? target.name : null;
      let i = 0;
      while (i + 1 < args.length) {
        const sid = args[i], argc = args[i + 1];
        if (typeof sid !== 'number' || typeof argc !== 'number' || argc < 0) break;
        const params = args.slice(i + 2, i + 2 + argc);
        i += 2 + argc;
        const sel = selname(sid);
        if (sel === 'newRoom' && params.length >= 1 && typeof params[0] === 'number') {
          goto.push(params[0]); continue;
        }
        if (tname === null) continue;
        if (argc === 1 && params.length === 1 && typeof params[0] === 'number') {
          effects.push([`${tname}.${sel}`, '=', params[0]]);
        } else if (argc === 0) {
          pendSym = `${tname}.${sel}`; pendImm = null;
        } else {
          calls.push(`${tname}.${sel}(${params.map(x =>
            typeof x === 'number' ? String(x) : (x instanceof Ref ? x.name : '?')).join(', ')})`);
        }
      }
      if (pendSym === null) acc = null;
    }
    else if (n === 'calle' && a.length >= 3) {
      // calle <script>, <export>, <argc bytes>.  One (script, export) pair
      // per game is its message printer: (text resource, line).
      const nwords = Math.max(0, Math.floor(a[2] / 2));
      const args = nwords ? stack.slice(Math.max(0, stack.length - nwords)) : [];
      stack.length = stack.length - args.length;
      if (printer && a[0] === printer[0] && a[1] === printer[1] &&
          args.length >= 2 && typeof args[0] === 'number' && typeof args[1] === 'number')
        says.push([args[0], args[1], sayText(args[0], args[1])]);
      acc = null;
    }
    else if (n.startsWith('la')) acc = null;
  }
  return { conds: uniq(conds), effects: uniq(effects), goto: uniq(goto),
           calls: uniq(calls), says: uniq(says) };
}

/** Instructions of one method: to a `ret` no forward branch jumps past. */
function methodExtent(ins: Instruction[], startI: number): number {
  let far = 0;
  for (let i = startI; i < ins.length; i++) {
    const { pc: p, name: n, args: a } = ins[i];
    if (/^(bt|bnt|jmp)$/.test(n) && a.length) {
      const base = i + 1 < ins.length ? ins[i + 1].pc : p;
      far = Math.max(far, base + a[0]);
    }
    if (n === 'ret' && p >= far) return i + 1;
  }
  return ins.length;
}

/**
 * Split a changeState method into its numbered states.
 *
 * The compiler turns `switch (state)` into a chain of
 * `dup / ldi N / eq? / bnt <next>`, so each state's body runs from just
 * after its `bnt` to that branch's target.
 */
export function extractStates(ins: Instruction[], startI: number, ctx: Ctx): State[] {
  const end = methodExtent(ins, startI);
  const states: State[] = [];
  let k = startI;
  while (k < end - 3) {
    if (ins[k].name !== 'dup') { k++; continue; }
    if (ins[k + 1].name !== 'ldi' || !ins[k + 1].args.length) { k++; continue; }
    if (ins[k + 2].name !== 'eq?' || ins[k + 3].name !== 'bnt') { k++; continue; }
    const num = ins[k + 1].args[0];
    const after = k + 4 < ins.length ? ins[k + 4].pc : ins[k + 3].pc;
    const target = after + ins[k + 3].args[0];
    let hi = end;
    for (let i = k + 4; i < end; i++) if (ins[i].pc >= target) { hi = i; break; }
    const r = scanRange(ins, k + 4, hi, ctx);
    states.push({ state: num, conditions: r.conds, effects: r.effects,
                  goto: r.goto, calls: r.calls, says: r.says });
    k = hi;
  }
  return states;
}

/**
 * Find the exported procedure a game uses to print messages.
 *
 * Games differ: SQ3 and Camelot call `calle 255, 0`, QFG2 calls
 * `calle 1, 13`.  Rather than hardcode one, score every (script, export)
 * called with two integer arguments by how often those arguments name a
 * real text resource and a line inside it, and take the best.
 */
export function detectPrinter(game: Game, minSamples = 20, minHit = 0.75):
    [number, number] | null {
  const cands = new Map<string, Array<[number, number]>>();
  for (const res of game.byType('script')) {
    let sc: Script;
    try { sc = new Script(game.data(2, res.number), res.number); } catch { continue; }
    for (const [bn, off, size] of sc.blocks) {
      if (bn !== 'code') continue;
      const [ins, ok] = sweep(sc.data, off + 4, off + size);
      if (!ok) continue;
      for (let k = 0; k < ins.length; k++) {
        const { name: n, args: a } = ins[k];
        if (n !== 'calle' || a.length < 3) continue;
        const nwords = Math.max(0, Math.floor(a[2] / 2));
        if (nwords < 2 || k < nwords) continue;
        const args: Array<number | null> = [];
        for (let q = k - nwords; q < k; q++) {
          const nn = ins[q].name, aa = ins[q].args;
          if (nn === 'pushi' && aa.length) args.push(aa[0]);
          else if (nn === 'push0') args.push(0);
          else if (nn === 'push1') args.push(1);
          else if (nn === 'push2') args.push(2);
          else args.push(null);
        }
        if (args.length >= 2 && typeof args[0] === 'number' && typeof args[1] === 'number') {
          const key = `${a[0]},${a[1]}`;
          const l = cands.get(key);
          if (l) l.push([args[0], args[1]]); else cands.set(key, [[args[0], args[1]]]);
        }
      }
    }
  }
  const cache = new Map<number, string[]>();
  const linesOf = (n: number) => {
    if (!cache.has(n)) {
      const d = game.tryData('text', n);
      cache.set(n, d ? textStrings(d) : []);
    }
    return cache.get(n)!;
  };
  let best: [number, number] | null = null, bestScore = 0;
  for (const [key, pairs] of cands) {
    if (pairs.length < minSamples) continue;
    let hits = 0;
    for (const [a, b] of pairs) if (b >= 0 && b < linesOf(a).length) hits++;
    const rate = hits / pairs.length;
    if (rate >= minHit && hits > bestScore) {
      const [s, e] = key.split(',').map(Number);
      best = [s, e]; bestScore = hits;
    }
  }
  return best;
}

export interface ModelStats {
  saidBlocks: number; handlers: number; unlinked: number;
  printer: [number, number] | null; globalCommands: number;
}

export function build(game: Game, index?: Index):
    { models: Map<number, Room>; stats: ModelStats } {
  const idx = index ?? new Index(game);
  const groups = gameGroups(game);
  const saidK = idx.kernel.map((k, i) => k === 'Said' ? i : -1).filter(i => i >= 0);
  const printer = detectPrinter(game);

  const textCache = new Map<number, string[]>();
  const sayText = (resNo: number, lineNo: number) => {
    if (!textCache.has(resNo)) {
      const d = game.tryData('text', resNo);
      textCache.set(resNo, d ? textStrings(d) : []);
    }
    const lines = textCache.get(resNo)!;
    return (lineNo >= 0 && lineNo < lines.length) ? lines[lineNo] : '';
  };

  const roomsMeta = RG.collect(game, idx);
  // Exits must come from every newRoom literal in the script, not just the
  // ones inside Said handlers: most movement is triggered by walking off a
  // screen edge, which lives in doit/handleEvent, not in a parser command.
  const { links: allLinks } = RL.build(game, idx);
  const models = new Map<number, Room>();
  let globalsCmds: Command[] = [];
  const stats: ModelStats = { saidBlocks: 0, handlers: 0, unlinked: 0, printer, globalCommands: 0 };

  for (const res of game.byType('script')) {
    let sc: Script;
    try { sc = new Script(game.data(2, res.number), res.number); } catch { continue; }
    const meta = roomsMeta.get(res.number);
    const room = new Room(res.number, meta ? meta.name : null,
                          meta ? (meta.picture ?? null) : null);
    room.objects = sc.instances().filter(o => !o.name.startsWith('<anon')).map(o => o.name);
    room.strings = [...sc.strings.values()].filter(t => t.length > 3).slice(0, 40);
    const saidMap = new Map(sc.said);
    const objsByPtr = new Map<number, SciObject>();
    for (const o of sc.objects) objsByPtr.set(o.offset + 12, o);
    const methodOwner = new Map<number, SciObject>();
    for (const o of sc.objects) for (const [, moff] of o.methods) methodOwner.set(moff, o);
    const propCache = new Map<SciObject, string[]>();
    const propsOf = (o: SciObject | null): string[] => {
      if (!o) return [];
      let p = propCache.get(o);
      if (!p) { p = o.propertyNames(idx); propCache.set(o, p); }
      return p;
    };
    stats.saidBlocks += sc.said.length;

    for (const [bn, off, size] of sc.blocks) {
      if (bn !== 'code') continue;
      const [ins, ok] = sweep(sc.data, off + 4, off + size);
      if (!ok) continue;
      const ownerAt = new Map<number, SciObject | null>();
      let curOwner: SciObject | null = null;
      ins.forEach((cur, k) => {
        const o = methodOwner.get(cur.pc);
        if (o) curOwner = o;
        ownerAt.set(k, curOwner);
      });
      const saidAt: number[] = [];
      ins.forEach((cur, k) => {
        if (cur.name === 'callk' && cur.args.length && saidK.includes(cur.args[0])) saidAt.push(k);
      });
      for (let order = 0; order < saidAt.length; order++) {
        const j = saidAt[order];
        let specOff: number | null = null;
        for (let q = j - 1; q > Math.max(-1, j - 6); q--) {
          if ((ins[q].name === 'lofsa' || ins[q].name === 'lofss') && ins[q].args.length) {
            const t = resolveLofs(ins, q);
            if (saidMap.has(t)) { specOff = t; break; }
          }
        }
        if (specOff === null) { stats.unlinked++; continue; }
        let end = order + 1 < saidAt.length ? saidAt[order + 1] : ins.length;
        for (let k = j + 1; k < end; k++) if (ins[k].name === 'ret') { end = k; break; }
        const cmd = new Command(saidDecode(saidMap.get(specOff)!, groups), res.number, specOff);
        const own = ownerAt.get(j) ?? null;
        const ctx: Ctx = { owner: own, objs: objsByPtr,
                           selname: (sid) => idx.selectorName(sid),
                           ownprops: propsOf(own), sayText, printer };
        const r = scanRange(ins, j + 1, end, ctx);
        cmd.conditions = r.conds; cmd.effects = r.effects;
        cmd.goto = r.goto; cmd.calls = r.calls; cmd.says = r.says;
        room.commands.push(cmd);
        stats.handlers++;
      }
    }

    // State machines: the puzzle logic a command hands off to via setScript.
    const csSel = idx.selectorId('changeState');
    if (csSel >= 0) {
      for (const o of sc.objects) {
        const moffs = o.methods.filter(([sid]) => sid === csSel).map(([, off]) => off);
        if (!moffs.length || o.name.startsWith('<anon')) continue;
        for (const [bn2, off2, size2] of sc.blocks) {
          if (bn2 !== 'code' || !(off2 + 4 <= moffs[0] && moffs[0] < off2 + size2)) continue;
          const [ins2, ok2] = sweep(sc.data, off2 + 4, off2 + size2);
          if (!ok2) continue;
          const st = ins2.findIndex(i => i.pc === moffs[0]);
          if (st < 0) continue;
          const ctx2: Ctx = { owner: o, objs: objsByPtr,
                              selname: (sid) => idx.selectorName(sid),
                              ownprops: propsOf(o), sayText, printer };
          const sts = extractStates(ins2, st, ctx2);
          if (sts.length) room.machines.set(o.name, sts);
          break;
        }
      }
    }

    if (meta) {
      // Three sources, and all three are needed: newRoom literals anywhere
      // in the script; the room's own north/south/east/west properties,
      // which the shared Rm base class passes to newRoom as a parameter and
      // so are invisible at the call site; and newRoom inside Said handlers.
      const cardinal = new Set<number>(meta.exits.values());
      const all = new Set<number>([...(allLinks.get(res.number) ?? [])]);
      for (const v of cardinal) all.add(v);
      for (const c of room.commands) for (const g of c.goto) all.add(g);
      for (const sts of room.machines.values()) for (const s of sts) for (const g of s.goto) all.add(g);
      room.exits = [...all].sort((a, b) => a - b);
    }
    if (meta || room.commands.length || room.machines.size) models.set(res.number, room);
    if (res.number === 0) globalsCmds = room.commands;
  }
  stats.globalCommands = globalsCmds.length;
  return { models, stats };
}
