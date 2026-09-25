/**
 * Wading and swimming, which are not features but a consequence.
 *
 * SCI has no code for being in water.  What it has, per ScummVM, is:
 * the priority screen starts at zero and is written only where the
 * picture's own `PIC_OP_SET_PRIORITY` paints it; a character's
 * priority is the band its y falls in; and a cel pixel is drawn where
 * `priority >= screenPriority`, so the background hides it only where
 * that value is strictly greater.
 *
 * So an artist makes water by painting priority over it that beats the
 * band of the rows it covers, and the character standing there is cut
 * off at the waterline.  Nothing else is involved -- no control
 * colour, no script.  King's Quest IV's stream beside the unicorn has
 * almost no such priority (296 pixels of it), which is why Rosella
 * walks across that one; the game's other fifty-one water screens have
 * thousands.
 *
 * Every SCI0 game here uses it, so the check is categorical: for each
 * game, find the picture with the most water painted that way, stand a
 * figure in it, and require the background to hold back a real share
 * of the figure.  Getting the comparison backwards, or ignoring the
 * picture's priority, leaves the figure whole and fails everywhere.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { Picture } from '../src/pic.ts';
import { View } from '../src/view.ts';
import { ROOT } from './games.ts';

let failed = 0, checked = 0;
const check = (ok: boolean, msg: string) => {
  checked++; if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
};

/** ScummVM's band arithmetic, which ours has to agree with. */
const TOP = 42, BOTTOM = 190, BANDS = 14;
const bandSize = ((BOTTOM - TOP) * 2000) / BANDS;
const band = (y: number) => y < TOP ? 0 : Math.min(15, 1 + Math.floor(((y - TOP) * 2000) / bandSize));

/** Blue and cyan, and not dithered against anything else. */
const WATER = new Set([1, 3, 9, 11]);
const isWater = (v: number) => WATER.has(v >> 4) && WATER.has(v & 0x0F);

/** Games are configuration; whichever are present get checked. */
const here = readdirSync('games').filter(d => existsSync(join('games', d, 'RESOURCE.MAP')));
const dirs = here.length
  ? here.map(d => [d, join('games', d)] as const)
  : readdirSync(ROOT).filter(d => existsSync(join(ROOT, d, 'RESOURCE.MAP')))
      .map(d => [d, join(ROOT, d)] as const);
if (!dirs.length) {
  console.log('water: no games here, so wading was NOT checked');
  process.exit(0);
}

for (const [name, dir] of dirs) {
  const files = readdirSync(dir);
  const g = new Game({ names: () => files,
    read: (n: string) => new Uint8Array(readFileSync(join(dir, n))) } as ResourceSource);

  let best: { n: number; no: number; pic: Picture } | null = null;
  for (const r of g.byType('pic')) {
    let p: Picture;
    try { p = new Picture(g.tryData('pic', r.number)!); } catch { continue; }
    let n = 0;
    for (let y = TOP; y < 190; y++) {
      const b = band(y);
      for (let x = 0; x < 320; x++) {
        const i = y * 320 + x;
        if (p.priority[i] > b && isWater(p.visual[i])) n++;
      }
    }
    if (!best || n > best.n) best = { n, no: r.number, pic: p };
  }
  if (!best || best.n < 500) { check(false, `${name}: no water painted to stand in`); continue; }

  // Any upright cel stands in for a character.
  let cel: { width: number; height: number; key: number; pixels: Uint8Array } | null = null;
  for (const r of g.byType('view')) {
    try {
      const v = new View(g.tryData('view', r.number)!);
      for (const cels of v.loops) for (const c of cels)
        if (!cel && c.height >= 28 && c.height <= 50 && c.width >= 10) cel = c;
    } catch { /* unreadable view */ }
    if (cel) break;
  }
  if (!cel) { check(false, `${name}: no cel to stand in the water`); continue; }

  const idx = new Index(g);
  const s = new Session(g, idx);
  const screen = s.screen as unknown as {
    visual: Uint8Array;
    drawPic(p: Picture, clear: boolean, reveal: boolean): void;
    drawCel(c: unknown, l: number, t: number, pri: number, a: boolean, b: boolean): void;
  };

  /**
   * Deepest first: the waterline is what is being measured, and a
   * point at the very edge of the water would measure the edge.
   */
  const spots: Array<[number, number, number]> = [];
  for (let y = 189; y >= TOP; y--) {
    const b = band(y);
    for (let x = 8; x < 312; x++) {
      const i = y * 320 + x;
      if (isWater(best.pic.visual[i]) && best.pic.priority[i] > b)
        spots.push([x, y, best.pic.priority[i] - b]);
    }
  }
  spots.sort((a, b2) => b2[2] - a[2]);
  // Spread the samples over the whole list rather than crowding the
  // deepest corner, which may be a puddle behind something.
  const stride = Math.max(1, Math.floor(spots.length / 300));
  const sample = spots.filter((_, i) => i % stride === 0);

  let bestHeld = 0, at = '';
  for (const [wx, wy] of sample.slice(0, 300)) {
    screen.drawPic(best.pic, true, true);
    const left = wx - (cel.width >> 1), top = wy - cel.height;
    const before = screen.visual.slice();
    screen.drawCel(cel, left, top, band(wy), true, true);
    let drawn = 0, held = 0;
    for (let y = 0; y < cel.height; y++) for (let x = 0; x < cel.width; x++) {
      if (cel.pixels[y * cel.width + x] === cel.key) continue;
      const sx = left + x, sy = top + y;
      if (sx < 0 || sx >= 320 || sy < 0 || sy >= 190) continue;
      if (screen.visual[sy * 320 + sx] === before[sy * 320 + sx]) held++; else drawn++;
    }
    const pct = Math.round(100 * held / Math.max(1, held + drawn));
    if (pct > bestHeld) { bestHeld = pct; at = `${wx},${wy}`; }
  }

  check(bestHeld >= 25,
    `${name}: pic ${best.no} has ${best.n} pixels of standing water; ` +
    `a figure at ${at} loses ${bestHeld}% of itself to it`);
}

console.log(`\n${checked - failed}/${checked} water checks passed`);
process.exit(failed ? 1 : 0);
