/**
 * Search the extracted model for a route through the game.
 *
 * State is (room, values of the globals anything tests).  Actions are the
 * parser commands a room handles: a command applies its own effects, plus
 * the effects of any state machine it starts via `setScript`, and may
 * move the player.  Walking between connected rooms is always allowed.
 *
 * Everything here is only as good as the model underneath it, so the
 * search is deliberately *optimistic*: where an effect writes a value the
 * disassembly could not pin down, the global becomes unknown and later
 * tests against it are treated as satisfiable.  Steps that depended on
 * such an assumption are flagged in the plan rather than hidden, because
 * they are exactly the ones most likely to be wrong.
 */
import type { Room, Condition, Effect } from './model.ts';

const CMP_OK: Record<string, (a: number, b: number) => boolean> = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '>': (a, b) => a > b,
  '<=': (a, b) => a <= b,
  '>=': (a, b) => a >= b,
};

export class Action {
  room: number; label: string;
  conditions: Condition[]; effects: Effect[]; gotos: number[];
  machine: string | null;
  constructor(room: number, label: string, conditions: Condition[],
              effects: Effect[], gotos: number[], machine: string | null = null) {
    this.room = room; this.label = label; this.conditions = conditions;
    this.effects = effects; this.gotos = gotos; this.machine = machine;
  }
}

/** 'clawScript.setScript(clawScript)' -> 'clawScript' (the argument). */
function machineFor(call: string): string | null {
  if (!call.includes('.setScript(')) return null;
  const arg = call.split('(').slice(1).join('(').replace(/\)[^)]*$/, '');
  const first = arg.split(',')[0].trim();
  return first || null;
}

export function compileActions(models: Map<number, Room>):
    { perRoom: Map<number, Action[]>; tracked: string[] } {
  const perRoom = new Map<number, Action[]>();
  const tracked = new Set<string>();
  for (const [rn, room] of models) {
    if (room.picture === null) continue;
    const acts: Action[] = [];
    for (const c of room.commands) {
      const conds = c.conditions.map(x => [...x] as Condition);
      const effs = c.effects.map(x => [...x] as Effect);
      const gotos = [...c.goto];
      let machine: string | null = null;
      for (const call of c.calls) {
        const name = machineFor(call);
        const states = name ? room.machines.get(name) : undefined;
        if (!states) continue;
        machine = name;
        for (const st of states) {
          effs.push(...st.effects.map(e => [...e] as Effect));
          gotos.push(...st.goto);
        }
      }
      acts.push(new Action(rn, c.text, conds, effs, gotos, machine));
      for (const [a, op] of conds) if (op in CMP_OK) tracked.add(a);
    }

    // A room's state machines are not all reachable through a parser
    // command: cutscenes are started by the room's own init, so a room
    // with no commands can still move the player.  Offer each machine as
    // an action, marked so the plan shows it was not something typed.
    const started = new Set(acts.map(a => a.machine).filter(Boolean) as string[]);
    for (const [name, states] of room.machines) {
      if (started.has(name)) continue;
      const effs: Effect[] = [], gotos: number[] = [], conds: Condition[] = [];
      for (const st of states) {
        effs.push(...st.effects.map(e => [...e] as Effect));
        gotos.push(...st.goto);
        conds.push(...st.conditions.map(c => [...c] as Condition));
      }
      if (!effs.length && !gotos.length) continue;
      acts.push(new Action(rn, `(${name} runs)`, [], effs, gotos, name));
      for (const [a, op] of conds) if (op in CMP_OK) tracked.add(a);
    }
    perRoom.set(rn, acts);
  }
  // Only track globals that something also writes; the rest never change.
  const written = new Set<string>();
  for (const acts of perRoom.values())
    for (const act of acts) for (const [a] of act.effects) written.add(a);
  return { perRoom, tracked: [...tracked].filter(t => written.has(t)).sort() };
}

export type StepHow = ['walk' | 'do', string, boolean, number];

export class Plan {
  steps: Array<[StepHow, number]> = [];
  states = 0;
  blocked = new Map<string, number>();
  roomsSeen = new Set<number>();
}

/** Does `flags` meet these conditions? -> [ok, usedAnAssumption] */
function satisfied(conds: Condition[], flags: Map<string, number | null>):
    [boolean, boolean] {
  let assumed = false;
  for (const [name, op, val] of conds) {
    if (!(op in CMP_OK)) continue;          // a bare read constrains nothing
    const cur = flags.has(name) ? flags.get(name)! : 0;
    if (cur === null) { assumed = true; continue; }   // written, value unknown
    if (typeof val !== 'number') { assumed = true; continue; }
    if (!CMP_OK[op](cur, val)) return [false, assumed];
  }
  return [true, assumed];
}

function apply(effects: Effect[], flags: Map<string, number | null>,
               tracked: ReadonlySet<string>): Map<string, number | null> {
  const out = new Map(flags);
  for (const [name, , val] of effects) {
    if (!tracked.has(name)) continue;
    out.set(name, typeof val === 'number' ? val : null);
  }
  return out;
}

/** Breadth-first search for a route from `start` to `goal`. */
export function plan(models: Map<number, Room>, start: number, goal: number,
                     maxStates = 400000): { result: Plan; tracked: string[] } {
  const { perRoom, tracked } = compileActions(models);
  const trackedSet = new Set(tracked);
  // Walking must not include transitions that only happen because the
  // player typed something: Room.exits folds those in, so subtract them
  // back out or the planner gets rooms for free that the game gates
  // behind a command.
  const exits = new Map<number, number[]>();
  for (const [rn, r] of models) {
    if (r.picture === null) continue;
    const typed = new Set<number>();
    for (const c of r.commands) for (const g of c.goto) typed.add(g);
    for (const sts of r.machines.values()) for (const st of sts) for (const g of st.goto) typed.add(g);
    exits.set(rn, r.exits.filter(e => perRoom.has(e) && !typed.has(e)));
  }
  const result = new Plan();
  if (!perRoom.has(start)) return { result, tracked };

  const key = (room: number, vals: Array<number | null>) => `${room}|${vals.join(',')}`;
  const initVals: Array<number | null> = tracked.map(() => 0);
  const startKey = key(start, initVals);
  const seen = new Set([startKey]);
  const prev = new Map<string, [string, StepHow] | null>([[startKey, null]]);
  const info = new Map<string, [number, Array<number | null>]>([[startKey, [start, initVals]]]);
  const q: string[] = [startKey];

  while (q.length) {
    const sk = q.shift()!;
    const [room, vals] = info.get(sk)!;
    result.roomsSeen.add(room);
    result.states++;
    if (room === goal) {
      const chain: Array<[StepHow, number]> = [];
      let step = sk;
      for (;;) {
        const p = prev.get(step);
        if (!p) break;
        const [parent, how] = p;
        chain.push([how, info.get(step)![0]]);
        step = parent;
      }
      result.steps = chain.reverse();
      return { result, tracked };
    }
    if (result.states > maxStates) break;
    const flags = new Map<string, number | null>();
    tracked.forEach((g, i) => flags.set(g, vals[i]));

    for (const dest of exits.get(room) ?? []) {
      const nk = key(dest, vals);
      if (seen.has(nk)) continue;
      seen.add(nk);
      prev.set(nk, [sk, ['walk', `go to room ${dest}`, false, room]]);
      info.set(nk, [dest, vals]);
      q.push(nk);
    }

    for (const act of perRoom.get(room) ?? []) {
      const [ok, assumed] = satisfied(act.conditions, flags);
      if (!ok) { result.blocked.set(act.label, (result.blocked.get(act.label) ?? 0) + 1); continue; }
      const nf = apply(act.effects, flags, trackedSet);
      const nvals = tracked.map(g => nf.get(g) ?? 0);
      const dests = act.gotos.length ? act.gotos : [room];
      for (const dest of dests) {
        if (!perRoom.has(dest)) continue;
        const nk = key(dest, nvals);
        if (seen.has(nk)) continue;
        seen.add(nk);
        prev.set(nk, [sk, ['do', act.label, assumed, room]]);
        info.set(nk, [dest, nvals]);
        q.push(nk);
      }
    }
  }
  return { result, tracked };
}

export function describe(result: Plan, tracked: string[]): string {
  const lines = [`tracked globals: ${tracked.length}  (${tracked.slice(0, 12).join(', ')})`];
  if (!result.steps.length) {
    lines.push(`no route found after ${result.states} states, ${result.roomsSeen.size} rooms visited`);
  } else {
    lines.push(`route: ${result.steps.length} steps, ${result.states} states explored`);
    result.steps.forEach(([how, dest], i) => {
      const [kind, label, assumed, src] = how;
      const flag = assumed ? '  [assumed]' : '';
      if (kind === 'walk') lines.push(`${String(i + 1).padStart(3)}. ${label}${flag}`);
      else lines.push(`${String(i + 1).padStart(3)}. in room ${String(src).padEnd(4)} type: ` +
                      `${label.padEnd(44)} -> room ${dest}${flag}`);
    });
  }
  const worst = [...result.blocked].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (worst.length) {
    lines.push('');
    lines.push('most often blocked by unmet conditions:');
    for (const [label, n] of worst)
      lines.push(`   ${String(n).padStart(5)}x  ${label.slice(0, 70)}`);
  }
  return lines.join('\n');
}
