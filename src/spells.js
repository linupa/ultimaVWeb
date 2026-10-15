// spells.js - the spell tables, as the Spells class; `spells` is the one object. Ported from the
// C++ port's spells.h.
import { data } from './data/gamedata.js';
import { S, strings } from './data/strings.js';

export class Spells {
  static COUNT = 0x30;
  static REAGENTS = 8;
  constructor() {
    this.reagentNames = data.words(0x19d2, new Array(Spells.REAGENTS).fill(0), 'spells.reagentNames');
    this.names = data.words(0x19e2, new Array(Spells.COUNT).fill(0), 'spells.names');
    this.syllables = data.words(0x1bfc, new Array(26).fill(0), 'spells.syllables');
    this.lettersOf = data.words(0x1c30, new Array(Spells.COUNT).fill(0), 'spells.letters');
    this.where = data.bytes(0x1c90, new Uint8Array(Spells.COUNT), 'spells.where');
    this.recipes = data.bytes(0x1cc0, new Uint8Array(Spells.COUNT), 'spells.recipes');
    this.coneSteps = data.words(0x1cf0, new Int16Array(21), 'spells.coneSteps');
  }
  recipe(spell) { return spell < Spells.COUNT ? this.recipes[spell] : 0; }
  name(spell) { return strings.get(spell < Spells.COUNT ? this.names[spell] : S.NONE); }
  letters(spell) { return strings.get(spell < Spells.COUNT ? this.lettersOf[spell] : S.NONE); }
  /** The word of power a letter stands for: 'A' "AN" ... 'Z' "ZU"; J and O have none. */
  syllable(letter) { return strings.get(letter >= 0x41 && letter <= 0x5a ? this.syllables[letter - 0x41] : S.NONE); }
  reagentName(r) { return strings.get(r < Spells.REAGENTS ? this.reagentNames[r] : S.NONE); }
}

export const spells = new Spells();
