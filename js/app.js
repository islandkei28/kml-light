import { listRoutes, putRoute, deleteRoute } from './store.js';
import { decode, isLight, toKml } from './format.js';

const $ = id => document.getElementById(id);
const GSI = 'https://cyberjapandata.gsi.go.jp/xyz/';
const BASES = [
  { id: 'std', label: '標準', url: GSI + 'std/{z}/{x}/{y}.png' },
  { id: 'pale', label: '淡色', url: GSI + 'pale/{z}/{x}/{y}.png' },
  { id: 'photo', label: '写真', url: GSI + 'seamlessphoto/{z}/{x}/{y}.jpg' },
];

let routes = [];            // 保存したルート { id, name, created, visible, bytes, data }
let preview = null;         // 変換したがまだ保存していないデータ
const featureCache = new Map();

// ---------- 地図 ----------

// CSP で blob: の Worker を禁じているので、MapLibre の Worker は別ファイルから読む
maplibregl.setWorkerUrl('vendor/maplibre-gl-4.7.1/maplibre-gl-csp-worker.js');

const map = new maplibregl.Map({
  container: 'map',
  center: [138, 37],
  zoom: 4.3,
  attributionControl: { compact: true },
  style: {
    version: 8,
    sources: Object.fromEntries(BASES.map(b => [b.id, {
      type: 'raster', tiles: [b.url], tileSize: 256, maxzoom: 18,
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
    }])),
    layers: BASES.map((b, i) => ({
      id: b.id, type: 'raster', source: b.id, layout: { visibility: i === 0 ? 'visible' : 'none' },
    })),
  },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true, positionOptions: { enableHighAccuracy: true } }), 'top-right');

const mapReady = new Promise(res => map.on('load', res));
mapReady.then(() => {
  map.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const layout = { 'line-join': 'round', 'line-cap': 'round' };
  map.addLayer({
    id: 'route-casing', type: 'line', source: 'routes', layout,
    paint: { 'line-color': '#fff', 'line-width': ['+', ['get', 'width'], 3], 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'route-line', type: 'line', source: 'routes', layout,
    paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] },
  });
  map.on('click', 'route-line', e => {
    const p = e.features[0].properties;
    const div = document.createElement('div');
    div.innerHTML = '<b></b><br><small></small>';
    div.querySelector('b').textContent = p.name || '（名前なし）';
    div.querySelector('small').textContent = p.route;
    new maplibregl.Popup().setLngLat(e.lngLat).setDOMContent(div).addTo(map);
  });
  map.on('mouseenter', 'route-line', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'route-line', () => { map.getCanvas().style.cursor = ''; });
  redraw();
});

let baseIdx = 0;
$('baseBtn').onclick = () => {
  map.setLayoutProperty(BASES[baseIdx].id, 'visibility', 'none');
  baseIdx = (baseIdx + 1) % BASES.length;
  map.setLayoutProperty(BASES[baseIdx].id, 'visibility', 'visible');
  $('baseBtn').textContent = '地図：' + BASES[baseIdx].label;
};

function features(key, data) {
  let f = featureCache.get(key);
  if (!f) {
    f = data.lines.map(l => ({
      type: 'Feature',
      properties: { name: l.name, route: data.name, color: l.color, width: Math.min(Math.max(l.width || 4, 3), 8) },
      geometry: { type: 'LineString', coordinates: decode(l.p) },
    }));
    featureCache.set(key, f);
  }
  return f;
}

function redraw() {
  const src = map.getSource('routes');
  if (!src) return;
  const all = [];
  for (const r of routes) if (r.visible) all.push(...features(r.id, r.data));
  if (preview) all.push(...features('preview', preview));
  src.setData({ type: 'FeatureCollection', features: all });
}

function fitTo(data) {
  const [w, s, e, n] = data.bbox;
  const sheetH = window.innerWidth >= 720 ? 0 : $('sheet').offsetHeight;
  map.fitBounds([[w, s], [e, n]], {
    padding: { top: 60, left: window.innerWidth >= 720 ? 410 : 30, right: 60, bottom: sheetH + 30 },
    maxZoom: 16, duration: 600,
  });
}

// ---------- 一覧 ----------

const fmtBytes = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const fmtNum = n => n.toLocaleString('ja-JP');

function renderList() {
  const ul = $('list');
  ul.textContent = '';
  $('count').textContent = routes.length ? `（${routes.length}）` : '';
  $('empty').hidden = routes.length > 0 || !$('conv').hidden;
  for (const r of [...routes].sort((a, b) => b.created - a.created)) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="item">
        <input type="checkbox" aria-label="地図に表示">
        <span class="swatch"></span>
        <button class="info"><b></b><small></small></button>
      </div>
      <div class="actions">
        <button data-a="fit">地図で見る</button>
        <button data-a="kml">KMLで書き出す</button>
        <button data-a="light">軽量ファイルで書き出す</button>
        <button data-a="rename">名前を変える</button>
        <button data-a="del" class="danger">削除</button>
      </div>`;
    const cb = li.querySelector('input');
    cb.checked = r.visible;
    cb.onchange = async () => { r.visible = cb.checked; redraw(); await putRoute(r); };
    li.querySelector('.swatch').style.background = r.data.lines[0]?.color || '#888';
    li.querySelector('b').textContent = r.data.name;
    li.querySelector('small').textContent =
      `${r.data.lines.length}本・${fmtBytes(r.bytes)}・${new Date(r.created).toLocaleDateString('ja-JP')}`;
    li.querySelector('.info').onclick = () => {
      li.classList.toggle('open');
      if (!r.visible) { r.visible = cb.checked = true; redraw(); putRoute(r); }
      fitTo(r.data);
    };
    li.querySelector('.actions').onclick = e => {
      const a = e.target.dataset?.a;
      if (a) onAction(a, r);
    };
    ul.append(li);
  }
}

async function onAction(a, r) {
  const base = r.data.name.replace(/[\\/:*?"<>|]/g, '_') || 'route';
  if (a === 'fit') fitTo(r.data);
  else if (a === 'kml') {
    await saveFile(new Blob([toKml(r.data)], { type: 'application/vnd.google-earth.kml+xml' }), base + '.kml');
  } else if (a === 'light') {
    await saveFile(new Blob([JSON.stringify(r.data)], { type: 'application/json' }), base + '.line.json');
  } else if (a === 'rename') {
    const name = prompt('新しい名前', r.data.name);
    if (!name) return;
    r.data.name = name.trim();
    featureCache.delete(r.id);
    await putRoute(r);
    renderList();
    redraw();
  } else if (a === 'del') {
    if (!confirm(`「${r.data.name}」を削除しますか？`)) return;
    await deleteRoute(r.id);
    routes = routes.filter(x => x !== r);
    featureCache.delete(r.id);
    renderList();
    redraw();
  }
}

// スマホでは共有シート、PCや共有できない形式ではダウンロード
async function saveFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$('sheetToggle').onclick = () => $('sheet').classList.toggle('collapsed');

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ---------- 変換 ----------

let convFile = null, worker = null;

$('openBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) openFile(f);
};

async function openFile(f) {
  if (/\.json$/i.test(f.name)) return importLight(f);
  if (!/\.(kml|kmz)$/i.test(f.name)) {
    const head = new Uint8Array(await f.slice(0, 2).arrayBuffer());
    const text = await f.slice(0, 2000).text();
    if (!(head[0] === 0x50 && head[1] === 0x4b) && !/<kml[\s>]/.test(text)) {
      toast('KML / KMZ / 軽量ファイル（.line.json）を選んでください');
      return;
    }
  }
  convFile = f;
  $('convName').textContent = f.name;
  $('convSize').textContent = fmtBytes(f.size);
  $('conv').hidden = false;
  $('sheet').classList.remove('collapsed');
  renderList();
  convert();
}

async function importLight(f) {
  try {
    const data = JSON.parse(await f.text());
    if (!isLight(data)) throw new Error();
    await addRoute(data, f.size);
    toast(`「${data.name}」を読み込みました`);
  } catch {
    toast('軽量ファイルとして読めませんでした');
  }
}

function tolerance() {
  return +document.querySelector('input[name=tol]:checked').value;
}
document.querySelectorAll('input[name=tol]').forEach(r => { r.onchange = () => convFile && convert(); });

let lastStats = null;
function convert() {
  worker?.terminate();
  preview = null;
  redraw();
  $('convSave').disabled = true;
  $('convProg').hidden = false;
  $('convProg').value = 0;
  $('convStat').textContent = '読み込み中…';
  worker = new Worker(new URL('./convert-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'progress') {
      $('convProg').value = m.ratio;
      $('convStat').textContent = `読み込み中… ${Math.round(m.ratio * 100)}%`;
    } else if (m.type === 'done') {
      worker.terminate();
      worker = null;
      $('convProg').hidden = true;
      preview = m.data;
      lastStats = m.stats;
      featureCache.delete('preview');
      const s = m.stats;
      $('convStat').innerHTML =
        `${fmtBytes(s.inBytes)} → <b>${fmtBytes(s.outBytes)}</b>（線 ${s.lines}本、点 ${fmtNum(s.ptsIn)} → ${fmtNum(s.ptsOut)}）`;
      $('convSave').disabled = false;
      redraw();
      fitTo(preview);
    } else {
      worker.terminate();
      worker = null;
      $('convProg').hidden = true;
      $('convStat').textContent = '変換できませんでした：' + m.message;
    }
  };
  worker.onerror = e => {
    $('convProg').hidden = true;
    $('convStat').textContent = '変換できませんでした：' + (e.message || 'Worker のエラー');
  };
  worker.postMessage({ file: convFile, tolerance: tolerance() });
}

function closeConv() {
  worker?.terminate();
  worker = null;
  convFile = null;
  preview = null;
  featureCache.delete('preview');
  $('conv').hidden = true;
  renderList();
  redraw();
}

$('convCancel').onclick = closeConv;
$('convSave').onclick = async () => {
  const data = preview;
  closeConv();
  await addRoute(data, lastStats.outBytes);
  toast(`「${data.name}」を保存しました`);
};

async function addRoute(data, bytes) {
  const r = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    created: Date.now(), visible: true, bytes, data,
  };
  await putRoute(r);
  routes.push(r);
  renderList();
  await mapReady;
  redraw();
  fitTo(data);
}

// ---------- 起動 ----------

(async () => {
  routes = await listRoutes();
  renderList();
  await mapReady;
  redraw();
  navigator.storage?.persist?.();

  // Android の共有メニューから送られたファイル（sw.js が一時保存している）
  if (new URLSearchParams(location.search).has('shared') && 'caches' in window) {
    history.replaceState(null, '', location.pathname);
    const cache = await caches.open('share');
    const res = await cache.match('shared-file');
    if (res) {
      await cache.delete('shared-file');
      const name = decodeURIComponent(res.headers.get('X-Filename') || 'shared.kml');
      openFile(new File([await res.blob()], name));
    }
  }
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
