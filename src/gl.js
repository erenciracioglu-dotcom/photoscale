/* ---------- shared WebGL helpers ---------- */
const GLU = {
  program(gl, vs, fs) {
    const mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
    p.u = {}; p.a = {};
    const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < nu; i++) { const inf = gl.getActiveUniform(p, i); p.u[inf.name.replace('[0]', '')] = gl.getUniformLocation(p, inf.name); }
    const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < na; i++) { const inf = gl.getActiveAttrib(p, i); p.a[inf.name] = gl.getAttribLocation(p, inf.name); }
    return p;
  },
  fbo(gl, w, h, withDepth) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let rb = null;
    if (withDepth) {
      rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, rb, w, h };
  },
  quadBuffer(gl) {
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    return b;
  }
};

/* mat4 helpers (column-major, like WebGL/WebXR) */
const M4 = {
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
    }
    return o;
  },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far), o = new Float32Array(16);
    o[0] = f / aspect; o[5] = f; o[10] = (far + near) * nf; o[11] = -1; o[14] = 2 * far * near * nf;
    return o;
  },
  // world_from_cam (pose) from row-major R and C -> column-major 4x4
  pose(R, C) {
    return new Float32Array([R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, C[0], C[1], C[2], 1]);
  },
  invRigid(m) {
    const o = new Float32Array(16);
    o[0] = m[0]; o[1] = m[4]; o[2] = m[8]; o[4] = m[1]; o[5] = m[5]; o[6] = m[9]; o[8] = m[2]; o[9] = m[6]; o[10] = m[10];
    o[12] = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]);
    o[13] = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]);
    o[14] = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
    o[15] = 1;
    return o;
  },
  // pose matrix (column-major) -> row-major R, C
  toRC(m) {
    return { R: [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]], C: [m[12], m[13], m[14]] };
  }
};

/* Camera image -> small grayscale image packed 4 pixels per RGBA texel.
   Each gray pixel averages 4 bilinear taps (reduces aliasing). */
class GrayPacker {
  constructor(gl) {
    this.gl = gl;
    this.prog = GLU.program(gl,
      'attribute vec2 aPos; void main(){ gl_Position = vec4(aPos,0.0,1.0); }',
      `precision highp float;
       uniform sampler2D uTex; uniform vec2 uSize; uniform vec2 uTap;
       float lum(vec2 uv){ vec3 c = texture2D(uTex, uv).rgb; return dot(c, vec3(0.299,0.587,0.114)); }
       float px(float x, float y){
         vec2 uv = vec2(x / uSize.x, y / uSize.y);
         return 0.25*(lum(uv+vec2(-uTap.x,-uTap.y))+lum(uv+vec2(uTap.x,-uTap.y))+lum(uv+vec2(-uTap.x,uTap.y))+lum(uv+vec2(uTap.x,uTap.y)));
       }
       void main(){
         float fx = floor(gl_FragCoord.x); float y = gl_FragCoord.y;
         gl_FragColor = vec4(px(4.0*fx+0.5,y), px(4.0*fx+1.5,y), px(4.0*fx+2.5,y), px(4.0*fx+3.5,y));
       }`);
    this.quad = GLU.quadBuffer(gl);
    this.target = null;
  }
  ensure(w, h) {
    if (this.target && this.target.w === w / 4 && this.target.h === h) return;
    this.target = GLU.fbo(this.gl, w / 4, h, false);
    this.buf = new Uint8Array(w * h);
  }
  // tex: WebGLTexture holding the camera image; srcW/srcH its size (for tap spacing)
  grab(tex, w, h, srcW, srcH) {
    const gl = this.gl; this.ensure(w, h);
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevVp = gl.getParameter(gl.VIEWPORT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.fb);
    gl.viewport(0, 0, w / 4, h);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.prog.u.uTex, 0);
    gl.uniform2f(this.prog.u.uSize, w, h);
    const sx = srcW ? Math.max(0.25, (srcW / w) * 0.25) / srcW : 0, sy = srcH ? Math.max(0.25, (srcH / h) * 0.25) / srcH : 0;
    gl.uniform2f(this.prog.u.uTap, sx, sy);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.prog.a.aPos);
    gl.vertexAttribPointer(this.prog.a.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(this.prog.a.aPos);
    const out = new Uint8Array(w * h);
    gl.readPixels(0, 0, w / 4, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
    return out;
  }
}

/* Draws the tracked dots (2D, image positions) and measured points (3D),
   plus simple 3D lines/triangles (start flag, reference marks). */
class DotRenderer {
  constructor(gl) {
    this.gl = gl;
    this.prog = GLU.program(gl,
      `attribute vec3 aPos; attribute vec4 aCol;
       uniform mat4 uMVP; uniform float uIs2D; uniform float uSize;
       varying vec4 vCol;
       void main(){
         vCol = aCol;
         gl_Position = uIs2D > 0.5 ? vec4(aPos.xy, 0.0, 1.0) : uMVP * vec4(aPos, 1.0);
         gl_PointSize = uSize;
       }`,
      `precision mediump float; varying vec4 vCol; uniform float uRound;
       void main(){
         if (uRound > 0.5) {
           vec2 d = gl_PointCoord - 0.5; float r = length(d);
           if (r > 0.5) discard;
           float ring = smoothstep(0.30, 0.36, r);
           gl_FragColor = vec4(mix(vCol.rgb, vec3(0.05), ring*0.85), vCol.a);
         } else gl_FragColor = vCol;
       }`);
    this.bPos = gl.createBuffer(); this.bCol = gl.createBuffer();
    this.bMapPos = gl.createBuffer(); this.mapCount = 0; this.mapCap = 0; this.mapData = new Float32Array(0);
  }
  _draw(mode, pos, col, count, mvp, is2D, size, round) {
    const gl = this.gl, p = this.prog;
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bPos); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(p.a.aPos); gl.vertexAttribPointer(p.a.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bCol); gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(p.a.aCol); gl.vertexAttribPointer(p.a.aCol, 4, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(p.u.uMVP, false, mvp || new Float32Array(16));
    gl.uniform1f(p.u.uIs2D, is2D ? 1 : 0); gl.uniform1f(p.u.uSize, size); gl.uniform1f(p.u.uRound, round ? 1 : 0);
    gl.drawArrays(mode, 0, count);
    gl.disableVertexAttribArray(p.a.aPos); gl.disableVertexAttribArray(p.a.aCol);
  }
  // tracks: Float32Array [u,v,state,X,Y,Z,hasX]*n ; mapping image->NDC uses flip mode
  drawTracks(tracks, w, h, flip, dpr) {
    const n = tracks.length / 7; if (!n) return;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 4);
    const C = [[1.0, 0.18, 0.25, 0.95], [0.15, 0.55, 1.0, 0.95], [0.25, 0.95, 0.35, 0.95]];
    for (let i = 0; i < n; i++) {
      let uc = tracks[i * 7] + 0.5, vc = tracks[i * 7 + 1] + 0.5;
      if (flip & 1) vc = h - vc; if (flip & 2) uc = w - uc;
      pos[i * 3] = 2 * uc / w - 1; pos[i * 3 + 1] = 1 - 2 * vc / h;
      const c = C[Math.max(0, Math.min(2, tracks[i * 7 + 2] | 0))];
      col.set(c, i * 4);
    }
    const gl = this.gl;
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
    this._draw(gl.POINTS, pos, col, n, null, true, 9 * (dpr || 1), true);
  }
  addMapPoints(np) {
    if (!np || !np.length) return;
    const add = np.length / 4;
    const need = (this.mapCount + add) * 3;
    if (need > this.mapData.length) { const d = new Float32Array(Math.max(need, this.mapData.length * 2, 3000)); d.set(this.mapData.subarray(0, this.mapCount * 3)); this.mapData = d; }
    for (let i = 0; i < add; i++) { this.mapData[(this.mapCount + i) * 3] = np[i * 4]; this.mapData[(this.mapCount + i) * 3 + 1] = np[i * 4 + 1]; this.mapData[(this.mapCount + i) * 3 + 2] = np[i * 4 + 2]; }
    this.mapCount += add; this.mapDirty = true;
  }
  resetMap() { this.mapCount = 0; this.mapDirty = true; }
  drawMap(mvp, dpr) {
    if (!this.mapCount) return;
    const gl = this.gl, p = this.prog, maxShow = 20000;
    const start = Math.max(0, this.mapCount - maxShow), cnt = this.mapCount - start;
    if (!this.mapCol || this.mapCol.length < cnt * 4) { this.mapCol = new Float32Array(Math.max(cnt, 4000) * 4); for (let i = 0; i < this.mapCol.length / 4; i++) this.mapCol.set([0.2, 0.95, 0.4, 0.55], i * 4); }
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
    this._draw(gl.POINTS, this.mapData.subarray(start * 3, this.mapCount * 3), this.mapCol.subarray(0, cnt * 4), cnt, mvp, false, 3.5 * (dpr || 1), true);
  }
  drawLines(verts, cols, mvp, mode) {
    const gl = this.gl;
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
    this._draw(mode === undefined ? gl.LINES : mode, verts, cols, verts.length / 3, mvp, false, 1, false);
  }
}
