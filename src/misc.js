// misc.js - small main-program utilities: capped arithmetic, string search, random numbers.
// Ported from the C++ port's misc.cpp. The capped helpers work on obj[key], standing in for the
// original's pointers.

/** 3ef0 */
export function addByteCapped(max, n, obj, key) {
  obj[key] = obj[key] + n < max ? (obj[key] + n) & 0xff : max;
}
/** 3f14: signed compare */
export function addWordCapped(max, n, obj, key) {
  const sum = (obj[key] + n) & 0xffff;
  obj[key] = s16(sum) < s16(max) ? sum : max;
}
/** 3f36 */
export function subByteFloor0(n, obj, key) {
  obj[key] = n < obj[key] ? (obj[key] - n) & 0xff : 0;
}
/** 3f54: signed compare */
export function subWordFloor0(n, obj, key) {
  obj[key] = s16(n) < s16(obj[key]) ? (obj[key] - n) & 0xffff : 0;
}

export const s16 = (v) => ((v & 0xffff) << 16) >> 16;
export const s8 = (v) => ((v & 0xff) << 24) >> 24;

const fold = (c) => {
  c &= 0x7f;
  return c > 0x60 ? c & 0x5f : c;
};

/** 6f1e: case-insensitive search ignoring bit 7, resuming past a partial match as the original. */
export function strFindNocase(haystack, needle) {
  const nlen = needle.length, hlen = haystack.length;
  if (nlen > hlen || nlen === 0) return -1;
  const limit = hlen - nlen;
  let pos = 0;
  do {
    let matched = 0;
    while (matched < nlen && fold(haystack.charCodeAt(pos + matched)) === fold(needle.charCodeAt(matched))) matched++;
    if (matched === nlen) return pos;
    pos += matched + 1;
  } while (pos <= limit);
  return -1;
}

let timeSeedSource = null; // for the tests: a fixed clock

/** For the tests: timeSeed() gives fn() instead of reading the clock (null: the clock again). */
export function setTimeSeedSource(fn) {
  timeSeedSource = fn;
}

/** 2056: from the clock, 0-0xFFF, as the DOS time makes it. */
export function timeSeed() {
  if (timeSeedSource) return timeSeedSource();
  const t = new Date();
  const hundredths = Math.floor(t.getMilliseconds() / 10);
  const a = (((t.getSeconds() << 3) & 0xff) << 8) | hundredths;
  const b = (((t.getHours() << 1) & 0xff) << 8) | ((t.getMinutes() << 2) & 0xff);
  return ((a + b) ^ 0x91eb) & 0xfff;
}

let randState = 0; // ds:5420

/** 207e */
export function setRandomSeed(seed) {
  randState = seed & 0xffff;
}

/** 2092: lo..hi inclusive. state = ror3(state + 0x9248) ^ 0x9248 + 0x11. */
export function randomBetween(hi, lo) {
  let a = (randState + 0x9248) & 0xffff;
  a = ((a >> 3) | (a << 13)) & 0xffff;
  randState = ((a ^ 0x9248) + 0x11) & 0xffff;
  return ((randState & 0x7fff) % ((hi - lo + 1) & 0xffff)) + lo;
}
