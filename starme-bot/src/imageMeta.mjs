// Minimal image metadata reader (PNG / JPEG / WEBP) — no dependencies.
// Used by the offline heuristic analyzer and for diagnostics.

export function readImageMeta(buffer) {
  if (!buffer || buffer.length < 16) return null;
  const b = buffer;
  const sig = b.slice(0, 8);
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (sig.length === 8 && sig.every((v, i) => v === png[i])) {
    // PNG: IHDR width(4) height(4) at offset 16
    return { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) return readJpegMeta(b);
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') {
    return readWebpMeta(b);
  }
  return { format: 'unknown' };
}

function readJpegMeta(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    // Standalone markers without length
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3 ||
        marker === 0xc5 || marker === 0xc6 || marker === 0xc7 ||
        marker === 0xc9 || marker === 0xca || marker === 0xcb || marker === 0xcd || marker === 0xce || marker === 0xcf) {
      return { format: 'jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return { format: 'jpeg' };
}

function readWebpMeta(b) {
  const chunk = String.fromCharCode(...b.slice(12, 16));
  if (chunk === 'VP8X') {
    const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { format: 'webp', width: w, height: h };
  }
  if (chunk === 'VP8 ') return { format: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { format: 'webp' };
}
