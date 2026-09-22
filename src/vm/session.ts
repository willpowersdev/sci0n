/**
 * A running game: the machine, its screen, and a clock to drive them.
 *
 * The interpreter's main loop never returns, so it cannot be called and
 * waited on.  A session runs it in slices -- one per displayed frame --
 * leaving the frame stack standing between them, which is what turns a
 * program that would block forever into something a browser can host.
 */
import { Game } from '../resources.ts';
import { Index } from '../script.ts';
import { PMachine, EV, type SciEvent } from './pmachine.ts';
import { WIDTH, SCREEN_HEIGHT } from './screen.ts';

export { WIDTH, SCREEN_HEIGHT };

export interface SessionStatus {
  running: boolean;
  instructions: number;
  frames: number;
  picture: number;
  stopped?: string;
  detail?: string;
}

export class Session {
  vm: PMachine;
  index: Index;
  /** Instructions per displayed frame; enough for a game cycle, bounded
   *  so one runaway loop cannot freeze the page. */
  budget = 120_000;
  /**
   * Game cycles per second when the game leaves the pace to us.
   *
   * A cycle costs `minWait` ticks, so asking for a rate is asking for
   * the clock to issue that many ticks a second.  Running the clock
   * faster than real time is what makes skipping an intro possible: the
   * game still waits exactly as long as it thinks it does, there is just
   * less of our time in each of its ticks.
   */
  private rate = 20;
  get cyclesPerSecond() { return this.rate; }
  /**
   * Changing the rate rebases the clock's origin.
   *
   * Ticks due are counted from the start of the session at the current
   * rate, so a rate that drops leaves the count already issued far ahead
   * of what the new rate says is due -- and the game's clock then stands
   * still until real time catches up with it.  Coming back to 20 cps
   * after twenty seconds of skipping an intro froze it for ten minutes:
   * `Wait` never returned, so the game never polled, and every key the
   * player pressed queued up unread.  Measuring from here instead keeps
   * the ticks already issued and owes nothing for time spent at the old
   * rate.
   */
  set cyclesPerSecond(v: number) {
    if (v === this.rate) return;
    this.rate = v;
    this.started_at = 0;
    this.ticksIssued = 0;
  }
  private get ticksPerSecond() { return this.rate * this.vm.minWait; }
  instructions = 0;
  frames = 0;
  /**
   * The game's clock runs on wall-clock time, not on displayed frames.
   *
   * An SCI tick is a sixtieth of a second.  Counting one per frame ties
   * the speed of the game to the refresh rate of the screen, so the same
   * game runs twice as fast on a 120 Hz display as on a 60 Hz one.
   */
  private started_at = 0;
  private ticksIssued = 0;
  /**
   * Where the time comes from.
   *
   * A browser paces frames for us, so wall-clock time is the right
   * source there.  A test driving frames in a loop passes no time at
   * all, and a game whose clock never moves waits for ever -- so the
   * source is replaceable, and a harness can hand over a clock it
   * controls.
   */
  now: () => number = () => Date.now();
  private entry: { script: number; pc: number; obj: ReturnType<PMachine['instantiate']> } | null = null;
  private started = false;
  private done: { stopped: string; detail?: string } | null = null;

  constructor(game: Game, index?: Index) {
    this.index = index ?? new Index(game);
    this.vm = new PMachine(game, this.index);
    const obj = this.vm.resolveTarget(null, this.vm.scriptID(0, 0));
    if (!obj) return;
    // Export 0 of script 0 is the game object; `play` is its entry point.
    for (const name of ['play', 'init']) {
      const sel = this.index.selectorId(name);
      if (sel < 0) continue;
      const f = this.vm.species.lookup(obj.def, sel, obj.scriptNo);
      if (!f) continue;
      this.entry = { script: f.script, pc: f.offset, obj: this.vm.instantiate(0, obj.def) };
      break;
    }
  }

  get ready() { return this.entry !== null; }
  get screen() { return this.vm.screen; }

  key(code: number, modifiers = 0) {
    this.vm.events.push({ type: EV.keyboard, message: code, modifiers,
                          x: this.vm.mouseX, y: this.vm.mouseY });
  }
  mouse(type: number, x: number, y: number) {
    this.vm.mouseX = x; this.vm.mouseY = y;
    this.vm.events.push({ type, message: 0, modifiers: 0, x, y });
  }
  move(x: number, y: number) { this.vm.mouseX = x; this.vm.mouseY = y; }

  /** Run one frame's worth of the game. */
  tick(): SessionStatus {
    if (!this.entry) return { running: false, instructions: 0, frames: 0, picture: -1, stopped: 'no entry point' };
    if (this.done) return { running: false, instructions: this.instructions, frames: this.frames,
                            picture: this.vm.currentPic, ...this.done };
    const now = this.now();
    if (!this.started_at) this.started_at = now;
    const due = Math.floor((now - this.started_at) * this.ticksPerSecond / 1000);
    if (due > this.ticksIssued) {
      // Cap the catch-up so a page that was in a background tab does not
      // come back and run a minute of game in one frame.  The cap scales
      // with the rate, or asking for speed would be undone by it.
      const cap = Math.max(6, Math.ceil(this.ticksPerSecond / 6));
      this.vm.advanceClock(Math.min(due - this.ticksIssued, cap));
      this.ticksIssued = due;
    }
    const r = this.started
      ? this.vm.run(0, null, 0, { steps: this.budget, resume: true, keep: true, deadline: Date.now() + 120 })
      : this.vm.run(this.entry.script, this.entry.obj, this.entry.pc,
                    { steps: this.budget, keep: true, deadline: Date.now() + 120 });
    this.started = true;
    this.vm.pumpSounds();
    this.instructions += r.steps;
    this.frames++;
    if (r.stopped !== 'step-limit' && r.stopped !== 'timeout')
      this.done = { stopped: r.stopped, detail: r.detail };
    return { running: !this.done, instructions: this.instructions, frames: this.frames,
             picture: this.vm.currentPic, stopped: this.done?.stopped, detail: this.done?.detail };
  }
}
