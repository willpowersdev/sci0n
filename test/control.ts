/**
 * `OnControl`, and the map that is built on it.
 *
 * The kernel has two forms.  `OnControl(map, left, top, right, bottom)`
 * reports on a rectangle, which is what almost every call wants -- an
 * actor's base, to see what it is standing on.  `OnControl(map, x, y)`
 * asks about a single point, and that one was not handled at all: it
 * fell through to the branch that expects an actor, tried to resolve an
 * x coordinate as an object, found nothing, and answered "no control
 * colours here".  Every one of Camelot's 31 calls came back 0.
 *
 * Camelot's overhead map is built entirely on the short form.  `rm1`
 * reads the control colour under Arthur to work out which part of
 * Britain he is on, and when that changes it decides he has left the
 * region he started in.  Hearing 0 every time, it concluded he had
 * wandered off the moment he moved and walked him back to where he
 * began: a few steps in any direction, then home again, in silence.
 *
 * Both are checked, because the kernel answering correctly is no use
 * if the game still cannot act on it.  The second check is the one
 * that matches what a player sees -- walk in a straight line and stay
 * walked.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { Picture } from '../src/pic.ts';
import { WIDTH } from '../src/vm/screen.ts';
import { ROOT } from './games.ts';

const ENTER = 0x0D, UP = 0x4800, LEFT = 0x4B00;
/** `ocSPECIAL`: the control map. */
const CONTROL = 4;
/** Further than the old code ever let him get before hauling him back. */
const TRAVELLED = 30;

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let failed = 0, checked = 0;

const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
const idx = new Index(g);
const s = new Session(g, idx);
let clock = 0;
s.now = () => clock;
const step = () => { clock += 1000 / 60; return s.tick(); };
const vm = s.vm as any;
const onControl = idx.kernel.indexOf('OnControl');

let st = s.tick();
for (let i = 0; i < 12_000 && st.running; i++) { if (i % 120 === 0) s.key(ENTER); st = step(); }

/**
 * The point form answers for the colour actually under the point.
 *
 * Read straight off the decoded picture, so this cannot be satisfied
 * by a kernel that returns some plausible constant.
 */
{
  const map = new Picture(g.tryData('pic', 1)!);
  const pts: Array<[number, number, number]> = [];
  for (let y = 40; y < 150 && pts.length < 8; y += 13)
    for (let x = 40; x < 280 && pts.length < 8; x += 29) {
      const c = map.control[y * WIDTH + x] & 15;
      if (c) pts.push([x, y, c]);
    }
  // Put that picture on screen so the kernel is reading the same one.
  s.screen.drawPic(map);
  let wrong = 0;
  for (const [x, y, c] of pts) {
    const got = vm.kernel(onControl, [CONTROL, x, y], null);
    if (got !== (1 << c)) wrong++;
  }
  checked++;
  if (wrong) failed++;
  console.log(`  ${wrong ? 'FAIL' : 'ok  '} OnControl(map, x, y) named the colour at all ${pts.length} points` +
    `${wrong ? ` -- ${wrong} WERE WRONG` : ''}`);
}

/**
 * And on the map itself, walking gets somewhere.
 *
 * Arthur has to be in his travelling clothes before the game will let
 * him out of his room at all, so the sequence is the player's: change,
 * leave, then walk.
 */
{
  const s2 = new Session(new Game(nodeSource(join(ROOT, 'CAMELOT'))), idx);
  let c2 = 0;
  s2.now = () => c2;
  const tick = () => { c2 += 1000 / 60; return s2.tick(); };
  const vm2 = s2.vm as any;
  const ego = () => {
    for (const v of vm2.listValues(vm2.cast)) {
      const o = vm2.resolveTarget(null, v);
      if (o?.name === 'ego') return o;
    }
    return null;
  };
  const at = () => { const e = ego(); return e ? [vm2.prop(e, 'x'), vm2.prop(e, 'y')] : [0, 0]; };

  let t = s2.tick();
  for (let i = 0; i < 12_000 && t.running; i++) { if (i % 120 === 0) s2.key(ENTER); t = tick(); }
  for (const ch of 'wear travelling clothes') { s2.key(ch.charCodeAt(0)); for (let i = 0; i < 8; i++) t = tick(); }
  s2.key(ENTER);
  for (let i = 0; i < 900 && t.running; i++) t = tick();
  s2.key(ENTER);
  for (let i = 0; i < 200 && t.running; i++) t = tick();

  const room = t.picture;
  for (let k = 0; k < 40 && t.picture === room; k++) { s2.key(LEFT); for (let i = 0; i < 30; i++) t = tick(); }
  checked++;
  const onMap = t.picture !== room;
  if (!onMap) failed++;
  console.log(`  ${onMap ? 'ok  ' : 'FAIL'} leaving his room reaches picture ${t.picture}` +
    `${onMap ? '' : ' -- HE NEVER GOT OUT'}`);

  if (onMap) {
    const [x0, y0] = at();
    for (let k = 0; k < 60 && t.running; k++) { s2.key(UP); for (let i = 0; i < 6; i++) t = tick(); }
    const [x1, y1] = at();
    const gone = Math.hypot(x1 - x0, y1 - y0);
    checked++;
    const ok = gone >= TRAVELLED;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} walking north took him ${Math.round(gone)}px from ${x0},${y0} to ${x1},${y1}` +
      `${ok ? '' : ' -- HE WAS WALKED BACK TO WHERE HE STARTED'}`);
  }
}

/**
 * The edge of the picture is not a wall.
 *
 * `CanBeHere` used to refuse any base reaching past the picture, which
 * sounds like common sense and is not what the original does: it asks
 * the control plane and the other actors, and nothing else.  Keeping an
 * actor on screen is the control plane's job, and a room that wants a
 * way out simply leaves its edge unpainted.
 *
 * Merlin's room is one.  `Rm2::doit` watches for the ego's y passing
 * 188 and sends it back to the map, and the ego steps two rows at a
 * time from an even start -- so with that check in place the highest it
 * could reach was 188 exactly.  One short, in a room with no other way
 * out: you could walk in and never leave.
 *
 * Both halves are checked, because removing a bound is only right if
 * the rooms that meant to stop you still do.  Merlin's floor has to let
 * the ego past the line his room watches for, and Arthur's chamber --
 * which paints its edges -- still has to hold him in.
 */
{
  console.log('\n=== the picture\'s edge ===');
  const vm2 = s.vm as any;
  const canBeHere = idx.kernel.indexOf('CanBeHere');
  const baseSetter = idx.kernel.indexOf('BaseSetter');
  let ego: any = null;
  for (const v of vm2.listValues(vm2.cast)) {
    const o = vm2.resolveTarget(null, v);
    if (o?.name === 'ego') { ego = o; break; }
  }

  /** May the ego stand here, with this room's control plane on screen? */
  const standable = (pic: number, x: number, y: number) => {
    s.screen.drawPic(new Picture(g.data(1, pic)));
    vm2.setProp(ego, 'x', x); vm2.setProp(ego, 'y', y);
    vm2.kernel(baseSetter, [ego.handle || 0], null);
    return !!vm2.kernel(canBeHere, [ego.handle || 0], null);
  };

  if (!ego) {
    failed++; checked++;
    console.log('  FAIL there is no ego to place');
  } else {
    // Merlin's room: the way out is off the bottom, past y = 188.
    checked++;
    const canLeave = standable(2, 160, 190);
    if (!canLeave) failed++;
    console.log(`  ${canLeave ? 'ok  ' : 'FAIL'} Merlin's floor lets the ego past y=188` +
      `${canLeave ? '' : ' -- HIS ROOM HAS NO EXIT'}`);

    /**
     * And the rooms that meant to stop you still do.
     *
     * Arthur's chamber has no `doit` and no way out at the bottom, so
     * it paints a line of blocking control along its last row instead.
     * Stepping onto y=190 puts the ego's base across that row, which is
     * what has to refuse -- the check being removed was never what held
     * him in, it only looked like it.
     */
    checked++;
    const held = !standable(4, 160, 190);
    if (!held) failed++;
    console.log(`  ${held ? 'ok  ' : 'FAIL'} Arthur's chamber still stops him on its painted edge` +
      `${held ? '' : ' -- HE WALKS OUT OF THE PICTURE'}`);
  }
}

console.log(`\n${checked - failed}/${checked} control checks passed`);
process.exit(failed ? 1 : 0);
