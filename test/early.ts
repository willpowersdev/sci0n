/**
 * King's Quest 4, which is built differently from the rest.
 *
 * It is the one early-SCI0 game here, and three things in it are not
 * what the later games do.  Each was enough on its own to stop the game
 * dead at its copy-protection prompt, on a black screen with a white
 * band across the top and nothing that could be typed or dismissed.
 *
 *   - Selectors are stored doubled -- twice the table index, so always
 *     even -- and a send that reads or writes a property arrives with
 *     bit 0 set.  Matched literally, every property send in the game
 *     found nothing and gave back zero.  `Dialog::setSize` asks each of
 *     its items for `nsLeft` and `nsTop`, was told nought by all of
 *     them, and opened a window four pixels square.
 *
 *   - `&rest` belongs to the send it was compiled for, and this game's
 *     `Collect::firstTrue` calls `NodeValue` in between.  Counting the
 *     rest towards that kernel call took the send's own arguments away
 *     with it, so the dialog never found the field to type into.
 *
 *   - The game names 97 kernels and calls 102.  The numbering is the
 *     interpreter's, not the game's, and 102 is `StrAt` -- which is how
 *     `copyProtect` reads the answer back.  Dispatched by a name the
 *     game had not got, it did nothing, and the comparison never came
 *     to an answer either way.
 *
 * What is checked is the prompt a player sees: that it is a dialog
 * rather than a sliver, that the words are on the screen, that typing
 * reaches the field, and that answering gets a reply.  The three
 * mechanisms are checked separately as well, because a whole-game test
 * says where it hurts but not where it is.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { ROOT } from './games.ts';

const TRIMMED = join(import.meta.dirname, '..', 'games');
const shipped = existsSync(join(TRIMMED, 'games.json'));
const dirOf = (trimmed: string, original: string) =>
  shipped ? join(TRIMMED, trimmed) : join(ROOT, original);

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let failed = 0, checked = 0;
function check(ok: boolean, line: string) {
  checked++;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${line}`);
}

console.log('how the game is built');
{
  const kq4 = new Index(new Game(nodeSource(dirOf('kq4sci', 'KQ4'))));
  const late = new Index(new Game(nodeSource(dirOf('camelot', 'CAMELOT'))));
  check(kq4.selectorShift === 1, `KQ4 stores selectors doubled (shift ${kq4.selectorShift})`);
  check(late.selectorShift === 0, `Camelot does not (shift ${late.selectorShift})`);

  // The game's own table stops short of the kernel its scripts call.
  check(kq4.kernel.length <= 102, `KQ4 names ${kq4.kernel.length} kernels`);
  check(kq4.kernelName(102) === 'StrAt', `and 102 is still read as "${kq4.kernelName(102)}"`);
  check(late.kernelName(102) === 'StrAt', `Camelot names it itself: "${late.kernelName(102)}"`);
  // A game that names a kernel keeps its own name for it.
  check(kq4.kernelName(0) === 'Load', `a named kernel is left alone ("${kq4.kernelName(0)}")`);
}

console.log('\nthe prompt the game would have shown');
/**
 * Read with the patch table switched off, so this is KQ4 as Sierra
 * shipped it: the copy-protection prompt, which the three fixes above
 * are what make workable at all.  It is bypassed in play -- see
 * src/patches.ts for why -- and that bypass would hide every one of
 * them, so the fault each was for is reached here directly.
 */
{
  const g = new Game(nodeSource(dirOf('kq4sci', 'KQ4')));
  const idx = new Index(g, { patch: false });
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };

  const vm = s.vm as unknown as {
    kernel: (id: number, a: number[], f: unknown) => number;
    resolveTarget: (f: unknown, v: number) => { scriptNo: number } | null;
    prop: (o: unknown, name: string) => number;
    stringAt: (v: number, script?: number) => string;
  };
  const newWindow = idx.kernel.indexOf('NewWindow');
  const drawControl = idx.kernel.indexOf('DrawControl');
  let win: number[] | null = null;
  let edit: { scriptNo: number } | null = null;
  const kernel = vm.kernel.bind(vm);
  vm.kernel = (id: number, a: number[], f: unknown) => {
    if (id === newWindow && !win) win = a.slice(0, 4);
    if (id === drawControl) {
      const o = vm.resolveTarget(null, a[0]);
      if (o && vm.prop(o, 'max') > 0) edit = o;   // only a field has a limit
    }
    return kernel(id, a, f);
  };

  let st = s.tick();
  for (let i = 0; i < 400 && st.running; i++) st = step();

  /**
   * The window is sized from its items, each asked for its own
   * rectangle.  Told nought by all of them it comes out four pixels
   * square, with the question painted outside it: a black screen with
   * a white band across the top, which is what this looked like.
   */
  checked++;
  if (!win) { failed++; console.log('  FAIL no window was opened at all'); }
  else {
    const [top, left, bottom, right] = win as number[];
    const w = right - left, h = bottom - top;
    const roomy = w >= 200 && h >= 30;
    if (!roomy) failed++;
    console.log(`  ${roomy ? 'ok  ' : 'FAIL'} it opens ${w}x${h}` +
      `${roomy ? '' : ' -- TOO SMALL TO HOLD THE QUESTION'}`);
  }

  const field = edit as { scriptNo: number } | null;
  check(field !== null, 'it has a field to type into');
  if (field) {
    // Reaching the field means the dialog found it, which it does by
    // asking each item in turn -- the `&rest` that a kernel call in
    // between must not eat.
    const read = () => vm.stringAt(vm.prop(field, 'text'), field.scriptNo);
    for (const ch of 'unicorn') { s.key(ch.charCodeAt(0)); for (let i = 0; i < 20; i++) st = step(); }
    check(read() === 'unicorn', `typing reaches it -- it holds "${read()}"`);

    // Answering compares character by character with `StrAt`, the
    // kernel this game calls but does not name.  Without it the
    // comparison cannot even be wrong: it simply never finishes.
    const before = st.instructions;
    s.key(13);
    for (let i = 0; i < 1500 && st.running; i++) st = step();
    const worked = st.instructions - before;
    check(worked > 1_000_000, `answering costs ${(worked / 1e6).toFixed(0)}M instructions of work`);
  }
}

console.log('\nthe game it runs instead');
{
  const g = new Game(nodeSource(dirOf('kq4sci', 'KQ4')));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };

  /**
   * A cheap signature of the screen, to tell a picture from a freeze.
   */
  const shot = () => {
    let h = 0;
    const v = s.screen.visual;
    for (let i = 0; i < v.length; i += 7) h = (h * 31 + v[i]) | 0;
    return h;
  };

  let st = s.tick();
  const pics = new Set<number>();
  const screens = new Set<number>();
  for (let i = 0; i < 4000 && st.running; i++) {
    st = step();
    if (st.picture >= 0) pics.add(st.picture);
    if (i % 400 === 0) screens.add(shot());
  }

  // 991 is the blank black backdrop the copy-protection room draws, and
  // for a long time it was the only picture this game ever managed.
  const real = [...pics].filter(p => p !== 991);
  check(real.length > 0, `it draws ${real.length ? `picture ${real.join(', ')}` : 'nothing but the blank backdrop'}`);

  /**
   * Is it a scene, or a screen with a box on it?
   *
   * Counted in colours rather than in pixels: the broken build filled
   * a dialog with white on black and could pass a test that only asked
   * how much had been painted.  A drawn room uses the palette.
   */
  const used = new Set(s.screen.visual);
  check(used.size >= 8, `${used.size} colours are on the screen`);

  check(screens.size >= 5, `${screens.size} of 10 sampled frames differ -- it is moving`);
  check(st.running, 'and it is still running');

  /**
   * The work is the tell.
   *
   * Every property send in this game came back zero when the low bit
   * was not masked off, which does not stop the machine -- it stops
   * the game, quietly, while the interpreter goes on being busy about
   * nothing.  A game that is actually playing gets through millions of
   * instructions in four thousand frames.
   */
  check(st.instructions > 500_000, `${(st.instructions / 1000).toFixed(0)}k instructions of it`);
}

console.log(`\n${checked - failed}/${checked} early-SCI0 checks passed`);
process.exit(failed ? 1 : 0);
