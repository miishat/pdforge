// Packs a document's page text for saving to disk (so a large file's first search needn't read every page again),
// and unpacks it. Format: gzip of "PDFT" + version byte + page count (u32 LE), then per page a u32 LE byte length
// and the UTF-8 text. Streamed through gzip so the whole text is never held twice as one string.

const MAGIC = [0x50, 0x44, 0x46, 0x54]; // "PDFT"
const VERSION = 1;

function u32(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Compresses page texts (index = page number). */
export async function packPlainText(texts: string[]): Promise<Uint8Array> {
  const gzip = new CompressionStream("gzip");
  const result = collect(gzip.readable);
  const writer = gzip.writable.getWriter();
  const enc = new TextEncoder();
  const header = new Uint8Array(9);
  header.set(MAGIC, 0);
  header[4] = VERSION;
  header.set(u32(texts.length), 5);
  await writer.write(header);
  // Pages go into ~1 MB blocks, one write each: per-page writes would cost far more than the compression.
  const BLOCK = 1 << 20;
  let block = new Uint8Array(BLOCK + 4);
  let used = 0;
  const flush = async () => {
    if (!used) return;
    await writer.write(block.slice(0, used));
    used = 0;
  };
  for (const t of texts) {
    // A UTF-8 encoding is at most 3 bytes per UTF-16 unit.
    if (used + 4 + t.length * 3 > block.length) {
      await flush();
      if (4 + t.length * 3 > block.length) block = new Uint8Array(4 + t.length * 3);
    }
    const { written } = enc.encodeInto(t, block.subarray(used + 4));
    new DataView(block.buffer).setUint32(used, written, true);
    used += 4 + written;
  }
  await flush();
  await writer.close();
  return result;
}

/** Unpacks what `packPlainText` made. Null if the data is damaged or from another version. */
export async function unpackPlainText(data: Uint8Array): Promise<string[] | null> {
  let raw: Uint8Array;
  try {
    const gunzip = new DecompressionStream("gzip");
    const result = collect(gunzip.readable);
    result.catch(() => {}); // Damaged data fails both sides; the write's error is the one handled.
    const writer = gunzip.writable.getWriter();
    await writer.write(data as Uint8Array<ArrayBuffer>);
    await writer.close();
    raw = await result;
  } catch {
    return null;
  }
  if (raw.length < 9 || MAGIC.some((m, i) => raw[i] !== m) || raw[4] !== VERSION) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const count = view.getUint32(5, true);
  const dec = new TextDecoder("utf-8", { fatal: true });
  const texts: string[] = [];
  let at = 9;
  try {
    for (let i = 0; i < count; i++) {
      if (at + 4 > raw.length) return null;
      const len = view.getUint32(at, true);
      at += 4;
      if (at + len > raw.length) return null;
      texts.push(dec.decode(raw.subarray(at, at + len)));
      at += len;
    }
  } catch {
    return null;
  }
  return at === raw.length ? texts : null;
}

/** SHA-256 of the bytes, as hex: identifies a file's exact contents. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
