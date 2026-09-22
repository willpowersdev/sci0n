/**
 * Exercise harness for the PMachine: run every method of every object
 * and report where execution stops.  Not a differential test -- there is
 * no reference to diff against for execution -- so this measures reach
 * and surfaces what is still missing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Script, Index } from '../src/script.ts';
import { PMachine } from '../src/vm/pmachine.ts';

import { ROOT } from './games.ts';
const GAMES = process.argv[2] ? [process.argv[2]] : ['SQ3', 'ICE', 'QFG2'];
function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

for (const name of GAMES) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  const stops = new Map<string, number>();
  const kernels = new Map<number, number>();
  const unimpl = new Map<string, number>();
  let methods = 0, steps = 0, unresolved = 0, maxDepth = 0, maxStack = 0;
  const kinds = new Map<string, number>();
  const t0 = Date.now();

  for (const r of g.byType('script')) {
    let s: Script;
    try { s = new Script(g.data(2, r.number), r.number); } catch { continue; }
    const vm = new PMachine(g, idx);
    for (const def of s.objects) {
      const obj = vm.instantiate(r.number, def);
      for (const [, off] of def.methods) {
        methods++;
        const res = vm.run(r.number, obj, off, { steps: 4000, deadline: Date.now() + 20 });
        steps += res.steps;
        unresolved += res.unresolvedSends;
        maxDepth = Math.max(maxDepth, res.maxDepth);
        maxStack = Math.max(maxStack, res.maxStack);
        const key = res.stopped === 'unimplemented' ? `unimplemented:${res.detail}` : res.stopped;
        stops.set(key, (stops.get(key) ?? 0) + 1);
        if (res.stopped === 'unimplemented')
          unimpl.set(res.detail!, (unimpl.get(res.detail!) ?? 0) + 1);
        for (const [k, n] of res.kernelCalls) kernels.set(k, (kernels.get(k) ?? 0) + n);
        for (const [k, n] of res.unresolvedKind) kinds.set(k, (kinds.get(k) ?? 0) + n);
      }
    }
  }

  console.log(`\n=== ${name}: ${methods} methods, ${steps.toLocaleString()} instructions ` +
    `in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('   stop reasons:');
  for (const [k, n] of [...stops].sort((a, b) => b[1] - a[1]))
    console.log(`      ${String(n).padStart(5)}  ${k}`);
  console.log(`   max frame depth ${maxDepth}, max stack ${maxStack}, unresolved sends ${unresolved}`);
  console.log('   why sends fail:');
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]))
    console.log(`      ${String(n).padStart(6)}  ${k}`);
  const top = [...kernels].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, n]) => `${idx.kernelName(k)}×${n}`);
  console.log('   kernel calls: ' + (top.join(', ') || 'none'));
}
