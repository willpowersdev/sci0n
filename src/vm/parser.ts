/**
 * The text parser: `Parse` and `Said`.
 *
 * A game reads a line from the player, hands it to `Parse`, and then
 * asks `Said` whether it matches each pattern it cares about.  The
 * patterns are compiled into the script as a said block -- a run of
 * 16-bit word-group ids with operator bytes from 0xF0 up between them --
 * and the words themselves live in the game's vocabulary, which maps
 * every word it knows to a class and a group.  Synonyms share a group,
 * which is why a pattern names groups rather than words: "get" and
 * "take" are the same id.
 *
 * The operators, from the kernel documentation:
 *
 *   ,  alternatives -- "take,get"
 *   /  sentence-part separator, at most two of them
 *   () grouping
 *   [] optional
 *   <  semantic reference, as in 'get<up'
 *   >  do not claim the event, so later patterns can match too
 *
 * The matching here is a simplification of SCI's, which builds a parse
 * tree from a grammar.  A pattern becomes a list of slots, each holding
 * the groups that would satisfy it, and the input has to visit them in
 * order.  Words in between are stepped over, which is what makes
 * "look at the rock" match 'look/rock' without a grammar to say that
 * "at" and "the" carry no meaning.
 */
import { Game } from '../resources.ts';
import { gameWords, gameSuffixes } from '../vocab.ts';

/** Operator bytes, as `saidDecode` names them. */
const OR = 0xF0, PART = 0xF2, OPEN = 0xF3, CLOSE = 0xF4;
const OPT_OPEN = 0xF5, OPT_CLOSE = 0xF6, HASH = 0xF7, REF = 0xF8, KEEP = 0xF9;

interface Slot { groups: Set<number>; optional: boolean }

export class Parser {
  /** Every word the game knows, to its group. */
  private words = new Map<string, number>();
  /** Endings that turn one word into another the vocabulary does know. */
  private suffixes: Array<{ pattern: string; replacement: string }> = [];

  /** Groups of the last line parsed, in the order they were typed. */
  said: number[] = [];
  /** A pattern has matched, so the line is spent until the next parse. */
  used = true;
  /** The event `Parse` was given, which a match claims. */
  event = 0;

  constructor(game: Game) {
    try {
      for (const [word, , group] of gameWords(game)) if (!this.words.has(word)) this.words.set(word, group);
    } catch { /* a game with no vocabulary parses nothing */ }
    try {
      for (const s of gameSuffixes(game)) this.suffixes.push({ pattern: s.pattern, replacement: s.replacement });
    } catch { /* a game may ship no suffix table */ }
  }

  get ready() { return this.words.size > 0; }

  /** The group a word belongs to, trying its endings, or -1. */
  private groupOf(word: string): number {
    const direct = this.words.get(word);
    if (direct !== undefined) return direct;
    // A suffix rule says "a word ending like this is that word with a
    // different ending" -- "looked" is "look", "rocks" is "rock".
    for (const s of this.suffixes) {
      const end = s.pattern.replace(/^\*/, '');
      if (!end || !word.endsWith(end)) continue;
      const stem = word.slice(0, word.length - end.length) + s.replacement.replace(/^\*/, '');
      const g = this.words.get(stem);
      if (g !== undefined) return g;
    }
    return -1;
  }

  /**
   * Read a line.  Returns the word the game does not know, or null when
   * every word was recognised -- which is the distinction the game needs
   * to tell the player "I don't know the word X" rather than "I don't
   * understand".
   */
  parse(text: string): string | null {
    this.said = [];
    this.used = false;
    const tokens = text.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
    for (const t of tokens) {
      const g = this.groupOf(t);
      // 0 is the group of words with no meaning of their own -- "the",
      // "at" -- which are simply not part of what was said.
      if (g < 0) { this.said = []; this.used = true; return t; }
      if (g > 0) this.said.push(g);
    }
    return null;
  }

  /** Turn a compiled pattern into the slots the input must visit. */
  private slots(spec: Uint8Array): { slots: Slot[]; claim: boolean } {
    const slots: Slot[] = [];
    let optional = false, afterOr = false, claim = true;
    for (let i = 0; i < spec.length; i++) {
      const v = spec[i];
      if (v >= 0xF0) {
        if (v === OR) afterOr = true;
        else if (v === OPT_OPEN) { optional = true; afterOr = false; }
        else if (v === OPT_CLOSE) { optional = false; afterOr = false; }
        else if (v === KEEP) claim = false;
        // Parts, grouping, '#' and '<' do not change which groups are
        // acceptable, only how SCI's grammar would have read them.
        else if (v === PART || v === OPEN || v === CLOSE || v === HASH || v === REF) afterOr = false;
        continue;
      }
      if (i + 1 >= spec.length) break;
      const group = (v << 8) | spec[i + 1];
      i++;
      if (afterOr && slots.length) slots[slots.length - 1].groups.add(group);
      else slots.push({ groups: new Set([group]), optional });
      afterOr = false;
    }
    return { slots, claim };
  }

  /**
   * Does the last line match this pattern?
   *
   * A line is spent once something has matched it, so a second pattern
   * asking the same question gets no for an answer -- the games rely on
   * that to try their specific cases before their general ones.
   */
  match(spec: Uint8Array): { matched: boolean; claim: boolean } {
    if (this.used || !this.said.length) return { matched: false, claim: true };
    const { slots, claim } = this.slots(spec);
    if (!slots.length) return { matched: false, claim };
    let at = 0;
    for (const slot of slots) {
      let found = -1;
      for (let i = at; i < this.said.length; i++)
        if (slot.groups.has(this.said[i])) { found = i; break; }
      if (found < 0) {
        if (slot.optional) continue;
        return { matched: false, claim };
      }
      at = found + 1;
    }
    if (claim) this.used = true;
    return { matched: true, claim };
  }
}
