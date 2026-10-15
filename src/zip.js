// zip.js - reads the files out of a ZIP archive, so a player can give the game as the ZIP it came
// in. Only what game archives use: stored (method 0) and deflated (method 8) entries, found
// through the central directory; deflate is the browser's own (DecompressionStream).

const u16 = (b, p) => b[p] | (b[p + 1] << 8);
const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

/** The end-of-central-directory record: at the end, before a comment of up to 64 KB. */
function findEnd(b) {
  for (let p = b.length - 22; p >= 0 && p >= b.length - 22 - 0xffff; p--)
    if (u32(b, p) === 0x06054b50) return p;
  throw new Error('not a ZIP file');
}

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The archive's files as [{ name, bytes }], `name` with its folders ("ultima5/DATA.OVL").
 * Folders themselves are left out. Throws if the archive is damaged or uses something else.
 */
export async function readZip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const end = findEnd(b);
  const count = u16(b, end + 10);
  let p = u32(b, end + 16); // the central directory
  const files = [];
  for (let i = 0; i < count; i++) {
    if (u32(b, p) !== 0x02014b50) throw new Error('damaged ZIP file');
    const method = u16(b, p + 10);
    const packed = u32(b, p + 20), size = u32(b, p + 24);
    const nameLen = u16(b, p + 28), extraLen = u16(b, p + 30), commentLen = u16(b, p + 32);
    const local = u32(b, p + 42);
    const name = new TextDecoder('latin1').decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (u32(b, local) !== 0x04034b50) throw new Error('damaged ZIP file');
    const start = local + 30 + u16(b, local + 26) + u16(b, local + 28); // after the local header
    const data = b.subarray(start, start + packed);
    let out;
    if (method === 0) out = data.slice();
    else if (method === 8) out = await inflate(data);
    else throw new Error(`${name}: unsupported ZIP compression (method ${method})`);
    if (out.length !== size) throw new Error(`${name}: damaged in the ZIP file`);
    files.push({ name, bytes: out });
  }
  return files;
}
