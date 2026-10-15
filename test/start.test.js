// The game's start against the real game files (skipped without them): the data, the text, the
// saved game, and the first screen of Journey Onward - compared pixel for pixel with the C++
// port's when U5_REF names a screen it wrote (raw 320 x 200 colour numbers, the same seed).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { S, strings } from '../src/data/strings.js';
import { pictures, P } from '../src/data/pictures.js';
import { journeyOnward, startUp } from '../src/game.js';
import { gameTime } from '../src/gametime.js';
import { M, map } from '../src/map.js';
import { setRandomSeed } from '../src/misc.js';
import { party } from '../src/party.js';
import { setPlatform } from '../src/platform/platform.js';
import { ScriptPlatform } from '../src/platform/script.js';
import { savegame } from '../src/savegame.js';
import { status } from '../src/status.js';
import { town } from '../src/town.js';
import { view } from '../src/view.js';
import { textWindows } from '../src/text.js';
import { video } from '../src/video/video.js';
import { GAME_DIR, loadGameFolder, savePng } from './helpers.js';

describe.skipIf(!GAME_DIR)('the game with the real files', () => {
  const files = GAME_DIR ? loadGameFolder() : null;
  if (files && process.env.U5_SAVE) files.add('SAVED.GAM', readFileSync(process.env.U5_SAVE)); // another saved game to start from
  setPlatform(new ScriptPlatform());
  if (files) startUp(files);

  it('reads the text and the tables from DATA.OVL', () => {
    expect(strings.get(S.Leather_Helm_0042)).toBe('Leather Helm');
    expect(strings.get(S.CONFLICT_A438)).toBe('*** CONFLICT ***\n');
    expect(pictures.name(P.TILES)).toBe('TILES.16');
    expect(map.name(M.BRITAIN)).toBe('BRITAIN');
  });

  it('loads SAVED.GAM and saves it back byte for byte', () => {
    const original = files.get('SAVED.GAM');
    savegame.unpack(original);
    expect(party.member(0).name.length).toBeGreaterThan(0);
    expect(gameTime.month).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(savegame.pack()).equals(Buffer.from(original.subarray(0, 0x1060)))).toBe(true);
  });

  it('draws the saved game\'s first screen', async () => {
    const printed = [];
    textWindows.echo = (c) => printed.push(String.fromCharCode(c));
    setRandomSeed(1234);
    expect(journeyOnward()).toBe(true);
    // the start of game_run, as the C++ reference program does it
    status.drawStatusBar();
    if (map.isOutdoors()) {
      map.enterOutdoors();
      await view.worldTick();
    } else {
      await town.enterTown(0);
    }
    textWindows.echo = null;
    savePng(process.env.U5_SHOT ?? 'start.png', video.fb);
    const panel = printed.join('');
    expect(panel).toContain(party.member(0).name);
    expect(panel).toContain(`${gameTime.month}-${gameTime.day}-`);
    const ref = process.env.U5_REF;
    if (ref && existsSync(ref)) {
      const expected = readFileSync(ref);
      let diff = 0;
      for (let i = 0; i < expected.length; i++) if (expected[i] !== video.fb[i]) diff++;
      expect(diff).toBe(0);
    }
  });
});
