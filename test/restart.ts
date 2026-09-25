/**
 * How King's Quest IV starts, which is by restarting itself.
 *
 * Its opening is an attract loop.  Script 0's `init` asks the
 * interpreter `GameIsRestarting`, and on "no" -- which is every fresh
 * boot -- it goes to the copy-protection room and from there through
 * the title, the credits, Graham's collapse and Rosella on the shore
 * of Tamir with Genesta.  `RoomActions` state 32 in script 222 ends
 * that by calling `Game::restart`, which is the `RestartGame` kernel.
 * The game comes up again, `init` asks a second time, the answer is
 * now "yes", and it goes straight to room 25: the beach you play.
 *
 * So both halves are load-bearing and neither is optional.  With
 * `RestartGame` doing nothing the intro ran to its last frame and
 * stopped dead -- no ego in the cast, `User.canInput` false, the
 * player looking at the beach unable to move.  With `GameIsRestarting`
 * answering no every time, the restart works and lands back at the
 * copy-protection room, and the intro plays again for ever.
 *
 * The checks are on the thing the player would do: after the intro,
 * press an arrow key and see whether Rosella walks, and whether she
 * turns to face the way she is going.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
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

const g = new Game(nodeSource(join(ROOT, 'KQ4')));
const idx = new Index(g);
const s = new Session(g, idx);
let clock = 0;
s.now = () => clock;

const s16 = (v: number) => (v << 16) >> 16;
/** The machine is replaced by a restart, so it is never held onto. */
interface Machine { objects?: Map<number, unknown>; prop(o: unknown, n: string): number }
const vm = () => s.vm as unknown as Machine;
const named = (n: string) =>
  [...(vm().objects?.values() ?? [])]
    .find((o) => (o as { def?: { name?: string } })?.def?.name === n);
const p = (o: unknown, n: string) => { try { return s16(vm().prop(o, n)); } catch { return -999; } };

/** Did the game ask to be restarted?  The intro's last act. */
let asked = false;
const restartKernel = idx.kernel.indexOf('RestartGame');
const watch = () => {
  const m = s.vm as unknown as { kernel(id: number, a: number[], f?: unknown): number };
  const real = m.kernel.bind(m);
  m.kernel = (id, a, f) => { if (id === restartKernel) asked = true; return real(id, a, f); };
};
watch();

/**
 * Long enough for the whole intro and the restart after it.  The intro
 * runs about thirty-two thousand frames; the rest is margin.
 */
let st = s.tick();
let restartedAt = -1;
for (let i = 0; i < 40000 && st.running; i++) {
  clock += 1000 / 60;
  st = s.tick();
  if (asked && restartedAt < 0 && st.picture >= 0 && i > 0) { restartedAt = i; watch(); }
}

check(asked, 'the intro finished by asking for a restart');
check(st.running, `the game is still running (${st.stopped ?? 'ok'})`);

const ego = named('ego'), user = named('User');
check(st.picture === 25,
  `it came back in room 25, the beach (picture ${st.picture})`);
check(p(user, 'canInput') === 1 && p(user, 'controls') === 1,
  `the player has control (canInput ${p(user, 'canInput')}, controls ${p(user, 'controls')})`);

/**
 * One press per direction and sixty cycles to walk it: SCI keeps the
 * heading until something changes it, so this is a press and a walk
 * rather than a key held down.
 */
const walk = (name: string, code: number, dx: number, dy: number, loop: number) => {
  const x0 = p(ego, 'x'), y0 = p(ego, 'y');
  s.key(code);
  for (let k = 0; k < 60; k++) { clock += 1000 / 60; st = s.tick(); }
  const x1 = p(ego, 'x'), y1 = p(ego, 'y');
  const moved = (dx ? Math.sign(x1 - x0) === dx : true) && (dy ? Math.sign(y1 - y0) === dy : true);
  check(moved && (x1 !== x0 || y1 !== y0),
    `${name}: Rosella walked ${x0},${y0} to ${x1},${y1}`);
  check(p(ego, 'loop') === loop,
    `${name}: she is facing it (loop ${p(ego, 'loop')}, wanted ${loop})`);
};
walk('right', 0x4D00, 1, 0, 0);
walk('up', 0x4800, 0, -1, 3);
walk('left', 0x4B00, -1, 0, 1);
walk('down', 0x5000, 0, 1, 2);

console.log(`\n${checked - failed}/${checked} restart checks passed`);
process.exit(failed ? 1 : 0);
