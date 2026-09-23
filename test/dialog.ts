/**
 * The opening menu: does the game let you choose anything?
 *
 * Camelot starts by asking whether to watch the intro, start a new game
 * or restore one.  That one dialog exercises most of the machinery a
 * Sierra interface is made of -- a window opened over the picture, a
 * text control, three buttons carrying labels and values, and a modal
 * loop that waits for a choice and returns it -- and every part of it
 * was broken in a different way at once.  The window was filled black
 * over its own text, the buttons had no labels because an indexed store
 * dropped what it assigned, and the text that did exist was read out of
 * the wrong script.
 *
 * The check is deliberately about what reaches the screen: the labels
 * are rendered through the game's own font and matched against the
 * window's pixels, and then a key is pressed to see the game move on.
 * A dialog can hold all three buttons in memory and show none of them.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { EV } from '../src/vm/pmachine.ts';
import { WIDTH, HEIGHT } from '../src/vm/screen.ts';
import { ROOT } from './games.ts';

const ENTER = 0x0D;
/**
 * Frames to allow for the logos, the title and the credits.
 *
 * Generous, and not waited out: the run stops as soon as the menu
 * opens.  Timing is the game's own and moves when the clock is fixed --
 * a fixed count here quietly became "somewhere in the credits" the day
 * `GetTime` started answering in seconds.
 */
const TO_MENU = 6000;
const LABELS = ['See the Intro', 'Start New Game', 'Restore Game'];

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

/**
 * Is `text` drawn anywhere on screen, in either ink?
 *
 * A highlighted button is drawn inverted, so both polarities count --
 * but the glyphs have to be legible either way.  Matching only the set
 * pixels accepts a flat slab of one colour as every word in the dialog,
 * so the gaps between the strokes must be the other ink.
 */
function onScreen(s: Session, text: string): boolean {
  const font = (s.vm as any).font(0);
  if (!font) return false;
  const glyphs = [...text].map(c => font.chars[c.charCodeAt(0)]).filter(Boolean);
  if (glyphs.length !== text.length) return false;
  const vis = s.screen.visual;
  const h = Math.max(...glyphs.map(g => g.height));
  for (let y = 0; y + h < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      for (const dark of [true, false]) {
        let cx = x, all = true, contrast = 0;
        for (const g of glyphs) {
          for (let gy = 0; gy < g.height && all; gy++)
            for (let gx = 0; gx < g.width && all; gx++) {
              const px = cx + gx, py = y + gy;
              if (px >= WIDTH || py >= HEIGHT) { all = false; break; }
              const ink = (vis[py * WIDTH + px] & 0x0F) === 0;
              if (g.bits[gy * g.width + gx]) { if (ink !== dark) all = false; }
              else if (ink !== dark) contrast++;
            }
          cx += g.width;
          if (!all) break;
        }
        if (all && contrast > 0) return true;
      }
    }
  }
  return false;
}

const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
const s = new Session(g, new Index(g));
let clock = 0;
s.now = () => clock;
const step = () => { clock += 1000 / 60; return s.tick(); };
/** Run until a window opens, which is the menu appearing. */
function toMenu(sess: Session, run: () => { running: boolean; picture: number }) {
  let last = sess.tick();
  for (let i = 0; i < TO_MENU && last.running; i++) {
    last = run();
    if (sess.screen.windows.length) break;
  }
  return last;
}

let st = toMenu(s, step);

let failed = 0, checked = 0;
console.log(`CAMELOT  menu open at picture ${st.picture}`);
for (const label of LABELS) {
  checked++;
  const shown = onScreen(s, label);
  if (!shown) failed++;
  console.log(`  "${label}" ${shown ? 'is on screen' : 'IS NOT DRAWN'}`);
}

// Choosing has to take the game somewhere, by either hand.
const before = st.picture;
s.key(ENTER);
for (let i = 0; i < 600 && st.running; i++) st = step();
checked++;
const byKey = st.picture !== before;
if (!byKey) failed++;
console.log(`  the keyboard ${byKey ? `takes the game on to picture ${st.picture}`
                                    : `LEAVES IT ON PICTURE ${before}`}`);

/**
 * And by mouse.
 *
 * Worth its own check: the two paths share almost nothing.  A click has
 * to be converted into the window's own coordinates before the dialog
 * asks which control it landed on, and the control then polls for the
 * pointer while the button is held -- so an empty event queue has to
 * keep reporting where the pointer is, or the button highlights under
 * the mouse and refuses every click.
 */
{
  const w = new Session(g, new Index(g));
  let clock2 = 0;
  w.now = () => clock2;
  const step2 = () => { clock2 += 1000 / 60; return w.tick(); };
  let st2 = toMenu(w, step2);
  const was = st2.picture;
  // The dialog centres itself; these are the first button's own pixels.
  const port = (w.vm as any).port;
  const x = port.x + 180, y = port.y + 9;
  w.mouse(EV.mouseDown, x, y);
  for (let i = 0; i < 20 && st2.running; i++) st2 = step2();
  w.mouse(EV.mouseUp, x, y);
  for (let i = 0; i < 600 && st2.running; i++) st2 = step2();
  checked++;
  const byMouse = st2.picture !== was;
  if (!byMouse) failed++;
  console.log(`  a click at ${x},${y} ${byMouse ? `takes it on to picture ${st2.picture}`
                                                : `LEAVES IT ON PICTURE ${was}`}`);
}

console.log(`\n${checked - failed}/${checked} opening-menu checks passed`);
process.exit(failed ? 1 : 0);
