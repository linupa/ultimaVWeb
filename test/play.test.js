// Plays a key script on the saved game and compares the end with the C++ port's (skipped unless
// U5_KEYS names a script). The keys are hex codes, as the C++ reference player reads them; with
// U5_REF=<prefix> the screen (<prefix>.raw), the saved game (<prefix>.gam) and the printed text
// (<prefix>.txt) must match what it wrote. The seeds are fixed: random 1234, clock 0x123. With
// U5_INTRO=intro (or menu) the game starts at the title (or the menu) instead of the saved game.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gameRun, journeyOnward, startUp, WIN_MESSAGE } from '../src/game.js';
import { gfx } from '../src/gfx.js';
import { intro } from '../src/intro.js';
import { capturedByBlackthorn, rescueLordBritish } from '../src/endings.js';
import { M, map } from '../src/map.js';
import { party } from '../src/party.js';
import { view } from '../src/view.js';
import { setRandomSeed, setTimeSeedSource } from '../src/misc.js';
import { setPlatform } from '../src/platform/platform.js';
import { ScriptPlatform } from '../src/platform/script.js';
import { savegame } from '../src/savegame.js';
import { textWindows } from '../src/text.js';
import { video } from '../src/video/video.js';
import { GAME_DIR, loadGameFolder, savePng } from './helpers.js';

const KEYS = process.env.U5_KEYS;

describe.skipIf(!GAME_DIR || !KEYS)('a scripted game', () => {
  it('ends as the C++ port does', async () => {
    const files = loadGameFolder();
    if (process.env.U5_SAVE) files.add('SAVED.GAM', readFileSync(process.env.U5_SAVE));
    if (process.env.U5_EXTRA) files.add(process.env.U5_EXTRA, readFileSync(process.env.U5_EXTRA)); // e.g. PARTY.SAV
    intro.portMenu = false; // the original's menu, as the C++ port has it
    const p = new ScriptPlatform();
    setPlatform(p);
    startUp(files);
    setTimeSeedSource(() => 0x123);
    setRandomSeed(1234);
    p.keys(readFileSync(KEYS, 'utf8').trim().split(/\s+/).map((k) => parseInt(k, 16)));
    let text = '';
    textWindows.echo = (c, rune) => (text += rune ? '#' : String.fromCharCode(c));
    const scene = ['blackthorn', 'ending'].includes(process.env.U5_INTRO) ? process.env.U5_INTRO : null;
    if (scene) { // a scene first, from the saved game (the C++ port's -x)
      expect(journeyOnward()).toBe(true);
      view.worldTickEnabled = 1;
      if (scene === 'blackthorn') await capturedByBlackthorn();
      else {
        map.id = M.SCENE;
        party.sandalwoodBox = 1;
        await rescueLordBritish();
      }
      if (!p.quitRequested()) {
        textWindows.selectTextWindow(0);
        gfx.drawScreenFrame();
        textWindows.selectTextWindow(WIN_MESSAGE);
      }
      view.worldTickEnabled = 1;
      if (!p.quitRequested()) await gameRun();
    } else if (process.env.U5_INTRO) { // start at the title (or with "menu" at the menu), as the game does
      if (await intro.introMain(process.env.U5_INTRO === 'menu')) {
        textWindows.selectTextWindow(WIN_MESSAGE);
        textWindows.setTextColor(gfx.colorText);
        view.worldTickEnabled = 1;
        await gameRun();
      }
    } else {
      expect(journeyOnward()).toBe(true);
      await gameRun();
    }
    textWindows.echo = null;
    const shot = process.env.U5_SHOT ?? 'play.png';
    savePng(shot, video.fb);
    mkdirSync('test-output', { recursive: true });
    writeFileSync(`test-output/${shot.replace(/\.png$/, '')}.txt`, text, 'latin1'); // to diff with the C++ text
    const ref = process.env.U5_REF;
    if (ref) {
      expect(text).toBe(readFileSync(`${ref}.txt`, 'latin1'));
      const gam = readFileSync(`${ref}.gam`);
      const mine = savegame.pack();
      const diffs = [];
      for (let i = 0; i < gam.length; i++) if (gam[i] !== mine[i]) diffs.push((0x55a6 + i).toString(16));
      expect(diffs).toEqual([]);
      const raw = readFileSync(`${ref}.raw`);
      let d = 0;
      for (let i = 0; i < raw.length; i++) if (raw[i] !== video.fb[i]) d++;
      expect(d).toBe(0);
    }
  });
});
