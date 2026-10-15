// script.js - a Platform without a page, for the tests: keys come from a script, and waits take no
// time but are counted in ticks. When the script runs out the platform reports quit, so input
// loops end. (The C++ port's ScriptPlatform.)
import { Platform } from './platform.js';

export class ScriptPlatform extends Platform {
  constructor() {
    super();
    this.script = [];
    this.pos = 0;
    this.quit = false;
    this.ticks = 0;
    /** Test hook: if set, keys come from it instead of the script (-1 = no more keys). */
    this.nextKey = null;
    /** Test hook: called after every tick with the running tick count. */
    this.onTick = null;
  }

  /** Sets the keys to play; an entry of 0 is a poll that finds nothing. */
  keys(list) {
    this.script = list;
    this.pos = 0;
    this.quit = false;
  }

  pollKey() {
    if (this.quit) return { key: 0x0d, shifted: 0 };
    if (this.nextKey) {
      const k = this.nextKey();
      if (k >= 0) return k ? { key: k, shifted: 0 } : null;
      this.quit = true;
      return { key: 0x0d, shifted: 0 };
    }
    if (this.pos >= this.script.length) {
      this.quit = true;
      return { key: 0x0d, shifted: 0 };
    }
    const k = this.script[this.pos++];
    return k ? { key: k, shifted: 0 } : null;
  }

  keyWaiting() {
    if (this.quit) return true;
    if (this.nextKey || this.pos >= this.script.length) return false;
    return this.script[this.pos] !== 0;
  }

  async delayTicks(n) {
    for (; n > 0; n--) {
      this.ticks++;
      if (this.onTick) this.onTick(this.ticks);
    }
  }

  async delayMs() {}

  quitRequested() {
    return this.quit;
  }
}
