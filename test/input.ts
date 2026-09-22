/**
 * Does the player actually control the character?
 *
 * The earlier version of this test asked only whether the ego's position
 * changed after pressing an arrow, and passed for months while the games
 * were not controllable at all: any key dismissed an intro dialog and a
 * room script moved the ego once, which "changed position" satisfies.
 * A test that cannot tell being driven from being carried is worse than
 * none, because it is quoted as evidence.
 *
 * So there are three things to establish, and the last two are what give
 * the first its meaning:
 *
 *   - each arrow moves the ego in the direction it names;
 *   - the ego keeps moving, rather than jumping once;
 *   - a key that is not a direction moves it nowhere.
 *
 * Reaching a room where any of that is true takes a while: the games
 * pace themselves, and the opening is a sequence of dialogs waiting to
 * be dismissed.  That is why the clock is driven rather than measured,
 * and why the warm-up presses Enter on its way through.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { ROOT } from './games.ts';

const ENTER = 0x0D, SPACE = 0x20;
/** Each arrow, and the sign it should put on x and y. */
const ARROWS: Array<[string, number, number, number]> = [
  ['up',    0x4800,  0, -1],
  ['down',  0x5000,  0,  1],
  ['left',  0x4B00, -1,  0],
  ['right', 0x4D00,  1,  0],
];
/** A move has to clear this many pixels to count as a walk, not a nudge. */
const WALKED = 8;

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let failed = 0, checked = 0;
for (const name of ['SQ3', 'CAMELOT']) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const s = new Session(g, new Index(g));
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };

  let st = s.tick();
  // Through the opening: the games show dialogs that wait on a key.
  for (let i = 0; i < 12_000 && st.running; i++) {
    if (i % 120 === 0) s.key(ENTER);
    st = step();
  }
  const vm = s.vm;
  const ego = vm.resolveTarget(null, vm.globals[0]);
  if (!ego) { console.log(`${name.padEnd(9)} no ego`); failed++; continue; }
  const x = () => vm.prop(ego, 'x'), y = () => vm.prop(ego, 'y');

  /** Let the ego finish whatever it is doing, so the next press starts still. */
  const settle = () => {
    let last = `${x()},${y()}`, quiet = 0;
    for (let i = 0; i < 400 && st.running && quiet < 30; i++) {
      st = step();
      const at = `${x()},${y()}`;
      quiet = at === last ? quiet + 1 : 0;
      last = at;
    }
  };

  settle();
  console.log(`${name}  picture ${st.picture}, ego at ${x()},${y()}`);
  for (const [label, key, wantX, wantY] of ARROWS) {
    const x0 = x(), y0 = y();
    s.key(key);
    for (let i = 0; i < 90 && st.running; i++) st = step();
    const dx = x() - x0, dy = y() - y0;
    // The axis the arrow names must move the right way and far enough;
    // the other must stay put, or the ego is sliding off somewhere.
    const along = wantX ? dx * wantX : dy * wantY;
    const across = wantX ? Math.abs(dy) : Math.abs(dx);
    const ok = along >= WALKED && across <= WALKED;
    checked++;
    if (!ok) failed++;
    console.log(`  ${label.padEnd(5)} ${String(x0 + ',' + y0).padStart(8)} -> ` +
      `${String(x() + ',' + y()).padEnd(8)} d=(${dx},${dy})  ` +
      `${ok ? 'walks ' + label : `EXPECTED ${label.toUpperCase()}`}`);
    settle();
  }

  // The control. Without this the whole test can pass on a game that
  // merely reacts to being touched.
  const x0 = x(), y0 = y();
  s.key(SPACE);
  for (let i = 0; i < 90 && st.running; i++) st = step();
  const moved = Math.abs(x() - x0) + Math.abs(y() - y0);
  checked++;
  if (moved > WALKED) failed++;
  console.log(`  space ${String(x0 + ',' + y0).padStart(8)} -> ${String(x() + ',' + y()).padEnd(8)} ` +
    `${moved > WALKED ? 'MOVED THE EGO -- any key would pass this test'
                      : 'moves the ego nowhere, as it should'}`);
}
console.log(`\n${checked - failed}/${checked} directional checks passed`);
process.exit(failed ? 1 : 0);
