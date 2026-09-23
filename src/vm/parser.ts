/**
 * The text parser: `Parse` and `Said`.
 *
 * A game reads a line from the player, hands it to `Parse`, and then
 * asks `Said` whether it matches each pattern it cares about.  The two
 * halves live next door: vocab.900 holds the grammar that turns a line
 * into a sentence with parts (see grammar.ts), and the said blocks
 * compiled into each script hold the patterns those parts are compared
 * against (see said.ts).  This joins them, and owns the one piece of
 * state between them -- a line, once something has matched it, is spent.
 *
 * A word the vocabulary does not know stops the whole thing, because
 * the game wants to say "I don't know the word X" rather than "I don't
 * understand", and those are different failures.  A word it does not
 * know *directly* may still be one it knows with a different ending:
 * vocab.901 lists those, so "rocks" is looked up again as "rock".
 */
import { Game } from '../resources.ts';
import { gameWords, gameSuffixes } from '../vocab.ts';
import { grammarRules, parseSentence, type Rule, type Word, type Parse } from './grammar.ts';
import { parseSaid, saidMatches } from './said.ts';

export class Parser {
  /** Every word the game knows, to its class mask and group. */
  private words = new Map<string, { cls: number; group: number }>();
  /** Endings that turn one word into another the vocabulary does know. */
  private suffixes: Array<{ pattern: string; replacement: string }> = [];
  /** The grammar, if the game ships one. */
  private rules: Rule[] = [];

  /** The sentence last parsed, or null if the line did not make one. */
  parse_: Parse | null = null;
  /** A pattern has matched, so the line is spent until the next parse. */
  used = true;
  /** The event `Parse` was given, which a match claims. */
  event = 0;

  constructor(game: Game) {
    try {
      for (const [word, cls, group] of gameWords(game))
        if (!this.words.has(word)) this.words.set(word, { cls, group });
    } catch { /* a game with no vocabulary parses nothing */ }
    try {
      for (const s of gameSuffixes(game)) this.suffixes.push({ pattern: s.pattern, replacement: s.replacement });
    } catch { /* a game may ship no suffix table */ }
    try {
      const g = game.tryData('vocab', 900);
      // In SCI01 resource 900 is the word list, not the grammar; a
      // grammar is a whole number of 20-byte rules starting at a
      // non-terminal, which a word list is not.
      if (g && g.length >= 20 && g.length % 20 === 0) this.rules = grammarRules(g);
    } catch { /* no grammar: nothing will parse */ }
  }

  get ready() { return this.words.size > 0 && this.rules.length > 0; }

  /** What the vocabulary makes of a word, trying its endings, or null. */
  private look(word: string): { cls: number; group: number } | null {
    const direct = this.words.get(word);
    if (direct) return direct;
    // A suffix rule says "a word ending like this is that word with a
    // different ending" -- "looked" is "look", "rocks" is "rock".
    for (const s of this.suffixes) {
      const end = s.pattern.replace(/^\*/, '');
      if (!end || !word.endsWith(end)) continue;
      const stem = word.slice(0, word.length - end.length) + s.replacement.replace(/^\*/, '');
      const g = this.words.get(stem);
      if (g) return g;
    }
    return null;
  }

  /**
   * Read a line.  Returns the word the game does not know, or null when
   * every word was recognised -- which is the distinction the game needs
   * to tell the player "I don't know the word X" rather than "I don't
   * understand".  A line of known words that the grammar cannot make a
   * sentence of is the second failure, not the first: it parses to
   * nothing, and no pattern will match it.
   */
  parse(text: string): string | null {
    this.parse_ = null;
    this.used = false;
    const ws: Word[] = [];
    for (const t of text.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean)) {
      const e = this.look(t);
      if (!e) { this.used = true; return t; }
      ws.push({ text: t, group: e.group, cls: e.cls });
    }
    this.parse_ = parseSentence(this.rules, ws);
    if (!this.parse_) this.used = true;
    return null;
  }

  /**
   * Does the last line match this pattern?
   *
   * A line is spent once something has matched it, so a second pattern
   * asking the same question gets no for an answer -- the games rely on
   * that to try their specific cases before their general ones.  A
   * pattern ending in `>` matches without spending the line.
   */
  match(spec: Uint8Array): { matched: boolean; claim: boolean } {
    const said = parseSaid(spec);
    if (this.used || !this.parse_) return { matched: false, claim: said.claim };
    if (!saidMatches(said, this.parse_)) return { matched: false, claim: said.claim };
    if (said.claim) this.used = true;
    return { matched: true, claim: said.claim };
  }
}
