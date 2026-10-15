// map.js - where the party is and the map around it, as the Map class; `map` is the one object.
// Ported from the C++ port's map.h, map.cpp and map_places.cpp.
//
//   - the party's square (x, y, z) and the map in memory, with the loaders that fill it.
//     Coordinates are absolute map coordinates (outdoors 0-255, towns 0-31);
//   - which place this is: the game's location number (Map ids below);
//   - the read-only tables about places, from DATA.OVL.
// The square, the place and the changes to the map are part of the saved game.
import { data, SHARED } from './data/gamedata.js';
import { S, strings } from './data/strings.js';
import { loadFilePart, saveFilePart } from './files.js';
import { gameTime } from './gametime.js';
import { subByteFloor0, randomBetween } from './misc.js';
import { party } from './party.js';
import { savegame, SaveGame } from './savegame.js';
import { structView } from './struct.js';
import { sound } from './sound.js';
import { status } from './status.js';
import { tiles } from './tiles.js';
import { outdoor } from './outdoor.js';
import { town } from './town.js';
import { view } from './view.js';
import { clearLocationLabel, drawSkyBar, setWindDirection } from './world.js';

/** A thing on the map: 8 bytes, as in SAVED.GAM and the .OOL files. */
export const MapObject = structView({
  tile: [0, 'u8'], // 0 = an empty slot
  tile2: [1, 'u8'], // the tile shown (animated)
  x: [2, 'u8'],
  y: [3, 'u8'],
  z: [4, 'u8'],
  hull: [5, 'u8'], // a ship's hull; hit points; ...
  flags: [6, 'u8'],
  skiffs: [7, 'u8'],
});

/** The things on the map: 32 slots, 0 the party. The 0x100 bytes the .OOL files hold. */
export class MapObjects {
  static COUNT = 32;
  constructor() {
    this.bytes = new Uint8Array(MapObjects.COUNT * 8);
    this.items = Array.from({ length: MapObjects.COUNT }, (_, i) => new MapObject(this.bytes, i * 8));
    this.spare = new MapObject(new Uint8Array(8)); // what an index past the table gives
  }
  at(i) {
    return i >= 0 && i < MapObjects.COUNT ? this.items[i] : this.spare;
  }
}

export const M = Object.freeze({
  BRITANNIA: 0x00,
  MOONGLOW: 0x01, BRITAIN: 0x02, JHELOM: 0x03, YEW: 0x04, MINOC: 0x05, TRINSIC: 0x06, SKARA_BRAE: 0x07, NEW_MAGINCIA: 0x08,
  FOGSBANE: 0x09, STORMCROW: 0x0a, GREYHAVEN: 0x0b, WAVEGUIDE: 0x0c, IOLOS_HUT: 0x0d, SUTEKS_HUT: 0x0e, SIN_VRAALS_HUT: 0x0f, GRENDELS_HUT: 0x10,
  LORD_BRITISHS_CASTLE: 0x11, PALACE_OF_BLACKTHORN: 0x12, WEST_BRITANNY: 0x13, NORTH_BRITANNY: 0x14, EAST_BRITANNY: 0x15,
  PAWS: 0x16, COVE: 0x17, BUCCANEERS_DEN: 0x18,
  ARARAT: 0x19, BORDERMARCH: 0x1a, FARTHING: 0x1b, WINDEMERE: 0x1c, STONEGATE: 0x1d, LYCAEUM: 0x1e, EMPATH_ABBEY: 0x1f, SERPENTS_HOLD: 0x20,
  DECEIT: 0x21, DESPISE: 0x22, DESTARD: 0x23, WRONG: 0x24, COVETOUS: 0x25, SHAME: 0x26, HYTHLOTH: 0x27, DOOM: 0x28,
  TITLE: 0x40, TITLE_MENU: 0x41, DEMO: 0x42,
  SCENE: 0xff, // a scene on its own small map (view.localMap): combat, a dungeon room, a shrine
});

const NAMES = 0x28;
const NPC_FILES = [S.towne_npc_6D46, S.dwelling_npc_6D50, S.castle_npc_6D5E, S.keep_npc_6D6A]; // picked in code by the original

export class GameMap {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.z = 0; // 0 the surface, 0xFF the Underworld; a building's or dungeon's level
    // Outdoors a 32 x 32 window of Britannia at the origin as four 16 x 16 chunks (slots 0 1 / 2 3);
    // in a settlement the 32 x 32 level.
    this.buffer = new Uint8Array(1024);
    this.originX = 0;
    this.originY = 0;
    this.dungeonSeals = new Uint8Array(8);
    this.shrineState = new Uint8Array(8);
    this.openDoorTile = 0;
    this.openDoorX = 0;
    this.openDoorY = 0;
    this.openDoorTimer = 0;
    this.objects = new MapObjects();
    this.objectsBackup = new Uint8Array(0x100);
    this.windDirection = 0; // 0 calm, 1 north, 2 south, 3 east, 4 west
    this.beam1X = 0xffff; this.beam1Y = 0xffff;
    this.beam2X = 0xffff; this.beam2Y = 0xffff;
    this.beamFrame = 0xff;
    this.shadowlordLocations = new Uint8Array(3);
    this.searchFoundBits = new Uint8Array(15);
    this.savedLocation = 0;
    this.moonstoneX = new Uint8Array(8);
    this.moonstoneY = new Uint8Array(8);
    this.moonstoneZ = new Uint8Array(8);
    this.moonstoneLoc = new Uint8Array(8);
    this.id = M.BRITANNIA;

    const s = savegame;
    s.u8(0x5893, this, 'id', 'map.id');
    s.u8(0x5892, this, 'windDirection', 'map.windDirection');
    for (const [off, key] of [[0x5895, 'z'], [0x5896, 'x'], [0x5897, 'y'], [0x589b, 'originX'], [0x589c, 'originY'],
      [0x594f, 'openDoorTile'], [0x5950, 'openDoorX'], [0x5951, 'openDoorY'], [0x5952, 'openDoorTimer']]) {
      s.u8(off, this, key, `map.${key}`);
    }
    s.bytes(0x5830, this.moonstoneX, 'map.moonstoneX');
    s.bytes(0x5838, this.moonstoneY, 'map.moonstoneY');
    s.bytes(0x5840, this.moonstoneLoc, 'map.moonstoneLoc');
    s.bytes(0x5848, this.moonstoneZ, 'map.moonstoneZ');
    s.bytes(0x585c, this.searchFoundBits, 'map.searchFoundBits');
    s.bytes(0x58c8, this.shadowlordLocations, 'map.shadowlordLocations');
    s.bytes(0x58d0, this.dungeonSeals, 'map.dungeonSeals');
    s.bytes(0x58d8, this.shrineState, 'map.shrineState');
    s.bytes(0x5c5a, this.objects.bytes, 'map.objects');

    // Read-only tables, from DATA.OVL. The byte tables are read with any byte as the index, so each
    // is the 256 bytes from its start.
    const d = data;
    this.shadowlordRows = d.bytes(0x13a5, new Uint8Array(256), 'map.shadowlordRow', SHARED);
    this.levelIndexes = d.bytes(0x1e19, new Uint8Array(256), 'map.levelIndex', SHARED);
    this.names = d.words(0x1e3a, new Array(NAMES).fill(0), 'map.names', SHARED);
    this.exitXs = d.bytes(0x1e89, new Uint8Array(256), 'map.exitX', SHARED);
    this.exitYs = d.bytes(0x1eb1, new Uint8Array(256), 'map.exitY', SHARED);
    this.virtueNames = d.words(0x1f4e, new Array(8).fill(0), 'map.virtueNames');
    this.mantras = d.words(0x1f5e, new Array(8).fill(0), 'map.mantras');
    this.shrineXs = d.bytes(0x1f6e, new Uint8Array(8), 'map.shrineX');
    this.shrineYs = d.bytes(0x1f76, new Uint8Array(8), 'map.shrineY');
    this.beamShapes = d.bytes(0x1f7e, new Int8Array(16 * 16 * 2), 'map.beamShapes'); // 16 shapes of 16 (dx, dy)
    this.datFiles = d.words(0x2652, new Array(4).fill(0), 'map.datFiles');
    this.entranceChunks = d.bytes(0x3866, new Uint8Array(8), 'map.entranceChunks');
    this.shrineChunks = d.bytes(0x386e, new Uint8Array(8), 'map.shrineChunks');
    this.britChunks = d.bytes(0x3876, new Uint8Array(256), 'map.britChunk'); // where each chunk is in BRIT.DAT; 0xFF sea
    this.wordsOfPower = d.words(0x4502, new Array(8).fill(0), 'map.wordsOfPower');
    this.sealTiles = d.bytes(0x4512, new Uint8Array(8), 'map.sealTiles');
    this.tlkFiles = d.words(0x4aa0, new Array(4).fill(0), 'map.tlkFiles');
  }

  // ---- which place this is ----
  isOutdoors() { return this.id === M.BRITANNIA; }
  isTown() { return this.id >= M.MOONGLOW && this.id <= M.SERPENTS_HOLD; }
  isDungeon() { return this.id >= M.DECEIT && this.id <= M.DOOM; }
  onTileMap() { return this.id <= M.SERPENTS_HOLD; }
  inScene() { return this.id >= 0x80; }
  /** A settlement's data files: 0 TOWNE, 1 DWELLING, 2 CASTLE, 3 KEEP. */
  kind() { return ((this.id - 1) >> 3) >>> 0; }

  exitX(id = this.id) { return this.exitXs[id]; }
  exitY(id = this.id) { return this.exitYs[id]; }
  name(id) { return strings.get(id >= 1 && id <= NAMES ? this.names[id - 1] : S.NONE); }
  levelIndex() { return this.levelIndexes[this.id]; }
  datFile() { return strings.get(this.kind() < 4 ? this.datFiles[this.kind()] : S.NONE); }
  tlkFile() { return strings.get(this.kind() < 4 ? this.tlkFiles[this.kind()] : S.NONE); }
  npcFile() { return strings.get(NPC_FILES[this.kind() & 3]); }
  shadowlordRow() { return this.shadowlordRows[this.id]; }

  // ---- the map in memory ----

  /**
   * 4402 (get_map_tile_ptr): where map square (y, x) is, as [array, index]. Outside a settlement's
   * level it is the level's last square; in a scene the map is the scene's own (view.localMap).
   */
  tileRef(y, x) {
    if (this.inScene()) return [view.localMap, (((y * 0x20 + x) & 0xffff) % 0x400)];
    if (this.isOutdoors()) {
      x = (x - this.originX) & 0x1f;
      y = (y - this.originY) & 0x1f;
      let slot = 0;
      if (y > 0x0f) { slot = 2; y -= 0x10; }
      if (x > 0x0f) { slot++; x -= 0x10; }
      return [this.buffer, slot * 0x100 + y * 0x10 + x];
    }
    if (x < 0 || y < 0 || x > 0x1f || y > 0x1f) return [this.buffer, 0x3ff];
    return [this.buffer, y * 0x20 + x];
  }
  getTile(y, x) {
    const [a, i] = this.tileRef(y, x);
    return a[i];
  }
  setTile(y, x, t) {
    const [a, i] = this.tileRef(y, x);
    a[i] = t;
  }

  /** a290: chunk numbers of the dungeon entrances; sealed unless the matching seal byte is 0. */
  dungeonEntranceSealed(chunk) {
    for (let i = 0; i < 8; i++) if (this.entranceChunks[i] === chunk >> 8) return this.dungeonSeals[i] === 0;
    return true;
  }
  /** a2da */
  shrineDestroyed(chunk) {
    for (let i = 0; i < 8; i++) if (this.shrineChunks[i] === chunk >> 8) return this.shrineState[i] > 0x7f;
    return false;
  }

  /** a328: chunk = (chunk number << 8), also the offset in UNDER.DAT. BRIT.DAT holds only some. */
  loadOutdoorChunk(chunk, slot, filename) {
    let offset;
    if (filename[0] === 'B') {
      const index = this.britChunks[(chunk >> 8) & 0xff];
      if (index === 0xff) {
        this.buffer.fill(1, slot * 0x100, slot * 0x100 + 0x100);
        return;
      }
      offset = index << 8;
    } else {
      offset = chunk;
    }
    loadFilePart(offset, 0x100, this.buffer.subarray(slot * 0x100, slot * 0x100 + 0x100), filename);
    const cx = (chunk >> 4) & 0xf0, cy = (chunk >> 8) & 0xf0;
    for (let y = 0; y < 0x10; y++)
      for (let x = 0; x < 0x10; x++) {
        const t = this.buffer[slot * 0x100 + y * 0x10 + x];
        if (t <= 0x15) continue;
        if (t < 0x19) {
          if (this.dungeonEntranceSealed(chunk)) this.setTile(y + cy, x + cx, 0xdf);
        } else if (t === 0x19 && this.shrineDestroyed(chunk)) {
          this.setTile(y + cy, x + cx, 0x1a);
        }
      }
  }

  /** a444: the chunks on the side moved to (dy, dx); (1,0) then (-1,0) loads all four. */
  loadOutdoorChunks(dy, dx) {
    const chunk = (this.originX * 0x10 + this.originY * 0x100) & 0xffff;
    const right = this.originX === 0xf0 ? -0xf00 : 0x100; // wraps east to west
    const file = strings.get(this.z < 0x80 ? S.BRIT_DAT_3980 : S.UNDER_DAT_3976);
    if (dx === -1 || dy === -1) this.loadOutdoorChunk(chunk, 0, file);
    if (dx === 1 || dy === -1) this.loadOutdoorChunk((chunk + right) & 0xffff, 1, file);
    if (dx === -1 || dy === 1) this.loadOutdoorChunk((chunk + 0x1000) & 0xffff, 2, file);
    if (dx === 1 || dy === 1) this.loadOutdoorChunk((chunk + right + 0x1000) & 0xffff, 3, file);
    const off = this.buffer.indexOf(0x1b); // the lighthouse light, for the beams
    if (off < 0) {
      this.beam1X = this.beam1Y = 0xffff;
    } else {
      this.beam1X = (off & 0x0f) + (off & 0x100 ? 0x10 : 0);
      this.beam1Y = ((off >> 4) & 0x0f) + (off & 0x200 ? 0x10 : 0);
    }
  }

  /** a558: keeps the two chunks that stay in the window, moving them to their new slots. */
  shiftOutdoorChunks(dy, dx) {
    const to = dx < 0 || dy < 0 ? 3 : 0;
    const from = dx < 0 || dy > 0 ? 2 : 1;
    this.buffer.copyWithin(to * 0x100, from * 0x100, from * 0x100 + 0x100);
    const a = (to + dy + dx * 2) * 0x100, b = (from + dy + dx * 2) * 0x100;
    this.buffer.copyWithin(a, b, b + 0x100);
  }

  /** 81d0 (the map's part): the window around the party, the light map, the labels. */
  enterOutdoors() {
    clearLocationLabel();
    passTime(0);
    view.rebuild = true;
    party.needPrompt = 1;
    view.worldTickEnabled = 1;
    party.sailDirection = 0;
    this.originX = this.x & 0xf0;
    if ((this.x & 0x0f) < 8) this.originX = (this.originX - 0x10) & 0xff;
    this.originY = this.y & 0xf0;
    if ((this.y & 0x0f) < 8) this.originY = (this.originY - 0x10) & 0xff;
    this.loadOutdoorChunks(1, 0);
    this.loadOutdoorChunks(-1, 0);
    passTime(0);
    view.updateLightMap();
    setWindDirection(-1);
    drawSkyBar();
    outdoor.placeUnderworldSpecials();
  }

  /** 8524: moves the party; near the window's edge, scrolls it by a chunk. */
  outdoorStep(dy, dx) {
    this.x = (this.x + dx) & 0xff;
    this.y = (this.y + dy) & 0xff;
    view.rebuild = true;
    const rx = (this.x - this.originX) & 0x1f, ry = (this.y - this.originY) & 0x1f;
    if (rx < 5 || rx > 0x1a || ry < 5 || ry > 0x1a) {
      this.shiftOutdoorChunks(dy, dx);
      this.originX = (dx * 0x10 + this.originX) & 0xf0;
      this.originY = (dy * 0x10 + this.originY) & 0xf0;
      this.loadOutdoorChunks(dy, dx);
      view.updateLightMap();
    }
  }

  /** 85d8: the settlement's level from its .DAT file, its lamps and lights. */
  loadTownLevel(placeNpcsToo) {
    clearLocationLabel();
    drawSkyBar();
    setWindDirection(-1);
    this.openDoorTile = 0;
    this.originY = 0;
    this.originX = 0;
    let level = this.levelIndex() + this.z;
    if (this.z > 0x7f) level -= 0x100;
    loadFilePart(level << 10, 0x400, this.buffer, this.datFile());
    town.lampCount = 0;
    this.beam1X = this.beam1Y = this.beam2X = this.beam2Y = 0xffff;
    for (let x = 0; x < 0x20; x++)
      for (let y = 0; y < 0x20; y++) {
        const t = this.getTile(y, x);
        if ((t & 0xfe) === 0x48 && town.lampCount < 32) {
          town.lampX[town.lampCount] = x;
          town.lampY[town.lampCount] = y;
          town.lampTile[town.lampCount] = t;
          town.lampCount++;
        }
        if (t === 0x2a) { // the first two 0x2A tiles get light beams
          if (this.beam1X === 0xffff) { this.beam1X = x; this.beam1Y = y; }
          else { this.beam2X = x; this.beam2Y = y; }
        }
      }
    if (gameTime.hour < 5 || gameTime.hour > 0x13) town.updateLamps();
    view.updateLightMap();
    passTime(0);
    town.shadowlordBlight();
    if (placeNpcsToo) town.placeNpcs();
    view.rebuild = true;
  }
}

export const map = new GameMap();

/** A saved game (SAVED.GAM, INIT.GAM) in the game's files. 0 on success; a short file changes nothing. */
export function loadGameFile(filename) {
  const image = new Uint8Array(SaveGame.SIZE);
  const r = loadFilePart(0, SaveGame.SIZE, image, filename);
  if (r === 0) savegame.unpack(image);
  return r;
}

export function saveGameFile(filename) {
  return saveFilePart(SaveGame.SIZE, savegame.pack(), filename);
}

/** From passTime: the light radius by the time and place, a light spell or a torch. */
export function updateLightRadius() {
  const old = view.lightRadius;
  if (view.lightRadius > 0x32) return;
  if (map.id === M.ARARAT || map.z > 0x7f || gameTime.hour < 5 || gameTime.hour > 0x13) view.lightRadius = 2;
  else if (gameTime.hour === 5) view.lightRadius = view.dawnRadius(Math.trunc(gameTime.minute / 10));
  else if (gameTime.hour === 0x13) view.lightRadius = view.dawnRadius(Math.trunc((0x3b - gameTime.minute) / 10));
  else view.lightRadius = 0x32;
  if (party.lightSpell && view.lightRadius < 0x12) view.lightRadius = 0x12;
  if (party.torchLight && view.lightRadius < 10) view.lightRadius = 10;
  if (old !== view.lightRadius) view.rebuild = true;
}

/** 4f7c: the clock, torch and light spell, the Shadowlords' daily moves, the calendar, the light. */
export function passTime(minutes) {
  if (minutes !== 0) {
    if (party.activeSpell === 0x51 && (minutes >>= 1) === 0) minutes = 1; // 'Q' quickness
    gameTime.prevHour = gameTime.hour;
    if (party.activeSpell !== 0x54) { // 'T' time stop
      gameTime.minute = (gameTime.minute + minutes) & 0xff;
      subByteFloor0(minutes & 0xff, party, 'torchLight');
      subByteFloor0(minutes & 0xff, party, 'lightSpell');
    }
    if (gameTime.minute > 0x3b) {
      gameTime.minute -= 0x3c;
      subByteFloor0(1, gameTime, 'restCooldown');
      if (++gameTime.hour > 0x17) {
        gameTime.hour = 0;
        for (let i = 0; i < 3; i++) { // each Shadowlord still about moves to another town 1-8
          if (map.shadowlordLocations[i] >= 0x80) continue;
          let t;
          do {
            t = randomBetween(8, 1);
            if (map.id === t) t = 0;
            for (let j = 0; j < 3; j++) if (map.shadowlordLocations[j] === t) t = 0;
          } while (t === 0);
          map.shadowlordLocations[i] = t;
        }
        if (++gameTime.day > 0x1c) {
          gameTime.reagentSpotDay.fill(0);
          gameTime.hiddenItemDay = 0;
          gameTime.day = 1;
          gameTime.noAmbush = 0;
          for (let m = 0; m < 16; m++) if (party.member(m).innMonths < 0x19) party.member(m).innMonths++;
          if (++gameTime.month > 0x0d) {
            gameTime.month = 1;
            gameTime.year = (gameTime.year + 1) & 0xffff;
          }
        }
        status.drawStatusBar();
      }
    }
  }
  updateLightRadius();
  if (gameTime.hour !== gameTime.prevHour) {
    drawSkyBar();
    sound.ambientCooldown = gameTime.hour === 0 ? 0x0c : gameTime.hour > 0x0c ? gameTime.hour - 0x0c : gameTime.hour; // the strokes to strike
  }
  if (map.isTown()) tiles.patchTilesC(gameTime.hour, gameTime.minute);
}
