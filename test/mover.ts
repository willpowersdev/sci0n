/**
 * Walking from one place to another, and arriving.
 *
 * SCI moves an actor along a line it works out once: `InitBresen` fixes
 * a step for the dominant axis and an error term that says when the
 * other one is nudged, and `DoBresen` walks it.  The point of the error
 * term is that the last step lands on the target exactly, because that
 * is the only thing the script accepts: `Motion::doit` compares the
 * mover's x and y with its client's and calls `moveDone` only when both
 * agree, and asks for another step otherwise.
 *
 * This used to step straight at the target and, whenever a step was
 * refused, write the client's own position into the mover so the two
 * would agree and the walk would end.  That is a walk abandoned dressed
 * up as a walk finished, and it destroys the target on the way: a mover
 * that has been told where to go no longer knows.
 *
 * So two things are asked.  That the machine sets the line up at all --
 * the state lives on the mover, under names the games declare, and an
 * interpreter that keeps none of it leaves them zero.  And that a walk
 * ends with the actor on the spot it was sent to, not near it.
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
function check(ok: boolean, line: string) {
  checked++;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${line}`);
}

/**
 * KQ4's Tamir scene, where three fairies fly in to fixed places.
 *
 * SCI0 steers the ego with the keyboard, which sets a direction rather
 * than fitting a mover, so a walk with a destination is something the
 * scripts arrange -- and this is a scene that arranges three at once.
 */
{
  const dir = join(ROOT, 'KQ4');
  const g = new Game(nodeSource(dir));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };
  const vm = s.vm as any;

  let st = s.tick();
  for (let i = 0; i < 20_000 && st.running && st.picture !== 25; i++) st = step();
  checked++;
  if (st.picture !== 25) { failed++; console.log('  FAIL the scene with the movers is never reached'); }
  else {
    console.log('  ok   the scene with the movers is reached');
    // Catch them while they are still flying.
    const moving = new Map<any, { name: string; tx: number; ty: number; state: string }>();
    for (let i = 0; i < 400 && st.running; i++) {
      st = step();
      for (const v of vm.listValues(vm.cast)) {
        const o = vm.resolveTarget(null, v);
        if (!o || moving.has(o)) continue;
        const h = vm.prop(o, 'mover');
        if (!h) continue;
        const m = vm.resolveTarget(null, h);
        if (!m) continue;
        moving.set(o, {
          name: `${m.def?.name} for view ${vm.prop(o, 'view')}`,
          tx: vm.prop(m, 'x'), ty: vm.prop(m, 'y'),
          state: ['dx', 'dy', 'b-i1', 'b-i2', 'b-di', 'b-xAxis', 'b-incr']
            .map(n => `${n}=${vm.prop(m, n)}`).join(' '),
        });
      }
      if (moving.size >= 3) break;
    }
    check(moving.size >= 3, `${moving.size} actors are walking to somewhere`);
    for (const [, e] of moving) console.log(`         ${e.name} -> ${e.tx},${e.ty}  ${e.state}`);

    /**
     * The line has to be there.
     *
     * `b-incr` is which way the second axis is nudged and is 1 or -1;
     * `dx` and `dy` are the step.  An interpreter that works the step
     * out afresh each cycle, as this one used to, leaves every one of
     * them as the game left it -- zero.
     */
    const set = [...moving.values()].filter(e => !/b-incr=0(\s|$)/.test(e.state));
    check(set.length === moving.size,
      `all ${moving.size} have their line set up${set.length === moving.size ? '' : ' -- THE STATE IS NOT KEPT'}`);

    // And they arrive, which is the only thing the script accepts.
    let arrived = 0;
    for (let i = 0; i < 1200 && st.running; i++) {
      st = step();
      for (const [o, e] of moving) {
        if (vm.prop(o, 'mover')) continue;
        if (vm.prop(o, 'x') === e.tx && vm.prop(o, 'y') === e.ty) arrived++;
        moving.delete(o);
      }
      if (!moving.size) break;
    }
    check(arrived >= 2, `${arrived} of them land on the spot they were sent to`);
  }
}

console.log(`\n${checked - failed}/${checked} mover checks passed`);
process.exit(failed ? 1 : 0);
