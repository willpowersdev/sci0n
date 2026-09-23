/**
 * The said block: a compiled pattern, and what it asks of a parse.
 *
 * A pattern is a run of 16-bit word-group ids with single operator
 * bytes between them, 0xf0 to 0xf9 standing for `, & / ( ) [ ] # < >`.
 * It divides into at most three parts at the slashes, and those parts
 * line up with the three the grammar assigns a typed line -- what is
 * being done, what to, and what with.  So `give/sword/knight` asks for
 * "give" in part one, "sword" in part two and "knight" in part three,
 * and the player may type either word order because the grammar has
 * already sorted them out.
 *
 * Within a part:
 *
 *   ,   alternatives -- any one of them will do
 *   ( ) grouping
 *   [ ] optional, so its contents are never required
 *   <   a reference: `turn<on` wants both "turn" and "on", which is how
 *       a pattern distinguishes "turn on the belt" from "turn the belt"
 *   >   on the end of the pattern: match without claiming the event, so
 *       a later pattern still gets a chance at the same line
 *
 * Two group ids are not words.  0xfff is the vocabulary's `*`, which
 * any word satisfies, and 0xffe is its `!*`, satisfied only by silence.
 *
 * A part is satisfied by containment, not equality: `look/rock` matches
 * "look at the rock" even though part one also holds "at".  A part the
 * pattern does not mention is not looked at either, so `look` matches
 * "look at the rock" as well -- which is what lets a game write
 *
 *   (if (Said 'look>')
 *       (if (Said '/wall')  ...)
 *       (if (Said '[/!*]')  ...)   ; just "look" on its own
 *       (if (Said '/*')     ...))  ; "look" at anything else
 *
 * and have the outer test pass for every one of them.  Requiring a part
 * to be *empty* is what `!*` is for, and `*` is its opposite: some word
 * must have been said there.
 */
import type { Parse } from './grammar.ts';

const OR = 0xF0, AND = 0xF1, PART = 0xF2, OPEN = 0xF3, CLOSE = 0xF4;
const OPT_OPEN = 0xF5, OPT_CLOSE = 0xF6, HASH = 0xF7, REF = 0xF8, KEEP = 0xF9;

/** Any word will do. */
const ANY = 0xFFF;
/** Only silence will do. */
const NONE = 0xFFE;
/** The group of "the", which carries no meaning and is not looked for. */
const NULL_GROUP = 1;

type Expr =
  | { kind: 'word'; group: number }
  | { kind: 'all'; of: Expr[] }
  | { kind: 'any'; of: Expr[] }
  | { kind: 'opt'; of: Expr };

export interface Said {
  /** One entry per part written, so its length is what was written. */
  parts: Expr[];
  /** False when the pattern ends in `>` and must not spend the line. */
  claim: boolean;
}

/**
 * Read a compiled pattern.
 *
 * Recursive descent over the bytes: a part is a sequence of terms, each
 * a list of alternatives, each an atom that may carry a reference.
 */
export function parseSaid(spec: Uint8Array): Said {
  let i = 0;
  let claim = true;
  const peek = () => (i < spec.length ? spec[i] : -1);

  const atom = (): Expr | null => {
    const v = peek();
    if (v === OPEN || v === OPT_OPEN) {
      const close = v === OPEN ? CLOSE : OPT_CLOSE;
      i++;
      const inner = sequence(close);
      if (peek() === close) i++;
      return v === OPT_OPEN ? { kind: 'opt', of: inner } : inner;
    }
    if (v >= 0 && v < 0xF0) {
      const group = (spec[i] << 8) | (spec[i + 1] ?? 0);
      i += 2;
      return { kind: 'word', group };
    }
    return null;
  };

  /** One term: alternatives joined by `,`, with any `<` references. */
  const term = (): Expr | null => {
    const first = atom();
    if (!first) return null;
    const alts = [first];
    while (peek() === OR) { i++; const a = atom(); if (!a) break; alts.push(a); }
    let out: Expr = alts.length > 1 ? { kind: 'any', of: alts } : alts[0];
    // `a<b` wants both, and the reference itself may be a list.
    while (peek() === REF) {
      i++;
      const r = term();
      if (!r) break;
      out = { kind: 'all', of: [out, r] };
    }
    return out;
  };

  const sequence = (stop: number): Expr => {
    const of: Expr[] = [];
    for (;;) {
      const v = peek();
      if (v < 0 || v === PART || v === stop) break;
      if (v === AND || v === HASH) { i++; continue; }
      if (v === KEEP) { i++; claim = false; continue; }
      if (v === CLOSE || v === OPT_CLOSE) break;
      const t = term();
      if (!t) { i++; continue; }
      of.push(t);
    }
    return of.length === 1 ? of[0] : { kind: 'all', of };
  };

  const parts: Expr[] = [sequence(-1)];
  while (peek() === PART) { i++; parts.push(sequence(-1)); }
  // A trailing `>` lands after the last part.
  if (peek() === KEEP) { i++; claim = false; }
  return { parts, claim };
}

/**
 * Does this expression say the part it sits in was left unsaid?
 *
 * `!*` is an assertion about what is *not* there, and making it
 * optional cannot weaken it: "absent" and "empty" are the same
 * observation, so `[/!*]` asks exactly what `/!*` does.  Without this
 * an optional emptiness test would be vacuous, and a game's "just
 * look on its own" clause would answer for "look at the wall" too.
 */
function assertsEmpty(e: Expr): boolean {
  switch (e.kind) {
    case 'word': return e.group === NONE;
    case 'any': case 'all': return e.of.some(assertsEmpty);
    case 'opt': return assertsEmpty(e.of);
  }
}

/** Is every group this expression requires present among `said`? */
function satisfied(e: Expr, said: Set<number>): boolean {
  switch (e.kind) {
    case 'word':
      if (e.group === ANY) return said.size > 0;
      if (e.group === NONE) return said.size === 0;
      return said.has(e.group);
    case 'any': return e.of.some(x => satisfied(x, said));
    case 'all': return e.of.every(x => satisfied(x, said));
    case 'opt': return assertsEmpty(e.of) ? satisfied(e.of, said) : true;
  }
}

/** Does this expression ask for nothing, as an empty part does? */
const empty = (e: Expr): boolean => e.kind === 'all' && e.of.length === 0;

/** Does a parsed line answer this pattern? */
export function saidMatches(said: Said, parse: Parse): boolean {
  for (let p = 0; p < 3; p++) {
    // "the" is in every part and means nothing; a pattern never names
    // it, and leaving it in would make `!*` impossible to satisfy.
    const groups = new Set([...parse.parts[p]].filter(g => g !== NULL_GROUP));
    const e = said.parts[p];
    // A part the pattern does not mention, and one written empty, are
    // both simply not asked about.
    if (e === undefined || empty(e)) continue;
    if (!satisfied(e, groups)) return false;
  }
  return true;
}
