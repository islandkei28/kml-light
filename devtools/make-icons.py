"""アプリのアイコン（PNG）を作る。使い方: python devtools/make-icons.py"""
import math
import os
import struct
import zlib

BG = (0x1F, 0x7A, 0x5A)
WHITE = (255, 255, 255)
END = (0xF5, 0xA6, 0x23)
# 0..1 の座標。マスク（丸く切られる）でも見えるよう中央 80% に収める
ROUTE = [(0.27, 0.70), (0.40, 0.50), (0.52, 0.60), (0.62, 0.38), (0.73, 0.30)]
LINE_W = 0.065
DOT_R = 0.065


def seg_dist(px, py, a, b):
    ax, ay = a
    dx, dy = b[0] - ax, b[1] - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def mix(c1, c2, k):
    return tuple(round(a + (b - a) * k) for a, b in zip(c1, c2))


def render(size):
    rows = []
    aa = 1.0 / size
    for j in range(size):
        row = bytearray([0])
        y = (j + 0.5) / size
        for i in range(size):
            x = (i + 0.5) / size
            c = BG
            d = min(seg_dist(x, y, ROUTE[k], ROUTE[k + 1]) for k in range(len(ROUTE) - 1))
            c = mix(c, WHITE, max(0.0, min(1.0, (LINE_W / 2 - d) / aa + 0.5)))
            for (cx, cy), col in ((ROUTE[0], WHITE), (ROUTE[-1], END)):
                d = math.hypot(x - cx, y - cy)
                c = mix(c, col, max(0.0, min(1.0, (DOT_R - d) / aa + 0.5)))
            row += bytes(c)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", raw) + chunk(b"IEND", b""))


out = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(out, exist_ok=True)
for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
    with open(os.path.join(out, name), "wb") as f:
        f.write(render(size))
    print(name)
