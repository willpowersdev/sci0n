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
  instructions = 0;
  frames = 0;
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
    const r = this.started
      ? this.vm.run(0, null, 0, { steps: this.budget, resume: true, keep: true, deadline: Date.now() + 120 })
      : this.vm.run(this.entry.script, this.entry.obj, this.entry.pc,
                    { steps: this.budget, keep: true, deadline: Date.now() + 120 });
    this.started = true;
    this.instructions += r.steps;
    this.frames++;
    if (r.stopped !== 'step-limit' && r.stopped !== 'timeout')
      this.done = { stopped: r.stopped, detail: r.detail };
    return { running: !this.done, instructions: this.instructions, frames: this.frames,
             picture: this.vm.currentPic, stopped: this.done?.stopped, detail: this.done?.detail };
  }
}
