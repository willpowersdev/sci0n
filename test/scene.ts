/**
 * Differential test for scene compositing and the init analysis.
 *
 * Every script that declares a room is rendered and digested: the pixels
 * of the composited room, then each placed sprite's name, view, loop,
 * cel, position, priority and the number of pixels it actually drew.
 * Sprite placement depends on the signed/unsigned split in the cel
 * displacements and on the priority test against the pic, so a digest
 * over the drawn-pixel counts catches a sprite that lands in the right
 * place but bleeds through scenery it should be behind.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Scene } from '../src/scene.ts';
import { ROOT } from './games.ts';

const fx = JSON.parse(readFileSync('fixtures/scene.json', 'utf8'));
function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}
const le16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xFFFF); return b; };
const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); return b; };

let bad = 0, allRooms = 0, allPlaced = 0;
for (const name of Object.keys(fx).sort()) {
  const want = fx[name];
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  const h = createHash('sha1');
  let rooms = 0, sprites = 0, placed = 0, sends = 0, unresolved = 0;
  for (const r of [...g.byType('script')].sort((a, b) => a.number - b.number)) {
    let sc: Scene;
    try { sc = new Scene(g, idx, r.number); } catch { continue; }
    rooms++;
    let rgb: Uint8Array;
    try { rgb = sc.render(); } catch { continue; }
    h.update(le16(r.number));
    h.update(createHash('sha1').update(Buffer.from(rgb)).digest());
    sprites += sc.sprites().length;
    placed += sc.placed.length;
    sends += sc.initStats.sends;
    unresolved += sc.initStats.unresolved;
    for (const p of sc.placed) {
      h.update(Buffer.from(Array.from(p.name, c => c.charCodeAt(0) & 0xFF)));
      h.update(Buffer.from([0]));
      for (const k of ['view', 'loop', 'cel', 'x', 'y', 'z', 'priority', 'pixels'] as const)
        h.update(i32(p[k] as number));
    }
  }
  const digest = h.digest('hex').slice(0, 16);
  const ok = digest === want.digest && rooms === want.rooms && placed === want.placed
          && sprites === want.sprites && sends === want.sends && unresolved === want.unresolved;
  if (!ok) bad++;
  allRooms += rooms; allPlaced += placed;
  console.log(`${name.padEnd(9)} ${String(rooms).padStart(3)} rooms · ${String(placed).padStart(4)} placed · ` +
    `${String(sends).padStart(5)} init sends · ` +
    (ok ? 'match' : `MISMATCH got ${digest}/${rooms}/${placed}/${sprites}/${sends}/${unresolved} ` +
      `want ${want.digest}/${want.rooms}/${want.placed}/${want.sprites}/${want.sends}/${want.unresolved}`));
}
console.log(`\n${allRooms} rooms composited, ${allPlaced} sprites placed, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
