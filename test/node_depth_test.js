// Depth-only end-to-end check of fusion, ground fit, segmentation and volume.
// A cone-shaped pile on flat ground; a simulated phone walks around it and
// produces ARCore-like depth samples (with noise). Compare volume with truth.
const PSE = require(require('path').join(__dirname, '..', 'src', 'engine.js'));
const DEG = Math.PI / 180;

function makePile(kind) {
  const tanA = Math.tan(35 * DEG);
  if (kind === 'cone') {
    const H0 = 3.5;
    return (x, z) => Math.max(0, H0 - Math.hypot(x, z) * tanA);
  }
  // irregular: cone + lobe, rounded top, gentle waviness
  return (x, z) => {
    const r1 = Math.hypot(x, z), r2 = Math.hypot(x - 2.6, z + 1.4);
    const a = 3.3 - r1 * tanA, b = 2.2 - r2 * tanA;
    const k = 0.6; // smooth max
    const m = Math.max(a, b), sm = m + Math.log(Math.exp((a - m) / k) + Math.exp((b - m) / k)) * k - 0.35;
    const wav = 0.06 * Math.sin(1.7 * x + 0.5) * Math.cos(1.3 * z - 0.2);
    let h = sm + (sm > 0 ? wav * Math.min(1, sm) : 0);
    // round the top
    if (h > 3.0) h = 3.0 + (h - 3.0) * 0.5;
    return Math.max(0, h);
  };
}
function truthVolume(h) {
  let V = 0; const s = 0.01;
  for (let x = -12; x < 12; x += s) for (let z = -12; z < 12; z += s) V += h(x + s / 2, z + s / 2);
  return V * s * s;
}
function lookAt(C, T) {
  // camera looks along -z; returns row-major R (world_from_cam)
  let fz = [C[0] - T[0], C[1] - T[1], C[2] - T[2]]; // backward
  let n = Math.hypot(...fz); fz = fz.map(v => v / n);
  let up = [0, 1, 0];
  let fx = [up[1] * fz[2] - up[2] * fz[1], up[2] * fz[0] - up[0] * fz[2], up[0] * fz[1] - up[1] * fz[0]];
  n = Math.hypot(...fx); fx = fx.map(v => v / n);
  const fy = [fz[1] * fx[2] - fz[2] * fx[1], fz[2] * fx[0] - fz[0] * fx[2], fz[0] * fx[1] - fz[1] * fx[0]];
  return [fx[0], fy[0], fz[0], fx[1], fy[1], fz[1], fx[2], fy[2], fz[2]];
}
function castRay(h, o, d) {
  let t = 0.05;
  for (let it = 0; it < 400; it++) {
    const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
    const gap = y - h(x, z);
    if (gap < 0.002) return t;
    t += Math.max(0.004, gap / 1.8);
    if (t > 12) return 0;
  }
  return 0;
}
let seed = 7; function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
function gauss() { return Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()); }

function run(kind, opts) {
  const h = makePile(kind), Vt = truthVolume(h);
  PSE.reset({ flipLocked: true, flipMode: 1 });
  const vfov = 62 * DEG, aspect = 0.45, p5 = 1 / Math.tan(vfov / 2), p0 = p5 / aspect;
  const nx = 36, ny = 80, fps = 10, T = 110, R0 = 9.5;
  let started = false;
  const theta0 = 0.3;
  for (let f = 0; f < T * fps; f++) {
    const t = f / fps;
    const prog = Math.max(0, (t - 2) / (T - 4)) * 1.07;
    const th = theta0 + prog * 2 * Math.PI;
    const r = R0 + 0.4 * Math.sin(3 * th);
    const C = [r * Math.cos(th), 1.45 + 0.03 * Math.sin(t * 11), r * Math.sin(th)];
    const Tg = [0.3 * Math.sin(t * 0.7), 1.0, 0.3 * Math.cos(t * 0.5)];
    const R = lookAt(C, Tg);
    // ARCore-like errors: scale error + slow drift
    const sc = 1 + (opts.scaleErr || 0);
    const drift = (opts.drift || 0) * t;
    const Cr = [C[0] * sc + drift, C[1] * sc, C[2] * sc];
    const data = new Float32Array(nx * ny);
    const lfx = gauss(), lfy = gauss();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const xn = 2 * (i + 0.5) / nx - 1, yn = 1 - 2 * (j + 0.5) / ny;
      const dc = [xn / p0, yn / p5, -1];
      const dw = [R[0] * dc[0] + R[1] * dc[1] + R[2] * dc[2], R[3] * dc[0] + R[4] * dc[1] + R[5] * dc[2], R[6] * dc[0] + R[7] * dc[1] + R[8] * dc[2]];
      const len = Math.hypot(...dw); const du = dw.map(v => v / len);
      const tt = castRay(h, C, du);
      if (!tt) { data[j * nx + i] = 0; continue; }
      let d = tt / len; // z-depth (distance to camera plane)
      const sig = (opts.noise || 0.01) * d;
      d = d * sc + sig * gauss() + 0.5 * sig * (lfx * xn + lfy * yn);
      data[j * nx + i] = d > 8 ? 0 : d;
    }
    if (!started && t >= 2) { PSE.start([0.2, 1.2, -0.2], t); started = true; }
    const msg = { R, C: Cr, intr: { w: 216, h: 480, fx: 0, fy: 1, cx: 0, cy: 0 }, t, progress: prog,
      depth: { nx, ny, data, p: [p0, p5, 0, 0] } };
    // ground hits every 0.5 s: ray toward the ground in front of the user
    if (f % 5 === 0) {
      const gd = [Tg[0] - C[0], -1.3, Tg[2] - C[2]];
      const gl = Math.hypot(...gd); const gu = gd.map(v => v / gl);
      const tt = castRay(h, C, gu);
      if (tt) { const p = [C[0] + gu[0] * tt, C[1] + gu[1] * tt, C[2] + gu[2] * tt]; if (h(p[0], p[2]) < 0.01) msg.hits = [[p[0] * sc + drift, p[1] * sc, p[2] * sc]]; }
    }
    PSE.processFrame(msg);
  }
  const res = PSE.finish({}).msg;
  if (res.error) { console.log(kind, 'ERROR', res.error); return; }
  const err = (res.volume - Vt) / Vt * 100;
  console.log(`${kind.padEnd(10)} ${JSON.stringify(opts)} truth ${Vt.toFixed(2)} m3  measured ${res.volume.toFixed(2)} m3  err ${err.toFixed(2)}%  ` +
    `±${(1.5 * res.sigma / res.volume * 100).toFixed(1)}%  cover ${(res.coverage * 100).toFixed(0)}%  maxH ${res.maxHeight.toFixed(2)}  ` +
    `ground rms ${(res.ground.rms * 100).toFixed(1)}cm camH ${res.camHeight.toFixed(2)} loopMis ${res.loopMismatch && (res.loopMismatch * 100).toFixed(1)}cm`);
  if (res.warnings.length) console.log('   warnings:', res.warnings.join(' | '));
  if (!opts.scaleErr && !opts.drift) {
    const G = res.grid; let sb = 0, nb = 0, vo = 0, vt = 0, vfT = 0, vfM = 0;
    for (let k = 0; k < G.nz; k++) for (let i = 0; i < G.nx; i++) {
      const j = k * G.nx + i; if (!(G.mask[j] & 1)) continue;
      const x = G.x0 + i * G.s, z = G.z0 + k * G.s, ht = h(x, z);
      if (G.mask[j] & 2) { sb += G.Z[j] - ht; nb++; vo += G.Z[j]; vt += ht; }
      else { vfT += ht; vfM += G.Z[j]; }
    }
    const a = G.s * G.s;
    console.log(`   observed cells: bias ${(sb / nb * 100).toFixed(1)} cm, vol ${(vo * a).toFixed(2)} vs true ${(vt * a).toFixed(2)};  filled cells: ${(vfM * a).toFixed(2)} vs true ${(vfT * a).toFixed(2)};  truth outside region ${(Vt - (vt + vfT) * a).toFixed(2)}`);
  }
}
const t0 = Date.now();
run('cone', { noise: 0.01 });
run('irregular', { noise: 0.01 });
// run('irregular', { noise: 0.02 });
run('irregular', { noise: 0.015, scaleErr: 0.01 });
run('irregular', { noise: 0.015, drift: 0.002 });
console.log('time', (Date.now() - t0) / 1000, 's');
