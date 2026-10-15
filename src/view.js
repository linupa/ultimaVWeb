// view.js - the 11 x 11 map view: line of sight, light, objects, drawing and animation (main
// program 0000:44b8-0000:7040), as the View class; `view` is the one object. Ported from the C++
// port's view.cpp.
//
// mask (11 rows of 32 bytes) holds, per square, the terrain tile to draw, 0xFF if it can't be
// seen, or 0 if an object is there; tiles (11 rows of 16) then holds the object's tile, drawn as
// tile + 0x100. localMap holds the light map: per square of the 32 x 32 map window, non-zero if
// a light reaches it. The party is at view square (5, 5). The three lie one after another in one
// block as in the original: the line-of-sight code works on either the mask or the light map by
// an offset into the block, and near the edges it steps outside the one it was given.
import { combat } from './combat.js';
import { data } from './data/gamedata.js';
import { gfx } from './gfx.js';
import { gameTime } from './gametime.js';
import { M, map } from './map.js';
import { randomBetween } from './misc.js';
import { party } from './party.js';
import { savegame } from './savegame.js';
import { sound } from './sound.js';
import { tiles } from './tiles.js';
import { animateLightBeams, randomWindChange, updateMoongates } from './world.js';

const MASK = 0, TILES = 0x162, LOCAL_MAP = 0x212, SIZE = 0x612;

export class View {
  static MASK = MASK;
  static TILES = TILES;
  static LOCAL_MAP = LOCAL_MAP;

  constructor() {
    this.block = new Uint8Array(SIZE);
    this.mask = this.block.subarray(MASK, MASK + 0x160);
    this.tiles = this.block.subarray(TILES, TILES + 0xb0);
    this.localMap = this.block.subarray(LOCAL_MAP, LOCAL_MAP + 0x400);
    this.outside = 0; // what an offset outside the block reads and writes
    this.tileAnimMap = new Uint8Array(256); // tile -> the tile shown for it now
    this.rebuild = true; // the next worldTick works out sight and light afresh
    this.animTick = 0;
    // Saved state.
    this.animFlag = 0; // 0 = no animation step this tick, 0xFF = never
    this.aimMode = 0;
    this.worldTickEnabled = 0;
    this.lightRadius = 0; // 50 day, 2 night/underground, ...; > 0x32 = fixed
    const s = savegame;
    s.u8(0x5891, this, 'animFlag', 'view.animFlag');
    s.u8(0x5898, this, 'aimMode', 'view.aimMode');
    s.u8(0x58a4, this, 'worldTickEnabled', 'view.worldTickEnabled');
    s.u8(0x58a5, this, 'lightRadius', 'view.lightRadius');
    // Read-only tables, from DATA.OVL.
    this.animScripts = data.bytes(0x1b18, new Uint8Array(0xb0), 'view.animScripts'); // 16 bytes a script
    this.animScriptOf = data.bytes(0x1bc8, new Uint8Array(51), 'view.animScriptOf'); // by tile group from 0x34
    this.seeAcrossBits = data.bytes(0x6a14, new Uint8Array(32), 'view.seeAcrossBits');
    this.dawnRadii = data.bytes(0x6a80, new Uint8Array(6), 'view.dawnRadius');
    this.opaqueTiles = data.bytes(0x6a86, new Uint8Array(19), 'view.opaqueTiles');
    this.lightTiles = data.bytes(0x6a9a, new Uint8Array(10), 'view.lightTiles');
    this.distances = data.bytes(0x6aa8, new Uint8Array(36), 'view.distance'); // a 6 x 6 quarter of the view
  }

  /** The byte at an offset of the block (one outside it is a spare byte). */
  at(off) {
    return off >= 0 && off < SIZE ? this.block[off] : this.outside;
  }
  put(off, v) {
    if (off >= 0 && off < SIZE) this.block[off] = v;
    else this.outside = v & 0xff;
  }
  maskAt(r, c) { return this.at(MASK + r * 0x20 + c); }
  setMask(r, c, v) { this.put(MASK + r * 0x20 + c, v); }
  setTiles(r, c, v) { this.put(TILES + r * 0x10 + c, v); }

  seenAcross(tile) {
    return (0x80 >> (tile & 7)) & this.seeAcrossBits[tile >> 3];
  }
  dawnRadius(tensOfMinutes) {
    return this.dawnRadii[tensOfMinutes < 6 ? tensOfMinutes : 5];
  }

  resetTileAnimMap() {
    for (let i = 0; i < 256; i++) this.tileAnimMap[i] = i;
  }

  /** 6ff0: distance from the centre: 0 there, 0x32 in the corners. */
  viewDistanceLevel(y, x) {
    if (x >= 0x0b || y >= 0x0b || x < 0 || y < 0) return 0;
    if (x > 5) x = 10 - x;
    if (y > 5) y = 10 - y;
    return this.distances[y * 6 + x];
  }

  /** 5dfe: true if sight passes the tile. 0x4A, 0x4B, 0xBA, 0xBB, 0x98 only from next to it. */
  isTransparent(level, tile) {
    if (tile === 0x4b || tile === 0x4a || tile === 0xba || tile === 0xbb || tile === 0x98) return level === 1;
    return !this.opaqueTiles.includes(tile);
  }

  /**
   * 5a28: breadth-first from the centre (5,5) of an 11 x 11 area, numbered from (x0, y0) relative
   * to the map origin. View mode (row === -0x6F, mask = MASK): what the party sees. Light mode
   * (mask = LOCAL_MAP at the source): the squares a light reaches, the mask as the visited set.
   */
  computeLineOfSight(mask, col, row, x0, y0, radius) {
    if (radius <= 0) return;
    const queue = new Int32Array(257);
    let head = 0, tail = 2;
    const viewMode = row === -0x6f;
    if (viewMode) row = 0;
    queue[0] = 5;
    queue[1] = 5;
    this.put(mask + row * 0x20 + col + 0xa5, map.getTile(y0 + map.originY + 5, x0 + map.originX + 5));
    while (head !== tail) {
      const pr = queue[head], pc = queue[head + 1];
      head += 2;
      let r = pr, c = pc;
      for (let dir = 7; dir >= 0; dir--) { // round the 8 neighbours
        switch (dir) {
          case 0: case 1: case 7: c--; break;
          case 2: case 3: r--; break;
          case 4: case 5: c++; break;
          case 6: r++; break;
        }
        let ok = c >= 0 && c <= 10 && r >= 0 && r <= 10;
        const p = mask + (row + r) * 0x20 + col + c;
        if (viewMode) {
          if (this.at(p) !== 0xff) ok = false;
        } else if (this.maskAt(r, c) === 0 || row + r > 0x1f) {
          ok = false;
        } else {
          this.setMask(r, c, 0);
        }
        if (!ok) continue;
        let t = map.getTile(y0 + r + map.originY, x0 + c + map.originX);
        const level = this.viewDistanceLevel(r, c);
        if (level < radius + 1) {
          this.put(p, t);
        } else if (viewMode) {
          const litHere = this.at(LOCAL_MAP + c + (y0 + r) * 0x20 + x0) !== 0;
          if (!this.isTransparent(level, t)) {
            if (this.at(mask + pr * 0x20 + pc) === 0 || this.at(LOCAL_MAP + pc + (y0 + pr) * 0x20 + x0) === 0 || !litHere) {
              this.put(p, 0xff);
              t = 0xff;
            } else {
              this.put(p, t);
            }
          } else if (y0 + r >= 0 && x0 + c >= 0 && x0 + c < 0x20 && y0 + r < 0x20 && litHere) {
            this.put(p, t);
          } else {
            this.put(p, 0); // dark but see-through: keep looking past it
          }
        } else {
          t = 0xff;
        }
        if (this.isTransparent(level, t) && tail < 256) {
          queue[tail++] = r;
          queue[tail++] = c;
        }
      }
    }
  }

  /** 5d0a: y, x the party relative to the origin. radius < 0: no line of sight, the whole 11 x 11. */
  computeViewMask(y, x, radius) {
    for (let r = 0; r < 11; r++) this.mask.fill(0xff, r * 0x20, r * 0x20 + 11);
    if (radius > 0) {
      this.computeLineOfSight(MASK, 0, -0x6f, x - 5, y - 5, radius);
      for (let r = 0; r < 11; r++) for (let c = 0; c < 11; c++) if (this.maskAt(r, c) === 0) this.setMask(r, c, 0xff);
    }
    if (radius < 0)
      for (let r = 0; r < 11; r++)
        for (let c = 0; c < 11; c++) this.setMask(r, c, map.getTile(map.originY + y - 5 + r, x - 5 + c + map.originX));
  }

  /** 5e4a: light from the sources in the 32 x 32 window (up to 32 of them). */
  updateLightMap() {
    const sources = [];
    this.localMap.fill(0xff);
    for (let y = 0; y < 0x20; y++)
      for (let x = 0; x < 0x20; x++) {
        const t = map.getTile(y + map.originY, map.originX + x);
        if (this.lightTiles.includes(t) && sources.length < 64) {
          sources.push(y, x);
          this.localMap[y * 0x20 + x] = t;
        }
      }
    for (let i = 0; i < sources.length; i += 2) {
      const sy = sources[i] - 5, sx = sources[i + 1] - 5;
      for (let r = 0; r < 11; r++) this.mask.fill(0xff, r * 0x20, r * 0x20 + 11);
      this.computeLineOfSight(LOCAL_MAP, sx, sy, sx, sy, 10);
    }
    for (let i = 0; i < 0x400; i++) if (this.localMap[i] === 0xff) this.localMap[i] = 0;
  }

  /** 51a0 */
  randomAnimFrame() {
    return party.activeSpell === 0x54 ? 0 : randomBetween(3, 0); // 'T' time stop freezes
  }

  /** 51b8: people sitting in chairs, lying in beds, at the forge... by the terrain under them. */
  viewObjectFixup(tile, y, x, row, col) {
    if (tile === 0x1c || (tile >= 0x12 && tile <= 0x15) || tile >= 0x40 || (tile >= 0x28 && tile <= 0x2b)) {
      const u = map.getTile(y, x);
      if (u === 0xec || u === 0x0a) return; // hidden
      if (u === 0x57) {
        this.setMask(row, col, 0x38);
        return;
      }
      if (u === 0x6a || u === 0x6b) {
        if ((tile & 0xf0) === 0x80 || (tile & 0xfc) === 0x28) return;
      } else if (tile <= 0x7f) {
        let done = true;
        switch (u) {
          case 0x92: tile = map.getTile(y + 1, x) === 0x9a || map.getTile(y + 1, x) === 0x9c ? this.randomAnimFrame() + 0x34 : 0x32; break;
          case 0x84: tile = this.randomAnimFrame() + 0x60; break;
          case 0x85: tile = this.randomAnimFrame() + 0x64; break;
          case 0x90: tile = map.getTile(y - 1, x) === 0x9b || map.getTile(y - 1, x) === 0x9c ? this.randomAnimFrame() + 0x38 : 0x30; break;
          case 0x91: case 0x93: tile = (u & 3) + 0x30; break;
          case 0x9d: case 0x9e: tile = this.randomAnimFrame() + 0x3c; break;
          case 0xab: tile = 0x1a; break;
          case 0xc8: tile = 0x17; break;
          case 0xc9: tile = 0x18; break;
          default: done = false;
        }
        // under the top half of a bed (0x9D) the square above shows 0x9E
        if (!done && map.getTile(y - 1, x) === 0x9d && row !== 0) this.setMask(row - 1, col, 0x9e);
      }
    }
    this.setTiles(row, col, tile & 0xff);
    this.setMask(row, col, 0);
  }

  /** 5394: the objects into the view, the last first so object 0 (the party) ends up on top. */
  updateViewObjects() {
    const objs = map.objects;
    if (!map.inScene()) {
      const p = objs.at(0);
      p.x = map.x;
      p.y = map.y;
      p.z = map.z;
      p.tile = party.transport;
      p.tile2 = party.transport;
      for (let r = 0; r < 11; r++) // 0xDD and 0x1C swap with distance from the party
        for (let c = 0; c < 11; c++) {
          if (this.maskAt(r, c) === 0xdd && this.viewDistanceLevel(r, c) > 5) this.setMask(r, c, 0x1c);
          else if (this.maskAt(r, c) === 0x1c && this.viewDistanceLevel(r, c) < 6) this.setMask(r, c, 0xdd);
        }
    }
    for (let i = 31; i >= 0; i--) {
      const o = objs.at(i);
      if (o.tile === 0) continue;
      let col = o.x, row = o.y;
      if (!map.inScene()) {
        col = (o.x - (map.x - 5)) & 0xff;
        row = (o.y - (map.y - 5)) & 0xff;
        if (o.z !== map.z || col > 10 || row > 10) continue;
      }
      const m = this.maskAt(row, col);
      if (o.tile2 === 0 || m === 0xff || m === 0x87) continue;
      if ((o.tile & 0xfc) === 0xe8 || o.tile === 0x1e || o.tile === 0x1f) { // fields
        if (m !== 0) {
          this.setTiles(row, col, o.tile2);
          this.setMask(row, col, 0);
        }
      } else if (o.tile2 === 0x1d || o.tile2 === 0x1e) {
        this.setTiles(row, col, o.tile2);
        this.setMask(row, col, 0);
      } else if (o.tile === 0x5c && m === 0x92) {
        this.setTiles(row, col, o.tile2);
        this.setMask(row, col, 0);
      } else {
        this.viewObjectFixup(o.tile === 0x5c ? o.tile2 - 8 : o.tile2, o.y, o.x, row, col);
      }
    }
  }

  /** 56ac */
  drawView() {
    for (let r = 0; r < 11; r++)
      for (let c = 0; c < 11; c++) {
        const m = this.maskAt(r, c);
        if (m === 0) {
          const t = this.at(TILES + r * 0x10 + c);
          if (t !== 0x16) tiles.drawTileAt(r, c, 0x100 + t);
        } else if (m === 0xdc && gameTime.moongatePhase !== 0 && gameTime.moongatePhase < 0x10) {
          tiles.shimmerTiles(r, c, gameTime.moongatePhase, map.id === M.SCENE);
        } else {
          tiles.drawTileAt(r, c, this.tileAnimMap[m]);
        }
      }
    // In combat: every other draw, a frame around the fighter whose turn it is (if on the party's
    // side) and, while aiming, the cross-hairs.
    if (!map.inScene()) return;
    combat.redraw = combat.redraw === 0 ? 1 : 0;
    if (!combat.redraw || combat.turn === 0xff || combat.combatantSide(combat.turn) !== 0) return;
    const c = combat.combatants[combat.turn & 0x1f];
    const px = c.x * 0x10, py = c.y * 0x10;
    gfx.setDrawColor(gfx.colorText);
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 0x0f; j += 0x0e) {
        gfx.drawHline(px + 0x17, py + 8 + i + j, px + 8);
        gfx.drawVline(py + 0x17, py + 8, px + 8 + i + j);
      }
    if (this.aimMode === 0) return;
    const ax = combat.aimX * 0x10, ay = combat.aimY * 0x10;
    for (let i = 0; i < 2; i++) {
      const yOut = ay + 10 + 11 * i, yIn = ay + 14 + 3 * i, yGap = ay + 13 + 5 * i, row = ay + i + 15;
      for (let j = 0; j < 2; j++) {
        const xOut = ax + 10 + 11 * j, xIn = ax + 14 + 3 * j, xGap = ax + 13 + 5 * j, col = ax + j + 15;
        gfx.setDrawColor(gfx.colorText);
        gfx.drawLine(yIn, xIn, yIn, xOut);
        gfx.drawLineB(yOut, xIn);
        gfx.setDrawColor(0);
        gfx.drawLine(yGap, xGap, yGap, xOut);
        gfx.drawLineB(yOut, xGap);
        gfx.drawLine(row, xIn, row, xOut);
        gfx.drawLine(yOut, col, yIn, col);
      }
    }
  }

  /** 44b8 */
  cycleAnimatedTiles() {
    const m = this.tileAnimMap;
    for (let i = 0xd4; i < 0xd8; i++) if (++m[i] === 0xd8) m[i] = 0xd4;
    for (let i = 0xd8; i < 0xdc; i++) if (++m[i] === 0xdc) m[i] = 0xd8;
    if (this.animTick & 1) {
      for (let i = 0x80; i < 0x84; i++) m[i] ^= 1;
      for (let i = 0xec; i < 0xf0; i++) if (++m[i] === 0xf0) m[i] = 0xec;
      if (this.animTick & 2) for (let i = 0xfa; i < 0xfe; i++) m[i] ^= 1;
    }
    this.animTick = (this.animTick + 1) & 0xff;
  }

  /**
   * 4552: each object's flags: low nibble turns to wait (0xF never), high nibble its place in its
   * animation script. Script bytes: 1-4 show frame n-1; 5 / 6 random branches; 0 restart; 7 go
   * to step 2; 0x8n wait n turns.
   */
  animateObjects() {
    for (let i = 0; i < 32; i++) {
      const o = map.objects.at(i);
      if (o.tile === 0) continue;
      let wait = o.flags & 0x0f, step = o.flags >> 4;
      const base = o.tile & 0xfc;
      if (wait === 0x0f) continue;
      if (wait !== 0) {
        o.flags = (o.flags & 0xf0) + wait - 1;
        continue;
      }
      if (o.tile2 === 0 || o.tile2 === 0x1d || o.tile2 === 0x1e || base <= 0x33 || base === 0xe8 || base === 0xb4) continue;
      if (!(base === 0x5c || base === 0xa8 || randomBetween(0xff, 0) > 0x7f)) continue;
      const script = this.animScriptOf[(base - 0x34) >> 2];
      let done = false;
      do {
        const at = step + script * 0x10;
        const op = at < this.animScripts.length ? this.animScripts[at] : 0;
        switch (op) {
          case 1: case 2: case 3: case 4:
            o.tile2 = base + op - 1;
            step++;
            done = true;
            break;
          case 5:
            if (randomBetween(0xff, 0) > 0x3f) { step++; break; }
            o.tile2 = o.tile;
            if (base === 0x5c) step++;
            else wait = 6;
            done = true;
            break;
          case 6:
            if (randomBetween(0xff, 0) > 0xbf) { step++; break; }
            step = 0;
            break;
          case 0: step = 0; break;
          case 7: step = 2; break;
          default:
            wait = (op + 0x80) & 0xff;
            step++;
            done = true;
        }
        o.flags = (step * 0x10 + wait) & 0xff;
      } while (!done);
    }
    this.cycleAnimatedTiles();
    tiles.animateTilesAlt();
  }

  /** 5910: animate, rebuild the view if something changed, draw it, and the ambient sounds. */
  async worldTick() {
    if (party.activeSpell === 0x54) this.animFlag = 0;
    if (this.worldTickEnabled) {
      if (this.animFlag) {
        if (this.animFlag !== 0xff) this.animateObjects();
        randomWindChange();
        if (!map.inScene()) {
          updateMoongates();
          animateLightBeams();
        }
      }
      if (!map.inScene()) {
        if (!this.rebuild) { // squares that showed an object get their terrain back
          for (let r = 0; r < 11; r++)
            for (let c = 0; c < 11; c++)
              if (this.maskAt(r, c) === 0) this.setMask(r, c, map.getTile(r + map.y - 5, c + map.x - 5));
        } else {
          this.computeViewMask(map.y - map.originY, map.x - map.originX, this.lightRadius);
          this.rebuild = false;
        }
      } else {
        this.mask.set(this.localMap.subarray(0, 0x160)); // combat: the 11 x 11 map is the view
      }
      this.updateViewObjects();
      this.drawView();
      if (this.animFlag) await sound.ambientSounds(map, this);
    }
    this.animFlag = 1;
  }
}

export const view = new View();
