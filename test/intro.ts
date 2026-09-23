/**
 * Does Camelot's intro play?
 *
 * The opening is not a video.  It is a `Script` object in the room,
 * stepped one state per game cycle, and each state holds until
 * something releases it: a countdown in `seconds`, or a cue from a
 * sound finishing.  So "the intro plays" is a question about the clock
 * and the sound driver as much as about drawing.
 *
 * Three separate faults each stopped it dead, and each looked like a
 * different bug from the outside:
 *
 *   - `GetTime(gtTIME_OF_DAY)` answered in ticks where SCI answers in
 *     seconds, so every timed state ran sixty times fast and the
 *     credits went by before they could be read;
 *   - a piece of music ended only when somebody rendered it, so a scene
 *     waiting on a sound's cue waited for ever with nothing listening;
 *   - `Display` read parameter 105 as a width when it is the font, so
 *     the narration -- written twice, an outline font under a face font
 *     -- came out as one font twice, wrapped two different ways.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { EV } from '../src/vm/pmachine.ts';
import { WIDTH, HEIGHT } from '../src/vm/screen.ts';
import { ROOT } from './games.ts';

/** Frames to allow; the run stops as soon as the menu opens. */
const TO_MENU = 6000;
/** Four minutes of game time, which the intro fits inside. */
const INTRO = 14_000;
/** A line the narration is known to speak, over the Round Table. */
const LINE = 'Sharing the Round Table';

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
const s = new Session(g, new Index(g));
let clock = 0;
s.now = () => clock;
const step = () => { clock += 1000 / 60; return s.tick(); };

let st = s.tick();
let toMenu = 0;
for (let i = 0; i < TO_MENU && st.running; i++) {
  st = step(); toMenu = i;
  if (s.screen.windows.length) break;
}
console.log(`CAMELOT  menu opens at ${(toMenu / 60).toFixed(0)}s`);

// The credits have to take a while; sixty times fast is the bug.
let failed = 0, checked = 0;
checked++;
const paced = toMenu > 20 * 60;
if (!paced) failed++;
console.log(`  the logos and credits run for ${(toMenu / 60).toFixed(0)}s` +
  `${paced ? '' : ' -- TOO FAST TO READ'}`);

// "See the Intro" is the highlighted option.
const port = (s.vm as any).port;
s.mouse(EV.mouseDown, port.x + 180, port.y + 9);
for (let i = 0; i < 20 && st.running; i++) st = step();
s.mouse(EV.mouseUp, port.x + 180, port.y + 9);

const pictures: number[] = [];
let sawLine = false;
for (let i = 0; i < INTRO && st.running; i++) {
  st = step();
  if (st.picture >= 0 && st.picture !== pictures[pictures.length - 1]) pictures.push(st.picture);
  if (!sawLine && i % 30 === 0 && drawn(s, LINE)) sawLine = true;
}
checked++;
// One scene is the stall; the intro has many.
const played = new Set(pictures).size >= 5;
if (!played) failed++;
console.log(`  the intro shows ${new Set(pictures).size} scenes: ${pictures.join(' -> ')}` +
  `${played ? '' : ' -- IT STOPPED'}`);

checked++;
if (!sawLine) failed++;
console.log(`  "${LINE}" ${sawLine ? 'is drawn over its scene' : 'IS NOT ON THE SCREEN'}`);

/**
 * The boat that sails across the harbour scene.
 *
 * `MoveTo` turns an actor to face where it is going by calling
 * `DirLoop`, which is right for someone walking and wrong for a boat:
 * view 601's loop 0 is the shimmer of light on the water and loop 2 is
 * the boat itself, so turning it "east" replaced the boat with its own
 * reflection.  The script says so -- the boat carries `noTurn` -- and
 * `DirLoop` was ignoring it.
 *
 * Both halves are checked, because the loop number alone would still
 * pass if the art moved: the boat's cels are a quarter solid where the
 * shimmer's are a twentieth, so the opaque fraction says which one is
 * really on screen.
 */
const NO_TURN = 0x800;
let boat: { loop: number; solid: number; noTurn: boolean } | null = null;
{
  const vm = s.vm as any;
  for (const v of vm.listValues(vm.cast)) {
    const o = vm.resolveTarget(null, v);
    if (!o || o.name !== 'boat') continue;
    const cel = vm.celOf(o);
    if (!cel) continue;
    let opaque = 0;
    for (const p of cel.pixels) if (p !== cel.key) opaque++;
    boat = {
      loop: vm.prop(o, 'loop'),
      solid: opaque / (cel.width * cel.height),
      noTurn: !!(vm.prop(o, 'signal') & NO_TURN),
    };
  }
}
if (!boat) {
  console.log('  (the harbour scene had gone by; no boat to check)');
} else {
  checked++;
  // A fifth solid is comfortably above the shimmer and below the boat.
  const ok = boat.noTurn && boat.loop !== 0 && boat.solid > 0.15;
  if (!ok) failed++;
  console.log(`  the boat keeps loop ${boat.loop}, ${Math.round(boat.solid * 100)}% solid` +
    ` (noTurn ${boat.noTurn ? 'set' : 'CLEAR'})` +
    `${ok ? '' : ' -- DirLoop TURNED IT INTO THE WATER SHIMMER'}`);
}

console.log(`\n${checked - failed}/${checked} intro checks passed`);
process.exit(failed ? 1 : 0);

/** Are these glyphs on the screen, in either ink? */
function drawn(sess: Session, text: string): boolean {
  const font = (sess.vm as any).font((sess.vm as any).dsFont) ?? (sess.vm as any).font(0);
  if (!font) return false;
  const glyphs = [...text].map(ch => font.chars[ch.charCodeAt(0)]);
  if (glyphs.some(gl => !gl)) return false;
  const vis = sess.screen.visual;
  const h = Math.max(...glyphs.map(gl => gl.height));
  for (let y = 0; y + h < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++)
      for (const dark of [true, false]) {
        let cx = x, all = true;
        for (const gl of glyphs) {
          for (let gy = 0; gy < gl.height && all; gy++)
            for (let gx = 0; gx < gl.width && all; gx++) {
              if (!gl.bits[gy * gl.width + gx]) continue;
              const px = cx + gx, py = y + gy;
              if (px >= WIDTH || py >= HEIGHT) { all = false; break; }
              if (((vis[py * WIDTH + px] & 0x0F) === 0) !== dark) all = false;
            }
          cx += gl.width;
          if (!all) break;
        }
        if (all) return true;
      }
  return false;
}
