/**
 * The SCI0 screen: three 320x190 planes and the rules for drawing on them.
 *
 * A picture paints all three -- what you see, how near it is, and what
 * the floor does there.  Everything drawn afterwards is transient: cels
 * are composited over a saved copy of the background each frame rather
 * than erased individually, which is both simpler and what the
 * interpreter effectively did with its "restore under bits" bookkeeping.
 *
 * A cel pixel is drawn only where its priority is at least the priority
 * already there, which is what beds an actor into the scenery instead of
 * pasting it on top.
 */
import { Picture, WIDTH, HEIGHT } from '../pic.ts';
import type { Cel } from '../view.ts';
import type { Font } from '../font.ts';
import { EGA_RGB, BLENDED_RGB, ditherPixel } from '../ega.ts';

export { WIDTH, HEIGHT };
/** The status line sits above the picture; SCI0 reserves ten rows. */
export const STATUS_HEIGHT = 10;
export const SCREEN_HEIGHT = HEIGHT + STATUS_HEIGHT;

export class Screen {
  /** Palette bytes, so a dither pair survives to the renderer. */
  visual = new Uint8Array(WIDTH * HEIGHT).fill(0xFF);
  priority = new Uint8Array(WIDTH * HEIGHT);
  control = new Uint8Array(WIDTH * HEIGHT);
  /** The picture alone, restored under the cast every frame. */
  private bgVisual = new Uint8Array(WIDTH * HEIGHT).fill(0xFF);
  private bgPriority = new Uint8Array(WIDTH * HEIGHT);
  /** Text above the picture, drawn last and never covered by it. */
  status = '';
  /**
   * The status line's own pixels.
   *
   * It sits outside the picture and survives everything drawn into it,
   * so it gets a plane of its own rather than a corner of the visual
   * one.  White with black text, as SCI0 draws it.
   */
  statusBar = new Uint8Array(WIDTH * STATUS_HEIGHT).fill(0xFF);
  /** Set when the picture changes, so the host knows to repaint. */
  dirty = true;
  /** Undithering is a display choice, not a drawing one. */
  undither = false;

  drawPic(pic: Picture, clear = true) {
    if (clear) { this.bgVisual.fill(0xFF); this.bgPriority.fill(0); this.control.fill(0); }
    this.bgVisual.set(pic.visual);
    this.bgPriority.set(pic.priority);
    this.control.set(pic.control);
    this.restore();
    this.dirty = true;
  }

  /** Put the background back, ready for this frame's cast. */
  restore() {
    this.visual.set(this.bgVisual);
    this.priority.set(this.bgPriority);
  }

  /** Bake a cel into the background, as AddToPic does. */
  addToPic(cel: Cel, left: number, top: number, priority: number) {
    this.blit(this.bgVisual, this.bgPriority, cel, left, top, priority, true);
    this.restore();
    this.dirty = true;
  }

  /**
   * Draw a cel over the picture.
   *
   * `writePriority` records the cel's own priority in the plane as it
   * goes, which is what keeps two sprites in the right order where they
   * overlap: without it, whichever is drawn second wins every pixel.
   */
  drawCel(cel: Cel, left: number, top: number, priority: number, writePriority = false) {
    this.blit(this.visual, this.priority, cel, left, top, priority, writePriority);
    this.dirty = true;
  }

  private blit(vis: Uint8Array, pri: Uint8Array, cel: Cel,
               left: number, top: number, priority: number, writePriority: boolean) {
    for (let y = 0; y < cel.height; y++) {
      const py = top + y;
      if (py < 0 || py >= HEIGHT) continue;
      for (let x = 0; x < cel.width; x++) {
        const px = left + x;
        if (px < 0 || px >= WIDTH) continue;
        const v = cel.pixels[y * cel.width + x];
        if (v === cel.key) continue;
        const i = py * WIDTH + px;
        if (priority < pri[i]) continue;
        // A cel index is one colour; the pair byte keeps the renderer's
        // two paths identical for pictures and for sprites.
        vis[i] = v < 16 ? ((v << 4) | v) : v;
        if (writePriority) pri[i] = priority;
      }
    }
  }

  /** Draw a string with a decoded font, one glyph at a time. */
  text(font: Font, s: string, x: number, y: number, colour: number): number {
    let cx = x;
    for (const ch of s) {
      const g = font.chars[ch.charCodeAt(0)];
      if (!g) continue;
      for (let gy = 0; gy < g.height; gy++) {
        const py = y + gy;
        if (py < 0 || py >= HEIGHT) continue;
        for (let gx = 0; gx < g.width; gx++) {
          if (!g.bits[gy * g.width + gx]) continue;
          const px = cx + gx;
          if (px < 0 || px >= WIDTH) continue;
          this.visual[py * WIDTH + px] = (colour << 4) | colour;
        }
      }
      cx += g.width;
    }
    this.dirty = true;
    return cx - x;
  }

  /** Copy a rectangle out, so a window can put back what it covered. */
  save(x0: number, y0: number, x1: number, y1: number) {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(WIDTH, x1); y1 = Math.min(HEIGHT, y1);
    const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
    const buf = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      buf.set(this.visual.subarray((y0 + y) * WIDTH + x0, (y0 + y) * WIDTH + x1), y * w);
    return { x0, y0, w, h, buf };
  }

  restoreRect(r: { x0: number; y0: number; w: number; h: number; buf: Uint8Array }) {
    for (let y = 0; y < r.h; y++)
      this.visual.set(r.buf.subarray(y * r.w, (y + 1) * r.w), (r.y0 + y) * WIDTH + r.x0);
    this.dirty = true;
  }

  fill(x0: number, y0: number, x1: number, y1: number, colour: number) {
    for (let y = Math.max(0, y0); y < Math.min(HEIGHT, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(WIDTH, x1); x++)
        this.visual[y * WIDTH + x] = (colour << 4) | colour;
    this.dirty = true;
  }

  frame(x0: number, y0: number, x1: number, y1: number, colour: number) {
    for (let x = x0; x < x1; x++) { this.px(x, y0, colour); this.px(x, y1 - 1, colour); }
    for (let y = y0; y < y1; y++) { this.px(x0, y, colour); this.px(x1 - 1, y, colour); }
  }
  private px(x: number, y: number, c: number) {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
    this.visual[y * WIDTH + x] = (c << 4) | c;
  }

  /**
   * RGB for display, with the status line above the picture.
   *
   * Dithered output alternates the pair per pixel the way the hardware
   * did; undithered blends it, which is the same choice the explorer
   * offers on a picture.
   */
  /**
   * Write the status line.
   *
   * The text was being kept and never drawn, which left a black band
   * across the top of every game where the original shows the score.
   */
  drawStatus(font: Font | null, text: string) {
    this.status = text;
    this.statusBar.fill(0xFF);
    if (!font) return;
    let cx = 2;
    const top = Math.max(0, (STATUS_HEIGHT - font.lineHeight) >> 1);
    for (const ch of text) {
      const g = font.chars[ch.charCodeAt(0)];
      if (!g) continue;
      for (let gy = 0; gy < g.height; gy++) {
        const py = top + gy;
        if (py < 0 || py >= STATUS_HEIGHT) continue;
        for (let gx = 0; gx < g.width; gx++) {
          if (!g.bits[gy * g.width + gx]) continue;
          const px = cx + gx;
          if (px < 0 || px >= WIDTH) continue;
          this.statusBar[py * WIDTH + px] = 0x00;
        }
      }
      cx += g.width;
      if (cx >= WIDTH) break;
    }
    this.dirty = true;
  }

  rgb(out = new Uint8Array(WIDTH * SCREEN_HEIGHT * 3)): Uint8Array {
    for (let y = 0; y < STATUS_HEIGHT; y++)
      for (let x = 0; x < WIDTH; x++) {
        const c = EGA_RGB[ditherPixel(this.statusBar[y * WIDTH + x], x, y)];
        const o = (y * WIDTH + x) * 3;
        out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
      }
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const v = this.visual[y * WIDTH + x];
        const c = this.undither ? BLENDED_RGB[v] : EGA_RGB[ditherPixel(v, x, y)];
        const o = ((y + STATUS_HEIGHT) * WIDTH + x) * 3;
        out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
      }
    }
    return out;
  }
}
