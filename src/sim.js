/* ---------- synthetic gravel pile: demo mode and automated accuracy tests ----------
   Renders a textured pile with WebGL2 and walks a virtual phone around it, producing
   the same inputs the AR mode gets from ARCore: pose, camera image and depth. */
const SIM_DEG = Math.PI / 180;
const SimWorld = {
  pile(kind) {
    const tanA = Math.tan(35 * SIM_DEG);
    if (kind === 'cone') return (x, z) => Math.max(0, 3.4 - Math.hypot(x, z) * tanA);
    if (kind === 'ridge') return (x, z) => {
      const ax = Math.max(0, Math.abs(x) - 3.5), r = Math.hypot(ax, z);
      return Math.max(0, Math.min(2.6, 3.1 - r * tanA));
    };
    return (x, z) => { // irregular heap: main cone + side lobe, rounded top, waviness
      const r1 = Math.hypot(x, z), r2 = Math.hypot(x - 2.6, z + 1.4);
      const a = 3.3 - r1 * tanA, b = 2.2 - r2 * tanA, k = 0.6, m = Math.max(a, b);
      const sm = m + Math.log(Math.exp((a - m) / k) + Math.exp((b - m) / k)) * k - 0.35;
      const wav = 0.06 * Math.sin(1.7 * x + 0.5) * Math.cos(1.3 * z - 0.2);
      let h = sm + (sm > 0 ? wav * Math.min(1, sm) : 0);
      if (h > 3.0) h = 3.0 + (h - 3.0) * 0.5;
      return Math.max(0, h);
    };
  },
  mesh(hf) {
    const n = 241, L = 12, st = 2 * L / (n - 1);
    const pos = new Float32Array(n * n * 3), nrm = new Float32Array(n * n * 3), H = new Float32Array(n * n);
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) H[k * n + i] = hf(-L + i * st, -L + k * st);
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
      const j = k * n + i, x = -L + i * st, z = -L + k * st;
      pos[j * 3] = x; pos[j * 3 + 1] = H[j]; pos[j * 3 + 2] = z;
      const hl = H[k * n + Math.max(0, i - 1)], hr = H[k * n + Math.min(n - 1, i + 1)];
      const hd = H[Math.max(0, k - 1) * n + i], hu = H[Math.min(n - 1, k + 1) * n + i];
      let nx = (hl - hr) / (2 * st), ny = 1, nz = (hd - hu) / (2 * st); const l = Math.hypot(nx, ny, nz);
      nrm[j * 3] = nx / l; nrm[j * 3 + 1] = ny / l; nrm[j * 3 + 2] = nz / l;
    }
    const idx = new Uint32Array((n - 1) * (n - 1) * 6); let q = 0, V = 0;
    for (let k = 0; k < n - 1; k++) for (let i = 0; i < n - 1; i++) {
      const a = k * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = b;
      V += st * st / 6 * (H[a] + H[d] + H[c] + H[a] + H[d] + H[b]);
    }
    return { pos, nrm, idx, truthVolume: V, hf, n, L, st, H };
  },
  heightAt(M, x, z) { // bilinear on the mesh grid (matches the rendered surface closely)
    const fx = (x + M.L) / M.st, fz = (z + M.L) / M.st;
    if (fx < 0 || fz < 0 || fx >= M.n - 1 || fz >= M.n - 1) return 0;
    const i = fx | 0, k = fz | 0, ax = fx - i, az = fz - k, H = M.H, n = M.n;
    return H[k * n + i] * (1 - ax) * (1 - az) + H[k * n + i + 1] * ax * (1 - az) + H[(k + 1) * n + i] * (1 - ax) * az + H[(k + 1) * n + i + 1] * ax * az;
  },
  castRay(M, o, d) {
    let t = 0.05;
    for (let it = 0; it < 500; it++) {
      const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
      const gap = y - SimWorld.heightAt(M, x, z);
      if (gap < 0.002) return t;
      t += Math.max(0.004, gap / 1.8);
      if (t > 60) return 0;
    }
    return 0;
  }
};

const SIM_VS = `#version 300 es
in vec3 aPos; in vec3 aNrm;
uniform mat4 uVP; uniform mat4 uV;
out vec3 vW; out vec3 vN; out float vD;
void main(){ vW = aPos; vN = aNrm; vD = -(uV * vec4(aPos,1.0)).z; gl_Position = uVP * vec4(aPos,1.0); }`;
const SIM_FS = `#version 300 es
precision highp float;
in vec3 vW; in vec3 vN; in float vD;
uniform int uMode; uniform vec3 uSun;
out vec4 o;
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031,.1030,.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(h12(i), h12(i+vec2(1,0)), u.x), mix(h12(i+vec2(0,1)), h12(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a*vn(p); p *= 2.03; a *= 0.5; } return s; }
vec2 vor(vec2 x){ vec2 n = floor(x), f = fract(x); float m1 = 8.0, m2 = 8.0, id = 0.0;
  for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++){ vec2 g = vec2(float(i),float(j)); vec2 r = g + h22(n+g) - f; float d = dot(r,r);
    if (d < m1){ m2 = m1; m1 = d; id = h12(n+g); } else if (d < m2) m2 = d; }
  return vec2(id, sqrt(m2) - sqrt(m1)); }
void main(){
  if (uMode == 1) {
    float mm = floor(vD * 1000.0 + 0.5);
    float r = floor(mm / 65536.0); float g = floor((mm - r*65536.0) / 256.0); float b = mm - r*65536.0 - g*256.0;
    o = vec4(r/255.0, g/255.0, b/255.0, 1.0); return;
  }
  vec2 p = vW.xz + vec2(0.0, vW.y*0.35);
  float px = length(fwidth(vW.xz));
  float lod = smoothstep(0.01, 0.035, px);
  vec2 v = vor(p * 24.0);
  float peb = 0.55 + 0.42*(v.x-0.5) - 0.30*(1.0 - smoothstep(0.0, 0.10, v.y));
  peb = mix(peb, 0.52, lod*0.85);
  float big = (fbm(p*0.7)-0.5)*0.35 + (fbm(p*4.0)-0.5)*0.22;
  vec3 gravel = vec3(0.72,0.68,0.62) * (peb + big);
  vec2 v2 = vor(p * 7.0);
  float gtx = 0.52 + 0.22*(v2.x-0.5) + (fbm(p*1.1)-0.5)*0.45 + (fbm(p*14.0)-0.5)*0.25*(1.0-lod);
  vec3 ground = vec3(0.47,0.45,0.42) * gtx;
  float pile = smoothstep(0.015, 0.07, vW.y);
  vec3 alb = mix(ground, gravel, pile);
  vec3 n = normalize(vN);
  float dif = max(dot(n, normalize(uSun)), 0.0);
  vec3 col = alb * (0.38 + 0.78*dif);
  col = mix(col, vec3(0.78,0.84,0.92), smoothstep(45.0, 140.0, vD));
  o = vec4(col, 1.0);
}`;

class SimSource {
  constructor(opts) {
    this.o = Object.assign({ kind: 'demo', speed: 1, walkTime: 100, R0: 9.0, depth: true, camera: true, test: false,
      scaleErr: 0, drift: 0, yawDrift: 0, flipSim: 0, procH: 480, aspect: 0.45, depthNoise: 0.012, seed: 3 }, opts || {});
    this.seed = this.o.seed;
  }
  rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }
  gauss() { return Math.sqrt(-2 * Math.log(this.rnd() + 1e-12)) * Math.cos(2 * Math.PI * this.rnd()); }
  init(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available for the demo.');
    this.gl = gl;
    this.world = SimWorld.mesh(SimWorld.pile(this.o.kind));
    this.truthVolume = this.world.truthVolume;
    this.prog = GLU.program(gl, SIM_VS, SIM_FS);
    const mk = (data, target) => { const b = gl.createBuffer(); gl.bindBuffer(target || gl.ARRAY_BUFFER, b); gl.bufferData(target || gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
    this.bPos = mk(this.world.pos); this.bNrm = mk(this.world.nrm); this.bIdx = mk(this.world.idx, gl.ELEMENT_ARRAY_BUFFER);
    this.nIdx = this.world.idx.length;
    const G = 160, gp = new Float32Array([-G, -0.004, -G, G, -0.004, -G, -G, -0.004, G, G, -0.004, G]);
    this.bGround = mk(gp); this.bGroundN = mk(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]));
    this.bGroundI = mk(new Uint32Array([0, 2, 3, 0, 3, 1]), gl.ELEMENT_ARRAY_BUFFER);
    const H = this.o.procH, Wd = Math.round(H * this.o.aspect / 4) * 4;
    this.procW = Wd; this.procH = H;
    this.camFbo = GLU.fbo(gl, Wd * 2, H * 2, true);
    this.dnx = Math.round(80 * this.o.aspect); this.dny = 80;
    this.depthFbo = GLU.fbo(gl, this.dnx, this.dny, true);
    this.packer = new GrayPacker(gl);
    this.dots = new DotRenderer(gl);
    this.vfov = 62 * SIM_DEG;
    this.proj = M4.perspective(this.vfov, this.o.aspect, 0.1, 400);
    this.p = [this.proj[0], this.proj[5], this.proj[8], this.proj[9]];
  }
  /* virtual walk: warm-up, then one loop plus overlap, slowing down at the end */
  truePose(t) {
    const o = this.o, warm = 1.5, T = o.walkTime;
    const u = Math.max(0, Math.min(1, (t - warm) / T));
    // speed ramps up, then halves over the last 12% (slowing down to close the loop)
    const F = u <= 0.04 ? u * u / 0.08 : (u <= 0.88 ? 0.02 + (u - 0.04) : 0.86 + (u - 0.88) - (u - 0.88) * (u - 0.88) / 0.48);
    const prog = 1.07 * F / 0.95;
    const th = 0.4 + prog * 2 * Math.PI;
    const r = o.R0 + 0.35 * Math.sin(3 * th + 1);
    const C = [r * Math.cos(th), 1.45 + 0.025 * Math.sin(2 * Math.PI * t / 0.55), r * Math.sin(th)];
    const T3 = [0.4 * Math.sin(0.37 * t), 1.05 + 0.18 * Math.sin(0.23 * t), 0.4 * Math.cos(0.29 * t)];
    let fz = [C[0] - T3[0], C[1] - T3[1], C[2] - T3[2]]; let l = Math.hypot(...fz); fz = fz.map(v => v / l);
    const roll = 2.5 * SIM_DEG * Math.sin(0.9 * t);
    let up = [Math.sin(roll) * -fz[2], Math.cos(roll), Math.sin(roll) * fz[0]];
    let fx = [up[1] * fz[2] - up[2] * fz[1], up[2] * fz[0] - up[0] * fz[2], up[0] * fz[1] - up[1] * fz[0]]; l = Math.hypot(...fx); fx = fx.map(v => v / l);
    const fy = [fz[1] * fx[2] - fz[2] * fx[1], fz[2] * fx[0] - fz[0] * fx[2], fz[0] * fx[1] - fz[1] * fx[0]];
    return { R: [fx[0], fy[0], fz[0], fx[1], fy[1], fz[1], fx[2], fy[2], fz[2]], C, prog, walking: t >= warm, done: u >= 1 };
  }
  /* what ARCore would report: optional scale error, drift and yaw drift */
  reportedPose(tp, t) {
    const o = this.o;
    if (!o.scaleErr && !o.drift && !o.yawDrift) return { R: tp.R.slice(), C: tp.C.slice() };
    if (!this._d) { this._d = [0, 0, 0]; this._lt = t; this._C0 = tp.C.slice(); }
    const dt = Math.max(0, t - this._lt); this._lt = t;
    for (let i = 0; i < 3; i++) this._d[i] += o.drift * Math.sqrt(dt) * this.gauss();
    const s = 1 + o.scaleErr, C0 = this._C0;
    let C = [C0[0] + (tp.C[0] - C0[0]) * s + this._d[0], C0[1] + (tp.C[1] - C0[1]) * s + this._d[1], C0[2] + (tp.C[2] - C0[2]) * s + this._d[2]];
    const a = o.yawDrift * SIM_DEG * t, ca = Math.cos(a), sa = Math.sin(a);
    const rx = C[0] - C0[0], rz = C[2] - C0[2];
    C = [C0[0] + ca * rx + sa * rz, C[1], C0[2] - sa * rx + ca * rz];
    const R = tp.R, Rr = [];
    for (let c = 0; c < 3; c++) { const x = R[c], y = R[3 + c], z = R[6 + c]; Rr[c] = ca * x + sa * z; Rr[3 + c] = y; Rr[6 + c] = -sa * x + ca * z; }
    return { R: Rr, C };
  }
  viewMatrices(R, C) {
    const pose = M4.pose(R, C), view = M4.invRigid(pose);
    return { view, vp: M4.mul(this.proj, view) };
  }
  drawScene(vp, view, mode) {
    const gl = this.gl, p = this.prog;
    gl.useProgram(p);
    gl.uniformMatrix4fv(p.u.uVP, false, vp); gl.uniformMatrix4fv(p.u.uV, false, view);
    gl.uniform1i(p.u.uMode, mode); gl.uniform3f(p.u.uSun, 0.45, 0.8, 0.35);
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    const draw = (bp, bn, bi, cnt) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, bp); gl.enableVertexAttribArray(p.a.aPos); gl.vertexAttribPointer(p.a.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bn); gl.enableVertexAttribArray(p.a.aNrm); gl.vertexAttribPointer(p.a.aNrm, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bi); gl.drawElements(gl.TRIANGLES, cnt, gl.UNSIGNED_INT, 0);
    };
    draw(this.bGround, this.bGroundN, this.bGroundI, 6);
    draw(this.bPos, this.bNrm, this.bIdx, this.nIdx);
    gl.disableVertexAttribArray(p.a.aPos); gl.disableVertexAttribArray(p.a.aNrm);
  }
  grabGray(tp) {
    const gl = this.gl, { view, vp } = this.viewMatrices(tp.R, tp.C);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.camFbo.fb); gl.viewport(0, 0, this.camFbo.w, this.camFbo.h);
    gl.clearColor(0.70, 0.80, 0.92, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.drawScene(vp, view, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let g = this.packer.grab(this.camFbo.tex, this.procW, this.procH, this.camFbo.w, this.camFbo.h);
    if (this.o.flipSim) g = flipImage(g, this.procW, this.procH, this.o.flipSim);
    return g;
  }
  grabDepth(tp) {
    const gl = this.gl, { view, vp } = this.viewMatrices(tp.R, tp.C), w = this.dnx, h = this.dny;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthFbo.fb); gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.drawScene(vp, view, 1);
    const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const out = new Float32Array(w * h), sn = this.o.depthNoise, lx = this.gauss(), ly = this.gauss();
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const q = ((h - 1 - j) * w + i) * 4;
      let d = (px[q] * 65536 + px[q + 1] * 256 + px[q + 2]) / 1000;
      if (d <= 0 || d > 8) { out[j * w + i] = 0; continue; }
      const xn = 2 * (i + 0.5) / w - 1, yn = 1 - 2 * (j + 0.5) / h, sg = sn * d;
      d = d + sg * this.gauss() + 0.5 * sg * (lx * xn + ly * yn);
      out[j * w + i] = d;
    }
    return { nx: w, ny: h, data: out, p: this.p.slice() };
  }
  rayFromScreen(tp, sx, sy) {
    const xn = 2 * sx - 1, yn = 1 - 2 * sy;
    const dc = [(xn + this.p[2]) / this.p[0], (yn + this.p[3]) / this.p[1], -1], R = tp.R;
    const d = [R[0] * dc[0] + R[1] * dc[1] + R[2] * dc[2], R[3] * dc[0] + R[4] * dc[1] + R[5] * dc[2], R[6] * dc[0] + R[7] * dc[1] + R[8] * dc[2]];
    const l = Math.hypot(...d); return d.map(v => v / l);
  }
  hitAt(tp, sx, sy) {
    const d = this.rayFromScreen(tp, sx, sy), t = SimWorld.castRay(this.world, tp.C, d);
    if (!t) return null;
    const P = [tp.C[0] + d[0] * t, tp.C[1] + d[1] * t, tp.C[2] + d[2] * t];
    return { p: P, ground: SimWorld.heightAt(this.world, P[0], P[2]) < 0.02, dist: t };
  }
  intrinsics() {
    const w = this.procW, h = this.procH, p = this.proj;
    return { w, h, fx: p[0] * w / 2, fy: p[5] * h / 2, cx: w / 2 * (1 - p[8]), cy: h / 2 * (1 + p[9]) };
  }
  display(tp, tracksBuf, flip, vpReported) {
    const gl = this.gl, c = this.canvas;
    const { view, vp } = this.viewMatrices(tp.R, tp.C);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0.70, 0.80, 0.92, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.drawScene(vp, view, 0);
    const dpr = c.width / (c.clientWidth || c.width);
    this.dots.drawMap(vpReported || vp, dpr);
    if (tracksBuf) this.dots.drawTracks(tracksBuf, this.procW, this.procH, flip, dpr);
    if (this.extraLines) this.dots.drawLines(this.extraLines.v, this.extraLines.c, vp, this.extraLines.mode);
    return vp;
  }
}
function flipImage(g, w, h, mode) {
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sy = (mode & 1) ? h - 1 - y : y, sx = (mode & 2) ? w - 1 - x : x;
    o[y * w + x] = g[sy * w + sx];
  }
  return o;
}
