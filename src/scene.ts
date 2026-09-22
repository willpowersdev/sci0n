/**
 * Composite a room's sprites onto its background.
 *
 * A room script declares its props as instances carrying static `view`,
 * `loop`, `cel`, `x`, `y`, `z` and `priority` properties, so a whole
 * scene can be reassembled from data alone -- no interpreter needed.
 *
 * Placement follows SCI's convention that (x, y) is the sprite's bottom
 * centre:
 *
 *     left   = x + displaceX - (width >> 1)
 *     bottom = y + displaceY - z + 1
 *
 * with displaceX signed but displaceY *unsigned*, and displaceX negated
 * on mirrored loops.  A cel pixel is drawn only where its priority is at
 * least the pic's priority value there, which is what beds sprites into
 * scenery instead of pasting them on top.
 */
import type { Game } from './resources.ts';
import { Script, SciObject, Index } from './script.ts';
import { Picture, WIDTH, HEIGHT } from './pic.ts';
import { View, type Cel } from './view.ts';
import { EGA_RGB, BLENDED_RGB } from './ega.ts';
import { InitAnalysis, type Override } from './interp.ts';
import { picHistogram, unditherCel } from './undither.ts';

export const DEFAULT_BANDS = [42, 53, 64, 74, 85, 95, 106, 116, 127, 138, 148, 159, 169, 180];

/** Property words are signed: sprites are routinely parked off-screen so
 *  they can slide in. */
const s16 = (v: number) => (v & 0x8000) ? v - 0x10000 : v;

export interface Sprite {
  name: string; view: number; loop: number; cel: number;
  x: number; y: number; z: number; priority: number;
  fromInit: string[];
}

export interface Placed extends Sprite {
  pixels: number; rect: [number, number, number, number];
  size: [number, number];
}

export interface SceneOptions {
  room?: string; applyInit?: boolean; undither?: boolean;
}

export class Scene {
  game: Game; index: Index; script: Script; room: SciObject;
  picture: number; pic: Picture; bands: number[];
  placed: Placed[] = [];
  skipped: Array<[string, string]> = [];
  overrides = new Map<string, Override>();
  initStats: { sends: number; unresolved: number } = { sends: 0, unresolved: 0 };
  unditherStats = { cels: 0, combinations: 0 };
  private undither: boolean;
  private picHist: Int32Array | null = null;

  constructor(game: Game, index: Index, scriptNumber: number, opts: SceneOptions = {}) {
    this.game = game; this.index = index;
    this.undither = opts.undither ?? false;
    const d = game.tryData('script', scriptNumber);
    if (!d) throw new Error(`script ${scriptNumber} missing`);
    this.script = new Script(d, scriptNumber);
    const room = this.findRoom(opts.room);
    if (!room) throw new Error(`script ${scriptNumber} declares no room object`);
    this.room = room;
    const props = this.propsOf(room);
    const picture = props.get('picture');
    if (!picture || picture === 0xFFFF)
      throw new Error(`room ${room.name} has no static picture`);
    this.picture = picture;
    const pd = game.tryData('pic', picture);
    if (!pd) throw new Error(`pic ${picture} missing`);
    this.pic = new Picture(pd);
    this.bands = this.pic.priorityBands ?? DEFAULT_BANDS;
    if (opts.applyInit ?? true) {
      const ia = new InitAnalysis(this.script, index, room);
      this.overrides = ia.run();
      this.initStats = { sends: ia.sends, unresolved: ia.unresolved };
    }
  }

  private propsOf(o: SciObject): Map<string, number> {
    const names = o.propertyNames(this.index);
    const m = new Map<string, number>();
    names.forEach((n, i) => m.set(n, o.properties[i]));
    return m;
  }

  private findRoom(want?: string): SciObject | null {
    for (const o of this.script.objects) {
      const props = this.propsOf(o);
      if (!props.has('picture') || o.name.startsWith('<anon')) continue;
      if (want === undefined || o.name === want) return o;
    }
    return null;
  }

  /**
   * Sierra's y -> priority band.
   *
   * The 14 band coordinates are the *start* of bands 1..14, so the
   * priority is the count of thresholds at or above which y sits -- not
   * that count plus one.
   */
  priorityFor(y: number): number {
    return Math.max(1, Math.min(15, this.bands.filter(b => b <= y).length));
  }

  sprites(): Sprite[] {
    const out: Sprite[] = [];
    for (const o of this.script.instances()) {
      const d = this.propsOf(o);
      const v = d.get('view');
      if (!v || v === 0xFFFF) continue;
      const sp: Sprite = {
        name: o.name, view: v, loop: d.get('loop') ?? 0, cel: d.get('cel') ?? 0,
        x: s16(d.get('x') ?? 0), y: s16(d.get('y') ?? 0), z: s16(d.get('z') ?? 0),
        priority: d.get('priority') ?? 0xFFFF, fromInit: [],
      };
      const ov = this.overrides.get(o.name);
      if (ov) {
        if (ov.hidden) { this.skipped.push([o.name, 'hidden by init']); continue; }
        for (const f of ['x', 'y', 'z', 'view', 'loop', 'cel', 'priority'] as const) {
          const val = ov[f];
          if (val === undefined) continue;
          (sp as Record<string, unknown>)[f] =
            (f === 'x' || f === 'y' || f === 'z') ? s16(val as number) : val;
          sp.fromInit.push(f);
        }
      }
      if (sp.x === 0 && sp.y === 0) {
        this.skipped.push([o.name, 'no position in data or init']);
        continue;
      }
      if (sp.priority === 0xFFFF || sp.priority === 0) sp.priority = this.priorityFor(sp.y);
      out.push(sp);
    }
    out.sort((a, b) => a.priority - b.priority);
    return out;
  }

  private blit(buf: Uint8Array, cel: Cel, x: number, y: number, z: number, pr: number):
      [number, [number, number, number, number]] {
    const dx = cel.mirrored ? -cel.xShift : cel.xShift;
    const dy = cel.yShift >= 0 ? cel.yShift : cel.yShift + 256;
    const left = x + dx - (cel.width >> 1);
    const bottom = y + dy - z + 1;
    const top = bottom - cel.height;
    let drawn = 0;
    for (let row = 0; row < cel.height; row++) {
      const py = top + row;
      if (py < 0 || py >= HEIGHT) continue;
      const base = row * cel.width;
      for (let col = 0; col < cel.width; col++) {
        const px = left + col;
        if (px < 0 || px >= WIDTH) continue;
        const v = cel.pixels[base + col];
        if (v === cel.key || pr < this.pic.priority[py * WIDTH + px]) continue;
        const o = (py * WIDTH + px) * 3;
        const c = v < 16 ? EGA_RGB[v] : BLENDED_RGB[v];
        buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2];
        drawn++;
      }
    }
    return [drawn, [left, top, left + cel.width, bottom]];
  }

  /**
   * RGB bytes of the populated room.
   *
   * The report arrays are cleared first so a second call describes that
   * call: rendering twice used to append to them and double every count.
   */
  render(exclude: ReadonlySet<string> = new Set()): Uint8Array {
    this.placed = [];
    this.skipped = [];
    this.unditherStats = { cels: 0, combinations: 0 };
    let buf: Uint8Array;
    if (this.undither) {
      this.picHist = picHistogram(this.pic);
      buf = this.pic.unditheredRGB();
    } else {
      buf = this.pic.visualRGB();
    }
    for (const sp of this.sprites()) {
      if (exclude.has(sp.name)) continue;
      const rd = this.game.tryData('view', sp.view);
      if (!rd) { this.skipped.push([sp.name, `view ${sp.view} missing`]); continue; }
      const v = new View(rd);
      const loop = sp.loop < v.loops.length ? sp.loop : 0;
      const cels = loop < v.loops.length ? v.loops[loop] : [];
      if (!cels.length) { this.skipped.push([sp.name, 'empty loop']); continue; }
      const cel = cels[sp.cel < cels.length ? sp.cel : 0];
      if (this.undither && this.picHist) {
        const n = unditherCel(cel, this.picHist);
        if (n) { this.unditherStats.cels++; this.unditherStats.combinations += n; }
      }
      const [drawn, rect] = this.blit(buf, cel, sp.x, sp.y, sp.z, sp.priority);
      this.placed.push({ ...sp, pixels: drawn, rect, size: [cel.width, cel.height] });
    }
    return buf;
  }
}
