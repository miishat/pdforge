// A compact sRGB ICC profile (version 2.1, display class), generated rather than shipped as a
// binary. PDF/A needs one as the document's output intent. Primaries are the sRGB ones adapted
// to D50 (as ICC requires); the tone curve is the sRGB piecewise curve sampled at 1024 points.

export function srgbProfile(): Uint8Array {
  const desc = textDescription("sRGB IEC61966-2.1 (PDForge)");
  const cprt = textType("No copyright, use freely");
  const xyz = (x: number, y: number, z: number) => {
    const b = new DataView(new ArrayBuffer(20));
    b.setUint32(0, tag("XYZ "));
    b.setInt32(8, s15(x));
    b.setInt32(12, s15(y));
    b.setInt32(16, s15(z));
    return new Uint8Array(b.buffer);
  };
  const curve = (() => {
    const n = 1024;
    const b = new DataView(new ArrayBuffer(12 + n * 2 + 2)); // padded to 4 bytes
    b.setUint32(0, tag("curv"));
    b.setUint32(8, n);
    for (let i = 0; i < n; i++) {
      const v = i / (n - 1);
      const lin = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      b.setUint16(12 + i * 2, Math.round(lin * 65535));
    }
    return new Uint8Array(b.buffer);
  })();

  const elements: [string, Uint8Array][] = [
    ["desc", desc],
    ["cprt", cprt],
    ["wtpt", xyz(0.9642, 1.0, 0.8249)],
    ["rXYZ", xyz(0.4361, 0.2225, 0.0139)],
    ["gXYZ", xyz(0.3851, 0.7169, 0.0971)],
    ["bXYZ", xyz(0.1431, 0.0606, 0.7141)],
    ["rTRC", curve],
  ];
  // The three curves are identical, so the green and blue tags share the red one's data.
  const shared: [string, string][] = [["gTRC", "rTRC"], ["bTRC", "rTRC"]];
  const count = elements.length + shared.length;
  const tableSize = 4 + count * 12;
  let offset = 128 + tableSize;
  const placed = new Map<string, { offset: number; size: number }>();
  const bodies: Uint8Array[] = [];
  for (const [sig, data] of elements) {
    placed.set(sig, { offset, size: data.length });
    const padded = pad4(data);
    bodies.push(padded);
    offset += padded.length;
  }
  const total = offset;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, total);
  v.setUint32(4, 0); // preferred CMM: none
  v.setUint32(8, 0x02100000); // version 2.1
  v.setUint32(12, tag("mntr"));
  v.setUint32(16, tag("RGB "));
  v.setUint32(20, tag("XYZ "));
  // Creation date 2024-01-01 00:00:00.
  [2024, 1, 1, 0, 0, 0].forEach((n, i) => v.setUint16(24 + i * 2, n));
  v.setUint32(36, tag("acsp"));
  v.setUint32(40, tag("MSFT"));
  v.setUint32(64, 0); // rendering intent: perceptual
  // Illuminant D50.
  v.setInt32(68, s15(0.9642));
  v.setInt32(72, s15(1.0));
  v.setInt32(76, s15(0.8249));
  v.setUint32(128, count);
  let t = 132;
  for (const [sig] of elements) {
    const p = placed.get(sig)!;
    v.setUint32(t, tag(sig));
    v.setUint32(t + 4, p.offset);
    v.setUint32(t + 8, p.size);
    t += 12;
  }
  for (const [sig, same] of shared) {
    const p = placed.get(same)!;
    v.setUint32(t, tag(sig));
    v.setUint32(t + 4, p.offset);
    v.setUint32(t + 8, p.size);
    t += 12;
  }
  let o = 128 + tableSize;
  for (const b of bodies) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

function tag(s: string): number {
  return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
}

function s15(x: number): number {
  return Math.round(x * 65536);
}

function pad4(b: Uint8Array): Uint8Array {
  if (b.length % 4 === 0) return b;
  const out = new Uint8Array(b.length + (4 - (b.length % 4)));
  out.set(b);
  return out;
}

/** textDescriptionType (ICC v2): ASCII, then empty Unicode and ScriptCode parts. */
function textDescription(text: string): Uint8Array {
  const ascii = new TextEncoder().encode(text + "\0");
  const b = new Uint8Array(12 + ascii.length + 4 + 4 + 2 + 1 + 67);
  const v = new DataView(b.buffer);
  v.setUint32(0, tag("desc"));
  v.setUint32(8, ascii.length);
  b.set(ascii, 12);
  return b;
}

function textType(text: string): Uint8Array {
  const ascii = new TextEncoder().encode(text + "\0");
  const b = new Uint8Array(8 + ascii.length);
  new DataView(b.buffer).setUint32(0, tag("text"));
  b.set(ascii, 8);
  return b;
}
