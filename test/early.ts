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
import { Picture, WIDTH } from '../src/pic.ts';
import { bankInDriver } from '../src/opl/patch.ts';
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

console.log('\nthe instruments in the driver');
{
  const g = new Game(nodeSource(dirOf('kq4sci', 'KQ4')));
  const drv = g.file('adl.drv');
  check(drv !== null, `the game carries adl.drv (${drv?.length ?? 0} bytes)`);
  const bank = drv ? bankInDriver(drv) : null;
  check((bank?.length ?? 0) === 48, `${bank?.length ?? 0} instruments are read out of it`);

  /**
   * Found on the right byte, which is the whole difficulty.
   *
   * A first attempt tested only the fields that happen to be narrow and
   * settled three bytes early: forty-eight records that all looked
   * plausible, every one reading its neighbour's fields, and every
   * instrument in the game wrong.  What tells one alignment from
   * another is every field at the width the chip gives it -- so that is
   * what is asked here, of the alignment chosen and of its neighbours.
   */
  if (drv) {
    const RECORD = 28, OP = 13, COUNT = 48;
    const WIDTH: Array<[number, number]> = [
      [0, 3], [1, 15], [3, 15], [4, 15], [5, 1],
      [6, 15], [7, 15], [8, 63], [9, 1], [10, 1], [11, 1],
    ];
    const shaped = (o: number) => {
      for (const at of [0, OP])
        for (const [i, max] of WIDTH) if (drv[o + at + i] > max) return false;
      return drv[o + 12] <= 1 && drv[o + 26] <= 3 && drv[o + 27] <= 3;
    };
    const intact = (o: number) => {
      let n = 0;
      for (let i = 0; i < COUNT; i++) if (shaped(o + i * RECORD)) n++;
      return n;
    };
    let at = -1, best = -1, ties = 0;
    for (let o = 0; o + COUNT * RECORD <= drv.length; o++) {
      const n = intact(o);
      if (n > best) { best = n; at = o; ties = 1; } else if (n === best) ties++;
    }
    check(best === COUNT && ties === 1,
      `one alignment has all ${COUNT} records intact, at ${at}${ties === 1 ? '' : ` -- and ${ties} do`}`);
    const near = [-3, -2, -1, 1, 2, 3].map(d => intact(at + d));
    check(near.every(n => n < COUNT),
      `a byte either side of it does not: ${near.join(', ')} of ${COUNT}`);
  }
}

console.log('\nthe numerals on the title screen');
{
  const g = new Game(nodeSource(dirOf('kq4sci', 'KQ4')));
  const s = new Session(g, new Index(g));
  let clock = 0;
  s.now = () => clock;

  /**
   * The band above the banner, which the picture leaves nearly empty.
   *
   * The "IV" flies in as three views and, once it has landed, the game
   * marks them as having stopped moving and drops them from the cast --
   * so unless they have been made part of the picture by then, nothing
   * redraws them and the next thing that repaints from the background
   * takes them away.  That is what happened: the numerals sat there
   * while the opening question was up and went with it.
   *
   * Counted rather than sampled, because a sparkle drifting through
   * would satisfy a probe on a single pixel.
   */
  const TOP = 15, BOT = 78;
  const ink = () => {
    let n = 0;
    for (let y = TOP; y < BOT; y++)
      for (let x = 0; x < WIDTH; x++) if (s.screen.visual[y * WIDTH + x] !== 0) n++;
    return n;
  };
  const bare = (() => {
    const pic = new Picture(g.tryData('pic', 96) as Uint8Array);
    let n = 0;
    for (let y = TOP; y < BOT; y++)
      for (let x = 0; x < WIDTH; x++) if (pic.visual[y * WIDTH + x] !== 0) n++;
    return n;
  })();

  let st = s.tick();
  const seen: Array<[number, number]> = [];
  for (let i = 0; i <= 1600 && st.running; i++) {
    clock += 1000 / 60;
    st = s.tick();
    if ([300, 900, 1500].includes(i) && st.picture === 96) seen.push([i / 60, ink()]);
  }
  check(seen.length === 3, `the title screen is up at ${seen.map(([t]) => `${t.toFixed(0)}s`).join(', ')}`);
  // The picture leaves 778 pixels of ink in that band; the numerals are
  // several thousand more, so anything near the bare figure is the
  // banner on its own.
  check(bare < 1500, `the picture alone puts ${bare} pixels there`);
  for (const [t, n] of seen)
    check(n > bare + 2000, `at ${t.toFixed(0)}s there are ${n}` +
      `${n > bare + 2000 ? '' : ' -- THE NUMERALS HAVE GONE'}`);
}

console.log('\nthe credits that follow it');
{
  const g = new Game(nodeSource(dirOf('kq4sci', 'KQ4')));
  const s = new Session(g, new Index(g));
  let clock = 0;
  s.now = () => clock;

  /**
   * One credit at a time, in the space between the two heralds.
   *
   * Each credit stops moving, is hidden, and is dropped from the cast,
   * and a view that has stopped is scenery -- left alone by the restore
   * that clears moving actors.  Left alone by the hiding as well, they
   * pile up: "Executive Producer" is still there under "Directed by".
   *
   * The tell is the ink never coming down.  Counted rather than
   * compared against the picture, because the picture behind the
   * credits is black and any text at all would pass that.
   */
  let st = s.tick();
  const ink: number[] = [];
  for (let i = 0; i < 4200 && st.running; i++) {
    clock += 1000 / 60;
    st = s.tick();
    if (st.picture !== 698 || i % 180 !== 0) continue;
    let n = 0;
    for (let y = 60; y < 170; y++)
      for (let x = 100; x < 230; x++) if (s.screen.visual[y * WIDTH + x] !== 0) n++;
    ink.push(n);
  }
  check(ink.length >= 6, `the credits run for ${ink.length} samples`);
  const fell = ink.some((n, i) => i > 0 && n < ink[i - 1] - 100);
  check(fell, `a credit is cleared before the next arrives${fell ? '' : ' -- THEY ARE PILING UP'}`);
  // Two credits of three lines are about 2,400 pixels; the whole run
  // left on screen at once came to nearly 6,000.
  check(Math.max(...ink) < 3500,
    `the most on screen at once is ${Math.max(...ink)} pixels`);
}

console.log('\nwhat a property can hold');
{
  const g = new Game(nodeSource(dirOf('kq4sci', 'KQ4')));
  const s = new Session(g, new Index(g));
  let clock = 0;
  s.now = () => clock;
  const vm = s.vm as unknown as {
    listValues(h: number): number[];
    resolveTarget(f: unknown, v: number): object | null;
    prop(o: unknown, name: string, d?: number): number;
    cast: number;
  };

  /**
   * A property is a word, and the games' arithmetic on one wraps.
   *
   * This machine keeps object and buffer references in properties as
   * well, tagged above the sixteenth bit, so those are stored whole --
   * but a coordinate is a number and has to behave like one.  Stored
   * wide, one of the fairies in the Tamir scene walked its x out past
   * half a million while the interpreter went on reading the low word
   * of it, so what was written and what was read had nothing to do
   * with each other.
   */
  let st = s.tick();
  let worst = 0, worstAt = '';
  for (let i = 0; i < 20000 && st.running; i++) {
    clock += 1000 / 60;
    st = s.tick();
    if (i % 5 !== 0) continue;
    for (const v of vm.listValues(vm.cast)) {
      const o = vm.resolveTarget(null, v);
      if (!o) continue;
      for (const name of ['x', 'y']) {
        const n = Math.abs(vm.prop(o, name));
        if (n > worst) { worst = n; worstAt = `${name} of view ${vm.prop(o, 'view')} at ${(i / 60).toFixed(0)}s`; }
      }
    }
  }
  check(worst <= 32768,
    `the furthest any cast coordinate reaches is ${worst} (${worstAt})` +
    `${worst <= 32768 ? '' : ' -- WIDER THAN A WORD'}`);
}

console.log('\nthe intro it plays');
{
  const g = new Game(nodeSource(dirOf('kq4sci', 'KQ4')));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };
  const box = (s.vm as unknown as { sounds: {
    bank: unknown[] | null; playing: number[]; mix(o: Float32Array): void } }).sounds;

  check(box.bank !== null && (box.bank?.length ?? 0) >= 48,
    `the instruments come out of adl.drv: ${box.bank?.length ?? 0} of them`);

  /**
   * The intro is paced by its music, not by a timer.
   *
   * Each scene runs until its piece ends, so a game that cannot start
   * a piece never leaves the first one.  This sat on the throne room
   * with nothing moving: the music was never created, so the end it
   * was waiting for never came.
   */
  let st = s.tick();
  const pics: Array<[number, number]> = [];
  const heard = new Set<number>();
  let peak = 0;
  const buf = new Float32Array(2048);
  for (let i = 0; i < 9000 && st.running; i++) {
    st = step();
    for (const n of box.playing) heard.add(n);
    if (st.picture >= 0 && (!pics.length || pics[pics.length - 1][0] !== st.picture))
      pics.push([st.picture, i]);
    // Pull the mix as the page does, during the second scene.  That
    // one is sound 2, which is 894 notes and not a drum among them --
    // the drums are synthesised without reference to the bank, so a
    // piece with any in it would sound whether the instruments loaded
    // or not, and would prove nothing about them.
    if (i > 2200 && i < 3000) { box.mix(buf); for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; } }
  }

  check(pics.length >= 3, `it moves through ${pics.length} scenes: ` +
    pics.map(([p, f]) => `${p}@${(f / 60).toFixed(0)}s`).join(' -> '));
  check(heard.size >= 2, `${heard.size} pieces of music play: ${[...heard].join(', ')}`);

  /**
   * Is there a sound, or only a piece that says it is playing?
   *
   * Taken off the mixer the page pulls from, over a piece with no
   * percussion in it, so what is heard is the instrument bank and
   * nothing else.  A bank read from the wrong place, or a header
   * measured one resource at a time, both leave a piece that runs its
   * whole length in silence.
   */
  check(peak > 0.05, `the chip is sounding: peak ${peak.toFixed(3)}`);

  /**
   * A piece survives being disposed in the middle of starting itself.
   *
   * `Sound::play` sets a flag, calls `dispose` on itself, puts the flag
   * back and carries on using `self` -- SCI hands a disposed clone to
   * the next collection rather than freeing it there and then.  Freeing
   * it at the call left the music created and thrown away in the same
   * breath, which is the other half of why this intro stood still.
   */
  check(heard.has(2), `the intro's own music (2) is among them`);
}

console.log(`\n${checked - failed}/${checked} early-SCI0 checks passed`);
process.exit(failed ? 1 : 0);
