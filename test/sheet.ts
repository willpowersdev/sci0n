/**
 * Hero's Quest's character sheet, which is thirty-six `Display` calls.
 *
 * Everything on that screen except the two buttons and the portrait is
 * text written straight onto the picture: five attribute names and
 * their values, eight skills and theirs, three point totals, the
 * prompt, the name label.  They are written one after another in the
 * same breath.
 *
 * The rule that erased them was "text from an earlier cycle goes back
 * to the picture before new text is written", which is right only for
 * the case it was written for -- a line of narration replacing the
 * line before it in the same place.  Applied to a screen built out of
 * thirty-six lines in thirty-six different places it left the last one
 * standing and put the picture back over the other thirty-five, so the
 * player got a blank sheet with "Start Game" on it and nothing to
 * choose.
 *
 * So the check is on the screen and on the labels furthest apart on
 * it: if only the overlapping case is cleared they are all there, and
 * if every older line is cleared none of them is.
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

let failed = 0, checked = 0;
const check = (ok: boolean, msg: string) => {
  checked++; if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
};

const g = new Game(nodeSource(join(ROOT, 'HERO')));
const idx = new Index(g);
const s = new Session(g, idx);
let clock = 0;
s.now = () => clock;

/**
 * The sheet is the third window: the copyright notice and the disk
 * notice come first and each wants a key before it will go.
 */
const newWindow = idx.kernel.indexOf('NewWindow');
interface Machine { kernel(id: number, a: number[], f?: unknown): number }
const vm = s.vm as unknown as Machine;
const kernel = vm.kernel.bind(vm);
let windows = 0;
vm.kernel = (id, a, f) => { if (id === newWindow) windows++; return kernel(id, a, f); };

let st = s.tick();
let frames = 0;
for (let i = 0; i < 6000 && st.running; i++) {
  if (i > 600 && i % 300 === 0) s.key(13);
  clock += 1000 / 60;
  st = s.tick();
  if (windows >= 3 && ++frames > 4) break;
}
check(windows >= 3, `the character sheet opened (${windows} windows)`);

/**
 * How much of the sheet's white page has ink on it.  White is 0xFF in
 * the dithered byte the screen keeps, so anything else is something
 * that was drawn.
 */
const ink = (x0: number, y0: number, x1: number, y1: number) => {
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) if (s.screen.visual[y * WIDTH + x] !== 0xFF) n++;
  return n;
};

// The four corners of the sheet, written first, in the middle and last.
for (const [name, x, y] of [['Strength', 83, 35], ['Weapon Use', 207, 28],
                            ['Health Points', 10, 148], ['Points Available', 62, 109],
                            ['TAB to move around', 165, 127]] as Array<[string, number, number]>) {
  const n = ink(x, y, Math.min(WIDTH, x + 40), y + 9);
  check(n > 10, `"${name}" is on the sheet at ${x},${y} (${n} pixels of ink)`);
}

console.log(`\n${checked - failed}/${checked} character-sheet checks passed`);
process.exit(failed ? 1 : 0);
