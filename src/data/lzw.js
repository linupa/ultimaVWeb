// lzw.js - the LZW decompression of the game's graphics files (read_file_buffered, 0000:135a).
// Ported from the C++ port's lzw.cpp.
//
// File: 4-byte little-endian decompressed size, then LZW codes packed least-significant bit first.
// Codes start 9 bits wide and grow to 12; 0x100 resets the dictionary, 0x101 ends the data.

const MAX_CODES = 4096;

/** Returns the decompressed bytes, or null if the data is bad. */
export function lzwDecompress(input) {
  if (input.length < 4) return null;
  const want = (input[0] | (input[1] << 8) | (input[2] << 16) | (input[3] << 24)) >>> 0;
  const out = new Uint8Array(want);
  const prefix = new Uint16Array(MAX_CODES);
  const suffix = new Uint8Array(MAX_CODES);
  const stack = new Uint8Array(MAX_CODES);
  let bitPos = 32, n = 0;
  let width = 9, nextCode = 0x102, limit = 0x200, oldCode = -1, first = 0;
  for (;;) {
    const byte = bitPos >> 3;
    if (byte >= input.length) return null; // ran out of input without an end code
    let window = input[byte];
    if (byte + 1 < input.length) window |= input[byte + 1] << 8;
    if (byte + 2 < input.length) window |= input[byte + 2] << 16;
    const code = (window >>> (bitPos & 7)) & ((1 << width) - 1);
    bitPos += width;

    if (code === 0x101) return n === want ? out : null;
    if (code === 0x100) {
      width = 9;
      limit = 0x200;
      nextCode = 0x102;
      oldCode = -1;
      continue;
    }
    if (oldCode < 0) { // the first code after a reset is a literal
      if (code > 0xff) return null;
      if (n < want) out[n] = code;
      n++;
      oldCode = code;
      first = code;
      continue;
    }
    let sp = 0, c = code;
    if (code >= nextCode) { // KwKwK: the previous string + its first byte
      stack[sp++] = first;
      c = oldCode;
    }
    while (c > 0xff) {
      if (c >= nextCode || sp >= MAX_CODES - 1) return null;
      stack[sp++] = suffix[c];
      c = prefix[c];
    }
    stack[sp++] = c;
    first = c;
    while (sp > 0) {
      if (n < want) out[n] = stack[sp - 1];
      n++;
      sp--;
    }
    if (nextCode < MAX_CODES) {
      prefix[nextCode] = oldCode;
      suffix[nextCode] = first;
    }
    nextCode++;
    oldCode = code;
    if (nextCode >= limit && width < 12) {
      width++;
      limit <<= 1;
    }
  }
}
