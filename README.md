# KMLライト

KML / KMZ / GPX の線を軽くして地図に表示する PWA。iPhone・Android 共通。ビルド不要（そのまま置けば動く）。

- 変換はすべて端末の中（Web Worker）。ファイルは外に送らない
- 線（KML の LineString / LinearRing / gx:Track、GPX の trk / rte）だけを取り出し、Douglas–Peucker で間引き（1 / 3 / 10 / 30 m）、座標は約1m精度の encoded polyline にする
- 保存は IndexedDB。書き出しは KML か軽量ファイル（`.line.json`、このアプリで読み込める）
- まとめて取り込み：複数の KML/KMZ/GPX や、ログを詰めた zip をそのまま選べる。`.gpx.gz` などの gzip も読む（Strava の一括書き出しの zip をそのまま入れられる）。FIT は読めないので数だけ知らせる。同じファイル（名前と大きさが同じ）は飛ばす
- 記録の日付は KML の中の日時 → ファイル名の日付 → ファイルの更新日時 の順に取る。一覧は年ごとにまとめ、名前・日付で探せる。年で色分けもできる
- バックアップ：全部を1つの `.json.gz` に書き出し、開くボタンから戻せる（既にあるものは飛ばす）。iCloud Drive / Google Drive などに自分で置く
- 読み込むファイルは信用しない：形の崩れた軽量ファイル・バックアップは受け取らない。ページは CSP で自分自身と国土地理院タイル以外と通信できない
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

Service Worker と現在地は HTTPS が必要。GitHub Pages（main の最上位）で公開していて、main に push すると反映される：https://islandkei28.github.io/kml-light/
`_headers` は Cloudflare Pages に移すとき用（GitHub Pages では使われない）。
公開したURLを開いて、iPhone は Safari の共有 →「ホーム画面に追加」、Android は Chrome のメニュー →「アプリをインストール」。

アプリの中身を変えたときは `sw.js` の `APP` の版（`app-v1`）を上げる。
