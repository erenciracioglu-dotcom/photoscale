/* ---------- app: screens, materials, results, history ---------- */
const APP_VERSION = '1.1.0';
const PRESETS = [
  { name: 'Gravel (loose)', d: 1.60 }, { name: 'Sand (dry)', d: 1.60 }, { name: 'Crushed stone', d: 1.55 },
  { name: 'Limestone (crushed)', d: 1.55 }, { name: 'Soil / earth (loose)', d: 1.30 },
  { name: 'Coal — loose', d: 0.80 }, { name: 'Coal — stockpiled', d: 0.90 }, { name: 'Lignite', d: 0.75 },
  { name: 'Fly ash (dry)', d: 0.85 }, { name: 'Bottom ash', d: 0.95 }, { name: 'Gypsum (FGD, moist)', d: 1.10 }
];
const Store = {
  get(k, d) { try { const v = localStorage.getItem('photoscale.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('photoscale.' + k, JSON.stringify(v)); return true; } catch (e) { return false; } }
};
const DB = {
  db: null,
  open() {
    return new Promise((res) => {
      try {
        const r = indexedDB.open('photoscale', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('results', { keyPath: 'id' });
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => res(null);
      } catch (e) { res(null); }
    });
  },
  async tx(mode, fn) {
    const db = this.db || await this.open(); if (!db) return null;
    return new Promise((res) => {
      try {
        const t = db.transaction('results', mode), st = t.objectStore('results'), q = fn(st);
        t.oncomplete = () => res(q && q.result !== undefined ? q.result : true); t.onerror = () => res(null);
      } catch (e) { res(null); }
    });
  },
  put(o) { return this.tx('readwrite', (s) => s.put(o)); },
  get(id) { return this.tx('readonly', (s) => s.get(id)); },
  del(id) { return this.tx('readwrite', (s) => s.delete(id)); }
};
const fmt = {
  n(v, d) { return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); },
  big(v) { return v >= 1000 ? fmt.n(v, 0) : (v >= 100 ? fmt.n(v, 1) : fmt.n(v, 2)); },
  dur(s) { s = Math.round(s); return s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60) + ' s' : s + ' s'; },
  date(iso) { const d = new Date(iso); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
};

const App = {
  cur: null, viewer: null, arOk: false,
  init() {
    $('ver').textContent = APP_VERSION;
    document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => this.show(b.dataset.go)));
    $('go-home').onclick = () => this.show('home');
    this.fillMaterials();
    const last = Store.get('last', null);
    $('in-name').value = this.defaultName();
    if (last) { this.selectMaterial(last.material, last.density); }
    $('in-mat').onchange = () => { const o = $('in-mat').selectedOptions[0]; if (o && o.dataset.d) $('in-den').value = o.dataset.d; };
    this.initSetup();
    $('btn-ar').onclick = () => this.startAR();
    $('btn-demo').onclick = () => this.startDemo();
    // result screen
    $('v-3d').onclick = () => { this.viewer && this.viewer.setTop(false); $('v-3d').classList.add('on'); $('v-top').classList.remove('on'); };
    $('v-top').onclick = () => { this.viewer && this.viewer.setTop(true); $('v-top').classList.add('on'); $('v-3d').classList.remove('on'); };
    $('v-pts').onclick = () => { const on = !$('v-pts').classList.contains('on'); $('v-pts').classList.toggle('on', on); this.viewer && this.viewer.setPoints(on); };
    $('res-den').onclick = () => this.editDensity();
    $('tape-apply').onclick = () => this.applyTape();
    $('cal-go').onclick = () => this.calibrate();
    $('res-save').onclick = () => this.save();
    $('res-share').onclick = () => this.share();
    $('res-json').onclick = () => this.exportJSON();
    $('res-raw').onclick = () => this.downloadRaw();
    $('res-new').onclick = () => { $('in-name').value = this.defaultName(); this.show('home'); };
    $('hist-csv').onclick = () => this.exportCSV();
    // settings
    $('set-record').checked = Store.get('record', false); $('set-record').onchange = (e) => Store.set('record', e.target.checked);
    $('set-debug').checked = Store.get('debug', false); $('set-debug').onchange = (e) => Store.set('debug', e.target.checked);
    $('set-speed').value = String(Store.get('speed', 2)); $('set-speed').onchange = (e) => Store.set('speed', +e.target.value);
    $('mat-add').onclick = () => this.addMaterial($('mat-name').value, $('mat-den').value);
    $('ov-stats').classList.toggle('hidden', !Store.get('debug', false));
    this.updateHistCount();
    this.checkAR();
    window.addEventListener('hashchange', () => this.route());
    if (location.hash === '#demo') setTimeout(() => this.startDemo(), 300);
  },
  route() { const h = location.hash.replace('#', ''); if (['home', 'history', 'guide', 'settings'].includes(h)) this.show(h); },
  show(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'scr-' + name));
    if (name === 'history') this.renderHistory();
    if (name === 'settings') this.renderMaterials();
    window.scrollTo(0, 0);
    if (name === 'result' && this.viewer) setTimeout(() => this.viewer.render(), 30);
  },
  toast(msg, kind, ms) {
    const t = $('toast'); t.textContent = msg; t.className = 'toast ' + (kind || '');
    clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.add('hidden'), ms || 4200);
  },
  defaultName() { const d = new Date(); return 'Pile ' + d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); },
  /* materials */
  allMaterials() { return PRESETS.map(p => Object.assign({ preset: true }, p)).concat(Store.get('materials', [])); },
  fillMaterials() {
    const sel = $('in-mat'), mine = Store.get('materials', []);
    sel.innerHTML = '';
    const add = (label, list) => {
      if (!list.length) return;
      const g = document.createElement('optgroup'); g.label = label;
      for (const m of list) { const o = document.createElement('option'); o.textContent = m.name + ' · ' + m.d.toFixed(2); o.value = m.name; o.dataset.d = m.d; g.appendChild(o); }
      sel.appendChild(g);
    };
    add('My materials', mine); add('Typical values', PRESETS);
    const o = document.createElement('option'); o.textContent = 'Other (type density)'; o.value = '__other'; sel.appendChild(o);
    if (!$('in-den').value) { sel.value = PRESETS[0].name; $('in-den').value = PRESETS[0].d; }
  },
  selectMaterial(name, d) {
    const sel = $('in-mat');
    if ([...sel.options].some(o => o.value === name)) sel.value = name; else sel.value = '__other';
    $('in-den').value = d;
  },
  addMaterial(name, d) {
    name = (name || '').trim(); d = parseFloat(d);
    if (!name || !(d > 0.05 && d < 5)) { this.toast('Enter a name and a density between 0.05 and 5 t/m³', 'bad'); return false; }
    const mine = Store.get('materials', []).filter(m => m.name !== name);
    mine.unshift({ name, d: Math.round(d * 1000) / 1000 });
    Store.set('materials', mine); this.fillMaterials(); this.renderMaterials();
    $('mat-name').value = ''; $('mat-den').value = '';
    this.toast('Saved material “' + name + '”', 'ok');
    return true;
  },
  renderMaterials() {
    const box = $('set-mats'), mine = Store.get('materials', []);
    box.innerHTML = mine.length ? '' : '<p class="muted">No materials of your own yet. Add one below, or calibrate from a weighed pile on a result page.</p>';
    mine.forEach((m, i) => {
      const r = document.createElement('div'); r.className = 'mat';
      r.innerHTML = `<span>${esc(m.name)} <b>${m.d.toFixed(3)} t/m³</b></span>`;
      const b = document.createElement('button'); b.textContent = 'Delete';
      b.onclick = () => { const l = Store.get('materials', []); l.splice(i, 1); Store.set('materials', l); this.fillMaterials(); this.renderMaterials(); };
      r.appendChild(b); box.appendChild(r);
    });
  },
  /* pile setup: walk (full/partial), top (peaked/flat), size (grid), base width */
  initSetup() {
    this.setup = Object.assign({ walk: 'full', top: 'peaked', size: 'small', far: 'mirror', wallh: '1.5' }, Store.get('setup', {}));
    delete this.setup.width; // base width and height belong to one pile: kept for this session only
    const bind = (id, key) => {
      $(id).querySelectorAll('.seg').forEach(b => b.addEventListener('click', () => { this.setup[key] = b.dataset.v; this.renderSetup(); }));
    };
    bind('opt-walk', 'walk'); bind('opt-top', 'top'); bind('opt-size', 'size'); bind('opt-far', 'far');
    $('in-wallh').value = this.setup.wallh || '1.5';
    $('in-wallh').oninput = () => { this.setup.wallh = $('in-wallh').value; Store.set('setup', this.setup); };
    this.renderSetup();
  },
  renderSetup() {
    const S = this.setup;
    for (const [id, key] of [['opt-walk', 'walk'], ['opt-top', 'top'], ['opt-size', 'size'], ['opt-far', 'far']])
      $(id).querySelectorAll('.seg').forEach(b => b.classList.toggle('on', b.dataset.v === S[key]));
    $('help-walk').textContent = S.walk === 'partial'
      ? 'Walk the full length of one long side, and one end if you can. Then choose below what is on the sides you can\'t reach.'
      : 'Walk one full loop around the pile, a few steps past where you started.';
    $('help-top').textContent = (S.top === 'flat'
      ? 'Where the top can\'t be seen (tall piles), it is taken as flat at the height of its edge.'
      : 'Where the top can\'t be seen, the slopes are continued into a rounded peak (cones, ridges).') +
      ' Piles over about 5 m high: tap Top edge during the walk, or enter the height below.';
    const walls = S.walk === 'partial' && S.far === 'wall';
    $('row-far').classList.toggle('hidden', S.walk !== 'partial');
    $('help-far').textContent = walls
      ? 'The pile leans on walls on the sides you can\'t walk. Tap Wall at each wall during the walk; the hidden part is built out to the walls.'
      : 'The sides you can\'t walk are taken as a mirror image of the walked ones (a free-standing pile).';
    $('row-wallh').classList.toggle('hidden', !walls);
    $('row-width').classList.toggle('hidden', S.walk !== 'partial' || walls);
    Store.set('setup', S);
  },
  setupText(m) {
    return (m.walk === 'partial' ? (m.far === 'wall' ? 'partial walk (against walls)' : 'partial walk (mirrored)') : 'full loop') + ' · ' + (m.top === 'flat' ? 'flat top' : 'rounded top');
  },
  readForm() {
    const sel = $('in-mat'), d = parseFloat($('in-den').value);
    const material = sel.value === '__other' ? 'Custom' : sel.value;
    const S = this.setup || { walk: 'full', top: 'peaked', size: 'small' }, w = parseFloat($('in-width').value), ht = parseFloat($('in-height').value);
    const meta = { name: ($('in-name').value || this.defaultName()).trim(), material, density: d > 0 ? d : 1,
      walk: S.walk, top: S.top, size: S.size, baseWidth: S.walk === 'partial' && S.far !== 'wall' && w > 0 ? w : 0, topHeight: ht > 0 ? ht : 0,
      far: S.walk === 'partial' && S.far === 'wall' ? 'wall' : 'mirror', wallHeight: parseFloat(S.wallh) > 0 ? parseFloat(S.wallh) : 1.5 };
    Store.set('last', { material: sel.value, density: meta.density });
    return meta;
  },
  /* capture */
  async checkAR() {
    const st = $('ar-status');
    if (!window.isSecureContext) { st.textContent = 'AR needs a secure (https) page.'; st.className = 'status bad'; return; }
    this.arOk = await XRSource.supported();
    if (this.arOk) { st.textContent = '✓ AR is available on this device.'; st.className = 'status ok'; }
    else { st.textContent = 'AR is not available here. It needs Chrome on an ARCore Android phone — you can still try the demo.'; st.className = 'status bad'; }
  },
  hooks() {
    return {
      onResult: (r, extra) => this.onResult(r, extra),
      onError: (m) => this.toast(m, 'bad', 7000),
      onExit: (m) => { if (m) this.toast(m); this.show('home'); }
    };
  },
  async startAR() {
    if (!this.arOk) { this.toast('AR is not available on this device or browser. Try the demo instead.', 'bad', 6000); return; }
    const meta = this.readForm();
    const src = new XRSource();
    const cap = new Capture(this.hooks());
    const sz = PILE_SIZES[meta.size] || PILE_SIZES.small;
    cap.begin(src, meta, { record: Store.get('record', false), cfg: { cellSize: sz.cellSize, gridN: sz.gridN } });
    $('ov-stats').classList.toggle('hidden', !Store.get('debug', false));
    try { await src.start(cap); }
    catch (e) {
      cap.phase = 'done'; try { cap.worker.terminate(); } catch (_) { }
      Overlay.hide();
      this.toast('Could not start AR: ' + (e && e.message || e), 'bad', 9000);
    }
  },
  startDemo() {
    const meta = this.readForm();
    // the demo follows the chosen setup: round heap, long flat-topped pile, or a pile walked on two sides
    let sc = { kind: 'demo', path: 'circle', name: 'Demo heap (simulated)' };
    if (meta.walk === 'partial' && meta.far === 'wall') sc = meta.top === 'flat' ? { kind: 'corner', path: 'Lw', name: 'Demo: flat-topped pile in a walled corner', walls: true } : { kind: 'cornerpk', path: 'Lw', name: 'Demo: ridge pile in a walled corner', walls: true };
    else if (meta.walk === 'partial') sc = meta.top === 'flat' ? { kind: 'yard', path: 'L', name: 'Demo: flat-topped pile, 2 sides walked' } : { kind: 'yardpk', path: 'L', name: 'Demo: ridge pile, 2 sides walked' };
    else if (meta.top === 'flat') sc = { kind: 'yard', path: 'rect', name: 'Demo: flat-topped pile, full loop' };
    meta.name = sc.name;
    if (sc.kind !== 'demo' && meta.size === 'small') meta.size = 'medium';
    meta.baseWidth = 0; meta.topHeight = 0; if (sc.walls) meta.wallHeight = 1.5;
    const sim = new SimSource({ kind: sc.kind, path: sc.path, speed: Store.get('speed', 2), topTaps: meta.top === 'flat' ? 3 : 0, wallTaps: !!sc.walls });
    try { sim.init($('sim-canvas')); } catch (e) { this.toast(e.message, 'bad'); return; }
    const cap = new Capture(this.hooks());
    const szd = PILE_SIZES[meta.size] || PILE_SIZES.small;
    cap.begin(sim, meta, { record: false, cfg: { cellSize: szd.cellSize, gridN: szd.gridN } });
    $('ov-stats').classList.toggle('hidden', !Store.get('debug', false));
    SimRunner.interactive(cap, sim);
  },
  /* results */
  onResult(r, extra) {
    if (r.error) { this.toast(r.error, 'bad', 9000); this.show('home'); return; }
    const m = extra.meta;
    this.cur = { id: 'm' + Date.now(), r, extra, name: m.name, material: m.material, density: m.density, date: new Date().toISOString(), scale: 1, tapeAR: null, tape: null, saved: false, walk: r.walk, top: r.top };
    if (extra.refA && extra.refB) this.cur.tapeAR = Math.hypot(extra.refA[0] - extra.refB[0], extra.refA[1] - extra.refB[1], extra.refA[2] - extra.refB[2]);
    this.openResult();
  },
  openResult() {
    const c = this.cur;
    this.show('result');
    if (!this.viewer) { try { this.viewer = new PileViewer($('res-3d')); } catch (e) { console.warn(e); } }
    if (this.viewer) { this.viewer.load(c.r); $('v-3d').classList.add('on'); $('v-top').classList.remove('on'); $('v-pts').classList.remove('on'); this.viewer.top = false; this.viewer.showPts = false; }
    $('res-tape').classList.toggle('hidden', !c.tapeAR);
    if (c.tapeAR) { $('tape-ar').textContent = fmt.n(c.tapeAR, 3) + ' m'; $('tape-in').value = c.tape || ''; $('tape-out').textContent = c.tape ? this.tapeText() : ''; }
    $('cal-in').value = ''; $('cal-out').textContent = '';
    $('res-raw').classList.toggle('hidden', !(c.extra && c.extra.recorder));
    $('res-save').textContent = c.saved ? 'Update saved measurement' : 'Save to history';
    this.renderResult();
    setTimeout(() => this.viewer && this.viewer.render(), 50);
  },
  numbers() {
    const c = this.cur, r = c.r, f = c.scale, f3 = f * f * f, V = r.volume * f3;
    const p = r.parts, scalePart = c.tape ? 3 * 0.003 * V : p.scale * f3;
    const parts = { scale: scalePart, fill: p.fill * f3, mirror: (p.mirror || 0) * f3, base: p.base * f3, loop: p.loop * f3 };
    const sig = Math.sqrt(parts.scale ** 2 + parts.fill ** 2 + parts.mirror ** 2 + parts.base ** 2 + parts.loop ** 2);
    const lo = Math.max(0, V - 1.5 * sig), hi = V + 1.5 * sig;
    return { V, lo, hi, pm: V > 0 ? 1.5 * sig / V * 100 : 0, parts, f, T: V * c.density, Tlo: lo * c.density, Thi: hi * c.density };
  },
  renderResult() {
    const c = this.cur, r = c.r, N = this.numbers(), f = N.f;
    $('res-title').textContent = c.name;
    $('res-sub').textContent = fmt.date(c.date) + ' · ' + c.material + ' · ' + this.setupText({ walk: r.walk, top: r.top, far: r.far }) + (c.extra && c.extra.source === 'demo' ? ' · demo' : '');
    $('res-vol').textContent = fmt.big(N.V);
    $('res-vol-range').textContent = 'likely ' + fmt.big(N.lo) + '–' + fmt.big(N.hi) + ' m³ (±' + N.pm.toFixed(0) + '%)';
    $('res-ton').textContent = fmt.big(N.T);
    $('res-den').textContent = 'at ' + c.density.toFixed(2) + ' t/m³ ✎';
    const q = $('res-quality');
    // grade the capture itself (loop, coverage, ground, drift); the ± range is shown separately
    const nw = r.warnings.length;
    // coverage only counts against a full loop with a rounded top; partial walks and flat tops expect unseen parts
    const covOk = (r.walk === 'partial' || r.top === 'flat') ? true : r.coverage >= 0.85;
    const grade = r.incomplete ? ['poor', 'Incomplete — see notes'] : (nw === 0 && covOk ? ['good', 'Good capture'] : (nw <= 1 ? ['fair', 'Fair — see notes'] : ['poor', 'Check the notes']));
    const lg = $('res-legend');
    if (lg) lg.innerHTML = '<span><i class="lg seen"></i>measured</span>' + ((r.mirroredVolume || 0) > 0 ? '<span><i class="lg mir"></i>mirrored</span>' : '') + (r.filledVolume > 0.005 * r.volume ? '<span><i class="lg fill"></i>filled (' + (r.top === 'flat' ? 'flat' : 'rounded') + ' top)</span>' : '') + '<span><i class="lg path"></i>your path</span>';
    q.className = 'qbadge ' + grade[0]; q.textContent = grade[1];
    const tr = $('res-truth');
    if (c.extra && c.extra.truth) {
      const e = (N.V - c.extra.truth) / c.extra.truth * 100;
      tr.classList.remove('hidden');
      tr.innerHTML = `Demo check: the simulated pile's true volume is <b>${fmt.n(c.extra.truth, 2)} m³</b>, so this measurement is off by <b>${e >= 0 ? '+' : ''}${e.toFixed(1)}%</b>.`;
    } else tr.classList.add('hidden');
    const stats = [
      [fmt.n(r.footprint * f * f, 1) + ' m²', 'footprint'], [fmt.n(r.maxHeight * f, 2) + ' m', 'peak height'],
      [fmt.n(r.length * f, 1) + ' × ' + fmt.n(r.width * f, 1) + ' m', 'length × width'],
      [Math.round(r.coverage * 100) + '%', 'surface seen' + (r.mirrorShare ? ' (+' + Math.round(r.mirrorShare * 100) + '% mirrored)' : '')],
      r.walk === 'partial' ? [Math.round(r.walked || 0) + ' m', 'walked'] : [r.progress >= 0.98 ? 'Yes ✓' : Math.round(r.progress * 100) + '%', 'loop closed'],
      [fmt.dur(r.duration), 'walk time']
    ];
    $('res-stats').innerHTML = stats.map(s => `<div class="stat"><b>${s[0]}</b><span>${s[1]}</span></div>`).join('');
    const W = $('res-warn'); W.innerHTML = '';
    for (const w of (r.notes || [])) { const li = document.createElement('li'); li.className = 'note'; li.textContent = w; W.appendChild(li); }
    for (const w of r.warnings) { const li = document.createElement('li'); li.textContent = w; W.appendChild(li); }
    if (!r.warnings.length) { const li = document.createElement('li'); li.className = 'ok'; li.textContent = (r.walk === 'partial' ? 'No problems detected: the walked sides were well covered and the ground level is consistent.' : 'No problems detected: the loop was closed, the surface was well covered and the ground level is consistent.'); W.appendChild(li); }
    if (!c.tape && c.tapeAR === null && N.pm > 4) {
      const li = document.createElement('li'); li.className = 'tip'; li.textContent = 'Tip: most of the ± range is the phone\'s own sense of distance. Mark two taped points (Mark A / Mark B) during the walk to shrink it to about ±2–3%.'; W.appendChild(li);
    }
    const P = N.parts, row = (a, b, v) => `<div class="why-row"><span><b>${a}</b><br><span class="muted">${b}</span></span><b>±${fmt.big(1.5 * v)} m³</b></div>`;
    $('why-body').innerHTML =
      `<p class="muted">The range shown is where the true volume most likely lies. It adds up these sources of error (each shown at the same confidence):</p>` +
      row('Phone scale', c.tape ? 'Corrected with your tape check.' : 'The phone\'s sense of distance can be off by 1–2%; volume triples that. A tape check removes most of it.', P.scale) +
      (P.mirror > 0 ? row('Mirrored sides', 'The sides you could not reach were taken as a mirror image of the measured ones (' + fmt.big((r.mirroredVolume || 0) * f * f * f) + ' m³). Real piles are never perfectly symmetrical.', P.mirror) : '') +
      row('Unseen areas', 'Parts nobody saw were filled in as a ' + (r.top === 'flat' ? 'flat' : 'rounded') + ' top (' + fmt.big(r.filledVolume * f * f * f) + ' m³ of the volume)' +
        (r.topSource === 'taps' ? ', up to ' + (r.topHeight * f).toFixed(1) + ' m from your top-edge taps' : (r.topSource === 'entered' ? ', up to the ' + (r.topHeight * f).toFixed(1) + ' m height you entered' : '')) + '.', P.fill) +
      row('Ground level', 'How well the ground around the pile defines the base under it (spread ' + (r.ringRms * 100).toFixed(1) + ' cm).', P.base) +
      row('Tracking drift', r.loopMismatch !== null ? 'Where your loop closed, start and end differed by ' + (r.loopMismatch * 100).toFixed(1) + ' cm.' : 'Could not be checked at the loop end.', P.loop) +
      `<p class="muted small">Tonnage also depends on the density you chose (${c.density.toFixed(2)} t/m³). A 5% error in density is a 5% error in tonnes — calibrate it with a weighed pile when you can.</p>`;
  },
  editDensity() {
    const v = prompt('Bulk density in t/m³ for this pile:', this.cur.density);
    const d = parseFloat(v); if (!(d > 0.05 && d < 5)) return;
    this.cur.density = d; this.renderResult();
  },
  tapeText() {
    const c = this.cur, e = (c.tapeAR - c.tape) / c.tape * 100;
    return `Phone scale was off by ${e >= 0 ? '+' : ''}${e.toFixed(2)}% — corrected. Volume changed by ${((c.scale ** 3 - 1) * 100).toFixed(1)}%.`;
  },
  applyTape() {
    const c = this.cur, d = parseFloat($('tape-in').value);
    if (!(d > 0.3)) { this.toast('Enter the taped distance in metres', 'bad'); return; }
    const f = d / c.tapeAR;
    if (f < 0.85 || f > 1.15) { if (!confirm('That is ' + ((f - 1) * 100).toFixed(1) + '% different from the phone. Were the right points marked? Apply anyway?')) return; }
    c.tape = d; c.scale = f; $('tape-out').textContent = this.tapeText(); this.renderResult();
    this.viewer && this.viewer.render();
  },
  calibrate() {
    const N = this.numbers(), t = parseFloat($('cal-in').value);
    if (!(t > 0) || !(N.V > 0)) { this.toast('Enter the known tonnage', 'bad'); return; }
    const d = t / N.V;
    const out = $('cal-out');
    out.innerHTML = `Density = ${fmt.n(t, 1)} t ÷ ${fmt.big(N.V)} m³ = <b>${d.toFixed(3)} t/m³</b> (±${N.pm.toFixed(0)}% from the volume). `;
    const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Save as material';
    b.onclick = () => { const name = prompt('Material name:', (this.cur.material && this.cur.material !== 'Custom' ? this.cur.material + ' (calibrated)' : 'My material')); if (name && this.addMaterial(name, d)) { this.cur.density = d; this.cur.material = name.trim(); this.renderResult(); } };
    out.appendChild(b);
  },
  summaryText() {
    const c = this.cur, r = c.r, N = this.numbers(), f = N.f;
    return `Photoscale — ${c.name}\n${fmt.date(c.date)}\nVolume: ${fmt.big(N.V)} m³ (likely ${fmt.big(N.lo)}–${fmt.big(N.hi)})\n` +
      `Tonnage: ${fmt.big(N.T)} t at ${c.density.toFixed(2)} t/m³ (${c.material})\n` +
      `Footprint ${fmt.n(r.footprint * f * f, 1)} m² · peak ${fmt.n(r.maxHeight * f, 2)} m · ${fmt.n(r.length * f, 1)} × ${fmt.n(r.width * f, 1)} m` +
      (c.tape ? `\nScale checked with tape (${fmt.n(c.tape, 2)} m)` : '');
  },
  async share() {
    const text = this.summaryText();
    try { if (navigator.share) { await navigator.share({ title: 'Photoscale — ' + this.cur.name, text }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); this.toast('Summary copied to the clipboard', 'ok'); } catch (e) { prompt('Copy the summary:', text); }
  },
  record() {
    const c = this.cur, N = this.numbers();
    return {
      id: c.id, name: c.name, material: c.material, density: c.density, date: c.date, volume: N.V, lo: N.lo, hi: N.hi, tonnes: N.T,
      footprint: c.r.footprint * N.f * N.f, peak: c.r.maxHeight * N.f, coverage: c.r.coverage, source: c.extra && c.extra.source,
      tape: c.tape, scale: c.scale, warnings: c.r.warnings.length, walk: c.r.walk === 'partial' && c.r.far === 'wall' ? 'partial-walls' : c.r.walk, top: c.r.top
    };
  },
  async save() {
    const c = this.cur, rec = this.record();
    try { rec.thumb = this.viewer ? this.viewer.snapshot(240, 160) : null; } catch (e) { rec.thumb = null; }
    const hist = Store.get('history', []).filter(h => h.id !== c.id); hist.unshift(rec);
    if (!Store.set('history', hist)) { hist.forEach(h => { h.thumb = null; }); Store.set('history', hist); }
    const full = { id: c.id, r: c.r, cur: { name: c.name, material: c.material, density: c.density, date: c.date, scale: c.scale, tape: c.tape, tapeAR: c.tapeAR, truth: c.extra && c.extra.truth, source: c.extra && c.extra.source } };
    const ok = await DB.put(full);
    c.saved = true; $('res-save').textContent = 'Update saved measurement';
    this.updateHistCount();
    this.toast(ok ? 'Saved to history' : 'Saved the summary (this browser could not store the 3D model)', 'ok');
  },
  updateHistCount() { const n = Store.get('history', []).length; $('hist-count').textContent = n ? n : ''; },
  renderHistory() {
    const list = $('hist-list'), hist = Store.get('history', []);
    list.innerHTML = ''; $('hist-empty').classList.toggle('hidden', hist.length > 0);
    for (const h of hist) {
      const it = document.createElement('div'); it.className = 'hitem';
      it.innerHTML = `${h.thumb ? `<img src="${h.thumb}" alt="">` : '<img alt="">'}<div class="hx"><b>${esc(h.name)}</b><span>${fmt.date(h.date)} · ${esc(h.material)}</span></div>` +
        `<div class="hv"><b>${fmt.big(h.volume)} m³</b><span class="muted small">${fmt.big(h.tonnes)} t</span></div>`;
      const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕'; del.title = 'Delete';
      del.onclick = async (e) => { e.stopPropagation(); if (!confirm('Delete “' + h.name + '”?')) return; Store.set('history', Store.get('history', []).filter(x => x.id !== h.id)); await DB.del(h.id); this.updateHistCount(); this.renderHistory(); };
      it.appendChild(del);
      it.onclick = () => this.openSaved(h);
      list.appendChild(it);
    }
  },
  async openSaved(h) {
    const full = await DB.get(h.id);
    if (!full || !full.r) { this.toast('The 3D data of this measurement is not available in this browser.', 'bad'); return; }
    const k = full.cur;
    this.cur = { id: full.id, r: full.r, extra: { meta: {}, truth: k.truth, source: k.source }, name: k.name, material: k.material, density: k.density, date: k.date, scale: k.scale || 1, tape: k.tape || null, tapeAR: k.tapeAR || null, saved: true };
    this.openResult();
  },
  download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  },
  fileBase() { return ('photoscale_' + this.cur.name).replace(/[^\w\-]+/g, '_').slice(0, 60); },
  exportJSON() {
    const c = this.cur, r = c.r, N = this.numbers();
    const b64 = (ta) => { const u = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); };
    const out = {
      app: 'Photoscale', version: APP_VERSION, name: c.name, date: c.date, material: c.material, density_t_per_m3: c.density,
      volume_m3: +N.V.toFixed(3), volume_likely_range_m3: [+N.lo.toFixed(3), +N.hi.toFixed(3)], tonnes: +N.T.toFixed(3),
      footprint_m2: +(r.footprint * N.f * N.f).toFixed(3), peak_height_m: +(r.maxHeight * N.f).toFixed(3),
      length_m: +(r.length * N.f).toFixed(2), width_m: +(r.width * N.f).toFixed(2), surface_seen: +r.coverage.toFixed(3),
      loop_progress: +r.progress.toFixed(3), walk: r.walk, top_assumption: r.top, mirrored_volume_m3: +((r.mirroredVolume || 0) * N.f ** 3).toFixed(3),
      filled_volume_m3: +(r.filledVolume * N.f ** 3).toFixed(3), symmetry: r.sym, unwalked_sides: r.far || null, wall_height_m: r.wallHeight || null, walls: r.walls || null,
      top: { height_m: r.topHeight != null ? +(r.topHeight * N.f).toFixed(2) : null, from: r.topSource || 'measured', highest_measured_m: r.topMeasured != null ? +(r.topMeasured * N.f).toFixed(2) : null, top_edge_taps_m: (r.tapHeights || []).map(h => +(h * N.f).toFixed(2)), slope_deg: r.slopeDeg != null ? +r.slopeDeg.toFixed(1) : null }, tape_check: c.tape ? { ar_distance_m: c.tapeAR, tape_distance_m: c.tape, scale_factor: c.scale } : null,
      error_parts_m3: N.parts, warnings: r.warnings, notes: r.notes || [],
      height_grid: { note: 'heights above the base plane in metres, row-major (z rows, x columns); NaN = not measured; mask bit0 = pile, bit1 = seen (a measurement within 25 cm), bit2 = mirrored from the measured side', nx: r.grid.nx, nz: r.grid.nz, cell_m: r.grid.s, scale_applied: c.scale, Z_float32_base64: b64(r.grid.Z), mask_uint8_base64: b64(r.grid.mask) }
    };
    this.download(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }), this.fileBase() + '.json');
  },
  async downloadRaw() {
    const rec = this.cur.extra && this.cur.extra.recorder; if (!rec) return;
    Busy.show('Packing raw data (' + rec.sizeMB().toFixed(0) + ' MB)…');
    try {
      const blob = await rec.zip({ name: this.cur.name, flipMode: this.cur.r.flipMode, result_volume_m3: this.cur.r.volume, features: this.cur.extra.features });
      this.download(blob, this.fileBase() + '_raw.zip');
    } catch (e) { this.toast('Could not pack the raw data: ' + e.message, 'bad'); }
    Busy.hide();
  },
  exportCSV() {
    const hist = Store.get('history', []);
    if (!hist.length) { this.toast('No saved measurements yet'); return; }
    const rows = [['name', 'date', 'material', 'density_t_m3', 'volume_m3', 'volume_low_m3', 'volume_high_m3', 'tonnes', 'footprint_m2', 'peak_m', 'surface_seen', 'walk', 'top', 'tape_checked']];
    for (const h of hist) rows.push([h.name, h.date, h.material, h.density, h.volume.toFixed(3), h.lo.toFixed(3), h.hi.toFixed(3), h.tonnes.toFixed(3), h.footprint.toFixed(2), h.peak.toFixed(2), h.coverage.toFixed(3), h.walk || 'full', h.top || 'peaked', h.tape ? 'yes' : 'no']);
    const csv = rows.map(r => r.map(v => /[",;\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(',')).join('\n');
    this.download(new Blob(['﻿' + csv], { type: 'text/csv' }), 'photoscale_history.csv');
  }
};
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
window.addEventListener('DOMContentLoaded', () => App.init());
