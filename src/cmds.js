// cmds.js - command handlers from CMDS.OVL, plus selectSpell (CAST2.OVL), which Mix needs. Ported
// from the C++ port's cmds.cpp.
import { askDirection, getCommandKey, readLine, readNumber, restoreOpenDoor, tilePassable, toUpper, waitTurns } from './commands.js';
import { data } from './data/gamedata.js';
import { S, strings } from './data/strings.js';
import { dissolveTile, flashSquare, screenShake } from './effects.js';
import { gameQuit } from './gamestate.js';
import { gameTime } from './gametime.js';
import { gfx } from './gfx.js';
import { input } from './input.js';
import { combat } from './combat.js';
import { dungeon } from './dungeon.js';
import { monsters } from './monsters.js';
import { M, map, passTime } from './map.js';
import { addByteCapped, randomBetween, setRandomSeed, strFindNocase, subByteFloor0, timeSeed } from './misc.js';
import { npcs } from './npc.js';
import { allocObjectSlot, findObjectAt, objectTileAt, setObjectEntry } from './objects.js';
import { isActiveMonsterTile, outdoor } from './outdoor.js';
import { party } from './party.js';
import { sound } from './sound.js';
import { spells } from './spells.js';
import { status } from './status.js';
import { textWindows as tw } from './text.js';
import { town } from './town.js';
import { view } from './view.js';
import { damageMember, damageParty, perTurnStatus, springTrap, drawSkyBar } from './world.js';

const mask = (row, col) => view.mask[row * 0x20 + col];

/**
 * The camp: everyone but the guard sleeps (a bard on guard plays first), then time passes 5
 * minutes a step until the waking hour. After the first hour each step has 1 chance in 64 of an
 * ambush by one of eight monster types; the party is woken only if a guard was posted. Returns 1
 * if a fight follows. Six hours or more undisturbed, not within 14 hours of the last rest, heal
 * 1-63 hit points and restore magic points for everyone but the guard and the poisoned; then,
 * 1 time in 4 (not in a dungeon), the apparition comes.
 */
export async function campRest(hours, guard, flags) {
  let lastHour = gameTime.hour;
  const active = party.activePlayer;
  let bard = -1, monster = -1;
  const poisoned = new Array(8).fill(0);
  party.activeSpellTurns = 0;
  party.activeSpell = 0;
  party.activePlayer = 0xff;
  if (flags & 2) await dungeon.placeCombatants(0, dungeon.here());
  else await combat.clearCombatTables();
  combat.turn = 0xff;
  let wake = hours + gameTime.hour;
  if (wake > 0x17) wake -= 0x18;
  let g = ((guard & 0xffff) << 16) >> 16;
  if (g > 5 || g < -1) g = -1;
  for (let m = 0; m < party.size; m++) {
    let slot;
    for (slot = 0; slot < 0x20; slot++) if (combat.combatants[slot].kind === m) break;
    const st = party.member(m).status;
    if (st === 'P') poisoned[m & 7]++;
    if (st !== 'G' && st !== 'P' && st !== 'S') continue;
    if (m !== g && slot < 0x20) await combat.sleepUnlessPoisoned(slot);
    if (party.member(m).cls === 'B' && m === g && sound.enabled !== 0) bard = slot;
  }
  await view.worldTick();
  if (bard !== -1) { // tile 0x5F: playing
    const o = map.objects.at(combat.combatants[bard & 0x1f].object & 0x1f);
    const tile = o.tile, tile2 = o.tile2;
    o.tile = o.tile2 = 0x5f;
    sound.tunePos = 1;
    await waitTurns(0x34);
    o.tile = tile;
    o.tile2 = tile2;
    if (combat.combatants[bard & 0x1f].kind !== g) await combat.sleepUnlessPoisoned(bard);
    await view.worldTick();
  }
  tw.printText(strings.get(S.Zzzzzz_41D4));
  let gc = null, guardTile = 0;
  if (g !== -1) {
    for (let i = 0; i < 0x20; i++)
      if (combat.combatants[i].kind === g) {
        gc = combat.combatants[i];
        break;
      }
    if (gc) guardTile = map.objects.at(gc.object & 0x1f).tile;
  }
  while (wake !== gameTime.hour && !gameQuit()) {
    if (gameTime.hour > 0x17) gameTime.hour -= 0x18;
    await view.worldTick();
    status.regenRingTick();
    status.drawStatusBar();
    if (lastHour !== gameTime.hour && randomBetween(0x3f, 0) === 0) {
      setRandomSeed(timeSeed());
      monster = monsters.ambusher(randomBetween(7, 0));
      tw.printText(strings.get(S.Ambushed_41E0));
      if (g >= 0)
        for (let slot = 0; slot < 6; slot++) {
          const m = combat.combatants[slot].kind;
          if (m >= party.size) continue;
          combat.wakeCombatant(slot);
          party.member(m).status = poisoned[m & 7] ? 'P' : 'G';
        }
      status.drawStatusBar();
      if (flags & 2) await dungeon.placeCombatants(1, dungeon.here());
      else await combat.placeMonsterGroup(monster, flags);
      break;
    }
    lastHour = gameTime.hour;
    passTime(5);
    await input.delayTicks(1);
    if (combat.prevLocation < 0x21) {
      map.id = combat.prevLocation;
      drawSkyBar();
      map.id = M.SCENE;
    }
    if (gc && randomBetween(3, 0) === 2) { // the guard paces
      let px = gc.x, py = gc.y;
      switch (randomBetween(3, 0)) {
        case 0: py--; break;
        case 1: py++; break;
        case 2: px++; break;
        case 3: px--; break;
      }
      if (combat.inCombatBounds(py, px) && combat.combatTileFree(py, px, guardTile)) {
        const o = map.objects.at(gc.object & 0x1f);
        gc.x = o.x = px;
        gc.y = o.y = py;
        await view.worldTick();
      }
    }
  }
  if (monster >= 0) return 1;
  if (gameTime.restCooldown !== 0 || hours < 6) {
    tw.printText(strings.get(S.No_effect_41FB));
  } else {
    tw.printText(strings.get(S.Party_rested_41EC));
    for (let m = 0; m < party.size; m++) {
      const pm = party.member(m);
      if (poisoned[m & 7] !== 0 || pm.dead() || m === g) continue;
      pm.hp = pm.hp + randomBetween(0x3f, 1);
      if (((pm.maxHp << 16) >> 16) < ((pm.hp << 16) >> 16)) pm.hp = pm.maxHp;
      if (pm.cls === 'A' || pm.cls === 'M') pm.mp = pm.intel;
      else if (pm.cls === 'B') pm.mp = pm.intel >> 1;
    }
    if (!(flags & 0x82) && randomBetween(99, 0) < 0x19) {
      gameTime.apparitionMonth = gameTime.month;
      await outdoor.apparitionLevelUp();
    }
    gameTime.restCooldown = 0x0e;
  }
  for (let m = 0; m < party.size; m++) if (party.member(m).asleep()) party.member(m).status = 'G';
  party.activePlayer = active;
  status.drawStatusBar();
  return 0;
}

/**
 * Esc in combat: once the battle is won (and not in a dungeon room) everything is swept off the
 * map at once, which ends it. Returns 1 if refused.
 */
export async function combatEscape() {
  tw.printText(strings.get(S.Escape_4574));
  let members = 0;
  for (let i = 0; i < 0x20; i++)
    if ((combat.combatants[i].flags & 0xa0) === 0x80) {
      members = 1;
      break;
    }
  if (members) {
    if (combat.flags & 0x80) {
      tw.printText(strings.get(S.Not_here_457B));
      status.dirty = true;
      return 1;
    }
    if (combat.victory === 0) {
      tw.printText(strings.get(S.Not_yet_4587));
      status.dirty = true;
      return 1;
    }
  }
  tw.putChar(0x21);
  for (let i = 0; i < 0x20; i++)
    if (combat.combatants[i].flags !== 0) {
      combat.combatRemove(-1 - i);
      await view.worldTick();
    }
  for (let i = 0; i < 0x20; i++)
    if (map.objects.at(i).tile !== 0) {
      combat.combatRemove(i + 1);
      await view.worldTick();
    }
  await sound.soundSlide(0x28, 1, 2000, 0x4b0);
  status.dirty = true;
  return 0;
}

/**
 * H on a bed: the town carries on for 16 turns first (an attacker cancels the rest), then everyone
 * sleeps 10 minutes at a time until the hour comes round or someone turns up. The waking hour past
 * midnight is hour + n - 23, one more than asked: kept as it is.
 */
export async function cmdHoleUpBed() {
  tw.printText(strings.get(S.For_how_many_hours_4209));
  let key;
  do {
    key = await getCommandKey();
    if (gameQuit()) return;
  } while (key !== 0x20 && (key < 0x30 || key > 0x39));
  if (key === 0x20 || key === 0x30) return;
  tw.putChar(key);
  tw.putChar(0x0a);
  let wake = gameTime.hour + key - 0x30;
  if (wake > 0x17) wake -= 0x17;
  let active = party.activePlayer;
  for (let i = 0; i < 0x10; i++) {
    npcs.updateNpcs(gameTime.hour);
    await view.worldTick();
    active = party.activePlayer;
    if (npcs.event === 0x61) return;
  }
  for (let i = 0; i < party.size; i++) if (party.member(i).good()) party.member(i).status = 'S';
  status.drawStatusBar();
  tw.printText(strings.get(S.Zzzzzzz_421E));
  gfx.setDrawColor(0);
  gfx.fillRect(0xb7, 0xb7, 8, 8);
  let prev = gameTime.hour;
  while (wake !== gameTime.hour && !gameQuit()) {
    passTime(10);
    if (prev !== gameTime.hour && (gameTime.hour === 0x14 || gameTime.hour === 5)) town.updateLamps();
    prev = gameTime.hour;
    drawSkyBar();
    await perTurnStatus();
    status.drawStatusBar();
    town.placeNpcs();
    if (findObjectAt(map.z, map.y, map.x).tile !== 0) {
      wake = 0xffff;
      break;
    }
    await input.delayTicks(1);
  }
  if (wake === 0xffff) tw.printText(strings.get(S.Thrown_out_of_bed_422A));
  for (let i = 0; i < party.size; i++) if (party.member(i).asleep()) party.member(i).status = 'G';
  map.x = (map.x + 1) & 0xff;
  view.rebuild = true;
  map.objects.at(0).x++;
  party.activePlayer = active;
  status.drawStatusBar();
  await view.worldTick();
}

function boardCheckOnFoot() {
  if (party.transport === 0x1c || party.transport === 0x1d) return true;
  tw.printText(strings.get(S.On_foot_423E));
  return false;
}

/** A ship can be boarded on foot, from a carpet or from a skiff. */
function boardCheckShipOk() {
  const t = party.transport;
  if (t < 0x14 || (t > 0x15 && (t < 0x1c || (t > 0x1d && (t < 0x28 || t > 0x2b))))) {
    tw.printText(strings.get(S.On_foot_4248));
    return false;
  }
  return true;
}

/** A view square (col x, row y) the party could step out onto. */
function isLandTile(x, y) {
  if (view.mask[x + y * 0x20] === 0) {
    const o = view.tiles[x + y * 0x10], k = o & 0xfc;
    return o === 0x1b || k === 0x1c || k === 0x24 || k === 0x10 || k === 0x28;
  }
  return tilePassable(view.mask[x + y * 0x20], 0x1c);
}

function isLandAdjacent() {
  return isLandTile(5, 4) || isLandTile(5, 6) || isLandTile(6, 5) || isLandTile(4, 5);
}

/** B: the object the party stands on becomes its transport. */
export async function cmdBoard() {
  if (map.isDungeon()) {
    tw.printText(strings.get(S.Not_here_4252));
    return 1;
  }
  const found = findObjectAt(map.z, map.y, map.x);
  const tile = found.tile, index = found.slot;
  if ((tile & 0xfe) === 0x10) {
    let npc;
    if (!map.isOutdoors() && (npc = town.npcForObject(index)) !== -1 && npcs.state[npc].dialogue !== 0) {
      tw.printText(strings.get(S.Nay_425E));
      return 1;
    }
    if (!boardCheckOnFoot()) return 1;
    tw.printText(strings.get(S.horse_4266));
    party.transport = tile + 2;
  } else if (tile === 0x1b) {
    if (!boardCheckOnFoot()) return 1;
    tw.printText(strings.get(S.carpet_426D));
    party.transport = 0x14;
  } else if ((tile & 0xfc) === 0x28) {
    if (!boardCheckOnFoot()) return 1;
    tw.printText(strings.get(S.skiff_4275));
    party.transport = tile;
  } else if ((tile & 0xfc) === 0x24) {
    if (!boardCheckShipOk()) return 1;
    tw.printText(strings.get(S.Ship_427C));
    const hull = map.objects.at(index).hull;
    if (hull < 10) tw.printText(strings.get(S.DANGER_SHIP_BADLY_4282));
    let skiffs = map.objects.at(index).skiffs;
    if ((party.transport & 0xfe) === 0x14) party.magicCarpets++;
    if ((party.transport & 0xfc) === 0x28) skiffs++;
    map.objects.at(0).hull = hull;
    if (skiffs === 0) tw.printText(strings.get(S.WARNING_NO_SKIFFS_ON_42A0));
    map.objects.at(0).skiffs = skiffs;
    status.dirty = true;
    party.transport = tile;
  } else {
    tw.printText(strings.get(S.What_42BF));
    return 0;
  }
  setObjectEntry(index, 0, 0, 0, 0, 0, 0);
  view.rebuild = true;
  return 1;
}

/** A ship fires only abeam: 3 squares; a hit takes 1-20 off the target and removes it below zero. */
async function fireShipCannons() {
  if (party.transport < 0x20 || party.transport > 0x27) {
    tw.printText(strings.get(S.What_42C6));
    return;
  }
  const dir = await askDirection();
  if (!dir) return;
  const { dx, dy } = dir;
  if (!((dx !== 0 || (party.transport & 1) !== 0) && (dx === 0 || (party.transport & 1) === 0))) {
    tw.printText(strings.get(S.Fire_broadsides_only_42CD));
    return;
  }
  let x = map.x, y = map.y, slot = 0;
  await sound.soundSlide(300, 5, 200, 1000);
  for (let n = 0; ;) {
    x += dx;
    y += dy;
    const found = findObjectAt(map.z, y, x);
    slot = found.slot;
    if (isActiveMonsterTile(found.tile) && (found.tile & 0xfc) !== 0xec) break;
    if (++n > 2) {
      await combat.animateMissile(1, dy * 3 + 5, dx * 3 + 5, 5, 5);
      return;
    }
  }
  const o = map.objects.at(slot);
  if ((await combat.animateMissile(1, o.y - map.y + 5, o.x - map.x + 5, 5, 5)) === 0) return;
  await view.worldTick();
  await flashSquare(y, x);
  o.hull = (o.hull - randomBetween(0x14, 1)) & 0xff;
  if (o.hull < 0x80) return;
  setObjectEntry(slot, 0, 0, 0, 0, 0, 0);
  view.rebuild = true;
}

/**
 * F: in a town a cannon next to the party fires 4 squares along its facing: doors are destroyed,
 * whoever it hits killed (karma -5); the town is alerted. Outdoors, a ship's broadside.
 */
export async function cmdFire() {
  if (map.isDungeon()) {
    tw.printText(strings.get(S.What_42E4));
    return;
  }
  if (map.isOutdoors()) {
    await fireShipCannons();
    return;
  }
  restoreOpenDoor(map.openDoorY, map.openDoorX, map.openDoorTile);
  let cdx, cdy, cannon;
  if ((mask(4, 5) & 0xfc) === 0xb4) { cdx = 0; cdy = -1; cannon = mask(4, 5); }
  else if ((mask(5, 6) & 0xfc) === 0xb4) { cdx = 1; cdy = 0; cannon = mask(5, 6); }
  else if ((mask(6, 5) & 0xfc) === 0xb4) { cdx = 0; cdy = 1; cannon = mask(6, 5); }
  else if ((mask(5, 4) & 0xfc) === 0xb4) { cdx = -1; cdy = 0; cannon = mask(5, 4); }
  else {
    tw.printText(strings.get(S.What_42EB));
    return;
  }
  let x = cdx + map.x, y = cdy + map.y;
  const fromX = cdx + 5, fromY = cdy + 5;
  const fdx = [0, 1, 0, -1], fdy = [-1, 0, 1, 0];
  const dx = fdx[cannon & 3], dy = fdy[cannon & 3];
  tw.printText(strings.get(S.BOOOM_42F2));
  await sound.soundSlide(300, 5, 200, 1000);
  town.alertTown();
  let door = false, hit = false, target = 0, vx = fromX, vy = fromY;
  for (let range = 5; !door && !hit && --range > 0;) {
    x += dx;
    y += dy;
    vx += dx;
    vy += dy;
    const at = objectTileAt(map.z, y, x);
    if (at.tile === 0) {
      const m = map.getTile(y, x);
      if (m > 0x96 && (m < 0x9a || (m > 0xb7 && m < 0xbc))) door = true;
    } else if ((at.tile > 0x1b && (at.tile & 0xf8) !== 0x78) || at.tile === 0x10 || at.tile === 0x11) {
      hit = true;
      target = at.slot;
    }
  }
  await combat.animateMissile(1, vy, vx, fromY, fromX);
  if (door || hit) await flashSquare(y, x);
  if (door) {
    tw.printText(strings.get(S.Door_destroyed_42FA));
    map.setTile(y, x, 0x44);
    view.rebuild = true;
    map.openDoorTile = 0;
  }
  if (hit && target !== 0) {
    setObjectEntry(target, 0, 0, 0, 0, 0, 0);
    view.rebuild = true;
    subByteFloor0(5, party, 'karma');
    const npc = town.npcForObject(target);
    if (npc === -1) return;
    town.markNpcDead(npc);
    town.removeNpc(npc);
  }
  if (hit && target === 0) await damageParty(); // object 0 is the party itself
}

/** I */
export function cmdIgniteTorch() {
  if (party.torches === 0) {
    tw.printText(strings.get(S.None_owned_430B));
    return;
  }
  party.torches--;
  if (!map.isDungeon()) party.torchLight = 0xf0;
  else addByteCapped(0xff, randomBetween(0x0f, 0) + 0x70, party, 'torchLight');
}

/** N: two members change places; the Avatar must lead. */
export async function cmdNewOrder() {
  tw.printText(strings.get(S.Swap_4318));
  const a = await status.askMemberNumber();
  if (a === -1) {
    tw.printText(strings.get(S.nobody_4320));
    return;
  }
  tw.printText(party.member(a).name);
  if (a === 0) {
    tw.printText(strings.get(S.NL_NL_4329));
    tw.printText(party.member(0).name);
    tw.printText(strings.get(S.must_lead_432C));
    return;
  }
  tw.printText(strings.get(S.with_4339));
  const b = await status.askMemberNumber();
  if (b === -1) {
    tw.printText(strings.get(S.nobody_4340));
    return;
  }
  tw.printText(party.member(b).name);
  if (b === 0) {
    tw.printText(strings.get(S.NL_NL_4349));
    tw.printText(party.member(0).name);
    tw.printText(strings.get(S.must_lead_434C));
    return;
  }
  tw.printText(strings.get(S.Bang_NL_4359));
  party.swapMembers(a, b);
  status.dirty = true;
}

/**
 * X: the transport is left on the square as an object. From a ship with furled sails and no land
 * alongside the party takes a skiff (or, with none, a carpet).
 */
export function cmdExit() {
  const tile = map.getTile(map.y, map.x);
  const kind = party.transport & 0xfc;
  let left, skiffs = 0;
  if (kind === 0x10) {
    tw.printText(strings.get(S.horse_43A4));
    left = party.transport - 2;
    party.transport = 0x1c;
  } else if (kind === 0x14) {
    if (!isLandAdjacent() && !tilePassable(tile, 0x1c)) {
      tw.printText(strings.get(!isLandAdjacent() ? S.No_land_nearby_4386 : S.Not_here_4398));
      return;
    }
    tw.printText(strings.get(S.carpet_437D));
    left = 0x1b;
    party.transport = 0x1c;
  } else if (kind === 0x1c) {
    tw.printText(strings.get(S.what_4368));
    return;
  } else if (kind === 0x20) {
    tw.printText(strings.get(S.Under_sail_436F));
    return;
  } else if (kind === 0x24) {
    tw.printText(strings.get(S.ship_43D2));
    const land = isLandAdjacent();
    left = party.transport;
    skiffs = map.objects.at(0).skiffs;
    if (land) {
      party.transport = 0x1c;
    } else if (skiffs !== 0) {
      party.transport += 4;
      skiffs--;
    } else if (party.magicCarpets !== 0) {
      party.magicCarpets--;
      party.transport = 0x14;
    } else {
      tw.printText(strings.get(S.No_skiffs_on_board_43D9));
      return;
    }
  } else if (kind === 0x28) {
    if (!isLandAdjacent()) {
      tw.printText(strings.get(S.No_land_nearby_43AC));
      return;
    }
    if ((tile & 0xfe) === 0x6a) {
      tw.printText(strings.get(S.Not_here_43BE)); // under a bridge
      return;
    }
    tw.printText(strings.get(S.skiff_43CA));
    left = party.transport;
    party.transport = 0x1c;
  } else {
    return;
  }
  const slot = allocObjectSlot();
  setObjectEntry(slot, map.objects.at(0).hull, map.z, map.y, map.x, left, left);
  map.objects.at(slot).skiffs = skiffs;
  status.drawStatusBar();
}

// The Shadowlords' names, which yelled summon them (ds:444A).
const shadowlordNames = data.words(0x444a, new Array(3).fill(0), 'cmds.shadowlordNames');

/** At the three flames, yelling a Shadowlord's name while he is still about brings him two squares north. */
async function yellSummonShadowlord(word) {
  if (map.id !== M.LYCAEUM && map.id !== M.EMPATH_ABBEY && map.id !== M.SERPENTS_HOLD) {
    tw.printText(strings.get(S.No_effect_443C));
    return;
  }
  let who;
  for (who = 0; who < 3; who++) if (strFindNocase(word, strings.get(shadowlordNames[who])) > -1) break;
  if (who === 3 || map.y <= 1 || map.shadowlordLocations[who] === 0xff) {
    tw.printText(strings.get(S.No_effect_440B));
    return;
  }
  for (let i = 0; i < 0x20; i++)
    if (map.objects.at(i).tile === 0xfc) {
      tw.printText(strings.get(S.No_effect_4418));
      return;
    }
  party.summonedShadowlord = who;
  const obj = allocObjectSlot();
  setObjectEntry(obj, 0, map.z, (map.y - 2) & 0xff, map.x, 0xfc, 0xfc);
  let npc = 0x1f;
  for (let i = 0x1f; i >= 0; i--)
    if (npcs.type[i] === 0) {
      npc = i;
      break;
    }
  const st = npcs.state[npc], sc = npcs.schedules[npc];
  st.state = 1;
  st.object = obj;
  st.x = map.x;
  st.y = (map.y - 2) & 0xffff;
  st.z = map.z;
  sc.times.fill(0);
  for (let i = 0; i < 3; i++) {
    sc.activity[i] = 6;
    sc.x[i] = map.x;
    sc.y[i] = map.y - 2;
    sc.z[i] = map.z;
  }
  npcs.type[npc] = 0xfc;
  tw.printText(strings.get(S.A_shadowlord_appears_4425));
  await sound.soundSweep(2, 2000, 30000, 1, 0x28a0);
  const o = map.objects.at(obj);
  o.tile = o.tile2 = 0x16;
  await dissolveTile(3, 5, 0x1fc);
  o.tile = o.tile2 = 0xfc;
}

/** A word of power beside a ruined shrine: the virtue and three times the mantra restore it. */
async function meditateRestoreShrine(y, x, shrine) {
  tw.printText(strings.get(S.Upon_what_virtue_dost_4450));
  let buf = await readLine(0x0f);
  let ok = strFindNocase(buf, strings.get(map.virtueNames[shrine])) !== -1;
  for (let i = 3; i !== 0; i--) {
    tw.printText(strings.get(S.Mantra_4479));
    buf = await readLine(0x0f);
    if (strFindNocase(buf, strings.get(map.mantras[shrine])) === -1) ok = false;
  }
  if (ok && map.shrineXs[shrine] === x && map.shrineYs[shrine] === y) {
    map.shrineState[shrine] &= 0x7f;
    tw.printText(strings.get(S.The_Shrine_is_restored_4482));
    await screenShake();
    map.setTile(y, x, 0x19);
    view.rebuild = true;
  } else {
    tw.putChar(0x0a);
  }
}

/** The eight words seal or unseal a dungeon whose entrance is next to the party. */
async function yellWordOfPower(word) {
  for (let n = 0; n < 8; n++) {
    if (strFindNocase(word, strings.get(map.wordsOfPower[n])) < 0) continue;
    tw.printText(strings.get(S.A_word_of_power_is_44D7));
    await screenShake();
    const dxs = [-1, 0, 1, 0], dys = [0, 1, 0, -1];
    let d, t = 0;
    for (d = 0; d < 4; d++) {
      t = mask(5 + dys[d], 5 + dxs[d]);
      if (t === map.sealTiles[n] || t === 0xdf || t === 0x1a) break;
    }
    if (d === 4) break;
    const x = (map.x + dxs[d]) & 0xffff, y = (map.y + dys[d]) & 0xffff;
    if (t === 0x1a) {
      await meditateRestoreShrine(y, x, n);
      return;
    }
    if (x === map.exitX(0x21 + n) && y === map.exitY(0x21 + n)) {
      map.dungeonSeals[n] ^= 0x80;
      map.setTile(y, x, map.getTile(y, x) ^ map.sealTiles[n] ^ 0xdf);
      view.rebuild = true;
    }
    return;
  }
  tw.printText(strings.get(S.No_effect_44F4));
}

/** Y: on a ship it furls or hoists the sails; else a word. */
export async function cmdYell() {
  if ((party.transport & 0xf8) === 0x20 && !map.inScene()) {
    if ((party.transport & 0xfc) === 0x20) {
      tw.printText(strings.get(S.FURL_451A));
      party.transport += 4;
    } else {
      tw.printText(strings.get(S.HOIST_4521));
      party.transport -= 4;
    }
    return 1;
  }
  tw.printText(strings.get(S.what_4529));
  const buf = await readLine(0x1e);
  if (buf === '') {
    tw.printText(strings.get(S.Nothing_4531));
    return 1;
  }
  tw.putChar(0x0a);
  if (map.isOutdoors()) await yellWordOfPower(buf);
  else if (!map.onTileMap()) tw.printText(strings.get(S.No_effect_453A));
  else await yellSummonShadowlord(buf);
  return 1;
}

/** 0x5B, chairs, desks, barrels, 0xA8, 0xA9, 0xAD-0xAF, cannons. */
function isPushableTile(tile) {
  if (tile < 0xa7) return !(tile < 0xa5 && tile !== 0x5b && (tile < 0x90 || tile > 0x93));
  if (tile < 0xa8) return false;
  if (tile > 0xa9) {
    if (tile < 0xad) return false;
    if (tile > 0xaf && (tile < 0xb4 || tile > 0xb7)) return false;
  }
  return true;
}

/** Chairs and cannons turn to face the way they were pushed (the opposite when pulled). */
function rotatePushedTile(pulled, tile, dy, dx) {
  if (dx === 1 && dy === 0) tile += 1;
  if (dx === 0 && dy === 1) tile += 2;
  if (dx === -1 && dy === 0) tile += 3;
  if (pulled) tile ^= 2;
  return tile;
}

/**
 * P: the thing moves on a square if the floor beyond is plain (0x44; for a cannon 0x45); if not,
 * and the pusher stands on such floor, the two change places ("Pulled!"). The pusher steps in.
 */
export async function cmdPush() {
  restoreOpenDoor(map.openDoorY, map.openDoorX, map.openDoorTile);
  const dir = await askDirection();
  if (!dir) return;
  const { dx, dy } = dir;
  const partyX = map.x, partyY = map.y;
  const inCombat = map.inScene();
  if (inCombat) { // the pusher is the fighter whose turn it is
    map.x = combat.combatants[combat.turn & 0x1f].x;
    map.y = combat.combatants[combat.turn & 0x1f].y;
  }
  const x = (dx + map.x) & 0xffff, y = (dy + map.y) & 0xffff;
  if (inCombat && (await combat.combatRoomTrigger(y, x)) !== 0) return; // (the party position stays the fighter's, as in the original)
  const tile = map.getTile(y, x);
  if (findObjectAt(map.z, y, x).tile !== 0 || !isPushableTile(tile)) {
    tw.printText(strings.get(S.Won_t_budge_4559));
    return;
  }
  const floor = (tile & 0xfc) === 0xb4 ? 0x45 : 0x44;
  const x2 = (x + dx) & 0xffff, y2 = (y + dy) & 0xffff;
  const beyond = map.getTile(y2, x2);
  const here = map.getTile(map.y, map.x);
  if (findObjectAt(map.z, y2, x2).tile === 0 && beyond === floor) {
    tw.printText(strings.get(S.Pushed_4547));
    map.setTile(y2, x2, tile);
    map.setTile(y, x, beyond);
    const k = tile & 0xfc;
    if (k === 0x90 || k === 0xb4) map.setTile(y2, x2, rotatePushedTile(false, k, dy, dx));
  } else if (here === floor) {
    tw.printText(strings.get(S.Pulled_4550));
    map.setTile(map.y, map.x, tile);
    map.setTile(y, x, here);
    const k = tile & 0xfc;
    if (k === 0x90 || k === 0xb4) map.setTile(map.y, map.x, rotatePushedTile(true, k, dy, dx));
  } else {
    tw.printText(strings.get(S.Won_t_budge_4567));
    return;
  }
  map.x = (map.x + dx) & 0xff;
  map.y = (map.y + dy) & 0xff;
  view.rebuild = true;
  if (inCombat) {
    const c = combat.combatants[combat.turn & 0x1f];
    const o = map.objects.at(c.kind & 0x1f); // the original indexes the objects by `kind`, not `object`
    c.x = c.x + dx;
    c.y = c.y + dy;
    o.x = o.x + dx;
    o.y = o.y + dy;
    map.x = partyX;
    map.y = partyY;
    await view.worldTick();
  }
}

/** The reagents owned listed in the status window; arrows move, Return marks, M mixes, Esc gives up. */
async function mixSelectReagents() {
  const list = [];
  for (let i = 0; i < 8; i++) if (party.reagents[i] !== 0) list.push(i);
  tw.selectTextWindow(1);
  tw.defineTextWindow(9, 0x26, 1, 0x18, 1);
  tw.putChar(0xff);
  tw.defineTextWindow(9, 0x27, 1, 0x18, 1);
  status.clearSidePanel();
  status.drawPanelTitle(strings.get(S.Reagents_8F64));
  for (const r of list) {
    tw.putChar(0x0a);
    tw.putChar(0x20);
    tw.printNumber('0', 2, party.reagents[r]);
    tw.putChar(0x20);
    tw.printText(spells.reagentName(r));
  }
  let cur = 0, done = false, maskBits = 0;
  status.highlightMemberRow(1);
  while (!done) {
    tw.selectTextWindow(2);
    let key = await getCommandKey();
    if (gameQuit()) key = 0x1b;
    if (key === 4 || key === 2) {
      if (cur < list.length - 1) {
        status.highlightMemberRow(cur + 1);
        cur++;
        status.highlightMemberRow(cur + 1);
      }
    } else if (key === 1 || key === 3) {
      if (cur > 0) {
        status.highlightMemberRow(cur + 1);
        cur--;
        status.highlightMemberRow(cur + 1);
      }
    } else if (key === 0x0d || key === 0x20) {
      const bit = 0x80 >>> (list[cur] & 0x1f);
      maskBits ^= bit;
      tw.selectTextWindow(1);
      tw.setCursor(cur + 1, 3);
      tw.putChar(0xfd);
      tw.putChar((bit & maskBits) === 0 ? 0x20 : 0x0f);
      tw.putChar(0xfd);
    } else if (key === 0x1b) {
      maskBits = 0xffff;
      done = true;
      tw.putChar(0x0a);
    } else if (key === 0x4d) {
      done = true;
      tw.printText(strings.get(S.NL_NL_8F6E));
    }
  }
  status.highlightMemberRow(cur + 1);
  tw.selectTextWindow(2);
  return maskBits;
}

async function mixAskAmount(reagentMask) {
  for (;;) {
    let ok = true;
    tw.printText(strings.get(S.How_much_8F72));
    const n = (await readNumber(2)) & 0xffff;
    if (n !== 0)
      for (let i = 0; i < 8; i++)
        if ((reagentMask & (0x80 >>> i)) !== 0 && party.reagents[i] < n) {
          tw.printText(strings.get(S.Insufficient_reagents_8F7E));
          ok = false;
          break;
        }
    if (ok || gameQuit()) return n;
  }
}

/** M: the reagents are used up whatever the spell; a wrong recipe goes off like a trap. */
export async function cmdMixReagents() {
  let total = 0;
  for (let i = 0; i < 8; i++) total += party.reagents[i];
  if (total === 0) {
    tw.printText(strings.get(S.No_reagents_owned_8F98));
    return;
  }
  tw.printText(strings.get(S.For_what_spell_8FAC));
  const spell = await selectSpell();
  if (spell === -1) {
    tw.printText(strings.get(S.None_8FBE));
  } else {
    tw.putChar(0x0a);
    for (const c of [0x1b, 0x2c, 0x1a, 0x2c, 0x18, 0x2c, 0x19]) tw.putChar(c);
    tw.printText(strings.get(S.to_move_RETURN_selects_8FC6));
    const m = await mixSelectReagents();
    let amount;
    if (((m << 16) >> 16) >= 0 && (amount = ((await mixAskAmount(m)) << 16) >> 16) >= 1) {
      if (m === 0) {
        tw.printText(strings.get(S.Nothing_to_mix_9004));
      } else {
        tw.printText(strings.get(S.Mixing_8FF0));
        if (map.onTileMap()) await waitTurns(10);
        else await input.delayTicks(10);
        for (let i = 0; i < 8; i++) if ((0x80 >>> i) & m) party.reagents[i] = (party.reagents[i] - amount) & 0xff;
        if (spell < 0 || spells.recipe(spell) !== m) {
          tw.putChar(0x0a);
          await springTrap(party.firstAble());
        } else {
          tw.printText(strings.get(S.Done_8FFC));
          party.mixedSpells[spell] = Math.min(99, party.mixedSpells[spell] + amount);
        }
      }
    }
  }
  status.drawPanelTopBar();
  status.drawPanelBottomBar();
  status.drawStatusBar();
}

/** K outdoors: with a grapple, on foot, onto low mountains (0x0C); a failed DEX roll falls for 1-5. */
export async function cmdKlimbGrapple() {
  if (party.grapples === 0) {
    tw.printText(strings.get(S.With_what_9016));
    return;
  }
  if (party.transport !== 0x1c) {
    tw.printText(strings.get(S.On_foot_9022));
    return;
  }
  const dir = await askDirection();
  if (!dir) return;
  const t = map.getTile((map.y + dir.dy) & 0xffff, (map.x + dir.dx) & 0xffff);
  if (t === 0x0d) {
    tw.printText(strings.get(S.Impassable_902C));
  } else if (t === 0x0c) {
    for (let i = 0; i < party.size; i++)
      if (!party.member(i).dead() && party.member(i).dex < randomBetween(0x1e, 1)) {
        tw.printText(strings.get(S.Fell_904A));
        await damageMember(randomBetween(5, 1), i);
      }
    map.outdoorStep(dir.dy, dir.dx);
  } else {
    tw.printText(strings.get(S.Not_climbable_903A));
  }
}

/**
 * CAST2 e2be: a spell typed as the first letters of its words (IN LOR = "IL"), each printing its
 * syllable. Up to four; Backspace, Return or Space, Esc. Sorted, repeats dropped, matched against
 * the 48 entries. Index 0-47, -1 nothing typed, -2 no such spell.
 */
export async function selectSpell() {
  const letters = [], cols = [];
  let done = false;
  while (!done) {
    const key = toUpper(await getCommandKey()) & 0xff;
    if (gameQuit()) return -1;
    if (key === 0x4a || key === 0x4f) continue;
    if (key >= 0x41 && key <= 0x5a && letters.length <= 3) {
      const syllable = spells.syllable(key);
      if (tw.getCursorCol() + syllable.length > 0x0d) tw.putChar(0x0a);
      cols.push(tw.getCursorCol());
      letters.push(key);
      tw.printText(syllable);
      tw.putChar(0x20);
    } else if (key === 8) {
      if (letters.length !== 0) {
        const row = tw.getCursorCol() === 0 ? tw.getCursorRow() - 1 : tw.getCursorRow();
        const col = cols[cols.length - 1];
        tw.setCursor(row, col);
        for (let len = spells.syllable(letters[letters.length - 1]).length; len > 0; len--) tw.putChar(0x20);
        tw.setCursor(tw.getCursorRow(), col);
        letters.pop();
        cols.pop();
      }
    } else if (key === 0x0d || key === 0x20) {
      done = true;
    } else if (key === 0x1b) {
      letters.length = 0;
      done = true;
    }
  }
  letters.sort((a, b) => a - b);
  const n = letters.length;
  let spell = -1;
  for (let s = 0; s < 0x30 && spell < 0; s++) {
    const want = spells.letters(s);
    let match = true, k = 0;
    for (let i = 0; i < n; i++, k++) {
      if (want.charCodeAt(k) !== letters[i]) {
        match = false;
        break;
      }
      while (i < n - 1 && letters[i + 1] === letters[i]) i++;
    }
    if (match && k < want.length) match = false;
    if (match) spell = s;
  }
  if (n === 0) return -1;
  tw.putChar(0x0a);
  return spell < 0 ? -2 : spell;
}
