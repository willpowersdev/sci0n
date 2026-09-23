/**
 * The text around the picture: the status line and the parser's input.
 *
 * Typing a letter opens the parser's input line, and the game sizes that
 * window itself: `DEdit::setSize` measures the string "M" through
 * `TextSize` and multiplies it by the field's character limit.  So the
 * whole dialog is only as sane as one glyph measurement, and when that
 * measurement was wrong the window came out 1252 pixels wide with one
 * letter visible on screen.
 *
 * What is checked is what a player would notice: the window and the
 * field it contains are on the screen, wide enough to type into, and
 * that a typed phrase appears in them.  That last part is not the same
 * question as whether the field holds the text -- it held "look" while
 * the screen still showed "l", because editing the buffer and redrawing
 * the field are two different things and only one of them was
 * happening.
 *
 * The status line is checked here too.  It is the other half of the
 * interface that is not the picture, and it was being kept as a string
 * and never drawn -- a black band across the top of every game where
 * the original shows the score.
 *
 * Only a game that asks for one is judged on it.  SQ3 draws a score
 * line; Camelot puts a menu bar in the same strip and never calls
 * `DrawStatus` at all, so its strip is the menu bar's -- see
 * test/menubar.ts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { WIDTH, STATUS_HEIGHT } from '../src/vm/screen.ts';
import { ROOT } from './games.ts';

const ENTER = 0x0D;
const PHRASE = 'look';
/** Cycles to let the dialog notice each keystroke. */
const SETTLE = 30;
/** Narrower than this and there is no room to type. */
const USABLE = 100;

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

/**
 * Does `text` appear as pixels inside the given rectangle?
 *
 * The glyphs are rendered from the game's own font and matched against
 * the screen, so this cannot be satisfied by the text merely existing
 * somewhere in memory.
 */
function drawnText(s: Session, text: string, left: number, top: number,
                   right: number, bottom: number): boolean {
  const font = (s.vm as any).font(0);
  if (!font) return false;
  const glyphs = [...text].map(c => font.chars[c.charCodeAt(0)]).filter(Boolean);
  if (!glyphs.length) return false;
  const vis = s.screen.visual;
  const y1 = Math.min(190, bottom), x1 = Math.min(WIDTH, right);
  for (let y = Math.max(0, top); y < y1 - glyphs[0].height; y++) {
    for (let x = Math.max(0, left); x < x1; x++) {
      let cx = x, all = true;
      for (const g of glyphs) {
        for (let gy = 0; gy < g.height && all; gy++)
          for (let gx = 0; gx < g.width && all; gx++) {
            if (!g.bits[gy * g.width + gx]) continue;
            const px = cx + gx, py = y + gy;
            // The field is black on white, so a set bit must be dark.
            if (px >= WIDTH || py >= 190 || (vis[py * WIDTH + px] & 0x0F) !== 0) all = false;
          }
        cx += g.width;
        if (!all) break;
      }
      if (all) return true;
    }
  }
  return false;
}

let failed = 0, checked = 0;
for (const name of ['SQ3', 'CAMELOT']) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };

  // Watch the window as it is opened, and the controls as they are drawn.
  const vm = s.vm as any;
  const newWindow = idx.kernel.indexOf('NewWindow');
  const drawControl = idx.kernel.indexOf('DrawControl');
  let win: number[] | null = null;
  const fields: Array<{ name: string; left: number; right: number }> = [];
  const kernel = vm.kernel.bind(vm);
  vm.kernel = (id: number, a: number[], f: any) => {
    if (id === newWindow && !win) win = a.slice(0, 4);
    if (id === drawControl) {
      const o = vm.resolveTarget(null, a[0]);
      // `max` is how many characters the field holds; only an editable
      // one has it, and only that one has to be wide enough to type in.
      if (o && vm.prop(o, 'max') > 0)
        fields.push({ name: o.def.name, left: vm.prop(o, 'nsLeft'), right: vm.prop(o, 'nsRight') });
    }
    return kernel(id, a, f);
  };

  let st = s.tick();
  for (let i = 0; i < 12_000 && st.running; i++) {
    if (i % 120 === 0) s.key(ENTER);
    st = step();
  }
  // Only what typing opens counts; the opening sequence has windows of
  // its own and the first one seen is not the parser's.
  win = null;
  fields.length = 0;
  for (const ch of PHRASE) {
    s.key(ch.charCodeAt(0));
    for (let i = 0; i < SETTLE && st.running; i++) st = step();
  }

  checked++;
  if (!win) { failed++; console.log(`${name.padEnd(9)} typing opened no window at all`); continue; }
  const [top, left, bottom, right] = win as number[];
  const w = right - left, h = bottom - top;
  // Only the horizontal geometry is judged.  That is where the fault
  // was, and it is the part whose convention is settled: the window's
  // left and right are picture coordinates.  Where the bottom edge may
  // sit relative to the status bar is a separate question, not one to
  // answer with a guess inside a test.
  const onScreen = left >= 0 && right <= WIDTH;
  const roomy = w >= USABLE;
  if (!onScreen || !roomy) failed++;
  console.log(`${name.padEnd(9)} input window ${left},${top}-${right},${bottom} (${w}x${h})` +
    `${onScreen ? '' : ' -- OFF THE SIDE OF THE SCREEN'}${roomy ? '' : ` -- ONLY ${w}px WIDE`}`);

  const field = fields[fields.length - 1];
  checked++;
  if (!field) { failed++; console.log(`          no editable field was drawn`); continue; }
  const fw = field.right - field.left;
  // The field's rectangle is relative to the window it sits in.
  const ok = fw >= USABLE && fw <= WIDTH;
  if (!ok) failed++;
  console.log(`          ${field.name} field ${field.left}-${field.right} (${fw}px)` +
    `${ok ? '' : ` -- ${fw > WIDTH ? 'WIDER THAN THE SCREEN' : 'TOO NARROW TO TYPE IN'}`}`);

  /**
   * Is the phrase on the screen?
   *
   * Rendering each letter through the same font and looking for it in
   * the window's pixels is the only way to ask this that a buffer full
   * of text cannot answer for the screen.
   */
  checked++;
  const shown = drawnText(s, PHRASE, left, top, right, bottom);
  if (!shown) failed++;
  console.log(`          "${PHRASE}" ${shown ? 'is drawn in the window' : 'IS NOT ON THE SCREEN'}`);

  // The status line: text the game set, and pixels to show for it.
  const bar = s.screen.statusBar;
  let dark = 0;
  for (const v of bar) if ((v & 0x0F) === 0) dark++;
  if (!s.screen.status.trim()) {
    console.log(`          no status line asked for (this game puts a menu bar in the strip)`);
  } else {
    checked++;
    const lit = dark > 0 && dark < bar.length;
    if (!lit) failed++;
    console.log(`          status line ${JSON.stringify(s.screen.status.trim().slice(0, 40))}` +
      ` · ${dark} of ${WIDTH * STATUS_HEIGHT} pixels inked` +
      `${lit ? '' : ' -- NOTHING DRAWN IN THE STATUS LINE'}`);
  }
}
console.log(`\n${checked - failed}/${checked} input-window checks passed`);
process.exit(failed ? 1 : 0);
