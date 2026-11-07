/* ---------- AR source: Chrome on Android (ARCore) via WebXR ----------
   Gives metric 6-DoF poses (gravity aligned), the camera image (camera-access),
   depth-from-motion (depth-sensing) and hit tests on detected surfaces. */
class XRSource {
  static async supported() {
    try { return !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-ar')); } catch (e) { return false; }
  }
  constructor(opts) { this.o = opts || {}; this.isSim = false; this.ended = false; this.lastGroundT = -1; this.lastCenterHit = null; }
  async start(capture) {
    this.cap = capture;
    const root = $('ov');
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local'],
      optionalFeatures: ['camera-access', 'depth-sensing', 'dom-overlay', 'hit-test'],
      domOverlay: { root },
      depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] }
    });
    this.session = session;
    root.addEventListener('beforexrselect', (e) => e.preventDefault());
    const canvas = document.createElement('canvas');
    let gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true, antialias: false });
    this.gl = gl;
    if (gl.makeXRCompatible) { try { await gl.makeXRCompatible(); } catch (e) { } }
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl, { alpha: true, antialias: false }) });
    this.ref = await session.requestReferenceSpace('local');
    this.viewerSpace = await session.requestReferenceSpace('viewer');
    const en = session.enabledFeatures ? Array.from(session.enabledFeatures) : ['camera-access', 'depth-sensing', 'hit-test', 'dom-overlay'];
    let depthOk = en.includes('depth-sensing');
    try { if (depthOk && session.depthUsage !== 'cpu-optimized') depthOk = false; } catch (e) { depthOk = false; }
    this.feat = {
      camera: en.includes('camera-access') && typeof XRWebGLBinding !== 'undefined',
      depth: depthOk, hit: en.includes('hit-test'), overlay: en.includes('dom-overlay')
    };
    this.featInfo = 'cam ' + (this.feat.camera ? '✓' : '✗') + ' depth ' + (this.feat.depth ? '✓' : '✗') + ' hit ' + (this.feat.hit ? '✓' : '✗');
    if (this.feat.camera) { try { this.binding = new XRWebGLBinding(session, gl); } catch (e) { this.feat.camera = false; } }
    if (this.feat.hit) {
      const req = async (opt) => { try { return await session.requestHitTestSource(opt); } catch (e) { return null; } };
      this.hitCenter = await req({ space: this.viewerSpace, entityTypes: ['plane', 'point'] }) || await req({ space: this.viewerSpace });
      const down = new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: -0.6, z: -1, w: 0 });
      this.hitGround = await req({ space: this.viewerSpace, offsetRay: down, entityTypes: ['plane'] }) || await req({ space: this.viewerSpace, offsetRay: down });
    }
    if (!this.feat.camera && !this.feat.depth) {
      session.end();
      throw new Error('This phone/browser did not grant camera access or depth in AR, so nothing can be measured. Update Chrome and Google Play Services for AR, and allow camera access.');
    }
    this.packer = new GrayPacker(gl);
    this.dots = new DotRenderer(gl);
    session.addEventListener('end', () => { this.ended = true; if (this.cap.phase === 'walk' || this.cap.phase === 'warmup') this.cap.abortExternal(); });
    session.requestAnimationFrame((t, f) => this.onFrame(t, f));
    return this.feat;
  }
  centerHit() { return this.lastCenterHit; }
  centerRay() { return this.lastCenterRay; }
  stop() { if (!this.ended && this.session) { this.ended = true; try { this.session.end(); } catch (e) { } } }
  onFrame(time, frame) {
    if (this.ended) return;
    const s = this.session;
    s.requestAnimationFrame((t, f) => this.onFrame(t, f));
    const gl = this.gl, layer = s.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const t = time / 1000;
    const pose = frame.getViewerPose(this.ref);
    if (!pose) { this.cap.frame({ t, tracking: false }); return; }
    const view = pose.views[0], vp = layer.getViewport(view);
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    const m = view.transform.matrix, { R, C } = M4.toRC(m), P = view.projectionMatrix;
    { // sight line through the centre dot (the projection can be slightly off-centre)
      const dc = [P[8] / P[0], P[9] / P[5], -1], D = [R[0] * dc[0] + R[1] * dc[1] + R[2] * dc[2], R[3] * dc[0] + R[4] * dc[1] + R[5] * dc[2], R[6] * dc[0] + R[7] * dc[1] + R[8] * dc[2]];
      const l = Math.hypot(D[0], D[1], D[2]); this.lastCenterRay = { C: C.slice(), D: [D[0] / l, D[1] / l, D[2] / l] };
    }
    // centre hit (pile surface) and ground hits
    let centerHit = null;
    if (this.hitCenter) {
      const r = frame.getHitTestResults(this.hitCenter);
      if (r.length) { const hp = r[0].getPose(this.ref); if (hp) { const q = hp.transform.position; centerHit = { p: [q.x, q.y, q.z] }; } }
    }
    let depthInfo = null;
    if (this.feat.depth) { try { depthInfo = frame.getDepthInformation(view); } catch (e) { depthInfo = null; } }
    if (depthInfo) {
      // depth at the screen centre is a better "what am I looking at" than plane hits
      const d = depthInfo.getDepthInMeters(0.5, 0.5);
      if (d > 0.3) {
        const dc = [P[8] / P[0] * d, P[9] / P[5] * d, -d];
        centerHit = { p: [R[0] * dc[0] + R[1] * dc[1] + R[2] * dc[2] + C[0], R[3] * dc[0] + R[4] * dc[1] + R[5] * dc[2] + C[1], R[6] * dc[0] + R[7] * dc[1] + R[8] * dc[2] + C[2]], dist: d };
      }
    }
    if (centerHit) { if (!centerHit.dist) centerHit.dist = Math.hypot(centerHit.p[0] - C[0], centerHit.p[1] - C[1], centerHit.p[2] - C[2]); this.lastCenterHit = centerHit; }
    let hits = null;
    if (this.hitGround && t - this.lastGroundT > 0.25) {
      this.lastGroundT = t;
      const r = frame.getHitTestResults(this.hitGround);
      if (r.length) {
        const hp = r[0].getPose(this.ref);
        if (hp && hp.transform.matrix[5] > 0.93) { const q = hp.transform.position; hits = [[q.x, q.y, q.z]]; }
      }
    }
    const want = this.cap.frame({ t, R, C, tracking: !pose.emulatedPosition, nearDist: centerHit ? centerHit.dist : null });
    const aspect = vp.width / vp.height, H = 480, W = Math.max(4, Math.round(H * aspect / 4) * 4);
    if (want) {
      const intr = { w: W, h: H, fx: P[0] * W / 2, fy: P[5] * H / 2, cx: W / 2 * (1 - P[8]), cy: H / 2 * (1 + P[9]) };
      let gray = null, depth = null;
      if (this.feat.camera && view.camera) {
        try {
          const tex = this.binding.getCameraImage(view.camera);
          if (tex) gray = this.packer.grab(tex, W, H, view.camera.width, view.camera.height);
          this.camSize = view.camera.width + 'x' + view.camera.height;
        } catch (e) { console.warn('camera image', e); }
        gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
        gl.viewport(vp.x, vp.y, vp.width, vp.height);
      }
      if (depthInfo && this.cap.phase === 'walk') {
        const ny = 80, nx = Math.max(8, Math.round(80 * aspect)), data = new Float32Array(nx * ny);
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          let d = 0; try { d = depthInfo.getDepthInMeters((i + 0.5) / nx, (j + 0.5) / ny); } catch (e) { d = 0; }
          data[j * nx + i] = d > 0 ? d : 0;
        }
        depth = { nx, ny, data, p: [P[0], P[5], P[8], P[9]] };
      }
      if (gray || depth) this.cap.submit({ t, R, C, intr, gray, depth, hits });
    }
    // overlays: measured points, tracked dots, start flag, reference marks
    const mvp = M4.mul(P, M4.invRigid(m)), dpr = vp.width / (window.innerWidth || vp.width);
    this.dots.drawMap(mvp, dpr);
    if (this.cap.tracks) this.dots.drawTracks(this.cap.tracks, W, H, this.cap.flip, dpr);
    this.drawMarks(mvp, dpr);
  }
  drawMarks(mvp, dpr) {
    const cap = this.cap, v = [], c = [];
    const gy = cap.groundY !== undefined && cap.groundY !== null ? cap.groundY : (cap.startC ? cap.startC[1] - 1.45 : 0);
    if (cap.startC && cap.phase === 'walk' && !cap.partial) {
      const x = cap.startC[0], z = cap.startC[2];
      for (let h = 0; h <= 2.0; h += 0.06) { v.push(x, gy + h, z); c.push(1, 0.83, 0, 0.95); }
    }
    for (const p of [cap.refA, cap.refB]) if (p) {
      for (let k = -4; k <= 4; k++) { v.push(p[0] + k * 0.03, p[1] + 0.01, p[2]); c.push(1, 0.3, 1, 1); v.push(p[0], p[1] + 0.01, p[2] + k * 0.03); c.push(1, 0.3, 1, 1); }
    }
    if (v.length) this.dots.drawLines(new Float32Array(v), new Float32Array(c), mvp, this.gl.POINTS);
    if (cap.startC && cap.phase === 'walk' && !cap.partial) {
      const x = cap.startC[0], z = cap.startC[2], top = gy + 2.0;
      const f = new Float32Array([x, top, z, x + 0.45, top - 0.14, z, x, top - 0.28, z]);
      this.dots.drawLines(f, new Float32Array([1, 0.83, 0, 0.9, 1, 0.83, 0, 0.9, 1, 0.83, 0, 0.9]), mvp, this.gl.TRIANGLES);
    }
  }
}
