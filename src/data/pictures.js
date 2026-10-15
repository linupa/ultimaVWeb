// pictures.js - the names of the game's picture files, as the Pictures class. The names come from
// DATA.OVL: a table of string offsets at ds:25EA. The same table tells the loader which files
// are compressed: exactly these. Ported from the C++ port's pictures.h.
import { data } from './gamedata.js';
import { strings } from './strings.js';

/** The table's entries, in its order. */
export const P = Object.freeze({
  STORY_FONT: 0, BRITISH_BITMAP: 1, TITLE_BITMAP: 2, TILES: 3, DUNGEON_DOORS: 4,
  DUNGEON_WALLS_1: 5, DUNGEON_WALLS_2: 6, DUNGEON_WALLS_3: 7, MONSTER_0: 8,
  CREATE: 16, STORY_BACKGROUND: 17, STORY_1: 18, ENDING_1: 24, ENDING_2: 25,
  LOGO: 26, START_SCROLL: 27, END_SCROLL: 28, COUNT: 29,
});

export class Pictures {
  constructor() {
    this.ids = data.words(0x25ea, new Array(P.COUNT).fill(0), 'pictures.names');
  }

  /** The file's name ("TILES.16"). */
  name(file) {
    return file < P.COUNT ? strings.get(this.ids[file]) : '';
  }

  dungeon(n) { return this.name(P.DUNGEON_DOORS + (n & 3)); }
  monster(n) { return this.name(P.MONSTER_0 + (n & 7)); }
  story(n) { return n < 6 ? this.name(P.STORY_1 + n) : ''; }
  ending(n) { return this.name(P.ENDING_1 + (n & 1)); }

  /** Is this one of the picture files? Those are the compressed ones (any case). */
  has(name) {
    const upper = name.toUpperCase();
    for (let i = 0; i < P.COUNT; i++) if (this.name(i).toUpperCase() === upper) return true;
    return false;
  }
}

export const pictures = new Pictures();
