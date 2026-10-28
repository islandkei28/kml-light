// Douglas–Peucker 法で点を間引く（再帰を使わないので長い線でも落ちない）。
// pts は [lon, lat, lon, lat, ...]、tol は許す誤差（メートル）。
export function simplify(pts, tol) {
  const n = pts.length / 2;
  if (n <= 2 || tol <= 0) return pts.slice();
  const kx = 111320 * Math.cos(pts[1] * Math.PI / 180), ky = 110540;
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = pts[2 * i] * kx; y[i] = pts[2 * i + 1] * ky; }

  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const tol2 = tol * tol;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    const ax = x[a], ay = y[a], dx = x[b] - ax, dy = y[b] - ay, len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = x[i] - ax, py = y[i] - ay;
      let d;
      if (len2 > 0) {
        let t = (px * dx + py * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - t * dx, ey = py - t * dy;
        d = ex * ex + ey * ey;
      } else {
        d = px * px + py * py;
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2) {
      keep[idx] = 1;
      stack.push(a, idx, idx, b);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}
