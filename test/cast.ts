/**
 * The animation cycle, end to end.
 *
 * An SCI0 game advances its puzzles through `cue`, which a cycler sends
 * when it finishes -- and a cycler only runs because `Animate` gives
 * every cast member `doit:` once per frame.  So "the cast is populated
 * and receiving doit:" is the property that decides whether the machine
 * is running a game or merely executing bytecode.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { PMachine } from '../src/vm/pmachine.ts';

import { ROOT } from './games.ts';
const games = process.argv.slice(2).length ? process.argv.slice(2)
            : ['SQ3', 'LSL2', 'KQ4', 'CAMELOT', 'COLONEL', 'ICE', 'HERO', 'QFG2'];
let live = 0;
for (const name of games) {
  const dir = join(ROOT, name);
  const files = readdirSync(dir);
  const g = new Game({ names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) });
  const idx = new Index(g);
  const vm = new PMachine(g, idx);
  const obj = vm.resolveTarget(null, vm.scriptID(0, 0));
  if (!obj) { console.log(`${name.padEnd(9)} no game object`); continue; }
  const sel = idx.selectorId('play');
  const f = sel < 0 ? null : vm.species.lookup(obj.def, sel, obj.scriptNo);
  if (!f) { console.log(`${name.padEnd(9)} ${obj.name} has no play`); continue; }
  const r = vm.run(f.script, vm.instantiate(0, obj.def), f.offset,
                   { steps: 2_000_000, deadline: Date.now() + 8000 });
  const st = vm.animateStats;
  if (st.doits > 0) live++;
  console.log(`${name.padEnd(9)} Animate ${String(st.calls).padStart(6)}` +
    `  doit: ${String(st.doits).padStart(7)}  cast ${String(st.max).padStart(3)}` +
    `  (${r.steps.toLocaleString()} instr, ${r.stopped})`);
  if (st.names.size)
    console.log(`          ${[...st.names].slice(0, 12).join(', ')}` +
                (st.names.size > 12 ? ` +${st.names.size - 12} more` : ''));
}
console.log(`\n${live}/${games.length} games reach a populated, animating cast`);
