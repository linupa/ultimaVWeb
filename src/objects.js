// objects.js - the map object table helpers of the main program (0000:3702-0000:3aae). Objects 0
// is the party; 1-31 vehicles, people, monsters and fields. Ported from the C++ port's objects.cpp.
import { map } from './map.js';
import { randomBetween } from './misc.js';

/** 3a74 */
export function setObjectEntry(index, hull, z, y, x, tile2, tile) {
  const o = map.objects.at(index);
  o.tile = tile;
  o.tile2 = tile2;
  o.x = x;
  o.y = y;
  o.z = z;
  o.hull = hull;
}

/** 3868: the first object 1-23 with a tile in [min, max] (never 0xB5); farOnly: outside the view. 0 if none. */
export function findObjectInTileRange(farOnly, maxTile, minTile) {
  for (let i = 1; i <= 0x17; i++) {
    const o = map.objects.at(i);
    if (o.tile < minTile || o.tile > maxTile || o.tile === 0xb5) continue;
    if (!farOnly) return i;
    if (((o.x - map.x + 5) & 0xff) > 10 || ((o.y - map.y + 5) & 0xff) > 10) return i;
  }
  return 0;
}

/** 38e4: a free slot, or else one to reuse - out-of-sight objects first. */
export function allocObjectSlot() {
  const tries = [[0, 0, 0], [1, 0x0f, 1], [1, 0xff, 0x80], [1, 0x11, 0x10], [1, 0x7f, 0x30],
    [0, 0x0f, 1], [0, 0xff, 0x80], [0, 0x11, 0x10], [0, 0x7f, 0x30], [0, 0xff, 0]];
  for (const [far, max, min] of tries) {
    const slot = findObjectInTileRange(far, max, min);
    if (slot) return slot;
  }
  return 0;
}

/** 3702: the tile of an object there (from 31 down to 0), 0 if none; `.slot` is where (0xFFFF none). */
export function objectTileAt(z, y, x) {
  for (let i = 31; i >= 0; i--) {
    const o = map.objects.at(i);
    if (o.x === x && o.y === y && (map.inScene() || o.z === z)) return { tile: o.tile, slot: i };
  }
  return { tile: 0, slot: 0xffff };
}

/** 368e: the tile of an object 1-31 there, 0 if none; `.slot` is where (31 if none, as the original). */
export function findObjectAt(z, y, x) {
  y &= 0xff;
  x &= 0xff;
  for (let i = 1; i < 32; i++) {
    const o = map.objects.at(i);
    if (o.x === x && o.y === y && (map.inScene() || o.z === z)) return { tile: o.tile, slot: i };
  }
  return { tile: 0, slot: 31 };
}

/** 3aae */
export function randomUpto(max) {
  return randomBetween(max, 0);
}
