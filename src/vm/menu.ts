/**
 * The menu bar, as SCI0 builds it.
 *
 * A game declares its menus once with `AddMenu(title, items)`, where the
 * items are one string separated by colons and marked up with a few
 * characters that `sci.sh` and the kernel documentation spell out:
 *
 *   `   the rest of this item is right-justified -- the shortcut label
 *   :   end of this item, the next one follows
 *   --! this item is a separator line
 *   #n  the item's function key
 *   ^c  the item's control-key
 *
 * So Camelot's File menu arrives as
 * "Save Game`#5:Restore Game`#7:--!:Restart Game`#9:Quit`^q".
 *
 * Items are named to the game by a word: the high byte is the menu and
 * the low byte the item, both counting from one, which is why a script
 * disables an item with `SetMenu($0503 smMENU_ENABLE 0)`.
 */
import type { Font } from '../font.ts';
import { type Screen, WIDTH, STATUS_HEIGHT } from './screen.ts';

export interface MenuItem {
  /** What is written on the left. */
  text: string;
  /** What is written on the right: the shortcut, as a player reads it. */
  hint: string;
  /** The keystroke that picks it without opening the menu. */
  key: number;
  /** A `Said` spec the game attached, which it matches against later. */
  said: number;
  enabled: boolean;
  separator: boolean;
}

export interface Menu {
  title: string;
  items: MenuItem[];
  /** Where the title sits on the bar, filled in when the bar is drawn. */
  x: number;
  width: number;
}

/** Sub-functions of `SetMenu` and `GetMenu`, from sci.sh. */
export const SM = { said: 109, text: 110, key: 111, enable: 112 } as const;

/**
 * The keystroke a shortcut stands for.
 *
 * Function keys are the PC's extended codes -- F1 is 0x3B00 -- and a
 * control-key is the letter with the top three bits cleared, which is
 * what a keyboard actually sends.
 */
function shortcutKey(spec: string): { key: number; hint: string } {
  const fn = /^#(\d+)/.exec(spec);
  if (fn) {
    const n = Number(fn[1]);
    return { key: n >= 1 && n <= 10 ? 0x3B00 + ((n - 1) << 8) : 0, hint: `F${n}` };
  }
  const ctrl = /^\^(.)/.exec(spec);
  if (ctrl) {
    const c = ctrl[1].toUpperCase();
    return { key: c.charCodeAt(0) & 0x1F, hint: `Ctrl-${c}` };
  }
  const ch = spec.trim()[0];
  return ch ? { key: ch.charCodeAt(0), hint: ch } : { key: 0, hint: '' };
}

/** Split one `AddMenu` items string into items. */
export function parseItems(spec: string): MenuItem[] {
  const out: MenuItem[] = [];
  for (const raw of spec.split(':')) {
    const part = raw.replace(/\s+$/, '');
    if (!part) continue;
    if (part.trim().startsWith('--!')) {
      out.push({ text: '', hint: '', key: 0, said: 0, enabled: false, separator: true });
      continue;
    }
    const tick = part.indexOf('`');
    const text = (tick < 0 ? part : part.slice(0, tick)).trim();
    // A trailing `=n` after the shortcut is the item's own value, which
    // the game reads back; it is not part of what the player is shown.
    const after = tick < 0 ? '' : part.slice(tick + 1).replace(/=.*$/, '');
    const { key, hint } = tick < 0 ? { key: 0, hint: '' } : shortcutKey(after);
    out.push({ text, hint, key, said: 0, enabled: true, separator: false });
  }
  return out;
}

export class MenuBar {
  menus: Menu[] = [];
  /** Which menu is pulled down, and which of its items is under the pointer. */
  openMenu = -1;
  openItem = 0;
  /** Pixels hidden by the open menu, to put back when it closes. */
  private under: ReturnType<Screen['save']> | null = null;
  /** Whether the strip was showing before the menu was pulled down. */
  private barWasVisible = false;

  add(title: string, items: string) {
    this.menus.push({ title, items: parseItems(items), x: 0, width: 0 });
  }

  /** The item a word like 0x0503 names, counting menus and items from one. */
  item(id: number): MenuItem | null {
    const m = this.menus[((id >> 8) & 0xFF) - 1];
    return m?.items[(id & 0xFF) - 1] ?? null;
  }

  /** The item a keystroke picks, or 0. */
  forKey(key: number): number {
    for (let mi = 0; mi < this.menus.length; mi++) {
      const items = this.menus[mi].items;
      for (let ii = 0; ii < items.length; ii++)
        if (items[ii].key && items[ii].key === key && items[ii].enabled)
          return ((mi + 1) << 8) | (ii + 1);
    }
    return 0;
  }

  /** Lay the titles along the bar and draw them. */
  drawBar(screen: Screen, font: Font | null) {
    screen.statusBar.fill(0xFF);
    if (!font) return;
    let x = 0;
    for (const m of this.menus) {
      m.x = x;
      m.width = measure(font, m.title);
      text(screen.statusBar, font, m.title, x, top(font), 0x00);
      x += m.width;
    }
    screen.dirty = true;
  }

  /** Is this event asking for the menus? */
  activates(type: number, message: number, y: number): boolean {
    if (type === 4 && message === 27) return true;          // Escape
    return type === 1 && y < 0;                              // a click in the bar
  }

  open(screen: Screen, font: Font | null, which: number) {
    this.barWasVisible = screen.statusVisible;
    screen.statusVisible = true;
    this.openMenu = Math.max(0, Math.min(this.menus.length - 1, which));
    this.openItem = this.firstPickable(this.openMenu, 1);
    this.drawBar(screen, font);
    this.drawDrop(screen, font);
  }

  close(screen: Screen, font: Font | null) {
    if (this.under) { screen.restoreRect(this.under); this.under = null; }
    this.openMenu = -1;
    screen.statusVisible = this.barWasVisible;
    this.drawBar(screen, font);
    screen.dirty = true;
  }

  /** Step to the next menu, or the next item, wrapping round. */
  move(screen: Screen, font: Font | null, dMenu: number, dItem: number) {
    if (this.openMenu < 0) return;
    if (dMenu) {
      const n = this.menus.length;
      this.openMenu = (this.openMenu + dMenu + n) % n;
      this.openItem = this.firstPickable(this.openMenu, dMenu >= 0 ? 1 : 1);
    }
    if (dItem) this.openItem = this.firstPickable(this.openMenu, dItem, this.openItem + dItem);
    if (this.under) { screen.restoreRect(this.under); this.under = null; }
    this.drawBar(screen, font);
    this.drawDrop(screen, font);
  }

  /** The chosen item's id, or 0 if it cannot be chosen. */
  chosen(): number {
    if (this.openMenu < 0) return 0;
    const it = this.menus[this.openMenu]?.items[this.openItem];
    if (!it || it.separator || !it.enabled) return 0;
    return ((this.openMenu + 1) << 8) | (this.openItem + 1);
  }

  /** Which menu a point on the bar is over, or -1. */
  menuAt(x: number): number {
    for (let i = 0; i < this.menus.length; i++) {
      const m = this.menus[i];
      if (x >= m.x && x < m.x + m.width) return i;
    }
    return -1;
  }

  /** Which item in the open menu a point is over, or -1. */
  itemAt(font: Font | null, x: number, y: number): number {
    if (this.openMenu < 0 || !font) return -1;
    const m = this.menus[this.openMenu];
    const h = Math.max(8, font.lineHeight);
    const i = Math.floor((y - 1) / h);
    if (i < 0 || i >= m.items.length) return -1;
    if (x < m.x || x > m.x + this.dropWidth(font, m) + 4) return -1;
    return i;
  }

  private firstPickable(mi: number, step: number, from?: number): number {
    const items = this.menus[mi]?.items ?? [];
    let i = from ?? (step >= 0 ? 0 : items.length - 1);
    for (let n = 0; n < items.length + 1; n++) {
      if (i < 0) i = items.length - 1;
      if (i >= items.length) i = 0;
      if (items[i] && !items[i].separator) return i;
      i += step || 1;
    }
    return 0;
  }

  private dropWidth(font: Font, m: Menu): number {
    let w = 0;
    for (const it of m.items) w = Math.max(w, measure(font, it.text) + 12 + measure(font, it.hint));
    return Math.max(w, m.width);
  }

  /** Draw the menu that is pulled down, over the picture. */
  private drawDrop(screen: Screen, font: Font | null) {
    if (this.openMenu < 0 || !font) return;
    const m = this.menus[this.openMenu];
    const h = Math.max(8, font.lineHeight);
    const w = this.dropWidth(font, m) + 4;
    const x0 = Math.max(0, Math.min(WIDTH - w - 2, m.x));
    const y1 = Math.min(190, m.items.length * h + 2);
    this.under = screen.save(x0, 0, x0 + w + 2, y1 + 1);
    screen.fill(x0, 0, x0 + w + 2, y1, 15);
    screen.frame(x0, 0, x0 + w + 2, y1, 0);
    for (let i = 0; i < m.items.length; i++) {
      const it = m.items[i];
      const y = 1 + i * h;
      if (it.separator) {
        for (let x = x0 + 1; x < x0 + w + 1; x++) screen.px(x, y + (h >> 1), 0);
        continue;
      }
      const picked = i === this.openItem;
      if (picked) screen.fill(x0 + 1, y, x0 + w + 1, y + h, 0);
      const ink = picked ? 15 : it.enabled ? 0 : 8;
      screen.text(font, it.text, x0 + 3, y, ink);
      if (it.hint) screen.text(font, it.hint, x0 + w - measure(font, it.hint), y, ink);
    }
    screen.dirty = true;
  }
}

function measure(font: Font, s: string): number {
  let w = 0;
  for (const ch of s) w += font.chars[ch.charCodeAt(0)]?.width ?? 0;
  return w;
}

function top(font: Font): number {
  return Math.max(0, (STATUS_HEIGHT - font.lineHeight) >> 1);
}

/** Draw a string into the status strip's own plane. */
function text(bar: Uint8Array, font: Font, s: string, x: number, y: number, colour: number) {
  let cx = x;
  for (const ch of s) {
    const g = font.chars[ch.charCodeAt(0)];
    if (!g) continue;
    for (let gy = 0; gy < g.height; gy++) {
      const py = y + gy;
      if (py < 0 || py >= STATUS_HEIGHT) continue;
      for (let gx = 0; gx < g.width; gx++) {
        if (!g.bits[gy * g.width + gx]) continue;
        const px = cx + gx;
        if (px < 0 || px >= WIDTH) continue;
        bar[py * WIDTH + px] = colour;
      }
    }
    cx += g.width;
    if (cx >= WIDTH) break;
  }
}
