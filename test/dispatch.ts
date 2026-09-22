/** Differential test for inheritance chains and method resolution. */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Script, Index } from '../src/script.ts';
import { SpeciesTable } from '../src/vm/heap.ts';

import { ROOT } from './games.ts';
const fx = JSON.parse(readFileSync('fixtures/dispatch.json', 'utf8'));
function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}
const u8 = (h: Hash, v: number) => h.update(Buffer.from([v & 0xFF]));
const u16 = (h: Hash, v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xFFFF); h.update(b); };

let bad = 0;
for (const [name, want] of Object.entries<any>(fx)) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  const table = new SpeciesTable(g, idx);
  const h = createHash('sha1');
  let nobj = 0, nmeth = 0, deepest = 0;

  for (const r of g.byType('script')) {
    let s: Script;
    try { s = new Script(g.data(2, r.number), r.number); } catch { continue; }
    for (const o of s.objects) {
      const ch = table.chain(o.species);
      const ms = table.resolveMethods(o);
      nobj++; nmeth += ms.size; deepest = Math.max(deepest, ch.length);
      u16(h, r.number); u16(h, o.species ?? 0); u8(h, ch.length); u8(h, o.isClass ? 1 : 0);
      for (const sp of ch) u16(h, sp);
      for (const sid of [...ms.keys()].sort((a, b) => a - b)) { u16(h, sid); u16(h, ms.get(sid)!); }
    }
  }
  const digest = h.digest('hex').slice(0, 16);
  const ok = table.size === want.species && nobj === want.objects &&
             nmeth === want.methods && deepest === want.deepest && digest === want.digest;
  if (!ok) {
    bad++;
    console.log(`${name.padEnd(9)} MISMATCH  species ${table.size}/${want.species} ` +
      `objects ${nobj}/${want.objects} methods ${nmeth}/${want.methods} ` +
      `deepest ${deepest}/${want.deepest} digest ${digest}/${want.digest}`);
  } else {
    console.log(`${name.padEnd(9)} ${String(want.species).padStart(3)} species  ` +
      `${String(want.objects).padStart(4)} objects  ` +
      `${String(want.methods).padStart(5)} resolved methods  all match`);
  }
}
console.log(`\n${bad} games with mismatches`);
process.exit(bad ? 1 : 0);
