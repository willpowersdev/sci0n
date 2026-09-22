/**
 * Attempt a real start-up: script 0's game object, then its `play`.
 * This is the measurement that matters -- calling methods cold, with
 * every global still zero, tells you nothing about whether the machine
 * can actually run a game.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Script, Index } from '../src/script.ts';
import { PMachine } from '../src/vm/pmachine.ts';

import { ROOT } from './games.ts';
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['SQ3', 'ICE']) {
  const dir = join(ROOT, name);
  const files = readdirSync(dir);
  const g = new Game({ names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) });
  const idx = new Index(g);
  const vm = new PMachine(g, idx);
  const s0 = new Script(g.data(2, 0), 0);

  // Export 0 of script 0 is the game object by convention.
  const ref = vm.scriptID(0, 0);
  const obj = vm.resolveTarget(null, ref);
  if (!obj) { console.log(`${name}: export 0 of script 0 is not an object`); continue; }
  const playSel = idx.selectorId('play');
  const initSel = idx.selectorId('init');
  let chosen: { name: string; off: number; script: number; sel: string } | null = null;
  for (const [sel, label] of [[playSel, 'play'], [initSel, 'init']] as const) {
    if (sel < 0) continue;
    const f = vm.species.lookup(obj.def, sel, obj.scriptNo);
    if (f !== null) { chosen = { name: obj.name, off: f.offset, script: f.script, sel: label }; break; }
  }
  if (!chosen) { console.log(`${name}: ${obj.name} answers to neither play nor init`); continue; }
  const def = obj.def;
  const t0 = Date.now();
  const r = vm.run(chosen.script, vm.instantiate(0, def), chosen.off,
                   { steps: 2_000_000, deadline: Date.now() + 5000 });
  const nonZero = [...vm.globals].filter(v => v !== 0).length;
  console.log(`\n=== ${name}: ${chosen.name}.${chosen.sel}()`);
  console.log(`   ${r.steps.toLocaleString()} instructions, stopped: ${r.stopped} ${r.detail ?? ''}` +
    `  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`   globals now non-zero: ${nonZero}  ·  depth ${r.maxDepth}  ·  unresolved sends ${r.unresolvedSends}`);
  const kern = [...r.kernelCalls].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([k, n]) => `${idx.kernelName(k)}×${n}`);
  console.log('   kernel: ' + (kern.join(', ') || 'none'));
}
