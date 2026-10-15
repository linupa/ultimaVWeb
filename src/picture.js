// picture.js - pictures, 1-bit bitmaps, page copies and screen effects: the main program's
// wrappers (0000:0ace-0000:10dc) and the EGA.DRV functions behind them. Ported from the C++ port's
// picture.cpp (EGA only).
//
// Bitmap file (.BIT, PROPORT.PCS): word glyph count, word offsets, then per glyph word width, word
// height, 1 bit per pixel in rows of width / 8 bytes (at least 1). Glyphs draw white on the back
// page.
//
// Picture file (.16, LZW): word frame count, then per frame (word data offset, word mask offset or
// 0). Frame data: word width, word height, rows of 4-bit pixels (high nibble left), each row
// padded to 8 pixels. Mask: 4 bytes, then 1 bit per pixel, set = transparent. In the original a
// handle is a DOS memory segment; here it is a small number (0 = failed).
import { data } from './data/gamedata.js';
import { gameLoadFile } from './files.js';
import { gfx } from './gfx.js';
import { input } from './input.js';
import { sound } from './sound.js';
import { platform } from './platform/platform.js';
import { video, SCREEN_W, SCREEN_H } from './video/video.js';

const MAX_HANDLES = 16;
// A freed block keeps its contents until the slot is used again, as freed DOS memory does.
const handles = Array.from({ length: MAX_HANDLES }, () => ({ data: null, freed: false }));

function newHandle(filename) {
  let slot = handles.findIndex((h) => !h.data);
  if (slot < 0) slot = handles.findIndex((h) => h.freed);
  if (slot < 0) return 0;
  handles[slot].freed = false;
  handles[slot].data = gameLoadFile(filename);
  return handles[slot].data ? slot + 1 : 0;
}

function dataOf(handle) {
  if (handle === 0 || handle > MAX_HANDLES) return null;
  return handles[handle - 1].data;
}

const u16 = (d, p) => d[p] | (d[p + 1] << 8);

/** 0bae */
export function loadPicture(filename) {
  return newHandle(filename);
}

/** 0fae */
export function loadBitmap(filename) {
  return newHandle(filename);
}

/** 0be4 */
export function dosFreeMem(handle) {
  if (handle === 0 || handle > MAX_HANDLES) return;
  handles[handle - 1].freed = true;
}

/** 0fdc */
export function dosFreeMem2(handle) {
  dosFreeMem(handle);
}

/** 0f2a: clears the back page; 1 = ok. */
export function allocBackPage() {
  video.clearBack();
  return 1;
}

// The driver's own noise (EGA.DRV 0x27af): the speaker's timer gets `count` random pitches between
// 100 Hz and top / 2, a sixteenth of a delay unit apart, and stays on at the last, for `seconds`.
let noiseSeed = 0x7664, noiseTop = 0xf0, noiseCount = 1;
function driverNoise(seconds) {
  for (let i = 0; i < noiseCount; i++) {
    let a = (noiseSeed + 0x9248) & 0xffff;
    a = ((a >> 3) | (a << 13)) & 0xffff;
    noiseSeed = ((a ^ 0x9248) + 0x11) & 0xffff;
    const span = ((noiseTop >> 1) - 100 + 1) & 0xffff;
    const freq = (span ? noiseSeed % span : 0) + 100;
    sound.tone(freq, i + 1 === noiseCount ? seconds : 1 / 16000);
  }
}

/** 0f6e */
export function copyPage(to, from) {
  video.copyPage(from, to);
}

/** 0ace */
export function copyPageRect(y2, x2, y1, x1, to, from) {
  if (to === from || to >>> 0 > 1 || from >>> 0 > 1) return;
  video.copyRect(x1, y1, x2, y2, from, to);
}

/** For the clip rows of drawPictureFrame while gfx.clipEnabled is set. */
export function setClipRect(y2, x2, y1, x1) {
  gfx.clipX1 = x1 & 0xffff;
  gfx.clipY1 = y1 & 0xffff;
  gfx.clipX2 = x2 & 0xffff;
  gfx.clipY2 = y2 & 0xffff;
}

/**
 * 0f46 + drv 0x66 (carry clear): the pixels of the rectangle, rows y1 to y2 - 1, are copied from
 * the back page to the screen in the order of a maximal-length shift register over width *
 * height, so the picture dissolves in, about 20 steps a second.
 */
export async function copyBackRect(y2, x2, y1, x1) {
  const taps = [0x0003, 0x0006, 0x000c, 0x0014, 0x0030, 0x0060, 0x00b8, 0x0110, 0x0240, 0x0500, 0x0ca0, 0x1b00, 0x3500, 0x6000, 0xb400];
  if (x1 > x2) [x1, x2] = [x2, x1];
  if (y1 > y2) [y1, y2] = [y2, y1];
  const w = x2 - x1 + 1, h = y2 - y1;
  const n = (w * h - 1) & 0xffff;
  let bits = 0;
  for (let v = n; v; v >>= 1) bits++;
  if (bits < 2) bits = 2;
  const tap = taps[bits - 2 > 14 ? 14 : bits - 2];
  let state = 1;
  const base = x1 & ~7;
  const step = Math.trunc((1 << bits) / 20) + 1;
  // Until the driver has drawn its first character (so: for the title) every other pixel also
  // gives the speaker a new random pitch from a widening range - a rising hiss - and a waiting key
  // stops the dissolve (the key is left for the game to read).
  const noisy = video.noTextYet;
  let done = 0, everyOther = 0, stopped = false, quiet = 0;
  const reveal = (x, y) => {
    if (x < 0 || x >= SCREEN_W || y < 0 || y >= SCREEN_H) return;
    video.fb[y * SCREEN_W + x] = video.back[y * SCREEN_W + x];
  };
  do {
    const x = state % w, y = Math.trunc(state / w);
    quiet++;
    if (y < h) {
      reveal(base + x, y1 + y);
      if (noisy && (everyOther ^= 1)) {
        driverNoise(quiet * (0.055 / step));
        quiet = 0;
        noiseTop = (noiseTop + 1) & 0xffff;
        if (platform.keyWaiting()) {
          stopped = true;
          break;
        }
      }
    }
    const carry = state & 1;
    state >>= 1;
    if (carry) state ^= tap;
    if (++done % step === 0) {
      if (noisy) sound.flush();
      platform.present();
      await input.delayTicks(1);
    }
  } while (state !== 1);
  if (!stopped && h > 0) reveal(base, y1);
  if (noisy) sound.flush();
}

function frameData(picture, frame) {
  const d = dataOf(picture);
  if (!d || frame < 0 || frame >= u16(d, 0)) return null;
  const off = u16(d, 2 + frame * 4), moff = u16(d, 4 + frame * 4);
  if (off + 4 > d.length) return null;
  const w = u16(d, off), h = u16(d, off + 2);
  const rowBytes = (((w + 1) >> 1) + 3) & ~3; // 4-bit pixels, rows padded to 8 pixels
  if (off + 4 + rowBytes * h > d.length) return null;
  return { d, src: off + 4, mask: moff ? moff + 4 : -1, w, h, rowBytes };
}

/** A frame's width and height, or null. */
export function pictureFrameSize(picture, frame) {
  const f = frameData(picture, frame);
  return f ? { w: f.w, h: f.h } : null;
}

/**
 * 0d4c + drv 0x4B. x is rounded down to a multiple of 8. Rows y to y + h - 1 are clipped to
 * 0-199, or to clipY1-clipY2 while gfx.clipEnabled is set (flag 1, upside down, draws upwards
 * from y + h). With a mask, pixels whose mask bit is set are left alone. On the screen page whole
 * bytes are copied, so the width is rounded up to 8 pixels and flag 2 is ignored; on the back
 * page the last byte keeps what was there beyond the frame's width.
 *
 * Flag 2 (back page only) mirrors the frame within its byte-padded width W. The driver reverses
 * each byte with a table and patches the seams: without a mask the frame is OR-ed onto the page,
 * and the last pixel of each byte comes from one source pixel further left (the very last is
 * left out, and one more lands just left of the frame); with a mask that pixel is the AND of the
 * two source pixels, opaque only if both are.
 */
export function drawPictureFrame(flags, y, x, frame, picture) {
  const f = frameData(picture, frame);
  if (!f) return;
  const { d, w, h, rowBytes } = f;
  const full = rowBytes * 2, maskBytes = rowBytes >> 2;
  const back = video.getDrawPage() !== 0;
  const limit = back && f.mask < 0 ? w : full;
  let top = 0, bottom = 199;
  if (gfx.clipEnabled) {
    top = (gfx.clipY1 << 16) >> 16;
    bottom = (gfx.clipY2 << 16) >> 16;
  }
  x &= ~7;
  const draw = video.draw;
  for (let i = 0; i < h; i++) {
    const py = flags & 1 ? y + h - i : y + i;
    if (py < top || py >= bottom + (flags & 1 ? 1 : 0) || py < 0 || py >= SCREEN_H) continue;
    const row = f.src + i * rowBytes;
    const mrow = f.mask >= 0 ? f.mask + i * maskBytes : -1;
    const SRC = (px) => (px & 1 ? d[row + (px >> 1)] & 0x0f : d[row + (px >> 1)] >> 4);
    const MSK = (px) => (d[mrow + (px >> 3)] & (0x80 >> (px & 7))) !== 0;
    const line = py * SCREEN_W;
    if (!(flags & 2) || !back) {
      for (let px = 0; px < limit; px++) {
        if (x + px < 0 || x + px >= SCREEN_W) continue;
        if (mrow >= 0 && MSK(px)) continue;
        draw[line + x + px] = SRC(px);
      }
      continue;
    }
    for (let dx = -1; dx < full; dx++) {
      if (x + dx < 0 || x + dx >= SCREEN_W) continue;
      const at = line + x + dx;
      const sp = full - 1 - dx; // the mirrored source pixel
      if (dx === -1) { // the stray pixel left of the frame: the last source pixel
        if (mrow < 0 || !MSK(full - 1)) draw[at] = SRC(full - 1);
      } else if ((dx & 7) !== 7) {
        if (mrow < 0) draw[at] |= SRC(sp);
        else if (!MSK(sp)) draw[at] = SRC(sp);
      } else if (mrow < 0) {
        if (sp - 1 >= 0 && dx !== full - 1) draw[at] |= SRC(sp - 1);
      } else {
        let c = SRC(sp);
        let m = MSK(sp);
        if (sp - 1 >= 0 && dx !== full - 1) {
          c &= SRC(sp - 1);
          m = m && MSK(sp - 1);
        }
        if (!m) draw[at] = c;
      }
    }
  }
}

/** drv 0x63: the same, mirrored. */
export function drawPictureFrame2(flags, y, x, frame, picture) {
  drawPictureFrame(flags | 2, y, x, frame, picture);
}

/**
 * 1044 + drv 0x4E: set bits become colour 15 on the back page, clear bits leave it alone. The
 * row loop runs at least once (the story font).
 */
export function drawFontGlyph(y, x, glyph, bitmap) {
  const d = dataOf(bitmap);
  if (!d || glyph < 0 || glyph >= ((u16(d, 0) << 16) >> 16)) return;
  const off = u16(d, 2 + glyph * 2);
  if (off + 4 > d.length) return;
  const width = u16(d, off), h = u16(d, off + 2);
  let bytes = width >> 3;
  if (bytes < 1) bytes = 1;
  const pixels = bytes * 8;
  let row = off + 4;
  for (let i = 0; i < h; i++, row += bytes) {
    if (row + bytes > d.length) return;
    const py = y + i;
    if (py < 0 || py >= SCREEN_H) continue;
    for (let px = 0; px < pixels; px++)
      if ((d[row + (px >> 3)] & (0x80 >> (px & 7))) && x + px >= 0 && x + px < SCREEN_W) video.back[py * SCREEN_W + x + px] = 15;
  }
}

// drv 0x69 (carry clear): the title banner is four animation frames kept in the back page at rows
// 0, 50, 100 and 150 (49 rows each); each call copies the next one to rows 65-113 of the screen.
let bannerFrame = 0;
function bannerStep() {
  for (let r = 0; r < 49; r++) video.fb.set(video.back.subarray((bannerFrame * 50 + r) * SCREEN_W, (bannerFrame * 50 + r + 1) * SCREEN_W), (65 + r) * SCREEN_W);
  bannerFrame = (bannerFrame + 1) & 3;
}

/** INTRO a250: one tick, then the next frame of the banner. */
export async function waitRevealStrips() {
  await input.delayTicks(1);
  bannerStep();
}

/**
 * INTRO a26e + drv 0x69 (carry set): the four banner frames dissolve in around the letters of the
 * 288 x 49 bitmap (WD.BIT, "Warriors of Destiny"), which stay black, then the letters fill in.
 * Works in the back page while the banner keeps animating on the screen; a waiting key stops it
 * (and stays for the game to read). Every 128 pixels the banner moves on a frame and the driver
 * waits 50 delay units - or crackles first: 25 random pitches up to 1500 Hz, then 45 units. The
 * chance of a crackle starts at 400 in 512 and drops by 3 each time.
 */
let chanceSeed = 0x7664; // EGA.DRV cs:28C2
export async function revealStrips(bitmap) {
  const wd = dataOf(bitmap);
  const saved = video.back.slice();
  video.clearBack();
  const pixel = (x, y, lettersStay) => {
    const letter = wd && 8 + y * 36 + (x >> 3) < wd.length && (wd[8 + y * 36 + (x >> 3)] & (0x80 >> (x & 7)));
    if (lettersStay && letter) return;
    for (let n = 0, ly = y; n < 4; n++, ly += 50) video.back[ly * SCREEN_W + 16 + x] = saved[ly * SCREEN_W + 16 + x];
  };
  let stopped = false;
  for (let pass = 1; pass >= 0 && !stopped; pass--) {
    let state = 1, count = 0x80, chance = 400;
    do {
      const x = state % 288, y = Math.trunc(state / 288);
      if (y < 49) {
        pixel(x, y, pass);
        if (--count === 0) {
          count = 0x80;
          bannerStep();
          chance -= 3;
          if ((chanceSeed & 0x1ff) < chance) {
            noiseTop = 3000;
            noiseCount = 25;
            driverNoise(1 / 16000);
            sound.tone(0, 0.001);
            sound.flush();
            await platform.delayMs(45);
          } else {
            await platform.delayMs(50);
          }
        }
      }
      if (platform.keyWaiting() || platform.quitRequested()) {
        stopped = true;
        break;
      }
      const carry = state & 1;
      state >>= 1;
      if (carry) state ^= 0x3500;
      let a = (chanceSeed + 0x9248) & 0xffff;
      a = ((a >> 3) | (a << 13)) & 0xffff;
      chanceSeed = ((a ^ 0x9248) + 0x11) & 0xffff;
    } while (state !== 1);
    if (!stopped) pixel(0, 0, pass);
  }
  video.back.set(saved);
}

// drv 0x6F: the ORIGIN logo that grows while it turns over. The back page holds seven sizes of it
// stacked from row 0; the script (EGA.DRV 0x1E8C-0x1F93) gives for each size its row on the back
// page, its row on the screen and its height, then lists of line numbers separated by 0xFF.
// Reading a list backwards switches lines on, a frame at each 0xFF (seven frames: the size
// unfolds); reading it forwards switches them off (six frames) before the next size starts. A
// frame draws the lines that are on packed together in the middle of the size's band, the rest of
// the band black - and bottom-up for every other size, so the image flips as it grows. Only planes
// 0 and 3 are written: the logo is light blue (9). A key ends it with the full last size (1).
const LOGO_SCRIPT = 0x1e8c, LOGO_SCRIPT_SIZE = 0x108, LOGO_LAST_SIZE = 0x1f4b - LOGO_SCRIPT;
const titleWidths = data.words(0x5306, new Int16Array(7), 'picture.titleWidths');
const titleHeights = data.words(0x5314, new Int16Array(7), 'picture.titleHeights');

async function titleEffect() {
  const drv = gameLoadFile('EGA.DRV');
  if (!drv || drv.length < LOGO_SCRIPT + LOGO_SCRIPT_SIZE) {
    console.error('cannot read the logo script from EGA.DRV');
    return 0;
  }
  const script = drv.slice(LOGO_SCRIPT, LOGO_SCRIPT + LOGO_SCRIPT_SIZE);
  const logo = { src: 0, dst: 0, height: 0, flip: 1, key: 0, skipped: 0, on: new Uint8Array(256) };
  const nextRow = (y) => {
    y += logo.flip ? -1 : 1;
    if (!logo.skipped && input.pollKey()) logo.key = 1;
    return y;
  };
  const clearRow = (y) => {
    if (y < 0 || y >= SCREEN_H) return;
    for (let x = 0; x < SCREEN_W; x++) video.fb[y * SCREEN_W + x] &= 6;
  };
  const frame = async () => {
    let hidden = 0, shown = 0, next = 0;
    for (let i = 0; i < logo.height; i++) {
      if (logo.on[i]) shown++;
      else hidden++;
    }
    await sound.delayLoop(12, 1);
    let y = logo.flip ? logo.dst + logo.height : logo.dst;
    for (let n = hidden >> 1; n > 0; n--) {
      clearRow(y);
      y = nextRow(y);
      if (logo.key) return;
    }
    for (let n = shown; n > 0; n--) {
      while (!logo.on[next]) next++;
      const row = logo.src + next++;
      if (y >= 0 && y < SCREEN_H && row < SCREEN_H)
        for (let x = 0; x < SCREEN_W; x++) video.fb[y * SCREEN_W + x] = (video.fb[y * SCREEN_W + x] & 6) | (video.back[row * SCREEN_W + x] & 1 ? 9 : 0);
      y = nextRow(y);
      if (logo.key) return;
    }
    for (let n = (hidden + 1) >> 1; n > 0; n--) {
      clearRow(y);
      y = nextRow(y);
      if (logo.key) return;
    }
  };
  let p = 0;
  for (let stages = script[p++]; ;) {
    logo.src = script[p++];
    logo.dst = script[p++];
    logo.height = script[p++];
    const len = script[p++];
    const list = p;
    p += len;
    logo.flip ^= 1;
    logo.on.fill(0);
    for (let i = len - 2, frames = 7; frames > 0 && i >= 0; i--) {
      if (script[list + i] !== 0xff) {
        logo.on[script[list + i]] = 1;
        continue;
      }
      await frame();
      frames--;
    }
    if (logo.key || platform.quitRequested()) break;
    if (--stages === 0) return 0;
    for (let i = 1, frames = 6; frames > 0 && i < len; i++) {
      if (script[list + i] !== 0xff) {
        logo.on[script[list + i]] = 0;
        continue;
      }
      await frame();
      frames--;
    }
    if (logo.key || platform.quitRequested()) break;
  }
  logo.key = 0;
  logo.skipped = 1;
  logo.src = script[LOGO_LAST_SIZE];
  logo.dst = script[LOGO_LAST_SIZE + 1];
  logo.height = script[LOGO_LAST_SIZE + 2];
  logo.flip = 0;
  logo.on.fill(1);
  await frame();
  return 1;
}

/**
 * 0d72 + drv 0x6F: the seven sizes (TITLE.BIT glyphs 0-6) drawn one under another on the back
 * page, centred, and the effect plays. 1 if a key cut it short.
 */
export async function showTitlePicture(bitmap) {
  let y = 0;
  video.setDrawPage(1);
  gfx.setDrawColor(0);
  gfx.fillRect(199, 0x13f, 0, 0);
  for (let i = 0; i < 7; i++) {
    drawFontGlyph(y, (0x140 - titleWidths[i]) >> 1, i, bitmap);
    y += titleHeights[i];
  }
  video.setDrawPage(0);
  return titleEffect();
}
