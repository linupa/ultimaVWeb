// keys.js - key codes as the game sees them (poll_key, 0000:1d5e): ASCII for ordinary keys
// (8 backspace, 0x0D return, 0x1B escape), plus these for extended keys. Same values as the C++
// port's platform.h.

export const KEY_LEFT = 0x01;
export const KEY_RIGHT = 0x02;
export const KEY_UP = 0x03;
export const KEY_DOWN = 0x04;
export const KEY_F1 = 0xc9; // F1-F10 = 0xC9-0xD2
export const KEY_HOME = 0xd3;
export const KEY_END = 0xd4;
export const KEY_PGUP = 0xd5;
export const KEY_PGDN = 0xd6;
export const KEY_BACKSPACE = 0x08;
export const KEY_TAB = 0x09;
export const KEY_RETURN = 0x0d;
export const KEY_ESCAPE = 0x1b;

const NAMED = {
  Backspace: KEY_BACKSPACE,
  Tab: KEY_TAB,
  Enter: KEY_RETURN,
  Escape: KEY_ESCAPE,
  ArrowLeft: KEY_LEFT,
  ArrowRight: KEY_RIGHT,
  ArrowUp: KEY_UP,
  ArrowDown: KEY_DOWN,
  Home: KEY_HOME,
  End: KEY_END,
  PageUp: KEY_PGUP,
  PageDown: KEY_PGDN,
};

/**
 * The game's key for a browser keydown event ({key, code, shiftKey, ctrlKey, altKey, metaKey}),
 * as { key, shifted }, or null for keys the game doesn't see (Shift alone, Alt+..., ...).
 * Mirrors SdlPlatform::key_down: keypad digits report Shift, Ctrl+letter gives 1-26 as the
 * BIOS does.
 */
export function keyFromEvent(e) {
  const shifted = e.shiftKey ? 1 : 0;
  if (e.altKey || e.metaKey) return null;
  if (e.code && e.code.startsWith('Numpad') && /^Numpad[1-9]$/.test(e.code)) {
    // with NumLock off the browser reports arrows etc. for the keypad; the game wants the digit
    return { key: e.code.charCodeAt(6), shifted };
  }
  if (e.key in NAMED) return { key: NAMED[e.key], shifted };
  const f = /^F([1-9]|10)$/.exec(e.key);
  if (f) return { key: KEY_F1 + Number(f[1]) - 1, shifted };
  if (e.ctrlKey) {
    const letter = /^Key([A-Z])$/.exec(e.code ?? '');
    return letter ? { key: letter[1].charCodeAt(0) - 0x40, shifted } : null;
  }
  if (e.key.length === 1) {
    const c = e.key.charCodeAt(0);
    if (c >= 0x20 && c < 0x7f) return { key: c, shifted: 0 };
  }
  return null;
}
