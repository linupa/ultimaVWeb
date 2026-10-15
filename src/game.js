// game.js - starting the game and main's loop: the start-up, Journey Onward, the command
// dispatcher and the main program's command handlers. Ported from the C++ port's game.cpp and
// sdl_main.cpp.
import { cmdBoard, cmdExit, cmdFire, cmdHoleUpBed, cmdIgniteTorch, cmdKlimbGrapple, cmdMixReagents, cmdNewOrder, cmdPush, cmdYell } from './cmds.js';
import { askDirection, getCommandKey } from './commands.js';
import { data } from './data/gamedata.js';
import { pictures, P } from './data/pictures.js';
import { S, strings } from './data/strings.js';
import { files, loadFilePart, saveFilePart } from './files.js';
import { gameClearExit, gameQuit } from './gamestate.js';
import { gfx } from './gfx.js';
import { input } from './input.js';
import { combat } from './combat.js';
import { dungeon } from './dungeon.js';
import { cmdCast, cmdUse } from './magic.js';
import { cmdReady, cmdZstats } from './stats.js';
import { cmdLook, showAreaMap } from './look.js';
import { loadGameFile, map, M, passTime, saveGameFile } from './map.js';
import { randomBetween, setRandomSeed, timeSeed } from './misc.js';
import { outdoor } from './outdoor.js';
import { party } from './party.js';
import { cmdGet, cmdJimmy, cmdOpen, cmdSearch } from './sjog.js';
import { sound } from './sound.js';
import { status } from './status.js';
import { conversation } from './talk.js';
import { textWindows as tw } from './text.js';
import { textBuffer } from './textbuf.js';
import { tiles } from './tiles.js';
import { town } from './town.js';
import { view } from './view.js';
import { objectsFileName } from './world.js';

export const WIN_STATUS = 1;
export const WIN_MESSAGE = 2;

/** The program's start: the game's data, the fonts and the tile set. Throws if something is missing. */
export function startUp(gameFiles) {
  files.game = gameFiles;
  data.load(gameFiles);
  setRandomSeed(timeSeed());
  if (!gfx.videoStart()) throw new Error('cannot read the fonts (IBM.CH, RUNES.CH)');
  if (!tiles.loadTileset(pictures.name(P.TILES))) throw new Error(`cannot read ${pictures.name(P.TILES)}`);
  view.resetTileAnimMap();
  tw.resetTextWindows();
  tw.resetTextAttrs();
  tw.selectFont(0);
}

/**
 * Journey Onward (the -j path of the C++ port): SAVED.GAM, the saved objects as the working .OOL
 * files, the screen's frame and windows. False if there is no saved game.
 */
export function journeyOnward() {
  if (loadGameFile(strings.get(S.SAVED_GAM_31E6)) !== 0 || party.member(0).name === '') return false;
  const ool = new Uint8Array(0x200);
  loadFilePart(0, 0x200, ool, strings.get(S.SAVED_OOL_323F));
  saveFilePart(0x100, ool, strings.get(S.BRIT_OOL_3249));
  saveFilePart(0x100, ool.subarray(0x100), strings.get(S.UNDER_OOL_3252));
  sound.enabled = 1; // as intro_main does
  tiles.originY = 8;
  tw.selectTextWindow(0);
  gfx.drawScreenFrame();
  tw.defineTextWindow(9, 0x27, 1, 0x18, WIN_STATUS);
  tw.defineTextWindow(0x17, 0x27, 0x0b, 0x18, WIN_MESSAGE);
  tw.selectTextWindow(WIN_MESSAGE);
  tw.setTextColor(gfx.colorText);
  view.worldTickEnabled = 1;
  return true;
}

/** 0-6 set the active player. */
export function cmdSetActivePlayer(key) {
  const member = key - 0x31;
  tw.printText(strings.get(S.Set_Active_Plr_A396));
  if (key === 0x30) {
    tw.printText(strings.get(S.None_A3A8));
    party.activePlayer = 0xff;
  } else {
    if (party.size <= member || party.member(member).dead() || party.member(member).asleep()) {
      tw.printText(strings.get(S.Invalid_A3B0));
      return 1;
    }
    party.activePlayer = member;
    tw.printText(party.member(member).name);
    tw.putChar(0x0a);
  }
  status.drawStatusBar();
  return 0;
}

/**
 * H outdoors: on a ship with furled sails, five 5-minute turns, then the hull gains 1-3 at a time
 * until at least 10. Otherwise the party camps for 1-9 hours, with a watch if it wants one
 * (campRest, on a combat map).
 */
async function cmdHoleUp() {
  const tile = map.objects.at(0).tile2;
  tw.printText(strings.get(S.Hole_up_A2C2));
  if ((tile & 0xf8) === 0x20) {
    tw.printText(strings.get(S.repair_A2CE));
    if (map.objects.at(0).tile2 <= 0x23) {
      tw.printText(strings.get(S.Sails_must_be_A2DC));
      tw.printText(strings.get(S.lowered_A2EC));
      view.rebuild = true;
      return;
    }
    for (let i = 0; i < 5; i++) {
      await outdoor.waitIfObject1Near();
      await outdoor.outdoorMonstersTurn();
      if ((party.transport & 0xfc) !== 0x24) return;
      passTime(5);
    }
    const p = map.objects.at(0);
    do {
      p.hull = Math.min(99, p.hull + randomBetween(3, 1));
    } while (p.hull < 10);
    tw.printText(strings.get(S.Hull_now_A2F8));
    tw.printNumber(' ', 2, p.hull);
    tw.printText(strings.get(S.Bang_NL_NL_A302));
    view.rebuild = true;
    status.dirty = true;
    return;
  }
  tw.printText(strings.get(S.camp_A306));
  let here = tile;
  if (map.onTileMap()) here = map.getTile(map.y, map.x);
  if (map.onTileMap() && here !== 0 && here < 4) {
    tw.printText(strings.get(S.On_land_or_ship_A30E));
    view.rebuild = true;
    return;
  }
  if (map.onTileMap() && map.objects.at(0).tile2 !== 0x1c) {
    tw.printText(strings.get(S.On_foot_A322));
    view.rebuild = true;
    return;
  }
  tw.printText(strings.get(S.For_how_many_hours_1_A32C));
  let key;
  do {
    key = (await getCommandKey()) & 0xff;
    if (gameQuit()) return;
  } while (key !== 0x20 && (key < 0x30 || key > 0x39));
  tw.putChar(key);
  tw.putChar(0x0a);
  if (key === 0x20 || key === 0x30) return;
  let able = 0, guard = -1;
  for (let i = 0; i !== party.size; i++) if (party.member(i).good() || party.member(i).poisoned()) able++;
  if (able > 1) {
    tw.printText(strings.get(S.Wilt_thou_set_a_watch_A348));
    let c;
    do {
      c = (await getCommandKey()) & 0xff;
      if (gameQuit()) return;
    } while (c !== 0x59 && c !== 0x4e);
    if (c === 0x4e) {
      tw.printText(strings.get(S.No_A362));
    } else {
      tw.printText(strings.get(S.Yes_A368));
      tw.printText(strings.get(S.Who_will_stand_guard_A36E));
      guard = await status.askMemberNumber();
      tw.putChar(0x0a);
      if (guard === -1 || !party.member(guard).good()) {
        guard = -1;
        tw.printText(strings.get(S.None_posted_A386));
      }
    }
  }
  if (!map.onTileMap()) { // a dungeon camp is a corridor fight map
    combat.flags = 6;
    dungeon.unloadDungeonGraphics();
    dungeon.setupCorridorCombat();
    await combat.runCombat(key - 0x30, guard, combat.flags);
    dungeon.loadDungeonGraphics(0);
    map.objects.bytes.set(map.objectsBackup.subarray(8, 16), 8);
    dungeon.dungeonSpawnMonster(0);
    view.rebuild = true;
    return;
  }
  await combat.campAmbushCombat(key - 0x30, guard);
  view.rebuild = true;
}

/** Q: SAVED.GAM and SAVED.OOL (BRIT.OOL then UNDER.OOL); in the browser main.js keeps them (files.onWrite). */
async function cmdQuitSave() {
  tw.printText(strings.get(S.Save_game_9658));
  let c;
  do {
    c = await getCommandKey();
    if (gameQuit()) return;
  } while (c !== 0x59 && c !== 0x4e);
  if (c === 0x4e) {
    tw.printText(strings.get(S.No_9666));
    return;
  }
  tw.printText(strings.get(S.Yes_Saving_966A));
  loadFilePart(0, 0x100, textBuffer.data.subarray(0x100, 0x200), strings.get(S.UNDER_OOL_967A));
  loadFilePart(0, 0x100, textBuffer.data.subarray(0, 0x100), strings.get(S.BRIT_OOL_9684));
  saveGameFile(strings.get(S.SAVED_GAM_9698));
  saveFilePart(0x200, textBuffer.data, strings.get(S.SAVED_OOL_96A2));
  tw.printText(strings.get(S.Done_96AC));
}

/** A command letter: 1 = a turn passes, 0 = none, 2 = a talk that ended in arrest. */
export async function dispatchCommand(key) {
  switch (key) {
    case 0x20:
      if (map.isOutdoors() && party.sailDirection !== 0) {
        tw.printText(strings.get(S.Sheets_in_irons_A122));
        party.sailDirection = 0;
        return 1;
      }
      tw.printText(strings.get(S.Pass_A134));
      return 1;
    case 0x41: // A
      if (map.isOutdoors()) return outdoor.cmdAttackOutdoor();
      if (!map.onTileMap()) return dungeon.cmdAttackDungeon();
      return town.cmdAttackTown();
    case 0x42: // B
      tw.printText(strings.get(S.Board_A13A));
      return cmdBoard();
    case 0x43: // C
      tw.printText(strings.get(S.Cast_A142));
      return cmdCast();
    case 0x44:
      tw.printText(strings.get(S.D_What_A14C));
      return 0;
    case 0x45: // E
      if (map.isOutdoors()) return outdoor.cmdEnter();
      tw.printText(strings.get(S.Enter_what_A156));
      return 1;
    case 0x46: // F
      tw.printText(strings.get(S.Fire_A164));
      await cmdFire();
      return 1;
    case 0x47: // G
      if (map.onTileMap()) tw.printText(strings.get(S.Get_A16A));
      await cmdGet();
      return 1;
    case 0x48: { // H
      if (map.isOutdoors() || !map.onTileMap()) {
        await cmdHoleUp();
        return 1;
      }
      const tile = map.getTile(map.y, map.x);
      tw.printText(strings.get(S.Hole_up_A170));
      if (tile === 0xab) await cmdHoleUpBed();
      else tw.printText(strings.get(S.Only_in_bed_A17A));
      return 1;
    }
    case 0x49: // I
      tw.printText(strings.get(S.Ignite_torch_A188));
      cmdIgniteTorch();
      return 1;
    case 0x4a: // J
      tw.printText(strings.get(S.Jimmy_A198));
      await cmdJimmy();
      return 1;
    case 0x4b: // K
      if (map.isOutdoors()) {
        tw.printText(strings.get(S.Klimb_A1A0));
        await cmdKlimbGrapple();
        return 1;
      }
      if (!map.onTileMap()) return dungeon.cmdKlimbDungeon();
      return town.cmdKlimbTown();
    case 0x4c: // L
      tw.printText(strings.get(S.Look_A1A8));
      if (map.isDungeon()) {
        tw.printText(strings.get(S.Dot_Dot_Dot_NL_A1AE));
        await dungeon.cmdLookDungeon();
        return 1;
      }
      tw.putChar(0x2d);
      await cmdLook();
      return 1;
    case 0x4d: // M
      tw.printText(strings.get(S.Mix_Reagents_A1B4));
      await cmdMixReagents();
      return 1;
    case 0x4e: // N
      tw.printText(strings.get(S.New_Order_A1C4));
      await cmdNewOrder();
      return 1;
    case 0x4f: // O
      tw.printText(strings.get(S.Open_A1CE));
      await cmdOpen();
      return 1;
    case 0x50: // P
      if (!map.isDungeon()) {
        tw.printText(strings.get(S.Push_A1E4));
        await cmdPush();
        return 1;
      }
      tw.printText(strings.get(S.Push_Not_here_A1D4));
      return 0;
    case 0x51: // Q
      tw.printText(strings.get(S.Quit_A1EA));
      await cmdQuitSave();
      return 0;
    case 0x52: // R
      tw.printText(strings.get(S.Ready_A1F0));
      await cmdReady();
      return 1;
    case 0x53: // S
      tw.printText(strings.get(map.onTileMap() ? S.Search_A1FC : S.Search_A204));
      await cmdSearch();
      return 1;
    case 0x54: // T
      if (map.isOutdoors()) {
        tw.printText(strings.get(S.Talk_A210));
        if (!(await askDirection())) return 1;
        tw.printText(strings.get(S.Funny_no_response_A216));
        return 1;
      }
      if (map.onTileMap()) {
        tw.printText(strings.get(S.Talk_A246));
        return (await conversation.cmdTalk()) !== 0 ? 2 : 1;
      }
      tw.printText(strings.get(S.Talk_Funny_no_response_A22C));
      return 1;
    case 0x55: // U
      tw.printText(strings.get(S.Use_item_A24C));
      await cmdUse();
      return 1;
    case 0x56: // V
      tw.printText(strings.get(S.View_a_gem_A258));
      if (party.gems === 0) {
        tw.printText(strings.get(S.You_have_none_A266));
        return 1;
      }
      party.gems--;
      if (!map.onTileMap()) await dungeon.showDungeonMap();
      else await showAreaMap(map.y, map.x);
      return 1;
    case 0x57:
      tw.printText(strings.get(S.W_What_A276));
      return 0;
    case 0x58: // X
      tw.printText(strings.get(S.X_it_A280));
      cmdExit();
      return 1;
    case 0x59: // Y
      tw.printText(strings.get(S.Yell_A286));
      return cmdYell();
    case 0x5a: // Z
      tw.printText(strings.get(S.Z_stats_A28C));
      await cmdZstats();
      return 1;
    case 0xfc: // the type-ahead buffer toggle
      tw.printText(strings.get(S.Buffer_O_A110));
      input.typeaheadOn = input.typeaheadOn === 0 ? 1 : 0;
      tw.printText(strings.get(input.typeaheadOn === 0 ? S.n_A11E : S.ff_A11A));
      return 0;
  }
  tw.printText(strings.get(S.What_A298));
  return 0;
}

/**
 * main's loop. Coming from Britannia (or a dungeon) a town is entered fresh; a saved game inside a
 * town carries on with what was saved. After a town Britannia's objects come back from BRIT.OOL /
 * UNDER.OOL.
 */
export async function gameRun() {
  gameClearExit();
  status.drawStatusBar();
  let fromDungeon = false;
  if (map.inScene()) { // can't be: combat isn't saved
    map.id = M.BRITANNIA;
    loadFilePart(0, 0x100, map.objects.bytes, objectsFileName());
  }
  for (;;) {
    const outdoors = map.isOutdoors();
    if (outdoors) {
      await outdoor.outdoorStart();
      fromDungeon = false;
      if (gameQuit() || map.isOutdoors()) return;
    }
    if (map.onTileMap()) {
      await town.enterTown(outdoors || fromDungeon ? 1 : 0);
      await town.townMainLoop();
      fromDungeon = false;
    } else {
      await dungeon.dungeonMainLoop(outdoors ? 1 : 0);
      fromDungeon = true;
    }
    if (gameQuit()) return;
    loadFilePart(0, 0x100, map.objects.bytes, objectsFileName());
  }
}
