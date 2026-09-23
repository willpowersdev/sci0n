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
import { View, type Cel } from '../view.ts';
import { Picture } from '../pic.ts';
import { Font } from '../font.ts';
import { strings as textStrings } from '../text.ts';
import { Screen, WIDTH, HEIGHT } from './screen.ts';
import { SoundBox, SIGNAL_FINISHED } from './sounds.ts';

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

/**
 * SCI0 event types, as the scripts test them.
 *
 * `peek` is a flag on the mask rather than a type: it asks to look at
 * the queue without taking anything off it.
 */
/**
 * The signal bit that pins an actor's priority.
 *
 * Not a guess: `View::setPri` sets it when given a priority and clears
 * it when given -1, so it is the game's own record of "leave this
 * alone".  Everything without it follows its y down the screen.
 */
export const SIGNAL_FIXED_PRIORITY = 0x10;

/**
 * Signal bits that say an actor is not there to be bumped into.
 *
 * 0x4000 is "ignore actors": `Act::canBeHere` skips the whole check when
 * the mover carries it, which is what makes a doorway walkable --
 * Camelot's `door` has it where its `armourStand` and `pouch` do not.
 * The other two cover an actor whose view has been taken away and one
 * the interpreter is not maintaining, neither of which is on the floor
 * to stand on.
 */
export const SIGNAL_NO_BLOCK = 0x4000 | 0x0080 | 0x0004;

export const EV = {
  null: 0x0000, mouseDown: 0x0001, mouseUp: 0x0002,
  keyboard: 0x0004, joystick: 0x0008, direction: 0x0040,
  said: 0x0080, peek: 0x8000,
} as const;

/**
 * Direction keys, as the numeric keypad's scan codes.
 *
 * Directions run clockwise from north, 1 to 8, with 0 for the centre
 * key that stops the ego -- the same numbering the movers use.  The
 * arrow keys send the keypad's codes, which is why there is only one
 * table: on the hardware they were the same keys.
 */
const KEY_DIRECTION: Record<number, number> = {
  0x4700: 8, 0x4800: 1, 0x4900: 2, 0x4B00: 7, 0x4C00: 0,
  0x4D00: 3, 0x4F00: 6, 0x5000: 5, 0x5100: 4,
};

export interface SciEvent {
  type: number; message: number; modifiers: number; x: number; y: number;
}

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
  /**
   * Arguments `&rest` added to the call that follows it.
   *
   * `&rest` does not merely push: it widens the next call.  The compiler
   * emits `pushi sel / push0 / &rest 2 / send 4` for `(send obj sel:
   * &rest)`, where the operand counts only the two words it can see and
   * the rest are added at run time.
   */
  private restAdjust = 0;
  stack: number[] = [];
  frames: Frame[] = [];
  trace: string[] = [];
  traceLimit = 0;
  /** What the game has drawn. */
  screen = new Screen();
  /** Input waiting to be collected by GetEvent. */
  events: SciEvent[] = [];
  /** Where the pointer is, which several kernels report. */
  mouseX = 160;
  mouseY = 95;
  /** Number of the picture currently shown, for the host. */
  currentPic = -1;
  /** The AdLib driver the game drives through `DoSound`. */
  sounds: SoundBox;

  /**
   * Tell any script waiting on music that its piece has finished.
   *
   * Audio is produced by whatever is pulling samples, which is not the
   * machine, so a finished piece has to be noticed rather than returned.
   * `Sound::check` polls `signal` and a room script's `changeState` will
   * sit on the same state for ever until it reads -1 here.
   */
  pumpSounds() {
    for (const handle of this.sounds.takeEnded()) {
      const obj = this.resolveTarget(null, handle);
      if (obj) this.setProp(obj, 'signal', SIGNAL_FINISHED);
    }
  }
  private views = new Map<number, View | null>();
  private fonts = new Map<number, Font | null>();
  private selCache = new Map<string, number>();
  /** Strings the kernel made, which scripts hold by handle. */
  private strings = new Map<number, string>();
  private textRes = new Map<number, string[]>();
  /** Where Display leaves the caret, and what it last drew with. */
  private dsFont = 0;
  /**
   * Ports.  A window makes its own the active one, and everything drawn
   * afterwards is placed relative to it -- which is why a control's tiny
   * `ns` rectangle lands inside the dialog rather than at the top-left
   * of the screen.
   */
  private ports: Array<{ x: number; y: number; w: number; h: number }> =
    [{ x: 0, y: 0, w: WIDTH, h: HEIGHT }];
  private windows = new Map<number, {
    rect: { x0: number; y0: number; w: number; h: number; buf: Uint8Array };
    port: { x: number; y: number; w: number; h: number };
  }>();

  constructor(game: Game, index?: Index) {
    this.game = game;
    this.index = index ?? new Index(game);
    this.sounds = new SoundBox(game, this.index);
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
  /**
   * Run until the starting frame returns, a limit trips, or the machine
   * cannot continue.
   *
   * `resume` continues an earlier run instead of starting one: a game's
   * main loop never returns, so playing it means executing a slice per
   * displayed frame and picking up exactly where the last slice stopped.
   * When a slice runs out of budget the frames are left standing for
   * that reason -- unwinding them would restart the game every frame.
   */
  run(scriptNo: number, obj: RtObject | null, pc: number,
      opts: { steps?: number; trace?: number; deadline?: number;
              paramsBase?: number; resume?: boolean; keep?: boolean } = {}): RunResult {
    const limit = opts.steps ?? 20000;
    const deadline = opts.deadline ?? (Date.now() + 250);
    this.traceLimit = opts.trace ?? 0;
    this.trace = [];
    const res: RunResult = {
      steps: 0, stopped: 'step-limit', kernelCalls: new Map(),
      unresolvedSends: 0, unresolvedKind: new Map(), maxStack: 0, maxDepth: 0,
      budget: limit, deadline,
    };
    const base = opts.resume ? 0 : this.frames.length;
    const floor = opts.resume ? 0 : this.stack.length;
    if (!opts.resume) {
      // A frame nobody called still needs a well-formed argument block.
      // Without one, paramsBase points at whatever the method itself
      // pushes first, and `&rest` reads that as the argument count.
      let paramsBase = opts.paramsBase;
      if (paramsBase === undefined) { paramsBase = this.stack.length; this.stack.push(0); }
      this.frames.push({ scriptNo, obj, pc, tempsBase: this.stack.length,
                         paramsBase, argc: this.stack[paramsBase] ?? 0 });
    }
    if (!this.frames.length) { res.stopped = 'ret'; return res; }

    let yielded = false;
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
          case 'lea': {
            // The address of a variable, which is how a script hands the
            // kernel somewhere to write: `Format` and `GetFarText` are
            // both given a buffer this way.  There is no byte-addressable
            // script memory for a variable here, so each slot gets a
            // stable handle standing in for its address -- returning zero
            // instead, as this did, makes every formatted string null.
            const kind = (a[0] >> 1) & 3;
            const idx = a[1] + ((a[0] & 0x10) ? this.acc : 0);
            this.acc = this.bufferFor(kind, idx, f.scriptNo, f);
            break;
          }

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
            const words = (a[1] >> 1) + this.restAdjust;
            const pBase = st.length - words - 1;
            if (pBase < 0) { res.stopped = 'error'; res.detail = 'callk: params underflow'; break; }
            st[pBase] = words;
            // `Wait` is the game saying it has finished a cycle and wants
            // the rest of its frame back.  It blocks on real hardware, so
            // it has to block here: the instruction is left un-executed
            // and the slice ends, and the same `Wait` runs again next
            // frame until enough ticks have gone by.  Returning
            // immediately instead lets a game run its whole cycle as many
            // times as the instruction budget allows, which is why
            // everything moved far too fast.
            if (this.index.kernelName(a[0]) === 'Wait') {
              const asked = st[pBase + 1] ?? 0;
              const want = asked > 0 ? asked : this.minWait;
              if (this.ticks - this.lastWait < want) {
                f.pc = ins.pc;          // run this same Wait again next slice
                yielded = true;
                break;
              }
            }
            this.restAdjust = 0;
            const args = st.splice(pBase, words + 1).slice(1);
            res.kernelCalls.set(a[0], (res.kernelCalls.get(a[0]) ?? 0) + 1);
            this.acc = this.kernel(a[0], args, f);
            break;
          }

          case 'send': case 'self': case 'super': {
            const rest = this.restAdjust;
            const words = Math.max(0, a[a.length - 1] >> 1) + rest;
            this.restAdjust = 0;
            const args = st.splice(st.length - words, words);
            if (rest) this.widenLastGroup(args, rest);
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
            const words = Math.max(0, a[a.length - 1] >> 1) + this.restAdjust;
            this.restAdjust = 0;
            const pBase = st.length - words - 1;
            if (pBase < 0) { res.stopped = 'error'; res.detail = `${ins.name}: params underflow`; break; }
            // A call's count word is simply however many words were
            // pushed, so `&rest` needs no separate bookkeeping here.
            st[pBase] = words;
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
            let pushed = 0;
            for (let i = a[0]; i <= argc; i++) { st.push(this.stack[f.paramsBase + i] ?? 0); pushed++; }
            // The count word for the call being built has to grow by the
            // same amount, but it is not at a fixed distance from here:
            // it sits below whatever arguments were pushed explicitly
            // first.  `(mover init: self &rest 2)` pushes one, and
            // reaching past it lands on that argument and corrupts it
            // instead -- which is how the ego came to be given a mover
            // whose client was a number that resolved to nothing.  Only
            // the instruction that consumes these knows the layout, so
            // the count is recorded and fixed up there.
            this.restAdjust += pushed;
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
      if (yielded || res.stopped !== 'step-limit') break;
    }

    // A run that merely ran out of budget still has a story to tell:
    // where it was when the budget ended.
    if (res.stopped === 'step-limit' || res.stopped === 'timeout')
      res.detail = this.frameDump(base);
    else if (res.stopped === 'error' || res.stopped === 'invalid-opcode')
      res.detail = `${res.detail ?? ''} at ${this.frameDump(base)}`;
    const ranOut = res.stopped === 'step-limit' || res.stopped === 'timeout';
    if (!(opts.keep && ranOut)) {
      while (this.frames.length > base) this.frames.pop();
      this.stack.length = floor;
    }
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
      if (!found) {
        // A selector the object does not answer returns nothing, and
        // "nothing" has to be zero: leaving the accumulator alone lets
        // whatever was in it stand as the result, and a caller like
        // `firstTrue` reads that as success.
        res.unresolvedSends++;
        this.acc = 0;
        continue;
      }
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
   * How far a mover's client should move this cycle.
   *
   * A straight line to the target, limited to the client's own step in
   * whichever axis dominates, and landing exactly on the target once it
   * is within one step.  Working it out from the current position each
   * cycle rather than accumulating a stored increment keeps the path
   * straight without rounding drift, and means a client nudged by
   * anything else simply carries on from where it now is.
   */
  private bresenStep(mover: RtObject, client: RtObject, mult: number) {
    const cx = s16(u16(this.prop(client, 'x')));
    const cy = s16(u16(this.prop(client, 'y')));
    const tx = s16(u16(this.prop(mover, 'x', cx)));
    const ty = s16(u16(this.prop(mover, 'y', cy)));
    const dx = tx - cx, dy = ty - cy;
    const sx = Math.max(1, Math.abs(s16(u16(this.prop(client, 'xStep', 3))))) * mult;
    const sy = Math.max(1, Math.abs(s16(u16(this.prop(client, 'yStep', 2))))) * mult;
    if (Math.abs(dx) <= sx && Math.abs(dy) <= sy) return { dx, dy };
    if (Math.abs(dx) * sy >= Math.abs(dy) * sx) {
      const step = Math.sign(dx) * sx;
      return { dx: step, dy: Math.round(dy * sx / Math.abs(dx)) };
    }
    const step = Math.sign(dy) * sy;
    return { dx: Math.round(dx * sy / Math.abs(dy)), dy: step };
  }

  /**
   * The strip of floor a cast member stands on.
   *
   * Worked out from where the member is now rather than read back from
   * its `br` properties, which only the members that run a full `doit`
   * keep up to date: SQ3's `motivator` sits at 183,169 carrying a base
   * rectangle left over from the origin, and trusting that would put an
   * invisible obstacle in the corner of the room and none where the
   * thing actually is.
   */
  private baseRectOf(o: RtObject, atX?: number, atY?: number) {
    const cel = this.celOf(o);
    if (!cel) return null;
    const x = atX ?? s16(u16(this.prop(o, 'x')));
    const y = atY ?? s16(u16(this.prop(o, 'y')));
    const r = this.celRect(cel, x, y, s16(u16(this.prop(o, 'z'))));
    const step = Math.max(1, s16(u16(this.prop(o, 'yStep', 2))));
    if (r.right <= r.left) return null;
    return { left: r.left, right: r.right, top: y + 1 - step, bottom: y + 1 };
  }

  /**
   * Would this actor's feet land on another cast member's?
   *
   * Actors stand on each other's base rectangles, not their pictures --
   * two characters may overlap on screen while standing apart.  A
   * member with the "ignore actors" bit is walked through on purpose,
   * which is how doorways work: Camelot's `door` carries it, its
   * `armourStand` and `pouch` do not.
   */
  private blockedByCast(o: RtObject, left: number, top: number,
                        right: number, bottom: number, listH: number): boolean {
    if (!listH) return false;
    // An actor that ignores others is not stopped by them either.
    if (u16(this.prop(o, 'signal')) & 0x4000) return false;
    for (const v of this.listValues(listH)) {
      const m = this.resolveTarget(null, v);
      if (!m || m === o) continue;
      const sig = u16(this.prop(m, 'signal'));
      if (sig & SIGNAL_NO_BLOCK) continue;
      const b = this.baseRectOf(m);
      if (!b) continue;                               // no base to stand on
      if (left < b.right && b.left < right && top < b.bottom && b.top < bottom) return true;
    }
    return false;
  }

  /**
   * Could this actor stand with its feet at (x, y)?
   *
   * The base rectangle is worked out for the position being considered
   * rather than read from the actor, so a step can be tested before it
   * is taken.
   */
  private legalAt(o: RtObject, x: number, y: number): boolean {
    const b = this.baseRectOf(o, x, y);
    if (!b) return true;
    if (b.left < 0 || b.right > WIDTH || b.top < 0 || b.bottom > HEIGHT) return false;
    if (this.blockedByCast(o, b.left, b.top, b.right, b.bottom, this.cast)) return false;
    const illegal = u16(this.prop(o, 'illegalBits'));
    if (!illegal) return true;
    return (this.controlBits(b.left, b.top, b.right, b.bottom) & illegal) === 0;
  }

  /**
   * The set of control colours under a rectangle, one bit per colour.
   *
   * The whole base is sampled rather than a single point, because a foot
   * overlapping a wall by one pixel is what has to stop a walk.
   */
  private controlBits(left: number, top: number, right: number, bottom: number): number {
    const x0 = Math.max(0, Math.min(WIDTH, left));
    const x1 = Math.max(0, Math.min(WIDTH, right));
    const y0 = Math.max(0, Math.min(HEIGHT, top));
    const y1 = Math.max(0, Math.min(HEIGHT, bottom));
    let bits = 0;
    const map = this.screen.control;
    for (let y = y0; y < y1; y++) {
      const row = y * WIDTH;
      for (let x = x0; x < x1; x++) bits |= 1 << (map[row + x] & 15);
    }
    return bits;
  }

  /**
   * Grow the count of the last selector group by what `&rest` added.
   *
   * A send carries several (selector, count, args...) groups and `&rest`
   * widens only the one being built, which is the last.  Walking the
   * groups from the front is the only way to find its count word: from
   * the back, the arguments and the counts are indistinguishable.
   */
  private widenLastGroup(args: number[], rest: number) {
    const base = args.length - rest;
    let i = 0;
    while (i + 1 < args.length) {
      const n = args[i + 1];
      if (!Number.isInteger(n) || n < 0 || n > 127) return;
      if (i + 2 + n >= base) { args[i + 1] = n + rest; return; }
      i += 2 + n;
    }
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
   * Ticks since start, 1/60 s as the games assume.  Advanced by the
   * host once per displayed frame rather than by any kernel call, so
   * time passes for a game that is waiting without animating.
   */
  ticks = 0;
  private lastWait = 0;
  /**
   * Ticks a `Wait(0)` is held for.
   *
   * SCI0 games ask to wait zero and let the machine set the pace -- that
   * is what their speed test was measuring -- so on anything modern the
   * game runs as fast as the interpreter can be driven. Holding a zero
   * wait for a few ticks puts the cycle rate back where the hardware of
   * the day would have left it. Three ticks is twenty cycles a second.
   */
  minWait = 3;

  /** One tick is 1/60 s; the host advances it as frames are displayed. */
  advanceClock(n = 1) { this.ticks += n; }

  /**
   * Periodic sample of the innermost frame.  Where a run spends its
   * instructions is a different question from where it happened to stop,
   * and only a histogram answers the first one.
   */
  sampleEvery = 0;
  samples = new Map<string, number>();

  /** What Animate actually reached, for measurement. */
  animateStats = { calls: 0, doits: 0, max: 0, drawn: 0, names: new Set<string>() };
  /** Priority bands of the current picture. */
  picBands = [42, 53, 64, 74, 85, 95, 106, 116, 127, 138, 148, 159, 169, 180];


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
  /**
   * The cast list `Animate` was last given.
   *
   * `Act::canBeHere` passes it to the kernel itself, but the step check
   * inside `DoBresen` has no such argument and needs the same list, so
   * it is kept here as the game hands it over.
   */
  private cast = 0;

  private animate(castH: number, f?: Frame): number {
    this.cast = castH;
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
    // Drawing happens now, from the properties as they stand.  The
    // doit: calls queued above run afterwards and take effect on the
    // next frame, which is the order the interpreter used: a cycler
    // advances a cel for the frame after the one being drawn.
    this.drawCast(castH);
    return 0;
  }

  /**
   * Composite every visible cast member over the picture.
   *
   * Sorted by priority so nearer sprites overwrite farther ones, and
   * each pixel still tested against the picture's own priority, which is
   * what puts an actor behind scenery rather than in front of it.
   */
  private drawCast(castH: number) {
    this.screen.restore();
    const drawn: Array<{ o: RtObject; cel: Cel; left: number; top: number;
                        pri: number; y: number; z: number; order: number }> = [];
    let order = 0;
    for (const v of this.listValues(castH)) {
      const o = this.resolveTarget(null, v);
      if (!o) continue;
      // signal bit 0x0008 is "hidden"; a view of -1 is nothing to draw.
      if (this.prop(o, 'signal') & 0x0008) continue;
      const cel = this.celOf(o);
      if (!cel) continue;
      const r = this.celRect(cel, this.prop(o, 'x'), this.prop(o, 'y'), this.prop(o, 'z'));
      // Unless the script has pinned it, an actor's priority follows its
      // feet down the screen, and the property is rewritten so scripts
      // reading it see the same band the drawing used.  Leaving a stale
      // value in place is what let the ego walk in front of scenery it
      // should have passed behind: Camelot's ego sat at priority 0 all
      // game while standing in band 7.
      let pri = this.prop(o, 'priority', -1);
      if (!(this.prop(o, 'signal') & SIGNAL_FIXED_PRIORITY)) {
        pri = this.priorityOf(s16(u16(this.prop(o, 'y'))));
        this.setProp(o, 'priority', pri);
      } else if (pri < 0 || pri > 15) pri = this.priorityOf(r.bottom - 1);
      drawn.push({ o, cel, left: r.left, top: r.top, pri,
                   y: s16(u16(this.prop(o, 'y'))), z: s16(u16(this.prop(o, 'z'))),
                   order: order++ });
    }
    /**
     * Nearer the bottom of the screen is nearer the viewer, so that --
     * not priority -- is the order cast members are drawn in.
     *
     * Sorting by priority instead put anything sharing the ego's band
     * in front of it whenever it happened to come later in the cast:
     * Camelot's armour stand sits at y 108 and the ego walks to 110, so
     * the ego is in front of it, but both land in band 7 and the stand
     * was drawn last.  Ties fall back to z, then to the order the game
     * gave them, so two things at the same depth keep their arrangement.
     */
    drawn.sort((a, b) => (a.y - b.y) || (a.z - b.z) || (a.order - b.order));
    // Each cel writes its priority as well as testing against it, so a
    // member drawn later cannot paint over one that is nearer the front.
    for (const d of drawn) this.screen.drawCel(d.cel, d.left, d.top, d.pri, true);
    this.animateStats.drawn += drawn.length;
  }

  /** Sierra's y -> priority band. */
  priorityOf(y: number): number {
    const bands = this.picBands;
    return Math.max(1, Math.min(15, bands.filter(b => b <= y).length));
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
      case 'Wait': {
        // Reached only once the wait is satisfied -- the interpreter loop
        // holds the instruction back until then -- so this reports how
        // long it actually took and opens the next interval.
        const elapsed = this.ticks - this.lastWait;
        const want = a0 > 0 ? a0 : this.minWait;
        // Advance by the interval rather than to the clock, so time
        // already earned is not thrown away: setting it to now means the
        // next wait always blocks and the game can never do more than
        // one cycle per frame, however fast the clock is running.  If it
        // has fallen a long way behind -- a slow frame, a background tab
        // -- give up the backlog instead of bursting through it.
        this.lastWait = elapsed > want * 8 ? this.ticks : this.lastWait + want;
        return elapsed;
      }

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

      // --- picture and cels -------------------------------------------
      case 'DrawPic': {
        const d = this.game.tryData('pic', a0);
        if (!d) return 0;
        try {
          const pic = new Picture(d);
          // `clear` is the third argument; games pass 0 to overlay.
          this.screen.drawPic(pic, (args[2] ?? 1) !== 0);
          this.picBands = pic.priorityBands ?? this.picBands;
          this.currentPic = a0;
        } catch { /* a picture that will not decode leaves the last one */ }
        return 0;
      }
      case 'DrawCel': {
        // DrawCel(view, loop, cel, x, y, priority)
        const v = this.view(a0);
        const cels = v?.loops[a1];
        const cel = cels?.[args[2] ?? 0];
        if (!cel) return 0;
        this.screen.drawCel(cel, args[3] ?? 0, args[4] ?? 0, args[5] ?? 15);
        return 0;
      }
      case 'AddToPic': {
        // Bake the cast list handed in straight into the background.
        for (const val of this.listValues(a0)) {
          const o = this.resolveTarget(null, val);
          if (!o) continue;
          const cel = this.celOf(o);
          if (!cel) continue;
          const r = this.celRect(cel, this.prop(o, 'x'), this.prop(o, 'y'), this.prop(o, 'z'));
          let pri = this.prop(o, 'priority', -1);
          if (pri < 0 || pri > 15) pri = this.priorityOf(r.bottom - 1);
          this.screen.addToPic(cel, r.left, r.top, pri);
        }
        return 0;
      }
      case 'PicNotValid': return 0;
      case 'Graph': return 0;
      case 'GetPort': case 'SetPort': return 0;

      // --- placement and movement --------------------------------------
      case 'BaseSetter': {
        // The base rectangle is the strip of floor a sprite stands on:
        // as wide as the cel, `yStep` deep, at its feet.  CanBeHere
        // tests this, not the whole sprite.
        const o = this.resolveTarget(null, a0);
        if (!o) return 0;
        const cel = this.celOf(o);
        if (!cel) return 0;
        const y = this.prop(o, 'y'), z = this.prop(o, 'z');
        const r = this.celRect(cel, this.prop(o, 'x'), y, z);
        const step = Math.max(1, this.prop(o, 'yStep', 2));
        this.setProp(o, 'brLeft', r.left);
        this.setProp(o, 'brRight', r.right);
        this.setProp(o, 'brBottom', y + 1);
        this.setProp(o, 'brTop', y + 1 - step);
        this.setProp(o, 'nsLeft', r.left);
        this.setProp(o, 'nsRight', r.right);
        this.setProp(o, 'nsTop', r.top);
        this.setProp(o, 'nsBottom', r.bottom);
        return 0;
      }
      /**
       * Set a mover up to walk its client to (x, y).
       *
       * A mover carries the destination; the thing that moves is its
       * `client`.  `Motion::init` calls this and `Motion::doit` then
       * calls `DoBresen` once a cycle, so without this the mover starts
       * with no idea how far it has to go -- which is why the ego stood
       * still with every part of the walking machinery apparently
       * running.
       */
      case 'InitBresen': {
        const mover = this.resolveTarget(null, a0);
        if (!mover) return 0;
        const client = this.resolveTarget(null, this.prop(mover, 'client'));
        if (!client) return 0;
        const mult = args.length > 1 ? (a1 || 1) : 1;
        const cx = s16(u16(this.prop(client, 'x')));
        const cy = s16(u16(this.prop(client, 'y')));
        const step = this.bresenStep(mover, client, mult);
        this.setProp(mover, 'dx', step.dx);
        this.setProp(mover, 'dy', step.dy);
        this.setProp(mover, 'xLast', cx);
        this.setProp(mover, 'yLast', cy);
        this.setProp(mover, 'b-moveCnt', 0);
        this.setProp(mover, 'completed', 0);
        return 0;
      }

      /**
       * One cycle of a mover: step its client along the line.
       *
       * The script decides arrival itself -- `Motion::doit` compares the
       * mover's x and y against the client's and calls `moveDone` when
       * they match -- so the last step has to land exactly on the
       * target rather than merely near it, or the walk never ends.
       */
      case 'DoBresen': {
        const mover = this.resolveTarget(null, a0);
        if (!mover) return 0;
        const client = this.resolveTarget(null, this.prop(mover, 'client'));
        if (!client) return 0;
        const cx = s16(u16(this.prop(client, 'x')));
        const cy = s16(u16(this.prop(client, 'y')));
        this.setProp(mover, 'xLast', cx);
        this.setProp(mover, 'yLast', cy);
        const step = this.bresenStep(mover, client, 1);
        const nx = cx + step.dx, ny = cy + step.dy;
        // Refuse a step onto ground this actor may not stand on.
        //
        // `Act::doit` does ask `canBeHere` after moving, but only when
        // the base rectangle's left or right edge changed, so a walk
        // straight up or down is never checked; and the `Avoid` avoider
        // that would catch it is only fitted in the handful of rooms
        // that ask for one.  The step itself is the one place every
        // walk passes through.  A move out of a bad position is always
        // allowed, so an actor that starts somewhere illegal -- or is
        // put there by a script -- can still get out.
        if (!this.legalAt(client, nx, ny) && this.legalAt(client, cx, cy)) {
          // Telling the mover it has arrived is what ends the walk:
          // `Motion::doit` compares its target against the client and
          // calls `moveDone` when they agree.
          this.setProp(mover, 'x', cx);
          this.setProp(mover, 'y', cy);
          return 0;
        }
        this.setProp(client, 'x', nx);
        this.setProp(client, 'y', ny);
        this.setProp(mover, 'b-moveCnt',
          u16(this.prop(mover, 'b-moveCnt')) + 1);
        return 0;
      }

      case 'GlobalToLocal': case 'LocalToGlobal': {
        // There is one port covering the picture, so the two spaces are
        // the same and the coordinates pass through unchanged.
        return 0;
      }

      // --- input --------------------------------------------------------
      case 'HaveMouse': return 1;
      case 'SetCursor': {
        if (args.length >= 3) { this.mouseX = a1; this.mouseY = args[2] ?? this.mouseY; }
        return 0;
      }
      case 'GetEvent': {
        const mask = a0;
        const ev = this.resolveTarget(null, a1);
        const i = this.events.findIndex(e => (e.type & mask) !== 0);
        if (i < 0) { if (ev) this.setProp(ev, 'type', EV.null); return 0; }
        const e = this.events[i];
        if (!(mask & EV.peek)) this.events.splice(i, 1);
        if (ev) {
          this.setProp(ev, 'type', e.type);
          this.setProp(ev, 'message', e.message);
          this.setProp(ev, 'modifiers', e.modifiers);
          this.setProp(ev, 'x', e.x);
          this.setProp(ev, 'y', e.y);
        }
        return 1;
      }
      case 'GameIsRestarting': return 0;
      case 'Joystick': return 0;

      // --- text and windows ---------------------------------------------
      case 'DrawStatus': {
        this.screen.status = this.stringAt(a0, f?.scriptNo);
        return 0;
      }
      /**
       * TextSize(rect, text, font, maxWidth).
       *
       * The result goes *into* the caller's rectangle, four words of it,
       * not into the return value.  A dialog sizes itself from what this
       * writes, so returning the measurement instead leaves every window
       * eight pixels wide with its text outside it.
       */
      case 'TextSize': {
        // Named `fnt`, not `f`: the frame is also called `f` here, and
        // shadowing it sent `stringAt` looking in script 0.  It then
        // measured whatever sat at that offset in the wrong resource --
        // "0.001" where the caller meant "M" -- and `DEdit::setSize`
        // multiplied the five characters by its 45-character limit into
        // an input box 1252 pixels wide.
        const fnt = this.font(args[2] ?? 0) ?? this.font(0);
        const t = this.stringAt(a1, f?.scriptNo);
        const maxW = (args[3] ?? 0) > 0 ? args[3] : WIDTH;
        let w = 0, h = fnt ? Math.max(8, fnt.lineHeight) : 8, line = 0;
        if (fnt) {
          for (const ch of t) {
            if (ch === '\n') { w = Math.max(w, line); line = 0; h += Math.max(8, fnt.lineHeight); continue; }
            const g = fnt.chars[ch.charCodeAt(0)];
            if (!g) continue;
            if (line + g.width > maxW) { w = Math.max(w, line); line = 0; h += Math.max(8, fnt.lineHeight); }
            line += g.width;
          }
          w = Math.max(w, line);
        }
        this.writeWords(a0, [0, 0, h, w]);
        return 0;
      }

      // --- things that only need to not fail -----------------------------
      case 'Display': return this.display(args, f?.scriptNo);
      case 'GetFarText': {
        // GetFarText(resource, line, buffer) fills the buffer and returns
        // it, so the caller can go on using the address it passed in.
        const text = this.textLines(a0)[a1] ?? '';
        const buf = args[2] ?? 0;
        if (this.strings.has(buf)) { this.strings.set(buf, text); return buf; }
        return this.makeString(text);
      }
      case 'Format': {
        // Format(dest, source, ...) writes into dest and returns it; the
        // source may be a string or a (resource, line) pair.
        let i = 1, src: string;
        if (this.strings.has(a1) || isRef(a1)) { src = this.stringAt(a1, f?.scriptNo); i = 2; }
        else { src = this.textLines(a1)[args[2] ?? 0] ?? ''; i = 3; }
        const out = this.format(src, args.slice(i), f?.scriptNo);
        if (this.strings.has(a0)) { this.strings.set(a0, out); return a0; }
        return this.makeString(out);
      }
      case 'StrLen': return this.stringAt(a0, f?.scriptNo).length;
      case 'StrCpy': return a0;
      case 'StrCmp': {
        const x = this.stringAt(a0, f?.scriptNo), y = this.stringAt(a1, f?.scriptNo);
        return x < y ? -1 : x > y ? 1 : 0;
      }
      case 'StrAt': {
        const t = this.stringAt(a0, f?.scriptNo);
        return t.charCodeAt(a1) || 0;
      }

      /**
       * NewWindow(top, left, bottom, right, title, type, priority, fg, bg).
       *
       * The rectangle comes first and the games pass it in that order --
       * a window at (144, 156, 156, 164) is twelve rows tall and eight
       * wide, which is what an empty dialog is before its text sizes it.
       */
      case 'NewWindow': {
        const top = a0, left = a1, bottom = args[2] ?? a0, right = args[3] ?? a1;
        const bg = args[8] ?? 15;
        const x0 = Math.max(0, left - 1), y0 = Math.max(0, top - 1);
        const x1 = Math.min(WIDTH, right + 2), y1 = Math.min(HEIGHT, bottom + 2);
        const saved = this.screen.save(x0, y0, x1, y1);
        this.screen.fill(x0, y0, x1, y1, bg & 0x0F);
        this.screen.frame(x0, y0, x1, y1, 0);
        const port = { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) };
        const h = this.alloc();
        this.windows.set(h, { rect: saved, port });
        this.ports.push(port);
        return h;
      }
      case 'DisposeWindow': {
        const w = this.windows.get(a0);
        if (w) {
          this.screen.restoreRect(w.rect);
          this.windows.delete(a0);
          const i = this.ports.lastIndexOf(w.port);
          if (i > 0) this.ports.splice(i, 1);
        }
        return 0;
      }
      case 'SetPort': {
        const w = this.windows.get(a0);
        if (w) { const i = this.ports.lastIndexOf(w.port); if (i < 0) this.ports.push(w.port); }
        else if (a0 === 0) this.ports.length = 1;
        return 0;
      }

      /**
       * DrawControl(control).
       *
       * The dialogs are built out of these: type 2 is a line of text,
       * type 3 an edit field, type 0 and 1 buttons.  Their rectangles are
       * relative to the window's port, and `state` bit 0 means selected,
       * which is drawn inverted.
       */
      case 'DrawControl': case 'HiliteControl': {
        const o = this.resolveTarget(null, a0);
        if (!o) return 0;
        const p = this.port;
        const x = p.x + this.prop(o, 'nsLeft');
        const y = p.y + this.prop(o, 'nsTop');
        const w = Math.max(0, this.prop(o, 'nsRight') - this.prop(o, 'nsLeft'));
        const type = this.prop(o, 'type');
        const state = this.prop(o, 'state');
        const text = this.stringAt(this.prop(o, 'text'), o.scriptNo);
        const font = this.font(this.prop(o, 'font')) ?? this.font(0);
        const selected = (state & 1) !== 0;
        if (type === 0 || type === 1) {
          const bottom = p.y + this.prop(o, 'nsBottom');
          if (selected) this.screen.fill(x, y, x + w + 2, bottom + 2, 0);
          this.screen.frame(x - 1, y - 1, x + w + 3, bottom + 3, 0);
          if (font && text) this.screen.text(font, text, x + 1, y, selected ? 15 : 0);
        } else if (type === 3) {
          // An edit field shows what has been typed, with the caret
          // where the cursor actually is rather than always at the end.
          if (font) {
            this.screen.text(font, text, x, y, 0);
            const cur = Math.max(0, Math.min(text.length, this.prop(o, 'cursor', text.length)));
            let cx = x;
            for (let i = 0; i < cur; i++)
              cx += font.chars[text.charCodeAt(i)]?.width ?? 0;
            this.screen.fill(cx, y, cx + 1, y + Math.max(8, font.lineHeight), 0);
          }
        } else if (font && text) {
          this.drawText(font, text, x, y, 0, Math.max(8, w || (WIDTH - x)));
        }
        return 0;
      }

      /**
       * EditControl(control, event).
       *
       * Typing into a text field.  Only an edit control has anything to
       * do here, and only a keyboard event: the caller hands every
       * control in the dialog the same event, so the ones that do not
       * apply have to leave it alone rather than claim it.
       *
       * The text lives in the buffer a `lea` handle names, which is what
       * the control's `text` property holds, so editing means rewriting
       * that buffer -- not the property.
       */
      case 'EditControl': {
        const ctl = this.resolveTarget(null, a0);
        const ev = this.resolveTarget(null, a1);
        if (!ctl || !ev) return 0;
        if (this.prop(ctl, 'type') !== 3) return 0;
        if (this.prop(ev, 'type') !== EV.keyboard) return 0;
        const buf = this.prop(ctl, 'text');
        if (!this.strings.has(buf)) return 0;
        const max = this.prop(ctl, 'max', 40);
        let text = this.strings.get(buf)!;
        let cur = Math.max(0, Math.min(text.length, this.prop(ctl, 'cursor', text.length)));
        const key = this.prop(ev, 'message');
        let handled = true;
        if (key === 8) {                                  // backspace
          if (cur > 0) { text = text.slice(0, cur - 1) + text.slice(cur); cur--; }
        } else if (key === 0x4B00) { if (cur > 0) cur--; }        // left
        else if (key === 0x4D00) { if (cur < text.length) cur++; } // right
        else if (key === 0x4700) { cur = 0; }                      // home
        else if (key === 0x4F00) { cur = text.length; }            // end
        else if (key === 0x5300) { text = text.slice(0, cur) + text.slice(cur + 1); }
        else if (key >= 32 && key < 256) {
          if (text.length < max) {
            text = text.slice(0, cur) + String.fromCharCode(key) + text.slice(cur);
            cur++;
          }
        } else handled = false;                 // enter and the rest are the dialog's
        if (!handled) return 0;
        this.strings.set(buf, text);
        this.setProp(ctl, 'cursor', cur);
        this.setProp(ev, 'claimed', 1);
        return 1;
      }

      /**
       * The sound driver.
       *
       * A `Sound` object carries the resource number and is its own
       * handle; the driver reports back by way of the object's `signal`
       * property, which is what `Sound::check` polls.  Subops the games
       * never call, and queries with nothing to answer from, fall
       * through to zero.
       */
      /**
       * Turn a direction key into a direction event.
       *
       * This is the whole of keyboard walking.  `User::handleEvent`
       * hands its event here and then acts on the *type* it comes back
       * with, so a machine that does not implement this leaves the
       * event a plain keystroke: the ego never moves, and the key falls
       * through to whatever else is listening.  Returning 0 is not a
       * harmless stub -- it is the difference between a game that can
       * be played and one that only looks like it.
       */
      case 'MapKeyToDir': {
        const ev = this.resolveTarget(null, a0);
        if (!ev) return 0;
        if (this.prop(ev, 'type') !== EV.keyboard) return 0;
        const dir = KEY_DIRECTION[u16(this.prop(ev, 'message'))];
        if (dir === undefined) return 0;
        this.setProp(ev, 'type', EV.direction);
        this.setProp(ev, 'message', dir);
        return 1;
      }

      case 'DoSound': {
        const verb = this.sounds.verb(a0);
        if (!verb) return 0;
        // Every verb but the global ones names the game's own `Sound`
        // object, which doubles as the driver's handle for the piece.
        const obj = a1 ? this.resolveTarget(null, a1) : null;
        const num = obj ? this.prop(obj, 'number') : 0;
        switch (verb) {
          case 'init':
            if (obj) { this.sounds.init(a1, num); this.setProp(obj, 'handle', a1); }
            return 0;
          case 'play':
            if (obj) {
              // `loop` counts repeats; -1 is what a script sets to mean
              // "keep going", and anything else plays the piece once.
              this.sounds.play(a1, num, s16(u16(this.prop(obj, 'loop'))) === -1);
              this.setProp(obj, 'handle', a1);
              this.setProp(obj, 'signal', 0);
            }
            return 0;
          case 'dispose': this.sounds.dispose(a1); return 0;
          case 'stop':
            this.sounds.stop(a1);
            if (obj) this.setProp(obj, 'signal', 0);
            return 0;
          // SCI0's `Sound::pause` passes its own argument straight
          // through, so there it is a flag and everything stops
          // together; SCI01 names the piece and passes the flag second.
          case 'pause':
            if (this.sounds.sci01) this.sounds.pause(a1, !!(args[2] ?? 1));
            else this.sounds.pause(0, !!a1);
            return 0;
          case 'mute':
            if (args.length > 1) this.sounds.setMuted(!!a1);
            return this.sounds.muted ? 1 : 0;
          case 'masterVolume':
            if (args.length > 1) this.sounds.setMasterVolume(a1);
            return this.sounds.masterVolume;
          case 'fade': this.sounds.fade(a1); return 0;
          // Nine melodic voices, which is what the chip has.
          case 'getPolyphony': return 9;
          case 'stopAll': this.sounds.stopAll(); return 0;
          // `check` is polled every cycle; the answer a script wants is
          // carried on the object's own `signal`, which `pumpSounds`
          // writes, so there is nothing to return here.
          case 'check': case 'update': case 'hold':
          case 'sendMidi': case 'restore': case 'resume':
            return 0;
        }
        return 0;
      }

      case 'DisposeScript': case 'FlushResources': case 'MemoryInfo':
      case 'SetMenu': case 'AddMenu': case 'DrawMenuBar': case 'SetSynonyms':
      case 'GetSaveDir': case 'GetCWD':
      case 'FileIO':
      case 'FOpen': case 'FClose': case 'FGets': case 'FPuts':
        return 0;

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
      /**
       * May this actor stand where it now is?
       *
       * The control plane is a map of the floor: every pixel carries a
       * colour, and an actor's `illegalBits` names the colours it may
       * not stand on.  Only the base rectangle is tested, which is the
       * actor's feet -- a head passing in front of a wall is ordinary,
       * standing inside one is not.
       *
       * `Act::doit` asks this after every step and calls `findPosn` to
       * nudge the actor back when the answer is no, so answering yes to
       * everything, as this used to, is what let the ego walk through
       * scenery and off the edge of the picture.
       */
      case 'CanBeHere': {
        const o = this.resolveTarget(null, a0);
        if (!o) return 1;
        const left = s16(u16(this.prop(o, 'brLeft')));
        const right = s16(u16(this.prop(o, 'brRight')));
        const top = s16(u16(this.prop(o, 'brTop')));
        const bottom = s16(u16(this.prop(o, 'brBottom')));
        if (right <= left || bottom <= top) return 1;    // no base yet
        if (left < 0 || right > WIDTH || top < 0 || bottom > HEIGHT) return 0;
        // `Act::canBeHere` hands over the cast so that actors can stand
        // in each other's way.
        if (this.blockedByCast(o, left, top, right, bottom, a1 || this.cast)) return 0;
        const illegal = u16(this.prop(o, 'illegalBits'));
        if (!illegal) return 1;
        return (this.controlBits(left, top, right, bottom) & illegal) ? 0 : 1;
      }

      /**
       * Which control colours lie under an actor, or under a rectangle.
       *
       * Rooms use it to notice the ego reaching a doorway or stepping
       * into water, so returning 0 meant none of that ever fired.
       */
      case 'OnControl': {
        // The first argument selects the map; only the control one is
        // ever asked for here.  With four more it reports on a
        // rectangle, with one more on an actor's base.
        if (args.length >= 4) {
          const x1 = s16(u16(a1)), y1 = s16(u16(args[2]));
          const x2 = s16(u16(args[3] ?? a1)), y2 = s16(u16(args[4] ?? args[2]));
          return this.controlBits(Math.min(x1, x2), Math.min(y1, y2),
                                  Math.max(x1, x2) + 1, Math.max(y1, y2) + 1);
        }
        const o = this.resolveTarget(null, a1);
        if (!o) return 0;
        return this.controlBits(s16(u16(this.prop(o, 'brLeft'))), s16(u16(this.prop(o, 'brTop'))),
                                s16(u16(this.prop(o, 'brRight'))), s16(u16(this.prop(o, 'brBottom'))));
      }

      /**
       * Point an actor the way it is heading.
       *
       * A view holds a loop per facing, and this picks the one matching
       * a heading in degrees clockwise from north.  Without it an actor
       * keeps whatever loop it last had, which is why the ego walked in
       * every direction still facing one way.
       *
       * The four-loop convention is the views' own: 0 faces right, 1
       * left, 2 towards the viewer, 3 away.  A view with fewer loops
       * than that has no back or front to turn to, so the heading only
       * chooses between left and right.
       */
      case 'DirLoop': {
        const o = this.resolveTarget(null, a0);
        if (!o) return 0;
        const angle = ((s16(u16(a1)) % 360) + 360) % 360;
        // Early SCI0 used a narrower arc for front and back; the later
        // interpreter widened both to a full quadrant.
        const arc = this.index.selectorShift === 1 ? 30 : 45;
        let loop = -1;
        if (angle > 360 - arc || angle < arc) loop = 3;            // away
        else if (angle > 180 - arc && angle < 180 + arc) loop = 2; // towards
        if (loop < 0) loop = angle >= 180 ? 1 : 0;                 // left : right
        else if ((this.view(this.prop(o, 'view'))?.loopCount ?? 0) < 4) return 0;
        this.setProp(o, 'loop', loop);
        return 0;
      }

      /**
       * Refresh an actor's "now seen" rectangle from its current cel.
       *
       * Rooms test against this rectangle, so leaving it behind after a
       * turn makes an actor respond to the shape it used to be.
       */
      case 'SetNowSeen': {
        const o = this.resolveTarget(null, a0);
        if (!o) return 0;
        const cel = this.celOf(o);
        if (!cel) return 0;
        const r = this.celRect(cel, this.prop(o, 'x'), this.prop(o, 'y'), this.prop(o, 'z'));
        this.setProp(o, 'nsLeft', r.left);
        this.setProp(o, 'nsTop', r.top);
        this.setProp(o, 'nsRight', r.right);
        this.setProp(o, 'nsBottom', r.bottom);
        return 0;
      }

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

  /** Selector id by name, cached; -1 when the game has no such selector. */
  sel(name: string): number {
    let v = this.selCache.get(name);
    if (v === undefined) { v = this.index.selectorId(name); this.selCache.set(name, v); }
    return v;
  }

  /** Read a named property of an object, or a default. */
  prop(o: RtObject, name: string, dflt = 0): number {
    const i = o.indexOfSelector(this.sel(name));
    return i < 0 ? dflt : o.props[i];
  }
  setProp(o: RtObject, name: string, v: number) {
    const i = o.indexOfSelector(this.sel(name));
    if (i >= 0) o.props[i] = v;
  }

  /** Decoded font, cached. */
  font(n: number): Font | null {
    if (!this.fonts.has(n)) {
      const d = this.game.tryData('font', n);
      let f: Font | null = null;
      if (d) { try { f = new Font(d); } catch { f = null; } }
      this.fonts.set(n, f);
    }
    return this.fonts.get(n) ?? null;
  }

  /**
   * Where a cel lands and how big it is.
   *
   * (x, y) is the sprite's bottom centre, displaceX signed and negated
   * on a mirrored loop, displaceY unsigned -- the same convention the
   * static scene compositor uses, because it is the same convention the
   * interpreter used.
   */
  celRect(cel: Cel, x: number, y: number, z: number) {
    const dx = cel.mirrored ? -cel.xShift : cel.xShift;
    const dy = cel.yShift >= 0 ? cel.yShift : cel.yShift + 256;
    const left = x + dx - (cel.width >> 1);
    const bottom = y + dy - z + 1;
    return { left, top: bottom - cel.height, right: left + cel.width, bottom };
  }

  /** The cel an object's view/loop/cel properties name. */
  celOf(o: RtObject): Cel | null {
    const v = this.view(this.prop(o, 'view', -1));
    if (!v) return null;
    const loop = v.loops[this.prop(o, 'loop')] ?? v.loops[0];
    if (!loop || !loop.length) return null;
    return loop[Math.min(Math.max(0, this.prop(o, 'cel')), loop.length - 1)] ?? null;
  }

  /**
   * Display(text, attributes...).
   *
   * The text is either a string the kernel or a script owns, or a
   * (resource, line) pair -- the games use both, so which one it is has
   * to be decided from the value rather than assumed.
   *
   * After it come attribute codes, read from the calls the games
   * actually make: 100 takes a coordinate pair, 101 a font, 102 and 103
   * the two colours, 105 a width; 107 and 121 take nothing.  An
   * unrecognised code stops the scan rather than guessing a length,
   * because guessing wrong reads the next code as a value and turns the
   * rest of the arguments into nonsense.
   */
  private display(args: number[], fromScript = 0): number {
    let i = 0;
    let text: string;
    if (this.strings.has(args[0]) || isRef(args[0])) { text = this.stringAt(args[0], fromScript); i = 1; }
    else { text = this.textLines(args[0])[args[1] ?? 0] ?? ''; i = 2; }

    let x = 0, y = 0, fg = 15, width = WIDTH, haveXY = false;
    for (; i < args.length;) {
      const code = args[i++];
      if (code === 100) { x = args[i++]; y = args[i++]; haveXY = true; }
      else if (code === 101) { this.dsFont = args[i++]; }
      else if (code === 102) { fg = args[i++] & 0x0F; }
      else if (code === 103) { i++; }                 // background
      else if (code === 104 || code === 106 || code === 108) { i++; }
      else if (code === 105) { width = args[i++]; }
      else if (code === 107 || code === 121) { /* no value */ }
      else break;
    }
    if (!text) return 0;
    const font = this.font(this.dsFont) ?? this.font(0);
    if (!font) return 0;
    if (!haveXY) { x = 0; y = 0; }
    const p = this.port;
    this.drawText(font, text, p.x + x, p.y + y, fg, Math.min(width, WIDTH - p.x - x));
    return 0;
  }

  /** Draw text, wrapping on spaces inside the given width. */
  private drawText(font: Font, text: string, x: number, y: number,
                   colour: number, width: number) {
    const lineHeight = Math.max(8, font.lineHeight);
    const measure = (s: string) => {
      let w = 0;
      for (const ch of s) w += font.chars[ch.charCodeAt(0)]?.width ?? 0;
      return w;
    };
    let cy = y;
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (line && measure(next) > width) {
          this.screen.text(font, line, x, cy, colour);
          cy += lineHeight;
          line = word;
        } else line = next;
      }
      this.screen.text(font, line, x, cy, colour);
      cy += lineHeight;
    }
  }

  /** The printf subset the scripts use. */
  private format(src: string, args: number[], fromScript = 0): string {
    let out = '', ai = 0;
    for (let i = 0; i < src.length; i++) {
      if (src[i] !== '%') { out += src[i]; continue; }
      let j = i + 1;
      while (j < src.length && /[-0-9.]/.test(src[j])) j++;
      const kind = src[j];
      const v = args[ai++];
      if (kind === 'd' || kind === 'u') out += String(v ?? 0);
      else if (kind === 's') out += this.stringAt(v ?? 0, fromScript);
      else if (kind === 'c') out += String.fromCharCode(v ?? 32);
      else if (kind === 'x') out += (v ?? 0).toString(16);
      else if (kind === '%') { out += '%'; ai--; }
      else { out += src.slice(i, j + 1); ai--; }
      i = j;
    }
    return out;
  }

  private get port() { return this.ports[this.ports.length - 1]; }

  /** Lines of a text resource, cached. */
  textLines(n: number): string[] {
    let l = this.textRes.get(n);
    if (!l) {
      const d = this.game.tryData('text', n);
      l = d ? textStrings(d) : [];
      this.textRes.set(n, l);
    }
    return l;
  }

  /**
   * Write words into an array a script owns.
   *
   * Several kernels report by filling a caller-supplied rectangle rather
   * than by returning, so the machine has to be able to write back into
   * script memory, not only read from it.
   */
  writeWords(ref: number, values: number[]) {
    // A `lea` handle names a run of variables, not a place in script
    // memory, and that is where a rectangle filled by the kernel has to
    // land -- the script reads it straight back out of those variables.
    const slot = this.slotArray(ref);
    if (slot) {
      for (let i = 0; i < values.length; i++) {
        const at = slot.index + i;
        if (at < 0) continue;
        if (Array.isArray(slot.arr)) {
          while (slot.arr.length <= at) slot.arr.push(0);
          slot.arr[at] = values[i];
        } else if (at < slot.arr.length) slot.arr[at] = values[i];
      }
      return;
    }
    const scriptNo = isRef(ref) ? refScript(ref) : 0;
    const off = isRef(ref) ? refOffset(ref) : ref;
    const sc = this.script(scriptNo);
    if (!sc || off <= 0) return;
    for (let i = 0; i < values.length; i++) {
      const p = off + i * 2;
      if (p + 1 >= sc.data.length) return;
      sc.data[p] = values[i] & 0xFF;
      sc.data[p + 1] = (values[i] >> 8) & 0xFF;
    }
  }

  private buffers = new Map<string, number>();
  /** Which variable slot a `lea` handle stands for. */
  private bufferSlot = new Map<number, {
    kind: number; index: number; script: number;
    /** For a temp or a parameter, the frame the slot belongs to. */
    frame?: Frame;
  }>();

  /**
   * A stable stand-in for the address of one variable slot.
   *
   * Globals and locals are identified by index, so one handle can serve
   * every use of that slot.  A temp or a parameter lives on the value
   * stack at an address that depends on the frame, so those are keyed by
   * where they actually are -- the `Print` dialogs measure themselves
   * into a temporary rectangle, and a handle that forgot which frame it
   * came from would write into somebody else's.
   */
  bufferFor(kind: number, index: number, script: number, f: Frame): number {
    const stack = kind === 2 || kind === 3;
    const at = kind === 2 ? f.tempsBase + index
             : kind === 3 ? f.paramsBase + index : index;
    const key = stack ? `s:${at}` : `${kind}:${index}:${script}`;
    let h = this.buffers.get(key);
    if (h === undefined) {
      h = this.alloc();
      this.buffers.set(key, h);
      this.strings.set(h, '');
    }
    // A stack address only means anything while the frame that owns it
    // is still running.  Recording the frame is what stops a handle kept
    // in some object's property from later writing into whatever method
    // happens to occupy those slots now -- which corrupts its temps, and
    // a method whose temp is its return value then returns nonsense.
    this.bufferSlot.set(h, { kind, index: at, script, frame: stack ? f : undefined });
    return h;
  }

  /** Where a `lea` handle points, if anywhere writable. */
  private slotArray(h: number):
      { arr: Int32Array | number[]; index: number } | null {
    const slot = this.bufferSlot.get(h);
    if (!slot) return null;
    if (slot.kind === 0) return { arr: this.globals, index: slot.index };
    if (slot.kind === 1) return { arr: this.localsOf(slot.script), index: slot.index };
    // The frame has returned, so those slots are somebody else's now.
    if (!slot.frame || !this.frames.includes(slot.frame)) return null;
    return { arr: this.stack, index: slot.index };
  }

  /** Put a string on the kernel's heap and return its handle. */
  makeString(s: string): number {
    const h = this.alloc();
    this.strings.set(h, s);
    return h;
  }

  /**
   * Read a NUL-terminated string a script pointed at.
   *
   * A tagged reference names its script; a bare offset is assumed to sit
   * in script 0, which is where the shared strings live.
   */
  /**
   * The text a script is pointing at.
   *
   * A bare offset carries no script with it -- `lofsa` only tags a
   * reference when the target is an object -- so the script it came
   * from has to be supplied.  Assuming script 0 reads the same offset
   * out of the wrong resource: `DEdit::setSize` measures the string "M"
   * to size the parser's input box, and reading script 0 at that offset
   * gave "0.001" instead, five characters wide, which the script then
   * multiplied by the field's 45-character limit into a box 1252 pixels
   * across.
   */
  stringAt(ref: number, fromScript = 0): string {
    const made = this.strings.get(ref);
    if (made !== undefined) return made;
    const scriptNo = isRef(ref) ? refScript(ref) : fromScript;
    const off = isRef(ref) ? refOffset(ref) : ref;
    const sc = this.script(scriptNo);
    if (!sc || off <= 0 || off >= sc.data.length) return '';
    let out = '';
    for (let p = off; p < sc.data.length && sc.data[p]; p++) out += String.fromCharCode(sc.data[p]);
    return out;
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
