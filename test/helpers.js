// helpers.js - for the tests: the player's game files from a local folder, and PNG screenshots.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { GameFiles } from '../src/gamefiles.js';
import { EGA_PALETTE, SCREEN_H, SCREEN_W } from '../src/video/video.js';

/** The game folder for the tests (U5_GAME, default ../ultima5), or null if there is none. */
export const GAME_DIR = (() => {
  const dir = resolve(process.env.U5_GAME ?? '../ultima5');
  return existsSync(join(dir, 'DATA.OVL')) ? dir : null;
})();

export function loadGameFolder(dir = GAME_DIR) {
  const files = new GameFiles();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isFile()) files.add(name, readFileSync(path));
  }
  return files;
}

/** Writes 320 x 200 colour numbers as a PNG in test-output/. */
export function savePng(name, pixels) {
  mkdirSync('test-output', { recursive: true });
  const raw = Buffer.alloc(SCREEN_H * (1 + SCREEN_W * 3));
  for (let y = 0; y < SCREEN_H; y++) {
    raw[y * (1 + SCREEN_W * 3)] = 0;
    for (let x = 0; x < SCREEN_W; x++) {
      const [r, g, b] = EGA_PALETTE[pixels[y * SCREEN_W + x] & 15];
      raw.set([r, g, b], y * (1 + SCREEN_W * 3) + 1 + x * 3);
    }
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tb));
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SCREEN_W, 0);
  ihdr.writeUInt32BE(SCREEN_H, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  writeFileSync(join('test-output', name), png);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
