/**
 * Wading, which is a view swap driven by a region.
 *
 * Not priority: King's Quest IV's creek has none painted over it, and
 * a background priority of 0 can never hide a sprite.  What happens is
 * that room 26 calls `setRegions(501, 512, 506, 518)`, and script 501's
 * `water::doit` asks `gEgo.onControl(1)` every cycle and switches her
 * view by the control colour it gets back: mask 1 -- ordinary ground --
 * is view 2, and the water colours are wading views.  Two depths,
 * which is what a player sees walking into the creek.
 *
 * None of it ran.  `setRegions` only calls a region's `init` when it is
 * not already `initialized`, and `init` is what puts the region into
 * the list the game cycles.  In SCI the answer is fresh every room
 * because leaving one calls `DisposeScript` and the next `ScriptID`
 * loads it again with the property values the resource carries.
 * `DisposeScript` was a no-op here, so `waterReg` stayed initialized
 * from the first room that used it and was never added again.  Rosella
 * walked on top of the creek.
 *
 * So the check walks her in and out and looks at the view.  It also
 * looks at the locals, because the region keeps the last ground it saw
 * in one of them: unloading a script has to give it its locals back as
 * well as its objects, and dropping only the objects left the region
 * comparing the accumulator with itself and deciding nothing had
 * changed.
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
check(st.picture === 26, `she is in the room with the creek (picture ${st.picture})`);

interface Machine {
  objects?: Map<number, unknown>;
  prop(o: unknown, n: string): number;
  localsOf(n: number): Int32Array;
  resolveTarget(a: null, v: number): unknown;
  listValues(h: number): number[];
  globals: Int32Array | number[];
}
const vm = s.vm as unknown as Machine;
const ego = [...(vm.objects?.values() ?? [])]
  .find((o) => (o as { def?: { name?: string } })?.def?.name === 'ego');

// The region has to be in the list the game cycles, or nothing asks.
const regions = vm.resolveTarget(null, vm.globals[6] as number);
const inList: string[] = [];
for (const v of vm.listValues(vm.prop(regions, 'elements')))
  inList.push(String((vm.resolveTarget(null, v) as { scriptNo?: number })?.scriptNo));
check(inList.includes('501'),
  `the water region is among the room's regions (${inList.join(' ')})`);
check(vm.localsOf(501).length >= 2,
  `and it has its locals back (${vm.localsOf(501).length})`);

/** Her view at each step of the crossing. */
const views: Array<[number, number]> = [];
for (let k = 0; k < 45 && st.picture === 26; k++) {
  s.key(0x4D00);
  step(20);
  views.push([s16(vm.prop(ego, 'x')), s16(vm.prop(ego, 'view'))]);
}

const dry = views.filter(([, v]) => v === 2);
const wet = views.filter(([, v]) => v !== 2);
check(dry.length > 4, `she walks on the grass as view 2 (${dry.length} of ${views.length} steps)`);
check(wet.length > 2,
  wet.length > 2
    ? `and changes view in the water: ${[...new Set(wet.map(([, v]) => v))].sort().map(v => `view ${v}`).join(', ')}` +
      ` between x ${wet[0][0]} and ${wet[wet.length - 1][0]}`
    : 'SHE WALKS ON THE WATER -- the view never changes');
// And comes out again, or it would be a one-way swap rather than the ground.
const last = views[views.length - 1];
check(last[1] === 2, `she is back to view 2 on the far side (x ${last[0]}, view ${last[1]})`);

console.log(`\n${checked - failed}/${checked} wading checks passed`);
process.exit(failed ? 1 : 0);
