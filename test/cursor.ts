/**
 * The game's own pointer.
 *
 * Every SCI0 game keeps its cursor in two resources: 999 is the arrow,
 * and 997 is the one it puts up while it is busy -- an hourglass in
 * most of them, the Grail itself in Camelot.  The interpreter drew
 * neither.  `SetCursor` only ever looked at its arguments for a
 * position, and even that it took from the wrong one: the second
 * argument says whether the pointer is *shown*, so a game hiding its
 * cursor with `SetCursor(999, 0, 320, 200)` was read as moving the
 * mouse to column 0 instead.  The player saw the browser's arrow
 * throughout and never the game's, and never knew when it was working.
 *
 * SCI composites the cursor over everything and never into the
 * picture, so the checks below ask for both halves of that: it has to
 * appear in the rendered frame, and it must leave the planes alone --
 * a cursor drawn into the picture would smear a trail of arrows behind
 * every movement, and no single screenshot would show it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { WIDTH } from '../src/vm/screen.ts';
import { Cursor, CURSOR_SIZE } from '../src/font.ts';
import { ROOT } from './games.ts';

const ENTER = 0x0D;
/** The two every game has: the arrow, and the one it shows when busy. */
const ARROW = 999, BUSY = 997;

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

/** Pixels of the frame that differ, and the box they sit in. */
function diff(a: Uint8Array, b: Uint8Array) {
  let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let i = 0; i < a.length; i += 3) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) continue;
    n++;
    const p = i / 3, x = p % WIDTH, y = (p / WIDTH) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { n, x0, y0, x1, y1 };
}

let failed = 0, checked = 0;
for (const name of ['CAMELOT', 'SQ3']) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };
  const vm = s.vm as any;
  const setCursor = idx.kernel.indexOf('SetCursor');

  // What the game asks for of its own accord, while it is starting up
  // and loading rooms -- which is when it wants the busy pointer.
  const asked: number[] = [];
  const kernel = vm.kernel.bind(vm);
  vm.kernel = (id: number, a: number[], f: any) => {
    if (id === setCursor) asked.push(a[0]);
    return kernel(id, a, f);
  };

  let st = s.tick();
  for (let i = 0; i < 12_000 && st.running; i++) { if (i % 120 === 0) s.key(ENTER); st = step(); }
  console.log(`\n=== ${name} ===`);

  const put = (...a: number[]) => { vm.kernel(setCursor, a, null); for (let i = 0; i < 2; i++) st = step(); };
  const frame = () => s.screen.rgb().slice();

  // Hidden, so the frame underneath is the one to compare against.
  put(ARROW, 0);
  s.move(150, 120);
  const bare = frame();
  const plane = Uint8Array.from(s.screen.visual);

  put(ARROW, 1);
  const withArrow = frame();
  const d = diff(bare, withArrow);
  checked++;
  // Drawn, and confined to one cursor's worth of the screen.
  const ok = d.n > 0 && (d.x1 - d.x0) < CURSOR_SIZE && (d.y1 - d.y0) < CURSOR_SIZE;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} the arrow draws ${d.n} pixels at ${d.x0},${d.y0}-${d.x1},${d.y1}` +
    `${d.n ? '' : ' -- NOTHING WAS DRAWN'}`);

  // It is composited, not painted: the planes must not have moved.
  checked++;
  let touched = 0;
  for (let i = 0; i < plane.length; i++) if (plane[i] !== s.screen.visual[i]) touched++;
  if (touched) failed++;
  console.log(`  ${touched ? 'FAIL' : 'ok  '} the picture underneath is untouched` +
    `${touched ? ` -- ${touched} PIXELS WERE PAINTED INTO IT` : ''}`);

  // The busy cursor is a different pointer, not the same one again.
  put(BUSY, 1);
  const withBusy = frame();
  checked++;
  const changed = diff(withArrow, withBusy).n;
  if (!changed) failed++;
  console.log(`  ${changed ? 'ok  ' : 'FAIL'} the busy cursor differs from the arrow in ${changed} pixels` +
    `${changed ? '' : ' -- IT IS THE SAME PICTURE'}`);

  /**
   * Hiding is the second argument, not a coordinate.
   *
   * `SetCursor(999, 0, 320, 200)` is how a game parks its pointer out
   * of the way.  Read as a position it moved the mouse to column 0 and
   * left the arrow sitting in the corner of the picture.
   */
  s.move(150, 120);
  put(ARROW, 0, 320, 200);
  checked++;
  const hidden = diff(bare, frame()).n === 0;
  const moved = s.screen.cursorX === 320;
  if (!hidden || !moved) failed++;
  console.log(`  ${hidden && moved ? 'ok  ' : 'FAIL'} hiding it draws nothing and takes the position from` +
    ` the third argument (x=${s.screen.cursorX})` +
    `${hidden ? '' : ' -- STILL DRAWN'}${moved ? '' : ' -- READ THE WRONG ARGUMENT'}`);

  /**
   * The game asks for both of them itself.
   *
   * Not just any cursor: the arrow to point with, and 997 while it is
   * busy.  That second one is the whole reason the pointer matters --
   * it is how a player tells a game that is loading from one that has
   * stopped.
   */
  checked++;
  const kinds = new Set(asked);
  const both = kinds.has(ARROW) && kinds.has(BUSY);
  if (!both) failed++;
  console.log(`  ${both ? 'ok  ' : 'FAIL'} the game asked for ${[...kinds].sort().join(', ') || 'no cursor at all'}` +
    `${both ? ' -- the arrow and the busy one' : ` -- EXPECTED BOTH ${ARROW} AND ${BUSY}`}`);
}

/**
 * Where a cursor points.
 *
 * An SCI0 cursor carries no hotspot coordinates at all.  Its first four
 * bytes are a flag: set byte 3 means "centre it", anything else means
 * the top left.  Reading those bytes as a coordinate pair -- which is
 * what later SCI does put there -- gave Colonel's Bequest a hotspot of
 * (448,320), which is not a position inside a sixteen-pixel square.
 *
 * So the pair is believed only when it lands inside the bitmap.  That
 * invariant is the check: a hotspot outside the cursor is meaningless
 * whoever wrote the file, and it needs no fixture to state.
 *
 * The two cursors it moves are worth naming, because they are not
 * arbitrary: both are 997, the one a game puts up while it is busy.
 * That one wants to be centred precisely because it is not pointing at
 * anything.
 */
{
  console.log('\n=== hotspots ===');
  let outside = 0, seen = 0;
  const centred: string[] = [];
  for (const name of readdirSync(ROOT).sort()) {
    let g: Game;
    try { g = new Game(nodeSource(join(ROOT, name))); } catch { continue; }
    for (const r of g.byType('cursor')) {
      const d = g.tryData('cursor', r.number);
      if (!d || d.length !== 68) continue;
      let cu: Cursor;
      try { cu = new Cursor(d); } catch { continue; }
      seen++;
      if (cu.hotspotX >= CURSOR_SIZE || cu.hotspotY >= CURSOR_SIZE ||
          cu.hotspotX < 0 || cu.hotspotY < 0) {
        outside++;
        console.log(`  ${name} cursor ${r.number}: HOTSPOT ${cu.hotspotX},${cu.hotspotY} IS OUTSIDE THE BITMAP`);
      }
      // Which ones had no usable pair and fell back to the flag.  A
      // stored (8,8) is an ordinary hotspot -- several of King's Quest
      // V's have it -- so asking "is it centred" would catch those too.
      const storedX = d[0] | (d[1] << 8), storedY = d[2] | (d[3] << 8);
      if (storedX >= CURSOR_SIZE || storedY >= CURSOR_SIZE)
        centred.push(`${name}.${r.number}`);
    }
  }
  checked++;
  if (outside) failed++;
  console.log(`  ${outside ? 'FAIL' : 'ok  '} all ${seen} cursors point inside themselves`);

  checked++;
  // Every cursor that falls back to the flag is the busy one.
  const allBusy = centred.length > 0 && centred.every(c => c.endsWith('.997'));
  if (!allBusy) failed++;
  console.log(`  ${allBusy ? 'ok  ' : 'FAIL'} the ones with no usable pair are ${centred.join(', ') || 'none'}` +
    `${allBusy ? ' -- the busy cursor, centred by its flag' : ' -- EXPECTED ONLY 997'}`);
}

console.log(`\n${checked - failed}/${checked} cursor checks passed`);
process.exit(failed ? 1 : 0);
