// monsters.js - what the game knows about each kind of monster: the read-only monster tables, as
// the Monsters class; `monsters` is the one object. Ported from the C++ port's monsters.h.
//
// A monster type is 0-0x2F: 0x00-0x0F are people (mage, bard, ... guard, Lord British), 0x10 on
// the creatures; a map object's tile gives it as (tile - 0x40) >> 2. The original reads the byte
// and word tables with any byte as the index, so each is the 256 entries from its start.
import { data, SHARED } from './data/gamedata.js';
import { S, strings } from './data/strings.js';

export class Monsters {
  static COUNT = 0x30;
  constructor() {
    this.stats = data.bytes(0x13bc, new Uint8Array(256 * 8), 'monsters.stats', SHARED); // 8 bytes a type
    this.flagsOf = data.words(0x153c, new Uint16Array(256), 'monsters.flags', SHARED);
    this.attackRanges = data.bytes(0x159c, new Uint8Array(256), 'monsters.attackRange', SHARED);
    this.missiles = data.bytes(0x15cc, new Uint8Array(256), 'monsters.missile', SHARED);
    this.companions = data.bytes(0x16d4, new Uint8Array(256), 'monsters.companion', SHARED);
    this.ambushers = data.bytes(0x1734, new Uint8Array(8), 'monsters.ambushers');
    this.names = data.words(0x1856, new Array(Monsters.COUNT).fill(0), 'monsters.names');
    this.groupNames = data.words(0x18b6, new Array(Monsters.COUNT).fill(0), 'monsters.groupNames');
  }
  strength(t) { return this.stats[(t & 0xff) * 8]; }
  speed(t) { return this.stats[(t & 0xff) * 8 + 1]; } // dexterity
  intelligence(t) { return this.stats[(t & 0xff) * 8 + 2]; }
  armour(t) { return this.stats[(t & 0xff) * 8 + 3]; }
  damage(t) { return this.stats[(t & 0xff) * 8 + 4]; }
  hp(t) { return this.stats[(t & 0xff) * 8 + 5]; } // experience is hp / 4 + 1
  groupSize(t) { return this.stats[(t & 0xff) * 8 + 6]; }
  treasure(t) { return this.stats[(t & 0xff) * 8 + 7]; }
  /** 0x8000 undead (turned), 0x2000 teleports, 0x1000 vanishes, 0x10 divides, ... */
  flags(t) { return this.flagsOf[t & 0xff]; }
  attackRange(t) { return this.attackRanges[t & 0xff]; }
  missile(t) { return this.missiles[t & 0xff]; }
  companion(t) { return this.companions[t & 0xff]; }
  ambusher(n) { return this.ambushers[n & 7]; }
  /** "Sea Serpent" */
  name(t) { return strings.get(t < Monsters.COUNT ? this.names[t] : S.NONE); }
  /** "SEA SERPENTS", for a group met outdoors. */
  groupName(t) { return strings.get(t < Monsters.COUNT ? this.groupNames[t] : S.NONE); }
}

export const monsters = new Monsters();
