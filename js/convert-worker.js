// 変換は画面を止めないよう、この Worker の中で行う。
// 受け取る: { op: 'list', file }                      → { type: 'list', entries: [{ name, size, date }], fit }
//           { op: 'convert', file, entry?, tolerance } → { type: 'progress', ratio } … { type: 'done', data, stats }
// entry を付けると、zip の中のそのファイル（KML / KMZ / GPX、.gz 付きも）を変換する。失敗は { type: 'error', message }
// fit は zip の中にあった、読めない FIT ファイルの数
import { KmlLineReader } from './kml-parse.js';
import { simplify } from './simplify.js';
import { FORMAT, encode } from './format.js';

const TRACK_FILE = /\.(kml|kmz|gpx)(\.gz)?$/i;
const PALETTE = ['#e6194b', '#3c78d8', '#2e9d4f', '#f58231', '#911eb4', '#0aa5b5', '#d4a017', '#c2185b'];

self.onmessage = async e => {
  try {
    const m = e.data;
    if (m.op === 'list') {
      const all = (await readZipDir(m.file)).filter(z => !/(^|\/)(__MACOSX\/|\.)/.test(z.name));
      const entries = all
        .filter(z => TRACK_FILE.test(z.name))
        .map(z => ({ name: z.name, size: z.usize, date: z.date }));
      const fit = all.filter(z => /\.fit(\.gz)?$/i.test(z.name)).length;
      self.postMessage({ type: 'list', entries, fit });
    } else {
      self.postMessage(await convert(m));
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};

async function convert({ file, entry, tolerance }) {
  let src = file, name = file.name, lastMod = file.lastModified;
  if (entry) {
    const z = (await readZipDir(file)).find(x => x.name === entry);
    if (!z) throw new Error('zip の中に見つかりません');
    src = await new Response(await entryStream(file, z)).blob();
    name = entry.split('/').pop();
    lastMod = z.date;
  }

  const { stream, size } = await openKml(src);
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
  if (!lines.length) throw new Error('線（トラック）が見つかりませんでした');

  // 名前：ファイルの名前 → 線が1つだけならその名前（Strava の GPX は「Morning Ride」など）→ ファイル名
  const one = reader.placemarks.length === 1 ? reader.placemarks[0].name : '';
  const data = {
    type: FORMAT, v: 1,
    name: reader.docName || one || name.replace(TRACK_FILE, ''),
    date: logDate(reader.firstWhen, name, lastMod),
    bbox: [w, s, ea, n], lines,
  };
  const outBytes = new TextEncoder().encode(JSON.stringify(data)).length;
  return { type: 'done', data, src: { name, bytes: src.size }, stats: { inBytes: src.size, outBytes, ptsIn, ptsOut, lines: lines.length } };
}

// 記録の日付（YYYY-MM-DD）：KML の中の日時 → ファイル名の日付 → ファイルの更新日時 の順に探す
function logDate(when, name, lastMod) {
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const t = Date.parse(when);
  if (Number.isFinite(t)) return ymd(new Date(t));
  const m = /(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])/.exec(name);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return lastMod ? ymd(new Date(lastMod)) : '';
}

async function openKml(blob) {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  // .gpx.gz など（Strava の一括書き出しに入っている）。解凍してから読み直す
  if (head[0] === 0x1f && head[1] === 0x8b) {
    return openKml(await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob());
  }
  if (!(head[0] === 0x50 && head[1] === 0x4b)) return { stream: blob.stream(), size: blob.size };
  // KMZ：中の KML を1つ取り出す。doc.kml があればそれを優先
  const isDoc = s => /(^|\/)doc\.kml$/i.test(s);
  let pick = null;
  for (const z of await readZipDir(blob)) {
    if (/\.kml$/i.test(z.name) && (!pick || (isDoc(z.name) && !isDoc(pick.name)))) pick = z;
  }
  if (!pick) throw new Error('KMZの中にKMLがありません');
  return { stream: await entryStream(blob, pick), size: pick.usize || pick.csize };
}

// zip の目次を読む。ファイル全体は読まず、末尾と目次の部分だけ読む
async function readZipDir(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip を読めませんでした');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
  const buf = await blob.slice(cdOff, cdOff + cdSize).arrayBuffer();
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  const utf8 = new TextDecoder('utf-8', { fatal: true }), sjis = new TextDecoder('shift_jis');
  const out = [];
  for (let k = 0, p = 0; k < count && p + 46 <= u8.length; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true);
    const nlen = dv.getUint16(p + 28, true);
    const raw = u8.subarray(p + 46, p + 46 + nlen);
    let name;
    try { name = utf8.decode(raw); } catch { name = sjis.decode(raw); }  // Windows の zip は Shift_JIS のことがある
    const t = dv.getUint16(p + 12, true), d = dv.getUint16(p + 14, true);
    out.push({
      name, flags,
      method: dv.getUint16(p + 10, true),
      csize: dv.getUint32(p + 20, true),
      usize: dv.getUint32(p + 24, true),
      off: dv.getUint32(p + 42, true),
      date: new Date((d >> 9) + 1980, ((d >> 5) & 15) - 1, d & 31, t >> 11, (t >> 5) & 63, (t & 31) * 2).getTime(),
    });
    p += 46 + nlen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return out;
}

async function entryStream(blob, z) {
  if (z.flags & 1) throw new Error('パスワード付きの zip には対応していません');
  const lh = new DataView(await blob.slice(z.off, z.off + 30).arrayBuffer());
  const start = z.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const stream = blob.slice(start, start + z.csize).stream();
  if (z.method === 8) return stream.pipeThrough(new DecompressionStream('deflate-raw'));
  if (z.method === 0) return stream;
  throw new Error('この圧縮方式の zip には対応していません');
}
