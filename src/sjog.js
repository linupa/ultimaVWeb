// sjog.js - Search, Jimmy, Open and Get (SJOG.OVL). Ported from the C++ port's sjog.cpp; the
// dungeon versions are in dungeon.js.
import { combat } from './combat.js';
import { dungeon } from './dungeon.js';
import { askDirection, restoreOpenDoor } from './commands.js';
import { data } from './data/gamedata.js';
import { S, strings } from './data/strings.js';
import { gameTime } from './gametime.js';
import { items } from './items.js';
import { M, map } from './map.js';
import { addByteCapped, addWordCapped, randomBetween, subByteFloor0 } from './misc.js';
import { npcs } from './npc.js';
import { allocObjectSlot, findObjectAt, objectTileAt, setObjectEntry } from './objects.js';
import { party } from './party.js';
import { sound } from './sound.js';
import { status } from './status.js';
import { textWindows as tw } from './text.js';
import { town } from './town.js';
import { view } from './view.js';
import { askWhichMember, springTrap } from './world.js';

function findFreeObjectSlot() {
  for (let i = 0x1f; i >= 0; i--) if (map.objects.at(i).tile === 0) return i;
  return 0;
}

/** A chest (tile 1) on the square, else 0x20. */
function chestAt(y, x) {
  let i;
  for (i = 1; i < 0x20; i++) {
    const o = map.objects.at(i);
    if (o.x === x && o.y === y && (map.inScene() || o.z === map.z) && o.tile === 1) break;
  }
  return i;
}

function printFoundItem(kind) {
  const texts = {
    1: S.a_chest_850E, 2: S.a_sack_of_gold_8518, 3: S.a_potion_852A, 4: S.a_scroll_8536, 5: S.a_weapon_8542, 6: S.a_shield_854E,
    7: S.a_ring_of_keys_855A, 8: S.a_gem_856C, 9: S.a_helm_8574, 0x0a: S.a_ring_857E, 0x0b: S.some_armour_8588, 0x0c: S.an_amulet_8596,
    0x0d: S.some_torches_85A2, 0x0f: S.some_food_85B2, 0x19: S.a_strange_rock_85BE, 0x1e: S.a_rotting_body_85D0, 0x1f: S.a_moldy_corpse_85E2,
  };
  tw.printText(strings.get(texts[kind] ?? S.Nothing_of_note_85F4));
}

/** 1 in 8 a body turns into food or gold; else it is gone, 1 in 32 with the plague. */
async function searchBody(member, object) {
  if (randomBetween(7, 0) === 0) {
    let kind;
    if (randomBetween(3, 0) === 0) {
      tw.printText(strings.get(S.food_863A));
      kind = 0x0f;
    } else {
      tw.printText(strings.get(S.gold_8642));
      kind = 2;
    }
    const o = map.objects.at(object);
    o.tile = o.tile2 = kind;
    o.hull = randomBetween(3, 1);
    view.rebuild = true;
    await view.worldTick();
    return;
  }
  setObjectEntry(object, 0, 0, 0, 0, 0, 0);
  if (randomBetween(0x1f, 0) === 0x13) {
    tw.printText(strings.get(S.Plague_8606));
    await sound.soundNoise(500, 3000, 0x28);
    party.member(member).status = 'P';
    status.dirty = true;
    return;
  }
  const texts = [S.nothing_8610, S.worms_861A, S.guts_8622, S.a_bloody_pulp_862A];
  tw.printText(strings.get(texts[randomBetween(randomBetween(3, 0), 0)]));
}

/** The searcher's roll against (30 - INT [+ trap level]) / 2; a failed roll gives the wrong answer. */
function searchChestTrap(member, object) {
  const hull = map.objects.at(object).hull, intel = party.member(member).intel;
  const v = (hull & 0x80 ? (hull & 0x7f) - intel + 0x1e : 0x1e - intel) & 0xffff;
  const ok = ((v >> 1) << 16) >> 16 <= randomBetween(0x1e, 1);
  const trapped = (hull & 0x80) !== 0;
  const level = hull & 0x7f;
  if ((ok && !trapped) || (!ok && trapped)) tw.printText(strings.get(S.no_trap_864A));
  else if (ok && level < 10) tw.printText(strings.get(S.a_simple_trap_8654));
  else if (ok && level > 0x14) tw.printText(strings.get(S.a_complex_trap_8664));
  else tw.printText(strings.get(S.a_trap_8676));
}

/** A moonstone buried here that isn't already lying on the square becomes an object (0x19). */
function searchMoonstone(z, y, x) {
  for (let i = 7; i >= 0; i--) {
    if (map.moonstoneX[i] !== x || map.moonstoneY[i] !== y || map.moonstoneZ[i] !== z || map.moonstoneLoc[i] !== map.id) continue;
    const found = findObjectAt(z, y, x);
    if (found.tile === 0x19 && map.objects.at(found.slot & 0x1f).hull === i) continue;
    const slot = allocObjectSlot();
    setObjectEntry(slot, i, z, y, x, 0x19, 0x19);
    tw.printText(strings.get(S.a_strange_rock_8680));
    view.rebuild = true;
    return true;
  }
  return false;
}

// Three spots in Britannia give 2-15 mandrake or nightshade between midnight and one, once a day
// each: x (ds:3E66), y (ds:3E6A), the reagent (ds:3E6E) and its name (ds:3E72).
const reagentSpotX = data.bytes(0x3e66, new Uint8Array(4), 'sjog.reagentSpotX');
const reagentSpotY = data.bytes(0x3e6a, new Uint8Array(4), 'sjog.reagentSpotY');
const reagentSpotKind = data.bytes(0x3e6e, new Uint8Array(4), 'sjog.reagentSpotKind');
const reagentSpotName = data.words(0x3e72, new Array(3).fill(0), 'sjog.reagentSpotName');

function searchReagentSpot(y, x) {
  for (let i = 0; i < 3; i++) {
    if (reagentSpotX[i] !== x || reagentSpotY[i] !== y || gameTime.hour !== 0 || gameTime.reagentSpotDay[i] === gameTime.day) continue;
    gameTime.reagentSpotDay[i] = gameTime.day;
    const reagent = reagentSpotKind[i] & 7;
    const n = randomBetween(0x0f, 2);
    party.reagents[reagent] = Math.min(99, party.reagents[reagent] + n);
    tw.printNumber(' ', n < 10 ? 1 : 2, n);
    tw.printText(strings.get(S.sprigs_of_86BE));
    tw.printText(strings.get(reagentSpotName[i]));
    tw.printText(strings.get(S.NL_86CA));
    return true;
  }
  return false;
}

// 113 hidden things, six parallel tables of 0x72 bytes: kind, amount, location, level, x, y. Each
// is found once (searchFoundBits), except 13 (a key) whenever the party has none, 14 once a day,
// 15 whenever the party has none of item 0x27 - as long as nothing lies there already.
const HIDDEN = 0x72;
const hiddenKind = data.bytes(0x3e78, new Uint8Array(HIDDEN), 'sjog.hiddenKind');
const hiddenAmount = data.bytes(0x3eea, new Uint8Array(HIDDEN), 'sjog.hiddenAmount');
const hiddenPlace = data.bytes(0x3f5c, new Uint8Array(HIDDEN), 'sjog.hiddenPlace');
const hiddenLevel = data.bytes(0x3fce, new Uint8Array(HIDDEN), 'sjog.hiddenLevel');
const hiddenX = data.bytes(0x4040, new Uint8Array(HIDDEN), 'sjog.hiddenX');
const hiddenY = data.bytes(0x40b2, new Uint8Array(HIDDEN), 'sjog.hiddenY');

async function searchHiddenItem(y, x) {
  let found = false, i;
  for (i = 0; i <= 0x70; i++) {
    if (hiddenPlace[i] !== map.id || hiddenLevel[i] !== map.z || hiddenX[i] !== x || hiddenY[i] !== y) continue;
    if ((i !== 0x0d || party.keys !== 0 || findObjectAt(map.z, y, x).tile !== 0) &&
        (i !== 0x0e || gameTime.day === gameTime.hiddenItemDay) &&
        (i !== 0x0f || party.inventory[0x27] !== 0 || findObjectAt(map.z, y, x).tile !== 0)) {
      const bit = 1 << (i & 7);
      if ((bit & map.searchFoundBits[i >> 3]) !== 0 || (i > 0x0c && i < 0x10)) continue;
      map.searchFoundBits[i >> 3] |= bit;
    }
    found = true;
    break;
  }
  if (i === 0x0e) gameTime.hiddenItemDay = gameTime.day;
  if (!found) {
    tw.printText(strings.get(S.nothing_of_note_86CC));
    return;
  }
  const slot = allocObjectSlot();
  const kind = hiddenKind[i];
  setObjectEntry(slot, hiddenAmount[i], hiddenLevel[i], hiddenY[i], hiddenX[i], kind, kind);
  view.rebuild = true;
  printFoundItem(kind);
}

/** S */
export async function cmdSearch() {
  if (map.isDungeon()) {
    await dungeon.dungeonSearch();
    return;
  }
  const dir = await askDirection();
  if (!dir) return;
  const x = (map.x + dir.dx) & 0xffff, y = (map.y + dir.dy) & 0xffff;
  const member = await askWhichMember();
  if (member === -1) return;
  const t = map.getTile(y, x);
  const chest = chestAt(y, x);
  if (chest < 0x20) {
    tw.printText(strings.get(S.Thou_dost_find_892C));
    searchChestTrap(member, chest);
    return;
  }
  const at = objectTileAt(map.z, y, x);
  if (at.tile === 0x1f) {
    tw.printText(strings.get(S.Thou_dost_find_893E));
    await searchBody(member, at.slot);
    return;
  }
  const where = {
    0x2b: S.In_the_stump_t_8950, 0x4f: S.In_the_wall_t_8A24, 0x5a: S.On_the_shelf_t_8960, 0x5c: S.In_the_bookshelf_t_8970,
    0x5d: S.In_the_bookshelf_t_8970, 0xa1: S.Near_the_well_t_8984, 0xa5: S.In_the_desk_t_8996, 0xa6: S.In_the_barrel_t_89A6,
    0xa8: S.In_the_vanity_t_89B8, 0xab: S.Under_the_bed_t_89CA, 0xac: S.Under_the_bed_t_89CA, 0xad: S.In_the_dresser_t_89DC,
    0xaf: S.In_the_trunk_t_89EE, 0xb2: S.In_the_brazier_t_8A12, 0xbc: S.In_the_fireplace_t_89FE,
  };
  tw.printText(strings.get(where[t] ?? S.T_8A34));
  tw.printText(strings.get(S.hou_dost_find_8A38));
  if (t === 0x4e) { // a secret door becomes a door (locked above ground)
    tw.printText(strings.get(S.a_hidden_door_8A48));
    map.setTile(y, x, map.z < 0x80 ? 0xb9 : 0xb8);
    view.rebuild = true;
  } else if ((t === 0xdc || !searchMoonstone(map.z, y, x)) && !searchReagentSpot(y, x)) {
    await searchHiddenItem(y, x);
  }
}

/** Disarms a trapped chest on a roll above (trap level - DEX + 30) / 2; else the key breaks. */
async function jimmyChest(object) {
  const member = await askWhichMember();
  if (member === -1) return;
  const hull = map.objects.at(object).hull;
  if (hull >= 0x80) {
    const need = (((hull & 0x7f) - party.member(member).dex + 0x1e) >>> 1) & 0xff;
    if (need < randomBetween(0x1e, 1)) {
      tw.printText(strings.get(S.Success_8A64));
      map.objects.at(object).hull &= 0x7f;
      return;
    }
    tw.printText(strings.get(S.Key_broke_8A6E));
  } else {
    tw.printText(strings.get(S.Key_broke_8A58));
  }
  await sound.soundSlide(0x32, 1, 2000, 800);
  party.keys = (party.keys - 1) & 0xff;
}

/** J: locked doors on a DEX roll; magic doors break the key; prisoners freed (karma +2); chests. */
export async function cmdJimmy() {
  if (map.isDungeon()) {
    await dungeon.dungeonJimmy();
    return;
  }
  if (party.keys === 0) {
    tw.printText(strings.get(S.No_Keys_8AD0));
    return;
  }
  const dir = await askDirection();
  if (!dir) return;
  const x = (map.x + dir.dx) & 0xffff, y = (map.y + dir.dy) & 0xffff;
  const t = map.getTile(y, x);
  if (t === 0x97 || t === 0x98) {
    tw.printText(strings.get(S.Key_broke_8AF2));
    party.keys--;
    return;
  }
  if (t === 0x84 || t === 0x85) {
    // In a scene the original doesn't look for the person and goes on with the direction's dx as the object.
    let slot = dir.dx & 0xffff;
    if (!map.inScene()) {
      const found = findObjectAt(map.z, y, x);
      if (found.tile === 0) {
        tw.printText(strings.get(S.No_one_is_there_8AFE));
        return;
      }
      slot = found.slot;
    }
    const member = await askWhichMember();
    if (member === -1) return;
    if (party.member(member).dex <= randomBetween(0x1d, 0)) {
      tw.printText(strings.get(S.Key_broke_8B10));
      party.keys--;
      return;
    }
    if (map.id >= 0x7f) { // in combat the manacles just open
      map.setTile(y, x, 0x44);
      view.rebuild = true;
      tw.printText(strings.get(S.Unlocked_8B48));
      return;
    }
    const npc = town.npcForObject(slot);
    if (npc === -1) {
      tw.printText(strings.get(S.Couldn_t_find_this_npc_8B1C));
      return;
    }
    if (npcs.state[npc].dialogue !== 0) npcs.state[npc].dialogue = 0;
    if (town.npcIsDead(npc) === 0) {
      npcs.schedules[npc].activity.fill(5);
      tw.printText(strings.get(S.I_thank_thee_8B36));
      addByteCapped(99, 2, party, 'karma');
    }
    town.markNpcDead(npc);
    return;
  }
  if (t === 0xb9 || t === 0xbb) {
    const member = await askWhichMember();
    if (member === -1) return;
    if (party.member(member).dex <= randomBetween(0x1d, 0)) {
      tw.printText(strings.get(S.Key_broke_8ADA));
      party.keys--;
      return;
    }
    map.setTile(y, x, t - 1);
    view.rebuild = true;
    tw.printText(strings.get(S.Unlocked_8AE6));
    return;
  }
  const chest = chestAt(y, x);
  if (chest < 0x20) await jimmyChest(chest);
  else tw.printText(strings.get(S.No_lock_8B52));
}

/** A chest holds 1 to `level` things and gold 1 to 3 x level; potions and scrolls get a type 0-7. */
async function spawnChestItem(state, level, z, y, x, amount, kind) {
  if (kind === 3 || kind === 4) amount = (amount - 1) & 0xff;
  if (kind === 1) amount = randomBetween(level, 1) & 0xff;
  else if (kind === 2) amount = randomBetween(level * 3, 1) & 0xff;
  const slot = findFreeObjectSlot();
  if (slot === 0) return;
  setObjectEntry(slot, amount, z, y, x, kind, kind);
  const o = map.objects.at(slot);
  if (!map.inScene()) {
    o.skiffs = 0;
    o.z = z;
  } else {
    o.skiffs = 0x20;
  }
  view.rebuild = true;
  await view.worldTick();
  if (!state.found) {
    tw.printText(strings.get(S.Found_8B5C));
    state.found = true;
  }
  printFoundItem(kind);
}

// The eight kinds of thing a chest can hold (ds:4124), the lowest chest level each appears at
// (ds:412C), and the most of each (ds:4134).
const chestItemKind = data.bytes(0x4124, new Uint8Array(8), 'sjog.chestItemKind');
const chestItemMinLevel = data.bytes(0x412c, new Uint8Array(8), 'sjog.chestItemMinLevel');
const chestItemMaxCount = data.bytes(0x4134, new Uint8Array(8), 'sjog.chestItemMaxCount');

async function chestRollItems(state, z, y, x, level) {
  for (let i = 7; i >= 0; i--) {
    if (chestItemMinLevel[i] > level) continue;
    if (chestItemMinLevel[i] > randomBetween(0x1e, 1)) continue;
    const amount = chestItemMaxCount[i] === 1 ? 1 : randomBetween(chestItemMaxCount[i], 1);
    await spawnChestItem(state, level, z, y, x, amount, chestItemKind[i]);
  }
}

// level / 2 + 1 tries: a random item 0-47 appears on the same two tests against its level (ds:416C,
// 0xFF never); its kind is at ds:413C.
const equipmentKind = data.bytes(0x413c, new Uint8Array(48), 'sjog.equipmentKind');
const equipmentLevel = data.bytes(0x416c, new Uint8Array(48), 'sjog.equipmentLevel');

async function chestRollEquipment(state, z, y, x, level) {
  for (let n = level >> 1; n >= 0; n--) {
    const item = randomBetween(0x2f, 0);
    const min = equipmentLevel[item];
    if (min > level) continue;
    if (min > randomBetween(0x1e, 1)) continue;
    await spawnChestItem(state, level, z, y, x, item, equipmentKind[item]);
  }
}

/** Opening a chest in a town costs 2 karma; the contents are rolled now, from the chest's level. */
async function openChest(z, y, x) {
  let i;
  for (i = 1; i < 0x20; i++) {
    const o = map.objects.at(i);
    if (o.x !== x || o.y !== y || !(map.inScene() || o.z === z)) continue;
    if (o.tile === 1) break;
    if (o.tile === 0x0e) {
      tw.printText(strings.get(S.Can_t_8B64)); // the sandalwood box
      return;
    }
  }
  if (i === 0x20) {
    tw.printText(strings.get(S.Nothing_to_open_8B6C));
    return;
  }
  const member = await askWhichMember();
  if (member === -1) return;
  let level = map.objects.at(i).hull;
  setObjectEntry(i, 0, 0, 0, 0, 0, 0);
  view.rebuild = true;
  if (map.isTown()) subByteFloor0(2, party, 'karma');
  if (level > 0x7f) {
    level &= 0x7f;
    tw.printText(strings.get(S.Trapped_8B7E));
    await springTrap(member);
    if (map.inScene() && member >= 0 && party.member(member).dead()) { // killed in combat
      for (let c = 0; c < 0x20; c++) {
        const cb = combat.combatants[c];
        if ((cb.flags & 0x80) && cb.kind === member) {
          cb.flags |= 0x20;
          const o = map.objects.at(cb.object & 0x1f);
          o.tile = o.tile2 = 0x1e;
          break;
        }
      }
      if (member === party.activePlayer) party.activePlayer = 0xff;
      await view.worldTick();
    }
  }
  const state = { found: false };
  await chestRollItems(state, z, y, x, level);
  await chestRollEquipment(state, z, y, x, level);
  if (!state.found) tw.printText(strings.get(S.Chest_empty_8B88));
}

/** O: doors open for 4 turns; locked ones and portcullises don't; else a chest. */
export async function cmdOpen() {
  if (map.isDungeon()) {
    await dungeon.dungeonOpenChest();
    return;
  }
  restoreOpenDoor(map.openDoorY, map.openDoorX, map.openDoorTile);
  const dir = await askDirection();
  if (!dir) return;
  const x = (map.x + dir.dx) & 0xffff, y = (map.y + dir.dy) & 0xffff;
  const t = map.getTile(y, x);
  if (t === 0xaf) {
    tw.printText(strings.get(S.It_s_open_8BBE));
  } else if (t === 0x99) {
    tw.printText(strings.get(S.Too_heavy_8BCA));
  } else if (t === 0xb9 || t === 0xbb || t === 0x97 || t === 0x98) {
    tw.printText(strings.get(S.Locked_8BD6));
  } else if (t === 0xb8 || t === 0xba) {
    map.openDoorTimer = 4;
    map.openDoorX = x;
    map.openDoorY = y;
    map.openDoorTile = t;
    map.setTile(y, x, 0x44);
    view.rebuild = true;
    tw.printText(strings.get(S.Opened_8BE0));
  } else {
    await openChest(map.z, y, x);
  }
}

export function getItem(slot, amount, kind) {
  switch (kind) {
    case 1:
      tw.printText(strings.get(S.Open_it_first_8C3E));
      return;
    case 2:
      tw.printNumber(' ', 1, amount);
      tw.printText(strings.get(S.gold_8CF0));
      addWordCapped(9999, amount, party, 'gold');
      break;
    case 3:
      tw.printText(strings.get(S.A_8CF8));
      tw.printText(items.potionColour(amount));
      tw.printText(strings.get(S.potion_8CFC));
      if (++party.potions[amount & 7] === 100) party.potions[amount & 7] = 99;
      break;
    case 4:
      if (amount === 0xff) {
        tw.printText(strings.get(S.The_plans_for_the_HMS_8CC2));
        party.hmsCapePlans = 0xff;
      } else {
        tw.printText(strings.get(S.A_scroll_8CE0));
        tw.selectFont(1);
        tw.printText(items.scrollLetters(amount));
        tw.selectFont(0);
        tw.printText(strings.get(S.Bang_NL_8CEC));
        if (++party.scrolls[amount & 7] === 100) party.scrolls[amount & 7] = 99;
      }
      break;
    case 7:
      if (amount < 0x80) {
        tw.printNumber(' ', 1, amount);
        tw.printText(strings.get(S.key_8CB4));
        addByteCapped(99, amount, party, 'keys');
      } else {
        amount &= 0x7f;
        tw.printNumber(' ', 1, amount);
        tw.printText(strings.get(S.odd_key_8CAA));
        addByteCapped(99, amount, party, 'oddKeys');
      }
      tw.printText(strings.get(amount === 1 ? S.Bang_NL_8CBA : S.s_8CBE));
      break;
    case 8:
      tw.printNumber(' ', 1, amount);
      tw.printText(strings.get(S.gem_8C9C));
      tw.printText(strings.get(amount === 1 ? S.Bang_NL_8CA2 : S.s_8CA6));
      addByteCapped(99, amount, party, 'gems');
      break;
    case 5: case 6: case 9: case 0x0a: case 0x0b: case 0x0c: // equipment: amount is the item id
      if (amount === 0x1b || amount === 0x1d) addByteCapped(99, 5, party.inventory, amount); // arrows and quarrels in fives
      else if (++party.inventory[amount % 48] === 100) party.inventory[amount % 48] = 99;
      tw.printText(items.name(amount));
      tw.printText(strings.get(S.Bang_NL_8D06));
      break;
    case 0x0d:
      tw.printNumber(' ', 1, amount);
      tw.printText(strings.get(S.torch_8C8A));
      tw.printText(strings.get(amount === 1 ? S.Bang_NL_8C92 : S.es_8C96));
      addByteCapped(99, amount, party, 'torches');
      break;
    case 0x0e:
      tw.printText(strings.get(S.A_sandalwood_box_8C76));
      party.sandalwoodBox = 0xff;
      npcs.deadBits[0x11] |= 0x80000000; // it won't be there again
      break;
    case 0x0f:
      tw.printNumber(' ', 1, amount);
      tw.printText(strings.get(S.food_8C6E));
      addWordCapped(9999, amount, party, 'food');
      break;
    case 0x19:
      tw.printText(strings.get(S.A_moonstone_8C4E));
      map.moonstoneLoc[amount & 7] = 0xff;
      break;
    case 0x1b:
      tw.printText(strings.get(S.A_magic_carpet_8C5C));
      if (++party.magicCarpets === 100) party.magicCarpets = 99;
      if (map.id === M.LORD_BRITISHS_CASTLE) town.removeNpc(0x16); // the one in Lord British's castle
      break;
    case 0xb4: {
      const shard = amount & 3;
      party.shards[shard % 3] = 0xff;
      tw.printText(strings.get(S.The_Shard_of_8D0A));
      tw.printText(strings.get(shard === 0 ? S.Falsehood_8D18 : shard === 1 ? S.Hatred_8D24 : S.Cowardice_8D2E));
      break;
    }
    case 0xb5: {
      party.lbCrown = 0xff;
      tw.printText(strings.get(S.The_Crown_of_Lord_8D3A));
      const npc = town.npcForObject(slot);
      if (npc >= 0) {
        town.markNpcDead(npc);
        town.removeNpc(npc);
      }
      break;
    }
    case 0xb6:
      party.lbSceptre = 0xff;
      tw.printText(strings.get(S.The_Sceptre_of_Lord_8D56));
      break;
    case 0xb7:
      party.lbAmulet = 0xff;
      tw.printText(strings.get(S.The_Amulet_of_Lord_8D74));
      break;
    default:
      tw.printText(strings.get(S.Nothing_to_get_8D92));
      return;
  }
  if (slot < 0x20) setObjectEntry(slot, 0, 0, 0, 0, 0, 0);
  status.dirty = true;
  view.rebuild = true;
}

/** G: objects; also crops, food from a plate within reach (1 karma each), a wall torch to borrow. */
export async function cmdGet() {
  if (map.isDungeon()) {
    dungeon.dungeonGet();
    return;
  }
  const dir = await askDirection();
  if (!dir) return;
  const dx = dir.dx & 0xffff, dy = dir.dy & 0xffff;
  const x = (dx + map.x) & 0xffff, y = (dy + map.y) & 0xffff;
  tw.printText(strings.get(S.NL_8DE6));
  for (let i = 1; i < 0x20; i++) {
    const o = map.objects.at(i);
    if (o.x !== x || o.y !== y || !(map.inScene() || o.z === map.z)) continue;
    if (o.tile < 0x10 || o.tile === 0x19 || o.tile === 0x1b || (o.tile & 0xfc) === 0xb4) {
      getItem(i, o.hull, o.tile);
      return;
    }
  }
  const t = map.getTile(y, x);
  let text, plate = false;
  if (t === 0x9a) {
    if (dy !== 1) {
      tw.printText(strings.get(S.Can_t_reach_plate_8E10));
      return;
    }
    map.setTile(y, x, 0x95);
    text = S.Mmmmm_8E04;
  } else if (t === 0x9b) {
    if (dy !== 0xffff) {
      tw.printText(strings.get(S.Can_t_reach_plate_8E30));
      return;
    }
    map.setTile(y, x, 0x95);
    text = S.Mmmmm_8E24;
    plate = true;
  } else if (t === 0x9c) {
    if (dx === 1 || dx === 0xffff) {
      tw.printText(strings.get(S.Can_t_reach_plate_8E44));
      return;
    }
    if (dy === 1) map.setTile(y, x, 0x9b);
    if (dy === 0xffff) map.setTile(y, x, 0x9a);
    text = S.Mmmmm_8E58;
    plate = true;
  } else if (t === 0xb0 || t === 0xb1) {
    map.setTile(y, x, 0x44);
    view.rebuild = true;
    if (!map.inScene()) view.updateLightMap();
    party.torchLight = 100;
    tw.printText(strings.get(S.Borrowed_8DE8));
    await sound.soundSlide(0x32, 1, 2000, 800);
    await view.worldTick();
    return;
  } else if (t === 0x2d) {
    map.setTile(y, x, 0x2c);
    text = S.Crops_picked_8DF4;
  } else {
    tw.printText(strings.get(S.Nothing_to_get_8E64));
    return;
  }
  view.rebuild = true;
  tw.printText(strings.get(text));
  addWordCapped(9999, 1, party, 'food');
  if (!plate) status.dirty = true; // the status bar isn't refreshed for the other two plates
  if (party.karma !== 0) party.karma--;
}
