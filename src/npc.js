// npc.js - the people of a settlement: schedules, movement and path finding (NPC.OVL), as the
// Npcs class; `npcs` is the one object. Ported from the C++ port's npc.cpp.
//
// Each town has up to 31 NPCs (slot 0 unused). From the .NPC file: schedules[n] (three entries of
// activity and x/y/z, four change times), type[n] (its tile, 0 = none) and the dialogue number.
// state[n].state: 0 none, 1 at its spot, 2 walking a path, 3 walking to stairs, 4/5 arriving from
// the floor above/below, 6/7 must go up/down to reach its spot, 8 its spot and it both elsewhere.
// Paths are stored run-length in paths[n * 32] as (count, direction) pairs; directions for
// stepInDir: 1 east, 2 north, 3 west, 4 south. All of it is part of the saved game.
import { data } from './data/gamedata.js';
import { loadFilePart } from './files.js';
import { gameTime } from './gametime.js';
import { map } from './map.js';
import { randomBetween } from './misc.js';
import { objectTileAt, randomUpto } from './objects.js';
import { savegame } from './savegame.js';
import { structView } from './struct.js';
import { textBuffer } from './textbuf.js';
import { town } from './town.js';
import { view } from './view.js';

/** An NPC's day: 16 bytes, as in the .NPC files and SAVED.GAM. The arrays are live views. */
class NpcSchedule {
  constructor(bytes, offset) {
    this.activity = bytes.subarray(offset, offset + 3);
    this.x = bytes.subarray(offset + 3, offset + 6);
    this.y = bytes.subarray(offset + 6, offset + 9);
    this.z = bytes.subarray(offset + 9, offset + 12);
    this.times = bytes.subarray(offset + 12, offset + 16);
  }
}

/** What an NPC is doing: 16 bytes of words, as in SAVED.GAM. */
const NpcState = structView({
  state: [0, 'u16'], x: [2, 'u16'], y: [4, 'u16'], z: [6, 'u16'],
  type: [8, 'u16'], dialogue: [10, 'u16'], object: [12, 'u16'], schedSlot: [14, 'u16'],
});

const s16 = (v) => ((v & 0xffff) << 16) >> 16;
const s8 = (v) => ((v & 0xff) << 24) >> 24;

// The path grid is the first 32 x 32 bytes of the text buffer. Per square: high nibble the
// direction it was reached from (1 W, 2 S, 3 E, 4 N as searched), low nibble 5 goal, 6 start;
// 0x90 blocked. The search's bounds check lets x or y reach 32, so it can touch the bytes just past.
const grid = (y, x) => textBuffer.get(y * 0x20 + x);
const setGrid = (y, x, v) => textBuffer.set(y * 0x20 + x, v);

export class Npcs {
  constructor() {
    this.type = new Uint8Array(32);
    this.scheduleBytes = new Uint8Array(32 * 16);
    this.schedules = Array.from({ length: 32 }, (_, i) => new NpcSchedule(this.scheduleBytes, i * 16));
    this.stateBytes = new Uint8Array(32 * 16);
    this.state = Array.from({ length: 32 }, (_, i) => new NpcState(this.stateBytes, i * 16));
    this.paths = new Uint8Array(1024);
    this.pathPos = new Uint16Array(32);
    this.blockedTurns = new Uint16Array(32);
    this.event = 0; // 'a' (0x61) = an NPC is attacking, 't' = wants to talk
    this.eventSlot = 0;
    // A bit per NPC dead or gone, by location 1-0x20; 33 words (Serpent's Hold uses the 33rd,
    // which the original shares with the "met" table).
    this.deadBits = new Uint32Array(33);
    const s = savegame;
    s.bytes(0x5b56, new Uint8Array(this.deadBits.buffer), 'npcs.deadBits');
    s.bytes(0x5d5e, this.scheduleBytes, 'npcs.schedules');
    s.bytes(0x5f5e, this.stateBytes, 'npcs.state');
    s.bytes(0x615e, this.paths, 'npcs.paths');
    s.bytes(0x655e, new Uint8Array(this.pathPos.buffer), 'npcs.pathPos');
    s.bytes(0x659e, this.type, 'npcs.type');
    s.u8(0x65be, this, 'event', 'npcs.event');
    s.u8(0x65bf, this, 'eventSlot', 'npcs.eventSlot');
    s.bytes(0x65c2, new Uint8Array(this.blockedTurns.buffer), 'npcs.blockedTurns');
    this.walkableBits = data.bytes(0x367e, new Uint8Array(32), 'npcs.walkableBits'); // set = an NPC can't step there
  }

  sx(npc) { return s16(this.state[npc].x); }
  sy(npc) { return s16(this.state[npc].y); }

  /** a290: the town's NPCs from its .NPC file. */
  loadTownNpcs() {
    const dialogue = new Uint8Array(32);
    const group = map.kind();
    const offset = ((map.id - 1) - group * 8) * 0x240;
    const file = map.npcFile();
    loadFilePart(offset, 0x200, this.scheduleBytes, file);
    loadFilePart(offset + 0x200, 0x20, this.type, file);
    loadFilePart(offset + 0x220, 0x20, dialogue, file);
    for (let i = 0; i < 32; i++) this.state[i].dialogue = dialogue[i];
  }

  /** a366 */
  initNpcStates(hour) {
    for (let npc = 1; npc < 32; npc++) {
      const s = this.state[npc];
      if (this.type[npc] !== 0) {
        const slot = this.currentScheduleSlot(hour, npc);
        const sc = this.schedules[npc];
        s.state = 1;
        s.x = sc.x[slot];
        s.y = sc.y[slot];
        s.z = sc.z[slot];
        s.type = this.type[npc];
        s.schedSlot = slot;
        s.object = 0;
        this.pathPos[npc] = 0xffff;
        this.paths[npc * 0x20] = 0;
        this.blockedTurns[npc] = 0;
      } else {
        s.state = 0;
      }
    }
  }

  /** a430: to the nearest up (0xC8) or down (0xC9) stairs; the stairs found, or null. */
  npcPathToStairs(npc, up, y, x) {
    return this.npcFindPath(npc, up ? -1 : -2, 0, 0, y, x);
  }

  /** a462 */
  buildPathGrid(npc, mode, destY, destX, startY, startX) {
    const stairs = mode === -1 ? 0xc8 : 0xc9;
    const slot = this.currentScheduleSlot(gameTime.hour, npc);
    for (let y = 0; y < 0x20; y++)
      for (let x = 0; x < 0x20; x++) {
        setGrid(y, x, this.npcSquareWalkable(slot, npc, map.z, y, x) === 0 ? 0x90 : 0);
        if (mode < 0 && map.buffer[y * 0x20 + x] === stairs) setGrid(y, x, 5);
      }
    for (let i = 31; i > 0; i--) { // creatures (and the party) within 4 squares block
      const o = map.objects.at(i);
      if (o.tile > 0x3f && this.manhattanDistance(this.sy(npc), this.sx(npc), o.y, o.x) < 4) setGrid(o.y, o.x, 0x90);
    }
    const p = map.objects.at(0);
    if (this.manhattanDistance(this.sy(npc), this.sx(npc), p.y, p.x) < 4) setGrid(p.y, p.x, 0x90);
    if (mode >= 0) setGrid(destY, destX, 5);
    setGrid(startY, startX, 0x46);
  }

  /** a5bc: breadth-first over a 32-entry circular queue. The goal square reached ({x, y}), or null. */
  npcFindPath(npc, mode, destY, destX, startY, startX) {
    const qx = new Uint8Array(32), qy = new Uint8Array(32);
    let head = 0, tail = 1;
    this.buildPathGrid(npc, mode, destY, destX, startY, startX);
    qx[0] = startX;
    qy[0] = startY;
    for (;;) {
      let x = qx[head], y = qy[head];
      let dir = grid(y, x) >> 4;
      let goal = null;
      for (let n = 0; n < 4; n++) {
        let out = false;
        switch (dir) {
          case 1: if (--x < 0) out = true; break;
          case 2: if (++y > 0x20) out = true; break;
          case 3: if (++x > 0x20) out = true; break;
          case 4: if (--y < 0) out = true; break;
        }
        if (!out && grid(y, x) < 0x10) {
          const old = grid(y, x) & 0x0f;
          setGrid(y, x, dir << 4);
          if (old === 5) {
            goal = { x, y };
            break;
          }
          if (tail !== head) { // a full queue drops the square
            qx[tail] = x;
            qy[tail] = y;
            tail++;
          }
          if (tail >= 0x20) tail = 0;
        }
        dir = (dir & 3) + 1;
        x = qx[head];
        y = qy[head];
      }
      if (goal) return goal;
      if (++head === 0x20) head = 0;
      if (head === tail) return null;
    }
  }

  /** a73c: walks back from the goal collecting (count, direction) runs, then reverses them. */
  npcStorePath(destY, destX, mode, npc) {
    const base = npc * 0x20, path = this.paths;
    let count = 0, n = 0;
    this.pathPos[npc] = 0;
    let cell = grid(destY, destX), dir = cell >> 4, runDir = dir;
    do {
      cell &= 0x0f;
      switch (dir) { // undo the search step
        case 1: destX++; break;
        case 2: destY--; break;
        case 3: destX--; break;
        case 4: destY++; break;
      }
      if (runDir === dir && cell !== 6) count = (count + 1) & 0xff;
      if (runDir !== dir || cell === 6) {
        path[base + n] = count;
        path[base + n + 1] = runDir;
        n += 2;
        if (cell === 6) break;
        count = 1;
        runDir = dir;
      }
      cell = grid(destY, destX);
      dir = cell >> 4;
    } while (n < 0x20);
    for (let i = 0, j = n - 2; i <= j; i += 2, j -= 2) {
      const c = path[base + i], d = path[base + i + 1];
      path[base + i] = path[base + j];
      path[base + i + 1] = ((path[base + j + 1] + 1) & 3) + 1;
      path[base + j] = c;
      path[base + j + 1] = ((d + 1) & 3) + 1;
    }
    return n;
  }

  /** a8c2: moves pos one square (the original clamps against the other coordinate; kept). */
  stepInDir(dir, pos) {
    switch (dir) {
      case 1: pos.x = (pos.x + 1) & 0xffff; if (s16(pos.y) > 0x20) pos.x = 0x20; break;
      case 2: pos.y = (pos.y - 1) & 0xffff; if (s16(pos.x) < 0) pos.y = 0; break;
      case 3: pos.x = (pos.x - 1) & 0xffff; if (s16(pos.y) < 0) pos.x = 0; break;
      case 4: pos.y = (pos.y + 1) & 0xffff; if (s16(pos.x) > 0x20) pos.y = 0x20; break;
    }
  }

  /** a930 */
  manhattanDistance(y1, x1, y2, x2) {
    return Math.abs(x2 - x1) + Math.abs(y2 - y1);
  }

  /** a974: activities 3/6 keep away from the party, 4/5/7 approach; next to it, 4/5 talk and 6/7 attack. */
  npcFollowParty(slot, npc) {
    const s = this.state[npc];
    const activity = this.schedules[npc].activity[slot];
    const dist = [0, 0, 0, 0];
    const p = map.objects.at(0);
    let d = this.manhattanDistance(this.sy(npc), this.sx(npc), p.y, p.x);
    if (d === 1 && activity > 3) {
      if (activity === 4 || activity === 5) {
        if (s.dialogue !== 0) {
          this.event = 0x74; // 't'
          this.eventSlot = npc;
          return;
        }
      } else {
        this.event = 0x61; // 'a'
        this.eventSlot = npc;
        return;
      }
    }
    const py = p.y, px = p.x;
    for (let dir = 1; dir < 5; dir++) { // the distance after a step each way, 99 = can't
      const next = { x: s.x, y: s.y };
      this.stepInDir(dir, next);
      const nx = s16(next.x), ny = s16(next.y);
      dist[dir - 1] = this.npcCanStep(-1, npc, ny, nx) ? this.manhattanDistance(ny, nx, py, px) : 99;
    }
    d = this.manhattanDistance(this.sy(npc), this.sx(npc), p.y, p.x);
    let best = -1;
    for (let i = 1; i < 8; i++) {
      if (i < 5 && dist[i - 1] !== 99) {
        if (activity === 3) {
          if (dist[i - 1] > d) {
            if (best === -1 || randomBetween(1, 0) !== 0) best = i;
            if (i === 4) break;
          }
        } else if (dist[i - 1] < d) {
          best = i;
          break;
        }
      }
      // Steps 5-7 read past the distance array in the original (none of what lies there is 99)
      // and compare with the current distance; stepInDir(5-7) then doesn't move: stay put.
      if (i > 4 && dist[i - 5] === d) {
        best = i;
        break;
      }
    }
    if ((activity === 5 || activity === 7) && randomBetween(0x3f, 0) < 0x10) { // sometimes stray
      let alt = best;
      for (let j = 1; j < 5; j++) if (j !== best && dist[j - 1] !== 99 && (alt === best || randomBetween(0x3f, 0) < 0x10)) alt = j;
      best = alt;
    }
    if (best > -1) {
      const next = { x: s.x, y: s.y };
      this.stepInDir(best, next);
      const o = map.objects.at(s.object);
      s.x = next.x;
      o.x = next.x;
      s.y = next.y;
      o.y = next.y;
      view.rebuild = true;
    }
  }

  /** abc8: at a change hour, how the NPC gets to its new spot. The new slot + 1, or 0. */
  npcCheckSchedule(hour, npc) {
    const sc = this.schedules[npc], s = this.state[npc];
    let slot = -1;
    for (let i = 0; i < 4; i++) {
      if (sc.times[i] !== hour) continue;
      slot = this.currentScheduleSlot(hour, npc);
      if (s.schedSlot === slot) {
        s.state = 1;
      } else if (s.z === map.z || sc.z[slot] === map.z) {
        if (s.z === map.z) {
          if (sc.z[slot] === map.z) s.state = 2;
          else if (s8(map.z) < s8(sc.z[slot])) s.state = 6;
          else s.state = 7;
        } else if (s8(map.z) < s8(s.z)) {
          s.state = 4;
        } else {
          s.state = 5;
        }
      } else {
        s.state = 8;
      }
      break;
    }
    if (slot > -1 && s.x === sc.x[slot] && s.y === sc.y[slot] && s.z === sc.z[slot]) {
      slot = 0;
      s.state = 1;
    }
    return slot === -1 ? 0 : slot + 1;
  }

  /** acda */
  npcOnStairs(slot, npc) {
    const o = map.objects.at(this.state[npc].object);
    const t = map.getTile(o.y, o.x);
    if (s8(this.schedules[npc].z[slot]) < s8(map.z)) {
      if (t === 0xc9) return true;
    } else if (t === 0xc8) {
      return true;
    }
    return (t & 0xf4) === 0xc4;
  }

  /** ad6c: 2 = this slot's spot, 1 = walkable for NPCs, 0 = not. Stairs count while heading for them. */
  npcSquareWalkable(slot, npc, z, y, x) {
    const sc = this.schedules[npc];
    if (slot >= 0 && sc.x[slot] === x && sc.y[slot] === y && sc.z[slot] === z) return 2;
    let t = map.buffer[0x3ff];
    if (x >= 0 && y >= 0 && x < 0x20 && y < 0x20) t = map.buffer[x + y * 0x20];
    if (this.state[npc].state === 3 && (t === 0xc8 || t === 0xc9)) return 1;
    return (this.walkableBits[t >> 3] & (0x80 >> (t & 7))) === 0 ? 1 : 0;
  }

  /** ae2e: inside, walkable for this NPC, no object there. 0xFC walks anywhere; chairs only on a path. */
  npcCanStep(slot, npc, y, x) {
    if (x < 0 || x > 0x1f || y < 0 || y > 0x1f) return 0;
    const t = map.getTile(y, x);
    let ok;
    if (this.type[npc] === 0xfc || (t & 0xfc) === 0x30) ok = 1;
    else if ((t & 0xfc) === 0x90 && this.state[npc].state !== 2) ok = 0;
    else ok = this.npcSquareWalkable(slot, npc, map.z, y, x);
    if (ok === 0 || objectTileAt(map.z, y, x).tile !== 0) return 0;
    return ok;
  }

  /** aee0: half the time, one random step, staying within radius of its spot (0 = any). */
  npcWander(sched, npc, slot, radius, state) {
    if (!(randomBetween(0xff, 0) & 8)) return;
    const r = randomUpto(0x40);
    const next = { x: state.x, y: state.y };
    this.stepInDir((r & 3) + 1, next);
    const nx = next.x, ny = next.y;
    if ((radius === 0 || this.manhattanDistance(s16(ny), s16(nx), sched.y[slot], sched.x[slot]) <= radius) && this.npcCanStep(slot, npc, s16(ny), s16(nx))) {
      const o = map.objects.at(state.object);
      state.x = nx;
      o.x = nx;
      state.y = ny;
      o.y = ny;
      view.rebuild = true;
    }
  }

  /** af90: 0 stand, 1 wander within 3, 2 wander, 3/6 keep away when near, 4 approach to talk, 5/7 approach. */
  npcDoActivity(slot, npc) {
    const sc = this.schedules[npc];
    switch (sc.activity[slot]) {
      case 2:
        this.npcWander(sc, npc, slot, 0, this.state[npc]);
        break;
      case 3: case 6:
        if (this.manhattanDistance(this.sy(npc), this.sx(npc), map.y, map.x) > 3) return;
        this.npcFollowParty(slot, npc);
        break;
      case 5: case 7:
        this.npcFollowParty(slot, npc);
        break;
      case 4:
        if (this.manhattanDistance(sc.y[slot], sc.x[slot], map.y, map.x) < 4) {
          this.npcFollowParty(slot, npc);
          break;
        }
      // fall through
      case 1:
        this.npcWander(sc, npc, slot, 3, this.state[npc]);
        break;
    }
  }

  /** b044: once a town turn. */
  updateNpcs(hour) {
    let searched = 0; // only one path search a turn
    this.event = 0;
    this.eventSlot = 0;
    for (let npc = 1; npc < 0x20; npc++) {
      if (this.type[npc] === 0) continue;
      const slot = this.currentScheduleSlot(hour, npc);
      const s = this.state[npc], sc = this.schedules[npc];
      const base = npc * 0x20, path = this.paths;
      if (s16(s.state) <= 1 && this.npcCheckSchedule(hour, npc) === 0) {
        if (s.z === map.z) this.npcDoActivity(slot, npc);
        continue;
      }
      const state = s16(s.state);
      if (state <= 3) {
        if (this.pathPos[npc] < 0x8000 && path[base + this.pathPos[npc]] !== 0) { // follow the stored path a step
          const next = { x: s.x, y: s.y };
          this.stepInDir(path[base + this.pathPos[npc] + 1], next);
          const nx = next.x, ny = next.y;
          const can = this.npcCanStep(slot, npc, s16(ny), s16(nx));
          if (can === 0) {
            this.blockedTurns[npc]++;
            this.npcWander(sc, npc, slot, 0, s);
            if (s16(this.blockedTurns[npc]) > 3) {
              this.pathPos[npc] = 0xffff;
              this.blockedTurns[npc] = 0;
            }
          } else {
            const o = map.objects.at(s.object);
            o.x = nx;
            s.x = nx & 0xff;
            o.y = ny;
            s.y = ny & 0xff;
            view.rebuild = true;
            const pos = this.pathPos[npc];
            path[base + pos]--;
            this.blockedTurns[npc] = 0;
            if (path[base + pos] === 0) { // run finished: the next pair
              this.pathPos[npc]++;
              path[base + this.pathPos[npc]++] = 0;
              if (s16(this.pathPos[npc]) > 0x1f || path[base + this.pathPos[npc]] === 0) this.pathPos[npc] = 0xffff;
              if (can === 2) { // arrived
                s.schedSlot = slot;
                s.state = 1;
                this.pathPos[npc] = 0xffff;
              }
            }
          }
        } else if (this.pathPos[npc] === 0xffff && s.state === 3) {
          // reached the stairs: next turn it changes floor (the original returns here, skipping the rest)
          s.state = s8(map.z) < s8(sc.z[this.currentScheduleSlot(hour, npc)]) ? 6 : 7;
          return;
        } else if (searched < 1) {
          if (s.state !== 1) {
            if (s16(this.blockedTurns[npc]) < 200 && (this.blockedTurns[npc] === 0 || randomBetween(2, 0) === 1)) {
              if (this.pathPos[npc] === 0xffff) {
                searched++;
                if (this.npcFindPath(npc, 0, sc.y[slot], sc.x[slot], this.sy(npc), this.sx(npc))) {
                  this.npcStorePath(sc.y[slot], sc.x[slot], 0, npc);
                  this.blockedTurns[npc] = 0;
                  continue;
                }
                this.blockedTurns[npc] = 200; // no path: give up for a while
              }
              this.npcWander(sc, npc, slot, 0, s);
            } else {
              if (s16(this.blockedTurns[npc]) >= 200) this.blockedTurns[npc]++;
              if (s16(this.blockedTurns[npc]) > 0xcc) this.blockedTurns[npc] = 0;
            }
          }
        } else if (s.z === map.z) {
          this.npcDoActivity(s16(s.schedSlot), npc);
        }
      } else if (state === 4 || state === 5) {
        // coming from another floor: appear on the stairs nearest its spot, then walk
        if (searched === 1) continue;
        searched = 1;
        const mode = state === 4 ? 3 : 4;
        const stairs = this.npcPathToStairs(npc, mode === 3, sc.y[slot], sc.x[slot]);
        let ax = 0, ay = 0, found = !!stairs;
        if (found) {
          ax = stairs.x;
          ay = stairs.y;
          found = !!this.npcFindPath(npc, mode, sc.y[slot], sc.x[slot], s16(ay), s16(ax));
        }
        if (!found) continue;
        this.npcStorePath(sc.y[slot], sc.x[slot], mode, npc);
        const t = map.buffer[ay < 0x20 && ax < 0x20 ? ay * 0x20 + ax : 0x3ff];
        if ((mode === 3 && t === 0xc8) || (mode === 4 && t === 0xc9) || (t & 0xfc) === 0xc4) town.placeNpc(map.z, ay, ax, npc);
        s.state = 2;
      } else if ((state === 6 || state === 7) && !this.npcOnStairs(slot, npc)) {
        // walk to the stairs on this floor
        if (s.state === 2 || searched === 1) continue;
        searched = 1;
        const mode = state === 6 ? 1 : 2;
        const stairs = this.npcPathToStairs(npc, mode === 1, s.y, s.x);
        let ax = 0, ay = 0, found = !!stairs;
        if (found) {
          ax = stairs.x;
          ay = stairs.y;
          found = !!this.npcFindPath(npc, mode, s16(ay), s16(ax), this.sy(npc), this.sx(npc));
        }
        if (found) {
          this.npcStorePath(s16(ay), s16(ax), mode, npc);
          s.state = 3;
        }
      } else {
        // on the stairs, or both spots on other floors: jump to the spot
        town.placeNpc(sc.z[slot], sc.y[slot], sc.x[slot], npc);
        s.schedSlot = slot;
        this.pathPos[npc] = 0xffff;
        s.state = 1;
      }
    }
  }

  /** b570: the entry whose change time passed most recently; the fourth time goes back to entry 1. */
  currentScheduleSlot(hour, npc) {
    const t = this.schedules[npc].times;
    let best = (hour - t[0]) & 0xff, slot = 0;
    if (((hour - t[1]) & 0xff) < best) { best = (hour - t[1]) & 0xff; slot = 1; }
    if (((hour - t[2]) & 0xff) < best) { best = (hour - t[2]) & 0xff; slot = 2; }
    if (((hour - t[3]) & 0xff) < best) slot = 1;
    return slot;
  }
}

export const npcs = new Npcs();
