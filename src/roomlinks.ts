/**
 * Recover room transitions from compiled script code.
 *
 * A room change is `(someRoom newRoom: N)`, which the compiler emits as
 *
 *     pushi  <newRoom selector>
 *     pushi  1                     ; one argument
 *     pushi  N                     ; the destination room
 *     ...                          ; load the target into the accumulator
 *     send   6
 *
 * so the destination is a literal in the instruction stream.  Walking the
 * code with a validated disassembler makes those literals safe to read --
 * scanning raw bytes for the pattern would also match operand bytes that
 * happen to look like a push.
 *
 * Transitions whose argument is computed at run time are reported
 * separately; they cannot be resolved without executing the game.
 */
import { Script, type Index } from './script.ts';
import { sweep, type Instruction } from './disasm.ts';
import type { Game } from './resources.ts';

function literal(ins: Instruction): number | null {
  switch (ins.name) {
    case 'pushi': return ins.args[0];
    case 'push0': return 0;
    case 'push1': return 1;
    case 'push2': return 2;
    default: return null;
  }
}

/** Static targets and the count of run-time-computed ones, for one script. */
export function scanScript(script: Script, newRoomSel: number):
    { targets: Array<[number, number]>; dynamic: number } {
  const targets: Array<[number, number]> = [];
  let dynamic = 0;
  for (const [bname, off, size] of script.blocks) {
    if (bname !== 'code') continue;
    const [ins, ok] = sweep(script.data, off + 4, off + size);
    if (!ok) continue;
    for (let i = 0; i < ins.length; i++) {
      const cur = ins[i];
      if (cur.name !== 'pushi' || !cur.args.length || cur.args[0] !== newRoomSel) continue;
      const j = i + 1;
      if (j >= ins.length) continue;
      if (literal(ins[j]) !== 1) continue;      // one argument
      const k = j + 1;
      if (k >= ins.length) continue;
      const val = literal(ins[k]);
      if (val === null) dynamic++;
      else targets.push([cur.pc, val]);
    }
  }
  return { targets, dynamic };
}

export interface LinkStats {
  scripts: number; selector: number; static: number; dynamic: number;
  error?: string;
}

/** links: script number -> the set of rooms it can send you to. */
export function build(game: Game, index: Index):
    { links: Map<number, Set<number>>; stats: LinkStats } {
  const sel = index.selectorId('newRoom');
  if (sel < 0)
    return { links: new Map(), stats: { scripts: 0, selector: -1, static: 0, dynamic: 0, error: 'no newRoom selector' } };
  const links = new Map<number, Set<number>>();
  let dynamic = 0, scanned = 0;
  for (const r of game.byType('script')) {
    let s: Script;
    try { s = new Script(game.data(2, r.number), r.number); } catch { continue; }
    scanned++;
    const { targets, dynamic: d } = scanScript(s, sel);
    dynamic += d;
    if (!targets.length) continue;
    let set = links.get(r.number);
    if (!set) { set = new Set(); links.set(r.number, set); }
    for (const [, v] of targets) set.add(v);
  }
  let total = 0;
  for (const v of links.values()) total += v.size;
  return { links, stats: { scripts: scanned, selector: sel, static: total, dynamic } };
}
