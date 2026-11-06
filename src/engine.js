/* Photoscale measurement engine.
   Runs inside a Web Worker (also loadable in Node for tests).
   Input per frame: camera pose (from ARCore via WebXR, metric, y = up),
   a small grayscale camera image and/or a depth sample grid.
   Output: tracked feature dots (red/blue/green), a fused 2.5D height grid,
   and at the end the pile volume with an error estimate. */
'use strict';
var PSE = (function () {

const DEG = Math.PI / 180;
const now = (typeof performance !== 'undefined') ? () => performance.now() : () => Date.now();

const CFG = {
  levels: 3, win: 4, lkIters: 10, minEig: 6, fbThr: 0.9, resThr: 32,
  fastThr: 14, cellPx: 16, maxTracks: 420,
  obsMinMove: 0.05, maxObs: 12, maxTrackSpan: 15,
  triMinParDeg: 0.8, greenParDeg: 3.0, greenSigma: 0.05, commitSigma: 0.15, maxResPx: 2.5,
  pxSigma: 0.7,
  cellSize: 0.10, gridN: 640, kF: 3.0, minCellW: 0.25,
  depthMin: 0.7, depthMax: 7.5, depthEdge: 0.06, depthW: 0.25,
  flipEvalEvery: 6,
  miniEveryMs: 350,
};

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */
let W = 0, H = 0, pyrA = null, pyrB = null, hasPrev = false, prevGrayFi = -1;
let tracks = [], nextId = 1, medFX = 0, medFY = 0, fastThr = CFG.fastThr;
let fr = { R: [], C: [], I: [], t: [] };
let grid = null, started = false, tStart = 0, center = null;
let groundHits = [];
let pts = new Float32Array(4 * 8192), nPts = 0, newPts = [];
let flipMode = 1, flipLocked = false, flipStats = null, flipCount = 0;
let nDepthFrames = 0, nDepthSamples = 0;
let camPath = [];
let lastProgress = 0, lastMiniT = -1e9, procTimes = [], lostCount = 0;
let occ = null, best = null, bx = null, by = null;

function reset(cfg) {
  if (cfg) for (const k in cfg) if (k in CFG) CFG[k] = cfg[k];
  W = 0; H = 0; pyrA = pyrB = null; hasPrev = false; prevGrayFi = -1;
  tracks = []; nextId = 1; medFX = medFY = 0; fastThr = CFG.fastThr;
  fr = { R: [], C: [], I: [], t: [] };
  grid = null; started = false; tStart = 0; center = null; groundHits = [];
  pts = new Float32Array(4 * 8192); nPts = 0; newPts = [];
  flipMode = (cfg && cfg.flipMode !== undefined) ? cfg.flipMode : 1;
  flipLocked = !!(cfg && cfg.flipLocked); flipStats = null; flipCount = 0;
  nDepthFrames = 0; nDepthSamples = 0; camPath = []; lastProgress = 0; lastMiniT = -1e9;
  procTimes = []; lostCount = 0;
}

/* ------------------------------------------------------------------ */
/* image pyramid                                                       */
/* ------------------------------------------------------------------ */
function makePyr(w, h, n) {
  const L = [];
  for (let i = 0; i < n; i++) {
    L.push({ w, h, img: new Float32Array(w * h), gx: new Float32Array(w * h), gy: new Float32Array(w * h) });
    w = w >> 1; h = h >> 1;
  }
  return L;
}
function buildPyr(P, gray) {
  const a0 = P[0].img, n = P[0].w * P[0].h;
  for (let i = 0; i < n; i++) a0[i] = gray[i];
  for (let l = 1; l < P.length; l++) {
    const a = P[l - 1], b = P[l], aw = a.w, bw = b.w, bh = b.h, ai = a.img, bi = b.img;
    for (let y = 0; y < bh; y++) {
      const r0 = 2 * y * aw, r1 = r0 + aw;
      for (let x = 0; x < bw; x++) {
        const o = 2 * x;
        bi[y * bw + x] = 0.25 * (ai[r0 + o] + ai[r0 + o + 1] + ai[r1 + o] + ai[r1 + o + 1]);
      }
    }
  }
  for (const lv of P) scharr(lv);
}
function scharr(lv) {
  const w = lv.w, h = lv.h, I = lv.img, gx = lv.gx, gy = lv.gy;
  gx.fill(0); gy.fill(0);
  for (let y = 1; y < h - 1; y++) {
    let o = y * w + 1;
    for (let x = 1; x < w - 1; x++, o++) {
      const a = I[o - w - 1], b = I[o - w], c = I[o - w + 1], d = I[o - 1], f = I[o + 1],
        g = I[o + w - 1], hh = I[o + w], k = I[o + w + 1];
      gx[o] = (3 * (c - a) + 10 * (f - d) + 3 * (k - g)) * 0.03125;
      gy[o] = (3 * (g - a) + 10 * (hh - b) + 3 * (k - c)) * 0.03125;
    }
  }
}

/* ------------------------------------------------------------------ */
/* pyramidal Lucas-Kanade                                              */
/* ------------------------------------------------------------------ */
const WN = (2 * CFG.win + 1) * (2 * CFG.win + 1);
const TT = new Float32Array(WN), TX = new Float32Array(WN), TY = new Float32Array(WN);
const LK = { x: 0, y: 0, ok: false, eig: 0, err: 0 };
function lk(P, Q, x0, y0, ix0, iy0) {
  const win = CFG.win, nl = P.length;
  let gx = ix0 / (1 << (nl - 1)), gy = iy0 / (1 << (nl - 1));
  LK.ok = false;
  for (let L = nl - 1; L >= 0; L--) {
    const lp = P[L], lq = Q[L], w = lp.w, h = lp.h, sc = 1 / (1 << L);
    const px = x0 * sc, py = y0 * sc;
    if (px < win + 1 || py < win + 1 || px > w - win - 2 || py > h - win - 2) {
      if (L === 0) return LK;
      gx *= 2; gy *= 2; continue;
    }
    const ix = px | 0, iy = py | 0, ax = px - ix, ay = py - iy;
    const a00 = (1 - ax) * (1 - ay), a10 = ax * (1 - ay), a01 = (1 - ax) * ay, a11 = ax * ay;
    const I = lp.img, IX = lp.gx, IY = lp.gy;
    let Gxx = 0, Gxy = 0, Gyy = 0, n = 0;
    for (let dy = -win; dy <= win; dy++) {
      let o = (iy + dy) * w + ix - win;
      for (let dx = -win; dx <= win; dx++, o++, n++) {
        const t = a00 * I[o] + a10 * I[o + 1] + a01 * I[o + w] + a11 * I[o + w + 1];
        const tx = a00 * IX[o] + a10 * IX[o + 1] + a01 * IX[o + w] + a11 * IX[o + w + 1];
        const ty = a00 * IY[o] + a10 * IY[o + 1] + a01 * IY[o + w] + a11 * IY[o + w + 1];
        TT[n] = t; TX[n] = tx; TY[n] = ty;
        Gxx += tx * tx; Gxy += tx * ty; Gyy += ty * ty;
      }
    }
    const det = Gxx * Gyy - Gxy * Gxy;
    const eig = (Gxx + Gyy - Math.sqrt((Gxx - Gyy) * (Gxx - Gyy) + 4 * Gxy * Gxy)) / (2 * WN);
    if (L === 0) LK.eig = eig;
    if (det < 1e-6 || eig < CFG.minEig * (L === 0 ? 1 : 0.25)) {
      if (L === 0) return LK;
      gx *= 2; gy *= 2; continue;
    }
    const J = lq.img;
    let vx = 0, vy = 0, okL = true;
    for (let it = 0; it < CFG.lkIters; it++) {
      const qx = px + gx + vx, qy = py + gy + vy;
      if (qx < win + 1 || qy < win + 1 || qx > w - win - 2 || qy > h - win - 2) { okL = false; break; }
      const jx = qx | 0, jy = qy | 0, ex0 = qx - jx, ey0 = qy - jy;
      const b00 = (1 - ex0) * (1 - ey0), b10 = ex0 * (1 - ey0), b01 = (1 - ex0) * ey0, b11 = ex0 * ey0;
      let sx = 0, sy = 0; n = 0;
      for (let dy = -win; dy <= win; dy++) {
        let o = (jy + dy) * w + jx - win;
        for (let dx = -win; dx <= win; dx++, o++, n++) {
          const d = TT[n] - (b00 * J[o] + b10 * J[o + 1] + b01 * J[o + w] + b11 * J[o + w + 1]);
          sx += d * TX[n]; sy += d * TY[n];
        }
      }
      const ex = (Gyy * sx - Gxy * sy) / det, ey = (Gxx * sy - Gxy * sx) / det;
      vx += ex; vy += ey;
      if (ex * ex + ey * ey < 0.0009) break;
    }
    if (!okL && L === 0) return LK;
    if (L > 0) { gx = 2 * (gx + vx); gy = 2 * (gy + vy); } else { gx += vx; gy += vy; }
  }
  // final photometric residual at level 0
  const lq = Q[0], w = lq.w, J = lq.img;
  const qx = x0 + gx, qy = y0 + gy;
  if (qx < CFG.win + 1 || qy < CFG.win + 1 || qx > w - CFG.win - 2 || qy > lq.h - CFG.win - 2) return LK;
  const jx = qx | 0, jy = qy | 0, ex0 = qx - jx, ey0 = qy - jy;
  const b00 = (1 - ex0) * (1 - ey0), b10 = ex0 * (1 - ey0), b01 = (1 - ex0) * ey0, b11 = ex0 * ey0;
  let e = 0, n = 0;
  for (let dy = -CFG.win; dy <= CFG.win; dy++) {
    let o = (jy + dy) * w + jx - CFG.win;
    for (let dx = -CFG.win; dx <= CFG.win; dx++, o++, n++) {
      e += Math.abs(TT[n] - (b00 * J[o] + b10 * J[o + 1] + b01 * J[o + w] + b11 * J[o + w + 1]));
    }
  }
  LK.err = e / WN;
  if (LK.err > CFG.resThr) return LK;
  LK.x = qx; LK.y = qy; LK.ok = true;
  return LK;
}

/* ------------------------------------------------------------------ */
/* FAST-9 corner detection with grid bucketing                         */
/* ------------------------------------------------------------------ */
const CIRC = [[0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3],
  [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3]];
function has9(m) {
  if (!m) return false;
  const x = (m | (m << 16)) >>> 0;
  let r = x;
  for (let k = 1; k < 9; k++) r &= x >>> k;
  return (r & 0xFFFF) !== 0;
}
function detect(g, fi) {
  const cp = CFG.cellPx, gw = Math.ceil(W / cp), gh = Math.ceil(H / cp), nc = gw * gh;
  if (!occ || occ.length !== nc) { occ = new Uint8Array(nc); best = new Float32Array(nc); bx = new Int16Array(nc); by = new Int16Array(nc); }
  occ.fill(0); best.fill(0);
  for (const tr of tracks) {
    const ci = ((tr.y / cp) | 0) * gw + ((tr.x / cp) | 0);
    if (ci >= 0 && ci < nc) occ[ci] = 1;
  }
  let free = 0; for (let i = 0; i < nc; i++) if (!occ[i]) free++;
  if (free === 0) return;
  const off = CIRC.map(([dx, dy]) => dy * W + dx);
  const thr = fastThr;
  for (let y = 4; y < H - 4; y++) {
    const rowCell = ((y / cp) | 0) * gw;
    for (let x = 4; x < W - 4; x++) {
      const ci = rowCell + ((x / cp) | 0);
      if (occ[ci]) { x = (((x / cp) | 0) + 1) * cp - 1; continue; }
      const o = y * W + x, p = g[o], hi = p + thr, lo = p - thr;
      const v0 = g[o + off[0]], v4 = g[o + off[4]], v8 = g[o + off[8]], v12 = g[o + off[12]];
      const nb = (v0 > hi) + (v4 > hi) + (v8 > hi) + (v12 > hi);
      const nd = (v0 < lo) + (v4 < lo) + (v8 < lo) + (v12 < lo);
      if (nb < 2 && nd < 2) continue;
      let mb = 0, md = 0;
      for (let i = 0; i < 16; i++) { const v = g[o + off[i]]; if (v > hi) mb |= 1 << i; else if (v < lo) md |= 1 << i; }
      let s = 0;
      if (nb >= 2 && has9(mb)) { for (let i = 0; i < 16; i++) if ((mb >> i) & 1) s += g[o + off[i]] - hi; }
      else if (nd >= 2 && has9(md)) { for (let i = 0; i < 16; i++) if ((md >> i) & 1) s += lo - g[o + off[i]]; }
      else continue;
      s += 1;
      if (s > best[ci]) { best[ci] = s; bx[ci] = x; by[ci] = y; }
    }
  }
  const cand = [];
  for (let i = 0; i < nc; i++) if (best[i] > 0) cand.push(i);
  if (cand.length < free * 0.35) fastThr = Math.max(6, fastThr - 1);
  else if (cand.length > free * 0.85) fastThr = Math.min(40, fastThr + 1);
  cand.sort((a, b) => best[b] - best[a]);
  const room = CFG.maxTracks - tracks.length;
  for (let q = 0; q < cand.length && q < room; q++) {
    const ci = cand[q];
    const tr = newTrack(bx[ci], by[ci], g[by[ci] * W + bx[ci]], fi);
    tracks.push(tr);
  }
}
function newTrack(x, y, gval, fi) {
  const tr = {
    id: nextId++, x, y, n: 0,
    ou: new Float32Array(CFG.maxObs), ov: new Float32Array(CFG.maxObs), of: new Int32Array(CFG.maxObs),
    lc: [0, 0, 0], X: null, state: 0, par: 0, sig: 1e9, res: 0, bad: 0, age: 0, t0: fr.t[fi], gv: gval
  };
  addObs(tr, fi);
  return tr;
}

/* ------------------------------------------------------------------ */
/* geometry                                                            */
/* ------------------------------------------------------------------ */
const D3 = new Float64Array(3), X3 = new Float64Array(3), P2 = new Float64Array(2);
function rayOf(u, v, fi, mode, out) {
  const it = fr.I[fi], R = fr.R[fi];
  let uc = u + 0.5, vc = v + 0.5;
  if (mode & 1) vc = it.h - vc;
  if (mode & 2) uc = it.w - uc;
  const x = (uc - it.cx) / it.fx, y = -(vc - it.cy) / it.fy;
  const dx = R[0] * x + R[1] * y - R[2], dy = R[3] * x + R[4] * y - R[5], dz = R[6] * x + R[7] * y - R[8];
  const nn = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
  out[0] = dx * nn; out[1] = dy * nn; out[2] = dz * nn;
}
function project(X, fi, mode, out) {
  const R = fr.R[fi], C = fr.C[fi], it = fr.I[fi];
  const vx = X[0] - C[0], vy = X[1] - C[1], vz = X[2] - C[2];
  const cx = R[0] * vx + R[3] * vy + R[6] * vz;
  const cy = R[1] * vx + R[4] * vy + R[7] * vz;
  const cz = R[2] * vx + R[5] * vy + R[8] * vz;
  if (cz > -0.05) return false;
  let uc = it.cx + it.fx * cx / -cz, vc = it.cy - it.fy * cy / -cz;
  if (mode & 1) vc = it.h - vc;
  if (mode & 2) uc = it.w - uc;
  out[0] = uc - 0.5; out[1] = vc - 0.5;
  return true;
}
function addObs(tr, fi) {
  if (tr.n === CFG.maxObs) {
    for (let i = 1; i < tr.n - 1; i++) { tr.ou[i] = tr.ou[i + 1]; tr.ov[i] = tr.ov[i + 1]; tr.of[i] = tr.of[i + 1]; }
    tr.n--;
  }
  tr.ou[tr.n] = tr.x; tr.ov[tr.n] = tr.y; tr.of[tr.n] = fi; tr.n++;
  const C = fr.C[fi]; tr.lc[0] = C[0]; tr.lc[1] = C[1]; tr.lc[2] = C[2];
}
function removeObs(tr, i) {
  for (let j = i; j < tr.n - 1; j++) { tr.ou[j] = tr.ou[j + 1]; tr.ov[j] = tr.ov[j + 1]; tr.of[j] = tr.of[j + 1]; }
  tr.n--;
}
const RAYS = new Float64Array(64 * 3);
const TRI = { ok: false, X: new Float64Array(3), par: 0, res: 0, worst: -1, worstErr: 0, sig: 1e9, depth: 0, behind: false };
function triCore(tr, mode) {
  const n = tr.n;
  TRI.ok = false; TRI.behind = false; TRI.par = 0;
  if (n < 2) return TRI;
  let A00 = 0, A01 = 0, A02 = 0, A11 = 0, A12 = 0, A22 = 0, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    rayOf(tr.ou[i], tr.ov[i], tr.of[i], mode, D3);
    const d0 = D3[0], d1 = D3[1], d2 = D3[2];
    RAYS[3 * i] = d0; RAYS[3 * i + 1] = d1; RAYS[3 * i + 2] = d2;
    const C = fr.C[tr.of[i]];
    const m00 = 1 - d0 * d0, m01 = -d0 * d1, m02 = -d0 * d2, m11 = 1 - d1 * d1, m12 = -d1 * d2, m22 = 1 - d2 * d2;
    A00 += m00; A01 += m01; A02 += m02; A11 += m11; A12 += m12; A22 += m22;
    b0 += m00 * C[0] + m01 * C[1] + m02 * C[2];
    b1 += m01 * C[0] + m11 * C[1] + m12 * C[2];
    b2 += m02 * C[0] + m12 * C[1] + m22 * C[2];
  }
  let minc = 1;
  for (let i = 1; i < n; i++) {
    const c = RAYS[0] * RAYS[3 * i] + RAYS[1] * RAYS[3 * i + 1] + RAYS[2] * RAYS[3 * i + 2];
    if (c < minc) minc = c;
  }
  const L = 3 * (n - 1);
  for (let i = 1; i < n - 1; i++) {
    const c = RAYS[L] * RAYS[3 * i] + RAYS[L + 1] * RAYS[3 * i + 1] + RAYS[L + 2] * RAYS[3 * i + 2];
    if (c < minc) minc = c;
  }
  const par = Math.acos(Math.min(1, Math.max(-1, minc)));
  TRI.par = par;
  if (par < CFG.triMinParDeg * DEG) return TRI;
  const c00 = A11 * A22 - A12 * A12, c01 = A02 * A12 - A01 * A22, c02 = A01 * A12 - A02 * A11;
  const det = A00 * c00 + A01 * c01 + A02 * c02;
  if (Math.abs(det) < 1e-12) return TRI;
  const c11 = A00 * A22 - A02 * A02, c12 = A01 * A02 - A00 * A12, c22 = A00 * A11 - A01 * A01;
  const X0 = (c00 * b0 + c01 * b1 + c02 * b2) / det;
  const X1 = (c01 * b0 + c11 * b1 + c12 * b2) / det;
  const X2 = (c02 * b0 + c12 * b1 + c22 * b2) / det;
  let worst = -1, worstErr = 0, sum2 = 0, dsum = 0;
  for (let i = 0; i < n; i++) {
    const C = fr.C[tr.of[i]];
    const vx = X0 - C[0], vy = X1 - C[1], vz = X2 - C[2];
    const tt = vx * RAYS[3 * i] + vy * RAYS[3 * i + 1] + vz * RAYS[3 * i + 2];
    if (tt < 0.25) { TRI.behind = true; return TRI; }
    const px = vx - tt * RAYS[3 * i], py = vy - tt * RAYS[3 * i + 1], pz = vz - tt * RAYS[3 * i + 2];
    const err = Math.sqrt(px * px + py * py + pz * pz) / tt * fr.I[tr.of[i]].fy;
    sum2 += err * err; dsum += tt;
    if (err > worstErr) { worstErr = err; worst = i; }
  }
  TRI.X[0] = X0; TRI.X[1] = X1; TRI.X[2] = X2;
  TRI.res = Math.sqrt(sum2 / n); TRI.worst = worst; TRI.worstErr = worstErr; TRI.depth = dsum / n;
  const f = fr.I[tr.of[n - 1]].fy;
  TRI.sig = TRI.depth * (CFG.pxSigma / f) / Math.max(Math.sin(par), 0.005) / Math.sqrt(Math.max(1, (n - 1) / 2));
  TRI.ok = true;
  return TRI;
}
function retri(tr) {
  let r = triCore(tr, flipMode);
  if (r.ok && r.worstErr > CFG.maxResPx * 2 && tr.n >= 4) { removeObs(tr, r.worst); r = triCore(tr, flipMode); }
  if (!r.ok) {
    tr.X = null; tr.state = 0; tr.par = r.par;
    if (flipLocked && r.behind) { tr.bad++; if (tr.bad > 2) tr.kill = true; }
    return;
  }
  if (r.worstErr > CFG.maxResPx * 2) {
    tr.X = null; tr.state = 0;
    if (flipLocked) { tr.bad++; if (tr.bad > 2) tr.kill = true; }
    return;
  }
  if (!tr.X) tr.X = new Float64Array(3);
  tr.X[0] = r.X[0]; tr.X[1] = r.X[1]; tr.X[2] = r.X[2];
  tr.par = r.par; tr.sig = r.sig; tr.res = r.res;
  tr.state = (tr.n >= 3 && r.par >= CFG.greenParDeg * DEG && r.sig <= CFG.greenSigma && r.res <= CFG.maxResPx) ? 2 : 1;
}

/* ------------------------------------------------------------------ */
/* tracking step                                                       */
/* ------------------------------------------------------------------ */
function trackStep(fi) {
  const P = pyrA, Q = pyrB, keep = [], dxs = [], dys = [];
  for (const tr of tracks) {
    let gx = medFX, gy = medFY;
    if (flipLocked && prevGrayFi >= 0) {
      if (tr.X && tr.state >= 1) {
        if (project(tr.X, fi, flipMode, P2)) { gx = P2[0] - tr.x; gy = P2[1] - tr.y; }
      } else {
        rayOf(tr.x, tr.y, prevGrayFi, flipMode, D3);
        const C = fr.C[prevGrayFi];
        X3[0] = C[0] + 30 * D3[0]; X3[1] = C[1] + 30 * D3[1]; X3[2] = C[2] + 30 * D3[2];
        if (project(X3, fi, flipMode, P2)) { gx = P2[0] - tr.x; gy = P2[1] - tr.y; }
      }
      if (gx * gx + gy * gy > 3600) { gx = medFX; gy = medFY; }
    }
    const r = lk(P, Q, tr.x, tr.y, gx, gy);
    if (!r.ok) { lose(tr); continue; }
    const nx = r.x, ny = r.y;
    const b = lk(Q, P, nx, ny, tr.x - nx, tr.y - ny);
    if (!b.ok || (b.x - tr.x) * (b.x - tr.x) + (b.y - tr.y) * (b.y - tr.y) > CFG.fbThr * CFG.fbThr) { lose(tr); continue; }
    if (nx < 5 || ny < 5 || nx > W - 6 || ny > H - 6) { lose(tr); continue; }
    dxs.push(nx - tr.x); dys.push(ny - tr.y);
    tr.x = nx; tr.y = ny; tr.age++;
    keep.push(tr);
  }
  tracks = keep;
  medFX = dxs.length ? median(dxs) : 0;
  medFY = dys.length ? median(dys) : 0;
}
function updateObs(fi) {
  const C = fr.C[fi], t = fr.t[fi], keep = [];
  for (const tr of tracks) {
    if (tr.kill) { lose(tr); continue; }
    if (t - tr.t0 > CFG.maxTrackSpan && tr.n >= 2) {
      commit(tr);
      tr.n = 0; tr.X = null; tr.state = 0; tr.par = 0; tr.sig = 1e9; tr.bad = 0; tr.t0 = t; tr.id = nextId++;
      addObs(tr, fi); keep.push(tr); continue;
    }
    const dx = C[0] - tr.lc[0], dy = C[1] - tr.lc[1], dz = C[2] - tr.lc[2];
    if (dx * dx + dy * dy + dz * dz >= CFG.obsMinMove * CFG.obsMinMove) {
      addObs(tr, fi);
      retri(tr);
      if (tr.kill) { lose(tr); continue; }
    }
    keep.push(tr);
  }
  tracks = keep;
}
function lose(tr) { commit(tr); lostCount++; }
function commit(tr) {
  if (!started || !grid || !flipLocked) return;
  if (!tr.X || tr.state < 1 || tr.sig > CFG.commitSigma || tr.res > CFG.maxResPx) return;
  const w = Math.min(4, Math.max(0.1, (0.03 / tr.sig) * (0.03 / tr.sig)));
  addPoint(tr.X[0], tr.X[1], tr.X[2], w, tr.state);
}
function addPoint(x, y, z, w, state) {
  if (nPts * 4 + 4 > pts.length) { const n2 = new Float32Array(pts.length * 2); n2.set(pts); pts = n2; }
  pts[nPts * 4] = x; pts[nPts * 4 + 1] = y; pts[nPts * 4 + 2] = z; pts[nPts * 4 + 3] = w;
  nPts++;
  newPts.push(x, y, z, state);
  grid.addFeat(x, y, z, w);
}

/* ------------------------------------------------------------------ */
/* camera image orientation check                                      */
/* The browser hands us the camera image as a GPU texture whose row    */
/* order is not specified. We test the 4 possible flips: the right one */
/* gives consistent triangulation and puts the ground below the phone. */
/* ------------------------------------------------------------------ */
function evalFlip() {
  const res = [[], [], [], []], hgt = [[], [], [], []], ok = [0, 0, 0, 0];
  let cnt = 0;
  for (const tr of tracks) {
    if (tr.n < 3) continue;
    const Ca = fr.C[tr.of[0]], Cb = fr.C[tr.of[tr.n - 1]];
    const bl = Math.hypot(Ca[0] - Cb[0], Ca[1] - Cb[1], Ca[2] - Cb[2]);
    if (bl < 0.2) continue;
    for (let m = 0; m < 4; m++) {
      const r = triCore(tr, m);
      if (r.ok) { ok[m]++; res[m].push(Math.min(r.res, 30)); hgt[m].push(r.X[1] - Cb[1]); }
      else res[m].push(30);
    }
    if (++cnt >= 160) break;
  }
  const med = res.map(a => a.length ? median(a) : 99);
  const mh = hgt.map(a => a.length ? median(a) : 0);
  const okf = ok.map(v => cnt ? v / cnt : 0);
  flipStats = { n: cnt, med: med.map(v => +v.toFixed(2)), h: mh.map(v => +v.toFixed(2)), ok: okf.map(v => +v.toFixed(2)) };
  if (cnt < 25) return;
  let bestRes = Math.min(...med);
  const cands = [0, 1, 2, 3].filter(m => okf[m] >= 0.6 && med[m] <= Math.max(2.0, 1.6 * bestRes));
  if (!cands.length || bestRes > 3) return;
  cands.sort((a, b) => mh[a] - mh[b]);
  const pick = cands[0];
  if (mh[pick] > -0.15) return;
  if (cands.length > 1 && mh[cands[1]] - mh[pick] < 0.3) return;
  flipCount++;
  if (flipCount < 2 && pick !== flipMode) { flipMode = pick; return; }
  flipMode = pick; flipLocked = true;
  for (const tr of tracks) retri(tr);
}

/* ------------------------------------------------------------------ */
/* height grid                                                         */
/* ------------------------------------------------------------------ */
function Grid(N, s) {
  this.N = N; this.s = s; this.x0 = 0; this.z0 = 0;
  const n = N * N;
  this.wF = new Float32Array(n); this.hF = new Float32Array(n);
  this.wD = new Float32Array(n); this.hD = new Float32Array(n); this.qD = new Float32Array(n);
  this.wA = new Float32Array(n); this.hA = new Float32Array(n);
  this.wB = new Float32Array(n); this.hB = new Float32Array(n);
  this.sect = new Uint16Array(n);
  this.bb = [N, N, -1, -1];
}
Grid.prototype.setOrigin = function (x, z) {
  this.x0 = x - this.N * this.s / 2; this.z0 = z - this.N * this.s / 2;
};
Grid.prototype.cell = function (x, z) {
  const i = Math.floor((x - this.x0) / this.s), k = Math.floor((z - this.z0) / this.s);
  if (i < 0 || k < 0 || i >= this.N || k >= this.N) return -1;
  return k * this.N + i;
};
Grid.prototype.touch = function (c) {
  const i = c % this.N, k = (c / this.N) | 0, b = this.bb;
  if (i < b[0]) b[0] = i; if (k < b[1]) b[1] = k; if (i > b[2]) b[2] = i; if (k > b[3]) b[3] = k;
};
Grid.prototype.addFeat = function (x, y, z, w) {
  const c = this.cell(x, z); if (c < 0) return;
  if (this.wD[c] > 3 && Math.abs(y - this.hD[c]) > 0.6) return;
  const W0 = this.wF[c], W2 = W0 + w;
  this.hF[c] += (y - this.hF[c]) * w / W2; this.wF[c] = W2;
  this.touch(c);
};
Grid.prototype.addDepth = function (x, y, z, w, pass, sector) {
  const c = this.cell(x, z); if (c < 0) return;
  const W0 = this.wD[c];
  if (W0 > 1.0) {
    const sd = Math.sqrt(this.qD[c] / W0);
    if (Math.abs(y - this.hD[c]) > Math.max(0.25, 4 * sd)) return;
  }
  const W2 = W0 + w, d = y - this.hD[c], m2 = this.hD[c] + d * w / W2;
  this.qD[c] += w * d * (y - m2); this.hD[c] = m2; this.wD[c] = W2;
  if (pass === 1) { const a = this.wA[c] + w; this.hA[c] += (y - this.hA[c]) * w / a; this.wA[c] = a; }
  else if (pass === 2) { const a = this.wB[c] + w; this.hB[c] += (y - this.hB[c]) * w / a; this.wB[c] = a; }
  this.sect[c] |= (1 << sector);
  this.touch(c);
};
Grid.prototype.height = function (c) {
  const wf = this.wF[c] * CFG.kF, wd = this.wD[c], Wt = wf + wd;
  return Wt > 0 ? (wf * this.hF[c] + wd * this.hD[c]) / Wt : NaN;
};
Grid.prototype.weight = function (c) { return this.wF[c] * CFG.kF + this.wD[c]; };

/* ------------------------------------------------------------------ */
/* depth fusion                                                        */
/* ------------------------------------------------------------------ */
function fuseDepth(D, fi) {
  const R = fr.R[fi], C = fr.C[fi];
  const nx = D.nx, ny = D.ny, data = D.data, p0 = D.p[0], p5 = D.p[1], p8 = D.p[2], p9 = D.p[3];
  const sector = (((Math.atan2(C[2] - center.z, C[0] - center.x) + Math.PI) / (2 * Math.PI) * 16) | 0) & 15;
  const pass = lastProgress < 0.15 ? 1 : (lastProgress > 0.88 ? 2 : 0);
  const e = CFG.depthEdge;
  let used = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const o = j * nx + i, d = data[o];
      if (!(d >= CFG.depthMin && d <= CFG.depthMax)) continue;
      let bad = false;
      if (i > 0) { const q = data[o - 1]; if (q > 0 && Math.abs(q - d) > e * d) bad = true; }
      if (!bad && i < nx - 1) { const q = data[o + 1]; if (q > 0 && Math.abs(q - d) > e * d) bad = true; }
      if (!bad && j > 0) { const q = data[o - nx]; if (q > 0 && Math.abs(q - d) > e * d) bad = true; }
      if (!bad && j < ny - 1) { const q = data[o + nx]; if (q > 0 && Math.abs(q - d) > e * d) bad = true; }
      if (bad) continue;
      const xn = 2 * (i + 0.5) / nx - 1, yn = 1 - 2 * (j + 0.5) / ny;
      const cx = d * (xn + p8) / p0, cy = d * (yn + p9) / p5, cz = -d;
      const wx = R[0] * cx + R[1] * cy + R[2] * cz + C[0];
      const wy = R[3] * cx + R[4] * cy + R[5] * cz + C[1];
      const wz = R[6] * cx + R[7] * cy + R[8] * cz + C[2];
      const w = CFG.depthW / (1 + (d / 3) * (d / 3));
      grid.addDepth(wx, wy, wz, w, pass, sector);
      used++;
    }
  }
  nDepthFrames++; nDepthSamples += used;
}

/* ------------------------------------------------------------------ */
/* frame entry point                                                   */
/* ------------------------------------------------------------------ */
function processFrame(m) {
  const t0 = now();
  const fi = fr.R.length;
  fr.R.push(m.R); fr.C.push(m.C); fr.I.push(m.intr); fr.t.push(m.t);
  lastProgress = m.progress || 0;
  if (started) camPath.push(m.C[0], m.C[1], m.C[2], m.t, lastProgress);
  if (m.gray) {
    const g = m.gray instanceof Uint8Array ? m.gray : new Uint8Array(m.gray);
    const w = m.intr.w, h = m.intr.h;
    if (w !== W || h !== H || !pyrA) {
      for (const tr of tracks) commit(tr);
      W = w; H = h; pyrA = makePyr(w, h, CFG.levels); pyrB = makePyr(w, h, CFG.levels);
      hasPrev = false; tracks = [];
    }
    buildPyr(pyrB, g);
    if (hasPrev) trackStep(fi);
    updateObs(fi);
    if (tracks.length < CFG.maxTracks * 0.9) detect(g, fi);
    if (!flipLocked && tracks.length && (fi % CFG.flipEvalEvery) === 0) evalFlip();
    const tmp = pyrA; pyrA = pyrB; pyrB = tmp; hasPrev = true; prevGrayFi = fi;
  }
  if (m.depth && started) fuseDepth(m.depth, fi);
  if (m.hits) for (const p of m.hits) groundHits.push(p[0], p[1], p[2]);
  procTimes.push(now() - t0); if (procTimes.length > 30) procTimes.shift();
  return packOutput(fi, m.t);
}
function start(c, t) {
  center = { x: c[0], y: c[1], z: c[2] };
  grid = new Grid(CFG.gridN, CFG.cellSize);
  grid.setOrigin(center.x, center.z);
  started = true; tStart = t;
}
function packOutput(fi, t) {
  const n = tracks.length, tr = new Float32Array(n * 7);
  let nGreen = 0;
  for (let i = 0; i < n; i++) {
    const k = tracks[i], o = i * 7;
    tr[o] = k.x; tr[o + 1] = k.y; tr[o + 2] = k.state;
    if (k.X) { tr[o + 3] = k.X[0]; tr[o + 4] = k.X[1]; tr[o + 5] = k.X[2]; tr[o + 6] = 1; }
    if (k.state === 2) nGreen++;
  }
  const np = new Float32Array(newPts); newPts = [];
  const msg = {
    type: 'tracks', fi, tracks: tr, newPts: np, flipMode, flipLocked,
    stats: { nTracks: n, nGreen, nPts, nDepthFrames, ms: procTimes.length ? median(procTimes) : 0, flip: flipStats, fastThr }
  };
  const transfer = [tr.buffer, np.buffer];
  if (started && t - lastMiniT > CFG.miniEveryMs / 1000) {
    lastMiniT = t;
    const mm = minimap(128);
    if (mm) { msg.mini = mm; transfer.push(mm.rgba.buffer); }
  }
  return { msg, transfer };
}

/* ------------------------------------------------------------------ */
/* minimap (top view of what has been measured so far)                 */
/* ------------------------------------------------------------------ */
function groundGuess() {
  if (groundHits.length >= 15) {
    const ys = []; for (let i = 1; i < groundHits.length; i += 3) ys.push(groundHits[i]);
    return median(ys);
  }
  const g = grid, b = g.bb, hs = [];
  if (b[2] < 0) return center ? center.y - 1 : 0;
  const step = Math.max(1, Math.floor(((b[2] - b[0] + 1) * (b[3] - b[1] + 1)) / 4000));
  let q = 0;
  for (let k = b[1]; k <= b[3]; k++) for (let i = b[0]; i <= b[2]; i++) {
    if ((q++ % step) !== 0) continue;
    const c = k * g.N + i; if (g.weight(c) >= CFG.minCellW) hs.push(g.height(c));
  }
  if (!hs.length) return 0;
  hs.sort((a, b) => a - b);
  return hs[Math.floor(hs.length * 0.04)];
}
function minimap(S) {
  const g = grid, b = g.bb;
  if (b[2] < 0) return null;
  const gy = groundGuess();
  const ci = (b[0] + b[2]) / 2, ck = (b[1] + b[3]) / 2;
  const span = Math.max(b[2] - b[0], b[3] - b[1], 40) * 1.15 + 6;
  const rgba = new Uint8ClampedArray(S * S * 4);
  let maxH = 0.5, sx = 0, sz = 0, sw = 0;
  const hs = new Float32Array(S * S).fill(NaN);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = Math.floor(ci + (x / S - 0.5) * span), k = Math.floor(ck + (y / S - 0.5) * span);
    if (i < 0 || k < 0 || i >= g.N || k >= g.N) continue;
    const c = k * g.N + i;
    if (g.weight(c) < CFG.minCellW) continue;
    const h = g.height(c) - gy; hs[y * S + x] = h;
    if (h > maxH) maxH = h;
  }
  for (let k = b[1]; k <= b[3]; k += 2) for (let i = b[0]; i <= b[2]; i += 2) {
    const c = k * g.N + i; if (g.weight(c) < CFG.minCellW) continue;
    const h = g.height(c) - gy; if (h > 0.3) { sx += (g.x0 + (i + 0.5) * g.s) * h; sz += (g.z0 + (k + 0.5) * g.s) * h; sw += h; }
  }
  for (let p = 0; p < S * S; p++) {
    const h = hs[p]; if (h !== h) continue;
    const c = heightColor(Math.max(0, h) / maxH);
    rgba[p * 4] = c[0]; rgba[p * 4 + 1] = c[1]; rgba[p * 4 + 2] = c[2]; rgba[p * 4 + 3] = 235;
  }
  const res = {
    S, rgba, x0: g.x0 + (ci - span / 2) * g.s, z0: g.z0 + (ck - span / 2) * g.s, size: span * g.s, maxH, groundY: gy
  };
  if (sw > 1) res.centerEst = [sx / sw, sz / sw];
  return res;
}
function heightColor(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [[0, 30, 60, 150], [0.25, 0, 170, 200], [0.5, 60, 200, 80], [0.75, 250, 200, 30], [1, 230, 60, 40]];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i], u = (t - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
    }
  }
  return [230, 60, 40];
}

/* ------------------------------------------------------------------ */
/* final computation                                                   */
/* ------------------------------------------------------------------ */
function rng32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function median(a) { const b = Array.from(a).sort((x, y) => x - y), n = b.length; return n ? (n % 2 ? b[(n - 1) / 2] : 0.5 * (b[n / 2 - 1] + b[n / 2])) : 0; }

function fitGround(H, obs, Wt, nx, nz, X0, Z0, s, camY) {
  const cx = [], cz = [], ch = [], cw = [];
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const j = k * nx + i; if (!obs[j]) continue;
    const h = H[j]; if (h < camY - 4.5 || h > camY - 0.25) continue;
    cx.push(X0 + i * s); cz.push(Z0 + k * s); ch.push(h); cw.push(Math.min(Wt[j], 3));
  }
  for (let q = 0; q < groundHits.length; q += 3) {
    const h = groundHits[q + 1]; if (h < camY - 4.5 || h > camY - 0.25) continue;
    cx.push(groundHits[q]); cz.push(groundHits[q + 2]); ch.push(h); cw.push(2);
  }
  const m = cx.length;
  if (m < 25) return null;
  const rnd = rng32(1234567);
  const order = Array.from({ length: m }, (_, i) => i).sort((a, b) => ch[a] - ch[b]);
  const low = order.slice(0, Math.max(10, Math.floor(m * 0.45)));
  let S = order;
  if (m > 12000) { S = []; for (let q = 0; q < 12000; q++) S.push((rnd() * m) | 0); }
  let bestP = null, bestScore = -1e18;
  for (let it = 0; it < 320; it++) {
    const p = low[(rnd() * low.length) | 0], q = low[(rnd() * low.length) | 0], r = low[(rnd() * low.length) | 0];
    const ux = cx[q] - cx[p], uz = cz[q] - cz[p], uh = ch[q] - ch[p];
    const vx = cx[r] - cx[p], vz = cz[r] - cz[p], vh = ch[r] - ch[p];
    const den = ux * vz - uz * vx;
    if (Math.abs(den) < 1.0) continue;
    const a = (uh * vz - uz * vh) / den, b = (ux * vh - uh * vx) / den;
    if (a * a + b * b > 0.031) continue;
    const c = ch[p] - a * cx[p] - b * cz[p];
    let sc = 0;
    for (let qq = 0; qq < S.length; qq++) {
      const j = S[qq];
      const rr = ch[j] - (a * cx[j] + b * cz[j] + c);
      if (rr > -0.06 && rr < 0.06) sc += cw[j]; else if (rr < -0.25) sc -= 3 * cw[j];
    }
    if (sc > bestScore) { bestScore = sc; bestP = { a, b, c }; }
  }
  if (!bestP) bestP = { a: 0, b: 0, c: ch[order[Math.floor(m * 0.05)]] };
  let { a, b, c } = bestP, rms = 0, nIn = 0;
  for (const thr of [0.07, 0.045]) {
    let mx = 0, mz = 0, sw = 0;
    for (let j = 0; j < m; j++) {
      const rr = ch[j] - (a * cx[j] + b * cz[j] + c);
      if (Math.abs(rr) < thr) { mx += cw[j] * cx[j]; mz += cw[j] * cz[j]; sw += cw[j]; }
    }
    if (sw < 1e-6) break;
    mx /= sw; mz /= sw;
    let Sxx = 0, Sxz = 0, Szz = 0, Sx = 0, Sz = 0, Sh = 0, Sxh = 0, Szh = 0, S1 = 0;
    for (let j = 0; j < m; j++) {
      const rr = ch[j] - (a * cx[j] + b * cz[j] + c);
      if (Math.abs(rr) >= thr) continue;
      const w = cw[j], x = cx[j] - mx, z = cz[j] - mz, h = ch[j];
      Sxx += w * x * x; Sxz += w * x * z; Szz += w * z * z; Sx += w * x; Sz += w * z; S1 += w;
      Sh += w * h; Sxh += w * x * h; Szh += w * z * h;
    }
    // solve [Sxx Sxz Sx; Sxz Szz Sz; Sx Sz S1] [a b c'] = [Sxh Szh Sh]
    const M = [Sxx, Sxz, Sx, Sxz, Szz, Sz, Sx, Sz, S1], v = [Sxh, Szh, Sh];
    const sol = solve3(M, v);
    if (!sol) break;
    let na = sol[0], nb = sol[1];
    if (na * na + nb * nb > 0.031) { na = a; nb = b; }
    a = na; b = nb; c = sol[2] - a * mx - b * mz;
  }
  let s2 = 0, sw2 = 0;
  for (let j = 0; j < m; j++) {
    const rr = ch[j] - (a * cx[j] + b * cz[j] + c);
    if (Math.abs(rr) < 0.06) { s2 += cw[j] * rr * rr; sw2 += cw[j]; nIn++; }
  }
  rms = sw2 > 0 ? Math.sqrt(s2 / sw2) : 0.05;
  return { a, b, c, rms, nIn };
}
function solve3(M, v) {
  const [a, b, c, d, e, f, g, h, i] = M;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const D = -(b * i - c * h), E = a * i - c * g, Fq = -(a * h - b * g);
  const G = b * f - c * e, Hh = -(a * f - c * d), I = a * e - b * d;
  return [(A * v[0] + D * v[1] + G * v[2]) / det, (B * v[0] + E * v[1] + Hh * v[2]) / det, (C * v[0] + Fq * v[1] + I * v[2]) / det];
}
function convexHull(P) {
  const pts2 = P.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts2.length < 3) return pts2;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts2) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts2.length - 1; i >= 0; i--) { const p = pts2[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

function chamfer(mask, nx, nz) {
  const n = nx * nz, BIG = 1e9, dist = new Float32Array(n);
  for (let j = 0; j < n; j++) dist[j] = mask[j] ? 0 : BIG;
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const j = k * nx + i; let d = dist[j];
    if (i > 0) d = Math.min(d, dist[j - 1] + 1);
    if (k > 0) { d = Math.min(d, dist[j - nx] + 1); if (i > 0) d = Math.min(d, dist[j - nx - 1] + 1.414); if (i < nx - 1) d = Math.min(d, dist[j - nx + 1] + 1.414); }
    dist[j] = d;
  }
  for (let k = nz - 1; k >= 0; k--) for (let i = nx - 1; i >= 0; i--) {
    const j = k * nx + i; let d = dist[j];
    if (i < nx - 1) d = Math.min(d, dist[j + 1] + 1);
    if (k < nz - 1) { d = Math.min(d, dist[j + nx] + 1); if (i < nx - 1) d = Math.min(d, dist[j + nx + 1] + 1.414); if (i > 0) d = Math.min(d, dist[j + nx - 1] + 1.414); }
    dist[j] = d;
  }
  return dist;
}

/* Thin-plate fill of unknown cells: solves the 13-point biharmonic system
   (20 z - 8 N4 + 2 D4 + F4 = 0) with conjugate gradients. Known cells keep
   their measured value; cells outside the pile count as ground (0). */
function biharmonicFill(U, Zs, obs, region, nx, nz) {
  const m = U.length, idx = new Int32Array(nx * nz).fill(-1);
  for (let q = 0; q < m; q++) idx[U[q]] = q;
  const OFF = [[-1, 0, -8], [1, 0, -8], [0, -1, -8], [0, 1, -8], [-1, -1, 2], [1, -1, 2], [-1, 1, 2], [1, 1, 2], [-2, 0, 1], [2, 0, 1], [0, -2, 1], [0, 2, 1]];
  const nbI = new Int32Array(m * 12).fill(-1), nbW = new Float32Array(m * 12), b = new Float64Array(m);
  for (let q = 0; q < m; q++) {
    const u = U[q], i = u % nx, k = (u / nx) | 0;
    let bb = 0;
    for (let e = 0; e < 12; e++) {
      const ii = i + OFF[e][0], kk = k + OFF[e][1], w = OFF[e][2];
      if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
      const c = kk * nx + ii, v = idx[c];
      if (v >= 0) { nbI[q * 12 + e] = v; nbW[q * 12 + e] = w; }
      else bb -= w * ((obs[c] || region[c]) ? Zs[c] : 0);
    }
    b[q] = bb;
  }
  const mul = (x, y) => {
    for (let q = 0; q < m; q++) {
      let s = 20 * x[q];
      for (let e = 0; e < 12; e++) { const v = nbI[q * 12 + e]; if (v >= 0) s += nbW[q * 12 + e] * x[v]; }
      y[q] = s;
    }
  };
  const x = new Float64Array(m), r = new Float64Array(m), p = new Float64Array(m), Ap = new Float64Array(m);
  for (let q = 0; q < m; q++) x[q] = Zs[U[q]];
  mul(x, Ap);
  let rr = 0, bn = 0;
  for (let q = 0; q < m; q++) { r[q] = b[q] - Ap[q]; p[q] = r[q]; rr += r[q] * r[q]; bn += b[q] * b[q]; }
  const tol = 1e-12 * Math.max(bn, 1e-9), t0 = now();
  for (let it = 0; it < 3000 && rr > tol; it++) {
    mul(p, Ap);
    let pAp = 0; for (let q = 0; q < m; q++) pAp += p[q] * Ap[q];
    if (pAp <= 0) break;
    const al = rr / pAp; let rn = 0;
    for (let q = 0; q < m; q++) { x[q] += al * p[q]; r[q] -= al * Ap[q]; rn += r[q] * r[q]; }
    const be = rn / rr; rr = rn;
    for (let q = 0; q < m; q++) p[q] = r[q] + be * p[q];
    if (now() - t0 > 4000) break;
  }
  for (let q = 0; q < m; q++) Zs[U[q]] = x[q];
}

function finish(opts) {
  opts = opts || {};
  for (const tr of tracks) commit(tr);
  const warnings = [];
  const g = grid;
  if (!started || !g || g.bb[2] < 0) return { msg: { type: 'result', error: 'No 3D data was captured. Make sure tracking works and walk around the pile.' }, transfer: [] };
  const N = g.N, s = g.s, mg = 8;
  const i0 = Math.max(0, g.bb[0] - mg), k0 = Math.max(0, g.bb[1] - mg);
  const i1 = Math.min(N - 1, g.bb[2] + mg), k1 = Math.min(N - 1, g.bb[3] + mg);
  const nx = i1 - i0 + 1, nz = k1 - k0 + 1, n = nx * nz;
  const H = new Float32Array(n), Wt = new Float32Array(n), obs = new Uint8Array(n);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const c = (k0 + k) * N + (i0 + i), j = k * nx + i, w = g.weight(c);
    if (w >= CFG.minCellW) { H[j] = g.height(c); Wt[j] = w; obs[j] = 1; } else H[j] = NaN;
  }
  const X0 = g.x0 + (i0 + 0.5) * s, Z0 = g.z0 + (k0 + 0.5) * s;
  const nP = camPath.length / 5;
  if (nP < 10) return { msg: { type: 'result', error: 'The walk was too short.' }, transfer: [] };
  const ys = []; for (let q = 0; q < nP; q++) ys.push(camPath[q * 5 + 1]);
  const camY = median(ys);
  const progress = opts.progress !== undefined ? opts.progress : camPath[(nP - 1) * 5 + 4];

  /* ground plane */
  const pl = fitGround(H, obs, Wt, nx, nz, X0, Z0, s, camY);
  if (!pl) return { msg: { type: 'result', error: 'Could not find the ground around the pile. Keep some ground in view while walking.' }, transfer: [] };
  const base = (x, z) => pl.a * x + pl.b * z + pl.c;
  const Z = new Float32Array(n);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const j = k * nx + i;
    Z[j] = obs[j] ? H[j] - base(X0 + i * s, Z0 + k * s) : NaN;
  }
  let pcx = 0, pcz = 0;
  for (let q = 0; q < nP; q++) { pcx += camPath[q * 5]; pcz += camPath[q * 5 + 2]; }
  pcx /= nP; pcz /= nP;
  const camH = camY - base(pcx, pcz);
  if (camH < 0.7 || camH > 2.4) warnings.push('Ground level looks unusual (phone was ' + camH.toFixed(2) + ' m above it). Check that enough ground around the pile was in view.');

  /* walking loop -> region that can contain the pile */
  const hullPts = [];
  for (let q = 0; q < nP; q += 3) hullPts.push([camPath[q * 5], camPath[q * 5 + 2]]);
  for (let j = 0; j < n; j += 3) if (obs[j] && Z[j] > 0.3) hullPts.push([X0 + (j % nx) * s, Z0 + ((j / nx) | 0) * s]);
  const hull = convexHull(hullPts);
  const inside = new Uint8Array(n);
  const hn = hull.length;
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const x = X0 + i * s, z = Z0 + k * s;
    let inn = hn >= 3;
    for (let e = 0; e < hn && inn; e++) {
      const a = hull[e], b = hull[(e + 1) % hn];
      if ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) < -1e-9) inn = false;
    }
    inside[k * nx + i] = inn ? 1 : 0;
  }

  /* pile candidates */
  const zt = Math.max(0.06, 2.5 * pl.rms);
  const pileObs = new Uint8Array(n);
  for (let j = 0; j < n; j++) pileObs[j] = (obs[j] && Z[j] > zt) ? 1 : 0;
  // chamfer distance (in cells) from observed pile cells
  const dist = chamfer(pileObs, nx, nz);
  // Unseen cells enclosed by the pile (typically its top) always belong to it.
  // Unseen cells that connect to open ground are only accepted close to the toe.
  const rc = Math.max(2, Math.round(0.3 / s));
  const barrier = new Uint8Array(n);
  for (let j = 0; j < n; j++) barrier[j] = dist[j] <= rc ? 1 : 0;
  const ext = new Uint8Array(n), eq = new Int32Array(n);
  let eh = 0, et = 0;
  for (let j = 0; j < n; j++) {
    if (barrier[j]) continue;
    if (!inside[j] || (obs[j] && Z[j] <= zt)) { ext[j] = 1; eq[et++] = j; }
  }
  while (eh < et) {
    const q = eq[eh++], qi = q % nx, qk = (q / nx) | 0;
    if (qi > 0 && !barrier[q - 1] && !ext[q - 1]) { ext[q - 1] = 1; eq[et++] = q - 1; }
    if (qi < nx - 1 && !barrier[q + 1] && !ext[q + 1]) { ext[q + 1] = 1; eq[et++] = q + 1; }
    if (qk > 0 && !barrier[q - nx] && !ext[q - nx]) { ext[q - nx] = 1; eq[et++] = q - nx; }
    if (qk < nz - 1 && !barrier[q + nx] && !ext[q + nx]) { ext[q + nx] = 1; eq[et++] = q + nx; }
  }
  const nearToe = 0.6 / s;
  const cand = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    cand[j] = inside[j] && (pileObs[j] || (!obs[j] && (!ext[j] || dist[j] <= nearToe))) ? 1 : 0;
  }

  /* connected components */
  const comp = new Int32Array(n).fill(-1), comps = [];
  const queue = new Int32Array(n);
  for (let j = 0; j < n; j++) {
    if (!cand[j] || comp[j] >= 0) continue;
    const id = comps.length; let qh = 0, qt = 0, score = 0, cnt = 0;
    queue[qt++] = j; comp[j] = id;
    while (qh < qt) {
      const q = queue[qh++]; cnt++;
      if (pileObs[q]) score += Z[q];
      const qi = q % nx, qk = (q / nx) | 0;
      if (qi > 0 && cand[q - 1] && comp[q - 1] < 0) { comp[q - 1] = id; queue[qt++] = q - 1; }
      if (qi < nx - 1 && cand[q + 1] && comp[q + 1] < 0) { comp[q + 1] = id; queue[qt++] = q + 1; }
      if (qk > 0 && cand[q - nx] && comp[q - nx] < 0) { comp[q - nx] = id; queue[qt++] = q - nx; }
      if (qk < nz - 1 && cand[q + nx] && comp[q + nx] < 0) { comp[q + nx] = id; queue[qt++] = q + nx; }
    }
    comps.push({ id, score, cnt });
  }
  if (!comps.length) return { msg: { type: 'result', error: 'No pile found above the ground inside your walking loop.' }, transfer: [] };
  comps.sort((a, b) => b.score - a.score);
  const main = comps[0].id;
  if (comps.length > 1 && comps[1].score > 0.1 * comps[0].score) warnings.push('Another heap or object inside your walking loop was left out of the volume.');
  const region = new Uint8Array(n);
  for (let j = 0; j < n; j++) region[j] = comp[j] === main ? 1 : 0;

  /* light smoothing of measured heights: local plane fit (keeps slopes
     unbiased, unlike a median), with a spike check first */
  const Zs = new Float32Array(n);
  const nb = new Float32Array(9), ndi = new Int8Array(9), ndk = new Int8Array(9);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const j = k * nx + i;
    if (!obs[j]) { Zs[j] = NaN; continue; }
    if (!region[j]) { Zs[j] = Z[j]; continue; }
    let c = 0;
    for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, kk = k + dk; if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
      const q = kk * nx + ii; if (obs[q]) { nb[c] = Z[q]; ndi[c] = di; ndk[c] = dk; c++; }
    }
    if (c < 5) { Zs[j] = Z[j]; continue; }
    // plane z = a + b*di + e*dk by least squares; drop the worst point if it is a spike
    let use = c, skip = -1;
    for (let pass = 0; pass < 2; pass++) {
      let S1 = 0, Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sz = 0, Sxz = 0, Syz = 0;
      for (let q = 0; q < c; q++) {
        if (q === skip) continue;
        const x = ndi[q], y = ndk[q], zz = nb[q];
        S1++; Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y; Sz += zz; Sxz += x * zz; Syz += y * zz;
      }
      const sol = solve3([S1, Sx, Sy, Sx, Sxx, Sxy, Sy, Sxy, Syy], [Sz, Sxz, Syz]);
      if (!sol) { Zs[j] = Z[j]; break; }
      Zs[j] = sol[0];
      if (pass === 0) {
        let worst = -1, we = 0;
        for (let q = 0; q < c; q++) { const e = Math.abs(nb[q] - (sol[0] + sol[1] * ndi[q] + sol[2] * ndk[q])); if (e > we) { we = e; worst = q; } }
        if (we > 0.15 && use > 5) { skip = worst; use--; } else break;
      }
    }
  }

  /* fill unseen cells inside the pile (smooth membrane) */
  const U = [];
  for (let j = 0; j < n; j++) if (region[j] && !obs[j]) U.push(j);
  const val = (q) => (obs[q] ? Zs[q] : (region[q] ? Zs[q] : 0));
  for (const u of U) Zs[u] = NaN;
  // initial fill by repeated neighbour averaging
  let pending = U.slice(), guard = 0;
  while (pending.length && guard++ < 400) {
    const next = [], upd = [];
    for (const u of pending) {
      const ui = u % nx, uk = (u / nx) | 0; let sm = 0, c = 0;
      const nbs = [ui > 0 ? u - 1 : -1, ui < nx - 1 ? u + 1 : -1, uk > 0 ? u - nx : -1, uk < nz - 1 ? u + nx : -1];
      for (const q of nbs) { if (q < 0) { c++; continue; } const v = obs[q] ? Zs[q] : (region[q] ? Zs[q] : 0); if (v === v) { sm += v; c++; } }
      if (c) upd.push([u, sm / c]); else next.push(u);
    }
    for (const [u, v] of upd) Zs[u] = v;
    pending = next;
  }
  for (const u of pending) Zs[u] = 0;
  for (let it = 0; it < 400 && U.length; it++) {
    let md = 0;
    for (const u of U) {
      const ui = u % nx, uk = (u / nx) | 0;
      const a = ui > 0 ? val(u - 1) : 0, b = ui < nx - 1 ? val(u + 1) : 0, c = uk > 0 ? val(u - nx) : 0, d = uk < nz - 1 ? val(u + nx) : 0;
      const nv = Zs[u] + 1.85 * ((a + b + c + d) * 0.25 - Zs[u]);
      md = Math.max(md, Math.abs(nv - Zs[u])); Zs[u] = nv;
    }
    if (md < 2e-4) break;
  }
  // then a thin-plate (biharmonic) fill: continues the slopes into the gap,
  // so an unseen peak is rebuilt instead of being cut flat
  if (U.length) biharmonicFill(U, Zs, obs, region, nx, nz);

  /* volume and statistics. Gaps of up to ~25 cm between measured cells count
     as interpolated (seen); anything further from a measurement is "unseen". */
  const dObs = chamfer(obs, nx, nz), near = Math.max(1.5, 0.25 / s);
  let V = 0, Vfill = 0, Vinterp = 0, area = 0, maxH = 0, nFoot = 0, nFootObs = 0, mx = 0, mz = 0;
  for (let j = 0; j < n; j++) {
    if (!region[j]) continue;
    const z = Math.max(Zs[j], -0.05);
    V += z * s * s;
    const seen = dObs[j] <= near;
    if (!obs[j]) { if (seen) Vinterp += Math.max(z, 0) * s * s; else Vfill += Math.max(z, 0) * s * s; }
    if (z > zt) { nFoot++; if (seen) nFootObs++; mx += X0 + (j % nx) * s; mz += Z0 + ((j / nx) | 0) * s; }
    if (z > maxH) maxH = z;
  }
  area = nFoot * s * s;
  if (nFoot) { mx /= nFoot; mz /= nFoot; }
  let cxx = 0, cxz = 0, czz = 0;
  for (let j = 0; j < n; j++) if (region[j] && Zs[j] > zt) {
    const x = X0 + (j % nx) * s - mx, z = Z0 + ((j / nx) | 0) * s - mz;
    cxx += x * x; cxz += x * z; czz += z * z;
  }
  const ang = 0.5 * Math.atan2(2 * cxz, cxx - czz), ca = Math.cos(ang), sa = Math.sin(ang);
  let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
  for (let j = 0; j < n; j++) if (region[j] && Zs[j] > zt) {
    const x = X0 + (j % nx) * s - mx, z = Z0 + ((j / nx) | 0) * s - mz;
    const u = x * ca + z * sa, v = -x * sa + z * ca;
    if (u < a0) a0 = u; if (u > a1) a1 = u; if (v < b0) b0 = v; if (v > b1) b1 = v;
  }
  const len = Math.max(a1 - a0, b1 - b0) + s, wid = Math.min(a1 - a0, b1 - b0) + s;
  const coverage = nFoot ? nFootObs / nFoot : 0;

  // loop consistency: same ground seen at the start and the end of the walk
  let lmS = 0, lmW = 0, lmN = 0;
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const c = (k0 + k) * N + (i0 + i);
    if (g.wA[c] >= 0.3 && g.wB[c] >= 0.3) {
      const w = Math.min(g.wA[c], g.wB[c]);
      lmS += w * Math.abs(g.hA[c] - g.hB[c]); lmW += w; lmN++;
    }
  }
  const loopMis = lmN >= 20 ? lmS / lmW : null;

  // ring just outside the pile: should sit on the base plane
  const ring = new Uint8Array(n);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const j = k * nx + i; if (region[j]) continue;
    let near = false;
    for (let dk = -3; dk <= 3 && !near; dk++) for (let di = -3; di <= 3; di++) {
      const ii = i + di, kk = k + dk; if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
      if (region[kk * nx + ii]) { near = true; break; }
    }
    if (near && obs[j]) ring[j] = 1;
  }
  let rS = 0, rS2 = 0, rN = 0;
  for (let j = 0; j < n; j++) if (ring[j]) { rS += Z[j]; rS2 += Z[j] * Z[j]; rN++; }
  const ringMean = rN ? rS / rN : 0, ringRms = rN ? Math.sqrt(Math.max(0, rS2 / rN)) : 0;

  /* uncertainty, in plain terms: what could make the number wrong */
  const relScale = opts.scaleFixed ? 0.003 : 0.015;
  const eScale = 3 * relScale * V;
  const eFill = 0.12 * Vfill + 0.02 * Vinterp;
  const eBase = (Math.abs(ringMean) * 0.5 + (rN ? ringRms / Math.sqrt(rN) : 0.02) + 0.008) * area;
  const eLoop = loopMis !== null ? 0.4 * loopMis * area : 0.02 * area;
  const sigma = Math.sqrt(eScale * eScale + eFill * eFill + eBase * eBase + eLoop * eLoop);

  if (progress < 0.95) warnings.push('The loop around the pile was not closed (' + Math.round(progress * 100) + '% of the way round). The unseen side was filled in by estimation.');
  if (coverage < 0.85) warnings.push(Math.round((1 - coverage) * 100) + '% of the pile surface was not seen directly and was filled in.');
  if (Math.abs(ringMean) > 0.08 || ringRms > 0.12) warnings.push('The ground around the pile is uneven or sloping, so the base level is less certain.');
  if (loopMis !== null && loopMis > 0.08) warnings.push('Tracking drifted a little during the walk (' + Math.round(loopMis * 100) + ' cm mismatch where the loop closed).');
  if (nPts < 300 && nDepthFrames < 30) warnings.push('Very little 3D data was collected.');

  /* outputs for the 3D view */
  const mask = new Uint8Array(n);
  for (let j = 0; j < n; j++) mask[j] = (region[j] ? 1 : 0) | (dObs[j] <= near ? 2 : 0);
  const Zout = new Float32Array(n);
  for (let j = 0; j < n; j++) Zout[j] = region[j] ? Zs[j] : (obs[j] ? Z[j] : (dObs[j] <= near ? 0 : NaN));
  const step = Math.max(1, Math.ceil(nPts / 25000));
  const P = new Float32Array(Math.ceil(nPts / step) * 3); let pc = 0;
  for (let q = 0; q < nPts; q += step) {
    const x = pts[q * 4], y = pts[q * 4 + 1], z = pts[q * 4 + 2];
    P[pc++] = x; P[pc++] = y - base(x, z); P[pc++] = z;
  }
  const pstep = Math.max(1, Math.ceil(nP / 600));
  const path = new Float32Array(Math.ceil(nP / pstep) * 3); let qc = 0;
  for (let q = 0; q < nP; q += pstep) {
    const x = camPath[q * 5], y = camPath[q * 5 + 1], z = camPath[q * 5 + 2];
    path[qc++] = x; path[qc++] = y - base(x, z); path[qc++] = z;
  }
  const result = {
    type: 'result', volume: V, sigma, filledVolume: Vfill, footprint: area, maxHeight: maxH,
    length: len, width: wid, coverage, progress, loopMismatch: loopMis, ground: { a: pl.a, b: pl.b, c: pl.c, rms: pl.rms, n: pl.nIn },
    ringMean, ringRms, camHeight: camH, nPoints: nPts, nDepthFrames, nDepthSamples, duration: nP ? camPath[(nP - 1) * 5 + 3] - camPath[3] : 0,
    flipMode, flipLocked, flipStats, warnings, zt,
    parts: { scale: eScale, fill: eFill, base: eBase, loop: eLoop },
    grid: { nx, nz, s, x0: X0, z0: Z0, Z: Zout, mask }, center: [mx, mz], points: P, path
  };
  return { msg: result, transfer: [Zout.buffer, mask.buffer, P.buffer, path.buffer] };
}

function state() {
  return { started, flipMode, flipLocked, nPts, nTracks: tracks.length, nDepthFrames, frames: fr.R.length };
}

return { CFG, reset, processFrame, start, finish, state, _test: { lk, makePyr, buildPyr, detect: () => null, has9, triCore, median, convexHull, fitGround, solve3 } };
})();

if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof importScripts === 'function') {
  self.onmessage = function (e) {
    const m = e.data;
    try {
      if (m.type === 'reset') { PSE.reset(m.cfg); self.postMessage({ type: 'ready' }); }
      else if (m.type === 'frame') { const o = PSE.processFrame(m); self.postMessage(o.msg, o.transfer); }
      else if (m.type === 'start') { PSE.start(m.center, m.t); }
      else if (m.type === 'finish') { const o = PSE.finish(m.opts); self.postMessage(o.msg, o.transfer); }
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.stack || err) });
    }
  };
}
if (typeof module !== 'undefined' && module.exports) module.exports = PSE;
