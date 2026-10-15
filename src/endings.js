// endings.js - BLCKTHRN.OVL (capture by Blackthorn, death and resurrection) and ENDGAME.OVL
// (rescuing Lord British, the ending pictures and the proclamation). These scenes play on the
// 11 x 11 scene map (view.localMap) with the map id SCENE and the actors in the object table.
// Ported from the C++ port's endings.cpp.
import { getCommandKey, readLine, toUpper, waitTurns } from './commands.js';
import { combat } from './combat.js';
import { data, SHARED } from './data/gamedata.js';
import { S, strings } from './data/strings.js';
import { dissolveTile, flashSquare, screenShake, strIndex } from './effects.js';
import { loadFilePart } from './files.js';
import { gameTime } from './gametime.js';
import { gfx } from './gfx.js';
import { input } from './input.js';
import { M, map, passTime } from './map.js';
import { setObjectEntry } from './objects.js';
import { intro, readPages } from './intro.js';
import { randomBetween, subByteFloor0 } from './misc.js';
import { pictures, P } from './data/pictures.js';
import { copyBackRect, copyPage, dosFreeMem, dosFreeMem2, drawPictureFrame, loadBitmap, loadPicture } from './picture.js';
import { drawSkyBar, setWindDirection } from './world.js';
import { party } from './party.js';
import { platform } from './platform/platform.js';
import { sound } from './sound.js';
import { resurrectMember } from './stats.js';
import { status } from './status.js';
import { textWindows as tw } from './text.js';
import { textBuffer } from './textbuf.js';
import { tiles } from './tiles.js';
import { town } from './town.js';
import { video } from './video/video.js';
import { view } from './view.js';

// The six notes as the party is brought back: soundSweep's increment, count, from and step.
const deathNotes = data.words(0x3720, new Uint16Array(24), 'endings.deathNotes');

// The cut-scene scripts (see runCutscene).
const cutsceneScripts = data.bytes(0x369e, new Uint8Array(0x82), 'endings.cutsceneScripts');
// Where the prisoners stand in Blackthorn's chamber: for each number of the living, which places,
// and the places' squares.
const prisonerPlaces = data.bytes(0x1f0a, new Uint8Array(7 * 8), 'endings.prisonerPlaces');
const prisonerX = data.bytes(0x1f42, new Uint8Array(6), 'endings.prisonerX');
const prisonerY = data.bytes(0x1f48, new Uint8Array(6), 'endings.prisonerY');
// The ending's pages, kept field by field like the introduction's.
let pages = [];
data.add(0x3da6, 6 * 17, (b) => { pages = readPages(6, b, 6, 6, 'chapter'); }, 'endings.pages', SHARED);
// Numbers in words for the proclamation: 0-20 "One" ... "Twenty", then from 21 the tens "Thirty"
// ... "Ninety", then from 28 the ordinals "First" ... "Twelfth".
const numberWords = data.words(0x3e0a, new Array(40).fill(0), 'endings.numberWords');
// Where each member walks to at the rescue of Lord British.
const rescueX = data.bytes(0x3e5a, new Uint8Array(6), 'endings.rescueX');
const rescueY = data.bytes(0x3e60, new Uint8Array(6), 'endings.rescueY');

const T = (off) => textBuffer.cString(off); // text loaded from a .DAT file
const str = (id) => strings.get(id);

/** A key, or Return once the window is closed. */
async function key() {
  const k = await getCommandKey();
  return platform.quitRequested() ? 0x0d : k;
}

async function yesNo(yesText, noText) {
  for (;;) {
    let k = await key();
    if (platform.quitRequested()) k = 0x4e;
    if (k === 0x4e) { tw.printText(str(noText)); return 0x4e; }
    if (k === 0x59) { tw.printText(str(yesText)); return 0x59; }
  }
}

/** The scene map: rows of 16 bytes (as loaded from MISCMAPS.DAT into view.tiles) to localMap's rows of 32. */
function loadScene(offset, file) {
  loadFilePart(offset, 0xb0, view.tiles, file);
  for (let r = 0; r < 11; r++) view.localMap.set(view.tiles.subarray(r * 0x10, r * 0x10 + 11), r * 0x20);
}

const classTile = (cls) => party.classTile(strIndex(cls.charCodeAt(0), str(S.AMBFDTPRS_701A)));

// ---- BLCKTHRN: cutscenes ----

/** a290 */
async function cutsceneWait(n) {
  for (; n > 0; n--) {
    await sound.stepSound();
    await waitTurns(2);
  }
}

/**
 * a2be: actor in the high bits: 0x10 / 0x14 the two guards (objects 6, 7), 0x18 Blackthorn (8),
 * 0x1C the Avatar (0), 0x20 the companion (1); low 2 bits: 0 north, 1 east, 2 south, 3 west.
 */
function cutsceneActor(cmd) {
  const dx = [0, 1, 0, -1], dy = [-1, 0, 1, 0];
  let slot = 0;
  switch (cmd & 0xfc) {
    case 0x10: slot = 6; break;
    case 0x14: slot = 7; break;
    case 0x18: slot = 8; break;
    case 0x1c: slot = 0; break;
    case 0x20: slot = 1; break;
  }
  return { slot, dx: dx[cmd & 3], dy: dy[cmd & 3] };
}

// The cut-scenes runCutscene plays.
const SCENE_RELEASE = 0x00, SCENE_THREAT = 0x3c, SCENE_GUARDS_ENTER = 0x64, SCENE_GUARDS_UNCHAIN = 0x70, SCENE_BLACKTHORN_LEAVES = 0x78;

/**
 * a34e: script bytes: 0 end; 1 the next move is two actors together; 2 n = repeat the next move
 * n times; 3 / 4 show each step (default) / move at once; 5 n = wait n turns; 6 tile x y = change
 * the scene; 7 redraw; 8 wait; 9 slot = remove an actor; 0x10 and up = move an actor one step.
 */
async function runCutscene(script) {
  let p = script, animate = 1;
  for (;;) {
    let repeat = 1, cmd, pair = 0;
    for (;;) {
      cmd = cutsceneScripts[p++];
      if (cmd === 0) return;
      if (cmd > 0x0f) break;
      switch (cmd) {
        case 1: pair = 1; break;
        case 2: repeat = cutsceneScripts[p++]; break;
        case 3: animate = 1; break;
        case 4: animate = 0; break;
        case 5: await waitTurns(cutsceneScripts[p++]); break;
        case 6:
          view.localMap[(cutsceneScripts[p + 1] + cutsceneScripts[p + 2] * 0x20) % 0x400] = cutsceneScripts[p];
          p += 3;
          break;
        case 7: await view.worldTick(); break;
        case 8: await cutsceneWait(repeat); repeat = 1; break;
        case 9: {
          const o = map.objects.at(cutsceneScripts[p] & 31);
          o.tile = o.tile2 = 0;
          p++;
          break;
        }
      }
      if (platform.quitRequested()) return;
    }
    const a = cutsceneActor(cmd);
    const b = pair ? cutsceneActor(cutsceneScripts[p++]) : null;
    for (; repeat !== 0; repeat--) {
      const oa = map.objects.at(a.slot);
      oa.x = oa.x + a.dx;
      oa.y = oa.y + a.dy;
      if (b) {
        const ob = map.objects.at(b.slot);
        ob.x = ob.x + b.dx;
        ob.y = ob.y + b.dy;
      }
      if (animate) await cutsceneWait(1);
    }
  }
}

// ---- BLCKTHRN: interrogation ----

/** a508: MISCMSG.DAT holds Blackthorn's lines; three ever harsher demands for the shrine's mantra. */
function blackthornDemand(shrine, attempt) {
  const line = [0, 0x2d, 0x52];
  const tail = [S.Qm_Quote_6F6E, S.Qm_Quote_6F72, S.Qm_Quote_6F76];
  if (attempt >= 0 && attempt <= 2) {
    tw.printText(T(line[attempt]));
    tw.printText(str(map.virtueNames[shrine & 7]));
    tw.printText(str(tail[attempt]));
  } else if (attempt === 3) {
    tw.printText(T(0xac));
  }
}

/** a57a: true if the typed line contains the mantra (any case). */
async function checkMantraAnswer(shrine) {
  tw.printText(str(S.Your_response_6F7A));
  const answer = await readLine(0x0e);
  tw.printText(str(S.NL_NL_6F8E));
  const mantra = str(map.mantras[shrine & 7]);
  const up = (s, i) => toUpper(s.charCodeAt(i));
  for (let at = 0; at <= answer.length - mantra.length; at++) {
    let i = 0;
    while (i < mantra.length && up(mantra, i) === up(answer, at + i)) i++;
    if (i === mantra.length) return true;
  }
  return false;
}

/** a63e: the second living member is killed: moved to the end of the roster and marked gone (0x7F). */
async function companionExecuted(say) {
  tw.printText(T(say ? 0xf1 : 0x12d));
  await waitTurns(10);
  for (let f = 2000; f < 25000; f += 0x32) await sound.soundSweep(0, f, 200, 1, 0xa50); // the blade hums up and down
  for (let f = 25000; f > 2000; f -= 0x32) await sound.soundSweep(0, f, 200, 1, 0xa50);
  const o1 = map.objects.at(1);
  await flashSquare(o1.y, o1.x);
  o1.tile = o1.tile2 = 0;
  view.localMap[0xe5] = 0x80;
  let m = 0, living = 0;
  for (; m < party.size; m++) {
    if (!party.member(m).dead()) living++;
    if (living === 2) break;
  }
  party.moveOut(m).where = 0x7f;
  status.drawStatusBar();
  if (say) {
    tw.printText(str(S.NL_NL_6F92));
    tw.printText(party.member(15).name);
    tw.printText(str(S.is_sliced_in_half_6F96));
    await key();
    tw.printText(T(0x1a0));
  }
  tw.putChar(0x0a);
}

/** a7a0 */
async function blackthornRelease() {
  await key();
  await runCutscene(SCENE_RELEASE);
}

/** a7ac */
async function blackthornThreat() {
  tw.printText(T(0x229));
  await runCutscene(SCENE_THREAT);
  tw.printText(T(0x25f));
  tw.printText(party.member(1).name);
  tw.printText(str(S.die_6FAC));
  await key();
  tw.printText(str(S.NL_NL_6FB4));
}

/**
 * a7da: giving the mantra destroys that shrine and costs 5 karma (and, with companions, one of
 * them anyway). Refusing: a threat, then the torture device advances each time, and the fourth
 * refusal kills the companion. Alone, a refusal ends it at once.
 */
async function blackthornInterrogation(alive, shrine) {
  let threatened = false;
  tw.printText(str(S.NL_NL_6FB8));
  for (let attempt = 0; attempt <= 3; attempt++) {
    blackthornDemand(shrine, attempt);
    if (await checkMantraAnswer(shrine)) {
      map.shrineState[shrine] = 0xff;
      subByteFloor0(5, party, 'karma');
      if (alive > 1) await companionExecuted(0);
      else tw.printText(T(0x29c));
      await blackthornRelease();
      return;
    }
    if (alive < 2) {
      tw.printText(T(0x2dc));
      await blackthornRelease();
      return;
    }
    if (!threatened) {
      threatened = true;
      await blackthornThreat();
    } else {
      passTime(2);
      status.drawStatusBar();
      if (attempt === 0) view.localMap[0x125] = 0xea;
      else if (attempt === 1) view.localMap[0x125] = 0xeb;
      else if (attempt === 2) view.localMap[0x125] = 0xe8;
      else await companionExecuted(1);
    }
    if (platform.quitRequested()) return;
  }
}

/**
 * a89e: caught by Blackthorn's guards. While a shrine is still whole the party is dragged to his
 * torture chamber and he wants its mantra; either way it ends in his castle (location 0x12).
 */
export async function capturedByBlackthorn() {
  const alive = party.living();
  let shrine;
  party.transport = 0x1c;
  await view.worldTick();
  tw.printText(str(S.Thou_art_subdued_and_6FBC));
  for (shrine = 0; shrine < 8; shrine++) if (map.shrineState[shrine] === 0) break;
  if (shrine < 8) { // a shrine is still whole: Blackthorn wants its mantra
    await waitTurns(2);
    gfx.setDrawColor(0);
    gfx.fillRect(0xb7, 0xb7, 8, 8);
    map.z = 0xff;
    drawSkyBar();
    setWindDirection(-1);
    for (let i = 5; i !== 0; i--) {
      await input.delayTicks(5);
      await sound.stepSound();
    }
    tw.printText(str(S.Strong_guards_drag_thee_6FE0));
    for (let i = 0; i < (sound.enabled === 0 ? 3 : 0x12); i++) { // a long march, short with sound off
      await input.delayTicks(5);
      await sound.stepSound();
    }
    for (let i = 0; i < 0x20; i++) setObjectEntry(i, 0, 0, 0, 0, 0, 0);
    map.id = M.SCENE;
    combat.turn = 0xff;
    loadScene(0, str(S.MISCMAPS_DAT_7000)); // the torture chamber
    loadFilePart(0, 1000, textBuffer.data, str(S.MISCMSG_DAT_700E));
    for (let i = 0; i < alive; i++) { // where each prisoner stands, by party size
      const pos = prisonerPlaces[(alive % 7) * 8 + (i & 7)];
      const o = map.objects.at(i);
      o.x = prisonerX[pos % 6];
      o.y = prisonerY[pos % 6];
      o.tile = o.tile2 = classTile(party.member(i).cls);
    }
    await waitTurns(0x10);
    tw.printText(str(S.Thou_hast_been_chained_7024));
    await waitTurns(0x32);
    tw.printText(str(S.Footsteps_704C));
    await cutsceneWait(8);
    setObjectEntry(6, 0, 0, 10, 4, 0x70, 0x70);
    setObjectEntry(7, 0, 0, 10, 6, 0x70, 0x70);
    await runCutscene(SCENE_GUARDS_ENTER);
    await sound.soundSweep(5, 100, 13000, 1, 0xaf0);
    setObjectEntry(8, 0, 0, 5, 5, 0x16, 0x16);
    await dissolveTile(5, 5, 0x178); // Blackthorn appears
    setObjectEntry(8, 0, 0, 5, 5, 0x78, 0x78);
    await waitTurns(8);
    tw.printText(str(S.Blackthorn_says_Ah_705A));
    tw.printText(party.member(0).name);
    tw.printText(str(S.Tis_indeed_an_honour_to_7074));
    await key();
    tw.printText(str(S.GUARD_Release_this_good_70A4));
    if (party.member(0).sex === 0x0c) tw.printText(str(S.lady_70C0));
    else if (party.member(0).sex === 0x0b) tw.printText(str(S.man_70C8));
    tw.printText(str(S.at_once_70CE));
    await runCutscene(SCENE_GUARDS_UNCHAIN);
    tw.printText(T(0x32c));
    await key();
    await blackthornInterrogation(alive, shrine);
    if (map.objects.at(8).tile !== 0) await runCutscene(SCENE_BLACKTHORN_LEAVES);
  }
  map.z = 0xff;
  drawSkyBar();
  setWindDirection(-1);
  map.x = 10;
  map.y = 7;
  party.keys = 0;
  map.id = M.PALACE_OF_BLACKTHORN;
}

/**
 * aba0: all dead: a dark, quiet place; Lord British's voice speaks of the party's karma (KARMA.DAT)
 * and brings everyone back to his castle at 6:00, at full health, with karma at least 75 and
 * some food.
 */
export async function partyDeath() {
  const was = map.id;
  party.transport = 0x1e;
  if (map.onTileMap()) await view.worldTick();
  await input.delayTicks(10);
  map.id = M.SCENE;
  combat.turn = 0xff;
  tw.printText(strings.get(S.An_unending_darkness_70E2));
  video.setDrawPage(1);
  gfx.setDrawColor(0);
  gfx.fillRect(0xb7, 0xb7, 8, 8);
  video.setDrawPage(0);
  await copyBackRect(0xb7, 0xb7, 8, 8);
  for (let r = 0; r < 11; r++) view.localMap.fill(0xff, r * 0x20, r * 0x20 + 11);
  for (let i = 0; i < 0x20; i++) setObjectEntry(i, 0, 0, 0, 0, 0, 0);
  await view.worldTick();
  tw.printText(strings.get(S.Thou_hast_found_refuge_7108));
  await input.delayTicks(0x0e);
  tw.printText(strings.get(S.No_evil_lives_here_only_7122));
  await input.delayTicks(0x1c);
  tw.printText(strings.get(S.But_thy_slumber_is_7152));
  view.localMap[0xa5] = 0;
  const me = map.objects.at(0), other = map.objects.at(1);
  me.tile = me.tile2 = 0x1c;
  me.x = me.y = 5;
  await view.worldTick();
  for (let i = 0; i < 6; i++) // six notes
    await sound.soundSweep((deathNotes[18 + i] << 16) >> 16, deathNotes[12 + i], (deathNotes[6 + i] << 16) >> 16, 1, deathNotes[i]);
  tw.printText(strings.get(S.Someone_shouts_FORTIS_7172));
  await input.delayTicks(6);
  other.tile = other.tile2 = 0x16;
  other.x = 2;
  other.y = 7;
  view.localMap[0xe2] = 0;
  await dissolveTile(7, 2, 0x5e);
  view.localMap[0xe2] = 0x5e;
  other.tile = 0;
  await view.worldTick();
  await input.delayTicks(4);
  other.tile = 0x16;
  other.x = 8;
  view.localMap[0xe8] = 0;
  await dissolveTile(7, 8, 0x5f);
  view.localMap[0xe8] = 0x5f;
  other.tile = 0;
  await view.worldTick();
  await input.delayTicks(4);
  tw.printText(strings.get(S.There_is_a_peal_of_719E));
  await screenShake();
  await screenShake();
  view.localMap[0x45] = 0;
  other.tile = other.tile2 = 0x16;
  other.x = 5;
  other.y = 2;
  await dissolveTile(2, 5, 0x174);
  other.tile = other.tile2 = 0x74;
  await view.worldTick();
  tw.printText(strings.get(S.NL_Quote_71BE));
  loadFilePart(party.karmaText(Math.trunc(party.karma / 0x14)), 2000, textBuffer.data, strings.get(S.KARMA_DAT_71C2));
  tw.printText(textBuffer.cString(0));
  tw.putChar(0x22);
  await key();
  tw.printText(strings.get(S.Strange_words_are_71CC));
  await input.delayTicks(4);
  for (let i = 0; i < party.size; i++) {
    await sound.soundSweep(2, 2000, 30000, 1, Math.trunc(0x8e30 / (i + 7))); // a lower note for each
    await resurrectMember(0xff, i);
    party.member(i).hp = party.member(i).maxHp;
    status.drawStatusBar();
  }
  tw.printText(strings.get(S.Vertigo_71EA));
  await input.delayTicks(4);
  video.setDrawPage(1);
  gfx.setDrawColor(0);
  gfx.fillRect(0xb7, 0xb7, 8, 8);
  tiles.drawTileAt(5, 5, 0x11c);
  video.setDrawPage(0);
  await copyBackRect(0xb7, 0xb7, 8, 8);
  if (party.karma < 0x4b) party.karma = 0x4b;
  map.id = M.LORD_BRITISHS_CASTLE;
  map.z = 1;
  party.transport = 0x1c;
  map.x = map.y = 10;
  party.activeSpellTurns = 0;
  party.activeSpell = 0;
  while (gameTime.hour !== 6) passTime(9);
  party.lightSpell = 0;
  party.torchLight = 0;
  if (party.food === 0) party.food = 0x3f;
  if (was !== 0 && was < 0x21) await town.enterTown(1);
}

// ---- ENDGAME ----

/** a290: six pages like the introduction's (text in END.DAT), then ENDSC.16. */
async function endingPictures() {
  const font = loadBitmap(pictures.name(P.STORY_FONT));
  const titles = loadPicture(pictures.name(P.STORY_BACKGROUND));
  let picture = loadPicture(pictures.ending(0));
  let set = 0x31;
  await copyBackRect(199, 0x13f, 0, 0);
  tw.selectTextWindow(0);
  for (let page = 0; page < 6; page++) {
    const pg = pages[page];
    if (pg.set !== set) {
      dosFreeMem(picture);
      set = pg.set;
      picture = loadPicture(pictures.ending(set));
    }
    video.setDrawPage(1);
    tw.putChar(0xff);
    if (pg.chapter === 1) { // a chapter title
      if (page === 0) {
        drawPictureFrame(0, 0, 0xd8, 0, titles);
        drawPictureFrame(0, 0x1c, 0x98, 4, titles);
      } else if (page === 3) {
        drawPictureFrame(0, 0, 0xe0, 5, titles);
        drawPictureFrame(0, 0, 0xb0, 0, titles);
      }
    }
    drawPictureFrame(0, pg.py, pg.px, pg.frame, picture);
    intro.storyLeft = [pg.left[0], pg.left[1]];
    intro.storyRight = [pg.right[0], pg.right[1]];
    intro.storyLineMin = pg.lineMin;
    intro.storyLineMax = pg.lineMax;
    intro.storyX = pg.x;
    intro.storyY = pg.y;
    loadFilePart(pg.text, 2000, textBuffer.data, str(S.END_DAT_81FE));
    intro.drawStoryText(textBuffer.data, font);
    if (page !== 0) await intro.waitAnyKey();
    copyPage(0, 1);
    if (platform.quitRequested()) break;
  }
  dosFreeMem(picture);
  dosFreeMem(titles);
  dosFreeMem2(font);
  await intro.waitAnyKey();
  video.setDrawPage(1);
  tw.putChar(0xff);
  const last = loadPicture(pictures.name(P.END_SCROLL));
  drawPictureFrame(0, 0, 0x28, 0, last);
  dosFreeMem(last);
  copyPage(0, 1);
  video.setDrawPage(0);
}

// The proclamation at the end: the line being put together.
let proclamationLine = '';

/** a4ca: words are collected into a line (39 columns at most), printed when it ends with a new line. */
function printEndingWord(word) {
  for (let i = 0; i < word.length && proclamationLine.length < 0x27; i++) proclamationLine += word[i];
  if (proclamationLine.length > 0 && proclamationLine.endsWith('\n')) {
    tw.printText(proclamationLine);
    proclamationLine = '';
  }
}

/** a51c */
function printNumberWords(n) {
  if (n > 0x14) {
    printEndingWord(str(numberWords[(18 + Math.trunc(n / 10)) % 40]));
    n %= 10;
    if (n === 0) return;
    printEndingWord(str(S.Dash_82C6));
  }
  printEndingWord(str(numberWords[n % 40]));
}

/** a566 */
function printOrdinalWords(n) {
  if (n < 0x0d) {
    printEndingWord(str(numberWords[(27 + n) % 40]));
  } else if (n < 0x14) {
    printNumberWords(n);
    printEndingWord(str(S.th_831E));
  } else {
    printEndingWord(str(S.Twent_8322));
    if (n === 0x14) {
      printEndingWord(str(S.ieth_8328));
    } else {
      printEndingWord(str(S.y_832E));
      printEndingWord(str(numberWords[(7 + n) % 40]));
    }
  }
}

/**
 * a5b6: "Be it known that on the <day> Day of the <month> Month of the Year <year> <name> the
 * Avatar saved the life of our sovereign ..." and how long the quest took, counted from 4-5-139.
 * The original stops here for good.
 */
async function printProclamation() {
  tw.setCursor(1, 0);
  tw.putChar(0xfd);
  tw.putChar(0xfc);
  tw.printText(str(S.Be_it_known_that_on_8332));
  proclamationLine = '';
  printEndingWord(str(S.the_8348));
  printOrdinalWords(gameTime.day);
  printEndingWord(str(S.Day_of_834E));
  printEndingWord(str(S.the_8358));
  printOrdinalWords(gameTime.month);
  printEndingWord(str(S.Month_835E));
  tw.printText(str(S.of_the_Year_8366));
  const year = (gameTime.year << 16) >> 16;
  printNumberWords(Math.trunc(year / 100));
  printEndingWord(str(S.Hundred_8374));
  printNumberWords(year % 100);
  printEndingWord(str(S.NL_NL_837E));
  printEndingWord(party.member(0).name);
  printEndingWord(str(S.the_Avatar_8382));
  tw.printText(str(S.saved_the_life_8390));
  tw.printText(str(S.of_our_sovereign_83A0));
  tw.printText(str(S.Lord_British_thereby_83B2));
  tw.printText(str(S.saving_our_people_83CA));
  tw.printText(str(S.and_our_land_83DE));
  tw.selectFont(1);
  tw.printText(str(S.E_QUE_OF_E_AVATAR_83EE));
  tw.printText(str(S.IS_FOREVER_8404));
  tw.selectFont(0);
  tw.putChar(0xfd);
  tw.printText(str(S.Report_now_thy_Quest_8414));
  let years = year - 0x8b, months = gameTime.month - 4, days = gameTime.day - 5;
  if (days < 0) { days = gameTime.day + 0x17; months = gameTime.month - 5; }
  if (months < 0) { months += 0x0d; years = year - 0x8c; }
  if (years !== 0) {
    printEndingWord(String(years));
    printEndingWord(str(S.year_8438));
    if (years > 1) printEndingWord(str(S.s_843E));
    if (months !== 0 || days !== 0) printEndingWord(str(S.Comma_SP_8440));
  }
  if (months !== 0) {
    printEndingWord(String(months));
    printEndingWord(str(S.month_8444));
    if (months > 1) printEndingWord(str(S.s_844C));
    if (days !== 0) printEndingWord(str(S.Comma_SP_844E));
  }
  if (days !== 0) {
    printEndingWord(String(days));
    printEndingWord(str(S.day_8452));
    if (days > 1) printEndingWord(str(S.s_8458));
  }
  printEndingWord(str(S.NL_845A));
  tw.printText(str(S.to_Lord_British_at_845C));
  while (!platform.quitRequested()) { // the original stops here for good
    input.pollKey();
    await input.delayTicks(1);
  }
}

/** a78e */
async function endingTick() {
  await waitTurns(2);
  await sound.stepSound();
  await waitTurns(3);
}

/** a7a0: one step toward (x, y), along the longer axis first. 1 while it is still walking. */
async function walkEndingActor(y, x, slot) {
  const o = map.objects.at(slot);
  if (o.tile === 0 || (o.x === x && o.y === y) || platform.quitRequested()) return 0;
  const dx = o.x - x, dy = o.y - y;
  if (Math.abs(dx) < Math.abs(dy)) o.y = o.y + (y < o.y ? -1 : 1);
  else o.x = o.x + (x < o.x ? -1 : 1);
  await endingTick();
  return 1;
}

/** a832: half the time, a random step onto floor (0x44). */
async function endingActorLeave(slot) {
  const o = map.objects.at(slot);
  if (o.tile !== 0 && randomBetween(1, 0) !== 0) {
    for (let tries = 0; tries < 8; tries++) {
      let x = o.x, y = o.y;
      switch (randomBetween(3, 0)) {
        case 0: x++; break;
        case 1: x--; break;
        case 2: y++; break;
        case 3: y--; break;
      }
      if (view.at(y * 0x20 + x) === 0x44) {
        o.x = x;
        o.y = y;
        break;
      }
    }
  }
  await waitTurns(1);
}

/**
 * a8d8: Lord British (0x7C) steps out of the mirror; the party gathers, the dead are raised. With
 * the sandalwood box and a "yes", he speaks, opens a moongate home, and the ending follows;
 * otherwise everyone just drifts away, forever.
 */
export async function rescueLordBritish() {
  combat.turn = 0xff;
  status.drawStatusBar();
  tiles.patchTiles(1);
  loadScene(0x210, str(S.MISCMAPS_DAT_8480));
  loadFilePart(0, 1000, textBuffer.data, str(S.ENDMSG_DAT_848E));
  for (let i = 0; i < 32; i++) map.objects.at(i).tile = map.objects.at(i).tile2 = 0;
  const lb = map.objects.at(0x1f);
  lb.tile = lb.tile2 = 0x7c;
  lb.x = 5;
  lb.y = 8;
  lb.flags = 0;
  await waitTurns(0x28);
  while (await walkEndingActor(3, 5, 0x1f));
  for (let i = 0; i < party.size; i++) {
    const p = party.member(i);
    if (p.dead()) {
      tw.putChar(0x0a);
      tw.printText(p.name);
      tw.printText(str(S.lives_849A));
      p.status = 'G';
      p.hp = p.maxHp;
      gfx.setDrawColor(gfx.colorText);
      gfx.xorFillRect(0xb7, 0xb7, 8, 8);
      await sound.soundSweep(1, 5000, -0x63c0, 1, 0x2260);
      status.drawStatusBar();
    }
    const o = map.objects.at(i);
    o.tile = o.tile2 = party.classTile(strIndex(p.cls.charCodeAt(0), str(S.AMBFDTPRS_84A4)));
    o.x = 5;
    o.y = 9;
    o.flags = 0;
    await waitTurns(1);
    while (await walkEndingActor(rescueY[i % 6], rescueX[i % 6], i));
  }
  await waitTurns(0x28);
  tw.printText(T(0));
  tw.printText(party.member(0).name);
  tw.printText(str(S.Bang_Quote_NL_NL_84AE));
  await key();
  tw.printText(T(0x21));
  let answer = await yesNo(S.Yes_84B4, S.No_84BA);
  if (answer === 0x4e) {
    tw.printText(T(0x49));
    answer = await yesNo(S.Yes_84C0, S.No_84C6);
  }
  if (answer === 0x59 && party.sandalwoodBox !== 0) {
    await waitTurns(8);
    while (await walkEndingActor(4, 5, 0));
    while (await walkEndingActor(5, 5, 0));
    await waitTurns(4);
    const box = map.objects.at(6);
    box.tile = box.tile2 = 0x0e;
    box.x = 5;
    box.y = 4;
    box.flags = 0;
    tw.printText(T(0xab));
    await waitTurns(0x28);
    tw.printText(str(S.He_says_84CC));
    await key();
    for (const at of [0xd3, 0x128, 0x167, 0x1c9, 0x211]) {
      tw.printText(T(at));
      await key();
    }
    tw.printText(T(0x24b));
    box.tile = box.tile2 = 8;
    await key();
    await sound.soundSweep(1, 10000, -0x3cb0, 1, 0x1450);
    box.tile = box.tile2 = 0;
    view.localMap[0x85] = 0xdc; // a moongate rises
    for (gameTime.moongatePhase = 1; gameTime.moongatePhase < 0x10; gameTime.moongatePhase++) await waitTurns(1);
    await waitTurns(4);
    while (await walkEndingActor(4, 5, 0x1f));
    lb.tile = lb.tile2 = 0;
    await waitTurns(1);
    for (let i = 0; i < party.size; i++) {
      while (await walkEndingActor(4, 5, i));
      map.objects.at(i).tile = map.objects.at(i).tile2 = 0;
      await waitTurns(1);
    }
    for (gameTime.moongatePhase = 0x0f; gameTime.moongatePhase !== 0; gameTime.moongatePhase--) await waitTurns(1);
    tiles.drawTileAt(4, 5, 0x44);
    video.setDrawPage(1);
    gfx.setDrawColor(0);
    gfx.fillRect(199, 0x13f, 0, 0);
    video.setDrawPage(0);
    await endingPictures();
    await printProclamation();
    return;
  }
  tw.printText(str(S.I_see_84DA));
  await waitTurns(0x28);
  tw.printText(T(0x2d5));
  map.objects.at(0).y--;
  await endingTick();
  while ((await walkEndingActor(6, 8, 2)) + (await walkEndingActor(1, 4, 0x1f)) + (await walkEndingActor(4, 8, 0)) !== 0);
  while (!platform.quitRequested()) { // the original loops here for good
    await endingActorLeave(1);
    await endingActorLeave(3);
    await endingActorLeave(4);
    await endingActorLeave(5);
  }
}
