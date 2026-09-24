/**
 * Speaking a word should type it once.
 *
 * macOS dictation does not hand over a finished phrase.  It inserts its
 * best guess so far and then revises it, replacing the range it inserted
 * before: "G", "Ge", "Get", "Get".  The browser field was emptied every
 * time it was read, which left dictation nothing to replace, so each
 * revision arrived as a fresh insertion of the whole guess and one
 * spoken word reached the game as "GGeGetGet".
 *
 * Two things are checked, because the fault could be either.  First that
 * the difference between revisions is the right run of keys, which is
 * arithmetic and can be asked directly.  Then that a real game's input
 * line -- SCI's own `DEdit` buffer, read back out of the interpreter's
 * heap -- holds the spoken phrase and nothing else after the whole
 * sequence has been replayed through it.  The second is the one that
 * matters: the first would pass with the field still being emptied
 * somewhere else.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { revise, BACKSPACE } from '../src/dictation.ts';
import { ROOT } from './games.ts';

const ENTER = 0x0D;
/** Cycles to let the dialog notice each keystroke. */
const SETTLE = 30;

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

/**
 * What the field reads as a phrase is dictated.
 *
 * Taken from the shape macOS produces: a guess per syllable, the same
 * value repeated when it commits, and a word replaced outright when a
 * later one changes its mind about an earlier one.
 */
const SPOKEN = [
  'g', 'ge', 'get', 'get',
  'get t', 'get th', 'get the', 'get the',
  'get the r', 'get the ro', 'get the rocket',   // misheard
  'get the rock', 'get the rock',                // and corrected
];
const SAID = 'get the rock';

/** The line a run of keys leaves behind, as the game's editor would. */
function applyKeys(keys: number[], line = ''): string {
  for (const k of keys) line = k === BACKSPACE ? line.slice(0, -1) : line + String.fromCharCode(k);
  return line;
}

console.log('the difference between revisions');
{
  let sent = '', line = '';
  let typed = 0;
  for (const now of SPOKEN) {
    const keys = revise(sent, now);
    typed += keys.length;
    line = applyKeys(keys, line);
    sent = now;
  }
  check(line === SAID, `"${SAID}" spoken in ${SPOKEN.length} revisions reads "${line}"`);
  // Sending the whole field every time would be 100 keys for a 12
  // letter phrase; only the corrections should cost anything extra.
  check(typed <= SAID.length + 8, `it costs ${typed} keys, not ${SPOKEN.join('').length}`);
  check(revise('get the rocket', 'get the rock').filter(k => k === BACKSPACE).length === 2,
    'a misheard ending is taken back with backspaces, not retyped from the start');
  check(revise('look', 'look').length === 0, 'a revision that changes nothing sends nothing');
  check(applyKeys(revise('', 'café 中')) === 'café ',
    'what the game has no key for is dropped rather than mangled');
}

/**
 * The same sequence through a real game's input line.
 *
 * The line is read out of the interpreter's heap rather than off the
 * screen: the screen would answer whether the text was drawn, and this
 * is asking what the game believes was typed.
 */
for (const name of ['SQ3', 'CAMELOT']) {
  console.log(`\n${name} input line`);
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };

  const vm = s.vm as any;
  const drawControl = idx.kernel.indexOf('DrawControl');
  let edit: any = null;
  const kernel = vm.kernel.bind(vm);
  vm.kernel = (id: number, a: number[], f: unknown) => {
    if (id === drawControl) {
      const o = vm.resolveTarget(null, a[0]);
      // Only an editable field has a character limit, and it is the
      // one the parser types into.
      if (o && vm.prop(o, 'max') > 0) edit = o;
    }
    return kernel(id, a, f);
  };

  let st = s.tick();
  for (let i = 0; i < 12_000 && st.running; i++) {
    if (i % 120 === 0) s.key(ENTER);
    st = step();
  }
  edit = null;

  /**
   * The browser's handler, as it stands: keep the field, send the
   * difference.  Written out rather than imported because the real one
   * reaches for the DOM, so what is exercised here is the arrangement
   * it uses -- if that arrangement went back to emptying the field,
   * this is what would change.
   */
  let dictated = '';
  const onInput = (value: string) => {
    for (const k of revise(dictated, value)) {
      s.key(k);
      for (let i = 0; i < SETTLE && st.running; i++) st = step();
    }
    dictated = value;
  };
  for (const partial of SPOKEN) onInput(partial);
  for (let i = 0; i < SETTLE * 4 && st.running; i++) st = step();

  if (!edit) { check(false, 'typing opened no input field'); continue; }
  const line = vm.stringAt(vm.prop(edit, 'text'), edit.scriptNo) as string;
  check(line === SAID, `it holds "${line}"`);
  check(!line.startsWith('gge'), 'the partial guesses were not left in front of it');
}

console.log(`\n${checked - failed}/${checked} dictation checks passed`);
process.exit(failed ? 1 : 0);
