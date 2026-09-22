/**
 * Differential test for the analysis layer: room graph, room links, the
 * per-room behavioural model, and the planner's action compilation.
 *
 * The model digest is over each room's serialised form -- exits,
 * objects, every Said command with its conditions, effects, calls and
 * printed lines, and every state machine -- so a drift in any one of the
 * abstract-interpretation rules shows up.
 *
 * `roomgraph.layout` is not covered: it is seeded from Python's Mersenne
 * Twister there and from a small generator here, so the coordinates
 * differ by construction while the graph does not.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import * as RG from '../src/roomgraph.ts';
import * as RL from '../src/roomlinks.ts';
import { build } from '../src/model.ts';
import { compileActions } from '../src/planner.ts';
import { ROOT } from './games.ts';

const fx = JSON.parse(readFileSync('fixtures/model.json', 'utf8'));
function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}
/**
 * Match Python's json.dumps output byte for byte.
 *
 * `sortKeys` mirrors the flag: the model digest is taken with it on, but
 * the link map is dumped from a dict built in numeric key order and left
 * unsorted, and sorting "10" before "2" there would change the bytes
 * without anything being wrong.
 */
function pyJSON(v: unknown, sortKeys = true): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(x => pyJSON(x, sortKeys)).join(', ') + ']';
  const o = v as Record<string, unknown>;
  const keys = sortKeys ? Object.keys(o).sort() : Object.keys(o);
  return '{' + keys.map(k => `${JSON.stringify(k)}: ${pyJSON(o[k], sortKeys)}`).join(', ') + '}';
}

let bad = 0, allHandlers = 0, allModels = 0;
for (const name of Object.keys(fx).sort()) {
  const want = fx[name];
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);

  const rooms = RG.collect(g, idx);
  const disp = RG.dispatchers(rooms);
  const eds = RG.edges(rooms, disp);
  const comps = RG.components([...rooms.keys()].sort((a, b) => a - b), eds);
  const { links, stats: lstats } = RL.build(g, idx);
  const { models, stats: mstats } = build(g, idx);

  const h = createHash('sha1');
  for (const n of [...models.keys()].sort((a, b) => a - b))
    h.update(Buffer.from(pyJSON(models.get(n)!.toJSON()), 'utf8'));
  // Python sorts the tuples themselves: number, then string, then number.
  const sortedEdges = eds.map(([a, k, b]) => [a, k, b] as [number, string, number])
    .sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || x[2] - y[2]);
  const eh = createHash('sha1').update(Buffer.from(pyJSON(sortedEdges), 'utf8'));
  const linkObj: Record<string, number[]> = {};
  for (const k of [...links.keys()].sort((a, b) => a - b))
    linkObj[String(k)] = [...links.get(k)!].sort((a, b) => a - b);
  const lh = createHash('sha1').update(Buffer.from(pyJSON(linkObj, false), 'utf8'));
  const { perRoom, tracked } = compileActions(models);
  let actions = 0;
  for (const v of perRoom.values()) actions += v.length;

  const got = {
    rooms: rooms.size, dispatchers: disp.size, edges: eds.length,
    components: comps.map(c => c.length).slice(0, 5),
    edge_digest: eh.digest('hex').slice(0, 16),
    link_digest: lh.digest('hex').slice(0, 16),
    links_static: lstats.static, links_dynamic: lstats.dynamic,
    models: models.size, handlers: mstats.handlers,
    said_blocks: mstats.saidBlocks, unlinked: mstats.unlinked,
    printer: mstats.printer ? [...mstats.printer] : null,
    model_digest: h.digest('hex').slice(0, 16),
    actions, tracked,
  };
  const diffs = Object.keys(got).filter(k =>
    pyJSON((got as Record<string, unknown>)[k]) !== pyJSON(want[k]));
  if (diffs.length) bad++;
  allHandlers += mstats.handlers; allModels += models.size;
  console.log(`${name.padEnd(9)} ${String(rooms.size).padStart(3)} rooms · ` +
    `${String(eds.length).padStart(4)} edges · ${String(mstats.handlers).padStart(4)} handlers · ` +
    `${String(models.size).padStart(3)} models · ${tracked.length} tracked · ` +
    (diffs.length ? `MISMATCH in ${diffs.join(', ')}` : 'match'));
  for (const d of diffs.slice(0, 3))
    console.log(`            ${d}: got ${pyJSON((got as Record<string, unknown>)[d]).slice(0, 90)}` +
                ` want ${pyJSON(want[d]).slice(0, 90)}`);
}
console.log(`\n${allModels} room models (${allHandlers} Said handlers) compared, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
