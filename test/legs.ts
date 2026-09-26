/**
 * She stops walking when she stops moving.
 *
 * Walk her into something and she should stand there, not tread the
 * spot.  The chain that does it is three links long and the last one
 * was broken.
 *
 * `Walk::doit` advances the walking cel only when `client.isStopped()`
 * is false.  `Act::isStopped` asks the mover `triedToMove()` first,
 * and answers "not stopped" out of hand when the mover says it did
 * not try; only when it did try does it compare the actor's position
 * with the one saved last cycle.  And `Motion::triedToMove` is exactly
 * `b-moveCnt == 0`.
 *
 * `b-moveCnt` belongs to the kernel in SCI0 -- ScummVM calls that
 * `kIncrementMoveCount`, which every SCI0 and SCI01 game gets.  It
 * counts up on each call to `DoBresen` and goes back to nought on the
 * cycle the step is actually taken, once it has passed the client's
 * `moveSpeed`.  Ours incremented and never reset, so `triedToMove` was
 * never true, `isStopped` never said stopped, and the legs went on
 * walking against every obstacle in the game for as long as the key
 * was held.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { ROOT } from './games.ts';

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n: string) => new Uint8Array(readFileSync(join(dir, n))) };
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
const step = (n: number) => { for (let i = 0; i < n; i++) { clock += 1000 / 60; st = s.tick(); } };

let st = s.tick();
for (let i = 0; i < 36000 && st.running; i++) { clock += 1000 / 60; st = s.tick(); }
for (let k = 0; k < 40 && st.picture === 25; k++) { s.key(0x4D00); step(30); }
check(st.picture === 26, `she is in the room with the trees (picture ${st.picture})`);

interface Machine { objects?: Map<number, unknown>; prop(o: unknown, n: string): number }
const vm = s.vm as unknown as Machine;
const ego = [...(vm.objects?.values() ?? [])]
  .find((o) => (o as { def?: { name?: string } })?.def?.name === 'ego');
const P = (n: string) => s16(vm.prop(ego, n));

// Across to below the trees at the top left, then straight up into them.
for (let k = 0; k < 14; k++) { s.key(0x4D00); step(12); }
for (let k = 0; k < 24; k++) { s.key(0x4800); step(6); }
const stuck = `${P('x')},${P('y')}`;
check((vm.prop(ego, 'signal') & 0x0400) !== 0,
  `she is up against them at ${stuck} and knows it (signal 0x${(vm.prop(ego, 'signal') >>> 0).toString(16)})`);

/** Hold the key the way a keyboard repeats it, and watch the cel. */
const cels: number[] = [];
for (let k = 0; k < 24; k++) {
  for (let r = 0; r < 2; r++) { s.key(0x4800); step(1); }
  cels.push(P('cel'));
}
check(`${P('x')},${P('y')}` === stuck, `she does not move while it is held (${P('x')},${P('y')})`);
const distinct = new Set(cels).size;
check(distinct === 1,
  distinct === 1
    ? `and stands still: cel ${cels[0]} for all ${cels.length} cycles`
    : `SHE IS STILL WALKING -- ${distinct} different cels: ${cels.join(',')}`);

/**
 * And the legs still work when there is somewhere to go.
 *
 * The held presses are let run out first.  A repeat is an ordinary
 * press, as it is in ScummVM, so what is queued is still owed and she
 * would go on trying to walk up into the trees while it drains.
 */
step(240);
const before = `${P('x')},${P('y')}`;
const moving: number[] = [];
for (let k = 0; k < 16; k++) { s.key(0x5000); step(6); moving.push(P('cel')); }
check(`${P('x')},${P('y')}` !== before,
  `she walks off again afterwards (${before} to ${P('x')},${P('y')})`);
check(new Set(moving).size > 1,
  `and her legs move while she does (${new Set(moving).size} cels)`);

console.log(`\n${checked - failed}/${checked} walk-cycle checks passed`);
process.exit(failed ? 1 : 0);
