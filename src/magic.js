// magic.js - Cast and Use: CAST.OVL and the spell helpers of CAST2.OVL. Ported from the C++ port's
// magic.cpp.
//
// Spells are numbered 0-47, six to a circle (circle = n / 6 + 1); a spell costs its circle in
// magic points and needs that level. spells.where says where it works (8 outdoors, 4 towns,
// 2 dungeons, 1 combat) and party.mixedSpells holds how many are mixed. Spell results: 1
// "Success!", 0 "Failed!", -1 nothing more to say. Timed effects set party.activeSpell to a
// letter: 'P' protection, 'Q' quickness, 'C' confusion, 'N' negate magic, 'T' time stop; 0x0E
// the Amulet, 0x1C the Crown, 0x1D the Black Badge.
import { getCommandKey, waitTurns } from './commands.js';
import { combat, isSquareVisible, pixelToSquare } from './combat.js';
import { data } from './data/gamedata.js';
import { S, strings } from './data/strings.js';
import { dissolveTile, flashSquare, screenShake } from './effects.js';
import { gameQuit } from './gamestate.js';
import { gameTime } from './gametime.js';
import { gfx } from './gfx.js';
import { input } from './input.js';
import { lookSky, showAreaMap } from './look.js';
import { M, map } from './map.js';
import { addWordCapped, randomBetween } from './misc.js';
import { monsters } from './monsters.js';
import { npcs } from './npc.js';
import { findObjectAt, randomUpto, setObjectEntry } from './objects.js';
import { party } from './party.js';
import { selectSpell } from './cmds.js';
import { sound } from './sound.js';
import { spells } from './spells.js';
import { collectSpecialItems, listNextItem, readyItemList, resurrectMember, setListWindow, specialList } from './stats.js';
import { status } from './status.js';
import { textWindows as tw } from './text.js';
import { town } from './town.js';
import { view } from './view.js';
import { askWhichMember, moongateTravel, randomStatRoll, setWindDirection } from './world.js';
import { dungeon, Dungeon } from './dungeon.js';

const C = (slot) => combat.combatants[slot & 0x1f];
const OBJ = (c) => map.objects.at(c.object & 0x1f);
const str = (id) => strings.get(id);

// Where spells work (spells.where).
const COMBAT = 1, DUNGEONS = 2, TOWNS = 4, OUTDOORS = 8;

// From DATA.OVL: the two sweeps of each spell effect 0-8 - soundSweep's increment, where each
// sweep starts and the step (the second sweep goes the other way).
const effectIncrement = data.words(0x4af6, new Uint16Array(9), 'magic.effectIncrement');
const effectFrom1 = data.words(0x4b08, new Uint16Array(9), 'magic.effectFrom1');
const effectFrom2 = data.words(0x4b1a, new Uint16Array(9), 'magic.effectFrom2');
const effectStep = data.words(0x4b2c, new Int16Array(9), 'magic.effectStep');
// The attack item each field is thrown as, and the code it leaves in a dungeon square.
const fieldAttack = data.bytes(0x4592, new Uint8Array(4), 'magic.fieldAttack');
const fieldSquare = data.bytes(0x4596, new Uint8Array(4), 'magic.fieldSquare');
// Where each Shadowlord's flame burns - x, y, location and level - and his bit in Stonegate's dead NPCs.
const flameX = data.bytes(0x4882, new Uint8Array(4), 'magic.flameX');
const flameY = data.bytes(0x4886, new Uint8Array(4), 'magic.flameY');
const flamePlace = data.bytes(0x488a, new Uint8Array(4), 'magic.flamePlace');
const flameLevel = data.bytes(0x488e, new Uint8Array(4), 'magic.flameLevel');
const shadowlordNpcBit = data.bytes(0x4892, new Uint8Array(3), 'magic.shadowlordNpcBit');

async function spellFizzle() {
  await sound.soundSlide(0x32, 1, 2000, 800);
}

// ---- CAST2.OVL helpers ----

/** e1e0: fx 0-8 a noise rising with fx and two sweeps while the view flashes; 9 one short sweep. */
export async function spellEffect(fx) {
  if (fx >= 9) {
    await sound.soundSweep(1, 300, -0x218, 1, 0x1180);
    return;
  }
  await sound.soundNoise(700, fx * 0x640 + 8000, 800);
  gfx.setDrawColor(gfx.colorText);
  gfx.xorFillRect(0xb7, 0xb7, 8, 8);
  await sound.soundSweep(effectStep[fx], effectFrom1[fx], 0x2710 + fx * 4000, 1, effectIncrement[fx]);
  await sound.soundSweep(-effectStep[fx], effectFrom2[fx], 0x2710 + fx * 4000, 1, effectIncrement[fx]);
  gfx.xorFillRect(0xb7, 0xb7, 8, 8);
}

/** e27e: "On who: " */
export async function askTargetMember() {
  tw.printText(str(S.On_who_94F4));
  const member = await status.askMemberNumber();
  tw.printText(member < 0 ? str(S.None_94FE) : party.member(member).name);
  if (tw.getCursorCol() !== 0) tw.putChar(0x0a);
  return member;
}

/**
 * e4e6: key 1-4 (W E N S) or 0; with the square next to the caster that way (the caster's own
 * if none was): { dir, x, y }.
 */
export async function askSpellDirection() {
  const t = { dir: 0, x: 0, y: 0 };
  if (map.inScene()) {
    t.x = C(combat.turn).x;
    t.y = C(combat.turn).y;
  } else {
    t.x = map.x;
    t.y = map.y;
  }
  tw.printText(str(S.Direction_9504));
  for (;;) {
    let key = await getCommandKey();
    if (gameQuit()) key = 0x20;
    switch (key) {
      case 1: tw.printText(str(S.West_9526)); t.x--; t.dir = 1; return t;
      case 2: tw.printText(str(S.East_9518)); t.x++; t.dir = 2; return t;
      case 3: tw.printText(str(S.North_9510)); t.y--; t.dir = 3; return t;
      case 4: tw.printText(str(S.South_951E)); t.y++; t.dir = 4; return t;
      case 0x20: tw.printText(str(S.Pass_952C)); return t;
    }
  }
}

/** e5a2: 1-30 hit points; 0 if dead. */
export function healMember(member) {
  const m = party.member(member & 0x0f);
  if (m.dead()) return 0;
  addWordCapped(m.maxHp, randomStatRoll(), m, 'hp');
  status.dirty = true;
  return 1;
}

/** e5ea: the wind comes to blow towards `dir` (a direction key 1-4); 0 calms it, but only from the scroll. */
export async function changeWind(showFx, dir) {
  const wind = [0, 4, 3, 1, 2];
  if (dir === 0 && showFx === 0) return;
  await spellEffect(showFx === 0 ? 2 : 1);
  if (dir >= 0 && dir <= 4) setWindDirection(wind[dir]);
}

/** e64c: the whole view lit for 20 ticks. */
export async function partyViewEffect() {
  view.computeViewMask(map.y - map.originY, map.x - map.originX, -1);
  for (let i = 0x14; i !== 0; i--) {
    if (party.activeSpell !== 0x54) view.animateObjects();
    view.updateViewObjects();
    view.drawView();
    await input.delayTicks(1);
  }
  await view.worldTick();
}

/**
 * e6a2: a daemon (type 0x26) on a free random square. Cast (not from the scroll) it serves only if
 * the caster's intelligence beats a 1-30 roll: "Oops..." (-1) and it is an enemy.
 */
export async function summonDaemon(fromScroll) {
  await spellEffect(fromScroll === 0 ? 8 : 5);
  let tries = 0, pos;
  for (;;) {
    pos = combat.randomCombatPos();
    if (pos.ok && combat.combatTileFree(pos.y, pos.x, 0xd8) && map.getTile(pos.y, pos.x) !== 0xff) break;
    if (++tries > 7) return 0;
  }
  const n = combat.addCombatant(map.z, pos.y, pos.x, 0, 0x26);
  if (n < 0) return 0;
  await sound.soundSweep(5, 500, 12000, 1, 0xac8);
  const o = OBJ(C(n));
  o.tile = o.tile2 = 0x16;
  await dissolveTile(pos.y, pos.x, 0x1d8);
  o.tile = o.tile2 = 0xd8;
  if (fromScroll === 0 && combat.getCombatantStat(-1, combat.turn) <= randomStatRoll()) {
    tw.printText(str(S.Oops_9532));
    return -1;
  }
  C(n).flags |= 1;
  return 1;
}

/** e8cc: in runes: latitude then longitude, each as two letters A-P (sixteenths, then units). */
export function printCoordinates() {
  tw.selectFont(1);
  tw.putChar(0x0a);
  tw.putChar((map.y >> 4) + 0x41);
  tw.putChar(0x27);
  tw.putChar((map.y & 0x0f) + 0x41);
  tw.printText(str(S.Quote_Comma_SP_9548));
  tw.putChar((map.x >> 4) + 0x41);
  tw.putChar(0x27);
  tw.putChar((map.x & 0x0f) + 0x41);
  tw.putChar(0x22);
  tw.selectFont(0);
  tw.putChar(0x0a);
}

/**
 * e948: magically locked doors (0x97, 0x98) become plain doors (0xB8, 0xBA). -1 no direction,
 * 0 no such door, 1 unlocked; `.where` the square.
 */
export async function magicUnlockDoor() {
  const t = await askSpellDirection();
  const where = { x: t.x, y: t.y };
  if (t.dir === 0) return { result: -1, where };
  const p = map.getTile(t.y, t.x);
  if (p === 0x97) map.setTile(t.y, t.x, 0xb8);
  else if (p === 0x98) map.setTile(t.y, t.x, 0xba);
  else return { result: 0, where };
  view.rebuild = true;
  return { result: 1, where };
}

/** The dungeon square the party is on if it is of `kind`, else the one it faces: its index in dungeon.grid. */
function dungeonSquare(kind) {
  let i = ((map.z & 7) * 0x40 + (map.y & 7) * 8 + (map.x & 7)) & 0x1ff;
  if ((dungeon.grid[i] & 0xf0) !== kind)
    i = ((map.z & 7) * 0x40 + ((Dungeon.facingDy[dungeon.facing & 3] + map.y) & 7) * 8 + ((Dungeon.facingDx[dungeon.facing & 3] + map.x) & 7)) & 0x1ff;
  return i;
}

/** e99c: in combat a field object next to the caster; elsewhere (dungeons) a field square (0x8n). */
export async function dispelField(showFx) {
  if (!map.inScene()) {
    if (showFx) await spellEffect(4);
    const i = dungeonSquare(0x80);
    if ((dungeon.grid[i] & 0xf0) !== 0x80) return 0;
    dungeon.grid[i] &= 8;
    tw.printText(str(S.Field_destroyed_954C));
    return -1;
  }
  const t = await askSpellDirection();
  if (t.dir === 0) return -1;
  if (showFx) await spellEffect(4);
  for (let i = 0; i < 0x20; i++) {
    const o = map.objects.at(i);
    if ((o.tile & 0xfc) === 0xe8 && o.x === (t.x & 0xffff) && o.y === (t.y & 0xffff)) {
      setObjectEntry(i, 0, 0, 0, 0, 0, 0);
      return 1;
    }
  }
  return 0;
}

/** eaca */
export function setLight(turns) {
  party.lightSpell = turns;
}

/** ead8 */
export async function startTimedSpell(fx, turns, letter) {
  party.activeSpell = letter;
  party.activeSpellTurns = turns;
  await spellEffect(fx);
  status.drawStatusBar();
}

// ---- CAST.OVL: the spells ----

/** bf80: Shadowlords, Blackthorn, Lord British. */
export function isSpellImmuneKind(slot) {
  const k = C(slot).kind;
  return k === 0x2f || k === 0x0e || k === 0x0f;
}

/** bfb2: Grav Por (0x30), Vas Flam (0x31), Xen Corp (0x32): aimed like a missile weapon. */
async function castMissile(missile) {
  combat.attackItem = missile;
  await combat.attackWith(missile, combat.turn);
}

/** bfcc: in combat the field is thrown; in a dungeon it fills the empty square ahead. */
async function castField(field) {
  if (map.inScene()) {
    combat.attackItem = fieldAttack[field & 3];
    await combat.attackWith(combat.attackItem, combat.turn);
    return -1;
  }
  await spellEffect(field === 3 ? 4 : 3);
  const i = ((map.z & 7) * 0x40 + ((Dungeon.facingDy[dungeon.facing & 3] + map.y) & 7) * 8 + ((Dungeon.facingDx[dungeon.facing & 3] + map.x) & 7)) & 0x1ff;
  if ((dungeon.grid[i] & 0xf7) !== 0) return 0;
  dungeon.grid[i] = (dungeon.grid[i] & 8) | fieldSquare[field & 3];
  return -1;
}

/** c094 An Zu: wakes a sleeper. */
async function spellAnZu() {
  const member = await askTargetMember();
  if (member < 0) return -1;
  if (!party.member(member).asleep()) return 0;
  party.member(member).status = 'G';
  if (map.inScene())
    for (let slot = 0; slot < 0x20; slot++)
      if ((C(slot).flags & 0xe8) === 0x88 && C(slot).kind === member) {
        combat.wakeCombatant(slot);
        break;
      }
  await spellEffect(1);
  status.dirty = true;
  return -1;
}

/** c12e An Nox: cures poison. */
async function spellAnNox() {
  const member = await askTargetMember();
  if (member < 0) return -1;
  if (!party.member(member).poisoned()) return 0;
  party.member(member).status = 'G';
  await spellEffect(1);
  status.dirty = true;
  return 1;
}

/** c17a Mani: heals 1-30. */
async function spellMani() {
  const member = await askTargetMember();
  const r = member < 0 ? -1 : healMember(member);
  if (r !== 0) await spellEffect(1);
  return r;
}

/** c1b0 An Ylem: a piece of furniture vanishes (the tiles Push can move, and mirrors). */
async function spellAnYlem() {
  const t = await askSpellDirection();
  if (t.dir === 0) return -1;
  await spellEffect(1);
  const tile = map.getTile(t.y, t.x);
  if (!(tile === 0x9d || tile === 0x5b || (tile > 0x8f && tile < 0x94) || tile === 0xa5 || tile === 0xa6 || tile === 0xa8 || tile === 0xa9 || (tile > 0xac && tile < 0xb0)))
    return 0;
  map.setTile(t.y, t.x, 0x44);
  tw.printText(str(S.POOF_459A));
  view.rebuild = true;
  await view.worldTick();
  await sound.soundSlide(0x28, 1, 2000, 0x4b0);
  return -1;
}

/** c252 An Sanct: unlocks a door (0xB9, 0xBB) or disarms a chest; in a dungeon opens the chest on or ahead of the party. */
async function spellAnSanct() {
  if (!(map.onTileMap() || map.inScene())) {
    await spellEffect(2);
    const i = dungeonSquare(0x40);
    if ((dungeon.grid[i] & 0xf0) !== 0x40) return 0;
    if (dungeon.grid[i] & 1) tw.printText(str(S.Disarmed_45A1));
    dungeon.grid[i] = (dungeon.grid[i] & 8) | 0x70;
    tw.printText(str(S.Chest_opened_45AC));
    return -1;
  }
  const t = await askSpellDirection();
  if (t.dir === 0) return -1;
  const tile = map.getTile(t.y, t.x);
  if (tile === 0xb9 || tile === 0xbb) {
    map.setTile(t.y, t.x, tile - 1);
    view.rebuild = true;
    await spellEffect(2);
    return 1;
  }
  for (let i = 0; i < 0x20; i++) {
    const o = map.objects.at(i);
    if (o.tile === 1 && o.x === (t.x & 0xffff) && o.y === (t.y & 0xffff) && (map.inScene() || o.z === map.z)) {
      o.hull &= 0x7f;
      await spellEffect(2);
      return 1;
    }
  }
  return 0;
}

/** c3be An Xen Corp: monsters flagged 0x20 (the undead) that fail to resist turn and flee. */
async function spellAnXenCorp() {
  await spellEffect(2);
  for (let slot = 0; slot < 0x20; slot++) {
    const c = C(slot);
    if (isSpellImmuneKind(slot) || (c.flags & 0xc0) !== 0x40 || !(monsters.flags(c.kind) & 0x20)) continue;
    if (combat.magicResistRoll(0, slot, combat.turn) === 0) {
      c.hp = 1;
      c.flags |= 2;
    }
  }
}

/** c424 In Wis: the party's position. */
async function spellInWis() {
  await spellEffect(2);
  printCoordinates();
}

/** c430 Kal Xen: a rat (6 in 16), spider (5), bat (3) or python (2) appears on the party's side. */
async function spellKalXen() {
  await spellEffect(2);
  const r = randomBetween(0x0f, 0);
  const type = r < 6 ? 0x14 : r < 0x0b ? 0x16 : r < 0x0e ? 0x15 : 0x22;
  const tile = type * 4 + 0x40;
  let tries = 0, pos;
  for (;;) {
    pos = combat.randomCombatPos();
    if (pos.ok && combat.combatTileFree(pos.y, pos.x, 0x90)) break;
    if (++tries > 7) return 0;
  }
  const n = combat.addCombatant(map.z, pos.y, pos.x, 0, type);
  if (n < 0) return 0;
  const o = OBJ(C(n));
  o.tile = o.tile2 = 0x16;
  await dissolveTile(pos.y, pos.x, type * 4 + 0x140);
  o.tile = o.tile2 = tile;
  C(n).flags |= 1;
  return 1;
}

/** c534 In Xen Mani: 1-3 food. */
async function spellInXenMani() {
  await spellEffect(2);
  addWordCapped(9999, randomBetween(3, 1), party, 'food');
  status.dirty = true;
  return 1;
}

/**
 * c55c In Por. Outdoors the party jumps along the direction to the farthest grass square (tile 5)
 * of the loaded map window. In combat the caster jumps to a random free square.
 */
async function spellInPor() {
  if (map.inScene()) {
    if (combat.flags & 2) return 0;
    const c = C(combat.turn);
    const o = OBJ(c);
    await spellEffect(3);
    for (let tries = 0; tries < 7; tries++) {
      const pos = combat.randomCombatPos();
      if (pos.ok && combat.combatTileFree(pos.y, pos.x, o.tile)) {
        c.x = o.x = pos.x;
        c.y = o.y = pos.y;
        return 1;
      }
    }
    return 0;
  }
  const t = await askSpellDirection();
  if (t.dir === 0) return -1;
  await spellEffect(3);
  const dx = t.x - map.x, dy = t.y - map.y;
  let found = 0;
  let maxX = map.originX + 0x20, maxY = map.originY + 0x20;
  if (maxX > 0x100) maxX = 0x100;
  if (maxY > 0x100) maxY = 0x100;
  for (let x = t.x & 0xff, y = t.y & 0xff; x >= map.originX && x < maxX && y >= map.originY && y < maxY; x += dx, y += dy)
    if (map.getTile(y, x) === 5) {
      found = -1;
      map.x = x;
      map.y = y;
      view.rebuild = true;
    }
  if (found) map.enterOutdoors();
  return found;
}

/** c6cc Wis Quas: invisible monsters show. */
async function spellWisQuas() {
  await spellEffect(4);
  for (let slot = 0; slot < 0x20; slot++) {
    const c = C(slot);
    if (c.flags === 0 || (c.flags & 0x80) || !(c.flags & 0x10)) continue;
    c.flags &= 0xef;
    OBJ(c).tile2 = OBJ(c).tile;
    view.updateViewObjects();
    view.drawView();
  }
}

/** c734 In Bet Xen: four insect swarms (type 0x1F) on the party's side, all on one free square. */
async function spellInBetXen() {
  await spellEffect(5);
  let tries = 0, pos;
  for (;;) {
    pos = combat.randomCombatPos();
    if (pos.ok && combat.combatTileFree(pos.y, pos.x, 0xbc)) break;
    if (++tries > 7) return 0;
  }
  let made = 0;
  for (let i = 0; i < 4; i++) {
    const n = combat.addCombatant(map.z, pos.y, pos.x, 0, 0x1f);
    if (n < 0) return made;
    C(n).flags |= 1;
    made = 1;
  }
  return made;
}

/** c7c6 An Ex Por: a door becomes magically locked (0xB8, 0xB9 -> 0x97; 0xBA, 0xBB -> 0x98). */
async function spellAnExPor() {
  const t = await askSpellDirection();
  if (t.dir === 0) return -1;
  await spellEffect(5);
  const tile = map.getTile(t.y, t.x);
  if (tile < 0xb8 || tile > 0xbb) return 0;
  map.setTile(t.y, t.x, tile < 0xba ? 0x97 : 0x98);
  view.rebuild = true;
  return 1;
}

/** c82c Vas Mani: full hit points; not for the dead, nor in a fight before it is won. */
async function spellVasMani() {
  const member = await askTargetMember();
  if (member < 0) return -1;
  if (party.member(member).dead() || (map.inScene() && combat.victory === 0)) return 0;
  party.member(member).hp = party.member(member).maxHp;
  await spellEffect(5);
  status.dirty = true;
  return 1;
}

/** c89e In Vas Por Ylem: the earth shakes; every enemy whose speed fails a 1-30 roll takes 1-20. */
async function spellInVasPorYlem(caster) {
  await spellEffect(6);
  await screenShake();
  for (let slot = 0; slot < 0x20; slot++) {
    if (C(slot).flags === 0 || combat.combatantSide(slot) === 0) continue;
    const roll = randomStatRoll();
    if (combat.getCombatantStat(-2, slot) > roll) continue;
    await combat.flashCombatant(slot);
    const xp = await combat.applyDamage(randomBetween(0x14, 1), slot);
    addWordCapped(9999, xp, party.member(caster & 0x0f), 'xp');
    await combat.reportHit(combat.turn, slot);
  }
}

/** c920 An Xen Ex: an enemy that fails to resist changes sides (not one in stocks or manacles). */
async function spellAnXenEx() {
  tw.printText(str(S.Creature_45BB));
  if ((await combat.aimCursor(0x0f, combat.turn)) === 0) return -1;
  await spellEffect(6);
  if ((map.getTile(combat.aimY, combat.aimX) & 0xfe) === 0x84) return 0;
  const t = combat.combatantAt(combat.aimY, combat.aimX);
  if (t < 0 || isSpellImmuneKind(t) || combat.combatantSide(t) === 0 || combat.magicResistRoll(0, t, combat.turn) !== 0) return 0;
  const c = C(t);
  c.flags ^= 1;
  if (c.flags & 0x80) {
    party.member(c.kind & 0x0f).status = 'G';
    status.drawStatusBar();
  }
  combat.printCombatantName(t);
  tw.printText(str(S.charmed_45C6));
  return -1;
}

/** c9dc Rel Xen Bet: a creature that fails to resist becomes a giant rat (type 0x14). */
async function spellRelXenBet() {
  tw.printText(str(S.Creature_45D1));
  if ((await combat.aimCursor(0x0f, combat.turn)) === 0) return -1;
  await spellEffect(6);
  const t = combat.combatantAt(combat.aimY, combat.aimX);
  if (t < 0 || isSpellImmuneKind(t) || combat.magicResistRoll(0, t, combat.turn) !== 0) return 0;
  const x = C(t).x, y = C(t).y;
  combat.combatRemove(-1 - t);
  combat.addCombatant(map.z, y, x, 0, 0x14);
  return 1;
}

/** ca7e Sanct Lor: the caster turns invisible. */
async function spellSanctLor() {
  const c = C(combat.turn);
  OBJ(c).tile2 = 0x1d;
  c.flags |= 0x10;
  await spellEffect(7);
  return 1;
}

/** caa8 In Quas Xen: a copy of the fighter aimed at, friend or foe, on a random free square. */
async function spellInQuasXen() {
  tw.printText(str(S.Creature_45DC));
  if ((await combat.aimCursor(0x0f, combat.turn)) === 0) return -1;
  await spellEffect(7);
  const t = combat.combatantAt(combat.aimY, combat.aimX);
  if (t < 0) return 0;
  let obj, slot;
  for (obj = 0; obj < 0x20 && map.objects.at(obj).tile !== 0; obj++);
  for (slot = 0; slot < 0x20 && combat.combatants[slot].flags !== 0; slot++);
  if (obj === 0x20 || slot === 0x20) return 1; // (the result is unset in the original; nothing happens)
  combat.combatantBytes.copyWithin(slot * 8, t * 8, t * 8 + 8);
  combat.combatants[slot].object = obj;
  const src = OBJ(C(t));
  map.objects.bytes.copyWithin(obj * 8, src.offset, src.offset + 8);
  for (let tries = 0; tries < 10000; tries++) { // the original tries for ever
    const pos = combat.randomCombatPos();
    if (!pos.ok || !combat.combatTileFree(pos.y, pos.x, 0x1c)) continue;
    combat.combatants[slot].x = map.objects.at(obj).x = pos.x;
    combat.combatants[slot].y = map.objects.at(obj).y = pos.y;
    break;
  }
  return 1;
}

/** cc18 In Quas Corp: every monster that fails to resist flees. */
async function spellInQuasCorp() {
  await spellEffect(7);
  for (let slot = 0; slot < 0x20; slot++) {
    const c = C(slot);
    if ((c.flags & 0xc0) !== 0x40 || isSpellImmuneKind(slot) || combat.magicResistRoll(0, slot, combat.turn) !== 0) continue;
    c.hp = 1;
    c.flags |= 2;
  }
}

/** cc70 Vas Rel Por: to moonstone 1-8, as through a moongate. Not aboard ship. */
async function spellVasRelPor() {
  if ((party.transport & 0xf0) === 0x20) return 0;
  tw.printText(str(S.To_phase_45E7));
  const c = (await getCommandKey()) & 0xff;
  if (c > 0x1f) tw.putChar(c);
  tw.putChar(0x0a);
  if (c > 0x30 && c < 0x39) {
    await spellEffect(8);
    if (await moongateTravel(c - 0x31)) return -1;
  }
  return 0;
}

/** cccc An Tym: time stops for 10 turns - unless a Shadowlord is present. */
async function spellAnTym() {
  await spellEffect(8);
  for (let i = 0; i < 0x20; i++)
    if (map.objects.at(i).tile === 0xfc) {
      tw.printText(str(S.Magic_absorbed_45F2));
      await sound.soundSweep(2, 1000, 28000, 1, 0x2648);
      return 0;
    }
  party.activeSpell = 0x54;
  party.activeSpellTurns = 10;
  status.drawStatusBar();
  return -1;
}

/**
 * cd3a: the caster is the active player (or asked for; in combat whoever's turn it is). The
 * mixed spell is used up before the magic points and the level are checked, so it is lost on
 * "M.P. too low!" and when the caster's level is below the circle. Nothing works in Blackthorn's
 * castle without the Crown, nor in Stonegate. Returns 0 only after a moongate journey (no turn).
 */
export async function cmdCast() {
  let turn = 1, result;
  combat.castCircle = 1;
  combat.magicAttack = 1;
  const member = await askWhichMember();
  if (member < 0) return member;
  tw.printText(str(S.Spell_name_4603));
  const spell = await selectSpell();
  if (spell === -1) {
    tw.printText(str(S.None_4611));
    return 1;
  }
  if (spell === -2) {
    tw.printText(str(S.No_effect_4618));
    return 1;
  }
  const circle = Math.trunc(spell / 6) + 1;
  combat.castCircle = circle;
  const where = spells.where[spell];
  let need;
  if (map.isOutdoors()) {
    need = OUTDOORS;
  } else if (!map.inScene()) {
    if ((map.id === M.PALACE_OF_BLACKTHORN && party.lbCrown === 0) || map.id === M.STONEGATE) {
      tw.printText(str(S.Absorbed_4624));
      await sound.soundSweep(2, 1000, 28000, 1, 0x2648);
      return 1;
    }
    need = map.onTileMap() ? TOWNS : DUNGEONS;
  } else {
    need = COMBAT;
  }
  if (!(where & need)) {
    tw.printText(str(S.Not_here_462F));
    await spellFizzle();
    return 1;
  }
  if (party.mixedSpells[spell] === 0) {
    tw.printText(str(S.None_mixed_463A));
    return 1;
  }
  party.mixedSpells[spell]--;
  const m = party.member(member & 0x0f);
  if (m.mp < circle) {
    tw.printText(str(S.M_P_too_low_4647));
    result = 0;
  } else {
    m.mp = m.mp - circle;
    result = -1;
    if (m.level < circle) result = 0;
    else switch (spell) {
      case 0x00: setLight(100); await spellEffect(1); break; // In Lor
      case 0x01: await castMissile(0x30); break; // Grav Por
      case 0x02: result = await spellAnZu(); break;
      case 0x03: result = await spellAnNox(); break;
      case 0x04: result = await spellMani(); break;
      case 0x05: result = await spellAnYlem(); break;
      case 0x06: result = await spellAnSanct(); break;
      case 0x07: await spellAnXenCorp(); break;
      case 0x08: await changeWind(0, (await askSpellDirection()).dir); break; // Rel Hur
      case 0x09: await spellInWis(); break;
      case 0x0a: result = await spellKalXen(); break;
      case 0x0b: result = await spellInXenMani(); break;
      case 0x0c: setLight(0xff); await spellEffect(3); break; // Vas Lor
      case 0x0d: await castMissile(0x31); break; // Vas Flam
      case 0x0e: result = await castField(0); break; // In Flam Grav
      case 0x0f: result = await castField(1); break; // In Nox Grav
      case 0x10: result = await castField(2); break; // In Zu Grav
      case 0x11: result = await spellInPor(); break;
      case 0x12: result = await dispelField(1); break; // An Grav
      case 0x13: await startTimedSpell(4, 0x14, 0x50); break; // In Sanct: 'P'
      case 0x14: result = await castField(3); break; // In Sanct Grav
      case 0x15: case 0x16: // Uus Por, Des Por: up / down a dungeon level
        if (map.id === M.DOOM) {
          result = 0; // not in Doom
          break;
        }
        await spellEffect(4);
        if ((await dungeon.dungeonChangeLevel(1, spell === 0x15 ? -1 : 1)) !== 0) dungeon.exitDungeon();
        break;
      case 0x17: await spellWisQuas(); break;
      case 0x18: result = await spellInBetXen(); break;
      case 0x19: result = await spellAnExPor(); break;
      case 0x1a: // In Ex Por
        result = (await magicUnlockDoor()).result;
        if (result !== -1) await spellEffect(5);
        break;
      case 0x1b: result = await spellVasMani(); break;
      case 0x1c: await castAreaSpell(gfx.colorSleep, 1, combat.turn); break; // In Zu
      case 0x1d: await startTimedSpell(5, 0x1e, 0x51); break; // Rel Tym: 'Q'
      case 0x1e: await spellInVasPorYlem(member); break;
      case 0x1f: await startTimedSpell(6, 0x14, 0x43); break; // Quas An Wis: 'C'
      case 0x20: await startTimedSpell(6, 10, 0x4e); break; // In An: 'N'
      case 0x21: await spellEffect(6); await partyViewEffect(); break; // Wis An Ylem
      case 0x22: result = await spellAnXenEx(); break;
      case 0x23: result = await spellRelXenBet(); break;
      case 0x24: result = await spellSanctLor(); break;
      case 0x25: await castMissile(0x32); break; // Xen Corp
      case 0x26: result = await spellInQuasXen(); break;
      case 0x27: // In Quas Wis
        await spellEffect(7);
        if (map.onTileMap()) await showAreaMap(map.y, map.x);
        else await dungeon.showDungeonMap();
        break;
      case 0x28: await castAreaSpell(gfx.colorPoison, 2, combat.turn); break; // In Nox Hur
      case 0x29: await spellInQuasCorp(); break;
      case 0x2a: // In Mani Corp
        result = await resurrectMember(0, await askTargetMember());
        status.drawStatusBar();
        break;
      case 0x2b: result = await summonDaemon(0); break; // Kal Xen Corp
      case 0x2c: await castAreaSpell(gfx.colorFrame, 4, combat.turn); break; // In Vas Grav Corp
      case 0x2d: await castAreaSpell(gfx.colorFire, 3, combat.turn); break; // In Flam Hur
      case 0x2e:
        result = await spellVasRelPor();
        if (result !== 0) turn = 0;
        break;
      case 0x2f: result = await spellAnTym(); break;
    }
  }
  if (result === 1) {
    tw.printText(str(S.Success_4656));
  } else if (result === 0) {
    tw.printText(str(S.Failed_4660));
    await spellFizzle();
  }
  return turn;
}

// ---- Use ----

/** d15e: scrolls: 0 light, 1 wind change, 2 protection, 3 negate magic, 4 view, 5 summon daemon, 6 resurrection, 7 negate time. */
async function useScroll(scroll) {
  party.scrolls[scroll & 7]--;
  tw.printText(str(S.Scroll_466A));
  switch (scroll) {
    case 0:
      setLight(0xf0);
      tw.printText(str(S.Light_4673));
      await spellEffect(0);
      return 1;
    case 1: {
      tw.printText(str(S.Wind_change_467B));
      const dir = (await askSpellDirection()).dir;
      if (!map.onTileMap()) return 0;
      await changeWind(1, dir);
      return 1;
    }
    case 2:
      tw.printText(str(S.Protection_4689));
      await startTimedSpell(2, 100, 0x50);
      return 1;
    case 3:
      tw.printText(str(S.Negate_magic_4696));
      await startTimedSpell(3, 0x14, 0x4e);
      return 1;
    case 4:
      tw.printText(str(S.View_46A5));
      if (map.inScene()) {
        tw.printText(str(S.Not_here_46AC));
        return 1;
      }
      await spellEffect(4);
      if (map.onTileMap()) await showAreaMap(map.y, map.x);
      else await dungeon.showDungeonMap();
      return 1;
    case 5:
      tw.printText(str(S.Summon_Daemon_46B7));
      if (map.inScene()) return summonDaemon(1);
      tw.printText(str(S.Not_here_46C7));
      return 1;
    case 6: {
      tw.printText(str(S.Resurrection_46D2));
      if (map.inScene()) {
        tw.printText(str(S.Not_here_46E1));
        return 1;
      }
      const r = await resurrectMember(1, await askTargetMember());
      status.drawStatusBar();
      return r;
    }
    case 7:
      if (map.id === M.STONEGATE || map.id === M.DOOM) {
        tw.printText(str(S.No_effect_46EC));
        await spellFizzle();
        return 1;
      }
      tw.printText(str(S.Negate_time_46F8));
      await startTimedSpell(7, 0x14, 0x54);
      return 1;
  }
  return 1;
}

/**
 * d2da: potions: 0 blue awakens, 1 yellow heals, 2 red cures, 3 green poisons, 4 orange sleeps,
 * 5 purple turns the drinker into a rat (combat), 6 black makes invisible (combat), 7 white shows
 * the surroundings. 1 time in 16 any potion is a sleeping draught, 1 in 16 a random one. In combat
 * the drinker is the one whose turn it is.
 */
async function usePotion(potion) {
  let result = 1;
  party.potions[potion & 7]--;
  tw.printText(str(S.Potion_4706));
  const member = !map.inScene() ? await askTargetMember() : C(combat.turn).kind;
  if (member < 0) return member;
  await spellEffect(potion);
  const r = randomBetween(0x0f, 0);
  if (r === 0) potion = 4;
  else if (r === 1) potion = randomBetween(7, 0);
  const m = party.member(member & 0x0f);
  const c = C(combat.turn);
  switch (potion) {
    case 0:
      if (!m.asleep()) return 0;
      m.status = 'G';
      if (map.inScene()) {
        if (c.kind !== member || (c.flags & 0xe8) !== 0x88) return 0;
        combat.wakeCombatant(combat.turn);
        return 1;
      }
      break;
    case 1:
      result = healMember(member);
      if (result === 0) return 0;
      tw.printText(str(S.Healed_470E));
      break;
    case 2:
      if (!m.poisoned()) return 0;
      m.status = 'G';
      tw.printText(str(S.Poison_cured_4717));
      break;
    case 3:
      if (!m.good()) return 0;
      m.status = 'P';
      tw.printText(str(S.POISONED_4726));
      break;
    case 4:
      if (!m.good()) return 0;
      if (!map.inScene()) m.status = 'S';
      else await combat.sleepCombatant(member); // the member number is passed as the slot
      tw.printText(str(S.Slept_4731));
      break;
    case 5:
      if (map.inScene()) {
        tw.printText(str(S.Poof_4739));
        OBJ(c).tile = OBJ(c).tile2 = 0x90;
        return 1;
      }
      tw.printText(str(S.No_noticeable_effect_now_474C));
      return result;
    case 6:
      if (map.inScene()) {
        c.flags |= 0x10;
        tw.printText(str(S.Invisible_4740));
        OBJ(c).tile = OBJ(c).tile2 = 0x1d;
        return 1;
      }
      tw.printText(str(S.No_noticeable_effect_now_474C));
      return result;
    case 7:
      if (map.onTileMap()) {
        await partyViewEffect();
        return 1;
      }
      tw.printText(str(S.No_noticeable_effect_now_474C));
      return result;
    default:
      return result;
  }
  status.drawStatusBar();
  return result;
}

/** d4bc: a moonstone can be buried on grass, scrub, swamp, desert and hills (tiles 4-10) and on fields (0x2C, 0x2D). */
function useMoonstone(moonstone) {
  const t = map.getTile(map.y, map.x);
  tw.printText(str(S.Moonstone_4768));
  if (map.onTileMap() && (t === 0x2c || t === 0x2d || (t > 3 && t < 0x0b))) {
    tw.printText(str(S.buried_4773));
    map.moonstoneX[moonstone & 7] = map.x;
    map.moonstoneY[moonstone & 7] = map.y;
    map.moonstoneLoc[moonstone & 7] = map.id;
    map.moonstoneZ[moonstone & 7] = map.z;
  } else {
    tw.printText(str(S.cannot_be_buried_here_477C));
  }
}

/**
 * d534: a shard works only at its flame. Cast in while the matching Shadowlord, summoned by name,
 * stands just north, it destroys him.
 */
async function useShard(shard) {
  const which = [S.Falsehood_47CC, S.Hatred_47D9, S.Cowardice_47E3];
  const flame = [S.Truth_4822, S.Love_482A, S.Courage_4831];
  const name = [S.Faulinei_4858, S.Astaroth_4861, S.Nosfentor_486A];
  tw.printText(str(S.Gem_Shard_Thou_dost_hold_4794));
  if (shard < 3) tw.printText(str(which[shard]));
  for (let f = 2000; f < 25000; f += 0x32) await sound.soundSweep(0, f, 200, 1, 0xa50);
  for (let f = 25000; f > 2000; f -= 0x32) await sound.soundSweep(0, f, 200, 1, 0xa50);
  if (flameX[shard & 3] !== map.x || flameY[shard & 3] !== map.y || flamePlace[shard & 3] !== map.id || flameLevel[shard & 3] !== map.z) {
    tw.printText(str(S.No_effect_47F0));
    await spellFizzle();
    return;
  }
  await waitTurns(7);
  tw.printText(str(S.and_cast_it_into_the_47FE));
  if (shard < 3) tw.printText(str(flame[shard]));
  await screenShake();
  await screenShake();
  await screenShake();
  await waitTurns(3);
  const found = findObjectAt(map.z, (map.y - 1) & 0xff, map.x);
  if (found.tile !== 0xfc) return;
  if (shard !== party.summonedShadowlord) return;
  const npc = town.npcForObject(found.slot);
  if (npc >= 0) town.removeNpc(npc); // (the original doesn't check)
  for (let i = 7; i !== 0; i--) await flashSquare(map.y - 1, map.x);
  map.shadowlordLocations[shard] = 0xff;
  party.shards[shard] = 0;
  npcs.deadBits[0x1d] |= shadowlordNpcBit[shard < 3 ? shard : 2]; // his place in Stonegate stays empty
  tw.printText(str(S.The_doom_of_the_483B));
  tw.printText(str(name[shard]));
  tw.printText(str(S.is_wrought_4874));
  await combat.victoryFanfare();
}

/** d6e4: using a worn item (Amulet, Crown, Badge) again takes it off. 1 if it wasn't on. */
function useRemoveItem(item) {
  if (item !== party.activeSpell) return 1;
  tw.printText(str(S.Removed_4895));
  party.activeSpellTurns = 0;
  party.activeSpell = 0;
  status.dirty = true;
  return 0;
}

/**
 * d712: the "Items:" list: 0-7 scrolls, 8-15 potions, 16 carpet, 17 skull keys, 18-20 Lord
 * British's Amulet, Crown and Sceptre, 21-28 moonstones, 29-31 shards, 32 spyglass, 33 HMS Cape
 * plans, 34 sextant, 35 pocket watch, 36 black badge, 37 wooden box.
 */
export async function cmdUse() {
  let ok = 1;
  collectSpecialItems();
  const first = listNextItem(0xff, specialList, 0x26, -1);
  if (first === -1) {
    tw.printText(str(S.No_usable_items_489F));
    return;
  }
  tw.printText(str(S.Item_48B1));
  status.clearSidePanel();
  tw.selectTextWindow(1);
  status.drawPanelTitle(str(S.Items_48B8));
  setListWindow(8);
  const item = await readyItemList(0x55, 0xff, first);
  status.drawListHeaderBar();
  status.drawPanelTopBar();
  status.drawPanelBottomBar();
  status.drawStatusBar();
  if (item < 0) return;
  if (item < 8) {
    ok = await useScroll(item);
  } else if (item < 0x10) {
    ok = await usePotion(item - 8);
  } else if (item > 0x14 && item < 0x1d) {
    useMoonstone(item - 0x15);
  } else switch (item) {
    case 0x10:
      tw.printText(str(S.Carpet_48BF));
      if (!(map.onTileMap() && map.getTile(map.y, map.x) !== 0x0c)) {
        tw.printText(str(S.Not_here_48F3));
      } else if (party.transport === 0x1c) {
        tw.printText(str(S.Boarded_48C8));
        party.transport = randomBetween(1, 0) + 0x14;
        party.magicCarpets--;
      } else {
        tw.printText(str((party.transport & 0xf8) === 0x20 ? S.X_it_ship_first_48D2 : S.Only_on_foot_48E4));
      }
      break;
    case 0x11: // a skull key opens a magically locked door, like In Ex Por
      party.oddKeys--;
      tw.printText(str(S.Skull_Key_48FE));
      if (map.onTileMap() || map.inScene()) {
        const r = await magicUnlockDoor();
        ok = r.result;
        if (ok !== 0 && !map.inScene()) await flashSquare(r.where.y, r.where.x);
      } else {
        tw.printText(str(S.Not_here_4909));
      }
      break;
    case 0x12:
      tw.printText(str(S.Amulet_4914));
      if (useRemoveItem(0x0e) !== 0) {
        tw.printText(str(S.Wearing_the_Amulet_491D));
        tw.printText(str(S.of_Lord_British_4A84));
        await startTimedSpell(9, 0xff, 0x0e);
      }
      break;
    case 0x13:
      tw.printText(str(S.Crown_4930));
      if (useRemoveItem(0x1c) !== 0) {
        tw.printText(str(S.Thou_dost_don_the_Crown_4938));
        tw.printText(str(S.of_Lord_British_4A84));
        await startTimedSpell(9, 0xff, 0x1c);
      }
      break;
    case 0x14: { // the Sceptre clears the 0x7n tiles around the party, or else dispels a field
      tw.printText(str(S.Sceptre_4950));
      tw.printText(str(S.Wielding_the_Sceptre_495A));
      tw.printText(str(S.of_Lord_British_4A84));
      await sound.soundSweep(1, 5000, -0x3cb0, 1, 0x1450);
      let cleared = 0;
      if (!map.isDungeon())
        for (let dx = -1; dx < 2; dx++)
          for (let dy = -1; dy < 2; dy++) {
            const y = (map.y + dy) & 0xffff, x = (dx + map.x) & 0xffff;
            if ((map.getTile(y, x) & 0xf0) !== 0x70) continue;
            map.setTile(y, x, 5);
            await view.worldTick();
            await sound.soundNoise(2000, 3000, 10);
            cleared++;
          }
      if (cleared === 0) {
        const r = await dispelField(0);
        if (r === 1) tw.printText(str(S.Field_dissolved_496F));
        else if (r === 0) tw.printText(str(S.No_effect_4981));
      }
      break;
    }
    case 0x1d: case 0x1e: case 0x1f:
      await useShard(item - 0x1d);
      break;
    case 0x20:
      tw.printText(str(S.Spyglass_498D));
      if (!(map.onTileMap() && map.z < 0x80)) {
        tw.printText(str(S.Not_here_49AF));
      } else if (gameTime.hour < 6 || gameTime.hour > 0x12) {
        tw.printText(str(S.Looking_4998));
        await lookSky();
      } else {
        tw.printText(str(S.No_stars_49A4));
      }
      break;
    case 0x21:
      tw.printText(str(S.Plans_49BA));
      if ((party.transport & 0xf8) === 0x20) {
        party.hmsCapePlans |= 0x80;
        tw.printText(str(S.Ship_rigged_for_double_49C2));
      } else {
        tw.printText(str(S.Only_usable_on_shipboard_49E1));
      }
      break;
    case 0x22:
      tw.printText(str(S.Sextant_49FC));
      if (!(map.z < 0x80 && map.isOutdoors())) {
        tw.printText(str(S.Only_outdoors_4A06));
      } else if (gameTime.hour < 6 || gameTime.hour > 0x12) {
        tw.printText(str(S.Position_4A26));
        printCoordinates();
      } else {
        tw.printText(str(S.Only_at_night_4A16));
      }
      break;
    case 0x23: {
      tw.printText(str(S.Watch_The_pocket_watch_4A30));
      const h = gameTime.hour % 12;
      tw.printNumber(' ', 1, h === 0 ? 12 : h);
      tw.putChar(0x3a);
      tw.printNumber('0', 2, gameTime.minute);
      tw.printText(str(gameTime.hour < 12 ? S.AM_4A55 : S.PM_4A4F));
      break;
    }
    case 0x24:
      tw.printText(str(S.Badge_4A5B));
      if (useRemoveItem(0x1d) !== 0) {
        tw.printText(str(S.Badge_worn_4A63));
        party.activeSpell = 0x1d;
        party.activeSpellTurns = 0xff;
        status.dirty = true;
      }
      break;
    case 0x25:
      tw.printText(str(S.Box_How_4A70));
      break;
  }
  if (ok === 0) {
    tw.printText(str(S.Failed_4A7B));
    await spellFizzle();
  }
}

// ---- the area spells ----

/**
 * db30: two pixels of the cloud. 0 ends the ray: outside the view, or (on odd rows only, where
 * the square under the pixel is looked up into `sq`) on a square that blocks sight. On even rows
 * `sq` is left as it was: the square of the pixel before.
 */
function plotSpellPixel(color, y, x, sq) {
  if (x < 8 || x > 0xb6 || y < 8 || y > 0xb6) {
    sq.x = sq.y = 0xffff;
    return 0;
  }
  gfx.setDrawColor(color);
  gfx.plotPixel(y, x);
  gfx.plotPixel(y, x + 1);
  sound.speakerOn(randomBetween(10000, 100));
  sound.crackle(300); // port: the original's pixel loop takes about this long on its own
  if ((y & 1) === 0) return 1;
  const s = pixelToSquare(y, x);
  sq.x = s.x;
  sq.y = s.y;
  if (s16(sq.x) > -1 && s16(sq.y) > -1) return isSquareVisible(sq.y, sq.x) ? 1 : 0;
  return 0;
}

const s16 = (v) => ((v & 0xffff) << 16) >> 16;

/**
 * dbb6: a fan of 21 rays from the caster's edge in direction `dir` (1-4 = W E N S). Each ray
 * moves a pixel at a time along the direction and sideways whenever its error term runs out, the
 * first ten to one side, the rest to the other. The rays advance in random bursts of 0-14 pixels
 * until all have ended. Squares showing an object (mask 0) that a ray crosses are listed, from
 * index 1, at most 62: the column to hitY[] and the row to hitX[] (the original's names).
 */
async function traceSpellCone(dir, caster, tile, hitX, hitY, first) {
  let x0 = C(caster).x * 0x10 + 8, y0 = C(caster).y * 0x10 + 8;
  if (dir === 1) y0 += 8;
  else if (dir === 2) { x0 += 0x10; y0 += 8; }
  else if (dir === 3) x0 += 8;
  else if (dir === 4) { x0 += 8; y0 += 0x10; }
  const done = new Array(21).fill(0), px = [], py = [], err = new Int16Array(21);
  let count = 0;
  // The square the last pixel was in: the original starts with the square the direction prompt left.
  const sq = { x: first.x & 0xffff, y: first.y & 0xffff };
  for (let i = 0; i < 21; i++) {
    err[i] = spells.coneSteps[i];
    px[i] = x0;
    py[i] = y0;
  }
  for (;;) {
    let ended = 0;
    for (let i = 0; i < 21; i++) {
      if (done[i]) {
        ended++;
        continue;
      }
      const burst = randomUpto(0x0f);
      for (let step = 0; step < burst && !done[i]; step++) {
        if (plotSpellPixel(tile + 8, py[i], px[i], sq) === 0) {
          done[i] = 1;
        } else if (count < 0x3e && s16(sq.x) > -1 && s16(sq.y) > -1 && sq.x < 0x0b && sq.y < 0x0b && view.mask[sq.y * 0x20 + sq.x] === 0) {
          count++;
          hitY[count] = sq.x;
          hitX[count] = sq.y;
          view.mask[sq.y * 0x20 + sq.x] = 0xff;
        }
        if (done[i]) break;
        err[i] -= 10;
        if (dir === 1) px[i]--;
        else if (dir === 2) px[i]++;
        else if (dir === 3) py[i]--;
        else if (dir === 4) py[i]++;
        if (err[i] < 1) {
          const side = i < 10 ? -1 : 1;
          if (dir === 1) py[i] -= side;
          else if (dir === 2) py[i] += side;
          else if (dir === 3) px[i] += side;
          else if (dir === 4) px[i] -= side;
          err[i] += spells.coneSteps[i];
        }
      }
    }
    if (ended > 20) {
      sound.speakerOff();
      return count;
    }
    await sound.delayLoop(1, 1); // port: plays the crackle queued so far and shows the cloud growing
  }
}

/**
 * dee0: In Zu (1: sleep), In Nox Hur (2: poison), In Flam Hur (3: fire, 0-30) and In Vas Grav Corp
 * (4: death). Sleep and death can be resisted and don't touch the immune; poison misses those
 * whose speed beats a 1-30 roll. The cloud strikes friend and foe alike. A fighter is marked in
 * bit 7 of its timer so it is struck once.
 */
async function castAreaSpell(tile, kind, caster) {
  const hitX = new Array(64).fill(0), hitY = new Array(64).fill(0);
  const m = party.member(C(caster).kind & 0x0f);
  const target = await askSpellDirection();
  await sound.soundNoise(700, kind === 1 ? 16000 : kind === 2 ? 0x4b00 : 0x5140, 800);
  const count = await traceSpellCone(target.dir, caster, tile, hitX, hitY, target);
  for (let k = 1; k <= count; k++) {
    for (let slot = 0x1f; slot >= 0; slot--) {
      const c = C(slot);
      if (c.x !== hitY[k] || c.y !== hitX[k] || (c.timer & 0x80) || (c.flags & 0x20) || c.flags === 0) continue;
      c.timer |= 0x80;
      if (kind === 1) {
        if (combat.magicResistRoll(0, slot, caster) !== 0 || isSpellImmuneKind(slot)) break;
        await combat.flashCombatant(slot);
        await combat.sleepCombatant(slot);
      } else if (kind === 2) {
        const speed = combat.getCombatantStat(-2, slot);
        if (randomStatRoll() < speed) break;
        await combat.flashCombatant(slot);
        await combat.applyPoisonHit(caster, slot);
      } else if (kind === 3) {
        await combat.flashCombatant(slot);
        addWordCapped(9999, await combat.applyDamage(randomUpto(0x1e), slot), m, 'xp');
      } else {
        if (kind !== 4 || combat.magicResistRoll(0, slot, caster) !== 0 || isSpellImmuneKind(slot)) break;
        await combat.flashCombatant(slot);
        addWordCapped(9999, await combat.applyDamage(99, slot), m, 'xp');
      }
      await combat.reportHit(caster, slot);
      break;
    }
  }
  for (let slot = 0; slot < 0x20; slot++) C(slot).timer &= 0x7f;
}
