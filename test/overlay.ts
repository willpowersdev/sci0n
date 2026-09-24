/**
 * What the cast may rub out, and what it may not.
 *
 * Two different things get drawn over the picture and they are not owed
 * the same protection.
 *
 * A window is a thing standing in front of the picture.  Nothing may
 * paint over it while it is open -- not a sprite, and not the picture
 * being put back under where a sprite was.  Arthur standing beside the
 * parser's message box used to take the first few letters off it every
 * frame.
 *
 * Text written by `Display` is not a window.  It is paint on the
 * picture, and SCI lets the cast rub it out: restoring the background
 * under where a sprite was erases whatever had been written there, and
 * a sprite drawn afterwards covers it.  Camelot's purse depends on
 * this.  Its coin counts are written over the panel, the panel is a
 * view, and closing the purse disposes that view -- the counts go
 * because they sit inside the rectangle that gets the picture put back.
 * Guarding them the way a window is guarded left three numbers hanging
 * over the room after the purse had gone.
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

const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
const idx = new Index(g);
const s = new Session(g, idx);
let clock = 0;
s.now = () => clock;
const step = (n = 1) => { for (let i = 0; i < n; i++) { clock += 1000 / 60; s.tick(); } };
interface Machine { kernel(id: number, a: number[], f?: unknown): number; makeString(t: string): number }
const vm = s.vm as unknown as Machine;
/** The picture under the frame, which the class keeps to itself. */
const screen = s.screen as unknown as {
  bgVisual: Uint8Array;
  lastDrawn: Array<{ x0: number; y0: number; x1: number; y1: number }>;
  restoreCastAreas(): void;
};

s.tick(); step(400);

const display = idx.kernel.indexOf('Display');
const newWindow = idx.kernel.indexOf('NewWindow');
const disposeWindow = idx.kernel.indexOf('DisposeWindow');
/** Where the cast is busy, so a restore will sweep through it. */
const X = 150, Y = 60, W = 60, H = 10;
/**
 * How many pixels differ from the picture underneath.
 *
 * Counting ink outright counts the room as well -- it is a picture, and
 * pictures are not blank.  What is being asked is how much of what is
 * on screen is *not* the picture, which is exactly what a restore is
 * supposed to take away.
 */
const overPicture = (x0: number, y0: number, x1: number, y1: number) => {
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = y * WIDTH + x;
      if (s.screen.visual[i] !== screen.bgVisual[i]) n++;
    }
  return n;
};

// --- written text is the cast's to rub out ------------------------------
{
  // Display(text, dsCOORD, x, y) -- code 100 carries the position.
  vm.kernel(display, [vm.makeString('MMMMMMMM'), 100, X, Y]);
  const wrote = overPicture(X, Y, X + W, Y + H);
  check(wrote > 0, `text was written over the picture at ${X},${Y} (${wrote} pixels)`);

  /**
   * Make the cast cover it, then let a cycle put the picture back.
   *
   * `lastDrawn` is where the cast was, and the restore walks exactly
   * those rectangles -- which is the mechanism the purse relies on.
   */
  screen.lastDrawn = [{ x0: X, y0: Y, x1: X + W, y1: Y + H }];
  screen.restoreCastAreas();
  const left = overPicture(X, Y, X + W, Y + H);
  check(left < wrote / 4,
    `the cast put the picture back over it (${wrote} pixels down to ${left})`);
}

// --- a window is not ----------------------------------------------------
{
  const top = 40, left = 40, bottom = 80, right = 200;
  const h = vm.kernel(newWindow, [top, left, bottom, right, 0, 0, 0, 0, 15]);
  const before = overPicture(left, top, right, bottom);
  check(before > 0, `a window painted itself over the picture at ${left},${top} (${before} pixels)`);

  screen.lastDrawn = [{ x0: left, y0: top, x1: right, y1: bottom }];
  screen.restoreCastAreas();
  const after = overPicture(left, top, right, bottom);
  check(after === before,
    `the cast left the window alone (${before} pixels, ${after} after a restore swept it)`);
  vm.kernel(disposeWindow, [h]);
}

console.log(`\n${checked - failed}/${checked} overlay checks passed`);
process.exit(failed ? 1 : 0);
