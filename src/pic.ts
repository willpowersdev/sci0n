/**
 * SCI0 pic resource -> visual / priority / control planes.
 *
 * A pic is a little vector program.  Opcodes 0xF0..0xFE drive a pen over
 * three 320x190 canvases at once; each opcode consumes arguments until
 * the next byte >= 0xF0, so argument lists are self-terminating.
 */
import { EGA_RGB, DEFAULT_PIC_PALETTE, DEFAULT_PRIORITY_TABLE, ditherPixel } from './ega.ts';

export const WIDTH = 320, HEIGHT = 190;

const OP_SET_COLOR = 0xF0, OP_DISABLE_VISUAL = 0xF1, OP_SET_PRIORITY = 0xF2,
      OP_DISABLE_PRIORITY = 0xF3, OP_SHORT_PATTERNS = 0xF4, OP_MEDIUM_LINES = 0xF5,
      OP_LONG_LINES = 0xF6, OP_SHORT_LINES = 0xF7, OP_FILL = 0xF8,
      OP_SET_PATTERN = 0xF9, OP_ABS_PATTERNS = 0xFA, OP_SET_CONTROL = 0xFB,
      OP_DISABLE_CONTROL = 0xFC, OP_MEDIUM_PATTERNS = 0xFD, OP_OPX = 0xFE,
      OP_TERMINATE = 0xFF;

const PATTERN_PENSIZE = 0x07, PATTERN_RECTANGLE = 0x10, PATTERN_USE_TEXTURE = 0x20;

/** Bit-packed circle brushes, pen sizes 0..7, consumed LSB-first. */
const CIRCLES: number[][] = [
  [0x01],
  [0x72,0x02],
  [0xCE,0xF7,0x7D,0x0E],
  [0x1C,0x3E,0x7F,0x7F,0x7F,0x3E,0x1C,0x00],
  [0x38,0xF8,0xF3,0xDF,0x7F,0xFF,0xFD,0xF7,0x9F,0x3F,0x38],
  [0x70,0xC0,0x1F,0xFE,0xE3,0x3F,0xFF,0xF7,0x7F,0xFF,0xE7,0x3F,0xFE,0xC3,0x1F,0xF8,0x00],
  [0xF0,0x01,0xFF,0xE1,0xFF,0xF8,0x3F,0xFF,0xDF,0xFF,0xF7,0xFF,0xFD,0x7F,0xFF,0x9F,0xFF,
   0xE3,0xFF,0xF0,0x1F,0xF0,0x01],
  [0xE0,0x03,0xF8,0x0F,0xFC,0x1F,0xFE,0x3F,0xFE,0x3F,0xFF,0x7F,0xFF,0x7F,0xFF,0x7F,0xFF,
   0x7F,0xFF,0x7F,0xFE,0x3F,0xFE,0x3F,0xFC,0x1F,0xF8,0x0F,0xE0,0x03],
];

const TEXTURE_BYTES = [
  0x04,0x29,0x40,0x24,0x09,0x41,0x25,0x45,0x41,0x90,0x50,0x44,0x48,0x08,0x42,0x28,
  0x89,0x52,0x89,0x88,0x10,0x48,0xA4,0x08,0x44,0x15,0x28,0x24,0x00,0x0A,0x24,0x20,
];

/**
 * Sierra's interpreter drops the 256th bit, so the wrap-around copy is
 * offset by one.  Reproduce that exactly or textured brushes drift.
 */
const bits: boolean[] = [];
for (let i = 0; i < 32; i++) for (let j = 0; j < 8; j++)
  bits.push((TEXTURE_BYTES[i] & (1 << j)) !== 0);
export const TEXTURES: boolean[] = bits.slice(0, 255).concat(bits, [false]);

const TEXTURE_OFFSET = [
  0x00,0x18,0x30,0xC4,0xDC,0x65,0xEB,0x48,0x60,0xBD,0x89,0x04,0x0A,0xF4,0x7D,0x6D,
  0x85,0xB0,0x8E,0x95,0x1F,0x22,0x0D,0xDF,0x2A,0x78,0xD5,0x73,0x1C,0xB4,0x40,0xA1,
  0xB9,0x3C,0xCA,0x58,0x92,0x34,0xCC,0xCE,0xD7,0x42,0x90,0x0F,0x8B,0x7F,0x32,0xED,
  0x5C,0x9D,0xC8,0x99,0xAD,0x4E,0x56,0xA6,0xF7,0x68,0xB7,0x25,0x82,0x37,0x3A,0x51,
  0x69,0x26,0x38,0x52,0x9E,0x9A,0x4F,0xA7,0x43,0x10,0x80,0xEE,0x3D,0x59,0x35,0xCF,
  0x79,0x74,0xB5,0xA2,0xB1,0x96,0x23,0xE0,0xBE,0x05,0xF5,0x6E,0x19,0xC5,0x66,0x49,
  0xF0,0xD1,0x54,0xA9,0x70,0x4B,0xA4,0xE2,0xE6,0xE5,0xAB,0xE4,0xD2,0xAA,0x4C,0xE3,
  0x06,0x6F,0xC6,0x4A,0x75,0xA3,0x97,0xE1,
];

export class Picture {
  visual = new Uint8Array(WIDTH * HEIGHT).fill(0xFF);   // palette bytes; white
  priority = new Uint8Array(WIDTH * HEIGHT);
  control = new Uint8Array(WIDTH * HEIGHT);
  ops = 0;
  priorityBands: number[] | null = null;

  private color: number | null = null;
  private prio: number | null = null;
  private ctrl: number | null = null;

  constructor(data: Uint8Array) { this.draw(data); }

  private put(x: number, y: number) {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
    const i = y * WIDTH + x;
    if (this.color !== null) this.visual[i] = this.color;
    if (this.prio !== null) this.priority[i] = this.prio;
    if (this.ctrl !== null) this.control[i] = this.ctrl;
  }

  private visible(x: number, y: number) {
    return ditherPixel(this.visual[y * WIDTH + x], x, y);
  }

  visualRGB(): Uint8Array {
    const out = new Uint8Array(WIDTH * HEIGHT * 3);
    let i = 0, o = 0;
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const c = EGA_RGB[ditherPixel(this.visual[i++], x, y)];
      out[o++] = c[0]; out[o++] = c[1]; out[o++] = c[2];
    }
    return out;
  }

  private line(x1: number, y1: number, x2: number, y2: number) {
    const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this.put(x1, y1);
      if (x1 === x2 && y1 === y2) break;
      const e2 = err * 2;
      if (e2 > -dy) { err -= dy; x1 += sx; }
      if (e2 < dx) { err += dx; y1 += sy; }
    }
  }

  /** Rectangle brushes wrap off the right edge onto the next row with the
   *  dither pair swapped.  Sierra's quirk; keep it. */
  private boxPixel(x: number, y: number) {
    if (x < 0 || y < 0 || y >= HEIGHT) return;
    if (x < WIDTH) { this.put(x, y); return; }
    if (y >= HEIGHT - 1) return;
    const saved = this.color;
    if (this.color !== null)
      this.color = ((this.color & 0x0F) << 4) | (this.color >> 4);
    this.put(0, y + 1);
    this.color = saved;
  }

  private pattern(x: number, y: number, code: number, texture: number) {
    const size = code & PATTERN_PENSIZE;
    let left = x - size, top = y - size;
    const w = size * 2 + 2, h = size * 2 + 1;
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    if (left + w > WIDTH + 1) left = WIDTH + 1 - w;
    if (top + h > HEIGHT) top = HEIGHT - h;
    const right = left + w, bottom = top + h;
    const textured = (code & PATTERN_USE_TEXTURE) !== 0;
    let ti = textured ? TEXTURE_OFFSET[texture & 0x7F] : 0;

    if (code & PATTERN_RECTANGLE) {
      for (let py = top; py < bottom; py++)
        for (let px = left; px < right; px++) {
          let draw = true;
          if (textured) { draw = TEXTURES[ti]; ti++; }
          if (draw) this.boxPixel(px, py);
        }
    } else {
      const table = CIRCLES[size];
      let bi = 0, bitNo = 0, bitmap = table[0];
      for (let py = top; py < bottom; py++)
        for (let px = left; px < right; px++) {
          if (bitNo === 8) { bi++; bitmap = bi < table.length ? table[bi] : 0; bitNo = 0; }
          if (bitmap & 1) {
            if (!textured || TEXTURES[ti]) {
              if (px >= 0 && px < WIDTH && py >= 0 && py < HEIGHT) this.put(px, py);
            }
            if (textured) ti++;
          }
          bitNo++; bitmap >>= 1;
        }
    }
  }

  private fill(x: number, y: number) {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
    let maskV = this.color !== null, maskP = this.prio !== null, maskC = this.ctrl !== null;
    const sCol = this.visible(x, y);
    const sPri = this.priority[y * WIDTH + x];
    const sCon = this.control[y * WIDTH + x];

    // Sierra bails out on these rather than filling the whole screen.
    if (maskV) { if (this.color === 0xFF || sCol !== 0x0F) return; }
    else if (maskP) { if (this.prio === 0 || sPri !== 0) return; }
    else if (maskC) { if (this.ctrl === 0 || sCon !== 0) return; }
    else return;

    if (maskV && sCol === (this.color! & 0x0F)) maskV = false;
    if (maskP && sPri === this.prio) maskP = false;
    if (maskC && sCon === this.ctrl) maskC = false;
    if (!(maskV || maskP || maskC)) return;

    const match = maskV
      ? (px: number, py: number) => this.visible(px, py) === sCol
      : maskP
      ? (px: number, py: number) => this.priority[py * WIDTH + px] === sPri
      : (px: number, py: number) => this.control[py * WIDTH + px] === sCon;

    const stack: Array<[number, number]> = [[x, y]];
    while (stack.length) {
      const [px, py] = stack.pop()!;
      if (!match(px, py)) continue;
      this.put(px, py);
      let left = px, right = px;
      while (left > 0 && match(left - 1, py)) { left--; this.put(left, py); }
      while (right < WIDTH - 1 && match(right + 1, py)) { right++; this.put(right, py); }
      let aSet = false, bSet = false;
      for (let sx = left; sx <= right; sx++) {
        if (py > 0 && match(sx, py - 1)) {
          if (!aSet) { stack.push([sx, py - 1]); aSet = true; }
        } else aSet = false;
        if (py < HEIGHT - 1 && match(sx, py + 1)) {
          if (!bSet) { stack.push([sx, py + 1]); bSet = true; }
        } else bSet = false;
      }
    }
  }

  /** SCI01 pics can paste a view cel straight into the background. */
  private embeddedCel(d: Uint8Array, hp: number, ox: number, oy: number) {
    if (hp + 8 > d.length) return;
    const w = d[hp] | (d[hp + 1] << 8), h = d[hp + 2] | (d[hp + 3] << 8);
    const key = d[hp + 6];
    if (w <= 0 || h <= 0 || w > 320 || h > 200) return;
    const total = w * h;
    const pix = new Uint8Array(total);
    let q = hp + 8, n = 0;
    while (n < total && q < d.length) {
      const b = d[q++]; const run = b >> 4, colour = b & 0x0F;
      if (!run) continue;
      const end = Math.min(n + run, total);
      pix.fill(colour, n, end);
      n += run;
    }
    for (let row = 0; row < h; row++) {
      const y = oy + row;
      if (y < 0 || y >= HEIGHT) continue;
      for (let col = 0; col < w; col++) {
        const v = pix[row * w + col];
        if (v === key) continue;
        const x = ox + col;
        if (x >= 0 && x < WIDTH) this.visual[y * WIDTH + x] = (v << 4) | v;
      }
    }
  }

  private draw(d: Uint8Array) {
    const palettes = new Uint8Array(160);
    for (let i = 0; i < 4; i++) palettes.set(DEFAULT_PIC_PALETTE, i * 40);
    const prioTable = DEFAULT_PRIORITY_TABLE;
    const palNo = 0;
    let patCode = 0, patTexture = 0, p = 0;
    const n = d.length;

    const absCoords = (): [number, number] => {
      const pre = d[p];
      const x = d[p + 1] + ((pre & 0xF0) << 4);
      const y = d[p + 2] + ((pre & 0x0F) << 8);
      p += 3; return [x, y];
    };
    const relCoords = (x: number, y: number): [number, number] => {
      const b = d[p++];
      x += (b & 0x80) ? -((b >> 4) & 7) : (b >> 4);
      y += (b & 0x08) ? -(b & 7) : (b & 7);
      return [x, y];
    };
    const relCoordsMed = (x: number, y: number): [number, number] => {
      let b = d[p++];
      y += (b & 0x80) ? -(b & 0x7F) : b;
      b = d[p++];
      x += (b & 0x80) ? -(128 - (b & 0x7F)) : b;
      return [x, y];
    };
    const more = () => p < n && d[p] < 0xF0;
    const getTexture = () => {
      if (patCode & PATTERN_USE_TEXTURE) { patTexture = (d[p] >> 1) & 0x7F; p++; }
    };

    while (p < n) {
      const op = d[p++];
      this.ops++;
      let x: number, y: number, ox: number, oy: number;
      switch (op) {
        case OP_SET_COLOR: {
          const idx = palNo * 40 + d[p++];
          this.color = idx < palettes.length ? palettes[idx] : 0;
          break;
        }
        case OP_DISABLE_VISUAL: this.color = null; break;
        case OP_SET_PRIORITY: this.prio = prioTable[d[p++] & 0x0F]; break;
        case OP_DISABLE_PRIORITY: this.prio = null; break;
        case OP_SET_CONTROL: this.ctrl = d[p++] & 0x0F; break;
        case OP_DISABLE_CONTROL: this.ctrl = null; break;
        case OP_SET_PATTERN: patCode = d[p++] & 0x37; break;
        case OP_LONG_LINES:
          [ox, oy] = absCoords();
          while (more()) { [x, y] = absCoords(); this.line(ox, oy, x, y); ox = x; oy = y; }
          break;
        case OP_SHORT_LINES:
          [ox, oy] = absCoords();
          while (more()) { [x, y] = relCoords(ox, oy); this.line(ox, oy, x, y); ox = x; oy = y; }
          break;
        case OP_MEDIUM_LINES:
          [ox, oy] = absCoords();
          while (more()) { [x, y] = relCoordsMed(ox, oy); this.line(ox, oy, x, y); ox = x; oy = y; }
          break;
        case OP_FILL:
          while (more()) { [x, y] = absCoords(); this.fill(x, y); }
          break;
        case OP_ABS_PATTERNS:
          while (more()) { getTexture(); [x, y] = absCoords(); this.pattern(x, y, patCode, patTexture); }
          break;
        case OP_SHORT_PATTERNS:
          getTexture(); [x, y] = absCoords(); this.pattern(x, y, patCode, patTexture);
          while (more()) { getTexture(); [x, y] = relCoords(x, y); this.pattern(x, y, patCode, patTexture); }
          break;
        case OP_MEDIUM_PATTERNS:
          getTexture(); [x, y] = absCoords(); this.pattern(x, y, patCode, patTexture);
          while (more()) { getTexture(); [x, y] = relCoordsMed(x, y); this.pattern(x, y, patCode, patTexture); }
          break;
        case OP_OPX: {
          const ex = d[p++];
          if (ex === 0x00) {
            while (more()) { const i = d[p], v = d[p + 1]; p += 2; if (i < palettes.length) palettes[i] = v; }
          } else if (ex === 0x01) {
            const which = d[p++]; const base = which * 40;
            for (let i = 0; i < 40; i++) if (base + i < palettes.length) palettes[base + i] = d[p + i];
            p += 40;
          } else if (ex === 0x02) p += 41;
          else if (ex === 0x03 || ex === 0x05) p += 1;
          else if (ex === 0x07) {
            const pre = d[p];
            const vx = d[p + 1] + ((pre & 0xF0) << 4);
            const vy = d[p + 2] + ((pre & 0x0F) << 8);
            p += 3;
            const size = d[p] | (d[p + 1] << 8); p += 2;
            this.embeddedCel(d, p, vx, vy);
            p += size;
          } else if (ex === 0x08) {
            this.priorityBands = Array.from(d.subarray(p, p + 14));
            p += 14;
          }
          break;
        }
        case OP_TERMINATE: return;
        default: return;   // stray byte; stop cleanly
      }
    }
  }
}
