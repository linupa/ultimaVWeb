// outdoor.js - Britannia and the Underworld (MAINOUT.OVL and the rest of OUTSUBS.OVL), as the
// Outdoor class; `outdoor` is the one object. Ported from the C++ port's outdoor.cpp.
import { askDirection, enterTownFromMap, getCommandKey, tilePassable, toUpper, waitTurns } from './commands.js';
import { cmdSetActivePlayer, dispatchCommand } from './game.js';
import { data } from './data/gamedata.js';
import { S, strings } from './data/strings.js';
import { dissolveTile, flashSquare, screenShake, strIndex } from './effects.js';
import { gfx } from './gfx.js';
import { textBuffer } from './textbuf.js';
import { exitGame, gameQuit } from './gamestate.js';
import { gameTime } from './gametime.js';
import { input } from './input.js';
import { combat } from './combat.js';
import { dungeon } from './dungeon.js';
import { partyDeath } from './endings.js';
import { visitShrine } from './shrine.js';
import { M, map, passTime } from './map.js';
import { addByteCapped, randomBetween } from './misc.js';
import { allocObjectSlot, findObjectAt, objectTileAt, setObjectEntry } from './objects.js';
import { party } from './party.js';
import { saveFilePart, loadFilePart } from './files.js';
import { sound } from './sound.js';
import { status } from './status.js';
import { textWindows as tw } from './text.js';
import { town } from './town.js';
import { view } from './view.js';
import { checkMoongate, damageMember, damageParty, objectsFileName, perTurnStatus, randomStatRoll } from './world.js';

const mask = (row, col) => view.mask[row * 0x20 + col];

/** Pirate ships and monsters 0x80 and up, except 0xB4-0xB7 and 0xE8-0xEB. */
export function isActiveMonsterTile(tile) {
  if ((tile < 0x2c || tile > 0x2f) && (tile < 0x80 || (tile > 0xb3 && tile < 0xb8) || (tile > 0xe7 && tile < 0xec))) return false;
  return true;
}

const wrapDistance = (a, b) => {
  const d = Math.abs(a - b);
  return d > 0x7f ? 0x100 - d : d;
};

export class Outdoor {
  constructor() {
    // Turns the monsters sit out: each flips every turn.
    this.quicknessToggle = 0;
    this.ridingToggle = 0;
    this.capeSpeedToggle = 0;
    // The square the last monster to move came from: monsterStep won't take it straight back.
    this.lastMonsterX = 0;
    this.lastMonsterY = 0;
    // Read-only tables, from DATA.OVL.
    const d = data;
    this.windDx = d.bytes(0x29f6, new Int8Array(4), 'outdoor.windDx'); // the way wind 1-4 blows
    this.windDy = d.bytes(0x29fa, new Int8Array(4), 'outdoor.windDy');
    this.landMonsters = d.bytes(0x2bc0, new Uint8Array(12), 'outdoor.landMonsters');
    this.underLandMonsters = d.bytes(0x2bcc, new Uint8Array(8), 'outdoor.underLandMonsters');
    this.seaMonsters = d.bytes(0x2bd4, new Uint8Array(6), 'outdoor.seaMonsters');
    this.underSeaMonsters = d.bytes(0x2bda, new Uint8Array(2), 'outdoor.underSeaMonsters');
    this.landChances = d.bytes(0x2bdc, new Uint8Array(12), 'outdoor.landChances');
    this.underLandChances = d.bytes(0x2be8, new Uint8Array(8), 'outdoor.underLandChances');
    this.seaChances = d.bytes(0x2bf0, new Uint8Array(6), 'outdoor.seaChances');
    this.underSeaChances = d.bytes(0x2bf6, new Uint8Array(2), 'outdoor.underSeaChances');
    // How many turns a pirate ship (0x2C-0x2F, by heading) waits in wind 1-4; 4 = never moves
    // (ds:2BF8; the original reaches it as ds:2BF6 + wind * 2).
    this.pirateWait = d.words(0x2bf8, new Uint16Array(16), 'outdoor.pirateWait');
    this.chaseWeight = d.bytes(0x2c18, new Uint8Array(61), 'outdoor.chaseWeight'); // distance x + 11 * distance y
    this.shadowlordX = d.bytes(0x3a06, new Uint8Array(3), 'outdoor.shadowlordX'); // their shards in the Underworld
    this.shadowlordY = d.bytes(0x3a0a, new Uint8Array(3), 'outdoor.shadowlordY');
    this.shadowlordHull = d.bytes(0x3a0e, new Uint8Array(3), 'outdoor.shadowlordHull');
    this.apparitionTune = d.words(0x3a26, new Uint16Array(6), 'outdoor.apparitionTune');
  }

  /** 824a */
  async waitIfObject1Near() {
    const o = map.objects.at(1);
    if (o.tile !== 0 && o.z === map.z && Math.abs(map.x - o.x) < 6 && Math.abs(map.y - o.y) < 6) await waitTurns(1);
  }

  /**
   * 82aa: horses and carpets only face east and west. A ship turns first: unless it already heads
   * that way the move is used up (returns 1); with sails up and no wind it doesn't move either.
   */
  outdoorSetFacing(dir) {
    const kind = party.transport & 0xfc;
    if (kind === 0x10) {
      tw.printText(strings.get(S.Ride_2946));
      if (dir === 1) party.transport = 0x12;
      else if (dir === 3) party.transport = 0x13;
      return 0;
    }
    if (kind === 0x14) {
      tw.printText(strings.get(S.Fly_294C));
      if (dir === 1) party.transport = 0x14;
      else if (dir === 3) party.transport = 0x15;
      return 0;
    }
    if (kind !== 0x20 && kind !== 0x24) {
      if (kind !== 0x28) return 0;
      tw.printText(strings.get(S.Row_2951));
      party.transport = dir + (party.transport & 0xfc);
      return 0;
    }
    const heading = dir + (party.transport & 0xfc);
    if (party.transport === heading) {
      if (heading > 0x23) return 0;
      if (map.windDirection !== 0) return 0;
      return 1;
    }
    party.transport = heading;
    tw.printText(strings.get(S.Head_2956));
    const names = [S.North_295C, S.East_296A, S.South_2963, S.West_2970];
    if (dir >= 0 && dir <= 3) tw.printText(strings.get(names[dir]));
    party.needPrompt = 1;
    if (map.objects.at(0).hull < 0x32) tw.printText(strings.get(S.Hull_weak_2976));
    return 1;
  }

  /** 83ce: an object blocks, except things one can board; under sail a blocked move is a collision. */
  async outdoorCanMove(dy, dx) {
    if ((party.transport & 0xfc) === 0x24) tw.printText(strings.get(S.Rowing_2982));
    let ok = true;
    const obj = findObjectAt(map.z, dy + map.y, dx + map.x).tile;
    if (obj !== 0) {
      ok = false;
      if (party.transport < 0x30 && party.transport > 0x1f) {
        if (party.transport > 0x27 && obj > 0x23 && obj < 0x28) ok = true;
      } else if ((obj > 0x23 && obj < 0x2c) || obj === 0x1b || (obj & 0xfe) === 0x10) {
        ok = true;
      }
    }
    const tile = mask(5 + dy, 5 + dx);
    if (ok && tilePassable(tile, party.transport)) return 1;
    if (party.sailDirection === 0) {
      if (party.transport > 0x1f && (obj & 0xfc) === 0xec) return 0; // a whirlpool
      tw.printText(strings.get(S.Blocked_29AE));
      if (tile === 0x2f) { // a cactus
        tw.printText(strings.get(S.OUCH_29B8));
        await damageParty();
      } else {
        await sound.beep(200, 0xa5);
      }
      input.flushKeyboard();
      return 0;
    }
    if (tile === 3) tw.printText(strings.get(S.BREAKING_UP_298B)); // shoals
    else if (tile !== 0x47) tw.printText(strings.get(S.COLLISION_2999));
    if (tile === 0x47) { // a pier
      tw.printText(strings.get(S.Docked_29A5));
      party.transport += 4; // sails furled
    } else {
      await sound.soundNoise(300, 2000, 100);
      await this.damageVehicle();
    }
    party.needPrompt = 1;
    party.sailDirection = 0;
    return 0;
  }

  /** 85b0: swamp, scrub and hills cost a monster turn and 2 minutes more; forest and mountains two and 4. */
  async terrainSlowdown() {
    const t = map.getTile(map.y, map.x);
    let slow;
    if (t === 5) slow = 0;
    else if (t === 0x1e || t === 0x1f) slow = 1;
    else if (t < 4 || t > 0x0f) slow = 0;
    else slow = t > 8 ? 2 : 1;
    if (slow === 1) {
      const acted = await this.outdoorMonstersTurn();
      await this.waitIfObject1Near();
      if (acted === 0) tw.printText(strings.get(S.Slow_progress_29BF));
      passTime(2);
    } else if (slow === 2) {
      let acted = await this.outdoorMonstersTurn();
      await this.waitIfObject1Near();
      acted += await this.outdoorMonstersTurn();
      await this.waitIfObject1Near();
      if (acted === 0) tw.printText(strings.get(S.Very_slow_29CF));
      passTime(4);
    }
  }

  /** 8660: key 1-4 = W E N S; `fast` while on an unseen square, when the move is only announced. */
  async outdoorMove(fast, key) {
    if ((party.transport & 0xfc) === 0x20) { // under sail: the key sets the course
      if (key !== party.sailDirection) {
        party.sailDirection = key;
        party.sailCounter = 0;
      }
      party.needPrompt = 0;
    }
    if (party.transport === 0x1c || (party.transport & 0xfe) === 0x12) await sound.stepSound();
    const dxs = [0, -1, 1, 0, 0], dys = [0, 0, 0, -1, 1], facing = [0, 3, 1, 0, 2];
    const names = [S.NONE, S.West_29EF, S.East_29E9, S.North_29DB, S.South_29E2];
    let dx = 0, dy = 0;
    if (key >= 1 && key <= 4) {
      dx = dxs[key];
      dy = dys[key];
      const r = this.outdoorSetFacing(facing[key]);
      if (r !== 0) return r;
      if (party.sailDirection === 0) tw.printText(strings.get(names[key]));
    }
    const moved = await this.outdoorCanMove(dy, dx);
    if (fast === 0 && moved !== 0) {
      if ((party.transport & 0xfe) === 0x12) await sound.stepSound();
      map.outdoorStep(dy, dx);
      await this.terrainSlowdown();
    }
    return moved;
  }

  /**
   * 8768: under sail the ship moves by itself until another key is pressed. It waits 1 turn a move
   * running before the wind, 2 beating against it, none abeam. With the HMS Cape plans aboard a
   * turn takes 1 minute instead of 2 and the monsters move only every other turn.
   */
  async outdoorReadKey() {
    let key = 0;
    await view.worldTick();
    status.refresh();
    if ((mask(6, 5) & 0xfc) === 0xd4) { // a waterfall just south
      await this.waterfallFall();
      return 0;
    }
    if (party.needPrompt !== 0) {
      tw.putChar(0x0a);
      status.drawLabelLeft();
    }
    party.needPrompt = 1;
    while (party.sailDirection !== 0) {
      key = toUpper(await input.waitKeyCursor());
      if (key !== 0 && key !== party.sailDirection) break;
      key = party.sailDirection;
      if (map.windDirection !== 0) {
        const dx = key === 1 ? -1 : key === 2 ? 1 : 0, dy = key === 3 ? -1 : key === 4 ? 1 : 0;
        let wait = 1;
        if (this.windDx[(map.windDirection - 1) & 3] !== dx) wait = 2;
        if (this.windDy[(map.windDirection - 1) & 3] !== dy) wait++;
        if (wait % 3 <= party.sailCounter) {
          party.sailCounter = 0;
          break;
        }
      }
      let minutes = 2;
      if (party.hmsCapePlans >= 0x80) {
        this.capeSpeedToggle = this.capeSpeedToggle === 0 ? 1 : 0;
        minutes = 1;
      }
      passTime(minutes);
      if (this.capeSpeedToggle === 0 || party.hmsCapePlans < 0x80) await this.outdoorMonstersTurn();
      await waitTurns(1);
      party.sailCounter = (party.sailCounter + 1) & 0xff;
      if (gameQuit()) return 0;
    }
    if (party.sailDirection === 0) key = await getCommandKey();
    return key;
  }

  /** 88bc: not from a skiff or carpet over water. */
  async cmdAttackOutdoor() {
    tw.printText(strings.get(S.Attack_29FE));
    if (map.getTile(map.y, map.x) < 4 && ((party.transport & 0xfc) === 0x28 || (party.transport & 0xfe) === 0x14)) {
      tw.printText(strings.get(S.On_foot_2A06));
    } else {
      const dir = await askDirection();
      if (dir) {
        const found = findObjectAt(map.z, map.y + dir.dy, map.x + dir.dx);
        const t = found.tile & 0xfc;
        if (t === 0x2c || (t !== 0xb4 && t !== 0xe8 && t > 0x3f)) await combat.combatWithObject(found.slot);
        else tw.printText(strings.get(S.Nothing_to_attack_2A10));
      }
    }
    return 0;
  }

  /**
   * 8960: the dungeon entrances are entries 0x21-0x28 of the exit tables. Doom is guarded by the
   * Shadowlords while any is left. DUNGEON.DAT gives the dungeon's 8 levels; from Britannia the
   * party starts at the top, from the Underworld at the bottom.
   */
  async enterDungeon(prompt) {
    tw.printText(prompt);
    let i;
    for (i = 0x20; i < 0x28; i++) if (map.exitX(1 + i) === map.x && map.exitY(1 + i) === map.y) break;
    if (i >= 0x28) {
      tw.printText(strings.get(S.What_dungeon_2A5F));
      return 1;
    }
    if (party.transport !== 0x1c) {
      tw.printText(strings.get(S.On_foot_2A24));
      return 1;
    }
    if (i === 0x27) {
      if ((map.shadowlordLocations[0] & map.shadowlordLocations[1] & map.shadowlordLocations[2]) < 0x80) {
        tw.printText(strings.get(S.Attacked_at_entrance_2A2F));
        const slot = allocObjectSlot();
        map.objects.at(slot).tile = 0xfc;
        await combat.combatWithObject(slot);
        return slot;
      }
    } else {
      tw.printText(strings.get(S.NL_NL_2A47));
      tw.putChar(0xfc);
      tw.printText(map.name(i + 1));
      tw.putChar(0xfb);
    }
    tw.putChar(0x0a);
    saveFilePart(0x100, map.objects.bytes, objectsFileName());
    loadFilePart((i - 0x20) * 0x200, 0x200, dungeon.grid, strings.get(S.DUNGEON_DAT_2A53));
    map.id = i + 1;
    if (map.z === 0 || map.id === M.DOOM) {
      map.z = 0;
      map.x = map.y = 1;
      dungeon.facing = 1;
      dungeon.entryDir = 5;
    } else {
      map.z = 7;
      dungeon.facing = 3;
      dungeon.entryDir = 4;
      map.x = map.y = 7;
    }
    return 1;
  }

  /** 8aae: E outdoors. */
  async cmdEnter() {
    tw.printText(strings.get(S.Enter_2A6F));
    let what;
    switch (map.getTile(map.y, map.x)) {
      case 0x10: what = S.hut_2A85; break;
      case 0x11:
        tw.printText(strings.get(S.the_Shrine_of_the_Codex_2A89));
        await visitShrine();
        return 1;
      case 0x12: what = S.keep_2AA3; break;
      case 0x13: what = S.village_2AA8; break;
      case 0x14: what = S.towne_2AB0; break;
      case 0x15: what = S.castle_2AB6; break;
      case 0x16: return this.enterDungeon(strings.get(S.cave_2ABD));
      case 0x17: return this.enterDungeon(strings.get(S.mine_2AC2));
      case 0x18: return this.enterDungeon(strings.get(S.dungeon_2AC7));
      case 0x19: {
        tw.printText(strings.get(S.the_shrine_of_2A76));
        let i;
        for (i = 0; i < 8; i++) if (map.shrineXs[i] === map.x && map.shrineYs[i] === map.y) break;
        tw.printText(strings.get(map.virtueNames[i & 7]));
        tw.putChar(0x0a);
        await visitShrine();
        return 1;
      }
      case 0x1a:
        tw.printText(strings.get(S.ruins_2ACF));
        return 1;
      case 0x1b: what = S.lighthouse_2AD5; break;
      case 0x39: what = S.the_palace_of_Blackthorn_2AE0; break;
      case 0x3e: what = S.the_Castle_of_Lord_2AFA; break;
      default:
        tw.printText(strings.get(S.What_2B16));
        return 0;
    }
    return enterTownFromMap(strings.get(what));
  }

  /** 8bea: on a square the party can't see (0xFF) the view goes dark and moves are only announced. */
  async outdoorIdleCheck(ticked) {
    if (map.getTile(map.y, map.x) === 0xff && party.activeSpell !== 0x0e) {
      view.lightRadius = 0;
      if (ticked === 0) {
        await view.worldTick();
        ticked = 1;
      }
    } else {
      ticked = 0;
      passTime(0);
    }
    return ticked;
  }

  /** 8c30 */
  async randomEarthquake() {
    if (map.z !== 0 && randomBetween(0xff, 0) === 0x69) {
      tw.printText(strings.get(S.EARTHQUAKE_2B1D));
      await screenShake();
      await damageParty();
    }
  }

  /** 8c54: the outdoor loop, until the party enters somewhere (or the game ends). */
  async outdoorMainLoop() {
    let ticked = 0;
    for (;;) {
      let leave = false, result = 1;
      ticked = await this.outdoorIdleCheck(ticked);
      const state = status.checkPartyState();
      if (state === 1) {
        tw.putChar(0x0a);
        status.drawLabelLeft();
        tw.printText(strings.get(S.Zzzzzz_2B2A));
        await waitTurns(1); // the original only redraws; this keeps it from spinning
      } else if (state === -1) {
        saveFilePart(0x100, map.objects.bytes, objectsFileName());
        await partyDeath();
        leave = true;
        result = 0;
      } else {
        if (await checkMoongate()) await visitShrine();
        if (!map.isOutdoors()) return;
        input.commandPrompt = input.anyCommandPrompt = true;
        const key = (await this.outdoorReadKey()) & 0xff;
        input.commandPrompt = input.anyCommandPrompt = false;
        if (gameQuit()) return;
        if (key > 0x1f) {
          result = key < 0x30 || key > 0x39 ? await dispatchCommand(key) : cmdSetActivePlayer(key);
        } else {
          switch (key) {
            case 0:
              result = 0;
              break;
            case 1: case 2: case 3: case 4:
              result = await this.outdoorMove(ticked, key);
              break;
            case 5: // Ctrl-E
              tw.printText(strings.get(S.Exit_to_DOS_2B3E));
              if (((await getCommandKey()) & 0xff) !== 0x59) {
                tw.printText(strings.get(S.N_2B4C));
              } else {
                exitGame(0);
                return;
              }
              break;
            case 0x0b: // Ctrl-K
              tw.printNumber(' ', 1, party.karma);
              tw.putChar(0x0a);
              result = 0;
              break;
            case 0x13: // Ctrl-S
              tw.printText(strings.get(S.Sound_2B54));
              tw.printText(strings.get(sound.enabled === 0 ? S.On_2B60 : S.Off_2B5B));
              sound.enabled = sound.enabled === 0 ? 1 : 0;
              break;
            case 0x16: // Ctrl-V
              tw.printText(strings.get(S.N1_16_2B4F));
              tw.putChar(0x0a);
              result = 0;
              break;
            default:
              tw.printText(strings.get(S.What_2B64));
          }
        }
      }
      if (gameQuit()) return;
      if ((party.transport & 0xfc) !== 0x20) party.sailDirection = 0;
      if (!map.isOutdoors()) return;
      if (leave) return;
      if (result === 0) continue;
      passTime(2);
      const t = map.getTile(map.y, map.x);
      if ((t & 0xfe) === 0x6a) {
        await this.trollBridge();
      } else if (t === 4 && party.transport === 0x1c) {
        this.swampPoison();
        await waitTurns(1);
      } else if (t === 0x8f) {
        await this.lavaBurn();
      } else if (map.x === 0xe9 && map.y === 0xeb && map.z === 0 && map.isOutdoors()) { // the passage to the Codex
        tw.printText(strings.get(S.NL_Quote_2B6B));
        if (party.sacredQuest === 0) {
          tw.printText(strings.get(S.Thou_art_not_upon_a_2B7E));
          tw.printText(strings.get(S.Passage_denied_2BA1));
          map.y++;
        } else {
          tw.printText(strings.get(S.Pass_Seeker_2B6E));
        }
      }
      await this.randomEarthquake();
      await perTurnStatus();
      if (t === 1 && ((party.transport & 0xfc) === 0x28 || (party.transport & 0xfe) === 0x14)) {
        tw.printText(strings.get(S.Rough_seas_2BB3)); // a skiff or carpet on deep water
        await flashSquare(map.y, map.x);
        await this.damageVehicle();
      }
      if ((t & 0xfc) === 0xd4) await this.waterfallFall();
      await this.outdoorMonstersTurn();
    }
  }

  /** 8ef2: the ship left at a town's entrance becomes an object again, then the loop. */
  async outdoorStart() {
    map.enterOutdoors();
    if (town.storedShip > 0x3f) {
      const slot = allocObjectSlot();
      const o = map.objects.at(slot);
      o.skiffs = town.storedShip & 0x3f;
      o.x = town.storedShipX;
      o.y = town.storedShipY;
      o.z = 0;
      o.tile = o.tile2 = town.storedShip < 0x80 ? 0x29 : 0x25;
      o.hull = 99;
      town.storedShip = 0;
    }
    await this.outdoorMainLoop();
  }

  /** 8f5c: against a 1-30 roll each turn: 1 open land, 2 swamp/forest/mountains, 0 on 0x20-0x26; +3 after midnight; 3 underground. */
  encounterChance() {
    if (map.z >= 0x80) return 3;
    const t = map.getTile(map.y, map.x);
    let chance;
    if (t >= 0x20 && t <= 0x26) chance = 0;
    else if (t === 4 || (t > 8 && t < 0x10)) chance = 2;
    else chance = 1;
    if (gameTime.hour > 0x1f || gameTime.hour < 5) chance += 3;
    return chance;
  }

  /** 8fd4 */
  weightedRandomIndex(weights) {
    let roll = randomBetween(0xff, 0), i = 0;
    for (; weights[i] <= roll; i++) roll -= weights[i];
    return i;
  }

  /** 901e: the wandering monsters by terrain; the chances add up to 256. */
  pickMonsterForTerrain(tile) {
    if (tile < 4 || (tile > 0x5f && tile < 0x70) || (tile > 0xd3 && tile < 0xd8) || (tile > 0xe3 && tile < 0xe8)) {
      if (randomBetween(0x40, 0) < 0x10) {
        if (map.z > 0x7f) return this.underSeaMonsters[this.weightedRandomIndex(this.underSeaChances) & 1];
        if (tile === 1 && randomBetween(7, 0) === 7) return 0xec; // a whirlpool
        return this.seaMonsters[this.weightedRandomIndex(this.seaChances) % 6];
      }
    } else if (tile === 7) {
      if (randomBetween(3, 0) === 0) return 0xe0;
    } else {
      if (tile === 4 && map.z === 0xff) return 0xf8;
      if (tile !== 0x0c && tile !== 0x0d && (tile < 0x10 || (tile & 0xfc) === 0x30)) {
        if (map.z < 0x80) return this.landMonsters[this.weightedRandomIndex(this.landChances) % 12];
        return this.underLandMonsters[this.weightedRandomIndex(this.underLandChances) & 7];
      }
    }
    return 0;
  }

  /** 911e: a square of the window at least 7 away from the party on both axes. */
  randomSpawnPos() {
    for (;;) {
      const x = (randomBetween(0x1f, 0) + map.originX) & 0xff;
      const y = (randomBetween(0x1f, 0) + map.originY) & 0xff;
      const ax = Math.abs(x - map.x), ay = Math.abs(y - map.y);
      if (ax >= 7 && ay >= 7 && ax <= 0xf9 && ay <= 0xf9) return { x, y };
    }
  }

  /** 9194 */
  spawnRandomMonster() {
    let tries, x = 0, y = 0, tile = 0;
    for (tries = 0; tries < 0x80; tries++) {
      ({ x, y } = this.randomSpawnPos());
      tile = this.pickMonsterForTerrain(map.getTile(y, x));
      if (tile !== 0 && (tile !== 0x2c || (map.getTile(y, x) & 0xf0) !== 0x60)) break; // no pirates on rivers
    }
    if (tries === 0x80) return;
    const slot = allocObjectSlot();
    setObjectEntry(slot, 0, map.z, y, x, tile, tile);
    if (tile === 0x2c) map.objects.at(slot).hull = 100;
  }

  /** 926e: a ship loses 1-30 hull, sinks below that; anything else hurts the party. */
  async damageVehicle() {
    if ((party.transport & 0xf8) !== 0x20) {
      await damageParty();
      return;
    }
    const damage = randomBetween(0x1e, 1);
    const p = map.objects.at(0);
    if (damage < p.hull) {
      p.hull -= damage;
      status.drawStatusBar();
      return;
    }
    tw.printText(strings.get(S.Ship_sunk_6ADA));
    const skiffs = p.skiffs;
    if (skiffs === 0 && party.magicCarpets === 0) {
      party.transport = 0;
      status.drawStatusBar();
      await view.worldTick();
      await sound.soundSlide(0x1e78, 0x28, 0x96, 0x294);
      tw.printText(strings.get(S.DROWNING_6AF6));
      while (status.checkPartyState() !== -1 && !gameQuit()) {
        await flashSquare(map.y, map.x);
        await damageParty();
      }
    } else {
      tw.printText(strings.get(S.Abandon_ship_6AE6));
      if (skiffs === 0) {
        party.magicCarpets--;
        party.transport = randomBetween(1, 0) + 0x14;
      } else {
        party.transport = (party.transport & 3) + 0x28;
      }
      status.dirty = true;
    }
  }

  /** 9338: the pirate ship turns broadside on and fires. */
  async pirateBroadside(distY, distX, object) {
    const o = map.objects.at(object);
    if (distX === 0 && (o.tile2 === 0x2c || o.tile2 === 0x2e)) o.tile2 = (randomBetween(3, 0) & 2) + 0x2d;
    if (distY === 0 && (o.tile2 === 0x2d || o.tile2 === 0x2f)) o.tile2 = (randomBetween(3, 0) & 2) + 0x2c;
    await view.worldTick();
    await sound.soundSlide(100, 5, 300, 0x514);
    if ((await combat.animateMissile(1, 5, 5, (o.y - map.y + 5) & 0xff, (o.x - map.x + 5) & 0xff)) !== 0) {
      await view.worldTick();
      await flashSquare(map.y, map.x);
      await this.damageVehicle();
    }
  }

  /** 9418: a whirlpool takes a ship to the Underworld; other monsters attack (or, over water in a skiff or on a carpet, damage). */
  async monsterContact(object) {
    const o = map.objects.at(object);
    if ((o.tile & 0xfc) === 0xec) {
      if (party.transport !== 0x1c) {
        o.tile = o.tile2 = 0;
        tw.printText(strings.get(S.WHIRLPOOL_6B04));
        const transport = party.transport;
        party.transport = 0xec;
        await view.worldTick();
        await sound.soundSlide(0x1e78, 0x28, 0x96, 0x294);
        party.transport = transport;
        await this.damageVehicle();
        map.z = 0xff;
        map.x = 0x22;
        map.y = 0x12;
        map.enterOutdoors();
        return;
      }
    } else if ((o.tile & 0xfc) !== 0xe0) {
      await view.worldTick();
      tw.printText(strings.get(S.Attacked_6B12));
      if (map.getTile(map.y, map.x) > 3 || ((party.transport & 0xfe) !== 0x14 && (party.transport & 0xfc) !== 0x28)) {
        await combat.combatWithObject(object);
        return;
      }
    }
    await this.damageVehicle();
  }

  /** 94ea: contact when next to the party; 0x88 and 0xDC shoot from up to 3 squares; pirates in line fire. 1 if it acted. */
  async monsterAct(object) {
    const o = map.objects.at(object);
    const tile = o.tile;
    const ax = wrapDistance(o.x, map.x), ay = wrapDistance(o.y, map.y);
    if ((ax === 1 && ay === 0) || (ax === 0 && ay === 1)) {
      await this.monsterContact(object);
      return 1;
    }
    if (tile === 0x88 || tile === 0xdc) {
      if (ax < 4 && ay < 4 && randomBetween(7, 0) === 0) {
        await view.worldTick();
        await sound.soundSlide(100, 5, 300, 0x514);
        if ((await combat.animateMissile(3, 5, 5, (o.y - map.y + 5) & 0xff, (o.x - map.x + 5) & 0xff)) !== 0) {
          await flashSquare(map.y, map.x);
          await this.damageVehicle();
        }
        return 1;
      }
    } else if ((tile & 0xfc) === 0x2c && ((ax === 0 && ay < 4) || (ay === 0 && ax < 4))) {
      tw.printText(strings.get(S.BOOOM_6B1E));
      await this.pirateBroadside(ay, ax, object);
      return 1;
    }
    return 0;
  }

  monsterCanStep(y, x, object) {
    return tilePassable(map.getTile(y, x), map.objects.at(object).tile) && objectTileAt(map.z, y, x).tile === 0;
  }

  notLastPosition(y, x) {
    return !(x === this.lastMonsterX && y === this.lastMonsterY);
  }

  /** 96ba: by distance from the party (only read by the Shadowlord). */
  shadowlordChaseWeight(object) {
    const o = map.objects.at(object);
    const ax = wrapDistance(o.x, map.x), ay = wrapDistance(o.y, map.y);
    return ax < 6 && ay < 6 ? this.chaseWeight[ax + ay * 0x0b] : 0;
  }

  /** 9748: pirates face the step; most monsters are slowed by rough ground; into a moongate is gone. */
  monsterStep(dy, dx, object) {
    const o = map.objects.at(object);
    const tile = o.tile;
    const x = (o.x + dx) & 0xff, y = (o.y + dy) & 0xff;
    const ground = map.getTile(y, x);
    if ((tile & 0xfc) === 0x2c) {
      let heading = 0;
      if (dx === 0 && dy === -1) heading = 0;
      else if (dx === 1 && dy === 0) heading = 1;
      else if (dx === 0 && dy === 1) heading = 2;
      else if (dx === -1 && dy === 0) heading = 3;
      o.tile = o.tile2 = heading + 0x2c;
    } else if (tile !== 0xdc && tile !== 0x94 && tile !== 0xd8 && tile !== 0xf0) {
      switch (ground) {
        case 4: case 6: case 7: case 8: case 0x1e: case 0x1f:
          if (randomBetween(1, 0) === 0) return;
          break;
        case 9: case 0x0a: case 0x0b: case 0x0c: case 0x0d: case 0x0e: case 0x0f:
          if (randomBetween(2, 0) !== 2) return;
          break;
      }
    }
    this.lastMonsterX = o.x;
    this.lastMonsterY = o.y;
    o.x = x;
    o.y = y;
    view.rebuild = true;
    if (map.getTile(y, x) === 0xdc) o.tile = o.tile2 = 0;
  }

  monsterRandomWalk(object) {
    const o = map.objects.at(object);
    const x = o.x, y = o.y;
    switch (randomBetween(3, 0)) {
      case 0: if (this.monsterCanStep(y - 1, x, object)) this.monsterStep(-1, 0, object); break;
      case 1: if (this.monsterCanStep(y, x + 1, object)) this.monsterStep(0, 1, object); break;
      case 2: if (this.monsterCanStep(y + 1, x, object)) this.monsterStep(1, 0, object); break;
      case 3: if (this.monsterCanStep(y, x - 1, object)) this.monsterStep(0, -1, object); break;
    }
  }

  /** 99a4: a step towards the party along a random axis first; never back; else at random. */
  monsterChase(chase, object) {
    const o = map.objects.at(object);
    const x = o.x, y = o.y;
    const ddx = ((o.x - map.x) << 24) >> 24, ddy = ((o.y - map.y) << 24) >> 24;
    const sx = ddx === 0 ? 0 : ddx > 0 ? -1 : 1, sy = ddy === 0 ? 0 : ddy > 0 ? -1 : 1;
    const tryX = () => sx !== 0 && this.monsterCanStep(y, x + sx, object) && this.notLastPosition(y, x + sx);
    const tryY = () => sy !== 0 && this.monsterCanStep(y + sy, x, object) && this.notLastPosition(y + sy, x);
    if (randomBetween(1, 0) === 1) {
      if (tryX()) this.monsterStep(0, sx, object);
      else if (tryY()) this.monsterStep(sy, 0, object);
      else this.monsterRandomWalk(object);
    } else {
      if (tryY()) this.monsterStep(sy, 0, object);
      else if (tryX()) this.monsterStep(0, sx, object);
      else this.monsterRandomWalk(object);
    }
  }

  /** 9b5c: whirlpools move every other turn; the Shadowlord bides near the party; pirates by the wind. */
  monsterMoveOutdoor(object) {
    const o = map.objects.at(object);
    const tile = o.tile;
    let chase = 1;
    if ((tile & 0xfc) === 0xec) {
      o.hull ^= 1;
      if (o.hull === 0) return;
      if (randomBetween(1, 0) === 0) {
        this.monsterRandomWalk(object);
        return;
      }
    } else if (tile === 0xfc) {
      if (this.shadowlordChaseWeight(object) !== 0 && o.hull++ < 0x14) chase = 0;
    } else if ((tile & 0xfc) === 0x2c) {
      if (map.windDirection === 0) return;
      const wait = this.pirateWait[(tile - 0x2c) * 4 + ((map.windDirection - 1) & 3)];
      if (wait !== 4 && ++o.skiffs > wait) {
        o.skiffs = 0;
        return;
      }
    }
    this.monsterChase(chase, object);
  }

  /**
   * 9c30: nothing moves under Time Stop; under Quickness, riding or flying only every other call.
   * Once a monster has acted the others don't move this turn. Monsters outside the window go.
   */
  async outdoorMonstersTurn() {
    let acted = 0;
    if (party.activeSpell === 0x54 ||
        (party.activeSpell === 0x51 && ((this.quicknessToggle ^= 1), this.quicknessToggle !== 0)) ||
        (((party.transport & 0xfe) === 0x12 || (party.transport & 0xfe) === 0x14) && ((this.ridingToggle ^= 1), this.ridingToggle !== 0)))
      return 0;
    if (randomBetween(0x1e, 1) < this.encounterChance()) this.spawnRandomMonster();
    for (let i = 0x1f; i > 0; i--) {
      if (!isActiveMonsterTile(map.objects.at(i).tile)) continue;
      acted += await this.monsterAct(i);
      if (acted === 0) this.monsterMoveOutdoor(i);
      if (!map.isOutdoors() || gameQuit()) return acted; // a fight can end somewhere else
    }
    for (let i = 0x1f; i > 0; i--) {
      const o = map.objects.at(i);
      if (isActiveMonsterTile(o.tile) && (((o.x - map.originX) & 0xff) > 0x1f || ((o.y - map.originY) & 0xff) > 0x1f)) setObjectEntry(i, 0, 0, 0, 0, 0, 0);
    }
    return acted;
  }

  /** 9d0e: 99 - 3 x the first able member's strength; refusing, or no gold, means trolls. */
  async trollToll() {
    tw.printText(strings.get(S.Caught_The_trolls_demand_6B2C));
    const toll = 99 - party.member(party.firstAble()).str * 3;
    tw.printNumber(' ', 2, toll);
    tw.printText(strings.get(S.gp_toll_Dost_thou_pay_6B4A));
    let c;
    do {
      c = await getCommandKey();
      if (gameQuit()) return;
    } while (c !== 0x59 && c !== 0x4e);
    tw.putChar(c);
    tw.putChar(0x0a);
    if (c === 0x59) {
      party.gold = (party.gold - toll) & 0xffff;
      status.dirty = true;
      if (((party.gold << 16) >> 16) >= 0) return;
      party.gold = (party.gold + toll) & 0xffff;
    }
    const slot = allocObjectSlot();
    setObjectEntry(slot, 0, 0, map.y, map.x, 0, 0xe4);
    await combat.combatWithObject(slot);
  }

  /** 9db8: on foot on a bridge, 1 time in 8: each member sneaks across on a DEX roll. */
  async trollBridge() {
    if (randomBetween(7, 0) !== 0 || party.transport !== 0x1c) return;
    await view.worldTick();
    tw.printText(strings.get(S.Thou_spieth_trolls_under_6B64));
    await waitTurns(10);
    for (let i = 0; i < party.size; i++) {
      const m = party.member(i);
      if (m.dead() || m.asleep()) continue;
      tw.printText(m.name);
      tw.printText(strings.get(S.sneaks_across_6B8C));
      for (let n = 3; n !== 0; n--) {
        await waitTurns(5);
        tw.putChar(0x2e);
      }
      tw.printText(strings.get(S.NL_NL_6B9C));
      if (m.dex < randomBetween(0x1e, 1)) {
        await this.trollToll();
        return;
      }
    }
    tw.printText(strings.get(S.Trolls_evaded_6BA0));
  }

  /** a6e8: two squares south over the falls; the falls at (0x36, 0x8A) lead to the Underworld. */
  async waterfallFall() {
    tw.printText(strings.get(S.F_A_L_L_S_39B5));
    map.outdoorStep(1, 0);
    await waitTurns(1);
    map.outdoorStep(1, 0);
    await sound.soundSlide(300, 1, 800, 0x9c4);
    const transport = party.transport;
    party.transport = 0;
    await waitTurns(1);
    for (let i = 0; i < party.size; i++) if (!party.member(i).dead() && party.member(i).dex <= randomStatRoll()) await damageMember(1, i);
    await waitTurns(2);
    party.transport = transport;
    if (map.x === 0x36 && map.y === 0x8a) {
      tw.printText(strings.get(S.Falling_into_underworld_39C3));
      map.z = 0xff;
      saveFilePart(0x100, map.objects.bytes, strings.get(S.BRIT_OOL_39DE));
      loadFilePart(0, 0x100, map.objects.bytes, strings.get(S.UNDER_OOL_39E7));
      map.enterOutdoors();
    }
  }

  /** a7f6: in the Underworld, objects 0x1C-0x1F are the Amulet (until found) and the Shadowlords' shards. */
  placeUnderworldSpecials() {
    if (map.z === 0) return;
    if (party.lbAmulet === 0) {
      const o = map.objects.at(0x1c);
      o.tile = o.tile2 = 0xb7;
      o.x = 0x69;
      o.y = 0xe1;
      o.z = 0xff;
      o.hull = 0xf3;
    }
    for (let i = 0; i < 3; i++) {
      if (party.shards[i] !== 0 || map.shadowlordLocations[i] >= 0x80) continue;
      const o = map.objects.at(0x1d + i);
      o.tile = o.tile2 = 0xb4;
      o.x = this.shadowlordX[i];
      o.y = this.shadowlordY[i];
      o.z = 0xff;
      o.hull = this.shadowlordHull[i];
    }
  }

  /** a87e */
  async lavaBurn() {
    await view.worldTick();
    tw.printText(strings.get(S.Burning_3A11));
    await damageParty();
  }

  /** a88c */
  swampPoison() {
    for (let i = 0; i < party.size; i++) {
      const m = party.member(i);
      if (m.dead() || m.poisoned()) continue;
      if (m.dex < randomBetween(0x1e, 1)) {
        m.status = 'P';
        tw.printText(strings.get(S.Poisoned_3A1B));
      }
    }
  }

  /**
   * After a good rest, 1 time in 4: an old man appears in the camp, heals everyone, raises the
   * level of each member whose experience earns it (with a point of strength, dexterity or
   * intelligence), speaks of the party's karma (KARMA.DAT) and vanishes.
   */
  async apparitionLevelUp() {
    const man = map.objects.at(10);
    tw.printText(strings.get(S.An_apparition_7750));
    await sound.soundSweep(6, 0x9c4, 10000, 1, 0xa3c);
    for (const note of this.apparitionTune) await sound.soundSweep(0x0d, 200, 5000, 1, note);
    man.x = man.y = 5;
    man.tile = man.tile2 = 0x16;
    await dissolveTile(5, 5, 0x174);
    man.tile = man.tile2 = 0x74;
    let o = man; // (the original keeps the previous member's object if none is found)
    for (let m = 0; m < party.size; m++) {
      const pm = party.member(m);
      if (!pm.dead()) {
        o = man;
        pm.hp = pm.maxHp;
        pm.status = 'G';
        for (let i = 0; i < 0x20; i++)
          if (combat.combatants[i].kind === m) {
            o = map.objects.at(combat.combatants[i].object & 0x1f);
            break;
          }
        o.tile = o.tile2 = party.classTile(strIndex(pm.cls.charCodeAt(0), strings.get(S.AMBFDTPRS_7760)));
        man.flags = 0;
        await waitTurns(1);
        await sound.soundSweep(0x0d, 200, 5000, 1, 0x157c);
        gfx.setDrawColor(gfx.colorText);
        gfx.xorFillRect(0xb7, 0xb7, 8, 8);
        await sound.soundSweep(1, 0x9c4, -0x15a0, 1, 0x157c);
        for (let i = 3; i !== 0; i--) {
          man.flags = 1;
          await waitTurns(1);
        }
        let level = 1;
        for (let n = Math.trunc(((pm.xp << 16) >> 16) / 100); n > 0; n >>= 1) level++;
        if (pm.level !== level) {
          pm.level = level;
          pm.maxHp = pm.hp = level * 0x1e;
          tw.printText(strings.get(S.Hail_776A));
          tw.printText(pm.name);
          tw.printText(strings.get(S.For_thy_valiant_deeds_I_7774));
          tw.printText(strings.get(S.Thou_art_now_level_77A4));
          tw.printNumber(' ', 1, level);
          tw.printText(strings.get(S.and_77B8));
          switch (randomBetween(3, 1)) {
            case 1: tw.printText(strings.get(S.stronger_77C0)); addByteCapped(0x1e, 1, pm, 'str'); break;
            case 2: tw.printText(strings.get(S.quicker_77CA)); addByteCapped(0x1e, 1, pm, 'dex'); break;
            case 3: tw.printText(strings.get(S.wiser_77D4)); addByteCapped(0x1e, 1, pm, 'intel'); break;
          }
          tw.printText(strings.get(S.Quote_SP_77DC));
          await getCommandKey();
          tw.putChar(0x0a);
        }
      }
      if (pm.cls === 'A' || pm.cls === 'M') pm.mp = pm.intel;
      else if (pm.cls === 'B') pm.mp = pm.intel >> 1;
      status.drawStatusBar();
    }
    tw.printText(strings.get(S.NL_Quote_77E0));
    const k = Math.trunc(party.karma / 0x14);
    loadFilePart(k < 4 ? party.karmaText(k) : 0x29f, 2000, textBuffer.data, strings.get(S.KARMA_DAT_77E4));
    tw.printText(textBuffer.cString(0));
    tw.putChar(0x22);
    await getCommandKey();
    tw.printText(strings.get(S.The_strangely_familiar_77F8));
    man.tile = man.tile2 = 0x16;
    await dissolveTile(5, 5, view.localMap[0xa5]);
    man.tile = man.tile2 = 0;
    await waitTurns(1);
    passTime(0);
  }
}

export const outdoor = new Outdoor();
