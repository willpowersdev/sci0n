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

console.log('\nthe copy-protection prompt');
{
  const g = new Game(nodeSource(dirOf('kq4sci', 'KQ4')));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };

  // biome-ignore-start: reaching into the VM to watch what the scripts ask for
  const vm = s.vm as unknown as {
    kernel: (id: number, a: number[], f: unknown) => number;
    resolveTarget: (f: unknown, v: number) => { scriptNo: number } | null;
    prop: (o: unknown, name: string) => number;
    stringAt: (v: number, script?: number) => string;
  };
  // biome-ignore-end: ---
  const newWindow = idx.kernel.indexOf('NewWindow');
  const drawControl = idx.kernel.indexOf('DrawControl');
  let win: number[] | null = null;
  let edit: { scriptNo: number } | null = null;
  const kernel = vm.kernel.bind(vm);
  vm.kernel = (id: number, a: number[], f: unknown) => {
    if (id === newWindow && !win) win = a.slice(0, 4);
    if (id === drawControl) {
      const o = vm.resolveTarget(null, a[0]);
      // Only the editable field has a character limit.
      if (o && vm.prop(o, 'max') > 0) edit = o;
    }
    return kernel(id, a, f);
  };

  let st = s.tick();
  for (let i = 0; i < 400 && st.running; i++) st = step();

  checked++;
  if (!win) { failed++; console.log('  FAIL no window was opened at all'); }
  else {
    const [top, left, bottom, right] = win as number[];
    const w = right - left, h = bottom - top;
    // The question is 267 pixels of text; a window that does not hold
    // it is the four-pixel sliver, whatever else may be wrong.
    const roomy = w >= 200 && h >= 30;
    if (!roomy) failed++;
    console.log(`  ${roomy ? 'ok  ' : 'FAIL'} the window is ${w}x${h}` +
      `${roomy ? '' : ' -- TOO SMALL TO HOLD THE QUESTION'}`);
  }

  /**
   * Is it actually on the screen?
   *
   * The dialog is painted white on a black picture, so counting white
   * says how much of it got drawn without having to match glyphs: the
   * broken window covered about 1400 pixels, a real one covers ten
   * times that.  White is 0xFF here because the visual plane holds
   * dither pairs and white is 15 in both nibbles.
   */
  let white = 0;
  for (const c of s.screen.visual) if (c === 0xFF) white++;
  check(white > 10_000, `${white} pixels of it are painted`);

  const field = edit as { scriptNo: number } | null;
  check(field !== null, 'it has a field to type into');
  if (field) {
    const read = () => vm.stringAt(vm.prop(field, 'text'), field.scriptNo);
    for (const ch of 'unicorn') { s.key(ch.charCodeAt(0)); for (let i = 0; i < 20; i++) st = step(); }
    check(read() === 'unicorn', `typing reaches it -- it holds "${read()}"`);

    /**
     * Does answering get an answer?
     *
     * `copyProtect` compares what was typed a character at a time, so
     * a comparison that cannot read a character does not merely get
     * the wrong result -- it gets none, and the game sits there.  The
     * test is that the machine does a day's work on the answer rather
     * than idling: the broken build managed about three instructions
     * a frame, and a real comparison runs into the millions.
     */
    const before = st.instructions;
    s.key(13);
    for (let i = 0; i < 1500 && st.running; i++) st = step();
    const worked = st.instructions - before;
    check(worked > 1_000_000, `answering it costs ${(worked / 1e6).toFixed(0)}M instructions of work`);
    check(st.running, 'and the game is still running afterwards');
  }
}

console.log(`\n${checked - failed}/${checked} early-SCI0 checks passed`);
process.exit(failed ? 1 : 0);
