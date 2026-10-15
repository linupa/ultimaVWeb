// party.js - the party: its members and what it carries, as the Party class; `party` is the one
// object. All of it is part of the saved game. Ported from the C++ port's party.h.
import { data } from './data/gamedata.js';
import { savegame } from './savegame.js';
import { structView } from './struct.js';

/** A character of the roster: 32 bytes, as in SAVED.GAM. */
export const PartyMember = structView({
  name: [0, 'chars', 9],
  sex: [9, 'u8'], // 0x0B male, 0x0C female
  cls: [10, 'char'], // 'A'vatar 'F'ighter 'B'ard 'M'age
  status: [11, 'char'], // 'G'ood 'P'oisoned 'S'leeping 'D'ead
  str: [12, 'u8'],
  dex: [13, 'u8'],
  intel: [14, 'u8'],
  mp: [15, 'u8'],
  hp: [16, 'u16'],
  maxHp: [18, 'u16'],
  xp: [20, 'u16'],
  level: [22, 'u8'],
  innMonths: [23, 'u8'],
  armour: [24, 'u8'],
  helm: [25, 'u8'],
  body: [26, 'u8'],
  leftHand: [27, 'u8'],
  rightHand: [28, 'u8'],
  ring: [29, 'u8'],
  amulet: [30, 'u8'],
  where: [31, 'u8'], // 0 in the party, else the location left at; 0x7F dead
});
Object.assign(PartyMember.prototype, {
  good() { return this.status === 'G'; },
  poisoned() { return this.status === 'P'; },
  asleep() { return this.status === 'S'; },
  dead() { return this.status === 'D'; },
});

export class Party {
  static MAX_SIZE = 6;
  static ROSTER_SIZE = 16;

  constructor() {
    this.roster = new Uint8Array(Party.ROSTER_SIZE * 32); // ds:55A8
    this.members = Array.from({ length: Party.ROSTER_SIZE }, (_, i) => new PartyMember(this.roster, i * 32));
    this.nobody = new PartyMember(new Uint8Array(32)); // what an index past the roster gives
    this.activePlayer = 0; // 0xFF = none
    this.karma = 0;
    this.activeSpell = 0; // the letter of the lasting effect, 0 none
    this.activeSpellTurns = 0;
    this.lightSpell = 0;
    this.torchLight = 0;
    this.transport = 0; // the party's tile: 0x1C/0x1D on foot, 0x20-0x27 a ship, ...
    this.sailDirection = 0;
    this.sailCounter = 0;
    this.needPrompt = 0;
    this.sacredQuest = 0;
    this.codexAnswered = 0;
    this.summonedShadowlord = 0;
    this.food = 0;
    this.gold = 0;
    this.keys = 0;
    this.gems = 0;
    this.torches = 0;
    this.grapples = 0;
    this.magicCarpets = 0;
    this.oddKeys = 0;
    this.inventory = new Uint8Array(48);
    this.mixedSpells = new Uint8Array(48);
    this.scrolls = new Uint8Array(8);
    this.potions = new Uint8Array(8);
    this.reagents = new Uint8Array(8);
    this.lbAmulet = 0;
    this.lbCrown = 0;
    this.lbSceptre = 0;
    this.shards = new Uint8Array(3);
    this.spyglass = 0;
    this.hmsCapePlans = 0;
    this.sextant = 0;
    this.pocketWatch = 0;
    this.blackBadge = 0;
    this.sandalwoodBox = 0;
    this.size = 0; // members in the party

    const s = savegame;
    s.bytes(0x55a8, this.roster, 'party.members');
    s.u16(0x57a8, this, 'food', 'party.food');
    s.u16(0x57aa, this, 'gold', 'party.gold');
    for (const [off, key] of [[0x57ac, 'keys'], [0x57ad, 'gems'], [0x57ae, 'torches'], [0x57af, 'grapples'], [0x57b0, 'magicCarpets'],
      [0x57b1, 'oddKeys'], [0x57b3, 'lbAmulet'], [0x57b4, 'lbCrown'], [0x57b5, 'lbSceptre'], [0x57ba, 'spyglass'], [0x57bb, 'hmsCapePlans'],
      [0x57bc, 'sextant'], [0x57bd, 'pocketWatch'], [0x57be, 'blackBadge'], [0x57bf, 'sandalwoodBox'], [0x585b, 'size'],
      [0x587a, 'activeSpell'], [0x587b, 'activePlayer'], [0x587c, 'transport'], [0x5883, 'sailCounter'], [0x5888, 'karma'],
      [0x588e, 'activeSpellTurns'], [0x58a6, 'lightSpell'], [0x58a7, 'torchLight'], [0x58cb, 'summonedShadowlord'],
      [0x58cc, 'sacredQuest'], [0x58ce, 'codexAnswered'], [0x5955, 'sailDirection'], [0x5956, 'needPrompt']]) {
      s.u8(off, this, key, `party.${key}`);
    }
    s.bytes(0x57b6, this.shards, 'party.shards');
    s.bytes(0x57c0, this.inventory, 'party.inventory');
    s.bytes(0x57f0, this.mixedSpells, 'party.mixedSpells');
    s.bytes(0x5820, this.scrolls, 'party.scrolls');
    s.bytes(0x5828, this.potions, 'party.potions');
    s.bytes(0x5850, this.reagents, 'party.reagents');

    // Read-only tables, from DATA.OVL. A class is its place in "AMBFDTPRS" (9 = none of them).
    this.classTiles = data.bytes(0x1ade, new Uint8Array(10), 'party.classTiles');
    this.karmaTexts = data.words(0x1a74, new Uint16Array(6), 'party.karmaTexts');
  }

  /** Roster entry i; an index past the roster gives a spare entry, as in the C++ port. */
  member(i) {
    return i < Party.ROSTER_SIZE ? this.members[i] : this.nobody;
  }

  /** Members that aren't dead. */
  living() {
    let n = 0;
    for (let i = 0; i < this.size; i++) if (!this.members[i].dead()) n++;
    return n;
  }

  /** The first member who can act (good or poisoned); 0, the Avatar, if nobody can. */
  firstAble() {
    for (let i = 0; i < this.size; i++) if (this.members[i].good() || this.members[i].poisoned()) return i;
    return 0;
  }

  /** Swaps two roster entries' 32 bytes (New Order). */
  swapMembers(a, b) {
    const t = this.roster.slice(a * 32, a * 32 + 32);
    this.roster.copyWithin(a * 32, b * 32, b * 32 + 32);
    this.roster.set(t, b * 32);
  }

  full() {
    return this.size === Party.MAX_SIZE;
  }
  alone() {
    return this.size === 1;
  }

  /** Roster entry i joins as the last member; the entry in that slot takes its place (talk). */
  swapIn(i) {
    const n = this.size;
    this.members[i].where = 0;
    this.swapMembers(i, n);
    this.size++;
    return this.members[n];
  }

  /** Roster entry i joins as the last member; the entries between move up, keeping their order (inn). */
  moveIn(i) {
    const n = this.size;
    const tmp = this.roster.slice(i * 32, i * 32 + 32);
    if (n < i) this.roster.copyWithin((n + 1) * 32, n * 32, i * 32); // make room
    tmp[31] = 0; // where
    this.roster.set(tmp, n * 32);
    this.size++;
    return this.members[n];
  }

  /** Member i leaves for the end of the roster and the rest close up. */
  moveOut(i) {
    const last = Party.ROSTER_SIZE - 1;
    const tmp = this.roster.slice(i * 32, i * 32 + 32);
    if (i < last) this.roster.copyWithin(i * 32, (i + 1) * 32, Party.ROSTER_SIZE * 32);
    this.roster.set(tmp, last * 32);
    this.size--;
    return this.members[last];
  }

  classTile(cls) {
    return this.classTiles[cls < 10 ? cls : 9];
  }
  karmaText(k) {
    return this.karmaTexts[k < 6 ? k : 5];
  }
}

export const party = new Party();
