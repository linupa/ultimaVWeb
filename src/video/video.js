// video.js - the graphics driver (EGA.DRV) as two 320 x 200 pages of EGA colour numbers 0-15: the
// screen and the back page. Ported from the C++ port's video.cpp (EGA only; the CGA and
// Hercules looks may come later).

export const SCREEN_W = 320;
export const SCREEN_H = 200;

/** The 16 EGA colours (the display hardware's, not game data). */
export const EGA_PALETTE = [
  [0x00, 0x00, 0x00], [0x00, 0x00, 0xaa], [0x00, 0xaa, 0x00], [0x00, 0xaa, 0xaa],
  [0xaa, 0x00, 0x00], [0xaa, 0x00, 0xaa], [0xaa, 0x55, 0x00], [0xaa, 0xaa, 0xaa],
  [0x55, 0x55, 0x55], [0x55, 0x55, 0xff], [0x55, 0xff, 0x55], [0x55, 0xff, 0xff],
  [0xff, 0x55, 0x55], [0xff, 0x55, 0xff], [0xff, 0xff, 0x55], [0xff, 0xff, 0xff],
];

class Video {
  constructor() {
    this.fb = new Uint8Array(SCREEN_W * SCREEN_H); // the screen (page 0)
    this.back = new Uint8Array(SCREEN_W * SCREEN_H); // the back page (page 1)
    this.draw = this.fb; // the page all drawing goes to
    this.color = 0; // drv 0x2D's colour
    this.noTextYet = true; // set until the first character is drawn
  }

  page(n) {
    return n ? this.back : this.fb;
  }

  /** drv 0x0F: choose the draw page (0 screen, 1 back). */
  setDrawPage(n) {
    this.draw = this.page(n);
  }
  getDrawPage() {
    return this.draw === this.back ? 1 : 0;
  }
  clearBack() {
    this.back.fill(0);
  }
  clear() {
    this.fb.fill(0);
  }

  /** drv 0x1B: copy a whole page. */
  copyPage(from, to) {
    if ((from !== 0) !== (to !== 0)) this.page(to).set(this.page(from));
  }

  setColor(c) {
    this.color = c & 0x0f;
  }

  /** drv 0x3F: fill (x1,y1)-(x2,y2) inclusive with the colour; xor: XOR it in. Clipped. */
  fillRect(x1, y1, x2, y2, xor = false) {
    const r = clip(x1, y1, x2, y2);
    if (!r) return;
    for (let y = r.y1; y <= r.y2; y++) {
      const row = y * SCREEN_W;
      if (xor) for (let x = r.x1; x <= r.x2; x++) this.draw[row + x] ^= this.color;
      else this.draw.fill(this.color, row + r.x1, row + r.x2 + 1);
    }
  }

  /** drv 0x30 */
  plot(x, y) {
    if (x < 0 || x >= SCREEN_W || y < 0 || y >= SCREEN_H) return;
    this.draw[y * SCREEN_W + x] = this.color;
  }

  /** drv 0x33: L + 1 pixels from (x1,y1), L the longer of |dx|, |dy| (x when equal). */
  line(x1, y1, x2, y2) {
    const sx = x2 < x1 ? -1 : 1, sy = y2 < y1 ? -1 : 1;
    const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    const xMajor = dx >= dy, longer = xMajor ? dx : dy, shorter = xMajor ? dy : dx;
    let d = 2 * shorter - longer;
    for (let n = longer + 1; n > 0; n--) {
      this.plot(x1, y1);
      if (d < 0) {
        if (xMajor) x1 += sx;
        else y1 += sy;
        d += 2 * shorter;
      } else {
        x1 += sx;
        y1 += sy;
        d += 2 * shorter - 2 * longer;
      }
    }
  }

  /** drv 0x5D: an 8 x 8 1-bit glyph (8 bytes, bit 7 left) at text cell (col, row), opaque. */
  drawChar(col, row, glyph, fg, bg) {
    this.noTextYet = false;
    if (col < 0 || col >= SCREEN_W / 8 || row < 0 || row >= SCREEN_H / 8) return;
    for (let y = 0; y < 8; y++) {
      const bits = glyph[y];
      const p = (row * 8 + y) * SCREEN_W + col * 8;
      for (let x = 0; x < 8; x++) this.draw[p + x] = (bits & (0x80 >> x) ? fg : bg) & 0x0f;
    }
  }

  /** drv 0x27: move (x1,y1)-(x2,y2) by dy pixels (negative = up), filling the strip with 0. */
  scrollRect(x1, y1, x2, y2, dy) {
    const r = clip(x1, y1, x2, y2);
    if (!r || dy === 0) return;
    let n = Math.abs(dy);
    const w = r.x2 - r.x1 + 1, h = r.y2 - r.y1 + 1;
    if (n > h) n = h;
    const rowAt = (y) => y * SCREEN_W + r.x1;
    if (dy < 0) for (let y = r.y1; y <= r.y2 - n; y++) this.draw.copyWithin(rowAt(y), rowAt(y + n), rowAt(y + n) + w);
    else for (let y = r.y2; y >= r.y1 + n; y--) this.draw.copyWithin(rowAt(y), rowAt(y - n), rowAt(y - n) + w);
    const f = dy < 0 ? r.y2 - n + 1 : r.y1;
    for (let y = f; y < f + n; y++) this.draw.fill(0, rowAt(y), rowAt(y) + w);
  }

  /** drv 0x18: copy (x1,y1)-(x2,y2) between pages, in whole bytes of 8 pixels as EGA.DRV does. */
  copyRect(x1, y1, x2, y2, from, to) {
    const r = clip(x1, y1, x2, y2);
    if ((from !== 0) === (to !== 0) || !r) return;
    const a = r.x1 & ~7, b = r.x2 | 7;
    const src = this.page(from), dst = this.page(to);
    for (let y = r.y1; y <= r.y2; y++) dst.set(src.subarray(y * SCREEN_W + a, y * SCREEN_W + b + 1), y * SCREEN_W + a);
  }
}

function clip(x1, y1, x2, y2) {
  if (x1 > x2) [x1, x2] = [x2, x1];
  if (y1 > y2) [y1, y2] = [y2, y1];
  x1 = Math.max(0, x1);
  y1 = Math.max(0, y1);
  x2 = Math.min(SCREEN_W - 1, x2);
  y2 = Math.min(SCREEN_H - 1, y2);
  return x1 <= x2 && y1 <= y2 ? { x1, y1, x2, y2 } : null;
}

export const video = new Video();

/** Writes `pixels` (colour numbers) into `rgba` (4 bytes a pixel). */
export function toRGBA(pixels, rgba) {
  for (let i = 0, o = 0; i < pixels.length; i++, o += 4) {
    const [r, g, b] = EGA_PALETTE[pixels[i] & 15];
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = 255;
  }
}
