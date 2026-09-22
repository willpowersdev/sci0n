/**
 * Does the player actually control the character?
 *
 * Booting, drawing and animating are all things a game does on its own.
 * This asks the one question none of those answer: does pressing an
 * arrow key move the ego.
 *
 * It takes a while to become answerable. The games pace themselves now,
 * so reaching a room where anything can be controlled takes as long as
 * it did on the hardware -- which is why the clock is driven rather than
 * measured, and why the warm-up is a minute of game time.
 *
 * Each game is driven twice: once at the period rate, and once the way a
 * player who does not want to sit through the intro drives it -- wound
 * right up, then wound back down.  That second pass is the one that
 * caught a frozen clock, so it is not an optional extra.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { ROOT } from './games.ts';

const RIGHT = 0x4D00, DOWN = 0x5000;

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let moved = 0, tried = 0;

/**
 * Warm a game up, then press right and down and report where the ego went.
 *
 * `fast` runs the warm-up at the "skip intro" rate and drops back to the
 * period rate before touching the keyboard, which is the sequence the
 * speed control makes available and the one a player actually uses.
 */
function drive(name: string, fast: boolean) {
  tried++;
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };

  if (fast) s.cyclesPerSecond = 600;
  let st = s.tick();
  const warm = fast ? 1200 : 3600;
  for (let i = 0; i < warm && st.running; i++) st = step();
  if (fast) {
    s.cyclesPerSecond = 20;
    for (let i = 0; i < 600 && st.running; i++) st = step();
  }
  const label = `${name} @ ${fast ? 'skip-intro then 20cps' : '20cps'}`;
  const ego = s.vm.resolveTarget(null, s.vm.globals[0]);
  if (!ego) { console.log(`${label.padEnd(32)} no ego`); return; }
  const at = () => `${s.vm.prop(ego, 'x')},${s.vm.prop(ego, 'y')}`;
  const before = at();
  for (let k = 0; k < 120 && st.running; k++) { if (k % 10 === 0) s.key(RIGHT); st = step(); }
  for (let k = 0; k < 120 && st.running; k++) { if (k % 10 === 0) s.key(DOWN); st = step(); }
  const after = at();
  const ok = before !== after;
  if (ok) moved++;
  // Keys left unread mean the game never polled -- a stalled clock, not
  // a game that considered the move and declined it.
  const pending = s.vm.events.length;
  console.log(`${label.padEnd(32)} picture ${String(st.picture).padStart(3)} · ` +
    `ego ${before} -> ${after} · ${ok ? 'responds to the arrows'
      : `DID NOT MOVE${pending ? ` (${pending} keys never read)` : ''}`}`);
}

for (const name of ['SQ3', 'CAMELOT']) { drive(name, false); drive(name, true); }
console.log(`\n${moved}/${tried} runs take arrow-key control`);
process.exit(moved === tried ? 0 : 1);
