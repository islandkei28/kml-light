// KMLを少しずつ読み、線（LineString / LinearRing / gx:Track）だけを取り出す。
// 大きなファイルでもメモリに全部載せないよう、DOMParser は使わない。

const local = q => q.slice(q.indexOf(':') + 1);

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodeEntities = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);

// KMLの色は aabbggrr
function kmlColor(t) {
  t = t.trim();
  if (!/^[0-9a-f]{8}$/i.test(t)) return null;
  return '#' + t.slice(6, 8) + t.slice(4, 6) + t.slice(2, 4);
}

export class KmlLineReader {
  constructor() {
    this.buf = '';
    this.stack = [];
    this.styles = new Map();     // Style id → { color, width }
    this.styleMaps = new Map();  // StyleMap id → normal の styleUrl
    this.placemarks = [];        // { name, styleUrl, color, width, lines: [[lon, lat, ...]] }
    this.docName = '';
    this.pm = null;
    this.style = null;
    this.styleMap = null;
    this.pair = null;
    this.line = null;
    this.coordsOn = false;
    this.carry = '';
    this.text = null;
    this.anon = 0;
  }

  feed(chunk) {
    const s = this.buf + chunk;
    let i = 0;
    for (;;) {
      const lt = s.indexOf('<', i);
      if (lt < 0) { this._text(s.slice(i)); i = s.length; break; }
      if (lt > i) this._text(s.slice(i, lt));
      i = lt;
      const rest = s.length - i;
      if (rest < 9 && ('<![CDATA['.startsWith(s.slice(i)) || '<!--'.startsWith(s.slice(i)))) break;
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i + 4);
        if (end < 0) break;
        i = end + 3;
      } else if (s.startsWith('<![CDATA[', i)) {
        const end = s.indexOf(']]>', i + 9);
        if (end < 0) break;
        this._text(s.slice(i + 9, end), true);
        i = end + 3;
      } else {
        const end = s.indexOf('>', i + 1);
        if (end < 0) break;
        this._tag(s.slice(i + 1, end));
        i = end + 1;
      }
    }
    this.buf = s.slice(i);
  }

  finish() {
    if (this.buf) { this.feed(''); this._text(this.buf); this.buf = ''; }
  }

  // styleUrl（#id）から線の色と太さを探す。StyleMap は normal をたどる
  resolve(url) {
    if (!url || url[0] !== '#') return null;
    let id = url.slice(1);
    const normal = this.styleMaps.get(id);
    if (normal != null) {
      if (normal[0] !== '#') return null;
      id = normal.slice(1);
    }
    return this.styles.get(id) || null;
  }

  _text(s, cdata) {
    if (this.coordsOn) this._coords(s);
    else if (this.text !== null) this.text += cdata ? s : decodeEntities(s);
  }

  _tag(raw) {
    const c = raw[0];
    if (c === '?' || c === '!') return;
    if (c === '/') { this._close(local(raw.slice(1).trim())); return; }
    const m = /^[^\s/>]+/.exec(raw);
    if (!m) return;
    const name = local(m[0]);
    const id = /\bid\s*=\s*["']([^"']*)["']/.exec(raw)?.[1];
    this._open(name, id);
    if (raw.endsWith('/')) this._close(name);
  }

  _open(name, id) {
    const parent = this.stack[this.stack.length - 1];
    this.stack.push(name);
    switch (name) {
      case 'Placemark':
        this.pm = { name: '', styleUrl: '', color: null, width: null, lines: [] };
        break;
      case 'Style':
        this.style = { id, color: null, width: null };
        break;
      case 'StyleMap':
        this.styleMap = { id, normal: '' };
        break;
      case 'Pair':
        this.pair = { key: '', url: '' };
        break;
      case 'LineString': case 'LinearRing': case 'Track':
        this.line = [];
        break;
      case 'coordinates':
        if (this.line) { this.coordsOn = true; this.carry = ''; }
        break;
      case 'coord':
        if (this.line) this.text = '';
        break;
      case 'name':
        if ((parent === 'Placemark' && this.pm) || (parent === 'Document' && !this.docName)) this.text = '';
        break;
      case 'color': case 'width':
        if (this.style && parent === 'LineStyle') this.text = '';
        break;
      case 'styleUrl': case 'key':
        this.text = '';
        break;
    }
  }

  _close(name) {
    const idx = this.stack.lastIndexOf(name);
    if (idx < 0) return;
    this.stack.length = idx;
    const parent = this.stack[idx - 1];
    const t = this.text;
    this.text = null;
    switch (name) {
      case 'name':
        if (t === null) break;
        if (parent === 'Placemark' && this.pm) this.pm.name = t.trim();
        else if (parent === 'Document' && !this.docName) this.docName = t.trim();
        break;
      case 'color':
        if (t !== null && this.style) this.style.color = kmlColor(t);
        break;
      case 'width':
        if (t !== null && this.style) this.style.width = parseFloat(t) || null;
        break;
      case 'styleUrl':
        if (t === null) break;
        if (this.pair) this.pair.url = t.trim();
        else if (this.pm) this.pm.styleUrl = t.trim();
        break;
      case 'key':
        if (t !== null && this.pair) this.pair.key = t.trim();
        break;
      case 'Style': {
        const st = this.style;
        this.style = null;
        if (!st) break;
        const val = { color: st.color, width: st.width };
        if (this.pair) {
          const anonId = '\0anon' + this.anon++;
          this.styles.set(anonId, val);
          this.pair.url = '#' + anonId;
        } else if (this.pm) {
          if (st.color) this.pm.color = st.color;
          if (st.width) this.pm.width = st.width;
        } else if (st.id) {
          this.styles.set(st.id, val);
        }
        break;
      }
      case 'Pair':
        if (this.pair && this.styleMap && this.pair.key === 'normal') this.styleMap.normal = this.pair.url;
        this.pair = null;
        break;
      case 'StyleMap':
        if (this.styleMap?.id) this.styleMaps.set(this.styleMap.id, this.styleMap.normal);
        this.styleMap = null;
        break;
      case 'coordinates':
        if (this.coordsOn) { this._coords(' '); this.coordsOn = false; }
        break;
      case 'coord':
        if (t !== null && this.line) {
          const p = t.trim().split(/\s+/);
          const lon = +p[0], lat = +p[1];
          if (Number.isFinite(lon) && Number.isFinite(lat)) this.line.push(lon, lat);
        }
        break;
      case 'LineString': case 'LinearRing': case 'Track':
        if (this.line && this.pm && this.line.length >= 4) this.pm.lines.push(this.line);
        this.line = null;
        break;
      case 'Placemark':
        if (this.pm && this.pm.lines.length) this.placemarks.push(this.pm);
        this.pm = null;
        break;
    }
  }

  // "lon,lat[,alt] lon,lat ..." を少しずつ読む。最後の欠けた組は carry に残す
  _coords(s) {
    const parts = (this.carry + s).split(/\s+/);
    this.carry = parts.pop();
    const line = this.line;
    for (const p of parts) {
      if (!p) continue;
      const a = p.indexOf(',');
      if (a < 0) continue;
      const b = p.indexOf(',', a + 1);
      const lon = +p.slice(0, a);
      const lat = +(b < 0 ? p.slice(a + 1) : p.slice(a + 1, b));
      if (Number.isFinite(lon) && Number.isFinite(lat)) line.push(lon, lat);
    }
  }
}
