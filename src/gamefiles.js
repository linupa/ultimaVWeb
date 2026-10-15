// gamefiles.js - the original game's files, as the player provides them.
//
// The port ships none of Ultima V's data: the player chooses their copy's folder, and the files
// are kept in memory (and in IndexedDB by store.js, so it is asked only once). The C++ port's
// files.cpp is the model: names are DOS names, matched without regard to case.

/** DATA.OVL is 16 bytes of header and the 0xBD40-byte data segment image. */
export const DATA_OVL_SIZE = 16 + 0xbd40;

/** Files the game cannot start without. */
export const REQUIRED = ['DATA.OVL', 'INIT.GAM', 'IBM.CH', 'RUNES.CH', 'TILES.16'];

export class GameFiles {
  constructor() {
    /** @type {Map<string, Uint8Array>} upper-case DOS name -> contents */
    this.files = new Map();
  }

  /** Adds a file by name (any case). */
  add(name, bytes) {
    this.files.set(baseName(name).toUpperCase(), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  /** Adds the files a folder picker or a drop gave (File objects). */
  async addFileList(fileList) {
    for (const file of fileList) this.add(file.name, new Uint8Array(await file.arrayBuffer()));
  }

  has(name) {
    return this.files.has(name.toUpperCase());
  }

  /** The file's bytes, or undefined. */
  get(name) {
    return this.files.get(name.toUpperCase());
  }

  /** The required files that are missing, and a reason if one is there but wrong. */
  check() {
    const missing = REQUIRED.filter((name) => !this.has(name));
    const data = this.get('DATA.OVL');
    const problem = data && data.length !== DATA_OVL_SIZE ? `DATA.OVL is ${data.length} bytes, not ${DATA_OVL_SIZE}` : null;
    return { missing, problem, ok: missing.length === 0 && !problem };
  }
}

function baseName(path) {
  return path.split(/[\\/]/).pop();
}
