/**
 * Differential test: the TypeScript reader must agree with the Python
 * reference on every resource of every game -- header fields, codec
 * choice, and a hash of the decompressed bytes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';

import { ROOT } from './games.ts';
const fixtures = JSON.parse(readFileSync('fixtures/resources.json', 'utf8'));

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return {
    names: () => files,
    read: (n: string) => new Uint8Array(readFileSync(join(dir, n))),
  };
}

const sha = (b: Uint8Array) =>
  createHash('sha1').update(b).digest('hex').slice(0, 16);

let games = 0, checked = 0, failed = 0;
const problems: string[] = [];

for (const [name, fx] of Object.entries<any>(fixtures)) {
  const t0 = Date.now();
  const g = new Game(nodeSource(join(ROOT, name)));
  let bad = 0;

  for (const [wantCodecMethod, wantCodec] of Object.entries<string>(fx.codecs)) {
    const got = g.codecFor(Number(wantCodecMethod));
    if (got !== wantCodec) {
      bad++; problems.push(`${name}: method ${wantCodecMethod} codec ${got} != ${wantCodec}`);
    }
  }

  for (const [type, num, vol, off, comp, dec, meth, hash] of fx.resources) {
    checked++;
    const r = g.resources.get(Game.key(type, num));
    if (!r) { bad++; problems.push(`${name}: missing ${type}.${num}`); continue; }
    try {
      g.header(r);
      if (r.volume !== vol || r.offset !== off || r.compSize !== comp ||
          r.decompSize !== dec || r.method !== meth) {
        bad++; problems.push(`${name} ${type}.${num}: header mismatch`); continue;
      }
      const d = g.data(type, num);
      if (d.length !== dec) {
        bad++; problems.push(`${name} ${type}.${num}: length ${d.length} != ${dec}`); continue;
      }
      if (sha(d) !== hash) {
        bad++; problems.push(`${name} ${type}.${num}: hash mismatch`);
      }
    } catch (e: any) {
      bad++; problems.push(`${name} ${type}.${num}: ${e.message}`);
    }
  }
  failed += bad; games++;
  console.log(`${name.padEnd(9)} ${String(fx.count).padStart(4)} resources  ` +
    `${bad === 0 ? 'all match' : bad + ' MISMATCH'}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

console.log(`\n${games} games, ${checked} resources compared, ${failed} mismatches`);
for (const p of problems.slice(0, 10)) console.log('   ' + p);
process.exit(failed ? 1 : 0);
