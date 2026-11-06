/* ---------- 3D result viewer (WebGL1): height-coloured pile surface with contours ---------- */
class PileViewer {
  constructor(canvas) {
    this.c = canvas;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL not available');
    this.gl = gl;
    this.ext = gl.getExtension('OES_element_index_uint');
    gl.getExtension('OES_standard_derivatives');
    this.prog = GLU.program(gl,
      `attribute vec3 aPos; attribute vec3 aNrm; attribute vec4 aCol;
       uniform mat4 uMVP; varying vec4 vCol; varying vec3 vN; varying float vH;
       void main(){ vCol = aCol; vN = aNrm; vH = aPos.y; gl_Position = uMVP * vec4(aPos, 1.0); gl_PointSize = 2.5; }`,
      `#extension GL_OES_standard_derivatives : enable
       precision mediump float; varying vec4 vCol; varying vec3 vN; varying float vH;
       uniform float uContour; uniform float uLit;
       void main(){
         vec3 c = vCol.rgb;
         if (uLit > 0.5) {
           float d = max(dot(normalize(vN), normalize(vec3(0.4, 0.85, 0.3))), 0.0);
           c = c * (0.42 + 0.68 * d);
           if (uContour > 0.0 && vCol.a > 0.5) {
             float f = vH / uContour; float w = fwidth(f) * 1.2;
             float l = abs(fract(f + 0.5) - 0.5);
             c = mix(vec3(0.06), c, smoothstep(0.0, w, l) * 0.6 + 0.4 * step(w, l));
           }
         }
         gl_FragColor = vec4(c, 1.0);
       }`);
    this.yaw = -0.7; this.pitch = 0.62; this.dist = 20; this.target = [0, 1, 0]; this.showPts = false; this.top = false;
    this.bind();
  }
  load(res) {
    const gl = this.gl, G = res.grid, nx = G.nx, nz = G.nz, s = G.s, Z = G.Z, M = G.mask;
    const cx = res.center[0], cz = res.center[1];
    this.cx = cx; this.cz = cz;
    const pos = new Float32Array(nx * nz * 3), nrm = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 4);
    let maxH = Math.max(0.5, res.maxHeight);
    const zAt = (i, k) => { const v = Z[k * nx + i]; return v === v ? v : 0; };
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const j = k * nx + i, z = zAt(i, k);
      pos[j * 3] = G.x0 + i * s - cx; pos[j * 3 + 1] = Math.max(z, -0.05); pos[j * 3 + 2] = G.z0 + k * s - cz;
      const hl = zAt(Math.max(0, i - 1), k), hr = zAt(Math.min(nx - 1, i + 1), k), hd = zAt(i, Math.max(0, k - 1)), hu = zAt(i, Math.min(nz - 1, k + 1));
      let a = (hl - hr) / (2 * s), b = 1, cc = (hd - hu) / (2 * s); const l = Math.hypot(a, b, cc);
      nrm[j * 3] = a / l; nrm[j * 3 + 1] = b / l; nrm[j * 3 + 2] = cc / l;
      const inPile = M[j] & 1, seen = M[j] & 2;
      let rgb;
      if (inPile) { rgb = PileViewer.cmap(Math.max(0, z) / maxH); if (!seen) rgb = [rgb[0] * 0.6 + 0.3, rgb[1] * 0.6 + 0.3, rgb[2] * 0.6 + 0.3]; }
      else rgb = seen ? [0.36, 0.38, 0.40] : [0.20, 0.21, 0.23];
      col[j * 4] = rgb[0]; col[j * 4 + 1] = rgb[1]; col[j * 4 + 2] = rgb[2]; col[j * 4 + 3] = inPile ? 1 : 0;
    }
    const idx = [];
    for (let k = 0; k < nz - 1; k++) for (let i = 0; i < nx - 1; i++) {
      const a = k * nx + i, b = a + 1, c = a + nx, d = c + 1;
      const ok = (q) => Z[q] === Z[q];
      if (ok(a) && ok(b) && ok(c) && ok(d)) idx.push(a, c, d, a, d, b);
    }
    const mk = (data, tgt) => { const b = gl.createBuffer(); gl.bindBuffer(tgt || gl.ARRAY_BUFFER, b); gl.bufferData(tgt || gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
    this.bPos = mk(pos); this.bNrm = mk(nrm); this.bCol = mk(col);
    const use32 = !!this.ext && nx * nz > 65535;
    this.idxType = use32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    if (!use32 && nx * nz > 65535) { this.nIdx = 0; } else { this.bIdx = mk(use32 ? new Uint32Array(idx) : new Uint16Array(idx), gl.ELEMENT_ARRAY_BUFFER); this.nIdx = idx.length; }
    // points (measured 3D points) and walking path
    const P = res.points, np = P.length / 3, pp = new Float32Array(np * 3), pc = new Float32Array(np * 4), pn = new Float32Array(np * 3);
    for (let q = 0; q < np; q++) { pp[q * 3] = P[q * 3] - cx; pp[q * 3 + 1] = P[q * 3 + 1]; pp[q * 3 + 2] = P[q * 3 + 2] - cz; pc.set([0.15, 0.95, 0.4, 0], q * 4); pn[q * 3 + 1] = 1; }
    this.bPP = mk(pp); this.bPC = mk(pc); this.bPN = mk(pn); this.nPP = np;
    const L = res.path, nl = L.length / 3, lp = new Float32Array(nl * 3), lc = new Float32Array(nl * 4), ln = new Float32Array(nl * 3);
    for (let q = 0; q < nl; q++) { lp[q * 3] = L[q * 3] - cx; lp[q * 3 + 1] = 0.03; lp[q * 3 + 2] = L[q * 3 + 2] - cz; lc.set([1, 0.8, 0.1, 0], q * 4); ln[q * 3 + 1] = 1; }
    this.bLP = mk(lp); this.bLC = mk(lc); this.bLN = mk(ln); this.nLP = nl;
    const ext = Math.max(res.length || 10, 6);
    this.dist0 = ext * 1.55 + 4; this.dist = this.dist0; this.target = [0, maxH * 0.3, 0];
    const st = maxH / 6; this.contour = st < 0.3 ? 0.25 : (st < 0.75 ? 0.5 : (st < 1.5 ? 1 : 2));
    this.render();
  }
  static cmap(t) {
    t = Math.max(0, Math.min(1, t));
    const S = [[0, 0.12, 0.24, 0.6], [0.25, 0.0, 0.66, 0.78], [0.5, 0.24, 0.78, 0.32], [0.75, 0.98, 0.78, 0.12], [1, 0.9, 0.24, 0.16]];
    for (let i = 1; i < S.length; i++) if (t <= S[i][0]) { const a = S[i - 1], b = S[i], u = (t - a[0]) / (b[0] - a[0]); return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u]; }
    return [0.9, 0.24, 0.16];
  }
  resize() {
    const r = this.c.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (this.c.width !== w || this.c.height !== h) { this.c.width = w; this.c.height = h; }
  }
  render() {
    if (!this.bPos) return;
    this.resize();
    const gl = this.gl, p = this.prog, w = this.c.width, h = this.c.height;
    gl.viewport(0, 0, w, h); gl.clearColor(0.075, 0.085, 0.10, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const pitch = this.top ? 1.5607 : this.pitch;
    const eye = [this.target[0] + this.dist * Math.cos(pitch) * Math.cos(this.yaw), this.target[1] + this.dist * Math.sin(pitch), this.target[2] + this.dist * Math.cos(pitch) * Math.sin(this.yaw)];
    const V = PileViewer.lookAt(eye, this.target, this.top ? [Math.cos(this.yaw + Math.PI), 0, Math.sin(this.yaw + Math.PI)] : [0, 1, 0]);
    const Pm = M4.perspective(45 * Math.PI / 180, w / h, 0.1, 500), mvp = M4.mul(Pm, V);
    gl.useProgram(p); gl.uniformMatrix4fv(p.u.uMVP, false, mvp);
    const attr = (b, loc, n) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0); };
    attr(this.bPos, p.a.aPos, 3); attr(this.bNrm, p.a.aNrm, 3); attr(this.bCol, p.a.aCol, 4);
    gl.uniform1f(p.u.uContour, this.contour); gl.uniform1f(p.u.uLit, 1);
    if (this.nIdx) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bIdx); gl.drawElements(gl.TRIANGLES, this.nIdx, this.idxType, 0); }
    gl.uniform1f(p.u.uLit, 0);
    if (this.showPts && this.nPP) { attr(this.bPP, p.a.aPos, 3); attr(this.bPN, p.a.aNrm, 3); attr(this.bPC, p.a.aCol, 4); gl.drawArrays(gl.POINTS, 0, this.nPP); }
    if (this.nLP) { attr(this.bLP, p.a.aPos, 3); attr(this.bLN, p.a.aNrm, 3); attr(this.bLC, p.a.aCol, 4); gl.drawArrays(gl.LINE_STRIP, 0, this.nLP); }
  }
  static lookAt(e, t, up) {
    let z = [e[0] - t[0], e[1] - t[1], e[2] - t[2]]; let l = Math.hypot(...z); z = z.map(v => v / l);
    let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]]; l = Math.hypot(...x) || 1; x = x.map(v => v / l);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -(x[0] * e[0] + x[1] * e[1] + x[2] * e[2]), -(y[0] * e[0] + y[1] * e[1] + y[2] * e[2]), -(z[0] * e[0] + z[1] * e[1] + z[2] * e[2]), 1]);
  }
  bind() {
    const c = this.c, ptrs = new Map(); let lastD = 0, lastTap = 0;
    const redraw = () => { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); }); };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY, e.button]);
      const now = performance.now(); if (now - lastTap < 300) { this.yaw = -0.7; this.pitch = 0.62; this.dist = this.dist0; redraw(); } lastTap = now;
    });
    c.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      const prev = ptrs.get(e.pointerId), dx = e.clientX - prev[0], dy = e.clientY - prev[1];
      ptrs.set(e.pointerId, [e.clientX, e.clientY, prev[2]]);
      if (ptrs.size === 1) {
        if (prev[2] === 2 || e.shiftKey) this.pan(dx, dy);
        else { this.yaw += dx * 0.008; this.pitch = Math.max(0.05, Math.min(1.5, this.pitch + dy * 0.006)); }
      } else if (ptrs.size === 2) {
        const [a, b] = Array.from(ptrs.values()), d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (lastD) this.dist = Math.max(2, Math.min(300, this.dist * lastD / d));
        lastD = d; this.pan(dx / 2, dy / 2);
      }
      redraw();
    });
    const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) lastD = 0; };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.dist = Math.max(2, Math.min(300, this.dist * Math.exp(e.deltaY * 0.001))); redraw(); }, { passive: false });
    window.addEventListener('resize', redraw);
  }
  pan(dx, dy) {
    const k = this.dist * 0.0016, sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const right = [sy, 0, -cy], fwd = [-cy, 0, -sy];
    this.target[0] += -right[0] * dx * k + fwd[0] * dy * k;
    this.target[2] += -right[2] * dx * k + fwd[2] * dy * k;
  }
  setTop(v) { this.top = v; this.render(); }
  setPoints(v) { this.showPts = v; this.render(); }
  snapshot(w, h) {
    this.render();
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    out.getContext('2d').drawImage(this.c, 0, 0, w, h);
    return out.toDataURL('image/jpeg', 0.75);
  }
}
