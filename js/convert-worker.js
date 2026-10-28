// 変換は画面を止めないよう、この Worker の中で行う。
// 受け取る: { file, tolerance }  送る: { type: 'progress', ratio } / { type: 'done', data, stats } / { type: 'error', message }
import { KmlLineReader } from './kml-parse.js';
import { simplify } from './simplify.js';
import { FORMAT, encode } from './format.js';

const PALETTE = ['#e6194b', '#3c78d8', '#2e9d4f', '#f58231', '#911eb4', '#0aa5b5', '#d4a017', '#c2185b'];

self.onmessage = async e => {
  const { file, tolerance } = e.data;
  try {
    const { stream, size } = await openKml(file);
    const reader = new KmlLineReader();
    const r = stream.pipeThrough(new TextDecoderStream()).getReader();
    let read = 0, lastPost = 0;
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      reader.feed(value);
      read += value.length;
      const now = Date.now();
      if (now - lastPost > 150) { self.postMessage({ type: 'progress', ratio: Math.min(read / size, 1) }); lastPost = now; }
    }
    reader.finish();

    const lines = [];
    let ptsIn = 0, ptsOut = 0, w = 180, s = 90, ea = -180, n = -90, ci = 0;
    for (const pm of reader.placemarks) {
      const st = reader.resolve(pm.styleUrl);
      const color = pm.color || st?.color || PALETTE[ci++ % PALETTE.length];
      const width = pm.width || st?.width;
      for (const raw of pm.lines) {
        const pts = simplify(raw, tolerance);
        ptsIn += raw.length / 2;
        ptsOut += pts.length / 2;
        for (let i = 0; i < pts.length; i += 2) {
          const x = pts[i], y = pts[i + 1];
          if (x < w) w = x; if (x > ea) ea = x;
          if (y < s) s = y; if (y > n) n = y;
        }
        const line = { name: pm.name, color, p: encode(pts) };
        if (width) line.width = width;
        lines.push(line);
      }
    }
    if (!lines.length) throw new Error('線（LineString / gx:Track）が見つかりませんでした');

    const data = { type: FORMAT, v: 1, name: reader.docName || file.name.replace(/\.(kml|kmz)$/i, ''), bbox: [w, s, ea, n], lines };
    const outBytes = new TextEncoder().encode(JSON.stringify(data)).length;
    self.postMessage({ type: 'done', data, stats: { inBytes: file.size, outBytes, ptsIn, ptsOut, lines: lines.length } });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};

async function openKml(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) return openKmz(file);
  return { stream: file.stream(), size: file.size };
}

// KMZ（zip）の中から KML を1つ取り出す。doc.kml があればそれを優先
async function openKmz(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('KMZ（zip）を読めませんでした');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const isDoc = name => /(^|\/)doc\.kml$/i.test(name);
  let pick = null;
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const nlen = dv.getUint16(p + 28, true);
    const ent = {
      method: dv.getUint16(p + 10, true),
      csize: dv.getUint32(p + 20, true),
      usize: dv.getUint32(p + 24, true),
      off: dv.getUint32(p + 42, true),
      name: dec.decode(buf.subarray(p + 46, p + 46 + nlen)),
    };
    if (/\.kml$/i.test(ent.name) && (!pick || (isDoc(ent.name) && !isDoc(pick.name)))) pick = ent;
    p += 46 + nlen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  if (!pick) throw new Error('KMZの中にKMLがありません');
  const start = pick.off + 30 + dv.getUint16(pick.off + 26, true) + dv.getUint16(pick.off + 28, true);
  let stream = new Blob([buf.subarray(start, start + pick.csize)]).stream();
  if (pick.method === 8) stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
  else if (pick.method !== 0) throw new Error('この圧縮方式のKMZには対応していません');
  return { stream, size: pick.usize || pick.csize };
}
