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
import { parseSound, type Sound } from '../sound.ts';
import { parseBank, type Instrument } from '../opl/patch.ts';
import { Player } from '../opl/player.ts';
import { OPL_RATE } from '../opl/opl2.ts';

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

interface Entry {
  /** The game's `Sound` object, which owns the properties we report to. */
  handle: number;
  number: number;
  sound: Sound;
  player: Player;
  playing: boolean;
  /** Set once `signal` has been marked finished, so it is reported once. */
  reported: boolean;
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

  constructor(game: Game, index?: Index) {
    this.game = game;
    if (index) { try { this.detectDialect(index); } catch { /* assume SCI0 */ } }
    // The AdLib bank is patch resource 3.  A game without one can still
    // be played; it simply makes no music.
    try { this.bank = parseBank(game.data(9, 3)); } catch { this.bank = null; }
  }

  get available() { return this.bank !== null; }
  /** How many pieces are sounding, for the HUD and for tests. */
  get active() { return [...this.live.values()].filter(e => e.playing).length; }

  private gainFor() { return this.muted ? 0 : this.masterVolume / 15; }

  /** Load a piece and hold it ready, without sounding it. */
  init(handle: number, number: number) {
    const existing = this.live.get(handle);
    if (existing && existing.number === number) return;
    if (!this.bank) return;
    let data: Uint8Array | null = null;
    try { data = this.game.tryData('sound', number); } catch { data = null; }
    if (!data) return;
    const sound = parseSound(data);
    if (!sound) return;
    const player = new Player(sound, this.bank);
    player.gain = this.gainFor();
    this.live.set(handle, { handle, number, sound, player, playing: false,
                            reported: false, startTick: 0 });
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
    e.playing = false;
    e.player.rewind();
  }

  dispose(handle: number) { this.stop(handle); this.live.delete(handle); }

  stopAll() { for (const h of [...this.live.keys()]) this.stop(h); }

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
   * Mix every sounding piece into `out` at the chip's rate.
   *
   * Nothing here is scheduled against wall-clock time: the caller asks
   * for as many samples as it needs, so the audio device's own clock
   * paces the music and it cannot drift from what is heard.
   */
  mix(out: Float32Array) {
    out.fill(0);
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
