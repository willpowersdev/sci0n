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
import { WIDTH, HEIGHT } from '../src/vm/screen.ts';
import { ROOT } from './games.ts';

const ENTER = 0x0D;
/** Long enough for the logos and the title to go by. */
const TO_MENU = 700;
const LABELS = ['See the Intro', 'Start New Game', 'Restore Game'];

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

/**
 * Is `text` drawn anywhere on screen, in either ink?
 *
 * A highlighted button is drawn inverted, so both polarities count.
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
        let cx = x, all = true;
        for (const g of glyphs) {
          for (let gy = 0; gy < g.height && all; gy++)
            for (let gx = 0; gx < g.width && all; gx++) {
              if (!g.bits[gy * g.width + gx]) continue;
              const px = cx + gx, py = y + gy;
              if (px >= WIDTH || py >= HEIGHT) { all = false; break; }
              const ink = (vis[py * WIDTH + px] & 0x0F) === 0;
              if (ink !== dark) all = false;
            }
          cx += g.width;
          if (!all) break;
        }
        if (all) return true;
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
let st = s.tick();
for (let i = 0; i < TO_MENU && st.running; i++) st = step();

let failed = 0, checked = 0;
console.log(`CAMELOT  at ${(TO_MENU / 60).toFixed(1)}s, picture ${st.picture}`);
for (const label of LABELS) {
  checked++;
  const shown = onScreen(s, label);
  if (!shown) failed++;
  console.log(`  "${label}" ${shown ? 'is on screen' : 'IS NOT DRAWN'}`);
}

// Choosing has to take the game somewhere.
const before = st.picture;
s.key(ENTER);
for (let i = 0; i < 600 && st.running; i++) st = step();
checked++;
const moved = st.picture !== before;
if (!moved) failed++;
console.log(`  choosing an option ${moved ? `moves the game on to picture ${st.picture}`
                                          : `LEAVES IT ON PICTURE ${before}`}`);

console.log(`\n${checked - failed}/${checked} opening-menu checks passed`);
process.exit(failed ? 1 : 0);
