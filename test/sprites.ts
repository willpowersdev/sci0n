/**
 * Dither blending for views, not just for pictures.
 *
 * A picture's visual plane stores the dither *pair* per pixel, so
 * blending it is a decision the renderer makes and nothing has to be
 * detected.  A view cel is not like that: every pixel is one 4-bit
 * colour index, and where the artist faked a colour the EGA did not
 * have, the chequerboard is all there is.  So blended backgrounds with
 * untouched cels put dithered sprites in front of smooth scenery.
 *
 * Merging a cel needs the pattern found and then cross-checked against
 * the background the cel will be drawn over -- a combination is merged
 * only where the picture dithered with it too, which is what keeps
 * deliberate chequerboard texture from being eaten.  That means the
 * answer depends on the room, and on the setting, either of which can
 * change under a view that is already loaded and cached.
 *
 * So what is checked here is the live path through the interpreter:
 * that cels really are merged while the setting is on, that none are
 * while it is off, and -- the part that is easy to get wrong, because
 * merging rewrites a cel in place -- that turning it off gives back
 * exactly the bytes the resource had.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { View } from '../src/view.ts';
import { Session } from '../src/vm/session.ts';
import { ROOT } from './games.ts';

const ENTER = 0x0D;
/** Long enough to be in a room with a background drawn. */
const BOOT = 14_000;

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

/**
 * A merged pixel holds a pair byte, an untouched one a colour index.
 *
 * The two are told apart by range, not by the nibbles: an index of 3
 * has unequal nibbles as surely as the pair 0x31 does.  Merging keeps
 * its results at 0x10 and above precisely so this stays decidable,
 * swapping the nibbles when the high one would be zero.
 */
const blendedPixels = (v: View) => {
  let n = 0;
  for (const loop of v.loops)
    for (const cel of loop)
      for (const p of cel.pixels) if (p >= 0x10) n++;
  return n;
};

let failed = 0, checked = 0;
for (const name of ['SQ3', 'CAMELOT']) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };
  const vm = s.vm as any;

  let st = s.tick();
  for (let i = 0; i < BOOT && st.running; i++) { if (i % 120 === 0) s.key(ENTER); st = step(); }
  console.log(`\n=== ${name} ===`);

  const numbers = g.byType('view').map(r => r.number);
  /** Load every view the game has, and count the cels that came back merged. */
  const sweep = () => {
    let views = 0, pixels = 0;
    for (const n of numbers) {
      const v = vm.view(n) as View | null;
      if (!v) continue;
      const p = blendedPixels(v);
      if (p) { views++; pixels += p; }
    }
    return { views, pixels };
  };

  s.screen.undither = true;
  const on = sweep();
  checked++;
  if (!on.views) failed++;
  console.log(`  ${on.views ? 'ok  ' : 'FAIL'} blending on: ${on.views} of ${numbers.length} views merged` +
    ` (${on.pixels} pixels)${on.views ? '' : ' -- NOTHING WAS MERGED'}`);

  s.screen.undither = false;
  const off = sweep();
  checked++;
  if (off.views) failed++;
  console.log(`  ${off.views ? 'FAIL' : 'ok  '} blending off: ${off.views} views merged` +
    `${off.views ? ' -- CELS WERE MERGED WITH THE SETTING OFF' : ''}`);

  /**
   * Turning it off has to give back the resource, byte for byte.
   *
   * Merging rewrites a cel's pixels where they sit, so the only way
   * back is a pristine copy kept aside.  A cel that came back subtly
   * wrong would show as a sprite that degrades every time the setting
   * is touched, which no screenshot of a single frame would catch.
   */
  let restored = 0, wrong: string[] = [];
  for (const n of numbers) {
    const live = vm.view(n) as View | null;
    const d = g.tryData('view', n);
    if (!live || !d) continue;
    let fresh: View;
    try { fresh = new View(d); } catch { continue; }
    for (let li = 0; li < live.loops.length; li++)
      for (let ci = 0; ci < live.loops[li].length; ci++) {
        const a = live.loops[li][ci].pixels, b = fresh.loops[li]?.[ci]?.pixels;
        if (!b) continue;
        restored++;
        if (a.length !== b.length || !a.every((x, i) => x === b[i])) wrong.push(`${n}/${li}/${ci}`);
      }
  }
  checked++;
  if (wrong.length) failed++;
  console.log(`  ${wrong.length ? 'FAIL' : 'ok  '} ${restored} cels came back exactly as the resource has them` +
    `${wrong.length ? ` -- ${wrong.length} DIFFER, e.g. ${wrong.slice(0, 4).join(' ')}` : ''}`);

  // And on again, to show the round trip is stable rather than merely
  // destructive in one direction.
  s.screen.undither = true;
  const again = sweep();
  checked++;
  const same = again.views === on.views && again.pixels === on.pixels;
  if (!same) failed++;
  console.log(`  ${same ? 'ok  ' : 'FAIL'} turning it back on merges the same ${again.views} views` +
    `${same ? '' : ` -- WAS ${on.views}/${on.pixels}, NOW ${again.views}/${again.pixels}`}`);
}

console.log(`\n${checked - failed}/${checked} sprite-blending checks passed`);
process.exit(failed ? 1 : 0);
