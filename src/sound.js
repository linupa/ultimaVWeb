// sound.js - the PC speaker, as the Sound class; `sound` is the one object. Ported from the C++
// port's sound.cpp: the original makes sound three ways - timer 2 driving the speaker at a
// frequency (with busy-wait delays for the length), rapid random frequencies (soundNoise), and
// switching the speaker in a counted loop (soundSweep, for everything musical). The port renders
// the same sequences as 44.1 kHz samples, hands them to the platform and waits while they play,
// as the original blocks while it makes them. With sound off (Ctrl-S) the waits remain.
// Everything that sounds is async (see platform/platform.js).
import { data } from './data/gamedata.js';
import { platform } from './platform/platform.js';
import { savegame } from './savegame.js';

const RATE = 44100;
const LEVEL = 5000;
const SWEEP_RATE = 16492; // iterations a second with repeat 1: note 3497 = 880 Hz

export class Sound {
  constructor() {
    this.enabled = 0; // Ctrl-S
    this.noiseRand = 0x7664;
    this.ambientState = 0;
    this.tunePos = 0;
    this.ambientCooldown = 0; // the strokes a clock still has to strike
    this.pcm = [];
    this.phase = 0;
    this.carry = 0;
    this.speakerFreq = 0; // 0 = off
    savegame.u8(0x5884, this, 'ambientCooldown', 'sound.ambientCooldown');
    this.halfDelay = data.bytes(0x5426, new Uint8Array(8), 'sound.halfDelay');
    this.tunePitch = data.words(0x6a34, new Uint16Array(10), 'sound.tunePitch');
    this.tune = data.bytes(0x6a48, new Uint8Array(0x36), 'sound.tune');
  }

  flush() {
    if (this.pcm.length) platform.audioQueue(Int16Array.from(this.pcm));
    this.pcm = [];
  }

  /** `seconds` of a square wave at freq (0 = silence), carrying the phase over. */
  tone(freq, seconds) {
    const n = seconds * RATE + this.carry;
    const count = Math.floor(n);
    this.carry = n - count;
    for (let i = 0; i < count; i++) {
      if (freq <= 0) {
        this.pcm.push(0);
        continue;
      }
      this.phase += freq / RATE;
      if (this.phase >= 1) this.phase -= Math.floor(this.phase);
      this.pcm.push(this.phase < 0.5 ? LEVEL : -LEVEL);
    }
  }

  async play() {
    this.flush();
    await platform.audioWait();
  }

  /** 22e2: timer 2 takes the divisor 0x1234DE / freq, so the pitch is slightly quantised. */
  speakerOn(freq) {
    if (this.enabled === 0 || freq === 0) return;
    const divisor = Math.floor(0x1234de / freq) & 0xffff;
    this.speakerFreq = divisor ? 0x1234de / divisor : 0;
  }

  /** 230e */
  speakerOff() {
    this.speakerFreq = 0;
  }

  /** 20c8: about `count` ms (half for some speed indexes); whatever the speaker does goes on. */
  async delayLoop(count, speedIndex) {
    let ms = count & 0xffff;
    if ((this.halfDelay[speedIndex & 7] | (this.halfDelay[(speedIndex + 1) & 7] << 8)) !== 0) ms /= 2;
    if (this.speakerFreq) {
      this.tone(this.speakerFreq, ms / 1000);
      await this.play();
    } else {
      await platform.delayMs(Math.round(ms));
    }
  }

  /** A moment of the current speaker tone, queued without waiting (for loops the original paces by CPU time). */
  crackle(microseconds) {
    this.tone(this.speakerFreq, microseconds / 1e6);
  }

  /** 22c0 */
  async beep(duration, freq) {
    if (this.enabled) this.speakerOn(freq);
    await this.delayLoop(duration, 1);
    this.speakerOff();
  }

  /** 43ae: from freqB to freqA over `length` ms. */
  async soundSlide(length, step, freqA, freqB) {
    const range = freqA - freqB;
    if (step <= 0 || length <= 0) return;
    for (let i = 0; i < length; i += step) {
      this.speakerOn(freqB);
      this.tone(this.speakerFreq || 0, step / 1000);
      freqB = (freqB + Math.trunc((range * step) / length)) >>> 0;
    }
    this.speakerOff();
    await this.play();
  }

  /** 223c: a new random pitch between 100 Hz and pitchRange every `step` 1/16 ms, `duration` of them. */
  async soundNoise(pitchRange, duration, step) {
    let total = 0;
    let range = (pitchRange - 99) & 0xffff;
    if (range === 0) range = 1;
    do {
      const r = this.noiseRand;
      this.noiseRand = (((((((r + 0x9248) & 0xffff) >> 3) | ((r << 13) & 0xffff)) ^ 0x9248) + 0x11) & 0xffff);
      const freq = (this.noiseRand % range) + 100;
      this.tone(this.enabled ? freq : 0, (step & 0xffff) / 16000);
      total += step;
    } while (total < duration && step > 0);
    await this.play();
  }

  /** 2192: `count` iterations of a 16-bit accumulator against a moving threshold (a shaped pulse). */
  async soundSweep(step, from, count, repeat, increment) {
    let acc = 0, threshold = from & 0xffff, n = count & 0xffff;
    const period = (120 + 172 * (repeat > 0 ? repeat : 1)) / 292 / SWEEP_RATE;
    let t = 0, next = 0;
    do {
      acc = (acc + increment) & 0xffff;
      const on = this.enabled !== 0 && acc > threshold;
      threshold = (threshold + step) & 0xffff;
      t += period;
      while (next < t) {
        this.pcm.push(on ? LEVEL : -LEVEL / 4);
        next += 1 / RATE;
      }
      n = (n - 1) & 0xffff;
    } while (n !== 0);
    this.pcm.push(0);
    await this.play();
  }

  /** 433e */
  async stepSound() {
    await this.soundNoise(1000, 0x19, 1);
    await this.delayLoop(0x14, 1);
    await this.soundNoise(0x5dc, 0x19, 1);
  }

  /**
   * 41c2...: the nearest sounding thing within about 7 squares - a clock (tick, tock, and the hour
   * struck), a waterfall, a fountain, or a bard playing the tune at ds:6A48.
   */
  async ambientSounds(map, view) {
    let kind = 0, best = 0x33, px = 5, py = 5;
    if (!map.inScene()) {
      px = map.x;
      py = map.y;
    }
    for (let col = 0; col < 11; col++)
      for (let row = 0; row < 11; row++) {
        const x = px - 5 + col, y = py - 5 + row;
        const d = (y - py) * (y - py) + (x - px) * (x - px);
        if (d >= best) continue;
        const t = map.getTile(y, x);
        if ((t & 0xfe) === 0xfa) kind = 1;
        else if ((t & 0xfc) === 0xd4) kind = 2;
        else if ((t & 0xfc) === 0xd8) kind = 3;
        else if (view.mask[row * 0x20 + col] === 0 && (view.tiles[row * 0x10 + col] & 0xfc) === 0x5c) kind = 4;
        else continue;
        best = d;
      }
    if (kind === 1) {
      if (this.ambientCooldown === 0 || (this.ambientState !== 0 && this.ambientState !== 4)) {
        if (this.ambientState === 0) await this.beep(3, 3000);
        else if (this.ambientState === 4) await this.beep(3, 2000);
      } else {
        await this.soundSweep(-10, 20000, 2000, 1, 0xc2c); // a chime
      }
    } else if (kind === 2) {
      await this.soundNoise(0x2710, 0x3c, 0x14);
    } else if (kind === 3) {
      await this.soundNoise(0x61a8, 0x1e, 10);
    } else if (kind === 4) {
      const note = this.tune[this.tunePos < this.tune.length ? this.tunePos : 0];
      if (note !== 0) await this.soundSweep(-10, 20000, 2000, 1, this.tunePitch[note < 10 ? note : 0]);
      if (++this.tunePos > 0x34) this.tunePos = 0;
    }
    if (this.ambientCooldown !== 0 && (this.ambientState === 0 || this.ambientState === 4)) this.ambientCooldown--;
    if (++this.ambientState > 7) this.ambientState = 0;
  }
}

export const sound = new Sound();
