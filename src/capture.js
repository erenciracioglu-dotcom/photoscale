/* ---------- capture controller (shared by AR mode and the simulated demo) ---------- */
const TAU = Math.PI * 2;
/* grid resolution per pile size: cell size (m) x cells per side = covered area */
const PILE_SIZES = {
  small: { cellSize: 0.10, gridN: 640, label: 'up to 25 m' },   // 64 m square
  medium: { cellSize: 0.25, gridN: 800, label: '25–80 m' },     // 200 m square
  large: { cellSize: 0.50, gridN: 1000, label: '80–300 m' }     // 500 m square
};
const $ = (id) => document.getElementById(id);

const Overlay = {
  show(isSim) {
    $('ov').classList.remove('hidden');
    $('ov').classList.toggle('sim', !!isSim);
    this.setMain('START', false);
    $('ov-ref').textContent = 'Mark A'; $('ov-ref').classList.add('hidden');
    $('ov-topedge').textContent = 'Top edge'; $('ov-topedge').classList.add('hidden');
    this.setMsg('Starting…', 'info', 0);
  },
  hide() { $('ov').classList.add('hidden'); },
  setMsg(text, kind, arrow) {
    const el = $('ov-msg');
    if (el._t !== text) { el.textContent = text; el._t = text; }
    el.className = 'ov-msg ' + (kind || 'info');
    const a = $('ov-arrow');
    if (arrow) { a.classList.remove('hidden'); a.style.transform = 'translate(-50%,-50%) rotate(' + arrow + 'deg)'; }
    else a.classList.add('hidden');
  },
  setMain(label, enabled, cls) {
    const b = $('ov-main'); b.textContent = label; b.disabled = !enabled;
    b.className = 'ov-main' + (cls ? ' ' + cls : '');
  },
  setStats(text) { const el = $('ov-stats'); if (!el.classList.contains('hidden')) el.textContent = text; },
  ring(sectors, progress, dir, closed) {
    const c = $('ov-ring'), g = c.getContext('2d'), W = c.width, cx = W / 2, cy = W / 2, r = W * 0.40;
    g.clearRect(0, 0, W, W);
    g.lineWidth = W * 0.085; g.lineCap = 'butt';
    for (let i = 0; i < 36; i++) {
      const a0 = -Math.PI / 2 + (dir < 0 ? -1 : 1) * (i / 36) * TAU, a1 = a0 + (dir < 0 ? -1 : 1) * (TAU / 36) * 0.86;
      const n = sectors[i];
      g.strokeStyle = n >= 4 ? '#3ddc84' : (n > 0 ? '#ffb020' : 'rgba(255,255,255,0.18)');
      g.beginPath(); if (dir < 0) g.arc(cx, cy, r, a1, a0); else g.arc(cx, cy, r, a0, a1); g.stroke();
    }
    // start mark
    g.fillStyle = '#ffd400';
    g.beginPath(); g.moveTo(cx, cy - r - W * 0.10); g.lineTo(cx - W * 0.05, cy - r - W * 0.17); g.lineTo(cx + W * 0.05, cy - r - W * 0.17); g.closePath(); g.fill();
    // current position
    const a = -Math.PI / 2 + (dir < 0 ? -1 : 1) * Math.min(progress, 1.2) * TAU;
    g.fillStyle = closed ? '#3ddc84' : '#ffffff';
    g.beginPath(); g.arc(cx + r * Math.cos(a), cy + r * Math.sin(a), W * 0.06, 0, TAU); g.fill();
    g.strokeStyle = '#111'; g.lineWidth = W * 0.015; g.stroke();
    $('ov-pct').textContent = Math.min(100, Math.round(progress * 100)) + '%';
  },
  ringText(text) {
    const c = $('ov-ring'), g = c.getContext('2d'), W = c.width;
    g.clearRect(0, 0, W, W);
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = W * 0.05;
    g.beginPath(); g.arc(W / 2, W / 2, W * 0.40, 0, TAU); g.stroke();
    $('ov-pct').textContent = text;
  },
  mini(m, path, cam, fwd, start) {
    const c = $('ov-mini'), g = c.getContext('2d'), W = c.width;
    g.clearRect(0, 0, W, W);
    g.fillStyle = 'rgba(10,12,14,0.55)'; g.fillRect(0, 0, W, W);
    if (!m) return;
    if (!this._mc || this._mc.width !== m.S) { this._mc = document.createElement('canvas'); this._mc.width = this._mc.height = m.S; }
    this._mc.getContext('2d').putImageData(new ImageData(m.rgba, m.S, m.S), 0, 0);
    g.imageSmoothingEnabled = false; g.drawImage(this._mc, 0, 0, W, W);
    const P = (x, z) => [(x - m.x0) / m.size * W, (z - m.z0) / m.size * W];
    if (path.length > 2) {
      g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2; g.beginPath();
      for (let i = 0; i < path.length; i += 2) { const p = P(path[i], path[i + 1]); if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }
      g.stroke();
    }
    if (start) { const p = P(start[0], start[2]); g.fillStyle = '#ffd400'; g.fillRect(p[0] - 1.5, p[1] - 12, 3, 12); g.beginPath(); g.moveTo(p[0] + 1.5, p[1] - 12); g.lineTo(p[0] + 10, p[1] - 9); g.lineTo(p[0] + 1.5, p[1] - 6); g.fill(); }
    if (cam) {
      const p = P(cam[0], cam[2]), a = Math.atan2(fwd[2], fwd[0]);
      g.save(); g.translate(p[0], p[1]); g.rotate(a);
      g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(11, 0); g.lineTo(-6, -6); g.lineTo(-3, 0); g.lineTo(-6, 6); g.closePath(); g.fill();
      g.restore();
    }
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = (W * 0.07) + 'px system-ui'; g.fillText('peak ' + m.maxH.toFixed(1) + ' m', 6, W - 8);
  }
};

class Capture {
  constructor(ui) { this.ui = ui; }
  makeWorker() {
    const src = $('engine-src').textContent;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return w;
  }
  begin(source, meta, opts) {
    this.source = source; this.meta = meta; this.opts = opts || {};
    this.worker = this.makeWorker();
    this.worker.onmessage = (e) => this.onWorker(e.data);
    this.worker.onerror = (e) => { console.error(e); this.ui.onError('Engine error: ' + (e.message || e)); };
    this.worker.postMessage({ type: 'reset', cfg: this.opts.cfg || {} });
    Object.assign(this, {
      busy: false, lastSubmit: -1, phase: 'warmup', t0: null, tracks: null, flip: 1, flipLocked: false,
      center: null, cum: 0, lastAng: null, progress: 0, dir: 0, sectors: new Uint16Array(36), startAng: 0,
      speed: 0, angSpeed: 0, lastC: null, lastT: null, lastF: null, closedNotified: false, stats: null, mini: null,
      path: [], lastPathT: -1, refA: null, refB: null, startC: null, groundYs: [], lowSince: null, trackingLost: false,
      lastGuide: -1, idleWaiters: [], resultWaiter: null, lastR: null, nearDist: null, finished: false, frames: 0,
      partial: !!(meta && meta.walk === 'partial'), walked: 0, nTop: 0
    });
    this.recorder = this.opts.record ? new Recorder() : null;
    Overlay.show(source.isSim);
    $('ov-ref').onclick = () => this.markRef();
    $('ov-topedge').onclick = () => this.markTop();
    $('ov-main').onclick = () => { if (this.phase === 'warmup') this.startWalk(); else if (this.phase === 'walk') this.finish(); };
    $('ov-close').onclick = () => this.abort();
  }
  fwd(R) { return [-R[2], -R[5], -R[8]]; }
  /* called once per displayed frame by the source; returns true if a frame should be processed */
  frame(info) {
    const t = info.t;
    if (this.t0 === null) this.t0 = t;
    this.trackingLost = !info.tracking;
    if (info.tracking && info.C) {
      const C = info.C, F = this.fwd(info.R);
      if (this.lastC) {
        const dt = Math.max(1e-3, t - this.lastT);
        const v = Math.hypot(C[0] - this.lastC[0], C[2] - this.lastC[2]) / dt;
        const dA = Math.acos(Math.max(-1, Math.min(1, F[0] * this.lastF[0] + F[1] * this.lastF[1] + F[2] * this.lastF[2]))) / dt * 180 / Math.PI;
        const k = Math.min(1, dt / 0.6);
        this.speed += (v - this.speed) * k; this.angSpeed += (dA - this.angSpeed) * k;
        if (this.phase === 'walk') { const st = Math.hypot(C[0] - this.lastC[0], C[2] - this.lastC[2]); if (st < 2) this.walked += st; }
      }
      this.lastC = C; this.lastT = t; this.lastF = F; this.lastR = info.R;
      if (this.phase === 'walk') {
        this.updateLoop(C);
        if (t - this.lastPathT > 0.2) { this.path.push(C[0], C[2]); this.lastPathT = t; }
      }
      if (info.nearDist !== undefined) this.nearDist = info.nearDist;
    }
    if (t - this.lastGuide > 0.12) { this.lastGuide = t; this.guide(t); }
    return info.tracking && !this.busy && (t - this.lastSubmit) >= 0.062 && this.phase !== 'finishing' && this.phase !== 'done';
  }
  submit(fr) {
    this.busy = true; this.lastSubmit = fr.t; this.frames++;
    const msg = { type: 'frame', t: fr.t, R: fr.R, C: fr.C, intr: fr.intr, progress: this.progress, hits: fr.hits || null };
    const tr = [];
    if (fr.gray) { msg.gray = fr.gray.buffer; }
    if (fr.depth) { msg.depth = fr.depth; }
    if (this.recorder) this.recorder.add(fr, this.progress);
    if (msg.gray) tr.push(msg.gray);
    if (msg.depth) tr.push(msg.depth.data.buffer);
    this.worker.postMessage(msg, tr);
  }
  waitIdle() { return this.busy ? new Promise(r => this.idleWaiters.push(r)) : Promise.resolve(); }
  onWorker(m) {
    if (m.type === 'tracks') {
      this.busy = false;
      this.tracks = m.tracks; this.flip = m.flipMode; this.flipLocked = m.flipLocked; this.stats = m.stats;
      if (m.newPts && m.newPts.length && this.source.dots) this.source.dots.addMapPoints(m.newPts);
      if (m.mini) {
        this.mini = m.mini;
        if (m.mini.centerEst && this.phase === 'walk') this.refineCenter(m.mini.centerEst);
        if (this.mini.groundY !== undefined) this.groundY = this.mini.groundY;
        Overlay.mini(this.mini, this.path, this.lastC, this.lastF || [0, 0, -1], this.startC);
      }
      const w = this.idleWaiters; this.idleWaiters = []; w.forEach(f => f());
    } else if (m.type === 'result') {
      if (this.resultWaiter) this.resultWaiter(m);
      this.onResult(m);
    } else if (m.type === 'error') {
      console.error('engine:', m.message);
      this.busy = false;
      const w = this.idleWaiters; this.idleWaiters = []; w.forEach(f => f());
    }
  }
  updateLoop(C) {
    const a = Math.atan2(C[2] - this.center.z, C[0] - this.center.x);
    if (this.lastAng === null) { this.lastAng = a; this.startAng = a; return; }
    let d = a - this.lastAng;
    while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU;
    this.lastAng = a;
    if (Math.abs(d) > 0.6) return;
    this.cum += d;
    this.progress = Math.abs(this.cum) / TAU;
    if (Math.abs(this.cum) > 0.15) this.dir = Math.sign(this.cum);
    const rel = (((a - this.startAng) * (this.dir || 1)) % TAU + TAU) % TAU;
    this.sectors[Math.floor(rel / TAU * 36) % 36]++;
  }
  refineCenter(est) {
    const dx = est[0] - this.center.x, dz = est[1] - this.center.z;
    if (Math.hypot(dx, dz) > 25) return;
    this.center = { x: this.center.x + 0.1 * dx, z: this.center.z + 0.1 * dz };
    if (this.lastC) this.lastAng = Math.atan2(this.lastC[2] - this.center.z, this.lastC[0] - this.center.x);
  }
  centerPoint() {
    const h = this.source.centerHit && this.source.centerHit();
    if (h && h.p) return h.p;
    const C = this.lastC || [0, 0, 0], F = this.lastF || [0, 0, -1], l = Math.hypot(F[0], F[2]) || 1;
    return [C[0] + F[0] / l * 6, C[1] - 1.2, C[2] + F[2] / l * 6];
  }
  startWalk() {
    if (this.phase !== 'warmup' || !this.lastC) return;
    const c = this.centerPoint();
    this.center = { x: c[0], z: c[2] };
    this.worker.postMessage({ type: 'start', center: c, t: this.lastT });
    if (this.recorder) this.recorder.event('start', { center: c, t: this.lastT });
    this.phase = 'walk'; this.startT = this.lastT; this.startC = this.lastC.slice();
    this.cum = 0; this.lastAng = null; this.progress = 0;
    Overlay.setMain('FINISH', true);
    $('ov-ref').classList.remove('hidden');
    $('ov-topedge').classList.remove('hidden');
    if (navigator.vibrate) navigator.vibrate(40);
  }
  markRef() {
    const h = this.source.centerHit && this.source.centerHit();
    if (!h || !h.p) { Overlay.setMsg('Aim the centre dot at the marker on the ground and try again', 'warn', 0); return; }
    if (!this.refA || this.refB) { this.refA = h.p.slice(); this.refB = null; $('ov-ref').textContent = 'Mark B'; }
    else { this.refB = h.p.slice(); $('ov-ref').textContent = 'A–B ' + Math.hypot(this.refA[0] - this.refB[0], this.refA[1] - this.refB[1], this.refA[2] - this.refB[2]).toFixed(2) + ' m'; }
    if (navigator.vibrate) navigator.vibrate(25);
  }
  /* "Top edge": the sight line through the centre dot, aimed at the pile's skyline */
  markTop(C, D) {
    if (this.phase !== 'walk') return;
    if (!C || !D) { const r = this.source.centerRay && this.source.centerRay(); if (r) { C = r.C; D = r.D; } else { C = this.lastC; D = this.lastF; } }
    if (!C || !D) return;
    this.worker.postMessage({ type: 'top', C, D });
    if (this.recorder) this.recorder.event('top', { C, D, t: this.lastT });
    this.nTop++;
    $('ov-topedge').textContent = 'Top edge ✓ ' + this.nTop;
    if (!this.source.isTest) { Overlay.setMsg('Top edge marked (' + this.nTop + '). Mark it again from one or two other places along the pile', 'ok', 0); this.lastGuide = this.lastT + 2.5; }
    if (navigator.vibrate) navigator.vibrate(25);
  }
  guide(t) {
    let msg = '', kind = 'info', arrow = 0;
    const st = this.stats;
    const lowTracks = st && st.nTracks < 40;
    if (lowTracks) { if (this.lowSince === null) this.lowSince = t; } else this.lowSince = null;
    if (this.trackingLost) { msg = 'Tracking lost — hold still and point at the pile'; kind = 'warn'; }
    else if (this.phase === 'warmup') {
      if (t - this.t0 < 2.5) msg = 'Move the phone gently left and right to start tracking';
      else { msg = 'Aim the centre dot at the middle of the pile, then tap START'; kind = 'go'; Overlay.setMain('START', true, 'go'); }
    } else if (this.phase === 'walk') {
      const p = this.progress;
      if (this.speed > 1.15) { msg = 'Slow down — walk slowly'; kind = 'warn'; }
      else if (this.angSpeed > 75) { msg = 'Turn the phone more slowly'; kind = 'warn'; }
      else if (this.lowSince !== null && t - this.lowSince > 1.2) { msg = 'Not enough detail — keep the pile in view'; kind = 'warn'; }
      else if (this.nearDist !== null && this.nearDist < 1.3) { msg = 'Step back — keep the whole pile and some ground in view'; kind = 'warn'; }
      else if (this.meta && this.meta.top === 'flat' && !this.meta.topHeight && this.nTop < 2 && t - this.startT > 6 && (t % 12) < 4) {
        msg = 'Aim the centre dot at the top edge of the pile and tap Top edge (' + this.nTop + ' of 2–3)'; kind = 'go';
      } else if (this.partial) {
        if (t - this.startT < 6) msg = 'Walk slowly along the sides you can reach — a long side and, if possible, one end';
        else msg = 'Keep the whole height and some ground in view. Tap FINISH when you have walked the sides you can reach';
      } else if (p >= 1.04) {
        msg = 'Loop closed ✓  Tap FINISH'; kind = 'ok';
        if (!this.closedNotified) { this.closedNotified = true; if (navigator.vibrate) navigator.vibrate([60, 60, 60]); Overlay.setMain('FINISH', true, 'go'); }
      } else if (p >= 0.86) {
        msg = 'Almost back at the start — slow down'; kind = 'slow';
        if (this.startC && this.lastC && this.lastF) {
          const dx = this.startC[0] - this.lastC[0], dz = this.startC[2] - this.lastC[2];
          const fx = this.lastF[0], fz = this.lastF[2];
          arrow = Math.atan2(fx * dz - fz * dx, fx * dx + fz * dz) * 180 / Math.PI - 90;
        }
      } else if (t - this.startT < 5) msg = 'Walk slowly around the pile. Keep the whole pile and some ground in view';
      else msg = 'Keep walking around the pile';
    }
    Overlay.setMsg(msg, kind, arrow);
    if (this.partial && this.phase === 'walk') Overlay.ringText(Math.round(this.walked) + ' m');
    else if (this.phase === 'walk' || this.phase === 'warmup') Overlay.ring(this.sectors, this.progress, this.dir, this.progress >= 1.04);
    if (st) Overlay.setStats(`tracked ${st.nTracks} · locked ${st.nGreen} · 3D pts ${st.nPts} · depth frames ${st.nDepthFrames} · ${st.ms.toFixed(0)} ms/frame · image ${this.flipLocked ? 'ok' : 'checking'}(${this.flip})` +
      ` · ${this.speed.toFixed(2)} m/s` + (this.source.featInfo ? ' · ' + this.source.featInfo : ''));
  }
  /* in-overlay "tap again to confirm" (browser dialogs may not show during AR) */
  armed(key, label, msg) {
    const now = performance.now();
    if (this._arm && this._arm.key === key && now - this._arm.t < 5000) { this._arm = null; return true; }
    this._arm = { key, t: now };
    if (label) Overlay.setMain(label, true, 'warn');
    Overlay.setMsg(msg, 'warn', 0); this.lastGuide = this.lastT + 2.5;
    setTimeout(() => { if (this._arm && this._arm.key === key && this.phase === 'walk') { this._arm = null; Overlay.setMain('FINISH', true, this.closedNotified ? 'go' : ''); } }, 5100);
    return false;
  }
  finish() {
    if (this.phase !== 'walk') return;
    const early = this.partial ? this.walked < 5 : this.progress < 0.9;
    if (early && !this.source.isTest && !this.armed('finish', 'FINISH NOW?', this.partial ? 'You have only walked ' + Math.round(this.walked) + ' m — tap FINISH NOW? again to finish anyway' : 'Only ' + Math.round(this.progress * 100) + '% of the way round — tap FINISH NOW? again to finish anyway')) return;
    this.phase = 'finishing';
    Busy.show('Calculating volume…');
    const m = this.meta || {};
    const send = () => this.worker.postMessage({ type: 'finish', opts: { progress: this.progress, walk: m.walk || 'full', top: m.top || 'peaked', baseWidth: m.baseWidth || 0, topHeight: m.topHeight || 0 } });
    if (this.busy) this.waitIdle().then(send); else send();
    if (this.source.stop) this.source.stop();
  }
  finishAndWait() { return new Promise(res => { this.resultWaiter = res; this.finish(); }); }
  onResult(r) {
    this.phase = 'done';
    Busy.hide(); Overlay.hide();
    try { this.worker.terminate(); } catch (e) { }
    const extra = {
      meta: this.meta, refA: this.refA, refB: this.refB, progress: this.progress,
      truth: this.source.truthVolume || null, source: this.source.isSim ? 'demo' : 'ar',
      features: this.source.feat || null, recorder: this.recorder
    };
    this.ui.onResult(r, extra);
  }
  abortExternal() {
    // AR session closed by the system or the back button
    this.phase = 'done';
    try { this.worker.terminate(); } catch (e) { }
    Overlay.hide(); Busy.hide();
    this.ui.onExit('The AR session was closed.');
  }
  abort() {
    if (this.phase === 'walk' && !this.armed('abort', null, 'Tap ✕ again to cancel this measurement')) return;
    this.phase = 'done';
    try { this.worker.terminate(); } catch (e) { }
    if (this.source.stop) this.source.stop();
    Overlay.hide(); Busy.hide();
    this.ui.onExit();
  }
}

const Busy = {
  show(msg) { $('busy-msg').textContent = msg; $('busy').classList.remove('hidden'); },
  hide() { $('busy').classList.add('hidden'); }
};

/* ---------- demo runner (interactive) and deterministic test runner ---------- */
const SimRunner = {
  interactive(capture, sim) {
    sim.isSim = true; sim.running = true;
    let simT = 0, last = performance.now(), lastHit = -1;
    sim.centerHit = () => sim._tp ? sim.hitAt(sim._tp, 0.5, 0.5) : null;
    sim.stop = () => { sim.running = false; $('sim-stage').classList.add('hidden'); };
    const stage = $('sim-stage'); stage.classList.remove('hidden');
    const resize = () => {
      const c = sim.canvas, r = stage.getBoundingClientRect(), a = sim.o.aspect;
      let w = r.width, h = r.height; if (w / h > a) w = h * a; else h = w / a;
      c.style.width = w + 'px'; c.style.height = h + 'px';
      const d = Math.min(2, window.devicePixelRatio || 1); c.width = Math.round(w * d); c.height = Math.round(h * d);
    };
    resize(); window.addEventListener('resize', resize);
    const loop = (now) => {
      if (!sim.running) { window.removeEventListener('resize', resize); return; }
      const dt = Math.min(0.05, (now - last) / 1000) * sim.o.speed; last = now; simT += dt;
      const tp = sim.truePose(simT); sim._tp = tp;
      const rp = sim.reportedPose(tp, simT);
      const ch = sim.hitAt(tp, 0.5, 0.5);
      const want = capture.frame({ t: simT, R: rp.R, C: rp.C, tracking: true, nearDist: ch ? ch.dist : null });
      if (capture.phase === 'warmup' && simT > 2.2) capture.startWalk();
      if (want) {
        const gray = sim.grabGray(tp);
        const depth = capture.phase === 'walk' && sim.o.depth ? sim.grabDepth(tp) : null;
        let hits = null;
        if (simT - lastHit > 0.25) { lastHit = simT; const h = sim.hitAt(tp, 0.5, 0.86); if (h && h.ground) hits = [h.p]; }
        capture.submit({ t: simT, R: rp.R, C: rp.C, intr: sim.intrinsics(), gray, depth, hits });
      }
      if (capture.phase === 'walk' && tp.done) { capture.finish(); return; }
      const vpRep = sim.viewMatrices(rp.R, rp.C).vp;
      sim.display(tp, capture.flipLocked ? capture.tracks : capture.tracks, capture.flip, vpRep);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  },
  async test(capture, sim, log) {
    sim.isSim = true; sim.isTest = true;
    sim.centerHit = () => sim._tp ? sim.hitAt(sim._tp, 0.5, 0.5) : null;
    const fps = 15; let f = 0, lastHit = -1;
    const t0 = performance.now();
    const tapAt = [0.15, 0.35, 0.8, 0.5, 0.65].slice(0, sim.o.topTaps || 0).sort((a, b) => a - b);
    for (;;) {
      const t = f / fps; f++;
      const tp = sim.truePose(t); sim._tp = tp;
      const rp = sim.reportedPose(tp, t);
      capture.frame({ t, R: rp.R, C: rp.C, tracking: true });
      capture.busy = false;
      if (capture.phase === 'warmup' && t >= 2.0) capture.startWalk();
      if (capture.phase === 'walk' && tapAt.length && tp.prog >= tapAt[0]) { tapAt.shift(); const r = sim.topEdgeRay(tp); if (r) capture.markTop(rp.C, r); }
      const gray = sim.o.camera ? sim.grabGray(tp) : null;
      const depth = capture.phase === 'walk' && sim.o.depth ? sim.grabDepth(tp) : null;
      let hits = null;
      if (t - lastHit > 0.25) { lastHit = t; const h = sim.hitAt(tp, 0.5, 0.86); if (h && h.ground) hits = [h.p]; }
      capture.submit({ t, R: rp.R, C: rp.C, intr: sim.intrinsics(), gray, depth, hits });
      await capture.waitIdle();
      if (log && f % 150 === 0) log(`t=${t.toFixed(1)} prog=${capture.progress.toFixed(2)} ` + JSON.stringify(capture.stats) + ` ${((performance.now() - t0) / 1000).toFixed(0)}s`);
      if (capture.phase === 'walk' && tp.done) break;
    }
    return await capture.finishAndWait();
  }
};
