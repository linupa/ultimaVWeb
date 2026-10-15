// effects.js - the main program's screen effects used across the game: a square flashing, the
// screen shaking, a tile dissolving in. Ported from the C++ port's endings.cpp ("main program
// helpers") and picture.cpp (dissolve_tile).
import { intro } from './intro.js';
import { M, map } from './map.js';
import { randomBetween } from './misc.js';
import { sound } from './sound.js';
import { tiles } from './tiles.js';
import { video, SCREEN_W, SCREEN_H } from './video/video.js';
import { view } from './view.js';

/** A square of the view (map coordinates outside a scene) flashes black with a noise. */
export async function flashSquare(y, x) {
  if (!map.inScene()) {
    x -= map.x - 5;
    y -= map.y - 5;
  }
  tiles.drawTileAt(y, x, 0);
  await sound.soundNoise(2000, 3000, 10);
  await view.worldTick();
}

/**
 * The view is copied to the back page, where 5-row strips are shifted 2 pixels down, shown, then
 * shifted back up, eight times, while the speaker rumbles at a new random pitch for every strip.
 */
export async function screenShake() {
  const rumble = () => {
    sound.speakerOn(randomBetween(0x96, 0x13));
    sound.crackle(1200);
  };
  video.copyPage(0, 1);
  video.setDrawPage(1);
  for (let n = 0; n < 8; n++) {
    for (let y = 8; y < 0xb4; y += 3) {
      video.scrollRect(8, y, 0xb7, y + 4, 2);
      rumble();
    }
    for (let y = 8; y < 0xb4; y += 3) {
      video.copyRect(8, y, 0xb7, y + 4, 1, 0);
      rumble();
    }
    await sound.delayLoop(1, 1);
    for (let y = 0xb3; y > 7; y -= 3) {
      video.scrollRect(8, y, 0xb7, y + 4, -2);
      rumble();
    }
    for (let y = 0xb3; y > 7; y -= 3) {
      video.copyRect(8, y, 0xb7, y + 4, 1, 0);
      rumble();
    }
    await sound.delayLoop(1, 1);
  }
  video.setDrawPage(0);
  sound.speakerOff();
}

/**
 * picture.cpp dissolve_tile (drv 0x66): the tile's pixels are drawn straight to the screen in the
 * order of an 8-bit shift register; every 8 pixels the world (or, in the demo, the demo) goes on a
 * step. Non-zero if the demo was interrupted.
 */
export async function dissolveTile(row, col, tile) {
  let state = 1;
  const x0 = tiles.originX + col * 16, y0 = tiles.originY + row * 16;
  for (let step = 0; step < 0x100; step++) {
    let x = 0, y = 0;
    if (step !== 0) {
      x = state >> 4;
      y = state & 0x0f;
      const carry = state & 1;
      state >>= 1;
      if (carry) state ^= 0xb8;
    }
    if (y0 + y >= 0 && y0 + y < SCREEN_H && x0 + x >= 0 && x0 + x < SCREEN_W) video.fb[(y0 + y) * SCREEN_W + x0 + x] = tiles.tilePixel(tile, x, y);
    if ((step & 7) === 7 && step !== 0xff) {
      if (map.id === M.DEMO) {
        const r = await intro.demoStep(1);
        if (r) return r;
      } else {
        await view.worldTick();
      }
    }
  }
  return 0;
}

/** Where c is in s, or s's length if it isn't (used with "AMBFDTPRS"). */
export function strIndex(c, s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) !== c) i++;
  return i;
}
