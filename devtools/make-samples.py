"""動作確認用の KML / KMZ を devtools/samples/ に作る。使い方: python devtools/make-samples.py [点の数]"""
import math
import os
import random
import sys
import zipfile

N = int(sys.argv[1]) if len(sys.argv) > 1 else 60000
random.seed(1)

# GPSログ風：1秒ごと、少しぶれながら進む（東京 → 西へ）
pts = []
lon, lat, head = 139.7671, 35.6812, math.radians(250)
for i in range(N):
    head += random.gauss(0, 0.05)
    step = 4.0 + random.gauss(0, 0.5)  # m
    lon += step * math.cos(head) / (111320 * math.cos(math.radians(lat))) + random.gauss(0, 2e-6)
    lat += step * math.sin(head) / 110540 + random.gauss(0, 2e-6)
    pts.append((lon, lat, 30 + 20 * math.sin(i / 500)))

coords = " ".join(f"{x:.15f},{y:.15f},{z:.3f}" for x, y, z in pts)
track = "\n".join(f"<gx:coord>{x:.12f} {y + 0.01:.12f} {z:.1f}</gx:coord><when>2026-10-01T00:00:{i % 60:02d}Z</when>"
                  for i, (x, y, z) in enumerate(pts[:800]))
ring = "139.70,35.70,0 139.72,35.70,0 139.72,35.72,0 139.70,35.72,0 139.70,35.70,0"

kml = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
  <name>テスト走行 &amp; 散歩</name>
  <!-- コメント <Placemark> は無視される -->
  <Style id="red-n"><LineStyle><color>ff0000ff</color><width>5</width></LineStyle></Style>
  <Style id="red-h"><LineStyle><color>ff00ffff</color><width>8</width></LineStyle></Style>
  <StyleMap id="red"><Pair><key>normal</key><styleUrl>#red-n</styleUrl></Pair><Pair><key>highlight</key><styleUrl>#red-h</styleUrl></Pair></StyleMap>
  <Folder><name>フォルダ名は使わない</name>
    <Placemark>
      <name>GPSログ</name>
      <description><![CDATA[<p>説明 <b>HTML</b> は捨てる</p>]]></description>
      <styleUrl>#red</styleUrl>
      <LineString><tessellate>1</tessellate><coordinates>
        {coords}
      </coordinates></LineString>
    </Placemark>
  </Folder>
  <Placemark>
    <name>青い2本</name>
    <Style><LineStyle><color>ffff0000</color></LineStyle></Style>
    <MultiGeometry>
      <LineString><coordinates>139.75,35.66 139.76,35.665 139.77,35.66</coordinates></LineString>
      <LineString><coordinates>139.75,35.65 139.77,35.65</coordinates></LineString>
    </MultiGeometry>
  </Placemark>
  <Placemark><name>gx:Track</name><gx:Track>{track}</gx:Track></Placemark>
  <Placemark><name>四角</name><Polygon><outerBoundaryIs><LinearRing><coordinates>{ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Placemark><name>点は無視</name><Point><coordinates>139.7,35.7,0</coordinates></Point></Placemark>
</Document>
</kml>
"""

out = os.path.join(os.path.dirname(__file__), "samples")
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "sample.kml"), "w", encoding="utf-8") as f:
    f.write(kml)
with zipfile.ZipFile(os.path.join(out, "sample.kmz"), "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("files/readme.txt", "dummy")
    z.writestr("doc.kml", kml)
for n in ("sample.kml", "sample.kmz"):
    print(n, os.path.getsize(os.path.join(out, n)))
