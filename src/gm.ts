/**
 * Playing an SCI score on a General MIDI synthesiser.
 *
 * SCI's program changes select patches on a Roland MT-32, which is not
 * a General MIDI instrument and shares neither its numbering nor its
 * sounds.  So a program change means nothing to a GM synthesiser until
 * it has been through the game's own `patch.001`, which says which
 * timbre each patch uses, and then through a table that says which GM
 * instrument stands in for that timbre.
 *
 * Both halves of that are written here from published material: the
 * General MIDI Level 1 sound set, which is the names below, and the
 * MT-32's factory timbre list, which is what its front panel shows.
 * Everything joining the two is matched by name, so the judgement in
 * this file is confined to `ALIASES` -- small enough to read, argue
 * with and correct, rather than a hand-assigned number per timbre.
 *
 * Many of an SCI game's timbres are not instruments at all.  Camelot
 * carries "Swords  MS", "Horse1  MS" and "CstlGateMS", sounds written
 * for scenes rather than for music, and General MIDI has nothing that
 * stands in for them.  Those are left unmapped on purpose: a wrong
 * instrument is worse than a silent one, and the caller can decide.
 */

/** No GM instrument stands in for this timbre. */
export const UNMAPPED = -1;

/**
 * The General MIDI Level 1 sound set, in order.
 *
 * The index is the program number a GM synthesiser expects; the numbers
 * printed in the specification are these plus one.
 */
export const GM_NAMES: readonly string[] = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavi',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone',
  'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ',
  'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass',
  'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'SynthStrings 1', 'SynthStrings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet',
  'French Horn', 'Brass Section', 'SynthBrass 1', 'SynthBrass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax',
  'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute',
  'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
  'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto',
  'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock',
  'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet',
  'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];

/**
 * The MT-32's factory timbres, as its two banks of 64 number them.
 *
 * Bank B is not a separate space -- the patch bank offsets into it --
 * so this is one list of 128.
 */
export const MT32_PRESETS: readonly string[] = [
  // Bank A
  'AcouPiano1', 'AcouPiano2', 'AcouPiano3', 'ElecPiano1',
  'ElecPiano2', 'ElecPiano3', 'ElecPiano4', 'Honkytonk',
  'ElecOrgan1', 'ElecOrgan2', 'ElecOrgan3', 'ElecOrgan4',
  'PipeOrgan1', 'PipeOrgan2', 'PipeOrgan3', 'AccordionF',
  'Harpsi 1', 'Harpsi 2', 'Harpsi 3', 'Clavi 1',
  'Clavi 2', 'Clavi 3', 'Celesta 1', 'Celesta 2',
  'SynBrass1', 'SynBrass2', 'SynBrass3', 'SynBrass4',
  'SynBass 1', 'SynBass 2', 'SynBass 3', 'SynBass 4',
  'Fantasy', 'Harmo Pan', 'Chorale', 'Glasses',
  'Soundtrack', 'Atmosphere', 'Warm Bell', 'FunnyVox',
  'EchoBell', 'Ice Rain', 'Oboe 2001', 'Echo Pan',
  'DoctorSolo', 'Schooldaze', 'BellSinger', 'SquareWave',
  'Str Sect1', 'Str Sect2', 'Str Sect3', 'Pizzicato',
  'Violin 1', 'Violin 2', 'Cello 1', 'Cello 2',
  'Contrabass', 'Harp 1', 'Harp 2', 'Guitar 1',
  'Guitar 2', 'ElecGtr 1', 'ElecGtr 2', 'Sitar',
  // Bank B
  'Acou Bass1', 'Acou Bass2', 'ElecBass1', 'ElecBass2',
  'Slap Bass1', 'Slap Bass2', 'Fretless1', 'Fretless2',
  'Flute 1', 'Flute 2', 'Piccolo 1', 'Piccolo 2',
  'Recorder', 'Panpipes', 'Sax 1', 'Sax 2',
  'Sax 3', 'Sax 4', 'Clarinet1', 'Clarinet2',
  'Oboe', 'Engl Horn', 'Bassoon', 'Harmonica',
  'Trumpet 1', 'Trumpet 2', 'Trombone1', 'Trombone2',
  'Fr Horn 1', 'Fr Horn 2', 'Tuba', 'Brs Sect1',
  'Brs Sect2', 'Vibe 1', 'Vibe 2', 'SynMallet',
  'Wind Bell', 'Glock', 'Tube Bell', 'Xylophone',
  'Marimba', 'Koto', 'Sho', 'Shakuhachi',
  'Whistle 1', 'Whistle 2', 'BottleBlow', 'BreathPipe',
  'Timpani', 'MelodicTom', 'Deep Snare', 'Elec Perc1',
  'Elec Perc2', 'Taiko', 'Taiko Rim', 'Cymbal',
  'Castanets', 'Triangle', 'Orche Hit', 'Telephone',
  'Bird Tweet', 'OneNoteJam', 'WaterBells', 'JungleTune',
];

/**
 * Timbre names that do not read across to a GM name on their own.
 *
 * Keys are normalised the same way names are, and the values are GM
 * names rather than numbers so that a reader can check the pairing
 * without counting down the list.  This is the whole of the judgement
 * in this file.
 */
const ALIASES: Readonly<Record<string, string>> = {
  // Keyboards.  The MT-32's numbered variants all collapse.
  acoupiano: 'Acoustic Grand Piano', elecpiano: 'Electric Piano 1',
  honkytonk: 'Honky-tonk Piano', harpsi: 'Harpsichord', clavi: 'Clavi',
  celesta: 'Celesta', elecorgan: 'Percussive Organ', pipeorgan: 'Church Organ',
  accordionf: 'Accordion', accordion: 'Accordion',
  // Synthesised families.
  synbrass: 'SynthBrass 1', synbass: 'Synth Bass 1', squarewave: 'Lead 1 (square)',
  synmallet: 'Synth Drum', syndrum: 'Synth Drum',
  // The MT-32's well-known pads, which are what these games reach for.
  fantasy: 'Pad 1 (new age)', harmopan: 'Pad 7 (halo)', chorale: 'Pad 4 (choir)',
  glasses: 'FX 3 (crystal)', soundtrack: 'FX 2 (soundtrack)',
  atmosphere: 'FX 4 (atmosphere)', warmbell: 'Tinkle Bell', funnyvox: 'Synth Voice',
  echobell: 'FX 7 (echoes)', icerain: 'FX 1 (rain)', oboe2001: 'Oboe',
  echopan: 'FX 7 (echoes)', doctorsolo: 'Lead 5 (charang)', schooldaze: 'Pad 3 (polysynth)',
  bellsinger: 'Synth Voice', waterbells: 'Tinkle Bell', jungletune: 'Pad 6 (metallic)',
  onenotejam: 'Lead 8 (bass + lead)',
  // Strings and plucked.
  strsect: 'String Ensemble 1', string: 'String Ensemble 1',
  hstrsect: 'String Ensemble 1', pizzicato: 'Pizzicato Strings',
  pizz: 'Pizzicato Strings', basspizz: 'Pizzicato Strings',
  violin: 'Violin', cello: 'Cello', contrabass: 'Contrabass', harp: 'Orchestral Harp',
  celticharp: 'Orchestral Harp', guitar: 'Acoustic Guitar (nylon)',
  elecgtr: 'Electric Guitar (clean)', dirtgtr: 'Distortion Guitar',
  sitar: 'Sitar', koto: 'Koto',
  acoubass: 'Acoustic Bass', elecbass: 'Electric Bass (finger)',
  slapbass: 'Slap Bass 1', fretless: 'Fretless Bass',
  // Winds and brass.
  flute: 'Flute', piccolo: 'Piccolo', recorder: 'Recorder', panpipes: 'Pan Flute',
  sax: 'Alto Sax', clarinet: 'Clarinet', oboe: 'Oboe', englhorn: 'English Horn',
  bassoon: 'Bassoon', harmonica: 'Harmonica', trumpet: 'Trumpet', trombone: 'Trombone',
  frhorn: 'French Horn', tuba: 'Tuba', brssect: 'Brass Section',
  tbone: 'Trombone', calliope: 'Lead 3 (calliope)', organ: 'Church Organ',
  choir: 'Choir Aahs', voice: 'Voice Oohs',
  whistle: 'Whistle', bottleblow: 'Blown Bottle', breathpipe: 'Breath Noise',
  shakuhachi: 'Shakuhachi', shakuvib: 'Shakuhachi', sho: 'Shanai', reedpip: 'Recorder',
  // Tuned percussion.
  vibe: 'Vibraphone', windbell: 'Tinkle Bell', glock: 'Glockenspiel',
  tubebell: 'Tubular Bells', xylophone: 'Xylophone', marimba: 'Marimba',
  timpani: 'Timpani', melodictom: 'Melodic Tom', toms: 'Melodic Tom',
  deepsnare: 'Synth Drum', elecperc: 'Synth Drum', taiko: 'Taiko Drum',
  taikorim: 'Taiko Drum', cymbal: 'Reverse Cymbal', cymswell: 'Reverse Cymbal',
  castanets: 'Woodblock', triangle: 'Tinkle Bell', orchehit: 'Orchestra Hit',
  shaker: 'Woodblock', stonedr: 'Woodblock', club: 'Woodblock',
  conga: 'Melodic Tom', snare: 'Synth Drum', picsnare: 'Synth Drum',
  steeldrm: 'Steel Drums', squrwave: 'Lead 1 (square)', bell: 'Tinkle Bell',
  clangbell: 'Tubular Bells', revcymb: 'Reverse Cymbal', tom: 'Melodic Tom',
  /**
   * The few effects General MIDI does carry.
   *
   * The line drawn here is whether the sound set has something that is
   * actually the same *kind* of sound, not whether the timbre's name
   * looks like an instrument.  Coins are a case the first cut of this
   * table got wrong: "Coins   MS" was left unmapped with the swords and
   * the horses, on the rule that a wrong instrument is worse than a
   * silent one -- but a purse of coins is a bright pitched metal
   * chime, which is exactly what Tinkle Bell is, and dropping it left
   * Camelot's purse opening in silence.  The rule holds for a horse;
   * it does not hold for anything GM can really make.
   */
  coins: 'Tinkle Bell',
  /**
   * Three more the games strike rather than play, chosen from how they
   * are built rather than from what they are called.  The bank's AdLib
   * definitions say what kind of sound each is, and that is a better
   * guide than the name: an "Armor" that turned out to be a soft pad
   * would want a pad, whatever it is called.
   *
   * Swords is a fast attack on a very high, inharmonic multiplier --
   * bright, clangy and gone at once, which is a struck metal bar.
   * Armor has a slow-rising second operator over a quick decay and is
   * played low, 29 to 52, so it rings rather than pings.  Thunder rises
   * from nothing on both operators, the upper one inharmonic: a noisy
   * swell, which is the one shape General MIDI really does have.
   */
  sword: 'Tubular Bells',
  armor: 'Steel Drums', armour: 'Steel Drums',
  thunder: 'Reverse Cymbal',
  telephone: 'Telephone Ring', birdtweet: 'Bird Tweet', ratsqueek: 'Bird Tweet',
  ocean: 'Seashore', wtrfall: 'Seashore', splash: 'Seashore', bubbles: 'Seashore',
  wind: 'Seashore', applause: 'Applause', explode: 'Gunshot', firedart: 'Gunshot',
  somebird: 'Bird Tweet', whiporill: 'Bird Tweet', chirps: 'Bird Tweet',
  cricket: 'Bird Tweet', owl: 'Bird Tweet',
  // Bass variants the banks spell their own way.
  sqbass: 'Synth Bass 1', ebass: 'Electric Bass (finger)',
  stabbass: 'Synth Bass 1', pinkbass: 'Synth Bass 2',
};

/**
 * Timbres whose number means something on both sides.
 *
 * Dropping digits is right for "AcouPiano1" through "AcouPiano3", which
 * General MIDI has one sound for.  It is wrong for the families the
 * sound set numbers too: the MT-32's three string sections would all
 * become String Ensemble 1 and the pair GM offers would go unused.
 * These are keyed with the digits kept, and tried first.
 */
const NUMBERED: Readonly<Record<string, string>> = {
  strsect1: 'String Ensemble 1', strsect2: 'String Ensemble 2',
  // The MT-32 has a third; the sound set does not.
  strsect3: 'String Ensemble 1',
  synbrass1: 'SynthBrass 1', synbrass2: 'SynthBrass 2',
  synbrass3: 'SynthBrass 1', synbrass4: 'SynthBrass 2',
  synbass1: 'Synth Bass 1', synbass2: 'Synth Bass 2',
  synbass3: 'Synth Bass 1', synbass4: 'Synth Bass 2',
  slapbass1: 'Slap Bass 1', slapbass2: 'Slap Bass 2',
};

/**
 * A GM name, folded for lookup.
 *
 * Digits are kept.  Dropping them collapses every numbered pair in the
 * sound set -- "String Ensemble 1" and "String Ensemble 2" become one
 * key, and whichever is defined last silently wins every lookup of
 * either.  That is how "Str Sect1" came out as String Ensemble 2.
 */
const gmKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A timbre name, folded for lookup.
 *
 * Here the digits do go: Sierra's composers signed their timbres, and
 * the MT-32's numbered variants of one sound -- "AcouPiano1" through
 * "AcouPiano3" -- are a single instrument to General MIDI.
 */
export function normalise(name: string): string {
  return name.toLowerCase()
    .replace(/\s*ms\s*$/, '')
    .replace(/[^a-z]/g, '')
    .replace(/\d+$/, '');
}

const BY_GM_NAME = new Map(GM_NAMES.map((n, i) => [gmKey(n), i]));
const gmIndex = (name: string) => BY_GM_NAME.get(gmKey(name)) ?? UNMAPPED;

/**
 * The GM program that stands in for a timbre, or `UNMAPPED`.
 *
 * Tried in order: the name as a GM name, the alias table, and then the
 * longest alias the name begins with -- which is what catches the
 * banks' truncations, "CelticHarp" and "RecorderMS" having been cut to
 * ten characters before anybody thought about General MIDI.
 */
export function gmForTimbre(name: string): number {
  const exact = BY_GM_NAME.get(gmKey(name));
  if (exact !== undefined) return exact;
  // The composers' initials go, but the family's number stays.
  const numbered = NUMBERED[gmKey(name.toLowerCase().replace(/\s*ms\s*$/, ''))];
  if (numbered !== undefined) return gmIndex(numbered);
  const key = normalise(name);
  if (!key) return UNMAPPED;
  const alias = ALIASES[key];
  if (alias !== undefined) return gmIndex(alias);
  let best = '';
  for (const k of Object.keys(ALIASES))
    if (key.startsWith(k) && k.length > best.length) best = k;
  return best ? gmIndex(ALIASES[best]) : UNMAPPED;
}
