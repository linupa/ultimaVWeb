// gamedata.js - the original game's data file, DATA.OVL, as the Data class; `data` is the one
// Data object. Ported from the C++ port's gamedata.h.
//
// The port keeps none of the game's tables or text in its own source: each module that owns
// some of them says, when it is created, which part of DATA.OVL it needs and where to put it
// (add), and data.load() reads the file once at start-up and hands every owner its part.
// Offsets are the original's data-segment offsets (ds:xxxx): the file offset less the 16-byte
// header, the same numbers as the decompiled source and the C++ port.

export const OWN = 0;
/** Two owners may not claim the same bytes unless one says SHARED (see the C++ gamedata.h). */
export const SHARED = 1;

export class Data {
  static SIZE = 0xbd40;
  static HEADER = 16;

  constructor() {
    this.pieces = [];
    this.loaded = false;
  }

  /** `fill(bytes)` gets the `size` bytes at ds:offset (a Uint8Array) when the file is loaded. */
  add(dsOffset, size, fill, name, sharing = OWN) {
    let problem = null;
    let other = '';
    if (this.loaded) problem = 'comes after DATA.OVL was loaded';
    else if (size <= 0 || dsOffset + size > Data.SIZE) problem = 'is outside DATA.OVL';
    for (const p of this.pieces) {
      if (problem) break;
      if (dsOffset < p.offset + p.size && p.offset < dsOffset + size && sharing === OWN && p.sharing === OWN) {
        problem = 'overlaps ';
        other = p.name;
      }
    }
    if (problem) throw new Error(`Data: ${name} (ds:${hex(dsOffset)}, ${size} bytes) ${problem}${other}`);
    this.pieces.push({ offset: dsOffset, size, fill, name, sharing });
  }

  /** Bytes into a Uint8Array or Int8Array, as they are. */
  bytes(dsOffset, array, name, sharing = OWN) {
    this.add(dsOffset, array.length, (b) => array.set(array instanceof Int8Array ? new Int8Array(b.buffer, b.byteOffset, b.length) : b), name, sharing);
    return array;
  }

  /** Little-endian 16-bit values into a Uint16Array or Int16Array (or a plain array: Strings ids). */
  words(dsOffset, array, name, sharing = OWN) {
    this.add(dsOffset, array.length * 2, (b) => {
      for (let i = 0; i < array.length; i++) {
        const w = b[i * 2] | (b[i * 2 + 1] << 8);
        array[i] = array instanceof Int16Array ? (w << 16) >> 16 : w;
      }
    }, name, sharing);
    return array;
  }

  /** Reads DATA.OVL from the game files and fills every owner. Throws if it is missing or wrong. */
  load(gameFiles, file = 'DATA.OVL') {
    const buf = gameFiles.get(file);
    if (!buf) throw new Error(`Data: cannot read ${file}`);
    if (buf.length !== Data.HEADER + Data.SIZE) throw new Error(`Data: ${file} is ${buf.length} bytes, not ${Data.HEADER + Data.SIZE}`);
    for (const p of this.pieces) p.fill(buf.subarray(Data.HEADER + p.offset, Data.HEADER + p.offset + p.size));
    this.loaded = true;
  }
}

function hex(n) {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

export const data = new Data();
