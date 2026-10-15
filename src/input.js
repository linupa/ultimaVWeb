// input.js - keyboard and timing routines of the main program (1b38, 1d5e, 1dda, 20fa), as the Input
// class; `input` is the one Input object. Ported from the C++ port's input.cpp.
//
// Waiting functions are async (see the convention in platform/platform.js).
import { data } from './data/gamedata.js';
import { KEY_DOWN, KEY_HOME, KEY_LEFT, KEY_PGDN } from './platform/keys.js';
import { platform } from './platform/platform.js';
import { textWindows } from './text.js';

// The cursor is a glyph drawn in place at the text cursor: IBM.CH glyphs cursor[0] + frame, the
// frame wrapping at cursor[1] (ds:5390, ds:5392 in DATA.OVL).
const cursor = data.words(0x5390, new Uint16Array(2), 'input.cursor');

export class Input {
  constructor() {
    this.numpadShift = 0; // ds:538A  poll_key: a cursor key, or Shift with a keypad digit
    this.typeaheadOn = 0; // ds:538C  the "Buffer On/Off" toggle (Ctrl key 0xFC); not modelled
    this.cursorFrame = 0; // ds:540C  wait_key_cursor's animation frame
    this.cursor = cursor;
    // While the game waits for typed text: 'text' or 'number' (else null). The page shows a
    // touch screen's keyboard then (onTyping).
    this.typing = null;
    this.onTyping = null;
  }

  drawCursor(frame) {
    textWindows.putChar((this.cursor[0] + frame) & 0xff);
  }

  eraseCursor() {
    textWindows.putChar(0x20);
  }

  /** 1d5e: the next key code, or 0. Sets numpadShift for cursor keys and Shift + 1-9. */
  pollKey() {
    this.numpadShift = 0;
    const k = platform.pollKey();
    const key = k ? k.key : 0;
    if ((key >= KEY_LEFT && key <= KEY_DOWN) || (key >= KEY_HOME && key <= KEY_PGDN)) this.numpadShift++;
    else if (key >= 0x31 && key <= 0x39 && k.shifted) this.numpadShift++;
    return key;
  }

  /** 20fa */
  async delayTicks(ticks) {
    await platform.delayTicks(ticks);
  }

  /** 1b38: one blink of the cursor, then a poll; a key blanks the cursor. 0 if no key. */
  async waitKeyCursor() {
    const saved = textWindows.autoAdvance;
    textWindows.autoAdvance = 0;
    const frame = this.cursorFrame++;
    this.drawCursor(frame);
    const key = this.pollKey();
    if (((this.cursorFrame << 16) >> 16) >= ((this.cursor[1] << 16) >> 16)) this.cursorFrame = 0;
    if (key === 0) await this.delayTicks(1);
    else this.eraseCursor();
    textWindows.autoAdvance = saved;
    return key;
  }

  /** 1dda: up to `tries` blinks for a key (0 = forever); 0 if none came. */
  async waitKeyTimeout(tries) {
    let key;
    let count = tries !== 0 ? 0 : -1;
    do {
      key = await this.waitKeyCursor();
      if (tries !== 0) count++;
    } while (count < tries && key === 0);
    return key;
  }

  /** Says that the game starts (kind 'text' or 'number') or stops (null) waiting for typed text. */
  setTyping(kind) {
    this.typing = kind;
    if (this.onTyping) this.onTyping(kind);
  }

  /** A name typed at the cursor (up to maxLen): Backspace / left erase, Esc clears, Return ends. */
  async readName(maxLen) {
    let key, name = '';
    this.setTyping('text');
    do {
      key = await this.waitKeyTimeout(0);
      if ((key === 8 || key === KEY_LEFT) && name.length !== 0) {
        textWindows.eraseChars(1);
        name = name.slice(0, -1);
      } else if (key === 0x1b && name.length !== 0) {
        textWindows.eraseChars(name.length);
        name = '';
      } else if (key > 0x1f && key < 0x80 && name.length < maxLen) {
        name += String.fromCharCode(key);
        textWindows.putChar(key);
      }
      if (platform.quitRequested()) break;
    } while (key !== 0x0d);
    this.setTyping(null);
    return name;
  }

  /** 1b16: discards keys typed ahead. */
  flushKeyboard() {
    platform.flushKeys();
  }
}

export const input = new Input();
