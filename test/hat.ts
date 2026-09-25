/**
 * Graham's hat, which was reported flying and standing still at once.
 *
 * The throw is shown in a vignette: a gold frame round a plain blue
 * sky, with the hat tumbling across it and nothing else drawn at all.
 * That makes it countable.  Every pixel in there that is not the
 * picture belongs to the hat, so the blobs of such pixels can be found
 * and counted, and there has to be exactly one of them.  Two is the
 * bug as the player described it -- "duplicated in the air".
 *
 * Read the honest status of this file before trusting it: the second
 * copy is gone now and the count below proves it is gone, but none of
 * the switches in this interpreter brings it back, so this check does
 * not fail on any fix being reverted.  It is not evidence that some
 * particular change cured it.  It pins behaviour that is currently
 * right so that it cannot go wrong again unnoticed, which is worth
 * having and is a weaker thing than the rest of the suite claims.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { WIDTH } from '../src/vm/screen.ts';
import { ROOT } from './games.ts';

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let failed = 0, checked = 0;
const check = (ok: boolean, msg: string) => {
  checked++; if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
};

const g = new Game(nodeSource(join(ROOT, 'KQ4')));
const idx = new Index(g);
const s = new Session(g, idx);
let clock = 0;
s.now = () => clock;

interface Machine {
  drawCast(h: number): void;
  listValues(h: number): number[];
  resolveTarget(a: null, v: number): object | null;
  prop(o: unknown, n: string): number;
  celOf(o: unknown): { width: number; height: number } | null;
}
const vm = s.vm as unknown as Machine;
const screen = s.screen as unknown as { visual: Uint8Array; bgVisual: Uint8Array };

/** True while the hat is the only thing the cast is drawing. */
let hatAlone = false;
const drawCast = vm.drawCast.bind(vm);
vm.drawCast = (h: number) => {
  drawCast(h);
  let hat = 0, others = 0;
  for (const v of vm.listValues(h)) {
    const o = vm.resolveTarget(null, v);
    if (!o || (vm.prop(o, 'signal') & 0x0008) || !vm.celOf(o)) continue;
    if (vm.prop(o, 'view') === 767) hat++; else others++;
  }
  hatAlone = hat > 0 && others === 0;
};

/** Blobs of anything that is not the picture, inside the vignette. */
const blobs = () => {
  const seen = new Uint8Array(WIDTH * 190);
  const out: Array<{ size: number; x: number; y: number }> = [];
  const ink = (i: number) => screen.visual[i] !== screen.bgVisual[i];
  for (let y = 20; y < 150; y++) for (let x = 20; x < 300; x++) {
    const i = y * WIDTH + x;
    if (seen[i] || !ink(i)) continue;
    let size = 0; const stack = [i]; seen[i] = 1;
    while (stack.length) {
      const p = stack.pop()!; size++;
      const px = p % WIDTH, py = (p / WIDTH) | 0;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
        const qx = px + dx, qy = py + dy;
        if (qx < 20 || qx >= 300 || qy < 20 || qy >= 150) continue;
        const q = qy * WIDTH + qx;
        if (seen[q] || !ink(q)) continue;
        seen[q] = 1; stack.push(q);
      }
    }
    // Small enough to be a stray pixel of dithering is not a hat.
    if (size >= 20) out.push({ size, x, y });
  }
  return out;
};

let st = s.tick();
let frames = 0, worst = { n: 0, frame: 0, at: '' };
for (let i = 0; i < 6200 && st.running; i++) {
  clock += 1000 / 60;
  st = s.tick();
  if (!hatAlone) continue;
  const b = blobs();
  if (!b.length) continue;
  frames++;
  if (b.length > worst.n)
    worst = { n: b.length, frame: i, at: b.map(o => `${o.size}px at ${o.x},${o.y}`).join(' and ') };
}

check(frames > 20, `the hat crosses the vignette alone (${frames} frames of it)`);
check(worst.n === 1,
  worst.n === 1
    ? `there is one hat on the screen in every one of those ${frames} frames`
    : `${worst.n} hats at frame ${worst.frame}: ${worst.at}`);

console.log(`\n${checked - failed}/${checked} hat checks passed`);
process.exit(failed ? 1 : 0);
