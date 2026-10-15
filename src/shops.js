// shops.js - the merchants: SHOPPES.OVL (common code, provisioner, reagents, stables, armoury,
// healer), SHOPPES2.OVL (tavern, shipwright) and SHOPPES3.OVL (inn). Ported from the C++ port's
// shops.cpp; the shop's state is kept on `town` as there.
//
// Shop text comes from SHOPPE.DAT (shopSay loads 1500 bytes at an offset). In it, and in the
// strings given to shopPrint, bytes >= 0x80 are words from the talk word table and # $ % ^ & * @
// are substitutions: keeper, shop name, price, quantity, item, item 2, time of day. Prices go up for
// low intelligence: price + price * (100 - 3 * INT) / 100; most shops divide unsigned, so from INT
// 34 on the negative product wraps into a huge number - ported as it is.
import { getCommandKey, readLine, readNumber, restoreOpenDoor, waitTurns } from './commands.js';
import { listNextItem, listPrevItem, printListEntry as printEntry, resurrectMember, shortNameOf } from './stats.js';
import { S, strings } from './data/strings.js';
import { loadFilePart } from './files.js';
import { gameTime } from './gametime.js';
import { gfx } from './gfx.js';
import { items } from './items.js';
import { M, map, passTime } from './map.js';
import { addByteCapped, addWordCapped, randomBetween, strFindNocase, subByteFloor0, subWordFloor0 } from './misc.js';
import { findObjectAt } from './objects.js';
import { party } from './party.js';
import { platform } from './platform/platform.js';
import { sound } from './sound.js';
import { status } from './status.js';
import { conversation } from './talk.js';
import { textWindows as tw } from './text.js';
import { textBuffer } from './textbuf.js';
import { town } from './town.js';
import { view } from './view.js';

// The shops' table offsets (the C++ port's Town::Table).
const T = {
  SHOP_NAME: 0x21ca, SHOPKEEPER_NAME: 0x22ca, SHOP_LOCATION: 0x23ca, REAGENT_PRICE: 0x3a32, REAGENT_QUANTITY: 0x3a5a,
  ARMOURY_STOCK: 0x3ae2, SHOP_GREETING: 0x3b2a, SHOP_FAREWELL_A: 0x3b6a, SHOP_FAREWELL_B: 0x3baa, PROVISION_PRICE: 0x3bea,
  PROVISION_TEXT: 0x3c0a, REAGENT_TEXT: 0x3c10, REAGENT_NAME: 0x3c20, HORSE_PRICE: 0x3c30, HORSE_DX: 0x3c38, HORSE_DY: 0x3c40,
  ARMOURY_ITEM_TEXT: 0x3c48, ARMOURY_OFFER_A: 0x3ca6, ARMOURY_OFFER_B: 0x3cae, ARMOURY_MENU_PHRASE: 0x3cb6, ARMOURY_SELL_TEXT: 0x3cbe,
  ARMOURY_SELL_A: 0x3d2e, ARMOURY_SELL_C: 0x3d36, ARMOURY_SELL_B: 0x3d3e, ARMOURY_ASK_A: 0x3d46, ARMOURY_ASK_B: 0x3d4a,
  ARMOURY_ASK_C: 0x3d52, HEAL_PRICE: 0x3d86, CURE_PRICE: 0x3d8e, RESURRECT_PRICE: 0x3d96,
  TAVERN_FOOD_KEY: 0x4c1e, TAVERN_WINE_KEY: 0x4c24, TAVERN_RATIONS_KEY: 0x4c2a, TAVERN_RUMOUR_KEY: 0x4c30, MEAL_PRICE: 0x4c36,
  WINE_PRICE: 0x4c48, RATIONS_PRICE: 0x4c54, RATIONS_TEXT: 0x4c66, RUMOUR_KEYWORD: 0x4c74, RUMOUR_SUBJECT: 0x4ca8,
  RUMOUR_PLACE: 0x4cdc, RUMOUR_PLACE_NAME: 0x4cf6, RUMOUR_PRICE: 0x4d10, RUMOUR_TEXT: 0x4d44, TAVERN_INDEX: 0x4d4c,
  TAVERN_GREETING: 0x4d56, TAVERN_MENU: 0x4d5e, SHIP_PRICE: 0x4d66, SKIFF_PRICE: 0x4d6e, SHIP_X: 0x4d76, SHIP_Y: 0x4d7a,
  INN_PRICE: 0x4d7e, INN_ROOMS: 0x4dc4, INN_TEXT: 0x4e6e, INN_BED_X: 0x4e7a, INN_BED_Y: 0x4e80,
};

const tb = (off) => town.tableByte(off);
const tword = (off) => town.tableWord(off);
const s16 = (v) => ((v & 0xffff) << 16) >> 16;
const str = (id) => strings.get(id);
const put = (c) => tw.putChar(typeof c === 'string' ? c.charCodeAt(0) : c);

/** The NUL-ended text in the text buffer at an offset. */
function bufText(off) {
  let s = '';
  for (let p = off; p < 2000; p++) {
    const c = textBuffer.get(p);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// getCommandKey, but once the page has quit it cycles through keys that end every shop prompt, so
// the original's wait-for-Y/N loops can't hang.
let quitKey = 0;
async function key() {
  const quitKeys = [0x4e, 0x20, 0x1b, 0x0d];
  let k = await getCommandKey();
  if (platform.quitRequested()) k = quitKeys[quitKey++ & 3];
  return k;
}

async function yesNoKey() {
  let k;
  do k = await key();
  while (k !== 0x59 && k !== 0x4e);
  return k;
}

const intelOf = (member) => party.member(member).intel;

/** price + price * (100 - 3 * INT) / 100, the division unsigned as in the original. */
function adjustPriceU(price, intel) {
  const prod = s16(price) * (100 - 3 * intel);
  return (price + Math.floor((prod >>> 0) / 100)) & 0xffff;
}

/** The inn's version divides signed. */
function adjustPriceS(price, intel) {
  const prod = s16(price) * (100 - 3 * intel);
  return (price + Math.trunc(prod / 100)) & 0xffff;
}

const rnd = (hi) => randomBetween(hi, 0);

// ---------------------------------------------------------------- SHOPPES: common

/** a2b6: the text with its substitutions, printed. */
function shopPrint(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const b = text.charCodeAt(i);
    if (b >= 0x80) { // a word from the talk word table, with spaces around it
      out += ' ' + conversation.word(b - 0x7f);
      if (i + 1 < text.length && text.charCodeAt(i + 1) < 0x80) out += ' ';
      continue;
    }
    switch (text[i]) {
      case '%': out += String(s16(town.shopPrice)); break;
      case '^': out += String(s16(town.shopQuantity)); break;
      case '#': out += str(town.shopName); break;
      case '$': out += str(town.shopkeeperName); break;
      case '&': out += str(town.shopItemName); break;
      case '*': out += str(town.shopItemName2); break;
      case '@': out += str(gameTime.hour < 12 ? S.morning_7826 : gameTime.hour < 18 ? S.afternoon_782E : S.evening_7838); break;
      default: out += text[i];
    }
  }
  tw.printText(out);
}

/** a40a: SHOPPE.DAT's text at an offset (1500 bytes into the text buffer). */
function shopSay(offset) {
  loadFilePart(offset, 0x5dc, textBuffer.data.subarray(0, 0x5dc), str(S.SHOPPE_DAT_7840));
  shopPrint(bufText(0));
}

/** a42a: the Shadowlord of Falsehood takes 1-64 gold. */
function shopTakeGold() {
  if (town.shadowlordHere === 0) subWordFloor0(randomBetween(0x40, 1), party, 'gold');
}

function shopGreeting() {
  put('"');
  shopSay(tword(T.SHOP_GREETING + town.shopType * 8 + rnd(3) * 2));
  if (tw.getCursorCol() < 0x0c) {
    if (tw.getCursorCol() !== 0) {
      put(' ');
      return;
    }
    tw.printText(str(S.NL_Colon_7850));
  } else {
    tw.printText(str(S.NL_NL_Colon_784C));
  }
}

/** a492: 0 nothing bought, 1 bought, else silent. */
function shopFarewell(kind) {
  if (kind === 0) {
    tw.printText(str(S.NL_NL_Quote_7854));
    shopSay(tword(T.SHOP_FAREWELL_A + town.shopType * 8 + rnd(3) * 2));
  } else if (kind === 1) {
    tw.printText(str(S.NL_NL_Quote_7858));
    shopSay(tword(T.SHOP_FAREWELL_B + town.shopType * 8 + rnd(3) * 2));
  } else {
    return;
  }
  if (tw.getCursorCol() !== 0) put(0x0a);
  shopPrint(str(S.says_785C));
}

async function askYesNo() {
  const k = await yesNoKey();
  tw.printText(str(k === 0x4e ? S.No_7866 : S.Yes_786A));
  return k;
}

// ---------------------------------------------------------------- provisioner (type 5)

async function provisionerOffer(result, item, member) {
  town.shopPrice = adjustPriceU(tword(T.PROVISION_PRICE + town.shopTown * 8 + item * 2), intelOf(member));
  tw.printText(str(S.NL_NL_Quote_786E));
  shopSay(tword(T.PROVISION_TEXT + item * 2));
  tw.printText(str(S.Interested_7872));
  if ((await yesNoKey()) === 0x4e) {
    tw.printText(str(S.No_What_else_then_7882));
    return result;
  }
  tw.printText(str(S.Yes_789A));
  if (s16(town.shopPrice) > s16(party.gold)) {
    shopSay(0x21e6);
    return -1;
  }
  party.gold = (party.gold - town.shopPrice) & 0xffff;
  shopTakeGold();
  status.drawStatusBar();
  if (item === 0) addByteCapped(99, 3, party, 'keys');
  else if (item === 1) addByteCapped(99, 4, party, 'gems');
  else if (item === 2) addByteCapped(99, 5, party, 'torches');
  shopPrint(str(S.Sold_says_What_else_78A0));
  tw.printText(str(party.member(member).sex === 0x0c ? S.m_lady_78C0 : S.m_lord_78C8));
  tw.printText(str(S.Qm_NL_NL_78D0));
  return 1;
}

async function provisionerMenu(member) {
  let result = 0;
  for (;;) {
    tw.printText(str(S.a_Keys_78D4));
    tw.printText(str(S.b_Gems_78E4));
    tw.printText(str(S.c_Torches_78F4));
    tw.printText(str(S.Thy_concern_7906));
    for (;;) {
      const k = (await key()) & 0xff;
      if (k === 0x20 || k === 0x1b) return result;
      if (k >= 0x41 && k <= 0x43) {
        put(k | 0x20);
        result = await provisionerOffer(result, k - 0x41, member);
        if (result === -1) return result;
        break;
      }
      if (k === 0x44) {
        shopSay(0x2215);
        break;
      }
    }
  }
}

async function shopProvisioner(member) {
  let kind = 0;
  shopGreeting();
  for (;;) {
    const k = (await key()) & 0xff;
    if (k === 0x20 || k === 0x4e) {
      tw.printText(str(S.No_7928));
      break;
    }
    if (k === 0x59) {
      tw.printText(str(S.Yes_We_sell_7916));
      kind = await provisionerMenu(member);
      break;
    }
  }
  shopFarewell(kind);
}

// ---------------------------------------------------------------- reagents (type 4)

async function reagentOffer(result, reagent, member) {
  let i, n = 0;
  for (i = 0; i < 8; i++) // the reagent-th one this shop sells
    if (tb(T.REAGENT_PRICE + town.shopTown * 8 + i) !== 0) {
      if (n === reagent) break;
      n++;
    }
  if (i === 8) return -2;
  if (party.reagents[i] === 99) {
    tw.printText(str(S.Thou_canst_not_carry_any_792C));
    await key();
    return result;
  }
  town.shopPrice = adjustPriceU(tb(T.REAGENT_PRICE + town.shopTown * 8 + i), intelOf(member));
  town.shopQuantity = tb(T.REAGENT_QUANTITY + town.shopTown * 8 + i);
  tw.printText(str(S.NL_NL_Quote_7952));
  shopPrint(bufText(tword(T.REAGENT_TEXT + i * 2) - 0x1a67)); // text loaded by reagentMenu
  tw.printText(str(S.Is_this_thy_need_7956));
  if (tw.getCursorCol() > 0x0c) tw.printText(str(S.NL_Colon_796C));
  if ((await yesNoKey()) === 0x4e) {
    tw.printText(str(S.No_What_else_7970));
    return result;
  }
  tw.printText(str(S.Yes_7982));
  if (s16(town.shopPrice) > s16(party.gold)) {
    shopPrint(bufText(0x4c4)); // in the loaded text: "not enough gold"
    return -1;
  }
  party.gold = (party.gold - town.shopPrice) & 0xffff;
  shopTakeGold();
  status.drawStatusBar();
  addByteCapped(99, town.shopQuantity, party.reagents, i);
  shopPrint(str(S.I_thank_thee_says_7988));
  tw.printText(str(S.Anything_else_79A2));
  return 1;
}

async function reagentMenu(member) {
  let result = 0;
  loadFilePart(0x1a67, 0x5dc, textBuffer.data.subarray(0, 0x5dc), str(S.SHOPPE_DAT_7A0A));
  for (;;) {
    let letter = 0x41;
    for (let i = 0; i < 8; i++)
      if (tb(T.REAGENT_PRICE + town.shopTown * 8 + i) !== 0) {
        put(letter++);
        tw.printText(str(S.Dot_Dot_Dot_7A16));
        tw.printText(str(tword(T.REAGENT_NAME + i * 2)));
        put(0x0a);
      }
    tw.printText(str(S.Thy_interest_7A1A));
    for (;;) {
      const k = (await key()) & 0xff;
      if (k === 0x1b || k === 0x0d || k === 0x20) return result;
      if (k < 0x41 || k > 0x45) continue;
      const r = await reagentOffer(result, k - 0x41, member);
      if (r === -1) return -1;
      if (r === -2) continue;
      result = r;
      break;
    }
  }
}

async function shopReagents(member) {
  let kind = 0;
  shopGreeting();
  for (;;) {
    const k = (await key()) & 0xff;
    if (k === 0x20 || k === 0x4e) {
      tw.printText(str(S.No_7A44));
      break;
    }
    if (k === 0x59) {
      tw.printText(str(S.Yes_Fine_We_sell_7A2C));
      kind = await reagentMenu(member);
      break;
    }
  }
  shopFarewell(kind);
}

// ---------------------------------------------------------------- stables (type 2)

/** The horse appears on a free floor or grass square at one of four offsets (ds:3C38 / 3C40). */
async function shopStables(member) {
  let slot = 0;
  while (slot < 32 && map.objects.at(slot).tile !== 0) slot++;
  let k4, x = 0, y = 0;
  for (k4 = 0; k4 < 4; k4++) {
    const dx = s16(tword(T.HORSE_DX + k4 * 2)), dy = s16(tword(T.HORSE_DY + k4 * 2));
    const t = map.getTile(dy + map.y, dx + map.x);
    y = (dy + map.y) & 0xff;
    x = (dx + map.x) & 0xff;
    if (findObjectAt(map.z, y, x).tile === 0 && (t === 0x44 || t === 0x45 || t === 5)) break;
  }
  if (k4 === 4 || slot === 32) {
    tw.printText(str(S.The_stables_are_closed_7A48));
    return;
  }
  let result = 0;
  town.shopPrice = adjustPriceU(tword(T.HORSE_PRICE + town.shopTown * 2), intelOf(member));
  shopGreeting();
  for (;;) {
    const k = (await key()) & 0xff;
    if (k === 0x20 || k === 0x4e) {
      tw.printText(str(S.No_7AB2));
      break;
    }
    if (k !== 0x59) continue;
    tw.printText(str(S.Yes_7A62));
    shopSay(0x1643);
    tw.printText(str(S.Deal_7A6A));
    if ((await yesNoKey()) === 0x4e) {
      tw.printText(str(S.No_7A74));
      break;
    }
    tw.printText(str(S.Yes_7A78));
    if (s16(party.gold) < s16(town.shopPrice)) {
      tw.printText(str(S.Thou_couldst_not_afford_7A7E));
      shopPrint(str(S.feed_it_yells_7A9E));
      result = -1;
    } else {
      party.gold = (party.gold - town.shopPrice) & 0xffff;
      shopTakeGold();
      const o = map.objects.at(slot);
      o.hull = o.skiffs = o.flags = 0;
      o.tile2 = o.tile = 0x10;
      o.x = x;
      o.y = y;
      o.z = map.z;
      await view.worldTick();
      status.drawStatusBar();
      result = 1;
    }
    break;
  }
  shopFarewell(result);
}

// ---------------------------------------------------------------- armoury (type 0)

async function armouryOffer(result, item, member) {
  town.shopPrice = adjustPriceU(items.prices[item] ?? 0, intelOf(member));
  tw.printText(str(S.NL_NL_Quote_7B5E));
  shopSay(tword(T.ARMOURY_ITEM_TEXT + item * 2));
  tw.printText(str(S.NL_NL_7B62));
  tw.printText(str(tword(T.ARMOURY_OFFER_A + rnd(3) * 2)));
  tw.printText(str(S.Quote_SP_7B66));
  if ((await yesNoKey()) === 0x4e) {
    tw.printText(str(S.No_7B6A));
  } else {
    tw.printText(str(S.Yes_7B70));
    if (party.inventory[item] === 99) {
      tw.printText(str(S.Thou_canst_not_carry_any_7B76));
      shopPrint(str(S.says_7B9A));
      await key();
    } else if (s16(party.gold) < s16(town.shopPrice)) {
      tw.printText(str(S.NL_Quote_7BA4));
      tw.printText(str(tword(T.ARMOURY_OFFER_B + rnd(3) * 2)));
      shopPrint(str(S.yells_7BA8));
      result = -1;
    } else {
      party.gold = (party.gold - town.shopPrice) & 0xffff;
      shopTakeGold();
      status.drawStatusBar();
      if (item === 0x1b || item === 0x1d) party.inventory[item] = 99; // a full quiver
      else addByteCapped(99, 1, party.inventory, item);
      shopPrint(str(S.Sold_7BB4));
      result = 1;
    }
  }
  if (result !== -1) {
    tw.printText(str(S.Anything_else_7BBC));
    tw.printText(str(result === 0 ? S.then_7BDC : party.member(member).sex === 0x0c ? S.milady_7BCE : S.sir_7BD6));
  }
  return result;
}

async function armouryBuyMenu(member) {
  let result = 0;
  for (;;) {
    tw.printText(str(S.NL_NL_7C44));
    let n;
    for (n = 0; n < 8; n++) { // this shop's stock, 0xFF ends
      const id = tb(T.ARMOURY_STOCK + town.shopTown * 8 + n);
      if (id === 0xff) break;
      put(0x61 + n);
      tw.printText(str(S.Dot_Dot_Dot_7C48));
      let name = items.name(id);
      if (name.length >= 0x0d) name = str(id < 0x38 ? items.shortNames[id] : S.NONE);
      tw.printText(name);
      if (tw.getCursorCol() !== 0) put(0x0a);
    }
    put(0x0a);
    tw.printText(str(tword(T.ARMOURY_MENU_PHRASE + rnd(3) * 2)));
    tw.printText(str(S.Quote_SP_7C4C));
    for (;;) {
      const k = await key();
      const idx = (k & 0xff) - 0x41;
      if (idx >= 0 && idx < n) {
        put((k + 0x20) & 0xff);
        result = await armouryOffer(result, tb(T.ARMOURY_STOCK + town.shopTown * 8 + idx), member);
        if (result === -1) return result;
        break;
      }
      if ((k & 0xff) === 0x1b || (k & 0xff) === 0x20) return result;
    }
  }
}

const sellListInit = () => party.inventory.some((n) => n !== 0);

const listNext = (i) => listNextItem(0xff, party.inventory, 0x30, i);
const listPrev = (i) => listPrevItem(0xff, party.inventory, 0x30, i);
const printListEntry = (marker, index) => printEntry(marker, shortNameOf, party.inventory, index);

/** Four rows of owned items in the panel box, the cursor's inverse. Returns the cursor's row. */
function armourySellList(st) {
  let cursorRow = 0;
  if (party.inventory[st.cursor] === 0) { // sold out: move to a neighbour
    if (st.top === st.cursor) {
      st.cursor = listPrev(st.cursor);
      if (st.cursor === -1) st.cursor = listNext(-1);
      st.top = st.cursor;
    } else {
      st.cursor = listNext(st.cursor);
      if (st.cursor === -1) {
        st.cursor = listPrev(0x30);
        if (listPrev(st.top) > -1) st.top = listPrev(st.top);
      }
    }
  }
  tw.selectTextWindow(1);
  tw.setCursor(1, 1);
  let item = st.top;
  if (item !== -1) {
    do {
      if (item === st.cursor) {
        put(0xfd);
        cursorRow = tw.getCursorRow();
      }
      printListEntry(0x2d, item);
      if (item === st.cursor) put(0xfd);
      tw.setCursor(tw.getCursorRow(), 1);
    } while (tw.getCursorRow() !== 5 && (item = listNext(item)) !== -1);
  }
  for (let r = tw.getCursorRow(); r !== 5; r++) {
    tw.setCursor(r, 1);
    tw.printText(str(S.SP_SP_SP_SP_7C50));
  }
  let arrows = 0;
  if (listPrev(st.top) !== -1) arrows = 2;
  if (item !== -1 && listNext(item) !== -1) arrows++;
  if (arrows === 0) {
    status.drawPanelBottomBar();
  } else {
    tw.setCursor(6, 6);
    status.drawLabelLeft();
    put(arrows === 1 ? 0x19 : arrows === 2 ? 0x18 : 0x12);
    status.drawLabelRight();
  }
  tw.selectTextWindow(2);
  return cursorRow;
}

async function armourySellItem(item, member) {
  if (item === 0x1b || item === 0x1d) {
    shopPrint(str(S.We_don_t_deal_in_7D32));
    return 1;
  }
  tw.printText(str(S.NL_NL_Quote_7D64));
  const base = items.prices[item] ?? 0;
  if (base === 0) {
    shopPrint(str(S.That_I_cannot_buy_from_7D8C));
  } else {
    const v = (intelOf(member) * base) & 0xffff;
    town.shopPrice = (Math.floor((v * 3) / 100) + 1) & 0xffff;
    town.shopItemName = items.tradeNames[item];
    if (town.shopItemName === 0) town.shopItemName = items.names[item];
    shopPrint(bufText(tword(T.ARMOURY_SELL_TEXT + rnd(7) * 2) - 0x0bc0)); // loaded by armourySell
    tw.printText(str(S.Deal_7D68));
    if ((await yesNoKey()) === 0x4e) {
      tw.printText(str(S.No_7D72));
    } else {
      shopPrint(str(S.Yes_Done_says_7D76));
      addWordCapped(9999, town.shopPrice, party, 'gold');
      subByteFloor0(1, party.inventory, item);
    }
    status.drawGold();
  }
  return 0;
}

function drawPanelBox(innerRows) {
  put(0x10);
  for (let i = 0; i < 0x0d; i++) put(0x11);
  put(0x13);
  for (let r = 1; r <= innerRows; r++) {
    tw.setCursor(r, 0);
    put(0x17);
    tw.setCursor(r, 0x0e);
    put(0x17);
  }
  put(0x0a);
  put(0x14);
  for (let i = 0; i < 0x0d; i++) put(0x15);
  put(0x16);
}

async function armourySell(member) {
  if (!sellListInit()) {
    shopPrint(str(S.Thou_hast_nothing_to_7F20));
    return;
  }
  tw.printText(str(tword(T.ARMOURY_SELL_A + rnd(3) * 2)));
  tw.printText(str(S.Quote_SP_7EF0));
  status.drawPanelTitle(str(S.Arms_7EF4));
  tw.selectTextWindow(1);
  tw.defineTextWindow(6, 0x26, 1, 0x18, 1);
  put(0xff);
  tw.defineTextWindow(9, 0x27, 1, 0x18, 1);
  drawPanelBox(4);
  const st = { cursor: listNext(-1), top: 0 };
  st.top = st.cursor;
  let row = armourySellList(st);
  let result = 0, done = false;
  loadFilePart(0x0bc0, 0x5dc, textBuffer.data.subarray(0, 0x5dc), str(S.SHOPPE_DAT_7EFA)); // the sell phrases
  while (!done) {
    const k = (await key()) & 0xff;
    if (k === 0x0d || k === 0x20) {
      result = await armourySellItem(st.cursor, member);
      if (result === 0 && sellListInit()) {
        row = armourySellList(st);
        tw.printText(str(S.NL_NL_Quote_7F06));
        tw.printText(str(tword(T.ARMOURY_SELL_B + rnd(3) * 2)));
        tw.printText(str(S.Quote_SP_7F0A));
      } else {
        done = true;
      }
      continue;
    }
    if (k === 0x1b) {
      done = true;
      continue;
    }
    if (k === 0xd3) { // Home
      st.cursor = st.top = listNext(-1);
    } else if (k === 0xd4) { // End: the last item, showing up to three before it
      st.cursor = st.top = listPrev(0x30);
      for (let n = 1; n < 4; n++) {
        const p = listPrev(st.top);
        if (p === -1) break;
        st.top = p;
      }
    } else if (k === 0xd5 || k === 1 || k === 3) { // PgUp / left / up
      for (let n = k === 0xd5 ? 4 : 1; n; n--) {
        const p = listPrev(st.cursor);
        if (st.cursor !== st.top) st.cursor = p;
        else if (p > -1) st.cursor = st.top = p;
      }
    } else if (k === 0xd6 || k === 2 || k === 4) { // PgDn / right / down
      for (let n = k === 0xd6 ? 4 : 1; n; n--) {
        const nx = listNext(st.cursor);
        if (nx > -1 && ((st.cursor = nx), ++row > 4)) st.top = listNext(st.top);
      }
    } else {
      continue;
    }
    row = armourySellList(st);
  }
  status.drawStatusBar();
  status.drawPanelTopBar();
  if (result !== 0) return;
  tw.printText(str(S.NL_NL_Quote_7F0E));
  tw.printText(str(tword(T.ARMOURY_SELL_C + rnd(3) * 2)));
  tw.printText(str(S.Quote_NL_7F12));
  if (sellListInit()) shopPrint(str(S.says_7F16));
}

async function shopArmoury(member) {
  let kind = 0;
  shopPrint(str(S.Good_and_welcome_to_8018));
  await key();
  shopPrint(str(S.says_8036));
  tw.printText(str(tword(T.ARMOURY_ASK_A + rnd(1) * 2)));
  tw.printText(str(S.Quote_SP_8042));
  for (;;) {
    const k = (await key()) & 0xff;
    if (k === 0x20) {
      tw.printText(str(S.No_8056));
      break;
    }
    if (k === 0x42) {
      tw.printText(str(S.Buy_8046));
      tw.printText(str(tword(T.ARMOURY_ASK_B + rnd(3) * 2)));
      tw.printText(str(tword(T.ARMOURY_ASK_C + rnd(3) * 2)));
      kind = await armouryBuyMenu(member);
      break;
    }
    if (k === 0x53) {
      tw.printText(str(S.Sell_804E));
      await armourySell(member);
      kind = -1;
      break;
    }
  }
  shopFarewell(kind);
}

// ---------------------------------------------------------------- healer (type 6)

async function healerAskWho() {
  if (party.alone()) return 0;
  tw.printText(str(S.Who_needs_my_aid_805A));
  const m = await status.askMemberNumber();
  if (m === -1) tw.printText(str(S.No_one_8072));
  return m;
}

/** XOR flashes over the view; the sound sweeps give them their length. */
async function healerEffect() {
  gfx.setDrawColor(gfx.colorFire);
  gfx.xorFillRect(0xb7, 0xb7, 8, 8);
  await sound.soundSweep(1, 5000, 0x57e4, 1, 0x100e);
  await sound.soundSweep(-1, 0x6b6c, 0x57e4, 1, 0x100e);
  gfx.setDrawColor(gfx.colorText);
  gfx.xorFillRect(0xb7, 0xb7, 8, 8);
  await sound.soundSweep(1, 1, -0x63c0, 1, 0x11b2);
  await sound.soundSweep(-1, 40000, -0x63c0, 1, 0x11b2);
  gfx.xorFillRect(0xb7, 0xb7, 8, 8);
  await sound.soundSweep(2, 1, 18000, 1, 0x8fc);
  await sound.soundSweep(-2, 36000, 18000, 1, 0x8fc);
}

/** At Skara Brae a price up to 100 that the party can't pay is waived. 1 = refused. */
async function healerAskPay() {
  shopPrint(str(S.for_gold_Wilt_thou_pay_807A));
  const k = await yesNoKey();
  tw.printText(str(k === 0x59 ? S.Yes_8098 : S.No_809C));
  let refused = k === 0x4e;
  if (!refused && s16(party.gold) < s16(town.shopPrice) && (s16(town.shopPrice) > 100 || map.id !== M.SKARA_BRAE)) {
    shopSay(0x23ab);
    refused = true;
  }
  if (!refused && s16(town.shopPrice) <= s16(party.gold)) {
    party.gold = (party.gold - town.shopPrice) & 0xffff;
    shopTakeGold();
  }
  return refused;
}

async function shopHealer() {
  let done = false;
  shopGreeting();
  while (!done) {
    const k = await yesNoKey();
    tw.printText(str(k === 0x4e ? S.No_80A0 : S.Yes_80A4));
    if (k === 0x4e) break;
    tw.printText(str(S.We_have_powers_to_Cure_80AA));
    shopPrint(str(S.says_What_is_the_nature_80DA));
    let c;
    do c = (await key()) & 0xff;
    while (c !== 0x43 && c !== 0x48 && c !== 0x52 && c !== 0x20 && c !== 0x0d);
    if (c === 0x0d || c === 0x20) {
      tw.printText(str(S.Nothing_81C0));
      done = true;
    } else if (c === 0x43) {
      tw.printText(str(S.Curing_8106));
      const m = await healerAskWho();
      if (m !== -1) {
        if (party.member(m).poisoned()) {
          tw.printText(str(S.NL_NL_Quote_810E));
          let refused = false;
          if (map.id === M.MINOC) {
            tw.printText(str(S.Receive_now_the_Light_8112));
          } else {
            tw.printText(str(S.I_can_cure_thy_poisoned_812A));
            town.shopPrice = tb(T.CURE_PRICE + town.shopTown);
            refused = await healerAskPay();
          }
          if (!refused) {
            await healerEffect();
            party.member(m).status = 'G';
          }
        } else {
          shopPrint(str(S.Thou_hast_no_need_of_3D5A));
        }
      }
    } else if (c === 0x48) {
      tw.printText(str(S.Healing_8148));
      const m = await healerAskWho();
      if (m !== -1) {
        const p = party.member(m);
        if (p.dead() || p.hp === p.maxHp) {
          shopPrint(str(S.Thou_hast_no_need_of_3D5A));
        } else {
          tw.printText(str(S.NL_NL_Quote_8150));
          let refused = false;
          if (map.id === M.MINOC) {
            tw.printText(str(S.Receive_now_the_Light_8154));
          } else {
            tw.printText(str(S.I_can_heal_thee_816C));
            town.shopPrice = tb(T.HEAL_PRICE + town.shopTown);
            refused = await healerAskPay();
          }
          if (!refused) {
            await healerEffect();
            p.hp = p.maxHp;
          }
        }
      }
    } else {
      tw.printText(str(S.Resurrect_817E));
      const m = await healerAskWho();
      if (m !== -1) {
        if (!party.member(m).dead()) {
          shopPrint(str(S.Thou_hast_no_need_of_3D5A));
        } else {
          tw.printText(str(S.NL_NL_Quote_8188));
          tw.printText(str(S.I_can_raise_this_818C));
          tw.printText(str(S.the_dead_81B6));
          town.shopPrice = tword(T.RESURRECT_PRICE + town.shopTown * 2);
          if (!(await healerAskPay())) {
            await healerEffect();
            await resurrectMember(0xff, m);
            party.member(m).hp = party.member(m).maxHp;
            status.drawStatusBar();
          }
        }
      }
    }
    if (!done) {
      status.drawStatusBar();
      tw.printText(str(S.Is_there_any_other_way_81C8));
      tw.printText(str(S.aid_thee_81F2));
    }
  }
  shopFarewell(1);
}

// ---------------------------------------------------------------- SHOPPES2: tavern (type 1)

/** The tavern's letters for food, drink, rations and rumours (by its index, ds:4C1E...). */
const tavernKey = (base) => tb(base + town.tavernIndex);

function tavernPriceForParty(priceEach) {
  town.shopPrice = 0;
  town.tavernDiners2 = 0;
  town.tavernDiners = 0;
  for (let i = 0; i < party.size; i++)
    if (!party.member(i).dead()) {
      town.tavernDiners2++;
      town.tavernDiners++;
      town.shopPrice = (town.shopPrice + priceEach) & 0xffff;
    }
  put(0x0a);
  put(0x0a);
}

function numberWord() {
  const words = [S.two_9AA8, S.three_9AAC, S.four_9AB2, S.five_9AB8, S.six_9ABE];
  if (town.tavernDiners2 >= 2 && town.tavernDiners2 <= 6) tw.printText(str(words[town.tavernDiners2 - 2]));
}

function sirOrMilady() {
  party.activePlayer = 0xff;
  tw.printText(str(party.member(0).sex === 0x0b ? S.sir_9AC2 : S.milady_9AC6));
}

/** Food goes onto the table next to the party (0x95 -> 0x9B above / 0x9A below). 1 = thrown out. */
async function tavernServeFood() {
  put('"');
  tw.printText(str(S.That_will_be_9ACE));
  tw.printNumber(' ', 1, s16(town.shopPrice));
  tw.printText(str(S.gold_for_the_9ADC));
  numberWord();
  tw.printText(str(S.of_ye_9AEC));
  sirOrMilady();
  put('.');
  if (s16(party.gold) < s16(town.shopPrice)) {
    tw.printText(str(S.CAN_T_PAY_Beat_it_9AF6));
    tw.printText(str(town.shopkeeperName));
    put('.');
    put(0x0a);
    return 1;
  }
  party.gold = (party.gold - town.shopPrice) & 0xffff;
  shopTakeGold();
  if (town.tavernDiners === 0) {
    town.tavernDrinks++;
  } else {
    addWordCapped(9999, town.tavernDiners, party, 'food');
    if (map.getTile(map.y - 1, map.x) === 0x95) {
      map.setTile(map.y - 1, map.x, 0x9b);
      town.tavernFoodTile = 0x9b;
      await view.worldTick();
    } else if (map.getTile(map.y + 1, map.x) === 0x95) {
      map.setTile(map.y + 1, map.x, 0x9a);
      town.tavernFoodTile = 0x9a;
      await view.worldTick();
    }
  }
  tw.printText(str(S.Enjoy_9B16));
  return 0;
}

async function tavernOrderFood() {
  put(tavernKey(T.TAVERN_FOOD_KEY));
  tavernPriceForParty(s16(tword(T.MEAL_PRICE + town.shopTown * 2)));
  return tavernServeFood();
}

/**
 * The fourth drink can be refused; insisting makes the party drunk (25 turns of "Hic!") and costs 1
 * karma. Wine taverns ('W') have a wine list. 1 = thrown out, 2 = chose nothing.
 */
async function tavernWine() {
  put(tavernKey(T.TAVERN_WINE_KEY));
  if (town.tavernDrinks === 3) {
    tw.printText(str(S.I_beg_thy_pardon_9B22));
    sirOrMilady();
    tw.printText(str(S.says_9B38));
    tw.printText(str(town.shopkeeperName));
    tw.printText(str(S.But_haven_t_ye_had_9B42));
    if ((await yesNoKey()) === 0x59) {
      tw.printText(str(S.Yes_9B6C));
      return 0;
    }
    tw.printText(str(S.No_9B72));
    town.drunkTurns = 0x19;
    subByteFloor0(1, party, 'karma');
  }
  tavernPriceForParty(1);
  if (tavernKey(T.TAVERN_WINE_KEY) !== 0x57) {
    town.tavernDiners = 0; // a drink, not a meal
    return tavernServeFood();
  }
  tw.printText(str(S.Our_wine_list_9B76));
  sirOrMilady();
  tw.printText(str(S.Dot_NL_NL_9B88));
  for (let o = 0x9b8c; o <= 0x9be6; o += 0x12) tw.printText(str(o)); // a) Rose ... f) Chablis
  tw.printText(str(S.Thy_choice_9BFA));
  let k;
  do k = (await key()) & 0xff;
  while (k !== 0x20 && (k < 0x41 || k > 0x46));
  if (k !== 0x20) {
    put(k);
    tw.printText(str(S.Ah_a_fine_choice_9C08));
    sirOrMilady();
    put('.');
    const price = s16(tword(T.WINE_PRICE + (k - 0x41) * 2));
    if (s16(party.gold) < price) {
      tw.printText(str(S.CAN_T_PAY_Beat_it_9C20));
      tw.printText(str(town.shopkeeperName));
      put('.');
      put(0x0a);
      return 1;
    }
    party.gold = (party.gold - price) & 0xffff;
    shopTakeGold();
    town.tavernDrinks++;
    tw.printText(str(S.Enjoy_9C40));
  }
  put(0x0a);
  put(0x0a);
  if (k === 0x20) {
    shopSay(0x1413);
    return 2;
  }
  return 0;
}

/** 25 food a ration; an empty order gets "Hrumph." */
async function tavernBuyRations(member) {
  put(tavernKey(T.TAVERN_RATIONS_KEY));
  put(0x0a);
  put(0x0a);
  town.shopPrice = adjustPriceU(tword(T.RATIONS_PRICE + town.shopTown * 2), intelOf(member));
  put('"');
  shopSay(tword(T.RATIONS_TEXT + randomBetween(6, 0) * 2));
  tw.printText(str(S.How_many_wouldst_thou_9C4A));
  const want = await readNumber(2);
  if (want === 0) {
    tw.printText(str(S.Hrumph_9C6A));
    return 2;
  }
  for (let left = want; left !== 0; left--) {
    if (s16(party.gold) < s16(town.shopPrice)) {
      tw.printText(str(S.NL_NL_9C76));
      if (want - left === 0) {
        if (s16(party.food) < 3) { // pity on the starving
          addWordCapped(9999, randomBetween(1, 0) + 1, party, 'food');
          shopSay(0x143f);
        } else {
          tw.printText(str(S.Thou_hast_neither_gold_9C7A));
          tw.printText(str(S.yells_9CA4));
          tw.printText(str(town.shopkeeperName));
          tw.printText(str(S.Dot_NL_9CAC));
        }
        return 1;
      }
      tw.printText(str(S.Thou_canst_afford_only_9CB0));
      tw.printNumber(' ', 1, want - left);
      tw.printText(str(S.Bang_Quote_NL_NL_9CCA));
      return 0;
    }
    subWordFloor0(town.shopPrice, party, 'gold');
    addWordCapped(9999, 0x19, party, 'food');
    if (party.food === 9999) break;
  }
  tw.printText(str(S.NL_NL_9CD0));
  shopTakeGold();
  return 0;
}

/** 26 topics (ds:4C74), each with a price (ds:4D10) and the & / * of the answer. */
async function tavernRumours() {
  let topic = -1;
  put(tavernKey(T.TAVERN_RUMOUR_KEY));
  tw.printText(str(S.NL_NL_Quote_9EFC));
  for (;;) {
    tw.printText(str(S.Of_what_wouldst_thou_9F00));
    sirOrMilady();
    tw.printText(str(S.You_respond_9F24));
    conversation.input = await readLine(0x0f);
    tw.printText(str(S.NL_NL_9F36));
    if (conversation.input === '') return 0;
    for (let i = 0; i < 0x1a; i++) {
      const pos = strFindNocase(conversation.input, str(tword(T.RUMOUR_KEYWORD + i * 2)));
      if (pos === 0 || (pos > 0 && conversation.input.charCodeAt(pos - 1) === 0x20)) {
        topic = i;
        break;
      }
    }
    if (topic !== -1) break;
    tw.printText(str(S.That_I_cannot_help_thee_9F3A));
  }
  town.shopPrice = tword(T.RUMOUR_PRICE + topic * 2);
  shopSay(0x134e);
  tw.printText(str(S.Fair_nuff_9F5C));
  if ((await yesNoKey()) === 0x4e) {
    tw.printText(str(S.No_9F6C));
    return 0;
  }
  tw.printText(str(S.Yes_9F72));
  if (s16(party.gold) < s16(town.shopPrice)) {
    tw.printText(str(S.Sorry_9F78));
    sirOrMilady();
    shopSay(0x146a);
    return 1;
  }
  party.gold = (party.gold - town.shopPrice) & 0xffff;
  status.drawStatusBar();
  town.shopItemName = tword(T.RUMOUR_SUBJECT + topic * 2);
  town.shopItemName2 = tword(T.RUMOUR_PLACE_NAME + tb(T.RUMOUR_PLACE + topic) * 2);
  shopSay(tword(T.RUMOUR_TEXT + rnd(3) * 2));
  tw.printText(str(S.says_9F82));
  tw.printText(str(town.shopkeeperName));
  tw.printText(str(S.Dot_NL_NL_9F8A));
  return 0;
}

/** Rumours are only offered once the party has bought something. */
async function shopTavern(member) {
  town.tavernIndex = tb(T.TAVERN_INDEX + town.shopTown);
  town.tavernFarewellKind = 0;
  town.tavernFoodTile = 0;
  shopGreeting();
  let k;
  do {
    k = await key();
    if (k === 0x4e || k === 0x20) {
      tw.printText(str(S.No_9F8E));
      shopFarewell(town.tavernFarewellKind);
      return;
    }
  } while (k !== 0x59);
  tw.printText(str(S.Yes_9F92));
  shopSay(tword(T.TAVERN_GREETING + town.tavernIndex * 2));
  put('"');
  put(' ');
  if (tw.getCursorCol() >= 0x0f) put(0x0a);
  for (;;) {
    let r = 0;
    for (;;) {
      const c = (await key()) & 0xff;
      r = 0;
      if (c === 0x20 || c === 0x1b || c === 0x0d) {
        shopFarewell(town.tavernFarewellKind);
        return;
      }
      if (tavernKey(T.TAVERN_FOOD_KEY) === c && (await tavernOrderFood()) !== 0) return;
      if (tavernKey(T.TAVERN_WINE_KEY) === c && (r = await tavernWine()) === 1) return;
      if (tavernKey(T.TAVERN_RATIONS_KEY) === c && (r = await tavernBuyRations(member)) === 1) return;
      if (tavernKey(T.TAVERN_RUMOUR_KEY) === c) {
        if (town.tavernFarewellKind === 0) continue;
        if ((await tavernRumours()) !== 0) return;
      }
      if (tavernKey(T.TAVERN_FOOD_KEY) === c || tavernKey(T.TAVERN_WINE_KEY) === c || tavernKey(T.TAVERN_RATIONS_KEY) === c || tavernKey(T.TAVERN_RUMOUR_KEY) === c) break;
    }
    if (r !== 2) town.tavernFarewellKind = 1;
    status.drawStatusBar();
    tw.printText(str(S.Anything_else_for_thee_9F9A));
    if ((await yesNoKey()) === 0x4e) {
      tw.printText(str(S.No_9FB6));
      shopFarewell(town.tavernFarewellKind);
      return;
    }
    tw.printText(str(S.Yes_9FBA));
    shopSay(tword(T.TAVERN_MENU + town.tavernIndex * 2));
    put('"');
    put(' ');
  }
}

// ---------------------------------------------------------------- SHOPPES2: shipwright (type 3)

function canAfford(price) {
  if (price <= s16(party.gold)) return true;
  shopSay(0x198e);
  shopPrint(str(S.yells_9FC2));
  town.shipwrightCanBuy = 1; // skips the farewell
  return false;
}

/** pay: charge the price; place: put the ship at this town's dock. ("milady" compares sex with 'F': everyone is "sir".) 1 = stop. */
async function shipwrightOffer(member, pay, place) {
  if (place) {
    shopSay(0x19ab);
    town.storedShipX = tb(T.SHIP_X + town.shopTown);
    town.storedShipY = tb(T.SHIP_Y + town.shopTown);
  }
  if (pay) {
    party.gold = (party.gold - town.shopPrice) & 0xffff;
    town.shipwrightBought = 1;
    shopTakeGold();
  }
  status.drawStatusBar();
  shopSay(0x19da);
  tw.printText(str(party.member(member).sex === 0x46 ? S.milady_9FCC : S.sir_9FD4));
  tw.printText(str(S.Qm_Quote_SP_9FD8));
  const k = await yesNoKey();
  tw.printText(str(k === 0x59 ? S.Yes_9FDC : S.No_9FE0));
  return k !== 0x59 ? 1 : 0;
}

/** storedShip: 0x80 a frigate, 0x40 a skiff, low bits extra skiffs. */
async function shipwrightMenu(member) {
  let stop = 0;
  do {
    shopSay(0x18eb);
    const k = await key();
    if (k === 0x1b || k === 0x20) {
      stop = 1;
    } else if (k === 0x46) {
      tw.printText(str(S.F_9FE4));
      stop = 1;
      if ((town.storedShip & 0xc0) === 0) {
        town.shopPrice = adjustPriceU(tword(T.SHIP_PRICE + town.shopTown * 2), intelOf(member));
        shopSay(0x183e);
        shopSay(0x1a50);
        if ((await yesNoKey()) !== 0x59) {
          tw.printText(str(S.No_9FF6));
          return;
        }
        tw.printText(str(S.Yes_9FF0));
        if (!canAfford(s16(town.shopPrice))) return;
        town.storedShip = 0x82;
        stop = await shipwrightOffer(member, 1, 1);
      } else { // already has a ship: trade it in? (10000, never affordable)
        shopSay(0x19f2);
        if ((await yesNoKey()) === 0x59) {
          tw.printText(str(S.Yes_9FE8));
          canAfford(10000);
        } else {
          tw.printText(str(S.No_9FEC));
          await shipwrightMenu(member);
        }
      }
    } else if (k === 0x53) {
      tw.printText(str(S.S_9FFA));
      town.shopPrice = adjustPriceU(tword(T.SKIFF_PRICE + town.shopTown * 2), intelOf(member));
      shopSay(0x188c);
      shopSay(0x1a50);
      const yes = (await yesNoKey()) === 0x59;
      stop = 1;
      if (!yes) {
        tw.printText(str(S.No_A004));
        return;
      }
      tw.printText(str(S.Yes_9FFE));
      if (!canAfford(s16(town.shopPrice))) return;
      if ((town.storedShip & 0xc0) === 0) {
        town.storedShip = 0x40;
        stop = await shipwrightOffer(member, 1, 1);
      } else if (town.storedShip & 0x80) { // a skiff for the frigate
        shopSay(0x193b);
        town.storedShip++;
        stop = await shipwrightOffer(member, 1, 0);
      } else if (town.storedShip & 0x40) {
        shopSay(0x195f);
        stop = await shipwrightOffer(member, 0, 0);
      }
    }
  } while (stop === 0);
}

async function shopShipwright(member) {
  town.shipwrightCanBuy = 0;
  town.shipwrightBought = 0;
  shopGreeting();
  for (;;) {
    const k = await key();
    if (k === 0x20 || k === 0x4e) {
      tw.printText(str(S.No_A00C));
      break;
    }
    if (k === 0x59) {
      tw.printText(str(S.Yes_A008));
      await shipwrightMenu(member);
      break;
    }
  }
  if (town.shipwrightCanBuy === 0) shopFarewell(town.shipwrightBought);
}

// ---------------------------------------------------------------- SHOPPES3: inn (type 7)

function countLeftCompanions() {
  let n = 0;
  for (let i = 0; i < 16; i++) if (party.member(i).where === map.id) n++;
  return n;
}

function innSirOrMilady(sex) {
  tw.printText(str(S.NL_NL_4D84));
  if (countLeftCompanions() < tb(T.INN_ROOMS + town.shopTown)) return true;
  tw.printText(str(S.I_am_sorry_4D87));
  tw.printText(str(sex === 0x0c ? S.milady_4D95 : S.sir_4D9C));
  tw.printText(str(S.but_we_have_no_room_4DA0));
  return false;
}

function restoreMp(p) {
  if (p.cls === 'A' || p.cls === 'M') p.mp = p.intel;
  else if (p.cls === 'B') p.mp = p.intel >> 1;
}

/** A night's rest until 6:00 in the inn's bed, then healed; anyone still poisoned dies. -1 rested, -2 no room. */
async function innRest(result, sex, intel) {
  put('R');
  if (!innSirOrMilady(sex)) return -2;
  put('"');
  town.shopPrice = adjustPriceS((tb(T.INN_PRICE + town.shopTown) * party.size) & 0xffff, intel);
  shopSay(tword(T.INN_TEXT + town.shopTown * 2));
  tw.printText(str(S.Wilt_thou_take_it_4DCA));
  const k = await askYesNo();
  tw.printText(str(S.NL_NL_4DE0));
  if (k !== 0x59) return result;
  if (s16(party.gold) < s16(town.shopPrice)) {
    tw.printText(str(S.Highwaymen_Cheap_at_that_4DE3));
    shopPrint(str(S.screams_4E07));
    return result;
  }
  party.gold = (party.gold - town.shopPrice) & 0xffff;
  shopTakeGold();
  status.drawStatusBar();
  tw.printText(str(S.Have_a_pleasant_night_4E13));
  tw.printText(str(sex === 0x0c ? S.milady_4E2C : S.sir_4E33));
  shopPrint(str(S.says_4E37));
  await waitTurns(10);
  restoreOpenDoor(map.openDoorY, map.openDoorX, map.openDoorTile);
  const active = party.activePlayer;
  map.x = tb(T.INN_BED_X + town.shopTown);
  map.y = tb(T.INN_BED_Y + town.shopTown);
  view.rebuild = true;
  for (let i = 0; i < party.size; i++) if (party.member(i).good()) party.member(i).status = 'S';
  status.drawStatusBar();
  await view.worldTick();
  tw.printText(str(S.Zzzzzz_4E44));
  for (let i = 0; i < 12; i++) passTime(5);
  while (gameTime.hour !== 6 && !platform.quitRequested()) {
    await waitTurns(1);
    status.regenRingTick();
    status.drawStatusBar();
    passTime(9);
    if (gameTime.hour === 0x14 || gameTime.hour === 5) town.updateLamps();
  }
  tw.printText(str(S.Morning_4E51));
  town.placeNpcs();
  for (let i = 0; i < party.size; i++) {
    const p = party.member(i);
    if (p.dead()) continue;
    p.hp = p.maxHp;
    restoreMp(p);
    if (p.poisoned()) {
      p.status = 'D';
      p.hp = 0;
      put(0x0a);
      tw.printText(p.name);
      tw.printText(str(S.has_passed_away_4E5B));
    } else if (p.asleep()) {
      p.status = 'G';
    }
  }
  map.x = (map.x + 1) & 0xff;
  view.rebuild = true;
  party.activePlayer = active;
  status.drawStatusBar();
  return -1;
}

/** A member (not the Avatar) stays at the inn, moved to the end of the roster; billed per month at pick-up. */
async function innLeaveCompanion(result, sex, intel) {
  put('L');
  if (!innSirOrMilady(sex)) return result;
  if (party.alone()) {
    shopSay(0x26e8);
    return -1;
  }
  for (;;) {
    shopPrint(str(S.asks_Who_will_stay_4E86));
    const m = await status.askMemberNumber();
    if (m === -1) {
      tw.printText(str(S.Nobody_4EA0));
      return -2;
    }
    tw.printText(str(S.NL_NL_4EA9));
    if (m === 0) {
      tw.printText(str(S.Thy_friend_4EAC));
      if (party.size > 2) put('s');
      tw.printText(str(S.will_not_leave_thee_4EB7));
      continue;
    }
    if (party.member(m).dead()) {
      shopSay(0x2723);
      return -1;
    }
    town.shopPrice = adjustPriceS(tb(T.INN_PRICE + town.shopTown) * 10, intel);
    tw.printText(str(S.The_rate_for_our_most_4ECF));
    shopPrint(str(S.gold_per_month_due_at_4F00));
    tw.printText(str(S.Wilt_thou_take_it_4F24));
    const k = await askYesNo();
    tw.printText(str(S.NL_NL_4F3A));
    if (k === 0x59) {
      result = 1;
      if (m === party.activePlayer) party.activePlayer = 0xff;
      else if (m < party.activePlayer && party.activePlayer !== 0xff) party.activePlayer--;
      party.member(m).where = map.id;
      party.member(m).innMonths = 0;
      party.moveOut(m);
      status.drawStatusBar();
      shopPrint(str(S.I_thank_thee_says_4F3D));
    }
    return result;
  }
}

function prevInnGuest(slot) {
  do {
    if (--slot === 0) return 0;
  } while (party.member(slot).where !== map.id);
  return slot;
}

function nextInnGuest(slot) {
  do {
    if (++slot > 0x0f) break;
  } while (party.member(slot).where !== map.id);
  return slot === 0x10 ? 0 : slot;
}

async function innPickUpCompanion(result, intel) {
  const guests = countLeftCompanions();
  let sel;
  if (party.full()) {
    tw.printText(str(S.One_must_first_be_left_4F57));
    return result;
  }
  if (guests === 0) {
    shopPrint(str(S.No_one_here_is_from_4F7A));
    return result;
  }
  if (guests < 2) {
    sel = nextInnGuest(0);
  } else { // the guest register in the side panel, a bar to choose with
    tw.printText(str(S.Who_will_check_out_4FA7));
    tw.selectTextWindow(1);
    status.clearSidePanel();
    tw.defineTextWindow(9, 0x26, 1, 0x18, 1);
    put(0xff);
    tw.defineTextWindow(9, 0x27, 1, 0x18, 1);
    drawPanelBox(7);
    tw.setCursor(1, 1);
    tw.printText(str(S.GUEST_4FC0));
    tw.setCursor(2, 1);
    tw.printText(str(S.REGISTER_4FCA));
    for (let i = 1; i < 16; i++)
      if (party.member(i).where === map.id) {
        tw.setCursor(tw.getCursorRow(), 4);
        tw.printText(party.member(i).name);
        put(0x0a);
      }
    tw.selectTextWindow(2);
    sel = nextInnGuest(0);
    let y = 0x28, done = false;
    gfx.setDrawColor(gfx.colorText);
    while (!done) {
      gfx.xorFillRect(y + 7, 0x131, y, 0xc6);
      for (;;) {
        const k = (await key()) & 0xff;
        let moved = false;
        if (k === 3 || k === 1) {
          const p = prevInnGuest(sel);
          if (p) {
            gfx.xorFillRect(y + 7, 0x131, y, 0xc6);
            y -= 8;
            sel = p;
            moved = true;
          }
        } else if (k === 4 || k === 2) {
          const n = nextInnGuest(sel);
          if (n) {
            gfx.xorFillRect(y + 7, 0x131, y, 0xc6);
            y += 8;
            sel = n;
            moved = true;
          }
        } else if (k === 0x0d || k === 0x20 || k === 0x1b) {
          if (k === 0x1b) {
            tw.printText(str(S.No_one_4FD8));
            sel = 0;
          }
          done = true;
          break;
        }
        if (moved) break;
      }
    }
    status.drawPanelBottomBar();
    status.drawStatusBar();
  }
  if (sel === 0) return result;
  const months = party.member(sel).innMonths || 1;
  town.shopPrice = (months * adjustPriceS(tb(T.INN_PRICE + town.shopTown) * 10, intel)) & 0xffff;
  shopPrint(str(S.That_will_be_gold_please_4FE1));
  if (s16(party.gold) < s16(town.shopPrice)) {
    shopSay(0x275a);
    town.alertTown();
    return -1;
  }
  party.gold = (party.gold - town.shopPrice) & 0xffff;
  shopTakeGold();
  status.drawStatusBar();
  const p = party.moveIn(sel);
  let text;
  if (p.poisoned()) { // poison kills while away
    p.status = 'D';
    p.hp = 0;
    text = str(S.Thy_friend_has_died_by_5005);
  } else {
    p.hp = p.maxHp;
    restoreMp(p);
    text = str(S.I_hope_thou_hast_found_5028);
  }
  tw.printText(text);
  shopPrint(str(S.says_5055));
  status.drawStatusBar();
  return 1;
}

async function shopInn(member) {
  let result = 0, done = false;
  const intel = intelOf(member);
  const sex = party.member(member).sex;
  party.activeSpellTurns = 0;
  party.activeSpell = 0;
  status.drawStatusBar();
  shopGreeting();
  while (!done) {
    let k;
    do {
      k = await key();
      if (k === 0x20) k = 0x4e;
    } while (k !== 0x4e && k !== 0x59);
    tw.printText(str(k === 0x4e ? S.No_505F : S.Yes_5062));
    if (k === 0x4e) break;
    shopPrint(str(S.asks_Art_thou_here_to_5066));
    tw.printText(str(S.Leave_a_companion_or_to_508E));
    for (;;) {
      const c = (await key()) & 0xff;
      if (c === 0x20) {
        done = true;
        break;
      }
      if (c === 0x4c) {
        const r = await innLeaveCompanion(result, sex, intel);
        if (r > -2) result = r;
        if (result === -1) done = true;
        break;
      }
      if (c === 0x50) {
        result = await innPickUpCompanion(result, intel);
        if (result === -1) done = true;
        break;
      }
      if (c === 0x52) {
        const r = await innRest(result, sex, intel);
        if (r > -2) {
          result = r;
          done = true;
        }
        break;
      }
    }
    if (!done) tw.printText(str(S.Is_there_anything_more_I_50BD));
  }
  shopFarewell(result);
}

// ---------------------------------------------------------------- from talk: open_shop (c066)

/** Merchant 0x81-0x88 = shop type 0-7; the town's index in the type's list picks the names and prices. */
export async function openShop(merchant) {
  if ((party.transport & 0xfe) === 0x12 && merchant !== 0x83) {
    tw.printText(str(S.A_merchant_says_GET_THAT_9072));
    return;
  }
  const member = party.activePlayer === 0xff ? party.firstAble() : party.activePlayer;
  town.shopType = merchant - 0x81;
  town.shopTown = 0;
  if (tb(T.SHOP_LOCATION + town.shopType * 0x10) !== map.id) {
    town.shopTown = 0;
    do {
      if (s16(town.shopTown) > 0x0f) break;
      town.shopTown++;
    } while (tb(T.SHOP_LOCATION + town.shopType * 0x10 + town.shopTown) !== map.id);
  }
  const i = town.shopType * 0x20 + town.shopTown * 2;
  town.shopName = tword(T.SHOP_NAME + i);
  town.shopkeeperName = tword(T.SHOPKEEPER_NAME + i);
  switch (town.shopType) {
    case 0: await shopArmoury(member); break;
    case 1: await shopTavern(member); break;
    case 2: await shopStables(member); break;
    case 3: await shopShipwright(member); break;
    case 4: await shopReagents(member); break;
    case 5: await shopProvisioner(member); break;
    case 6: await shopHealer(); break;
    case 7: await shopInn(member); break;
  }
}
