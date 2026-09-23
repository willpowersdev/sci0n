/**
 * vocab.900: the parser's grammar, and the parse it produces.
 *
 * SCI does not match a typed line against a pattern word by word.  It
 * first *parses* the line with a grammar the game ships, which assigns
 * every word a role in a sentence, and only then asks whether a
 * pattern describes that sentence.  That is why "give the knight the
 * sword" and "give the sword to the knight" mean the same thing to the
 * game while "sword give knight" means nothing at all.
 *
 * The grammar is a table of 20-byte rules:
 *
 *   u16 head, then up to four (u16 type, u16 value) pairs, zero-padded
 *
 * `head` is the non-terminal the rule produces and each pair is one
 * constituent.  A pair of type 0x146 is a terminal -- `value` is a mask
 * of word classes, and any word whose own class shares a bit with it
 * will do.  Every other type names another non-terminal to expand, and
 * the type itself says which *part of the sentence* the result belongs
 * to.  That last point is the whole trick, and it is visible in the
 * table: SQ3's rule 7 is
 *
 *   0x13c -> 0x141:0x13b  0x143:0x13d  0x142:0x13d
 *
 * a clause made of a verb phrase and two noun phrases, where the
 * *first* noun phrase is tagged 0x143 and the second 0x142.  That is
 * "give him the ball" -- surface order him-then-ball, but "ball" is
 * what is given and "him" is who gets it, so they are recorded the
 * other way round.  A pattern writes that as `give/ball/him`, and it
 * matches whichever way the player typed it.
 *
 * So the three parts a pattern can name are exactly these tags:
 *
 *   0x141  part one   -- what is being done
 *   0x142  part two   -- what it is being done to
 *   0x143  part three -- what it is being done with, or to whom
 *   0x144  no part of its own: stays in the part it was found in
 *   0x145  likewise (articles and conjunctions)
 *
 * The word classes the terminals select are the ones vocab.000 gives
 * each word, and the table names them all: 0x004 conjunction, 0x008
 * "with", 0x010 preposition, 0x020 article, 0x040 adjective, 0x080
 * pronoun, 0x100 noun, 0x200 auxiliary verb, 0x400 adverb, 0x800 verb.
 * A word may be several at once -- "gold" is 0x140, both adjective and
 * noun -- and the parse decides which reading the sentence needs.
 */

/** The non-terminal every parse must reduce to. */
export const START = 0x13f;
/** A pair of this type is a word class rather than a non-terminal. */
const TERMINAL = 0x146;
/** Constituent tags that open a new sentence part. */
const PART_TWO = 0x142, PART_THREE = 0x143;

export interface Item { type: number; value: number }
export interface Rule { head: number; body: Item[] }

/** A word of the typed line, as the vocabulary describes it. */
export interface Word { text: string; group: number; cls: number }

/** A word in the tree, or a non-terminal expanded into more items. */
export type Node = Word | Branch;
export interface Branch { nt: number; items: Array<{ type: number; node: Node }> }

const isWord = (n: Node): n is Word => 'group' in n;

/** Read the rule table.  A rule with no head ends it. */
export function grammarRules(data: Uint8Array): Rule[] {
  const u16 = (o: number) => data[o] | (data[o + 1] << 8);
  const rules: Rule[] = [];
  for (let o = 0; o + 20 <= data.length; o += 20) {
    const head = u16(o);
    if (head === 0) break;
    const body: Item[] = [];
    for (let k = 1; k < 9; k += 2) {
      const type = u16(o + k * 2), value = u16(o + k * 2 + 2);
      if (!type && !value) break;
      body.push({ type, value });
    }
    if (body.length) rules.push({ head, body });
  }
  return rules;
}

/**
 * The roles a parsed line fills: the groups said in each of the three
 * parts.  `whole` is every group, in the order typed, which is what a
 * pattern naming no parts at all is compared against.
 */
export interface Parse {
  parts: [Set<number>, Set<number>, Set<number>];
  whole: number[];
}

/**
 * Parse a line, or return null if the grammar does not describe it.
 *
 * Recursive descent with backtracking, taking the first reading in
 * table order.  No rule in the table is left-recursive and no
 * non-terminal can produce nothing, so every step consumes a word and
 * the recursion is bounded by the length of the line.
 */
export function parseSentence(rules: Rule[], words: Word[]): Parse | null {
  if (!words.length) return null;
  const byHead = new Map<number, Rule[]>();
  for (const r of rules) {
    const l = byHead.get(r.head);
    if (l) l.push(r); else byHead.set(r.head, [r]);
  }

  /** Expand `nt` from `pos`, handing each reading to `cont` until one sticks. */
  function expand(nt: number, pos: number, cont: (end: number, node: Node) => boolean): boolean {
    for (const rule of byHead.get(nt) ?? []) {
      const items: Array<{ type: number; node: Node }> = [];
      const step = (i: number, at: number): boolean => {
        if (i === rule.body.length) return cont(at, { nt, items: items.slice() });
        const { type, value } = rule.body[i];
        if (type === TERMINAL) {
          const w = words[at];
          // A word belongs to several classes at once; sharing one bit
          // with the mask is enough for this reading to be allowed.
          if (!w || !(w.cls & value)) return false;
          items.push({ type, node: w });
          if (step(i + 1, at + 1)) return true;
          items.pop();
          return false;
        }
        return expand(value, at, (end, node) => {
          items.push({ type, node });
          if (step(i + 1, end)) return true;
          items.pop();
          return false;
        });
      };
      if (step(0, pos)) return true;
    }
    return false;
  }

  let tree: Node | null = null;
  expand(START, 0, (end, node) => {
    // Only a reading that accounts for the whole line counts.
    if (end !== words.length) return false;
    tree = node;
    return true;
  });
  if (!tree) return null;

  const parts: [Set<number>, Set<number>, Set<number>] = [new Set(), new Set(), new Set()];
  const walk = (node: Node, part: number) => {
    if (isWord(node)) { parts[part].add(node.group); return; }
    for (const it of node.items) {
      const p = it.type === PART_TWO ? 1 : it.type === PART_THREE ? 2 : part;
      walk(it.node, p);
    }
  };
  walk(tree, 0);
  return { parts, whole: words.map(w => w.group) };
}
