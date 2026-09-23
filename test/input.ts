/**
 * Does the player actually control the character?
 *
 * The first version of this test asked only whether the ego's position
 * changed after an arrow was pressed, and passed for months while the
 * games were not controllable at all: any key dismissed an intro dialog
 * and a room script moved the ego once, which "changed position"
 * satisfies.  A test that cannot tell being driven from being carried is
 * worse than none, because it gets quoted as evidence.
 *
 * What has to hold:
 *
 *   - each arrow turns the ego to face the way it names;
 *   - where the ground allows it, the ego walks that way;
 *   - the ego stays inside the picture;
 *   - a key that is not a direction moves it nowhere.
 *
 * A direction that does not move the ego is not automatically a fault:
 * rooms have walls, and declining to walk into one is the right answer.
 * Neither is walking out of the room, which is what an edge is for --
 * where the ego lands is then the next room's business, so only the
 * facing is judged.  What must never happen is the ego moving the wrong
 * way within a room or leaving the picture -- and it must still walk
 * somewhere, or "everything is blocked" would pass as easily as the
 * original bug did.
 *
 * Each key gets its own session.  Pressing them in turn looks cheaper
 * but is not the same test: the ego carries on walking after a press,
 * so by the third key it is somewhere else entirely, usually against an
 * edge, and what is being measured is no longer that key.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { WIDTH, HEIGHT } from '../src/vm/screen.ts';
import { SIGNAL_NO_BLOCK } from '../src/vm/pmachine.ts';
import { ROOT } from './games.ts';

const ENTER = 0x0D;
/**
 * Each key: the sign it should put on x and y, and the loop the ego
 * should be drawn in.
 *
 * The loop numbering is the views' own, not an assumption: in both games
 * the ego's view carries a mirror mask of 0x2, so loop 1 is stored as
 * the flip of loop 0 -- one walk facing each way along the horizontal --
 * and loops 2 and 3 have a different cel count again, being the walks
 * towards and away from the viewer.  Space is the control: it names no
 * direction, so it must do nothing at all.
 */
const KEYS: Array<[string, number, number, number, number]> = [
  ['up',    0x4800,  0, -1,  3],
  ['down',  0x5000,  0,  1,  2],
  ['left',  0x4B00, -1,  0,  1],
  ['right', 0x4D00,  1,  0,  0],
  ['space', 0x20,    0,  0, -1],
];
/** A move has to clear this many pixels to count as a walk, not a nudge. */
const WALKED = 8;

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

/**
 * The cast list the game last handed to `Animate`.
 *
 * There is no global to read it from, so it is taken as it goes past.
 */
let lastCast = 0;

/** Boot a game and play through its opening, which waits on keys. */
function warmed(name: string) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const s = new Session(g, new Index(g));
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };
  const idx = (s as any).index;
  const animate = idx.kernel.indexOf('Animate');
  const kernel = s.vm.kernel.bind(s.vm);
  (s.vm as any).kernel = (id: number, args: number[], f: any) => {
    if (id === animate) lastCast = args[0] ?? 0;
    return kernel(id, args, f);
  };
  let st = s.tick();
  for (let i = 0; i < 12_000 && st.running; i++) {
    if (i % 120 === 0) s.key(ENTER);
    st = step();
  }
  return { s, step, st };
}

let failed = 0, checked = 0;
for (const name of ['SQ3', 'CAMELOT']) {
  let walked = 0, first = true;
  let last: ReturnType<typeof warmed> | null = null;
  for (const [label, key, wantX, wantY, wantLoop] of KEYS) {
    const w = warmed(name); last = w;
    const { s, step } = w;
    let st = s.tick();
    const vm = s.vm;
    const ego = vm.resolveTarget(null, vm.globals[0]);
    if (!ego) { console.log(`${name.padEnd(9)} no ego`); failed++; break; }
    const x = () => vm.prop(ego, 'x'), y = () => vm.prop(ego, 'y');
    if (first) { console.log(`${name}  picture ${st.picture}, ego at ${x()},${y()}`); first = false; }

    const x0 = x(), y0 = y(), pic0 = st.picture;
    s.key(key);
    for (let i = 0; i < 90 && st.running; i++) st = step();
    const dx = x() - x0, dy = y() - y0;
    const moved = Math.abs(dx) + Math.abs(dy) > WALKED;

    if (wantLoop < 0) {                       // the control: space
      checked++;
      if (moved) failed++;
      console.log(`  ${label.padEnd(5)} ${String(x0 + ',' + y0).padStart(8)} -> ` +
        `${String(x() + ',' + y()).padEnd(8)} ` +
        `${moved ? 'MOVED THE EGO -- any key would pass this test'
                 : 'moves the ego nowhere, as it should'}`);
      continue;
    }

    // Moving is optional -- a wall is a legitimate answer -- but moving
    // the wrong way never is, and nor is leaving the picture.
    // Walking out of the room is a success, not a direction to measure:
    // the ego is somewhere in the next room now.
    const leftRoom = st.picture !== pic0;
    const along = wantX ? dx * wantX : dy * wantY;
    const across = wantX ? Math.abs(dy) : Math.abs(dx);
    const rightWay = leftRoom || !moved || (along >= WALKED && across <= WALKED);
    const loop = vm.prop(ego, 'loop');
    const facing = loop === wantLoop;
    const inside = x() >= 0 && x() < WIDTH && y() >= 0 && y() < HEIGHT;
    if (moved || leftRoom) walked++;
    checked += 3;
    if (!rightWay) failed++;
    if (!facing) failed++;
    if (!inside) failed++;
    console.log(`  ${label.padEnd(5)} ${String(x0 + ',' + y0).padStart(8)} -> ` +
      `${String(x() + ',' + y()).padEnd(8)} d=(${dx},${dy})  ` +
      `${leftRoom ? `walks ${label}, out of the room into ${st.picture}`
         : !moved ? 'blocked by the room'
         : rightWay ? 'walks ' + label : 'WENT THE WRONG WAY'}` +
      `, loop ${loop} ${facing ? `(faces ${label})` : `-- EXPECTED LOOP ${wantLoop}`}` +
      `${inside ? '' : ' -- LEFT THE PICTURE'}`);
  }
  checked++;
  if (walked < 2) { failed++; console.log(`  only ${walked} of 4 directions walked -- TOO FEW TO PROVE CONTROL`); }
  else console.log(`  ${walked} of 4 directions walked; the rest were blocked by the room`);

  /**
   * Does the scenery hide the ego when it should?
   *
   * An actor's priority follows its feet down the screen, and each of
   * its pixels is tested against the picture's own priority, so standing
   * behind a pillar hides part of it.  Both halves have to be working
   * for that to happen, and when the priority was left stale -- the ego
   * sat at 0 all game -- it walked in front of everything.
   *
   * The room is scanned rather than walked: this asks whether the
   * machinery works, and walking to a particular pillar would be a test
   * of that room instead.  Sharing the warm-up above makes it free.
   */
  if (last) {
    const vm = last.s.vm;
    const ego = vm.resolveTarget(null, vm.globals[0])!;
    const cel = (vm as any).celOf(ego);
    let legal = 0, partly = 0;
    for (let y = 10; y < HEIGHT; y += 3) for (let x = 10; x < WIDTH - 10; x += 3) {
      if (!(vm as any).legalAt(ego, x, y)) continue;
      legal++;
      const r = (vm as any).celRect(cel, x, y, vm.prop(ego, 'z'));
      const pri = vm.priorityOf(y);
      let tot = 0, hid = 0;
      for (let cy = 0; cy < cel.height; cy++) for (let cx = 0; cx < cel.width; cx++) {
        const v = cel.pixels[cy * cel.width + cx];
        if (v === cel.key) continue;
        const py = r.top + cy, px = r.left + cx;
        if (py < 0 || py >= HEIGHT || px < 0 || px >= WIDTH) continue;
        tot++;
        if (pri < last.s.screen.priority[py * WIDTH + px]) hid++;
      }
      if (hid > 0 && hid < tot) partly++;
    }
    checked++;
    if (!partly) failed++;
    console.log(`  ${legal} legal standing positions, ${partly} where scenery hides part of the ego` +
      `${partly ? '' : ' -- NOTHING OCCLUDES THE EGO'}`);

    /**
     * Do the other things in the room stand in the way?
     *
     * Actors stand on each other's base rectangles, and a member
     * carrying the "ignore actors" bit is meant to be walked through --
     * a doorway, typically.  Both halves are checked here, because
     * blocking everything would satisfy the first on its own.
     */
    // An ego carrying the bit itself walks through everything on
    // purpose, and SQ3's does; only Camelot's is stopped by furniture.
    const egoIgnores = (vm.prop(ego, 'signal') & 0xFFFF & 0x4000) !== 0;
    let blockers = 0, walkThrough = 0, wrong = 0;
    for (const v of (vm as any).listValues(lastCast)) {
      const m = vm.resolveTarget(null, v);
      if (!m || m === ego) continue;
      const exempt = (vm.prop(m, 'signal') & 0xFFFF & SIGNAL_NO_BLOCK) !== 0;
      // Ask the collision check itself, not `legalAt`: standing where a
      // thing is may also be refused by the control plane, and that
      // would make this pass without the cast being consulted at all.
      const at = (vm as any).baseRectOf(ego, vm.prop(m, 'x'), vm.prop(m, 'y'));
      if (!at) continue;
      const stopped = (vm as any).blockedByCast(ego, at.left, at.top, at.right, at.bottom, lastCast);
      if (exempt || egoIgnores) { walkThrough++; if (stopped) wrong++; }
      else { blockers++; if (!stopped) wrong++; }
    }
    checked += egoIgnores ? 1 : 2;
    if (wrong) failed++;
    if (!egoIgnores && !blockers) failed++;
    console.log(`  ${blockers} cast members block the ego, ${walkThrough} are walked through` +
      `${egoIgnores ? ' (this ego ignores actors, by its own signal)' : ''}` +
      `${wrong ? ` -- ${wrong} BEHAVED THE WRONG WAY` : ''}` +
      `${!egoIgnores && !blockers ? ' -- NOTHING BLOCKS THE EGO' : ''}`);
  }

  /**
   * When two sprites overlap, which one is in front?
   *
   * Cast members are drawn back to front by y, and each writes its
   * priority as it goes, so whichever is nearer the bottom of the
   * screen wins the pixels they share.  Sorting by priority instead put
   * anything in the ego's band in front of it whenever it came later in
   * the cast: Camelot's armour stand sits at y 108 and the ego walks to
   * 110, and the stand was drawn over it.
   *
   * This gets a session of its own.  Putting the ego on each member in
   * turn walks it through doorways -- by the third the room has changed
   * and the member is not in it -- so one member is tested, the biggest
   * thing in the room, and the room is checked to be the same one.
   */
  {
    const w = warmed(name);
    const vm = w.s.vm;
    const ego = vm.resolveTarget(null, vm.globals[0]);
    const pic = w.s.tick().picture;
    // The biggest solid thing in the room.  A member carrying the
    // "ignore actors" bit is usually a doorway drawn flat against the
    // wall, which the ego barely overlaps however it stands.
    let target: ReturnType<typeof vm.resolveTarget> = null, area = 0;
    for (const v of (vm as any).listValues(lastCast)) {
      const m = vm.resolveTarget(null, v);
      if (!m || m === ego) continue;
      if (vm.prop(m, 'signal') & 0xFFFF & SIGNAL_NO_BLOCK) continue;
      const c = (vm as any).celOf(m);
      if (c && c.width * c.height > area) { area = c.width * c.height; target = m; }
    }
    if (ego && target) {
      /** Hold the ego still: the game animates on its own cycle. */
      const place = (ex: number, ey: number) => {
        for (let k = 0; k < 12; k++) {
          vm.setProp(ego, 'x', ex); vm.setProp(ego, 'y', ey);
          vm.setProp(ego, 'mover', 0);
          w.step();
        }
      };
      /** The share of the shared pixels the ego ended up owning. */
      const share = () => {
        const ec = (vm as any).celOf(ego), mc = (vm as any).celOf(target);
        if (!ec || !mc) return null;
        const er = (vm as any).celRect(ec, vm.prop(ego, 'x'), vm.prop(ego, 'y'), vm.prop(ego, 'z'));
        const mr = (vm as any).celRect(mc, vm.prop(target!, 'x'), vm.prop(target!, 'y'), vm.prop(target!, 'z'));
        let both = 0, mine = 0;
        for (let y = Math.max(er.top, mr.top); y < Math.min(er.bottom, mr.bottom); y++)
          for (let x = Math.max(er.left, mr.left); x < Math.min(er.right, mr.right); x++) {
            if (y < 0 || y >= HEIGHT || x < 0 || x >= WIDTH) continue;
            const ev = ec.pixels[(y - er.top) * ec.width + (x - er.left)];
            const mv = mc.pixels[(y - mr.top) * mc.width + (x - mr.left)];
            if (ev === ec.key || mv === mc.key) continue;
            both++;
            if (w.s.screen.visual[y * WIDTH + x] === (ev < 16 ? (ev << 4) | ev : ev)) mine++;
          }
        return both < 20 ? null : mine / both;
      };
      const tx = vm.prop(target, 'x'), ty = vm.prop(target, 'y');
      place(tx, ty + 4);
      const front = w.s.tick().picture === pic ? share() : null;
      place(tx, ty - 4);
      const back = w.s.tick().picture === pic ? share() : null;
      if (front === null || back === null) {
        console.log(`  sprite order against ${target.def.name}: not enough overlap to judge`);
      } else {
        const ok = front > 0.9 && back < 0.5;
        checked++;
        if (!ok) failed++;
        console.log(`  in front of ${target.def.name} the ego wins ` +
          `${(front * 100).toFixed(0)}% of the pixels they share, behind it ` +
          `${(back * 100).toFixed(0)}%${ok ? '' : ' -- DRAWN IN THE WRONG ORDER'}`);
      }
    }
  }
}
console.log(`\n${checked - failed}/${checked} checks passed`);
process.exit(failed ? 1 : 0);
