// platform.js - what the ported game needs from its host: the Platform interface, and `platform`,
// the one in use (the browser's, or a script's in the tests).
//
// THE ASYNC CONVENTION
// The original (and the C++ port) is written as blocking loops: it polls the keyboard and
// busy-waits on the timer. A browser page must never block, so in this port:
//   - Anything that waits - delayTicks, delayMs, audioWait - returns a Promise, and the caller
//     awaits it.
//   - So every function that calls one of them, directly or through another, is async too, and
//     is awaited, all the way up to the main loop. (A forgotten `await` lets the game run on
//     without waiting: if a ported function waits, its callers must be async.)
//   - Polling stays synchronous (pollKey, keyWaiting), but a loop that polls must also await a
//     delay each time round, or it would spin forever without letting the browser deliver keys.
// The frame is shown whenever the game waits, as in the C++ port, so drawing code stays plain
// synchronous code that writes to the screen buffer (video/screen.js).

export class Platform {
  /** Next key from the queue as { key, shifted }, or null. Never waits. */
  pollKey() {
    throw new Error('not implemented');
  }

  /** True if a key is waiting; it stays in the queue (BIOS int 16h, AH = 1). */
  keyWaiting() {
    throw new Error('not implemented');
  }

  /** Waits n timer ticks (the PC timer, 18.2 a second), showing the frame. */
  async delayTicks(n) {
    throw new Error('not implemented');
  }

  /** Waits about ms milliseconds (the game's short busy-wait delays). */
  async delayMs(ms) {
    throw new Error('not implemented');
  }

  /** Discards keys typed ahead (flush_keyboard). */
  flushKeys() {}

  /** Shows the frame now. */
  present() {}

  /** Sound: queues 44.1 kHz mono samples (an Int16Array); audioWait waits until they have played. */
  audioQueue(samples) {}
  async audioWait() {}

  /** True once the player has left the game; pollKey then gives Return so input loops end. */
  quitRequested() {
    return false;
  }
}

/** The host the game is running on (set by main.js or a test). */
export let platform = null;

export function setPlatform(p) {
  platform = p;
}

/** 55 ms: one tick of the PC timer. */
export const TICK_MS = 1000 / 18.2;
