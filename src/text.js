// text.js - text windows, fonts and printing (main program 0000:1184-0000:1fa0), as the
// TextWindows class; `textWindows` is the one object. Ported from the C++ port's text.cpp.
//
// The screen is 40 x 25 cells of 8 x 8 pixels. There are four text windows; the current one holds
// the cursor, colours and attribute flags. Text is a JS string of byte values; control codes for
// putChar / printText:
//   0x0A new line   0x0D carriage return   0xFF clear the window and home the cursor
//   0xFE toggle underline   0xFD toggle inverse   0xFC centring on   0xFB centring off
//   other bytes >= 0x80 print as (c & 0x7F)
// Argument order follows the C++ port (Ghidra's), e.g. setCursor(row, col).
import { gameLoadFile } from './files.js';
import { gfx } from './gfx.js';
import { video } from './video/video.js';

export const TEXT_COLS = 40;
export const TEXT_ROWS = 25;

const FONT_BYTES = 128 * 8;

class TextWindows {
  constructor() {
    this.windows = Array.from({ length: 4 }, () => ({ left: 0, top: 0, right: 0, bottom: 0, curCol: 0, curRow: 0, attr: 0, flags: 0 }));
    this.curWindowIndex = 0;
    this.autoAdvance = 1; // putChar moves the cursor after a glyph only when set
    this.underline = 0;
    this.centred = 0;
    this.inverse = 0;
    this.fg = 0;
    this.bg = 0;
    this.fonts = [null, null, null, null];
    this.curFontIndex = 0;
    /** Hook for tests and logging: gets every printed character, and '\n' at line breaks. */
    this.echo = null;
  }

  get window() {
    return this.windows[this.curWindowIndex];
  }

  /** 1184: all four windows the full screen, colour 15 on 0; window 0. */
  resetTextWindows() {
    for (const w of this.windows) Object.assign(w, { left: 0, top: 0, right: TEXT_COLS - 1, bottom: TEXT_ROWS - 1, curCol: 0, curRow: 0, attr: 0x0f, flags: 0 });
    this.curWindowIndex = 0;
  }

  /** 1226 */
  resetTextAttrs() {
    this.underline = 0;
    this.centred = 0;
    this.inverse = 0;
  }

  /** 1b94 */
  selectTextWindow(n) {
    if (n > 3) return;
    this.curWindowIndex = n;
    const w = this.window;
    this.fg = w.attr & 0x0f;
    this.bg = w.attr >> 4;
    this.underline = w.flags & 1;
    this.centred = (w.flags >> 1) & 1;
    this.inverse = (w.flags >> 2) & 1;
  }

  /** 1c22: clamped to the screen; the corners ordered as the original does. */
  defineTextWindow(bottom, right, top, left, n) {
    if (n >= 4) return;
    const clamp = (v, hi) => { v = ((v & 0xff) << 24) >> 24; return v < 0 ? 0 : v > hi ? hi : v; };
    let l = clamp(left, 39), t = clamp(top, 24), r = clamp(right, 39), b = clamp(bottom, 24);
    if (l > r) { // the original only checks the rows when it had to swap the columns
      [l, r] = [r, l];
      if (t > b) [t, b] = [b, t];
    }
    Object.assign(this.windows[n], { left: l, top: t, right: r, bottom: b });
  }

  /** 1bf2: relative to the window; ignored if off the screen. */
  setCursor(row, col) {
    const w = this.window;
    if (((col + w.left) & 0xff) > TEXT_COLS - 1 || ((row + w.top) & 0xff) > TEXT_ROWS - 1) return;
    w.curCol = col & 0xff;
    w.curRow = row & 0xff;
  }
  getCursorCol() { return this.window.curCol; }
  getCursorRow() { return this.window.curRow; }

  /** 1cca */
  setTextColor(c) {
    const w = this.window;
    this.fg = c & 0x0f;
    w.attr = (w.attr & 0xf0) | this.fg;
  }
  /** 1f26 */
  setTextBgColor(c) {
    const w = this.window;
    this.bg = c & 0x0f;
    w.attr = (w.attr & 0x0f) | (this.bg << 4);
  }

  /** 1d02: bytes read, -1 file error, -2 bad slot. */
  loadFont(slot, filename) {
    if (slot > 3) return -2;
    const bytes = gameLoadFile(filename);
    if (!bytes || bytes.length === 0) return -1;
    const font = new Uint8Array(FONT_BYTES);
    font.set(bytes.subarray(0, FONT_BYTES));
    this.fonts[slot] = font;
    return Math.min(bytes.length, FONT_BYTES);
  }

  /** 1c9e: ignored if the slot isn't loaded. */
  selectFont(n) {
    if (n >= 4 || !this.fonts[n]) return;
    this.curFontIndex = n;
  }

  windowPixels(w) {
    return [w.left * 8, w.top * 8, w.right * 8 + 7, w.bottom * 8 + 7];
  }

  /** 16ba: one character or control code (a number 0-255). */
  putChar(c) {
    const w = this.window;
    if (c > 0x7f) {
      switch (c) {
        case 0xff: { // clear the window
          w.curCol = 0;
          w.curRow = 0;
          video.setColor((w.attr >> 4) & 0x0f);
          const [x1, y1, x2, y2] = this.windowPixels(w);
          video.fillRect(x1, y1, x2, y2);
          video.setColor(gfx.drawColor);
          return;
        }
        case 0xfe: this.underline ^= 1; w.flags ^= 1; return;
        case 0xfd: this.inverse ^= 1; w.flags ^= 4; return;
        case 0xfc: this.centred = 1; w.flags |= 2; return;
        case 0xfb: this.centred = 0; w.flags &= ~2; return;
        default: c &= 0x7f;
      }
    }
    if (this.echo && this.autoAdvance && (c === 0x0a || c >= 0x20)) this.echo(c, this.curFontIndex !== 0);
    if (c === 0x0a) {
      w.curRow = (w.curRow + 1) & 0xff;
      w.curCol = 0;
    } else if (c === 0x0d) {
      w.curCol = 0;
    } else {
      const font = this.fonts[this.curFontIndex] ?? this.fonts[0];
      const glyph = font ? font.slice(c * 8, c * 8 + 8) : new Uint8Array(8);
      if (this.underline) glyph[7] = 0xff;
      if (this.inverse) for (let i = 0; i < 8; i++) glyph[i] = ~glyph[i] & 0xff;
      video.drawChar(w.curCol + w.left, w.curRow + w.top, glyph, this.fg, this.bg);
      if (!this.autoAdvance) return;
      w.curCol = (w.curCol + 1) & 0xff;
      if (s8(w.curCol + w.left) <= s8(w.right)) return;
      if (this.echo) this.echo(0x0a, false);
      w.curRow = (w.curRow + 1) & 0xff;
      w.curCol = 0;
    }
    if (s8(w.curRow + w.top) > s8(w.bottom)) { // scroll the window up a line
      const [x1, y1, x2, y2] = this.windowPixels(w);
      w.curRow = (w.curRow - 1) & 0xff;
      video.scrollRect(x1, y1, x2, y2, -8);
    }
  }

  /** 1850: word-wrapped, with optional centring. */
  printText(text) {
    if (text.length === 0) return;
    const at = (i) => (i < text.length ? text.charCodeAt(i) : 0);
    const w = this.windows[this.curWindowIndex];
    const centre = w.flags & 2;
    const width = w.right - w.left; // columns in the window - 1
    const line = [];
    let pos = 0, done = 0, newlineAfter = 0;
    do {
      if (newlineAfter) this.putChar(0x0a);
      let start = 0, skipSpaces = 0;
      newlineAfter = 0;
      const avail = width - this.getCursorCol(); // cells left on this row - 1
      line.length = 0;
      let i = pos;
      while (at(i) !== 0x0a && at(i) !== 0x0d && at(i) !== 0 && line.length <= avail) line.push(at(i++));
      const n = line.length;
      pos = i;
      let last = n;
      if (n === 0) { // at a line end or the end of the text
        if (at(pos) === 0) done++;
        else this.putChar(at(pos++));
        continue;
      }
      if (n > avail) { // doesn't fit: break at the last space
        let k = n, j = pos;
        while (at(j) !== 0x20) {
          if (k === 0 || at(j) === 0x0a || at(j) === 0 || at(j) === 0x0d) break;
          k--;
          j--;
        }
        pos = j;
        if (k === 0) { // one word longer than the row: print it as it is, on a fresh line
          last = n;
          pos = i;
          if (w.curCol !== 0) {
            this.putChar(0x0a);
            skipSpaces = 1;
          }
        } else {
          last = k - 1; // drop the trailing spaces and line ends
          while (last >= 0 && (line[last] === 0x20 || line[last] === 0x0d || line[last] === 0x0a)) last--;
          if (at(pos) !== 0) pos++; // skip the space it broke at
          if (last < avail) newlineAfter++; // a full row wraps by itself
        }
        if (last > avail) last--;
      } else {
        last--;
      }
      if (centre) {
        if (last > width) this.putChar(0x0a);
        this.setCursor(this.getCursorRow(), Math.trunc((avail - last) / 2));
      }
      if (skipSpaces) while (line[start] === 0x20) start++;
      for (let k = start; k <= last; k++) this.putChar(line[k]);
    } while (!done);
  }

  /** 1a3e: right-aligned in `width`, padded with `pad` (a character). */
  printNumber(pad, width, value) {
    const pow10 = [1, 10, 100, 1000, 10000];
    if (width > 39) width = 39;
    const negative = value < 0;
    if (negative) value = -value;
    let digits = 1;
    for (let k = 1; k < 5; k++) if (pow10[k] <= value) digits++;
    if (negative) digits++;
    let padding = width - digits;
    if (padding < 1) padding = 0;
    let s = pad.repeat(padding);
    if (negative) {
      s += '-';
      digits--;
    }
    do {
      const p = pow10[digits - 1];
      s += String.fromCharCode(0x30 + Math.trunc(value / p));
      value %= p;
    } while (--digits !== 0);
    this.printText(s);
  }

  /** 1fa0: backspace over `count` cells, across lines. */
  eraseChars(count) {
    const saved = this.autoAdvance;
    if ((this.getCursorCol() !== 0 || this.getCursorRow() !== 0) && count !== 0) {
      this.autoAdvance = 0;
      const w = this.windows[this.curWindowIndex];
      const width = w.right - w.left;
      for (; count > 0; count--) {
        const col = this.getCursorCol();
        this.putChar(0x20);
        if (col === 0) this.setCursor(this.getCursorRow() - 1, width);
        else this.setCursor(this.getCursorRow(), col - 1);
      }
    }
    this.autoAdvance = saved;
  }

  /** Runs fn with window n selected, then selects the one that was current (WindowScope). */
  inWindow(n, fn) {
    const saved = this.curWindowIndex;
    this.selectTextWindow(n);
    try {
      return fn();
    } finally {
      this.selectTextWindow(saved);
    }
  }
}

const s8 = (v) => ((v & 0xff) << 24) >> 24;

export const textWindows = new TextWindows();
