// files.js - the game's files: the player's copy (read-only) and the files the game writes
// (SAVED.GAM, the .OOL files), which are kept apart so the copy is never changed. Ported from the
// C++ port's files.cpp and the file helpers in map.cpp.
import { lzwDecompress } from './data/lzw.js';
import { pictures } from './data/pictures.js';

class Files {
  constructor() {
    /** @type {import('./gamefiles.js').GameFiles | null} */
    this.game = null;
    /** Files the game has written, by upper-case name. */
    this.written = new Map();
    /** Called with (name, bytes) after every write: the page keeps them (store.js). */
    this.onWrite = null;
  }

  /** A file's bytes: one the game wrote, else the player's copy; undefined if neither has it. */
  get(name) {
    const upper = name.toUpperCase();
    return this.written.get(upper) ?? this.game?.get(upper);
  }

  /** Writes a whole file (from offset 0). */
  put(name, bytes) {
    const copy = Uint8Array.from(bytes);
    this.written.set(name.toUpperCase(), copy);
    if (this.onWrite) this.onWrite(name.toUpperCase(), copy);
  }
}

export const files = new Files();

/** A whole game file, decompressed if it is one of the pictures (load_file_or_die); null if missing or bad. */
export function gameLoadFile(name) {
  const bytes = files.get(name);
  if (!bytes) return null;
  return pictures.has(name) ? lzwDecompress(bytes) : bytes;
}

/** 256e: `size` bytes from `offset` into buf. 0 on success, -1 if the file is missing or short. */
export function loadFilePart(offset, size, buf, name) {
  const bytes = files.get(name);
  if (!bytes || offset + size > bytes.length) {
    if (bytes && offset < bytes.length) buf.set(bytes.subarray(offset)); // what there is
    return -1;
  }
  buf.set(bytes.subarray(offset, offset + size));
  return 0;
}

/** Writes the file from offset 0. */
export function saveFilePart(size, buf, name) {
  files.put(name, buf.subarray(0, size));
  return 0;
}
