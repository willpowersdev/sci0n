/**
 * Differential test for text resources against the Python reference.
 *
 * The digest is over raw bytes -- each resource number, its string count
 * and every string NUL-terminated -- so an off-by-one in the split, a
 * dropped empty entry or a latin-1 slip all show up as a mismatch.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { strings } from '../src/text.ts';

import { ROOT } from './games.ts';
const fx = JSON.parse(readFileSync('fixtures/text.json', 'utf8'));

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let bad = 0, totalRes = 0;
for (const name of Object.keys(fx).sort()) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const h = createHash('sha1');
  let res = 0, chars = 0;
  for (const r of [...g.byType('text')].sort((a, b) => a.number - b.number)) {
    let lines: string[];
    try { lines = strings(g.data(3, r.number)); } catch { continue; }
    res++;
    const n = Buffer.alloc(2); n.writeUInt16LE(r.number & 0xFFFF); h.update(n);
    const c = Buffer.alloc(4); c.writeUInt32LE(lines.length); h.update(c);
    for (const s of lines) {
      h.update(Buffer.from(Array.from(s, ch => ch.charCodeAt(0) & 0xFF)));
      h.update(Buffer.from([0]));
      chars += s.length;
    }
  }
  const digest = h.digest('hex').slice(0, 16);
  const want = fx[name];
  const ok = digest === want.digest && res === want.resources && chars === want.chars;
  if (!ok) bad++;
  totalRes += res;
  console.log(`${name.padEnd(9)} ${String(res).padStart(4)} resources  ` +
    `${String(chars).padStart(7)} chars  ${ok ? 'match' :
      `MISMATCH (got ${digest}/${res}/${chars}, want ${want.digest}/${want.resources}/${want.chars})`}`);
}
console.log(`\n${totalRes} text resources compared, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
