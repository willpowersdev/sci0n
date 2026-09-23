/**
 * Can you see what you are typing?
 *
 * Typing a letter opens the parser's input line, and the game sizes that
 * window itself: `DEdit::setSize` measures the string "M" through
 * `TextSize` and multiplies it by the field's character limit.  So the
 * whole dialog is only as sane as one glyph measurement, and when that
 * measurement was wrong the window came out 1252 pixels wide with one
 * letter visible on screen.
 *
 * What is checked is what a player would notice: the window and the
 * field it contains are on the screen, and wide enough to type into.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { WIDTH } from '../src/vm/screen.ts';
import { ROOT } from './games.ts';

const ENTER = 0x0D, LETTER = 0x6C;        // 'l', as in "look"
/** Narrower than this and there is no room to type. */
const USABLE = 100;

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let failed = 0, checked = 0;
for (const name of ['SQ3', 'CAMELOT']) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };

  // Watch the window as it is opened, and the controls as they are drawn.
  const vm = s.vm as any;
  const newWindow = idx.kernel.indexOf('NewWindow');
  const drawControl = idx.kernel.indexOf('DrawControl');
  let win: number[] | null = null;
  const fields: Array<{ name: string; left: number; right: number }> = [];
  const kernel = vm.kernel.bind(vm);
  vm.kernel = (id: number, a: number[], f: any) => {
    if (id === newWindow && !win) win = a.slice(0, 4);
    if (id === drawControl) {
      const o = vm.resolveTarget(null, a[0]);
      // `max` is how many characters the field holds; only an editable
      // one has it, and only that one has to be wide enough to type in.
      if (o && vm.prop(o, 'max') > 0)
        fields.push({ name: o.def.name, left: vm.prop(o, 'nsLeft'), right: vm.prop(o, 'nsRight') });
    }
    return kernel(id, a, f);
  };

  let st = s.tick();
  for (let i = 0; i < 12_000 && st.running; i++) {
    if (i % 120 === 0) s.key(ENTER);
    st = step();
  }
  // Only what typing opens counts; the opening sequence has windows of
  // its own and the first one seen is not the parser's.
  win = null;
  fields.length = 0;
  s.key(LETTER);
  for (let i = 0; i < 60 && st.running; i++) st = step();

  checked++;
  if (!win) { failed++; console.log(`${name.padEnd(9)} typing opened no window at all`); continue; }
  const [top, left, bottom, right] = win;
  const w = right - left, h = bottom - top;
  // Only the horizontal geometry is judged.  That is where the fault
  // was, and it is the part whose convention is settled: the window's
  // left and right are picture coordinates.  Where the bottom edge may
  // sit relative to the status bar is a separate question, not one to
  // answer with a guess inside a test.
  const onScreen = left >= 0 && right <= WIDTH;
  const roomy = w >= USABLE;
  if (!onScreen || !roomy) failed++;
  console.log(`${name.padEnd(9)} input window ${left},${top}-${right},${bottom} (${w}x${h})` +
    `${onScreen ? '' : ' -- OFF THE SIDE OF THE SCREEN'}${roomy ? '' : ` -- ONLY ${w}px WIDE`}`);

  const field = fields[fields.length - 1];
  checked++;
  if (!field) { failed++; console.log(`          no editable field was drawn`); continue; }
  const fw = field.right - field.left;
  // The field's rectangle is relative to the window it sits in.
  const ok = fw >= USABLE && fw <= WIDTH;
  if (!ok) failed++;
  console.log(`          ${field.name} field ${field.left}-${field.right} (${fw}px)` +
    `${ok ? '' : ` -- ${fw > WIDTH ? 'WIDER THAN THE SCREEN' : 'TOO NARROW TO TYPE IN'}`}`);
}
console.log(`\n${checked - failed}/${checked} input-window checks passed`);
process.exit(failed ? 1 : 0);
