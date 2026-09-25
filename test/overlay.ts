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
  castCovered(x0: number, y0: number, x1: number, y1: number): void;
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
  /**
   * The order is the purse's own.  Its panel is a view, drawn first --
   * which is when the bits beneath it are kept.  The coin counts are
   * written over the panel afterwards.  Disposing the panel puts those
   * kept bits back: the room as it was, with no counts on it.
   *
   * So the save comes first, then the writing, and the restore has to
   * take the writing away with it.
   */
  screen.restoreCastAreas();          // nothing outstanding from before
  screen.castCovered(X, Y, X + W, Y + H);
  // Display(text, dsCOORD, x, y) -- code 100 carries the position.
  vm.kernel(display, [vm.makeString('MMMMMMMM'), 100, X, Y]);
  const wrote = overPicture(X, Y, X + W, Y + H);
  check(wrote > 0, `text was written over the picture at ${X},${Y} (${wrote} pixels)`);
  screen.restoreCastAreas();
  const left = overPicture(X, Y, X + W, Y + H);
  check(left < wrote / 4,
    `the cast put the picture back over it (${wrote} pixels down to ${left})`);
}

// --- a line replaces the line it lands on, and only that one ------------
{
  /**
   * Narration is written a line at a time in the same place, and the
   * line before has to go or the two print on top of each other.  What
   * must not go is a line somewhere else: Hero's Quest writes its whole
   * character sheet this way, one skill at a time, and clearing every
   * older line left the last one alone on a blank page.
   */
  const ax = 20, ay = 120, bx = 20, by = 140;
  vm.kernel(display, [vm.makeString('MMMMMMMM'), 100, ax, ay]);
  const first = overPicture(ax, ay, ax + W, ay + H);
  check(first > 0, `the first line was written at ${ax},${ay} (${first} pixels)`);

  screen.restoreCastAreas();            // a cycle passes, so the line is now old
  vm.kernel(display, [vm.makeString('MMMMMMMM'), 100, bx, by]);
  const elsewhere = overPicture(ax, ay, ax + W, ay + H);
  check(elsewhere === first,
    `a line written elsewhere left it alone (${first} pixels, ${elsewhere} after)`);

  screen.restoreCastAreas();
  vm.kernel(display, [vm.makeString('MM'), 100, ax, ay]);
  const over = overPicture(ax + 20, ay, ax + W, ay + H);
  check(over === 0,
    `a shorter line in its place took the tail of it away (${over} pixels left)`);
}

// --- a window is not ----------------------------------------------------
{
  const top = 40, left = 40, bottom = 80, right = 200;
  const h = vm.kernel(newWindow, [top, left, bottom, right, 0, 0, 0, 0, 15]);
  const before = overPicture(left, top, right, bottom);
  check(before > 0, `a window painted itself over the picture at ${left},${top} (${before} pixels)`);

  // A sprite covered the same ground the window is standing on, and a
  // cycle takes it away again: the window must not go with it.
  screen.castCovered(left, top, right, bottom);
  screen.restoreCastAreas();
  const after = overPicture(left, top, right, bottom);
  check(after === before,
    `the cast left the window alone (${before} pixels, ${after} after a restore swept it)`);
  vm.kernel(disposeWindow, [h]);
}

console.log(`\n${checked - failed}/${checked} overlay checks passed`);
process.exit(failed ? 1 : 0);
