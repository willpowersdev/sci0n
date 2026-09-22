/** Differential test: every instruction of every code block must match. */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Script } from '../src/script.ts';
import { sweep } from '../src/disasm.ts';

import { ROOT } from './games.ts';
const fx = JSON.parse(readFileSync('fixtures/disasm.json', 'utf8'));

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

const u8 = (h: Hash, v: number) => h.update(Buffer.from([v & 0xFF]));
const u32 = (h: Hash, v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); h.update(b); };
const i32 = (h: Hash, v: number) => { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); h.update(b); };
const str0 = (h: Hash, s: string) => {
  h.update(Buffer.from(Array.from(s, c => c.charCodeAt(0) & 0xFF)));
  h.update(Buffer.from([0]));
};

function digest(s: Script) {
  const h = createHash('sha1');
  let blocks = 0, instrs = 0, clean = 0;
  for (const [name, off, size] of s.blocks) {
    if (name !== 'code') continue;
    const [ins, ok] = sweep(s.data, off + 4, off + size);
    blocks++; if (ok) clean++; instrs += ins.length;
    u32(h, off); u8(h, ok ? 1 : 0); u32(h, ins.length);
    for (const { pc, name: mnem, args } of ins) {
      u32(h, pc); str0(h, mnem); u8(h, args.length);
      for (const a of args) i32(h, a);
    }
  }
  return { hash: h.digest('hex').slice(0, 16), blocks, instrs, clean };
}

let bad = 0, allInstr = 0, allBlocks = 0, allClean = 0;
const problems: string[] = [];

for (const [name, data] of Object.entries<any>(fx)) {
  const g = new Game(nodeSource(join(ROOT, name)));
  let gameBad = 0;
  for (const [num, blocks, instrs, clean, hash] of data.scripts) {
    try {
      const s = new Script(g.data(2, num), num);
      const r = digest(s);
      if (r.blocks !== blocks || r.instrs !== instrs || r.clean !== clean) {
        gameBad++; problems.push(`${name} script.${num}: counts ${r.blocks}/${r.instrs}/${r.clean}`);
        continue;
      }
      if (r.hash !== hash) { gameBad++; problems.push(`${name} script.${num}: instruction stream`); }
    } catch (e: any) { gameBad++; problems.push(`${name} script.${num}: ${e.message}`); }
  }
  bad += gameBad; allInstr += data.instructions; allBlocks += data.blocks; allClean += data.clean;
  console.log(`${name.padEnd(9)} ${String(data.blocks).padStart(5)} blocks  ` +
    `${String(data.instructions).padStart(7)} instr  ` +
    `${gameBad === 0 ? 'all match' : gameBad + ' MISMATCH'}`);
}
console.log(`\n${allBlocks} code blocks (${allClean} clean sweeps), ` +
  `${allInstr} instructions compared, ${bad} mismatches`);
for (const p of problems.slice(0, 10)) console.log('   ' + p);
process.exit(bad ? 1 : 0);
