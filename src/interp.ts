/**
 * Read a room's `init` method to find the staging that isn't in the data.
 *
 * Static properties describe where the compiler left a prop; `init` is
 * where the room actually dresses the set -- hiding things, repositioning
 * them, picking a loop for the time of day.  This walks the method and
 * applies the sends it can resolve.
 *
 * It is an approximation, deliberately:
 *
 *  - Conditional branches are flattened: every send in the method body is
 *    applied in address order, last write wins.  Real staging often
 *    depends on game state -- time of day, plot flags -- that only
 *    exists at run time, so there is no single correct answer to extract.
 *  - Only sends to objects named by `lofsa`/`lofss` are applied.
 *    Anything reached through a variable or the cast list is reported,
 *    not guessed.
 *
 * Send encoding: the stack holds (selector, argc, args...) groups and the
 * accumulator holds the target; `send N` consumes N *bytes*, so N/2 words.
 */
import { sweep, type Instruction } from './disasm.ts';
import type { Script, SciObject, Index } from './script.ts';

/** A resolved object reference; anything else on the stack is unknown. */
export class ObjRef {
  offset: number; name: string;
  constructor(offset: number, name: string) { this.offset = offset; this.name = name; }
}

type Slot = number | ObjRef | null;     // null is "unknown"

const VISIBILITY = ['hide', 'show'];
const POSITION = ['posn', 'x', 'y', 'z'];
const APPEARANCE = ['view', 'loop', 'cel', 'setPri', 'priority'];

export interface Override {
  hidden?: boolean;
  x?: number; y?: number; z?: number;
  view?: number; loop?: number; cel?: number; priority?: number;
}

export class InitAnalysis {
  script: Script; index: Index; room: SciObject;
  private sel = new Map<number, string>();
  private objs = new Map<number, SciObject>();
  changes = new Map<string, Override>();
  unresolved = 0;
  sends = 0;

  constructor(script: Script, index: Index, room: SciObject) {
    this.script = script; this.index = index; this.room = room;
    for (const n of [...VISIBILITY, ...POSITION, ...APPEARANCE, 'init', 'setLoop']) {
      const i = index.selectors.indexOf(n);
      if (i >= 0) this.sel.set(i << index.selectorShift, n);
    }
    // An SCI0 object pointer addresses the property array, not the header.
    for (const o of script.objects) this.objs.set(o.offset + 12, o);
  }

  private set(name: string, field: keyof Override, value: number | boolean) {
    const cur = this.changes.get(name) ?? {};
    (cur as Record<string, unknown>)[field] = value;
    this.changes.set(name, cur);
  }

  entry(): number | null {
    for (const [sid, off] of this.room.methods)
      if (this.index.selectorName(sid) === 'init') return off;
    return null;
  }

  /**
   * Instructions belonging to the method: walk to a `ret` that no forward
   * branch jumps past.
   */
  private extent(ins: Instruction[], startI: number): Instruction[] {
    const out: Instruction[] = [];
    let far = 0;
    for (let i = startI; i < ins.length; i++) {
      const cur = ins[i];
      out.push(cur);
      if (/^(bt|bnt|jmp)$/.test(cur.name) && cur.args.length) {
        const base = i + 1 < ins.length ? ins[i + 1].pc : cur.pc;
        far = Math.max(far, base + cur.args[0]);
      }
      if (cur.name === 'ret' && cur.pc >= far) break;
    }
    return out;
  }

  run(): Map<string, Override> {
    const entry = this.entry();
    if (entry === null) return this.changes;
    for (const [bname, off, size] of this.script.blocks) {
      if (bname !== 'code') continue;
      if (!(off + 4 <= entry && entry < off + size)) continue;
      const [ins, ok] = sweep(this.script.data, off + 4, off + size);
      if (!ok) return this.changes;
      const idx = ins.findIndex(i => i.pc === entry);
      if (idx < 0) return this.changes;
      this.exec(this.extent(ins, idx), ins);
      break;
    }
    return this.changes;
  }

  private exec(body: Instruction[], all: Instruction[]) {
    const stack: Slot[] = [];
    let acc: Slot = null;
    const pos = new Map<number, number>();
    all.forEach((i, n) => { pos.set(i.pc, n); });

    for (const cur of body) {
      const at = pos.get(cur.pc)!;
      const nxt = at + 1 < all.length ? all[at + 1].pc : cur.pc;
      const n = cur.name, a = cur.args;
      if (n === 'pushi') stack.push(a[0]);
      else if (n === 'push0') stack.push(0);
      else if (n === 'push1') stack.push(1);
      else if (n === 'push2') stack.push(2);
      else if (n === 'ldi') acc = a[0];
      else if (n === 'push') stack.push(acc);
      else if (n === 'pushSelf') stack.push(new ObjRef(-1, this.room.name));
      else if (n === 'dup') stack.push(stack.length ? stack[stack.length - 1] : null);
      else if (n === 'toss') { if (stack.length) stack.pop(); }
      else if (n === 'lofsa') acc = this.ref(nxt + a[0]);
      else if (n === 'lofss') stack.push(this.ref(nxt + a[0]));
      else if (n === 'send' || n === 'self' || n === 'super') {
        const target = n === 'send' ? acc : new ObjRef(-1, this.room.name);
        this.apply(target, stack, a[a.length - 1]);
      }
      else if (n.startsWith('ls')) stack.push(null);          // load to stack
      else if (n.startsWith('la') || n === 'class') acc = null;
      else if (['add', 'sub', 'mul', 'div', 'mod', 'eq?', 'ne?', 'gt?', 'lt?',
                'ge?', 'le?', 'and', 'or', 'xor'].includes(n)) acc = null;
    }
  }

  private ref(target: number): Slot {
    const o = this.objs.get(target);
    return o ? new ObjRef(target, o.name) : null;
  }

  private apply(target: Slot, stack: Slot[], argcBytes: number) {
    const words = Math.max(0, Math.floor(argcBytes / 2));
    const args = words ? stack.slice(Math.max(0, stack.length - words)) : [];
    stack.length = stack.length - args.length;
    this.sends++;
    if (!(target instanceof ObjRef)) { this.unresolved++; return; }
    let i = 0;
    while (i + 1 < args.length) {
      const sid = args[i], argc = args[i + 1];
      if (typeof sid !== 'number' || typeof argc !== 'number' || argc < 0) return;
      const params = args.slice(i + 2, i + 2 + argc);
      i += 2 + argc;
      const name = this.sel.get(sid);
      if (name === undefined) continue;
      if (argc === 0 && !VISIBILITY.includes(name)) continue;
      const p0 = params[0];
      if (name === 'hide') this.set(target.name, 'hidden', true);
      else if (name === 'show') this.set(target.name, 'hidden', false);
      else if (name === 'posn' && params.length >= 2) {
        if (typeof params[0] === 'number') this.set(target.name, 'x', params[0]);
        if (typeof params[1] === 'number') this.set(target.name, 'y', params[1]);
      }
      else if (['x', 'y', 'z', 'view', 'loop', 'cel'].includes(name) && params.length) {
        if (typeof p0 === 'number') this.set(target.name, name as keyof Override, p0);
      }
      else if ((name === 'setPri' || name === 'priority') && params.length) {
        if (typeof p0 === 'number' && p0 >= 0) this.set(target.name, 'priority', p0);
      }
    }
  }
}
