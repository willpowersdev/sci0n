/**
 * Build a room-connectivity graph from static exit properties.
 *
 * The north/south/east/west selectors on a room object record *which
 * screen edge you walk off*, not the compass bearing of the destination
 * -- two rooms routinely both exit "south" into each other.  So this
 * produces a topology graph, not a map.
 */
import { Script, type Index } from './script.ts';
import type { Game } from './resources.ts';

export const DIRS = ['north', 'south', 'east', 'west'] as const;
export type Dir = typeof DIRS[number];
export const SHORT: Record<Dir, string> = { north: 'N', south: 'S', east: 'E', west: 'W' };

export interface Room {
  name: string;
  picture: number | undefined;
  exits: Map<Dir, number>;
}
export type Edge = [number, Dir, number];

/** Every room object in the game, by script number. */
export function collect(game: Game, index: Index): Map<number, Room> {
  const rooms = new Map<number, Room>();
  for (const r of game.byType('script')) {
    let s: Script;
    try { s = new Script(game.data(2, r.number), r.number); } catch { continue; }
    for (const o of s.objects) {
      const names = o.propertyNames(index);
      const d = new Map<string, number>();
      names.forEach((n, i) => { d.set(n, o.properties[i]); });
      if (!d.has('picture') || o.name.startsWith('<anon')) continue;
      const exits = new Map<Dir, number>();
      for (const k of DIRS) {
        const v = d.get(k);
        if (v === undefined || v === 0 || v === 0xFFFF) continue;
        exits.set(k, v);
      }
      rooms.set(r.number, { name: o.name, picture: d.get('picture'), exits });
    }
  }
  return rooms;
}

/** Rooms referenced as an exit far more often than they are a place. */
export function dispatchers(rooms: Map<number, Room>, threshold = 5): Set<number> {
  const count = new Map<number, number>();
  for (const { exits } of rooms.values())
    for (const t of exits.values()) count.set(t, (count.get(t) ?? 0) + 1);
  const out = new Set<number>();
  for (const [t, c] of count) {
    if (c >= threshold) out.add(t);
    else {
      const r = rooms.get(t);
      if (r && (r.picture === 0 || r.picture === undefined)) out.add(t);
    }
  }
  return out;
}

export function edges(rooms: Map<number, Room>, skip: ReadonlySet<number>): Edge[] {
  const out: Edge[] = [];
  for (const [a, { exits }] of rooms)
    for (const [k, b] of exits)
      if (rooms.has(b) && !skip.has(b) && a !== b) out.push([a, k, b]);
  return out;
}

/** Connected components, largest first. */
export function components(nodes: number[], links: Edge[]): number[][] {
  const parent = new Map<number, number>();
  for (const n of nodes) parent.set(n, n);
  const find = (x: number): number => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (const [a, , b] of links) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<number, number[]>();
  for (const n of nodes) {
    const r = find(n);
    const g = groups.get(r);
    if (g) g.push(n); else groups.set(r, [n]);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/**
 * A small deterministic generator.
 *
 * The reference uses Python's Mersenne Twister; reproducing its stream
 * here would mean carrying an MT19937 just to place dots, so the layout
 * is seeded independently.  The graph itself -- rooms, exits,
 * dispatchers, components -- is identical either way; only the pixel
 * coordinates differ, which is why the differential test digests the
 * structure and not the positions.
 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fruchterman-Reingold, with a light downward pull along 'south' edges so
 * the picture reads top-to-bottom where the data allows it.
 */
export function layout(nodes: number[], links: Edge[], width: number, height: number,
                       iterations = 600, seed = 7): Map<number, [number, number]> {
  const rnd = mulberry32(seed);
  if (nodes.length === 1) return new Map([[nodes[0], [width / 2, height / 2]]]);
  const pos = new Map<number, [number, number]>();
  for (const n of nodes) pos.set(n, [rnd() * width, rnd() * height]);
  const k = Math.sqrt(width * height / nodes.length);
  const adj = links.filter(([a, , b]) => pos.has(a) && pos.has(b));
  let temp = width / 8;

  for (let step = 0; step < iterations; step++) {
    const disp = new Map<number, [number, number]>();
    for (const n of nodes) disp.set(n, [0, 0]);
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i], pa = pos.get(a)!, da = disp.get(a)!;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j], pb = pos.get(b)!, db = disp.get(b)!;
        let dx = pa[0] - pb[0], dy = pa[1] - pb[1];
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = rnd() * 2 - 1; dy = rnd() * 2 - 1; d2 = 1; }
        const f = k * k / d2;
        da[0] += dx * f; da[1] += dy * f;
        db[0] -= dx * f; db[1] -= dy * f;
      }
    }
    for (const [a, , b] of adj) {
      const pa = pos.get(a)!, pb = pos.get(b)!;
      const dx = pa[0] - pb[0], dy = pa[1] - pb[1];
      const d = Math.hypot(dx, dy) || 0.01;
      const f = d * d / k;
      const ux = dx / d * f, uy = dy / d * f;
      const da = disp.get(a)!, db = disp.get(b)!;
      da[0] -= ux; da[1] -= uy;
      db[0] += ux; db[1] += uy;
    }
    for (const [a, kdir, b] of links) {
      if (kdir !== 'south' || !pos.has(a) || !pos.has(b)) continue;
      disp.get(a)![1] -= k * 0.05;
      disp.get(b)![1] += k * 0.05;
    }
    for (const n of nodes) {
      const [dx, dy] = disp.get(n)!;
      const d = Math.hypot(dx, dy) || 1;
      const p = pos.get(n)!;
      p[0] += dx / d * Math.min(d, temp);
      p[1] += dy / d * Math.min(d, temp);
      p[0] = Math.min(width, Math.max(0, p[0]));
      p[1] = Math.min(height, Math.max(0, p[1]));
    }
    temp = Math.max(temp * 0.975, 0.5);
  }
  return pos;
}
