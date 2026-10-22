/*!
 * Video Rebrander v1.0
 * Removes an old logo or watermark from many videos and adds a new one.
 * Everything runs in this browser tab. Videos are never uploaded.
 * Video reading and writing: Mediabunny (MPL-2.0), see lib/MEDIABUNNY-LICENSE.txt
 */
(() => {
  'use strict';

  const MB = window.Mediabunny;
  const DEBUG = /debug/.test(location.hash);
  const $ = (id) => document.getElementById(id);
  const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);
  const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '__macosx', '.trashes', '.spotlight-v100', '.fseventsd', '.git']);
  const OUT_DIR_NAME = 'Rebranded';
  const MAX_BOXES = 8;
  const SETTINGS_KEY = 'vr.settings.v1';
  const PREVIEW_MAX = 1920;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const HAS_FSA = typeof window.showDirectoryPicker === 'function';

  const METHODS = {
    fill: { label: 'Fill', help: 'Fill paints over the logo with the colors around it. Best for most logos.' },
    blur: { label: 'Blur', help: 'Blur makes the area blurry so the logo can’t be read.' },
    pixelate: { label: 'Pixelate', help: 'Pixelate covers the area with large pixels.' },
    crop: { label: 'Crop out', help: 'Crop out zooms in a little so the logo is cut off. Best for logos at the very edge.' },
  };
  const ANCHORS = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];
  const FONTS = {
    sans: { family: '"Segoe UI", "Helvetica Neue", Arial, system-ui, sans-serif', weight: 700 },
    serif: { family: 'Georgia, "Times New Roman", Times, serif', weight: 700 },
    display: { family: 'Impact, "Arial Black", "Helvetica Neue", Arial, sans-serif', weight: 900 },
    mono: { family: '"Cascadia Mono", Consolas, "SFMono-Regular", Menlo, "Courier New", monospace', weight: 700 },
  };
  const COPY_RE = / \(rebranded(?: \d+)?\)\.mp4$/i;
  const CODEC_NAMES = { avc: 'H.264', hevc: 'HEVC (H.265)', vp8: 'VP8', vp9: 'VP9', av1: 'AV1' };
  const QUALITY = { original: [1.1, 0.035], smaller: [0.6, 0.025], best: [1.6, 0.08] };

  // ---------------------------------------------------------------- helpers
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const uid = () => Math.random().toString(36).slice(2, 9);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : (many || one + 's')}`;

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
  }
  function fmtTime(s) {
    if (!Number.isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }
  function fmtSpan(s) {
    if (!Number.isFinite(s) || s < 0) s = 0;
    return s < 60 ? `${s.toFixed(1)} s` : fmtTime(s);
  }
  function fmtLeft(s) {
    if (!Number.isFinite(s)) return '';
    if (s < 45) return 'Less than a minute left';
    const m = Math.round(s / 60);
    if (m < 60) return `About ${plural(m, 'minute')} left`;
    const h = Math.floor(m / 60), mm = m % 60;
    return `About ${h} h ${mm ? mm + ' min ' : ''}left`;
  }
  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  class UserError extends Error { constructor(msg, tip = '') { super(msg); this.tip = tip; } }

  let toastTimer = 0;
  function toast(msg, ms = 3800) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------------------------------------------------------------- shapes
  const RATIOS = [['16:9', 16 / 9], ['9:16', 9 / 16], ['4:3', 4 / 3], ['3:4', 3 / 4], ['1:1', 1], ['4:5', 4 / 5], ['5:4', 5 / 4],
    ['3:2', 3 / 2], ['2:3', 2 / 3], ['21:9', 64 / 27], ['9:21', 27 / 64], ['2:1', 2], ['1:2', 1 / 2]];
  function shapeKey(w, h) {
    const r = w / h;
    for (const [k, v] of RATIOS) if (Math.abs(r / v - 1) < 0.025) return k;
    return r >= 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`;
  }
  function shapeWord(key) {
    const [a, b] = key.split(':').map(Number);
    const r = a / b;
    return r > 1.05 ? 'landscape' : r < 0.95 ? 'portrait' : 'square';
  }
  const shapeLabel = (key) => `${key} ${shapeWord(key)}`;

  // ---------------------------------------------------------------- settings
  function defaultSettings() {
    return {
      v: 1,
      shapes: {},
      overlay: {
        kind: 'none',
        image: null,
        text: { value: '', font: 'sans', color: '#ffffff', shadow: true },
        anchor: 'br', cx: 0.85, cy: 0.85, size: 0.18, opacity: 1, margin: 0.04,
      },
      quality: 'original',
      existing: 'skip',
      rightsOk: false,
      includeSub: true,
    };
  }
  const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);
  function sanitizeBox(b) {
    if (!b || typeof b !== 'object') return null;
    const x = num(b.x, 0, 1, null), y = num(b.y, 0, 1, null), w = num(b.w, 0, 1, null), h = num(b.h, 0, 1, null);
    if ([x, y, w, h].includes(null) || w < 0.002 || h < 0.002) return null;
    return { id: typeof b.id === 'string' ? b.id : uid(), x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y), method: METHODS[b.method] ? b.method : 'fill' };
  }
  function loadSettings() {
    const s = defaultSettings();
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { raw = null; }
    if (!raw || raw.v !== 1) return s;
    if (raw.shapes && typeof raw.shapes === 'object') {
      for (const [k, val] of Object.entries(raw.shapes)) {
        const boxes = Array.isArray(val && val.boxes) ? val.boxes.map(sanitizeBox).filter(Boolean).slice(0, MAX_BOXES) : [];
        if (boxes.length) s.shapes[k] = { boxes };
      }
    }
    const o = raw.overlay || {}, d = s.overlay;
    d.kind = ['none', 'image', 'text'].includes(o.kind) ? o.kind : 'none';
    if (o.image && typeof o.image.dataUrl === 'string' && o.image.dataUrl.startsWith('data:image/')) {
      d.image = { name: String(o.image.name || 'logo.png'), dataUrl: o.image.dataUrl };
    }
    const t = o.text || {};
    d.text = {
      value: typeof t.value === 'string' ? t.value.slice(0, 80) : '',
      font: FONTS[t.font] ? t.font : 'sans',
      color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#ffffff',
      shadow: t.shadow !== false,
    };
    d.anchor = ANCHORS.includes(o.anchor) || o.anchor === 'box' || o.anchor === 'custom' ? o.anchor : 'br';
    d.cx = num(o.cx, 0, 1, 0.85); d.cy = num(o.cy, 0, 1, 0.85);
    d.size = num(o.size, 0.02, 0.9, 0.18);
    d.opacity = num(o.opacity, 0.1, 1, 1);
    d.margin = num(o.margin, 0, 0.2, 0.04);
    if (QUALITY[raw.quality]) s.quality = raw.quality;
    if (raw.existing === 'replace') s.existing = 'replace';
    s.rightsOk = raw.rightsOk === true;
    s.includeSub = raw.includeSub !== false;
    return s;
  }
  let saveTimer = 0;
  function saveSettings() { clearTimeout(saveTimer); saveTimer = setTimeout(saveSettingsNow, 200); }
  function saveSettingsNow() {
    clearTimeout(saveTimer);
    const s = state.settings;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {
      // Most likely the logo image is too big to remember. Keep everything else.
      try {
        const copy = JSON.parse(JSON.stringify(s));
        if (copy.overlay.image) copy.overlay.image.dataUrl = null;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(copy));
      } catch { /* storage unavailable */ }
    }
  }

  // ---------------------------------------------------------------- plan
  // A plan describes exactly what happens to every frame of one video size.
  // Boxes are stored relative to the original frame (0..1). The output always keeps the original size.
  function bestCrop(crops, W, H) {
    let best = null;
    const n = crops.length;
    const rec = (i, L, T, R, B) => {
      const s = Math.min((R - L) / W, (B - T) / H);
      if (!(s > 0.05) || (best && s <= best.s + 1e-9)) return;
      if (i === n) {
        const w = W * s, h = H * s;
        best = { s, x: clamp(W / 2 - w / 2, L, R - w), y: clamp(H / 2 - h / 2, T, B - h), w, h };
        return;
      }
      const b = crops[i];
      if (b.x + b.w <= L || b.x >= R || b.y + b.h <= T || b.y >= B) { rec(i + 1, L, T, R, B); return; }
      rec(i + 1, Math.max(L, b.x + b.w), T, R, B);
      rec(i + 1, L, T, Math.min(R, b.x), B);
      rec(i + 1, L, Math.max(T, b.y + b.h), R, B);
      rec(i + 1, L, T, R, Math.min(B, b.y));
    };
    rec(0, 0, 0, W, H);
    return best;
  }

  function anchoredPos(anchor, w, h, W, H, mg) {
    return {
      x: anchor.includes('l') ? mg : anchor.includes('r') ? W - mg - w : (W - w) / 2,
      y: anchor.startsWith('t') ? mg : anchor.startsWith('b') ? H - mg - h : (H - h) / 2,
    };
  }

  function overlaySize(cfg, aspect, W, H) {
    const L = cfg.size * Math.min(W, H);
    let w = aspect >= 1 ? L : L * aspect, h = aspect >= 1 ? L / aspect : L;
    if (w > W) { h *= W / w; w = W; }
    if (h > H) { w *= H / h; h = H; }
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  function computePlan(boxes, ov, aspect, W, H) {
    const all = (boxes || []).map((b) => ({ x: b.x * W, y: b.y * H, w: b.w * W, h: b.h * H, method: b.method }));
    const crops = all.filter((b) => b.method === 'crop');
    let crop = null, cropFailed = false;
    if (crops.length) {
      crop = bestCrop(crops, W, H);
      if (!crop) cropFailed = true;
      else if (crop.s > 0.999) crop = null;
    }
    const kx = crop ? W / crop.w : 1, ky = crop ? H / crop.h : 1;
    const ox = crop ? crop.x : 0, oy = crop ? crop.y : 0;
    const map = (x, y) => ({ x: (x - ox) * kx, y: (y - oy) * ky });
    const regions = [];
    let anchorPoint = null;
    for (const b of all) {
      if (b.method === 'crop') continue;
      const p0 = map(b.x, b.y), p1 = map(b.x + b.w, b.y + b.h);
      if (!anchorPoint) anchorPoint = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      const x0 = clamp(Math.floor(p0.x), 0, W), y0 = clamp(Math.floor(p0.y), 0, H);
      const x1 = clamp(Math.ceil(p1.x), 0, W), y1 = clamp(Math.ceil(p1.y), 0, H);
      if (x1 - x0 < 2 || y1 - y0 < 2) continue;
      regions.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, method: b.method });
    }
    let ovRect = null;
    if (ov && aspect) {
      const { w, h } = overlaySize(ov, aspect, W, H);
      const mg = ov.margin * Math.min(W, H);
      let anchor = ov.anchor, p;
      if (anchor === 'box' && !anchorPoint) anchor = 'br';
      if (anchor === 'box') p = { x: anchorPoint.x - w / 2, y: anchorPoint.y - h / 2 };
      else if (anchor === 'custom') p = { x: ov.cx * W - w / 2, y: ov.cy * H - h / 2 };
      else p = anchoredPos(anchor, w, h, W, H, mg);
      const rw = Math.max(1, Math.round(w)), rh = Math.max(1, Math.round(h));
      ovRect = { x: Math.round(clamp(p.x, 0, W - rw)), y: Math.round(clamp(p.y, 0, H - rh)), w: rw, h: rh, opacity: ov.opacity };
    }
    return {
      W, H, regions, ov: ovRect, cropFailed, anchorPoint,
      crop: crop ? { x: crop.x, y: crop.y, w: crop.w, h: crop.h } : null,
      zoom: crop ? Math.max(kx, ky) : 1,
    };
  }

  // ---------------------------------------------------------------- effects
  // Each effect works on a small area around its box only, so it stays fast even on 4K video.
  class FillKernel {
    // "Push-pull" fill: averages known pixels into a pyramid, then fills the hole from coarse to fine.
    constructor(r, W, H) {
      const m = Math.max(6, Math.round(Math.min(r.w, r.h) * 0.25));
      this.rx = Math.max(0, r.x - m); this.ry = Math.max(0, r.y - m);
      this.rw = Math.min(W, r.x + r.w + m) - this.rx; this.rh = Math.min(H, r.y + r.h + m) - this.ry;
      this.x0 = r.x - this.rx; this.y0 = r.y - this.ry; this.x1 = this.x0 + r.w; this.y1 = this.y0 + r.h;
      this.levels = [];
      let w = this.rw, h = this.rh;
      for (;;) {
        this.levels.push({ w, h, C: new Float32Array(w * h * 3), Wt: new Float32Array(w * h) });
        if (w === 1 && h === 1) break;
        w = Math.max(1, (w + 1) >> 1); h = Math.max(1, (h + 1) >> 1);
      }
    }
    apply(d) {
      const { rw, x0, y0, x1, y1, levels } = this;
      const L0 = levels[0], C0 = L0.C, W0 = L0.Wt;
      for (let y = 0, i = 0; y < L0.h; y++) {
        const rowIn = y >= y0 && y < y1;
        for (let x = 0; x < rw; x++, i++) {
          if (rowIn && x >= x0 && x < x1) { W0[i] = 0; C0[i * 3] = 0; C0[i * 3 + 1] = 0; C0[i * 3 + 2] = 0; continue; }
          const p = i * 4;
          C0[i * 3] = d[p]; C0[i * 3 + 1] = d[p + 1]; C0[i * 3 + 2] = d[p + 2]; W0[i] = 1;
        }
      }
      for (let l = 1; l < levels.length; l++) {
        const S = levels[l - 1], D = levels[l];
        const sw = S.w, sh = S.h, SC = S.C, SW = S.Wt, DC = D.C, DW = D.Wt;
        for (let y = 0; y < D.h; y++) {
          for (let x = 0; x < D.w; x++) {
            let r = 0, g = 0, b = 0, s = 0;
            for (let dy = 0; dy < 2; dy++) {
              const yy = y * 2 + dy;
              if (yy >= sh) break;
              for (let dx = 0; dx < 2; dx++) {
                const xx = x * 2 + dx;
                if (xx >= sw) break;
                const j = yy * sw + xx, wt = SW[j];
                if (wt === 0) continue;
                r += SC[j * 3] * wt; g += SC[j * 3 + 1] * wt; b += SC[j * 3 + 2] * wt; s += wt;
              }
            }
            const k = y * D.w + x;
            if (s > 0) { DC[k * 3] = r / s; DC[k * 3 + 1] = g / s; DC[k * 3 + 2] = b / s; DW[k] = s > 1 ? 1 : s; }
            else { DC[k * 3] = 0; DC[k * 3 + 1] = 0; DC[k * 3 + 2] = 0; DW[k] = 0; }
          }
        }
      }
      for (let l = levels.length - 2; l >= 0; l--) {
        const L = levels[l], U = levels[l + 1];
        const LC = L.C, LW = L.Wt, UC = U.C, uw = U.w, uh = U.h;
        for (let y = 0; y < L.h; y++) {
          const fy = clamp((y + 0.5) / 2 - 0.5, 0, uh - 1), iy = Math.floor(fy), ay = fy - iy, iy1 = Math.min(uh - 1, iy + 1);
          for (let x = 0; x < L.w; x++) {
            const i = y * L.w + x, wt = LW[i];
            if (wt >= 1) continue;
            const fx = clamp((x + 0.5) / 2 - 0.5, 0, uw - 1), ix = Math.floor(fx), ax = fx - ix, ix1 = Math.min(uw - 1, ix + 1);
            const a = (iy * uw + ix) * 3, b = (iy * uw + ix1) * 3, c = (iy1 * uw + ix) * 3, e = (iy1 * uw + ix1) * 3;
            for (let ch = 0; ch < 3; ch++) {
              const v = (UC[a + ch] * (1 - ax) + UC[b + ch] * ax) * (1 - ay) + (UC[c + ch] * (1 - ax) + UC[e + ch] * ax) * ay;
              LC[i * 3 + ch] = wt * LC[i * 3 + ch] + (1 - wt) * v;
            }
            LW[i] = 1;
          }
        }
      }
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * rw + x, p = i * 4;
          d[p] = C0[i * 3]; d[p + 1] = C0[i * 3 + 1]; d[p + 2] = C0[i * 3 + 2]; d[p + 3] = 255;
        }
      }
    }
  }

  class BlurKernel {
    constructor(r, W, H) {
      const rad = clamp(Math.round(Math.min(r.w, r.h) * 0.22), 3, 48);
      const m = rad * 3;
      this.rad = rad;
      this.rx = Math.max(0, r.x - m); this.ry = Math.max(0, r.y - m);
      this.rw = Math.min(W, r.x + r.w + m) - this.rx; this.rh = Math.min(H, r.y + r.h + m) - this.ry;
      this.x0 = r.x - this.rx; this.y0 = r.y - this.ry; this.x1 = this.x0 + r.w; this.y1 = this.y0 + r.h;
      this.a = new Float32Array(this.rw * this.rh * 3);
      this.b = new Float32Array(this.rw * this.rh * 3);
      this.line = new Float32Array(Math.max(this.rw, this.rh) * 3);
      this.feather = Math.max(2, Math.round(rad / 3));
    }
    pass(src, dst, w, h, stride, step, rad) {
      // One box-blur pass along rows (step=3, stride=w*3) or columns (step=w*3, stride=3), edges clamped.
      const line = this.line, n = step === 3 ? w : h, lines = step === 3 ? h : w, norm = 1 / (2 * rad + 1);
      for (let L = 0; L < lines; L++) {
        const base = L * stride;
        for (let ch = 0; ch < 3; ch++) {
          let acc = 0;
          for (let k = -rad; k <= rad; k++) acc += src[base + clamp(k, 0, n - 1) * step + ch];
          for (let i = 0; i < n; i++) {
            line[i] = acc * norm;
            acc += src[base + Math.min(n - 1, i + rad + 1) * step + ch] - src[base + Math.max(0, i - rad) * step + ch];
          }
          for (let i = 0; i < n; i++) dst[base + i * step + ch] = line[i];
        }
      }
    }
    apply(d) {
      const { rw, rh, a, b, rad, x0, y0, x1, y1, feather } = this;
      for (let i = 0, n = rw * rh; i < n; i++) { a[i * 3] = d[i * 4]; a[i * 3 + 1] = d[i * 4 + 1]; a[i * 3 + 2] = d[i * 4 + 2]; }
      for (let k = 0; k < 3; k++) { this.pass(a, b, rw, rh, rw * 3, 3, rad); this.pass(b, a, rw, rh, 3, rw * 3, rad); }
      for (let y = y0; y < y1; y++) {
        const dy = Math.min(y - y0, y1 - 1 - y);
        for (let x = x0; x < x1; x++) {
          const t = Math.min(1, (Math.min(dy, x - x0, x1 - 1 - x) + 1) / feather);
          const i = y * rw + x, p = i * 4;
          d[p] = d[p] + (a[i * 3] - d[p]) * t;
          d[p + 1] = d[p + 1] + (a[i * 3 + 1] - d[p + 1]) * t;
          d[p + 2] = d[p + 2] + (a[i * 3 + 2] - d[p + 2]) * t;
        }
      }
    }
  }

  class PixelateKernel {
    constructor(r) {
      this.bs = clamp(Math.round(Math.min(r.w, r.h) / 5), 6, 64);
      this.rx = r.x; this.ry = r.y; this.rw = r.w; this.rh = r.h;
    }
    apply(d) {
      const { rw, rh, bs } = this;
      for (let by = 0; by < rh; by += bs) {
        for (let bx = 0; bx < rw; bx += bs) {
          const ex = Math.min(rw, bx + bs), ey = Math.min(rh, by + bs);
          let r = 0, g = 0, b = 0, n = 0;
          for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const p = (y * rw + x) * 4; r += d[p]; g += d[p + 1]; b += d[p + 2]; n++; }
          r /= n; g /= n; b /= n;
          for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const p = (y * rw + x) * 4; d[p] = r; d[p + 1] = g; d[p + 2] = b; }
        }
      }
    }
  }

  function makeKernel(r, W, H) {
    if (r.method === 'blur') return new BlurKernel(r, W, H);
    if (r.method === 'pixelate') return new PixelateKernel(r, W, H);
    return new FillKernel(r, W, H);
  }

  // ---------------------------------------------------------------- new logo (image or text)
  function trimTransparent(src, w, h) {
    // Many logo PNGs have wide transparent borders. Trim them so size and margin feel right.
    if (w * h > 4096 * 4096) return { sx: 0, sy: 0, sw: w, sh: h };
    const c = makeCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(src, 0, 0);
    let d;
    try { d = x.getImageData(0, 0, w, h).data; } catch { return { sx: 0, sy: 0, sw: w, sh: h }; }
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        if (d[(yy * w + xx) * 4 + 3] > 8) {
          if (xx < minX) minX = xx;
          if (xx > maxX) maxX = xx;
          if (yy < minY) minY = yy;
          if (yy > maxY) maxY = yy;
        }
      }
    }
    if (maxX < 0) return { sx: 0, sy: 0, sw: w, sh: h };
    return { sx: minX, sy: minY, sw: maxX - minX + 1, sh: maxY - minY + 1 };
  }

  async function makeImageAsset(blob, name) {
    const isSvg = blob.type === 'image/svg+xml' || /\.svg$/i.test(name || '');
    let src, w, h, rect;
    if (isSvg) {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      try { await img.decode(); } catch { URL.revokeObjectURL(url); throw new UserError('This image can’t be opened. Try a PNG file.'); }
      w = img.naturalWidth || 600; h = img.naturalHeight || 600;
      src = img;
      rect = { sx: 0, sy: 0, sw: w, sh: h };
    } else {
      try { src = await createImageBitmap(blob); } catch { throw new UserError('This image can’t be opened. Try a PNG file.'); }
      w = src.width; h = src.height;
      rect = trimTransparent(src, w, h);
    }
    const cache = new Map();
    return {
      kind: 'image', name, isSvg, width: rect.sw, height: rect.sh,
      aspect: rect.sw / rect.sh,
      thumbSrc: null,
      drawSync(ctx, x, y, dw, dh) {
        ctx.drawImage(src, rect.sx, rect.sy, rect.sw, rect.sh, x, y, dw, dh);
      },
      async prepare(dw, dh) {
        const key = `${dw}x${dh}`;
        if (cache.has(key)) return cache.get(key);
        let out;
        if (isSvg) {
          out = makeCanvas(dw, dh);
          const c = out.getContext('2d');
          c.drawImage(src, 0, 0, dw, dh);
        } else {
          out = await createImageBitmap(src, rect.sx, rect.sy, rect.sw, rect.sh, { resizeWidth: dw, resizeHeight: dh, resizeQuality: 'high' });
        }
        if (cache.size > 12) cache.clear();
        cache.set(key, out);
        return out;
      },
    };
  }

  function makeTextAsset(t) {
    const text = (t.value || '').trim();
    if (!text) return null;
    const f = FONTS[t.font] || FONTS.sans;
    const BASE = 200;
    const mc = makeCanvas(8, 8).getContext('2d');
    mc.font = `${f.weight} ${BASE}px ${f.family}`;
    const m = mc.measureText(text);
    const asc = m.actualBoundingBoxAscent || BASE * 0.75, desc = m.actualBoundingBoxDescent || BASE * 0.2;
    const left = m.actualBoundingBoxLeft || 0, right = m.actualBoundingBoxRight || m.width;
    const pad = BASE * (t.shadow ? 0.14 : 0.04);
    const w0 = left + right + pad * 2, h0 = asc + desc + pad * 2;
    const draw = (ctx, x, y, dw, dh) => {
      const k = dw / w0;
      ctx.save();
      ctx.font = `${f.weight} ${BASE * k}px ${f.family}`;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillStyle = t.color;
      if (t.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = BASE * k * 0.09;
        ctx.shadowOffsetY = BASE * k * 0.03;
      }
      ctx.fillText(text, x + (pad + left) * k, y + (pad + asc) * (dh / h0));
      ctx.restore();
    };
    const cache = new Map();
    return {
      kind: 'text', name: text, aspect: w0 / h0,
      drawSync: draw,
      async prepare(dw, dh) {
        const key = `${dw}x${dh}`;
        if (cache.has(key)) return cache.get(key);
        const c = makeCanvas(dw, dh);
        draw(c.getContext('2d'), 0, 0, dw, dh);
        if (cache.size > 12) cache.clear();
        cache.set(key, c);
        return c;
      },
    };
  }

  // ---------------------------------------------------------------- frame renderer
  // Used for the preview and for the real export, so what you see is what you get.
  class FrameRenderer {
    constructor(plan, logo) {
      this.plan = plan;
      this.canvas = makeCanvas(plan.W, plan.H);
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
      this.kernels = plan.regions.map((r) => makeKernel(r, plan.W, plan.H));
      this.logo = logo || null;
      if (this.kernels.length) {
        const mw = Math.max(...this.kernels.map((k) => k.rw)), mh = Math.max(...this.kernels.map((k) => k.rh));
        this.scratch = makeCanvas(mw, mh);
        this.sctx = this.scratch.getContext('2d', { willReadFrequently: true, alpha: false });
      }
    }
    render(drawSource) {
      const { W, H, crop, ov } = this.plan, ctx = this.ctx;
      if (crop) {
        const kx = W / crop.w, ky = H / crop.h;
        drawSource(ctx, -crop.x * kx, -crop.y * ky, W * kx, H * ky);
      } else {
        drawSource(ctx, 0, 0, W, H);
      }
      for (const k of this.kernels) {
        this.sctx.drawImage(this.canvas, k.rx, k.ry, k.rw, k.rh, 0, 0, k.rw, k.rh);
        const img = this.sctx.getImageData(0, 0, k.rw, k.rh);
        k.apply(img.data);
        ctx.putImageData(img, k.rx, k.ry);
      }
      if (this.logo && ov) {
        ctx.globalAlpha = ov.opacity;
        if (this.logo.bitmap) ctx.drawImage(this.logo.bitmap, ov.x, ov.y, ov.w, ov.h);
        else this.logo.asset.drawSync(ctx, ov.x, ov.y, ov.w, ov.h);
        ctx.globalAlpha = 1;
      }
      return this.canvas;
    }
  }

  // ---------------------------------------------------------------- state
  const state = {
    settings: loadSettings(),
    source: null,          // { kind: 'folder' | 'files' | 'sample', name, handle? }
    videos: [],
    byId: new Map(),
    activeId: null,
    view: 'result',
    sel: null,             // { type: 'box', id } | { type: 'ov' }
    asset: null,           // the new logo, ready to draw
    outDir: null,          // a custom output folder (null = "Rebranded" inside the source folder)
    outSame: false,        // custom output folder is the source folder itself
    scanning: false,
    run: null,
    otherFiles: 0,
    copyFiles: 0,
    supported: true,
  };

  const shapeOf = (v) => (v && v.info ? v.info.shape : null);
  const activeVideo = () => state.byId.get(state.activeId) || null;
  const activeShape = () => shapeOf(activeVideo());
  function boxesFor(shape) {
    const s = shape && state.settings.shapes[shape];
    return s ? s.boxes : [];
  }
  function setBoxesFor(shape, boxes) {
    if (!shape) return;
    if (boxes.length) state.settings.shapes[shape] = { boxes };
    else delete state.settings.shapes[shape];
    saveSettings();
  }
  function overlayActive() {
    const o = state.settings.overlay;
    return o.kind !== 'none' && !!state.asset;
  }

  // ---------------------------------------------------------------- reading videos
  function openInput(file) {
    return new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
  }
  async function getFile(v) {
    if (v.file) return v.file;
    return v.handle.getFile();
  }

  function friendlyError(e, phase) {
    if (e instanceof UserError) return e.message;
    const msg = String((e && e.message) || e || '');
    const name = (e && e.name) || '';
    if (name === 'NotFoundError') return 'The file was moved or deleted.';
    if (name === 'NotReadableError') return 'The file can’t be read. It may be open in another app or on a disconnected drive.';
    if (name === 'QuotaExceededError') return 'Not enough free disk space.';
    if (name === 'NoModificationAllowedError' || name === 'InvalidModificationError') return 'The file can’t be saved there. The folder may be read-only.';
    if (name === 'NotAllowedError') return 'Permission to save was not given.';
    if (/unsupported or unrecognizable format/i.test(msg)) return 'This file type can’t be read.';
    if (/out of bounds|unexpected end|end of file|truncated|offset/i.test(msg)) return 'This file looks damaged or incomplete.';
    if (phase === 'probe') return 'This file looks damaged or can’t be read.';
    if (/decod/i.test(msg)) return 'The video couldn’t be decoded. The file may be damaged.';
    if (/encod/i.test(msg)) return 'This computer couldn’t encode the new video.';
    return msg ? `Something went wrong: ${msg.slice(0, 140)}` : 'Something went wrong.';
  }

  async function probeVideo(v) {
    let input = null;
    try {
      const file = await getFile(v);
      v.size = file.size;
      v.mtime = file.lastModified;
      if (!file.size) throw new UserError('This file is empty.');
      input = openInput(file);
      let vt;
      try { vt = await input.getPrimaryVideoTrack(); } catch (e) { throw new UserError(friendlyError(e, 'probe')); }
      if (!vt) throw new UserError('There’s no video in this file.');
      const codec = vt.codec;
      if (!codec) throw new UserError('This video format isn’t supported.');
      if (!(await vt.canDecode())) {
        throw codec === 'hevc'
          ? new UserError('HEVC (H.265) video can’t be read in this browser', 'This video uses HEVC (H.265). Try Microsoft Edge, or Chrome on a newer computer, or convert it to H.264 first.')
          : new UserError(`${CODEC_NAMES[codec] || codec} video can’t be read in this browser`, 'Try another browser, or convert the video to H.264 (MP4) first.');
      }
      const W = vt.displayWidth, H = vt.displayHeight;
      if (!W || !H) throw new UserError('This file looks damaged or can’t be read.');
      let dur = 0;
      try { dur = await input.computeDuration(); } catch { dur = 0; }
      if (!(dur > 0)) { try { dur = (await input.getDurationFromMetadata()) || 0; } catch { dur = 0; } }
      if (!(dur > 0)) throw new UserError('This file looks damaged or incomplete.');
      let fps = 30;
      try { const st = await vt.computePacketStats(90); if (st.averagePacketRate > 1) fps = st.averagePacketRate; } catch { /* keep 30 */ }
      let at = null;
      try { at = await input.getPrimaryAudioTrack(); } catch { at = null; }
      let bitrate = (v.size * 8) / dur - (at ? 160000 : 0);
      if (!(bitrate > 100000)) { try { bitrate = (await vt.getAverageBitrate()) || 0; } catch { bitrate = 0; } }
      v.info = {
        W, H, dur, fps, codec, rotation: vt.rotation || 0,
        bitrate: bitrate > 100000 ? bitrate : 0,
        audio: at ? at.codec || 'unknown' : null,
        shape: shapeKey(W, H),
      };
      v.status = 'ok';
    } catch (e) {
      v.status = 'bad';
      v.error = e instanceof UserError ? e.message : friendlyError(e, 'probe');
      v.errorTip = (e instanceof UserError && e.tip) || '';
    } finally {
      if (input) { try { input.dispose(); } catch { /* ignore */ } }
    }
  }

  async function walkFolder(root, includeSub, skip, onProgress) {
    const found = [];
    let others = 0, copies = 0;
    async function isSkipped(h) {
      for (const s of skip) { try { if (await h.isSameEntry(s)) return true; } catch { /* ignore */ } }
      return false;
    }
    async function rec(dir, prefix, depth) {
      const entries = [];
      try { for await (const e of dir.values()) entries.push(e); } catch { return; }
      for (const h of entries) {
        const name = h.name;
        if (name.startsWith('.') || name.startsWith('~$')) continue;
        if (h.kind === 'directory') {
          if (!includeSub || depth > 24 || SKIP_DIRS.has(name.toLowerCase())) continue;
          if (depth === 0 && name === OUT_DIR_NAME) continue;
          if (skip.length && await isSkipped(h)) continue;
          await rec(h, `${prefix}${name}/`, depth + 1);
        } else {
          const dot = name.lastIndexOf('.');
          const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
          if (VIDEO_EXT.has(ext)) {
            if (COPY_RE.test(name)) { copies++; continue; }
            found.push({ name, dir: prefix, path: prefix + name, handle: h });
            if (found.length % 50 === 0) onProgress(found.length);
          } else others++;
        }
      }
    }
    await rec(root, '', 0);
    found.sort((a, b) => collator.compare(a.dir, b.dir) || collator.compare(a.name, b.name));
    return { found, others, copies };
  }

  function addVideos(list) {
    state.videos = list.map((f, i) => ({
      id: `v${i + 1}`, name: f.name, dir: f.dir || '', path: f.path || f.name, handle: f.handle || null, file: f.file || null,
      size: f.file ? f.file.size : 0, status: 'pending', info: null, error: '', result: null, thumb: null,
    }));
    state.byId = new Map(state.videos.map((v) => [v.id, v]));
  }

  async function probeAll() {
    const list = state.videos.slice();
    const gen = ++probeGen;
    let next = 0, done = 0;
    state.scanning = true;
    renderSourceProgress(0, list.length);
    const worker = async () => {
      while (next < list.length) {
        const v = list[next++];
        if (gen !== probeGen) return;
        v.status = 'probing';
        await probeVideo(v);
        if (gen !== probeGen) return;
        done++;
        updateRow(v);
        renderSourceProgress(done, list.length);
        if (!state.activeId && v.status === 'ok') selectVideo(v.id);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (gen !== probeGen) return;
    state.scanning = false;
    if (!state.activeId) {
      const first = state.videos.find((v) => v.status === 'ok');
      if (first) selectVideo(first.id);
    }
    renderSourceProgress(list.length, list.length);
    renderAll();
  }
  let probeGen = 0;

  // ---------------------------------------------------------------- thumbnails
  const thumbQueue = [];
  let thumbBusy = 0;
  const thumbObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        thumbObserver.unobserve(e.target);
        const v = state.byId.get(e.target.dataset.id);
        if (v) queueThumb(v);
      }
    }, { root: null, rootMargin: '300px 0px' })
    : null;

  function queueThumb(v) {
    if (v.thumb || v.thumbQueued || v.status !== 'ok') return;
    v.thumbQueued = true;
    thumbQueue.push(v);
    pumpThumbs();
  }
  function pumpThumbs() {
    while (thumbBusy < 2 && thumbQueue.length) {
      const v = thumbQueue.shift();
      thumbBusy++;
      makeThumb(v).catch(() => {}).finally(() => { thumbBusy--; pumpThumbs(); });
    }
  }
  async function makeThumb(v) {
    const file = await getFile(v);
    const input = openInput(file);
    try {
      const vt = await input.getPrimaryVideoTrack();
      const tw = 128, th = 72;
      const { W, H } = v.info;
      const s = Math.max(tw / W, th / H);
      const sw = even(W * s), sh = even(H * s);
      const sink = new MB.CanvasSink(vt, { width: sw, height: sh, fit: 'fill', poolSize: 1 });
      const t0 = await vt.getFirstTimestamp();
      const r = await sink.getCanvas(t0 + Math.min(v.info.dur * 0.2, 3));
      if (!r) return;
      const c = document.createElement('canvas');
      c.width = tw; c.height = th;
      c.getContext('2d').drawImage(r.canvas, (tw - sw) / 2, (th - sh) / 2, sw, sh);
      v.thumb = c;
      const row = rowEl(v.id);
      if (row) paintThumb(row.querySelector('.vthumb'), v);
    } finally {
      input.dispose();
    }
  }
  function paintThumb(el, v) {
    if (!el) return;
    if (v.thumb) {
      const c = document.createElement('canvas');
      c.width = v.thumb.width; c.height = v.thumb.height;
      c.getContext('2d').drawImage(v.thumb, 0, 0);
      el.replaceChildren(c);
    }
  }

  // ---------------------------------------------------------------- preview
  const preview = { sess: null, raf: 0, renderer: null, rendererKey: '' };

  function previewSize(W, H) {
    const s = Math.min(1, PREVIEW_MAX / Math.max(W, H));
    return { pw: even(W * s), ph: even(H * s) };
  }

  async function openPreview(v) {
    closePreview();
    if (!v || v.status !== 'ok') return;
    const { pw, ph } = previewSize(v.info.W, v.info.H);
    const sess = { v, pw, ph, input: null, sink: null, t0: 0, dur: v.info.dur, t: 0, busy: false, pending: null, hasFrame: false };
    sess.src = makeCanvas(pw, ph);
    sess.sctx = sess.src.getContext('2d', { alpha: false });
    preview.sess = sess;
    setStageBusy(true);
    try {
      const file = await getFile(v);
      sess.input = openInput(file);
      const vt = await sess.input.getPrimaryVideoTrack();
      if (preview.sess !== sess) return;
      sess.t0 = await vt.getFirstTimestamp();
      sess.sink = new MB.CanvasSink(vt, { width: pw, height: ph, fit: 'fill', poolSize: 2 });
      layoutStage();
      const startAt = clamp(v.lastT != null ? v.lastT : Math.min(sess.dur * 0.25, 2), 0, Math.max(0, sess.dur - 0.05));
      $('scrubRange').value = String(Math.round((startAt / Math.max(0.001, sess.dur)) * 1000));
      $('tcDur').textContent = fmtTime(sess.dur);
      await seekPreview(startAt);
    } catch (e) {
      if (preview.sess === sess) {
        setStageBusy(false);
        v.status = 'bad';
        v.error = friendlyError(e, 'probe');
        updateRow(v);
        renderAll();
      }
    }
  }

  function closePreview() {
    const s = preview.sess;
    preview.sess = null;
    preview.renderer = null;
    preview.rendererKey = '';
    if (s && s.input) { try { s.input.dispose(); } catch { /* ignore */ } }
  }

  async function seekPreview(t) {
    const sess = preview.sess;
    if (!sess || !sess.sink) return;
    sess.pending = t;
    $('tcNow').textContent = fmtTime(t);
    if (sess.busy) return;
    sess.busy = true;
    setStageBusy(true);
    try {
      while (sess.pending != null && preview.sess === sess) {
        const tt = sess.pending;
        sess.pending = null;
        let r = null;
        try { r = await sess.sink.getCanvas(sess.t0 + tt); } catch { r = null; }
        if (preview.sess !== sess) return;
        if (!r && tt > 0) { try { r = await sess.sink.getCanvas(sess.t0); } catch { r = null; } }
        if (preview.sess !== sess) return;
        if (r) {
          sess.sctx.drawImage(r.canvas, 0, 0, sess.pw, sess.ph);
          sess.hasFrame = true;
          sess.t = tt;
          sess.v.lastT = tt;
          drawPreview();
        }
      }
    } finally {
      sess.busy = false;
      if (preview.sess === sess) setStageBusy(false);
    }
  }

  function previewPlan() {
    const sess = preview.sess;
    if (!sess) return null;
    const ov = overlayActive() ? state.settings.overlay : null;
    return computePlan(boxesFor(sess.v.info.shape), ov, ov ? state.asset.aspect : 0, sess.pw, sess.ph);
  }

  function drawPreview() {
    if (preview.raf) return;
    preview.raf = requestAnimationFrame(() => { preview.raf = 0; drawPreviewNow(); });
  }
  function drawPreviewNow() {
    const sess = preview.sess;
    if (!sess || !sess.hasFrame) return;
    const view = $('view');
    if (view.width !== sess.pw || view.height !== sess.ph) { view.width = sess.pw; view.height = sess.ph; }
    const vctx = view.getContext('2d', { alpha: false });
    const plan = previewPlan();
    sess.plan = plan;
    if (state.view === 'original') {
      vctx.drawImage(sess.src, 0, 0);
    } else {
      const key = JSON.stringify([plan.W, plan.H, plan.crop, plan.regions]);
      if (!preview.renderer || preview.rendererKey !== key) {
        preview.renderer = new FrameRenderer(plan, null);
        preview.rendererKey = key;
      }
      const r = preview.renderer;
      r.plan = plan;
      r.logo = plan.ov ? { asset: state.asset } : null;
      const out = r.render((c, dx, dy, dw, dh) => c.drawImage(sess.src, dx, dy, dw, dh));
      vctx.drawImage(out, 0, 0);
    }
    renderLayer();
    renderStageHint();
  }

  // ---------------------------------------------------------------- sample video
  function drawSampleScene(ctx, W, H, t) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2b5876'); g.addColorStop(0.55, '#f0a868'); g.addColorStop(1, '#f6d6a8');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // sun
    const sx = W * 0.22 + t * 18, sy = H * 0.42 - Math.sin(t * 0.5) * 10;
    const sg = ctx.createRadialGradient(sx, sy, 10, sx, sy, 150);
    sg.addColorStop(0, 'rgba(255,240,200,1)'); sg.addColorStop(0.35, 'rgba(255,214,150,0.9)'); sg.addColorStop(1, 'rgba(255,200,140,0)');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(sx, sy, 150, 0, Math.PI * 2); ctx.fill();
    // hills (parallax)
    const hills = [['#55707a', 0.62, 60, 0.004, 14], ['#3c5a5d', 0.7, 50, 0.006, 30], ['#26403f', 0.8, 40, 0.009, 55]];
    for (const [col, base, amp, freq, speed] of hills) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 16) {
        const xx = x + t * speed;
        ctx.lineTo(x, H * base - Math.sin(xx * freq) * amp - Math.sin(xx * freq * 2.7 + 1) * amp * 0.35);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    }
    // birds
    ctx.strokeStyle = 'rgba(30,40,45,0.8)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const bx = ((t * (90 + i * 25) + i * 260) % (W + 200)) - 100, by = H * (0.2 + i * 0.07) + Math.sin(t * 2 + i) * 12;
      const f = Math.sin(t * 9 + i * 2) * 8;
      ctx.beginPath(); ctx.moveTo(bx - 16, by - f); ctx.quadraticCurveTo(bx - 6, by - 6, bx, by); ctx.quadraticCurveTo(bx + 6, by - 6, bx + 16, by - f); ctx.stroke();
    }
    // the old watermark: a round mark and "OLD BRAND" in the bottom-right corner
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 6;
    ctx.font = '800 38px "Segoe UI", "Helvetica Neue", Arial, sans-serif';
    ctx.textBaseline = 'alphabetic';
    const label = 'OLD BRAND';
    const tw = ctx.measureText(label).width;
    const x = W - 44 - tw, y = H - 46;
    ctx.fillText(label, x, y);
    ctx.beginPath(); ctx.arc(x - 30, y - 14, 17, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath(); ctx.arc(x - 30, y - 14, 8, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  async function makeSampleVideo(onProgress) {
    const W = 1280, H = 720, FPS = 30, DUR = 6;
    const codec = await MB.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1', 'vp8'], { width: W, height: H });
    if (!codec) throw new UserError('This browser can’t create videos.');
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false });
    const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
    const src = new MB.CanvasSource(canvas, { codec, quality: new MB.Quality({ bitrate: 4e6 }), keyFrameInterval: 1 });
    output.addVideoTrack(src, { frameRate: FPS });
    await output.start();
    const n = FPS * DUR;
    for (let i = 0; i < n; i++) {
      drawSampleScene(ctx, W, H, i / FPS);
      await src.add(i / FPS, 1 / FPS);
      if (i % 10 === 0) onProgress(i / n);
    }
    src.close();
    await output.finalize();
    return new File([output.target.buffer], 'Sample video.mp4', { type: 'video/mp4', lastModified: Date.now() });
  }

  // ---------------------------------------------------------------- icons
  const ICON = {
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor" stroke="none"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    bad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
    skip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>',
  };

  // ---------------------------------------------------------------- source and list
  function okVideos() { return state.videos.filter((v) => v.status === 'ok'); }

  function renderSource() {
    const src = state.source;
    $('srcEmpty').hidden = !!src;
    $('srcLoaded').hidden = !src;
    $('optSub').checked = state.settings.includeSub;
    if (!src) return;
    $('srcName').textContent = src.name;
    const total = state.videos.length;
    const ok = okVideos().length;
    const bad = state.videos.filter((v) => v.status === 'bad').length;
    const bytes = state.videos.reduce((a, v) => a + (v.size || 0), 0);
    const parts = [];
    if (src.kind === 'sample') parts.push('Made on this computer for practice');
    else if (state.scanning && !total) parts.push('Looking for videos…');
    else {
      parts.push(plural(total, 'video'));
      if (bytes) parts.push(fmtBytes(bytes));
      if (!state.scanning && bad) parts.push(`${bad} can’t be read`);
      if (!state.scanning && ok && ok !== total && !bad) parts.push(`${ok} ready`);
    }
    $('srcMeta').textContent = parts.join(' · ');
    const notes = [];
    if (src.kind !== 'sample' && !state.scanning && !total) notes.push('No videos found here. Supported: MP4, MOV, M4V, WebM and MKV.');
    if (state.otherFiles) notes.push(`Skipped ${plural(state.otherFiles, 'file')} that ${state.otherFiles === 1 ? 'isn’t a video' : 'aren’t videos'}.`);
    if (state.copyFiles) notes.push(`Skipped ${plural(state.copyFiles, 'video')} this tool made earlier.`);
    $('srcNote').hidden = !notes.length;
    $('srcNote').textContent = notes.join(' ');
  }

  function renderSourceProgress(done, total, label) {
    const box = $('srcProgress');
    if (label != null) {
      box.hidden = false;
      $('srcBar').style.width = `${Math.round((done || 0) * 100)}%`;
      $('srcProgressText').textContent = label;
      return;
    }
    if (!total || done >= total) { box.hidden = true; renderSource(); return; }
    box.hidden = false;
    $('srcBar').style.width = `${Math.round((done / total) * 100)}%`;
    $('srcProgressText').textContent = `Checking videos… ${done.toLocaleString()} of ${total.toLocaleString()}`;
    if (done % 8 === 0) renderSource();
  }

  const rowEl = (id) => document.querySelector(`.vrow[data-id="${id}"]`);

  function rowMeta(v) {
    if (v.status === 'bad') return v.error;
    if (v.status === 'pending' || v.status === 'probing') return v.dir ? v.dir.replace(/\/$/, '') : 'Checking…';
    const i = v.info, bits = [];
    if (v.dir) bits.push(v.dir.replace(/\/$/, ''));
    bits.push(`${i.W}×${i.H}`, fmtTime(i.dur));
    if (v.size) bits.push(fmtBytes(v.size));
    return bits.join(' · ');
  }
  function rowStat(v) {
    const r = v.result;
    if (state.run && state.run.current === v) return ['run', '<span class="spinner" aria-hidden="true"></span>', 'Working on it'];
    if (r && r.status === 'done') return ['ok', ICON.ok, r.warn ? `Done. ${r.warn}` : 'Done'];
    if (r && r.status === 'skipped') return ['skip', ICON.skip, 'Skipped, a new copy already exists'];
    if (r && r.status === 'failed') return ['bad', ICON.bad, r.error];
    if (v.status === 'bad') return ['bad', ICON.bad, v.error];
    if (v.status === 'probing') return ['run', '<span class="spinner" aria-hidden="true"></span>', 'Checking'];
    return ['', '', ''];
  }

  function buildRow(v) {
    const li = document.createElement('li');
    li.className = 'vrow';
    li.dataset.id = v.id;
    li.tabIndex = 0;
    li.innerHTML = `<div class="vthumb">${ICON.film}</div><div class="vinfo"><div class="vname"></div><div class="vmeta"></div></div><div class="vstat"></div>`;
    li.querySelector('.vname').textContent = v.name;
    li.querySelector('.vname').title = v.path;
    fillRow(li, v);
    return li;
  }
  function fillRow(li, v) {
    li.classList.toggle('is-active', v.id === state.activeId);
    li.setAttribute('aria-current', v.id === state.activeId ? 'true' : 'false');
    const meta = li.querySelector('.vmeta');
    meta.textContent = rowMeta(v);
    meta.classList.toggle('bad', v.status === 'bad');
    meta.title = v.status === 'bad' && v.errorTip ? v.errorTip : '';
    const r = v.result;
    if (r && r.status === 'failed') { meta.textContent = r.error; meta.classList.add('bad'); }
    const [cls, icon, title] = rowStat(v);
    const st = li.querySelector('.vstat');
    st.className = `vstat ${cls}`;
    st.innerHTML = icon;
    st.title = title;
    if (title) st.setAttribute('aria-label', title); else st.removeAttribute('aria-label');
    if (v.thumb && !li.querySelector('.vthumb canvas')) paintThumb(li.querySelector('.vthumb'), v);
    if (v.status === 'ok' && !v.thumb && thumbObserver && !li.dataset.obs) { li.dataset.obs = '1'; thumbObserver.observe(li); }
  }
  function renderList() {
    const ul = $('vlist');
    const frag = document.createDocumentFragment();
    for (const v of state.videos) frag.append(buildRow(v));
    ul.replaceChildren(frag);
  }
  function updateRow(v) {
    const li = rowEl(v.id);
    if (li) fillRow(li, v);
  }

  // ---------------------------------------------------------------- stage
  function setStageBusy(on) { $('stageBusy').hidden = !on; }

  function layoutStage() {
    const sess = preview.sess;
    const has = !!sess;
    const wrap = $('stageWrap');
    $('stage').hidden = !has;
    $('stageEmpty').hidden = has;
    $('scrub').hidden = !has;
    if (!has) { wrap.style.height = ''; return; }
    // Fit the preview area to the video's shape, so there are no big empty bars.
    const pad = 24;
    const aw = Math.max(50, wrap.clientWidth - pad);
    const maxH = window.innerWidth <= 900 ? window.innerHeight * 0.56 : Math.min(window.innerHeight * 0.64, 640);
    const h = Math.round(clamp((aw * sess.ph) / sess.pw + pad, 240, Math.max(240, maxH)));
    if (wrap.style.height !== `${h}px`) wrap.style.height = `${h}px`;
    const ah = Math.max(50, h - pad);
    const s = Math.min(aw / sess.pw, ah / sess.ph);
    $('stage').style.width = `${Math.floor(sess.pw * s)}px`;
    $('stage').style.height = `${Math.floor(sess.ph * s)}px`;
  }

  function shapeGroups() {
    const m = new Map();
    for (const v of state.videos) {
      if (v.status !== 'ok') continue;
      const k = v.info.shape;
      if (!m.has(k)) m.set(k, { key: k, count: 0, first: v });
      m.get(k).count++;
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }

  function renderStageHead() {
    const v = activeVideo();
    $('stageName').textContent = v ? v.name : 'Preview';
    $('stageName').title = v ? v.path : '';
    $('stageMeta').textContent = v && v.info ? `${v.info.W}×${v.info.H} · ${fmtTime(v.info.dur)}` : '';
    for (const b of document.querySelectorAll('[data-action="view"]')) {
      const on = b.dataset.view === state.view;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  function renderShapeNote() {
    const el = $('shapeNote');
    const groups = shapeGroups();
    const cur = activeShape();
    if (groups.length < 2 || !cur) { el.hidden = true; return; }
    el.hidden = false;
    const btns = groups.map((g) => {
      const n = boxesFor(g.key).length;
      const on = g.key === cur;
      return `<button type="button" class="btn btn-outline btn-sm${on ? ' is-on' : ''}" data-action="shape" data-shape="${esc(g.key)}" aria-pressed="${on}">${esc(shapeLabel(g.key))} · ${plural(g.count, 'video')} · ${n ? plural(n, 'box', 'boxes') : 'no boxes yet'}</button>`;
    }).join('');
    el.innerHTML = `<span>Your videos come in ${groups.length} shapes. Boxes are set for each shape separately.</span>${btns}`;
  }

  function stageHintText() {
    const sess = preview.sess;
    if (!sess) return '';
    const plan = sess.plan;
    const boxes = boxesFor(sess.v.info.shape);
    if (plan && plan.cropFailed) return 'Crop out can’t cut off this box without cropping too much. Try Fill instead.';
    if (plan && plan.zoom > 1.45 && state.view === 'result') return `Crop out zooms in ${plan.zoom.toFixed(1)}×. It works best for logos at the very edge.`;
    if (state.view === 'original') {
      if (boxes.length) return 'This is the untouched video. Check that each box covers the whole old logo.';
      return 'This is the untouched video.';
    }
    if (!boxes.length) {
      if (state.source && state.source.kind === 'sample') return 'Drag a box around “OLD BRAND” in the bottom-right corner.';
      return 'Drag a box over the old logo. Make it a little bigger than the logo.';
    }
    if (!state.scrubbed) return 'Drag the timeline to check a few moments. If the logo moves, make the box bigger.';
    return '';
  }
  function renderStageHint() {
    const t = stageHintText();
    $('stageHint').hidden = !t;
    $('stageHint').textContent = t;
  }

  function viewCrop() {
    const sess = preview.sess;
    const plan = sess && sess.plan;
    if (state.view !== 'result' || !plan || !plan.crop) return null;
    return { x: plan.crop.x / plan.W, y: plan.crop.y / plan.H, w: plan.crop.w / plan.W, h: plan.crop.h / plan.H };
  }

  const pct = (n) => `${(n * 100).toFixed(3)}%`;
  function renderLayer() {
    const layer = $('layer');
    const sess = preview.sess;
    if (!sess || !sess.hasFrame) { layer.replaceChildren(); return; }
    const plan = sess.plan;
    const boxes = boxesFor(sess.v.info.shape);
    const cr = drag && drag.cr !== undefined ? drag.cr : viewCrop();
    layer.classList.toggle('is-clipped', !!cr);
    const frag = document.createDocumentFragment();
    const ovr = state.view === 'result' && plan && plan.ov
      ? { x: plan.ov.x / plan.W, y: plan.ov.y / plan.H, w: plan.ov.w / plan.W, h: plan.ov.h / plan.H } : null;
    const hits = (a, o) => o && a.x < o.x + o.w && o.x < a.x + a.w && a.y < o.y + o.h && o.y < a.y + a.h;
    boxes.forEach((b, i) => {
      if (state.view === 'result' && b.method === 'crop') return;
      let r = b;
      if (cr) r = { x: (b.x - cr.x) / cr.w, y: (b.y - cr.y) / cr.h, w: b.w / cr.w, h: b.h / cr.h };
      const sel = state.sel && state.sel.type === 'box' && state.sel.id === b.id;
      const el = document.createElement('div');
      // In the Result view the new logo matters most, so a box label that would cover it is hidden.
      const quiet = !sel && hits(r, ovr);
      el.className = `bx${sel ? ' is-sel' : ''}${b.method === 'crop' ? ' is-crop' : ''}${r.y < 0.08 ? ' label-below' : ''}${quiet ? ' label-off' : ''}`;
      el.dataset.box = b.id;
      el.style.left = pct(r.x); el.style.top = pct(r.y); el.style.width = pct(r.w); el.style.height = pct(r.h);
      el.innerHTML = `<span class="bx-label">${i + 1} · ${esc(METHODS[b.method].label)}</span>${sel ? ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<span class="hd" data-h="${h}"></span>`).join('') : ''}`;
      frag.append(el);
    });
    if (state.view === 'result' && plan && plan.ov) {
      const o = plan.ov;
      const sel = state.sel && state.sel.type === 'ov';
      const el = document.createElement('div');
      el.className = `ov${sel ? ' is-sel' : ''}${o.y / plan.H < 0.08 ? ' label-below' : ''}`;
      el.dataset.ov = '1';
      el.style.left = pct(o.x / plan.W); el.style.top = pct(o.y / plan.H); el.style.width = pct(o.w / plan.W); el.style.height = pct(o.h / plan.H);
      el.innerHTML = `<span class="ov-label">New logo</span>${sel ? ['nw', 'ne', 'se', 'sw'].map((h) => `<span class="hd" data-h="${h}"></span>`).join('') : ''}`;
      frag.append(el);
    }
    layer.replaceChildren(frag);
  }

  // ---------------------------------------------------------------- drawing and dragging on the preview
  let drag = null;

  function layerPoint(e) {
    const r = $('layer').getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1), sx: e.clientX, sy: e.clientY, scale: r.width };
  }
  const toFrame = (p, cr) => (cr ? { x: cr.x + p.x * cr.w, y: cr.y + p.y * cr.h } : { x: p.x, y: p.y });

  function onLayerDown(e) {
    const sess = preview.sess;
    if (e.button !== 0 || !sess || !sess.hasFrame || state.run) return;
    const pt = layerPoint(e);
    const hd = e.target.closest('.hd');
    const bx = e.target.closest('.bx');
    const ovEl = e.target.closest('.ov');
    const shape = sess.v.info.shape;
    const cr = viewCrop();
    if (ovEl && sess.plan && sess.plan.ov) {
      const p = sess.plan, o = p.ov;
      state.sel = { type: 'ov' };
      drag = { mode: hd ? 'ov-resize' : 'ov-move', handle: hd ? hd.dataset.h : null, start: pt, cr, W: p.W, H: p.H, o: { ...o } };
    } else if (bx) {
      const b = boxesFor(shape).find((x) => x.id === bx.dataset.box);
      if (!b) return;
      state.sel = { type: 'box', id: b.id };
      drag = { mode: hd ? 'resize' : 'move', handle: hd ? hd.dataset.h : null, id: b.id, start: toFrame(pt, cr), orig: { ...b }, cr };
    } else {
      drag = { mode: 'draw', start: toFrame(pt, cr), screen: pt, id: null, cr };
      state.sel = null;
    }
    e.preventDefault();
    drag.pointerId = e.pointerId;
    $('layer').setPointerCapture(e.pointerId);
    renderLayer();
    renderBoxPanel();
  }

  function onLayerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const sess = preview.sess;
    if (!sess) { drag = null; return; }
    const pt = layerPoint(e);
    const shape = sess.v.info.shape;
    const boxes = boxesFor(shape);
    const minW = 6 / sess.pw, minH = 6 / sess.ph;
    if (drag.mode === 'draw') {
      const p = toFrame(pt, drag.cr);
      if (!drag.id) {
        if (Math.hypot(pt.sx - drag.screen.sx, pt.sy - drag.screen.sy) < 6) return;
        if (boxes.length >= MAX_BOXES) { toast(`You can use up to ${MAX_BOXES} boxes.`); drag = null; return; }
        const b = { id: uid(), x: drag.start.x, y: drag.start.y, w: minW, h: minH, method: 'fill' };
        setBoxesFor(shape, [...boxes, b]);
        drag.id = b.id;
        state.sel = { type: 'box', id: b.id };
      }
      const b = boxesFor(shape).find((x) => x.id === drag.id);
      b.x = Math.min(drag.start.x, p.x); b.y = Math.min(drag.start.y, p.y);
      b.w = Math.max(minW, Math.abs(p.x - drag.start.x)); b.h = Math.max(minH, Math.abs(p.y - drag.start.y));
      b.w = Math.min(b.w, 1 - b.x); b.h = Math.min(b.h, 1 - b.y);
    } else if (drag.mode === 'move' || drag.mode === 'resize') {
      const b = boxes.find((x) => x.id === drag.id);
      if (!b) { drag = null; return; }
      const p = toFrame(pt, drag.cr), o = drag.orig;
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (drag.mode === 'move') {
        b.x = clamp(o.x + dx, 0, 1 - o.w); b.y = clamp(o.y + dy, 0, 1 - o.h);
      } else {
        let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
        const h = drag.handle;
        if (h.includes('w')) x0 = clamp(o.x + dx, 0, 1);
        if (h.includes('e')) x1 = clamp(o.x + o.w + dx, 0, 1);
        if (h.includes('n')) y0 = clamp(o.y + dy, 0, 1);
        if (h.includes('s')) y1 = clamp(o.y + o.h + dy, 0, 1);
        b.x = Math.min(x0, x1); b.y = Math.min(y0, y1);
        b.w = Math.max(minW, Math.abs(x1 - x0)); b.h = Math.max(minH, Math.abs(y1 - y0));
        b.w = Math.min(b.w, 1 - b.x); b.h = Math.min(b.h, 1 - b.y);
      }
    } else if (drag.mode === 'ov-move') {
      moveOverlay(drag, pt);
    } else if (drag.mode === 'ov-resize') {
      resizeOverlay(drag, pt);
    }
    saveSettings();
    drawPreview();
  }

  function onLayerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    try { $('layer').releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (d.mode === 'draw' && !d.id) state.sel = null;
    saveSettings();
    renderAll();
  }

  function overlayTol(d, pt) { return (10 / pt.scale) * d.W; }

  function moveOverlay(d, pt) {
    const ov = state.settings.overlay;
    const W = d.W, H = d.H, o = d.o;
    let x = clamp(o.x + (pt.x - d.start.x) * W, 0, W - o.w);
    let y = clamp(o.y + (pt.y - d.start.y) * H, 0, H - o.h);
    const tol = overlayTol(d, pt);
    const mg = ov.margin * Math.min(W, H);
    let snapped = null;
    for (const a of ANCHORS) {
      const p = anchoredPos(a, o.w, o.h, W, H, mg);
      if (Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol) { snapped = a; break; }
    }
    const ap = preview.sess && preview.sess.plan && preview.sess.plan.anchorPoint;
    if (!snapped && ap && Math.abs(ap.x - o.w / 2 - x) < tol && Math.abs(ap.y - o.h / 2 - y) < tol) snapped = 'box';
    if (snapped) {
      ov.anchor = snapped;
    } else {
      ov.anchor = 'custom';
      ov.cx = (x + o.w / 2) / W;
      ov.cy = (y + o.h / 2) / H;
    }
    renderOverlayPanel();
  }

  function resizeOverlay(d, pt) {
    const ov = state.settings.overlay;
    const W = d.W, H = d.H, o = d.o, h = d.handle;
    const fx = h.includes('w') ? o.x + o.w : o.x, fy = h.includes('n') ? o.y + o.h : o.y;
    const px = pt.x * W, py = pt.y * H;
    const s = Math.max(Math.abs(px - fx) / o.w, Math.abs(py - fy) / o.h);
    const m = Math.min(W, H);
    const long0 = Math.max(o.w, o.h);
    const size = clamp((long0 * s) / m, 0.02, 0.9);
    const k = (size * m) / long0;
    const nw = o.w * k, nh = o.h * k;
    const nx = h.includes('w') ? fx - nw : fx, ny = h.includes('n') ? fy - nh : fy;
    ov.size = size;
    const mg = ov.margin * m, tol = overlayTol(d, pt);
    if (ANCHORS.includes(ov.anchor)) {
      const p = anchoredPos(ov.anchor, nw, nh, W, H, mg);
      if (Math.abs(p.x - nx) < tol && Math.abs(p.y - ny) < tol) { renderOverlayPanel(); return; }
    }
    ov.anchor = 'custom';
    ov.cx = clamp((nx + nw / 2) / W, 0, 1);
    ov.cy = clamp((ny + nh / 2) / H, 0, 1);
    renderOverlayPanel();
  }

  function onKey(e) {
    if (state.run || $('runDialog').open) return;
    const t = e.target;
    const tag = (t && t.tagName) || '';
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag) || (t && t.isContentEditable) || (t && t.closest && t.closest('#vlist'))) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const sess = preview.sess;
    if (!sess || !state.sel) return;
    const shape = sess.v.info.shape;
    if (e.key === 'Escape') { state.sel = null; renderAll(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel.type === 'box') {
      e.preventDefault();
      removeBox(state.sel.id);
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!arrows[e.key]) return;
    e.preventDefault();
    const [ax, ay] = arrows[e.key];
    const step = e.shiftKey ? 10 : 1;
    if (state.sel.type === 'box') {
      const b = boxesFor(shape).find((x) => x.id === state.sel.id);
      if (!b) return;
      b.x = clamp(b.x + (ax * step) / sess.pw, 0, 1 - b.w);
      b.y = clamp(b.y + (ay * step) / sess.ph, 0, 1 - b.h);
    } else if (state.sel.type === 'ov' && sess.plan && sess.plan.ov) {
      const o = sess.plan.ov, ov = state.settings.overlay;
      ov.anchor = 'custom';
      ov.cx = clamp((o.x + o.w / 2 + ax * step) / sess.pw, 0, 1);
      ov.cy = clamp((o.y + o.h / 2 + ay * step) / sess.ph, 0, 1);
      renderOverlayPanel();
    }
    saveSettings();
    drawPreview();
  }

  function removeBox(id) {
    const shape = activeShape();
    setBoxesFor(shape, boxesFor(shape).filter((b) => b.id !== id));
    if (state.sel && state.sel.id === id) state.sel = null;
    renderAll();
  }

  // ---------------------------------------------------------------- settings panels
  function renderBoxPanel() {
    const v = activeVideo();
    const shape = activeShape();
    const boxes = boxesFor(shape);
    const multi = shapeGroups().length > 1;
    const empty = $('boxEmpty');
    empty.hidden = boxes.length > 0;
    if (!v) empty.textContent = 'Choose your videos first. Then drag on the preview to draw a box over the old logo.';
    else empty.textContent = `Drag on the preview to draw a box over the old logo. Make the box a little bigger than the logo.${multi ? ` These boxes are for ${shapeLabel(shape)} videos.` : ''}`;
    const ul = $('boxList');
    ul.replaceChildren(...boxes.map((b, i) => {
      const li = document.createElement('li');
      const sel = state.sel && state.sel.type === 'box' && state.sel.id === b.id;
      li.className = `brow${sel ? ' is-sel' : ''}${b.method === 'crop' ? ' is-crop' : ''}`;
      li.dataset.box = b.id;
      li.innerHTML = `<span class="bnum">${i + 1}</span>
        <select class="input" data-box-method="${b.id}" aria-label="How to remove box ${i + 1}">${Object.entries(METHODS).map(([k, m]) => `<option value="${k}"${k === b.method ? ' selected' : ''}>${m.label}</option>`).join('')}</select>
        <button type="button" class="icon-btn" data-action="remove-box" data-box="${b.id}" aria-label="Remove box ${i + 1}" title="Remove box">${ICON.trash}</button>`;
      return li;
    }));
    const selBox = boxes.find((b) => state.sel && state.sel.type === 'box' && state.sel.id === b.id) || boxes[0];
    $('methodHelp').hidden = !selBox;
    $('methodHelp').textContent = selBox ? METHODS[selBox.method].help + (multi && boxes.length ? ` These boxes are for ${shapeLabel(shape)} videos.` : '') : '';
    $('boxActions').hidden = !boxes.length;
    const add = document.querySelector('[data-action="add-box"]');
    if (add) add.disabled = boxes.length >= MAX_BOXES || !v;
  }

  function renderOverlayPanel() {
    const o = state.settings.overlay;
    for (const b of document.querySelectorAll('[data-action="ov-kind"]')) {
      const on = b.dataset.kind === o.kind;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    $('ovImage').hidden = o.kind !== 'image';
    $('ovText').hidden = o.kind !== 'text';
    $('ovPlace').hidden = o.kind === 'none';
    const lf = $('logoFile');
    const img = state.imageAsset;
    if (img) {
      lf.hidden = false;
      if (!lf.dataset.name || lf.dataset.name !== img.name || !lf.querySelector('img')) {
        lf.dataset.name = img.name;
        lf.innerHTML = `<div class="lf-thumb"><img alt=""></div><div style="min-width:0"><div class="lf-name"></div><div class="lf-meta"></div></div><button type="button" class="icon-btn" data-action="remove-logo" aria-label="Remove logo image" title="Remove">${ICON.close}</button>`;
        lf.querySelector('img').src = img.previewUrl || '';
        lf.querySelector('.lf-name').textContent = img.name;
        lf.querySelector('.lf-meta').textContent = img.isSvg ? 'SVG image' : `${img.width}×${img.height}`;
      }
      $('pickLogoBtn').textContent = 'Choose another image';
    } else {
      lf.hidden = true;
      lf.dataset.name = '';
      $('pickLogoBtn').textContent = 'Choose logo image';
    }
    if (document.activeElement !== $('txtValue')) $('txtValue').value = o.text.value;
    $('txtFont').value = o.text.font;
    $('txtColor').value = o.text.color;
    $('txtShadow').checked = o.text.shadow;
    for (const b of document.querySelectorAll('[data-action="anchor"]')) {
      const on = b.dataset.anchor === o.anchor;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const hasFillBox = boxesFor(activeShape()).some((b) => b.method !== 'crop');
    $('anchorBoxBtn').disabled = !hasFillBox;
    $('anchorBoxBtn').title = hasFillBox ? 'Put the new logo where box 1 is' : 'Draw a box over the old logo first';
    const set = (id, val, txt) => { if (document.activeElement !== $(id)) $(id).value = String(val); $(`${id}Out`).textContent = txt; };
    set('ovSize', Math.round(o.size * 100), `${Math.round(o.size * 100)}%`);
    set('ovOpacity', Math.round(o.opacity * 100), `${Math.round(o.opacity * 100)}%`);
    set('ovMargin', Math.round(o.margin * 100), `${Math.round(o.margin * 100)}%`);
  }

  function outTargetText() {
    const src = state.source;
    if (src && src.kind === 'sample') return 'Shown here when it’s ready, with a download button.';
    if (!HAS_FSA) return 'Each new video downloads when it’s ready.';
    if (state.outDir) {
      return state.outSame
        ? `The “${state.outDir.name}” folder, next to your videos. New copies get “(rebranded)” in the name.`
        : `The “${state.outDir.name}” folder. Subfolders are kept.`;
    }
    return src ? `A new “${OUT_DIR_NAME}” folder inside “${src.name}”. Subfolders are kept.` : `A new “${OUT_DIR_NAME}” folder inside your folder`;
  }

  function renderSavePanel() {
    const src = state.source;
    const sample = !!src && src.kind === 'sample';
    $('outTarget').textContent = outTargetText();
    $('pickOutBtn').hidden = !HAS_FSA || sample;
    $('resetOutBtn').hidden = !state.outDir || sample;
    $('existingField').hidden = !HAS_FSA || sample;
    $('rightsField').hidden = sample;
    $('optQuality').value = state.settings.quality;
    $('optExisting').value = state.settings.existing;
    $('optRights').checked = state.settings.rightsOk;
    const n = okVideos().length;
    const btn = $('startBtn');
    btn.disabled = !state.supported || !n || state.scanning || !!state.run;
    btn.textContent = sample ? 'Make the new video' : n ? `Start · ${plural(n, 'video')}` : 'Start';
    const bad = state.videos.filter((v) => v.status === 'bad').length;
    let hint = 'Saves MP4 copies. Your original videos are never changed.';
    if (sample) hint = 'Makes a new MP4 from the sample. Nothing is uploaded.';
    else if (state.scanning) hint = 'Checking your videos first…';
    else if (bad) hint = `${plural(bad, 'video')} can’t be read and will be skipped. ${hint}`;
    $('startHint').textContent = hint;
  }

  function renderAll() {
    renderSource();
    renderStageHead();
    renderShapeNote();
    renderBoxPanel();
    renderOverlayPanel();
    renderSavePanel();
    layoutStage();
    if (preview.sess && preview.sess.hasFrame) drawPreview();
    else { renderLayer(); renderStageHint(); }
  }

  // ---------------------------------------------------------------- choosing videos
  function resetSource() {
    probeGen++;
    closePreview();
    thumbQueue.length = 0;
    state.source = null;
    state.videos = [];
    state.byId = new Map();
    state.activeId = null;
    state.sel = null;
    state.otherFiles = 0;
    state.copyFiles = 0;
    state.scanning = false;
    state.scrubbed = false;
    $('vlist').replaceChildren();
    $('srcProgress').hidden = true;
  }

  function selectVideo(id) {
    const v = state.byId.get(id);
    if (!v || v.status !== 'ok') return;
    const prev = state.activeId;
    state.activeId = id;
    if (prev !== id) state.sel = null;
    if (prev) updateRow(state.byId.get(prev) || v);
    updateRow(v);
    renderAll();
    if (!preview.sess || preview.sess.v !== v) openPreview(v);
  }

  async function pickFolder() {
    let dir;
    try {
      dir = await window.showDirectoryPicker({ id: 'vr-videos', mode: 'read' });
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('That folder can’t be opened. Try another one.');
      return;
    }
    await loadFolder(dir);
  }

  async function loadFolder(dir) {
    resetSource();
    state.outDir = null;
    state.outSame = false;
    state.source = { kind: 'folder', name: dir.name, handle: dir };
    state.scanning = true;
    renderAll();
    renderSourceProgress(0, 0, 'Looking for videos…');
    const gen = probeGen;
    let res;
    try {
      res = await walkFolder(dir, state.settings.includeSub, [], (n) => {
        if (gen === probeGen) renderSourceProgress(0, 0, `Looking for videos… ${n.toLocaleString()} found`);
      });
    } catch {
      res = { found: [], others: 0, copies: 0 };
    }
    if (gen !== probeGen) return;
    state.otherFiles = res.others;
    state.copyFiles = res.copies;
    addVideos(res.found);
    renderList();
    if (!res.found.length) {
      state.scanning = false;
      $('srcProgress').hidden = true;
      renderAll();
      return;
    }
    renderAll();
    await probeAll();
  }

  async function loadFiles(files) {
    const list = [...files].filter((f) => VIDEO_EXT.has((f.name.split('.').pop() || '').toLowerCase()));
    if (!list.length) { toast('Those files aren’t videos this tool can read.'); return; }
    resetSource();
    state.source = { kind: 'files', name: list.length === 1 ? list[0].name : `${list.length} videos` };
    state.otherFiles = files.length - list.length;
    list.sort((a, b) => collator.compare(a.name, b.name));
    addVideos(list.map((f) => ({ name: f.name, dir: '', path: f.name, file: f })));
    renderList();
    renderAll();
    await probeAll();
  }

  async function loadSample() {
    resetSource();
    state.source = { kind: 'sample', name: 'Sample video' };
    state.scanning = true;
    renderAll();
    renderSourceProgress(0, 0, 'Making a sample video…');
    const gen = probeGen;
    let file;
    try {
      file = await makeSampleVideo((p) => { if (gen === probeGen) renderSourceProgress(p, 0, 'Making a sample video…'); });
    } catch (e) {
      if (gen !== probeGen) return;
      resetSource();
      renderAll();
      toast(e instanceof UserError ? e.message : 'The sample video couldn’t be made in this browser.');
      return;
    }
    if (gen !== probeGen) return;
    addVideos([{ name: 'Sample video.mp4', dir: '', path: 'Sample video.mp4', file }]);
    renderList();
    await probeAll();
  }

  // ---------------------------------------------------------------- new logo
  async function fileToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  async function storableDataUrl(blob, asset) {
    if (blob.size <= 1.5 * 1024 * 1024 || asset.isSvg) return fileToDataUrl(blob);
    const s = Math.min(1, 1600 / Math.max(asset.width, asset.height));
    const w = Math.max(1, Math.round(asset.width * s)), h = Math.max(1, Math.round(asset.height * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    asset.drawSync(c.getContext('2d'), 0, 0, w, h);
    return c.toDataURL('image/png');
  }

  async function useLogoFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|svg|gif|avif)$/i.test(file.name)) { toast('Please choose an image file, like a PNG.'); return; }
    let asset;
    try { asset = await makeImageAsset(file, file.name); } catch (e) { toast(e instanceof UserError ? e.message : 'This image can’t be opened.'); return; }
    asset.previewUrl = URL.createObjectURL(file);
    if (state.imageAsset && state.imageAsset.previewUrl && state.imageAsset.previewUrl.startsWith('blob:')) URL.revokeObjectURL(state.imageAsset.previewUrl);
    state.imageAsset = asset;
    const o = state.settings.overlay;
    o.kind = 'image';
    try { o.image = { name: file.name, dataUrl: await storableDataUrl(file, asset) }; } catch { o.image = { name: file.name, dataUrl: null }; }
    syncAsset();
    saveSettings();
    renderAll();
  }

  async function restoreLogo() {
    const img = state.settings.overlay.image;
    if (!img || !img.dataUrl) return;
    try {
      const blob = await (await fetch(img.dataUrl)).blob();
      const asset = await makeImageAsset(blob, img.name);
      asset.previewUrl = img.dataUrl;
      state.imageAsset = asset;
      syncAsset();
      renderAll();
    } catch { /* forget it */ }
  }

  function syncAsset() {
    const o = state.settings.overlay;
    if (o.kind === 'image') state.asset = state.imageAsset || null;
    else if (o.kind === 'text') state.asset = makeTextAsset(o.text);
    else state.asset = null;
    if (!state.asset && state.sel && state.sel.type === 'ov') state.sel = null;
  }

  function fitLogoToBox() {
    const v = activeVideo();
    const b = boxesFor(activeShape()).find((x) => x.method !== 'crop');
    if (!v || !b || !state.asset) return;
    const W = v.info.W, H = v.info.H;
    const bw = b.w * W, bh = b.h * H, a = state.asset.aspect;
    let w = Math.min(bw, bh * a), h = w / a;
    w *= 0.92; h *= 0.92;
    state.settings.overlay.size = clamp(Math.max(w, h) / Math.min(W, H), 0.02, 0.9);
  }

  // ---------------------------------------------------------------- saving new copies
  function pickBitrate(info, W, H, q) {
    const [mult, floor] = QUALITY[q] || QUALITY.original;
    const fps = clamp(info.fps || 30, 10, 120);
    const px = W * H * fps;
    const src = info.bitrate || px * 0.1;
    let b = Math.max(src * mult, px * floor);
    if (q === 'smaller' && info.bitrate) b = Math.min(b, src * 0.85);
    return Math.round(clamp(b, 4e5, 8e7));
  }

  function planNames(list, prefix) {
    // prefix: where the output folder sits inside the source folder ('' = same folder), or null if outside it.
    const sources = new Set(state.videos.map((v) => v.path.toLowerCase()));
    const used = new Set();
    const same = prefix === '';
    for (const v of list) {
      const base = v.name.replace(/\.[^.]+$/, '') || 'video';
      let name;
      for (let i = 0; ; i++) {
        const tag = same ? (i ? ` (rebranded ${i + 1})` : ' (rebranded)') : (i ? (i === 1 ? ' (rebranded)' : ` (rebranded ${i})`) : '');
        name = `${base}${tag}.mp4`;
        const rel = (v.dir + name).toLowerCase();
        if (used.has(rel)) continue;
        if (prefix !== null && sources.has((prefix + v.dir + name).toLowerCase())) continue;
        break;
      }
      used.add((v.dir + name).toLowerCase());
      v.outName = name;
    }
  }

  async function outFolder(run, dirPath) {
    if (run.dirs.has(dirPath)) return run.dirs.get(dirPath);
    let d = run.root;
    const parts = dirPath.split('/').filter(Boolean);
    let acc = '';
    for (const p of parts) {
      acc += `${p}/`;
      if (run.dirs.has(acc)) { d = run.dirs.get(acc); continue; }
      d = await d.getDirectoryHandle(p, { create: true });
      run.dirs.set(acc, d);
    }
    run.dirs.set(dirPath, d);
    return d;
  }

  function videoReason(conv) {
    const d = conv.discardedTracks.find((x) => x.track.type === 'video');
    if (!d) return 'This video can’t be converted.';
    if (d.reason === 'undecodable_source_codec' || d.reason === 'unknown_source_codec') return 'This browser can’t read this video’s format.';
    if (d.reason === 'no_encodable_target_codec') return 'This computer can’t encode a video of this size.';
    return 'This video can’t be converted.';
  }

  async function convertVideo(run, v, makeTarget) {
    const file = await getFile(v);
    const input = openInput(file);
    let out = null;
    try {
      const W = even(v.info.W), H = even(v.info.H);
      const ovCfg = overlayActive() ? state.settings.overlay : null;
      const plan = computePlan(boxesFor(v.info.shape), ovCfg, ovCfg ? state.asset.aspect : 0, W, H);
      let logo = null;
      if (plan.ov) logo = { bitmap: await state.asset.prepare(plan.ov.w, plan.ov.h), asset: state.asset };
      const renderer = new FrameRenderer(plan, logo);
      const bitrate = pickBitrate(v.info, W, H, state.settings.quality);
      const audioTrack = await input.getPrimaryAudioTrack().catch(() => null);
      const draw = (sample) => renderer.render((c, dx, dy, dw, dh) => sample.draw(c, dx, dy, dw, dh));
      let lastEnd = 0, frames = 0;
      const process = (sample) => {
        run.lastTick = performance.now();
        frames++;
        const end = (sample.timestamp || 0) + (sample.duration || 0);
        if (end > lastEnd) lastEnd = end;
        if (run.paused && run.gate) return run.gate.then(() => draw(sample));
        return draw(sample);
      };
      let conv = null;
      for (const codec of [run.codec, null]) {
        out = makeTarget();
        const output = new MB.Output({ format: new MB.Mp4OutputFormat(out.formatOptions || {}), target: out.target });
        out.bind(output);
        const video = {
          quality: new MB.Quality({ bitrate }), keyFrameInterval: 2, forceTranscode: true, allowTransformationMetadata: false,
          processedWidth: W, processedHeight: H, process,
        };
        if (codec) video.codec = codec;
        conv = await MB.Conversion.init({ input, output, tracks: 'primary', showWarnings: false, video, audio: {} });
        if (conv.isValid) break;
        const reason = (conv.discardedTracks.find((x) => x.track.type === 'video') || {}).reason;
        await out.cancelOutput();
        out = null;
        if (!(codec && reason === 'no_encodable_target_codec')) throw new UserError(videoReason(conv));
        conv = null;
      }
      if (!conv) throw new UserError('This computer can’t encode a video of this size.');
      const notes = [];
      if (audioTrack && conv.discardedTracks.some((x) => x.track === audioTrack)) notes.push('Saved without sound, because this sound format can’t be converted here.');
      run.conv = conv;
      run.lastTick = performance.now();
      conv.onProgress = (p) => { run.curProgress = clamp(p, 0, 1); run.lastTick = performance.now(); scheduleRunUI(); };
      try {
        await conv.execute();
      } finally {
        run.conv = null;
      }
      const result = await out.finish();
      const dur = v.info.dur || 0;
      if (!frames) throw new UserError('No picture could be read from this video. The file may be damaged.');
      if (dur - lastEnd > 0.25 && lastEnd < dur * 0.97) {
        notes.push(`Only the first ${fmtSpan(lastEnd)} of ${fmtSpan(dur)} could be read. The original file looks incomplete.`);
      }
      return { warn: notes.join(' '), ...result };
    } catch (e) {
      if (out) await out.cancelOutput();
      throw e;
    } finally {
      try { input.dispose(); } catch { /* ignore */ }
    }
  }

  const FINAL_STATES = new Set(['finalizing', 'finalized']);
  function fileTarget(fh) {
    // Each new video is written to a temporary file. It only replaces the real file once everything succeeded.
    const open = new Set();
    return {
      make() {
        let fsw = null, output = null;
        const get = async () => {
          if (!fsw) { fsw = await fh.createWritable(); open.add(fsw); }
          return fsw;
        };
        const ws = new WritableStream({
          write: async (c) => { const w = await get(); await w.write({ type: 'write', position: c.position, data: c.data }); },
          close: async () => {
            const ok = !!output && FINAL_STATES.has(output.state);
            if (!fsw && !ok) return;
            const w = await get();
            open.delete(w);
            if (ok) await w.close(); else await w.abort();
          },
          abort: async () => { if (fsw) { open.delete(fsw); try { await fsw.abort(); } catch { /* ignore */ } } },
        });
        return {
          target: new MB.StreamTarget(ws, { chunked: true }),
          bind(o) { output = o; },
          async cancelOutput() {
            try { if (output && !['canceled', 'finalized'].includes(output.state)) await output.cancel(); } catch { /* ignore */ }
          },
          async finish() { const f = await fh.getFile(); return { bytes: f.size }; },
        };
      },
      async abort() {
        for (const w of open) { try { await w.abort(); } catch { /* ignore */ } }
        open.clear();
      },
    };
  }

  function bufferTarget() {
    return {
      make() {
        let output = null;
        const target = new MB.BufferTarget();
        return {
          target,
          formatOptions: { fastStart: 'in-memory' },
          bind(o) { output = o; },
          async cancelOutput() { try { if (output && !['canceled', 'finalized'].includes(output.state)) await output.cancel(); } catch { /* ignore */ } },
          async finish() { const blob = new Blob([target.buffer], { type: 'video/mp4' }); return { bytes: blob.size, blob }; },
        };
      },
      async abort() {},
    };
  }

  async function processOne(run, v) {
    if (run.mode !== 'folder') {
      const t = bufferTarget();
      const r = await convertVideo(run, v, () => t.make());
      return { status: 'done', ...r };
    }
    const dir = await outFolder(run, v.dir);
    let existing = null;
    try { existing = await dir.getFileHandle(v.outName); } catch { existing = null; }
    if (existing) {
      if (v.handle && await existing.isSameEntry(v.handle).catch(() => false)) {
        return { status: 'failed', error: 'Not saved, because the new copy would replace the original.' };
      }
      const f = await existing.getFile().catch(() => null);
      if (f && f.size > 0 && state.settings.existing === 'skip') return { status: 'skipped' };
    }
    const fh = existing || await dir.getFileHandle(v.outName, { create: true });
    const t = fileTarget(fh);
    try {
      const r = await convertVideo(run, v, () => t.make());
      return { status: 'done', ...r };
    } catch (e) {
      await t.abort();
      if (!existing) { try { await dir.removeEntry(v.outName); } catch { /* ignore */ } }
      throw e;
    }
  }

  // ---------------------------------------------------------------- the run
  function newRun(mode, list) {
    return {
      mode, list, index: -1, current: null,
      done: 0, skipped: 0, failed: 0, warned: 0,
      totalDur: list.reduce((a, v) => a + v.info.dur, 0),
      finishedDur: 0, convertedDur: 0, activeMs: 0, tickStart: 0,
      curProgress: 0, paused: false, gate: null, release: null, stopping: false, finished: false,
      conv: null, codec: 'avc', root: null, dirs: new Map(), where: '', log: [], wake: null, lastTick: 0, results: [],
    };
  }

  async function startRun() {
    if (state.run) return;
    const src = state.source;
    const list = okVideos();
    if (!src || !list.length) return;
    const sample = src.kind === 'sample';
    const o = state.settings.overlay;
    if (o.kind === 'image' && !state.asset) { toast('Choose your new logo image first, or set “Add new logo” to None.'); return; }
    if (o.kind === 'text' && !state.asset) { toast('Type the text for your new logo first, or set “Add new logo” to None.'); $('txtValue').focus(); return; }
    const anyBoxes = list.some((v) => boxesFor(v.info.shape).length);
    if (!anyBoxes && !overlayActive()) { toast('Nothing to change yet. Draw a box over the old logo, or add a new logo.'); return; }
    if (!sample && !state.settings.rightsOk) {
      toast('Please confirm that you own these videos or have permission to edit them.');
      $('rightsField').classList.add('is-attn');
      $('optRights').focus();
      setTimeout(() => $('rightsField').classList.remove('is-attn'), 1600);
      return;
    }
    if (!sample && anyBoxes) {
      const missing = shapeGroups().filter((g) => !boxesFor(g.key).length);
      if (missing.length && !(await confirmMissing(missing))) return;
    }
    let mode = sample ? 'sample' : (HAS_FSA && src.handle) ? 'folder' : 'download';
    const run = newRun(mode, list);
    try {
      if (mode === 'folder') {
        let prefix = null;
        if (state.outDir) {
          if (await state.outDir.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new UserError('Saving needs permission to use the folder you chose.');
          run.root = state.outDir;
          const rel = await src.handle.resolve(state.outDir).catch(() => null);
          prefix = rel ? rel.map((p) => `${p}/`).join('') : null;
          run.where = `the “${state.outDir.name}” folder`;
        } else {
          if (await src.handle.requestPermission({ mode: 'readwrite' }) !== 'granted') {
            throw new UserError('To save the new copies, please allow this page to save files in your folder. Your original videos stay unchanged.');
          }
          run.root = await src.handle.getDirectoryHandle(OUT_DIR_NAME, { create: true });
          prefix = `${OUT_DIR_NAME}/`;
          run.where = `the “${OUT_DIR_NAME}” folder inside “${src.name}”`;
        }
        planNames(list, prefix);
      } else {
        planNames(list, null);
        if (mode === 'sample') list[0].outName = 'Sample video (rebranded).mp4';
        else run.where = 'your Downloads folder';
      }
      const W = even(list[0].info.W), H = even(list[0].info.H);
      run.codec = (await MB.getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: W, height: H }).catch(() => null)) || 'avc';
    } catch (e) {
      toast(e instanceof UserError ? e.message : friendlyError(e));
      return;
    }
    for (const v of list) v.result = null;
    state.run = run;
    state.sel = null;
    openRunDialog(run);
    renderAll();
    await keepAwake(run, true);
    run.tickStart = performance.now();
    try {
      for (let i = 0; i < list.length; i++) {
        if (run.stopping) break;
        const v = list[i];
        run.index = i;
        run.current = v;
        run.curProgress = 0;
        updateRow(v);
        renderRunCurrent(run);
        scheduleRunUI();
        let res;
        const t0 = performance.now();
        try {
          res = await processOne(run, v);
        } catch (e) {
          if (run.stalled) {
            run.stalled = false;
            res = { status: 'failed', error: 'This video stopped making progress, so it was skipped. The file may be damaged.' };
          } else if (e instanceof MB.ConversionCanceledError || run.stopping) {
            res = { status: 'stopped' };
          } else {
            res = { status: 'failed', error: e instanceof UserError ? e.message : friendlyError(e, 'run') };
            if (e && e.name === 'QuotaExceededError') { res.error = 'Not enough free disk space, so the run stopped.'; run.stopping = true; }
          }
        }
        if (res.status === 'stopped') { v.result = null; run.current = null; updateRow(v); break; }
        res.ms = performance.now() - t0;
        v.result = res;
        run.results.push([v, res]);
        if (res.status === 'done') {
          run.done++;
          run.convertedDur += v.info.dur;
          if (res.warn) run.warned++;
          if (res.blob) deliverBlob(run, v, res.blob);
        } else if (res.status === 'skipped') run.skipped++;
        else run.failed++;
        run.finishedDur += v.info.dur;
        run.curProgress = 0;
        run.current = null;
        updateRow(v);
        addRunLog(run, v, res);
        scheduleRunUI();
      }
    } finally {
      run.finished = true;
      run.current = null;
      await keepAwake(run, false);
      state.run = null;
      renderAll();
      for (const v of list) updateRow(v);
      showRunDone(run);
    }
  }

  function deliverBlob(run, v, blob) {
    const url = URL.createObjectURL(blob);
    if (run.mode === 'sample') { run.sampleUrl = url; run.sampleName = v.outName; return; }
    const a = document.createElement('a');
    a.href = url;
    a.download = v.outName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  function setPaused(run, on) {
    if (!run || run.finished || run.paused === on) return;
    if (on) {
      run.activeMs += performance.now() - run.tickStart;
      run.paused = true;
      run.gate = new Promise((r) => { run.release = r; });
      keepAwake(run, false);
    } else {
      run.paused = false;
      run.tickStart = performance.now();
      run.lastTick = performance.now();
      const r = run.release;
      run.release = null;
      run.gate = null;
      if (r) r();
      keepAwake(run, true);
    }
    renderRunControls(run);
    scheduleRunUI();
  }

  async function stopRun(run) {
    if (!run || run.finished || run.stopping) return;
    run.stopping = true;
    renderRunControls(run);
    const conv = run.conv;
    if (run.paused) setPaused(run, false);
    if (conv) { try { await conv.cancel(); } catch { /* ignore */ } }
  }

  async function keepAwake(run, on) {
    try {
      if (on && !run.wake && navigator.wakeLock && document.visibilityState === 'visible') {
        run.wake = await navigator.wakeLock.request('screen');
        run.wake.addEventListener('release', () => { run.wake = null; });
      } else if (!on && run.wake) {
        const w = run.wake;
        run.wake = null;
        await w.release();
      }
    } catch { /* not available */ }
  }

  // watchdog: a video that stops making progress for a long time is skipped
  setInterval(() => {
    const run = state.run;
    if (!run || run.paused || !run.conv || !run.lastTick) return;
    if (document.visibilityState !== 'visible') { run.lastTick = performance.now(); return; }
    if (performance.now() - run.lastTick > 90000) {
      run.lastTick = performance.now();
      run.conv.cancel().catch(() => {});
      run.stalled = true;
    }
  }, 5000);

  // ---------------------------------------------------------------- run dialog
  function openRunDialog(run) {
    const d = $('runDialog');
    const sample = run.mode === 'sample';
    d.innerHTML = `
      <div class="dlg" tabindex="-1">
        <div class="dlg-head">
          <div><h2 id="runTitle">${sample ? 'Making your new video' : 'Rebranding your videos'}</h2><p id="runSub">${sample ? 'This takes a few seconds.' : `Saving to ${esc(run.where)}`}</p></div>
          <span class="pause-tag" id="runPaused" hidden>Paused</span>
        </div>
        <div class="dlg-body" id="runBody">
          ${sample ? '' : `<div class="run-stats">
            <div class="run-stat"><b id="rsDone">0</b><span>Saved</span></div>
            <div class="run-stat"><b id="rsSkip">0</b><span>Already done</span></div>
            <div class="run-stat"><b id="rsBad">0</b><span>Problems</span></div>
          </div>`}
          <div class="run-overall">
            <div class="run-line"><span id="roCount"></span><span id="roEta"></span></div>
            <div class="bar lg"><span id="roBar"></span></div>
          </div>
          <div class="run-current" id="runCurrent">
            <div class="vthumb" id="rcThumb">${ICON.film}</div>
            <div style="min-width:0;display:grid;gap:5px">
              <div class="run-current-name" id="rcName"></div>
              <div class="bar"><span id="rcBar"></span></div>
              <div class="run-line"><span id="rcInfo"></span><span id="rcPct"></span></div>
            </div>
          </div>
          ${sample ? '' : '<ul class="run-log" id="runLog" aria-label="Finished videos" hidden></ul>'}
          <p class="run-note" id="runNote">${sample ? 'Nothing is uploaded.' : 'Keep this tab open. You can use other apps while it works.'}</p>
        </div>
        <div class="dlg-foot" id="runFoot">
          ${sample ? '' : '<button type="button" class="btn btn-outline" data-action="run-pause" id="runPauseBtn">Pause</button>'}
          <button type="button" class="btn btn-danger-text" data-action="run-stop" id="runStopBtn">Stop</button>
        </div>
      </div>`;
    if (!d.open) d.showModal();
    document.documentElement.classList.add('modal-open');
    d.querySelector('.dlg').focus();
    scheduleRunUI();
  }

  function renderRunControls(run) {
    const p = $('runPauseBtn'), s = $('runStopBtn'), tag = $('runPaused');
    if (p) { p.textContent = run.paused ? 'Resume' : 'Pause'; p.disabled = run.stopping; }
    if (s) { s.textContent = run.stopping ? 'Stopping…' : 'Stop'; s.disabled = run.stopping; }
    if (tag) tag.hidden = !run.paused;
  }

  function renderRunCurrent(run) {
    const v = run.current;
    const box = $('runCurrent');
    if (!box) return;
    if (!v) return;
    $('rcName').textContent = v.path;
    const th = $('rcThumb');
    if (v.thumb) paintThumb(th, v); else th.innerHTML = ICON.film;
    $('rcInfo').textContent = `${v.info.W}×${v.info.H} · ${fmtTime(v.info.dur)}`;
  }

  let runUiPending = false;
  function scheduleRunUI() {
    if (runUiPending) return;
    runUiPending = true;
    setTimeout(() => { runUiPending = false; updateRunUI(); }, 200);
  }
  function updateRunUI() {
    const run = state.run;
    if (!run || run.finished || !$('roBar')) return;
    const n = run.list.length;
    const pos = Math.min(n, run.index + 1);
    const cur = run.current;
    const curDur = cur ? cur.info.dur * run.curProgress : 0;
    const frac = run.totalDur ? (run.finishedDur + curDur) / run.totalDur : 0;
    $('roBar').style.width = `${(clamp(frac, 0, 1) * 100).toFixed(1)}%`;
    $('roCount').textContent = run.mode === 'sample' ? `${Math.round(frac * 100)}%` : `Video ${pos.toLocaleString()} of ${n.toLocaleString()} · ${Math.round(frac * 100)}%`;
    const active = run.activeMs + (run.paused ? 0 : performance.now() - run.tickStart);
    const conv = run.convertedDur + curDur;
    let eta = '';
    if (run.paused) eta = 'Paused';
    else if (run.stopping) eta = 'Stopping…';
    else if (conv > 3 && active > 3000) {
      const speed = conv / (active / 1000);
      const left = (run.totalDur - run.finishedDur - curDur) / speed;
      eta = `${fmtLeft(left)} · ${speed >= 10 ? Math.round(speed) : speed.toFixed(1)}× speed`;
    } else eta = 'Working out time left…';
    $('roEta').textContent = eta;
    if (cur) {
      $('rcBar').style.width = `${(run.curProgress * 100).toFixed(1)}%`;
      $('rcPct').textContent = `${Math.round(run.curProgress * 100)}%`;
    }
    if ($('rsDone')) { $('rsDone').textContent = run.done.toLocaleString(); $('rsSkip').textContent = run.skipped.toLocaleString(); $('rsBad').textContent = run.failed.toLocaleString(); }
    renderRunControls(run);
  }

  function logItem(v, res) {
    const li = document.createElement('li');
    const cls = res.status === 'done' ? 'ok' : res.status === 'skipped' ? 'skip' : 'bad';
    li.className = cls;
    const right = res.status === 'done' ? fmtBytes(res.bytes) : res.status === 'skipped' ? 'Already done' : 'Not saved';
    li.innerHTML = `${cls === 'ok' ? ICON.ok : cls === 'skip' ? ICON.skip : ICON.bad}<span class="nm"></span><span class="rt"></span>${res.error || res.warn ? '<span class="why"></span>' : ''}`;
    li.querySelector('.nm').textContent = v.path;
    li.querySelector('.nm').title = v.outName ? `Saved as ${v.dir}${v.outName}` : v.path;
    li.querySelector('.rt').textContent = right;
    const why = li.querySelector('.why');
    if (why) { why.textContent = res.error || res.warn; if (!res.error) why.classList.add('is-note'); }
    return li;
  }
  function addRunLog(run, v, res) {
    const ul = $('runLog');
    if (!ul) return;
    ul.hidden = false;
    ul.prepend(logItem(v, res));
    while (ul.children.length > 300) ul.lastElementChild.remove();
  }

  function showRunDone(run) {
    const d = $('runDialog');
    if (!d.open) d.showModal();
    const body = $('runBody'), foot = $('runFoot');
    const stopped = run.stopping && !run.stalled;
    const left = run.list.length - run.done - run.skipped - run.failed;
    $('runPaused').hidden = true;
    if (run.mode === 'sample') {
      const ok = run.done === 1 && run.sampleUrl;
      $('runTitle').textContent = ok ? 'Your new video is ready' : stopped ? 'Stopped' : 'The video couldn’t be made';
      $('runSub').textContent = ok ? 'Here’s the result. Nothing was uploaded.' : '';
      body.innerHTML = ok
        ? `<video class="result-video" src="${run.sampleUrl}" controls autoplay muted loop playsinline></video><p class="run-note">Like it? Choose a folder of your own videos to do the same to all of them at once.</p>`
        : `<div class="run-done has-bad">${esc((run.results[0] && run.results[0][1].error) || 'Stopped before it finished.')}</div>`;
      foot.innerHTML = `${ok ? `<a class="btn btn-outline" href="${run.sampleUrl}" download="${esc(run.sampleName)}">${ICON.download} Download</a>` : ''}<span class="spacer"></span><button type="button" class="btn btn-dark" data-action="run-close">Close</button>`;
      return;
    }
    $('runTitle').textContent = stopped ? 'Stopped' : run.failed ? 'Finished, with some problems' : 'All done';
    const bits = [];
    if (run.done) bits.push(`<strong>${plural(run.done, 'new video')}</strong> saved to ${esc(run.where)}.`);
    else bits.push('No new videos were saved.');
    if (run.skipped) bits.push(`${plural(run.skipped, 'video')} already had a new copy, so ${run.skipped === 1 ? 'it was' : 'they were'} skipped.`);
    if (run.failed) bits.push(`${plural(run.failed, 'video')} couldn’t be done. See below.`);
    if (run.warned) bits.push(`${plural(run.warned, 'video')} ${run.warned === 1 ? 'was' : 'were'} saved with a note. See below.`);
    if (stopped && left > 0) bits.push(`${plural(left, 'video')} ${left === 1 ? 'wasn’t' : 'weren’t'} started. Press Start again to continue. Finished videos are skipped.`);
    $('runSub').textContent = stopped ? 'You stopped the run.' : `Your original videos weren’t changed.`;
    const doneBox = `<div class="run-done${run.failed || stopped ? ' has-bad' : ''}">${bits.join(' ')}</div>`;
    const stats = body.querySelector('.run-stats');
    if (stats) updateRunStatsFinal(run);
    body.querySelector('.run-overall')?.remove();
    body.querySelector('.run-current')?.remove();
    $('runNote').textContent = run.mode === 'folder'
      ? `Find them in ${run.where}. Subfolders were kept.`
      : 'Each new video was downloaded when it was ready.';
    body.insertAdjacentHTML('afterbegin', doneBox);
    const ul = $('runLog');
    if (ul) {
      // show problems first
      const rank = (r) => (r.status === 'failed' ? 0 : r.warn ? 1 : 2);
      const items = [...run.results].sort((a, b) => rank(a[1]) - rank(b[1]));
      ul.replaceChildren(...items.slice(0, 400).map(([v, r]) => logItem(v, r)));
      ul.hidden = !items.length;
    }
    foot.innerHTML = '<span class="spacer"></span><button type="button" class="btn btn-dark" data-action="run-close">Close</button>';
    foot.querySelector('button').focus();
  }
  function updateRunStatsFinal(run) {
    if (!$('rsDone')) return;
    $('rsDone').textContent = run.done.toLocaleString();
    $('rsSkip').textContent = run.skipped.toLocaleString();
    $('rsBad').textContent = run.failed.toLocaleString();
  }

  function closeRunDialog() {
    const d = $('runDialog');
    const v = d.querySelector('video');
    if (v) { try { v.pause(); } catch { /* ignore */ } }
    if (d.open) d.close();
    document.documentElement.classList.remove('modal-open');
  }

  function confirmMissing(missing) {
    return new Promise((resolve) => {
      const d = $('runDialog');
      const count = missing.reduce((a, g) => a + g.count, 0);
      const names = missing.map((g) => `${shapeLabel(g.key)} (${plural(g.count, 'video')})`).join(', ');
      d.innerHTML = `
        <div class="dlg" tabindex="-1">
          <div class="dlg-head"><div><h2 id="runTitle">Some videos have no boxes yet</h2><p>Boxes are set for each video shape.</p></div></div>
          <div class="dlg-body"><div class="run-done has-bad">${plural(count, 'video')} in ${esc(names)} ${count === 1 ? 'has' : 'have'} no boxes, so the old logo won’t be removed from ${count === 1 ? 'it' : 'them'}.${overlayActive() ? ' The new logo will still be added.' : ''}</div></div>
          <div class="dlg-foot"><button type="button" class="btn btn-outline" data-confirm="fix">Set up ${esc(shapeLabel(missing[0].key))}</button><span class="spacer"></span><button type="button" class="btn btn-text" data-confirm="no">Cancel</button><button type="button" class="btn btn-dark" data-confirm="yes">Continue anyway</button></div>
        </div>`;
      const done = (val) => { d.removeEventListener('click', onClick); d.removeEventListener('cancel', onCancel); closeRunDialog(); resolve(val); };
      const onClick = (e) => {
        const b = e.target.closest('[data-confirm]');
        if (!b) return;
        if (b.dataset.confirm === 'fix') { done(false); selectVideo(missing[0].first.id); return; }
        done(b.dataset.confirm === 'yes');
      };
      const onCancel = (e) => { e.preventDefault(); done(false); };
      d.addEventListener('click', onClick);
      d.addEventListener('cancel', onCancel);
      d.showModal();
      document.documentElement.classList.add('modal-open');
      d.querySelector('[data-confirm="yes"]').focus();
    });
  }

  // ---------------------------------------------------------------- wiring
  function addBox() {
    const shape = activeShape();
    if (!shape) return;
    const boxes = boxesFor(shape);
    if (boxes.length >= MAX_BOXES) return;
    const b = { id: uid(), x: 0.4, y: 0.42, w: 0.2, h: 0.16, method: 'fill' };
    setBoxesFor(shape, [...boxes, b]);
    state.sel = { type: 'box', id: b.id };
    renderAll();
  }

  async function pickOutput() {
    let h;
    const opts = { id: 'vr-output', mode: 'readwrite' };
    if (state.source && state.source.handle) opts.startIn = state.source.handle;
    try {
      h = await window.showDirectoryPicker(opts);
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('That folder can’t be used. Try another one.');
      return;
    }
    state.outDir = h;
    state.outSame = !!(state.source && state.source.handle && await h.isSameEntry(state.source.handle).catch(() => false));
    renderAll();
  }

  function onAction(e) {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const a = el.dataset.action;
    const o = state.settings.overlay;
    switch (a) {
      case 'pick-folder': pickFolder(); break;
      case 'pick-files': $('fileInput').click(); break;
      case 'sample': loadSample(); break;
      case 'change-source':
        if (state.run) return;
        resetSource();
        state.outDir = null;
        state.outSame = false;
        renderAll();
        setTimeout(() => $(HAS_FSA ? 'pickBtn' : 'filesBtn').focus(), 0);
        break;
      case 'view':
        state.view = el.dataset.view === 'original' ? 'original' : 'result';
        if (state.view === 'original' && state.sel && state.sel.type === 'ov') state.sel = null;
        renderAll();
        break;
      case 'add-box': addBox(); break;
      case 'clear-boxes': setBoxesFor(activeShape(), []); state.sel = null; renderAll(); break;
      case 'remove-box': removeBox(el.dataset.box); break;
      case 'ov-kind':
        o.kind = el.dataset.kind;
        syncAsset();
        saveSettings();
        renderAll();
        if (o.kind === 'text') $('txtValue').focus();
        if (o.kind === 'image' && !state.imageAsset) $('logoInput').click();
        break;
      case 'pick-logo': $('logoInput').click(); break;
      case 'remove-logo':
        state.imageAsset = null;
        o.image = null;
        syncAsset();
        saveSettings();
        renderAll();
        break;
      case 'anchor':
        o.anchor = el.dataset.anchor;
        if (o.anchor === 'box') fitLogoToBox();
        saveSettings();
        renderAll();
        break;
      case 'pick-output': pickOutput(); break;
      case 'reset-output': state.outDir = null; state.outSame = false; renderAll(); break;
      case 'start': startRun(); break;
      case 'shape': {
        const g = shapeGroups().find((x) => x.key === el.dataset.shape);
        if (g && g.key !== activeShape()) selectVideo(g.first.id);
        break;
      }
      case 'run-pause': if (state.run) setPaused(state.run, !state.run.paused); break;
      case 'run-stop': if (state.run) stopRun(state.run); break;
      case 'run-close': closeRunDialog(); break;
      default: break;
    }
  }

  function wire() {
    document.addEventListener('click', onAction);
    document.addEventListener('keydown', onKey);

    const layer = $('layer');
    layer.addEventListener('pointerdown', onLayerDown);
    layer.addEventListener('pointermove', onLayerMove);
    layer.addEventListener('pointerup', onLayerUp);
    layer.addEventListener('pointercancel', onLayerUp);
    layer.addEventListener('lostpointercapture', (e) => { if (drag && e.pointerId === drag.pointerId) onLayerUp(e); });

    const list = $('vlist');
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.vrow');
      if (!row) return;
      const v = state.byId.get(row.dataset.id);
      if (v && v.status === 'ok') selectVideo(v.id);
      else if (v && v.status === 'bad') toast(v.errorTip ? `${v.error}. ${v.errorTip}` : v.error, 6000);
    });
    list.addEventListener('keydown', (e) => {
      const row = e.target.closest('.vrow');
      if (!row) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectVideo(row.dataset.id); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
        if (next) { next.focus(); const v = state.byId.get(next.dataset.id); if (v && v.status === 'ok') selectVideo(v.id); }
      }
    });

    $('boxList').addEventListener('change', (e) => {
      const sel = e.target.closest('[data-box-method]');
      if (!sel) return;
      const b = boxesFor(activeShape()).find((x) => x.id === sel.dataset.boxMethod);
      if (!b || !METHODS[sel.value]) return;
      b.method = sel.value;
      state.sel = { type: 'box', id: b.id };
      saveSettings();
      renderAll();
    });
    $('boxList').addEventListener('click', (e) => {
      if (e.target.closest('select, button')) return;
      const li = e.target.closest('.brow');
      if (!li) return;
      state.sel = { type: 'box', id: li.dataset.box };
      renderAll();
    });

    const o = () => state.settings.overlay;
    const textChanged = () => { syncAsset(); saveSettings(); renderOverlayPanel(); drawPreview(); renderLayer(); };
    $('txtValue').addEventListener('input', (e) => { o().text.value = e.target.value.slice(0, 80); textChanged(); });
    $('txtFont').addEventListener('change', (e) => { o().text.font = FONTS[e.target.value] ? e.target.value : 'sans'; textChanged(); });
    $('txtColor').addEventListener('input', (e) => { o().text.color = e.target.value; textChanged(); });
    $('txtShadow').addEventListener('change', (e) => { o().text.shadow = e.target.checked; textChanged(); });
    const slider = (id, key, lo, hi) => $(id).addEventListener('input', (e) => {
      o()[key] = clamp(Number(e.target.value) / 100, lo, hi);
      saveSettings();
      renderOverlayPanel();
      drawPreview();
    });
    slider('ovSize', 'size', 0.02, 0.9);
    slider('ovOpacity', 'opacity', 0.1, 1);
    slider('ovMargin', 'margin', 0, 0.2);

    $('optQuality').addEventListener('change', (e) => { state.settings.quality = QUALITY[e.target.value] ? e.target.value : 'original'; saveSettings(); });
    $('optExisting').addEventListener('change', (e) => { state.settings.existing = e.target.value === 'replace' ? 'replace' : 'skip'; saveSettings(); });
    $('optRights').addEventListener('change', (e) => { state.settings.rightsOk = e.target.checked; saveSettings(); });
    $('optSub').addEventListener('change', (e) => { state.settings.includeSub = e.target.checked; saveSettings(); });

    $('logoInput').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) useLogoFile(f); });
    $('fileInput').addEventListener('change', (e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; if (fs.length) loadFiles(fs); });

    $('scrubRange').addEventListener('input', (e) => {
      const sess = preview.sess;
      if (!sess) return;
      if (!state.scrubbed) { state.scrubbed = true; renderStageHint(); }
      seekPreview((Number(e.target.value) / 1000) * Math.max(0, sess.dur - 0.04));
    });

    if (typeof ResizeObserver === 'function') new ResizeObserver(() => layoutStage()).observe($('stageWrap'));
    window.addEventListener('resize', layoutStage);

    const dlg = $('runDialog');
    dlg.addEventListener('cancel', (e) => {
      if (state.run) { e.preventDefault(); return; }
      document.documentElement.classList.remove('modal-open');
    });
    dlg.addEventListener('close', () => document.documentElement.classList.remove('modal-open'));

    window.addEventListener('beforeunload', (e) => {
      if (state.run) { e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('visibilitychange', () => {
      const run = state.run;
      if (run && !run.paused && document.visibilityState === 'visible') keepAwake(run, true);
    });

    // Drop a folder (or, without folder support, video files) anywhere on the page.
    document.addEventListener('dragover', (e) => { if (!state.run && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    document.addEventListener('drop', async (e) => {
      if (state.run || !e.dataTransfer) return;
      e.preventDefault();
      const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
      const files = [...e.dataTransfer.files];
      if (HAS_FSA && items.length && typeof items[0].getAsFileSystemHandle === 'function') {
        const handles = await Promise.all(items.map((i) => i.getAsFileSystemHandle().catch(() => null)));
        const dir = handles.find((h) => h && h.kind === 'directory');
        if (dir) { loadFolder(dir); return; }
        const img = files.find((f) => /^image\//.test(f.type));
        if (img && !files.some((f) => /^video\//.test(f.type))) { useLogoFile(img); return; }
        toast('Drop a folder of videos here, or use “Choose folder”.');
        return;
      }
      const img = files.find((f) => /^image\//.test(f.type));
      if (img && !files.some((f) => /^video\//.test(f.type))) { useLogoFile(img); return; }
      if (files.length) loadFiles(files);
    });
  }

  function checkSupport() {
    const banner = $('unsupported');
    const ok = !!MB && typeof window.VideoDecoder === 'function' && typeof window.VideoEncoder === 'function';
    state.supported = ok;
    if (!ok) {
      banner.hidden = false;
      banner.textContent = 'This browser can’t edit videos. Please open this page in Google Chrome or Microsoft Edge on a computer.';
      for (const id of ['pickBtn', 'filesBtn', 'sampleBtn']) $(id).disabled = true;
      return;
    }
    if (!HAS_FSA) {
      $('pickBtn').hidden = true;
      $('filesBtn').hidden = false;
      $('optSub').closest('label').hidden = true;
      banner.hidden = false;
      banner.textContent = 'Tip: in Chrome or Edge on a computer you can pick a whole folder and save the new videos next to the originals. In this browser, each new video is downloaded.';
    }
  }

  function init() {
    checkSupport();
    syncAsset();
    wire();
    renderAll();
    restoreLogo();
    if (DEBUG) {
      window.__vr = {
        state, preview, computePlan, bestCrop, FrameRenderer, makeTextAsset, makeImageAsset, pickBitrate, planNames, shapeKey,
        loadFolder, loadFiles, loadSample, useLogoFile, selectVideo, startRun, boxesFor, setBoxesFor, renderAll, seekPreview, drawPreviewNow,
      };
    }
  }

  init();
})();
