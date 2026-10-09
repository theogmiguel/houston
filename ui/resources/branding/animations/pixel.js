// Procedural pixel sprite of the Houston mascot.
//
// Each cell is sampled from simple shapes positioned in the source PNG's
// 1254 px coordinate space (sphere, visor, crescents, cups, tilted orbit,
// arms, shield torso, core). Palette values were sampled from
// houston-mascot.png. Frames run at 10 fps, a deliberate pixel-art cadence.
(function () {
  const GW = 48, GH = 44;          // sprite grid
  const X0 = 40, Y0 = 60, CELL = 25; // source-space window covered by the grid
  const FPS = 10;

  const P = {
    out: '#070820',
    s: ['#0c0f2e', '#1a1c55', '#2c2a7e', '#4a3aa8', '#7a5fe0'],
    rim: '#38d6ff', rimDeep: '#2a8cf0',
    visor: '#090c24', visorGloss: '#161c4a',
    eye: '#8ff6ff', eyeLow: '#3cc8f0',
    cupShell: '#262a66', cupEdge: '#141740', cupRing: '#3fe0ff', cupIn: '#101538',
    ring: [
      ['#5b33c9', '#8a52f0', '#c08cff'],
      ['#2f3fc4', '#4a6cf5', '#8fb0ff'],
      ['#1f74d6', '#2f9cf5', '#8fd8ff'],
      ['#1aa6cc', '#36d4f5', '#b8f6ff'],
    ],
    spark: '#ffffff', sparkHalo: '#c8fbff',
    armDark: '#121640', armMid: '#1e2260', armLight: '#3a3590', armRim: '#2fa8f0',
    open: '#2fc8f0', openIn: '#8ff4ff',
    torso: '#1a1c52', torsoLight: '#2e2a78', torsoDark: '#12153f', torsoRim: '#2a8ff0',
    collar: '#070a20', lip: '#3a3a9a',
    socket: '#0c1438', socketGlow: '#145a88',
    core: [['#1b4f70', '#2a7aa0', '#5fb6d0'], ['#22b8e6', '#6ff0ff', '#f0feff']],
    warn: '#f59e0b', warnDark: '#1a1205', zee: '#a9b8ff',
  };

  const HEAD = { cx: 645, cy: 475, r: 325 };
  const RING = { cx: 645, cy: 515, rx: 590, ry: 165, rxIn: 500, ryIn: 88, a: -18.3 * Math.PI / 180 };
  const ARM_L = { tx: 408, ty: 815, px: 268, py: 995, hw: 80 };
  const MIRROR_X = 1262; // right arm mirrors the left one around x = 631
  const L = norm3(-0.55, -0.65, 0.55);

  function norm3(x, y, z) { const m = Math.hypot(x, y, z); return [x / m, y / m, z / m]; }
  function rot(x, y, cx, cy, deg) {
    const t = -deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const dx = x - cx, dy = y - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  }
  const inEll = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;

  // Ring sample in head-local space: returns [color, isFront] or null.
  function ring(x, y, st) {
    const dx = x - RING.cx, dy = y - RING.cy;
    const c = Math.cos(-RING.a), s = Math.sin(-RING.a);
    const u = dx * c - dy * s, v = dx * s + dy * c;
    const outer = (u / RING.rx) ** 2 + (v / RING.ry) ** 2;
    const inner = (u / RING.rxIn) ** 2 + (v / RING.ryIn) ** 2;
    if (outer > 1 || inner < 1) return null;
    const front = v > 0;
    const t = (u / RING.rx + 1) / 2;
    const hue = P.ring[t < 0.3 ? 0 : t < 0.55 ? 1 : t < 0.8 ? 2 : 3];
    const band = 1 - (1 - Math.sqrt(outer)) / 0.17; // ~0 inner edge .. 1 outer edge
    let col = front ? (band > 0.78 ? hue[2] : band < 0.3 ? hue[0] : hue[1]) : (band > 0.7 ? hue[1] : hue[0]);
    if (st.orbit != null) {
      const ang = Math.atan2(v / ((RING.ry + RING.ryIn) / 2), u / ((RING.rx + RING.rxIn) / 2));
      let d = Math.abs(ang - st.orbit) % (2 * Math.PI);
      d = Math.min(d, 2 * Math.PI - d);
      if (d < 0.11) col = P.spark; else if (d < 0.24) col = P.sparkHalo; else if (d < 0.4 && st.trail) col = hue[2];
    }
    return [col, front];
  }

  function head(x, y, st) {
    const d = Math.hypot(x - HEAD.cx, y - HEAD.cy) / HEAD.r;
    // Headphone cups sit on top of the sphere and may poke past its edge.
    for (const [cx, cy, rx, ry] of [[292, 525, 72, 140], [945, 470, 66, 132]]) {
      const e = inEll(x, y, cx, cy, rx, ry);
      if (e <= 1) {
        const k = Math.sqrt(inEll(x, y, cx + (cx < 600 ? 14 : -14), cy, rx * 0.68, ry * 0.76));
        if (k < 0.62) return P.cupIn;
        if (k < 1) return P.cupRing;
        return e > 0.8 ? P.cupEdge : P.cupShell;
      }
    }
    if (d > 1) return null;
    // Crescent eyes, squashed vertically by eyeOpen about their centre line.
    for (const ex of [500, 765]) {
      const qx = x - st.eyeDx, qy = 515 + (y - 515 - st.eyeDy) / st.eyeOpen;
      const in1 = Math.hypot(qx - ex, qy - 548) < 84;
      const in2 = Math.hypot(qx - ex, qy - 606) < 88;
      if (in1 && !in2 && qy < 540) return qy > 520 ? P.eyeLow : P.eye;
    }
    if (inEll(x, y, 622, 470, 262, 235) <= 1) {
      return inEll(x, y, 606, 520, 262, 232) > 1 ? P.visorGloss : P.visor;
    }
    const nx = (x - HEAD.cx) / HEAD.r, ny = (y - HEAD.cy) / HEAD.r;
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    const ang = Math.atan2(ny, nx) * 180 / Math.PI;
    if (d > 0.9 && ang > -105 && ang < 15) return d > 0.96 ? P.rimDeep : P.rim;
    const lam = nx * L[0] + ny * L[1] + nz * L[2];
    return P.s[lam < 0.2 ? 0 : lam < 0.5 ? 1 : lam < 0.75 ? 2 : lam < 0.92 ? 3 : 4];
  }

  function arm(x, y) {
    const ax = ARM_L.px - ARM_L.tx, ay = ARM_L.py - ARM_L.ty, len = Math.hypot(ax, ay);
    const ux = ax / len, uy = ay / len;
    const rx = x - ARM_L.tx, ry = y - ARM_L.ty;
    const s = (rx * ux + ry * uy) / len;
    const w = rx * -uy + ry * ux; // signed perpendicular (positive = outer side)
    if (s < -0.18 || s > 1.05) return null;
    // Teardrop: widest just below the opening, blunt rounded tip.
    const hw = ARM_L.hw * Math.sqrt(Math.max(0, 1 - ((s - 0.22) / 0.84) ** 2));
    if (Math.abs(w) > hw) return null;
    const open = (s / 0.13) ** 2 + (w / 58) ** 2;
    if (open < 0.45) return P.openIn;
    if (open < 1) return P.open;
    if (s > 0.72 || (w < -hw * 0.62 && s > 0.3)) return P.armRim;
    if (w > hw * 0.45 && s < 0.6) return P.armLight;
    return s > 0.45 ? P.armDark : P.armMid;
  }

  function torso(x, y, st) {
    const t = (y - 818) / 287;
    if (t < 0 || t > 1) return null;
    const hw = 168 * Math.sqrt(Math.max(0, 1 - Math.pow(t, 1.7)));
    const nx = (x - 630) / hw;
    if (Math.abs(nx) > 1) return null;
    if (inEll(x, y, 630, 826, 148, 20) <= 1) return P.collar;
    if (inEll(x, y, 630, 834, 160, 30) <= 1) return P.lip;
    const dc = Math.hypot(x - 630, y - 955);
    if (dc < 64) {
      const pal = P.core[st.core > 0.5 ? 1 : 0];
      if (Math.hypot(x - 612, y - 935) < 22) return pal[2];
      return dc > 48 ? pal[0] : pal[1];
    }
    if (dc < 80) return st.core > 0.9 ? P.socketGlow : P.socket;
    if ((Math.abs(nx) > 0.84 || t > 0.86) && t > 0.3) return P.torsoRim;
    if (nx < -0.35 && t < 0.62) return P.torsoLight;
    return nx > 0.4 ? P.torsoDark : P.torso;
  }

  function sample(x, y, st) {
    // Head-local coordinates (bob + tilt); the ring travels with the head.
    const [hx, hy] = rot(x, y - st.headDy, HEAD.cx, HEAD.cy + 120, st.tilt);
    const rg = ring(hx, hy, st);
    if (rg && rg[1]) return rg[0];
    if (st.armR.top) { const c = armAt(x, y, st.armR, true); if (c) return c; }
    const h = head(hx, hy, st);
    if (h) return h;
    if (rg) return rg[0];
    const c = armAt(x, y, st.armL, false) || (st.armR.top ? null : armAt(x, y, st.armR, true));
    if (c) return c;
    return torso(x, y - st.torsoDy, st);
  }

  function armAt(x, y, a, mirrored) {
    let qx = x - a.dx, qy = y - a.dy;
    if (mirrored) qx = MIRROR_X - qx;
    [qx, qy] = rot(qx, qy, ARM_L.tx, ARM_L.ty, mirrored ? -a.rot : a.rot);
    return arm(qx, qy);
  }

  const ZGLYPH = [[1, 1, 1], [0, 0, 1], [0, 1, 0], [1, 0, 0], [1, 1, 1]]; // 3x5 "z"

  function state(kind, f) {
    const st = { headDy: 0, tilt: 0, eyeOpen: 1, eyeDx: 0, eyeDy: 0, torsoDy: 0, core: 1, orbit: null, trail: false,
      armL: { dx: 0, dy: 0, rot: 0 }, armR: { dx: 0, dy: 0, rot: 0, top: false }, alert: false, zs: [] };
    const bob = k => Math.round(Math.sin(2 * Math.PI * (f - k) / 24)) * -CELL * 0.5;
    if (kind === 'idle' || kind === 'needs-input') {
      st.headDy = bob(0); st.torsoDy = bob(2);
      st.armL.dy = bob(4); st.armR.dy = bob(4);
      if (f % 52 < 2) st.eyeOpen = 0.15;
    }
    if (kind === 'working') {
      st.headDy = bob(0) * 0.5; st.torsoDy = 0;
      st.orbit = (f * 2 * Math.PI) / 18; st.trail = true;
      st.core = f % 6 < 3 ? 1 : 0.85;
      st.armL.dy = f % 6 < 3 ? -CELL : 0; st.armR.dy = f % 6 < 3 ? 0 : -CELL;
      st.eyeDy = 12;
      if (f % 64 < 2) st.eyeOpen = 0.15;
    }
    if (kind === 'needs-input') {
      st.armR = { dx: 200, dy: -20, rot: -150 + (f % 12 < 6 ? 0 : -8), top: true };
      st.tilt = 5; st.eyeDx = 18; st.eyeDy = -10;
      st.alert = f % 10 < 7;
    }
    if (kind === 'unavailable') {
      st.headDy = 30 + (f % 50 < 25 ? 0 : CELL * 0.5); st.tilt = -6;
      st.eyeOpen = 0.15; st.eyeDy = 18; st.core = 0.2;
      st.armL = { dx: 30, dy: 50, rot: -10 }; st.armR = { dx: 30, dy: 50, rot: -10, top: false };
      st.torsoDy = 20;
      st.zs = [0, 16, 32].map(o => (f + o) % 48);
    }
    return st;
  }

  function draw(ctx, kind, f) {
    const st = state(kind, f);
    const img = ctx.createImageData(GW, GH);
    const grid = new Array(GW * GH);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      grid[j * GW + i] = sample(X0 + (i + 0.5) * CELL, Y0 + (j + 0.5) * CELL, st);
    }
    // One-cell dark outline around the silhouette.
    const outlined = grid.slice();
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      if (grid[j * GW + i]) continue;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj;
        if (a >= 0 && b >= 0 && a < GW && b < GH && grid[b * GW + a]) { outlined[j * GW + i] = P.out; break; }
      }
    }
    if (st.alert) bubble(outlined, 40, 2);
    for (const z of st.zs) glyph(outlined, ZGLYPH, 37 + Math.floor(z / 8), 6 - Math.floor(z / 7), z < 40 ? P.zee : null);
    for (let k = 0; k < outlined.length; k++) {
      const c = outlined[k];
      if (!c) continue;
      img.data[k * 4] = parseInt(c.slice(1, 3), 16);
      img.data[k * 4 + 1] = parseInt(c.slice(3, 5), 16);
      img.data[k * 4 + 2] = parseInt(c.slice(5, 7), 16);
      img.data[k * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function put(g, i, j, c) { if (i >= 0 && j >= 0 && i < GW && j < GH) g[j * GW + i] = c; }
  function glyph(g, rows, x, y, c) {
    if (!c || y < 0) return;
    rows.forEach((r, j) => r.forEach((v, i) => v && put(g, x + i, y + j, c)));
  }
  function bubble(g, x, y) {
    for (let j = 0; j < 7; j++) for (let i = 0; i < 5; i++) {
      const corner = (i === 0 || i === 4) && (j === 0 || j === 6);
      if (!corner) put(g, x + i, y + j, P.warn);
    }
    for (const j of [1, 2, 3, 5]) put(g, x + 2, y + j, P.warnDark);
  }

  const canvases = [];
  let paused = false, still = false, frame = 0, last = 0;
  function tick(t) {
    requestAnimationFrame(tick);
    if (paused || still || document.hidden) return;
    if (t - last < 1000 / FPS) return;
    last = t; frame++;
    canvases.forEach(c => draw(c.ctx, c.kind, frame));
  }

  window.HoustonPixel = {
    mount(list) {
      list.forEach(cv => {
        cv.width = GW; cv.height = GH;
        canvases.push({ cv, ctx: cv.getContext('2d'), kind: cv.dataset.state });
      });
      this.resize();
      canvases.forEach(c => draw(c.ctx, c.kind, still ? 3 : frame));
      requestAnimationFrame(tick);
    },
    // Integer scale only: the nearest multiple of 48 px to the chosen size.
    resize() {
      const size = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--size')) || 200;
      canvases.forEach(c => {
        const inChip = c.cv.closest('.chip');
        const scale = inChip ? 1 : Math.max(1, Math.round(size / GW));
        c.cv.style.width = GW * scale + 'px';
      });
    },
    setPaused(p) { paused = p; },
    // Reduced motion: hold a representative frame (frame 3 avoids the blink).
    setStatic(s) { still = s; if (s) canvases.forEach(c => draw(c.ctx, c.kind, 3)); },
    draw, GW, GH,
  };
})();
