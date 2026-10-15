// combat.js - combat: the core of the main program (0000:5f86-6f1c), COMBAT.OVL (the battle loop,
// turns, monster behaviour, damage), the combat half of SJOG.OVL and COMSUBS.OVL (attacks, aiming
// and missiles), as the Combat class; `combat` is the one object. Ported from the C++ port's
// combat.cpp and comsubs.cpp.
//
// A battle runs on an 11 x 11 map from BRIT.CBT loaded into view.localMap (32-byte rows); the map
// id is SCENE meanwhile and the map's objects are kept in map.objectsBackup. Every fighter is a
// Combatant (slots 0-5 the party, 6-31 monsters) with a map object that shows it; the object's
// `skiffs` byte remembers the slot last aimed at and `hull` holds a monster's hit points.
// Combatant flags: 0x80 party member, 0x40 monster, 0x20 dead / gone, 0x10 invisible, 8 asleep,
// 4 swallowed, 2 fleeing, 1 changed sides (possessed or charmed).
import { getCommandKey, askDirection, tilePassable, waitTurns } from './commands.js';
import { data, SHARED } from './data/gamedata.js';
import { S, strings } from './data/strings.js';
import { dissolveTile } from './effects.js';
import { loadFilePart } from './files.js';
import { gameQuit } from './gamestate.js';
import { gameTime } from './gametime.js';
import { gfx } from './gfx.js';
import { input } from './input.js';
import { items } from './items.js';
import { rescueLordBritish } from './endings.js';
import { M, map, passTime } from './map.js';
import { addWordCapped, randomBetween, subWordFloor0 } from './misc.js';
import { monsters } from './monsters.js';
import { objectTileAt, randomUpto } from './objects.js';
import { party } from './party.js';
import { platform } from './platform/platform.js';
import { savegame } from './savegame.js';
import { sound } from './sound.js';
import { status } from './status.js';
import { structView } from './struct.js';
import { textWindows as tw } from './text.js';
import { tiles } from './tiles.js';
import { video } from './video/video.js';
import { view } from './view.js';
import { randomStatRoll } from './world.js';
import { cmdGet, cmdJimmy, cmdOpen, cmdSearch } from './sjog.js';
import { campRest, cmdPush, cmdYell, combatEscape } from './cmds.js';
import { cmdCast, cmdUse } from './magic.js';
import { cmdReady, cmdZstats } from './stats.js';
import { dungeon } from './dungeon.js';

/** A fighter in a battle: 8 bytes. */
export const Combatant = structView({
  hp: [0, 'u8'],
  speed: [1, 'u8'],
  flags: [2, 'u8'],
  kind: [3, 'u8'], // monster type or party member index
  object: [4, 'u8'], // index into map.objects
  timer: [5, 'u8'], // counts down to its next turn
  x: [6, 'u8'],
  y: [7, 'u8'],
});

const PATH_SIZE = 330;

/** The 11 x 11 view square a pixel is in; x 0xFFFF outside the view. */
export function pixelToSquare(py, px) {
  if (px < 8 || px > 0xb7 || py < 8 || py > 0xb7) return { x: 0xffff, y: 0xffff };
  return { x: (px - 8) >> 4, y: (py - 8) >> 4 };
}

/** By the bit table of tiles that can be seen (and shot) across. */
export function isSquareVisible(y, x) {
  return view.seenAcross(view.at((x + y * 0x20) & 0x1ff)) !== 0;
}

export function distanceSquared(y1, x1, y2, x2) {
  return (y2 - y1) * (y2 - y1) + (x2 - x1) * (x2 - x1);
}

/** e66a: the square root, rounded down. */
export function distance(y1, x1, y2, x2) {
  let rest = distanceSquared(y1, x1, y2, x2), root = 0;
  for (let odd = 1; odd <= rest; odd += 2) {
    rest -= odd;
    root++;
  }
  return root;
}

const s16 = (v) => ((v & 0xffff) << 16) >> 16;

export class Combat {
  static PATH_SIZE = PATH_SIZE;

  constructor() {
    this.combatantBytes = new Uint8Array(32 * 8);
    this.combatants = Array.from({ length: 32 }, (_, i) => new Combatant(this.combatantBytes, i * 8)); // 0-5 the party, 6-31 monsters
    this.monsterStartX = new Uint8Array(16);
    this.monsterStartY = new Uint8Array(16);
    this.partyStartX = new Uint8Array(6);
    this.partyStartY = new Uint8Array(6);
    this.onLadder = 0; // a corridor fight on a ladder square
    this.path = new Uint8Array(2 * PATH_SIZE); // a missile's flight in pixels, 0xFF ends: x, then y
    // Part of the saved game.
    this.turn = 0; // slot of the combatant whose turn it is; 0xFF none
    this.flags = 0; // 0x80 dungeon room, 2 corridor, 4 camp ambush
    this.event = 0; // 2 vanished, 8 poisoned, 0x10 escaped, 0x20 killed / missed
    this.exitDir = 0; // how the battle ended: 1-4 map side, 5 up, 6 down, 'M' endgame
    this.victory = 0;
    this.redraw = 0;
    this.minuteCtr = 0; // every 10 rounds a minute passes
    this.attackItem = 0; // weapon or missile in use; 0xFF bare hands
    this.castCircle = 0; // circle of the spell being cast; 0 for weapons
    this.magicAttack = 0; // 1 while a spell or magic weapon attacks
    this.aimX = 0;
    this.aimY = 0;
    this.lastAttacker = new Uint8Array(32);
    this.prevLocation = 0; // the location the battle or room was entered from
    const s = savegame;
    s.u8(0x5882, this, 'minuteCtr', 'combat.minuteCtr');
    s.u8(0x588f, this, 'castCircle', 'combat.castCircle');
    s.u8(0x5890, this, 'magicAttack', 'combat.magicAttack');
    s.u8(0x5894, this, 'prevLocation', 'combat.prevLocation');
    s.u8(0x5899, this, 'aimX', 'combat.aimX');
    s.u8(0x589a, this, 'aimY', 'combat.aimY');
    s.u8(0x589d, this, 'attackItem', 'combat.attackItem');
    s.u8(0x589e, this, 'turn', 'combat.turn');
    s.u8(0x589f, this, 'redraw', 'combat.redraw');
    s.u8(0x58a0, this, 'exitDir', 'combat.exitDir');
    s.u8(0x58a1, this, 'flags', 'combat.flags');
    s.u8(0x58a2, this, 'event', 'combat.event');
    s.u8(0x58a3, this, 'victory', 'combat.victory');
    s.bytes(0x58a8, this.lastAttacker, 'combat.lastAttacker');
    // The line figures of missile kinds 2 and 7 (ds:2188, ds:2198) and the bursts' offsets (ds:21BA).
    this.missileShapes = data.bytes(0x2188, new Int8Array(846), 'combat.missileShapes', SHARED);
  }

  c(slot) {
    return this.combatants[slot & 0x1f];
  }
  obj(c) {
    return map.objects.at(c.object & 0x1f);
  }
  lmap(y, x) {
    return view.localMap[(((y & 0xff) * 0x20) + (x & 0xff)) & 0x3ff];
  }

  // ---- the main program's part ----

  /** 5646: 0 the party's side, 1 the other. */
  combatantSide(slot) {
    const c = this.c(slot);
    if (c.flags & 0x20) return 0;
    if (!(c.flags & 0x80)) return (c.flags & 1) === 0 ? 1 : 0;
    // a member whose name has 'j' as its fifth letter (Saduj) is always an enemy
    if (c.kind === 0 || party.member(c.kind & 0x0f).name[4] !== 'j') return c.flags & 1;
    return 1;
  }

  /** 3564 */
  async flashCombatant(slot) {
    let c = null;
    if (map.inScene()) {
      c = this.c(slot);
      slot = c.object;
    }
    const o = map.objects.at(slot & 0x1f);
    tiles.drawTileAt(o.y, o.x, 0);
    if (!map.inScene() || !(c.flags & 0x80)) {
      await sound.soundNoise(2000, 3000, 10);
    } else {
      status.highlightMemberRow(c.kind);
      await sound.soundNoise(500, 3000, 0x28);
      status.highlightMemberRow(c.kind);
    }
    await view.worldTick();
  }

  /** 4368 */
  async victoryFanfare() {
    for (let i = 3; i !== 0; i--) await sound.soundSweep(6, 300, 0x2a30, 1, 0x11f8);
    await sound.soundSweep(3, 300, 0x5460, 1, 0x17d4);
  }

  /** 6d82 */
  inCombatBounds(y, x) {
    return !(x < 0 || x > 10 || y < 0 || y > 10);
  }

  /**
   * 6da8: the original sums a table value per equipment slot under a test that is never true, so
   * only the Protection spell counts; in Doom without item 0x0F as body armour it is 0.
   */
  getArmourBonus(member) {
    if (this.prevLocation === 0x28 && party.member(member).body !== 0x0f) return 0;
    return party.activeSpell === 0x50 ? 3 : 0;
  }

  /** 6e60: takes the item out of whichever slot holds it; 1 if it was worn. */
  unequipItem(item, member) {
    const m = party.member(member & 0x0f);
    let found = 1;
    if (item === m.helm) m.helm = 0xff;
    else if (item === m.body) m.body = 0xff;
    else if (item === m.leftHand) m.leftHand = 0xff;
    else if (item === m.rightHand) m.rightHand = 0xff;
    else if (item === m.ring) {
      m.ring = 0xff;
      if (item === 0x2a && map.inScene() && this.turn < 0x20) this.c(this.turn).flags &= 0xef; // visible again
    } else if (item === m.amulet) m.amulet = 0xff;
    else found = 0;
    this.getArmourBonus(member);
    return found;
  }

  /**
   * 6506: kind 0 a monster (slots 6 up), 1 a party member (from 0), 2 an object (a field, a chest:
   * no slot, the object index is returned). Objects that remembered a reused slot forget it.
   */
  addCombatant(z, y, x, kind, type) {
    let slot = -1, c = null;
    if (kind !== 2) {
      for (let i = kind === 0 ? 6 : 0; i < 0x20; i++) {
        if (this.combatants[i].flags !== 0) continue;
        c = this.combatants[i];
        if (kind === 1 && !party.member(type).dead()) {
          c.speed = party.member(type).dex;
          c.timer = 0x24 - c.speed;
          c.flags = 0x80;
          if (!party.member(type).good() && !party.member(type).poisoned()) c.flags |= 8;
        }
        if (kind === 0) {
          c.hp = monsters.hp(type);
          c.speed = randomUpto(7) - 4 + monsters.speed(type);
          if (c.speed > 0x1e) c.speed = monsters.speed(type);
          c.timer = 0x24 - c.speed;
          c.flags = type === 8 || type === 9 ? 0x20 : 0x40;
        }
        c.kind = type;
        c.x = x;
        c.y = y;
        slot = i;
        break;
      }
    }
    if (slot >= 0 || kind === 2) {
      let o;
      for (o = 0; o < 0x20; o++) {
        const ob = map.objects.at(o);
        if (ob.tile !== 0) continue;
        if (kind === 0) ob.tile = ob.tile2 = type * 4 + 0x40;
        if (kind === 2) {
          ob.tile = ob.tile2 = type;
          slot = o;
        }
        ob.x = x;
        ob.y = y;
        ob.z = z;
        ob.skiffs = 0xff;
        ob.hull = kind === 0 ? c.hp : type;
        if (kind !== 2) c.object = o;
        break;
      }
      if (kind !== 2 && o === 0x20) slot = -1;
    }
    if (slot >= 0)
      for (let i = 0; i < 0x20; i++) if (this.obj(this.combatants[i]).skiffs === slot) this.obj(this.combatants[i]).skiffs = 0xff;
    return slot;
  }

  /** 6794: a ring of invisibility (0x2A) hides its wearer (tile 0x1D); one of regeneration (0x2C) heals. */
  applyRingEffects(slot) {
    const c = this.c(slot);
    if (!(c.flags & 0x80) || (c.flags & 0x28)) return;
    if (party.member(c.kind & 0x0f).ring === 0x2a) {
      this.obj(c).tile2 = 0x1d;
      c.flags |= 0x10;
    } else if (party.member(c.kind & 0x0f).ring === 0x2c) {
      status.regenRingTick();
    }
  }

  /** 6800 */
  wakeCombatant(slot) {
    const c = this.c(slot);
    if (c.flags & 8) {
      if (!(c.flags & 0x80)) {
        this.obj(c).flags = 0;
      } else {
        party.member(c.kind & 0x0f).status = 'G';
        this.obj(c).tile2 = (c.flags & 0x10) ? 0x1d : this.obj(c).tile;
      }
      c.flags &= 0xf7;
    }
    status.drawStatusBar();
  }

  /** 6880 */
  async sleepUnlessPoisoned(slot) {
    const c = this.c(slot);
    if (!(c.flags & 0x80) || !party.member(c.kind & 0x0f).poisoned()) await this.sleepCombatant(slot);
  }

  /** 68ae */
  async sleepCombatant(slot) {
    const c = this.c(slot);
    if (!(c.flags & 0x80)) {
      c.flags |= 8;
      this.event = 4;
      this.obj(c).flags = 0xff; // stops its animation
    } else {
      const m = party.member(c.kind & 0x0f);
      if (m.dead()) return;
      m.status = 'S';
      c.flags |= 8;
      this.obj(c).tile2 = 0x1e;
      if (slot === party.activePlayer) party.activePlayer = 0xff;
      this.event = 4;
      status.drawStatusBar();
      if (this.flags & 4) return;
    }
    await view.worldTick();
  }

  /**
   * 6936: empties the objects and combatants and puts the living party on the map's start
   * squares, as mages (0x40), bards (0x44), fighters (0x48) or the Avatar (0x4C). Each ring of
   * invisibility or regeneration worn has 1 chance in 16 to vanish. A 0xDC in the middle of the
   * map (dungeon rooms) becomes a chest of level 3 x dungeon level + 7.
   */
  async clearCombatTables() {
    for (let i = 0; i < 0x20; i++) {
      const o = map.objects.at(i);
      o.flags = o.x = o.tile2 = o.tile = o.hull = o.z = o.y = 0;
      this.combatantBytes.fill(0, i * 8, i * 8 + 8);
    }
    for (let m = 0; m < party.size; m++) {
      const pm = party.member(m);
      if (pm.dead()) continue;
      if (pm.ring === 0x2a || pm.ring === 0x2c) {
        const ring = pm.ring;
        if (randomBetween(0x0f, 0) === 0x0b) {
          tw.printText(strings.get(S.A_ring_has_vanished_A422));
          await sound.soundSlide(0x28, 1, 2000, 0x4b0);
          this.unequipItem(ring, m);
        }
      }
      const slot = this.addCombatant(map.z, this.partyStartY[m], this.partyStartX[m], 1, m);
      if (slot < 0) continue;
      const o = this.obj(this.c(slot));
      o.skiffs = 0xff;
      switch (pm.cls) {
        case 'A': o.tile = 0x4c; break;
        case 'B': case 'S': case 'T': o.tile = 0x44; break;
        case 'D': case 'M': o.tile = 0x40; break;
        case 'F': case 'P': case 'R': o.tile = 0x48; break;
      }
      o.tile2 = o.tile;
      if (pm.asleep()) await this.sleepCombatant(slot);
      else this.applyRingEffects(slot);
    }
    if (view.localMap[0xa5] === 0xdc) {
      const o = this.addCombatant(map.z, 5, 5, 2, 1);
      map.objects.at(o & 0x1f).hull = map.z * 3 + 7;
      view.localMap[0xa5] = dungeon.corridorFloorTile;
    }
  }

  /**
   * 6bc2: monster + 0x100 means the type's full group even in a town, where otherwise one fights
   * alone (except type 0x0C). The group is 1 to the type's size, rolled twice while noAmbush is
   * set; sizes 1, 8 and 16 are exact. Among the first quarter 1 in 9 is the type's companion. The
   * start squares come from the combat map, shuffled for an ambush (flags 4). At most 16.
   */
  async placeMonsterGroup(monster, flags) {
    const alone = monster < 0x100;
    if (!alone) monster -= 0x100;
    this.exitDir = 0;
    if (!(flags & 4)) await this.clearCombatTables();
    const order = [];
    for (let i = 0; i < 0x10; i++) order[i] = i;
    if (flags & 4)
      for (let i = 0; i < 0x10; i++) {
        const j = randomBetween(0x0f, 0), t = order[i];
        order[i] = order[j];
        order[j] = t;
      }
    tw.printText(strings.get(S.CONFLICT_A438));
    let count;
    if (this.prevLocation === 0 || this.prevLocation > 0x20 || monster === 0x0c || !alone) count = monsters.groupSize(monster);
    else count = 1;
    if (count !== 8 && count !== 0x10 && count !== 1) {
      count = randomBetween(count, 1);
      if (gameTime.noAmbush !== 0) count = randomBetween(count, 1);
      await view.worldTick();
      if (count > 0x19) count = 0x1a;
    }
    this.addCombatant(map.z, this.monsterStartY[order[0]], this.monsterStartX[order[0]], 0, monster);
    for (let i = 1; i < count && i < 0x10; i++) {
      let type = monster;
      if (i < Math.trunc(count / 4) + 1 && randomUpto(8) === 0) type = monsters.companion(monster);
      this.addCombatant(map.z, this.monsterStartY[order[i]], this.monsterStartX[order[i]], 0, type);
    }
  }

  /**
   * 60ec: map n of BRIT.CBT: eleven 32-byte rows. The columns right of the 11 x 11 map hold the
   * start squares: the party's x at 0x6B and y at 0x71, the monsters' x at 0xCB and y at 0xEB.
   */
  loadCombatMap(mapNo) {
    loadFilePart(mapNo * 0x160, 0x160, view.localMap, strings.get(S.BRIT_CBT_A3F0));
    this.partyStartX.set(view.localMap.subarray(0x6b, 0x6b + 6));
    this.partyStartY.set(view.localMap.subarray(0x71, 0x71 + 6));
    this.monsterStartX.set(view.localMap.subarray(0xcb, 0xcb + 16));
    this.monsterStartY.set(view.localMap.subarray(0xeb, 0xeb + 16));
  }

  /**
   * 5f86: flags 0 a fight with map object `object`; 4 a camp (arg = hours, object = the guard);
   * 2 a dungeon corridor (the map was built by setupCorridorCombat). The map's objects are put aside.
   */
  async runCombat(arg, object, flags) {
    const x = map.x, y = map.y, z = map.z, active = party.activePlayer;
    this.flags = flags;
    this.prevLocation = map.id;
    map.id = M.SCENE;
    map.objectsBackup.set(map.objects.bytes);
    let fight = 1;
    if (flags === 0) {
      const o = map.objects.at(object & 0x1f);
      let monster = (o.tile & 0xfc) === 0x2c ? 1 : (o.tile - 0x40) >>> 2;
      if (o.hull > 0x7f) monster += 0x100;
      await this.placeMonsterGroup(monster, 1);
    } else if (flags & 4) {
      fight = await campRest(arg, object, flags);
    } else if (flags & 2) {
      await dungeon.placeCombatants(2, 0);
    } else {
      fight = 0;
    }
    if (fight) {
      party.activePlayer = 0xff;
      this.turn = 0xff;
      this.victory = 0;
      await this.combatMainLoop();
    }
    if (this.onLadder !== 0) {
      this.onLadder = 0;
      tiles.ladderTilesPatch(1);
    }
    map.id = this.prevLocation;
    view.rebuild = true;
    map.z = z;
    map.x = x;
    map.y = y;
    status.drawStatusBar();
    // with no active player the original tests "member 255": the spare entry, neither dead nor asleep
    const st = party.member(active).status;
    party.activePlayer = st === 'D' || st === 'S' ? 0xff : active;
    map.objects.bytes.set(map.objectsBackup);
  }

  /**
   * 6150: the combat map comes from the terrain under the enemy: 1 swamp, 2 grass, 3 scrub and
   * desert, 4 forest, 5 hills, 6 mountains, 7 bridges and such, 8 floors and anything in a town,
   * 10 a Shadowlord, 11-14 aboard ship, 12 pirates from land, 15 on water.
   */
  async combatWithObject(object) {
    const o = map.objects.at(object & 0x1f);
    const kind = o.tile & 0xfc;
    tw.putChar(0x0a);
    tw.putChar(0xfc);
    tw.printText(kind < 0x40 ? strings.get(S.PIRATES_A3FA) : monsters.groupName((kind - 0x40) >>> 2));
    tw.putChar(0xfb);
    tw.printText(strings.get(S.NL_NL_A402));
    const t = map.getTile(o.y, o.x);
    let water = t < 4 || ((t & 0xfe) !== 0x6a && (t & 0xf0) === 0x60);
    const other = map.isOutdoors() ? 2 : 8;
    let mapNo;
    if (kind === 0xfc) {
      mapNo = 10;
      if (party.lbSceptre !== 0) {
        tw.printText(strings.get(S.The_Sceptre_is_reclaimed_A406));
        await sound.soundSweep(1, 1, -0x218, 1, 0xfd2);
        party.lbSceptre = 0;
      }
    } else {
      if ((kind & 0xf0) === 0x80) water = true; // sea monsters
      if ((party.transport & 0xf8) === 0x20) mapNo = kind === 0x2c ? 0x0e : water ? 0x0b : 0x0d;
      else if (kind === 0x2c) mapNo = 0x0c;
      else if (water) mapNo = 0x0f;
      else if (t === 4) mapNo = 1;
      else if (t === 5) mapNo = 2;
      else if (t === 6 || t === 8) mapNo = 3;
      else if (t === 7 || t === 0x1e || t === 0x1f) mapNo = 4;
      else if (t === 9 || t === 0x0a) mapNo = 5;
      else if (t >= 0x0b && t <= 0x0f) mapNo = 6;
      else if (t === 0x1d || t === 0x48 || t === 0x49 || t === 0x6a || t === 0x6b) mapNo = 7;
      else if (t === 0x44) mapNo = 8;
      else mapNo = other;
    }
    this.loadCombatMap(mapNo);
    await this.runCombat(0, object, 0);
    await this.combatCleanup(object);
    view.updateLightMap();
    passTime(0);
  }

  /** 6360 */
  async campAmbushCombat(hours, guard) {
    this.loadCombatMap(0);
    await this.runCombat(hours, guard, 4);
    view.updateLightMap();
  }

  // ---- COMBAT.OVL ----

  /** a290: off the map counts as free. Fields 0xE8-0xEA, bodies and invisible things don't block; 0xEB does. */
  combatTileFree(y, x, mover) {
    const ix = s16(x), iy = s16(y);
    if (ix >= 0x0b || iy >= 0x0b || ix < 0 || iy < 0) return 1;
    const t = map.getTile(iy, ix);
    if (!tilePassable(t, mover) || t === 0xff) return 0;
    for (let i = 0; i < 0x20; i++) {
      const o = map.objects.at(i);
      const c = this.combatants[i];
      if (o.x === ix && o.y === iy) {
        if (o.tile === 0xeb) return 0;
        if ((o.tile & 0xfc) !== 0xe8 && o.tile !== 0x1e && o.tile !== 0x1f && o.tile !== 0 && o.tile2 !== 0) return 0;
      } else if (c.x === ix && c.y === iy && (c.flags & 0x24) === 0 && c.flags !== 0) {
        return 0;
      }
    }
    return 1;
  }

  /** a3de: half the time (always for type 0x1A); undead can't under Negate Magic. */
  async monsterRangedAttack(forceMiss, target, attacker) {
    const type = this.c(attacker).kind;
    const missile = monsters.missile(type);
    if (!(type === 0x1a || randomBetween(0xff, 0) < 0x80)) return 0;
    if ((monsters.flags(type) & 0x8000) && (party.activeSpell === 0x4e || party.activeSpell === 0x1c)) return 0;
    await sound.soundSlide(0x96, 5, 400, 0x2ee);
    const hit = forceMiss ? 0 : this.rollToHit(0, -this.castCircle, attacker, target);
    const t = await this.fireMissile(missile, hit, this.c(target).y, this.c(target).x, attacker);
    if (t >= 0) {
      await this.flashCombatant(t);
      tw.putChar(0x0a);
      await this.resolveHit(attacker, t);
      await this.reportHit(attacker, t);
    }
    return 1;
  }

  /**
   * a4b6: 1 if the monster used its turn. A magic attacker's shot at a wearer of amulet 0x2D
   * misses half the time. Thieves (flag 2) steal 5 food 3 times in 4 instead of wounding. A
   * fighter that changed sides strikes with weapon 0x21.
   */
  async monsterAttack(slot) {
    const c = this.c(slot);
    const type = c.kind;
    let forceMiss = 0;
    const target = (await this.findNearestEnemy(slot)).slot;
    if (target < 0) return 0;
    if (c.flags & 1) {
      if (this.combatantDistance(target, slot) !== 1) return 0;
      this.attackItem = 0x21;
      await this.meleeAttack(0x21, target, slot);
      return 1;
    }
    const tc = this.c(target);
    if ((tc.flags & 0x80) && party.member(tc.kind & 0x0f).amulet === 0x2d && (monsters.flags(type) & 0x8000))
      forceMiss = randomBetween(0xff, 0) < 0x80 ? 1 : 0;
    if (this.combatantDistance(target, slot) > monsters.attackRange(type)) return 0;
    if (type === 0x1a) this.obj(c).flags = 0x20;
    if (this.combatantDistance(target, slot) !== 1) return this.monsterRangedAttack(forceMiss, target, slot);
    if (type === 0x2d) this.obj(c).flags = 0x20;
    await sound.soundSlide(0x96, 5, 400, 0x2ee);
    this.lastAttacker[target & 0x1f] = slot;
    if (this.rollToHit(0, -this.castCircle, slot, target) === 0) return 1;
    if ((monsters.flags(type) & 2) && randomBetween(3, 0) !== 0 && party.food !== 0) {
      tw.printText(strings.get(S.A_6D74));
      this.printCombatantName(slot);
      tw.printText(strings.get(S.stole_some_food_6D78));
      subWordFloor0(5, party, 'food');
      await sound.soundSlide(0x32, 1, 2000, 800);
      status.drawStatusBar();
      return 1;
    }
    await this.flashCombatant(target);
    tw.putChar(0x0a);
    await this.resolveHit(slot, target);
    await this.reportHit(slot, target);
    return 1;
  }

  /**
   * a684: nothing under Time Stop, half the turns under Quickness, nothing while swallowed; a
   * sleeper wakes 1 time in 17. Otherwise a special power, else an attack, else a move. A fleeing
   * monster regains a hit point 1 turn in 4 and checks its morale; one that steps off the map escapes.
   */
  async monsterTurn() {
    const slot = this.turn;
    const c = this.c(slot);
    this.attackItem = 0;
    if (party.activeSpell === 0x54) return;
    if (party.activeSpell === 0x51 && randomBetween(1, 0) === 0) return;
    if (c.flags & 4) return;
    if (c.flags & 8) {
      if (randomBetween(0x10, 0) === 0x10) this.wakeCombatant(slot);
      return;
    }
    if (c.kind === 0x2d) this.obj(c).flags = 0;
    if (!(c.flags & 2)) {
      if ((await this.monsterSpecial(slot)) !== 0) return;
      if ((await this.monsterAttack(slot)) !== 0) return;
    } else {
      if (!(c.flags & 0x80) && randomBetween(3, 0) === 3) c.hp++;
      this.monsterMorale(slot);
    }
    if ((await this.monsterMove(slot)) === 0) {
      if (c.flags & 2) await this.monsterAttack(slot);
      return;
    }
    if (this.event & 0x10) {
      tw.putChar(0x0a);
      await sound.soundSlide(0x28, 1, 2000, 0x4b0);
      this.printCombatantName(slot);
      tw.printText(strings.get(S.escapes_6D8C));
      this.combatRemove(-1 - slot);
      if (c.kind === 0x2f) await this.combatCheckPassOut(); // (the flags were just cleared: only the type counts)
    }
    await view.worldTick();
  }

  /** a7d4 */
  async combatItemCommand(which, prompt) {
    tw.printText(prompt);
    if (!(this.c(this.turn).flags & 0x80)) {
      tw.printText(strings.get(S.Can_t_6D98));
      return 1;
    }
    switch (which) {
      case 0: await cmdGet(); break;
      case 1: await cmdJimmy(); break;
      case 2: await cmdOpen(); break;
      case 3: await cmdReady(); break;
      case 4: await cmdSearch(); break;
      case 5: await cmdUse(); break;
    }
    return 0;
  }

  /**
   * a8ce: a turn of anyone on the party's side: a member, or a monster that changed sides. With an
   * active player set, everyone else's turn is skipped. A member holding item 0x23 is possessed
   * and acts as a monster. Keys that aren't a turn ask again; commands that fail print the name
   * line again first.
   */
  async partyMemberTurn() {
    const slot = this.turn;
    const c = this.c(slot);
    const member = c.kind;
    let key = 0;
    map.x = c.x;
    map.y = c.y;
    if (party.activePlayer !== 0xff && (!(c.flags & 0x80) || member !== party.activePlayer)) {
      this.combatEndOfTurn();
      return;
    }
    const pm = party.member(member & 0x0f);
    if ((c.flags & 0x80) && (pm.leftHand === 0x23 || pm.rightHand === 0x23)) {
      c.flags |= 1;
      party.activePlayer = 0xff;
      status.dirty = true;
      await this.monsterTurn();
    } else {
      let again, weapons = 0;
      if (c.flags & 0x80) status.highlightMemberRow(c.kind);
      status.refresh();
      do {
        tw.putChar(0x0a);
        this.printCombatantName(slot);
        let line = '';
        if (c.flags & 0x80) {
          tw.printText(strings.get(S.armed_with_6DA4));
          const add = (count, item) => {
            if (item === 0xff || items.damage(item) === 0) return 0;
            if (count !== 0) line += strings.get(S.Comma_SP_6DA0);
            line += items.name(item);
            return 1;
          };
          weapons = add(0, pm.helm);
          weapons += add(weapons, pm.leftHand);
          weapons += add(weapons, pm.rightHand);
          if (weapons === 0) line += strings.get(S.bare_hands_6DB2);
        }
        line += strings.get(S.Colon_6DBE);
        tw.printText(line);
        again = 0;
        for (let done = 0; !done;) {
          tw.putChar(0x0a);
          status.drawLabelLeft();
          done = 1;
          if (c.flags & 4) {
            tw.printText(strings.get(S.ARGH_6DC0));
            await sound.soundNoise(500, 3000, 0x28);
            await this.checkRegurgitate(slot);
            continue;
          }
          if (c.flags & 8) {
            if (randomBetween(0xff, 0) < 0x10) this.wakeCombatant(slot);
            tw.printText(strings.get(S.Zzzzz_6DC8));
            continue;
          }
          key = (await getCommandKey()) & 0xff;
          if (gameQuit()) return;
          again = 0;
          switch (key) {
            case 1: case 2: case 3: case 4:
              if ((await this.combatMoveMember(key, slot)) === 0) done = 0;
              break;
            case 0x13:
              tw.printText(strings.get(S.Sound_6DE4));
              tw.printText(strings.get(sound.enabled === 0 ? S.On_6DF2 : S.Off_6DEC));
              sound.enabled = sound.enabled === 0 ? 1 : 0;
              done = 0;
              break;
            case 0x1b: again = await combatEscape(); break;
            case 0x20: tw.printText(strings.get(S.Pass_6E60)); break;
            case 0x30:
              party.activePlayer = 0xff;
              tw.printText(strings.get(S.Set_active_plr_None_6E66));
              status.drawStatusBar();
              break;
            case 0x31: case 0x32: case 0x33: case 0x34: case 0x35: case 0x36:
              if (this.combatSetActivePlayer(key - 0x31) === 0) again = 1;
              break;
            case 0x41: await this.cmdAttackCombat(weapons, slot); break; // A
            case 0x42: again = await this.combatCantDo(1, strings.get(S.Board_6E7E)); break;
            case 0x43: // C
              tw.printText(strings.get(S.Cast_6DF6));
              again = 1;
              if (!(c.flags & 0x80)) {
                tw.printText(strings.get(S.Can_t_6E0C));
              } else if (this.checkInterference(slot) === 0) {
                this.magicAttack = 1;
                this.castCircle = 1;
                again = 0;
                if (party.activeSpell === 0x4e || (party.lbCrown === 0 && this.prevLocation === 0x12)) {
                  tw.printText(strings.get(S.Absorbed_6E00)); // Negate Magic, or Blackthorn's castle without the Crown
                  await sound.soundSweep(2, 1000, 28000, 1, 0x2648);
                } else {
                  await cmdCast();
                }
              }
              break;
            case 0x44: tw.printText(strings.get(S.D_What_6E84)); again = 1; break;
            case 0x45: again = await this.combatCantDo(2, strings.get(S.Enter_6E8E)); break;
            case 0x46: again = await this.combatCantDo(2, strings.get(S.Fire_6E94)); break;
            case 0x47: again = await this.combatItemCommand(0, strings.get(S.Get_6E14)); break;
            case 0x48: again = await this.combatCantDo(2, strings.get(S.Hole_up_6E9A)); break;
            case 0x49: again = await this.combatCantDo(2, strings.get(S.Ignite_torch_6EA2)); break;
            case 0x4a: again = await this.combatItemCommand(1, strings.get(S.Jimmy_6E1A)); break;
            case 0x4b: // K
              if ((await this.combatKlimb()) === 0) done = 0;
              break;
            case 0x4c: again = await this.combatCantDo(2, strings.get(S.Look_6EB0)); break;
            case 0x4d: again = await this.combatCantDo(2, strings.get(S.Mix_6EB6)); break;
            case 0x4e: again = await this.combatCantDo(2, strings.get(S.New_order_6EBA)); break;
            case 0x4f: again = await this.combatItemCommand(2, strings.get(S.Open_6E22)); break;
            case 0x50: // P
              tw.printText(strings.get(S.Push_6E28));
              await cmdPush();
              break;
            case 0x51: again = await this.combatCantDo(2, strings.get(S.Quit_6EC4)); break;
            case 0x52: again = await this.combatItemCommand(3, strings.get(S.Ready_6E2E)); break;
            case 0x53: again = await this.combatItemCommand(4, strings.get(S.Search_6E3A)); break;
            case 0x54: again = await this.combatCantDo(3, strings.get(S.Talk_6ECA)); break;
            case 0x55: again = await this.combatItemCommand(5, strings.get(S.Use_item_6E42)); break;
            case 0x56: again = await this.combatCantDo(2, strings.get(S.View_6ED0)); break;
            case 0x57: tw.printText(strings.get(S.W_What_6ED6)); again = 1; break;
            case 0x58: again = await this.combatCantDo(1, strings.get(S.X_it_6EE0)); break;
            case 0x59: // Y
              tw.printText(strings.get(S.Yell_6E4E));
              await cmdYell();
              break;
            case 0x5a: // Z
              tw.printText(strings.get(S.Z_stats_6E54));
              await cmdZstats();
              break;
            case 0xfc:
              tw.printText(strings.get(S.Buffer_O_6DD2));
              input.typeaheadOn = input.typeaheadOn === 0 ? 1 : 0;
              tw.printText(strings.get(input.typeaheadOn === 0 ? S.n_6DE0 : S.ff_6DDC));
              done = 0;
              break;
            default:
              tw.printText(strings.get(S.What_6EE6));
              done = 0;
          }
        }
      } while (again);
      if (c.flags & 0x80) status.highlightMemberRow(c.kind);
    }
    if (key < 0x30 || key > 0x36) {
      this.combatEndOfTurn();
      await view.worldTick();
      await this.checkAbsorbed();
    }
  }

  /**
   * ae24: each pass every living combatant's timer drops by one; at zero it acts and the timer
   * restarts at 36 - speed. Ten turns make a minute. Whoever stands in stocks or manacles never
   * acts. The battle ends when nobody is left on the party's side: 0 if the other side is gone too
   * (the party walked off), else 1 ("BATTLE IS LOST!" unless it was won before).
   */
  async combatMainLoop() {
    let result = 1, over = 0;
    this.exitDir = 0;
    await view.worldTick();
    status.drawStatusBar();
    input.flushKeyboard();
    this.victory = this.countCombatSides().others === 0 ? 1 : 0;
    while (!over) {
      for (this.turn = 0; this.turn < 0x20; this.turn++) {
        if (gameQuit()) {
          over = 1;
          break;
        }
        map.openDoorTile = 0;
        const c = this.c(this.turn);
        if ((c.flags & 0xc0) === 0 || (c.flags & 0x20)) continue;
        if ((c.flags & 0x80) && party.member(c.kind & 0x0f).dead()) { // died outside a blow: poison, a trap
          c.flags |= 0x20;
          await this.flashCombatant(this.turn);
          await this.applyDamage(99, this.turn);
          continue;
        }
        if ((this.lmap(c.y, c.x) & 0xfe) === 0x84) continue;
        c.timer = c.timer - 1;
        if (c.timer !== 0) continue;
        c.timer = 0x24 - c.speed;
        view.aimMode = 0;
        this.event = 0;
        this.castCircle = 0;
        this.magicAttack = 0;
        this.attackItem = 0;
        this.minuteCtr = (this.minuteCtr + 1) & 0xff;
        if (this.minuteCtr === 10) {
          this.minuteCtr = 0;
          passTime(1);
        }
        this.redraw = 1;
        if (this.combatantSide(this.turn) === 0) await this.partyMemberTurn();
        else await this.monsterTurn();
        this.lastAttacker[this.turn & 0x1f] = 0xff;
        await this.applyTileHazard(this.turn);
        const sides = this.countCombatSides();
        if (sides.party === 0) {
          if (sides.others === 0) {
            result = 0;
          } else {
            if ((await this.combatCheckPassOut()) !== -1) continue; // a possessed member comes to: not over yet
            await view.worldTick();
            if (this.victory === 0) {
              tw.printText(strings.get(S.BATTLE_IS_LOST_6EEE));
              result = 1;
            }
          }
          over = 1;
          break;
        }
        if (sides.others === 0 && this.victory === 0) {
          tw.printText(strings.get(S.VICTORY_6F00));
          this.victory = 1;
          await this.victoryFanfare();
          input.flushKeyboard();
        }
      }
    }
    input.flushKeyboard();
    map.beamFrame = 0xff;
    return result;
  }

  /**
   * afc0: the nearest living fighter of the other side that isn't swallowed and can be seen
   * (invisible ones only in Doom, or by type 0x2F). Under Confusion a failed intelligence roll
   * makes the monster take its own side for the enemy. With nobody to fight the monsters all turn
   * to flee. Returns { slot (or -1), dx, dy: the step towards it (away, when fleeing) }.
   */
  async findNearestEnemy(slot) {
    const c = this.c(slot);
    let partySeen = -1, best = -1, bestDist = 99, tx = 5, ty = 5;
    let side = this.combatantSide(slot);
    if (party.activeSpell === 0x43 && this.getCombatantStat(-1, slot) < randomStatRoll()) side = 0;
    for (let i = 0x1f; i >= 0; i--) {
      const o = this.c(i);
      if (i === slot || o.flags === 0 || (o.flags & 0x20) || side === this.combatantSide(i)) continue;
      if (!(this.prevLocation === 0x28 || c.kind === 0x2f || !(o.flags & 0x10)) || (o.flags & 4)) continue;
      if (i < 5) partySeen++;
      const d = distance(o.y, o.x, c.y, c.x);
      if (d < bestDist) {
        tx = o.x;
        ty = o.y;
        best = i;
        bestDist = d;
      }
    }
    if (partySeen === -1 && best === -1) best = await this.combatCheckPassOut();
    if (best === -1) {
      for (let i = 0x1f; i > 5; i--)
        if (this.c(i).flags & 0x40) {
          this.c(i).hp = 1;
          this.c(i).flags |= 2;
        }
      tx = ty = 5;
    }
    let dx = 0, dy = 0;
    if (tx < c.x) dx = -1;
    if (c.x < tx) dx = 1;
    if (ty < c.y) dy = -1;
    if (c.y < ty) dy = 1;
    if (c.flags & 2) {
      dx = -dx;
      dy = -dy;
    }
    return { slot: best === slot ? -1 : best, dx, dy };
  }

  /**
   * b174: types 0x1A and 0x1B never move. Teleporters jump to a random free square 3 times in 4.
   * Others step towards the enemy along one axis, picked at random, the other if that is blocked,
   * else up to four random tries. Only a fleeing monster can step off the map.
   */
  async monsterMove(slot) {
    const c = this.c(slot);
    let moved = 0, r = 0;
    if (c.kind === 0x1b || c.kind === 0x1a) return 0;
    let pos;
    if (!(c.flags & 0x80) && (monsters.flags(c.kind) & 0x2000) && party.activeSpell !== 0x4e && party.activeSpell !== 0x1c &&
      (this.combatIsSurrounded(slot) || randomUpto(3) !== 3) && (pos = this.randomCombatPos()).ok) {
      const o = this.obj(c);
      if (this.combatTileFree(pos.y, pos.x, o.tile)) {
        c.x = o.x = pos.x;
        c.y = o.y = pos.y;
        tw.printText(monsters.name(c.kind));
        tw.printText(strings.get(S.teleports_6F0C));
        moved = 1;
      }
    }
    if (moved || this.combatIsSurrounded(slot)) return moved;
    let { dx, dy } = await this.findNearestEnemy(slot);
    if (randomUpto(0xff) < 0x80 || this.combatIsBlocked(slot, c.y, c.x + dx)) {
      if (!this.combatIsBlocked(slot, c.y + dy, c.x)) {
        dx = 0;
        r = 0x3e6;
      }
    } else {
      dy = 0;
      r = 999;
    }
    if (r < 0x3de) {
      const y = c.y, x = c.x;
      moved = 4; // the try counter shares the result variable
      do {
        r = randomUpto(3);
        if (r === 0) { dy = 1; dx = 0; }
        else if (r === 1) { dx = 1; dy = 0; }
        else if (r === 2) { dy = -1; dx = 0; }
        else if (r === 3) { dx = -1; dy = 0; }
        if (!this.combatIsBlocked(slot, y + dy, x + dx)) r = 0x3df;
        if (r > 0x3de) break;
        dy = dx = 0;
      } while (--moved > 0);
    }
    if (r !== 0) {
      const o = this.obj(c);
      c.x = c.x + dx;
      o.x = c.x;
      c.y = c.y + dy;
      o.y = c.y;
      moved = 1;
      if (!this.inCombatBounds(c.y, c.x)) this.event = 0x10;
    }
    return moved;
  }

  /**
   * b3aa: dungeon rooms: stepping on one of eight trigger squares changes up to two squares of
   * the map (the lists are in the columns right of the map).
   */
  async combatRoomTrigger(y, x) {
    let fired = 0;
    if (!(this.flags & 0x80) && !(this.flags & 2)) return 0;
    const m = view.localMap;
    for (let i = 0; i < 8; i++) {
      if (m[0x10b + i] !== (x & 0xffff) || m[0x113 + i] !== (y & 0xffff)) continue;
      m[0x113 + i] = m[0x10b + i] = 0xff;
      if (m[0x12b + i] < 0x0b && m[0x133 + i] < 0x0b) m[m[0x133 + i] * 0x20 + m[0x12b + i]] = m[0x0b + i];
      if (m[0x14b + i] < 0x0b && m[0x153 + i] < 0x0b) m[m[0x153 + i] * 0x20 + m[0x14b + i]] = m[0x0b + i];
      fired = 1;
    }
    if (fired) await view.worldTick();
    return fired;
  }

  /** b49e: a random square (0-15 each way); ok if it is on the map. */
  randomCombatPos() {
    const x = randomUpto(0x0f), y = randomUpto(0x0f);
    return { x, y, ok: x < 0x0b && y < 0x0b };
  }

  /** b4c6: -1 - slot, or object + 1. */
  combatRemove(which) {
    let object;
    if (which < 0) {
      const c = this.c(-1 - which);
      object = c.object;
      c.object = c.speed = c.hp = c.y = c.x = c.timer = c.flags = 0;
    } else {
      object = which - 1;
    }
    const o = map.objects.at(object & 0x1f);
    o.x = o.tile2 = o.tile = o.hull = o.z = o.y = 0;
  }

  /**
   * b540: a monster does its type's damage; a weapon 1 to its value, the glass sword (0x27) 99
   * and then it shatters, item 0x28 nothing, bare hands 1. The defender's armour takes off 1 to
   * its value, so the result can be negative.
   */
  calcDamage(defender, attacker) {
    let damage;
    if (this.c(attacker).flags & 0x40) {
      damage = monsters.damage(this.c(attacker).kind);
    } else if (this.attackItem === 0x27) {
      tw.printText(strings.get(S.Thy_sword_hath_shattered_6F1A));
      this.unequipItem(0x27, attacker); // the slot is passed as the member
      damage = 99;
    } else if (this.attackItem === 0x28) {
      damage = 0;
    } else if (this.attackItem === 0xff) {
      damage = 1;
    } else {
      damage = items.damage(this.attackItem);
      if (damage > 1 && damage !== 99) damage = randomBetween(damage, 1);
    }
    if (damage === 99) return 99;
    const d = this.c(defender);
    const armour = (d.flags & 0x40) ? monsters.armour(d.kind) : party.member(d.kind & 0x0f).armour;
    if (armour !== 0) damage -= randomBetween(armour, 1);
    return damage;
  }

  /** b62a */
  getCombatantSpeed(slot) {
    const c = this.c(slot);
    if ((party.activeSpell === 0x54 && (c.flags & 0x40)) || c.kind === 0x1a || (c.flags & 8)) return 1;
    return c.speed;
  }

  /**
   * b672: which -1 intelligence, -2 speed, -3 strength, -4 armour bonus. A weapon id (party)
   * picks strength for missile kind 8, else speed; 0 (monsters) strength for types flagged 0x80.
   */
  getCombatantStat(which, slot) {
    const c = this.c(slot);
    const monster = (c.flags & 0x40) !== 0;
    if (!monster) {
      if (which >= 1) which = items.missile(which) === 8 ? -3 : -2;
    } else if (which === 0) {
      which = (monsters.flags(c.kind) & 0x80) ? -3 : -2;
    }
    const m = party.member(c.kind & 0x0f);
    switch (which) {
      case -4: return monster ? monsters.armour(c.kind) : this.getArmourBonus(c.kind);
      case -3: return monster ? monsters.strength(c.kind) : m.str;
      case -2: return this.getCombatantSpeed(slot);
      case -1: return monster ? monsters.intelligence(c.kind) : m.intel;
    }
    return 0;
  }

  /**
   * b766: a hit if (defender's stat - attacker's stat + 30) / 2 <= a 1-30 roll. With a weapon the
   * defender's speed stands against the attacker's weapon stat; with a spell, intelligence against
   * intelligence. Items 0x27, 0x23, 0x28 and spells 0x2A-0x31, 0x33 always hit.
   */
  rollToHit(weapon, magic, attacker, defender) {
    let aStat, dStat;
    if (this.castCircle === 0) {
      if (weapon === 0x27 || weapon === 0x23 || weapon === 0x28) return 1;
      dStat = -2;
      aStat = weapon;
    } else {
      if (!((weapon < 0x2a || weapon > 0x31) && weapon !== 0x33)) return 1;
      aStat = dStat = -1;
    }
    const dv = this.getCombatantStat(dStat, defender), av = this.getCombatantStat(aStat, attacker);
    return Math.trunc((dv - av + 0x1e) / 2) <= randomStatRoll() ? 1 : 0;
  }

  /**
   * b804: monster flags: 0x20 half damage from weapons, 8 immune, 0x10 divides when wounded,
   * 0x1000 vanishes, 1 leaves nothing. A dead monster otherwise leaves a body (0x1F) or, if its
   * treasure level beats a 1-30 roll, a chest of that level, trapped on a second such roll -
   * unless it died on water. Type 0x1C leaves a body and a new monster 0x1F; type 0x1E a tile
   * 0x4C. Returns the experience: hit points / 4 + 1.
   */
  async applyDamage(damage, slot) {
    const c = this.c(slot);
    let xp = 0;
    damage &= 0xffff;
    if (s16(damage) < 1) {
      this.event = 0x20;
      damage = 0;
    }
    if (c.flags & 0x80) {
      const m = party.member(c.kind & 0x0f);
      m.hp = m.hp - damage;
      if (s16(m.hp) < 1 || damage === 99) {
        m.hp = 0;
        c.flags |= 0x20;
        m.status = 'D';
        this.obj(c).tile = this.obj(c).tile2 = 0x1e;
        if (c.kind === party.activePlayer) party.activePlayer = 0xff;
      }
      status.drawStatusBar();
      return 0;
    }
    const type = c.kind, mf = monsters.flags(type);
    if ((mf & 0x20) && this.magicAttack === 0) damage = damage >>> 1;
    if (mf & 8) damage = 0;
    c.hp = c.hp < damage ? 0 : c.hp - damage;
    if (c.hp === 0 || damage === 99) {
      xp = (monsters.hp(type) >> 2) + 1;
      const treasure = monsters.treasure(type), x = c.x, y = c.y;
      const o = this.obj(c);
      c.flags = 0x20;
      c.hp = 0;
      if ((mf & 0x1001) === 0) {
        if (type === 0x1c) {
          o.tile = o.tile2 = 0x1f;
          this.addCombatant(map.z, y, x, 0, 0x1f);
          await view.worldTick();
          return xp;
        }
        if (type === 0x1e) {
          map.setTile(y, x, 0x4c);
        } else if (this.lmap(y, x) !== 0x87 && this.lmap(y, x) > 3) {
          if (treasure < randomStatRoll()) {
            o.tile = o.tile2 = 0x1f;
            return xp;
          }
          o.tile = o.tile2 = 1;
          o.hull = treasure;
          if (treasure > randomStatRoll()) o.hull |= 0x80;
          return xp;
        }
      } else if (mf & 0x1000) {
        tw.printText(monsters.name(type));
        tw.printText(strings.get(S.vanishes_6F36));
        this.event = 2;
        o.tile = o.tile2 = 0x16;
        await dissolveTile(c.y, c.x, this.lmap(c.y, c.x));
        this.combatRemove(-1 - slot);
        await this.combatCheckPassOut();
        return xp;
      }
      this.combatRemove(-1 - slot);
    } else if (mf & 0x10) {
      for (let tries = 0; tries < 8; tries++) {
        const near = this.randomNear(c.y, c.x);
        if (!this.combatTileFree(near.y, near.x, this.obj(c).tile)) continue;
        const n = this.addCombatant(map.z, near.y, near.x, 0, (this.obj(c).tile - 0x40) >> 2);
        if (n < 0) continue;
        this.c(n).hp = c.hp;
        tw.printText(monsters.name(type));
        tw.printText(strings.get(S.divides_6F42));
        return 0;
      }
    }
    return xp;
  }

  /** bb4a: a healthy member is poisoned; anyone else takes 0-20. */
  async applyPoisonHit(attacker, defender) {
    const d = this.c(defender);
    if ((d.flags & 0x80) && party.member(d.kind & 0x0f).good()) {
      party.member(d.kind & 0x0f).status = 'P';
      tw.printText(party.member(d.kind & 0x0f).name);
      tw.printText(strings.get(S.is_poisoned_6F4E));
      this.event = 8;
      status.dirty = true;
      return;
    }
    const xp = await this.applyDamage(randomUpto(0x14), defender);
    if (attacker >= 0 && (this.c(attacker).flags & 0x80)) addWordCapped(9999, xp, party.member(this.c(attacker).kind & 0x0f), 'xp');
  }

  /**
   * bbda: monsters flagged 0x204 poison 3 times in 4 instead of wounding; type 0x1C puts its
   * victim to sleep; magic 0x34 is sleep and 0x33 poison. Experience goes to the member who struck.
   */
  async resolveHit(attacker, defender) {
    const a = this.c(attacker), d = this.c(defender);
    const monster = !(a.flags & 0x80);
    if (monster && (monsters.flags(a.kind) & 0x204) && randomBetween(3, 0) !== 0) {
      await this.applyPoisonHit(attacker, defender);
      return;
    }
    if (monster && a.kind === 0x1c && !(d.flags & 8)) {
      await this.sleepCombatant(defender);
      return;
    }
    if (this.magicAttack !== 0 && this.attackItem === 0x34) {
      await this.sleepCombatant(defender);
      return;
    }
    if (this.magicAttack !== 0 && this.attackItem === 0x33) {
      await this.applyPoisonHit(attacker, defender);
      return;
    }
    const damage = this.calcDamage(defender, attacker);
    if (damage < 0 && (d.flags & 0x80)) {
      this.event = 0x20;
      return;
    }
    const xp = await this.applyDamage(damage, defender);
    if (a.flags & 0x80) addWordCapped(9999, xp, party.member(a.kind & 0x0f), 'xp');
  }

  /** bcec: with q a quarter of the type's hit points: below q flees (1), below 2q flees 4 times in 256 (2), below 3q (3), else (4). */
  monsterMorale(slot) {
    const c = this.c(slot);
    let level, flee = false;
    if (c.flags & 0x80) return 0;
    const q = monsters.hp(c.kind) >> 2;
    if (c.hp < q) {
      level = 1;
      flee = true;
    } else if (c.hp < q * 2) {
      level = 2;
      flee = randomUpto(0x100) >= 0xfc;
    } else {
      level = c.hp < q * 3 ? 3 : 4;
    }
    if (flee) c.flags |= 2;
    else c.flags &= 0xfd;
    return level;
  }

  /**
   * bdae: after each turn lava and fire (0x8F, 0xBC, field 0xEA) burn for 0-10, swamp and the
   * poison field (0xE8) poison anyone whose tile is below 0x80, the sleep field (0xE9) sleeps.
   */
  async applyTileHazard(slot) {
    const c = this.c(slot);
    let hazard = 0;
    const t = this.lmap(c.y, c.x);
    if (t === 0x8f || t === 0xbc) hazard = 100;
    if (t === 4) hazard = 0x32;
    if (hazard === 0)
      for (let i = 0; i < 0x20 && hazard === 0; i++) {
        const o = map.objects.at(i);
        if (i === c.object || c.x !== o.x || c.y !== o.y) continue;
        if (o.tile === 0xea) hazard = 100;
        if (o.tile === 0xe8) hazard = 0x32;
        if (o.tile === 0xe9) hazard = 0x96;
      }
    if (hazard === 0x32) {
      if (this.obj(c).tile < 0x80) {
        await this.applyPoisonHit(-1, slot);
        await this.flashCombatant(slot);
      }
    } else if (hazard === 100) {
      await this.flashCombatant(slot);
      await this.applyDamage(randomUpto(10), slot);
      await this.reportHit(0xff, slot);
      status.dirty = true;
    } else if (hazard === 0x96) {
      await this.sleepCombatant(slot);
    }
  }

  /** bef6 */
  async checkRegurgitate(slot) {
    const c = this.c(slot);
    if (randomStatRoll() >= c.speed) return;
    tw.printText((c.flags & 0x80) ? party.member(c.kind & 0x0f).name : monsters.name(c.kind));
    tw.printText(strings.get(S.regurgitated_6F5E));
    await sound.soundNoise(600, 7000, 1);
    c.flags &= 0xfb;
    this.obj(c).tile2 = this.obj(c).tile;
  }

  // ---- the combat half of SJOG.OVL ----

  /** dab4 */
  countMembersWhere(item) {
    let n = 0;
    for (let m = 0; m < party.size; m++) if (this.unequipItem(item, m)) n++;
    return n;
  }

  /** daec: who is still fighting, on each side. */
  countCombatSides() {
    const sides = { party: 0, others: 0 };
    for (let i = 0; i < 0x20; i++) {
      if (this.combatants[i].flags === 0 || (this.combatants[i].flags & 0x20)) continue;
      if (this.combatantSide(i) === 0) sides.party++;
      else sides.others++;
    }
    return sides;
  }

  /** db32: exitDir 1-4 the side of the map, 5 up, 6 down. In a dungeon room everyone must use the same exit. */
  async combatLeaveMap(exitDir, slot) {
    if ((party.transport & 0xf8) === 0x20) {
      tw.printText(strings.get(S.Stay_with_ship_8E76));
      return 0;
    }
    if (this.c(slot).flags & 0x80) {
      if (this.exitDir === 0) {
        this.exitDir = exitDir;
      } else if (exitDir !== this.exitDir && (this.flags & 0x80)) {
        tw.printText(strings.get(S.All_must_use_the_same_8E88));
        await sound.beep(200, 0xa5);
        return 0;
      }
    }
    this.redraw = 1;
    tw.printText(strings.get(this.countCombatSides().others === 0 ? S.Leave_8EA6 : S.Escape_8EAE));
    await sound.soundSlide(0x28, 1, 2000, 0x4b0);
    party.activePlayer = 0xff;
    this.combatRemove(-1 - slot);
    status.drawStatusBar();
    await view.worldTick();
    return 1;
  }

  /** dbd6 */
  async combatMoveMember(dir, slot) {
    const c = this.c(slot);
    const o = this.obj(c);
    let dx = 0, dy = 0;
    if (dir === 1) { dx = -1; tw.printText(strings.get(S.West_8ECE)); }
    else if (dir === 2) { dx = 1; tw.printText(strings.get(S.East_8EC8)); }
    else if (dir === 3) { dy = -1; tw.printText(strings.get(S.North_8EB8)); }
    else if (dir === 4) { dy = 1; tw.printText(strings.get(S.South_8EC0)); }
    const x = c.x + dx, y = c.y + dy;
    if (!(x < 0x0b && y < 0x0b && x > -1 && y > -1)) return this.combatLeaveMap(dir, slot);
    if (!this.combatTileFree(y, x, o.tile)) {
      tw.printText(strings.get(S.Blocked_8ED4));
      await sound.beep(200, 0xa5);
      input.flushKeyboard();
      return 0;
    }
    c.x = o.x = x;
    c.y = o.y = y;
    await sound.stepSound();
    if (this.flags & 0x82) await this.combatRoomTrigger(y, x);
    return 1;
  }

  /**
   * dcea: ladders leave the map (up 5, down 6; a grate goes down in dungeon rooms); otherwise a
   * direction is asked and a fence (0x4C) with nothing on it can be climbed onto.
   */
  async combatKlimb() {
    tw.printText(strings.get(S.Klimb_8EDE));
    let t = map.getTile(map.y, map.x);
    if ((this.flags & 2) && t === 0xc8 && this.onLadder !== 0) {
      tw.printText(strings.get(S.U_D_8EE6));
      for (;;) {
        const key = await getCommandKey();
        if (gameQuit()) return 0;
        if (key === 3 || key === 0x55) break;
        if (key === 4 || key === 0x44) {
          t = 0xc9;
          break;
        }
      }
    }
    if (t === 0xc8) {
      tw.printText(strings.get(S.Up_8EEC));
      return this.combatLeaveMap(5, this.turn);
    }
    if ((t === 0x86 && (this.flags & 0x80)) || t === 0xc9) {
      tw.printText(strings.get(S.Down_8EF2));
      return this.combatLeaveMap(6, this.turn);
    }
    const dir = await askDirection();
    if (dir) {
      const x = (map.x + dir.dx) & 0xffff, y = (map.y + dir.dy) & 0xffff;
      if (map.getTile(y, x) !== 0x4c || objectTileAt(0, y, x).tile !== 0) {
        tw.printText(strings.get(S.What_8EFA));
        return 0;
      }
      const c = this.c(this.turn);
      c.x = this.obj(c).x = x;
      c.y = this.obj(c).y = y;
      await this.combatRoomTrigger(y, x);
    }
    return 1;
  }

  /** de24: in the last battle whoever stands in row 2 on one of the 0x3C tiles is taken (exit 'M'). */
  async checkAbsorbed() {
    const c = this.c(this.turn);
    if (c.flags === 0 || (c.flags & 0x20) || c.y !== 2 || (view.tiles[0x10 + (c.x & 0x0f)] & 0xfc) !== 0x3c) return;
    this.exitDir = 0x4d;
    tw.putChar(0x0a);
    this.printCombatantName(this.turn);
    tw.printText(strings.get(S.is_absorbed_8F02));
    await sound.soundSlide(0x28, 1, 2000, 0x4b0);
    party.activePlayer = 0xff;
    status.drawStatusBar();
    this.combatRemove(-1 - this.turn);
    await view.worldTick();
  }

  /** dea6 */
  async combatCantDo(kind, prompt) {
    tw.printText(prompt);
    if (kind === 1) tw.printText(strings.get(S.what_8F12));
    else if (kind === 2) tw.printText(strings.get(S.Not_here_8F1A));
    else if (kind === 3) tw.printText(strings.get(S.Funny_no_response_8F24));
    tw.putChar(0x0a);
    await sound.beep(0x96, 0xdc);
    await sound.beep(0x96, 0x96);
    return 1;
  }

  /** defa */
  combatSetActivePlayer(member) {
    tw.printText(strings.get(S.Set_active_plr_8F3A));
    for (let slot = 0; slot < 0x20; slot++) {
      const c = this.c(slot);
      if (!(c.flags & 0x80) || this.combatantSide(slot) !== 0 || c.kind !== member) continue;
      if (c.flags & 0x2c) break;
      party.activePlayer = member;
      this.printCombatantName(slot);
      tw.putChar(0x0a);
      status.drawStatusBar();
      return 1;
    }
    tw.printText(strings.get(S.Invalid_8F4C));
    return 0;
  }

  /** df92 */
  combatEndOfTurn() {
    this.applyRingEffects(this.turn);
    this.decayCombatFields();
    if (party.activeSpellTurns !== 0 && party.activeSpellTurns !== 0xff && --party.activeSpellTurns === 0) {
      party.activeSpell = 0;
      status.dirty = true;
    }
  }

  /**
   * dfbe: after a fight with a map object the object is gone whatever happened - except a pirate
   * ship that was beaten, which becomes a ship to board (tile - 8, hull 99, 2 skiffs).
   */
  async combatCleanup(object) {
    if (this.exitDir === 0x4d) await rescueLordBritish();
    map.objects.bytes.set(map.objectsBackup);
    if (this.flags & 0x82) return;
    if (object < 0x20) {
      const o = map.objects.at(object & 0x1f);
      if (this.victory === 0 || (o.tile & 0xfc) !== 0x2c) {
        o.z = o.y = o.x = o.tile2 = o.tile = 0;
      } else {
        o.tile -= 8;
        o.tile2 -= 8;
        o.hull = 99;
        o.skiffs = 2;
      }
    }
    tw.putChar(0x0a);
    map.id = this.prevLocation;
  }

  /** e058 */
  combatIsBlocked(slot, y, x) {
    const ix = s16(x), iy = s16(y);
    if (ix < 0 || ix > 10 || iy < 0 || iy > 10) return (this.c(slot).flags & 2) ? 0 : 1;
    return 1 - this.combatTileFree(iy, ix, this.obj(this.c(slot)).tile);
  }

  /** e0c8 */
  combatIsSurrounded(slot) {
    const x = this.c(slot).x, y = this.c(slot).y;
    let blocked = this.combatIsBlocked(slot, y + 1, x);
    blocked += this.combatIsBlocked(slot, y, x + 1);
    blocked += this.combatIsBlocked(slot, y, x - 1);
    blocked += this.combatIsBlocked(slot, y - 1, x);
    return blocked === 4 ? 1 : 0;
  }

  /**
   * e14e: a possessed member among slots 0-5 passes out: the possessing item 0x23 drops and the
   * member sleeps. Returns the slot, or -1 if there is none.
   */
  async combatCheckPassOut() {
    for (let slot = 0; slot < 6; slot++) {
      const c = this.c(slot);
      if (!(c.flags & 1) || !(c.flags & 0x80)) continue;
      c.flags &= 0xfe;
      tw.printText(party.member(c.kind & 0x0f).name);
      tw.printText(strings.get(S.passes_out_8F56));
      await sound.soundSweep(2, 1000, 30000, 1, 0xc1c);
      this.unequipItem(0x23, c.kind);
      await this.sleepCombatant(slot);
      return slot;
    }
    return -1;
  }

  // ---- COMSUBS.OVL: attacks, aiming and missiles ----

  /** e1e0: intelligence against intelligence; spells 0x30, 0x31 and 0x33 up can't be resisted. 1 = resisted. */
  magicResistRoll(missile, target, attacker) {
    if (missile === 0x30 || missile === 0x31 || missile >= 0x33) return 0;
    const a = this.getCombatantStat(-1, attacker), t = this.getCombatantStat(-1, target);
    return randomStatRoll() < Math.trunc((t - a + 0x1e) / 2) ? 1 : 0;
  }

  /** e236: each field has 1 chance in 16 to vanish at the end of a turn. */
  decayCombatFields() {
    for (let i = 0; i < 0x20; i++)
      if ((map.objects.at(i).tile & 0xfc) === 0xe8 && randomBetween(0xff, 0) < 0x10) this.combatRemove(i + 1);
  }

  /** e274 */
  printCombatantName(slot) {
    const c = this.c(slot);
    tw.printText((c.flags & 0x80) ? party.member(c.kind & 0x0f).name : monsters.name(c.kind));
  }

  /** e2b2: called with the target: "<target> missed!". */
  printMissed(slot) {
    if (this.castCircle !== 0) {
      tw.printText(strings.get(S.Failed_99A0));
      return;
    }
    this.printCombatantName(slot);
    tw.printText(strings.get(S.missed_99AA));
  }

  /**
   * e2d4: not under Negate Magic. Possessors (flag 0x40) pick a random slot: an able member there
   * who fails to resist changes sides (a daemon is used up by it). Flag 0x800: turns invisible or
   * visible again, 1 turn in 8. Flag 0x400: gates in a daemon on a free random square, 1 turn in
   * 8. Returns 1 if the turn was used.
   */
  async monsterSpecial(slot) {
    const c = this.c(slot);
    const type = c.kind, mf = monsters.flags(type);
    const o = this.obj(c);
    if (party.activeSpell === 0x1c || party.activeSpell === 0x4e || (c.flags & 0x80)) return 0;
    if (mf & 0x40) {
      const t = randomBetween(0x1f, 0);
      const tc = this.c(t);
      if ((tc.flags & 0x80) && !(tc.flags & 0x3d)) {
        if (this.magicResistRoll(0, t, slot) === 0) {
          tw.putChar(0x0a);
          tc.flags |= 1;
          if (tc.kind === party.activePlayer) party.activePlayer = 0xff;
          status.drawStatusBar();
          this.printCombatantName(t);
          tw.printText(strings.get(S.possessed_99B4));
          await sound.soundSweep(2, 1000, 30000, 1, 0xc1c);
          if (type === 0x26) this.combatRemove(-1 - slot);
        }
        return 1;
      }
    }
    if ((mf & 0x800) && randomBetween(0xff, 0) <= 0x1f) {
      tw.putChar(0x0a);
      this.printCombatantName(slot);
      if (o.tile2 === 0) {
        tw.printText(strings.get(S.reappears_99C2));
        c.flags &= 0xef;
        o.tile2 = o.tile;
      } else {
        tw.printText(strings.get(S.disappears_99CE));
        c.flags |= 0x10;
        o.tile2 = 0;
      }
      return 1;
    }
    if (!(mf & 0x400) || randomBetween(0xff, 0) > 0x1f) return 0;
    const pos = this.randomCombatPos();
    if (!pos.ok || !this.combatTileFree(pos.y, pos.x, 0xd8)) return 0;
    const n = this.addCombatant(map.z, pos.y, pos.x, 0, 0x26);
    if (n === -1) return 0;
    tw.putChar(0x0a);
    this.printCombatantName(slot);
    tw.printText(strings.get(S.gates_in_a_daemon_99DC));
    await sound.soundSweep(0x0f, 1000, 5000, 1, 0xac8);
    const d = this.obj(this.c(n));
    d.tile = d.tile2 = 0x16;
    await dissolveTile(pos.y, pos.x, 0x1d8);
    d.tile = d.tile2 = 0xd8;
    return 1;
  }

  /**
   * e4f2: event tells what the blow did: 0x20 no damage ("grazed!"), 2 the target vanished, 4
   * slept, 8 poisoned (already said). A monster's state is its morale level; a member is "hit!" or,
   * by type 0x2D, "dragged under!" (swallowed: flags 4, its object hidden).
   */
  async reportHit(attacker, target) {
    const t = this.c(target);
    const f = t.flags;
    this.event &= 0xfe;
    if (this.event & 0x20) {
      this.printCombatantName(target);
      tw.printText(strings.get(S.grazed_99F2));
      await sound.soundSlide(0x28, 1, 2000, 0x4b0);
    }
    if (this.event & 0x22) {
      this.event &= 0xdd;
      return;
    }
    if (f === 0 || (f & 0x20)) {
      this.printCombatantName(target);
      tw.printText(strings.get(S.killed_99FC));
      this.event |= 1;
    } else if (this.event & 4) {
      this.printCombatantName(target);
      tw.printText(strings.get(S.slept_9A06));
    } else if (!(this.event & 8)) {
      this.printCombatantName(target);
      if (!(f & 0x80)) {
        const wounds = [S.NONE, S.critical_9A64, S.heavily_wounded_9A50, S.lightly_wounded_9A3C, S.barely_wounded_9A2A];
        const level = this.monsterMorale(target);
        if (level >= 1 && level <= 4) tw.printText(strings.get(wounds[level]));
      } else if (attacker !== 0xff && this.c(attacker).kind === 0x2d) {
        tw.printText(strings.get(S.dragged_under_9A10));
        await sound.soundSlide(0x28, 1, 2000, 0x4b0);
        t.flags |= 4;
        this.obj(t).tile2 = 0;
        await waitTurns(4);
      } else {
        tw.printText(strings.get(S.hit_9A22));
      }
    }
    if (f & 0x80) {
      status.drawStatusBar();
      await view.worldTick();
    }
    this.event &= 0xf3;
  }

  /** e6b4 */
  combatantDistance(a, b) {
    return distance(this.c(a).y, this.c(a).x, this.c(b).y, this.c(b).x);
  }

  /**
   * e6e4: the cursor starts on the fighter's last target if that is still alive, visible and in
   * range, else on the fighter. Arrows and Home / End / PgUp / PgDn move it within range; Return
   * or A fires at any square but one's own; Esc, or Space on one's own square, cancels. 0 if
   * cancelled, else the distance; aimX / aimY.
   */
  async aimCursor(range, slot) {
    const c = this.c(slot);
    view.aimMode = 1;
    let t = this.obj(c).skiffs;
    if (t > 0x1f || (this.c(t).flags & 0x30) || this.c(t).flags === 0 || this.obj(this.c(t)).tile === 0 || this.combatantDistance(t, slot) > range) t = slot;
    this.aimX = this.c(t).x;
    this.aimY = this.c(t).y;
    let cancel = 0, fire = 0, dist = 0;
    while (!fire && !cancel) {
      let dx = 0, dy = 0;
      await view.worldTick();
      let key = await getCommandKey();
      if (gameQuit()) key = 0x1b;
      switch (key) {
        case 0x1b: cancel = 1; break;
        case 1: dx = -1; break;
        case 2: dx = 1; break;
        case 3: dy = -1; break;
        case 4: dy = 1; break;
        case 0xd3: dx = -1; dy = -1; break;
        case 0xd4: dx = -1; dy = 1; break;
        case 0xd5: dx = 1; dy = -1; break;
        case 0xd6: dx = 1; dy = 1; break;
        case 0x20:
          if (c.x === this.aimX && c.y === this.aimY) cancel = 1;
          break;
        case 0x0d: case 0x41:
          if (c.x !== this.aimX || c.y !== this.aimY) {
            tw.putChar(0x0a);
            if (this.castCircle !== 0) await sound.soundNoise(700, this.castCircle * 0x640 + 8000, 800);
            fire = 1;
          }
          break;
      }
      const nx = dx + this.aimX, ny = dy + this.aimY;
      dist = distance(c.y, c.x, ny, nx);
      if (dist <= range && nx > -1 && nx < 0x0b && ny > -1 && ny < 0x0b) {
        this.aimX = nx;
        this.aimY = ny;
      }
    }
    view.aimMode = 0;
    if (cancel) {
      tw.putChar(0x0a);
      return 0;
    }
    return dist;
  }

  /** e928: a living fighter on the square that isn't swallowed (nor shown as tile 0xF4); -1 if none. */
  combatantAt(y, x) {
    for (let i = 0; i < 0x20; i++) {
      const c = this.c(i);
      if (c.x !== x || c.y !== y || this.obj(c).tile2 === 0xf4) continue;
      if ((c.flags & 0xc0) === 0 || (c.flags & 0x20) || (c.flags & 4)) continue;
      return i;
    }
    return -1;
  }

  /** e9b4: a square next to (y, x), on the map. */
  randomNear(y, x) {
    let sx, sy;
    do {
      sx = randomBetween(3, 1) + x - 2;
      sy = randomBetween(3, 1) + y - 2;
    } while (sx < 0 || sx > 10 || sy < 0 || sy > 10);
    return { x: sx, y: sy };
  }

  /**
   * ea02: a miss flies to a random neighbour of the target. Weapons 0x19 and 0x22 aren't drawn.
   * Where the missile lands, flaming oil and the field spells leave a field: 0xEA fire, 0xE8
   * poison, 0xE9 sleep, 0xEB energy. Returns who stands there (never the one whose turn it is) or
   * -1; `landed` (if given) gets the square.
   */
  async fireMissile(anim, hit, y, x, attacker, landed = null) {
    let tx = x, ty = y;
    const ax = this.c(attacker).x, ay = this.c(attacker).y;
    let arrived = 0;
    if (hit === 0) {
      let near;
      do {
        near = this.randomNear(y, x);
      } while (ax === near.x && ay === near.y);
      tx = near.x;
      ty = near.y;
    }
    if (this.attackItem === 0x19 || this.attackItem === 0x22) {
      if (hit !== 0) {
        tx = x;
        ty = y;
        arrived = 1;
      }
    } else {
      const stopped = { x: 0, y: 0 };
      arrived = await this.animateMissile(anim, ty, tx, ay, ax, stopped);
      if (arrived === 0) {
        tx = stopped.x;
        ty = stopped.y;
      } else {
        await this.combatRoomTrigger(ty, tx);
      }
    }
    if (landed) {
      landed.x = tx;
      landed.y = ty;
    }
    if (arrived === 0) return -1;
    const who = this.combatantAt(ty, tx);
    let field = 0;
    if (this.attackItem === 0x13 || this.attackItem === 0x35) field = 0xea;
    else if (this.attackItem === 0x33) field = 0xe8;
    else if (this.attackItem === 0x34) field = 0xe9;
    else if (this.attackItem === 0x36) field = 0xeb;
    if (field) this.addCombatant(map.z, ty, tx, 2, field);
    if ((this.castCircle === 0 || hit !== 0) && who >= 0 && who !== this.turn) return who;
    return -1;
  }

  /**
   * eb5c: thrown weapons (0x10, 0x15, 0x16) are used up when thrown 2 squares or more; the last
   * leaves the hand. Bows (0x1A, 0x24) use arrows (0x1B), the crossbow (0x1C) quarrels (0x1D);
   * with the last gone the weapon is unreadied from everyone and goes back to the stock.
   */
  consumeAmmo(hit, weapon) {
    if (this.castCircle !== 0) return;
    if (weapon < 0x17) {
      if (weapon < 0x15 && weapon !== 0x10) return;
      if (hit < 2) return;
      if (party.inventory[weapon] !== 0) party.inventory[weapon]--;
      else this.unequipItem(weapon, this.c(this.turn).kind);
      return;
    }
    let left;
    if (weapon === 0x1c) left = --party.inventory[0x1d];
    else if (weapon === 0x1a || weapon === 0x24) left = --party.inventory[0x1b];
    else return;
    if ((left & 0xff) === 0) party.inventory[weapon] = party.inventory[weapon] + this.countMembersWhere(weapon);
  }

  /** ebdc: an enemy that struck this fighter since its last turn and still stands next to it spoils missiles and spells. */
  checkInterference(slot) {
    const who = this.lastAttacker[slot & 0x1f];
    if (who === 0xff) return 0;
    const w = this.c(who);
    if (w.flags === 0 || this.combatantSide(who) === 0 || (w.flags & 0x0c) || party.activeSpell === 0x54 ||
      this.combatantDistance(who, slot) !== 1) return 0;
    tw.putChar(0x0a);
    this.printCombatantName(who);
    tw.printText(strings.get(S.interferes_9A70));
    return 1;
  }

  /** ec48: weapon 0x26 comes back to the hand. Flaming oil (0x13) is used up when thrown. */
  async rangedAttack(anim, weapon, slot) {
    const c = this.c(slot);
    if ((weapon === 0x1a || weapon === 0x1c || weapon === 0x24 || weapon === 0x13 || weapon === 0x11) && this.checkInterference(slot) !== 0) return;
    tw.printText(strings.get(S.Aim_9A7E));
    const dist = await this.aimCursor(items.range(weapon), slot);
    if (dist === 0) return;
    await sound.soundSlide(100, 5, 300, 0x514);
    if (weapon === 0x13) {
      if (party.inventory[0x13] === 0) this.unequipItem(0x13, this.c(this.turn).kind);
      else party.inventory[0x13]--;
    }
    const o = this.obj(c);
    o.skiffs = 0xff;
    const defender = this.combatantAt(this.aimY, this.aimX);
    let hit = 1;
    if (defender >= 0) {
      o.skiffs = defender;
      this.consumeAmmo(dist, weapon);
      hit = this.rollToHit(weapon, -this.castCircle, slot, defender);
    }
    const landed = { x: 0, y: 0 };
    const who = await this.fireMissile(anim, hit, this.aimY, this.aimX, slot, landed);
    if (who < 0) {
      if (defender >= 0) {
        tw.putChar(0x0a);
        this.printMissed(defender);
      }
    } else {
      await this.flashCombatant(who);
      tw.putChar(0x0a);
      await this.resolveHit(slot, who);
      await this.reportHit(slot, who);
    }
    if (weapon === 0x26) await this.animateMissile(anim, c.y, c.x, landed.y, landed.x);
  }

  /** edd8 */
  async meleeAttack(weapon, target, slot) {
    await sound.soundSlide(0x96, 5, 0x2ee, 400);
    tw.putChar(0x0a);
    if (this.rollToHit(weapon, -this.castCircle, slot, target) === 0) {
      this.printMissed(target);
      return;
    }
    await this.flashCombatant(target);
    await this.resolveHit(slot, target);
    await this.reportHit(slot, target);
  }

  /** ee32: a monster on the party's side uses its type's range and missile. */
  async attackWith(weapon, slot) {
    const c = this.c(slot);
    let range, missile;
    if (weapon > 0x22) this.magicAttack = 1;
    if (!(c.flags & 0x80)) {
      range = monsters.attackRange(c.kind);
      if (range === 1) range = 0;
      missile = monsters.missile(c.kind);
    } else {
      range = weapon === 0xff ? 0 : items.range(weapon);
      missile = items.missile(weapon);
    }
    if (range !== 0) {
      await this.rangedAttack(missile, weapon, slot);
      return;
    }
    tw.printText(strings.get(S.Aim_9A84));
    const ok = await this.aimCursor(1, slot);
    const target = this.combatantAt(this.aimY, this.aimX);
    if (ok === 0 || target === -1) {
      tw.printText(strings.get(S.Nothing_9A8A));
      return;
    }
    this.obj(c).skiffs = target;
    await this.meleeAttack(weapon, target, slot);
  }

  /** ef1c */
  async attackWithItem(weaponCount, item) {
    if (item === 0xff || items.damage(item) === 0) return;
    if (weaponCount > 1) {
      this.castCircle = 0;
      this.magicAttack = 0;
      tw.putChar(0x0a);
      tw.printText(items.name(item));
      tw.printText(strings.get(S.Colon_NL_9A94));
    }
    this.attackItem = item;
    tw.printText(strings.get(S.Attack_9A98));
    await this.attackWith(item, this.turn);
  }

  /** ef76: a member attacks once with each weapon held: helm slot, left hand, right hand. */
  async cmdAttackCombat(weaponCount, slot) {
    const c = this.c(slot);
    if (!(c.flags & 0x80) || weaponCount === 0) {
      this.attackItem = 0xff;
      tw.printText(strings.get(S.Attack_9AA0));
      await this.attackWith(0xff, slot);
      return;
    }
    const m = party.member(c.kind & 0x0f);
    if (weaponCount > 1) {
      tw.setCursor(tw.getCursorRow(), 0);
      tw.putChar(0x20);
    }
    await this.attackWithItem(weaponCount, m.helm);
    await this.attackWithItem(weaponCount, m.leftHand);
    await this.attackWithItem(weaponCount, m.rightHand);
  }

  /**
   * f006: a line in pixels from one square's centre to another's, stepping x and catching up in y
   * by the slope in hundredths; at most 328 points, ended by 0xFF. Into this.path from index `at`
   * of each half.
   */
  traceLine(at, toY, toX, fromY, fromX) {
    const p = this.path;
    const X = (i) => i, Y = (i) => PATH_SIZE + i;
    const sx = toX < fromX ? -1 : 1, sy = toY < fromY ? -1 : 1;
    let room = 0x148;
    let slope = toX === fromX ? 0x4b00 : Math.trunc(((toY - fromY) * 100) / (toX - fromX));
    if (slope < 0) slope = -slope;
    let nx = Math.abs(toX - fromX), ny = Math.abs(toY - fromY);
    let i = at;
    const put = (idx, v, half) => { const k = half(idx); if (k < p.length) p[k] = v; };
    put(i, fromX, X);
    put(i, fromY, Y);
    let acc = slope;
    for (;;) {
      i++;
      if (!(nx > 0 || ny > 0)) break;
      do {
        if (acc < 1 || ny < 1) break;
        acc -= 100;
        fromY += sy;
        put(i, fromY, Y);
        ny--;
        put(i, fromX, X);
        i++;
      } while (--room !== 0);
      if (room === 0) break;
      nx--;
      acc += slope;
      fromX += sx;
      put(i, fromY, Y);
      put(i, fromX, X);
      room--;
    }
    put(i, 0xff, X);
    put(i, 0xff, Y);
  }

  /**
   * f12a: kind 0 a streak along the last 9 points of the path; 1 a ball; 2 and 7 line figures from
   * the point lists, turned by the frame (1-4); 3-6 a burst of 48 pixels in the bright version of
   * the fire, energy, poison or sleep colour. `i` is the point of the path.
   */
  drawMissileFrame(i, kind, frame, y, x) {
    const p = this.path, shapes = this.missileShapes;
    const px = (k) => p[k], py = (k) => p[PATH_SIZE + k];
    let sx = 1, sy = 1, burst = -1;
    let ay = -1, ax = -1; // indexes into the shapes, -1 none
    if (kind === 2) ay = ax = 0;
    if (kind > 2) ay = ax = 0x10;
    if (frame === 1) { if (ay >= 0) ay++; }
    else if (frame === 2) { if (ax >= 0) ax++; sx = -1; }
    else if (frame === 3) { if (ay >= 0) ay++; sy = -1; sx = -1; }
    else if (frame === 4) { if (ax >= 0) ax++; sy = -1; }
    gfx.setDrawColor(gfx.colorText);
    const sh = (k) => shapes[k] ?? 0;
    switch (kind) {
      case 0:
        for (let k = 0; k < 9 && px(i + k - 4) !== 0xff; k++) gfx.drawLine(py(i + k - 4), px(i + k - 4) + 1, py(i + k - 4), px(i + k - 4));
        break;
      case 1:
        gfx.drawLine(y - 2, x + 1, y - 2, x - 1);
        gfx.drawLine(y - 1, x + 2, y - 1, x - 2);
        gfx.drawLine(y, x + 2, y, x - 2);
        gfx.drawLine(y + 1, x + 2, y + 1, x - 2);
        gfx.drawLine(y + 2, x + 1, y + 2, x - 1);
        break;
      case 2:
        for (let k = 0; k < 4; k++, ax += 4, ay += 4) gfx.drawLine(sh(ay + 2) * sy + y, sh(ax + 2) * sx + x, sh(ay) * sy + y, sh(ax) * sx + x);
        break;
      case 3: burst = gfx.colorFire + 8; break;
      case 4: burst = gfx.colorFrame + 8; break;
      case 5: burst = gfx.colorPoison + 8; break;
      case 6: burst = gfx.colorSleep + 8; break;
      case 7:
        for (let k = 0; k < 7; k++, ax += 4, ay += 4) gfx.drawLine(sh(ay + 2) * sy + y, sh(ax + 2) * sx + x, sh(ay) * sy + y, sh(ax) * sx + x);
        ax -= 4;
        ay -= 4;
        gfx.plotPixel(sh(ay + 4) * sy + y, sh(ax + 4) * sx + x);
        gfx.plotPixel(sh(ay + 6) * sy + y, sh(ax + 6) * sx + x);
        gfx.plotPixel(sh(ay + 8) * sy + y, sh(ax + 8) * sx + x);
        break;
    }
    if (burst >= 0) {
      const offsets = 0x21ba - 0x2188; // 16 offsets 0-5, inside the shapes
      let fx = -1, fy = 1;
      for (let k = 0; k < 0x30; k++) {
        const a = randomBetween(0x0f, 0), b = randomBetween(0x0f, 0);
        if (randomBetween(1, 0)) fx = -fx;
        if (randomBetween(1, 0)) fy = -fy;
        gfx.setDrawColor(burst);
        gfx.plotPixel(shapes[offsets + b] * fy + y, shapes[offsets + a] * fx + x);
      }
    }
  }

  /**
   * f4be: the screen is copied to the back page, which then restores what each frame covered.
   * The missile advances 13 pixels a frame (6 in towns, 8 for kind 7) and stops, returning 0 with
   * `stopped` the square, when it enters a square that blocks sight. 1 if it got there.
   */
  async animateMissile(kind, toY, toX, fromY, fromX, stopped = null) {
    let step = 0x0d, frame = 0;
    const p = this.path;
    video.copyPage(0, 1);
    p.fill(0xff, 0, 0x100);
    p.fill(0xff, PATH_SIZE, PATH_SIZE + 0x100);
    this.traceLine(0, toY * 0x10 + 0x10, toX * 0x10 + 0x10, fromY * 0x10 + 0x10, fromX * 0x10 + 0x10);
    if (map.isOutdoors() || !map.onTileMap()) {
      if (kind === 7) step = 8;
    } else {
      step = 6;
    }
    const px = (k) => p[k], py = (k) => p[PATH_SIZE + k];
    let i = kind === 0 ? 4 : 0;
    for (;;) {
      if (px(i) === 0xff) return 1;
      frame = (frame & 3) + 1;
      const sq = pixelToSquare(py(i), px(i));
      if (stopped) {
        stopped.x = sq.x;
        stopped.y = sq.y;
      }
      if (sq.x === 0xffff) return 1;
      this.drawMissileFrame(i, kind, frame, py(i), px(i));
      platform.present();
      await sound.delayLoop(0x28, 1);
      video.copyRect((px(i) & 0xf8) - 8, py(i) - 8, (px(i) & 0xf8) + 0x0f, py(i) + 0x0f, 1, 0);
      i += step;
      if (i > PATH_SIZE) return 1;
      if (px(i) === 0xff) return 1;
      if (!isSquareVisible(sq.y, sq.x) && (fromX !== sq.x || fromY !== sq.y)) return 0;
    }
  }
}

export const combat = new Combat();
