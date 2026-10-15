// strings.js - the game's text, by name (S.Leather_Helm_0042 ...). The text comes from DATA.OVL
// when the game starts; `strings.get(id)` gives it as a JS string of byte values 0-255 (the
// game's control codes 0x80-0xFF included). Ported from the C++ port's strings.h.
import { data } from './gamedata.js';
import { S, TEXT_REGIONS } from './string-ids.js';

export { S };

export class Strings {
  constructor() {
    this.regions = TEXT_REGIONS.map(([start, end]) => ({ start, end, text: new Uint8Array(end - start) }));
    for (const r of this.regions) data.bytes(r.start, r.text, 'strings');
  }

  /** The text of a string. An id outside DATA.OVL's text gives "" (and a warning). */
  get(id) {
    if (id === S.NONE) return '';
    for (const r of this.regions) {
      if (id >= r.start && id < r.end) {
        let end = id - r.start;
        while (end < r.text.length && r.text[end] !== 0) end++;
        return latin1(r.text.subarray(id - r.start, end));
      }
    }
    console.warn(`Strings: no string 0x${id.toString(16)}`);
    return '';
  }
}

/** Bytes as a JS string, one character per byte. */
export function latin1(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

export const strings = new Strings();
