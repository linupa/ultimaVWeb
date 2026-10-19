// browser.js - the Platform for a web page: the screen buffer drawn to a <canvas>, keys from
// keydown events, waits as timers. (The C++ port's SdlPlatform.)
import { Platform, TICK_MS } from './platform.js';
import { keyFromEvent } from './keys.js';
import { SCREEN_H, SCREEN_W, toRGBA, video } from '../video/video.js';

const QUEUE_SIZE = 64; // as SdlPlatform; a full queue drops keys, like a full BIOS buffer

// Ctrl+these stay the browser's (reload, close, new tab/window, address bar, quit).
const BROWSER_CTRL = new Set(['KeyR', 'KeyW', 'KeyT', 'KeyN', 'KeyL', 'KeyQ']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BrowserPlatform extends Platform {
  /**
   * @param {HTMLCanvasElement} canvas  @param {EventTarget} keySource (usually window)
   * @param {() => {x, y, w, h, lit}[]} highlight  screen rectangles to highlight over each frame
   *   (the game's own picture is left as it is): lit ones inverted, the others outlined
   * @param {() => ?{w, h, parts: {x, y, w, h, dx, dy, dw, dh}[]}} layout  null: the screen as it
   *   is; else the canvas's size and where each part of the screen goes on it (scaled)
   */
  constructor(canvas, keySource = window, highlight = () => [], layout = () => null) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layout = layout;
    this.frame = null; // the screen drawn off the page, for a layout
    this.image = this.ctx.createImageData(SCREEN_W, SCREEN_H);
    this.queue = [];
    this.highlight = highlight;
    this.lastPresent = 0;
    this.audio = null; // the AudioContext, made at the first key (browsers allow sound only after one)
    this.audioEnd = 0; // when the sound queued so far ends, in the context's time
    this.wallEnd = 0; // and in wall-clock time (performance.now): the game waits by this
    this.silentMs = 0; // without sound: how long the queued samples would have played
    keySource.addEventListener('keydown', (e) => this.keyDown(e));
  }

  startAudio() {
    if (this.audio || typeof AudioContext === 'undefined') return;
    try {
      this.audio = new AudioContext();
    } catch {
      this.audio = null;
    }
  }

  keyDown(e) {
    this.startAudio();
    if (e.ctrlKey && BROWSER_CTRL.has(e.code)) return;
    // In the text field a touch keyboard types into (main.js), letters and Backspace arrive as
    // changes to the field; only Return, Escape and the like come from here.
    if (e.target?.tagName === 'INPUT' && (e.key.length === 1 || e.key === 'Backspace')) return;
    const k = keyFromEvent(e);
    if (!k) return;
    e.preventDefault(); // keep arrows, Backspace, Tab, Ctrl+S... for the game
    if (this.queue.length < QUEUE_SIZE) this.queue.push(k);
  }

  /** A key from something other than the keyboard (a click), as { key, shifted }. */
  pushKey(k) {
    this.startAudio();
    if (this.queue.length < QUEUE_SIZE) this.queue.push(k);
  }

  pollKey() {
    if (performance.now() - this.lastPresent >= 16) this.present();
    return this.queue.shift() ?? null;
  }

  keyWaiting() {
    return this.queue.length > 0;
  }

  async delayTicks(n) {
    this.present();
    await sleep(n * TICK_MS);
  }

  async delayMs(ms) {
    if (ms >= 10 || performance.now() - this.lastPresent >= 16) this.present();
    await sleep(Math.max(0, ms));
  }

  audioQueue(samples) {
    if (!this.audio || this.audio.state !== 'running') {
      if (this.audio && this.audio.state === 'suspended') this.audio.resume().catch(() => {});
      this.silentMs += (samples.length * 1000) / 44100;
      return;
    }
    const buffer = this.audio.createBuffer(1, samples.length, 44100);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
    const src = this.audio.createBufferSource();
    src.buffer = buffer;
    src.connect(this.audio.destination);
    const start = Math.max(this.audio.currentTime, this.audioEnd);
    src.start(start);
    this.audioEnd = start + buffer.duration;
    this.wallEnd = Math.max(performance.now(), this.wallEnd) + buffer.duration * 1000;
  }

  /**
   * Waits until what is queued has played (or, without sound, as long as it would have). The
   * wait goes by the wall clock, not the audio clock, which may stand still (no output device)
   * or run late: the game's pace mustn't depend on it.
   */
  async audioWait() {
    if (this.silentMs > 0) {
      const ms = this.silentMs;
      this.silentMs = 0;
      if (ms >= 1) await this.delayMs(ms);
      return;
    }
    const left = this.wallEnd - performance.now();
    if (left > 20) this.present();
    if (left > 1) await sleep(left);
  }

  flushKeys() {
    this.queue.length = 0;
  }

  present() {
    const layout = this.layout();
    if (layout && !this.frame) {
      this.frame = document.createElement('canvas');
      Object.assign(this.frame, { width: SCREEN_W, height: SCREEN_H });
    }
    const ctx = layout ? this.frame.getContext('2d') : this.ctx;
    const { w, h } = layout ?? { w: SCREEN_W, h: SCREEN_H };
    if (this.canvas.width !== w || this.canvas.height !== h) Object.assign(this.canvas, { width: w, height: h });
    toRGBA(video.fb, this.image.data);
    ctx.putImageData(this.image, 0, 0);
    // A lit choice in inverted colours, as the menu shows its cursor; the others (on a touch
    // screen, without hover) with a faint EGA yellow outline.
    ctx.lineWidth = 1;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(255, 255, 85, 0.6)';
    for (const r of this.highlight()) {
      if (r.lit) {
        ctx.globalCompositeOperation = 'difference'; // white minus each pixel
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.globalCompositeOperation = 'source-over';
      } else {
        ctx.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1);
      }
    }
    if (layout) {
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, w, h);
      for (const p of layout.parts) this.ctx.drawImage(this.frame, p.x, p.y, p.w, p.h, p.dx, p.dy, p.dw, p.dh);
    }
    this.lastPresent = performance.now();
  }
}
