import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GameFiles } from '../src/gamefiles.js';
import { readZip } from '../src/zip.js';
import { GAME_DIR } from './helpers.js';

/** A ZIP archive of [name, bytes, deflate?] entries (names ending in '/' are folders), with a comment. */
function makeZip(entries, comment = '') {
  const parts = [], central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  for (const [name, bytes, deflate] of entries) {
    const data = deflate ? deflateRawSync(bytes) : bytes;
    const nameBytes = Buffer.from(name, 'latin1');
    const common = [...u16(20), ...u16(0), ...u16(deflate ? 8 : 0), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(bytes.length), ...u16(nameBytes.length)];
    const local = Buffer.from([...u32(0x04034b50), ...common, ...u16(0)]);
    parts.push(local, nameBytes, data);
    central.push(Buffer.from([...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.from([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(dir.length), ...u32(offset), ...u16(comment.length)]);
  return new Uint8Array(Buffer.concat([...parts, dir, end, Buffer.from(comment, 'latin1')]));
}

describe('readZip', () => {
  it('reads stored and deflated files, leaving out folders', async () => {
    const text = Buffer.from('Ultima V '.repeat(200));
    const zip = makeZip([['ultima5/', Buffer.alloc(0)], ['ultima5/A.TXT', text, true], ['ultima5/B.BIN', Buffer.from([1, 2, 3]), false]], 'a comment');
    const files = await readZip(zip);
    expect(files.map((f) => f.name)).toEqual(['ultima5/A.TXT', 'ultima5/B.BIN']);
    expect(Buffer.from(files[0].bytes).equals(text)).toBe(true);
    expect([...files[1].bytes]).toEqual([1, 2, 3]);
  });

  it('refuses what is not a ZIP file', async () => {
    await expect(readZip(new Uint8Array(100))).rejects.toThrow(/not a ZIP/);
  });
});

describe('GameFiles.addZip', () => {
  it('takes the folder that holds DATA.OVL, and only it', async () => {
    const zip = makeZip([
      ['dosbox.conf', Buffer.from('x'), false],
      ['other/TILES.16', Buffer.from('wrong'), false],
      ['game/ultima5/data.ovl', Buffer.alloc(16), true],
      ['game/ultima5/TILES.16', Buffer.from('right'), true],
    ]);
    const files = new GameFiles();
    await files.addZip(zip);
    expect(files.has('DATA.OVL')).toBe(true);
    expect(Buffer.from(files.get('TILES.16')).toString()).toBe('right');
    expect(files.has('DOSBOX.CONF')).toBe(false);
  });

  it.skipIf(!GAME_DIR)('gives a game that checks out from a ZIP of the game folder', async () => {
    const entries = readdirSync(GAME_DIR)
      .filter((n) => statSync(join(GAME_DIR, n)).isFile())
      .map((n, i) => [`ultima5/${n}`, readFileSync(join(GAME_DIR, n)), i % 2 === 0]);
    const files = new GameFiles();
    await files.addZip(makeZip(entries));
    expect(files.check().ok).toBe(true);
    for (const [name, bytes] of entries) expect(Buffer.from(files.get(name.slice(8))).equals(bytes)).toBe(true);
  });
});
