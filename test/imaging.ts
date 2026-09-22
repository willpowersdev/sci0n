/**
 * Differential test for the optional imaging passes.
 *
 * Cel undithering and MLAA both rewrite pixels, so the digests are over
 * the pixels themselves: every cel of forty views per game after
 * undithering, and a whole anti-aliased picture.  The dither histogram
 * is pooled over ten pics because the cross-check needs enough evidence
 * from the background before it will merge anything at all -- with one
 * pic most games merge nothing and the test would pass without ever
 * running the interesting path.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Picture, WIDTH, HEIGHT } from '../src/pic.ts';
import { View } from '../src/view.ts';
import { BLENDED_RGB } from '../src/ega.ts';
import { picHistogram, unditherView } from '../src/undither.ts';
import { mlaa } from '../src/aa.ts';
import { ROOT } from './games.ts';

const fx = JSON.parse(readFileSync('fixtures/imaging.json', 'utf8'));
function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}
const le32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };

let bad = 0, totalCels = 0, totalMerged = 0;
for (const name of Object.keys(fx).sort()) {
  const want = fx[name];
  const g = new Game(nodeSource(join(ROOT, name)));
  const pics = [...g.byType('pic')].sort((a, b) => a.number - b.number);
  const views = [...g.byType('view')].sort((a, b) => a.number - b.number);

  const hist = new Int32Array(256);
  for (const r of pics.slice(0, 10)) {
    let p: Picture;
    try { p = new Picture(g.data(1, r.number)); } catch { continue; }
    const h = picHistogram(p);
    for (let i = 0; i < 256; i++) hist[i] += h[i];
  }
  const hh = createHash('sha1');
  for (const v of hist) hh.update(le32(v));

  const uh = createHash('sha1');
  let merged = 0, cels = 0;
  for (const r of views.slice(0, 40)) {
    let v: View;
    try { v = new View(g.data(0, r.number)); } catch { continue; }
    merged += unditherView(v, hist);
    for (const loop of v.loops) for (const cel of loop) { cels++; uh.update(Buffer.from(cel.pixels)); }
  }

  const p0 = new Picture(g.data(1, pics[0].number));
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let i = 0; i < p0.visual.length; i++) {
    const c = BLENDED_RGB[p0.visual[i]];
    rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2];
  }
  const ah = createHash('sha1').update(Buffer.from(mlaa(rgb, WIDTH, HEIGHT)));

  const got = {
    hist: hh.digest('hex').slice(0, 16),
    und: uh.digest('hex').slice(0, 16),
    aa: ah.digest('hex').slice(0, 16),
  };
  const ok = got.hist === want.hist_digest && got.und === want.undither_digest
          && got.aa === want.mlaa_digest && merged === want.merged && cels === want.cels;
  if (!ok) bad++;
  totalCels += cels; totalMerged += merged;
  console.log(`${name.padEnd(9)} ${String(cels).padStart(4)} cels · ${String(merged).padStart(3)} merges · ` +
    (ok ? 'match' : `MISMATCH hist ${got.hist}/${want.hist_digest} ` +
                    `und ${got.und}/${want.undither_digest} aa ${got.aa}/${want.mlaa_digest} ` +
                    `merged ${merged}/${want.merged} cels ${cels}/${want.cels}`));
}
console.log(`\n${totalCels} cels undithered (${totalMerged} merges) and 8 pictures anti-aliased, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
