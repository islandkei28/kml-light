import { listRoutes, putRoute, putRoutes, deleteRoute } from './store.js';
import { decode, isLight, toKml } from './format.js';

const $ = id => document.getElementById(id);
const GSI = 'https://cyberjapandata.gsi.go.jp/xyz/';
const BASES = [
  { id: 'std', label: '標準', url: GSI + 'std/{z}/{x}/{y}.png' },
  { id: 'pale', label: '淡色', url: GSI + 'pale/{z}/{x}/{y}.png' },
  { id: 'photo', label: '写真', url: GSI + 'seamlessphoto/{z}/{x}/{y}.jpg' },
];
const BACKUP = 'kml-light-backup';
const YEAR_COLORS = ['#e6194b', '#3c78d8', '#2e9d4f', '#f58231', '#911eb4', '#0aa5b5', '#d4a017', '#c2185b', '#6d4c41', '#455a64'];

let routes = [];            // 保存したルート { id, created, visible, bytes, src: { name, bytes }, data }
let preview = null;         // 変換したがまだ保存していないデータ
let yearMode = false;
let filterText = '';
const openYears = new Set();
let openYearsInit = false;
const featureCache = new Map();

const yearOf = data => (data.date || '').slice(0, 4);
const yearColor = y => YEAR_COLORS[+y % YEAR_COLORS.length];

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
    div.querySelector('small').textContent = [p.route, p.date].filter(Boolean).join('・');
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
      properties: {
        name: l.name, route: data.name, date: data.date || '', year: yearOf(data),
        color: l.color, width: Math.min(Math.max(l.width || 4, 3), 8),
      },
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

  const years = [...new Set(all.map(f => f.properties.year).filter(Boolean))];
  let color = ['get', 'color'];
  if (yearMode && years.length) {
    color = ['match', ['get', 'year']];
    for (const y of years) color.push(y, yearColor(y));
    color.push('#888888');
  }
  map.setPaintProperty('route-line', 'line-color', color);
}

function fitTo(list) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const d of list) {
    w = Math.min(w, d.bbox[0]); s = Math.min(s, d.bbox[1]);
    e = Math.max(e, d.bbox[2]); n = Math.max(n, d.bbox[3]);
  }
  if (w > e) return;
  const wide = window.innerWidth >= 720;
  map.fitBounds([[w, s], [e, n]], {
    padding: { top: 60, left: wide ? 410 : 30, right: 60, bottom: (wide ? 0 : $('sheet').offsetHeight) + 30 },
    maxZoom: 16, duration: 600,
  });
}

// ---------- 一覧 ----------

const fmtBytes = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const fmtNum = n => n.toLocaleString('ja-JP');

function shownRoutes() {
  const q = filterText.trim().toLowerCase();
  return routes
    .filter(r => !q || [r.data.name, r.data.date, r.src?.name].some(s => s && s.toLowerCase().includes(q)))
    .sort((a, b) => (b.data.date || '').localeCompare(a.data.date || '') || b.created - a.created);
}

function renderList() {
  const ul = $('list');
  ul.textContent = '';
  $('count').textContent = routes.length ? `（${fmtNum(routes.length)}）` : '';
  $('empty').hidden = routes.length > 0 || !$('conv').hidden;

  const groups = new Map();
  for (const r of shownRoutes()) {
    const y = yearOf(r.data);
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y).push(r);
  }
  if (!openYearsInit && groups.size) { openYears.add(groups.keys().next().value); openYearsInit = true; }
  const searching = filterText.trim() !== '';
  for (const [y, list] of groups) {
    const open = searching || openYears.has(y);
    ul.append(yearRow(y, list, open));
    if (open) for (const r of list) ul.append(routeRow(r));
  }
  if (searching && !groups.size) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '見つかりません';
    ul.append(li);
  }
}

function yearRow(y, list, open) {
  const li = document.createElement('li');
  li.className = 'year' + (open ? '' : ' closed');
  li.innerHTML = '<input type="checkbox"><span class="swatch"></span><button><span></span><span class="caret">▾</span></button>';
  const label = `${y ? y + '年' : '日付なし'}（${fmtNum(list.length)}）`;
  const cb = li.querySelector('input');
  const nVis = list.filter(r => r.visible).length;
  cb.checked = nVis === list.length;
  cb.indeterminate = nVis > 0 && nVis < list.length;
  cb.setAttribute('aria-label', label + 'を地図に表示');
  cb.onchange = () => setVisible(list, cb.checked);
  const sw = li.querySelector('.swatch');
  if (yearMode && y) sw.style.background = yearColor(y);
  else sw.hidden = true;
  li.querySelector('button span').textContent = label;
  li.querySelector('button').onclick = () => {
    if (openYears.has(y)) openYears.delete(y); else openYears.add(y);
    renderList();
  };
  return li;
}

function routeRow(r) {
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
  cb.onchange = () => setVisible([r], cb.checked);
  const y = yearOf(r.data);
  li.querySelector('.swatch').style.background = yearMode && y ? yearColor(y) : r.data.lines[0]?.color || '#888';
  li.querySelector('b').textContent = r.data.name;
  li.querySelector('small').textContent = `${r.data.date || '日付なし'}・${r.data.lines.length}本・${fmtBytes(r.bytes)}`;
  li.querySelector('.info').onclick = () => {
    li.classList.toggle('open');
    if (!r.visible) setVisible([r], true);
    fitTo([r.data]);
  };
  li.querySelector('.actions').onclick = e => {
    const a = e.target.dataset?.a;
    if (a) onAction(a, r);
  };
  return li;
}

async function setVisible(list, v) {
  for (const r of list) r.visible = v;
  renderList();
  redraw();
  await putRoutes(list);
}

async function onAction(a, r) {
  const base = r.data.name.replace(/[\\/:*?"<>|]/g, '_') || 'route';
  if (a === 'fit') fitTo([r.data]);
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
$('toolsBtn').onclick = () => {
  const show = $('tools').hidden;
  $('tools').hidden = !show;
  $('toolsBtn').setAttribute('aria-expanded', show);
  $('sheet').classList.remove('collapsed');
};
$('search').oninput = e => { filterText = e.target.value; renderList(); };
$('showAll').onclick = () => setVisible(shownRoutes(), true);
$('hideAll').onclick = () => setVisible(shownRoutes(), false);
$('yearMode').onclick = () => {
  yearMode = !yearMode;
  $('yearMode').setAttribute('aria-pressed', yearMode);
  renderList();
  redraw();
};
$('backupBtn').onclick = exportBackup;

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// ---------- バックアップ ----------

async function exportBackup() {
  if (!routes.length) { toast('まだルートがありません'); return; }
  const body = JSON.stringify({
    type: BACKUP, v: 1, exported: new Date().toISOString(),
    routes: routes.map(({ id, created, visible, bytes, src, data }) => ({ id, created, visible, bytes, src, data })),
  });
  const gz = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  toast(`${fmtNum(routes.length)}件を書き出します（${fmtBytes(gz.size)}）`);
  await saveFile(new Blob([gz], { type: 'application/gzip' }), `kml-light-backup-${stamp}.json.gz`);
}

// 軽量ファイル（.line.json）かバックアップ（.json / .json.gz）を読み込む
async function importJson(f, gz) {
  try {
    const text = gz ? await new Response(f.stream().pipeThrough(new DecompressionStream('gzip'))).text() : await f.text();
    const obj = JSON.parse(text);
    if (obj?.type === BACKUP && Array.isArray(obj.routes)) {
      const have = new Set(routes.map(r => r.id));
      const add = obj.routes
        .filter(r => r && typeof r.id === 'string' && isLight(r.data) && !have.has(r.id))
        .map(r => ({
          id: r.id, created: +r.created || Date.now(), visible: r.visible !== false, bytes: +r.bytes || 0,
          src: r.src && typeof r.src.name === 'string' ? { name: r.src.name, bytes: +r.src.bytes || 0 } : null,
          data: r.data,
        }));
      await putRoutes(add);
      routes.push(...add);
      renderList();
      redraw();
      const same = obj.routes.length - add.length;
      toast(`バックアップから${fmtNum(add.length)}件を戻しました` + (same ? `（${fmtNum(same)}件は既にあるか読めないので飛ばしました）` : ''));
    } else if (isLight(obj)) {
      await addRoute(obj, f.size, null);
      toast(`「${obj.name}」を読み込みました`);
    } else {
      throw new Error();
    }
  } catch {
    toast(`${f.name} を読めませんでした`);
  }
}

// ---------- 変換 ----------

let worker = null, gen = 0;
const getWorker = () => worker ??= new Worker(new URL('./convert-worker.js', import.meta.url), { type: 'module' });
function stopWorker() {
  worker?.terminate();
  worker = null;
  gen++;
}
// Worker に1つ頼んで結果を待つ。stopWorker() したあとの返事は捨てる
function ask(msg, onProgress) {
  const w = getWorker(), g = gen;
  return new Promise((res, rej) => {
    w.onmessage = e => {
      if (g !== gen) return;
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.ratio);
      else if (m.type === 'error') rej(new Error(m.message));
      else res(m);
    };
    w.onerror = e => { if (g === gen) rej(new Error(e.message || 'Worker のエラー')); };
    w.postMessage(msg);
  });
}

$('openBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) openFiles(files);
};

async function sniff(f) {
  if (/\.json$/i.test(f.name)) return 'json';
  const h = new Uint8Array(await f.slice(0, 2).arrayBuffer());
  if (h[0] === 0x1f && h[1] === 0x8b) return 'gz';
  if (h[0] === 0x50 && h[1] === 0x4b) return /\.kmz$/i.test(f.name) ? 'kml' : 'zip';
  if (/\.kml$/i.test(f.name) || /<kml[\s>]/.test(await f.slice(0, 2000).text())) return 'kml';
  return '';
}

async function openFiles(files) {
  const jobs = [], bad = [];
  for (const f of files) {
    const kind = await sniff(f);
    if (kind === 'json' || kind === 'gz') await importJson(f, kind === 'gz');
    else if (kind === 'kml') jobs.push({ file: f, label: f.name, size: f.size });
    else if (kind === 'zip') {
      try {
        const { entries } = await ask({ op: 'list', file: f });
        if (!entries.length) bad.push(f.name);
        for (const z of entries) jobs.push({ file: f, entry: z.name, label: z.name.split('/').pop(), size: z.size });
      } catch {
        bad.push(f.name);
      }
    } else bad.push(f.name);
  }
  if (bad.length) toast(`読めないファイルがありました：${bad.slice(0, 3).join('、')}${bad.length > 3 ? ' ほか' : ''}`);
  if (jobs.length === 1 && !jobs[0].entry) startSingle(jobs[0].file);
  else if (jobs.length) startBatch(jobs);
}

let mode = null, convFile = null, previewSrc = null, lastStats = null, batchJobs = [];

function showConv(title, size) {
  $('convName').textContent = title;
  $('convSize').textContent = fmtBytes(size);
  $('conv').hidden = false;
  $('sheet').classList.remove('collapsed');
  $('convCancel').textContent = 'やめる';
  document.querySelectorAll('input[name=tol]').forEach(r => { r.disabled = false; });
  renderList();
}

const tolerance = () => +document.querySelector('input[name=tol]:checked').value;
document.querySelectorAll('input[name=tol]').forEach(r => { r.onchange = () => { if (mode === 'single') convertSingle(); }; });

// 1つだけのとき：変換して地図で見比べてから保存する
function startSingle(file) {
  mode = 'single';
  convFile = file;
  showConv(file.name, file.size);
  $('convSave').hidden = false;
  $('convStart').hidden = true;
  convertSingle();
}

async function convertSingle() {
  stopWorker();
  preview = null;
  featureCache.delete('preview');
  redraw();
  $('convSave').disabled = true;
  $('convProg').hidden = false;
  $('convProg').value = 0;
  $('convStat').textContent = '読み込み中…';
  try {
    const m = await ask({ op: 'convert', file: convFile, tolerance: tolerance() }, ratio => {
      $('convProg').value = ratio;
      $('convStat').textContent = `読み込み中… ${Math.round(ratio * 100)}%`;
    });
    preview = m.data;
    previewSrc = m.src;
    lastStats = m.stats;
    const s = m.stats;
    $('convStat').innerHTML =
      `${fmtBytes(s.inBytes)} → <b>${fmtBytes(s.outBytes)}</b>（線 ${s.lines}本、点 ${fmtNum(s.ptsIn)} → ${fmtNum(s.ptsOut)}）`;
    $('convSave').disabled = false;
    redraw();
    fitTo([preview]);
  } catch (err) {
    $('convStat').textContent = '変換できませんでした：' + err.message;
  } finally {
    $('convProg').hidden = true;
  }
}

// 2つ以上・zip のとき：強さを選んで、まとめて変換して保存する
function startBatch(jobs) {
  mode = 'batch';
  batchJobs = jobs;
  showConv(`${fmtNum(jobs.length)}件のログ`, jobs.reduce((a, j) => a + j.size, 0));
  $('convSave').hidden = true;
  $('convStart').hidden = false;
  $('convStart').disabled = false;
  $('convProg').hidden = true;
  $('convStat').textContent = '間引きの強さを選んで「取り込む」を押してください。';
}

$('convStart').onclick = async () => {
  const jobs = batchJobs;
  const keys = new Set(routes.filter(r => r.src).map(r => r.src.name + '|' + r.src.bytes));
  const tol = tolerance();
  const g = gen;
  $('convStart').disabled = true;
  document.querySelectorAll('input[name=tol]').forEach(r => { r.disabled = true; });
  $('convProg').hidden = false;
  const added = [], failed = [];
  let skipped = 0;
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    $('convProg').value = i / jobs.length;
    $('convStat').textContent = `${fmtNum(i + 1)} / ${fmtNum(jobs.length)}：${j.label}`;
    if (keys.has(j.label + '|' + j.size)) { skipped++; continue; }
    try {
      const m = await ask({ op: 'convert', file: j.file, entry: j.entry, tolerance: tol });
      const r = newRecord(m.data, m.stats.outBytes, m.src);
      await putRoute(r);
      routes.push(r);
      added.push(r);
      keys.add(m.src.name + '|' + m.src.bytes);
      if (added.length % 25 === 0) { renderList(); redraw(); }
    } catch (err) {
      if (g !== gen) return;
      failed.push(`${j.label}（${err.message}）`);
    }
  }
  if (g !== gen) return;
  $('convProg').value = 1;
  let msg = `${fmtNum(added.length)}件を取り込みました。`;
  if (skipped) msg += `取り込み済みの${fmtNum(skipped)}件は飛ばしました。`;
  if (failed.length) msg += `読めなかった${failed.length}件：${failed.slice(0, 3).join('、')}${failed.length > 3 ? ' ほか' : ''}`;
  $('convStat').textContent = msg;
  $('convStart').hidden = true;
  $('convCancel').textContent = '閉じる';
  for (const r of added) openYears.add(yearOf(r.data));
  renderList();
  redraw();
  if (added.length) fitTo(added.map(r => r.data));
};

function closeConv() {
  stopWorker();
  mode = null;
  convFile = null;
  preview = null;
  batchJobs = [];
  featureCache.delete('preview');
  $('conv').hidden = true;
  renderList();
  redraw();
}

$('convCancel').onclick = closeConv;
$('convSave').onclick = async () => {
  const data = preview, src = previewSrc;
  closeConv();
  await addRoute(data, lastStats.outBytes, src);
  toast(`「${data.name}」を保存しました`);
};

function newRecord(data, bytes, src) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    created: Date.now(), visible: true, bytes, src, data,
  };
}

async function addRoute(data, bytes, src) {
  const r = newRecord(data, bytes, src);
  await putRoute(r);
  routes.push(r);
  openYears.add(yearOf(data));
  renderList();
  await mapReady;
  redraw();
  fitTo([data]);
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
    const files = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      await cache.delete(req);
      const name = decodeURIComponent(res.headers.get('X-Filename') || 'shared.kml');
      files.push(new File([await res.blob()], name));
    }
    if (files.length) openFiles(files);
  }
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
