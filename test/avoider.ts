/**
 * The avoider, which is what actually drives an actor's mover.
 *
 * `Act::doit` reads the actor's `avoider` and, when there is one,
 * calls that and jumps straight past the branch that would otherwise
 * have called the mover.  So an actor with an avoider moves only if
 * `DoAvoider` ticks the mover on its behalf.  The kernel was named in
 * the table and never implemented, so it answered zero.
 *
 * King's Quest IV's unicorn is the case that shows it.  Walk towards
 * it and it is given a `MoveTo` aimed at x 350 -- off the right edge,
 * which is what bolting means -- and then it galloped on the spot for
 * ever: `Act::doit` ran a hundred and seventy times and `DoBresen`
 * exactly once, because `Avoid::doit`'s first instruction is the call
 * to this kernel and everything it does afterwards depends on the
 * answer.
 *
 * So the check is the thing a player would see: approach it, and the
 * unicorn has to cross the screen and leave it.
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

// Through the intro and the restart, into the game.
let st = s.tick();
for (let i = 0; i < 36000 && st.running; i++) { clock += 1000 / 60; st = s.tick(); }

interface Machine {
  drawCast(h: number): void;
  listValues(h: number): number[];
  resolveTarget(a: null, v: number): object | null;
  prop(o: unknown, n: string): number;
  callMethod(o: unknown, name: string, params?: number[]): number;
  globals: Int32Array;
}
const vm = s.vm as unknown as Machine;

/**
 * Which room the unicorn is in, which the game decides by tossing a
 * die.  `regUnicorn::init` draws `Random(1, 3)` the first time one of
 * its rooms is entered and keeps the answer in global 124 -- so the
 * unicorn is in one of three, and a test that always walked east was
 * passing on the draw rather than on the code.  It moved the moment
 * anything else shifted the random sequence along.
 *
 * The die is settled here before it is thrown, so this measures the
 * avoider rather than the draw: 26 is the room east of the beach.
 */
const room = 26;
vm.globals[124] = room;
for (let k = 0; k < 40 && st.picture === 25; k++) { s.key(0x4D00); step(30); }
check(s16(vm.globals[124]) === room,
  `the unicorn is put in room ${room} rather than left to the dice`);
check(st.picture === room, `and that room is open (picture ${st.picture})`);

/** Where the unicorn is, cycle by cycle, and whether it is still here. */
const seen: string[] = [];
let ever = false;
const drawCast = vm.drawCast.bind(vm);
vm.drawCast = (h: number) => {
  drawCast(h);
  let at = '';
  for (const v of vm.listValues(h)) {
    const o = vm.resolveTarget(null, v);
    try {
      if (o && vm.prop(o, 'view') === 383) {
        ever = true;
        at = `${s16(vm.prop(o, 'x'))},${s16(vm.prop(o, 'y'))}`;
      }
    } catch { /* no view selector */ }
  }
  const t = at || (ever ? 'gone' : '');
  if (t && seen[seen.length - 1] !== t) seen.push(t);
};

for (let k = 0; k < 60 && st.picture === room; k++) { s.key(0x4D00); step(20); }

check(ever, `the unicorn is in room ${room}`);
const places = seen.filter(t => t !== 'gone');
const xs = places.map(t => Number(t.split(',')[0]));
const from = xs[0] ?? 0, to = xs[xs.length - 1] ?? 0;
check(places.length > 8,
  `it moves through ${places.length} places, not one (${places[0]} to ${places[places.length - 1]})`);
check(to - from > 80, `it crosses the room, ${from} to ${to} in x`);
check(to >= 320 || seen[seen.length - 1] === 'gone',
  seen[seen.length - 1] === 'gone'
    ? `and leaves: last seen at ${places[places.length - 1]}, then out of the cast`
    : `IT NEVER LEAVES -- last at ${places[places.length - 1]}`);

console.log(`\n${checked - failed}/${checked} avoider checks passed`);
process.exit(failed ? 1 : 0);
