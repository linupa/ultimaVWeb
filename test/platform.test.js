import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEY_DOWN, KEY_F1, KEY_LEFT, KEY_PGUP, keyFromEvent } from '../src/platform/keys.js';
import { BrowserPlatform } from '../src/platform/browser.js';
import { ScriptPlatform } from '../src/platform/script.js';
import { setPlatform, TICK_MS } from '../src/platform/platform.js';
import { Input } from '../src/input.js';
import { EGA_PALETTE, SCREEN_W, toRGBA, video } from '../src/video/video.js';

const fb = video.fb;
const fillRect = (x, y, w, h, c) => {
  video.setColor(c);
  video.fillRect(x, y, x + w - 1, y + h - 1);
};

const ev = (key, extra = {}) => ({ key, code: extra.code ?? '', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...extra });

describe('keyFromEvent', () => {
  it('gives ASCII for ordinary keys and the game codes for extended ones', () => {
    expect(keyFromEvent(ev('a'))).toEqual({ key: 0x61, shifted: 0 });
    expect(keyFromEvent(ev('Enter'))).toEqual({ key: 0x0d, shifted: 0 });
    expect(keyFromEvent(ev('ArrowLeft'))).toEqual({ key: KEY_LEFT, shifted: 0 });
    expect(keyFromEvent(ev('ArrowDown', { shiftKey: true }))).toEqual({ key: KEY_DOWN, shifted: 1 });
    expect(keyFromEvent(ev('PageUp')).key).toBe(KEY_PGUP);
    expect(keyFromEvent(ev('F3')).key).toBe(KEY_F1 + 2);
  });

  it('gives Ctrl+letter as 1-26 and keypad digits with Shift', () => {
    expect(keyFromEvent(ev('s', { code: 'KeyS', ctrlKey: true })).key).toBe(0x13);
    expect(keyFromEvent(ev('ArrowLeft', { code: 'Numpad4', shiftKey: true }))).toEqual({ key: 0x34, shifted: 1 });
  });

  it('ignores keys the game does not see', () => {
    expect(keyFromEvent(ev('Shift'))).toBeNull();
    expect(keyFromEvent(ev('x', { altKey: true }))).toBeNull();
  });
});

describe('Input on a scripted platform', () => {
  it('blinks the cursor a tick at a time until a key comes', async () => {
    const p = new ScriptPlatform();
    setPlatform(p);
    const input = new Input();
    const frames = [];
    let erased = 0;
    input.cursor = Uint16Array.of(5, 4); // DATA.OVL's cursor: glyphs 5-8
    input.drawCursor = (f) => frames.push(f);
    input.eraseCursor = () => erased++;
    p.keys([0, 0, 0, 0, 0, 0x41]);
    expect(await input.waitKeyTimeout(0)).toBe(0x41);
    expect(p.ticks).toBe(5);
    expect(frames).toEqual([0, 1, 2, 3, 0, 1]);
    expect(erased).toBe(1);
  });

  it('gives up after the tries, and reports quit as Return', async () => {
    const p = new ScriptPlatform();
    setPlatform(p);
    const input = new Input();
    p.keys([0, 0, 0, 0]);
    expect(await input.waitKeyTimeout(3)).toBe(0);
    expect(p.ticks).toBe(3);
    expect(await input.waitKeyTimeout(3)).toBe(0x0d); // one empty poll, then the script ends: Return
    expect(p.quitRequested()).toBe(true);
    expect(await input.waitKeyTimeout(0)).toBe(0x0d);
  });

  it('sets numpadShift for cursor keys and Shift + digits', async () => {
    const p = new ScriptPlatform();
    setPlatform(p);
    const input = new Input();
    p.nextKey = () => KEY_LEFT;
    input.pollKey();
    expect(input.numpadShift).toBe(1);
    p.nextKey = () => 0x35;
    input.pollKey();
    expect(input.numpadShift).toBe(0); // a digit without Shift
  });
});

describe('BrowserPlatform', () => {
  afterEach(() => vi.useRealTimers());

  function make() {
    const drawn = [];
    const canvas = {
      getContext: () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (img) => drawn.push(img.data.slice(0, 4)),
      }),
    };
    const keys = new EventTarget();
    return { p: new BrowserPlatform(canvas, keys), keys, drawn };
  }

  function keydown(target, key, code = '') {
    const e = new Event('keydown', { cancelable: true });
    Object.assign(e, { key, code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
    target.dispatchEvent(e);
    return e;
  }

  it('queues keys, keeps them from the page, and lets browser shortcuts through', () => {
    const { p, keys } = make();
    expect(keydown(keys, 'ArrowUp').defaultPrevented).toBe(true);
    const reload = new Event('keydown', { cancelable: true });
    Object.assign(reload, { key: 'r', code: 'KeyR', ctrlKey: true });
    keys.dispatchEvent(reload);
    expect(reload.defaultPrevented).toBe(false);
    expect(p.keyWaiting()).toBe(true);
    expect(p.pollKey().key).toBe(3);
    expect(p.pollKey()).toBeNull();
  });

  it('shows the frame and waits the PC timer ticks', async () => {
    vi.useFakeTimers();
    const { p, drawn } = make();
    fb.fill(0);
    fillRect(0, 0, 1, 1, 15);
    let done = false;
    p.delayTicks(2).then(() => (done = true));
    expect(Array.from(drawn[0])).toEqual([255, 255, 255, 255]);
    await vi.advanceTimersByTimeAsync(2 * TICK_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });
});

describe('BrowserPlatform sound', () => {
  afterEach(() => vi.useRealTimers());

  it('waits for queued sound by the wall clock, even when the audio clock stands still', async () => {
    vi.useFakeTimers();
    const canvas = { getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
    const p = new BrowserPlatform(canvas, new EventTarget());
    p.audio = { // an AudioContext whose clock never moves (no output device)
      state: 'running',
      currentTime: 0,
      destination: {},
      createBuffer: (ch, n, rate) => ({ duration: n / rate, getChannelData: () => new Float32Array(n) }),
      createBufferSource: () => ({ connect() {}, start() {} }),
    };
    p.audioQueue(new Int16Array(4410)); // 100 ms
    let done = false;
    p.audioWait().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(90);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(done).toBe(true);
    p.audioQueue(new Int16Array(4410)); // the next sound waits only its own length
    done = false;
    p.audioWait().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(110);
    expect(done).toBe(true);
  });
});

describe('video', () => {
  it('turns colour numbers into EGA RGBA, and clips rectangles', () => {
    fb.fill(0);
    fillRect(-5, -5, 7, 7, 4);
    expect(fb[0]).toBe(4);
    expect(fb[1 + SCREEN_W]).toBe(4);
    expect(fb[2]).toBe(0);
    const rgba = new Uint8ClampedArray(8);
    toRGBA(new Uint8Array([4, 9]), rgba);
    expect(Array.from(rgba)).toEqual([...EGA_PALETTE[4], 255, ...EGA_PALETTE[9], 255]);
  });
});
