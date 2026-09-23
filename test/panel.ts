/**
 * A panel a script painted is not something the cast may walk over.
 *
 * Camelot builds its message box out of three separate things: it saves
 * the box it is about to cover with `Graph`, paints a grey panel and an
 * ornamented border into it, and then opens a *transparent* window over
 * the middle of that, only to have a port to write the text into.
 *
 * Protecting the window alone protects the wrong rectangle.  For "How
 * wise of you." in Arthur's chamber the panel is painted over
 * 99,117-221,153 and the window covers 108,124-213,147, so the border
 * around the outside is unguarded -- and since the script walks Arthur
 * across the room while the message is up, he was drawn straight
 * through the ornament around the edge of his own dialogue.
 *
 * What makes the box the right thing to protect is what saving one
 * means: a script saves a rectangle because it is about to cover it and
 * intends to put it back itself.  For as long as it holds that box,
 * whatever it drew there is standing on the screen.
 *
 * The check is on pixels rather than on rectangles, because agreeing
 * about the rectangle is not the same as leaving the pixels alone.
 *
 * The rectangle it watches is taken from the save the script actually
 * made, not from the list of regions the interpreter decided to
 * protect.  Asking the protection list where the panel is lets the bug
 * answer the question: the first version of this test looked for "a
 * wide protected box", found the window inside the panel, checked that
 * the window's own pixels were undisturbed, and passed just as happily
 * with the fix taken out again.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { WIDTH } from '../src/vm/screen.ts';
import { ROOT } from './games.ts';

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

/** The message this scene shows, and the room it shows it in. */
const MESSAGE = 'How wise of you.';
/** Getting dressed is what earns it. */
const DRESSING = ['wear travelling clothes', 'take off court clothes', 'wear clothes'];

interface Live { def?: { name?: string } }
interface Machine {
  objects?: Map<number, Live>;
  prop(o: Live, n: string): number;
  setProp(o: Live, n: string, v: number): void;
  kernel(id: number, a: number[], f?: unknown): number;
  index: Index;
  drawText(...a: unknown[]): unknown;
}

let failed = 0, checked = 0;
const check = (ok: boolean, msg: string) => {
  checked++; if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
};

const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
const idx = new Index(g);
const s = new Session(g, idx);
let clock = 0;
s.now = () => clock;
const step = (n = 1) => { for (let i = 0; i < n; i++) { clock += 1000 / 60; s.tick(); } };
const vm = s.vm as unknown as Machine;

// Watch the dialog's buttons go by, so "Start New Game" can be clicked.
interface Rect { x0: number; y0: number; x1: number; y1: number }
const buttons: Array<{ l: number; t: number; r: number; b: number }> = [];
let win: { top: number; left: number } | null = null;
const openedAt = (): { top: number; left: number } | null => win;
const drawControl = idx.kernel.indexOf('DrawControl');
const newWindow = idx.kernel.indexOf('NewWindow');
const kernel = vm.kernel.bind(vm);
vm.kernel = (id: number, a: number[], f?: unknown) => {
  if (id === newWindow && !win) win = { top: a[0], left: a[1] };
  if (id === drawControl) {
    const o = (vm as unknown as { resolveTarget(f: null, r: number): Live | null }).resolveTarget(null, a[0]);
    if (o && o.def?.name === 'DButton')
      buttons.push({ l: vm.prop(o, 'nsLeft'), t: vm.prop(o, 'nsTop'),
                     r: vm.prop(o, 'nsRight'), b: vm.prop(o, 'nsBottom') });
  }
  return kernel(id, a, f);
};

s.tick(); step(300);
s.key(0x0D); step(90);                       // the options menu
checked++;
if (buttons.length < 2 || !win) {
  failed++;
  console.log('  FAIL  the opening menu did not offer its buttons');
} else {
  console.log(`  ok    the opening menu offered ${buttons.length} buttons`);
  const b = buttons[1];                      // Start New Game
  const w = openedAt()!;
  const x = w.left + ((b.l + b.r) >> 1), y = w.top + ((b.t + b.b) >> 1);
  s.mouse(1, x, y); step(3); s.mouse(2, x, y); step(660);
}

const ego = () => [...(vm.objects?.values() ?? [])].find(o => o?.def?.name === 'ego');
const type = (cmd: string) => {
  for (const ch of cmd) { s.key(ch.charCodeAt(0)); step(2); }
  s.key(0x0D);
};
checked++;
if (!ego()) { failed++; console.log('  FAIL  never reached Arthur\'s chamber'); }
else console.log('  ok    reached Arthur\'s chamber');

for (const c of DRESSING) { type(c); step(150); }

// Notice the moment the message is written, and which box it is in.
let shown = false;
/**
 * The box the script saved, which is the panel it is about to paint.
 * Recorded straight off the screen, before anything decides what to
 * protect.
 */
let painted: Rect | null = null;
const paintedBox = (): Rect | null => painted;
const save = s.screen.save.bind(s.screen);
(s.screen as unknown as { save: typeof save }).save = (x0, y0, x1, y1) => {
  if (!shown && (x1 - x0) > 80 && (y1 - y0) > 20 && y1 < 160)
    painted = { x0, y0, x1, y1 };
  return save(x0, y0, x1, y1);
};
const drawText = vm.drawText.bind(vm);
vm.drawText = (f: unknown, text: unknown, ...rest: unknown[]) => {
  if (typeof text === 'string' && text.startsWith('How wise')) shown = true;
  return drawText(f, text, ...rest);
};
type('dress');
for (let i = 0; i < 400 && !shown; i++) step(1);
check(shown, `the scene showed ${JSON.stringify(MESSAGE)}`);

const panel: Rect | null = paintedBox();
check(panel !== null, 'the script saved the box it painted its panel into');

/**
 * The protection has to cover what was painted, not merely overlap it.
 *
 * This is the rectangle half of the question, stated so that a failure
 * says which edge was left out.
 */
if (panel) {
  const covers = s.screen.windows.some(w =>
    w.x0 <= panel.x0 && w.y0 <= panel.y0 && w.x1 >= panel.x1 && w.y1 >= panel.y1);
  check(covers,
    `the whole painted panel ${panel.x0},${panel.y0}-${panel.x1},${panel.y1} is protected ` +
    `(protected: ${s.screen.windows.map(w => `${w.x0},${w.y0}-${w.x1},${w.y1}`).join(' ') || 'nothing'})`);
}

if (panel) {
  // Let the panel finish drawing, then remember every pixel of it.
  step(4);
  const snap = (r: typeof panel) => {
    const out: number[] = [];
    for (let y = r.y0; y < r.y1; y++)
      for (let x = r.x0; x < r.x1; x++) out.push(s.screen.visual[y * WIDTH + x]);
    return out;
  };
  const before = snap(panel);

  // Stand Arthur in the middle of it.  The script walks him across the
  // room here anyway; this only makes sure the crossing happens.
  const e = ego();
  check(e !== undefined, 'Arthur is in the room to walk through it');
  if (e) {
    vm.setProp(e, 'x', (panel.x0 + panel.x1) >> 1);
    vm.setProp(e, 'y', panel.y1 + 6);
    step(12);
    const after = snap(panel);
    let changed = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed++;
    check(changed === 0,
      `nothing repainted the panel while Arthur stood in it (${changed} of ${before.length} pixels changed)`);
  }
}

console.log(`\n${checked - failed}/${checked} panel checks passed`);
process.exit(failed ? 1 : 0);
