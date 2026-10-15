// stats.js - ZSTATS.OVL: the Ztats pages, Ready and the item lists (also used by Use and the
// armoury's sell list), and resurrection from CAST2.OVL (used by healers and magic). Ported from
// the C++ port's stats.cpp.
import { getCommandKey } from './commands.js';
import { combat } from './combat.js';
import { data, SHARED } from './data/gamedata.js';
import { S, strings } from './data/strings.js';
import { strIndex } from './effects.js';
import { items } from './items.js';
import { map } from './map.js';
import { spellEffect } from './magic.js';
import { randomBetween } from './misc.js';
import { party } from './party.js';
import { platform } from './platform/platform.js';
import { sound } from './sound.js';
import { spells } from './spells.js';
import { status } from './status.js';
import { textWindows as tw } from './text.js';

// From DATA.OVL, by class ("AMBFDTPRS", 9 = none): its name and the spaces before the sex that
// centre the line; and the health states "GPDSC" (the sixth reads the next table's first word).
const classNames = data.words(0x1a44, new Array(10).fill(0), 'stats.classNames');
const classIndent = data.words(0x1a58, new Int16Array(10), 'stats.classIndent', SHARED);
const healthNames = data.words(0x1a6a, new Array(6).fill(0), 'stats.healthNames', SHARED);

/** Names for the list pages: the entry's string id. */
export const shortNameOf = (i) => items.shortNameId(i);
export const specialNameOf = (i) => items.specialNameId(i);
export const spellNameOf = (i) => (i < 0x30 ? spells.names[i] : S.NONE);
export const reagentNameOf = (i) => (i < 8 ? spells.reagentNames[i] : S.NONE);

/** The Use list: counts (or 0xFF = owned, shown without a count) of the 38 special items. */
export const specialList = new Uint8Array(0x26);

/** e6f8 */
export function isEquippedBy(item, member) {
  const m = party.member(member);
  return m.helm === item || m.body === item || m.leftHand === item || m.rightHand === item || m.ring === item || m.amulet === item;
}

/** e74c: owned (count non-zero), or equipped by member when member isn't 0xFF; -1 none. */
export function listPrevItem(member, counts, size, index) {
  while (--index >= 0) if (counts[index] || (member !== 0xff && isEquippedBy(index, member))) return index;
  return -1;
}

/** e784 */
export function listNextItem(member, counts, size, index) {
  while (++index < size) if (counts[index] || (member !== 0xff && isEquippedBy(index, member))) return index;
  return -1;
}

/**
 * e7c2: "nn-Name" padded to column 14: count (or "--"), the marker (rune font below 0x20), the
 * name. Names starting with '*' / '!' get a rune prefix, '(' are moonstones with a rune letter.
 */
export function printListEntry(marker, names, counts, index) {
  const n = counts[index];
  if (n !== 0xff) {
    if (n === 0) tw.printText(strings.get(S.Dash_Dash_9778));
    else tw.printNumber(' ', 2, n);
    if (marker < 0x20) tw.selectFont(1);
    tw.putChar(marker);
    tw.selectFont(0);
  }
  const name = strings.get(names(index));
  if (name[0] === '*') {
    tw.selectFont(1);
    tw.printText(strings.get(S.Up_SP_Plus_SP_977C));
    tw.printText(name.slice(1));
    tw.selectFont(0);
  } else if (name[0] === '!') {
    tw.selectFont(1);
    tw.printText(strings.get(S.Down_SP_Plus_SP_9782));
    tw.selectFont(0);
    tw.printText(items.shortName(0x28 + index)); // the colour
  } else if (name[0] === '(') {
    tw.printText(strings.get(S.Moonstone_9788));
    tw.selectFont(1);
    tw.putChar(name.charCodeAt(1));
    tw.selectFont(0);
  } else {
    tw.printText(name);
  }
  for (let col = tw.getCursorCol(); col < 0x0e; col++) tw.putChar(0x20);
  tw.putChar(0x0a);
}

/**
 * CAST2 e7c0: back to 'G' with 1 HP; MP from INT (bards half). Karma below 98 costs XP (xp *
 * karma / 100); the level is recomputed from XP and max HP set to level * 30. fromScroll 1 the
 * scroll's effect, 0 the spell's, anything else (the healer) none.
 */
export async function resurrectMember(fromScroll, member) {
  if (member < 0) return -1;
  const m = party.member(member);
  if (!m.dead()) {
    if (fromScroll) tw.printText(strings.get(S.Not_dead_953C));
    return 0;
  }
  m.status = 'G';
  m.hp = 1;
  if (m.cls === 'A' || m.cls === 'M') m.mp = m.intel;
  else if (m.cls === 'B') m.mp = m.intel >> 1;
  if (party.karma < 0x62) m.xp = Math.trunc((((m.xp << 16) >> 16) * party.karma) / 100);
  let level = 1;
  for (let v = Math.trunc(((m.xp << 16) >> 16) / 100); v > 0; v >>= 1) level++;
  m.level = level;
  m.maxHp = level * 0x1e;
  if (fromScroll === 1) await spellEffect(6);
  else if (fromScroll === 0) await spellEffect(8);
  status.dirty = true;
  return 1;
}

/** eb7a */
export function collectSpecialItems() {
  const l = specialList;
  for (let i = 0; i < 8; i++) {
    l[i] = party.scrolls[i];
    l[8 + i] = party.potions[i];
    l[0x15 + i] = map.moonstoneLoc[i] === 0xff ? 0xff : 0;
  }
  l[0x10] = party.magicCarpets;
  l[0x11] = party.oddKeys;
  l[0x12] = party.lbAmulet;
  l[0x13] = party.lbCrown;
  l[0x14] = party.lbSceptre;
  l[0x1d] = party.shards[0];
  l[0x1e] = party.shards[1];
  l[0x1f] = party.shards[2];
  l[0x20] = party.spyglass;
  l[0x21] = party.hmsCapePlans === 0 ? 0 : 0xff;
  l[0x22] = party.sextant;
  l[0x23] = party.pocketWatch;
  l[0x24] = party.blackBadge;
  l[0x25] = party.sandalwoodBox;
}

/** e63e: clears the status window and draws the list's box, topRow rows high, in frame characters. */
export function setListWindow(topRow) {
  tw.defineTextWindow(topRow + 1, 0x26, 1, 0x18, 1);
  tw.putChar(0xff);
  tw.defineTextWindow(9, 0x27, 1, 0x18, 1);
  tw.putChar(0x10);
  for (let i = 0x0d; i !== 0; i--) tw.putChar(0x11);
  tw.putChar(0x13);
  for (let row = 1; row !== topRow; row++) {
    tw.setCursor(row, 0);
    tw.putChar(0x17);
    tw.setCursor(row, 0x0e);
    tw.putChar(0x17);
  }
  tw.putChar(0x0a);
  tw.putChar(0x14);
  for (let i = 0x0d; i !== 0; i--) tw.putChar(0x15);
  tw.putChar(0x16);
}

/**
 * f10e: the scrolling list of Ready ('R': the equipment, with a mark on what the member wears)
 * and Use ('U': the special items). Seven rows show; the bar stays on row 4 while the list can
 * scroll. Arrows move, PgUp / PgDn by 7, Home / End jump; Return or Space picks (Ready then readies
 * the item and goes on until Esc); Esc leaves. Returns the item, or -1.
 */
export async function readyItemList(mode, member, first) {
  let done = 0, selRow = 1, result = -1, item = -1, shown = 0;
  const counts = mode === 0x52 ? party.inventory : specialList;
  const size = mode === 0x52 ? 0x30 : 0x26;
  while (!done) {
    tw.selectTextWindow(1);
    tw.setCursor(1, 1);
    shown = 0;
    for (item = first; item !== -1; item = listNextItem(member, counts, size, item)) {
      shown++;
      if (tw.getCursorRow() === selRow) {
        tw.putChar(0xfd);
        result = item;
      }
      if (mode === 0x52) printListEntry(isEquippedBy(item, member) ? items.readyMark[item] : 0x20, shortNameOf, counts, item);
      else printListEntry(0x20, specialNameOf, counts, item);
      tw.setCursor(tw.getCursorRow(), 1);
      if (tw.getCursorRow() - 1 === selRow) tw.putChar(0xfd);
      if (tw.getCursorRow() === 8) break;
    }
    let more = 0;
    if (listPrevItem(member, counts, size, first) !== -1) more = 2;
    if (item !== -1 && listNextItem(member, counts, size, item) !== -1) more++;
    if (more === 0) status.drawListHeaderBar();
    else status.drawListMarker(more === 1 ? 0x19 : more === 2 ? 0x18 : 0x12); // down, up, both
    tw.selectTextWindow(2);
    let key = await getCommandKey();
    if (platform.quitRequested()) key = 0x1b;
    switch (key) {
      case 0x0d: case 0x20:
        done = mode === 0x52 ? await readyItem(result, member) : 1;
        break;
      case 1: case 3: case 0xd5:
        for (let n = key === 0xd5 ? 7 : 1; n !== 0; n--) {
          if (selRow === 4 || selRow === 1) {
            const prev = listPrevItem(member, counts, size, first);
            if (prev !== -1) first = prev;
            else if (selRow === 4) selRow--;
          } else {
            selRow--;
          }
        }
        break;
      case 2: case 4: case 0xd6:
        for (let n = key === 0xd6 ? 7 : 1; n !== 0; n--) {
          if (selRow === 4 || selRow === 7 || shown <= selRow) {
            if (item === -1 || listNextItem(member, counts, size, item) === -1) {
              if (selRow === 4 && shown > 4) selRow++;
            } else {
              first = listNextItem(member, counts, size, first);
              item = listNextItem(member, counts, size, item);
            }
          } else {
            selRow++;
          }
        }
        break;
      case 0x1b:
        tw.printText(strings.get(mode === 0x52 ? S.Done_9970 : S.None_9976));
        done = 1;
        result = -1;
        break;
      case 0xd3:
        first = listNextItem(member, counts, size, -1);
        selRow = 1;
        break;
      case 0xd4:
        first = listPrevItem(member, counts, size, size);
        selRow = 1;
        for (;;) {
          const prev = listPrevItem(member, counts, size, first);
          if (prev === -1) break;
          selRow++;
          first = prev;
          if (selRow >= 7) break;
        }
        break;
    }
  }
  return result;
}

// ---- Ztats ----

/** e1e0: in combat it is the member whose turn it is. -1 none, -2 the whole party (allowParty). */
export async function askPlayerNumber(allowParty) {
  let member;
  if (map.id < 0x81 || !(combat.combatants[combat.turn & 0x1f].flags & 0x80)) {
    tw.printText(strings.get(S.Player_96B4));
    member = await status.selectMember(allowParty);
    if (member > -1) {
      tw.printText(party.member(member).name);
      if (tw.getCursorCol() !== 0) tw.putChar(0x0a);
    }
  } else {
    member = combat.combatants[combat.turn & 0x1f].kind;
  }
  if (member === -1) tw.printText(strings.get(S.None_96BE));
  else if (member === -2) tw.putChar(0x0a);
  return member;
}

function clearStatusWindow() {
  tw.defineTextWindow(9, 0x26, 1, 0x18, 1);
  tw.putChar(0xff);
  tw.defineTextWindow(9, 0x27, 1, 0x18, 1);
}

/** e262: sex sign, level and class, the state in words, then the attributes, HP, XP and MP. */
export function showMemberStats(member) {
  const m = party.member(member);
  status.drawListHeaderBar();
  status.drawPanelTitle(m.name);
  clearStatusWindow();
  const cls = strIndex(m.cls.charCodeAt(0), strings.get(S.AMBFDTPRS_96C6));
  const state = strIndex(m.status.charCodeAt(0), strings.get(S.GPDSC_96D0));
  for (let i = 0; i < classIndent[cls]; i++) tw.putChar(0x20);
  tw.putChar(m.sex);
  tw.printText(strings.get(S.Lv_96D6));
  tw.printNumber(' ', 1, m.level);
  tw.putChar(0x20);
  tw.printText(strings.get(classNames[cls]));
  tw.defineTextWindow(9, 0x26, 1, 0x18, 1);
  tw.setCursor(1, 0);
  tw.putChar(0xfc);
  tw.printText(strings.get(healthNames[state])); // Good Health, Poisoned, Dead, Asleep, Charmed
  tw.defineTextWindow(9, 0x27, 1, 0x18, 1);
  tw.setCursor(3, 0);
  tw.putChar(0xfb);
  tw.printText(strings.get(S.Str_96DC));
  tw.printNumber('0', 2, m.str);
  tw.printText(strings.get(S.HP_96E2));
  tw.printNumber(' ', 4, (m.hp << 16) >> 16);
  tw.printText(strings.get(S.Int_96E8));
  tw.printNumber('0', 2, m.intel);
  tw.printText(strings.get(S.HM_96EE));
  tw.printNumber(' ', 4, (m.maxHp << 16) >> 16);
  tw.printText(strings.get(S.Dex_96F4));
  tw.printNumber('0', 2, m.dex);
  tw.printText(strings.get(S.Ex_96FA));
  tw.printNumber(' ', 4, (m.xp << 16) >> 16);
  tw.printText(strings.get(S.Magic_9700));
  tw.printNumber(' ', 2, m.mp);
}

/** e458 */
function printEquippedName(item) {
  if (item === 0xff) return 0;
  tw.putChar(0x20);
  tw.printText(items.shortName(item));
  tw.putChar(0x0a);
  return 1;
}

/** e488 */
export function showMemberArms(member) {
  const m = party.member(member);
  status.drawListHeaderBar();
  status.drawPanelTitle(m.name);
  tw.defineTextWindow(9, 0x26, 1, 0x18, 1);
  tw.putChar(0xff);
  tw.putChar(0xfc);
  tw.putChar(0xfe);
  tw.printText(strings.get(S.Arms_970E));
  tw.putChar(0xfb);
  tw.putChar(0xfe);
  let n = printEquippedName(m.helm);
  n += printEquippedName(m.body);
  n += printEquippedName(m.leftHand);
  n += printEquippedName(m.rightHand);
  n += printEquippedName(m.ring);
  n += printEquippedName(m.amulet);
  if (n === 0) {
    tw.setCursor(4, 0);
    tw.putChar(0xfc);
    tw.printText(strings.get(S.None_ready_9716));
    tw.putChar(0xfb);
  }
  tw.defineTextWindow(9, 0x27, 1, 0x18, 1);
}

/** e57c */
export function showEquipmentPage() {
  status.drawListHeaderBar();
  status.drawPanelTitle(strings.get(S.Equipment_9724));
  clearStatusWindow();
  tw.printText(strings.get(S.Food_972E));
  tw.printNumber(' ', 4, (party.food << 16) >> 16);
  tw.printText(strings.get(S.Gold_9738));
  tw.printNumber(' ', 4, (party.gold << 16) >> 16);
  tw.printText(strings.get(S.Keys_9742));
  tw.printNumber(' ', 2, party.keys);
  tw.printText(strings.get(S.Gems_9752));
  tw.printNumber(' ', 2, party.gems);
  tw.printText(strings.get(S.Torches_9760));
  tw.printNumber(' ', 2, party.torches);
  if (party.grapples !== 0) tw.printText(strings.get(S.Grapple_976E));
}

/**
 * e8c8: a list page of Ztats: up / down scroll a line, PgUp / PgDn seven, Home / End jump. Any
 * key that turns the page or ends Ztats (left, right, 0-6, Space, Esc) is returned.
 */
export async function browseItemList(names, counts, size, title) {
  status.drawPanelTitle(title);
  setListWindow(8);
  let first = listNextItem(0xff, counts, size, -1), key;
  if (first === -1) {
    setListWindow(8);
    tw.setCursor(4, 1);
    tw.printText(strings.get(S.None_owned_9794));
    status.drawListHeaderBar();
    tw.selectTextWindow(2);
    return getCommandKey();
  }
  for (;;) {
    let item;
    tw.selectTextWindow(1);
    tw.setCursor(1, 1);
    for (item = first; item !== -1; item = listNextItem(0xff, counts, size, item)) {
      printListEntry(0x2d, names, counts, item);
      tw.setCursor(tw.getCursorRow(), 1);
      if (tw.getCursorRow() === 8) break;
    }
    let more = 0;
    if (listPrevItem(0xff, counts, size, first) !== -1) more = 2;
    if (item !== -1 && listNextItem(0xff, counts, size, item) !== -1) more++;
    if (more === 0) status.drawListHeaderBar();
    else status.drawListMarker(more === 1 ? 0x19 : more === 2 ? 0x18 : 0x12);
    tw.selectTextWindow(2);
    key = await getCommandKey();
    if (platform.quitRequested()) return 0x1b;
    if (key === 0x20 || key === 0x1b || key === 1 || key === 2 || (key >= 0x30 && key <= 0x36)) return key;
    if (key === 3 || key === 0xd5) {
      for (let n = key === 0xd5 ? 7 : 1; n > 0; n--) {
        const prev = listPrevItem(0xff, counts, size, first);
        if (prev !== -1) first = prev;
      }
    } else if (key === 4 || key === 0xd6) {
      for (let n = key === 0xd6 ? 7 : 1; n > 0; n--)
        if (item !== -1 && listNextItem(0xff, counts, size, item) !== -1) {
          first = listNextItem(0xff, counts, size, first);
          item = listNextItem(0xff, counts, size, item);
        }
    } else if (key === 0xd3) {
      first = listNextItem(0xff, counts, size, -1);
    } else if (key === 0xd4) {
      first = listPrevItem(0xff, counts, size, size);
      for (let n = 0; n < 6; n++) {
        const prev = listPrevItem(0xff, counts, size, first);
        if (prev === -1) break;
        first = prev;
      }
    }
  }
}

/**
 * ec1a: pages: two per member (stats, arms), then 12 Equipment, 13 Reagents, 14 Spells, 15 Items,
 * 16 Armaments. Left / up and right / down turn the pages, 1-6 jump to a member, 0 to Equipment;
 * Space or Esc ends.
 */
export async function cmdZstats() {
  let member = await askPlayerNumber(1);
  if (member === -2) member = 6;
  else if (member < 0) return;
  tw.printText(strings.get(S.Status_97A2));
  collectSpecialItems();
  status.clearSidePanel();
  let page = member * 2;
  const last = party.size * 2 - 1;
  let key = 0;
  while (key !== 0x20 && key !== 0x1b) {
    if (key === 3 || key === 1) {
      if (page === 0x0c) page = last;
      else if (page < 1) page = 0x10;
      else page--;
    } else if (key === 2 || key === 4) {
      if (page === last) page = 0x0c;
      else if (page < 0x10) page++;
      else page = 0;
    } else if (key === 0x30) {
      page = 0x0c;
    } else if (key > 0x30 && key < 0x37 && key - 0x31 < party.size) {
      page = (key - 0x31) * 2;
    }
    tw.selectTextWindow(1);
    if (page <= 0x0c) {
      if (page === 0x0c) showEquipmentPage();
      else if (page & 1) showMemberArms(page >> 1);
      else showMemberStats(page >> 1);
      tw.selectTextWindow(2);
      key = (await getCommandKey()) & 0xff;
    } else if (page === 0x0d) {
      key = (await browseItemList(reagentNameOf, party.reagents, 8, strings.get(S.Reagents_97AC))) & 0xff;
    } else if (page === 0x0e) {
      key = (await browseItemList(spellNameOf, party.mixedSpells, 0x30, strings.get(S.Spells_97B6))) & 0xff;
    } else if (page === 0x0f) {
      key = (await browseItemList(specialNameOf, specialList, 0x26, strings.get(S.Items_97BE))) & 0xff;
    } else {
      key = (await browseItemList(shortNameOf, party.inventory, 0x30, strings.get(S.Armaments_97C4))) & 0xff;
    }
    if (platform.quitRequested()) break;
  }
  status.drawListHeaderBar();
  status.drawPanelTopBar();
  status.drawPanelBottomBar();
  status.drawStatusBar();
  tw.printText(strings.get(S.Done_97CE));
}

// ---- Ready ----

/** edce */
function printItemPrompt(text) {
  tw.printText(strings.get(S.NL_NL_97D4));
  tw.printText(text);
  tw.printText(strings.get(S.Item_97D8));
}

/** edea: 2 both hands free, 0 the left is free, 1 only the right (the left not two-handed), 0xFF none. */
export function freeHands(member) {
  const m = party.member(member);
  if (m.leftHand === 0xff && m.rightHand === 0xff) return 2;
  if (m.leftHand === 0xff) return 0;
  if (m.rightHand === 0xff && items.hands(m.leftHand) !== 0x30) return 1;
  return 0xff;
}

/**
 * ee3c: picking a worn item takes it off; otherwise it is put on if its slot is free and the
 * member can carry it: the weights of everything worn must not exceed strength. The slot comes
 * from the item's class: 0x80 helm, 0x40 body, 0x20 one hand, 0x30 both hands, 2 ring, 4 amulet.
 * Arrows and quarrels can't be readied, and bows need them. Armour can't be changed in a fight
 * before it is won. A ring of invisibility or regeneration has 1 chance in 16 to vanish when put
 * on (returns 1: the list closes).
 */
export async function readyItem(item, member) {
  const m = party.member(member);
  let o = null;
  if (map.inScene()) o = map.objects.at(combat.combatants[combat.turn & 0x1f].object & 0x1f);
  if (item < 0 || item === 0x1b || item === 0x1d) return 0;
  if (item > 8 && item < 0x10 && map.inScene() && combat.victory === 0) {
    printItemPrompt(strings.get(S.Thou_canst_not_change_97E2));
    return 0;
  }
  if (isEquippedBy(item, member)) {
    combat.unequipItem(item, member);
    if (party.inventory[item] < 99) party.inventory[item]++;
    if (o && item === 0x2a) // visible again
      o.tile = o.tile2 = party.classTile(strIndex(m.cls.charCodeAt(0), strings.get(S.AMBFDTPRS_9812)));
    return 0;
  }
  if (((item === 0x1a || item === 0x24) && party.inventory[0x1b] === 0) || (item === 0x1c && party.inventory[0x1d] === 0)) {
    printItemPrompt(strings.get(S.Thou_hast_no_ammunition_981C));
    return 0;
  }
  let load = 0;
  for (const w of [m.helm, m.body, m.leftHand, m.rightHand, m.ring, m.amulet]) if (w !== 0xff) load += items.weight(w);
  let slot = null;
  switch (items.hands(item)) {
    case 2:
      if (m.ring !== 0xff) { printItemPrompt(strings.get(S.Only_one_magic_ring_may_9916)); return 0; }
      slot = 'ring';
      break;
    case 4:
      if (m.amulet !== 0xff) { printItemPrompt(strings.get(S.Thou_must_remove_thine_98F0)); return 0; }
      slot = 'amulet';
      break;
    case 0x20: {
      const hand = freeHands(member);
      if (hand === 0xff) { printItemPrompt(strings.get(S.Thou_must_free_one_of_9892)); return 0; }
      slot = hand === 1 ? 'rightHand' : 'leftHand';
      break;
    }
    case 0x30:
      if (freeHands(member) !== 2) { printItemPrompt(strings.get(S.Both_hands_must_be_free_98BA)); return 0; }
      slot = 'leftHand';
      break;
    case 0x40:
      if (m.body !== 0xff) { printItemPrompt(strings.get(S.Thou_must_first_remove_9866)); return 0; }
      slot = 'body';
      break;
    case 0x80:
      if (m.helm !== 0xff) { printItemPrompt(strings.get(S.Remove_first_thy_present_9846)); return 0; }
      slot = 'helm';
      break;
  }
  if (items.weight(item) + load > m.str) {
    printItemPrompt(strings.get(S.Thou_art_not_strong_9942));
    return 0;
  }
  if (!slot) return 0; // an item of no class: the original writes through a stale pointer
  m[slot] = item;
  party.inventory[item]--;
  if ((item === 0x2a || item === 0x2c) && randomBetween(0x0f, 0) === 0) {
    tw.printText(strings.get(S.Ring_vanishes_995E));
    m.ring = 0xff;
    await sound.soundSlide(0x28, 1, 2000, 0x4b0);
    return 1;
  }
  if (item === 0x2a && o) o.tile = o.tile2 = 0x1d;
  return 0;
}

/** f476 */
export async function cmdReady() {
  const member = await askPlayerNumber(0);
  if (member < 0) return;
  const first = listNextItem(member, party.inventory, 0x30, -1);
  if (first === -1) {
    tw.printText(strings.get(S.Thou_art_empty_handed_997E));
    return;
  }
  tw.printText(strings.get(S.Item_9998));
  status.clearSidePanel();
  tw.selectTextWindow(1);
  status.drawPanelTitle(party.member(member).name);
  setListWindow(8);
  await readyItemList(0x52, member, first);
  status.drawListHeaderBar();
  status.drawPanelTopBar();
  status.drawPanelBottomBar();
  status.drawStatusBar();
}
