/**
 * Percussion for the drum channel.
 *
 * Channel 9 carries General MIDI percussion -- pooled across a game its
 * notes are hi-hat, kick, snare, tambourine, crashes and congas, a
 * handful of fixed pitches struck thousands of times -- so playing them
 * as melodic FM notes is simply wrong, and buzzes.
 *
 * The AdLib driver drove the OPL2's rhythm mode for these, where a noise
 * generator replaces the oscillator on some operators.  This is a
 * dedicated percussion synth rather than rhythm mode: a tone that can
 * sweep in pitch, a noise burst, and one decay envelope, per drum.  It
 * approximates those voices rather than reproducing them, which is
 * stated plainly because the timbres are tuned by ear-shaped reasoning
 * and not decoded from anything.
 */
export const DRUM_CHANNEL = 9;

interface Drum {
  /** Starting tone frequency in Hz; 0 for pure noise. */
  hz: number;
  /** Frequency at the end of the sweep, for the pitch drop of a kick. */
  hzEnd?: number;
  /** How much noise is mixed in, 0..1. */
  noise: number;
  /** Seconds to fall 60 dB. */
  decay: number;
  /** Noise brightness: 1 is raw, lower is darker. */
  bright?: number;
  gain?: number;
}

/**
 * General MIDI note to drum.  Notes outside the table are common in
 * these scores (67..70 especially), so anything unmapped falls back to a
 * short noise tick rather than silence.
 */
const DRUMS: Record<number, Drum> = {
  35: { hz: 130, hzEnd: 45, noise: 0.05, decay: 0.22, gain: 1.0 },   // kick, soft
  36: { hz: 150, hzEnd: 50, noise: 0.05, decay: 0.16, gain: 1.0 },   // kick
  37: { hz: 900, noise: 0.35, decay: 0.05, gain: 0.6 },              // side stick
  38: { hz: 210, noise: 0.80, decay: 0.16, gain: 0.85 },             // snare
  39: { hz: 0, noise: 1.0, decay: 0.14, bright: 0.9, gain: 0.7 },    // hand clap
  40: { hz: 240, noise: 0.85, decay: 0.13, gain: 0.85 },             // snare 2
  41: { hz: 110, noise: 0.10, decay: 0.28, gain: 0.9 },              // low tom
  42: { hz: 0, noise: 1.0, decay: 0.045, bright: 1.0, gain: 0.5 },   // closed hi-hat
  43: { hz: 140, noise: 0.10, decay: 0.26, gain: 0.9 },              // tom
  44: { hz: 0, noise: 1.0, decay: 0.06, bright: 1.0, gain: 0.45 },   // pedal hi-hat
  45: { hz: 175, noise: 0.10, decay: 0.24, gain: 0.9 },              // mid tom
  46: { hz: 0, noise: 1.0, decay: 0.32, bright: 1.0, gain: 0.5 },    // open hi-hat
  47: { hz: 210, noise: 0.10, decay: 0.22, gain: 0.9 },              // mid-high tom
  48: { hz: 250, noise: 0.10, decay: 0.20, gain: 0.9 },              // high tom
  49: { hz: 0, noise: 1.0, decay: 0.90, bright: 0.85, gain: 0.55 },  // crash
  50: { hz: 300, noise: 0.10, decay: 0.18, gain: 0.9 },              // high tom 2
  51: { hz: 0, noise: 1.0, decay: 0.55, bright: 0.95, gain: 0.45 },  // ride
  52: { hz: 0, noise: 1.0, decay: 0.80, bright: 0.8, gain: 0.5 },    // china
  53: { hz: 1200, noise: 0.55, decay: 0.35, gain: 0.5 },             // ride bell
  54: { hz: 0, noise: 1.0, decay: 0.12, bright: 1.0, gain: 0.45 },   // tambourine
  55: { hz: 0, noise: 1.0, decay: 0.60, bright: 0.9, gain: 0.5 },    // splash
  56: { hz: 820, noise: 0.15, decay: 0.20, gain: 0.55 },             // cowbell
  57: { hz: 0, noise: 1.0, decay: 0.95, bright: 0.8, gain: 0.55 },   // crash 2
  59: { hz: 0, noise: 1.0, decay: 0.50, bright: 0.95, gain: 0.45 },  // ride 2
  60: { hz: 400, noise: 0.10, decay: 0.16, gain: 0.8 },              // high bongo
  61: { hz: 300, noise: 0.10, decay: 0.18, gain: 0.8 },              // low bongo
  62: { hz: 340, noise: 0.12, decay: 0.16, gain: 0.8 },              // conga
  63: { hz: 260, noise: 0.12, decay: 0.18, gain: 0.8 },              // conga 2
  64: { hz: 200, noise: 0.12, decay: 0.22, gain: 0.8 },              // low conga
};
const DEFAULT: Drum = { hz: 0, noise: 1.0, decay: 0.07, bright: 1.0, gain: 0.4 };

export class PercussionVoice {
  private drum: Drum = DEFAULT;
  private phase = 0;
  private env = 0;
  private t = 0;
  private level = 0;
  /** Deterministic noise, so a render is reproducible. */
  private lfsr = 0x7FFF;
  private dark = 0;
  active = false;

  private noiseSample(bright: number) {
    // 15-bit maximal LFSR, as the chip's noise generator is.
    const bit = ((this.lfsr >> 0) ^ (this.lfsr >> 1)) & 1;
    this.lfsr = (this.lfsr >> 1) | (bit << 14);
    const raw = ((this.lfsr & 0xFF) / 127.5) - 1;
    // A one-pole low pass turns white noise into the duller sound of a
    // tom or a china, and leaves a hi-hat alone.
    this.dark += (raw - this.dark) * bright;
    return bright >= 1 ? raw : this.dark;
  }

  strike(note: number, velocity: number) {
    this.drum = DRUMS[note] ?? DEFAULT;
    this.phase = 0; this.t = 0; this.env = 1;
    this.level = (velocity / 127) * (this.drum.gain ?? 0.8);
    this.active = true;
  }

  sample(rate: number): number {
    if (!this.active) return 0;
    const d = this.drum;
    this.t += 1 / rate;
    // 60 dB of decay over the drum's lifetime.
    this.env = Math.pow(10, -3 * this.t / d.decay);
    if (this.env < 0.0005) { this.active = false; return 0; }
    let v = 0;
    if (d.hz > 0) {
      // A kick gets its punch from the pitch falling during the decay.
      const end = d.hzEnd ?? d.hz;
      const k = Math.min(1, this.t / d.decay);
      const hz = d.hz + (end - d.hz) * k;
      this.phase += hz / rate;
      v += Math.sin(2 * Math.PI * this.phase) * (1 - d.noise);
    }
    if (d.noise > 0) v += this.noiseSample(d.bright ?? 1) * d.noise;
    return v * this.env * this.level;
  }
}
