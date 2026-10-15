// look.js - Look and the area map (LOOKOBJ.OVL). Ported from the C++ port's look.cpp.
import { askDirection, getCommandKey, readLine } from './commands.js';
import { data, SHARED } from './data/gamedata.js';
import { S, strings, latin1 } from './data/strings.js';
import { loadFilePart } from './files.js';
import { gameTime } from './gametime.js';
import { gfx } from './gfx.js';
import { input } from './input.js';
import { M, map } from './map.js';
import { randomBetween, strFindNocase } from './misc.js';
import { allocObjectSlot, findObjectAt, setObjectEntry } from './objects.js';
import { party } from './party.js';
import { platform } from './platform/platform.js';
import { sound } from './sound.js';
import { status } from './status.js';
import { textWindows as tw } from './text.js';
import { textBuffer } from './textbuf.js';
import { video } from './video/video.js';
import { view } from './view.js';
import { askWhichMember, damageMember } from './world.js';

/** A NUL-ended text of LOOK2.DAT: its offset is at `index` * 2. */
function lookText(index) {
  const off = new Uint8Array(2), text = new Uint8Array(0x80);
  loadFilePart(index * 2, 2, off, strings.get(S.LOOK2_DAT_71F8));
  loadFilePart(off[0] | (off[1] << 8), 0x80, text, strings.get(S.LOOK2_DAT_7202));
  const end = text.indexOf(0);
  return latin1(end < 0 ? text : text.subarray(0, end));
}

export function printTileDescription(tile) {
  tw.printText(lookText(tile));
}

export function printObjectDescription(tile) {
  tw.printText(lookText(tile + 0x100));
  if (tw.getCursorCol() !== 0) tw.putChar(0x0a);
}

/** A coin and a wish: at Paws and Empath Abbey a wish for a horse (or one of five sports cars) brings one. */
async function lookWell(z, y, x) {
  tw.printText(strings.get(S.a_well_Drop_a_coin_720C));
  let c;
  do {
    c = await getCommandKey();
    if (platform.quitRequested()) return;
  } while (c !== 0x59 && c !== 0x4e);
  if (c === 0x4e) {
    tw.printText(strings.get(S.No_7222));
    return;
  }
  tw.printText(strings.get(S.Yes_7226));
  if (party.gold === 0) return;
  tw.printText(strings.get(S.Thy_wish_722C));
  party.gold--;
  const wish = await readLine(0x0c);
  if (wish === '') {
    tw.printText(strings.get(S.Nothing_7238));
    return;
  }
  const words = [S.Corvette_7242, S.Ferrari_724C, S.Lamborghini_7254, S.Lotus_7260, S.Porsche_7266, S.Horse_726E];
  const horse = words.some((w) => strFindNocase(wish, strings.get(w)) >= 0);
  if (!horse) {
    tw.printText(strings.get(S.No_effect_728C));
  } else if (map.id === M.PAWS || map.id === M.EMPATH_ABBEY) {
    tw.printText(strings.get(S.Poof_7284));
    await sound.soundNoise(2000, 3000, 10);
    setObjectEntry(allocObjectSlot(), 0, z, y, (x + 1) & 0xff, 0x10, 0x10);
  } else {
    tw.printText(strings.get(S.No_effect_7274));
  }
}

async function lookTownFountain() {
  tw.printText(strings.get(S.a_gurgling_fountain_729C));
  tw.printText(strings.get(S.Who_will_drink_72B4));
  const member = await status.askMemberNumber();
  if (member === -1) tw.printText(strings.get(S.None_72C6));
  else if (party.member(member).dead() || party.member(member).asleep()) tw.printText(strings.get(S.Incapacitated_72CE));
  else tw.printText(strings.get(S.Refreshing_72E0));
}

/** A planet: a 3 x 3 blob with a pixel above and below, at 8-pixel cells. */
function drawSkyMoon(col, phase) {
  gfx.setDrawColor(gfx.colorText);
  const x = phase * 8;
  gfx.plotPixel(col * 8 + 8, x + 6);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (x + j < 0xb1) gfx.plotPixel(col * 8 + i + 7, x + j + 7);
  if (x < 0xae) gfx.plotPixel(col * 8 + 8, x + 10);
}

/** A comet's tail beside the planet of the town a Shadowlord is in. */
function drawSkyShadowlord(col, phase) {
  const x = phase * 8, y = col * 8;
  gfx.setDrawColor(gfx.colorFire);
  if (x > 2) {
    gfx.drawVline(y + 0x0c, y + 10, x + 5);
    gfx.drawVline(y + 0x0c, y + 10, x + 6);
    gfx.drawVline(y + 0x0c, y + 8, x + 7);
  }
  if (x < 0xb0) gfx.drawVline(y + 0x0c, y + 8, x + 8);
  if (x < 0xaf) gfx.drawVline(y + 10, y + 6, x + 9);
  if (x < 0xae) gfx.drawVline(y + 10, y + 6, x + 10);
  if (x < 0xad) gfx.drawVline(y + 8, y + 5, x + 0x0b);
  if (x < 0xac) gfx.drawVline(y + 7, y + 5, x + 0x0c);
}

// From DATA.OVL: for each planet of the telescope view, where its walk starts (ds:3750), the row
// it is drawn on (ds:3758), and its track of 22 places, 0 = a place it skips (ds:3760).
const skyStart = data.bytes(0x3750, new Uint8Array(8), 'look.skyStart');
const skyRow = data.bytes(0x3758, new Uint8Array(8), 'look.skyRow');
const skyTrack = data.bytes(0x3760, new Uint8Array(8 * 0x16), 'look.skyTrack');

/**
 * By day the sun burns the looker for 1. By night: 80 stars and the eight planets, one for each of
 * towns 1-8, stepping back along their tracks a place a day since 4-5-139 - so the planets tell
 * where the Shadowlords are.
 */
export async function lookSky() {
  if (!(gameTime.hour < 6 || gameTime.hour > 0x11)) {
    tw.printText(strings.get(S.the_sun_72F0));
    if (party.activePlayer === 0xff && status.checkPartyState() === 0) party.activePlayer = party.firstAble();
    await damageMember(1, party.activePlayer);
    status.drawStatusBar();
    return;
  }
  view.rebuild = true;
  for (let r = 0; r < 11; r++) view.mask.fill(0xff, r * 0x20, r * 0x20 + 11);
  view.mask[0x145] = 0x59; // the telescope at the bottom
  view.drawView();
  gfx.setDrawColor(gfx.colorFrame + 8);
  for (let i = 0x50; i !== 0; i--) {
    const x = randomBetween(0xb6, 9), y = randomBetween(0xac, 9);
    gfx.plotPixel(y, x);
  }
  for (let p = 0; p < 8; p++) {
    let yr = ((gameTime.year << 16) >> 16) % 100, mo = gameTime.month, dy = gameTime.day;
    let pos = skyStart[p];
    let guard = 0;
    while ((yr > 0x27 || (yr === 0x27 && mo > 4) || (yr === 0x27 && mo === 4 && dy > 5)) && guard++ < 100000) {
      if (--dy === 0) {
        dy = 0x1c;
        mo--;
      }
      if (mo === 0) {
        mo = 0x0d;
        yr--;
      }
      do {
        if (--pos < 0) pos = 0x15;
      } while (skyTrack[p * 0x16 + pos] === 0);
    }
    const row = skyRow[p];
    drawSkyMoon(row, pos + 1);
    for (let s = 0; s < 3; s++) if (map.shadowlordLocations[s] === p + 1) drawSkyShadowlord(row, pos);
  }
  tw.printText(strings.get(S.the_night_sky_72FA));
  while ((await input.waitKeyCursor()) === 0 && !platform.quitRequested()) { /* until a key */ }
}

/** Telescopes pass the look on; clocks tell the time; the flame's plate and the seals their names. */
async function lookTile(y, x, tile) {
  let steps = 0;
  while ((tile === 0xe0 || tile === 0xe1 || tile === 0xe2) && steps++ < 64) {
    if (tile === 0xe0) y--;
    else if (tile === 0xe1) x++;
    else x--;
    tile = map.getTile(y, x);
  }
  if (tile === 0x59) {
    await lookSky();
  } else if (tile === 0xa1) {
    await lookWell(map.z, map.y, map.x);
  } else if ((tile & 0xfc) === 0xd8) {
    await lookTownFountain();
  } else {
    printTileDescription(tile);
    if ((tile & 0xfe) === 0xfa) {
      const h = gameTime.hour % 12;
      tw.printNumber(' ', 1, h === 0 ? 12 : h);
      tw.putChar(0x3a);
      tw.printNumber('0', 2, gameTime.minute);
      tw.printText(strings.get(gameTime.hour < 12 ? S.AM_7310 : S.PM_730A));
    } else if (tile === 0xde) {
      if (map.id === M.LYCAEUM) tw.printText(strings.get(S.Truth_7316));
      else if (map.id === M.EMPATH_ABBEY) tw.printText(strings.get(S.Love_731E));
      else if (map.id === M.SERPENTS_HOLD) tw.printText(strings.get(S.Courage_7324));
    } else if (tile === 0xdf) {
      const names = { 0x3a: S.Shame_735C, 0x48: S.Destard_7340, 0x5b: S.Despise_7336, 0x7e: S.Wrong_734A, 0x80: S.Doom_736E, 0x9c: S.Covetous_7352, 0xef: S.Hythloth_7364, 0xf0: S.Deceit_732E };
      if (names[x]) tw.printText(strings.get(names[x]));
    } else if (tw.getCursorCol() !== 0) {
      tw.putChar(0x0a);
    }
  }
}

// The frame and line pieces signs and books draw for bytes 0x29-0x31 (ds:3810; the original
// reaches it as ds:37BE + byte * 2).
const signPieces = data.words(0x3810, new Array(9).fill(0), 'look.signPieces');

/** A sign's text from the text buffer at `offset`; -1 = "LIVE BY THE EIGHT LAWS". */
export async function printSignText(offset) {
  if (offset === -1) {
    tw.selectFont(1);
    tw.printText(strings.get(S.abbbbbbbbbbbbbbc_g_g_g_742A));
    tw.printText(strings.get(S.g_EIGHT_LAWS_g_g_745E));
    tw.selectFont(0);
    return;
  }
  const buf = textBuffer.data;
  let i = offset + 4;
  while (i < 1990 && buf[i] === 10) i += 6; // an entry that is only "\n" shares the next one's text
  for (; i < 2000 && buf[i] !== 0; i++) {
    const b = buf[i];
    tw.selectFont((b & 0x80) === 0 ? 1 : 0);
    if (b === 0x26 || b === 0x27) {
      tw.putChar(0x6c);
    } else if (b >= 0x29 && b <= 0x31) {
      tw.selectFont(1);
      const piece = strings.get(signPieces[b - 0x29]);
      for (let k = 0; k < piece.length; k++) tw.putChar(piece.charCodeAt(k));
    } else if (b === 0x0d) {
      tw.selectFont(0);
      await getCommandKey();
    } else {
      tw.putChar(b & 0x7f);
    }
  }
  tw.selectFont(0);
  if (tw.getCursorCol() !== 0) tw.putChar(0x0a);
}

/** The poster in Yew names the party; otherwise the location's signs are searched for the square. */
async function readSign(y, x, z) {
  if (map.id === M.YEW && z === 0 && x === 0x11 && y === 0x15) {
    tw.selectFont(1);
    tw.printText(strings.get(S.abbbbbbbbbbbbbc_g_7492));
    tw.selectFont(0);
    tw.printText(strings.get(S.Wanted_74A8));
    tw.selectFont(1);
    tw.printText(strings.get(S.g_g_74B4));
    tw.setCursor(tw.getCursorRow(), 0x0e);
    tw.printText(strings.get(S.g_g_74B8));
    for (let m = 0; m < 3; m++) {
      if (m < party.size) {
        tw.selectFont(0);
        tw.setCursor(tw.getCursorRow(), 7 - (party.member(m).name.length >> 1));
        tw.printText(party.member(m).name);
        tw.selectFont(1);
      }
      tw.setCursor(tw.getCursorRow(), 0x0e);
      tw.printText(strings.get(S.g_g_74BC));
    }
    tw.setCursor(tw.getCursorRow(), 0x0e);
    tw.printText(strings.get(S.g_g_74C0));
    tw.selectFont(0);
    tw.printText(strings.get(S.Dead_or_Alive_74C4));
    tw.selectFont(1);
    tw.printText(strings.get(S.g_deeeeeeeeeeeeef_74D2));
    tw.selectFont(0);
    return;
  }
  const index = new Uint8Array(0x42);
  loadFilePart(0, 0x42, index, strings.get(S.signs_dat_74E6));
  const off = map.onTileMap() ? index[map.id * 2] | (index[map.id * 2 + 1] << 8) : 0;
  const buf = textBuffer.data;
  buf.fill(0xff);
  if (off === 0) {
    await printSignText(-1);
    return;
  }
  loadFilePart(off, 2000, buf, strings.get(S.signs_dat_74F0));
  for (let i = 0; i < 1990;) {
    if (buf[i + 1] === z && buf[i + 2] === x && buf[i + 3] === y) {
      await printSignText(i);
      return;
    }
    i += 4;
    while (i < 1999 && buf[i] !== 0) i++;
    i++;
    if (buf[i] === 0xff) break;
  }
  await printSignText(-1);
}

/** L: a crystal ball (0x29) shows the area map to the clever; signs are read; the rest described. */
export async function cmdLook() {
  const dir = await askDirection();
  if (!dir) return;
  const x = (map.x + dir.dx) & 0xffff, y = (map.y + dir.dy) & 0xffff;
  const tile = map.getTile(y, x);
  const object = findObjectAt(map.z, y, x).tile;
  if (tile === 0x29) {
    const member = await askWhichMember();
    if (member === -1) return;
    if (party.member(member).intel <= randomBetween(0x1e, 1)) {
      tw.printText(strings.get(S.Death_vision_74FA));
      await damageMember(1, member);
      status.drawStatusBar();
      return;
    }
    tw.printText(strings.get(S.Strange_vision_750A));
    await showAreaMap(map.y, map.x);
    return;
  }
  tw.printText(strings.get(S.Thou_dost_see_751C));
  if (object !== 0) {
    printObjectDescription(object);
  } else if (tile === 0xa0 || tile === 0x89 || tile === 0x8a || tile === 0xa4 || tile === 0xf8) {
    tw.printText(strings.get(S.NL_752C));
    await readSign(y, x, map.z);
  } else {
    await lookTile(y, x, tile);
  }
}

// ---- the area map: every square of the 32 x 32 map window as a 4 x 4 glyph ----

let gx = 0, gy = 0; // where the next glyph goes (the original leaves it in dir_x / dir_y)

function mapCellPos(row, col) {
  gx = col * 4 + 0x20;
  gy = row * 4 + 0x20;
}

const dimColor = () => gfx.colorFrame + 8; // EGA
const plot = (y, x) => gfx.plotPixel(y, x);

function glyphDots() {
  gfx.setDrawColor(gfx.colorPoison + 8);
  plot(gy, gx + 1);
  plot(gy + 2, gx + 1);
  plot(gy + 1, gx + 3);
  plot(gy + 3, gx + 3);
}
function glyphFilled() {
  gfx.setDrawColor(gfx.colorPoison + 8);
  gfx.fillRect(gy + 3, gx + 3, gy, gx);
}
function glyphVbars() {
  gfx.setDrawColor(gfx.colorText);
  gfx.drawLine(gy, gx + 3, gy, gx);
  gfx.drawLine(gy + 3, gx + 3, gy + 3, gx);
}
function glyphInnerBars() {
  gfx.setDrawColor(gfx.colorText);
  gfx.drawLine(gy + 1, gx + 2, gy + 1, gx + 1);
  gfx.drawLine(gy + 2, gx + 2, gy + 2, gx + 1);
}
function glyphBox() {
  gfx.setDrawColor(gfx.colorText);
  gfx.drawLine(gy, gx + 3, gy, gx);
  gfx.drawLine(gy + 3, gx + 3, gy + 3, gx);
  gfx.drawLine(gy + 2, gx, gy + 1, gx);
  gfx.drawLine(gy + 2, gx + 3, gy + 1, gx + 3);
}
function glyphSteps() {
  gfx.setDrawColor(gfx.colorChest);
  gfx.drawLine(gy, gx + 1, gy, gx);
  gfx.drawLine(gy + 1, gx + 1, gy + 1, gx);
  gfx.drawLine(gy + 2, gx + 3, gy + 2, gx + 2);
  gfx.drawLine(gy + 3, gx + 3, gy + 3, gx + 2);
}
function glyphHbars() {
  gfx.setDrawColor(gfx.colorPoison + 8);
  gfx.drawLine(gy, gx + 3, gy, gx);
  gfx.drawLine(gy + 2, gx + 3, gy + 2, gx);
  plot(gy + 1, gx + 2);
  plot(gy + 3, gx);
}

// From DATA.OVL: for the river tiles, which of the four dots are water (ds:3822); for the building
// tiles 0x20-0x26, which sides have walls (ds:3832; the original reaches it as ds:3812 + tile).
const riverDots = data.bytes(0x3822, new Uint8Array(16), 'look.riverDots');
const buildingWalls = data.bytes(0x3832, new Uint8Array(7), 'look.buildingWalls');

function glyphTerrain(tile) {
  const bits = riverDots[tile & 0x0f];
  const c = [0, 1, 2, 3].map((i) => ((tile & 0xf0) === 0x60 && !(bits & (8 >> i)) ? gfx.colorPoison + 8 : dimColor()));
  gfx.setDrawColor(c[0]);
  plot(gy, gx + 1);
  gfx.setDrawColor(c[1]);
  plot(gy + 1, gx + 3);
  gfx.setDrawColor(c[2]);
  plot(gy + 2, gx + 1);
  gfx.setDrawColor(c[3]);
  plot(gy + 3, gx + 3);
}
function glyphTwoDots() {
  gfx.setDrawColor(dimColor());
  plot(gy, gx);
  plot(gy + 2, gx + 2);
}
function glyphMixedDots() {
  gfx.setDrawColor(gfx.colorPoison + 8);
  plot(gy, gx + 1);
  plot(gy + 1, gx + 3);
  gfx.setDrawColor(dimColor());
  plot(gy + 2, gx);
  plot(gy + 3, gx + 2);
}
function glyphBuilding(tile) {
  glyphDots();
  gfx.setDrawColor(gfx.colorFire);
  gfx.fillRect(gy + 2, gx + 2, gy + 1, gx + 1);
  const walls = tile >= 0x20 && tile < 0x27 ? buildingWalls[tile - 0x20] : 0;
  if (walls & 8) gfx.drawLine(gy, gx + 2, gy, gx + 1);
  if (walls & 4) gfx.drawLine(gy + 2, gx + 3, gy + 1, gx + 3);
  if (walls & 2) gfx.drawLine(gy + 3, gx + 2, gy + 3, gx + 1);
  if (walls & 1) gfx.drawLine(gy + 2, gx, gy + 1, gx);
  gfx.setDrawColor(0);
  if (tile === 0x22) plot(gy + 2, gx + 1);
  else if (tile === 0x23) plot(gy + 1, gx + 1);
  else if (tile === 0x24) plot(gy + 1, gx + 2);
  else if (tile === 0x25) plot(gy + 2, gx + 2);
}

// Each tile's glyph class on the area map (ds:1D1A; 0 = nothing). 255 entries in the original;
// tile 0xFF reads the byte after them (0), so 256 are taken.
const mapGlyphClass = data.bytes(0x1d1a, new Uint8Array(256), 'look.mapGlyphClass', SHARED);

function drawMapGlyph(row, col, tile) {
  mapCellPos(row, col);
  switch (mapGlyphClass[tile & 0xff]) {
    case 1: glyphDots(); break;
    case 2: glyphFilled(); break;
    case 3: gfx.setDrawColor(gfx.colorFire); gfx.fillRect(gy + 3, gx + 3, gy, gx); break;
    case 4: glyphVbars(); break;
    case 5: glyphInnerBars(); break;
    case 6: glyphBox(); break;
    case 7: case 0x5a: gfx.setDrawColor(gfx.colorText); gfx.fillRect(gy + 3, gx + 3, gy, gx); break;
    case 8: glyphSteps(); break;
    case 9: glyphHbars(); break;
    case 0x0a: glyphTerrain(tile); break;
    case 0x0b: glyphTwoDots(); break;
    case 0x0c: gfx.setDrawColor(dimColor()); plot(gy + 2, gx + 2); break;
    case 0x0d: glyphMixedDots(); break;
    case 0x0e:
      gfx.setDrawColor(gfx.colorText);
      gfx.drawLine(gy + 3, gx + 1, gy, gx + 1);
      gfx.drawLine(gy + 3, gx + 2, gy, gx + 2);
      break;
    case 0x0f: gfx.setDrawColor(gfx.colorFrame + 8); gfx.fillRect(gy + 3, gx + 3, gy, gx); break;
    case 0x10: glyphBuilding(tile); break;
  }
}

/** Drawn on the back page and copied over the view; the party's cell blinks until a key. */
export async function showAreaMap(y, x) {
  const col = (x - map.originX) & 0xff, row = (y - map.originY) & 0xff;
  video.setDrawPage(1);
  gfx.setDrawColor(0);
  gfx.fillRect(0xb7, 0xb7, 8, 8);
  for (let r = 0; r < 0x20; r++) for (let c = 0; c < 0x20; c++) drawMapGlyph(r, c, map.getTile(map.originY + r, map.originX + c));
  video.copyRect(8, 8, 0xb7, 0xb7, 1, 0);
  video.setDrawPage(0);
  mapCellPos(row, col);
  for (let n = 0; (await input.waitKeyCursor()) === 0 && !platform.quitRequested();) {
    if (++n === 4) {
      n = 0;
      gfx.setDrawColor(gfx.colorText);
      gfx.xorFillRect(gy + 3, gx + 3, gy, gx);
    }
  }
  await view.worldTick();
}
