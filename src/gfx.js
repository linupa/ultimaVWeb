// gfx.js - the main program's drawing wrappers around the graphics driver (0000:0a70-0000:0fae)
// and the screen frame, as the Gfx class; `gfx` is the one object. Ported from the C++ port's
// gfx.cpp. Argument order follows the C++ port (Ghidra's), e.g. fillRect(y2, x2, y1, x1).
import { S, strings } from './data/strings.js';
import { textWindows } from './text.js';
import { video } from './video/video.js';

const s16 = (v) => ((v & 0xffff) << 16) >> 16;

class Gfx {
  constructor() {
    this.videoType = 1; // 1 EGA (the only driver ported)
    // The colours things are drawn in, by what they are for: DATA.OVL's four-colour values, which
    // setEgaColors replaces for the 16-colour drivers.
    this.colorText = 3;
    this.colorFrame = 1;
    this.colorFire = 2;
    this.colorPoison = 1;
    this.colorSleep = 2;
    this.colorChest = 3;
    this.colorLadder = 3;
    this.drawColor = 0; // 0xFFFF = none
    this.clipEnabled = 0;
    this.clipX1 = 0;
    this.clipX2 = 319;
    this.clipY1 = 0;
    this.clipY2 = 199;
    this.lineLastX = 0;
    this.lineLastY = 0;
  }

  /** 0a70 */
  setDrawColor(c) {
    if (c !== 0xffff) c &= 0x0f;
    this.drawColor = c;
    if (c !== 0xffff) video.setColor(c);
  }

  /** picture.cpp plot_pixel (0c64): one pixel in the colour, remembered as the line's end; clipped. */
  plotPixel(y, x) {
    this.lineLastX = x & 0xffff;
    this.lineLastY = y & 0xffff;
    if (this.drawColor === 0xffff) return;
    if (this.clipEnabled && (s16(x) < s16(this.clipX1) || s16(x) > s16(this.clipX2) || s16(y) < s16(this.clipY1) || s16(y) > s16(this.clipY2))) return;
    video.plot(x, y);
  }

  /** 0aa6: pixels, inclusive. */
  fillRect(y2, x2, y1, x1) { video.fillRect(x1, y1, x2, y2); }
  /** 0b86 */
  xorFillRect(y2, x2, y1, x1) { video.fillRect(x1, y1, x2, y2, true); }

  clipOutcode(x, y) {
    let code = 0;
    if (x < s16(this.clipX1)) code |= 1;
    if (x > s16(this.clipX2)) code |= 2;
    if (y > s16(this.clipY2)) code |= 4;
    if (y < s16(this.clipY1)) code |= 8;
    return code;
  }

  /** 0991: where the line from A to B (outside) leaves the rectangle, found by halving. */
  clipLineStep(ax, ay, bx, by) {
    let x = ax, y = ay;
    for (;;) {
      let mx = Math.trunc((x + bx) / 2), my = Math.trunc((y + by) / 2); // idiv for negative sums
      if (x + bx >= 0) mx = (x + bx) >> 1;
      if (y + by >= 0) my = (y + by) >> 1;
      let dx = x - mx, dy = y - my;
      if (this.clipOutcode(mx, my) !== 0) {
        bx = mx;
        by = my;
        continue;
      }
      x = mx;
      y = my;
      if ((x === s16(this.clipX1) || x === s16(this.clipX2)) && (y === s16(this.clipY1) || y === s16(this.clipY2))) break;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 1) break;
    }
    return [x, y];
  }

  /** 0935: null if the line is wholly on one outer side, else the clipped ends. */
  clipLine(x1, y1, x2, y2) {
    const c1 = this.clipOutcode(x1, y1), c2 = this.clipOutcode(x2, y2);
    if (c1 === 0 && c2 === 0) return [x1, y1, x2, y2];
    if (c1 & c2) return null;
    let a = [x1, y1], b = [x2, y2];
    if (c1 !== 0) a = this.clipLineStep(x2, y2, x1, y1);
    if (c2 !== 0) b = this.clipLineStep(x1, y1, x2, y2);
    return [a[0], a[1], b[0], b[1]];
  }

  /** 0b2d */
  lineImpl(x1, y1, x2, y2) {
    this.lineLastX = x2 & 0xffff;
    this.lineLastY = y2 & 0xffff;
    if (this.clipEnabled) {
      const c = this.clipLine(x1, y1, x2, y2);
      if (!c) return;
      [x1, y1, x2, y2] = c;
    }
    video.line(x1, y1, x2, y2);
  }

  /** 0b10 */
  drawLine(y2, x2, y1, x1) { this.lineImpl(x1, y1, x2, y2); }
  /** 0f90: from the end of the last line. */
  drawLineB(y, x) { this.lineImpl(s16(this.lineLastX), s16(this.lineLastY), x, y); }

  /** 0c9c */
  drawHline(x2, y, x1) {
    this.lineLastX = x2 & 0xffff;
    if (this.clipEnabled) {
      const hi = Math.max(x1, x2), lo = Math.min(x1, x2);
      if (hi < s16(this.clipX1) || lo > s16(this.clipX2) || hi < 0 || hi > 0x13f || lo > 0x13f) return;
    }
    video.line(x1, y, x2, y);
  }

  /** 0cf2 */
  drawVline(y2, y1, x) {
    this.lineLastY = y2 & 0xffff;
    if (this.clipEnabled) {
      const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
      if (lo < s16(this.clipY1) || hi > s16(this.clipY2) || lo < 0 || lo > 0xc7 || hi > 0xc7) return;
    }
    video.line(x, y1, x, y2);
  }

  /** intro_main's 16-colour role colours. */
  setEgaColors() {
    this.colorFrame = 1;
    this.colorFire = 4;
    this.colorText = 0x0f;
    this.colorSleep = 5;
    this.colorPoison = 2;
    this.colorChest = 0x0e;
    this.colorLadder = 7;
  }

  /** The start of intro_main: colours and fonts for EGA. False if a font is missing. */
  videoStart() {
    this.setEgaColors();
    return textWindows.loadFont(0, strings.get(S.ibm_ch_3194)) >= 0 && textWindows.loadFont(1, strings.get(S.runes_ch_319B)) >= 0;
  }

  /** 637e: the border around the view and the side panels. */
  drawScreenFrame() {
    const t = textWindows;
    this.setDrawColor(0);
    this.fillRect(199, 0x13f, 0, 0);
    this.setDrawColor(this.colorFrame);
    this.fillRect(6, 0x13f, 0, 0);
    this.fillRect(0xbf, 0xbf, 0xb9, 0);
    this.fillRect(0xbf, 6, 0, 0);
    this.fillRect(0xbf, 0xbf, 0, 0xb9);
    this.fillRect(0x57, 0x13f, 0, 0x139);
    this.fillRect(0x57, 0x138, 0x50, 0xc0);
    this.fillRect(0x3f, 0x138, 0x39, 0xc0);
    t.setTextColor(this.colorFrame);
    t.setCursor(0, 0);
    t.putChar(0x7b);
    t.setCursor(0, 0x27);
    t.putChar(0x7c);
    t.setCursor(0x17, 0);
    t.putChar(0x7d);
    this.setDrawColor(this.colorText);
    this.drawLine(0xb8, 7, 7, 7);
    this.drawLineB(0xb8, 0xb8);
    this.drawLineB(7, 0xb8);
    this.drawLineB(7, 7);
    this.drawLine(0x57, 0xbf, 0xbf, 0xbf);
    this.drawLineB(0x57, 0x13f);
    this.drawLine(7, 0x138, 7, 0xbf);
    this.drawLineB(0x38, 0x138);
    this.drawLineB(0x38, 0xbf);
    this.drawLineB(7, 0xbf);
    this.drawLine(0x3f, 0x138, 0x3f, 0xbf);
    this.drawLineB(0x50, 0x138);
    this.drawLineB(0x50, 0xbf);
    this.drawLineB(0x3f, 0xbf);
    t.setTextColor(this.colorText);
  }
}

export const gfx = new Gfx();
