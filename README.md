# KMLライト

KML / KMZ の線を軽くして地図に表示する PWA。iPhone・Android 共通。ビルド不要（そのまま置けば動く）。

- 変換はすべて端末の中（Web Worker）。ファイルは外に送らない
- 線（LineString / LinearRing / gx:Track）だけを取り出し、Douglas–Peucker で間引き（1 / 3 / 10 / 30 m）、座標は約1m精度の encoded polyline にする
- 保存は IndexedDB。書き出しは KML か軽量ファイル（`.line.json`、このアプリで読み込める）
- 背景は国土地理院タイル（標準・淡色・写真）。見たタイルとアプリ本体は Service Worker が保存（オフラインで開ける）
- Android は共有メニューから直接送れる（インストール後）。iPhone は「＋ KMLを開く」から「ファイル」アプリで選ぶ

## ファイル

| ファイル | 役目 |
|---|---|
| `js/app.js` | 画面・地図・一覧 |
| `js/convert-worker.js` | 変換（KMZ解凍 → 読む → 間引く → 符号化） |
| `js/kml-parse.js` | KMLを少しずつ読む（大きなファイルでも落ちにくい） |
| `js/simplify.js` | 間引き |
| `js/format.js` | 軽量ファイルの形、KML出力 |
| `js/store.js` | IndexedDB |
| `sw.js` | オフライン用の保存、Android の共有受け取り |
| `devtools/` | アイコンとテスト用KMLを作るスクリプト |

## 手元で動かす

```bash
python -m http.server 8790
```

http://localhost:8790/ を開く。テスト用ファイルは `python devtools/make-samples.py` で `devtools/samples/` にできる。

## スマホで使う

Service Worker と現在地は HTTPS が必要なので、GitHub Pages などに置く。
置いたURLを開いて、iPhone は Safari の共有 →「ホーム画面に追加」、Android は Chrome のメニュー →「アプリをインストール」。

アプリの中身を変えたときは `sw.js` の `APP` の版（`app-v1`）を上げる。
