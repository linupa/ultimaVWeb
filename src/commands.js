// commands.js - command input and movement helpers: getCommandKey, passability, entering towns,
// direction prompts, typed lines and numbers. Ported from the C++ port's commands.cpp.
import { data } from './data/gamedata.js';
import { S, strings } from './data/strings.js';
import { saveFilePart } from './files.js';
import { input } from './input.js';
import { map } from './map.js';
import { platform } from './platform/platform.js';
import { textWindows as tw } from './text.js';
import { view } from './view.js';
import { objectsFileName } from './world.js';

export const CMD_WEST = 1, CMD_EAST = 2, CMD_NORTH = 3, CMD_SOUTH = 4;

/** 2032 */
export function toUpper(c) {
  return c >= 0x61 && c <= 0x7a ? c - 0x20 : c;
}

/**
 * 266c: waits with the blinking cursor, the world going on (world_tick) at every empty poll on a
 * tile map or in a scene. Keys come back upper case. Arrows stay 1-4; Shift + keypad digits become
 * directions 1-4 and diagonals 0xD3-0xD6; codes 1-4 typed without numpadShift (Ctrl+A to Ctrl+D)
 * become 0xFB-0xFE.
 */
export async function getCommandKey() {
  let key;
  do {
    key = toUpper(await input.waitKeyCursor());
    if (key === 0 && (map.onTileMap() || map.inScene())) await view.worldTick();
    if (platform.quitRequested()) return 0x1b;
  } while (key === 0);
  if (input.numpadShift === 0) {
    if (key < 5) key += 0xfa;
  } else {
    switch (key) {
      case 0x31: key = 0xd4; break;
      case 0x32: key = 4; break;
      case 0x33: key = 0xd6; break;
      case 0x34: key = 1; break;
      case 0x36: key = 2; break;
      case 0x37: key = 0xd3; break;
      case 0x38: key = 3; break;
      case 0x39: key = 0xd5; break;
    }
  }
  return key;
}

// From DATA.OVL: a bit per tile, set = not walkable (ds:54D4); the kind of mover by tile / 4
// (ds:54F4); and from ds:5534 the sides a ship may sail onto a river tile (0x60-0x6F) and a shore
// tile (0x34-0x37) from - the original reaches these as ds:54D4 + tile and ds:5510 + tile.
const blockedBits = data.bytes(0x54d4, new Uint8Array(32), 'commands.blockedBits');
const moverKind = data.bytes(0x54f4, new Uint8Array(64), 'commands.moverKind');
const sailSides = data.bytes(0x5534, new Uint8Array(20), 'commands.sailSides');

/** 2bd4: walkable terrain; furniture (0x90-0x93) only for the party on foot and for people. */
export function landPassable(tile, mover) {
  let ok = (blockedBits[(tile >> 3) & 0x1f] & (0x80 >> (tile & 7))) === 0;
  if ((mover & 0xfe) !== 0x1c && (mover & 0xf0) !== 0x40 && (tile & 0xfc) === 0x90) ok = false;
  return ok;
}

/** 2c2e */
export function waterPassable(tile) {
  return tile < 4 || (tile & 0xf0) === 0x60;
}

/** 2c4c: can mover (a party or object tile) enter tile? By the mover's kind (ds:54F4). */
export function tilePassable(tile, mover) {
  switch (moverKind[(mover >> 2) & 0x3f]) {
    case 0: return landPassable(tile, mover);
    case 1: return waterPassable(tile);
    case 2:
      if ((tile & 0xf0) === 0x60 || waterPassable(tile)) return true;
      return landPassable(tile, mover);
    case 3: return landPassable(tile, mover) && tile !== 0x8f && tile !== 4;
    case 4: return !waterPassable(tile);
    case 5: // ships: shore tiles say which sides can be sailed onto
      if ((tile & 0xfc) === 0x34) return ((8 >> (mover & 3)) & sailSides[tile - 0x34 + 0x10]) !== 0;
      if (!waterPassable(tile)) return false;
      if (tile < 0x60) return true;
      return (sailSides[tile - 0x60] & (8 >> (mover & 3))) !== 0;
    case 6: return tile <= 2;
    case 7: return tile === 4;
    case 8: return tile === 5;
    case 9: return tile === 1;
    case 10: return tile === 7;
    default: return false;
  }
}

/** OUTSUBS a618: the town whose entrance is the party's square. 0 if entered, 1 if none here. */
export function enterTownFromMap(prompt) {
  tw.printText(prompt);
  let i;
  for (i = 0; i < 0x20; i++) if (map.exitX(1 + i) === map.x && map.exitY(1 + i) === map.y) break;
  if (i === 0x20) {
    tw.printText(strings.get(S.What_town_39A8)); // "\nWhat town?\n"
    return 1;
  }
  if (i < 0x0d || i > 0x11) {
    tw.printText(strings.get(S.NL_NL_399C));
    tw.putChar(0xfc);
    tw.printText(map.name(i + 1));
    tw.putChar(0xfb);
  }
  tw.putChar(0x0a);
  saveFilePart(0x100, map.objects.bytes, objectsFileName()); // Britannia's objects wait in BRIT.OOL / UNDER.OOL
  map.id = i + 1;
  map.z = 0;
  map.x = 0x0f;
  map.y = 0x1e;
  return 0;
}

/**
 * 35ec: the four directions and Space ("Pass"). Returns null for Pass, else {dx, dy}: -1, 0 or 1
 * each way. (The original keeps them as words; add them with & 0xFFFF / & 0xFF as it would.)
 */
export async function askDirection() {
  let key;
  do {
    key = (await getCommandKey()) & 0xff;
    if (platform.quitRequested()) return null;
  } while (!(key === 0x20 || (key >= 1 && key <= 4)));
  switch (key) {
    case 1: tw.printText(strings.get(S.West_A2B6)); return { dx: -1, dy: 0 };
    case 2: tw.printText(strings.get(S.East_A2BC)); return { dx: 1, dy: 0 };
    case 3: tw.printText(strings.get(S.North_A2A6)); return { dx: 0, dy: -1 };
    case 4: tw.printText(strings.get(S.South_A2AE)); return { dx: 0, dy: 1 };
    default: tw.printText(strings.get(S.Pass_A2A0)); return null;
  }
}

/** 39cc */
export function restoreOpenDoor(y, x, tile) {
  if (map.isTown() && tile !== 0) map.setTile(y, x, tile);
}

/** 3b1c: a typed line (up to maxLen), the view going on while waiting. */
export async function readLine(maxLen) {
  const saved = input.typeaheadOn;
  let key, s = '';
  input.typeaheadOn = 0;
  do {
    key = await getCommandKey();
    if ((key === 8 || key === 1) && s.length !== 0) {
      tw.eraseChars(1);
      s = s.slice(0, -1);
    } else if (key === 0x1b && s.length !== 0) {
      tw.eraseChars(s.length);
      s = '';
    } else if (key > 0x1f && key < 0x80 && s.length < maxLen) {
      s += String.fromCharCode(key);
      tw.putChar(key);
    }
    if (platform.quitRequested()) break;
  } while (key !== 0x0d);
  input.typeaheadOn = saved;
  return s;
}

/** 3ae6: n x (world_tick + a tick). */
export async function waitTurns(turns) {
  if (!view.worldTickEnabled) return;
  for (; turns > 0; turns--) {
    await view.worldTick();
    await input.delayTicks(1);
  }
}

/** 3b9e: up to maxDigits (5 at most) digits, a leading sign allowed; nothing typed gives 0. */
export async function readNumber(maxDigits) {
  const pow10 = [1, 10, 100, 1000, 10000];
  const digits = [0, 0, 0, 0, 0, 0];
  let n = 0;
  if (maxDigits > 5) maxDigits = 5;
  for (;;) {
    let key = await getCommandKey();
    if (platform.quitRequested()) key = 0x0d;
    if (key >= 0x30 && key <= 0x39) {
      if (n < maxDigits) {
        digits[n++] = key;
        tw.putChar(key);
      }
    } else if ((key === 0x2d || key === 0x2b) && n === 0) {
      digits[n++] = key;
      tw.putChar(key);
    } else if ((key === 8 || key === 1) && n !== 0) {
      n--;
      tw.eraseChars(1);
    } else if (key === 0x1b && n !== 0) {
      tw.eraseChars(n);
      n = 0;
    }
    if (key === 0x0d) {
      let value = 0, place = 0;
      for (let i = n - 1; i > 0; i--) value += (digits[i] - 0x30) * pow10[place++];
      if (digits[0] === 0x2d) value = -value;
      else if (digits[0] > 0x2f) value += pow10[place] * (digits[0] - 0x30);
      return (value << 16) >> 16;
    }
  }
}
