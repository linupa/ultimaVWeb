// dungeon.js - the dungeons: DUNGEON.OVL (the first-person view, movement, traps, the wandering
// monster, rooms), DNGLOOK.OVL (Look, the map, corridor fights, room set-up) and the dungeon halves
// of SJOG.OVL, as the Dungeon class; `dungeon` is the one object. Ported from the C++ port's
// dungeon.cpp.
//
// A dungeon (locations 0x21-0x28) is 8 levels of 8 x 8 squares in `grid`, wrapping at the edges.
// A square's high nibble is its kind: 0 passage, 1 up ladder, 2 down ladder, 3 both, 4 chest (low
// bits: trapped / locked), 5 fountain (0 cure, 1 heal, 2 poison, 3 bad), 6 pit and traps (0 pit,
// 1 hidden pit, 2 bomb), 7 open chest, 8 field (0 sleep, 1 poison, 2 fire, 3 electric), A room
// behind a door, B wall (low nibble: a sign), C special wall (stalactite, cave-in or skeleton, by
// style), D secret door, E doorway, F room. Bit 3 of kinds 0-8 is a hole in the ceiling. Rooms are
// 11 x 11 combat maps in DUNGEON.CBT (16 per dungeon). One monster wanders each level: object 1
// (tile 0-7 = picture MONn.16, hull = monster type).
//
// The view is built on the back page from wall pieces (DNG1-3.16 by style, doors in DNG0.16) drawn
// left and mirrored right, four squares deep.
import { getCommandKey, toUpper, waitTurns } from './commands.js';
import { combat } from './combat.js';
import { data, SHARED } from './data/gamedata.js';
import { pictures, P } from './data/pictures.js';
import { S, strings } from './data/strings.js';
import { loadFilePart } from './files.js';
import { cmdSetActivePlayer, dispatchCommand } from './game.js';
import { exitGame, gameQuit } from './gamestate.js';
import { gfx } from './gfx.js';
import { input } from './input.js';
import { partyDeath, rescueLordBritish } from './endings.js';
import { M, map, passTime } from './map.js';
import { randomBetween, subByteFloor0 } from './misc.js';
import { monsters } from './monsters.js';
import { party } from './party.js';
import { copyBackRect, copyPageRect, dosFreeMem, drawPictureFrame, drawPictureFrame2, loadPicture, setClipRect } from './picture.js';
import { savegame } from './savegame.js';
import { getItem } from './sjog.js';
import { sound } from './sound.js';
import { status } from './status.js';
import { textWindows as tw } from './text.js';
import { tiles } from './tiles.js';
import { video } from './video/video.js';
import { view } from './view.js';
import { askWhichMember, damageMember, damageParty, perTurnStatus, springTrap } from './world.js';

// The read-only tables, by their offsets in the original data segment.
const T = Object.freeze({
  MONSTER_TYPE: 0x173c, // the wandering monster: its type by picture (0-7)
  MONSTER_ANIM: 0x1744, // and how that picture is animated
  CORRIDOR_FEATURE: 0x244a, // corridor fight: the tile shown for the square's kind
  CAMP_PARTY_X: 0x2452,
  CAMP_PARTY_Y: 0x2458,
  CORRIDOR_PARTY_1: 0x245e,
  CORRIDOR_PARTY_2: 0x2464,
  CORRIDOR_PARTY_3: 0x246a,
  CORRIDOR_PARTY_4: 0x2470,
  CORRIDOR_MONSTERS_1: 0x2476,
  CORRIDOR_MONSTERS_2: 0x2486,
  CORRIDOR_MONSTERS_3: 0x2496,
  CORRIDOR_MONSTERS_4: 0x24a6,
  CAMP_MONSTER_X: 0x24b6,
  CAMP_MONSTER_Y: 0x24c6,
  ROOM_FACING: 0x2c76, // the way the party faces in a room, by the direction it came from
  SIGN_FIRST: 0x2dc7, // signs: by location id, the dungeon's first sign
  SIGN_LAST: 0x2dcf,
  SIGN_LEFT: 0x2df7, // a sign's text window
  SIGN_TOP: 0x2e03,
  SIGN_TEXT: 0x2e10, // and its text (string ids, words)
  MONSTER_ARMS: 0x2e26,
  MONSTER_X: 0x2e2a, // words
  MONSTER_Y: 0x2e32, // words: standing or hanging, by distance
  SPARKLE_LOW: 0x2e42,
  SPARKLE_HIGH: 0x2e4a,
  SPARKLE_COUNT: 0x2e52,
  SPARKLE_LENGTH: 0x2e5a,
  WALL_X: 0x2e62,
  FEATURE_X: 0x2e72,
  FEATURE_Y: 0x2e7a,
  CEILING_Y: 0x2e82,
  WALL_PIECE: 0x2e80,
  DRIP_Y_AHEAD: 0x2e8b,
  DRIP_Y_SIDE: 0x2e9a,
  FOUNTAIN_0: 0x2ea4,
  FOUNTAIN_1: 0x2ed4,
  FOUNTAIN_2: 0x2ef2,
  FOUNTAIN_3: 0x2f0a,
  FOUNTAIN_0_TOP: 0x2f10,
  CEILING_PIECE: 0x2f16,
  FLOOR_PIECE: 0x2f1e,
  HOLE_PIECE: 0x2f24,
  SIDE_DX: 0x2f28,
  SIDE_DY: 0x2f2c,
  ROOM_OBJECT_RANGE: 0x383f,
  ROOM_OBJECT_BASE: 0x384d,
  RANDOM_MONSTERS: 0x385e,
  CHEST_LEVEL: 0x41bc,
  CHEST_AMOUNT: 0x41c4,
  CHEST_KIND: 0x41cc,
});

// The tables come from DATA.OVL in six runs, read by their old ds offsets: several overlap or are
// entered part way in, and reading them the way the original does keeps every such case exact.
const runs = [
  [0x173c, 0x10, false], [0x244a, 0x8c, false], [0x2c76, 0x4, false],
  [0x2dc7, 0x169, true], [0x383f, 0x27, false], [0x41bc, 0x18, false],
].map(([start, size, shared]) => ({ start, size, bytes: data.bytes(start, new Uint8Array(size), `dungeon.tables_${start.toString(16).toUpperCase()}`, shared ? SHARED : undefined) }));

/** An offset outside the runs gives 0. */
function tableByte(ds) {
  for (const r of runs) if (ds - r.start >= 0 && ds - r.start < r.size) return r.bytes[ds - r.start];
  return 0;
}
function tableWord(ds) {
  return ((tableByte(ds) | (tableByte(ds + 1) << 8)) << 16) >> 16;
}

export class Dungeon {
  constructor() {
    // Part of the saved game.
    this.grid = new Uint8Array(0x200); // 8 levels of 8 x 8, [z * 0x40 + y * 8 + x], from DUNGEON.DAT
    this.style = 0; // 1 normal, 2, 3 caves: which walls are drawn
    this.facing = 0; // 0 north, 1 east, 2 south, 3 west
    this.entryDir = 0; // the direction the party came from (rooms, attacks)
    this.clearedRooms = new Uint8Array(14); // a bit per room emptied
    // The pictures of the first-person view, and what a corridor fight is fought on.
    this.wallPic = 0;
    this.doorPic = 0;
    this.monsterPic = 0;
    this.gfxFlags = 0; // 1 pictures loaded, 2 tiles loaded, 4 don't swap the room colours
    this.corridorWallTile = 0;
    this.corridorFloorTile = 0;
    this.footstepToggle = 0;
    this.footstepVolume = 0;
    this.fountainFrame = 0;
    this.mapQueueX = new Uint8Array(256);
    this.mapQueueY = new Uint8Array(256);
    const s = savegame;
    s.bytes(0x58e0, this.clearedRooms, 'dungeon.clearedRooms');
    // The original declares the map four bytes short of its 0x200: the last four squares are the
    // first word of the dead NPC bits, which belongs to no location. They are not saved.
    s.bytes(0x595a, this.grid.subarray(0, 0x200 - 4), 'dungeon.grid');
    s.u8(0x6602, this, 'entryDir', 'dungeon.entryDir');
    s.u8(0x6603, this, 'facing', 'dungeon.facing');
    s.u8(0x6604, this, 'style', 'dungeon.style');
    // The rooms that fill up again however often they are emptied: dungeon * 0x10 + room.
    this.fixedRooms = data.bytes(0x383a, new Uint8Array(6), 'dungeon.fixedRooms', SHARED);
  }

  /** The square index of level z, row y, column x (wrapping). */
  at(z, y, x) {
    return (z & 7) * 0x40 + (y & 7) * 8 + (x & 7);
  }
  cell(z, y, x) {
    return this.grid[this.at(z, y, x)];
  }
  setCell(z, y, x, v) {
    this.grid[this.at(z, y, x)] = v;
  }
  /** The party's square. */
  here() {
    return this.cell(map.z, map.y, map.x);
  }
  setHere(v) {
    this.setCell(map.z, map.y, map.x, v);
  }
  get fdx() { return Dungeon.facingDx[this.facing & 3]; }
  get fdy() { return Dungeon.facingDy[this.facing & 3]; }

  /** 0x21 and 0x22 share index 0. */
  dungeonIndex() {
    let i = map.id - 0x21;
    if (i > 0) i = map.id - 0x22;
    return i;
  }

  // ---- DUNGEON.OVL ----

  /**
   * 81d0: a room is combat without an enemy object: the party comes in on the side it walked from,
   * and leaving by a side moves it one square that way. Leaving with the monsters dead marks the
   * room cleared (rooms 0xF0 become 0xA0: just a door).
   */
  async dungeonEnterRoom(square) {
    tw.printText(strings.get(S.Entering_room_2C58));
    this.facing = tableByte(T.ROOM_FACING + this.entryDir);
    input.flushKeyboard();
    const active = party.activePlayer, x = map.x, y = map.y;
    const saved = map.objects.bytes.slice(8, 24);
    party.activePlayer = 0xff;
    combat.turn = 0xff;
    view.localMap.fill(0, 0, 0x160);
    loadFilePart(this.dungeonIndex() * 0x1600 + (square & 0x0f) * 0x160, 0x160, view.localMap, strings.get(S.dungeon_cbt_2C6A));
    combat.prevLocation = map.id;
    map.id = M.SCENE;
    combat.exitDir = 0;
    await this.placeCombatants(3, square);
    await view.worldTick();
    combat.flags = 0x82;
    if ((await combat.combatMainLoop()) === 0) {
      if (combat.exitDir === 0x4d) await rescueLordBritish();
      map.id = combat.prevLocation;
      this.markRoomCleared(square & 0x0f);
      this.setCell(map.z, y, x, this.cell(map.z, y, x) & 0xaf);
    }
    map.id = combat.prevLocation;
    map.x = x;
    map.y = y;
    this.applyCombatExit();
    map.objects.bytes.set(saved, 8);
    party.activePlayer = active;
  }

  /** 8304: the level's wandering monster: one of eight pictures. hull 0xFF = none. */
  dungeonSpawnMonster(newMonster) {
    const m = map.objects.at(1);
    const had = m.hull;
    if (newMonster !== 0) {
      const kind = randomBetween(7, 0);
      m.tile = m.tile2 = kind;
      m.skiffs = 0;
      m.flags = tableByte(T.MONSTER_ANIM + kind);
      m.hull = tableByte(T.MONSTER_TYPE + kind);
      m.z = map.z;
      if (had !== 0xff) dosFreeMem(this.monsterPic);
      this.monsterPic = 0;
      if (this.placeDungeonMonster() === 0) {
        m.tile = m.tile2 = 0;
        m.hull = 0xff;
      }
    }
    if (m.hull !== 0xff) this.monsterPic = loadPicture(pictures.monster(m.tile));
  }

  /** 83a2 */
  drawDungeonHud() {
    const names = [S.North_2C7C, S.East_2C82, S.South_2C88, S.West_2C8E, S.SP_Qm_Qm_Qm_2C94];
    tw.inWindow(0, () => {
      tw.setCursor(0, 0x0c);
      tw.printNumber(' ', 1, map.z + 1);
      tw.setCursor(0x17, 0x0c);
      tw.printText(strings.get(names[this.facing < 4 ? this.facing : 4]));
    });
  }

  /**
   * 8422: eight tries at a random open square of the level that is neither in the party's row
   * nor its column. Types 0x16 and 0x18 hang from the ceiling half the time (skiffs 0xFF).
   */
  placeDungeonMonster() {
    const m = map.objects.at(1), prev = map.objects.at(2);
    for (let tries = 0; tries < 8; tries++) {
      const pos = randomBetween(0x3f, 0);
      const kind = this.grid[pos + map.z * 0x40] & 0xf0;
      if (!(kind < 0x60 || kind === 0x70)) continue;
      if (pos % 8 === map.x || Math.trunc(pos / 8) === map.y) continue;
      m.x = prev.x = pos % 8;
      m.y = prev.y = Math.trunc(pos / 8);
      if ((m.hull === 0x16 || m.hull === 0x18) && randomBetween(99, 0) > 0x30) m.skiffs = 0xff;
      return 1;
    }
    m.x = m.y = prev.x = prev.y = 0xff;
    return 0;
  }

  /** 8502 */
  drawDungeonFrame() {
    gfx.setDrawColor(gfx.colorFrame);
    gfx.fillRect(7, 0x98, 0, 0x28);
    gfx.fillRect(0xbf, 0x98, 0xb9, 0x30);
    gfx.setDrawColor(gfx.colorText);
    gfx.drawLine(7, 0x98, 7, 0x28);
    gfx.drawLine(0xb8, 0x98, 0xb8, 0x30);
    tw.inWindow(0, () => {
      tw.setCursor(0, 10);
      status.drawLabelLeft();
      tw.printText(strings.get(S.L_2C9A));
      status.drawLabelRight();
      tw.setCursor(0x17, 6);
      status.drawLabelLeft();
      tw.printText(strings.get(S.Dir_2C9D));
      status.drawLabelRight();
    });
  }

  /**
   * 85a6: while no key comes the view is redrawn (monster, drips, fountains move). After the
   * first pass only the middle is refreshed, except in the style with dripping stalactites.
   */
  async dungeonReadKey() {
    status.refresh();
    tw.putChar(0x0a);
    status.drawLabelLeft();
    let full = 1;
    for (;;) {
      let key = toUpper((await input.waitKeyCursor()) & 0xff);
      if (key !== 0 && key < 5 && input.numpadShift === 0) key += 0xfa;
      if (key !== 0 || gameQuit()) return key;
      this.drawDungeonView(full);
      if (full) copyPageRect(0xb2, 0xaf, 0x0e, 0x10, 0, 1);
      else copyPageRect(0xb2, 0x96, 0x0e, 0x28, 0, 1);
      if (this.style !== 1) full = 0;
      await this.footstepSound();
    }
  }

  /** 8640: the party is thrown back the way it came and takes damage. */
  async electricFieldShock(dir) {
    await this.redrawDungeon();
    tw.printText(strings.get(S.Ouch_2CA8));
    tw.printText(strings.get(S.Electric_field_2CAF));
    gfx.setDrawColor(gfx.colorText);
    gfx.xorFillRect(0xb7, 0xb7, 8, 8);
    await input.delayTicks(1);
    gfx.xorFillRect(0xb7, 0xb7, 8, 8);
    await sound.soundNoise(20000, 500, 1);
    const sign = dir < 1 ? 1 : -1;
    map.y = (map.y + sign * this.fdy) & 0xff;
    map.x = (map.x + sign * this.fdx) & 0xff;
    await damageParty();
    await this.redrawDungeon();
  }

  /**
   * 86d2: key 1 left, 2 right, 3 advance, 4 back, else turn around. No turning in a doorway. Walls
   * block; a room or its door can't be backed into; the monster's square is blocked. Returns 1 for
   * a step attempt (a turn passes).
   */
  async dungeonMove(square, key) {
    let step = 0;
    if (key === 1 || key === 2) {
      if ((square & 0xf0) === 0xe0) {
        tw.printText(strings.get(key === 1 ? S.Not_in_doorway_2CEF : S.Not_in_doorway_2CC9));
      } else {
        tw.printText(strings.get(key === 1 ? S.Turn_left_2D00 : S.Turn_right_2CDA));
        this.facing = (this.facing + (key === 1 ? 3 : 1)) & 3;
      }
    } else if (key === 3) {
      tw.printText(strings.get(S.Advance_2CC0));
      step = 1;
    } else if (key === 4) {
      tw.printText(strings.get(S.Back_up_2CE6));
      step = -1;
    } else {
      tw.printText(strings.get(S.Turn_around_2D0B));
      this.facing = (this.facing + 2) & 3;
    }
    this.entryDir = this.facing;
    if (step !== 0) {
      let x = (this.fdx * step + map.x) & 7, y = (this.fdy * step + map.y) & 7;
      let cell = this.cell(map.z, y, x);
      if (cell === 0x83) {
        map.x = x;
        map.y = y;
        await this.electricFieldShock(step);
        x = map.x;
        y = map.y;
      }
      cell &= 0xf0;
      const m = map.objects.at(1);
      if ((cell >= 0xa1 && cell <= 0xdf) || (step === -1 && (cell === 0xa0 || cell === 0xf0))) {
        tw.printText(strings.get(S.Blocked_2D19));
      } else if (x === m.x && y === m.y) {
        tw.printText(strings.get(S.Blocked_2D23));
      } else {
        this.footstepVolume = 0x0f;
        this.footstepToggle = 0;
        await this.footstepSound();
        this.footstepToggle = 0;
        map.x = x & 7;
        map.y = y & 7;
      }
    }
    await this.redrawDungeon();
    return step !== 0 ? 1 : 0;
  }

  /** 8894: arrows walk and turn; Return or '.' turns around; the rest goes to the dispatcher. */
  async dungeonHandleKey(key) {
    switch (key) {
      case 0x0b:
        tw.printNumber(' ', 1, party.karma);
        tw.putChar(0x0a);
        return 1;
      case 5:
        tw.printText(strings.get(S.Exit_to_DOS_2D2D));
        if (((await getCommandKey()) & 0xff) === 0x59) exitGame();
        else tw.printText(strings.get(S.N_2D3B));
        return 1;
      case 0x13:
        tw.printText(strings.get(S.Sound_2D43));
        tw.printText(strings.get(sound.enabled === 0 ? S.On_2D4F : S.Off_2D4A));
        sound.enabled = sound.enabled === 0 ? 1 : 0;
        return 1;
      case 0x16:
        tw.printText(strings.get(S.N1_16_2D3E));
        tw.putChar(0x0a);
        return 1;
      case 1: case 2: case 3: case 4: case 0x0d: case 0x2e:
        return this.dungeonMove(this.here(), key);
    }
    if (key >= 0x30 && key <= 0x39) {
      cmdSetActivePlayer(key);
      return 0;
    }
    return dispatchCommand(key);
  }

  /**
   * 89b2: up to eight tries at a random step onto a square that isn't a pit, field, wall or door;
   * it steps back where it just was only 1 time in 8. Type 0x1B stays put. If the step lands on
   * the party the monster is put back and attacks (1).
   */
  dungeonMonsterMove() {
    const m = map.objects.at(1), prev = map.objects.at(2);
    if (m.hull === 0xff) return 0;
    if (m.hull !== 0x1b) {
      for (let tries = 0; tries < 8; tries++) {
        const d = randomBetween(3, 0);
        let x = Dungeon.facingDx[d] + m.x, y = Dungeon.facingDy[d] + m.y;
        if (x > 7) x = 0;
        if (x < 0) x = 7;
        if (y > 7) y = 0;
        if (y < 0) y = 7;
        const kind = this.cell(map.z, y, x) & 0xf0;
        if (kind === 0x60 || kind === 0x80 || kind >= 0xa0) continue;
        if (x === prev.x && y === prev.y && randomBetween(7, 0) !== 1) continue;
        prev.x = m.x;
        prev.y = m.y;
        m.x = x;
        m.y = y;
        break;
      }
    }
    if (m.x === map.x && m.y === map.y) {
      m.x = prev.x;
      m.y = prev.y;
      return 1;
    }
    return 0;
  }

  /** 8b18 */
  async sleepTrap() {
    tw.printText(strings.get(S.Sleep_spell_2D53));
    for (let i = 0; i < party.size; i++) {
      if (party.member(i).dex > randomBetween(0x1e, 1) || party.member(i).dead()) continue;
      party.member(i).status = 'S';
      status.highlightMemberRow(i);
      await sound.soundNoise(0xdac, 0x32, 1);
      status.dirty = true;
    }
    this.setHere(this.here() & 8);
  }

  /** 8bb6 */
  async poisonTrap() {
    tw.printText(strings.get(S.Poison_2D61));
    for (let i = 0; i < party.size; i++) {
      if (party.member(i).dex > randomBetween(0x1e, 1) || party.member(i).dead()) continue;
      party.member(i).status = 'P';
      await sound.soundNoise(0xdac, 0x32, 1);
    }
  }

  /** 8c1c: a hidden pit drops the party a level - and again if it lands on another. Below level 8 is the way out. */
  async pitTrap(square) {
    this.entryDir = 5;
    while ((square === 0x61 || square === 0x69) && map.z < 8) {
      tw.printText(strings.get(S.Pit_Trap_2D6A));
      tw.printText(strings.get(S.Falling_2D75));
      this.setHere(this.here() & 0xf8);
      map.z++;
      if (map.z > 7) break; // (the original reads past the map here)
      square = this.here();
      if (square < 0x90) {
        square |= 8;
        this.setHere(square);
      }
      await this.redrawDungeon();
      tw.printText(strings.get(S.splat_2D81));
      await damageParty();
    }
    if (map.z === 8) map.id = M.BRITANNIA;
    if (map.isOutdoors()) return;
    const kind = this.here() & 0xf0;
    if (kind === 0xa0 || kind === 0xf0) {
      this.unloadDungeonGraphics();
      await this.dungeonEnterRoom(this.here());
      if (map.isOutdoors()) return;
      this.loadDungeonGraphics(1);
    }
    this.dungeonSpawnMonster(1);
  }

  /** 8d4e: the party turns to face the attacker; the fight is on a map built from the corridor. */
  async dungeonMonsterAttack() {
    const prev = map.objects.at(2);
    tw.printText(strings.get(S.Attacked_2D92));
    if (((prev.x - 1) & 7) === map.x) this.entryDir = 1;
    else if (((prev.x + 1) & 7) === map.x) this.entryDir = 3;
    else if (((prev.y - 1) & 7) === map.y) this.entryDir = 2;
    else this.entryDir = 0;
    if (this.entryDir !== this.facing) {
      const names = [S.north_2DA6, S.east_2DAC, S.south_2DB1, S.west_2DB7];
      tw.printText(strings.get(S.from_the_2D9B));
      tw.printText(strings.get(names[this.entryDir & 3]));
      this.facing = this.entryDir;
    }
    tw.printText(strings.get(S.Bang_NL_2DBC));
    await this.redrawDungeon();
    input.flushKeyboard();
    await input.delayTicks(2);
    this.unloadDungeonGraphics();
    combat.exitDir = 0;
    combat.flags = 2;
    this.setupCorridorCombat();
    await combat.runCombat(0, map.objects.at(1).hull, 2);
    this.applyCombatExit();
    this.loadDungeonGraphics(1);
    this.dungeonSpawnMonster(1);
    if (!map.isOutdoors()) await this.redrawDungeon();
  }

  /** 8e46: after a turn: sleepers wake 1 time in 16, the monster moves, then the square acts: rooms open, fields and traps strike. */
  async dungeonTurnEffects(monsterMoves, square) {
    let woke = 0;
    for (let i = 0; i < party.size; i++)
      if (party.member(i).asleep() && randomBetween(0x3f, 0) < 4) {
        party.member(i).status = 'G';
        woke++;
      }
    if (woke) status.drawStatusBar();
    if (monsterMoves && this.dungeonMonsterMove()) {
      await this.dungeonMonsterAttack();
      if (map.isOutdoors() || gameQuit()) {
        await perTurnStatus();
        return;
      }
      square = this.here();
    }
    let kind = square & 0xf0;
    if (kind === 0xf0 || kind === 0xa0) {
      this.unloadDungeonGraphics();
      while ((kind === 0xf0 || kind === 0xa0) && status.checkPartyState() > -1 && !gameQuit()) {
        await this.dungeonEnterRoom(square);
        if (map.isOutdoors()) break;
        square = this.here();
        kind = square & 0xf0;
      }
      this.loadDungeonGraphics(1);
      if (!map.onTileMap()) await this.redrawDungeon();
      await perTurnStatus();
      return;
    }
    switch (square) {
      case 0x80: case 0x88: await this.sleepTrap(); break;
      case 0x81: case 0x89: await this.poisonTrap(); break;
      case 0x82: case 0x8a:
        tw.printText(strings.get(S.Fire_2DBF));
        await damageParty();
        break;
      case 0x61: case 0x69: await this.pitTrap(square); break;
      case 0x62: case 0x6a:
        tw.printText(strings.get(S.Bomb_Trap_2DC7));
        tw.printText(strings.get(S.KABOOM_2DD3));
        this.setHere(this.here() & 8);
        await damageParty();
        break;
    }
    status.drawStatusBar();
    await perTurnStatus();
  }

  /**
   * 8ffe: styles: 3 for Deceit, Wrong and Covetous (stone: fights on tiles 0x4F / 0x45), 2 for
   * Shame and Hythloth, 1 for the rest (caves: 0x4D / 5). A minute passes per turn (none under
   * Time Stop, every other turn under Quickness, when the monster also rests).
   */
  async dungeonMainLoop(resetMonster) {
    let state = 0, moves = 0;
    this.gfxFlags = 2;
    this.applyClearedRooms();
    const kind = this.here() & 0xf0;
    this.drawDungeonFrame();
    this.drawDungeonHud();
    if (map.id === M.DECEIT || map.id === M.WRONG || map.id === M.COVETOUS) {
      this.corridorWallTile = 0x4f;
      this.corridorFloorTile = 0x45;
      this.style = 3;
    } else {
      this.corridorWallTile = 0x4d;
      this.corridorFloorTile = 5;
      this.style = map.id === M.SHAME || map.id === M.HYTHLOTH ? 2 : 1;
    }
    if (kind === 0xa0 || kind === 0xf0) {
      this.unloadDungeonGraphics();
      await this.dungeonEnterRoom(this.here());
    }
    if (!map.onTileMap()) {
      this.loadDungeonGraphics(resetMonster);
      this.dungeonSpawnMonster(resetMonster);
      await this.redrawDungeon();
    }
    while (!map.onTileMap() && !gameQuit()) {
      state = status.checkPartyState();
      if (state < 0) break;
      if (state === 1) {
        tw.putChar(0x0a);
        status.drawLabelLeft();
        tw.printText(strings.get(S.Zzzzzz_2DDD));
        // the original loops here without a turn until someone wakes - which only a turn can do,
        // so it hangs; the port lets the dungeon's turn pass
        await this.dungeonTurnEffects(1, this.here());
        await waitTurns(1);
        continue;
      }
      if (party.activeSpell === 0x54) {
        moves = 0;
      } else if (party.activeSpell === 0x51) {
        moves ^= 1;
        if (moves) passTime(1);
      } else {
        moves = 1;
        passTime(1);
      }
      const key = await this.dungeonReadKey();
      if (gameQuit()) break;
      const turn = await this.dungeonHandleKey(key);
      if (map.onTileMap() || gameQuit()) break;
      if (turn) await this.dungeonTurnEffects(moves, this.here());
    }
    if (this.gfxFlags & 2) this.gfxFlags &= 0xfb;
    else this.gfxFlags |= 4;
    this.unloadDungeonGraphics();
    if (state < 0) await partyDeath();
  }

  /** 91f0 */
  async footstepSound() {
    this.footstepToggle ^= 1;
    if (this.footstepToggle !== 0 && this.footstepVolume !== 0) {
      await sound.soundNoise(20000, this.footstepVolume, 1);
      subByteFloor0(4, this, 'footstepVolume');
    }
  }

  /** 921c: writing on a wall (0xBn, n = which of the dungeon's signs), in runes. */
  drawDungeonSign(sign) {
    if (sign > tableByte(T.SIGN_LAST + map.id)) return;
    const i = tableByte(T.SIGN_FIRST + map.id) + sign;
    tw.defineTextWindow(0x18, 0x27, tableByte(T.SIGN_TOP + i), tableByte(T.SIGN_LEFT + i), 0);
    tw.selectTextWindow(0);
    tw.selectFont(1);
    tw.setCursor(0, 0);
    tw.putChar(0xfd);
    tw.printText(strings.get(tableWord(T.SIGN_TEXT + (i - 1) * 2) & 0xffff));
    tw.putChar(0xfd);
    tw.selectFont(0);
    tw.selectTextWindow(2);
    tw.defineTextWindow(0x18, 0x27, 0, 0, 0);
  }

  /** 92ac */
  dungeonCellAt(y, x) {
    const c = this.cell(map.z, y, x);
    return c < 0x90 ? c & 0xf7 : c;
  }

  /**
   * 92ee: the monster's picture has two poses of three sizes; the left half is drawn and the right
   * half mirrored, each in its own pose. flags: 0x20 both halves alternate, 0x60 a four-step
   * cycle, 0x40 at random; 0x80 / 0x90 tie the right half to the left (same / opposite). A hanging
   * monster (skiffs 0xFF) is drawn upside down from the ceiling.
   */
  drawDungeonMonster(distance) {
    const m = map.objects.at(1);
    if (party.activeSpell === 0x54) m.flags = tableByte(T.MONSTER_ANIM + (m.tile & 7));
    const hanging = m.skiffs === 0xff ? 1 : 0;
    const f = m.flags, tie = f & 0x90, mode = f & 0x60;
    let phase = f & 0x0f, left, right;
    if (party.activeSpell === 0x54) {
      left = right = 1;
    } else {
      left = randomBetween(100, 0) < 0x32 ? 1 : 0;
      right = randomBetween(100, 0) < 0x32 ? 1 : 0;
      if (mode === 0x20) {
        left = right = phase = (f & 0x0f) === 0 ? 1 : 0;
      } else if (mode === 0x60) {
        if (--phase < 0) phase = 3;
        left = tableByte(T.MONSTER_ARMS + phase) >> 1;
        right = tableByte(T.MONSTER_ARMS + phase) & 1;
      }
    }
    if (tie !== 0) right = (tie === 0x90 ? 1 : 0) ^ left;
    if (this.monsterPic === 0) {
      tw.printText(strings.get(S.Hey_What_s_going_on_6C4E));
      return;
    }
    const y = tableWord(T.MONSTER_Y + hanging * 8 + distance * 2);
    drawPictureFrame(hanging, y, tableWord(T.MONSTER_X + distance * 2), left * 3 + distance - 1, this.monsterPic);
    drawPictureFrame2(hanging, y, 0x60, right * 3 + distance - 1, this.monsterPic);
    m.flags = mode + tie + phase;
  }

  /** 944e: short streaks at random in the square's area. */
  drawFieldSparkles(field, distance) {
    const clip = gfx.clipEnabled;
    gfx.clipEnabled = 0;
    if (field === 0) gfx.setDrawColor(gfx.colorSleep + 8);
    else if (field === 1) gfx.setDrawColor(gfx.colorPoison + 8);
    else if (field === 2) gfx.setDrawColor(gfx.colorFire + 8);
    else if (field === 3) gfx.setDrawColor(gfx.colorFrame + 8);
    const lo = tableWord(T.SPARKLE_LOW + distance * 2), hi = tableWord(T.SPARKLE_HIGH + distance * 2), len = tableWord(T.SPARKLE_LENGTH + distance * 2);
    for (let n = tableWord(T.SPARKLE_COUNT + distance * 2); n > 0; n--) {
      const x1 = randomBetween(hi - len, lo), y = randomBetween(hi, lo);
      gfx.drawHline(len + x1, y, x1);
    }
    gfx.clipEnabled = clip;
  }

  /**
   * 951a: pieces below 0x1F are frames of the wall picture, at row 14: the left one at the column
   * for its depth, the right one mirrored. Higher numbers are frames of the door picture (ladders,
   * chests, fountains, pits, holes): frame (piece + 1) / 2 - 16, sized by depth; kind 1 draws it
   * upside down for the ceiling.
   */
  drawWallPiece(side, kind, piece) {
    let x, y, pic;
    if (piece < 0x1f) {
      x = tableWord(T.WALL_X + side * 8 + (piece & 3) * 2);
      if (side !== 0 && ((piece & 0xf8) === 8 || (piece & 0xfc) === 0x18)) x = 0x60;
      y = 0x0e;
      kind = 0;
      pic = this.wallPic;
    } else {
      const u = piece + 1, depth = (u & 6) >> 1;
      piece = (u >> 1) - 0x10;
      x = side === 0 ? tableWord(T.FEATURE_X + depth * 2) : 0x60;
      if (piece < 8) y = kind === 0 ? 0x60 : tableWord(T.CEILING_Y + depth * 2);
      else y = tableWord(T.FEATURE_Y + depth * 2 + kind * 8);
      pic = this.doorPic;
    }
    if (side === 0) drawPictureFrame(kind, y, x, piece, pic);
    else drawPictureFrame2(kind, y, x, piece, pic);
  }

  /** 962c: a drop grows on the stalactite (frames 0-3), falls (4) and splashes (5: a sound). */
  drawDrip(distance, frame, y, x) {
    if (frame === 5) {
      sound.soundSlide(-(distance * 8 - 0x14), 1, 0xdac, 0xc80); // its sound plays while the view goes on
      return 0;
    }
    let color = gfx.colorFrame;
    if (frame === 4) color = gfx.videoType === 0 || gfx.videoType === 3 ? 3 : 0x0b;
    gfx.setDrawColor(color);
    gfx.drawHline(x + 1, y, x - 1);
    gfx.drawVline(y + 1, y - 1, x);
    if (frame < 4) {
      gfx.setDrawColor(gfx.colorFrame + 8);
      gfx.plotPixel(y, x);
    }
    if (frame !== 0 || randomBetween(0x40, 0) < 4) frame++;
    return frame;
  }

  /** 96da: the square straight ahead at this depth. A wall, door or room ends the view (0) - except the doorway the party stands in. */
  drawDungeonCenter(distance, y, x) {
    const cell = this.dungeonCellAt(y, x);
    if (cell < 0xa0) return 1;
    const piece = distance === 0 ? 0x0c : tableByte(T.WALL_PIECE + (cell >> 4)) + distance;
    this.drawWallPiece(0, 0, piece);
    this.drawWallPiece(1, 0, piece);
    if ((distance === 1 || distance === 2) && this.style === 1 && (cell & 0xf0) === 0xc0) {
      const frame = this.drawDrip(distance, cell & 7, tableByte(T.DRIP_Y_AHEAD + (cell & 7) + distance * 5) + 0x0e, 0x5f);
      this.setCell(map.z, y, x, (this.cell(map.z, y, x) & 0xf8) + frame);
    }
    if (distance === 1) {
      if ((cell & 0xf0) === 0xb0 && (cell & 0x0f) !== 0) {
        this.drawDungeonSign(cell & 0x0f);
      } else if (this.style === 3 && (cell & 0xf0) === 0xc0 && randomBetween(0x40, 0) < 4) {
        gfx.setDrawColor(gfx.colorFire + 8); // the skeleton's eyes glint
        gfx.drawHline(0x5d, 0x57, 0x5c);
        gfx.drawHline(0x5d, 0x58, 0x5b);
        gfx.drawHline(0x62, 0x57, 0x61);
        gfx.drawHline(99, 0x58, 0x61);
      }
    }
    if ((cell & 0xf0) !== 0xe0 || distance !== 0) return 0;
    gfx.clipEnabled = 1;
    return 1;
  }

  /** 9852: the square to the left (side 0) or right (1): a wall, an opening (+0x10), a door (+4), or a special wall (+0x14, with its drip). */
  drawDungeonSide(distance, side, y, x) {
    const cell = this.dungeonCellAt(y, x), kind = cell & 0xf0;
    let piece = distance;
    if (cell < 0xa0) {
      piece += 0x10;
    } else if (kind === 0xc0) {
      this.drawWallPiece(side, 0, distance + 0x14);
      if (distance > 1 || this.style !== 1) return;
      let px = distance === 0 ? 0x21 : 0x43;
      if (side !== 0) px = 0xbe - px;
      const frame = this.drawDrip(distance, cell & 7, tableByte(T.DRIP_Y_SIDE + (cell & 7) + distance * 5) + 0x0e, px);
      this.setCell(map.z, y, x, (this.cell(map.z, y, x) & 0xf8) + frame);
      return;
    } else if (kind === 0xa0 || kind === 0xe0 || kind === 0xf0) {
      piece += 4;
    }
    this.drawWallPiece(side, 0, piece);
  }

  /** 9956: spray as point lists by depth, each point drawn on both sides of the middle. */
  drawFountain(frame, distance) {
    const mono = gfx.videoType === 0 || gfx.videoType === 3;
    gfx.setDrawColor(mono ? 0 : gfx.colorFrame);
    if (distance === 0) {
      if (!mono) gfx.setDrawColor(gfx.colorFrame + 8);
      for (let i = 0; i < 8; i++) {
        const px = tableByte(T.FOUNTAIN_0 + frame * 0x10 + i * 2), py = tableByte(T.FOUNTAIN_0 + 1 + frame * 0x10 + i * 2);
        gfx.plotPixel(py, px);
        gfx.plotPixel(py, 0xbe - px);
      }
      const px = tableByte(T.FOUNTAIN_0_TOP + frame * 2), py = tableByte(T.FOUNTAIN_0_TOP + 1 + frame * 2);
      gfx.plotPixel(py, px);
      gfx.plotPixel(py, 0xbe - px);
    } else if (distance === 1) {
      for (let i = 0; i < 5; i++) {
        const px = tableByte(T.FOUNTAIN_1 + frame * 10 + i * 2), py = tableByte(T.FOUNTAIN_1 + 1 + frame * 10 + i * 2);
        gfx.plotPixel(py + 0x60, px + 0x48);
        gfx.plotPixel(py + 0x60, 0x76 - px);
      }
    } else if (distance === 2) {
      for (let i = 0; i < 4; i++) {
        const px = tableByte(T.FOUNTAIN_2 + frame * 8 + i * 2), py = tableByte(T.FOUNTAIN_2 + 1 + frame * 8 + i * 2);
        gfx.plotPixel(py + 0x60, px + 0x50);
        gfx.plotPixel(py + 0x60, 0x6e - px);
      }
    } else if (distance === 3) {
      const px = tableByte(T.FOUNTAIN_3 + frame * 2), py = tableByte(T.FOUNTAIN_3 + 1 + frame * 2) + 0x60;
      gfx.plotPixel(py, px + 0x58);
      gfx.plotPixel(py, 0x66 - px);
    }
  }

  /** 9b22: what stands in an open square: ladders, chests, fountains, pits, fields, the hole a pit left, and the monster. */
  drawDungeonContents(distance, y, x) {
    const cell = this.dungeonCellAt(y, x);
    const kind = cell >> 4;
    if (kind < 1 || kind > 7 || (kind === 6 && (cell & 7) !== 0)) {
      if (kind === 8) this.drawFieldSparkles(cell & 7, distance);
    } else {
      const up = tableByte(T.CEILING_PIECE + kind), down = tableByte(T.FLOOR_PIECE + kind);
      if (up !== 0) {
        this.drawWallPiece(0, 1, up + distance * 2);
        this.drawWallPiece(1, 1, up + distance * 2);
      }
      if (down !== 0) {
        this.drawWallPiece(0, 0, down + distance * 2);
        this.drawWallPiece(1, 0, down + distance * 2);
      }
      if (kind === 5) this.drawFountain(this.fountainFrame, distance);
    }
    if (kind < 9 && (this.cell(map.z, y, x) & 8)) {
      const piece = distance * 2 + tableByte(T.HOLE_PIECE);
      this.drawWallPiece(0, 1, piece);
      this.drawWallPiece(1, 1, piece);
    }
    const m = map.objects.at(1);
    if (distance !== 0 && (x & 7) === m.x && (y & 7) === m.y) this.drawDungeonMonster(distance);
    if (distance === 0 && ++this.fountainFrame > 2) this.fountainFrame = 0;
  }

  /**
   * 9c60: without torch or light spell all is black. Otherwise walls are drawn from the party's
   * square outward, up to four deep, until something closes the view; then the contents of the
   * squares from the far end back to the party. `full` 0 skips the side walls of the party's square.
   */
  drawDungeonView(full) {
    video.setDrawPage(1);
    gfx.setDrawColor(0);
    gfx.fillRect(0xb2, 0xaf, 0x0e, 0x60);
    setClipRect(0xb7, 0x98, 0x2a, 0x28);
    gfx.clipEnabled = 0;
    if (party.lightSpell === 0 && party.torchLight === 0) {
      gfx.fillRect(0xb7, 0xb7, 8, 8);
    } else {
      let x = map.x, y = map.y, depth;
      const dx = this.fdx, dy = this.fdy;
      const sideDx = tableByte(T.SIDE_DX + (this.facing & 3)), sideDy = tableByte(T.SIDE_DY + (this.facing & 3));
      for (depth = 0; depth < 4; depth++) {
        if (this.drawDungeonCenter(depth, y, x) === 0) break;
        if (depth !== 0 || (this.dungeonCellAt(map.y, map.x) !== 0xe0 && full !== 0)) {
          this.drawDungeonSide(depth, 0, sideDy + y, sideDx + x);
          this.drawDungeonSide(depth, 1, y - sideDy, x - sideDx);
        }
        x += dx;
        y += dy;
      }
      while (--depth > -1) {
        x -= dx;
        y -= dy;
        this.drawDungeonContents(depth, y, x);
      }
    }
    video.setDrawPage(0);
    gfx.clipEnabled = 0;
  }

  /** 9db0 */
  async redrawDungeon() {
    status.drawStatusBar();
    this.drawDungeonView(1);
    copyPageRect(0xb2, 0xaf, 0x0e, 0x10, 0, 1);
    await this.footstepSound();
    this.drawDungeonHud();
  }

  /** 9ddc: with `check` (the Uus Por / Des Por spells) the square on the other level must be open. */
  canKlimbInto(check, level) {
    const kind = this.cell(level, map.y, map.x) & 0xf0;
    return !(check !== 0 && kind !== 0);
  }

  /** 9e3a: 1 if the move leads out of the dungeon (above level 1 or below level 8). */
  async dungeonChangeLevel(check, dz) {
    tw.printText(strings.get(dz < 1 ? S.Up_6C74 : S.Down_6C6C));
    if ((dz >= 1 && map.z === 7) || (dz < 0 && map.z === 0)) return 1;
    if (!this.canKlimbInto(check, dz + map.z)) {
      tw.printText(strings.get(S.Failed_6C7A));
      await sound.soundSlide(0x32, 1, 2000, 800);
      return 0;
    }
    map.z = (map.z + dz) & 0xff;
    this.entryDir = dz < 1 ? 4 : 5;
    this.dungeonSpawnMonster(1);
    await this.redrawDungeon();
    return 0;
  }

  /** 9ed8: from level 1 up to Britannia; from any other level out is the Underworld. */
  exitDungeon() {
    map.x = map.exitX();
    map.y = map.exitY();
    tw.printText(strings.get(S.Exit_to_6C84));
    if (map.z === 0) {
      tw.printText(strings.get(S.Britannia_6C9C));
    } else {
      map.z = 0xff;
      tw.printText(strings.get(S.Underworld_6C8E));
    }
    map.id = M.BRITANNIA;
  }

  /** 9f1a */
  async cmdAttackDungeon() {
    tw.printText(strings.get(S.Attack_6CAA));
    const m = map.objects.at(1);
    if (((this.fdx + map.x) & 7) !== m.x || ((this.fdy + map.y) & 7) !== m.y) {
      tw.printText(strings.get(S.What_6CB2));
      return 0;
    }
    combat.flags = 2;
    this.unloadDungeonGraphics();
    this.buildCorridorMap();
    this.setupCorridorCombat();
    await combat.runCombat(0, m.hull, 2);
    if (combat.exitDir === 5) {
      if (map.z !== 0) map.z--;
      else this.exitDungeon();
    } else if (combat.exitDir === 6) {
      if (map.z < 7) map.z++;
      else this.exitDungeon();
    }
    this.loadDungeonGraphics(1);
    if (!map.isOutdoors()) {
      this.dungeonSpawnMonster(1);
      await this.redrawDungeon();
    }
    return 0;
  }

  /** 9fe0: up by an up ladder, or with a grapple through a hole; down by a down ladder or a pit. Where both: "U/D". */
  async cmdKlimbDungeon() {
    const kind = this.dungeonCellAt(map.y, map.x) & 0xf0;
    const hole = (this.here() & 8) !== 0;
    let up = kind === 0x10 || kind === 0x30 || (hole && party.grapples !== 0);
    let down = kind === 0x20 || kind === 0x30 || kind === 0x60;
    if (up && down) {
      tw.printText(strings.get(S.Klimb_U_D_6CBA));
      while (up && down) {
        const key = await getCommandKey();
        if (gameQuit()) return 0;
        if (key === 3 || key === 0x55) down = false;
        else if (key === 4 || key === 0x44) up = false;
        else if (key === 0x20) {
          tw.printText(strings.get(S.Pass_6CC6));
          up = down = false;
        }
      }
    } else if (!up && !down) {
      tw.printText(strings.get(hole ? S.Klimb_With_What_6CD6 : S.Klimb_what_6CEA));
      return 0;
    } else {
      tw.printText(strings.get(S.Klimb_6CCE));
    }
    if ((up && (await this.dungeonChangeLevel(0, -1)) !== 0) || (down && (await this.dungeonChangeLevel(0, 1)) !== 0)) this.exitDungeon();
    return 1;
  }

  // ---- DNGLOOK.OVL ----

  /** a290: fountains (0x50 cure, 0x51 heal, 0x52 poison, others bad water) can be drunk from. */
  async cmdLookDungeon() {
    const member = await askWhichMember();
    if (member === -1) return;
    if (party.torchLight === 0 && party.lightSpell === 0) {
      tw.printText(strings.get(S.You_see_darkness_752E));
      return;
    }
    const spot = await this.askDungeonDirection(this.facing);
    if (!spot) return;
    let cell = this.cell(map.z, spot.y, spot.x);
    tw.printText(strings.get(S.You_see_7542));
    if (cell === 0x61) cell = 0; // a hidden pit looks like a passage
    const kind = cell & 0xf0;
    let text = S.NONE;
    if (kind === 0x80) {
      const fields = [S.A_sleep_field_754C, S.A_poison_gas_field_755C, S.A_wall_of_fire_7572, S.An_electric_field_7584, S.An_energy_field_7598];
      text = fields[cell - 0x80 < 4 ? cell - 0x80 : 4];
    } else if (kind === 0xc0) {
      if ((this.style & 0x0f) === 1) text = S.a_dripping_stalactite_75AA;
      else if ((this.style & 0x0f) === 2) text = S.a_caved_in_passage_75C2;
      else text = randomBetween(0xff, 1) === 0xff ? S.an_unfortunate_software_75D8 : S.a_less_fortunate_75FA;
    } else {
      switch (kind) {
        case 0x00: text = S.a_passage_7618; break;
        case 0x10: text = S.an_up_ladder_7624; break;
        case 0x20: text = S.a_down_ladder_7634; break;
        case 0x30: text = S.a_ladder_7644; break;
        case 0x40: text = S.a_wooden_chest_7650; break;
        case 0x50: text = S.a_fountain_7662; break;
        case 0x60: text = S.a_pit_7670; break;
        case 0x70: text = S.an_open_chest_7678; break;
        case 0x90: text = S.nothing_of_note_769A; break;
        case 0xa0: text = S.a_heavy_door_76AC; break;
        case 0xb0: text = S.a_wall_76BC; break;
        case 0xd0: text = S.a_wall_76D6; break; // a secret door
        case 0xe0: text = S.a_heavy_door_76E0; break;
        case 0xf0: text = S.a_heavy_door_76F0; break;
      }
    }
    if (text !== S.NONE) tw.printText(strings.get(text));
    if (kind !== 0x50) return;
    tw.printText(strings.get(S.Will_you_drink_7700));
    let c;
    do {
      c = (await getCommandKey()) & 0xff;
      if (gameQuit()) return;
    } while (c !== 0x59 && c !== 0x4e);
    if (c === 0x4e) {
      tw.printText(strings.get(S.No_7712));
      return;
    }
    tw.printText(strings.get(S.Yes_Gulp_7718));
    const pm = party.member(member);
    if (cell === 0x50) {
      tw.printText(strings.get(S.Cured_7726));
      pm.status = 'G';
    } else if (cell === 0x51) {
      tw.printText(strings.get(S.Healed_772E));
      pm.hp = pm.maxHp;
    } else if (cell === 0x52) {
      tw.printText(strings.get(S.Poisoned_7738));
      pm.status = 'P';
    } else {
      tw.printText(strings.get(S.Bad_taste_7744));
      await damageMember(randomBetween(7, 0), member);
    }
  }

  /** a514 */
  drawMapField(y, x) {
    const order = [0, 2, 1, 3];
    for (let i = 0; i < 4; i++) {
      const c = order[i] === 0 ? gfx.colorSleep : order[i] === 2 ? gfx.colorFire : order[i] === 1 ? gfx.colorFrame : gfx.colorPoison;
      gfx.setDrawColor(c + 8);
      gfx.drawLine(y + i * 2, x + 6, y + i * 2, x + 1);
      gfx.drawLine(y + i * 2 + 1, x + 6, y + i * 2 + 1, x + 1);
    }
  }

  /**
   * a5d0: the map is 22 x 22 character cells centred on the party (the level repeats, as it
   * wraps). A square is drawn once (localMap marks the cells still to do) as a rune-font glyph;
   * returns 1 if the map goes on through it: open squares do, walls don't.
   */
  drawMapSquare(row, col) {
    if (col < 0 || col > 0x15 || row < 0 || row > 0x15) return 0;
    if (view.localMap[row * 0x20 + col] === 0) return 0;
    view.localMap[row * 0x20 + col] = 0;
    let through = 1;
    const cell = this.cell(map.z, row + map.y - 0x0b, col + map.x - 0x0b);
    tw.setCursor(row + 1, col + 1);
    const px = col * 8, py = row * 8;
    let glyph = -1;
    gfx.setDrawColor(gfx.colorText);
    switch (cell >> 4) {
      case 0:
        if (cell & 8) {
          tw.setTextColor(gfx.colorLadder);
          glyph = 0x18;
        }
        break;
      case 1: tw.selectFont(1); tw.setTextColor(gfx.colorLadder); glyph = 0x2e; break;
      case 2: tw.selectFont(1); tw.setTextColor(gfx.colorLadder); glyph = 0x2d; break;
      case 3: tw.selectFont(1); tw.setTextColor(gfx.colorLadder); glyph = 0x2f; break;
      case 4: tw.selectFont(1); tw.setTextColor(gfx.colorChest); glyph = 0x70; break;
      case 5:
        gfx.drawLine(py + 0x0c, px + 0x0e, py + 0x0c, px + 9);
        gfx.drawLine(py + 0x0d, px + 0x0d, py + 0x0d, px + 10);
        gfx.drawLine(py + 0x0e, px + 10, py + 0x0e, px + 9);
        gfx.drawLine(py + 0x0e, px + 0x0e, py + 0x0e, px + 0x0d);
        gfx.setDrawColor(gfx.colorFrame + 8);
        gfx.plotPixel(py + 10, px + 9);
        gfx.plotPixel(py + 9, px + 10);
        gfx.drawLine(py + 10, px + 0x0c, py + 10, px + 0x0b);
        gfx.drawLine(py + 0x0b, px + 0x0c, py + 0x0b, px + 0x0b);
        gfx.plotPixel(py + 9, px + 0x0d);
        gfx.plotPixel(py + 10, px + 0x0e);
        break;
      case 6:
        tw.setTextColor(gfx.colorLadder);
        if (cell === 0x60) glyph = 0x19;
        else if (cell === 0x68) glyph = 0x12;
        else {
          tw.selectFont(1);
          if (cell === 0x61 || cell === 0x69) glyph = 0x71;
          else {
            tw.setTextColor(gfx.colorFire + 8);
            glyph = 0x72;
          }
        }
        break;
      case 8: this.drawMapField(py + 8, px + 8); break;
      case 0x0a: case 0x0f: tw.selectFont(1); tw.setTextColor(gfx.colorChest); glyph = 0x73; break;
      case 0x0b:
        if (cell === 0xb0) tw.putChar(0x7f);
        else {
          tw.selectFont(1);
          tw.putChar(0x74);
        }
        through = 0;
        break;
      case 0x0c:
        tw.selectFont(1);
        tw.setTextBgColor(gfx.colorFrame);
        tw.putChar(0x75);
        tw.setTextBgColor(0);
        through = 0;
        break;
      case 0x0d:
        tw.selectFont(1);
        if (gfx.videoType === 0) tw.setTextBgColor(gfx.colorFrame);
        else if (gfx.videoType === 1 || gfx.videoType === 2) tw.setTextBgColor(gfx.colorLadder);
        tw.putChar(0x76);
        tw.setTextBgColor(0);
        through = 0;
        break;
      case 0x0e: tw.selectFont(1); tw.setTextColor(gfx.colorChest); glyph = 0x77; break;
    }
    if (glyph >= 0) tw.putChar(glyph);
    tw.setTextColor(gfx.colorText);
    tw.selectFont(0);
    return through;
  }

  /** a938: the map spreads from the party through the open squares (a queue of 256 cells). */
  async showDungeonMap() {
    gfx.setDrawColor(0);
    gfx.fillRect(0xb7, 0xb7, 8, 8);
    view.localMap.fill(0xff, 0, 0x2e0);
    let head = 0, tail = 1;
    this.mapQueueX[0] = this.mapQueueY[0] = 0x0b;
    view.localMap[0x0b * 0x20 + 0x0b] = 0;
    gfx.setDrawColor(gfx.colorText);
    tw.selectTextWindow(0);
    tw.setCursor(0x0c, 0x0c);
    tw.selectFont(1);
    tw.setTextColor(gfx.videoType === 3 ? gfx.colorText : gfx.colorPoison + 8);
    tw.putChar(0x60); // the party
    tw.setTextColor(gfx.colorText);
    tw.selectFont(0);
    const dc = [-1, 0, 1, -1, 1, -1, 0, 1], dr = [-1, -1, -1, 0, 0, 1, 1, 1];
    while (head !== tail) {
      const col = this.mapQueueX[head], row = this.mapQueueY[head];
      for (let i = 0; i < 8; i++) {
        if (!this.drawMapSquare(row + dr[i], col + dc[i])) continue;
        this.mapQueueX[tail] = col + dc[i];
        this.mapQueueY[tail] = row + dr[i];
        tail = (tail + 1) & 0xff;
      }
      head = (head + 1) & 0xff;
    }
    tw.selectTextWindow(2);
    await input.waitKeyTimeout(0);
    gfx.setDrawColor(0);
    gfx.fillRect(0xb7, 0xb7, 8, 8);
    await this.redrawDungeon();
  }

  /** aad4: a bit per room (16 per dungeon); the fixed rooms always fill again. */
  markRoomCleared(room) {
    for (let i = 0; i < this.fixedRooms.length; i++) if (this.fixedRooms[i] === (map.id & 0x0f) * 0x10 + room) return;
    const bit = this.dungeonIndex() * 0x10 + room;
    this.clearedRooms[(bit >> 3) % this.clearedRooms.length] |= 1 << (bit & 7);
  }

  /** ab64 */
  isRoomCleared(room) {
    const bit = this.dungeonIndex() * 0x10 + room;
    return (this.clearedRooms[(bit >> 3) % this.clearedRooms.length] & (1 << (bit & 7))) !== 0;
  }

  /** abca */
  applyClearedRooms() {
    for (let i = 0; i < 0x200; i++) {
      const c = this.grid[i];
      if ((c & 0xf0) === 0xf0 && this.isRoomCleared(c & 0x0f)) this.grid[i] = c & 0xaf;
    }
  }

  /** ac0e: the corridor fight's map: sides 0-3 = north, east, south, west. A walled side is closed off; in a doorway the doorposts are added. */
  corridorEdgeWall(side, squareType) {
    const dx = side === 0 || side === 2 ? 1 : 0, dy = dx ? 0 : 1;
    let x = side === 1 ? 10 : 0, y = side === 2 ? 10 : 0;
    for (let i = 0; i < 11; i++, x += dx, y += dy) view.localMap[y * 0x20 + x] = 0xff;
    if (side === 0 && squareType === 0xe0) view.localMap[0x105] = view.localMap[0x45] = this.corridorWallTile;
    if (side === 3 && squareType === 0xe0) view.localMap[0xa8] = view.localMap[0xa2] = this.corridorWallTile;
  }

  /** acd8 */
  corridorEdgeOpen(side) {
    const dx = side === 0 || side === 2 ? 1 : 0, dy = dx ? 0 : 1;
    let x = side === 1 ? 9 : side === 3 ? 1 : 3, y = side === 0 ? 1 : side === 2 ? 9 : 3;
    for (let i = 0; i < 5; i++, x += dx, y += dy) view.localMap[y * 0x20 + x] = this.corridorFloorTile;
  }

  /** ad7e */
  corridorEdgePassage(side) {
    const dx = side === 0 || side === 2 ? 1 : 0, dy = dx ? 0 : 1;
    let x = side === 1 ? 9 : side === 3 ? 1 : 2, y = side === 0 ? 1 : side === 2 ? 9 : 2;
    for (let i = 0; i < 7; i++, x += dx, y += dy) view.localMap[y * 0x20 + x] = this.corridorFloorTile;
  }

  /** ae2e */
  buildCorridorEdge(side) {
    let x = map.x, y = map.y;
    if (side === 0) y--;
    else if (side === 1) x++;
    else if (side === 2) y++;
    else if (side === 3) x--;
    const kind = this.cell(map.z, y, x) & 0xf0;
    if (kind < 0xa0) this.corridorEdgePassage(side);
    if (kind === 0xb0 || kind === 0xc0 || kind === 0xd0) this.corridorEdgeWall(side, this.here() & 0xf0);
    else this.corridorEdgeOpen(side);
  }

  /**
   * aefc: a walled ring with the corners cut; whatever the party's square holds (ladder, chest,
   * fountain) stands in the middle. On a two-way ladder the ladder tiles are patched so both ends show.
   */
  buildCorridorMap() {
    const m = view.localMap;
    m.fill(this.corridorWallTile, 0x20, 0x20 + 11);
    m.fill(this.corridorWallTile, 0x120, 0x120 + 11);
    for (let r = 0; r < 11; r++) m[r * 0x20 + 1] = m[r * 0x20 + 9] = this.corridorWallTile;
    m[0x14a] = m[0x140] = m[10] = m[0] = 0xff;
    const kind = this.here() & 0xf0;
    if (kind !== 0 && kind < 0x80) {
      const tile = tableByte(T.CORRIDOR_FEATURE + (this.here() >> 4));
      if (tile !== 0) m[0xa5] = tile;
      if (this.here() >> 4 === 3) {
        combat.onLadder = 1;
        tiles.ladderTilesPatch(0);
      } else {
        combat.onLadder = 0;
      }
    }
    for (let side = 0; side < 4; side++) this.buildCorridorEdge(side);
  }

  /**
   * afce: fills in what loadCombatMap would have read: the party's start squares for each side it
   * can face, 16 monster squares by facing, and the monsters: 1 to the group size of the wandering
   * monster's type (for a camp a random one of the eight and the camp's own squares, with a fire
   * in the middle).
   */
  setupCorridorCombat() {
    const m = view.localMap;
    const camp = (combat.flags & 4) !== 0;
    for (let r = 0; r < 11; r++) m.fill(this.corridorFloorTile, r * 0x20, r * 0x20 + 11);
    if (camp) m[0xa5] = 0xb3;
    this.buildCorridorMap();
    m.fill(0xff, 0x113, 0x113 + 8);
    m.fill(0xff, 0x10b, 0x10b + 8);
    for (let i = 0; i < 6; i++) {
      if (camp) {
        m[0x6b + i] = m[0x4b + i] = m[0x8b + i] = m[0x2b + i] = tableByte(T.CAMP_PARTY_X + i);
        m[0x71 + i] = m[0x51 + i] = m[0x91 + i] = m[0x31 + i] = tableByte(T.CAMP_PARTY_Y + i);
      } else {
        m[0x6b + i] = tableByte(T.CORRIDOR_PARTY_4 + i);
        m[0x4b + i] = tableByte(T.CORRIDOR_PARTY_3 + i);
        m[0x8b + i] = tableByte(T.CORRIDOR_PARTY_1 + i);
        m[0x2b + i] = tableByte(T.CORRIDOR_PARTY_2 + i);
        m[0x71 + i] = tableByte(T.CORRIDOR_PARTY_2 + i);
        m[0x51 + i] = tableByte(T.CORRIDOR_PARTY_1 + i);
        m[0x91 + i] = tableByte(T.CORRIDOR_PARTY_3 + i);
        m[0x31 + i] = tableByte(T.CORRIDOR_PARTY_4 + i);
      }
    }
    const xs = [T.CORRIDOR_MONSTERS_1, T.CORRIDOR_MONSTERS_2, T.CORRIDOR_MONSTERS_4, T.CORRIDOR_MONSTERS_3];
    const ys = [T.CORRIDOR_MONSTERS_3, T.CORRIDOR_MONSTERS_4, T.CORRIDOR_MONSTERS_2, T.CORRIDOR_MONSTERS_1];
    for (let i = 0; i < 16; i++) {
      if (camp) {
        m[0xeb + i] = tableByte(T.CAMP_MONSTER_Y + i);
        m[0xcb + i] = tableByte(T.CAMP_MONSTER_X + i);
      } else if (this.facing < 4) {
        m[0xcb + i] = tableByte(xs[this.facing] + i);
        m[0xeb + i] = tableByte(ys[this.facing] + i);
      }
    }
    const order = [];
    for (let i = 0; i < 16; i++) order[i] = i;
    for (let i = 0; i < 16; i++) {
      const j = randomBetween(0x0f, 0), t = order[i];
      order[i] = order[j];
      order[j] = t;
      m[0xab + i] = 0;
    }
    let type = map.objects.at(1).hull;
    if (camp) type = tableByte(T.MONSTER_TYPE + randomBetween(7, 0));
    const size = monsters.groupSize(type);
    let count = randomBetween(size, 1);
    if (size === 8 || size === 0x10) count = size;
    for (let i = 0; i < count && i < 16; i++) m[0xab + order[i]] = type * 4 + 0x40;
  }

  /** b26a: the way the party left a fight or a room becomes a step in the dungeon. */
  applyCombatExit() {
    switch (combat.exitDir) {
      case 1: map.x = (map.x - 1) & 7; this.facing = this.entryDir = 3; break;
      case 2: map.x = (map.x + 1) & 7; this.facing = this.entryDir = 1; break;
      case 3: map.y = (map.y - 1) & 7; this.facing = this.entryDir = 0; break;
      case 4: map.y = (map.y + 1) & 7; this.facing = this.entryDir = 2; break;
      case 5:
        if (map.z !== 0) {
          map.z--;
          this.entryDir = 4;
        } else {
          this.exitDungeon();
        }
        break;
      case 6:
        if (map.z !== 7) {
          map.z++;
          this.entryDir = 5;
        } else {
          this.exitDungeon();
        }
        break;
    }
  }

  /**
   * b32e: the original frees the tile set to make room for the wall and door pictures and loads it
   * again for fights; the port keeps everything in memory but follows the same flags, and reloads
   * the tile set where the original does, which also undoes the colour swap.
   */
  loadDungeonGraphics(resetMonster) {
    if (map.isOutdoors()) return;
    if (!(this.gfxFlags & 1)) {
      this.wallPic = loadPicture(pictures.dungeon(this.style));
      this.doorPic = loadPicture(pictures.dungeon(0));
    }
    this.gfxFlags = 1;
    if (resetMonster !== 0) {
      const m = map.objects.at(1);
      m.tile = m.tile2 = 0;
      m.x = m.y = 0xff;
      m.hull = 0xff;
    }
    gfx.setDrawColor(0);
    gfx.fillRect(0xb7, 0xb7, 8, 8);
    video.setDrawPage(1);
    gfx.fillRect(0xb7, 0xb7, 8, 8);
    video.setDrawPage(0);
  }

  /** b3c0 */
  unloadDungeonGraphics() {
    if (this.gfxFlags & 1) {
      if (map.objects.at(1).hull !== 0xff) dosFreeMem(this.monsterPic);
      this.monsterPic = 0;
      dosFreeMem(this.doorPic);
      dosFreeMem(this.wallPic);
    }
    if (!(this.gfxFlags & 2)) tiles.loadTileset(pictures.name(P.TILES));
    if (!(this.gfxFlags & 4)) tiles.patchTiles(0); // rooms get their own colours
    this.gfxFlags = 6;
  }

  /**
   * b40e: mode 3 a room; 0 a dungeon camp; 1 its ambush (monsters only); 2 a corridor fight. The
   * party starts on the squares for the side it enters from - assigned to combatants 0, 1, 2...
   * in order, so with a dead member the squares shift. Then up to 16 things (tile, x, y):
   * monsters, or objects (tiles below 0x40, fields, 0xB4-0xB7); tiles 0xEC-0xEF stand for one of
   * four random monster types drawn per fight. Chests get a level and gold an amount by dungeon
   * level. A cleared room (0xA0) has nothing in it.
   */
  async placeCombatants(mode, roomTile) {
    const m = view.localMap;
    if (mode !== 1) {
      let row = 4;
      if (this.facing === 0 || this.facing === 5) row = 3;
      else if (this.facing === 1) row = 2;
      else if (this.facing === 3) row = 1;
      await combat.clearCombatTables();
      for (let i = 0; i < party.size; i++) {
        combat.combatants[i].x = map.objects.at(i).x = m[row * 0x20 + 0x0b + i];
        combat.combatants[i].y = map.objects.at(i).y = m[row * 0x20 + 0x11 + i];
      }
    }
    if (!(mode > 0 && ((roomTile > 0xef && mode === 3) || mode < 3))) return;
    const randomTypes = [];
    for (let i = 0; i < 4; i++) randomTypes[i] = tableByte(T.RANDOM_MONSTERS + randomBetween(7, 0));
    for (let i = 0; i < 16; i++) {
      const tile = m[0xab + i];
      if (tile === 0) continue;
      let kind, type;
      if (tile < 0x40 || (tile & 0xfc) === 0xb4 || (tile & 0xfc) === 0xe8) {
        kind = 2;
        type = tile;
      } else {
        kind = 0;
        type = (tile - 0x40) >> 2;
      }
      if ((tile & 0xfc) === 0xec) type = randomTypes[tile & 3];
      const n = combat.addCombatant(map.z, m[0xeb + i], m[0xcb + i], kind, type);
      if (kind !== 2 || n < 0) continue;
      const o = map.objects.at(n & 0x1f);
      if (type === 1) o.hull = map.z * 3 + 7;
      else if (type === 2) o.hull = randomBetween(map.z * 10 + 10, 1);
      else if (type <= 0x0f) o.hull = tableByte(T.ROOM_OBJECT_BASE + type) + randomBetween(tableByte(T.ROOM_OBJECT_RANGE + type) - 1, 0);
    }
  }

  // ---- SJOG.OVL: Search, Jimmy, Open and Get in a dungeon ----

  /** bfaa: the next square that way. */
  stepInFacing(y, x, facing) {
    const spot = { x, y };
    if (facing === 0) spot.y--;
    else if (facing === 1) spot.x++;
    else if (facing === 2) spot.y++;
    else if (facing === 3) spot.x--;
    return spot;
  }

  /** bfec: up = ahead, left, right; down = the party's own square. null for Pass. */
  async askDungeonDirection(facing) {
    tw.printText(strings.get(S.Dir_84E6));
    let key;
    do {
      key = (await getCommandKey()) & 0xff;
      if (gameQuit()) key = 0x20;
    } while (key !== 0x20 && (key < 1 || key > 4));
    if (key === 0x20) {
      tw.printText(strings.get(S.Pass_84EC));
      return null;
    }
    if (key === 4) {
      tw.printText(strings.get(S.Here_84FA));
      return { x: map.x, y: map.y };
    }
    if (key === 1) {
      tw.printText(strings.get(S.Left_8508));
      facing = (facing + 3) % 4;
    } else if (key === 2) {
      tw.printText(strings.get(S.Right_8500));
      facing = (facing + 1) % 4;
    } else {
      tw.printText(strings.get(S.Ahead_84F2));
    }
    return this.stepInFacing(map.y, map.x, facing);
  }

  /**
   * c5c6: searching reveals hidden pits (0x61 -> 0x60, with the hole in the ceiling below),
   * disarms bomb traps on a roll of (2 x level - DEX + 30) / 2, opens secret doors (0xD0 -> 0xE0),
   * crumbles skeletons, and judges chest traps.
   */
  async dungeonSearch() {
    const member = await askWhichMember();
    if (member === -1) return;
    if (party.torchLight === 0 && party.lightSpell === 0) {
      tw.printText(strings.get(S.You_find_darkness_86DE));
      return;
    }
    const spot = await this.askDungeonDirection(this.facing);
    if (!spot) return;
    const i = this.at(map.z, spot.y, spot.x);
    const cell = this.grid[i], kind = cell & 0xf0;
    let need = ((map.z * 2 - party.member(member).dex + 0x1e) & 0xffff) >> 1;
    let text = S.NONE, changed = 0;
    tw.printText(strings.get(S.You_find_86F4));
    switch (kind) {
      case 0x00: text = S.Nothing_of_note_8700; break;
      case 0x10: case 0x20: case 0x30: text = S.Nothing_hidden_on_the_8712; break;
      case 0x40:
        if (need < randomBetween(0x1e, 1)) {
          if (cell === 0x40) {
            text = S.No_trap_8732;
            break;
          }
          need = map.z;
        } else {
          need = randomBetween(8, 1);
        }
        text = need < 4 ? S.A_simple_trap_873C : need < 7 ? S.A_trap_875C : S.A_complex_trap_874C;
        break;
      case 0x50: text = S.Nothing_hidden_on_the_8764; break;
      case 0x60:
        if (cell === 0x60) {
          text = S.Nothing_hidden_in_the_8786;
        } else if (cell === 0x61) {
          tw.printText(strings.get(S.A_pit_87A2));
          this.grid[i] = 0x60;
          if (map.z < 7) this.setCell(map.z + 1, spot.y, spot.x, this.cell(map.z + 1, spot.y, spot.x) | 8);
          changed = 1;
        } else if (cell === 0x62) {
          if (need < randomBetween(0x1e, 1)) {
            tw.printText(strings.get(S.A_bomb_trap_87AA));
            this.grid[i] &= 8;
          } else {
            text = S.Nothing_of_note_87B8;
          }
        }
        break;
      case 0x70: text = S.Treasure_87CA; break;
      case 0x80: {
        const fields = [S.A_sleep_field_87D6, S.A_poison_gas_field_87E6, S.A_wall_of_fire_87FC, S.An_electric_field_880E, S.An_energy_field_8822];
        text = fields[cell - 0x80 < 4 ? cell - 0x80 : 4];
        break;
      }
      case 0x90: text = S.This_tile_is_impossible_8834; break;
      case 0xa0: text = S.Nothing_hidden_on_the_884E; break;
      case 0xb0: text = S.Nothing_hidden_on_the_886C; break;
      case 0xc0:
        if ((this.style & 0x0f) === 1) text = S.Nothing_on_the_88AC;
        else if ((this.style & 0x0f) === 2) text = S.Nothing_in_the_caved_in_888A;
        else {
          tw.printText(strings.get(S.Nothing_hidden_on_the_88C8));
          tw.printText(strings.get(S.It_crumbles_away_88EA));
          this.grid[i] = (cell & 8) + 0xb0;
          changed = 1;
        }
        break;
      case 0xd0:
        tw.printText(strings.get(S.A_hidden_door_88FE));
        this.grid[i] = (cell & 8) + 0xe0;
        changed = 1;
        break;
      case 0xe0: case 0xf0: text = S.Nothing_hidden_on_the_890E; break;
    }
    if (text !== S.NONE) tw.printText(strings.get(text));
    if (changed) {
      this.drawDungeonView(1);
      await copyBackRect(0xb7, 0xb7, 8, 8);
    }
  }

  /** cbbe: a locked chest opens on the same roll; the key breaks otherwise, and always on a chest that isn't locked. */
  async dungeonJimmy() {
    tw.printText(strings.get(S.NL_8A7A));
    const member = await askWhichMember();
    if (member === -1) return;
    const cell = this.here();
    if ((cell & 0xf0) === 0x70) {
      tw.printText(strings.get(S.Already_open_8AB8));
    } else if ((cell & 0xf0) !== 0x40) {
      tw.printText(strings.get(S.What_8AC8));
    } else if (party.keys === 0) {
      tw.printText(strings.get((cell & 0xf7) === 0x40 ? S.No_keys_8A7C : S.No_keys_8A92));
    } else if ((cell & 0xf7) !== 0x40 && ((map.z * 2 - party.member(member).dex + 0x1e) & 0xffff) >> 1 < randomBetween(0x1e, 1)) {
      tw.printText(strings.get(S.Chest_unlocked_8A9C));
      this.setHere((cell & 8) + 0x40);
    } else {
      tw.printText(strings.get((cell & 0xf7) === 0x40 ? S.Key_broke_8A86 : S.Key_broke_8AAC));
      party.keys--;
    }
  }

  /** d254 */
  async dungeonOpenChest() {
    const cell = this.here();
    if ((cell & 0xf0) === 0x40) {
      const member = await askWhichMember();
      if (member === -1) return;
      if (cell & 7) await springTrap(member);
      this.setHere((cell & 8) + 0x70);
      tw.printText(strings.get(S.Chest_opened_8B96));
    } else if ((cell & 0xf0) === 0x70) {
      tw.printText(strings.get(S.Already_Open_8BA6));
    } else {
      tw.printText(strings.get(S.What_8BB6));
    }
  }

  /**
   * d71e: an open chest is emptied: seven kinds of thing, each if a roll of 1 to 4 x level + 4
   * reaches its threshold; gold 1 to 8 x level, potions and scrolls of a random type.
   */
  dungeonGet() {
    tw.printText(strings.get(S.Get_8DA4));
    const kind = this.here() & 0xf0;
    if (kind === 0x40) {
      tw.printText(strings.get(S.Must_open_first_8DAA));
      return;
    }
    if (kind !== 0x70) {
      tw.printText(strings.get(S.Not_here_8DDA));
      return;
    }
    this.setHere(this.here() & 8);
    tw.printText(strings.get(S.contents_of_chest_You_8DBC));
    for (let i = 0; i < 7; i++) {
      if (tableByte(T.CHEST_LEVEL + i) > randomBetween(map.z * 4 + 4, 1)) continue;
      if (i === 5) getItem(0x20, randomBetween(7, 0), 3);
      else if (i === 6) getItem(0x20, randomBetween(7, 0), 4);
      else getItem(0x20, randomBetween(i === 1 ? map.z << 3 : tableByte(T.CHEST_AMOUNT + i), 1), tableByte(T.CHEST_KIND + i));
    }
  }
}

// a step that way, by facing (0 north, 1 east, 2 south, 3 west)
Dungeon.facingDx = data.words(0x24d6, new Int16Array(4), 'dungeon.facingDx');
Dungeon.facingDy = data.words(0x24de, new Int16Array(4), 'dungeon.facingDy');

export const dungeon = new Dungeon();
