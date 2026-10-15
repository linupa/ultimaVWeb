// shrine.js - the shrines (the rest of CAST2.OVL): the eight shrines of virtue and the Shrine of
// the Codex. Ported from the C++ port's shrine.cpp.
//
// A visit is a small scene on an 11 x 11 map from MISCMAPS.DAT (0xB0 the shrine, 0x160 the Codex),
// with the map id SCENE and the map's objects put aside; the texts come from MISCMSG.DAT at 0x3AB.
// Meditating with the right virtue and mantra gives a sacred quest (a bit in party.sacredQuest);
// the Codex then answers it (a bit in party.codexAnswered) and the shrine rewards the return.
import { getCommandKey, readLine, toUpper, waitTurns } from './commands.js';
import { combat } from './combat.js';
import { data } from './data/gamedata.js';
import { S, strings } from './data/strings.js';
import { screenShake } from './effects.js';
import { loadFilePart } from './files.js';
import { gfx } from './gfx.js';
import { M, map, passTime } from './map.js';
import { addByteCapped, strFindNocase } from './misc.js';
import { setObjectEntry } from './objects.js';
import { party } from './party.js';
import { platform } from './platform/platform.js';
import { sound } from './sound.js';
import { status } from './status.js';
import { textWindows as tw } from './text.js';
import { textBuffer } from './textbuf.js';
import { view } from './view.js';

/** MISCMSG.DAT from 0x3AB, loaded by visitShrine. */
const msg = (off) => textBuffer.cString(off);

// By shrine 0-7: the virtue to meditate on, where its quest text is in MISCMSG.DAT, and whether
// finishing the quest raises strength, dexterity or intelligence; by Codex question 0-7, where its
// text is. The urns: for 1-8 of them, the first of their places, and the places' x and y. The
// tune the shrine plays: seven sweeps.
const virtueWords = data.words(0x4b3e, new Array(8).fill(0), 'shrine.virtueWords');
const questTexts = data.words(0x4b5e, new Uint16Array(8), 'shrine.questTexts');
const codexTexts = data.words(0x4b6e, new Uint16Array(8), 'shrine.codexTexts');
const givesStr = data.bytes(0x4b7e, new Uint8Array(8), 'shrine.givesStr');
const givesDex = data.bytes(0x4b86, new Uint8Array(8), 'shrine.givesDex');
const givesInt = data.bytes(0x4b8e, new Uint8Array(8), 'shrine.givesInt');
const urnFirst = data.bytes(0x4b96, new Uint8Array(8), 'shrine.urnFirst');
const urnX = data.bytes(0x4b9e, new Uint8Array(36), 'shrine.urnX');
const urnY = data.bytes(0x4bc2, new Uint8Array(36), 'shrine.urnY');
const tuneIncrement = data.words(0x4be6, new Uint16Array(7), 'shrine.tuneIncrement');
const tuneCount = data.words(0x4bf4, new Int16Array(7), 'shrine.tuneCount');
const tuneFrom = data.words(0x4c02, new Uint16Array(7), 'shrine.tuneFrom');
const tuneStep = data.words(0x4c10, new Int16Array(7), 'shrine.tuneStep');

/** eaf4: 1-8 urns stand around the altar, as objects 1 up with tile 3. */
export function shrinePlaceUrns(count) {
  if (count < 1) return;
  let pos = urnFirst[(count - 1) & 7];
  for (let i = 0; i < count && pos < 36; i++, pos++) setObjectEntry(i + 1, 0, map.z, urnY[pos], urnX[pos], 3, 3);
}

async function flashAndHum(length, pitch) {
  gfx.setDrawColor(gfx.colorText);
  gfx.xorFillRect(0xb7, 0xb7, 8, 8);
  for (let f = 2000; f < 25000; f += 0x32) await sound.soundSweep(0, f, length, 1, pitch);
  for (let f = 25000; f > 2000; f -= 0x32) await sound.soundSweep(0, f, length, 1, pitch);
}

/**
 * eb46: the virtue is matched on its first four letters, the mantra three times. Then:
 *  - not yet answered at the Codex: the quest is given (or given again);
 *  - answered, quest not held: an offering of 100-900 gold buys 1-9 karma;
 *  - answered and the quest held: "WELL DONE!", karma +3 (+6 at Humility) and +1 to the Avatar's
 *    strength, dexterity and intelligence as the tables say.
 */
export async function virtueShrine() {
  let shrine;
  for (shrine = 0; shrine < 8; shrine++) if (map.shrineXs[shrine] === map.x && map.shrineYs[shrine] === map.y) break;
  if (shrine === 8) shrine = 6; // reached through the midnight moongate: Spirituality
  const bit = 1 << shrine;
  const me = map.objects.at(0);
  me.tile = me.tile2 = 0x6c; // kneeling
  await view.worldTick();
  tw.printText(msg(0x36d));
  await waitTurns(10);
  tw.printText(msg(0x398));
  let typed = await readLine(0x0c);
  if (typed === '') return;
  let ok = strFindNocase(typed, strings.get(virtueWords[shrine])) !== -1;
  await waitTurns(6);
  tw.putChar(0x0a);
  for (let i = 0; i < 3; i++) {
    tw.printText(strings.get(S.Mantra_958E));
    typed = await readLine(0x0c);
    if (typed === '') return;
    if (strFindNocase(typed, strings.get(map.mantras[shrine])) === -1) ok = false;
    await waitTurns(0x0c);
  }
  if (!ok) {
    tw.printText(msg(0x3c0));
    return;
  }
  if (!(party.codexAnswered & bit)) {
    party.sacredQuest |= bit;
    tw.printText(msg(0x3e1));
    me.tile = me.tile2 = 0x1c;
    await getCommandKey();
    tw.printText(msg(0x40e));
    tw.printText(msg(questTexts[shrine]));
    tw.printText(strings.get(S.Quote_NL_9598));
    await getCommandKey();
    tw.printText(msg(0x44b));
    for (let i = 0; i < 7; i++) await sound.soundSweep(tuneStep[i], tuneFrom[i], tuneCount[i], 1, tuneIncrement[i]);
  } else if (!(party.sacredQuest & bit)) {
    let n;
    for (;;) {
      tw.printText(msg(0x474));
      let key;
      do {
        key = await getCommandKey();
        if (platform.quitRequested()) return;
      } while (key < 0x30 || key > 0x39);
      tw.putChar(key);
      n = key - 0x30;
      if (n === 0) {
        tw.printText(strings.get(S.gp_959C));
        return;
      }
      tw.printText(strings.get(S.N00_gp_95A2));
      if (n * 100 <= ((party.gold << 16) >> 16)) break;
      tw.printText(msg(0x49b));
    }
    party.gold = (party.gold - n * 100) & 0xffff;
    status.drawStatusBar();
    addByteCapped(99, n, party, 'karma');
    tw.selectFont(1);
    tw.printText(strings.get(S.ALAKAZAM_95AA));
    tw.selectFont(0);
    tw.printText(strings.get(S.Bang_NL_95B4));
    await flashAndHum(200, 0xa8c);
  } else {
    party.sacredQuest &= ~bit & 0xff;
    tw.printText(msg(0x4b9));
    await flashAndHum(0x96, 0xc1c);
    await screenShake();
    addByteCapped(99, 3, party, 'karma');
    if (givesStr[shrine] !== 0) {
      addByteCapped(0x1e, 1, party.member(0), 'str');
      tw.printText(strings.get(S.Strength_1_95B8));
    }
    if (givesDex[shrine] !== 0) {
      addByteCapped(0x1e, 1, party.member(0), 'dex');
      tw.printText(strings.get(S.Dexterity_1_95C6));
    }
    if (givesInt[shrine] !== 0) {
      addByteCapped(0x1e, 1, party.member(0), 'intel');
      tw.printText(strings.get(S.Intelligence_1_95D4));
    }
    if (shrine === 7) addByteCapped(99, 3, party, 'karma');
  }
  await waitTurns(10);
}

/**
 * ef04: the book opens at the page of the first quest held and answers it. With all eight
 * answered the page turns once more: the four rune texts that tell how to enter Doom.
 */
export async function codexShrine() {
  await getCommandKey();
  tw.printText(msg(0x4e5));
  await getCommandKey();
  tw.printText(msg(0x515));
  await getCommandKey();
  let q;
  for (q = 0; q < 8; q++) if (party.sacredQuest & (1 << q)) break;
  if (q === 8) {
    tw.printText(msg(0x53e));
    return;
  }
  party.codexAnswered |= 1 << q;
  tw.putChar(0x22);
  tw.printText(msg(codexTexts[q]));
  tw.printText(strings.get(S.Quote_NL_NL_95E6));
  await getCommandKey();
  if (party.codexAnswered !== 0xff) return;
  for (let i = 0; i < 3; i++) {
    gfx.setDrawColor(i & 1 ? gfx.colorText : gfx.colorFire);
    gfx.xorFillRect(0xb7, 0xb7, 8, 8);
    await screenShake();
  }
  tw.printText(msg(0x555));
  await getCommandKey();
  tw.printText(strings.get(S.Thou_dost_read_95EA));
  for (const page of [0x57f, 0x5d1, 0x60c, 0x680]) {
    tw.selectFont(1);
    tw.printText(msg(page));
    tw.selectFont(0);
    await getCommandKey();
  }
}

/** f044 */
async function shrineWalkStep() {
  await waitTurns(1);
  await sound.stepSound();
  await waitTurns(4);
}

/**
 * f056: the Avatar walks in from the bottom of the scene to the altar (4 steps) or the Codex (7),
 * and out again; 16 minutes pass. At the Codex the urns' names are read on the way.
 */
export async function visitShrine() {
  const codex = map.getTile(map.y, map.x) === 0x11;
  view.rebuild = true;
  map.savedLocation = map.id;
  map.id = M.SCENE;
  combat.turn = 0xff;
  map.objectsBackup.set(map.objects.bytes);
  for (let i = 0; i < 0x20; i++) map.objects.at(i).tile = 0;
  loadFilePart(codex ? 0x160 : 0xb0, 0xb0, view.tiles, strings.get(S.MISCMAPS_DAT_95FC));
  textBuffer.data.fill(0);
  loadFilePart(0x3ab, 2000, textBuffer.data, strings.get(S.MISCMSG_DAT_9618));
  for (let r = 0; r < 11; r++) view.localMap.set(view.tiles.subarray(r * 0x10, r * 0x10 + 11), r * 0x20);
  await view.worldTick();
  let urns = 0;
  for (let m = 1; m < 16; m++) if (party.member(m).where === 0x7f) urns++;
  if (urns > 0) shrinePlaceUrns(urns > 8 ? 8 : urns);
  tw.printText(msg(codex ? 0x6db : 0x6ae));
  for (let i = 4; i !== 0; i--) await shrineWalkStep();
  const me = map.objects.at(0);
  me.tile = me.tile2 = 0x1c;
  me.x = 5;
  me.y = 10;
  me.z = map.z;
  await shrineWalkStep();
  if (codex && urns > 0) {
    tw.printText(strings.get(S.Thou_dost_see_9624));
    tw.printText(strings.get(urns === 1 ? S.an_urn_marked_9636 : S.urns_marked_9648));
    for (let m = 1; m < 16; m++) {
      if (party.member(m).where !== 0x7f) continue;
      for (const ch of party.member(m).name) tw.putChar(toUpper(ch.charCodeAt(0)));
      tw.putChar(0x0a);
    }
  }
  for (let i = codex ? 7 : 4; i !== 0; i--) {
    me.y--;
    await shrineWalkStep();
  }
  if (codex) await codexShrine();
  else await virtueShrine();
  me.tile = me.tile2 = 0x1c;
  await waitTurns(1);
  while (me.y < 10) {
    me.y++;
    await shrineWalkStep();
  }
  me.y = me.x = me.tile = 0;
  for (let i = 4; i !== 0; i--) await shrineWalkStep();
  await waitTurns(10);
  map.objects.bytes.set(map.objectsBackup);
  map.id = map.savedLocation;
  passTime(0x10);
  view.updateLightMap();
}
