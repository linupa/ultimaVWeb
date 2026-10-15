// struct.js - fixed-layout records kept in byte arrays, as the original keeps them (a party member
// is 32 bytes of SAVED.GAM, a map object 8): a view class gives named fields over the bytes.

/**
 * Makes a view class for records laid out as `fields`: { name: [offset, type, length?] } with
 * type 'u8', 'i8', 'u16', 'i16' (little-endian), 'char' (a one-character string) or 'chars'
 * (a NUL-padded string of `length` bytes). `new View(bytes, offset)` reads and writes bytes in place.
 */
export function structView(fields) {
  class View {
    constructor(bytes, offset = 0) {
      this.bytes = bytes;
      this.offset = offset;
    }
  }
  for (const [name, [off, type, len]] of Object.entries(fields)) {
    let get, set;
    switch (type) {
      case 'u8':
        get = function () { return this.bytes[this.offset + off]; };
        set = function (v) { this.bytes[this.offset + off] = v; };
        break;
      case 'i8':
        get = function () { return (this.bytes[this.offset + off] << 24) >> 24; };
        set = function (v) { this.bytes[this.offset + off] = v; };
        break;
      case 'u16':
        get = function () { const p = this.offset + off; return this.bytes[p] | (this.bytes[p + 1] << 8); };
        set = function (v) { const p = this.offset + off; this.bytes[p] = v; this.bytes[p + 1] = v >> 8; };
        break;
      case 'i16':
        get = function () { const p = this.offset + off; return ((this.bytes[p] | (this.bytes[p + 1] << 8)) << 16) >> 16; };
        set = function (v) { const p = this.offset + off; this.bytes[p] = v; this.bytes[p + 1] = v >> 8; };
        break;
      case 'char':
        get = function () { return String.fromCharCode(this.bytes[this.offset + off]); };
        set = function (v) { this.bytes[this.offset + off] = typeof v === 'string' ? v.charCodeAt(0) : v; };
        break;
      case 'chars':
        get = function () {
          let s = '';
          for (let i = 0; i < len; i++) {
            const c = this.bytes[this.offset + off + i];
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          return s;
        };
        set = function (v) {
          for (let i = 0; i < len; i++) this.bytes[this.offset + off + i] = i < v.length ? v.charCodeAt(i) : 0;
        };
        break;
      default:
        throw new Error(`structView: bad type ${type}`);
    }
    Object.defineProperty(View.prototype, name, { get, set });
  }
  return View;
}
