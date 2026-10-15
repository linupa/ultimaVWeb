// tiles.js - the 16 x 16 tile set (TILES.16) and the driver's tile functions, as the Tiles class;
// `tiles` is the one object. Ported from the C++ port's tiles.cpp (EGA only).
//
// Tiles 0-255 are terrain, 256-511 objects, vehicles and creatures. The set is kept in EGA.DRV's
// planar layout (drv 0x48 converts it at load): 128 bytes a tile, byte (row * 8 + half * 4 + plane)
// holds 8 pixels (bit 7 = left) of one colour plane. The per-turn animation edits these bytes
// directly, so the port keeps the layout.
import { gameLoadFile } from './files.js';
import { video, SCREEN_W, SCREEN_H } from './video/video.js';

export const TILE_COUNT = 512;
export const TILE_BYTES = 128;

class Tiles {
  constructor() {
    this.data = new Uint8Array(TILE_COUNT * TILE_BYTES);
    this.originX = 8; // where view square (0, 0) is drawn
    this.originY = 8;
    this.width = 16; // the only size the driver draws
    this.height = 16;
    this.drvRand = 0x7664; // EGA.DRV cs:1F94, the driver's own generator
  }

  /** 0ff4 + drv 0x48: TILES.16 is 4 bits a pixel, high nibble first. True if loaded. */
  loadTileset(filename) {
    const packed = gameLoadFile(filename);
    if (!packed || packed.length < TILE_COUNT * TILE_BYTES) return false;
    this.data.fill(0);
    for (let t = 0; t < TILE_COUNT; t++)
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          const b = packed[t * TILE_BYTES + y * 8 + (x >> 1)];
          const c = x & 1 ? b & 0x0f : b >> 4;
          for (let p = 0; p < 4; p++) if (c & (1 << p)) this.data[t * TILE_BYTES + y * 8 + (x >> 3) * 4 + p] |= 0x80 >> (x & 7);
        }
    return true;
  }

  /** The colour of one pixel of a tile. */
  tilePixel(tile, x, y) {
    const row = (tile & (TILE_COUNT - 1)) * TILE_BYTES + y * 8 + (x >> 3) * 4;
    let c = 0;
    for (let p = 0; p < 4; p++) if (this.data[row + p] & (0x80 >> (x & 7))) c |= 1 << p;
    return c;
  }

  /** 10e0 + drv 0x51: view square (row, col), at (originX + col * 16, originY + row * 16). */
  drawTileAt(row, col, tile) {
    if (this.width !== 16 || this.height !== 16) return;
    const x0 = this.originX + col * 16, y0 = this.originY + row * 16;
    for (let y = 0; y < 16; y++) {
      if (y0 + y < 0 || y0 + y >= SCREEN_H) continue;
      for (let x = 0; x < 16; x++) {
        if (x0 + x >= 0 && x0 + x < SCREEN_W) video.draw[(y0 + y) * SCREEN_W + x0 + x] = this.tilePixel(tile, x, y);
      }
    }
  }

  tb(tile) {
    return tile * TILE_BYTES;
  }

  /** drv 0x60 with carry set: a moongate risen `frame` rows, drawn through scratch tile 0x116. */
  shimmerTiles(row, col, frame, inScene) {
    frame = Math.max(0, Math.min(16, frame));
    const scratch = this.tb(0x116), rowBytes = TILE_BYTES / 16;
    const saved = this.data.slice(scratch, scratch + TILE_BYTES);
    this.data.copyWithin(scratch, this.tb(inScene ? 0x44 : 5), this.tb(inScene ? 0x44 : 5) + TILE_BYTES);
    this.data.copyWithin(scratch + TILE_BYTES - frame * rowBytes, this.tb(0xdc), this.tb(0xdc) + frame * rowBytes);
    this.drawTileAt(row, col, 0x116);
    this.data.set(saved, scratch);
  }

  drvRandom() {
    let a = (this.drvRand + 0x9248) & 0xffff;
    a = ((a >> 3) | (a << 13)) & 0xffff; // ror 3
    this.drvRand = ((a ^ 0x9248) + 0x11) & 0xffff;
    return this.drvRand & 0xff;
  }

  /** Scrolls a tile down one pixel row, the last row wrapping to the top. */
  scrollDown(tile) {
    const t = this.tb(tile), rb = TILE_BYTES / 16;
    const last = this.data.slice(t + TILE_BYTES - rb, t + TILE_BYTES);
    this.data.copyWithin(t + rb, t, t + TILE_BYTES - rb);
    this.data.set(last, t);
  }

  /** Where the mask's plane 3 is set, the tile shows the background's pixels. */
  composite(tile, mask, back, inverted = false) {
    const s = this.tb(tile), m = this.tb(mask), w = this.tb(back), d = this.data;
    for (let i = 0; i < TILE_BYTES; i += 4) {
      const m3 = inverted ? ~d[m + i + 3] & 0xff : d[m + i + 3];
      for (let p = 0; p < 4; p++) d[s + i + p] = (d[s + i + p] & ~m3 & 0xff) | (d[w + i + p] & m3);
    }
  }

  /** tile ^= field & mask */
  xorMasked(tile, mask, field) {
    const s = this.tb(tile), m = this.tb(mask), f = this.tb(field), d = this.data;
    for (let i = 0; i < TILE_BYTES; i++) d[s + i] ^= d[f + i] & d[m + i];
  }

  /** Swaps 4 bytes (a half row, all planes) with the same half two rows below (EGA.DRV 0x24b4). */
  swapHalf(off) {
    const d = this.data;
    for (let i = 0; i < 4; i++) [d[off + i], d[off + 0x10 + i]] = [d[off + 0x10 + i], d[off + i]];
  }

  /** 6fd6 + drv 0x60 (carry clear), once a turn: water flows, fields flicker, flags flutter. */
  animateTilesAlt() {
    const d = this.data;
    for (let i = 0; i < TILE_BYTES; i += 4) { // fields 0x1E8-0x1EB: new random pixels
      const r = this.drvRandom();
      const a = this.tb(0x1e8) + i, b = this.tb(0x1e9) + i, c = this.tb(0x1ea) + i, e = this.tb(0x1eb) + i;
      d[a + 3] = r; d[b + 3] = r; d[c + 3] = r; d[e + 3] = r;
      d[b + 2] = r; d[c + 2] = r;
      d[a + 1] = r;
      d[b] = r; d[e] = r;
    }
    for (const t of [1, 2, 3, 0x8f]) this.scrollDown(t);
    for (let i = 0; i < 16; i++) this.composite(0x60 + i, 0x70 + i, 3);
    this.composite(0x108, 0x100, 0x1eb);
    this.composite(0x1b4, 0x100, 0x1e9);
    for (let i = 0; i < 4; i++) this.composite(0x34 + i, 0xd0 + i, 3);
    for (let i = 0; i < 4; i++) this.composite(0xe4 + i, 0xd0 + i, 3, true);
    for (let i = 0; i < 4; i++) this.xorMasked(0xb0 + i, 0xc0 + i, 0x1ea);
    for (let i = 0; i < 4; i++) this.xorMasked(0xbc + i, 0xcc + i, 0x1ea);
    this.xorMasked(0xde, 0xc2, 0x1eb);
    const r = this.drvRand;
    if (r & 0x01) { this.swapHalf(0x900); this.swapHalf(0x904); }
    if (r & 0x02) this.swapHalf(0xa10);
    if (r & 0x04) { this.swapHalf(0xa80); this.swapHalf(0xa84); }
    if (r & 0x08) { this.swapHalf(0x1f00); this.swapHalf(0x1f04); }
    if (r & 0x10) this.swapHalf(0x908c);
    if (r & 0x20) this.swapHalf(0x9188);
    if (r & 0x40) this.swapHalf(0x968c);
    if (r & 0x01) this.swapHalf(0x9788);
  }

  /** 71aa + drv 0x6C mode 2: the town clock's hands (tiles 0xFA, 0xFB) for the hour and minute. */
  patchTilesC(hour, minute) {
    const keep = [0xfe, 0x3f, 0xfe, 0xbf, 0xfe, 0x3f];
    const wipe = (t) => {
      for (let p = 0; p < 4; p++) {
        if (p === 2) continue;
        for (let i = 0; i < 6; i++) this.data[t + i * 4 + p] &= keep[i];
      }
    };
    const rowOf = [0x10, 0x10, 0x10, 0x18, 0x20, 0x20, 0x20, 0x20, 0x20, 0x18, 0x10, 0x10];
    const half = [4, 4, 4, 4, 4, 4, 4, 0, 0, 0, 0, 0];
    const bits = [0x80, 0x40, 0x40, 0x40, 0x40, 0x40, 0x80, 0x01, 0x01, 0x01, 0x01, 0x01];
    const hand = (h) => {
      const t = this.tb(0xfa) + rowOf[h] + half[h];
      for (let p = 0; p < 4; p++) {
        this.data[t + p] |= bits[h];
        this.data[t + p + TILE_BYTES] |= bits[h];
      }
    };
    wipe(this.tb(0xfa) + 0x10);
    wipe(this.tb(0xfb) + 0x10);
    if (hour >= 12) hour -= 12;
    hand(hour % 12);
    hand(Math.trunc(minute / 5) % 12);
  }

  /**
   * drv 0x6C modes 0 and 1: mode 0 saves row 14 of tiles 0xC8 and 0x117 and replaces it with row
   * 0; mode 1 puts the saved rows back. Used while a fight is on a two-way ladder.
   */
  ladderTilesPatch(restore) {
    if (!this.ladderSaved) this.ladderSaved = [new Uint8Array(8), new Uint8Array(8)];
    const rb = TILE_BYTES / 16;
    [0xc8, 0x117].forEach((tile, i) => {
      const t = this.tb(tile);
      if (restore) {
        this.data.set(this.ladderSaved[i], t + 14 * rb);
      } else {
        this.ladderSaved[i].set(this.data.subarray(t + 14 * rb, t + 15 * rb));
        this.data.copyWithin(t + 14 * rb, t, t + rb);
      }
    });
  }

  /**
   * 6f9e + drv 0x6C mode n + 3. Mode 3 swaps colour planes 1 and 2 of the tiles dungeon rooms are
   * built from, which trades green for red; calling it again swaps them back. Mode 4 recolours 22
   * tiles for the last scene through a colour table.
   */
  patchTiles(n) {
    if (n === 1) {
      const lastScene = [0x44, 0x5c, 0x5d, 0x90, 0x92, 0x94, 0x96, 0x9b, 0xab, 0xac, 0xaf,
        0xb0, 0xb1, 0xbf, 0xdc, 0x108, 0x10e, 0x11a, 0x138, 0x139, 0x13a, 0x13b];
      const colour = [0, 5, 4, 4, 2, 1, 2, 7, 8, 0xc, 0xc, 0xc, 0xa, 9, 0xe, 0xf];
      for (const tile of lastScene) {
        const t = this.tb(tile);
        for (let g = 0; g < TILE_BYTES; g += 4) {
          const out = [0, 0, 0, 0];
          for (let bit = 0x80; bit; bit >>= 1) {
            let c = 0;
            for (let p = 0; p < 4; p++) if (this.data[t + g + p] & bit) c |= 1 << p;
            c = colour[c];
            for (let p = 0; p < 4; p++) if (c & (1 << p)) out[p] |= bit;
          }
          for (let p = 0; p < 4; p++) this.data[t + g + p] = out[p];
        }
      }
      return;
    }
    const runs = [[5, 1], [0x1e, 1], [0x1f, 1], [0x4c, 1], [0xca, 1], [0x20, 7], [0x30, 8], [0x60, 16]];
    for (const [first, count] of runs) {
      const t = this.tb(first);
      for (let i = 0; i < count * TILE_BYTES; i += 4) {
        const a = this.data[t + i + 1];
        this.data[t + i + 1] = this.data[t + i + 2];
        this.data[t + i + 2] = a;
      }
    }
  }
}

export const tiles = new Tiles();
