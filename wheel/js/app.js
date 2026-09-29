/* ZexWheel: random name picker wheel. No dependencies. */
(() => {
  'use strict';

  // ---------- Constants ----------
  const STORE_KEY = 'zexwheel:current';
  const SAVED_KEY = 'zexwheel:saved';
  const THEME_KEY = 'zexwheel:theme';
  const TAU = Math.PI * 2;
  const MAX_ENTRIES = 2000;
  const DEFAULT_ENTRIES = ['Ali', 'Beatriz', 'Charles', 'Diya', 'Eric', 'Fatima', 'Gabriel', 'Hanna'];

  const PALETTES = {
    vivid: { name: 'Vivid', colors: ['#EF476F', '#FFB703', '#06D6A0', '#118AB2', '#8338EC', '#FB5607'] },
    classic: { name: 'Classic', colors: ['#3369E8', '#D50F25', '#EEB211', '#009925'] },
    pastel: { name: 'Pastel', colors: ['#FFADAD', '#FFD6A5', '#FDFFB6', '#CAFFBF', '#9BF6FF', '#A0C4FF', '#BDB2FF', '#FFC6FF'] },
    neon: { name: 'Neon', colors: ['#FF006E', '#FB5607', '#FFBE0B', '#3A86FF', '#8338EC', '#00F5D4'] },
    ocean: { name: 'Ocean', colors: ['#03045E', '#0077B6', '#00B4D8', '#48CAE4', '#90E0EF', '#0096C7'] },
    sunset: { name: 'Sunset', colors: ['#F94144', '#F3722C', '#F8961E', '#F9C74F', '#90BE6D', '#43AA8B', '#577590'] },
    forest: { name: 'Forest', colors: ['#264653', '#2A9D8F', '#8AB17D', '#E9C46A', '#F4A261', '#E76F51'] },
    mono: { name: 'Mono purple', colors: ['#4C1D95', '#6D28D9', '#8B5CF6', '#C4B5FD'] },
  };

  const DEFAULT_SETTINGS = {
    duration: 6,
    palette: 'vivid',
    volume: 60,
    sound: true,
    confetti: true,
    speak: false,
    showDialog: true,
    autoRemove: false,
    idle: true,
  };

  // ---------- DOM ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const canvas = $('#wheel');
  const ctx = canvas.getContext('2d');
  const wrap = $('#wheelWrap');
  const pointerEl = $('#pointer');
  const spinBtn = $('#spinBtn');
  const entriesEl = $('#entries');
  const titleEl = $('#wheelTitle');
  const entryCountEl = $('#entryCount');
  const resultCountEl = $('#resultCount');
  const liveRegion = $('#liveRegion');
  const confettiCanvas = $('#confetti');
  const cctx = confettiCanvas.getContext('2d');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Storage helpers ----------
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    },
  };

  // ---------- State ----------
  const saved = store.get(STORE_KEY, null);
  const state = {
    id: saved?.id || uid(),
    title: saved?.title ?? '',
    text: saved?.text ?? DEFAULT_ENTRIES.join('\n'),
    settings: { ...DEFAULT_SETTINGS, ...(saved?.settings || {}) },
    results: Array.isArray(saved?.results) ? saved.results : [],
    image: saved?.image || null,
  };
  if (!PALETTES[state.settings.palette]) state.settings.palette = 'vivid';

  let entries = [];          // [{label, weight, line}]
  let segments = [];         // [{start, end, color, entry}]
  let rotation = 0;          // current wheel rotation (radians)
  let spinning = false;
  let wheelCache = null;     // offscreen canvas with the rendered wheel
  let centerImg = null;      // HTMLImageElement for center image
  let lastWinner = null;     // {entry, color}
  let needsDraw = true;

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function persist() {
    store.set(STORE_KEY, {
      id: state.id, title: state.title, text: state.text,
      settings: state.settings, results: state.results.slice(-500), image: state.image,
    });
  }

  // ---------- Randomness ----------
  function random() {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] / 4294967296;
  }

  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------- Entries ----------
  const WEIGHT_RE = /^(.*?)\s*\*\s*(\d+(?:\.\d+)?)\s*$/;

  function parseEntries(text) {
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < MAX_ENTRIES; i++) {
      let label = lines[i].trim();
      if (!label) continue;
      let weight = 1;
      const m = label.match(WEIGHT_RE);
      if (m && m[1].trim()) {
        label = m[1].trim();
        weight = Math.min(1000, Math.max(0.01, parseFloat(m[2])));
      }
      out.push({ label, weight, line: i });
    }
    return out;
  }

  function lineWithoutWeight(line) {
    const t = line.trim();
    const m = t.match(WEIGHT_RE);
    return m && m[1].trim() ? m[1].trim() : t;
  }

  function nonEmptyLines() {
    return state.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }

  function setText(text, { keepCursor = false } = {}) {
    state.text = text;
    if (!keepCursor) entriesEl.value = text;
    rebuild();
    persist();
  }

  function rebuild() {
    entries = parseEntries(state.text);
    entryCountEl.textContent = entries.length;
    const total = entries.reduce((s, e) => s + e.weight, 0);
    const colors = PALETTES[state.settings.palette].colors;
    segments = [];
    let angle = 0;
    entries.forEach((entry, i) => {
      const size = (entry.weight / total) * TAU;
      let ci = i % colors.length;
      // Avoid the last slice matching the first.
      if (i === entries.length - 1 && entries.length > 1 && ci === 0) ci = Math.min(1, colors.length - 1);
      segments.push({ start: angle, end: angle + size, color: colors[ci], entry });
      angle += size;
    });
    renderCache();
  }

  // ---------- Drawing ----------
  function contrastText(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? '#1c1830' : '#ffffff';
  }

  function fitText(c, text, maxWidth) {
    if (c.measureText(text).width <= maxWidth) return text;
    const chars = [...text];
    let lo = 0, hi = chars.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c.measureText(chars.slice(0, mid).join('') + '…').width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? chars.slice(0, lo).join('') + '…' : '';
  }

  function sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const cssSize = Math.max(200, wrap.clientWidth);
    const px = Math.round(cssSize * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
      renderCache();
    }
  }

  function renderCache() {
    const size = canvas.width || 600;
    if (!wheelCache) wheelCache = document.createElement('canvas');
    wheelCache.width = size;
    wheelCache.height = size;
    const c = wheelCache.getContext('2d');
    const cx = size / 2;
    const R = size / 2 - size * 0.02;
    const hubR = size * 0.085;

    c.clearRect(0, 0, size, size);

    // Outer rim
    c.beginPath();
    c.arc(cx, cx, R + size * 0.012, 0, TAU);
    c.fillStyle = '#ffffff';
    c.shadowColor = 'rgba(0,0,0,0.25)';
    c.shadowBlur = size * 0.02;
    c.fill();
    c.shadowBlur = 0;

    if (!segments.length) {
      c.beginPath();
      c.arc(cx, cx, R, 0, TAU);
      c.fillStyle = '#d9d5e8';
      c.fill();
      c.fillStyle = '#6b6785';
      c.font = `700 ${Math.round(size * 0.04)}px ${getComputedStyle(document.body).fontFamily}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('Add entries to spin', cx, cx - size * 0.15);
    }

    const fontFamily = getComputedStyle(document.body).fontFamily;
    const showLines = segments.length > 1;

    segments.forEach((seg) => {
      c.beginPath();
      c.moveTo(cx, cx);
      c.arc(cx, cx, R, seg.start, seg.end);
      c.closePath();
      c.fillStyle = seg.color;
      c.fill();
      if (showLines && segments.length < 200) {
        c.strokeStyle = 'rgba(255,255,255,0.55)';
        c.lineWidth = Math.max(1, size * 0.002);
        c.stroke();
      }

      // Label
      const arc = seg.end - seg.start;
      const midR = R * 0.62;
      const chord = arc >= Math.PI ? R : 2 * midR * Math.sin(arc / 2);
      let fontSize = Math.min(size * 0.055, chord * 0.62);
      const maxW = R * 0.9 - hubR - size * 0.03;
      if (fontSize < size * 0.012) return; // too thin to label
      c.save();
      c.translate(cx, cx);
      c.rotate(seg.start + arc / 2);
      c.fillStyle = contrastText(seg.color);
      c.textAlign = 'right';
      c.textBaseline = 'middle';
      c.font = `700 ${fontSize}px ${fontFamily}`;
      // Shrink long labels a bit before truncating.
      const w = c.measureText(seg.entry.label).width;
      if (w > maxW) {
        fontSize = Math.max(size * 0.012, fontSize * Math.max(0.6, maxW / w));
        c.font = `700 ${fontSize}px ${fontFamily}`;
      }
      const label = fitText(c, seg.entry.label, maxW);
      c.fillText(label, R * 0.92, 0);
      c.restore();
    });

    // Rim dots
    const dots = 24;
    for (let i = 0; i < dots; i++) {
      const a = (i / dots) * TAU;
      c.beginPath();
      c.arc(cx + Math.cos(a) * (R + size * 0.0005), cx + Math.sin(a) * (R + size * 0.0005), size * 0.006, 0, TAU);
      c.fillStyle = 'rgba(255,255,255,0.9)';
      c.fill();
    }

    // Hub
    c.beginPath();
    c.arc(cx, cx, hubR, 0, TAU);
    c.fillStyle = '#ffffff';
    c.fill();
    if (centerImg && centerImg.complete) {
      c.save();
      c.beginPath();
      c.arc(cx, cx, hubR * 0.94, 0, TAU);
      c.clip();
      const s = hubR * 2;
      const ratio = Math.max(s / centerImg.width, s / centerImg.height);
      const iw = centerImg.width * ratio, ih = centerImg.height * ratio;
      c.drawImage(centerImg, cx - iw / 2, cx - ih / 2, iw, ih);
      c.restore();
    }
    needsDraw = true;
  }

  function draw() {
    const size = canvas.width;
    ctx.clearRect(0, 0, size, size);
    if (!wheelCache) return;
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(rotation);
    ctx.drawImage(wheelCache, -size / 2, -size / 2);
    ctx.restore();
    needsDraw = false;
  }

  // Index of the segment under the pointer (pointer sits at angle 0, the right side).
  function segmentAtPointer(rot = rotation) {
    if (!segments.length) return -1;
    const a = ((-rot % TAU) + TAU) % TAU;
    let lo = 0, hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].end <= a) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // ---------- Audio ----------
  let audioCtx = null;
  function audio() {
    if (!state.settings.sound || state.settings.volume === 0) return null;
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  let lastTickSound = 0;
  function tickSound() {
    const ac = audio();
    if (!ac) return;
    const now = ac.currentTime;
    if (now - lastTickSound < 0.028) return;
    lastTickSound = now;
    const vol = state.settings.volume / 100;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1500, now);
    osc.frequency.exponentialRampToValueAtTime(600, now + 0.03);
    gain.gain.setValueAtTime(0.25 * vol, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  function winSound() {
    const ac = audio();
    if (!ac) return;
    const vol = state.settings.volume / 100;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      const t = ac.currentTime + i * 0.11;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(f, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12 * vol, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + (i === notes.length - 1 ? 0.6 : 0.2));
      osc.connect(gain).connect(ac.destination);
      osc.start(t);
      osc.stop(t + 0.65);
    });
  }

  function speak(text) {
    if (!state.settings.speak || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    speechSynthesis.speak(u);
  }

  // ---------- Pointer flap ----------
  let lastTickAt = 0;
  let lastSegIndex = -1;
  function onSegmentChange() {
    lastTickAt = performance.now();
    tickSound();
  }
  function updatePointer(now) {
    const k = Math.max(0, 1 - (now - lastTickAt) / 110);
    pointerEl.style.transform = `translateY(-50%) rotate(${(-22 * k).toFixed(2)}deg)`;
  }

  // ---------- Spin ----------
  function easeOut(t) {
    // Quintic ease out gives a long, suspenseful slow down.
    return 1 - Math.pow(1 - t, 5);
  }

  let spinAnim = null; // {from, to, start, duration}

  function pickWinnerIndex() {
    const total = entries.reduce((s, e) => s + e.weight, 0);
    let r = random() * total;
    for (let i = 0; i < entries.length; i++) {
      r -= entries[i].weight;
      if (r < 0) return i;
    }
    return entries.length - 1;
  }

  function spin(opts = {}) {
    if (spinning) return;
    if (!entries.length) {
      toast('Add at least one entry first');
      entriesEl.focus();
      return;
    }
    audio(); // unlock audio on user gesture
    closeDialog($('#winnerDialog'));

    const idx = pickWinnerIndex();
    const seg = segments[idx];
    const arc = seg.end - seg.start;
    // Land somewhere inside the slice, away from the edges.
    const target = seg.start + arc * (0.1 + random() * 0.8);
    const current = rotation;
    const base = ((-target % TAU) + TAU) % TAU;           // rotation mod TAU that puts target under pointer
    const curMod = ((current % TAU) + TAU) % TAU;
    let delta = base - curMod;
    if (delta < 0) delta += TAU;
    const duration = Math.max(1.5, opts.duration || state.settings.duration);
    const turns = Math.max(3, Math.round(duration * 1.6)) + Math.floor(random() * 2);
    spinAnim = {
      from: current,
      to: current + delta + turns * TAU,
      start: performance.now(),
      duration: duration * 1000,
      winner: seg,
    };
    spinning = true;
    entriesEl.readOnly = true;
    wrap.classList.add('spinning');
    spinBtn.disabled = true;
  }

  function finishSpin() {
    const seg = spinAnim.winner;
    spinAnim = null;
    spinning = false;
    entriesEl.readOnly = false;
    wrap.classList.remove('spinning');
    spinBtn.disabled = false;
    rotation = rotation % TAU;

    lastWinner = { entry: seg.entry, color: seg.color };
    state.results.push({ name: seg.entry.label, t: Date.now() });
    persist();
    renderResults();

    liveRegion.textContent = `Winner: ${seg.entry.label}`;
    winSound();
    speak(seg.entry.label);
    if (state.settings.confetti && !reducedMotion) burstConfetti(seg.color);

    if (state.settings.autoRemove) {
      removeEntryLine(seg.entry.line);
      toast(`${seg.entry.label} wins and leaves the wheel`);
      if (state.settings.showDialog) showWinner(seg, true);
    } else if (state.settings.showDialog) {
      showWinner(seg, false);
    } else {
      toast(`Winner: ${seg.entry.label}`);
    }
  }

  function removeEntryLine(line) {
    const lines = state.text.split(/\r?\n/);
    if (line >= 0 && line < lines.length) {
      lines.splice(line, 1);
      setText(lines.join('\n'));
    }
  }

  function showWinner(seg, alreadyRemoved) {
    $('#winnerName').textContent = seg.entry.label;
    $('#winnerBar').style.background = seg.color;
    $('[data-action="winner-remove"]').hidden = alreadyRemoved;
    openDialog($('#winnerDialog'));
    $('[data-action="winner-again"]').focus();
  }

  // ---------- Main loop ----------
  let lastFrame = performance.now();
  function frame(now) {
    const dt = Math.min(100, now - lastFrame);
    lastFrame = now;

    if (spinAnim) {
      const t = Math.min(1, (now - spinAnim.start) / spinAnim.duration);
      rotation = spinAnim.from + (spinAnim.to - spinAnim.from) * easeOut(t);
      needsDraw = true;
      if (t >= 1) {
        rotation = spinAnim.to;
        draw();
        finishSpin();
      }
    } else if (drag.coast) {
      rotation += drag.coast * dt;
      drag.coast *= Math.pow(0.992, dt);
      if (Math.abs(drag.coast) < 0.00005) drag.coast = 0;
      needsDraw = true;
    } else if (!drag.active && state.settings.idle && !reducedMotion && segments.length) {
      rotation += dt * 0.00008;
      needsDraw = true;
    }

    const segIdx = segmentAtPointer();
    if (segIdx !== lastSegIndex) {
      if (lastSegIndex !== -1 && (spinAnim || drag.active)) onSegmentChange();
      lastSegIndex = segIdx;
    }
    updatePointer(now);
    if (needsDraw) draw();
    requestAnimationFrame(frame);
  }

  // ---------- Drag / flick ----------
  const drag = { active: false, lastAngle: 0, lastTime: 0, velocity: 0, moved: 0, coast: 0 };

  function angleFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (spinning) return;
    canvas.setPointerCapture(e.pointerId);
    drag.active = true;
    drag.coast = 0;
    drag.lastAngle = angleFromEvent(e);
    drag.lastTime = performance.now();
    drag.velocity = 0;
    drag.moved = 0;
    wrap.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag.active) return;
    const a = angleFromEvent(e);
    let d = a - drag.lastAngle;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastTime);
    rotation += d;
    drag.moved += Math.abs(d);
    drag.velocity = drag.velocity * 0.6 + (d / dt) * 0.4;
    drag.lastAngle = a;
    drag.lastTime = now;
    needsDraw = true;
  });

  function endDrag() {
    if (!drag.active) return;
    drag.active = false;
    wrap.classList.remove('dragging');
    const stale = performance.now() - drag.lastTime > 120;
    const v = stale ? 0 : drag.velocity;
    if (drag.moved < 0.05) {
      spin(); // treat as click
    } else if (Math.abs(v) > 0.006) {
      // A strong flick spins; faster flicks spin longer.
      const duration = Math.min(20, Math.max(3, state.settings.duration * Math.min(1.6, Math.abs(v) / 0.012)));
      spin({ duration });
    } else {
      drag.coast = v;
    }
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  spinBtn.addEventListener('click', () => spin());

  // ---------- Confetti ----------
  let confetti = [];
  let confettiRunning = false;

  function sizeConfetti() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    confettiCanvas.width = innerWidth * dpr;
    confettiCanvas.height = innerHeight * dpr;
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function burstConfetti(accent) {
    sizeConfetti();
    const colors = [accent, ...PALETTES[state.settings.palette].colors];
    const r = canvas.getBoundingClientRect();
    const ox = r.left + r.width / 2, oy = r.top + r.height / 2;
    for (let i = 0; i < 220; i++) {
      const a = random() * TAU;
      const sp = 4 + random() * 10;
      confetti.push({
        x: ox, y: oy,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 6,
        w: 6 + random() * 6, h: 8 + random() * 8,
        rot: random() * TAU, vr: (random() - 0.5) * 0.4,
        color: colors[Math.floor(random() * colors.length)],
        life: 0, max: 140 + random() * 80,
      });
    }
    if (!confettiRunning) {
      confettiRunning = true;
      requestAnimationFrame(confettiFrame);
    }
  }

  function confettiFrame() {
    cctx.clearRect(0, 0, innerWidth, innerHeight);
    confetti = confetti.filter((p) => p.life < p.max && p.y < innerHeight + 40);
    for (const p of confetti) {
      p.life++;
      p.vy += 0.25;
      p.vx *= 0.99;
      p.vy *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      const alpha = Math.min(1, (p.max - p.life) / 30);
      cctx.save();
      cctx.globalAlpha = alpha;
      cctx.translate(p.x, p.y);
      cctx.rotate(p.rot);
      cctx.fillStyle = p.color;
      cctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.life * 0.1)));
      cctx.restore();
    }
    if (confetti.length) requestAnimationFrame(confettiFrame);
    else { confettiRunning = false; cctx.clearRect(0, 0, innerWidth, innerHeight); }
  }

  // ---------- Results ----------
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function renderResults() {
    const res = state.results;
    resultCountEl.textContent = res.length;
    $('#resultsEmpty').hidden = res.length > 0;
    const counts = new Map();
    res.forEach((r) => counts.set(r.name, (counts.get(r.name) || 0) + 1));
    const tally = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    $('#tally').innerHTML = tally.map(([n, c]) => `<li><span>${escapeHtml(n)}</span><span>${c}</span></li>`).join('');
    const fmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', month: 'short', day: 'numeric' });
    $('#history').innerHTML = res.slice().reverse().slice(0, 300).map((r, i) =>
      `<li><b>${res.length - i}. ${escapeHtml(r.name)}</b><time datetime="${new Date(r.t).toISOString()}">${fmt.format(r.t)}</time></li>`
    ).join('');
  }

  // ---------- Teams ----------
  let lastTeams = [];
  function makeTeams() {
    const names = entries.map((e) => e.label);
    const n = Math.min(50, Math.max(2, parseInt($('#teamCount').value, 10) || 2));
    if (names.length < n) { toast(`You need at least ${n} entries for ${n} teams`); return; }
    shuffleArray(names);
    lastTeams = Array.from({ length: n }, () => []);
    names.forEach((name, i) => lastTeams[i % n].push(name));
    const colors = PALETTES[state.settings.palette].colors;
    $('#teams').innerHTML = lastTeams.map((team, i) => {
      const color = colors[i % colors.length];
      return `<div class="team"><h4 style="background:${color};color:${contrastText(color)}">Team ${i + 1} (${team.length})</h4><ul>${team.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul></div>`;
    }).join('');
  }

  // ---------- Share ----------
  function toBase64Url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromBase64Url(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function shareUrl() {
    const payload = { t: state.title, e: nonEmptyLines(), p: state.settings.palette, d: state.settings.duration };
    const url = new URL(location.href);
    url.hash = 'w=' + toBase64Url(JSON.stringify(payload));
    url.search = '';
    return url.toString();
  }

  function loadFromHash() {
    const m = location.hash.match(/^#w=([A-Za-z0-9_-]+)$/);
    if (!m) return false;
    try {
      const data = JSON.parse(fromBase64Url(m[1]));
      if (!Array.isArray(data.e)) return false;
      state.id = uid();
      state.title = String(data.t || '').slice(0, 80);
      state.text = data.e.map((x) => String(x).slice(0, 200)).slice(0, MAX_ENTRIES).join('\n');
      state.results = [];
      if (PALETTES[data.p]) state.settings.palette = data.p;
      if (Number.isFinite(data.d)) state.settings.duration = Math.min(20, Math.max(2, data.d));
      history.replaceState(null, '', location.pathname + location.search);
      return true;
    } catch {
      return false;
    }
  }

  // ---------- Saved wheels ----------
  function savedWheels() { return store.get(SAVED_KEY, []); }

  function saveWheel() {
    const list = savedWheels();
    const item = {
      id: state.id,
      title: state.title || 'Untitled wheel',
      text: state.text,
      palette: state.settings.palette,
      image: state.image,
      updated: Date.now(),
    };
    const i = list.findIndex((w) => w.id === state.id);
    if (i >= 0) list[i] = item; else list.unshift(item);
    if (store.set(SAVED_KEY, list)) toast(`Saved "${item.title}"`);
    else toast('Storage full. Remove a saved wheel or the center image.');
  }

  function renderSaved() {
    const list = savedWheels().sort((a, b) => b.updated - a.updated);
    $('#savedEmpty').hidden = list.length > 0;
    const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    $('#savedList').innerHTML = list.map((w) => {
      const count = w.text.split(/\r?\n/).filter((l) => l.trim()).length;
      return `<li data-id="${escapeHtml(w.id)}">
        <div class="meta"><b>${escapeHtml(w.title)}</b><small>${count} entries · ${fmt.format(w.updated)}</small></div>
        <button class="btn primary" data-action="load-saved">Open</button>
        <button class="chip danger" data-action="delete-saved" aria-label="Delete ${escapeHtml(w.title)}">Delete</button>
      </li>`;
    }).join('');
  }

  function loadSaved(id) {
    const w = savedWheels().find((x) => x.id === id);
    if (!w) return;
    state.id = w.id;
    state.title = w.title === 'Untitled wheel' ? '' : w.title;
    state.image = w.image || null;
    if (PALETTES[w.palette]) state.settings.palette = w.palette;
    state.results = [];
    titleEl.value = state.title;
    loadCenterImage();
    setText(w.text);
    renderResults();
    closeDialog($('#openDialog'));
    toast(`Opened "${w.title}"`);
  }

  // ---------- Center image ----------
  function loadCenterImage() {
    spinBtn.classList.toggle('has-image', !!state.image);
    if (!state.image) { centerImg = null; renderCache(); return; }
    const img = new Image();
    img.onload = () => { centerImg = img; renderCache(); };
    img.src = state.image;
  }

  function handleImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Downscale to keep storage small.
        const max = 320;
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s);
        c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        state.image = c.toDataURL('image/png');
        persist();
        loadCenterImage();
        toast('Center image updated');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // ---------- Dialogs & toast ----------
  function openDialog(d) {
    if (d.open) return;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  }
  function closeDialog(d) {
    if (!d.open) return;
    if (typeof d.close === 'function') d.close();
    else d.removeAttribute('open');
  }
  $$('dialog').forEach((d) => {
    // Close on backdrop click.
    d.addEventListener('click', (e) => { if (e.target === d) closeDialog(d); });
  });

  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function copyText(text, okMsg = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast(okMsg); } catch { toast('Copy failed'); }
      ta.remove();
    }
  }

  function download(filename, content, type = 'text/plain') {
    const blob = new Blob([content], { type: `${type};charset=utf-8` });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function slug(s) {
    return (s || 'wheel').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'wheel';
  }

  function csvCell(s) {
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // ---------- Theme ----------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
  }
  function toggleTheme() {
    const isDark = document.documentElement.dataset.theme === 'dark' ||
      (document.documentElement.dataset.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    applyTheme(next);
    store.set(THEME_KEY, next);
  }

  // ---------- Fullscreen ----------
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      (document.documentElement.requestFullscreen?.() || Promise.reject()).catch(() => {
        document.body.classList.toggle('is-fullscreen');
        requestAnimationFrame(sizeCanvas);
      });
    } else {
      document.exitFullscreen();
    }
  }
  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement);
    requestAnimationFrame(sizeCanvas);
  });

  // ---------- Tabs ----------
  const tabs = $$('.tab');
  function selectTab(tab) {
    tabs.forEach((t) => {
      const on = t === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
      $('#' + t.getAttribute('aria-controls')).hidden = !on;
    });
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        selectTab(next);
        next.focus();
      }
    });
  });

  // ---------- Settings form ----------
  const form = $('#settingsForm');
  const paletteSelect = $('#paletteSelect');
  paletteSelect.innerHTML = Object.entries(PALETTES).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('');

  function syncSettingsForm() {
    const s = state.settings;
    form.duration.value = s.duration;
    form.palette.value = s.palette;
    form.volume.value = s.volume;
    ['sound', 'confetti', 'speak', 'showDialog', 'autoRemove', 'idle'].forEach((k) => { form[k].checked = !!s[k]; });
    $('#durationOut').textContent = `${s.duration}s`;
    $('#volumeOut').textContent = `${s.volume}%`;
  }

  form.addEventListener('input', () => {
    const s = state.settings;
    s.duration = parseInt(form.duration.value, 10);
    s.volume = parseInt(form.volume.value, 10);
    ['sound', 'confetti', 'speak', 'showDialog', 'autoRemove', 'idle'].forEach((k) => { s[k] = form[k].checked; });
    if (s.palette !== form.palette.value) {
      s.palette = form.palette.value;
      rebuild();
    }
    $('#durationOut').textContent = `${s.duration}s`;
    $('#volumeOut').textContent = `${s.volume}%`;
    persist();
  });

  $('#imageFile').addEventListener('change', (e) => { handleImageFile(e.target.files[0]); e.target.value = ''; });

  // ---------- Import ----------
  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const isCsv = /\.csv$/i.test(file.name);
      const lines = String(reader.result).split(/\r?\n/)
        .map((l) => (isCsv ? l.split(',')[0].replace(/^"|"$/g, '') : l).trim())
        .filter(Boolean);
      if (!lines.length) { toast('No entries found in that file'); return; }
      const merged = [...nonEmptyLines(), ...lines].slice(0, MAX_ENTRIES);
      setText(merged.join('\n'));
      toast(`Imported ${lines.length} entries`);
    };
    reader.readAsText(file);
  });

  // ---------- Actions ----------
  const actions = {
    new() {
      if (entries.length && !confirm('Start a new wheel? Unsaved changes to this wheel will be lost.')) return;
      state.id = uid();
      state.title = '';
      state.results = [];
      state.image = null;
      titleEl.value = '';
      loadCenterImage();
      setText('');
      renderResults();
      entriesEl.focus();
    },
    open() { renderSaved(); openDialog($('#openDialog')); },
    save: saveWheel,
    share() {
      $('#shareUrl').value = shareUrl();
      openDialog($('#shareDialog'));
      $('#shareUrl').select();
    },
    'copy-share'() {
      const url = $('#shareUrl').value;
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        navigator.share({ title: state.title || 'ZexWheel', url }).catch(() => copyText(url, 'Link copied'));
      } else {
        copyText(url, 'Link copied');
      }
    },
    fullscreen: toggleFullscreen,
    settings() { syncSettingsForm(); openDialog($('#settingsDialog')); },
    theme: toggleTheme,
    shuffle() { setText(shuffleArray(nonEmptyLines()).join('\n')); toast('Shuffled'); },
    sort() {
      const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      setText(nonEmptyLines().sort((a, b) => coll.compare(lineWithoutWeight(a), lineWithoutWeight(b))).join('\n'));
      toast('Sorted A to Z');
    },
    dedupe() {
      const seen = new Set();
      const lines = nonEmptyLines();
      const out = lines.filter((l) => {
        const k = lineWithoutWeight(l).toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      setText(out.join('\n'));
      toast(`Removed ${lines.length - out.length} duplicate${lines.length - out.length === 1 ? '' : 's'}`);
    },
    import() { $('#importFile').click(); },
    export() { download(`${slug(state.title)}-entries.txt`, nonEmptyLines().join('\n')); },
    clear() {
      if (!entries.length) return;
      if (!confirm('Remove all entries?')) return;
      setText('');
      entriesEl.focus();
    },
    'copy-results'() {
      if (!state.results.length) { toast('No results yet'); return; }
      copyText(state.results.map((r, i) => `${i + 1}. ${r.name}`).join('\n'), 'Results copied');
    },
    'export-results'() {
      if (!state.results.length) { toast('No results yet'); return; }
      const rows = ['spin,winner,time', ...state.results.map((r, i) => `${i + 1},${csvCell(r.name)},${new Date(r.t).toISOString()}`)];
      download(`${slug(state.title)}-results.csv`, rows.join('\n'), 'text/csv');
    },
    'clear-results'() {
      if (!state.results.length) return;
      if (!confirm('Clear all results?')) return;
      state.results = [];
      persist();
      renderResults();
    },
    'make-teams': makeTeams,
    'copy-teams'() {
      if (!lastTeams.length) { toast('Generate teams first'); return; }
      copyText(lastTeams.map((t, i) => `Team ${i + 1}: ${t.join(', ')}`).join('\n'), 'Teams copied');
    },
    'winner-close'() { closeDialog($('#winnerDialog')); },
    'winner-remove'() {
      if (lastWinner) removeEntryLine(lastWinner.entry.line);
      closeDialog($('#winnerDialog'));
    },
    'winner-again'() { closeDialog($('#winnerDialog')); spin(); },
    'pick-image'() { $('#imageFile').click(); },
    'clear-image'() { state.image = null; persist(); loadCenterImage(); toast('Center image removed'); },
    'close-dialog'(btn) { closeDialog(btn.closest('dialog')); },
    'load-saved'(btn) { loadSaved(btn.closest('li').dataset.id); },
    'delete-saved'(btn) {
      const id = btn.closest('li').dataset.id;
      if (!confirm('Delete this saved wheel?')) return;
      store.set(SAVED_KEY, savedWheels().filter((w) => w.id !== id));
      renderSaved();
    },
  };

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const fn = actions[btn.dataset.action];
    if (fn) { e.preventDefault(); fn(btn); }
  });

  // ---------- Inputs ----------
  let inputTimer = 0;
  entriesEl.addEventListener('input', () => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => setText(entriesEl.value, { keepCursor: true }), 120);
  });

  titleEl.addEventListener('input', () => {
    state.title = titleEl.value;
    document.title = (state.title ? `${state.title} | ` : '') + 'ZexWheel: Spin the Wheel';
    persist();
  });

  // ---------- Keyboard ----------
  document.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    const anyDialogOpen = $$('dialog').some((d) => d.open && d.id !== 'winnerDialog');
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!anyDialogOpen) spin();
      return;
    }
    if (inField || anyDialogOpen || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ' && document.activeElement?.tagName !== 'BUTTON') {
      e.preventDefault();
      spin();
    } else if (e.key === 'f' || e.key === 'F') {
      toggleFullscreen();
    }
  });

  // ---------- Resize ----------
  const ro = new ResizeObserver(() => sizeCanvas());
  ro.observe(wrap);
  addEventListener('resize', () => { if (confettiRunning) sizeConfetti(); });

  // ---------- Init ----------
  applyTheme(store.get(THEME_KEY, 'auto'));
  if (loadFromHash()) {
    persist();
    setTimeout(() => toast('Loaded a shared wheel'), 300);
  }
  titleEl.value = state.title;
  if (state.title) document.title = `${state.title} | ZexWheel: Spin the Wheel`;
  entriesEl.value = state.text;
  $('#year').textContent = new Date().getFullYear();
  rebuild();
  sizeCanvas();
  loadCenterImage();
  renderResults();
  requestAnimationFrame(frame);

  // Offline support
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
