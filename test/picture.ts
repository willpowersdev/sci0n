/**
 * Lines, and the fills they are supposed to hold in.
 *
 * A vector picture is drawn as outlines and then flood fills, so every
 * filled area is bounded by the lines laid down before it.  That makes
 * the line rasteriser load-bearing in a way it looks like it should not
 * be: the original's is not the textbook Bresenham, the two disagree
 * about a pixel here and there, and a single pixel is the difference
 * between a closed outline and one with a hole in it.  Where there is a
 * hole the fill behind it pours through and takes the rest of the
 * picture with it.
 *
 * Camelot's credit screen is the clearest case.  `FILL 74,87` paints
 * the king's hand in 0xfc -- white over light red, which dithers to
 * pale flesh -- and the background is filled black much later, at byte
 * 5186.  With a textbook Bresenham the hand's outline has a gap at
 * y=83; the flesh escapes along it, swallows the whole picture, and by
 * the time the black fill runs there is no unpainted pixel left for it
 * to claim.  The screen came out pink from edge to edge.
 *
 * So the check is that those two areas still have two different
 * colours.  That is the whole bug in one comparison, and it needs no
 * golden digest to state: it is a fact about the picture, not about
 * whichever implementation hashed it first.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Picture } from '../src/pic.ts';
import { ROOT } from './games.ts';

const WIDTH = 320;
/** Where the king's hand is, and the colour it is painted. */
const HAND_X = 74, HAND_Y = 87, FLESH = 0xFC;
/** Two places that are plain background, well away from the figure. */
const BACKGROUND: Array<[number, number]> = [[250, 100], [290, 40]];

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let failed = 0, checked = 0;

{
  const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
  const p = new Picture(g.data(1, 100));
  const at = (x: number, y: number) => p.visual[y * WIDTH + x];

  checked++;
  const hand = at(HAND_X, HAND_Y);
  const isFlesh = hand === FLESH;
  if (!isFlesh) failed++;
  console.log(`  ${isFlesh ? 'ok  ' : 'FAIL'} the hand at ${HAND_X},${HAND_Y} is 0x${hand.toString(16)}` +
    `${isFlesh ? '' : ` -- EXPECTED 0x${FLESH.toString(16)}`}`);

  for (const [x, y] of BACKGROUND) {
    checked++;
    const bg = at(x, y);
    // Not "is it black" but "is it not the hand": the failure being
    // guarded against is the one colour reaching both.
    const held = bg !== hand;
    if (!held) failed++;
    console.log(`  ${held ? 'ok  ' : 'FAIL'} the background at ${x},${y} is 0x${bg.toString(16)}` +
      `${held ? '' : ' -- THE HAND\'S FILL ESCAPED INTO IT'}`);
  }

  // And the background really is the black the later fill puts there.
  checked++;
  const black = BACKGROUND.every(([x, y]) => at(x, y) === 0x00);
  if (!black) failed++;
  console.log(`  ${black ? 'ok  ' : 'FAIL'} the background is black${black ? '' : ' -- SOMETHING ELSE CLAIMED IT'}`);
}

/**
 * Axis-aligned runs reach both ends.
 *
 * The original draws a horizontal or vertical line as a run rather
 * than stepping it, and an off-by-one at either end of a run is
 * exactly the sort of hole a fill finds.  Asked for the top and left
 * edges of a box, every pixel along them has to be painted.
 */
{
  const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
  const p = new Picture(g.data(1, 100)) as unknown as {
    visual: Uint8Array;
    line(x1: number, y1: number, x2: number, y2: number): void;
    color: number | null;
  };
  p.color = 0x11;
  p.line(10, 10, 40, 10);      // left to right
  p.line(40, 60, 10, 60);      // right to left, the same row span
  p.line(70, 20, 70, 50);      // top to bottom
  checked++;
  let holes = 0;
  for (let x = 10; x <= 40; x++) {
    if (p.visual[10 * WIDTH + x] !== 0x11) holes++;
    if (p.visual[60 * WIDTH + x] !== 0x11) holes++;
  }
  for (let y = 20; y <= 50; y++) if (p.visual[y * WIDTH + 70] !== 0x11) holes++;
  if (holes) failed++;
  console.log(`  ${holes ? 'FAIL' : 'ok  '} horizontal and vertical runs are solid end to end` +
    `${holes ? ` -- ${holes} PIXELS MISSING` : ''}`);
}

console.log(`\n${checked - failed}/${checked} picture checks passed`);
process.exit(failed ? 1 : 0);
