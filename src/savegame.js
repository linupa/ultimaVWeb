// savegame.js - reading and writing saved games in the original's format, as the SaveGame class;
// `savegame` is the one object. Ported from the C++ port's savegame.cpp.
//
// SAVED.GAM (and INIT.GAM, the new game) is 0x1060 bytes: the original's data segment from
// ds:55A6 on. Each module that holds part of the saved state registers it, saying which bytes of
// the block it stands for; pack() builds the block from them and unpack() takes it apart. The
// bytes nobody holds are kept as they were loaded, so a file comes back unchanged.

export class SaveGame {
  static DS_OFFSET = 0x55a6;
  static SIZE = 0x1060;

  constructor() {
    this.pieces = [];
    this.rest = new Uint8Array(SaveGame.SIZE);
    this.header = 0; // the file's first word, which the game neither reads nor sets
    this.u16(0x55a6, this, 'header', 'savegame.header');
  }

  /** The general form: `size` bytes at ds:offset; pack(dst) writes them into dst, unpack(src) reads them. */
  add(dsOffset, size, pack, unpack, name) {
    const offset = dsOffset - SaveGame.DS_OFFSET;
    let problem = null;
    let other = '';
    if (offset < 0 || size <= 0 || offset + size > SaveGame.SIZE) problem = 'is outside the saved range';
    for (const p of this.pieces) {
      if (problem) break;
      if (offset < p.offset + p.size && p.offset < offset + size) {
        problem = 'overlaps ';
        other = p.name;
      }
    }
    if (problem) throw new Error(`SaveGame: ${name} (ds:${dsOffset.toString(16)}, ${size} bytes) ${problem}${other}`);
    this.pieces.push({ offset, size, pack, unpack, name });
  }

  /** A byte array held as it is (a Uint8Array, or the bytes behind struct views). */
  bytes(dsOffset, array, name) {
    this.add(dsOffset, array.length, (dst) => dst.set(array), (src) => array.set(src), name);
  }

  /** obj[key] as one byte. */
  u8(dsOffset, obj, key, name) {
    this.add(dsOffset, 1, (dst) => { dst[0] = obj[key]; }, (src) => { obj[key] = src[0]; }, name);
  }

  /** obj[key] as a little-endian word. */
  u16(dsOffset, obj, key, name) {
    this.add(dsOffset, 2, (dst) => { dst[0] = obj[key]; dst[1] = obj[key] >> 8; }, (src) => { obj[key] = src[0] | (src[1] << 8); }, name);
  }

  /** The saved game as the file's SIZE bytes. */
  pack() {
    const image = this.rest.slice();
    for (const p of this.pieces) p.pack(image.subarray(p.offset, p.offset + p.size));
    return image;
  }

  unpack(image) {
    this.rest.set(image.subarray(0, SaveGame.SIZE));
    for (const p of this.pieces) p.unpack(image.subarray(p.offset, p.offset + p.size));
  }

  /** For the tests: forgets the bytes no module holds (they become 0). */
  clearRest() {
    this.rest.fill(0);
  }
}

export const savegame = new SaveGame();
