/**
 * Differential test for the graphics layer: every view cel and every pic
 * plane must hash identically to the Python reference.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { View } from '../src/view.ts';
import { Picture } from '../src/pic.ts';

import { ROOT } from './games.ts';
const fx = JSON.parse(readFileSync('fixtures/graphics.json', 'utf8'));
const sha = (b: Uint8Array) =>
  createHash('sha1').update(Buffer.from(b)).digest('hex').slice(0, 16);

/**
 * Digest a view from raw bytes only: fixed-width little-endian fields
 * followed by the pixel data.  Nothing here depends on how a language
 * formats an integer or joins a separator, so the Python reference and
 * this implementation agree by construction rather than by convention.
 */
function viewDigest(v: View): string {
  const h = createHash('sha1');
  for (const c of v.allCels()) {
    const head = new Uint8Array(7);
    const dv = new DataView(head.buffer);
    dv.setInt16(0, c.width, true);
    dv.setInt16(2, c.height, true);
    dv.setInt8(4, c.xShift);
    dv.setInt8(5, c.yShift);
    dv.setUint8(6, c.key);
    h.update(Buffer.from(head));
    h.update(Buffer.from(c.pixels));
  }
  return h.digest('hex').slice(0, 16);
}

/** Structural comparison, so no JSON text encoding sits in the path. */
const sameInts = (a: number[] | null, b: number[] | null) =>
  a === null || b === null ? a === b
    : a.length === b.length && a.every((v, i) => v === b[i]);

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let views = 0, pics = 0, bad = 0;
const problems: string[] = [];

for (const [name, data] of Object.entries<any>(fx)) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const t0 = Date.now();
  let gameBad = 0;

  for (const [num, loopCount, mirrorMask, celCounts, hash] of data.views) {
    views++;
    try {
      const v = new View(g.data(0, num));
      if (v.loopCount !== loopCount || v.mirrorMask !== mirrorMask ||
          !sameInts(v.loops.map(l => l.length), celCounts)) {
        gameBad++; problems.push(`${name} view.${num}: structure`); continue;
      }
      if (viewDigest(v) !== hash) { gameBad++; problems.push(`${name} view.${num}: cel pixels`); }
    } catch (e: any) { gameBad++; problems.push(`${name} view.${num}: ${e.message}`); }
  }

  for (const [num, ops, hv, hp, hc, bands] of data.pics) {
    pics++;
    try {
      const p = new Picture(g.data(1, num));
      if (p.ops !== ops) { gameBad++; problems.push(`${name} pic.${num}: ops ${p.ops}!=${ops}`); continue; }
      if (sha(p.visual) !== hv) { gameBad++; problems.push(`${name} pic.${num}: VISUAL plane`); continue; }
      if (sha(p.priority) !== hp) { gameBad++; problems.push(`${name} pic.${num}: priority plane`); continue; }
      if (sha(p.control) !== hc) { gameBad++; problems.push(`${name} pic.${num}: control plane`); continue; }
      if (!sameInts(p.priorityBands, bands)) {
        gameBad++; problems.push(`${name} pic.${num}: priority bands`);
      }
    } catch (e: any) { gameBad++; problems.push(`${name} pic.${num}: ${e.message}`); }
  }

  bad += gameBad;
  console.log(`${name.padEnd(9)} ${String(data.views.length).padStart(4)} views  ` +
    `${String(data.pics.length).padStart(4)} pics  ` +
    `${gameBad === 0 ? 'all match' : gameBad + ' MISMATCH'}  ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

console.log(`\n${views} views + ${pics} pics compared, ${bad} mismatches`);
for (const p of problems.slice(0, 12)) console.log('   ' + p);
process.exit(bad ? 1 : 0);
