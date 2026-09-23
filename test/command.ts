/**
 * Does the game answer a typed command?
 *
 * This is the whole point of a parser game, and it needs two kernels
 * that were not there at all.  `Parse` reads the line against the
 * game's own vocabulary, where every word it knows carries a group --
 * synonyms share one, which is why "get" and "take" are the same id.
 * `Said` then matches that against the patterns compiled into the
 * scripts.  Both returned 0 for everything, so pressing Return did
 * nothing whatever: the line was read, the window closed, and no
 * handler in the game ever fired.
 *
 * What is checked is the chain end to end: the line parses, a pattern
 * matches it, and the game puts something on the screen in reply.  A
 * word the game does not know must fail to parse, because that is a
 * different answer -- the game names the word back to the player
 * rather than saying it did not understand the sentence.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { WIDTH, HEIGHT } from '../src/vm/screen.ts';
import { ROOT } from './games.ts';

const ENTER = 0x0D;

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let failed = 0, checked = 0;
for (const [name, command] of [['SQ3', 'look'], ['CAMELOT', 'look']] as Array<[string, string]>) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };
  const vm = s.vm as any;

  // Watch what the parser is asked and what it answers.
  const parseK = idx.kernel.indexOf('Parse'), saidK = idx.kernel.indexOf('Said');
  let parsed = 0, tried = 0, matched = 0, drew = 0;
  const kernel = vm.kernel.bind(vm);
  const windowK = idx.kernel.indexOf('NewWindow'), displayK = idx.kernel.indexOf('Display');
  vm.kernel = (id: number, a: number[], f: unknown) => {
    const r = kernel(id, a, f);
    if (id === parseK && r) parsed++;
    if (id === saidK) { tried++; if (r) matched++; }
    if (id === windowK || id === displayK) drew++;
    return r;
  };

  let st = s.tick();
  for (let i = 0; i < 12_000 && st.running; i++) { if (i % 120 === 0) s.key(ENTER); st = step(); }

  for (const ch of command) { s.key(ch.charCodeAt(0)); for (let i = 0; i < 12 && st.running; i++) st = step(); }
  drew = 0;
  s.key(ENTER);
  for (let i = 0; i < 300 && st.running; i++) st = step();

  checked += 3;
  if (!parsed) failed++;
  if (!matched) failed++;
  if (!drew) failed++;
  console.log(`${name.padEnd(9)} "${command}" · parsed ${parsed ? 'yes' : 'NO'}` +
    ` · ${tried} patterns tried, ${matched} matched${matched ? '' : ' -- NONE MATCHED'}` +
    ` · the game ${drew ? 'answers' : 'SAYS NOTHING'}`);

  // A word it does not know is a different answer from a sentence it
  // cannot follow, and the game says so differently.
  checked++;
  const unknown = vm.parser.parse('zzxyqq');
  const knows = vm.parser.parse(command) === null;
  const ok = unknown === 'zzxyqq' && knows;
  if (!ok) failed++;
  console.log(`          an unknown word is reported back as "${unknown}"` +
    `${ok ? '' : ' -- EXPECTED THE WORD ITSELF, AND THE COMMAND TO PARSE'}`);
}
/**
 * A line the parser cannot read is answered, not ignored.
 *
 * The script's whole response to a failed `Parse` is to return, so
 * unless the interpreter speaks up nothing is said at all -- and a word
 * the game has never heard of looks exactly like a keyboard that has
 * stopped working.  "remove suit of armor" is one: Camelot knows
 * "armor", "armour" and "mail", but not "suit".
 *
 * The wording is the games' own, out of resource text.994.  The later
 * SCI0 games carry the parser's lines there; Camelot ships a shorter
 * table and kept them inside the interpreter, so it falls back to the
 * same text.
 *
 * What is checked is the glyphs on the screen, not a flag: the message
 * is rendered through the game's own font and looked for in the
 * picture.  That is deliberate, because the first way this went wrong
 * was a box that drew correctly and was then eaten from the left -- the
 * cast's background restore ran over it every frame, and "I don't
 * understand" arrived as "don't understand".  A check that only asked
 * whether a message existed would have passed.
 */
for (const [name, bad, nonsense] of [
  ['CAMELOT', 'remove suit of armor', 'purse the eat'],
  ['SQ3', 'get the zzxyqq', 'rock the get'],
] as Array<[string, string, string]>) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };
  const vm = s.vm as any;
  let st = s.tick();
  for (let i = 0; i < 12_000 && st.running; i++) { if (i % 120 === 0) s.key(ENTER); st = step(); }

  const type = (line: string) => {
    for (const ch of line) { s.key(ch.charCodeAt(0)); for (let i = 0; i < 10 && st.running; i++) st = step(); }
    s.key(ENTER);
    for (let i = 0; i < 300 && st.running; i++) st = step();
  };

  const clean = Uint8Array.from(s.screen.visual);
  type(bad);
  checked += 2;
  // The unknown word itself has to be named back, inside the message.
  const named = onScreen(s, `"${bad.split(' ').find(w => vm.parser.parse(w) !== null) ?? ''}"`);
  // The whole opening of the message, not a fragment of it: the first
  // way this broke was a box drawn correctly and then eaten from the
  // left, which a search starting mid-sentence would not have noticed.
  const said = onScreen(s, "I don't understand");
  if (!said) failed++;
  if (!named) failed++;
  console.log(`${name.padEnd(9)} "${bad}" · ${said ? 'the parser answers' : 'SAYS NOTHING'}` +
    ` · ${named ? 'and names the word back' : 'BUT DOES NOT NAME THE WORD'}`);

  // Any key takes it down, and the picture comes back untouched.
  checked++;
  s.key(0x20);
  for (let i = 0; i < 300 && st.running; i++) st = step();
  let diff = 0;
  for (let i = 0; i < clean.length; i++) if (clean[i] !== s.screen.visual[i]) diff++;
  if (diff) failed++;
  console.log(`          a keypress takes it down${diff ? ` -- ${diff} PIXELS LEFT BEHIND` : ' and leaves the picture as it was'}`);

  // Words it knows in an order it cannot follow is the other failure.
  checked++;
  type(nonsense);
  const sentence = onScreen(s, "sentence");
  if (!sentence) failed++;
  console.log(`          "${nonsense}" · ${sentence ? 'answered as a sentence it cannot follow' : 'SAYS NOTHING'}`);
  s.key(0x20);
  for (let i = 0; i < 200 && st.running; i++) st = step();
}

console.log(`\n${checked - failed}/${checked} command checks passed`);
process.exit(failed ? 1 : 0);

/**
 * Is this text drawn on the screen, in the interpreter's own font?
 *
 * Rendered glyph by glyph and matched against the picture, so a message
 * that exists only in memory -- or one that has had its first letters
 * painted over -- cannot satisfy it.
 */
function onScreen(sess: Session, text: string): boolean {
  const font = (sess.vm as any).font(0);
  if (!font) return false;
  const glyphs = [...text].map(c => font.chars[c.charCodeAt(0)]);
  if (glyphs.some(gl => !gl)) return false;
  const vis = sess.screen.visual;
  const h = Math.max(...glyphs.map(gl => gl.height));
  for (let y = 0; y + h < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      let cx = x, all = true;
      for (const gl of glyphs) {
        for (let gy = 0; gy < gl.height && all; gy++)
          for (let gx = 0; gx < gl.width && all; gx++) {
            if (!gl.bits[gy * gl.width + gx]) continue;
            const px = cx + gx, py = y + gy;
            // The box is black on white, so a set bit must be dark.
            if (px >= WIDTH || py >= HEIGHT || (vis[py * WIDTH + px] & 0x0F) !== 0) all = false;
          }
        cx += gl.width;
        if (!all) break;
      }
      if (all) return true;
    }
  return false;
}
