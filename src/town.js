// town.js - the settlements (TOWN.OVL), as the Town class; `town` is the one object. Ported from
// the C++ port's town.cpp.
import { askDirection, getCommandKey, restoreOpenDoor, tilePassable, waitTurns } from './commands.js';
import { data, SHARED } from './data/gamedata.js';
import { S, strings } from './data/strings.js';
import { flashSquare, screenShake } from './effects.js';
import { gameTime } from './gametime.js';
import { gfx } from './gfx.js';
import { input } from './input.js';
import { cmdSetActivePlayer, dispatchCommand } from './game.js';
import { exitGame, gameQuit } from './gamestate.js';
import { combat } from './combat.js';
import { dungeon } from './dungeon.js';
import { capturedByBlackthorn, partyDeath } from './endings.js';
import { visitShrine } from './shrine.js';
import { M, map, passTime } from './map.js';
import { randomBetween, setRandomSeed, subByteFloor0, timeSeed } from './misc.js';
import { npcs } from './npc.js';
import { allocObjectSlot, findObjectAt, objectTileAt, setObjectEntry } from './objects.js';
import { party } from './party.js';
import { savegame } from './savegame.js';
import { sound } from './sound.js';
import { status } from './status.js';
import { conversation } from './talk.js';
import { textWindows as tw } from './text.js';
import { view } from './view.js';
import { checkMoongate, damageParty, perTurnStatus } from './world.js';

export class Town {
  constructor() {
    this.justEntered = 0; // skips one moongate check in the town loop
    this.tuneProgress = 0; // notes of the secret harpsichord tune matched so far
    this.carpetSkip = false;
    this.quickSkip = false;
    this.drunkTurns = 0; // "Hic!"
    this.shadowlordHere = 0; // the Shadowlord in this town, or 0xFF
    this.storedShip = 0; // the ship left outside: 0x40 present, 0x80 type, low 6 bits skiffs
    this.storedShipX = 0;
    this.storedShipY = 0;
    this.lampX = new Uint8Array(32); // the street lamps of this level
    this.lampY = new Uint8Array(32);
    this.lampTile = new Uint8Array(32);
    this.lampCount = 0;
    const s = savegame;
    s.bytes(0x58ee, this.lampX, 'town.lampX');
    s.bytes(0x590e, this.lampY, 'town.lampY');
    s.bytes(0x592e, this.lampTile, 'town.lampTile');
    s.u8(0x594e, this, 'lampCount', 'town.lampCount');
    s.u8(0x5953, this, 'storedShipX', 'town.storedShipX');
    s.u8(0x5954, this, 'storedShipY', 'town.storedShipY');
    s.u8(0x5957, this, 'drunkTurns', 'town.drunkTurns');
    s.u8(0x5958, this, 'shadowlordHere', 'town.shadowlordHere');
    s.u8(0x6605, this, 'storedShip', 'town.storedShip');
    // Read-only tables, from DATA.OVL.
    this.drunkKeys = data.bytes(0x2742, new Uint8Array(4), 'town.drunkKeys'); // the way a drunk staggers instead
    this.notePitch = data.words(0x2746, new Uint16Array(10), 'town.notePitch'); // the harpsichord's notes
    this.secretTune = data.bytes(0x275a, new Uint8Array(13), 'town.secretTune'); // Stones, which opens the passage
    this.shadowlordAirs = data.words(0x27dc, new Array(3).fill(0), 'town.shadowlordAirs'); // "An air of ..."
    // by location 1-0x20, a bit per NPC (entry 0, which isn't a place, is the end of some text: SHARED)
    this.npcHiddenBits = data.bytes(0x28c2, new Uint8Array(0x84), 'town.npcHiddenBits', SHARED);
    // The shops' tables, read by their old offsets (TOWN_TABLES below) as in the C++ port: taken in
    // runs, which have text in between (SHARED).
    this.tableRuns = [[0x21ca, 0x280], [0x3a32, 0x374], [0x4c1e, 0x26a]].map(([start, size]) => ({
      start,
      bytes: data.bytes(start, new Uint8Array(size), 'town.tables', SHARED),
    }));
    // The shop being visited (shops.js). The names are string ids.
    this.shopType = 0; // 0 armoury ... 7 inn
    this.shopTown = 0; // which town's shop of that type: an index into the price tables
    this.shopName = 0; // # in the shop's text
    this.shopkeeperName = 0; // $
    this.shopItemName = 0; // &
    this.shopItemName2 = 0; // *
    this.shopPrice = 0; // %
    this.shopQuantity = 0; // ^
    this.tavernIndex = 0;
    this.tavernDrinks = 0;
    this.tavernFarewellKind = 0;
    this.tavernDiners = 0;
    this.tavernDiners2 = 0;
    this.tavernFoodTile = 0;
    this.shipwrightCanBuy = 0;
    this.shipwrightBought = 0;
  }

  /** A byte of the shops' tables by its old ds offset; one outside the runs gives 0. */
  tableByte(off) {
    for (const r of this.tableRuns) if (off - r.start >= 0 && off - r.start < r.bytes.length) return r.bytes[off - r.start];
    if (off >= 0x2742 && off < 0x275a) return off < 0x2746 ? this.drunkKeys[off - 0x2742] : (this.notePitch[(off - 0x2746) >> 1] >> ((off - 0x2746) & 1 ? 8 : 0)) & 0xff;
    return 0;
  }

  /** A little-endian word of them. */
  tableWord(off) {
    return this.tableByte(off) | (this.tableByte(off + 1) << 8);
  }

  /** Bit n of the per-location 32-bit table at ds:28C2 (NPCs not yet known by name). */
  npcHidden(npc) {
    const o = map.id * 4;
    const bits = (this.npcHiddenBits[o] | (this.npcHiddenBits[o + 1] << 8) | (this.npcHiddenBits[o + 2] << 16) | (this.npcHiddenBits[o + 3] << 24)) >>> 0;
    return (bits >>> (npc & 31)) & 1;
  }

  /** Only people (type 0x0E and >= 0x40) can be dead. */
  npcIsDead(npc) {
    if (npcs.type[npc] === 0x0e || npcs.type[npc] > 0x3f) return (npcs.deadBits[map.id] >>> (npc & 31)) & 1;
    return 0;
  }

  /** People only: not guards (0x70-0x73), not monsters (>= 0x80) except 0xB4-0xB7. */
  markNpcDead(npc) {
    if (npc < 0 || npc >= 0x20) return;
    const kind = npcs.type[npc] & 0xfc;
    if ((kind !== 0x70 && kind < 0x80) || kind === 0xb4) npcs.deadBits[map.id] |= 1 << npc;
  }

  /** Guards and low types attack in place (6), others chase (7); the schedule stays on entry 0. */
  npcMakeHostile(npc) {
    const a = npcs.type[npc] < 0x2f ? 6 : 7;
    npcs.schedules[npc].times.fill(0);
    npcs.schedules[npc].activity.fill(a);
  }

  /** People (0x40-0x73) with a schedule, or hostile, become "Don't hurt me!" (0xFD) and keep away. */
  npcMakeFleeing(npc) {
    const hasTimes = npcs.schedules[npc].times.some((t) => t !== 0);
    if (npcs.type[npc] < 0x74 && npcs.type[npc] > 0x3f && (npcs.state[npc].dialogue === 0xfe || hasTimes)) {
      npcs.state[npc].dialogue = 0xfd;
      npcs.schedules[npc].activity.fill(3);
    }
  }

  /** Guards (0x70), daemons (0xD8) and 0xFC turn hostile; others flee half the time. */
  alertTown() {
    for (let npc = 0; npc < 0x20; npc++) {
      if (npcs.state[npc].state === 0) continue;
      const t = npcs.type[npc];
      if (t === 0xfc || t === 0xd8 || t === 0x70) this.npcMakeHostile(npc);
      else if (randomBetween(0xff, 0) < 0x80) this.npcMakeFleeing(npc);
    }
  }

  async npcBegone(npc) {
    tw.printText(strings.get(S.Begone_vermin_278A)); // "Begone, vermin!"
    await damageParty();
    this.npcMakeFleeing(npc);
  }

  removeNpc(npc) {
    const s = npcs.state[npc];
    map.objects.at(s.object).bytes.fill(0, map.objects.at(s.object).offset, map.objects.at(s.object).offset + 8);
    s.dialogue = s.z = s.y = s.x = s.state = 0;
    npcs.schedules[npc].activity.fill(0);
    npcs.type[npc] = 0;
    view.rebuild = true;
  }

  npcForObject(object) {
    for (let i = 0; i < 32; i++) if (npcs.state[i].object === object && npcs.type[i] !== 0 && npcs.state[i].state !== 0) return i;
    return -1;
  }

  /** Lamp posts go dark by day (tile 3) and light at night; the light below a 0x87 toggles. */
  updateLamps() {
    for (let x = 0; x < 0x20; x++)
      for (let y = 0; y < 0x20; y++) if (map.getTile(y, x) === 0x87) map.setTile(y + 1, x, map.getTile(y + 1, x) ^ 0xdd);
    if ((map.getTile(map.y, map.x) & 0xfe) !== 0x48)
      for (let i = 0; i < this.lampCount; i++) map.setTile(this.lampY[i], this.lampX[i], gameTime.hour === 5 ? this.lampTile[i] : 3);
    view.rebuild = true;
  }

  /** Stairs 0xC4-0xC7 face a direction: walking that way goes up, the opposite way down. */
  async takeStairs(tile, facing) {
    if ((tile & 0xfc) !== 0xc4) return;
    await view.worldTick();
    if (tile - 0xc4 === facing) {
      map.z = (map.z + 1) & 0xff;
      tw.printText(strings.get(S.Up_265A));
    } else if (tile - 0xc4 === (facing ^ 2)) {
      map.z = (map.z - 1) & 0xff;
      tw.printText(strings.get(S.Down_265F));
    } else {
      return;
    }
    map.loadTownLevel(1);
  }

  /** Horses, carpets and boats turn to face the way they move; dir 0 N 1 E 2 S 3 W. */
  setVehicleFacing(dir) {
    const kind = party.transport & 0xfc;
    if (kind === 0x10) {
      tw.printText(strings.get(S.Ride_2666));
      if (dir === 1) party.transport = 0x12;
      else if (dir === 3) party.transport = 0x13;
    } else if (kind === 0x14) {
      tw.printText(strings.get(S.Fly_266C));
      if (dir === 1) party.transport = 0x14;
      else if (dir === 3) party.transport = 0x15;
    } else if (kind === 0x20 || kind === 0x24 || kind === 0x28) {
      if (kind === 0x28) tw.printText(strings.get(S.Row_2671));
      party.transport = dir + kind;
    }
  }

  /** A step; at the level's edge, the offer to leave. Returns non-zero if the party left. */
  async townMove(dir) {
    let dx = 0, dy = 0, atEdge = 0, facing = 0, text = null;
    if (party.transport === 0x1c || (party.transport & 0xfe) === 0x12) await sound.stepSound();
    switch (dir) {
      case 1: dx = -1; atEdge = map.x === 0 ? 1 : 0; facing = 3; text = S.West_268A; break;
      case 2: dx = 1; atEdge = map.x > 0x1e ? 1 : 0; facing = 1; text = S.East_2684; break;
      case 3: dy = -1; atEdge = map.y === 0 ? 1 : 0; facing = 0; text = S.North_2676; break;
      case 4: dy = 1; atEdge = map.y > 0x1e ? 1 : 0; facing = 2; text = S.South_267D; break;
    }
    if (text) {
      this.setVehicleFacing(facing);
      tw.printText(strings.get(text));
    }
    let free = true;
    const tile = view.mask[0xa5 + dx + dy * 0x20]; // the square next to the party, as seen
    const obj = findObjectAt(map.z, map.y + dy, map.x + dx).tile;
    if (obj !== 0) {
      free = false;
      if (party.transport >= 0x20 && party.transport < 0x30) { // boats may push into other boats
        if (!(party.transport < 0x28 || obj < 0x24 || obj > 0x27)) free = true;
      } else if ((obj >= 0x24 && obj <= 0x2b) || obj === 0x1b || (obj & 0xfe) === 0x10 || obj === 0x1e || obj === 0x1f) {
        free = true; // boarding
      }
    }
    if (free && tilePassable(tile, party.transport)) {
      if (!atEdge) {
        map.x = (map.x + dx) & 0xff;
        map.y = (map.y + dy) & 0xff;
        view.rebuild = true;
        await this.takeStairs(tile, facing);
        return 0;
      }
      tw.printText(strings.get(S.Dost_thou_wish_to_leave_2690)); // "Dost thou wish to leave? "
      let key;
      do key = await getCommandKey();
      while (key !== 0x59 && key !== 0x4e && key !== 0x1b);
      if (key === 0x59) {
        tw.printText(strings.get(S.Yes_Exit_to_26AB)); // "Yes\n\nExit to\n"
        if (map.id === M.ARARAT) {
          tw.printText(strings.get(S.Underworld_26B9));
          map.z = 0xff;
        } else {
          tw.printText(strings.get(S.Britannia_26C6));
          map.z = 0;
        }
        const loc = map.id;
        map.id = M.BRITANNIA;
        map.x = map.exitX(loc);
        map.y = map.exitY(loc);
        map.openDoorTile = 0;
        return atEdge;
      }
      tw.printText(strings.get(S.No_26D2));
    } else {
      tw.printText(strings.get(S.Blocked_26D6)); // "Blocked!"
      await sound.beep(200, 0xa5);
      input.flushKeyboard();
    }
    return 0;
  }

  isHitchingTile(y, x) {
    const t = map.getTile(y, x);
    return t === 0xa2 || t === 0x43;
  }

  /** Horses not next to a hitching post move a square at random half the time. */
  wanderHorses() {
    for (let i = 0; i < 0x20; i++) {
      const o = map.objects.at(i);
      let tile = o.tile;
      if ((tile & 0xfe) !== 0x10 || o.z !== map.z || randomBetween(1, 0) !== 0) continue;
      let x = o.x, y = o.y;
      if (this.isHitchingTile(y + 1, x) || this.isHitchingTile(y, x + 1) || this.isHitchingTile(y - 1, x) || this.isHitchingTile(y, x - 1)) continue;
      if (randomBetween(1, 0) === 0) {
        y += randomBetween(1, 0) * 2 - 1;
      } else {
        const d = randomBetween(1, 0) * 2 - 1;
        x += d;
        tile = d < 1 ? 0x11 : 0x10; // face the way it moves
      }
      if (x < 0x20 && y < 0x20 && x >= 0 && y >= 0 && tilePassable(map.getTile(y, x), 0x10) && objectTileAt(map.z, y, x).tile === 0) {
        o.tile2 = tile;
        o.tile = tile;
        o.x = x;
        o.y = y;
        view.rebuild = true;
      }
    }
  }

  /** The NPCs take their places by their schedules. */
  placeNpcs() {
    for (let i = 1; i < 0x20; i++) {
      setObjectEntry(i, 0, 0, 0, 0, 0, 0);
      npcs.state[i].object = 0;
    }
    for (let i = 1; i < 0x20; i++) {
      if (npcs.type[i] === 0) continue;
      const slot = npcs.currentScheduleSlot(gameTime.hour, i);
      const sc = npcs.schedules[i];
      this.placeNpc(sc.z[slot], sc.y[slot], sc.x[slot], i);
      npcs.state[i].state = 1;
      npcs.state[i].schedSlot = slot;
      npcs.pathPos[i] = 0xffff;
    }
  }

  /**
   * Gives the NPC a map object while it is on the party's floor. The object's hull is 0x1E for
   * type 1, else 0xFF if the NPC isn't known yet (ds:28C2), else 0.
   */
  placeNpc(z, y, x, npc) {
    if (npcs.type[npc] === 0) return;
    const s = npcs.state[npc];
    if (z !== map.z && s.object !== 0) {
      map.objects.at(s.object).tile = 0;
      s.object = 0;
    }
    if (z === map.z && s.object === 0) {
      const slot = allocObjectSlot();
      const hull = npcs.type[npc] === 1 ? 0x1e : this.npcHidden(npc) ? 0xff : 0;
      setObjectEntry(slot, hull, z, y, x, npcs.type[npc], npcs.type[npc]);
      map.objects.at(slot).flags = 0;
      s.object = slot;
    }
    if (z === map.z && s.object !== 0) {
      const o = map.objects.at(s.object);
      o.x = x;
      o.y = y;
      o.z = z;
    }
    s.x = x;
    s.y = y;
    s.z = z;
    s.state = 1;
  }

  /** Where a Shadowlord is, the town's crops wither (seeded by the day, so it looks the same all day). */
  shadowlordBlight() {
    if (this.shadowlordHere === 0xff) return;
    setRandomSeed(gameTime.day);
    for (let i = 0; i < 0x400; i++) {
      if (map.buffer[i] === 0x2d) {
        if (randomBetween(7, 0) !== 0) map.buffer[i] = 0x2c;
      } else if (map.buffer[i] === 0x2e && randomBetween(7, 0) !== 0) {
        map.buffer[i] = 0x2b;
      }
    }
    view.rebuild = true;
    setRandomSeed(timeSeed());
  }

  /** A Shadowlord in this town (not when the party arrives at row 4, in a cell) gets an object and an NPC slot. */
  checkShadowlordArrival() {
    this.shadowlordHere = 0xff;
    if (map.y !== 4)
      for (let i = 0; i < 3; i++)
        if (map.shadowlordLocations[i] === map.id) {
          this.shadowlordHere = i;
          break;
        }
    if (this.shadowlordHere === 0xff) return;
    this.shadowlordBlight();
    for (let i = 0; i < 0x20; i++) if (map.objects.at(i).tile === 0xfc) return;
    const obj = allocObjectSlot();
    let npc = 0x1f;
    for (let i = 0x1f; i >= 0; i--)
      if (npcs.type[i] === 0) {
        npc = i;
        break;
      }
    const o = map.objects.at(obj), st = npcs.state[npc], sc = npcs.schedules[npc];
    st.state = 1;
    st.object = obj;
    o.x = 0x0f;
    st.x = 0x0f;
    o.y = map.shadowlordRow();
    st.y = o.y;
    o.skiffs = 0;
    o.z = 0;
    o.hull = 0;
    o.flags = 0;
    st.z = 0;
    o.tile = o.tile2 = 0xfc;
    sc.times.fill(0);
    for (let i = 0; i < 3; i++) {
      sc.activity[i] = 6;
      sc.x[i] = 0x0f;
      sc.y[i] = o.y;
      sc.z[i] = 0;
    }
    npcs.type[npc] = 0xfc;
  }

  async fightNpc(npc) {
    this.markNpcDead(npc);
    await combat.combatWithObject(npcs.state[npc].object);
    this.removeNpc(npc);
    map.loadTownLevel(0);
    this.checkShadowlordArrival();
  }

  /** Only NPCs with a schedule can be swayed, half the time (the type test reads type[4]: the original's bug). */
  npcSwayedByShadowlord(npc) {
    let swayed = npcs.schedules[npc].times.some((t) => t !== 0);
    if (npcs.type[4] < 0x40 || npcs.type[4] > 0x73) swayed = false;
    if (randomBetween(1, 0) !== 0) swayed = false;
    return swayed;
  }

  /** Hatred (1) turns townspeople hostile, Cowardice (2) makes them flee. */
  applyShadowlordInfluence() {
    if (this.shadowlordHere !== 1 && this.shadowlordHere !== 2) return;
    for (let i = 0; i < 0x20; i++) {
      if (!this.npcSwayedByShadowlord(i)) continue;
      if (this.shadowlordHere === 1) {
        this.npcMakeHostile(i);
        npcs.state[i].dialogue = 0xfe;
      } else {
        this.npcMakeFleeing(i);
        npcs.state[i].dialogue = 0xfd;
      }
    }
  }

  async printShadowlordAir(shadowlord) {
    tw.printText(strings.get(S.An_air_of_27B8));
    tw.printText(strings.get(this.shadowlordAirs[shadowlord]));
    tw.printText(strings.get(S.doth_surround_thee_27C4));
    await sound.soundSweep(1, 2000, -0x15a0, 1, 0x19c8);
  }

  /** Entering a settlement: fresh from outdoors or a dungeon (its NPCs loaded), or a saved game going on. */
  async enterTown(fresh) {
    view.rebuild = true;
    this.justEntered = 1;
    if (fresh) {
      for (let i = 1; i < 0x20; i++) map.objects.at(i).tile = 0;
      this.drunkTurns = 0;
      view.worldTickEnabled = 1;
      npcs.loadTownNpcs();
      npcs.initNpcStates(gameTime.hour);
    }
    this.shadowlordHere = 0xff;
    map.loadTownLevel(fresh);
    this.checkShadowlordArrival();
    for (let i = 0; i < 0x20; i++) if (this.npcIsDead(i)) this.removeNpc(i);
    if (map.id === M.STONEGATE && party.lbSceptre !== 0) this.removeNpc(9);
    status.drawStatusBar();
    if (status.checkPartyState() < 0) return;
    await view.worldTick();
    if (map.id === M.STONEGATE) {
      for (let i = 2; i >= 0; i--) if (map.shadowlordLocations[i] < 0x80) await this.printShadowlordAir(i);
    } else if (this.shadowlordHere !== 0xff) {
      await this.printShadowlordAir(this.shadowlordHere);
      this.applyShadowlordInfluence();
    }
  }

  /**
   * In Blackthorn's castle capture means the interrogation. Elsewhere: going quietly puts the party
   * in the gaol at Yew at 8:00 without its keys; refusing alerts the town (returns 1: the guard
   * attacks).
   */
  async arrestParty() {
    if (map.id === M.PALACE_OF_BLACKTHORN) {
      if (status.checkPartyState() < 0) return 0;
      await capturedByBlackthorn();
      await this.enterTown(1);
      return 0;
    }
    tw.printText(strings.get(S.Thou_art_under_arrest_27E2));
    tw.printText(strings.get(S.Wilt_thou_come_quietly_27FE));
    let c;
    do {
      c = await getCommandKey();
      if (gameQuit()) return 0;
    } while (c !== 0x4e && c !== 0x59);
    if (c !== 0x59) {
      tw.printText(strings.get(S.No_Then_defend_thyself_285E));
      this.alertTown();
      return 1;
    }
    tw.printText(strings.get(S.Yes_The_guard_strikes_281B));
    gfx.setDrawColor(0);
    tw.printText(strings.get(S.Thou_dost_awaken_to_2845));
    map.id = M.YEW;
    map.x = 0x19;
    map.y = 4;
    view.rebuild = true;
    while (gameTime.hour !== 8) passTime(0x14);
    party.keys = 0;
    map.z = 0;
    await this.enterTown(1);
    return 0;
  }

  /** An NPC reached the party, or a conversation ended badly (mode 1). */
  async npcEncounter(mode) {
    let fight = 0, npc = npcs.eventSlot;
    const obj = npcs.state[npc].object;
    await view.worldTick();
    if (npcs.event === 0x61) {
      if (npcs.state[npc].dialogue === 0xfe) {
        tw.putChar(0x0a);
        await this.npcBegone(npc);
      } else if (map.objects.at(obj).tile !== 0x70) {
        fight = 1;
      } else {
        fight = await this.arrestParty();
      }
    } else if (mode === 0) {
      if (npcs.state[npc].dialogue !== 0 && (await conversation.talkToNpc(npc)) !== 0) fight = await this.arrestParty();
    } else {
      fight = await this.arrestParty();
    }
    if (fight) {
      npc = npcs.eventSlot;
      if (map.objects.at(npcs.state[npc].object).tile < 0x40) {
        this.removeNpc(npc);
      } else {
        tw.printText(strings.get(S.Attacked_2881));
        await this.fightNpc(npc);
      }
    }
  }

  /** A in a town. */
  async cmdAttackTown() {
    tw.printText(strings.get(S.Attack_26E0)); // "Attack-"
    if (map.getTile(map.y, map.x) < 4 && party.transport !== 0x1c) {
      tw.printText(strings.get(S.On_foot_26E8));
      return 0;
    }
    const dir = await askDirection();
    if (!dir) return 1;
    const x = (map.x + dir.dx) & 0xffff, y = (map.y + dir.dy) & 0xffff;
    if (map.getTile(y, x) === 0x9d) { // a mirror
      map.setTile(y, x, 0x9f);
      tw.printText(strings.get(S.Broken_26F2));
      for (let f = 2000; f < 20000; f += 1000) await sound.soundNoise(f, 0x78, 0x28);
      view.rebuild = true;
      return 1;
    }
    const found = findObjectAt(map.z, y, x);
    const tile = found.tile;
    let nothing = true, npc = -1;
    if (tile !== 0) {
      npc = this.npcForObject(found.slot);
      if (tile > 0x3f && (tile < 0xe8 || tile > 0xef) && (tile & 0xfc) !== 0xb4) nothing = false;
    }
    if (nothing) {
      tw.printText(strings.get(S.Nothing_to_attack_26FB));
      return 1;
    }
    if (tile < 0x80) { // a person: karma -5 and the town turns on the party
      subByteFloor0(5, party, 'karma');
      this.alertTown();
    } else if ((tile & 0xfc) === 0xd8) {
      this.alertTown();
    }
    const ground = map.getTile(y, x);
    if (ground < 0x84 || (ground > 0x85 && ground !== 0x9f && ground !== 0xab)) {
      if (npc < 0) return 1;
      this.markNpcDead(npc);
      await this.fightNpc(npc);
      return 1;
    }
    if (tile === 0x78) { // in the stocks, behind the broken mirror or in bed: can't fight back
      tw.printText(strings.get(S.Missed_270F));
      return 1;
    }
    tw.printText(strings.get(S.Murdered_2718));
    subByteFloor0(5, party, 'karma');
    await flashSquare(y, x);
    if (npc < 0) return 1;
    this.markNpcDead(npc);
    this.removeNpc(npc);
    return 1;
  }

  /** K: ladders (0xC8 up, 0xC9 down) and grates (0x86) at once; else fences and such over. */
  async cmdKlimbTown() {
    tw.printText(strings.get(S.Klimb_2723));
    if ((party.transport & 0xfe) === 0x12) {
      tw.printText(strings.get(S.On_foot_272A));
      return 0;
    }
    let t = map.getTile(map.y, map.x);
    if (t === 0x86 || t === 0xc9 || t === 0xc8) {
      dungeon.facing = t === 0xc8 ? 0 : 2;
      await this.takeStairs(0xc4, dungeon.facing);
      return 1;
    }
    const dir = await askDirection();
    if (dir) {
      t = map.getTile((map.y + dir.dy) & 0xffff, (map.x + dir.dx) & 0xffff);
      if (t !== 0x4c && t !== 0xca && t !== 0xcb) {
        tw.printText(strings.get(S.What_2735));
        return 0;
      }
      map.x = (map.x + dir.dx) & 0xff;
      map.y = (map.y + dir.dy) & 0xff;
      view.rebuild = true;
      await view.worldTick();
    }
    return 1;
  }

  /** While drunk, half the keys become a random direction ("Hic!") and the town is alerted. */
  async townReadKey(redraw) {
    if (redraw) {
      await view.worldTick();
      status.refresh();
      tw.putChar(0x0a);
      status.drawLabelLeft();
    }
    let key = await getCommandKey();
    if (this.drunkTurns !== 0 && randomBetween(1, 0) !== 0) {
      this.alertTown();
      this.drunkTurns--;
      tw.printText(strings.get(S.Hic_273C));
      key = this.drunkKeys[randomBetween(3, 0)];
    }
    return key;
  }

  /**
   * Digits set the active player, except facing a harpsichord (0x8D to the south), where they play
   * notes: the 13 notes of Stones open the secret panel in Lord British's castle (level 2).
   * Returns 3: no turn passes and the prompt isn't redrawn.
   */
  async townNumberKey(key) {
    if (view.mask[6 * 0x20 + 5] !== 0x8d) return cmdSetActivePlayer(key);
    const note = key - 0x30;
    if (sound.enabled) await sound.soundSweep(-4, 20000, 4000, 1, this.notePitch[note]);
    if (this.secretTune[this.tuneProgress] === note) {
      if (++this.tuneProgress === 0x0d) {
        this.tuneProgress = 0;
        if (map.id === M.LORD_BRITISHS_CASTLE && map.z === 2) {
          map.buffer[0x1b1] ^= 0x0b;
          await screenShake();
          view.rebuild = true;
        }
      }
    } else if (this.tuneProgress === 10 && note === 8) {
      this.tuneProgress = 3;
    } else if (this.tuneProgress === 11 && note === 7) {
      this.tuneProgress = 2;
    } else if (note === this.secretTune[0]) {
      this.tuneProgress = 1;
    } else {
      this.tuneProgress = 0;
    }
    return 3;
  }

  /** Sleepers wake; trapdoors (Stonegate's into lava), swamp, fire and lava. */
  async townTileEffects() {
    for (let i = 0; i < party.size; i++) if (party.member(i).asleep() && randomBetween(0x0f, 0) === 0x0f) party.member(i).status = 'G';
    let again;
    do {
      again = false;
      const t = map.getTile(map.y, map.x);
      if (t === 0x8c && (party.transport & 0xfe) !== 0x14) {
        tw.printText(strings.get(S.A_TRAPDOOR_2768));
        const transport = party.transport;
        party.transport = 0;
        await view.worldTick();
        await damageParty();
        party.transport = transport;
        if (map.id === M.STONEGATE) {
          gfx.setDrawColor(0);
          gfx.fillRect(0xb7, 0xb7, 8, 8);
          for (let f = 1000; f > 0xfa; f--) { // a long falling whistle
            sound.speakerOn(f);
            await sound.delayLoop(0x28, 1);
            if (gameQuit()) break;
          }
          sound.speakerOff();
          map.buffer.fill(0x8f);
          view.rebuild = true;
          for (let i = 0; i < 0x20; i++) map.objects.at(i).tile = 0;
          for (let i = 0; i < party.size; i++) {
            party.member(i).hp = 0;
            party.member(i).status = 'D';
            await sound.soundNoise(500, 3000, 0x28);
            status.drawStatusBar();
          }
        } else {
          map.z = (map.z - 1) & 0xff;
          map.loadTownLevel(1);
          again = true;
        }
      } else if (t === 4 && party.transport === 0x1c) {
        for (let i = 0; i < party.size; i++) {
          const m = party.member(i);
          if (!m.dead() && !m.poisoned() && m.dex < randomBetween(0x1d, 0)) {
            tw.printText(strings.get(S.Poisoned_2775));
            m.status = 'P';
            status.drawStatusBar();
          }
        }
      } else if (t === 0xbc || t === 0x8f) {
        await view.worldTick();
        tw.printText(strings.get(S.Burning_2780));
        await damageParty();
      }
    } while (again);
    await perTurnStatus();
  }

  /** The end of a town turn: a minute, the lamps, the tile under the party, the door, the townspeople. */
  async townEndTurn(key, result) {
    if (map.isOutdoors() || result === 0) return;
    if (status.checkPartyState() === -1) return;
    const hour = gameTime.hour;
    passTime(1);
    if (hour !== gameTime.hour && (gameTime.hour === 0x14 || gameTime.hour === 5)) this.updateLamps();
    await this.townTileEffects();
    if (map.openDoorTile !== 0 && --map.openDoorTimer === 0) restoreOpenDoor(map.openDoorY, map.openDoorX, map.openDoorTile);
    const p = map.objects.at(0);
    p.x = map.x;
    p.y = map.y;
    p.z = map.z;
    let go = party.transport < 0x12 || party.transport > 0x15 || key === 0x20 || ((this.carpetSkip = !this.carpetSkip), !this.carpetSkip);
    go = go && party.activeSpell !== 0x54 && (party.activeSpell !== 0x51 || ((this.quickSkip = !this.quickSkip), !this.quickSkip));
    if (go) {
      this.wanderHorses();
      if (result < 2) npcs.updateNpcs(gameTime.hour);
      if (npcs.eventSlot !== 0 || result === 2) await this.npcEncounter(result - 1);
    }
  }

  /** The town loop, until the party leaves (or the game ends). */
  async townMainLoop() {
    for (;;) {
      let result = 1, key = 0;
      const state = status.checkPartyState();
      if (state === 1) {
        tw.putChar(0x0a);
        status.drawLabelLeft();
        tw.printText(strings.get(S.Zzzzzz_288D));
        await waitTurns(1); // the original only redraws; this keeps it from spinning
      } else if (state === -1) {
        await partyDeath();
        result = 0;
      } else {
        if (this.justEntered === 0) {
          if (await checkMoongate()) await visitShrine();
        } else {
          this.justEntered = 0;
        }
        if (map.isOutdoors()) return;
        let redraw = true;
        do {
          key = (await this.townReadKey(redraw)) & 0xff;
          redraw = false;
          if (gameQuit()) return;
          if (key > 0x1f) {
            result = key < 0x30 || key > 0x39 ? await dispatchCommand(key) : await this.townNumberKey(key);
            continue;
          }
          switch (key) {
            case 1: case 2: case 3: case 4:
              result = (await this.townMove(key)) === 0 ? 1 : 0;
              break;
            case 5: // Ctrl-E
              tw.printText(strings.get(S.Exit_to_DOS_2898));
              if (((await getCommandKey()) & 0xff) === 0x59) {
                exitGame(0);
                return;
              }
              tw.printText(strings.get(S.N_28A6));
              break;
            case 0x0b: // Ctrl-K: the karma
              tw.printNumber(' ', 1, party.karma);
              tw.putChar(0x0a);
              result = 0;
              break;
            case 0x13: // Ctrl-S
              tw.printText(strings.get(S.Sound_28AE));
              tw.printText(strings.get(sound.enabled === 0 ? S.On_28BA : S.Off_28B5));
              sound.enabled = sound.enabled === 0 ? 1 : 0;
              result = 0;
              break;
            case 0x16: // Ctrl-V
              tw.printText(strings.get(S.N1_16_28A9));
              tw.putChar(0x0a);
              result = 0;
              break;
            default:
              tw.printText(strings.get(S.What_28BE));
              result = 0;
          }
        } while (result === 3);
      }
      if (gameQuit()) return;
      if (map.isOutdoors()) return;
      await this.townEndTurn(key, result);
      if (map.isOutdoors() || gameQuit()) return;
    }
  }
}

export const town = new Town();
