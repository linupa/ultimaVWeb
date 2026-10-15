// textbuf.js - the text buffer: 2000 bytes of scratch the game loads text into (conversations,
// shops, signs) and, at times, uses as the NPCs' path grid. Ported from the C++ port's textbuf.h.

export class TextBuffer {
  static SIZE = 2000;
  constructor() {
    this.data = new Uint8Array(TextBuffer.SIZE);
    this.outside = new Uint8Array(1); // the original reads and writes whatever lies past it
  }
  /** The byte at an offset (one outside the buffer reads a spare byte). */
  get(offset) {
    return offset >= 0 && offset < TextBuffer.SIZE ? this.data[offset] : this.outside[0];
  }
  set(offset, value) {
    if (offset >= 0 && offset < TextBuffer.SIZE) this.data[offset] = value;
    else this.outside[0] = value;
  }
  /** The NUL-ended text from offset, as the game prints it. */
  cString(offset = 0) {
    let s = '';
    for (let p = offset; p < TextBuffer.SIZE && this.data[p] !== 0; p++) s += String.fromCharCode(this.data[p]);
    return s;
  }
  word(offset) {
    return this.get(offset) | (this.get(offset + 1) << 8);
  }
}

export const textBuffer = new TextBuffer();
