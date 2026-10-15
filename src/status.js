// status.js - the party panel on the right and the panel title bars, as the Status class;
// `status` is the one object. Ported from the C++ port's status.cpp.
import { S, strings } from './data/strings.js';
import { gameTime } from './gametime.js';
import { gfx } from './gfx.js';
import { map } from './map.js';
import { getCommandKey } from './commands.js';
import { addWordCapped, randomBetween, subWordFloor0 } from './misc.js';
import { party } from './party.js';
import { platform } from './platform/platform.js';
import { textWindows as tw } from './text.js';
import { combat } from './combat.js';

export class Status {
  constructor() {
    this.dirty = false; // redraw the panel before the next key (refresh)
  }

  /** Redraws the panel if it is dirty. */
  refresh() {
    if (this.dirty) {
      this.drawStatusBar();
      this.dirty = false;
    }
  }

  /** 39fc: -1 all dead, 1 all asleep, 0 someone can act. */
  checkPartyState() {
    let asleep = 0;
    for (let i = 0; i < party.size; i++) {
      const st = party.member(i).status;
      if (st === 'G' || st === 'P') return 0;
      if (st === 'S') asleep++;
    }
    return asleep ? 1 : -1;
  }

  /** In combat: is it this member's turn? */
  isCombatTurnOf(member) {
    const c = combat.combatants[combat.turn & 0x1f];
    return map.inScene() && combat.turn !== 0xff && (c.flags & 0x80) !== 0 && c.kind === member;
  }

  /**
   * 2726: "Name      HHHS": the name padded to 9, an arrow for the active player, hit points,
   * status. In combat a marker (0xFD toggles inverse) frames the member whose turn it is.
   */
  drawMemberStatusRow(member) {
    tw.setCursor(member, 0);
    if (member >= party.size) {
      for (let i = 0; i < 15; i++) tw.putChar(0x20);
      return;
    }
    const m = party.member(member);
    const turn = this.isCombatTurnOf(member);
    if (turn) tw.putChar(0xfd);
    tw.printText(m.name);
    for (let n = m.name.length; n < 9; n++) tw.putChar(0x20);
    if (member === party.activePlayer) {
      if (m.dead() || m.asleep()) {
        tw.putChar(0x20);
        party.activePlayer = 0xff;
      } else {
        tw.putChar(0x1a);
      }
    } else {
      tw.putChar(0x20);
    }
    tw.printNumber(' ', 4, (m.hp << 16) >> 16);
    if (!map.inScene()) {
      tw.putChar(m.status.charCodeAt(0));
      return;
    }
    const c = combat.combatants[member];
    tw.putChar((c.flags & 0xe1) === 0x81 && c.kind === member ? 0x43 : m.status.charCodeAt(0));
    if (turn) tw.putChar(0xfd);
  }

  /** 2884 */
  drawGold() {
    tw.inWindow(1, () => {
      tw.setCursor(7, 8);
      const gold = (party.gold << 16) >> 16;
      if (gold < 1000) tw.putChar(0x20);
      if (gold < 100) tw.putChar(0x20);
      if (gold < 10) tw.putChar(0x20);
      tw.printText(strings.get(S.G_54B6)); // " G:"
      tw.printNumber(' ', 1, gold);
      while (tw.getCursorCol() <= 0x0e) tw.putChar(0x20);
    });
  }

  /** 2900: party rows, food, gold or the ship's hull, the date, the active spell. */
  drawStatusBar() {
    tw.selectTextWindow(1);
    for (let m = 0; m < 6; m++) this.drawMemberStatusRow(m);
    tw.setCursor(7, 0);
    tw.printText(strings.get(S.F_54BA)); // "F:"
    tw.printNumber(' ', 1, (party.food << 16) >> 16);
    while (tw.getCursorCol() <= 7) tw.putChar(0x20);
    if (!map.inScene() && (party.transport & 0xf8) === 0x20) {
      tw.printText(strings.get(S.Ship_54BD)); // "Ship:"
      tw.printNumber(' ', 1, map.objects.at(0).hull);
      if (map.objects.at(0).hull < 10) tw.putChar(0x20);
    } else {
      this.drawGold();
    }
    tw.printText(strings.get(S.NL_SP_SP_SP_54C3));
    if (gameTime.month < 10 && gameTime.day < 10) tw.putChar(0x20);
    tw.printNumber(' ', 1, gameTime.month);
    tw.putChar(0x2d);
    tw.printNumber(' ', 1, gameTime.day);
    tw.putChar(0x2d);
    tw.printNumber('0', 3, (gameTime.year << 16) >> 16);
    while (tw.getCursorCol() <= 0x0e) tw.putChar(0x20);
    tw.setCursor(6, 6);
    if (party.activeSpell === 0) {
      this.drawPanelBottomBar();
    } else {
      this.drawLabelLeft();
      tw.putChar(party.activeSpell);
      this.drawLabelRight();
    }
    tw.selectTextWindow(2);
  }

  /** 2a28: an XOR bar over the member's row. */
  highlightMemberRow(member) {
    gfx.setDrawColor(gfx.colorText);
    gfx.xorFillRect(member * 8 + 0x0f, 0x137, member * 8 + 8, 0xc0);
  }

  /**
   * 2d7a: digits 1-6 pick directly; arrows move the bar; Return / Space choose, Esc = none (-1),
   * 0 = all (-2) when allowed. Keys above '7' are ignored.
   */
  async selectMember(allowAll) {
    const v = { sel: 0 };
    let shown = 0xffff, done = false;
    const tc = combat.combatants[combat.turn & 0x1f];
    if (map.inScene() && (tc.flags & 0x80)) this.highlightMemberRow(tc.kind);
    this.drawPanelTitle(strings.get(S.Select_5554)); // "Select:"
    for (;;) {
      if (shown !== v.sel) {
        this.highlightMemberRow(v.sel);
        shown = v.sel;
      }
      let key;
      do {
        key = await getCommandKey();
        if (platform.quitRequested()) key = 0x1b;
      } while (key > 0x37);
      if (key >= 0x31 && key <= 0x36 && key - 0x31 < party.size) v.sel = key - 0x31;
      else if (key === 4 || key === 2) addWordCapped(party.size - 1, 1, v, 'sel');
      else if (key === 1 || key === 3) subWordFloor0(1, v, 'sel');
      else if (key === 0x0d || key === 0x20) done = true;
      else if (key === 0x1b) { v.sel = 0xffff; done = true; }
      else if (key === 0x30 && allowAll) { v.sel = 0xfffe; done = true; }
      if (shown !== v.sel) this.highlightMemberRow(shown);
      if (done) {
        if (((v.sel << 16) >> 16) >= 0) this.highlightMemberRow(v.sel);
        this.drawPanelTopBar();
        return (v.sel << 16) >> 16;
      }
    }
  }

  /** 2e8e */
  askMemberNumber() {
    return this.selectMember(false);
  }

  /** 400c: a member wearing the ring of regeneration (',') gains 1 hp, 1 time in 8. */
  regenRingTick() {
    for (let i = 0; i < party.size; i++) {
      const m = party.member(i);
      if (!m.dead() && m.ring === 0x2c && randomBetween(7, 0) === 7) {
        addWordCapped(m.maxHp, 1, m, 'hp');
        this.dirty = true;
      }
    }
  }

  /** The caps of a label box: glyph 2 / 1 in the frame colour, plus two slanted lines. */
  labelCap(glyph, left) {
    const w = tw.window;
    const x = (w.left + tw.getCursorCol()) * 8, y = (w.top + tw.getCursorRow()) * 8;
    const attr = w.attr;
    tw.setTextColor(gfx.colorFrame);
    tw.setTextBgColor(0);
    tw.putChar(glyph);
    gfx.setDrawColor(gfx.colorText);
    if (left) {
      gfx.drawLine(y + 3, x + 5, y, x);
      gfx.drawLine(y + 7, x, y + 4, x + 5);
    } else {
      gfx.drawLine(y + 3, x + 2, y, x + 7);
      gfx.drawLine(y + 7, x + 7, y + 4, x + 2);
    }
    tw.setTextColor(attr & 0x0f);
    tw.setTextBgColor(attr >> 4);
  }

  /** 4c2a */
  drawLabelLeft() { this.labelCap(2, true); }
  /** 4cce */
  drawLabelRight() { this.labelCap(1, false); }

  /** 4e20 */
  drawPanelTopBar() {
    gfx.setDrawColor(gfx.colorFrame);
    gfx.fillRect(6, 0x137, 0, 0xc0);
    gfx.setDrawColor(gfx.colorText);
    gfx.drawHline(0x137, 7, 0xc0);
  }

  /** 4e50 */
  drawPanelTitle(title) {
    const len = title.length, col = 0x1e - (len >> 1);
    gfx.setDrawColor(gfx.colorFrame);
    gfx.fillRect(6, col * 8, 0, 0xc0);
    const right = (len + col + 2) * 8;
    gfx.fillRect(6, 0x137, 0, right);
    gfx.setDrawColor(gfx.colorText);
    gfx.drawHline(col * 8, 7, 0xc0);
    gfx.drawHline(0x137, 7, right);
    tw.inWindow(0, () => {
      tw.setCursor(0, col);
      this.drawLabelLeft();
      tw.printText(title);
      this.drawLabelRight();
    });
  }

  /** 4efc */
  clearSidePanel() {
    gfx.setDrawColor(gfx.colorText);
    gfx.drawVline(0x3f, 0x38, 0xbf);
    gfx.drawVline(0x3f, 0x38, 0x138);
    gfx.setDrawColor(0);
    gfx.fillRect(0x3f, 0x137, 0x38, 0xc0);
  }

  /** 4f3c */
  drawPanelBottomBar() {
    gfx.setDrawColor(gfx.colorFrame);
    gfx.fillRect(0x3e, 0x138, 0x39, 0xbf);
    gfx.setDrawColor(gfx.colorText);
    gfx.drawHline(0x137, 0x38, 0xc0);
    gfx.drawHline(0x137, 0x3f, 0xc0);
  }

  /** The bar under the status window, plain. */
  drawListHeaderBar() {
    gfx.setDrawColor(gfx.colorFrame);
    gfx.fillRect(0x56, 0x107, 0x51, 0xf0);
    gfx.setDrawColor(gfx.colorText);
    gfx.drawHline(0x107, 0x50, 0xf0);
    gfx.drawHline(0x107, 0x57, 0xf0);
  }

  /** An arrow character on that bar: the list goes on. */
  drawListMarker(c) {
    tw.inWindow(0, () => {
      tw.setCursor(10, 0x1e);
      this.drawLabelLeft();
      tw.putChar(c);
      this.drawLabelRight();
    });
  }
}

export const status = new Status();
