// world.js - per-turn helpers of the main program shared by the town and outdoor loops: the sky
// bar, the wind, the location label, moongates and the lighthouse beams. Ported from the C++
// port's world.cpp.
import { combat } from './combat.js';
import { data } from './data/gamedata.js';
import { S, strings } from './data/strings.js';
import { loadFilePart, saveFilePart } from './files.js';
import { gameTime } from './gametime.js';
import { gfx } from './gfx.js';
import { M, map } from './map.js';
import { addByteCapped, randomBetween, subByteFloor0, subWordFloor0 } from './misc.js';
import { sound } from './sound.js';
import { tiles } from './tiles.js';
import { conversation } from './talk.js';
import { town } from './town.js';
import { waitTurns } from './commands.js';
import { dissolveTile } from './effects.js';
import { input } from './input.js';
import { party } from './party.js';
import { status } from './status.js';
import { textWindows as tw } from './text.js';
import { view } from './view.js';

/** a5f8: "BRIT.OOL" or "UNDER.OOL". */
export function objectsFileName() {
  return strings.get(map.z === 0 ? S.BRIT_OOL_3989 : S.UNDER_OOL_3992);
}

/** 2a52 */
export async function damageMember(damage, member) {
  status.highlightMemberRow(member);
  await sound.soundNoise(2000, 0x640, 10);
  status.highlightMemberRow(member);
  const m = party.member(member);
  m.hp = (m.hp - damage) & 0xffff;
  if (((m.hp << 16) >> 16) < 1) {
    m.hp = 0;
    m.status = 'D';
    if (member === party.activePlayer) party.activePlayer = 0xff;
  }
  status.drawStatusBar();
}

/** 2aa8: 1-8 to every living member. */
export async function damageParty() {
  for (let i = 0; i < 6; i++) if (i < party.size && !party.member(i).dead()) await damageMember(randomBetween(8, 1), i);
}

/** 2ae8: poison, food at 6, 12 and 18, the spell's turns, the regeneration ring. */
export async function perTurnStatus() {
  let eaters = 0;
  for (let i = 0; i < party.size; i++) {
    const st = party.member(i).status;
    if (st === 'D' && i === party.activePlayer) party.activePlayer = 0xff;
    if (st !== 'D' && st !== 'S') {
      if (st === 'P') await damageMember(1, i);
      eaters++;
    }
  }
  if (gameTime.hour !== gameTime.prevHour) {
    if (party.food === 0) {
      tw.printText(strings.get(S.Starving_54C8)); // "Starving!\n"
      await damageParty();
    } else if (gameTime.hour === 6 || gameTime.hour === 12 || gameTime.hour === 18) {
      subWordFloor0(eaters, party, 'food');
    }
    gameTime.prevHour = gameTime.hour;
  }
  addByteCapped(0xff, 1, conversation, 'almsCounter');
  if (party.activeSpellTurns !== 0 && party.activeSpellTurns !== 0xff && --party.activeSpellTurns === 0) {
    party.activeSpell = 0;
    status.drawStatusBar();
  }
  status.regenRingTick();
}

/** 2fa6 */
export function poisonMember(member) {
  if (member < party.size && !party.member(member).dead()) {
    party.member(member).status = 'P';
    status.drawStatusBar();
  }
}

/** 3abe: 1-30 */
export function randomStatRoll() {
  const r = randomBetween(0x3c, 0) >> 1;
  return r === 0 ? 1 : r;
}

// The kind of trap a chest springs outside a scene, one of eight (ds:559E): 0 0 0 1 1 2 2 3.
const trapKinds = data.bytes(0x559e, new Uint8Array(8), 'world.trapKinds');

/** 2fd0: acid, poison, a bomb or gas. */
export async function springTrap(member) {
  await sound.soundNoise(500, 3000, 0x28);
  const kind = !map.inScene() ? trapKinds[randomBetween(7, 0)] : randomBetween(1, 0);
  if (kind === 0) {
    tw.printText(strings.get(S.ACID_5581));
    await damageMember(randomStatRoll(), member);
  } else if (kind === 1) {
    tw.printText(strings.get(S.POISON_5588));
    poisonMember(member);
  } else if (kind === 2) {
    tw.printText(strings.get(S.BOMB_5591));
    await damageParty();
  } else if (kind === 3) {
    tw.printText(strings.get(S.GAS_5598));
    for (let i = 0; i < 6; i++) poisonMember(i);
  }
}

/** 4702: is moonstone n buried on this map (and outdoors, in the window)? */
export function moonstoneHere(n) {
  if (map.moonstoneLoc[n] !== map.id || map.moonstoneZ[n] !== map.z) return false;
  if (map.isOutdoors()) {
    if (((map.moonstoneX[n] - map.originX) & 0xff) > 0x1f) return false;
    if (((map.moonstoneY[n] - map.originY) & 0xff) > 0x1f) return false;
  }
  return true;
}

/** 475a: from 20:00 to 4:59 the gates rise a row a tick; by day they sink back to grass. */
export function updateMoongates() {
  let tile = 0xdc;
  if (gameTime.hour < 0x14 && gameTime.hour > 4) {
    subByteFloor0(1, gameTime, 'moongatePhase');
    if (gameTime.moongatePhase === 0) tile = 5;
  } else {
    addByteCapped(0x10, 1, gameTime, 'moongatePhase');
  }
  for (let i = 0; i < 8; i++) {
    if (!moonstoneHere(i)) continue;
    const old = map.getTile(map.moonstoneY[i], map.moonstoneX[i]);
    map.setTile(map.moonstoneY[i], map.moonstoneX[i], tile);
    view.rebuild = true;
    if (old !== tile) view.updateLightMap();
  }
}

/**
 * 47f4: to the moonstone's place. From a town a gate leads only to another town; between the
 * surface and anything else only the position changes. False if the stone is carried.
 */
export async function moongateTravel(moonstone) {
  if (map.moonstoneLoc[moonstone] === 0xff) return false;
  if (map.isOutdoors()) saveFilePart(0x100, map.objects.bytes, objectsFileName());
  const dest = map.moonstoneLoc[moonstone];
  map.x = map.moonstoneX[moonstone];
  map.y = map.moonstoneY[moonstone];
  map.z = map.moonstoneZ[moonstone];
  if (dest === 0 || map.isOutdoors() || dest > 0x20 || !map.onTileMap()) {
    if (dest === 0 && map.isOutdoors()) {
      loadFilePart(0, 0x100, map.objects.bytes, objectsFileName());
      map.enterOutdoors();
    }
  } else {
    map.id = dest;
    await town.enterTown(1);
  }
  return true;
}

/**
 * 48a8: standing on a moongate the party dissolves into it and arrives at the moonstone chosen by
 * the moon overhead (Trammel before noon, Felucca after). In the first ten minutes after
 * midnight it leads to a shrine instead (returns true).
 */
export async function checkMoongate() {
  let shrine = false;
  if (map.getTile(map.y, map.x) !== 0xdc) return false;
  await waitTurns(1);
  await sound.soundSweep(2, 2000, 30000, 1, 0x170c);
  const transport = party.transport;
  party.transport = 0x16;
  await dissolveTile(5, 5, 0xdc);
  party.transport = 0;
  await waitTurns(1);
  gameTime.moongatePhase = 0x0f;
  do {
    tiles.shimmerTiles(5, 5, gameTime.moongatePhase, map.inScene());
    await input.delayTicks(2);
  } while (--gameTime.moongatePhase !== 0);
  map.setTile(map.y, map.x, 5);
  view.rebuild = true;
  tiles.drawTileAt(5, 5, 5);
  if (gameTime.hour === 0 && gameTime.minute < 10) shrine = true;
  else await moongateTravel((gameTime.hour < 0x0c ? gameTime.moon1Phase : gameTime.moon2Phase) - 0x30);
  party.transport = transport;
  return shrine;
}

/**
 * 4988: the member a command is for - the active player if one is set; otherwise the only able
 * member, or "Player: " asks. -1 = none.
 */
export async function askWhichMember() {
  let member = -1;
  if (map.id >= 0x81) {
    member = combat.combatants[combat.turn & 0x1f].kind;
  } else if (party.activePlayer !== 0xff) {
    member = party.activePlayer;
  } else {
    let able = 0;
    for (let i = 0; i !== party.size; i++)
      if (party.member(i).good() || party.member(i).poisoned()) {
        able++;
        member = i;
      }
    if (able > 1) {
      for (;;) {
        tw.printText(strings.get(S.Player_A3C4)); // "Player: "
        member = await status.askMemberNumber();
        if (member < 0) break;
        if (party.member(member).good() || party.member(member).poisoned()) {
          tw.printText(party.member(member).name);
          if (tw.getCursorCol() !== 0) tw.putChar(0x0a);
          break;
        }
        tw.printText(strings.get(S.Disabled_A3CE)); // "Disabled!\n\n"
      }
    }
  }
  if (member === -1) tw.printText(strings.get(S.None_A3DA));
  else if (member === -2) tw.putChar(0x0a);
  return member;
}

/** 2e96: dir -1 only redraws the label. */
export function setWindDirection(dir) {
  if (dir !== -1) {
    map.windDirection = dir;
    party.sailCounter = 0;
  }
  if (!map.onTileMap() || map.id === M.ARARAT) return;
  if (map.z > 0x7f) { // underground: a plain frame instead of the label
    gfx.setDrawColor(gfx.colorText);
    gfx.drawLine(0xb8, 0x98, 0xb8, 0x30);
    gfx.setDrawColor(gfx.colorFrame);
    gfx.fillRect(0xbf, 0x98, 0xb9, 0x30);
    return;
  }
  tw.selectTextWindow(0);
  tw.setCursor(0x17, 6);
  status.drawLabelLeft();
  const names = [S.Calm_555C, S.North_5562, S.South_5568, S.East_556E, S.West_5574];
  if (map.windDirection < 5) tw.printText(strings.get(names[map.windDirection]));
  tw.printText(strings.get(S.Winds_557A)); // " Winds"
  status.drawLabelRight();
  tw.selectTextWindow(2);
}

/** 2f62 */
export function randomWindChange() {
  if (randomBetween(0x3f, 0) !== 0) return;
  let dir;
  do {
    dir = randomBetween(4, 0);
    if (dir !== 0) break;
  } while (randomBetween(0xff, 0) < 0xc0); // calm is rarer
  setWindDirection(dir);
}

/** 4a84: the sun ('*' in the rune font) and the two moons along the top of the view. */
export function drawSkyBar() {
  if (!map.onTileMap()) return;
  const sky = new Array(12).fill(0x20);
  tw.inWindow(0, () => {
    tw.selectFont(1);
    let col = 0x11 - gameTime.hour;
    if (col < 12 && col >= 0) sky[col] = 0x2a;
    gameTime.moon1Phase = gameTime.moonPhase(gameTime.day, 0);
    col = 8 - gameTime.hour;
    if (col < -12) col += 24;
    if (col < 12 && col >= 0) sky[col] = gameTime.moon1Phase;
    gameTime.moon2Phase = gameTime.moonPhase(gameTime.day, 1);
    col = 2 - gameTime.hour;
    if (col < -12) col += 24;
    if (col < 12 && col >= 0) sky[col] = gameTime.moon2Phase;
    tw.setCursor(0, 6);
    if (map.id === M.ARARAT || map.z > 0x7f) {
      gfx.setDrawColor(gfx.colorFrame);
      gfx.fillRect(6, 0x98, 0, 0x28);
      gfx.setDrawColor(gfx.colorText);
      gfx.drawLine(7, 0x98, 7, 0x28);
    } else {
      for (const c of sky) {
        tw.setTextColor(c === 0x2a ? gfx.colorChest : gfx.colorLadder);
        tw.putChar(c);
      }
      tw.setTextColor(gfx.colorText);
    }
    tw.selectFont(0);
  });
}

/** 4be8 */
export function clearLocationLabel() {
  tw.inWindow(0, () => {
    if (map.id !== M.ARARAT && map.z < 0x80) {
      tw.setCursor(0, 5);
      status.drawLabelLeft();
      tw.printText(strings.get(S.SP_SP_SP_SP_A3E2)); // twelve spaces
      status.drawLabelRight();
    }
  });
}

/** 7040: a lighthouse beam shape lit (set 1) or cleared in the light map. */
export function stampViewShape(y, x, set, shape) {
  const v = set === 1 ? 0xff : 0;
  const base = (shape % 0x10) * 32;
  for (let i = 0; i < 0x10; i++) {
    const off = (map.beamShapes[base + i * 2 + 1] + y) * 0x20 + map.beamShapes[base + i * 2] + x;
    if (off >= 0 && off < 0x400) view.localMap[off] = v;
  }
}

/** 70a6: while it is dark and the map has a light source, three consecutive shapes are lit. */
export function animateLightBeams() {
  if (view.lightRadius > 0x31 || map.beam1X === 0xffff) {
    map.beamFrame = 0xff;
    return;
  }
  const two = map.beam2X !== 0xffff;
  view.rebuild = true;
  if (map.beamFrame === 0xff) {
    map.beamFrame = 0;
    for (let s = 0; s < 3; s++) stampViewShape(map.beam1Y, map.beam1X, 1, s);
    if (two) for (let s = 0; s < 3; s++) stampViewShape(map.beam2Y, map.beam2X, 1, s);
  } else {
    stampViewShape(map.beam1Y, map.beam1X, 0, map.beamFrame);
    if (two) stampViewShape(map.beam2Y, map.beam2X, 0, map.beamFrame);
    map.beamFrame++;
    stampViewShape(map.beam1Y, map.beam1X, 1, map.beamFrame + 2);
    if (two) stampViewShape(map.beam2Y, map.beam2X, 1, map.beamFrame + 2);
  }
  if (map.beamFrame > 0x0f) map.beamFrame = 0;
}
