/**
 * The parser's input line in King's Quest IV.
 *
 * Typing a letter should open a box across the room with "Enter input"
 * above a field to type into.  What appeared instead was eight pixels
 * wide with nothing in it, and every key after the first went nowhere.
 *
 * The prompt is a pointer.  SCI scripts carry a relocation list naming
 * the words that hold addresses into themselves, and the loader turns
 * each into a real one; script 996 has three, and the one at offset 568
 * holds 618, where the string "Enter input" sits.  Left as the bare
 * number it is indistinguishable from a resource number -- and the
 * scripts do exactly that comparison, because script 255's `Print`
 * treats anything under 1000 as a text module and everything else as a
 * string.  So the prompt was fetched as text module 618, which no
 * King's Quest IV contains, and came back empty; the window sized
 * itself to nothing and the edit control was never built.
 *
 * Two things had to be true for it to work, and each is checked here by
 * what the player sees: the pointer arrives tagged, and an unsigned
 * comparison treats a tagged pointer as the large address it stands
 * for rather than truncating it back to the offset.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
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

// The pointer itself, before anything runs: the list says it is one.
{
  const sc = idx.script(996)!;
  check(sc.relocations.has(568),
    `script 996 says the word at 568 is a pointer (${sc.relocations.size} in the list)`);
  const at = sc.data[568] | (sc.data[569] << 8);
  let end = at; while (end < sc.data.length && sc.data[end]) end++;
  const text = Array.from(sc.data.subarray(at, end), b => String.fromCharCode(b)).join('');
  check(text === 'Enter input', `and it points at ${JSON.stringify(text)}`);
}

const s = new Session(g, idx);
let clock = 0;
s.now = () => clock;

interface Machine { kernel(id: number, a: number[], f?: unknown): number;
                    resolveTarget(a: null, v: number): unknown;
                    prop(o: unknown, n: string): number;
                    stringAt(p: number, sc?: number): string }
const s16 = (v: number) => (v << 16) >> 16;

/** Every control the dialog draws, and the window it draws them in. */
const controls: Array<{ kind: string; type: number; w: number; text: string }> = [];
let window: number[] = [];
const drawControl = idx.kernel.indexOf('DrawControl');
const newWindow = idx.kernel.indexOf('NewWindow');
let watched: unknown = null;
/** The edit control itself: it is filled in place, not redrawn each key. */
let editObj: unknown = null;
const watch = () => {
  const m = s.vm as unknown as Machine;
  if (m === watched) return;
  watched = m;
  const real = m.kernel.bind(m);
  m.kernel = (id, a, f) => {
    if (id === newWindow) window = a.slice(0, 4);
    if (id === drawControl) {
      const o = m.resolveTarget(null, a[0]) as { def?: { name?: string }; scriptNo?: number } | null;
      if (o && m.prop(o, 'type') === 3) editObj = o;
      if (o) controls.push({
        kind: o.def?.name ?? '?', type: m.prop(o, 'type'),
        w: s16(m.prop(o, 'nsRight')) - s16(m.prop(o, 'nsLeft')),
        text: m.stringAt(m.prop(o, 'text'), o.scriptNo ?? 0),
      });
    }
    return real(id, a, f);
  };
};
watch();

// Through the intro and the restart, to the beach she can be played on.
let st = s.tick();
for (let i = 0; i < 36000 && st.running; i++) { clock += 1000 / 60; st = s.tick(); watch(); }
check(st.picture === 25, `the game is on the beach (picture ${st.picture})`);

controls.length = 0;
window = [];
s.key('l'.charCodeAt(0));
for (let i = 0; i < 20; i++) { clock += 1000 / 60; st = s.tick(); }

const width = (window[3] ?? 0) - (window[1] ?? 0);
check(width > 200, `the input window is the width of the room (${width} pixels)`);
const prompt = controls.find(c => c.type === 2);
check(prompt?.text === 'Enter input',
  `it is headed ${JSON.stringify(prompt?.text ?? '')}`);
const edit = controls.find(c => c.type === 3);
check(!!edit && edit.w > 200, `it has a field to type into (${edit?.w ?? 0} pixels wide)`);
check(edit?.text === 'l', `the letter that opened it is in the field (${JSON.stringify(edit?.text ?? '')})`);

// And the rest of the words reach it.
for (const ch of 'ook at ocean') {
  s.key(ch.charCodeAt(0));
  for (let i = 0; i < 4; i++) { clock += 1000 / 60; st = s.tick(); }
}
const m = s.vm as unknown as Machine;
const typed = editObj ? m.stringAt(m.prop(editObj, 'text'),
  (editObj as { scriptNo?: number }).scriptNo ?? 0) : '';
check(typed === 'look at ocean',
  `typing reaches it -- it holds ${JSON.stringify(typed)}`);

/** And the game answers, rather than the key going nowhere. */
controls.length = 0;
s.key(13);
for (let i = 0; i < 60; i++) { clock += 1000 / 60; st = s.tick(); }
const said = controls.find(c => c.type === 2 && c.text.length > 4);
check(!!said, `the parser answered: ${JSON.stringify(said?.text.slice(0, 60) ?? '')}`);

console.log(`\n${checked - failed}/${checked} parser-prompt checks passed`);
process.exit(failed ? 1 : 0);
