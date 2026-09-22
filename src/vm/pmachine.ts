/**
 * SCI0 PMachine: the execution loop.
 *
 * State is an accumulator, a value stack, and a stack of call frames.
 * Variables come in four flavours -- global (script 0's locals), local
 * (the running script's), temp (allocated on the stack by `link`) and
 * param (pushed by the caller) -- which is why opcodes 0x40-0x7F form a
 * regular block of load/store/inc/dec crossed with those four.
 *
 * A `send` is not always a method call: if the selector names one of the
 * object's properties it is a get (argc 0) or a set (argc 1) instead.
 * Only otherwise does it dispatch through the inheritance chain.
 *
 * Nothing here throws on bad input.  Execution records what went wrong
 * and stops, because a half-ported VM should report its limits rather
 * than pretend.
 */
import type { Game } from '../resources.ts';
import { Script, SciObject, Index } from '../script.ts';
import { decode } from '../disasm.ts';
import { SpeciesTable } from './heap.ts';
import { View } from '../view.ts';

/**
 * Debug sampler.  A blocked synchronous loop never reaches a timer or
 * flushes a CPU profile, so the only way to see inside one is to have it
 * report on itself, unbuffered, as it goes.  Off unless SCI_WATCH is set.
 */
const WATCH = typeof process !== 'undefined' && process.env?.SCI_WATCH
  ? Number(process.env.SCI_WATCH) : 0;
let watchTick = 0;
function watch(line: string) {
  if (!WATCH) return;
  if (++watchTick % WATCH) return;
  console.error(line);   // `require` does not exist in an ES module
}

const s16 = (v: number) => (v & 0x8000) ? v - 0x10000 : v;
/**
 * The unsigned comparisons are a distinct opcode for a reason: games use
 * them to test a 16-bit counter against a value written as a negative
 * literal.  Aliasing them to the signed forms makes `GetTime() ugt -1024`
 * -- the idiom that waits out timer wraparound -- true forever.
 */
const u16 = (v: number) => v & 0xFFFF;

/**
 * Object references carry their script.
 *
 * `lofsa` yields a bare offset into the running script, which is fine
 * until the value is stored in a global and sent to from somewhere else
 * -- by then the script it belonged to is lost.  Tagging references with
 * their script keeps them meaningful anywhere, and the tag sits far
 * above the 16-bit range games actually compute with, so ordinary
 * arithmetic is unaffected.
 */
const REF_TAG = 0x40000000;
export const makeRef = (script: number, offset: number) =>
  REF_TAG | ((script & 0x3FFF) << 16) | (offset & 0xFFFF);
export const isRef = (v: number) => (v & REF_TAG) !== 0;
const refScript = (v: number) => (v >> 16) & 0x3FFF;
const refOffset = (v: number) => v & 0xFFFF;

/** Largest temp/param index a frame may address. */
const FRAME_WINDOW = 512;
/** Hard ceiling on the value stack; exceeding it means we have lost track. */
const MAX_STACK = 8192;
/** Frames, not JS stack depth -- an explicit stack can go much deeper. */
const MAX_FRAMES = 1024;

export class RtObject {
  readonly def: SciObject;
  readonly scriptNo: number;
  /**
   * 32-bit, not 16.  SCI is a 16-bit machine, but this port identifies
   * objects with script-tagged references that do not fit in a word, and
   * properties such as `cycler` and `client` hold exactly those.  Storing
   * them 16-bit silently drops the script tag.  The cost is that
   * arithmetic which relied on 16-bit overflow no longer wraps; the
   * value stack has always behaved that way, so this makes storage
   * consistent with it rather than adding a new deviation.
   */
  props: Int32Array;
  propSelectors: number[];
  constructor(def: SciObject, scriptNo: number, propSelectors: number[]) {
    this.def = def; this.scriptNo = scriptNo;
    this.props = Int32Array.from(def.properties.map(s16));
    this.propSelectors = propSelectors;
  }
  /**
   * The value a script sees when it says `self`.
   *
   * It has to be a real reference, not a "this frame's object" sentinel:
   * `(cast add: self)` stores it in a list, and whoever walks that list
   * later has no frame to interpret a sentinel against.  A clone carries
   * its allocated handle here instead of its template's address.
   */
  handle = 0;
  get name() { return this.def.name; }
  indexOfSelector(sel: number) { return this.propSelectors.indexOf(sel); }
}

interface Frame {
  scriptNo: number; obj: RtObject | null; pc: number;
  tempsBase: number; paramsBase: number; argc: number;
  /**
   * A send may carry several (selector, argc, args) groups, and each
   * method among them must finish before the next begins.  With an
   * explicit frame stack the caller cannot simply recurse, so it parks
   * its cursor here and resumes when the callee returns.
   */
  pending?: { target: RtObject; args: number[]; i: number;
              /** `super` resolves from this class, not from the object. */
              fromSpecies?: number };
  /**
   * Calls a kernel function asked for.  `Animate` sends `doit:` to every
   * cast member, but a kernel cannot push frames -- it returns a value to
   * an interpreter that is mid-instruction.  So it parks the queue on the
   * calling frame and the main loop drains it before moving on, with
   * `result` restored to the accumulator once the queue is empty.
   */
  kcalls?: { items: { target: RtObject; sel: number; params: number[] }[];
             i: number; result: number };
}

export interface RunResult {
  steps: number;
  stopped: 'ret' | 'step-limit' | 'timeout' | 'invalid-opcode' | 'unimplemented' | 'error';
  detail?: string;
  kernelCalls: Map<number, number>;
  unresolvedSends: number;
  /** Why sends failed: distinguishes an uninitialised reference from a
   *  bad one, which decides whether more kernel work would even help. */
  unresolvedKind: Map<string, number>;
  maxStack: number;
  maxDepth: number;
  budget?: number;
  deadline?: number;
}

export class PMachine {
  game: Game; index: Index; species: SpeciesTable;
  globals = new Int32Array(1024);
  private locals = new Map<number, Int32Array>();
  private scripts = new Map<number, Script>();
  private objects = new Map<string, RtObject>();
  acc = 0;
  prev = 0;
  stack: number[] = [];
  frames: Frame[] = [];
  trace: string[] = [];
  traceLimit = 0;

  constructor(game: Game, index?: Index) {
    this.game = game;
    this.index = index ?? new Index(game);
    this.species = new SpeciesTable(game, this.index);
    const s0 = this.script(0);
    if (s0) this.globals.set(Int32Array.from(s0.locals.map(s16)).subarray(0, 1024));
  }

  script(n: number): Script | null {
    if (!this.scripts.has(n)) {
      const d = this.game.tryData('script', n);
      if (!d) return null;
      const s = new Script(d, n);
      this.scripts.set(n, s);
      this.locals.set(n, Int32Array.from(s.locals.map(s16)));
    }
    return this.scripts.get(n) ?? null;
  }

  localsOf(n: number): Int32Array {
    if (!this.locals.has(n)) this.script(n);
    return this.locals.get(n) ?? new Int32Array(0);
  }

  /** Runtime instance of a static object, with its own mutable properties. */
  instantiate(scriptNo: number, def: SciObject): RtObject {
    const key = `${scriptNo}:${def.offset}`;
    let o = this.objects.get(key);
    if (!o) {
      const sels = def.propSelectors ??
        this.species.classOf(def.species)?.propSelectors ?? [];
      o = new RtObject(def, scriptNo, sels);
      o.handle = makeRef(scriptNo, def.offset + 12);
      this.objects.set(key, o);
    }
    return o;
  }

  /** Object whose property array begins at `ptr` (SCI0: block + 12). */
  objectAt(scriptNo: number, ptr: number): RtObject | null {
    const s = this.script(scriptNo);
    if (!s) return null;
    for (const def of s.objects)
      if (def.offset + 12 === ptr) return this.instantiate(scriptNo, def);
    return null;
  }

  private varRef(kind: number, index: number, scriptNo: number, f: Frame):
      { get(): number; set(v: number): void } | null {
    if (kind === 0) {
      const g = this.globals;
      if (index < 0 || index >= g.length) return null;
      return { get: () => g[index], set: (v) => { g[index] = v; } };
    }
    if (kind === 1) {
      const l = this.localsOf(scriptNo);
      if (index < 0 || index >= l.length) return null;
      return { get: () => l[index], set: (v) => { l[index] = v; } };
    }
    // Temps and params live in a bounded window of the value stack.  A
    // garbage index must be refused, not written: `stack[i] = v` on a
    // JS array happily grows it to any index, and one bad write turns
    // the stack into a huge sparse array that makes every later
    // operation crawl.  That, not an infinite loop, was the hang.
    const base = kind === 2 ? f.tempsBase : f.paramsBase;
    if (index < 0 || index >= FRAME_WINDOW) return null;
    const i = base + index;
    if (i < 0 || i >= this.stack.length + FRAME_WINDOW) return null;
    return {
      get: () => this.stack[i] ?? 0,
      set: (v) => {
        while (this.stack.length <= i) this.stack.push(0);   // dense growth only
        this.stack[i] = v;
      },
    };
  }

  /**
   * Run until the starting frame returns, a limit trips, or the machine
   * cannot continue.
   *
   * One loop, one explicit frame stack, no JavaScript recursion: a game's
   * main loop iterates by sending to itself, so recursing per send would
   * grow the JS stack without bound and cap how long a game can run.
   */
  run(scriptNo: number, obj: RtObject | null, pc: number,
      opts: { steps?: number; trace?: number; deadline?: number;
              paramsBase?: number } = {}): RunResult {
    const limit = opts.steps ?? 20000;
    const deadline = opts.deadline ?? (Date.now() + 250);
    this.traceLimit = opts.trace ?? 0;
    this.trace = [];
    const res: RunResult = {
      steps: 0, stopped: 'step-limit', kernelCalls: new Map(),
      unresolvedSends: 0, unresolvedKind: new Map(), maxStack: 0, maxDepth: 0,
      budget: limit, deadline,
    };
    const base = this.frames.length;
    const floor = this.stack.length;
    // A frame nobody called still needs a well-formed argument block.
    // Without one, paramsBase points at whatever the method itself
    // pushes first, and `&rest` reads that as the argument count.
    let paramsBase = opts.paramsBase;
    if (paramsBase === undefined) { paramsBase = this.stack.length; this.stack.push(0); }
    this.frames.push({ scriptNo, obj, pc, tempsBase: this.stack.length,
                       paramsBase, argc: this.stack[paramsBase] ?? 0 });

    while (res.steps < limit) {
      if ((res.steps & 0x0F) === 0 && Date.now() > deadline) {
        res.stopped = 'timeout'; break;
      }
      const f = this.frames[this.frames.length - 1];
      res.maxDepth = Math.max(res.maxDepth, this.frames.length - base);
      res.maxStack = Math.max(res.maxStack, this.stack.length);

      // Resume work interrupted by a method call.
      if (f.kcalls) {
        if (this.stepKernelCalls(f)) continue;    // pushed a frame
      }
      if (f.pending) {
        if (this.stepSend(f, res)) continue;      // pushed a frame
      }

      const s = this.script(f.scriptNo);
      if (!s) { res.stopped = 'error'; res.detail = `script ${f.scriptNo} missing`; break; }
      const ins = decode(s.data, f.pc);
      if (!ins) { res.stopped = 'invalid-opcode'; res.detail = `pc ${f.pc}`; break; }
      res.steps++;
      if (this.stack.length > MAX_STACK) {
        res.stopped = 'error';
        res.detail = 'stack overflow: ' + this.frameDump(base);
        break;
      }
      if (this.frames.length - base > MAX_FRAMES) {
        res.stopped = 'error'; res.detail = 'call depth exceeded'; break;
      }
      if (this.trace.length < this.traceLimit)
        this.trace.push(`${f.pc.toString(16).padStart(4, '0')} ${ins.name} ${ins.args.join(',')}`);
      watch(`s${f.scriptNo} pc=${f.pc} ${ins.name} depth=${this.frames.length} ` +
            `steps=${res.steps} stack=${this.stack.length}`);
      if (this.sampleEvery && res.steps % this.sampleEvery === 0) {
        const parts: string[] = [];
        for (let i = Math.max(base, this.frames.length - 3); i < this.frames.length; i++) {
          const g = this.frames[i];
          parts.push(`s${g.scriptNo}:${g.pc.toString(16)}${g.obj ? '/' + g.obj.name : ''}`);
        }
        const k = parts.join(' < ');
        this.samples.set(k, (this.samples.get(k) ?? 0) + 1);
      }

      const next = f.pc + ins.length;
      f.pc = next;
      const a = ins.args;
      const op = s.data[ins.pc] >> 1;
      const st = this.stack;

      try {
        if (op >= 0x40) {
          const rel = op - 0x40;
          const grp = rel >> 4, rest = rel & 0x0F;
          const kind = rest & 3, toStack = (rest >> 2) & 1, indexed = (rest >> 3) & 1;
          const idx = a[0] + (indexed ? this.acc : 0);
          const ref = this.varRef(kind, idx, f.scriptNo, f);
          if (!ref) { res.stopped = 'error'; res.detail = `var ${kind}[${idx}] out of range`; break; }
          if (grp === 0) { const v = ref.get(); if (toStack) st.push(v); else this.acc = v; }
          else if (grp === 1) { const v = toStack ? (st.pop() ?? 0) : this.acc; ref.set(v); }
          else { const v = ref.get() + (grp === 2 ? 1 : -1); ref.set(v);
                 if (toStack) st.push(v); else this.acc = v; }
          continue;
        }

        switch (ins.name) {
          case 'bnot': this.acc = ~this.acc; break;
          case 'add': this.acc = (st.pop() ?? 0) + this.acc; break;
          case 'sub': this.acc = (st.pop() ?? 0) - this.acc; break;
          case 'mul': this.acc = (st.pop() ?? 0) * this.acc; break;
          case 'div': { const d = this.acc; this.acc = d ? Math.trunc((st.pop() ?? 0) / d) : 0; break; }
          case 'mod': { const d = this.acc; this.acc = d ? (st.pop() ?? 0) % d : 0; break; }
          case 'shr': this.acc = (st.pop() ?? 0) >> this.acc; break;
          case 'shl': this.acc = (st.pop() ?? 0) << this.acc; break;
          case 'xor': this.acc = (st.pop() ?? 0) ^ this.acc; break;
          case 'and': this.acc = (st.pop() ?? 0) & this.acc; break;
          case 'or':  this.acc = (st.pop() ?? 0) | this.acc; break;
          case 'neg': this.acc = -this.acc; break;
          case 'not': this.acc = this.acc ? 0 : 1; break;
          case 'eq?': this.prev = this.acc; this.acc = (st.pop() ?? 0) === this.acc ? 1 : 0; break;
          case 'ne?': this.prev = this.acc; this.acc = (st.pop() ?? 0) !== this.acc ? 1 : 0; break;
          case 'gt?': this.prev = this.acc; this.acc = (st.pop() ?? 0) > this.acc ? 1 : 0; break;
          case 'ge?': this.prev = this.acc; this.acc = (st.pop() ?? 0) >= this.acc ? 1 : 0; break;
          case 'lt?': this.prev = this.acc; this.acc = (st.pop() ?? 0) < this.acc ? 1 : 0; break;
          case 'le?': this.prev = this.acc; this.acc = (st.pop() ?? 0) <= this.acc ? 1 : 0; break;
          case 'ugt?': this.prev = this.acc; this.acc = u16(st.pop() ?? 0) > u16(this.acc) ? 1 : 0; break;
          case 'uge?': this.prev = this.acc; this.acc = u16(st.pop() ?? 0) >= u16(this.acc) ? 1 : 0; break;
          case 'ult?': this.prev = this.acc; this.acc = u16(st.pop() ?? 0) < u16(this.acc) ? 1 : 0; break;
          case 'ule?': this.prev = this.acc; this.acc = u16(st.pop() ?? 0) <= u16(this.acc) ? 1 : 0; break;
          case 'bt': if (this.acc) f.pc = next + a[0]; break;
          case 'bnt': if (!this.acc) f.pc = next + a[0]; break;
          case 'jmp': f.pc = next + a[0]; break;
          case 'ldi': this.acc = a[0]; break;
          case 'push': st.push(this.acc); break;
          case 'selfID': this.acc = f.obj?.handle ?? 0; break;
          case 'pushSelf': st.push(f.obj?.handle ?? 0); break;
          case 'pushi': st.push(a[0]); break;
          case 'push0': st.push(0); break;
          case 'push1': st.push(1); break;
          case 'push2': st.push(2); break;
          case 'toss': st.pop(); break;
          case 'dup': st.push(st[st.length - 1] ?? 0); break;
          case 'pprev': st.push(this.prev); break;
          case 'link': for (let i = 0; i < a[0]; i++) st.push(0); break;
          case 'class': {
            // Names the class object for a species, which is how a script
            // sends to a class it does not hold a reference to.
            const l = this.species.locate(a[0]);
            this.acc = l && this.objectAt(l.script, l.offset + 12)
              ? makeRef(l.script, l.offset + 12) : 0;
            break;
          }
          case 'lea': this.acc = 0; break;

          case 'lofsa': case 'lofss': {
            const off = next + a[0];
            const v = this.objectAt(f.scriptNo, off) ? makeRef(f.scriptNo, off) : off;
            if (ins.name === 'lofsa') this.acc = v; else st.push(v);
            break;
          }

          case 'pToa': case 'pTos': case 'aTop': case 'sTop':
          case 'ipToa': case 'dpToa': case 'ipTos': case 'dpTos': {
            if (!f.obj) { res.stopped = 'error'; res.detail = 'property access with no self'; break; }
            const pi = a[0] >> 1;
            if (pi < 0 || pi >= f.obj.props.length) {
              res.stopped = 'error'; res.detail = `property ${pi} out of range`; break;
            }
            const n = ins.name;
            if (n === 'pToa') this.acc = f.obj.props[pi];
            else if (n === 'pTos') st.push(f.obj.props[pi]);
            else if (n === 'aTop') f.obj.props[pi] = this.acc;
            else if (n === 'sTop') f.obj.props[pi] = st.pop() ?? 0;
            else {
              const d = (n === 'ipToa' || n === 'ipTos') ? 1 : -1;
              f.obj.props[pi] += d;
              if (n === 'ipToa' || n === 'dpToa') this.acc = f.obj.props[pi];
              else st.push(f.obj.props[pi]);
            }
            break;
          }

          case 'callk': {
            // The operand counts argument *bytes*, but the caller also
            // pushes the argument count itself ahead of them -- the same
            // convention `call`/`callb`/`calle` handle with their `- 1`.
            // Popping only the arguments leaks one slot per kernel call,
            // which a game's main loop turns into a steady stack climb.
            const words = a[1] >> 1;
            const pBase = st.length - words - 1;
            if (pBase < 0) { res.stopped = 'error'; res.detail = 'callk: params underflow'; break; }
            const args = st.splice(pBase, words + 1).slice(1);
            res.kernelCalls.set(a[0], (res.kernelCalls.get(a[0]) ?? 0) + 1);
            this.acc = this.kernel(a[0], args, f);
            break;
          }

          case 'send': case 'self': case 'super': {
            const words = Math.max(0, a[a.length - 1] >> 1);
            const args = st.splice(st.length - words, words);
            const target = ins.name === 'send' ? this.resolveTarget(f, this.acc) : f.obj;
            if (!target) {
              const v = this.acc;
              const kind = ins.name !== 'send' ? 'no self'
                : v === 0 ? 'target 0 (uninitialised)'
                : isRef(v) ? 'tagged ref, no object'
                : (v > 0 && v < 65536) ? 'bare offset, no object' : 'other';
              res.unresolvedKind.set(kind, (res.unresolvedKind.get(kind) ?? 0) + 1);
              res.unresolvedSends++;
              break;
            }
            f.pending = { target, args, i: 0,
                          fromSpecies: ins.name === 'super' ? a[0] : undefined };
            this.stepSend(f, res);
            break;
          }

          case 'call': case 'callb': case 'calle': {
            const words = Math.max(0, a[a.length - 1] >> 1);
            const pBase = st.length - words - 1;
            if (pBase < 0) { res.stopped = 'error'; res.detail = `${ins.name}: params underflow`; break; }
            let targetScript = f.scriptNo, targetPc = -1;
            if (ins.name === 'call') targetPc = next + a[0];
            else {
              targetScript = ins.name === 'callb' ? 0 : a[0];
              targetPc = this.exportOffset(targetScript, ins.name === 'callb' ? a[0] : a[1]);
            }
            if (targetPc < 0) { st.length = pBase; this.acc = 0; res.unresolvedSends++; break; }
            this.frames.push({ scriptNo: targetScript, obj: f.obj, pc: targetPc,
                               tempsBase: st.length, paramsBase: pBase,
                               argc: st[pBase] ?? 0 });
            break;
          }

          case '&rest': {
            // argc is a stack value, so it must be sanity-checked before
            // being used as a loop bound.
            const argc = this.stack[f.paramsBase] ?? 0;
            if (argc < 0 || argc > FRAME_WINDOW) break;
            for (let i = a[0]; i <= argc; i++) st.push(this.stack[f.paramsBase + i] ?? 0);
            break;
          }

          case 'ret': {
            const done = this.frames.pop()!;
            st.length = Math.max(floor, Math.min(st.length, done.paramsBase));
            if (this.frames.length <= base) res.stopped = 'ret';
            break;
          }

          default:
            res.stopped = 'unimplemented'; res.detail = ins.name;
        }
      } catch (e: any) {
        res.stopped = 'error'; res.detail = e.message;
      }
      if (res.stopped !== 'step-limit') break;
    }

    // A run that merely ran out of budget still has a story to tell:
    // where it was when the budget ended.
    if (res.stopped === 'step-limit' || res.stopped === 'timeout')
      res.detail = this.frameDump(base);
    else if (res.stopped === 'error' || res.stopped === 'invalid-opcode')
      res.detail = `${res.detail ?? ''} at ${this.frameDump(base)}`;
    while (this.frames.length > base) this.frames.pop();
    this.stack.length = floor;
    return res;
  }

  /**
   * Where the value stack went.  A frame that never gives its slots back
   * shows up as a large gap between its own base and the next frame's,
   * which names the method to look at.
   */
  frameDump(base: number): string {
    const parts: string[] = [];
    for (let i = base; i < this.frames.length; i++) {
      const f = this.frames[i];
      const top = i + 1 < this.frames.length
        ? this.frames[i + 1].paramsBase : this.stack.length;
      parts.push(`[s${f.scriptNo} ${f.obj?.name ?? '-'} pc=${f.pc.toString(16)}` +
                 ` p=${f.paramsBase} t=${f.tempsBase} grew=${top - f.tempsBase}]`);
    }
    return parts.join(' ');
  }

  /**
   * Advance one send's selector groups.  Property gets and sets are done
   * here and now; a method pushes a frame and returns true so the main
   * loop runs it, resuming this cursor when it returns.
   */
  private stepSend(f: Frame, res: RunResult): boolean {
    const p = f.pending!;
    while (p.i + 1 < p.args.length) {
      const sel = p.args[p.i], argc = p.args[p.i + 1];
      if (!Number.isInteger(argc) || argc < 0 || argc > 127) break;
      const params = p.args.slice(p.i + 2, p.i + 2 + argc);
      p.i += 2 + argc;

      const pi = p.fromSpecies === undefined ? p.target.indexOfSelector(sel) : -1;
      if (pi >= 0) {
        if (argc === 0) this.acc = p.target.props[pi];
        else p.target.props[pi] = params[0];
        continue;
      }
      const found = p.fromSpecies !== undefined
        ? this.species.lookupFrom(p.fromSpecies, sel)
        : this.species.lookup(p.target.def, sel, p.target.scriptNo);
      if (!found) { res.unresolvedSends++; continue; }
      const pBase = this.stack.length;
      this.stack.push(argc, ...params);
      this.frames.push({ scriptNo: found.script, obj: p.target, pc: found.offset,
                         tempsBase: this.stack.length, paramsBase: pBase, argc });
      return true;
    }
    f.pending = undefined;
    return false;
  }

  /**
   * Dispatch the next call a kernel function scheduled, if any remain.
   * Members that do not answer the selector are simply skipped.
   */
  private stepKernelCalls(f: Frame): boolean {
    const k = f.kcalls!;
    while (k.i < k.items.length) {
      const it = k.items[k.i++];
      const found = this.species.lookup(it.target.def, it.sel, it.target.scriptNo);
      if (!found) continue;
      const pBase = this.stack.length;
      this.stack.push(it.params.length, ...it.params);
      this.frames.push({ scriptNo: found.script, obj: it.target, pc: found.offset,
                         tempsBase: this.stack.length, paramsBase: pBase,
                         argc: it.params.length });
      return true;
    }
    this.acc = k.result;
    f.kcalls = undefined;
    return false;
  }

  /** An accumulator value that should name an object. */
  resolveTarget(f: Frame | null, ref: number): RtObject | null {
    if (ref === -1) return f?.obj ?? null;
    if (this.clones.has(ref)) return this.clones.get(ref)!;
    if (isRef(ref)) return this.objectAt(refScript(ref), refOffset(ref));
    return f ? this.objectAt(f.scriptNo, ref) : null;
  }

  /** Offset of exported procedure `index` in `scriptNo`, or -1. */
  exportOffset(scriptNo: number, index: number): number {
    const s = this.script(scriptNo);
    if (!s || index < 0 || index >= s.exports.length) return -1;
    const off = s.exports[index];
    return (off > 0 && off < s.data.length) ? off : -1;
  }

  private clones = new Map<number, RtObject>();
  /**
   * Lists and nodes are kernel-owned structures a script only ever holds
   * a handle to, so they live here rather than in script memory.  Handles
   * share one descending allocator with clones: script 0x3FFF is a number
   * no game uses, which keeps every handle distinguishable from a real
   * object reference while still passing `isRef`.
   */
  private lists = new Map<number, { first: number; last: number }>();
  private nodes = new Map<number, { key: number; value: number;
                                    prev: number; next: number }>();
  private nextHandle = REF_TAG | (0x3FFF << 16) | 0xFFFF;
  private alloc() { return this.nextHandle--; }
  private rng = 1;

  /** Cached because Animate needs it on every frame. */
  private selDoit = -2;

  /**
   * Ticks since start, 1/60 s as the games assume.  A clock that never
   * advances turns every `while (< (GetTime) deadline)` into a spin, so
   * time has to move even when nothing is drawn.
   */
  private ticks = 0;

  /**
   * Periodic sample of the innermost frame.  Where a run spends its
   * instructions is a different question from where it happened to stop,
   * and only a histogram answers the first one.
   */
  sampleEvery = 0;
  samples = new Map<string, number>();

  /** What Animate actually reached, for measurement. */
  animateStats = { calls: 0, doits: 0, max: 0, names: new Set<string>() };


  /** Walk a list to its values, cycle-guarded against damaged links. */
  private listValues(h: number): number[] {
    const l = this.lists.get(h);
    if (!l) return [];
    const out: number[] = [];
    const seen = new Set<number>();
    for (let n = l.first; n && !seen.has(n); ) {
      seen.add(n);
      const node = this.nodes.get(n);
      if (!node) break;
      out.push(node.value);
      n = node.next;
    }
    return out;
  }

  private unlink(listH: number, nodeH: number) {
    const l = this.lists.get(listH), n = this.nodes.get(nodeH);
    if (!l || !n) return;
    if (n.prev) { const p = this.nodes.get(n.prev); if (p) p.next = n.next; }
    else l.first = n.next;
    if (n.next) { const q = this.nodes.get(n.next); if (q) q.prev = n.prev; }
    else l.last = n.prev;
    n.prev = n.next = 0;
  }

  /**
   * Give every cast member its turn.
   *
   * Drawing is a renderer's business; what the scripts depend on is that
   * each member receives `doit:`, because that is what advances cyclers
   * and movers -- and a cycler reaching the end of its loop is what sends
   * `cue:`, which is how an SCI0 game steps a puzzle forward.
   */
  private animate(castH: number, f?: Frame): number {
    if (this.selDoit === -2) this.selDoit = this.index.selectorId('doit');
    if (this.selDoit < 0 || !f) return 0;
    const items: { target: RtObject; sel: number; params: number[] }[] = [];
    for (const v of this.listValues(castH)) {
      const o = this.resolveTarget(null, v);
      if (o) items.push({ target: o, sel: this.selDoit, params: [] });
    }
    this.animateStats.calls++;
    this.animateStats.doits += items.length;
    this.animateStats.max = Math.max(this.animateStats.max, items.length);
    for (const it of items) this.animateStats.names.add(it.target.name);
    if (items.length) f.kcalls = { items, i: 0, result: 0 };
    return 0;
  }

  /**
   * The handful of kernel calls that shape control flow.  Everything
   * else is recorded and returns 0 -- graphics and sound cannot change
   * what a script decides, but object identity can.
   */
  kernel(id: number, args: number[], f?: Frame): number {
    const a0 = args[0] ?? 0, a1 = args[1] ?? 0;
    switch (this.index.kernelName(id)) {
      case 'ScriptID': return this.scriptID(args[0] ?? 0, args[1] ?? 0);
      case 'Clone': return this.cloneObject(args[0] ?? 0);
      case 'DisposeClone': this.clones.delete(args[0] ?? 0); return 0;
      case 'IsObject': return this.resolveTarget(null, args[0] ?? 0) ? 1 : 0;
      case 'RespondsTo': {
        const o = this.resolveTarget(null, args[0] ?? 0);
        if (!o) return 0;
        const sel = args[1] ?? 0;
        return (o.indexOfSelector(sel) >= 0 ||
                this.species.lookup(o.def, sel, o.scriptNo) !== null) ? 1 : 0;
      }
      case 'Load': this.script(args[1] ?? 0); return args[1] ?? 0;

      // --- time -------------------------------------------------------
      case 'GetTime': return this.ticks & 0x7FFF;
      case 'Wait': { const prev = this.ticks; this.ticks += Math.max(1, a0); return this.ticks - prev; }

      // --- lists and nodes --------------------------------------------
      case 'NewList': { const h = this.alloc(); this.lists.set(h, { first: 0, last: 0 }); return h; }
      case 'DisposeList': {
        const l = this.lists.get(a0);
        if (l) { for (let n = l.first; n; ) { const nd = this.nodes.get(n); this.nodes.delete(n); n = nd?.next ?? 0; } }
        this.lists.delete(a0); return 0;
      }
      case 'NewNode': {   // NewNode(value, key)
        const h = this.alloc();
        this.nodes.set(h, { key: a1, value: a0, prev: 0, next: 0 });
        return h;
      }
      case 'FirstNode': return this.lists.get(a0)?.first ?? 0;
      case 'LastNode': return this.lists.get(a0)?.last ?? 0;
      case 'NextNode': return this.nodes.get(a0)?.next ?? 0;
      case 'PrevNode': return this.nodes.get(a0)?.prev ?? 0;
      case 'NodeValue': return this.nodes.get(a0)?.value ?? 0;
      case 'EmptyList': return this.lists.get(a0)?.first ? 0 : 1;
      case 'AddToFront': {
        const l = this.lists.get(a0), n = this.nodes.get(a1);
        if (!l || !n) return a1;
        n.prev = 0; n.next = l.first;
        if (l.first) { const q = this.nodes.get(l.first); if (q) q.prev = a1; } else l.last = a1;
        l.first = a1; return a1;
      }
      case 'AddToEnd': {
        const l = this.lists.get(a0), n = this.nodes.get(a1);
        if (!l || !n) return a1;
        n.next = 0; n.prev = l.last;
        if (l.last) { const p = this.nodes.get(l.last); if (p) p.next = a1; } else l.first = a1;
        l.last = a1; return a1;
      }
      case 'AddAfter': {   // AddAfter(list, node, newNode)
        const l = this.lists.get(a0), at = this.nodes.get(a1), nn = this.nodes.get(args[2] ?? 0);
        if (!l || !nn) return 0;
        if (!at) return this.kernel(id, [a0, args[2] ?? 0], f);
        nn.prev = a1; nn.next = at.next;
        if (at.next) { const q = this.nodes.get(at.next); if (q) q.prev = args[2] ?? 0; }
        else l.last = args[2] ?? 0;
        at.next = args[2] ?? 0; return args[2] ?? 0;
      }
      case 'FindKey': {
        for (let n = this.lists.get(a0)?.first ?? 0; n; ) {
          const nd = this.nodes.get(n); if (!nd) break;
          if (nd.key === a1) return n;
          n = nd.next;
        }
        return 0;
      }
      case 'DeleteKey': {
        for (let n = this.lists.get(a0)?.first ?? 0; n; ) {
          const nd = this.nodes.get(n); if (!nd) break;
          const next = nd.next;
          if (nd.key === a1) { this.unlink(a0, n); this.nodes.delete(n); return 1; }
          n = next;
        }
        return 0;
      }

      case 'Animate': return this.animate(a0, f);

      // --- geometry ---------------------------------------------------
      // SCI angles are degrees clockwise from north, which is why sine
      // drives x and cosine drives y (and y grows downward, so it is
      // negated).  Movers and `findPosn` are built entirely out of these.
      case 'SinMult': return Math.round(Math.sin(a0 * Math.PI / 180) * a1);
      case 'CosMult': return Math.round(Math.cos(a0 * Math.PI / 180) * a1);
      case 'SinDiv': { const d = Math.sin(a0 * Math.PI / 180); return d ? Math.round(a1 / d) : 0; }
      case 'CosDiv': { const d = Math.cos(a0 * Math.PI / 180); return d ? Math.round(a1 / d) : 0; }
      case 'Abs': return Math.abs(s16(u16(a0)));
      case 'Sqrt': return Math.round(Math.sqrt(Math.abs(a0)));
      case 'GetDistance': {
        const dx = a0 - (args[2] ?? 0), dy = a1 - (args[3] ?? 0);
        return Math.round(Math.sqrt(dx * dx + dy * dy));
      }
      case 'GetAngle': {
        // (x1,y1) -> (x2,y2), degrees clockwise from north.
        const dx = (args[2] ?? 0) - a0, dy = (args[3] ?? 0) - a1;
        if (!dx && !dy) return 0;
        return ((Math.round(Math.atan2(dx, -dy) * 180 / Math.PI) % 360) + 360) % 360;
      }

      /**
       * No obstacle model yet -- but the stub has to say "yes".  `CanBeHere`
       * returning 0 means "blocked", and `Act::findPosn` loops until it
       * finds somewhere it can stand, so a blanket "no" is an infinite
       * search that stops a room ever finishing its init.
       */
      case 'CanBeHere': return 1;
      case 'OnControl': return 0;

      // --- view metrics -----------------------------------------------
      // A cycler decides it has finished by comparing `cel` against the
      // loop's last cel, so `NumCels` returning 0 means no cycle ever
      // completes, no `cue:` is ever sent, and every animation sits on
      // its first frame.  These come straight out of the view decoder.
      case 'NumLoops': return this.view(this.propOf(a0, 'view'))?.loopCount ?? 0;
      case 'NumCels': {
        const v = this.view(this.propOf(a0, 'view'));
        return v?.loops[this.propOf(a0, 'loop')]?.length ?? 0;
      }
      case 'CelWide': return this.view(a0)?.loops[a1]?.[args[2] ?? 0]?.width ?? 0;
      case 'CelHigh': return this.view(a0)?.loops[a1]?.[args[2] ?? 0]?.height ?? 0;
      case 'Random': {
        const lo = args[0] ?? 0, hi = args[1] ?? 0;
        this.rng = (this.rng * 1103515245 + 12345) & 0x7FFFFFFF;   // deterministic
        return hi > lo ? lo + (this.rng % (hi - lo + 1)) : lo;
      }
      default: return 0;
    }
  }

  private views = new Map<number, View | null>();

  /** Decoded view resource, cached; null when absent or malformed. */
  private view(n: number): View | null {
    if (!this.views.has(n)) {
      const d = n >= 0 ? this.game.tryData('view', n) : null;
      let v: View | null = null;
      if (d) { try { v = new View(d); } catch { v = null; } }
      this.views.set(n, v);
    }
    return this.views.get(n) ?? null;
  }

  /** Read a named property off an object handle, or -1. */
  private propOf(ref: number, name: string): number {
    const o = this.resolveTarget(null, ref);
    if (!o) return -1;
    const i = o.indexOfSelector(this.index.selectorId(name));
    return i < 0 ? -1 : o.props[i];
  }

  /** A script's exported object, which is how scripts reach each other. */
  scriptID(scriptNo: number, index: number): number {
    const off = this.exportOffset(scriptNo, index);
    if (off < 0) return 0;
    const s = this.script(scriptNo);
    if (!s) return 0;
    // An export may point at the object header or at its property array.
    for (const def of s.objects)
      if (def.offset === off || def.offset + 12 === off) {
        this.instantiate(scriptNo, def);
        return makeRef(scriptNo, def.offset + 12);
      }
    return makeRef(scriptNo, off);
  }

  cloneObject(ref: number): number {
    const src = this.resolveTarget(null, ref);
    if (!src) return 0;
    const copy = new RtObject(src.def, src.scriptNo, src.propSelectors);
    copy.props = Int32Array.from(src.props);
    const handle = this.alloc();
    copy.handle = handle;
    this.clones.set(handle, copy);
    return handle;
  }
}
