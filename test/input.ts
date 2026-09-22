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
for (const name of ['SQ3', 'CAMELOT']) {
  tried++;
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };

  let st = s.tick();
  for (let i = 0; i < 3600 && st.running; i++) st = step();   // a minute of game
  const ego = s.vm.resolveTarget(null, s.vm.globals[0]);
  if (!ego) { console.log(`${name.padEnd(9)} no ego`); continue; }
  const at = () => `${s.vm.prop(ego, 'x')},${s.vm.prop(ego, 'y')}`;
  const before = at();
  for (let k = 0; k < 120 && st.running; k++) { if (k % 10 === 0) s.key(RIGHT); st = step(); }
  for (let k = 0; k < 120 && st.running; k++) { if (k % 10 === 0) s.key(DOWN); st = step(); }
  const after = at();
  const ok = before !== after;
  if (ok) moved++;
  console.log(`${name.padEnd(9)} picture ${String(st.picture).padStart(3)} · ` +
    `ego ${before} -> ${after} · ${ok ? 'responds to the arrows' : 'DID NOT MOVE'}`);
}
console.log(`\n${moved}/${tried} games take arrow-key control`);
process.exit(moved === tried ? 0 : 1);
