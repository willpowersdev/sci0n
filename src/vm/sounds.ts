/**
 * The sound driver the games talk to through `DoSound`.
 *
 * A game does not play audio itself: it builds a `Sound` object holding
 * a resource number and asks the driver to init, play, stop and dispose
 * of it, then polls the object's `signal` property to find out when the
 * piece has finished.  This is the other half of that conversation --
 * it owns an OPL2 player per sounding piece and mixes them together for
 * whatever is pulling audio out, which is the browser during play and a
 * test harness otherwise.
 *
 * The subop numbers are SCI0's, read off the games themselves: each one
 * is called from the `Sound` method that names it (0 from `Sound::init`,
 * 1 from `Sound::play`, 3 from `Sound::dispose`, 5 from `Sound::stop`,
 * 6 from `Sound::pause`, 9 from `Sound::changeState`, 10 from
 * `Sound::fade`), and the two that are not (4 and 8) are both called
 * from `TheMenuBar::handleEvent`, which is where mute and master volume
 * live.
 */
import type { Game } from '../resources.ts';
import { type Index, SciObject, type Script } from '../script.ts';
import { detectHeaderSize, parseSound, type Sound } from '../sound.ts';
import { parseBank, bankInDriver, type Instrument } from '../opl/patch.ts';
import { Player } from '../opl/player.ts';
import { OPL_RATE } from '../opl/opl2.ts';
import { parsePatchBank, gmPatchMap } from '../mt32.ts';
import { toGeneralMidi, type GmEvent } from '../gmstream.ts';

export type SndVerb =
  | 'init' | 'play' | 'dispose' | 'stop' | 'pause' | 'soundOn' | 'masterVolume'
  | 'update' | 'fade' | 'getPolyphony' | 'stopAll' | 'check' | 'hold'
  | 'sendMidi' | 'restore' | 'resume';

/**
 * SCI0's subops, read off the games: each is called from the `Sound`
 * method that names it, and the two that are not -- 4 and 8 -- are both
 * called from `TheMenuBar::handleEvent`, which is where mute and master
 * volume live.
 */
const SCI0_VERBS: Record<number, SndVerb> = {
  0: 'init', 1: 'play', 2: 'restore', 3: 'dispose', 4: 'soundOn', 5: 'stop',
  6: 'pause', 7: 'resume', 8: 'masterVolume', 9: 'update', 10: 'fade',
  11: 'getPolyphony', 12: 'stopAll',
};

/**
 * SCI01 renumbered the lot.
 *
 * QFG2's `Sound::init` calls 5 where SQ3's calls 0, and every other verb
 * moves with it, so a game on this dialect driven by the table above
 * inits nothing and plays nothing.  Taken from QFG2 script 989 the same
 * way: init 5, dispose 6, play 7, stop 8, pause 9, fade 10, check 11,
 * send 12, hold 14, and changeState's update at 4.
 */
const SCI01_VERBS: Record<number, SndVerb> = {
  0: 'masterVolume', 1: 'soundOn', 4: 'update', 5: 'init', 6: 'dispose',
  7: 'play', 8: 'stop', 9: 'pause', 10: 'fade', 11: 'check',
  12: 'sendMidi', 14: 'hold',
};

/** The signal value a script reads as "this piece has finished". */
export const SIGNAL_FINISHED = -1;

/** Where the music goes: the game's own chip, or a GM synthesiser. */
export type Output = 'adlib' | 'midi';

interface Entry {
  /** The game's `Sound` object, which owns the properties we report to. */
  handle: number;
  number: number;
  sound: Sound;
  player: Player;
  playing: boolean;
  /** Set once `signal` has been marked finished, so it is reported once. */
  reported: boolean;
  /** How many of the piece's cues have already been handed over. */
  cueIndex: number;
  /**
   * The piece as General MIDI, translated the first time it is wanted.
   *
   * Most sessions never ask: the AdLib path is the default, and doing
   * this for all 165 of Camelot's scores on the way past would be work
   * done for nothing.
   */
  gm: GmEvent[] | null;
  gmIndex: number;
  /** The tick the piece started on, which is what decides when it ends. */
  startTick: number;
}

export class SoundBox {
  private game: Game;
  bank: Instrument[] | null = null;
  private live = new Map<number, Entry>();
  /** SCI carries a master volume of 0..15. */
  masterVolume = 12;
  muted = false;
  /** Pieces that have finished since the last sweep, by handle. */
  private ended: number[] = [];
  /** Cues come due, by handle, oldest first. */
  private cued: Array<{ handle: number; signal: number }> = [];
  /**
   * Where the music is sent.
   *
   * The AdLib path synthesises the game's own chip from its own bank
   * and is what it sounded like; the MIDI path hands the score to a
   * General MIDI synthesiser, which is a different instrument playing
   * the same notes.
   */
  output: Output = 'adlib';
  /** GM programs for the game's patches, read from `patch.001`. */
  private gmPatches: Int8Array | null = null;
  /** MIDI messages due to be sent, oldest first. */
  private midiOut: GmEvent[] = [];

  /** True when the game speaks SCI01's renumbered subops. */
  sci01 = false;

  /**
   * Which dialect this game's `Sound` class speaks.
   *
   * Decided from the class itself rather than from the game's name: the
   * SCI01 rewrite put a `nodePtr` at the front of the object, and it is
   * the same rewrite that renumbered the subops.
   */
  private detectDialect(index: Index) {
    for (let n = 0; n < 1000; n++) {
      let sc: Script | null;
      try { sc = index.script(n); } catch { continue; }
      if (!sc) continue;
      for (const [kind, off] of sc.blocks) {
        if (kind !== 'class') continue;
        let o: SciObject;
        try { o = new SciObject(sc, off, true); } catch { continue; }
        if (o.name !== 'Sound') continue;
        this.sci01 = o.propertyNames(index).includes('nodePtr');
        return;
      }
    }
  }

  /** Translate a subop into what it asks for, or null if unused. */
  verb(subop: number): SndVerb | null {
    return (this.sci01 ? SCI01_VERBS : SCI0_VERBS)[subop] ?? null;
  }

  /**
   * Whether this game hears the loop signal as a cue of its own.
   *
   * The earliest SCI0 passed 127 on to the scripts as well as looping
   * on it, and those games were written expecting it.  `selectorShift`
   * is the same tell used everywhere else for that era.
   */
  private earlySci0 = false;

  constructor(game: Game, index?: Index) {
    this.game = game;
    if (index) {
      try { this.detectDialect(index); } catch { /* assume SCI0 */ }
      this.earlySci0 = index.selectorShift === 1;
    }
    // The AdLib bank is patch resource 3, and for the earliest games --
    // KQ4 here -- it is inside the driver they shipped with instead.
    try { this.bank = parseBank(game.data(9, 3)); } catch { this.bank = null; }
    if (!this.bank) {
      const drv = game.file('adl.drv');
      if (drv) { try { this.bank = bankInDriver(drv); } catch { this.bank = null; } }
    }
    // The MT-32 bank, which is the only place the game says what its
    // programs were meant to sound like.  A game without one can still
    // play on the chip; it simply cannot be mapped to General MIDI.
    try {
      const b = parsePatchBank(game.data(9, 1));
      this.gmPatches = b ? gmPatchMap(b) : null;
    } catch { this.gmPatches = null; }
  }

  /** True when this game carries the bank a GM mapping needs. */
  get canPlayGeneralMidi() { return this.gmPatches !== null; }

  get available() { return this.bank !== null; }
  /** How many pieces are sounding, for the HUD and for tests. */
  get active() { return [...this.live.values()].filter(e => e.playing).length; }
  /**
   * Which resources are sounding.
   *
   * "Is anything playing" cannot tell one piece from another, and the
   * question worth asking about a game's audio is usually about a
   * particular piece -- whether the music that comes *after* the title
   * is audible, say, which the title music satisfies by itself.
   */
  get playing(): number[] {
    return [...this.live.values()].filter(e => e.playing).map(e => e.number);
  }

  private gainFor() { return this.muted ? 0 : this.masterVolume / 15; }

  private header: number | null = null;
  /**
   * How long this game's sound headers are, decided once for the game.
   *
   * A single resource does not always say: more than one header length
   * will scan it without complaint, and the wrong one can still yield a
   * stream that looks reasonable.  KQ4's banner music parsed as 3654
   * events instead of 3658 that way -- all the notes, none of the
   * channel setup that goes before them -- and played in silence.
   * Asking a spread of the game's own sounds which length fits them all
   * settles it, because a header that is wrong will fail on some of
   * them even when it passes on one.
   */
  private headerSize(): number | undefined {
    if (this.header === null) {
      const datas: Uint8Array[] = [];
      for (const r of this.game.byType('sound')) {
        if (datas.length >= 12) break;
        try { const d = this.game.tryData('sound', r.number); if (d) datas.push(d); } catch { /* skip */ }
      }
      this.header = datas.length ? detectHeaderSize(datas) : -1;
    }
    return this.header >= 0 ? this.header : undefined;
  }

  /** Load a piece and hold it ready, without sounding it. */
  init(handle: number, number: number) {
    const existing = this.live.get(handle);
    if (existing && existing.number === number) return;
    let data: Uint8Array | null = null;
    try { data = this.game.tryData('sound', number); } catch { data = null; }
    if (!data) return;
    const sound = parseSound(data, this.headerSize(), this.earlySci0);
    if (!sound) return;
    /**
     * A game with no instruments still has to keep time.
     *
     * The piece is loaded and run whether or not there is a bank to
     * play it with: an empty one leaves every note silent, which the
     * player already does for a program it has not got.  Refusing to
     * load it at all, as this did, stops the clock as well as the
     * sound -- and the scripts are listening to that clock.  KQ4's
     * intro waits for its title music to finish before it moves on,
     * so with no bank it waited on a piece that was never playing and
     * sat on the same screen for ever.
     */
    const player = new Player(sound, this.bank ?? []);
    player.gain = this.gainFor();
    this.live.set(handle, { handle, number, sound, player, playing: false,
                            reported: false, cueIndex: 0, gm: null, gmIndex: 0,
                            startTick: 0 });
  }

  play(handle: number, number: number, loop: boolean, atTick = 0) {
    this.init(handle, number);
    const e = this.live.get(handle);
    if (!e) return;
    e.player.rewind();
    e.player.loop = loop;
    e.player.gain = this.gainFor();
    e.playing = true;
    e.reported = false;
    // A piece played again cues again, from its first.
    e.cueIndex = 0;
    e.gmIndex = 0;
    e.startTick = atTick;
  }

  pause(handle: number, on: boolean) {
    if (!handle) { for (const e of this.live.values()) e.playing = !on; return; }
    const e = this.live.get(handle);
    if (e) e.playing = !on;
  }

  stop(handle: number) {
    const e = this.live.get(handle);
    if (!e) return;
    if (this.output === 'midi' && e.playing) this.silence(e);
    e.playing = false;
    e.player.rewind();
  }

  /**
   * Let go of every note a piece is holding.
   *
   * A synthesiser on the other end of a wire does not stop when we do:
   * a note-on it has been sent sounds until something takes it off, so
   * a piece cut short leaves its last chord hanging for ever.
   */
  private asGeneralMidi(e: Entry): GmEvent[] {
    e.gm ??= this.gmPatches ? toGeneralMidi(e.sound, this.gmPatches) : [];
    return e.gm;
  }

  private silence(e: Entry) {
    const used = new Set(this.asGeneralMidi(e).map(v => v.status & 0x0F));
    // 0x7B is all-notes-off; 0x79 resets the controllers we changed.
    for (const ch of used) {
      this.midiOut.push({ tick: 0, status: 0xB0 | ch, a: 0x7B, b: 0 });
      this.midiOut.push({ tick: 0, status: 0xB0 | ch, a: 0x79, b: 0 });
    }
  }

  /**
   * MIDI messages due since this was last called.
   *
   * The host owns the wire -- a browser reaches a synthesiser through
   * Web MIDI, which the machine knows nothing about -- so the box
   * queues and the host sends.
   */
  takeMidi(): GmEvent[] {
    const out = this.midiOut;
    this.midiOut = [];
    return out;
  }

  dispose(handle: number) { this.stop(handle); this.live.delete(handle); }

  stopAll() { for (const h of [...this.live.keys()]) this.stop(h); }

  /** Hand the music to a different output, leaving nothing sounding. */
  setOutput(to: Output) {
    if (to === this.output) return;
    if (this.output === 'midi')
      for (const e of this.live.values()) if (e.playing) this.silence(e);
    this.output = to;
    // A piece already under way resumes from where the clock says it is.
    if (to === 'midi') for (const e of this.live.values()) e.gmIndex = 0;
  }

  /**
   * Fade a piece out.
   *
   * The driver did this over a set number of steps; a straight ramp on
   * the piece's own gain is the audible part of it, and the script is
   * told the piece finished the same way a natural ending would.
   */
  fade(handle: number) {
    const e = this.live.get(handle);
    if (!e) return;
    e.player.fadeOut = true;
  }

  setMasterVolume(v: number) {
    this.masterVolume = Math.max(0, Math.min(15, v));
    for (const e of this.live.values()) e.player.gain = this.gainFor();
  }

  setMuted(on: boolean) {
    this.muted = on;
    for (const e of this.live.values()) e.player.gain = this.gainFor();
  }

  /**
   * Move every sounding piece along the game's clock.
   *
   * A piece ends because its time is up, not because somebody rendered
   * it: scripts wait on a sound finishing to move a scene on, and
   * Camelot's intro does exactly that.  Deciding it from the mixer
   * meant the intro stopped on its first scene whenever nothing was
   * pulling audio -- a headless run, or a browser that has not been
   * allowed to start a sound yet.
   */
  pump(nowTick: number) {
    /**
     * Cues first: a piece that signals on its very last tick must be
     * heard from before it is declared over, or the script gets the
     * end of the piece and never the cue that came with it.
     *
     * Only one cue per piece per sweep.  `signal` is a single slot that
     * the game's own `Sound` class reads and clears, so handing over
     * two at once loses the first -- the second would simply overwrite
     * it before the script had looked.
     */
    for (const e of this.live.values()) {
      if (!e.playing) continue;
      const cues = e.sound.cues;
      if (e.cueIndex >= cues.length) continue;
      if (nowTick - e.startTick < cues[e.cueIndex].tick) continue;
      this.cued.push({ handle: e.handle, signal: cues[e.cueIndex].signal });
      e.cueIndex++;
    }
    if (this.output === 'midi') {
      for (const e of this.live.values()) {
        if (!e.playing) continue;
        const gm = this.asGeneralMidi(e);
        const due = nowTick - e.startTick;
        while (e.gmIndex < gm.length && gm[e.gmIndex].tick <= due)
          this.midiOut.push(gm[e.gmIndex++]);
      }
    }
    for (const e of this.live.values()) {
      if (!e.playing || e.player.loop || e.reported) continue;
      // `ticks` is the piece's own length, in the same sixtieths the
      // machine counts.
      if (nowTick - e.startTick < e.sound.ticks) continue;
      e.playing = false;
      e.reported = true;
      this.ended.push(e.handle);
    }
  }

  /**
   * Handles whose piece has ended since this was last called.
   *
   * The machine turns these into `signal = -1` on the game's own object,
   * which is what a script polling `Sound::check` is waiting for.
   */
  takeEnded(): number[] {
    const out = this.ended;
    this.ended = [];
    return out;
  }

  /**
   * Cues that have come due since this was last called.
   *
   * The machine writes each one to `signal` on the game's own sound
   * object, which is where a script polling for it will look.
   */
  takeCues(): Array<{ handle: number; signal: number }> {
    const out = this.cued;
    this.cued = [];
    return out;
  }

  /**
   * Mix every sounding piece into `out` at the chip's rate.
   *
   * Nothing here is scheduled against wall-clock time: the caller asks
   * for as many samples as it needs, so the audio device's own clock
   * paces the music and it cannot drift from what is heard.
   */
  mix(out: Float32Array) {
    out.fill(0);
    // The synthesiser at the other end is making the sound, not us.
    if (this.output === 'midi') return;
    if (!this.live.size) return;
    const scratch = new Float32Array(out.length);
    for (const e of this.live.values()) {
      if (!e.playing) continue;
      const n = e.player.advance(scratch);
      for (let i = 0; i < n; i++) out[i] += scratch[i];
      // The mixer does not decide when a piece is over -- `pump` does,
      // off the game's clock -- so a player that has run out simply
      // contributes nothing more.
    }
    // Several pieces at once would otherwise sum past full scale.
    for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i]);
  }

  /** Samples per second the mix is produced at. */
  get rate() { return OPL_RATE; }
}
