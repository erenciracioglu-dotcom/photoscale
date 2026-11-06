/* ---------- raw-data recorder + minimal ZIP writer ----------
   Saves what the engine saw (small camera frames, depth, poses) so a
   measurement can be re-processed later, e.g. on a laptop, or debugged. */
const Zip = {
  table: null,
  crc32(u8) {
    if (!this.table) { this.table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; this.table[n] = c >>> 0; } }
    let c = 0xFFFFFFFF; const T = this.table;
    for (let i = 0; i < u8.length; i++) c = T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  },
  async build(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    const d = new Date(), dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)), dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate());
    for (const f of files) {
      let data = f.data;
      if (data instanceof Blob) data = new Uint8Array(await data.arrayBuffer());
      else if (typeof data === 'string') data = enc.encode(data);
      else if (!(data instanceof Uint8Array)) data = new Uint8Array(data.buffer || data);
      const name = enc.encode(f.name), crc = this.crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dt, true); lh.setUint16(12, dd, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dt, true); ch.setUint16(14, dd, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);
      offset += 30 + name.length + data.length;
    }
    let cdSize = 0; for (const c of central) cdSize += c.byteLength;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }
};

class Recorder {
  constructor() { this.frames = []; this.events = []; this.pending = 0; this.cv = document.createElement('canvas'); }
  add(fr, progress) {
    const i = this.frames.length;
    const rec = { i, t: +fr.t.toFixed(4), R: fr.R.map(v => +v.toFixed(6)), C: fr.C.map(v => +v.toFixed(5)), intr: fr.intr, progress: +progress.toFixed(4), hits: fr.hits || null };
    if (fr.depth) {
      const d = fr.depth, u = new Uint16Array(d.data.length);
      for (let k = 0; k < u.length; k++) u[k] = Math.min(65535, Math.round(d.data[k] * 1000));
      rec.depth = { nx: d.nx, ny: d.ny, p: d.p }; rec._d = u;
    }
    if (fr.gray && (i % 2 === 0)) {
      const w = fr.intr.w, h = fr.intr.h, g = fr.gray;
      this.cv.width = w; this.cv.height = h;
      const ctx = this.cv.getContext('2d'), im = ctx.createImageData(w, h);
      for (let k = 0, q = 0; k < w * h; k++, q += 4) { im.data[q] = im.data[q + 1] = im.data[q + 2] = g[k]; im.data[q + 3] = 255; }
      ctx.putImageData(im, 0, 0);
      this.pending++;
      this.cv.toBlob((b) => { rec._jpg = b; this.pending--; }, 'image/jpeg', 0.9);
      rec.gray = 'gray/' + String(i).padStart(6, '0') + '.jpg';
    }
    this.frames.push(rec);
  }
  event(type, data) { this.events.push(Object.assign({ type }, data)); }
  sizeMB() { let s = 0; for (const f of this.frames) { if (f._d) s += f._d.byteLength; if (f._jpg) s += f._jpg.size; } return s / 1e6; }
  async zip(extra) {
    while (this.pending > 0) await new Promise(r => setTimeout(r, 50));
    const files = [], depthParts = []; let off = 0;
    const meta = [];
    for (const f of this.frames) {
      const m = Object.assign({}, f); delete m._d; delete m._jpg;
      if (f._d) { m.depth.offset = off; m.depth.count = f._d.length; depthParts.push(f._d); off += f._d.length; }
      if (f._jpg) files.push({ name: f.gray, data: f._jpg });
      meta.push(m);
    }
    const depthAll = new Uint16Array(off); let o = 0; for (const p of depthParts) { depthAll.set(p, o); o += p.length; }
    files.unshift({ name: 'recording.json', data: JSON.stringify({ app: 'Photoscale', format: 1, note: 'gray images are stored bottom-up as read from GPU; flipMode tells the orientation', events: this.events, frames: meta, extra: extra || {} }) });
    files.push({ name: 'depth_mm_uint16.bin', data: new Uint8Array(depthAll.buffer) });
    return Zip.build(files);
  }
}
