// 軽量ファイル（*.line.json）の形と、線の符号化（Google の encoded polyline、精度 1e-5 度 ≒ 1m）
//
// { "type": "kml-light", "v": 1, "name": "...", "date": "YYYY-MM-DD", "bbox": [西, 南, 東, 北],
//   "lines": [ { "name": "...", "color": "#rrggbb", "width": 4, "p": "<encoded polyline>" } ] }
// date と width はなくてもよい

export const FORMAT = 'kml-light';
const FACTOR = 1e5;

// 外から来たファイルを信用しない：形が崩れていたり、変な値が入っていたりするものは受け取らない
export function isLight(obj) {
  return !!obj && obj.type === FORMAT && typeof obj.name === 'string'
    && (obj.date === undefined || obj.date === '' || /^\d{4}-\d{2}-\d{2}$/.test(obj.date))
    && Array.isArray(obj.bbox) && obj.bbox.length === 4 && obj.bbox.every(Number.isFinite)
    && Array.isArray(obj.lines) && obj.lines.length > 0
    && obj.lines.every(l => l && typeof l.p === 'string' && /^#[0-9a-f]{6}$/i.test(l.color)
      && (l.name === undefined || typeof l.name === 'string')
      && (l.width === undefined || Number.isFinite(l.width)));
}

function encNum(v) {
  v = v < 0 ? ~(v << 1) : v << 1;
  let s = '';
  while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
  return s + String.fromCharCode(v + 63);
}

// [lon, lat, ...] → 文字列。丸めたあと同じになった点は捨てる
export function encode(pts) {
  let out = '', plat = 0, plon = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const lat = Math.round(pts[i + 1] * FACTOR), lon = Math.round(pts[i] * FACTOR);
    if (i > 0 && lat === plat && lon === plon) continue;
    out += encNum(lat - plat) + encNum(lon - plon);
    plat = lat;
    plon = lon;
  }
  return out;
}

// 文字列 → [[lon, lat], ...]
export function decode(str) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let r = 0, sh = 0, b;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < str.length) {
    lat += next();
    lon += next();
    out.push([lon / FACTOR, lat / FACTOR]);
  }
  return out;
}

const esc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

// 軽量データ → KML 文字列
export function toKml(data) {
  const colors = [...new Set(data.lines.map(l => l.color + '|' + (l.width || 4)))];
  const styles = colors.map((k, i) => {
    const [c, w] = k.split('|');
    const abgr = 'ff' + c.slice(5, 7) + c.slice(3, 5) + c.slice(1, 3);
    return `<Style id="s${i}"><LineStyle><color>${abgr}</color><width>${w}</width></LineStyle></Style>`;
  });
  const marks = data.lines.map(l => {
    const s = colors.indexOf(l.color + '|' + (l.width || 4));
    const coords = decode(l.p).map(([x, y]) => x.toFixed(5) + ',' + y.toFixed(5)).join(' ');
    return `<Placemark><name>${esc(l.name || '')}</name><styleUrl>#s${s}</styleUrl>` +
      `<LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString></Placemark>`;
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
    `<name>${esc(data.name || '')}</name>\n${styles.join('\n')}\n${marks.join('\n')}\n</Document></kml>\n`;
}
