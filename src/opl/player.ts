/**
 * Plays a parsed SCI0 sound through the OPL2 voice engine.
 *
 * The chip has nine channels and the music has sixteen, so voices are
 * allocated on demand and the oldest is stolen when they run out --
 * which is what the AdLib driver had to do as well.
 *
 * Timing is the game's: SCI counts 60 ticks per second, and events carry
 * absolute ticks, so rendering walks the event list and the chip forward
 * together rather than scheduling anything.
 */
import { OPL2, noteToFreq, OPL_RATE } from './opl2.ts';
import { PercussionVoice, DRUM_CHANNEL } from './percussion.ts';
import { applyOp, type Instrument } from './patch.ts';
import { DEVICE_ADLIB, type Sound } from '../sound.ts';

export const TICKS_PER_SECOND = 60;

interface Voice { channel: number; note: number; midi: number; age: number }

/**
 * Chip channels kept for melody.  The hardware's rhythm mode took the
 * last three channels for percussion, and the same split keeps a busy
 * drum part from evicting the tune.
 */
const MELODIC_VOICES = 6;
/** Simultaneous drum hits; beyond this the quietest is replaced. */
const DRUM_VOICES = 6;
/** The program number that means "this channel has no instrument". */
const NO_INSTRUMENT = 127;

export class Player {
  opl = new OPL2();
  private bank: Instrument[];
  private voices: Voice[] = [];
  private program = new Int16Array(16).fill(NO_INSTRUMENT);
  private bend = new Float32Array(16);
  private volume = new Float32Array(16).fill(1);
  private clock = 0;
  private drums: PercussionVoice[] = Array.from({ length: DRUM_VOICES }, () => new PercussionVoice());
  /** Which of the music's channels this arrangement should sound. */
  private enabled: boolean[];

  private sound: Sound;

  constructor(sound: Sound, bank: Instrument[]) {
    this.sound = sound;
    this.bank = bank;
    // Prefer the channels the resource marks for AdLib; if a game marks
    // none -- early SCI0 uses a different bit layout -- sound them all
    // rather than render silence.
    const marked = sound.channels.map(c => (c.devices & DEVICE_ADLIB) !== 0);
    const any = marked.some(Boolean);
    this.enabled = Array.from({ length: 16 }, (_, i) => any ? (marked[i] ?? false) : true);
  }

  /**
   * Find a chip channel for a note.
   *
   * These scores ask for up to twenty-five simultaneous notes on a chip
   * with nine, so stealing is constant and the choice matters.  Taking
   * the oldest voice cuts notes that are still at full volume, and each
   * cut is a step in the waveform -- a click.  Thousands of those are
   * heard as static, so the quietest voice goes first, which is usually
   * one already fading out.
   */
  private alloc(midi: number, note: number): Voice {
    let v = this.voices.find(x => x.midi < 0 && !this.opl.channels[x.channel].active);
    if (!v && this.voices.length < MELODIC_VOICES) {
      v = { channel: this.voices.length, note, midi, age: this.clock };
      this.voices.push(v);
    }
    if (!v) {
      v = this.voices.reduce((a, b) =>
        this.opl.channels[a.channel].loudness <= this.opl.channels[b.channel].loudness ? a : b);
      this.opl.channels[v.channel].keyOff();
    }
    v.note = note; v.midi = midi; v.age = this.clock++;
    return v;
  }

  private noteOn(midi: number, note: number, velocity: number) {
    if (midi === DRUM_CHANNEL) {
      // A drum is struck, never held: it needs no note-off and no voice
      // of its own beyond its decay.
      const free = this.drums.find(d => !d.active) ?? this.drums[0];
      free.strike(note, velocity * this.volume[midi]);
      return;
    }
    // Programs index this game's own AdLib bank, not General MIDI: the
    // numbers used run 0..95 against a 96-instrument bank, and LSL2's
    // 48-instrument bank is never asked for anything above 42.  Only the
    // drum channel follows a General MIDI map.  127 means no instrument
    // -- it is set constantly and almost never has notes under it -- and
    // an out-of-range program is left silent rather than wrapped, since
    // wrapping plays a real but wrong instrument.
    const prog = this.program[midi];
    if (prog === NO_INSTRUMENT || prog < 0 || prog >= this.bank.length) return;
    const inst = this.bank[prog];
    if (!inst) return;
    const v = this.alloc(midi, note);
    const ch = this.opl.channels[v.channel];
    applyOp(ch.op0, inst.ops[0]);
    applyOp(ch.op1, inst.ops[1]);
    ch.feedback = inst.feedback;
    ch.additive = inst.additive;
    // Velocity and channel volume attenuate the carrier, as the driver
    // did: the modulator's level shapes timbre and must not be touched.
    const scale = (velocity / 127) * this.volume[midi];
    const extra = scale > 0 ? Math.round(-20 * Math.log10(scale) / 0.75) : 63;
    ch.op1.tl = Math.max(0, Math.min(63, inst.ops[1].tl + extra));
    const f = noteToFreq(note, this.bend[midi]);
    ch.fnum = f.fnum; ch.block = f.block;
    ch.keyOn();
  }

  private noteOff(midi: number, note: number) {
    if (midi === DRUM_CHANNEL) return;      // drums ring out on their own
    for (const v of this.voices) {
      if (v.midi !== midi || v.note !== note) continue;
      this.opl.channels[v.channel].keyOff();
      v.midi = -1;
    }
  }

  /** Apply one MIDI event. */
  private event(status: number, a: number, b: number) {
    const midi = status & 0x0F;
    if (!this.enabled[midi]) return;
    switch (status & 0xF0) {
      case 0x80: this.noteOff(midi, a); break;
      case 0x90: b === 0 ? this.noteOff(midi, a) : this.noteOn(midi, a, b); break;
      case 0xB0:
        if (a === 7) this.volume[midi] = b / 127;
        else if (a === 123 || a === 120) for (const v of this.voices) if (v.midi === midi) this.noteOff(midi, v.note);
        break;
      case 0xC0: this.program[midi] = a; break;
      case 0xE0: {
        const semis = ((b << 7 | a) - 8192) / 8192 * 2;
        this.bend[midi] = semis;
        for (const v of this.voices) {
          if (v.midi !== midi) continue;
          const f = noteToFreq(v.note, semis);
          const ch = this.opl.channels[v.channel];
          ch.fnum = f.fnum; ch.block = f.block;
        }
        break;
      }
    }
  }

  /** Total length in seconds, plus a tail for notes still ringing. */
  get duration() { return this.sound.ticks / TICKS_PER_SECOND + 1; }

  /**
   * Render the whole piece at the chip's rate.  Events are applied when
   * the running sample count reaches their tick, so timing comes from
   * the music rather than from any scheduler.
   */
  render(seconds = this.duration): Float32Array {
    const total = Math.ceil(seconds * OPL_RATE);
    const out = new Float32Array(total);
    const ev = this.sound.events;
    let i = 0;
    for (let s = 0; s < total; s++) {
      const tick = s * TICKS_PER_SECOND / OPL_RATE;
      while (i < ev.length && ev[i].tick <= tick) {
        this.event(ev[i].status, ev[i].a, ev[i].b);
        i++;
      }
      let v = this.opl.rawSample();
      for (const d of this.drums) v += d.sample(OPL_RATE) * 2.2;
      out[s] = Math.tanh(v / 3.2);
    }
    return out;
  }
}

/** Nearest-neighbour resample from the chip rate to the output rate. */
export function resample(src: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return src;
  const n = Math.floor(src.length * to / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * from / to;
    const j = Math.floor(x), t = x - j;
    out[i] = (src[j] ?? 0) * (1 - t) + (src[j + 1] ?? 0) * t;
  }
  return out;
}
