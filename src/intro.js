// intro.js - everything before the game proper: the title sequence and menu, the introduction's
// story, the demo ("Return to the View"), character creation and the transfer from Ultima IV
// (INTRO.OVL and FONT.OVL), as the Intro class; `intro` is the one object. Ported from the C++
// port's intro.cpp and story.cpp. None of its state is part of a saved game.
import { toUpper } from './commands.js';
import { data, SHARED } from './data/gamedata.js';
import { pictures, P } from './data/pictures.js';
import { S, strings } from './data/strings.js';
import { Dungeon } from './dungeon.js';
import { dissolveTile } from './effects.js';
import { files, loadFilePart, saveFilePart } from './files.js';
import { gfx } from './gfx.js';
import { input } from './input.js';
import { loadGameFile, M, map, saveGameFile } from './map.js';
import { randomBetween, setRandomSeed, timeSeed } from './misc.js';
import { party } from './party.js';
import {
  allocBackPage, copyBackRect, copyPage, copyPageRect, dosFreeMem, dosFreeMem2, drawFontGlyph, drawPictureFrame,
  loadBitmap, loadPicture, revealStrips, showTitlePicture, waitRevealStrips,
} from './picture.js';
import { platform } from './platform/platform.js';
import { sound } from './sound.js';
import { status } from './status.js';
import { textWindows as tw } from './text.js';
import { textBuffer } from './textbuf.js';
import { tiles } from './tiles.js';
import { video } from './video/video.js';
import { view } from './view.js';
import { setWindDirection } from './world.js';

/**
 * Puts pages together from the original's field-by-field tables at b: `words` entries of the left
 * pairs, the right pairs and the text offsets, then `bytes` entries of each byte field. The last
 * field is `last` (the story's `kind`, the ending's `chapter`).
 */
export function readPages(count, b, words, bytes, last) {
  const right = 2 * words, text = right + 4 * words, f = text + 2 * words;
  const at = (i) => (i < b.length ? b[i] : 0);
  const pages = [];
  for (let i = 0; i < count; i++) {
    const p = {
      left: [at(2 * i), at(2 * i + 1)],
      right: [at(right + 4 * i) | (at(right + 4 * i + 1) << 8), at(right + 4 * i + 2) | (at(right + 4 * i + 3) << 8)],
      text: at(text + 2 * i) | (at(text + 2 * i + 1) << 8),
    };
    ['lineMin', 'lineMax', 'x', 'y', 'frame', 'set', 'px', 'py', last].forEach((name, k) => { p[name] = at(f + k * bytes + i); });
    pages.push(p);
  }
  return pages;
}

const PATH_SIZE = 0x1060;

/** A name into a member's 9 bytes as the original writes it: the characters and a NUL, the rest left as it was. */
function writeName(m, name) {
  for (let i = 0; i < name.length && i < 8; i++) m.bytes[m.offset + i] = name.charCodeAt(i);
  m.bytes[m.offset + Math.min(name.length, 8)] = 0;
}

/** Text as the original's byte strings: a Uint8Array view (NUL-ended) or a JS string. */
function bytesOf(text) {
  if (typeof text === 'string') {
    const b = new Uint8Array(text.length + 1);
    for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0xff;
    return b;
  }
  return text;
}

export class Intro {
  constructor() {
    this.titlePicture = 0; // the logo picture
    // Lord British's signature, drawn stroke by stroke on the title screen: BRITISH.PTH, and how
    // far introTracePath has got in it.
    this.signaturePath = new Uint8Array(PATH_SIZE);
    this.pathPos = 0;
    // Story text: the cursor in pixels, and two pairs of margins. Lines whose y lies between
    // storyLineMin and storyLineMax use pair 1, the text beside a picture.
    this.storyX = 0;
    this.storyY = 0x3c;
    this.storyLeft = [0, 0];
    this.storyRight = [0x140, 0x140];
    this.storyLineMin = 0xc8;
    this.storyLineMax = 0xc8;
    this.storySpaceWidth = 5;
    // The demo.
    this.demoFrame = 0;
    this.demoCaptionFirst = 0;
    this.demoCaptionLast = 0;
    this.demoCaptionBlink = 0;
    this.demoCaptionMode = 0;
    // Character creation.
    this.virtueAsked = new Uint8Array(8);
    this.virtueBeaten = new Uint8Array(8);
    this.newInt = 0;
    this.newDex = 0;
    this.newStr = 0;
    // The transfer from Ultima IV: the first record of PARTY.SAV.
    this.u4Character = new Uint8Array(40);
    this.u4IsAvatar = 0;
    // What a click on the screen does (main.js): null nothing; 'skip' it is a key - it skips the
    // title sequence or the demo, turns the introduction's page (sent as Escape, which the menu
    // ignores if it is still waiting there); 'menu' it picks the menu item under it.
    this.mouseMode = null;

    // Read-only tables, from DATA.OVL.
    // 21 pages; the 22nd is read past each field's end, and its `kind` ends the story.
    this.storyPages = [];
    data.add(0x2f98, 21 * 17 + 9, (b) => { this.storyPages = readPages(22, b, 21, 22, 'kind'); }, 'intro.storyPages', SHARED);
    this.transferLabelRows = data.words(0x3656, new Int16Array(8), 'intro.transferLabelRows');
    this.transferLabels = data.words(0x3666, new Array(8).fill(0), 'intro.transferLabels');
    this.glyphWidths = data.bytes(0x50ca, new Uint8Array(128), 'intro.glyphWidths', SHARED); // less the gap of one pixel
    this.demoCaptions = data.words(0x515c, new Array(4).fill(0), 'intro.demoCaptions');
    // What each virtue adds to intelligence, dexterity and strength when it wins a question.
    this.virtueInt = data.bytes(0x5164, new Int8Array(8), 'intro.virtueInt');
    this.virtueDex = data.bytes(0x516c, new Int8Array(8), 'intro.virtueDex');
    this.virtueStr = data.bytes(0x5174, new Int8Array(8), 'intro.virtueStr');
    this.questionOffsets = data.words(0x517c, new Uint16Array(64), 'intro.questionOffsets'); // [a][b]
    this.virtueCardX = data.bytes(0x51fc, new Uint8Array(8), 'intro.virtueCardX');
    this.virtueCardY = data.bytes(0x5204, new Uint8Array(8), 'intro.virtueCardY');
  }

  glyphW(c) {
    return (c < 128 ? this.glyphWidths[c] : 0) + 1;
  }

  /** Waits for a key (the original spins on pollKey). Returns it, or 0 when the page closes. */
  async waitAnyKey() {
    for (;;) {
      const k = input.pollKey();
      if (k) return k;
      if (platform.quitRequested()) return 0;
      await input.delayTicks(1);
    }
  }

  // ---- INTRO.OVL ----

  /** 81d0: the banner's four animation frames go into the back page for waitRevealStrips. */
  drawMenuBanner() {
    video.setDrawPage(1);
    tw.putChar(0xff);
    for (let i = 0; i < 4; i++) drawPictureFrame(0, i * 0x32, 0x10, i + 1, this.titlePicture);
  }

  /**
   * 8210: BRITISH.PTH: one byte per pixel step, low nibble dy and high nibble dx (bit 3 =
   * negative, 0-2 pixels); a larger step moves without drawing; 0 ends a stroke. Returns 0 if a
   * key stopped it.
   */
  async introTracePath(y, x) {
    const path = this.signaturePath;
    let pen = gfx.colorText, i;
    gfx.setDrawColor(gfx.colorText);
    for (i = this.pathPos; i < PATH_SIZE; i++) {
      if (pen !== 0) gfx.plotPixel(y, x);
      pen = gfx.colorText;
      let dy = path[i] & 7, dx = (path[i] & 0x70) >> 4;
      if (dy > 2) pen = 0;
      if (path[i] & 8) dy = -dy;
      if (dx > 2) pen = 0;
      if (path[i] & 0x80) dx = -dx;
      x += dx;
      y += dy;
      if (input.pollKey() !== 0 || platform.quitRequested()) return 0;
      if ((i & 0x1f) === 0) await input.delayTicks(1);
      if (path[i] === 0) break;
    }
    this.pathPos = i + 1;
    return i + 1;
  }

  /**
   * 830e: 21 pages. Per page: the picture set and frame, where it goes, the text margins and
   * start, and a kind: 1 also the scroll-shaped background (TEXT.16), 2 a second frame dissolves
   * in afterwards, 3 the moongate page with fixed text, 4-6 an extra frame below. The text is in
   * STORY.DAT. A key turns the page.
   */
  async introStory() {
    map.id = M.TITLE;
    const font = loadBitmap(pictures.name(P.STORY_FONT));
    this.drawStoryText('', font);
    video.setDrawPage(1);
    tw.putChar(0xff);
    video.setDrawPage(0);
    tw.putChar(0xff);
    tw.setCursor(10, 0);
    const background = loadPicture(pictures.name(P.STORY_BACKGROUND));
    let picture = loadPicture(pictures.story(0));
    let set = 0;
    for (let page = 0; page <= 0x14 && !platform.quitRequested(); page++) {
      const pg = this.storyPages[page];
      if (pg.set !== set) {
        dosFreeMem(picture);
        set = pg.set;
        picture = loadPicture(pictures.story(set));
      }
      const kind = pg.kind;
      video.setDrawPage(1);
      tw.putChar(0xff);
      if (kind === 1) {
        if (page === 0) {
          drawPictureFrame(0, 0x1e, 0xe0, 0, background);
          drawPictureFrame(0, 0x3a, 0xa8, 1, background);
        } else if (page === 7) {
          drawPictureFrame(0, 0x1a, 0xe8, 0, background);
          drawPictureFrame(0, 0x36, 200, 2, background);
        } else if (page === 0x0e) {
          drawPictureFrame(0, 0, 0xb8, 0, background);
          drawPictureFrame(0, 0, 0xf8, 3, background);
        }
      }
      const py = pg.py, px = pg.px;
      drawPictureFrame(0, py, px, pg.frame, picture);
      if (kind > 3) drawPictureFrame(0, py + 0x37, px, kind * 2 - 5, picture);
      this.storyLeft = [pg.left[0], pg.left[1]];
      this.storyRight = [pg.right[0], pg.right[1]];
      this.storyLineMin = pg.lineMin;
      this.storyLineMax = pg.lineMax;
      const x = pg.x;
      this.storyY = pg.y;
      this.storyX = x;
      let text;
      if (kind === 3) {
        drawPictureFrame(0, 0x27, 0x60, 3, picture);
        this.drawStoryText(strings.get(S.Instantly_a_shimmering_2F31), font);
        this.storyY = 0xb4;
        this.storyX = x;
        text = strings.get(S.With_heart_beating_2F5F);
      } else {
        loadFilePart(pg.text, 2000, textBuffer.data, strings.get(S.STORY_DAT_2F8D));
        text = textBuffer.data;
      }
      this.drawStoryText(text, font);
      if (page !== 0) {
        input.flushKeyboard();
        await this.waitAnyKey();
      }
      copyPage(0, 1);
      if (kind === 2) {
        video.setDrawPage(1);
        drawPictureFrame(0, 0x56, 0x28, 2, picture);
        await copyBackRect(0x78, 0x4b, 0x56, 0x28);
      }
    }
    dosFreeMem(picture);
    dosFreeMem(background);
    dosFreeMem2(font);
    input.flushKeyboard();
    await this.waitAnyKey();
    video.setDrawPage(1);
    tw.putChar(0xff);
    video.setDrawPage(0);
  }

  /** 85fe: a label on the bottom frame line. */
  printCentered(text) {
    const len = text.length, col = 0x12 - (len >> 1);
    gfx.setDrawColor(gfx.colorFrame);
    gfx.fillRect(199, col * 8, 0xc1, 8);
    const right = (len + col + 2) * 8;
    gfx.fillRect(199, 0x137, 0xc1, right);
    gfx.setDrawColor(gfx.colorText);
    gfx.drawLine(0xc0, col * 8, 0xc0, 8);
    gfx.drawLine(0xc0, 0x137, 0xc0, right);
    tw.setCursor(0x18, col);
    status.drawLabelLeft();
    tw.printText(text);
    status.drawLabelRight();
  }

  /** 86a0: the frame around the menu (rows 15-24), in frame-piece glyphs 0x7B-0x7F. */
  drawMenuBorder() {
    tw.setTextColor(gfx.colorFrame);
    tw.setCursor(0x0f, 0);
    tw.putChar(0x7b);
    for (let i = 0; i < 0x26; i++) tw.putChar(0x7f);
    tw.putChar(0x7c);
    for (let i = 0; i < 8; i++) {
      tw.putChar(0x7f);
      tw.setCursor(tw.getCursorRow(), 0x27);
      tw.putChar(0x7f);
    }
    tw.putChar(0x7d);
    for (let i = 0; i < 0x26; i++) tw.putChar(0x7f);
    tw.autoAdvance = 0; // the last cell, without scrolling the screen
    tw.putChar(0x7e);
    tw.autoAdvance = 1;
    gfx.setDrawColor(gfx.colorText);
    gfx.drawLine(0x7f, 0x138, 0x7f, 7);
    gfx.drawLineB(0xc0, 0x138);
    gfx.drawLineB(0xc0, 7);
    gfx.drawLineB(0x7f, 7);
    tw.setTextColor(gfx.colorText);
  }

  /**
   * 8770: the "Ultima V" logo (ULTIMA.16 frame 0) on the top 100 rows and the animated banner
   * below it. quick != 0 (the full sequence): the logo dissolves in and "Warriors of Destiny" is
   * revealed.
   */
  async showTitleScreen(quick) {
    if (map.id !== M.TITLE) map.id = M.TITLE;
    this.titlePicture = loadPicture(pictures.name(P.LOGO));
    video.setDrawPage(0);
    tw.putChar(0xff);
    video.setDrawPage(1);
    drawPictureFrame(0, 0, 0, 0, this.titlePicture);
    if (quick !== 0) {
      await copyBackRect(100, 0x13f, 0, 0);
      quick = input.pollKey() === 0 ? 1 : 0;
    }
    if (quick === 0) copyPageRect(100, 0x13f, 0, 0, 0, 1);
    this.drawMenuBanner();
    dosFreeMem(this.titlePicture);
    if (quick !== 0) {
      const wd = loadBitmap(strings.get(S.WD_BIT_3105));
      await revealStrips(wd);
      dosFreeMem2(wd);
    }
    video.setDrawPage(0);
    await waitRevealStrips();
    this.drawMenuBorder();
  }

  /** 8836 */
  drawMenuItem(text, col, row, selected) {
    if (row === selected) tw.putChar(0xfd);
    tw.setCursor(row + 0x11, col);
    tw.putChar(0x20);
    tw.printText(text);
    tw.putChar(0x20);
    if (row === selected) tw.putChar(0xfd);
  }

  /** 887c */
  drawMainMenu(selected) {
    this.drawMenuItem(strings.get(S.Journey_Onward_310C), 0x0c, 0, selected);
    this.drawMenuItem(strings.get(S.Create_New_Character_311B), 9, 1, selected);
    this.drawMenuItem(strings.get(S.Transfer_from_Ultima_IV_3130), 8, 2, selected);
    this.drawMenuItem(strings.get(S.Ultima_V_Introduction_3148), 9, 3, selected);
    this.drawMenuItem(strings.get(S.Acknowledgements_315E), 0x0b, 4, selected);
    this.drawMenuItem(strings.get(S.Return_to_the_View_316F), 0x0a, 5, selected);
  }

  /**
   * 88ee: Acknowledgements: a scroll (STARTSC.16) unrolls from the middle of the screen to show
   * the credits (frame 1), waits for a key, and rolls up again.
   */
  async menuScrollEffect() {
    const picture = loadPicture(pictures.name(P.START_SCROLL));
    video.setDrawPage(1);
    drawPictureFrame(0, 0x3f, 0x10, 1, picture);
    video.setDrawPage(0);
    for (let y = 199; y > 0x3e; y--) { // the two rollers rise
      drawPictureFrame(0, y, 0x90, 0, picture);
      drawPictureFrame(0, y, 0xa0, 2, picture);
      if ((y & 7) === 0) await input.delayTicks(1); // port: the original isn't paced here
    }
    for (let i = 0; i < 0x90; i += 8) { // and part, uncovering the text
      drawPictureFrame(0, 0x3f, 0x88 - i, 0, picture);
      copyPageRect(199, 0x9f - i, 0x3f, 0x98 - i, 0, 1);
      drawPictureFrame(0, 0x3f, i + 0xa8, 2, picture);
      copyPageRect(199, i + 0xa7, 0x3f, i + 0xa0, 0, 1);
      await input.delayTicks(1);
    }
    this.titlePicture = loadPicture(pictures.name(P.LOGO));
    video.setDrawPage(1);
    tw.putChar(0xff);
    drawPictureFrame(0, 0x41, 0x10, 1, this.titlePicture);
    dosFreeMem(this.titlePicture);
    this.drawMenuBorder();
    this.drawMainMenu(4);
    await this.waitAnyKey();
    video.setDrawPage(0);
    for (let i = 0x88; i >= 0; i -= 8) { // close over the menu waiting in the back page
      drawPictureFrame(0, 0x3f, 0x90 - i, 0, picture);
      copyPageRect(199, 0x8f - i, 0x3f, 0x88 - i, 0, 1);
      drawPictureFrame(0, 0x3f, i + 0xa0, 2, picture);
      copyPageRect(199, i + 0xb7, 0x3f, i + 0xb0, 0, 1);
      await input.delayTicks(1);
    }
    for (let y = 0x3f; y < 199; y++) { // the rollers sink
      drawPictureFrame(0, y + 1, 0x90, 0, picture);
      drawPictureFrame(0, y + 1, 0xa0, 2, picture);
      copyPageRect(y, 0xaf, y, 0x90, 0, 1);
      if ((y & 7) === 0) await input.delayTicks(1);
    }
    dosFreeMem(picture);
    copyPageRect(199, 0xaf, 199, 0x90, 0, 1);
    this.drawMenuBanner();
    video.setDrawPage(0);
    input.flushKeyboard();
  }

  /** 8b0e */
  async waitKeyOrTicks(ticks) {
    for (let i = 0; i < ticks; i++) {
      const k = input.pollKey();
      if (k !== 0) return k;
      if (platform.quitRequested()) return 0x1b;
      await input.delayTicks(1);
    }
    return 0;
  }

  /** "Ultima" grows, "Lord British presents" with his signature traced, then the title screen. */
  async titleSequence() {
    const title = loadBitmap(pictures.name(P.TITLE_BITMAP));
    const british = loadBitmap(pictures.name(P.BRITISH_BITMAP));
    // BRITISH.PTH, the signature's path (the original reads it over the saved game's place).
    this.signaturePath.fill(0);
    loadFilePart(0, PATH_SIZE, this.signaturePath, strings.get(S.BRITISH_PTH_31B5));
    let go = (await showTitlePicture(title)) === 0;
    video.setDrawPage(1);
    gfx.fillRect(199, 0x13f, 0x8c, 0);
    drawFontGlyph(0x8c, 0x6c, 7, title);
    copyPageRect(199, 0x13f, 0x8c, 0, 0, 1);
    if (go) {
      await input.delayTicks(0x12);
      go = (await this.waitKeyOrTicks(0x14)) === 0;
    }
    if (go) {
      tw.putChar(0xff);
      drawFontGlyph(0, 0x98, 8, title);
      copyPage(0, 1);
      go = (await this.waitKeyOrTicks(0x14)) === 0;
      if (go) {
        video.setDrawPage(0);
        this.pathPos = 0;
        go = false;
        if ((await this.introTracePath(0x44, 0x2c)) && (await this.introTracePath(0x5e, 0x40)) && (await this.introTracePath(0x4e, 0x8f)))
          go = (await this.introTracePath(0x69, 0xa7)) !== 0;
        video.setDrawPage(1);
      }
      drawFontGlyph(0x42, 0x18, 0, british);
      copyPage(0, 1);
      drawFontGlyph(0xa0, 0x68, 9, title);
      copyPage(0, 1);
      if (go) go = (await this.waitKeyOrTicks(0x14)) === 0;
    }
    dosFreeMem2(british);
    dosFreeMem2(title);
    map.id = M.TITLE;
    tw.putChar(0xff);
    video.setDrawPage(0);
    return go ? 1 : 0;
  }

  // ---- Transfer from Ultima IV (INTRO 91d6-a24f) ----

  u4w(off) {
    return this.u4Character[off] | (this.u4Character[off + 1] << 8);
  }

  /**
   * 91d6: Ultima IV's PARTY.SAV: 8 bytes of counters, eight 39-byte characters, then from 0x140
   * food, gold and the eight virtue scores as words (at 0x146), where 0 means partial Avatarhood -
   * all eight make an Avatar. Only the first character comes over. Attributes above 70, points
   * above 9999, a class above 7 or control characters in the name are "bad data". 1 = failed.
   */
  async readUltima4Party() {
    let bad = 0;
    this.u4Character.fill(0);
    loadFilePart(8, 0x28, this.u4Character, strings.get(S.party_sav_3278));
    const c = this.u4Character;
    if (this.u4w(6) > 0x46 || this.u4w(8) > 0x46 || this.u4w(10) > 0x46 || this.u4w(4) > 0x270f || this.u4w(0) > 0x270f || this.u4w(2) > 0x270f || c[0x25] > 7) bad = 1;
    for (let i = 0; i < 8; i++) if (c[0x14 + i] !== 0 && c[0x14 + i] < 0x20) bad = 1;
    if (bad) {
      tw.putChar(0xff);
      tw.putChar(0xfc);
      tw.setCursor(5, 0);
      tw.printText(strings.get(S.Error_Your_Ultima_IV_3282));
      tw.printText(strings.get(S.Unable_to_continue_32B4));
      tw.printText(strings.get(S.Press_any_key_to_return_32D4));
      tw.putChar(0xfb);
      await input.waitKeyTimeout(0);
      return 1;
    }
    const m = party.member(0);
    let name = '';
    for (let n = 0; n < 8 && c[0x14 + n] !== 0; n++) name += String.fromCharCode(c[0x14 + n]);
    writeName(m, name);
    m.sex = c[0x24] === 0x0b ? 0x0b : 0x0c;
    m.cls = 'MBFDTPRS'[c[0x25]];
    m.status = 'G';
    m.str = c[6];
    m.dex = c[8];
    m.intel = c[10];
    m.mp = c[0x0c];
    m.hp = this.u4w(0);
    m.maxHp = this.u4w(2);
    m.xp = this.u4w(4);
    m.level = Math.trunc(this.u4w(2) / 100);
    const rest = new Uint8Array(0xb6).fill(0xff);
    loadFilePart(0x140, 0xb6, rest, strings.get(S.party_sav_32F9));
    let virtues = 0;
    for (let i = 0; i < 8; i++) virtues |= rest[6 + i * 2] | rest[7 + i * 2];
    if (virtues === 0) this.u4IsAvatar = 1;
    return 0;
  }

  /** 9438 */
  printUltima4Class() {
    const names = [S.Mage_3306, S.Bard_330C, S.Fighter_3312, S.Druid_331B, S.Tinker_3322, S.Paladin_332A, S.Ranger_3333, S.Shepherd_333B];
    const i = 'MBFDTPRS'.indexOf(party.member(0).cls);
    if (i >= 0) tw.printText(strings.get(names[i]));
  }

  /** 94aa: Ultima IV's attributes go to 50, Ultima V's to 30. */
  convertUltima4Stat(stat) {
    if (stat <= 9) return stat;
    if (stat < 0x1e) return ((stat - 9) >> 1) + 10;
    return ((stat - 0x1e) >> 2) + 0x14;
  }

  /** 9fe2: the row labels, in both panels. */
  printTransferLabel(row) {
    for (let w = 0; w < 2; w++) {
      tw.selectTextWindow(w);
      tw.setCursor(this.transferLabelRows[row], 3);
      tw.printText(strings.get(this.transferLabels[row]));
    }
  }

  /** a022 */
  drawTransferFrame() {
    tw.setTextColor(gfx.colorFrame);
    tw.setCursor(0x13, 0);
    tw.putChar(0x7b);
    for (let i = 0x26; i !== 0; i--) tw.putChar(0x7f);
    tw.putChar(0x7c);
    for (let i = 3; i !== 0; i--) {
      tw.putChar(0x7f);
      tw.setCursor(tw.getCursorRow(), 0x27);
      tw.putChar(0x7f);
    }
    tw.putChar(0x7d);
    for (let i = 0x26; i !== 0; i--) tw.putChar(0x7f);
    tw.putChar(0x7e);
    gfx.setDrawColor(gfx.colorText);
    gfx.drawLine(0x9f, 0x138, 0x9f, 7);
    gfx.drawLineB(0xb8, 0x138);
    gfx.drawLineB(0xb8, 7);
    gfx.drawLineB(0x9f, 7);
    tw.setTextColor(gfx.colorText);
  }

  /** a0e6: one of the two panels, titled " Ultima IV " - both: the right one is corrected later. */
  drawTransferPanel(x) {
    gfx.setDrawColor(gfx.colorFrame);
    gfx.fillRect(0x8f, x + 6, 0, x);
    gfx.fillRect(0x89, x + 0x97, 0, x + 0x8f);
    gfx.fillRect(0x8f, x + 0x96, 0x89, x + 7);
    tw.setTextColor(gfx.colorFrame);
    tw.setCursor(0, 0);
    tw.printText(strings.get(S.X7B_Block_Block_3676));
    status.drawLabelLeft();
    tw.setTextColor(gfx.colorText);
    tw.printText(strings.get(S.Ultima_IV_6D3A));
    tw.setTextColor(gfx.colorFrame);
    status.drawLabelRight();
    tw.printText(strings.get(S.Block_Block_367A));
    tw.putChar(0x7c);
    tw.setCursor(0x11, 0);
    tw.putChar(0x7d);
    tw.setCursor(0x11, 0x12);
    tw.putChar(0x7e);
    gfx.setDrawColor(gfx.colorText);
    gfx.drawLine(7, x + 7, 7, x + 0x18);
    gfx.drawLineB(0x88, x + 7);
    gfx.drawLineB(0x88, x + 0x8f);
    gfx.drawLineB(7, x + 0x8f);
    gfx.drawLineB(7, x + 0x80);
    tw.setTextColor(gfx.colorText);
  }

  /** a1e4 */
  drawTransferScreen() {
    this.drawTransferFrame();
    tw.defineTextWindow(0x12, 0x13, 0, 0, 0);
    tw.defineTextWindow(0x12, 0x27, 0, 0x15, 1);
    tw.defineTextWindow(0x15, 0x25, 0x15, 3, 2);
    tw.selectTextWindow(0);
    this.drawTransferPanel(0);
    tw.selectTextWindow(1);
    this.drawTransferPanel(0xa8);
    tw.setCursor(0, 0x0c);
    tw.putChar(0x20); // "Ultima IV" -> "Ultima V"
  }

  async transferYesNo() {
    for (;;) {
      const c = toUpper((await input.waitKeyTimeout(0)) & 0xff);
      if (c === 0x59 || c === 0x4e) return c;
      if (platform.quitRequested()) return 0x59;
    }
  }

  /** Moves the highlight (0xFD toggles inverse) from one row label to the next in both panels. */
  transferMark(row, col, text, on) {
    for (let w = 0; w < 2; w++) {
      tw.selectTextWindow(w);
      tw.setCursor(row, col);
      if (on) tw.putChar(0xfd);
      tw.printText(strings.get(text));
      if (on) tw.putChar(0xfd);
    }
  }

  /**
   * 94ea: a new game is made from INIT.GAM with the Ultima IV hero in place of the first member.
   * The left panel shows the old values, the right one the new as each is converted: the name and
   * the sex may be changed; a full Avatar keeps the title, anyone else keeps the class; experience
   * is divided by 10 and the level follows from it (30 hit points a level); strength (at least
   * 20), dexterity and intelligence are scaled down; magic points equal intelligence. The original
   * asks for the Ultima IV player disk; the port looks for PARTY.SAV among the game's files.
   */
  async transferFromUltima4() {
    const ool = new Uint8Array(0x200);
    const m = party.member(0);
    const loc = map.id === M.DEMO ? M.TITLE_MENU : map.id;
    map.id = loc;
    loadGameFile(strings.get(S.INIT_GAM_3345));
    loadFilePart(0, 0x100, ool.subarray(0x100), strings.get(S.INIT_OOL_334E));
    tw.defineTextWindow(0x18, 0x27, 0, 0, 0);
    tw.selectTextWindow(0);
    tw.putChar(0xff);
    while (!files.get(strings.get(S.party_sav_3278))) {
      tw.putChar(0xff);
      tw.setCursor(8, 3);
      tw.printText(strings.get(S.Transfer_Character_from_3357));
      tw.setCursor(11, 0);
      tw.printText(strings.get(S.Please_insert_the_Ultima_3379));
      tw.setCursor(13, 1);
      tw.printText('(PARTY.SAV, with the game\'s files)');
      tw.setCursor(15, 4);
      tw.printText('and press a key');
      tw.setCursor(17, 4);
      tw.printText(strings.get(S.or_press_Esc_to_abort_33B8));
      if (toUpper((await input.waitKeyTimeout(0)) & 0xff) === 0x1b || platform.quitRequested()) return;
    }
    this.u4IsAvatar = 0;
    if ((await this.readUltima4Party()) !== 0) return;
    if (this.u4IsAvatar !== 0) m.cls = 'A';
    tw.putChar(0xff);
    tw.setCursor(0x0b, 0);
    tw.putChar(0xfc);
    tw.printText(strings.get(S.Found_33D9));
    tw.setCursor(0x0c, 0);
    tw.printText(m.name);
    tw.putChar(0xfb);
    tw.setCursor(0x0d, 0x0c);
    tw.printText(strings.get(S.a_level_33E1));
    tw.printNumber(' ', 1, m.level);
    tw.printText(strings.get(m.sex === 0x0b ? S.Male_33EA : S.Female_33F1));
    this.printUltima4Class();
    tw.setCursor(0x0f, 0x11);
    tw.printText(strings.get(S.STR_33FA));
    tw.printNumber(' ', 1, m.str);
    tw.setCursor(0x10, 0x11);
    tw.printText(strings.get(S.DEX_3401));
    tw.printNumber(' ', 1, m.dex);
    tw.setCursor(0x11, 0x11);
    tw.printText(strings.get(S.INT_3408));
    tw.printNumber(' ', 1, m.intel);
    tw.setCursor(0x14, 10);
    tw.printText(m.name);
    tw.printText(strings.get(S.is_340F));
    tw.printText(strings.get(this.u4IsAvatar ? S.an_Avatar_3414 : S.not_an_Avatar_341F));
    await input.waitKeyTimeout(0);

    tw.putChar(0xff);
    this.drawTransferScreen();
    for (let i = 0; i < 8; i++) this.printTransferLabel(i);
    tw.selectTextWindow(0);
    tw.setCursor(3, 0);
    tw.putChar(0xfc);
    tw.printText(m.name);
    tw.putChar(0xfb);
    tw.setCursor(5, 10);
    tw.printText(strings.get(m.sex === 0x0b ? S.Male_342D : S.Female_3432));
    tw.setCursor(6, 10);
    if (this.u4IsAvatar) tw.printText(strings.get(S.Avatar_3439));
    else this.printUltima4Class();
    tw.setCursor(8, 10);
    tw.printNumber(' ', 1, (m.xp << 16) >> 16);
    tw.setCursor(9, 10);
    tw.printNumber(' ', 1, m.level);
    tw.setCursor(0x0b, 10);
    tw.printNumber(' ', 1, m.str);
    tw.setCursor(0x0c, 10);
    tw.printNumber(' ', 1, m.dex);
    tw.setCursor(0x0d, 10);
    tw.printNumber(' ', 1, m.intel);
    tw.setCursor(0x0f, 0);
    tw.putChar(0xfc);
    tw.printText(strings.get(this.u4IsAvatar ? S.Avatar_3440 : S.Non_Avatar_3447));
    tw.putChar(0xfb);

    // the name
    this.transferMark(2, 7, S.Name_3452, 1);
    tw.selectTextWindow(2);
    tw.putChar(0xff);
    tw.setCursor(0, 10);
    tw.printText(strings.get(S.Keep_this_name_345E));
    let c = await this.transferYesNo();
    tw.putChar(0xff);
    if (c === 0x4e)
      do {
        tw.setCursor(0, 1);
        tw.printText(strings.get(S.Enter_new_name_346E));
        writeName(m, await input.readName(8));
      } while (m.name === '' && !platform.quitRequested());
    tw.selectTextWindow(1);
    tw.setCursor(3, 0);
    tw.putChar(0xfc);
    tw.printText(m.name);
    tw.putChar(0xfb);
    this.transferMark(2, 7, S.Name_347F, 0);

    // the sex
    this.transferMark(5, 5, S.Sex_3485, 1);
    tw.selectTextWindow(2);
    tw.putChar(0xff);
    tw.putChar(0xfc);
    tw.printText(strings.get(S.Keep_same_sex_3495));
    tw.putChar(0xfb);
    c = await this.transferYesNo();
    tw.selectTextWindow(1);
    tw.setCursor(5, 10);
    if ((c === 0x59 && m.sex === 0x0b) || (c === 0x4e && m.sex === 0x0c)) {
      tw.printText(strings.get(S.Male_34A4));
      m.sex = 0x0b;
    } else {
      tw.printText(strings.get(S.Female_34A9));
      m.sex = 0x0c;
    }
    this.transferMark(5, 5, S.Sex_34B0, 0);

    // the class
    this.transferMark(6, 3, S.Class_34B5, 1);
    tw.selectTextWindow(1);
    tw.setCursor(6, 10);
    if (this.u4IsAvatar) tw.printText(strings.get(S.Avatar_34BC));
    else this.printUltima4Class();
    tw.selectTextWindow(2);
    tw.putChar(0xff);
    tw.setCursor(0, 2);
    tw.printText(strings.get(this.u4IsAvatar ? S.Thou_art_now_an_Avatar_34CF : S.Class_remains_intact_34E7));
    await input.waitKeyTimeout(0);
    this.transferMark(6, 3, S.Class_34FC, 0);

    // experience
    this.transferMark(8, 5, S.Exp_3503, 1);
    tw.selectTextWindow(1);
    tw.setCursor(8, 10);
    m.xp = Math.trunc(((m.xp << 16) >> 16) / 10);
    tw.printNumber(' ', 1, (m.xp << 16) >> 16);
    tw.selectTextWindow(2);
    tw.putChar(0xff);
    tw.putChar(0xfc);
    tw.printText(strings.get(S.Experience_has_been_3514));
    tw.putChar(0xfb);
    await input.waitKeyTimeout(0);
    this.transferMark(8, 5, S.Exp_3532, 0);

    // level
    this.transferMark(9, 3, S.Level_3537, 1);
    tw.selectTextWindow(1);
    tw.setCursor(9, 10);
    let level = 1;
    for (let n = Math.trunc(((m.xp << 16) >> 16) / 100); n > 0; n >>= 1) level++;
    m.level = level;
    m.hp = m.maxHp = level * 0x1e;
    tw.printNumber(' ', 1, m.level);
    tw.selectTextWindow(2);
    tw.putChar(0xff);
    tw.putChar(0xfc);
    tw.printText(strings.get(S.Level_has_been_converted_354A));
    tw.putChar(0xfb);
    await input.waitKeyTimeout(0);
    this.transferMark(9, 3, S.Level_3563, 0);

    // the three attributes
    const attr = [
      { row: 0x0b, key: 'str', label: S.STR_356A, was: S.Strength_was_357B, now: S.N50_now_358A, end: S.N30_3595 },
      { row: 0x0c, key: 'dex', label: S.DEX_359F, was: S.Dexterity_was_35AE, now: S.N50_now_35BE, end: S.N30_35C9 },
      { row: 0x0d, key: 'intel', label: S.INT_35D3, was: S.Intellect_was_35E2, now: S.N50_now_35F2, end: S.N30_35FD },
    ];
    for (let i = 0; i < 3; i++) {
      const a = attr[i];
      const old = m[a.key];
      this.transferMark(a.row, 5, a.label, 1);
      tw.selectTextWindow(1);
      tw.setCursor(a.row, 10);
      m[a.key] = this.convertUltima4Stat(old);
      if (i === 0 && m.str < 0x14) m.str = 0x14;
      if (i === 2) m.mp = m.intel;
      tw.printNumber(' ', 1, m[a.key]);
      tw.selectTextWindow(2);
      tw.putChar(0xff);
      tw.setCursor(0, 1);
      tw.printText(strings.get(a.was));
      tw.printNumber(' ', 1, old);
      tw.printText(strings.get(a.now));
      tw.printNumber(' ', 1, m[a.key]);
      tw.printText(strings.get(a.end));
      await input.waitKeyTimeout(0);
      this.transferMark(a.row, 5, a.label, 0);
    }
    tw.selectTextWindow(1);
    tw.setCursor(0x0f, 0);
    tw.putChar(0xfc);
    tw.printText(strings.get(this.u4IsAvatar ? S.Avatar_360C : S.Non_Avatar_3613));
    tw.putChar(0xfb);
    tw.selectTextWindow(2);
    tw.defineTextWindow(0x16, 0x25, 0x15, 2, 2);
    tw.putChar(0xff);
    tw.printText(strings.get(S.Conversion_complete_361E));
    saveFilePart(0x200, ool, strings.get(S.SAVED_OOL_3641)); // no Britannia objects, INIT.OOL for the Underworld
    saveGameFile(strings.get(S.SAVED_GAM_364B));
    map.id = loc;
  }

  /** Loads SAVED.GAM and splits SAVED.OOL into BRIT.OOL and UNDER.OOL. 0 if there is no character. */
  async journeyOnward() {
    gfx.drawScreenFrame();
    setWindDirection(0);
    tw.selectTextWindow(2);
    tw.setCursor(0x0c, 0);
    if (map.id === M.TITLE) {
      tiles.loadTileset(pictures.name(P.TILES));
      map.id = M.TITLE_MENU;
    }
    loadGameFile(strings.get(S.SAVED_GAM_31E6));
    if (party.member(0).name !== '') {
      const ool = new Uint8Array(0x200);
      loadFilePart(0, 0x200, ool, strings.get(S.SAVED_OOL_323F));
      saveFilePart(0x100, ool, strings.get(S.BRIT_OOL_3249));
      saveFilePart(0x100, ool.subarray(0x100), strings.get(S.UNDER_OOL_3252));
      setWindDirection(-1);
      tiles.originY = 8;
      return 1;
    }
    tw.printText(strings.get(S.No_active_game_31F0));
    tw.printText(strings.get(S.Please_create_a_3203));
    tw.printText(strings.get(S.or_transfer_one_from_321E));
    await input.waitKeyTimeout(0);
    tw.selectTextWindow(0);
    tw.putChar(0xff);
    video.setDrawPage(1);
    tw.putChar(0xff);
    video.setDrawPage(0);
    await this.showTitleScreen(0);
    return 0;
  }

  async backToTitle() {
    tw.defineTextWindow(0x18, 0x27, 0, 0, 0);
    tw.selectTextWindow(0);
    tw.putChar(0xff);
    video.setDrawPage(1);
    tw.putChar(0xff);
    await this.showTitleScreen(0);
    this.drawMenuBanner();
    video.setDrawPage(0);
  }

  /**
   * 8b46: the title sequence, then the menu. Returns 1 once "Journey Onward" has loaded the saved
   * game, 0 if the page was closed. skipTitle: start at the menu. The menu waits about 200 cursor
   * blinks, then starts the demo by itself.
   */
  async introMain(skipTitle) {
    const keys = 'JCTUAR';
    sound.enabled = 1;
    view.resetTileAnimMap();
    gfx.videoStart();
    allocBackPage();
    tw.selectFont(0);
    tw.defineTextWindow(0x18, 0x27, 0, 0, 0);
    tw.selectTextWindow(0);
    let go = 0;
    this.mouseMode = 'skip';
    if (!skipTitle) go = await this.titleSequence();
    else map.id = M.TITLE;
    if (platform.quitRequested()) return 0;
    await this.showTitleScreen(go);
    if (go) await this.attractDemo();
    this.mouseMode = null;
    setRandomSeed(timeSeed());
    for (;;) {
      if (platform.quitRequested()) return 0;
      tw.defineTextWindow(0x17, 0x26, 0x10, 1, 0);
      tw.selectTextWindow(0);
      tw.putChar(0xff);
      tw.defineTextWindow(0x18, 0x27, 0, 0, 0);
      tw.defineTextWindow(9, 0x27, 1, 0x18, 1);
      tw.defineTextWindow(0x17, 0x27, 0x0b, 0x18, 2);
      let selected = 0, choice;
      this.printCentered(strings.get(S.Copyright_1988_Lord_31C1));
      this.drawMainMenu(0);
      this.mouseMode = 'menu';
      do {
        tw.setCursor(0x0f, 0x0f);
        status.drawLabelLeft();
        tw.printText(strings.get(S.Select_31DD));
        status.drawLabelRight();
        tw.setCursor(0x0f, 0x17);
        let k = 0;
        for (let i = 0; i < 200 && k === 0; i++) {
          k = toUpper((await input.waitKeyCursor()) & 0xff);
          if (k === 0) await waitRevealStrips();
          if (platform.quitRequested()) return 0;
        }
        choice = 0;
        switch (k) {
          case 0: choice = 0x52; break; // idle: the demo
          case 0x0d: case 0x20: choice = keys.charCodeAt(selected); break;
          case 1: case 3:
            if (--selected < 0) selected = 5;
            this.drawMainMenu(selected);
            break;
          case 2: case 4:
            if (++selected > 5) selected = 0;
            this.drawMainMenu(selected);
            break;
          case 0x4a: case 0x43: case 0x54: case 0x55: case 0x41: case 0x52:
            selected = keys.indexOf(String.fromCharCode(k));
            this.drawMainMenu(selected);
            choice = k;
            break;
        }
      } while (choice < 0x21);
      this.mouseMode = choice === 0x41 || choice === 0x52 || choice === 0x55 ? 'skip' : null;
      switch (choice) {
        case 0x41: // A
          if (map.id !== M.TITLE) map.id = M.TITLE;
          await this.menuScrollEffect();
          break;
        case 0x43: // C
          await this.createCharacter();
          await this.backToTitle();
          break;
        case 0x4a: // J
          if (await this.journeyOnward()) return 1;
          break;
        case 0x52: // R
          await this.attractDemo();
          break;
        case 0x54: // T
          tw.putChar(0xff);
          await this.transferFromUltima4();
          await this.backToTitle();
          break;
        case 0x55: // U
          await this.introStory();
          await this.showTitleScreen(0);
          break;
      }
      this.mouseMode = null;
    }
  }

  // ---- FONT.OVL: story text, the demo, character creation ----

  /**
   * e1e0: text with the proportional font (PROPORT.PCS) into the back page at storyX / storyY,
   * word-wrapped and justified between two pairs of margins: lines whose y lies between
   * storyLineMin and storyLineMax use the second pair. '_' marks where a word may be hyphenated
   * and '{' leaves a 15-pixel gap; a line is 9 pixels.
   */
  drawStoryText(textIn, font) {
    const text = bytesOf(textIn);
    const t = (i) => (i >= 0 && i < text.length ? text[i] : 0);
    const s16 = (v) => ((v & 0xffff) << 16) >> 16;
    video.setDrawPage(1);
    let alt = s16(this.storyLineMin) < s16(this.storyY) && s16(this.storyY) < s16(this.storyLineMax) ? 1 : 0;
    let width = s16(this.storyRight[alt] - this.storyLeft[alt]);
    let pos = 0;
    let used = s16(this.storyX - this.storyLeft[alt]);
    const space = s16(this.storySpaceWidth), hyphen = this.glyphWidths[0x2d];
    while (t(pos) !== 0) {
      let spaces = 0, i = pos;
      for (; t(i) !== 0 && used < width && t(i) !== 0x0a; i++) { // measure
        const c = t(i);
        if (c < 0x21) { used += space; spaces++; }
        else if (c === 0x7b) used += 0x0f;
        else if (c !== 0x5f) used += this.glyphW(c);
      }
      for (;;) { // back up to where the line can break
        if ((t(i) === 0 && used < width) || t(i) === 0x0a) break;
        if (--i <= pos) break;
        if (t(i) === 0x20) {
          used -= space;
          spaces--;
          break;
        }
        if (t(i) === 0x5f && hyphen + used + 1 < width) {
          used += hyphen + 1;
          break;
        }
        if (t(i) !== 0x5f && t(i) !== 0x7b) used -= this.glyphW(t(i));
      }
      let slack = width - used;
      if (pos < i) {
        const end = t(i);
        do {
          const c = t(pos);
          if (c < 0x21) {
            this.storyX = (this.storyX + space) & 0xffff;
            if (spaces !== 0 && end !== 0 && end !== 0x0a) { // justify
              const q = Math.trunc(slack / spaces);
              this.storyX = (this.storyX + q) & 0xffff;
              slack -= q;
              spaces--;
            }
          } else if (c === 0x7b) {
            this.storyX = (this.storyX + 0x0f) & 0xffff;
          } else if (c !== 0x5f) {
            if (s16(this.storyY) < 0xc0) drawFontGlyph(s16(this.storyY), s16(this.storyX), c - 0x20, font);
            this.storyX = (this.storyX + this.glyphW(c)) & 0xffff;
          }
        } while (++pos !== i);
      }
      pos = i;
      if (t(i) === 0) break;
      if (t(i) === 0x5f && s16(this.storyY) < 0xc0) drawFontGlyph(s16(this.storyY), s16(this.storyX), 0x0d, font);
      used = 0;
      this.storyY = (this.storyY + 9) & 0xffff;
      alt = s16(this.storyLineMin) < s16(this.storyY) && s16(this.storyY) < s16(this.storyLineMax) ? 1 : 0;
      this.storyX = this.storyLeft[alt];
      width = s16(this.storyRight[alt] - this.storyX);
      pos = i + 1;
    }
    video.setDrawPage(0);
  }

  // The demo uses map.buffer as three 4-row maps of 32 columns: [0] what is drawn (0 = an object,
  // its tile in [0x80]; 0xFE = don't draw), [0x100] the scenery underneath. It is drawn at view rows
  // 7-10, with the tile origin moved down 8 pixels.

  /** e482 */
  demoDrawCell(row, col) {
    const b = map.buffer, i = col + row * 0x20;
    let tile;
    if (b[i] === 0) {
      if (b[0x80 + i] === 0x16) return;
      tile = 0x100 + b[0x80 + i];
    } else {
      tile = view.tileAnimMap[b[i]];
    }
    tiles.drawTileAt(row + 7, col, tile);
  }

  /** e4dc: captions grow outward from the middle column, two columns every other step. 1 if a key was pressed. */
  async demoStep(frames) {
    const b = map.buffer;
    do {
      view.animateObjects();
      await waitRevealStrips();
      for (let o = 0; o < 32; o++) {
        const ob = map.objects.at(o);
        if (ob.tile === 0) continue;
        const i = (ob.y * 0x20 + ob.x) & 0x7f;
        b[i] = 0;
        b[0x80 + i] = ob.tile2;
      }
      for (let col = this.demoCaptionFirst; col <= this.demoCaptionLast; col++)
        for (let row = 0; row < 4; row++) if (b[col + row * 0x20] !== 0xfe) this.demoDrawCell(row, col);
      if (this.demoCaptionFirst !== 0 && this.demoCaptionBlink !== 0) {
        this.demoCaptionFirst--;
        this.demoCaptionLast++;
      }
      this.demoCaptionBlink = this.demoCaptionBlink === 0 ? 1 : 0;
      if (input.pollKey() !== 0 || platform.quitRequested()) return 1;
      if (frames !== 0) await input.delayTicks(1);
      if (this.demoCaptionMode === 2) { // the waterfall scene
        await sound.soundNoise(10000, 0x3c, 0x14);
      } else if (this.demoCaptionMode === 3) { // the clock scene: tick, tock
        if (++this.demoFrame > 7) this.demoFrame = 0;
        if (this.demoFrame === 0) await sound.beep(3, 3000);
        else if (this.demoFrame === 4) await sound.beep(3, 2000);
      }
    } while (--frames !== 0);
    return 0;
  }

  /** e5f8: scene n: its title at the bottom, its 4 x 19 map from the loaded data. */
  demoCaption(n) {
    this.printCentered(strings.get(this.demoCaptions[n & 3]));
    const base = n * 0x80;
    for (let col = 0; col < 0x13; col++)
      for (let row = 0; row < 4; row++) {
        const t = textBuffer.get(base + col + row * 0x20);
        map.buffer[col + row * 0x20] = t;
        map.buffer[0x100 + col + row * 0x20] = t;
      }
    this.demoCaptionFirst = this.demoCaptionLast = 9;
    this.demoCaptionBlink = 0;
    this.demoCaptionMode = n & 0xff;
  }

  /**
   * e684: the script is at offset 0x200 of the data read from MISCMAPS.DAT. Ops: 0 place object
   * (slot, tile, x, y); 1 remove object; 2 move object (slot, direction); 3 wait n steps; 4 a
   * moongate rises at (x, y); 5 it sets again; 6 next scene (caption n); 7 object dissolves in; 8
   * object dissolves out; 9 restart; 10 set tile (tile, x, y); 11 lightning strikes object; 12
   * clear objects; 13 move object and wait 7; 14 n / 15: repeat.
   */
  async attractDemo() {
    const sc = textBuffer.data, b = map.buffer;
    let gateX = 0, gateY = 0, loopPos = 0, loopCount = 0;
    tiles.originY = 0x10;
    this.demoCaptionFirst = this.demoCaptionLast = 9;
    this.demoCaptionBlink = 0;
    gfx.setDrawColor(gfx.colorFrame);
    gfx.fillRect(0x7e, 199, 0x78, 0x78);
    gfx.setDrawColor(gfx.colorText);
    gfx.drawLine(0x7f, 199, 0x7f, 0x78);
    if (map.id !== M.DEMO) {
      loadFilePart(0x2c0, 2000, textBuffer.data, strings.get(S.MISCMAPS_DAT_A044));
      if (map.id === M.TITLE) tiles.loadTileset(pictures.name(P.TILES));
    }
    map.id = M.DEMO;
    for (let pos = 0x200; pos < 2000; pos++) {
      let steps = -1;
      const o = map.objects.at(sc[pos + 1] & 31);
      switch (sc[pos]) {
        case 0:
          o.tile = o.tile2 = sc[pos + 2];
          o.x = sc[pos + 3];
          o.y = sc[pos + 4];
          o.flags = 0;
          pos += 4;
          break;
        case 1: {
          o.flags = o.tile2 = o.tile = 0;
          const i = (o.y * 0x20 + o.x) & 0x7f;
          b[i] = b[0x100 + i];
          pos += 1;
          break;
        }
        case 2: case 0x0d: {
          const dir = sc[pos + 2] & 3;
          const i = (o.y * 0x20 + o.x) & 0x7f;
          b[i] = b[0x100 + i];
          o.x = o.x + Dungeon.facingDx[dir];
          o.y = o.y + Dungeon.facingDy[dir];
          if (sc[pos] === 0x0d) steps = 7;
          pos += 2;
          break;
        }
        case 3:
          steps = sc[pos + 1];
          pos += 1;
          break;
        case 4: case 5: {
          const rising = sc[pos] === 4;
          if (rising) {
            gateX = sc[pos + 1];
            gateY = sc[pos + 2];
          }
          const i = (gateY * 0x20 + gateX) & 0x7f;
          b[0x100 + i] = b[i] = 0xfe;
          for (let f = rising ? 1 : 15; rising ? f < 0x10 : f > 0; f += rising ? 1 : -1) {
            tiles.shimmerTiles(gateY + 7, gateX, f, false);
            if (await this.demoStep(1)) return;
          }
          b[0x100 + i] = b[i] = rising ? 0xdc : 5;
          if (rising) pos += 2;
          steps = 2;
          break;
        }
        case 6:
          this.demoCaption(sc[pos + 1]);
          pos += 1;
          break;
        case 7: case 8: {
          const t = o.tile, ox = o.x, oy = o.y;
          o.tile = o.tile2 = 0x16; // hidden while it dissolves
          const tile = sc[pos] === 7 ? 0x100 + t : b[0x100 + ((ox + oy * 0x20) & 0x7f)];
          if (await dissolveTile(oy + 7, ox, tile)) return;
          pos += 1;
          o.tile = o.tile2 = t;
          break;
        }
        case 9:
          pos = 0x1ff;
          break;
        case 0x0a: {
          const i = (sc[pos + 3] * 0x20 + sc[pos + 2]) & 0x7f;
          b[0x100 + i] = b[i] = sc[pos + 1];
          pos += 3;
          break;
        }
        case 0x0b: { // lightning from the top of the scene, then the object vanishes
          for (let n = 0, dx = 0, dy = 0; n < 5; n++, dx += 9, dy += 3) {
            if (await this.demoStep(1)) return;
            gfx.setDrawColor(gfx.colorText);
            gfx.drawLine(dy + 0x9b, dx + 0x89, dy + 0x98, dx + 0x80);
            gfx.drawLine(dy + 0x9c, dx + 0x89, dy + 0x99, dx + 0x80);
          }
          const t = map.objects.at(sc[pos + 2] & 31);
          tiles.drawTileAt(t.y + 7, t.x, 0);
          await sound.soundNoise(4000, 0x4b0, 1);
          steps = 3;
          pos += 2;
          break;
        }
        case 0x0c:
          for (let n = 0; n < 32; n++) {
            const ob = map.objects.at(n);
            ob.flags = ob.tile = ob.tile2 = 0;
          }
          break;
        case 0x0e:
          loopPos = pos + 1;
          loopCount = sc[pos + 1];
          pos = loopPos;
          break;
        case 0x0f:
          loopCount = (loopCount - 1) >>> 0;
          if (loopCount !== 0) pos = loopPos;
          break;
      }
      if (steps >= 0 && (await this.demoStep(steps))) return;
      if (input.pollKey() !== 0 || platform.quitRequested()) return;
    }
  }

  /** eb78: a virtue not yet asked in this round and not yet beaten. */
  randomVirtue() {
    let v;
    do v = randomBetween(7, 0);
    while (this.virtueAsked[v] !== 0 || this.virtueBeaten[v] !== 0);
    this.virtueAsked[v] = 1;
    return v;
  }

  /**
   * eba8: two virtues' cards and the gypsy's question (QUESTION.DAT); the answer A or B picks one:
   * its bonus goes to INT / DEX / STR and the other is out.
   */
  async askVirtueQuestion(picture, font) {
    video.setDrawPage(1);
    tw.putChar(0xff);
    drawPictureFrame(0, 0, 0x10, 1, picture);
    drawPictureFrame(0, 0, 200, 1, picture);
    this.storyX = 0;
    this.storyY = 0x98;
    const a = this.randomVirtue(), b = this.randomVirtue();
    const left = a < b ? a : b, right = a < b ? b : a;
    const aKey = b < a ? 0x42 : 0x41; // the key that chooses a (A = the left card)
    drawPictureFrame(0, this.virtueCardY[left & 7], this.virtueCardX[left & 7], left + 2, picture);
    drawPictureFrame(0, this.virtueCardY[right & 7], this.virtueCardX[right & 7] + 0xb8, right + 2, picture);
    loadFilePart(this.questionOffsets[(a & 7) * 8 + (b & 7)], 2000, textBuffer.data, strings.get(S.QUESTION_DAT_A052));
    this.drawStoryText(textBuffer.data, font);
    copyPage(0, 1);
    let c;
    do {
      c = toUpper((await this.waitAnyKey()) & 0xff);
      if (platform.quitRequested()) c = 0x41;
    } while (c !== 0x41 && c !== 0x42);
    const winner = c === aKey ? a : b, loser = c === aKey ? b : a;
    this.newInt = (this.newInt + this.virtueInt[winner & 7]) & 0xff;
    this.newDex = (this.newDex + this.virtueDex[winner & 7]) & 0xff;
    this.newStr = (this.newStr + this.virtueStr[winner & 7]) & 0xff;
    this.virtueBeaten[loser] = 1;
  }

  /**
   * ecea: INIT.GAM is the template; the name, sex and the seven answers (4 + 2 + 1, a tournament
   * of the eight virtues) set the Avatar's INT, DEX and STR. Writes SAVED.GAM and SAVED.OOL.
   */
  async createCharacter() {
    const text = textBuffer.data;
    const font = loadBitmap(pictures.name(P.STORY_FONT));
    const picture = loadPicture(pictures.name(P.CREATE));
    loadGameFile(strings.get(S.INIT_GAM_A060));
    gfx.setDrawColor(gfx.colorFrame);
    gfx.fillRect(0x7e, 200, 0x78, 0x78);
    gfx.setDrawColor(gfx.colorText);
    gfx.drawLine(0x7f, 200, 0x7f, 0x78);
    gfx.setDrawColor(0);
    gfx.fillRect(0xbf, 0x137, 0x80, 8);
    tw.setCursor(0x11, 3);
    tw.printText(strings.get(S.By_what_name_shalt_thou_A06A));
    tw.setCursor(0x13, 0x0e);
    tw.putChar(0x3a);
    writeName(party.member(0), await input.readName(8));
    if (party.member(0).name !== '') {
      tw.setCursor(0x15, 8);
      tw.printText(strings.get(S.Art_thou_Male_or_Female_A08C));
      let k;
      do {
        k = toUpper((await input.waitKeyTimeout(0)) & 0xff);
        if (platform.quitRequested()) k = 0x4d;
      } while (k !== 0x4d && k !== 0x46);
      tw.putChar(k);
      party.member(0).sex = k === 0x4d ? 0x0b : 0x0c;
      this.storyX = 0;
      this.storyY = 9;
      this.storyLeft = [0, 0xaf];
      this.storyRight = [0x140, 0x140];
      this.storyLineMin = 0x59;
      this.storyLineMax = 200;
      loadFilePart(0, 2000, text, strings.get(S.QUESTION_DAT_A0A6)); // the gypsy's welcome
      video.setDrawPage(1);
      tw.putChar(0xff);
      drawPictureFrame(0, 0x60, 0, 0, picture);
      this.drawStoryText(text, font);
      copyPage(0, 1);
      this.storyLineMin = 200;
      await this.waitAnyKey();
      this.newInt = party.member(0).intel;
      this.newDex = party.member(0).dex;
      this.newStr = party.member(0).str;
      this.virtueBeaten.fill(0);
      this.virtueAsked.fill(0);
      for (let i = 0; i < 4; i++) await this.askVirtueQuestion(picture, font);
      this.virtueAsked.fill(0);
      for (let i = 0; i < 2; i++) await this.askVirtueQuestion(picture, font);
      this.virtueAsked.fill(0);
      await this.askVirtueQuestion(picture, font);
      this.storyY = 0;
      this.storyX = 0;
      this.storyLineMin = 0x5a;
      this.storyLeft[1] = 0;
      this.storyRight[1] = 0xa6;
      this.storySpaceWidth = 4;
      loadFilePart(0x322, 2000, text, strings.get(S.QUESTION_DAT_A0B4)); // the gypsy's farewell
      video.setDrawPage(1);
      tw.putChar(0xff);
      drawPictureFrame(0, 100, 0xa8, 10, picture);
      this.drawStoryText(text, font);
      this.storySpaceWidth = 5;
      copyPage(0, 1);
      await this.waitAnyKey();
      dosFreeMem(picture);
      dosFreeMem2(font);
      video.setDrawPage(1);
      tw.putChar(0xff);
      video.setDrawPage(0);
      const m = party.member(0);
      m.intel = this.newInt;
      m.mp = this.newInt;
      m.dex = this.newDex;
      m.str = this.newStr < 0x14 ? 0x14 : this.newStr;
      tw.putChar(0xff);
      tw.setCursor(10, 0);
      const ool = new Uint8Array(0x200); // SAVED.OOL: Britannia empty, the Underworld from INIT.OOL
      loadFilePart(0, 0x100, ool.subarray(0x100), strings.get(S.INIT_OOL_A0C2));
      saveFilePart(0x200, ool, strings.get(S.SAVED_OOL_A0CC));
      saveGameFile(strings.get(S.SAVED_GAM_A0D6));
    } else {
      dosFreeMem(picture);
      dosFreeMem2(font);
    }
    map.id = M.TITLE;
  }
}

export const intro = new Intro();
