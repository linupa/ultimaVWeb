// items.js - the item tables, as the Items class; `items` is the one object. Ported from the C++
// port's items.h.
//
// An item id is the index into the inventory (party.inventory): 0x00-0x03 helms, 0x04-0x08 shields,
// 0x09-0x0F armour, 0x10-0x29 weapons, 0x2A-0x2C rings, 0x2D-0x2F amulets; 0xFF is "none". The byte
// tables are read with any byte as the index (spells fly as items past the last one), so each is
// the 256 bytes from its start.
import { data, SHARED } from './data/gamedata.js';
import { S, strings } from './data/strings.js';

export class Items {
  static COUNT = 0x30;
  static SPECIALS = 0x26;
  constructor() {
    this.names = data.words(0x17f6, new Array(Items.COUNT).fill(0), 'items.names');
    this.specialNames = data.words(0x1916, new Array(Items.SPECIALS).fill(0), 'items.specialNames');
    this.shortNames = data.words(0x1962, new Array(0x38).fill(0), 'items.shortNames');
    this.foundNames = data.words(0x419c, new Array(16).fill(0), 'items.foundNames'); // potion colours, then scroll letters
    this.prices = data.words(0x3a82, new Uint16Array(Items.COUNT), 'items.prices');
    this.tradeNames = data.words(0x3cce, new Array(Items.COUNT).fill(0), 'items.tradeNames');
    this.readyMark = data.bytes(0x1ae8, new Uint8Array(256), 'items.readyMark', SHARED);
    this.damages = data.bytes(0x15fc, new Uint8Array(256), 'items.damage', SHARED);
    this.ranges = data.bytes(0x1664, new Uint8Array(256), 'items.range', SHARED);
    this.missiles = data.bytes(0x169c, new Uint8Array(256), 'items.missile', SHARED);
    this.handsOf = data.bytes(0x1a7e, new Uint8Array(256), 'items.hands', SHARED);
    this.weights = data.bytes(0x1aae, new Uint8Array(256), 'items.weight', SHARED);
  }
  /** A weapon's damage; 0 = not a weapon. */
  damage(item) { return this.damages[item & 0xff]; }
  /** The reach of an attack; 0 = hand to hand. */
  range(item) { return this.ranges[item & 0xff]; }
  /** The kind of missile drawn. */
  missile(item) { return this.missiles[item & 0xff]; }
  /** Where it is worn or held (readyItem). */
  hands(item) { return this.handsOf[item & 0xff]; }
  /** The strength it takes to carry. */
  weight(item) { return this.weights[item & 0xff]; }
  /** The short name of the Arms page (0x30-0x37 the eight colours). */
  shortName(item) { return strings.get(item < 0x38 ? this.shortNames[item] : S.NONE); }
  shortNameId(item) { return item < 0x38 ? this.shortNames[item] : S.NONE; }
  specialNameId(n) { return n < Items.SPECIALS ? this.specialNames[n] : S.NONE; }
  name(item) {
    return strings.get(item < Items.COUNT ? this.names[item] : S.NONE);
  }
  /** A potion's colour, 0 "blue" ... 7 "white". */
  potionColour(n) {
    return strings.get(n < 16 ? this.foundNames[n] : S.NONE);
  }
  /** A scroll's spell in letters, 0 "VL" ... 7 "AT" (in the rune font). */
  scrollLetters(n) {
    return strings.get(this.foundNames[8 + (n & 7)]);
  }
}

export const items = new Items();
