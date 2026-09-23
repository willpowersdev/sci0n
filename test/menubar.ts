/**
 * The menu bar.
 *
 * A game declares its menus once with `AddMenu(title, items)` and then
 * spends the rest of the game calling `SetMenu` to enable and disable
 * what applies where the player is standing.  Escape pulls the menus
 * down, the arrows walk them, Enter picks, and a shortcut key picks
 * without opening anything.
 *
 * What is checked is what the player gets: the menus a game declared,
 * a pulled-down menu drawn on the screen with its shortcut labels, the
 * arrows moving between menus and items, and Escape putting the picture
 * back exactly as it was.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { EV } from '../src/vm/pmachine.ts';
import { WIDTH, HEIGHT } from '../src/vm/screen.ts';
import { ROOT } from './games.ts';

const ESC = 27, RIGHT = 0x4D00, DOWN = 0x5000;

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let failed = 0, checked = 0;
const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
const s = new Session(g, new Index(g));
let clock = 0;
s.now = () => clock;
const step = () => { clock += 1000 / 60; return s.tick(); };
const vm = s.vm as any;

let st = s.tick();
for (let i = 0; i < 6000 && st.running; i++) { st = step(); if (s.screen.windows.length) break; }
// "Start New Game" is the second button of the opening menu.
const port = vm.port;
s.mouse(EV.mouseDown, port.x + 180, port.y + 23);
for (let i = 0; i < 20 && st.running; i++) st = step();
s.mouse(EV.mouseUp, port.x + 180, port.y + 23);
for (let i = 0; i < 2400 && st.running; i++) st = step();

const titles = vm.menu.menus.map((m: { title: string }) => m.title.trim()).filter(Boolean);
checked++;
// Camelot declares six: the logo, File, Game, Speed, Action, Information.
const declared = vm.menu.menus.length >= 5;
if (!declared) failed++;
console.log(`CAMELOT  ${vm.menu.menus.length} menus declared: ${titles.join(', ')}` +
  `${declared ? '' : ' -- NONE WERE BUILT'}`);

/** A copy of the picture, to tell whether closing put it back. */
const before = Uint8Array.from(s.screen.visual);

s.key(ESC);
for (let i = 0; i < 60 && st.running; i++) st = step();
checked++;
const opened = vm.menu.openMenu >= 0;
if (!opened) failed++;
console.log(`  escape ${opened ? `pulls down menu ${vm.menu.openMenu}` : 'OPENS NOTHING'}`);

s.key(RIGHT);
for (let i = 0; i < 20 && st.running; i++) st = step();
s.key(DOWN);
for (let i = 0; i < 20 && st.running; i++) st = step();
checked++;
const walked = vm.menu.openMenu === 1 && vm.menu.openItem === 1;
if (!walked) failed++;
console.log(`  the arrows reach menu ${vm.menu.openMenu}, item ${vm.menu.openItem}` +
  `${walked ? '' : ' -- EXPECTED MENU 1, ITEM 1'}`);

// The File menu's items have to be on the screen, shortcuts and all.
checked++;
const shown = ['Save Game', 'Restore Game', 'Quit'].every(t => drawn(t)) && drawn('F5');
if (!shown) failed++;
console.log(`  its items and their shortcuts ${shown ? 'are drawn' : 'ARE NOT ON THE SCREEN'}`);

// A shortcut must name the same item the menu does.
checked++;
const byKey = vm.menu.forKey(0x3F00);            // F5
const bySpot = (2 << 8) | 1;                     // File, first item
if (byKey !== bySpot) failed++;
console.log(`  F5 names item 0x${byKey.toString(16)}` +
  `${byKey === bySpot ? ' -- the File menu’s first' : ` -- EXPECTED 0x${bySpot.toString(16)}`}`);

s.key(ESC);
for (let i = 0; i < 60 && st.running; i++) st = step();
checked++;
let diff = 0;
for (let i = 0; i < before.length; i++) if (before[i] !== s.screen.visual[i]) diff++;
const restored = vm.menu.openMenu < 0 && diff === 0;
if (!restored) failed++;
console.log(`  escape closes it and puts back the picture` +
  `${restored ? '' : ` -- ${diff} PIXELS LEFT CHANGED`}`);

console.log(`\n${checked - failed}/${checked} menu-bar checks passed`);
process.exit(failed ? 1 : 0);

/** Is this text drawn anywhere, in either ink? */
function drawn(text: string): boolean {
  const font = vm.font(0);
  if (!font) return false;
  const glyphs = [...text].map(ch => font.chars[ch.charCodeAt(0)]);
  if (glyphs.some((gl: unknown) => !gl)) return false;
  const vis = s.screen.visual;
  const h = Math.max(...glyphs.map((gl: { height: number }) => gl.height));
  for (let y = 0; y + h < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++)
      for (const dark of [true, false]) {
        let cx = x, all = true;
        for (const gl of glyphs) {
          for (let gy = 0; gy < gl.height && all; gy++)
            for (let gx = 0; gx < gl.width && all; gx++) {
              if (!gl.bits[gy * gl.width + gx]) continue;
              const px = cx + gx, py = y + gy;
              if (px >= WIDTH || py >= HEIGHT) { all = false; break; }
              if (((vis[py * WIDTH + px] & 0x0F) === 0) !== dark) all = false;
            }
          cx += gl.width;
          if (!all) break;
        }
        if (all) return true;
      }
  return false;
}
