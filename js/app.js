/* Quik Web – a browser video editor inspired by GoPro Quik.
   Everything runs locally: media never leaves the browser. */
(() => {
'use strict';

/* ======================================================================
   Helpers
   ====================================================================== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const easeInOut = (p) => p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
const fmt = (s) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
};
const ASPECTS = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5] };
const PREVIEW_LONG = 1280;
const MIN_CLIP = 0.2;
const IS_IOS = /iP(hone|ad|od)/.test(navigator.platform) || (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
const HAS_CTX_FILTER = (() => { try { const c = document.createElement('canvas').getContext('2d'); return typeof c.filter === 'string'; } catch (e) { return false; } })();
const phoneLayout = window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-height: 500px)');

let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ======================================================================
   State
   ====================================================================== */
function newProject() {
  return { title: '', aspect: '16:9', theme: 'classic', pace: 'medium', themeTitle: true, themeMusic: true, clips: [], music: null };
}
function defaultClip(m) {
  return {
    id: uid(), mediaId: m.id, kind: m.kind, name: m.name,
    start: 0, end: m.kind === 'video' ? m.duration : 0,
    speed: 1, volume: 1, imageDuration: 3, kenBurns: true,
    fit: 'cover', zoom: 1, panX: 0, panY: 0,
    filter: { preset: 'none', brightness: 1, contrast: 1, saturation: 1, vignette: 0 },
    text: { content: '', pos: 'center', style: 'bold', size: 0.08, color: '#ffffff', accent: '#111111', anim: 'fade', dur: 0 },
    transition: { type: 'none', duration: 0.6 }
  };
}

const state = {
  project: newProject(),
  media: new Map(),       // id -> { id, kind, name, blob, url, el, scratch, duration, w, h, thumb, strip }
  selectedId: null,
  playhead: 0,
  playing: false,
  exporting: false,
  undo: [], redo: [],
  snapCache: new Map(),   // clipId -> canvas holding that clip's final frame (for transitions)
  tlZoom: 60,             // timeline pixels per second
  activeTab: 'clip',
  library: [],            // built-in music tracks (music/library.json)
  previewId: null         // library track currently previewing
};
const P = () => state.project;

/* ======================================================================
   Timeline model
   ====================================================================== */
function clipDuration(c) {
  if (c.kind === 'image') return Math.max(MIN_CLIP, c.imageDuration);
  return Math.max(MIN_CLIP / 8, (c.end - c.start) / c.speed);
}
function layout() {
  let t = 0;
  return P().clips.map((clip, idx) => {
    const dur = clipDuration(clip);
    const item = { clip, idx, offset: t, dur };
    t += dur;
    return item;
  });
}
function totalDuration() { return P().clips.reduce((s, c) => s + clipDuration(c), 0); }
function locate(t) {
  const L = layout();
  if (!L.length) return null;
  for (const item of L) {
    if (t < item.offset + item.dur) return { ...item, lt: Math.max(0, t - item.offset) };
  }
  const last = L[L.length - 1];
  return { ...last, lt: Math.max(0, last.dur - 0.001) };
}
function clipById(id) { return P().clips.find(c => c.id === id) || null; }
function selectedClip() { return clipById(state.selectedId); }
function clipOffset(id) { const it = layout().find(i => i.clip.id === id); return it ? it.offset : 0; }

/* ======================================================================
   Undo / persistence
   ====================================================================== */
function pushUndo() {
  state.undo.push(JSON.stringify(P()));
  if (state.undo.length > 60) state.undo.shift();
  state.redo.length = 0;
  updateUndoButtons();
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(JSON.stringify(P()));
  state.project = JSON.parse(state.undo.pop());
  afterProjectReplaced();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(JSON.stringify(P()));
  state.project = JSON.parse(state.redo.pop());
  afterProjectReplaced();
}
function afterProjectReplaced() {
  state.snapCache.clear();
  if (!clipById(state.selectedId)) state.selectedId = null;
  applyAspect();
  state.playhead = clamp(state.playhead, 0, totalDuration());
  renderAll();
  save();
  updateUndoButtons();
}
function updateUndoButtons() {
  $('#undoBtn').disabled = !state.undo.length;
  $('#redoBtn').disabled = !state.redo.length;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    DB.putKV('project', JSON.parse(JSON.stringify(P())));
    DB.putKV('media', Array.from(state.media.values()).map(m => ({ id: m.id, kind: m.kind, name: m.name })));
  }, 300);
}

/* ======================================================================
   Media import
   ====================================================================== */
function seekTo(el, t) {
  return new Promise(resolve => {
    t = clamp(t, 0, isFinite(el.duration) ? Math.max(0, el.duration - 0.01) : t);
    if (Math.abs(el.currentTime - t) < 0.005 && el.readyState >= 2) return resolve();
    let done = false;
    const finish = () => { if (done) return; done = true; el.removeEventListener('seeked', finish); clearTimeout(timer); resolve(); };
    const timer = setTimeout(finish, 1500);
    el.addEventListener('seeked', finish);
    try { el.currentTime = t; } catch (e) { finish(); }
  });
}

function waitFrame(el, ms = 300) {
  if (!el || typeof el.requestVideoFrameCallback !== 'function') return new Promise(r => setTimeout(r, 30));
  return new Promise(r => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; el.requestVideoFrameCallback(fin); setTimeout(fin, ms); });
}
function isBlack(dataUrl) {
  // Cheap heuristic: a solid black JPEG compresses to a few hundred bytes.
  return !dataUrl || dataUrl.length < 1200;
}
/* Seeks a (muted) video element to t and returns a thumbnail, working around iOS not painting
   frames of a video that has never played by nudging it with a muted play/pause. */
async function grabVideoThumb(el, t, w, h, size = 200) {
  await seekTo(el, t); await waitFrame(el);
  let thumb = thumbFrom(el, w, h, size);
  if (isBlack(thumb) && el.muted) {
    try { await el.play(); } catch (e) {}
    await waitFrame(el, 400);
    el.pause();
    await seekTo(el, t); await waitFrame(el);
    thumb = thumbFrom(el, w, h, size);
  }
  return thumb;
}
function thumbFrom(source, w, h, size = 200) {
  const c = document.createElement('canvas');
  const scale = size / Math.max(w, h);
  c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

async function loadVideoMedia(entry) {
  const el = document.createElement('video');
  // Starts muted: iOS only decodes a muted video before the user has tapped play.
  // unlockMedia() unmutes it inside the first play gesture.
  el.preload = 'auto'; el.playsInline = true; el.muted = true; el.setAttribute('muted', ''); el.setAttribute('playsinline', ''); el.src = entry.url;
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timed out while reading the video')), 25000);
    el.addEventListener('loadedmetadata', () => { clearTimeout(timer); res(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(timer); rej(new Error('the browser cannot play this video format')); }, { once: true });
    try { el.load(); } catch (e) {}
  });
  // WebM files recorded by MediaRecorder report an infinite duration until seeked to the end.
  if (!isFinite(el.duration)) {
    await new Promise(res => {
      const t = setTimeout(res, 3000);
      el.addEventListener('durationchange', () => { if (isFinite(el.duration)) { clearTimeout(t); res(); } });
      el.currentTime = 1e9;
    });
    await seekTo(el, 0);
  }
  entry.el = el;
  entry.duration = isFinite(el.duration) ? el.duration : 10;
  entry.w = el.videoWidth || 1280; entry.h = el.videoHeight || 720;
  // Second element of the same source used for thumbnails / transition snapshots
  // so it never fights the preview element for the decoder position. It is muted,
  // which also lets iOS decode frames before the user has tapped play.
  const scratch = document.createElement('video');
  scratch.preload = 'auto'; scratch.muted = true; scratch.playsInline = true; scratch.setAttribute('muted', ''); scratch.src = entry.url;
  await new Promise(res => { scratch.addEventListener('loadedmetadata', res, { once: true }); scratch.addEventListener('error', res, { once: true }); setTimeout(res, 3000); });
  entry.scratch = scratch;
  entry.thumb = await grabVideoThumb(scratch, Math.min(0.5, entry.duration / 2), entry.w, entry.h);
  if (isBlack(entry.thumb)) entry.thumb = await grabVideoThumb(el, Math.min(0.5, entry.duration / 2), entry.w, entry.h);
  connectAudioEl(el);
}

async function loadImageMedia(entry) {
  const img = new Image();
  await new Promise((res, rej) => {
    let settled = false;
    const ok = () => { if (!settled) { settled = true; clearTimeout(timer); res(); } };
    const bad = (why) => { if (!settled) { settled = true; clearTimeout(timer); rej(new Error(why)); } };
    const timer = setTimeout(() => img.naturalWidth ? ok() : bad('timed out while reading the photo'), 25000);
    img.onload = ok;
    img.onerror = () => bad('the browser cannot decode this photo format');
    img.src = entry.url;
    if (img.complete && img.naturalWidth) ok();
  });
  // decode() is best effort only: Safari rejects it for very large photos even though the image is usable.
  try { await img.decode(); } catch (e) {}
  if (!img.naturalWidth) throw new Error('the photo has no readable pixels');
  entry.w = img.naturalWidth; entry.h = img.naturalHeight; entry.duration = 0;
  // Phones take 12–48 MP photos; drawing those every frame is slow and memory hungry, so keep a ≤2048px copy.
  const MAX = 2048;
  if (Math.max(entry.w, entry.h) > MAX) {
    const k = MAX / Math.max(entry.w, entry.h);
    const c = document.createElement('canvas');
    c.width = Math.round(entry.w * k); c.height = Math.round(entry.h * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    entry.el = c; entry.w = c.width; entry.h = c.height;
  } else entry.el = img;
  entry.thumb = thumbFrom(entry.el, entry.w, entry.h);
}

async function loadMedia(entry) {
  entry.url = URL.createObjectURL(entry.blob);
  if (entry.kind === 'video') await loadVideoMedia(entry); else await loadImageMedia(entry);
  state.media.set(entry.id, entry);
  return entry;
}

/* Photos pickers on phones sometimes hand over files with an empty MIME type; fall back to the extension. */
function mediaKind(file) {
  const t = (file.type || '').toLowerCase();
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('image/')) return 'image';
  const ext = (file.name || '').toLowerCase().split('.').pop();
  if (['mov', 'mp4', 'm4v', 'webm', 'mkv', 'avi', '3gp', 'hevc'].includes(ext)) return 'video';
  if (['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'avif', 'tif', 'tiff'].includes(ext)) return 'image';
  return null;
}
async function importFiles(files) {
  const all = Array.from(files || []);
  const list = all.filter(f => mediaKind(f));
  if (!list.length) { toast(all.length ? `Unsupported file type: ${all[0].name}` : 'No files were selected', 4000); return []; }
  const added = [], failed = [];
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    toast(`Importing ${i + 1}/${list.length}: ${file.name}…`, 60000);
    const entry = { id: uid(), kind: mediaKind(file), name: file.name || `file-${i + 1}`, blob: file };
    try {
      await loadMedia(entry);
      added.push(entry);
      // Persist for reloads, but never let a slow or broken IndexedDB block the import.
      Promise.race([DB.putFile(entry.id, file), new Promise(r => setTimeout(r, 8000))]).catch(() => {});
      renderMediaGrid();
    } catch (e) {
      console.warn('import failed', file.name, e);
      failed.push(`${file.name}: ${e && e.message ? e.message : e}`);
    }
  }
  renderMediaGrid();
  save();
  if (failed.length) toast(`Could not open ${failed.length} file${failed.length > 1 ? 's' : ''} – ${failed[0]}`, 7000);
  else if (added.length) toast(`Added ${added.length} file${added.length > 1 ? 's' : ''} to the media bin`);
  return added;
}

async function removeMedia(id) {
  const m = state.media.get(id);
  if (!m) return;
  if (P().clips.some(c => c.mediaId === id)) {
    if (!confirm('This file is used on the timeline. Remove it and its clips?')) return;
    pushUndo();
    P().clips = P().clips.filter(c => c.mediaId !== id);
    if (!clipById(state.selectedId)) state.selectedId = null;
  }
  state.media.delete(id);
  URL.revokeObjectURL(m.url);
  await DB.deleteFile(id);
  state.snapCache.clear();
  renderAll(); save();
}

/* Filmstrip thumbnails (8 frames across the source) for the trim control. */
async function buildStrip(m) {
  if (m.strip) return m.strip;
  if (m.kind === 'image') { m.strip = [m.thumb]; return m.strip; }
  const n = 8, out = [];
  const el = m.scratch;
  for (let i = 0; i < n; i++) out.push(await grabVideoThumb(el, (i + 0.5) / n * m.duration, m.w, m.h, 120));
  m.strip = out;
  return out;
}

/* ======================================================================
   Audio graph (preview + export)
   ====================================================================== */
let actx = null, masterGain = null, recDest = null;
const sourcedEls = new WeakSet();
const gainFor = new WeakMap();   // media element -> GainNode (volume control that also works on iOS)
function setElVolume(el, v) {
  v = clamp(v, 0, 1);
  const g = gainFor.get(el);
  if (g) { g.gain.value = v; el.muted = false; }
  else { try { el.volume = v; } catch (e) {} el.muted = v === 0; }
}
/* iOS lets a media element play later only if play() was first called inside a user gesture.
   Called from the play button: starts and immediately pauses every element once. */
const unlockedEls = new WeakSet();
function unlockMedia() {
  const els = [musicEl];
  state.media.forEach(m => { if (m.kind === 'video') els.push(m.el); });
  els.forEach(el => {
    if (unlockedEls.has(el) || !el.src) return;
    unlockedEls.add(el);
    // Play silently, then pause again unless playback has meanwhile started on this element.
    const g = gainFor.get(el);
    const savedGain = g ? g.gain.value : null, savedMuted = false;
    if (g) { g.gain.value = 0; el.muted = false; } else el.muted = true;
    const restore = () => {
      const active = state.playing && activeIdx >= 0 && P().clips[activeIdx] ? state.media.get(P().clips[activeIdx].mediaId) : null;
      const keep = (el === musicEl && state.playing && P().music) || (active && active.el === el);
      if (!keep) { el.pause(); if (g) g.gain.value = savedGain; else el.muted = savedMuted; }
      else if (!g) el.muted = savedMuted;
    };
    try { const p = el.play(); if (p && p.then) p.then(restore).catch(restore); else setTimeout(restore, 50); } catch (e) { restore(); }
  });
}
const musicEl = new Audio();
musicEl.preload = 'auto';

function ensureAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  actx = new AC();
  masterGain = actx.createGain();
  masterGain.connect(actx.destination);
  recDest = actx.createMediaStreamDestination();
  state.media.forEach(m => { if (m.kind === 'video') connectAudioEl(m.el); });
  connectAudioEl(musicEl);
}
function connectAudioEl(el) {
  if (!actx || sourcedEls.has(el)) return;
  try {
    const src = actx.createMediaElementSource(el);
    const g = actx.createGain();
    g.gain.value = isFinite(el.volume) ? el.volume : 1;
    src.connect(g);
    g.connect(masterGain);
    g.connect(recDest);
    sourcedEls.add(el);
    gainFor.set(el, g);
  } catch (e) { console.warn('audio connect', e); }
}

/* ======================================================================
   Renderer
   ====================================================================== */
const canvas = $('#preview');
const ctx = canvas.getContext('2d');
let W = canvas.width, H = canvas.height;

function setCanvasSize(long) {
  const [aw, ah] = ASPECTS[P().aspect] || ASPECTS['16:9'];
  if (aw >= ah) { W = long; H = Math.round(long * ah / aw); } else { H = long; W = Math.round(long * aw / ah); }
  W -= W % 2; H -= H % 2;
  canvas.width = W; canvas.height = H;
}
function applyAspect() {
  setCanvasSize(PREVIEW_LONG);
  state.snapCache.clear();
  $('#aspectSelect').value = P().aspect;
}

function filterCss(f) {
  const parts = [];
  const preset = FILTERS[f.preset];
  if (preset && preset.css) parts.push(preset.css);
  if (f.brightness !== 1) parts.push(`brightness(${f.brightness})`);
  if (f.contrast !== 1) parts.push(`contrast(${f.contrast})`);
  if (f.saturation !== 1) parts.push(`saturate(${f.saturation})`);
  return parts.join(' ') || 'none';
}

function drawSource(c, m, el, lt, dur) {
  const sw = m.w, sh = m.h;
  let scale = c.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  let z = c.zoom, drift = 0;
  if (c.kind === 'image' && c.kenBurns) {
    const p = clamp(lt / dur, 0, 1);
    z *= 1 + 0.12 * p;
    drift = (p - 0.5) * 0.06 * W;
  }
  scale *= z;
  const dw = sw * scale, dh = sh * scale;
  const dx = (W - dw) / 2 - c.panX * Math.abs(dw - W) / 2 + drift;
  const dy = (H - dh) / 2 - c.panY * Math.abs(dh - H) / 2;
  ctx.save();
  const css = filterCss(c.filter);
  if (HAS_CTX_FILTER) ctx.filter = css;
  try { ctx.drawImage(el, dx, dy, dw, dh); } catch (e) { /* frame not ready */ }
  ctx.restore();
  if (!HAS_CTX_FILTER && css !== 'none') applyFilterFallback(css);
  if (c.filter.vignette > 0) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${0.85 * c.filter.vignette})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
}

/* Approximates CSS filter functions with canvas blend modes when ctx.filter is unavailable. */
function applyFilterFallback(css) {
  const re = /(\w[\w-]*)\(([^)]*)\)/g; let m;
  ctx.save();
  while ((m = re.exec(css))) {
    const fn = m[1]; const v = parseFloat(m[2]);
    const blend = (mode, color, alpha) => { ctx.globalCompositeOperation = mode; ctx.globalAlpha = clamp(alpha, 0, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, W, H); };
    switch (fn) {
      case 'grayscale': blend('saturation', '#808080', v); break;
      case 'saturate':
        if (v < 1) blend('saturation', '#808080', 1 - v);
        else if (v > 1) { ctx.globalCompositeOperation = 'saturation'; ctx.globalAlpha = clamp((v - 1) * 0.6, 0, 1); ctx.drawImage(canvas, 0, 0); }
        break;
      case 'sepia': blend('color', '#a67c52', v * 0.8); break;
      case 'brightness': if (v > 1) blend('screen', '#ffffff', (v - 1)); else if (v < 1) blend('multiply', '#000000', 1 - v); break;
      case 'contrast':
        if (v > 1) { ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = clamp((v - 1) * 1.2, 0, 1); ctx.drawImage(canvas, 0, 0); }
        else if (v < 1) blend('source-over', '#808080', (1 - v));
        break;
      case 'hue-rotate': blend('hue', v < 0 ? '#4f8cff' : '#ff7a4f', Math.min(0.35, Math.abs(v) / 90)); break;
    }
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
}

function drawText(c, lt, dur) {
  const t = c.text;
  const content = (t.content || '').trim();
  if (!content) return;
  const showDur = t.dur > 0 ? Math.max(0.5, dur * t.dur) : dur;
  if (lt > showDur) return;
  const animT = 0.5;
  const p = t.anim === 'none' ? 1 : clamp(lt / animT, 0, 1);
  const outP = clamp((showDur - lt) / 0.3, 0, 1); // short fade out at the end
  const fontSize = t.size * H;
  const lineH = fontSize * 1.2;
  const isLower = t.style === 'lower';
  const weight = t.style === 'minimal' ? 300 : 800;
  const family = '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
  let lines = content.split('\n');
  if (t.anim === 'typewriter') {
    const total = content.length;
    const shown = Math.floor(clamp(lt / Math.min(1.5, showDur), 0, 1) * total);
    let remain = shown;
    lines = lines.map(l => { const s = l.slice(0, Math.max(0, remain)); remain -= l.length + 1; return s; });
  }
  ctx.save();
  ctx.globalAlpha = (t.anim === 'fade' || t.anim === 'slideUp' ? p : 1) * outP;
  ctx.font = `${weight} ${fontSize}px ${family}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = isLower ? 'left' : 'center';
  const x = isLower ? W * 0.08 : W / 2;
  let y0;
  if (isLower) y0 = H * 0.86 - (lines.length - 1) * lineH;
  else if (t.pos === 'top') y0 = H * 0.14;
  else if (t.pos === 'bottom') y0 = H * 0.86 - (lines.length - 1) * lineH;
  else y0 = H / 2 - (lines.length - 1) * lineH / 2;
  let dy = 0, scale = 1;
  if (t.anim === 'slideUp') dy = (1 - easeOut(p)) * fontSize * 0.8;
  if (t.anim === 'pop') scale = 0.6 + 0.4 * easeOut(p);
  ctx.translate(x, y0 + dy); ctx.scale(scale, scale); ctx.translate(-x, -(y0 + dy));
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = fontSize * 0.15; ctx.shadowOffsetY = fontSize * 0.04;
  lines.forEach((line, i) => {
    const y = y0 + dy + i * lineH;
    if (t.style === 'box' || isLower) {
      const w = ctx.measureText(line).width;
      const padX = fontSize * 0.4, padY = fontSize * 0.2;
      ctx.save(); ctx.shadowColor = 'transparent';
      ctx.fillStyle = t.accent;
      const bx = isLower ? x - padX : x - w / 2 - padX;
      ctx.fillRect(bx, y - lineH / 2 - padY / 2 + fontSize * 0.1, w + padX * 2, lineH + padY - fontSize * 0.1);
      if (isLower) { ctx.fillStyle = t.color; ctx.fillRect(bx - fontSize * 0.25, y - lineH / 2 - padY / 2 + fontSize * 0.1, fontSize * 0.12, lineH + padY - fontSize * 0.1); }
      ctx.restore();
    }
    if (t.style === 'outline') {
      ctx.lineWidth = fontSize * 0.1; ctx.lineJoin = 'round'; ctx.strokeStyle = t.accent;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = t.color;
    ctx.fillText(line, x, y);
  });
  ctx.restore();
}

function snapshotCanvas() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').drawImage(canvas, 0, 0);
  return c;
}

/* Last frame of clip[idx], used as the "from" image for transitions.
   During playback it is captured live; when scrubbing it is rendered on demand. */
const snapPending = new Set();
function snapshotFor(idx) {
  const clip = P().clips[idx];
  if (!clip) return null;
  const snap = state.snapCache.get(clip.id);
  if (snap && snap.width === W && snap.height === H) return snap;
  if (!state.playing && !snapPending.has(clip.id)) {
    snapPending.add(clip.id);
    renderClipLastFrame(clip).then(c => {
      snapPending.delete(clip.id);
      if (c) { state.snapCache.set(clip.id, c); if (!state.playing) renderAt(state.playhead); }
    });
  }
  return null;
}
async function renderClipLastFrame(clip) {
  const m = state.media.get(clip.mediaId);
  if (!m) return null;
  const dur = clipDuration(clip);
  let el = m.el;
  if (clip.kind === 'video') { el = m.scratch; await seekTo(el, clip.end - 0.03); }
  const saved = snapshotCanvas();
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  drawSource(clip, m, el, dur, dur);
  drawText(clip, dur, dur);
  const out = snapshotCanvas();
  ctx.drawImage(saved, 0, 0);
  return out;
}

function drawTransition(c, idx, lt) {
  const tr = c.transition;
  if (!tr || tr.type === 'none' || lt >= tr.duration) return;
  const p = clamp(lt / tr.duration, 0, 1);
  const prev = idx > 0 ? snapshotFor(idx - 1) : null;
  ctx.save();
  switch (tr.type) {
    case 'crossfade':
      if (prev) { ctx.globalAlpha = 1 - easeInOut(p); ctx.drawImage(prev, 0, 0); }
      break;
    case 'fade':
      if (prev && p < 0.5) { ctx.drawImage(prev, 0, 0); ctx.fillStyle = `rgba(0,0,0,${p * 2})`; }
      else ctx.fillStyle = `rgba(0,0,0,${prev ? 1 - (p - 0.5) * 2 : 1 - p})`;
      ctx.fillRect(0, 0, W, H);
      break;
    case 'flash':
      if (prev && p < 0.5) { ctx.drawImage(prev, 0, 0); ctx.fillStyle = `rgba(255,255,255,${p * 2})`; }
      else ctx.fillStyle = `rgba(255,255,255,${prev ? 1 - (p - 0.5) * 2 : 1 - p})`;
      ctx.fillRect(0, 0, W, H);
      break;
    case 'slide':
      if (prev) ctx.drawImage(prev, -easeInOut(p) * W, 0);
      break;
    case 'wipe':
      if (prev) { const x = easeInOut(p) * W; ctx.beginPath(); ctx.rect(x, 0, W - x, H); ctx.clip(); ctx.drawImage(prev, 0, 0); }
      break;
    case 'zoom':
      if (prev) {
        const s = 1 + easeOut(p) * 0.6;
        ctx.globalAlpha = 1 - p;
        ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.translate(-W / 2, -H / 2);
        ctx.drawImage(prev, 0, 0);
      }
      break;
  }
  ctx.restore();
}

function drawFrameNow(loc, srcEl = null) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.filter = 'none';
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (!loc) return;
  const { clip, idx, lt, dur } = loc;
  const m = state.media.get(clip.mediaId);
  if (!m) return;
  drawSource(clip, m, srcEl || m.el, lt, dur);
  drawText(clip, lt, dur);
  drawTransition(clip, idx, lt);
}

let renderToken = 0;
async function renderAt(t) {
  const token = ++renderToken;
  const loc = locate(t);
  if (!loc) { drawFrameNow(null); return; }
  const m = state.media.get(loc.clip.mediaId);
  let srcEl = null;
  if (loc.clip.kind === 'video' && m) {
    const st = loc.clip.start + loc.lt * loc.clip.speed;
    await seekTo(m.el, st); await waitFrame(m.el, 120);
    if (token !== renderToken) return;
    if (m.el.readyState < 2 && m.scratch) { await seekTo(m.scratch, st); if (token !== renderToken) return; srcEl = m.scratch; }
  }
  drawFrameNow(loc, srcEl);
}

function setPlayhead(t, render = true) {
  state.playhead = clamp(t, 0, Math.max(0, totalDuration()));
  updatePlayheadUI();
  if (render && !state.playing) renderAt(state.playhead);
}

/* ======================================================================
   Playback engine
   ====================================================================== */
let wallStart = 0, tStart = 0, activeIdx = -1, rafId = 0;

function effectiveClipVolume(c) {
  const mus = P().music;
  const duck = mus && mus.duck ? 0.35 : 1;
  return clamp(c.volume * duck, 0, 1);
}
function startClipMedia(clip, lt) {
  const m = state.media.get(clip.mediaId);
  if (!m || clip.kind !== 'video') return;
  const el = m.el;
  el.playbackRate = clamp(clip.speed, 0.0625, 16);
  try { el.preservesPitch = true; } catch (e) {}
  setElVolume(el, effectiveClipVolume(clip));
  el.currentTime = clip.start + lt * clip.speed;
  el.play().catch(() => {});
}
function stopClipMedia(clip) {
  const m = state.media.get(clip.mediaId);
  if (m && m.kind === 'video') m.el.pause();
}
function musicVolumeAt(t) {
  const mus = P().music;
  if (!mus) return 0;
  const total = totalDuration();
  let v = mus.volume;
  if (mus.fadeIn > 0) v *= clamp(t / mus.fadeIn, 0, 1);
  if (mus.fadeOut > 0) v *= clamp((total - t) / mus.fadeOut, 0, 1);
  return clamp(v, 0, 1);
}
function startMusic(t) {
  const mus = P().music;
  if (!mus) return;
  musicEl.loop = !!mus.loop;
  let pos = mus.offset + t;
  if (mus.loop && mus.duration > 0) pos = mus.offset + ((t) % Math.max(0.1, mus.duration - mus.offset));
  if (pos >= mus.duration) { musicEl.pause(); return; }
  musicEl.currentTime = pos;
  setElVolume(musicEl, musicVolumeAt(t));
  musicEl.play().catch(() => {});
}

function play() {
  if (!P().clips.length) { toast('Add some clips first'); return; }
  stopPreview();
  ensureAudio();
  unlockMedia();
  const total = totalDuration();
  if (state.playhead >= total - 0.05) state.playhead = 0;
  state.playing = true;
  wallStart = performance.now(); tStart = state.playhead; activeIdx = -1;
  startMusic(state.playhead);
  $('#playBtn').textContent = '❚❚';
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}
function pause() {
  if (!state.playing) return;
  state.playing = false;
  cancelAnimationFrame(rafId);
  if (activeIdx >= 0 && P().clips[activeIdx]) stopClipMedia(P().clips[activeIdx]);
  activeIdx = -1;
  musicEl.pause();
  $('#playBtn').textContent = '▶';
  renderAt(state.playhead);
}
function togglePlay() { state.playing ? pause() : play(); }

function tick() {
  if (!state.playing) return;
  const total = totalDuration();
  const t = tStart + (performance.now() - wallStart) / 1000;
  if (t >= total) {
    state.playhead = total;
    const wasExporting = state.exporting;
    pause();
    updatePlayheadUI();
    if (wasExporting) finishExport();
    return;
  }
  const loc = locate(t);
  if (loc.idx !== activeIdx) {
    if (activeIdx >= 0 && P().clips[activeIdx]) {
      state.snapCache.set(P().clips[activeIdx].id, snapshotCanvas());
      stopClipMedia(P().clips[activeIdx]);
    }
    activeIdx = loc.idx;
    startClipMedia(loc.clip, loc.lt);
  } else if (loc.clip.kind === 'video') {
    const m = state.media.get(loc.clip.mediaId);
    if (m) {
      const expected = loc.clip.start + loc.lt * loc.clip.speed;
      if (Math.abs(m.el.currentTime - expected) > 0.3) m.el.currentTime = expected;
      if (m.el.paused) m.el.play().catch(() => {});
    }
  }
  state.playhead = t;
  drawFrameNow(loc);
  if (P().music) { setElVolume(musicEl, musicVolumeAt(t)); if (musicEl.paused && musicEl.src && (P().music.loop || P().music.offset + t < P().music.duration)) musicEl.play().catch(() => {}); }
  updatePlayheadUI();
  if (state.exporting) updateExportProgress(t / total);
  rafId = requestAnimationFrame(tick);
}

/* ======================================================================
   Editing operations
   ====================================================================== */
function addClipsFromMedia(ids) {
  const added = [];
  ids.forEach(id => { const m = state.media.get(id); if (m) { const c = defaultClip(m); P().clips.push(c); added.push(c); } });
  return added;
}
function addToTimeline(ids, { select = true } = {}) {
  if (!ids.length) return;
  pushUndo();
  const added = addClipsFromMedia(ids);
  if (select && added.length) state.selectedId = added[added.length - 1].id;
  renderAll(); save();
  if (phoneLayout.matches && added.length) toast(`${added.length} clip${added.length > 1 ? 's' : ''} added · open the Clip tab to edit`);
}
function deleteClip(id) {
  const idx = P().clips.findIndex(c => c.id === id);
  if (idx < 0) return;
  pushUndo();
  P().clips.splice(idx, 1);
  const next = P().clips[Math.min(idx, P().clips.length - 1)];
  state.selectedId = next ? next.id : null;
  state.playhead = clamp(state.playhead, 0, totalDuration());
  renderAll(); save();
}
function duplicateClip(id) {
  const idx = P().clips.findIndex(c => c.id === id);
  if (idx < 0) return;
  pushUndo();
  const copy = JSON.parse(JSON.stringify(P().clips[idx]));
  copy.id = uid();
  P().clips.splice(idx + 1, 0, copy);
  state.selectedId = copy.id;
  renderAll(); save();
}
function splitAtPlayhead() {
  const loc = locate(state.playhead);
  if (!loc) return;
  const { clip, idx, lt, dur } = loc;
  if (lt < MIN_CLIP || dur - lt < MIN_CLIP) { toast('Move the playhead further inside the clip to split'); return; }
  pushUndo();
  const b = JSON.parse(JSON.stringify(clip));
  b.id = uid();
  b.transition = { type: 'none', duration: 0.6 };
  b.text = { ...b.text, content: '' };
  if (clip.kind === 'video') {
    const cut = clip.start + lt * clip.speed;
    clip.end = cut; b.start = cut;
  } else {
    clip.imageDuration = lt; b.imageDuration = dur - lt;
  }
  P().clips.splice(idx + 1, 0, b);
  state.snapCache.delete(clip.id);
  state.selectedId = b.id;
  renderAll(); save();
  toast('Clip split');
}
function moveClip(fromId, toIndex) {
  const from = P().clips.findIndex(c => c.id === fromId);
  if (from < 0) return;
  pushUndo();
  const [c] = P().clips.splice(from, 1);
  if (toIndex > from) toIndex--;
  P().clips.splice(clamp(toIndex, 0, P().clips.length), 0, c);
  state.snapCache.clear();
  renderAll(); save();
}
function nudgeClip(id, dir) {
  const from = P().clips.findIndex(c => c.id === id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= P().clips.length) return;
  pushUndo();
  const a = P().clips; [a[from], a[to]] = [a[to], a[from]];
  state.snapCache.clear();
  state.playhead = clipOffset(id);
  renderAll(); save();
}
function invalidate(clip) { if (clip) state.snapCache.delete(clip.id); }

/* ---------- Theme / auto create / beat sync ---------- */
function pickSegments(m, pace) {
  // Choose 1–3 evenly spaced highlight segments from a long video.
  const n = clamp(Math.floor(m.duration / (pace * 3)), 1, 3);
  const len = Math.min(m.duration, pace);
  const segs = [];
  for (let i = 0; i < n; i++) {
    const center = m.duration * (i + 1) / (n + 1);
    const start = clamp(center - len / 2, 0, Math.max(0, m.duration - len));
    segs.push([start, start + len]);
  }
  return segs;
}
function applyTheme({ retrim = false } = {}) {
  const th = THEMES[P().theme] || THEMES.classic;
  const pace = PACE[P().pace] || PACE.medium;
  P().clips.forEach((c, i) => {
    c.filter = { ...c.filter, preset: th.filter };
    c.transition = { type: i === 0 ? (th.transition === 'crossfade' || th.transition === 'slide' || th.transition === 'wipe' || th.transition === 'zoom' ? 'fade' : th.transition) : th.transition, duration: th.transition === 'flash' ? 0.3 : pace < 2 ? 0.4 : 0.7 };
    c.text.style = th.textStyle;
    if (retrim) {
      if (c.kind === 'image') { c.imageDuration = Math.max(1.5, Math.min(pace, 5)); c.kenBurns = true; }
      else {
        const m = state.media.get(c.mediaId);
        if (m) {
          const len = Math.min(m.duration, pace * c.speed);
          const mid = (c.start + c.end) / 2;
          c.start = clamp(mid - len / 2, 0, Math.max(0, m.duration - len));
          c.end = Math.min(m.duration, c.start + len);
        }
      }
    }
  });
  if (P().themeTitle && P().title.trim() && P().clips.length) {
    const first = P().clips[0];
    if (!first.text.content.trim() || first.text._auto) {
      first.text.content = P().title.trim();
      first.text.anim = 'fade'; first.text.pos = 'center'; first.text._auto = true;
      first.text.dur = Math.min(1, 2.5 / clipDuration(first));
    }
  }
  state.snapCache.clear();
}
async function autoCreate() {
  if (!state.media.size) { toast('Add some videos or photos first'); return; }
  pushUndo();
  if (!P().music && P().themeMusic !== false) {
    const track = trackForTheme(P().theme);
    if (track) { toast(`Adding theme music: ${track.name}…`, 20000); await useLibraryTrack(track.id, { silent: true, noUndo: true }); }
  }
  const pace = PACE[P().pace] || PACE.medium;
  if (!P().clips.length) {
    state.media.forEach(m => {
      if (m.kind === 'image') { P().clips.push(defaultClip(m)); return; }
      pickSegments(m, pace).forEach(([s, e]) => { const c = defaultClip(m); c.start = s; c.end = e; P().clips.push(c); });
    });
  }
  applyTheme({ retrim: true });
  if (P().music && P().music.beats && P().music.beats.length) beatSync({ silent: true, noUndo: true });
  state.selectedId = P().clips[0] ? P().clips[0].id : null;
  // Park just after the opening fade so the preview shows a real frame.
  state.playhead = P().clips[0] ? Math.min(P().clips[0].transition.duration, clipDuration(P().clips[0]) / 2) : 0;
  renderAll(); save();
  if (phoneLayout.matches) $('.tab[data-tab="clip"]').click();
  toast(`Auto-created a ${THEMES[P().theme].name} edit · ${fmt(totalDuration())}${P().music ? ` · ♫ ${P().music.name.replace(/\.mp3$/, '')}` : ''}`, 3500);
}
function beatSync({ silent = false, noUndo = false } = {}) {
  const mus = P().music;
  if (!mus || !mus.beats || !mus.beats.length) { toast('Add a music track first'); return; }
  if (!P().clips.length) { toast('Add some clips first'); return; }
  if (!noUndo) pushUndo();
  const target = PACE[P().pace] || PACE.medium;
  const beats = mus.beats.map(b => b - mus.offset).filter(b => b > 0.3);
  let t = 0;
  P().clips.forEach(c => {
    const m = state.media.get(c.mediaId);
    const desired = t + target;
    let best = null, bestD = Infinity;
    for (const b of beats) {
      if (b < t + 0.5) continue;
      const d = Math.abs(b - desired);
      if (d < bestD) { bestD = d; best = b; }
      if (b > desired + target) break;
    }
    let dur = best !== null ? best - t : target;
    if (c.kind === 'image') c.imageDuration = clamp(dur, 0.5, 10);
    else if (m) {
      const maxDur = (m.duration - c.start) / c.speed;
      dur = Math.min(dur, maxDur);
      if (dur < 0.4) dur = Math.min(maxDur, target);
      c.end = Math.min(m.duration, c.start + dur * c.speed);
    }
    const cd = clipDuration(c);
    c.transition.duration = Math.min(c.transition.duration, Math.max(0.2, cd / 2));
    t += cd;
  });
  state.snapCache.clear();
  renderAll(); save();
  if (!silent) toast('Cuts synced to the beat');
}
function fitToMusic() {
  const mus = P().music;
  if (!mus) return;
  const total = totalDuration();
  const target = Math.max(1, mus.duration - mus.offset);
  if (!total) return;
  pushUndo();
  const f = target / total;
  P().clips.forEach(c => {
    const m = state.media.get(c.mediaId);
    if (c.kind === 'image') c.imageDuration = clamp(c.imageDuration * f, 0.5, 15);
    else if (m) {
      const dur = clipDuration(c) * f;
      const maxDur = (m.duration - c.start) / c.speed;
      c.end = c.start + Math.min(dur, maxDur) * c.speed;
    }
  });
  state.snapCache.clear();
  renderAll(); save();
  toast(`Video is now ${fmt(totalDuration())} (music ${fmt(target)})`);
}
function shuffleClips() {
  if (P().clips.length < 2) return;
  pushUndo();
  const a = P().clips;
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  state.snapCache.clear();
  renderAll(); save();
}

/* ---------- Music library (built-in tracks) ---------- */
const previewEl = new Audio();
previewEl.preload = 'none';
async function loadLibrary() {
  try {
    const r = await fetch('music/library.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    state.library = await r.json();
  } catch (e) { console.warn('music library unavailable', e); state.library = []; }
  renderLibrary();
}
function trackForTheme(themeKey) {
  const lib = state.library;
  if (!lib.length) return null;
  return lib.find(t => (t.themes || []).includes(themeKey)) || lib[0];
}
function stopPreview() {
  previewEl.pause();
  state.previewId = null;
  $$('.lib-item .play').forEach(b => { b.textContent = '▶'; });
}
function togglePreview(track, btn) {
  if (state.previewId === track.id) { stopPreview(); return; }
  stopPreview();
  pause();
  state.previewId = track.id;
  previewEl.src = track.file;
  previewEl.currentTime = 0;
  previewEl.play().catch(() => { stopPreview(); toast('Could not play the preview'); });
  btn.textContent = '■';
}
previewEl.addEventListener('ended', stopPreview);
async function useLibraryTrack(id, opts = {}) {
  const track = state.library.find(t => t.id === id);
  if (!track) { toast('Track not found'); return false; }
  stopPreview();
  if (!opts.silent) toast(`Loading ${track.name}…`, 20000);
  try {
    const r = await fetch(track.file);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    const file = new File([blob], `${track.name}.mp3`, { type: 'audio/mpeg' });
    await setMusic(file, { libraryId: track.id, silent: opts.silent, noUndo: opts.noUndo });
    return true;
  } catch (e) {
    console.warn(e);
    toast(`Could not load ${track.name}: ${e.message || e}`, 5000);
    return false;
  }
}
function renderLibrary() {
  const list = $('#libraryList');
  if (!list) return;
  if (!state.library.length) { list.innerHTML = '<div class="muted small-text">No built-in tracks available offline yet. Add your own file below.</div>'; return; }
  list.innerHTML = '';
  const current = P().music && P().music.libraryId;
  state.library.forEach(track => {
    const d = document.createElement('div');
    d.className = 'lib-item' + (current === track.id ? ' active' : '');
    d.innerHTML = `<button class="icon-btn play" title="Preview">${state.previewId === track.id ? '■' : '▶'}</button>` +
      `<div class="meta"><div class="name">${track.name}</div><div class="sub">${track.mood} · ${track.bpm} BPM · ${fmt(track.duration)}</div></div>` +
      `<button class="small-btn use">${current === track.id ? 'In use' : 'Use'}</button>`;
    d.querySelector('.play').addEventListener('click', (e) => togglePreview(track, e.currentTarget));
    const useBtn = d.querySelector('.use');
    useBtn.disabled = current === track.id;
    useBtn.addEventListener('click', () => useLibraryTrack(track.id));
    list.appendChild(d);
  });
}

/* ---------- Music ---------- */
async function setMusic(file, opts = {}) {
  if (!opts.silent) toast('Analyzing music…', 30000);
  const id = uid();
  await DB.putFile(id, file);
  const url = URL.createObjectURL(file);
  let analysis = { beats: [], duration: 0, bpm: 0 };
  try { analysis = await Beats.analyze(file); } catch (e) { console.warn('beat analysis failed', e); }
  if (!analysis.duration) {
    await new Promise(res => { musicEl.addEventListener('loadedmetadata', res, { once: true }); musicEl.src = url; });
    analysis.duration = musicEl.duration;
  }
  if (!opts.noUndo) pushUndo();
  if (P().music && P().music.fileId) DB.deleteFile(P().music.fileId);
  P().music = {
    fileId: id, name: file.name, volume: 0.8, offset: 0, fadeIn: 1, fadeOut: 2, loop: true, duck: true,
    beats: analysis.beats, duration: analysis.duration, bpm: analysis.bpm, libraryId: opts.libraryId || null
  };
  musicEl.src = url;
  ensureAudioIfReady();
  renderAll(); save();
  if (!opts.silent) toast(`Music added · ${analysis.beats.length} beats${analysis.bpm ? ` · ~${analysis.bpm} BPM` : ''}`);
}
function ensureAudioIfReady() { if (actx) connectAudioEl(musicEl); }
async function restoreMusic(mus) {
  const blob = await DB.getFile(mus.fileId);
  if (!blob) { P().music = null; return; }
  musicEl.src = URL.createObjectURL(blob);
}
function removeMusic() {
  if (!P().music) return;
  pushUndo();
  DB.deleteFile(P().music.fileId);
  P().music = null;
  musicEl.pause(); musicEl.removeAttribute('src');
  renderAll(); save();
}

/* ======================================================================
   Export
   ====================================================================== */
let recorder = null, recChunks = [], exportMime = '', exportBlob = null, exportName = '', wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 20000);
}
async function shareExport() {
  if (!exportBlob) return;
  const file = new File([exportBlob], exportName, { type: exportBlob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: exportName }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  downloadBlob(exportBlob, exportName);
}
function pickMime() {
  if (!window.MediaRecorder) return '';
  // H.264/AAC MP4 first: it is what Photos, WhatsApp and most players accept (iOS Photos cannot import WebM).
  const cands = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.4D401E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=h264,aac', 'video/mp4;codecs=avc1', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'
  ];
  return cands.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } }) || '';
}
function openExport() {
  if (!P().clips.length) { toast('Nothing to export yet'); return; }
  pause();
  $('#exportProgressWrap').hidden = true;
  $('#exportResult').hidden = true;
  $('#exportStartBtn').hidden = false; $('#exportStartBtn').disabled = false;
  $('#exportCancelBtn').textContent = 'Cancel';
  $('#exportDialog').hidden = false;
}
function closeExport() {
  if (state.exporting) cancelExport();
  $('#exportDialog').hidden = true;
}
// Export frames are drawn by requestAnimationFrame, which browsers pause for hidden tabs.
document.addEventListener('visibilitychange', () => { if (document.hidden && state.exporting) { cancelExport(); toast('Export stopped because the app went to the background. Keep it open while rendering.', 5000); } });
function startExport() {
  const mime = pickMime();
  if (!mime || !canvas.captureStream) { toast('This browser cannot record video. Try Chrome or Edge.'); return; }
  ensureAudio();
  const res = $('#exportRes').value === '1080' ? 1920 : 1280;
  const fps = Number($('#exportFps').value) || 30;
  pause();
  setCanvasSize(res);
  state.snapCache.clear();
  const stream = canvas.captureStream(fps);
  if (recDest) recDest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  recChunks = []; exportMime = mime;
  try {
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: res === 1920 ? 10e6 : 5e6, audioBitsPerSecond: 160000 });
  } catch (e) { toast('Could not start the recorder: ' + e.message); setCanvasSize(PREVIEW_LONG); return; }
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    if (!state.exportCancelled && recChunks.length) {
      exportBlob = new Blob(recChunks, { type: exportMime.split(';')[0] });
      const ext = exportMime.includes('mp4') ? 'mp4' : 'webm';
      exportName = `${(P().title.trim() || 'quik-video').replace(/[^\w\-]+/g, '_')}.${ext}`;
      // Show the result step: on phones "Share" saves straight to Photos; elsewhere download.
      $('#exportDialog').hidden = false;
      $('#exportProgressWrap').hidden = true;
      $('#exportResult').hidden = false;
      $('#exportResultText').textContent = `Done · ${exportName} · ${(exportBlob.size / 1e6).toFixed(1)} MB · ${fmt(totalDuration())}` +
        (ext === 'webm' && IS_IOS ? ' · This browser could only record WebM, which Photos cannot save; use “Download file” to keep it in Files.' : '');
      const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File([exportBlob], exportName, { type: exportBlob.type })] }));
      $('#exportShareBtn').hidden = !canShare;
      $('#exportShareBtn').textContent = ext === 'mp4' ? 'Save to Photos / Share…' : 'Share…';
      $('#exportStartBtn').hidden = true;
      $('#exportCancelBtn').textContent = 'Close';
      if (!canShare && !IS_IOS) downloadBlob(exportBlob, exportName);
      toast(`Exported ${exportName}`, 4000);
    }
    recChunks = [];
  };
  state.exporting = true; state.exportCancelled = false;
  keepAwake(true);
  if (masterGain) masterGain.gain.value = 0;   // silent while rendering
  $('#exportProgressWrap').hidden = false;
  $('#exportStartBtn').disabled = true;
  updateExportProgress(0);
  // Pre-render first frame so the recording does not start black.
  state.playhead = 0;
  renderAt(0).then(() => {
    // Safari's MP4 recorder delivers one complete file at stop; timeslices are only used for WebM.
    if (exportMime.includes('mp4')) recorder.start(); else recorder.start(250);
    play();
  });
}
function updateExportProgress(p) {
  $('#exportProgress').style.width = `${Math.round(p * 100)}%`;
  $('#exportStatus').textContent = `Rendering… ${Math.round(p * 100)}% · ${fmt(state.playhead)} / ${fmt(totalDuration())}`;
}
function finishExport() {
  state.exporting = false;
  keepAwake(false);
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  if (masterGain) masterGain.gain.value = 1;
  setCanvasSize(PREVIEW_LONG);
  state.snapCache.clear();
  if (state.exportCancelled) $('#exportDialog').hidden = true;
  setPlayhead(0);
}
function cancelExport() {
  state.exportCancelled = true;
  pause();
  finishExport();
  toast('Export cancelled');
}
async function frameGrab() {
  if (!P().clips.length) return;
  pause();
  setCanvasSize(1920);
  state.snapCache.clear();
  await renderAt(state.playhead);
  canvas.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(P().title.trim() || 'frame').replace(/[^\w\-]+/g, '_')}_${fmt(state.playhead).replace(/[:.]/g, '-')}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setCanvasSize(PREVIEW_LONG);
    state.snapCache.clear();
    renderAt(state.playhead);
    toast('Frame saved as PNG');
  }, 'image/png');
}

/* ======================================================================
   UI – media grid
   ====================================================================== */
function renderMediaGrid() {
  const grid = $('#mediaGrid');
  grid.innerHTML = '';
  state.media.forEach(m => {
    const d = document.createElement('div');
    d.className = 'media-item'; d.title = `${m.name} – click to add to timeline`;
    d.innerHTML = `<img src="${m.thumb}" alt=""><span class="kind">${m.kind === 'video' ? '▶' : '🖼'}</span>` +
      (m.kind === 'video' ? `<span class="dur">${fmt(m.duration)}</span>` : '') +
      `<button class="rm" title="Remove from media bin">✕</button>`;
    d.addEventListener('click', () => addToTimeline([m.id]));
    d.querySelector('.rm').addEventListener('click', (e) => { e.stopPropagation(); removeMedia(m.id); });
    grid.appendChild(d);
  });
  $('#addAllBtn').disabled = !state.media.size;
  $('#dropZone').style.display = state.media.size ? 'none' : '';
}

/* ======================================================================
   UI – timeline
   ====================================================================== */
let dragId = null;
function renderTimeline() {
  const z = state.tlZoom;
  const L = layout();
  const total = totalDuration();
  const tl = $('#timeline');
  const widthPx = Math.max(total * z + 40, $('#timelineScroll').clientWidth);
  tl.style.width = `${widthPx}px`;

  // Ruler
  const ruler = $('#ruler');
  ruler.innerHTML = '';
  const step = z >= 120 ? 0.5 : z >= 60 ? 1 : z >= 35 ? 2 : 5;
  for (let t = 0; t <= Math.max(total, (widthPx - 40) / z); t += step) {
    const tick = document.createElement('div');
    tick.className = 'tick'; tick.style.left = `${t * z}px`;
    if (Number.isInteger(t) || step < 1) tick.textContent = fmt(t).replace(/\.\d$/, '');
    ruler.appendChild(tick);
  }
  const mus = P().music;
  if (mus && mus.beats) {
    mus.beats.forEach(b => {
      const t = b - mus.offset;
      if (t < 0 || t > total) return;
      const d = document.createElement('div'); d.className = 'beat'; d.style.left = `${t * z}px`;
      ruler.appendChild(d);
    });
  }

  // Clips
  const track = $('#clipsTrack');
  track.innerHTML = '';
  L.forEach(({ clip, dur }) => {
    const m = state.media.get(clip.mediaId);
    const d = document.createElement('div');
    d.className = 'clip' + (clip.id === state.selectedId ? ' selected' : '');
    d.style.width = `${Math.max(28, dur * z)}px`;
    if (m) d.style.backgroundImage = `url(${m.thumb})`;
    d.draggable = true; d.dataset.id = clip.id;
    const badges = [];
    if (clip.speed !== 1) badges.push(`${clip.speed}×`);
    if (clip.filter.preset !== 'none') badges.push(FILTERS[clip.filter.preset].name);
    if (clip.text.content.trim()) badges.push('T');
    if (clip.volume === 0 && clip.kind === 'video') badges.push('🔇');
    d.innerHTML = (clip.transition.type !== 'none' ? '<div class="trans"></div>' : '') +
      `<div class="badges">${badges.map(b => `<span class="badge">${b}</span>`).join('')}</div>` +
      `<div class="label">${clip.name} · ${fmt(dur)}</div>`;
    d.addEventListener('click', (e) => {
      selectClip(clip.id);
      const rect = d.getBoundingClientRect();
      const off = clipOffset(clip.id);
      const frac = clamp((e.clientX - rect.left) / rect.width, 0, 0.999);
      setPlayhead(off + frac * dur);
    });
    d.addEventListener('dragstart', (e) => { dragId = clip.id; d.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', clip.id); } catch (err) {} });
    d.addEventListener('dragend', () => { dragId = null; $$('.clip').forEach(x => x.classList.remove('dragging', 'drop-before', 'drop-after')); });
    d.addEventListener('dragover', (e) => {
      if (!dragId || dragId === clip.id) return;
      e.preventDefault();
      const rect = d.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      d.classList.toggle('drop-before', before); d.classList.toggle('drop-after', !before);
    });
    d.addEventListener('dragleave', () => d.classList.remove('drop-before', 'drop-after'));
    d.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragId || dragId === clip.id) return;
      const rect = d.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      const idx = P().clips.findIndex(c => c.id === clip.id);
      moveClip(dragId, before ? idx : idx + 1);
    });
    track.appendChild(d);
  });

  // Music bar
  const mt = $('#musicTrack');
  mt.innerHTML = '';
  if (mus) {
    const len = mus.loop ? total : Math.min(total, Math.max(0, mus.duration - mus.offset));
    const bar = document.createElement('div');
    bar.className = 'music-bar'; bar.style.left = '0px'; bar.style.width = `${Math.max(10, len * z)}px`;
    bar.textContent = `♫ ${mus.name}${mus.bpm ? ` · ${mus.bpm} BPM` : ''}`;
    mt.appendChild(bar);
  }
  updatePlayheadUI();
  $('#emptyHint').hidden = P().clips.length > 0;
}
function updatePlayheadUI() {
  const z = state.tlZoom;
  $('#playhead').style.left = `${12 + state.playhead * z}px`;
  $('#timeLabel').textContent = `${fmt(state.playhead)} / ${fmt(totalDuration())}`;
  if (state.playing) {
    const sc = $('#timelineScroll');
    const x = 12 + state.playhead * z - sc.scrollLeft;
    if (x > sc.clientWidth - 40 || x < 0) sc.scrollLeft = Math.max(0, 12 + state.playhead * z - 60);
    // Follow selection while playing
    const loc = locate(state.playhead);
    if (loc && loc.clip.id !== state.selectedId) { state.selectedId = loc.clip.id; $$('.clip').forEach(el => el.classList.toggle('selected', el.dataset.id === state.selectedId)); renderInspector(); }
  }
}
function selectClip(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  $$('.clip').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
  renderInspector();
}

/* Scrub on ruler / empty timeline area */
(function setupScrub() {
  const scroll = $('#timelineScroll');
  let scrubbing = false;
  const timeFromEvent = (e) => {
    const rect = $('#timeline').getBoundingClientRect();
    return clamp((e.clientX - rect.left - 12) / state.tlZoom, 0, totalDuration());
  };
  scroll.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.clip') || e.target.closest('.music-bar')) return;
    if (e.pointerType === 'touch' && !e.target.closest('.ruler')) return;
    scrubbing = true; pause();
    setPlayhead(timeFromEvent(e));
    scroll.setPointerCapture(e.pointerId);
  });
  scroll.addEventListener('pointermove', (e) => { if (scrubbing) setPlayhead(timeFromEvent(e)); });
  scroll.addEventListener('pointerup', () => { scrubbing = false; });
  scroll.addEventListener('pointercancel', () => { scrubbing = false; });
})();

/* ======================================================================
   UI – inspector
   ====================================================================== */
function setSeg(segId, attr, value) {
  $$(`#${segId} button`).forEach(b => b.classList.toggle('active', b.dataset[attr] === String(value)));
}

function renderInspector() {
  const c = selectedClip();
  const m = c ? state.media.get(c.mediaId) : null;
  $('#noClip').hidden = !!c; $('#clipEditor').hidden = !c;
  $('#noClipText').hidden = !!c; $('#textEditor').hidden = !c;
  $('#noClipStyle').hidden = !!c;
  renderFilterGrid(c, m);
  renderThemeGrid();
  setSeg('paceSeg', 'pace', P().pace);
  $('#themeTitle').checked = !!P().themeTitle;
  $('#themeMusic').checked = P().themeMusic !== false;
  renderMusicPanel();
  $('#projectTitle').value = P().title; $('#projectTitleMobile').value = P().title;
  if (!c || !m) return;

  $('#clipName').textContent = `${c.kind === 'video' ? '▶' : '🖼'} ${c.name}`;
  const isVideo = c.kind === 'video';
  $('#trimSlider').style.display = isVideo ? '' : 'none';
  $('#filmstrip').style.display = isVideo ? '' : 'none';
  $('#setInBtn').parentElement.style.display = isVideo ? '' : 'none';
  $('#trimStartLabel').parentElement.style.display = isVideo ? '' : 'none';
  $('#imageDurationRow').hidden = isVideo;
  $('#speedSeg').parentElement.querySelectorAll('.field-label')[1].style.display = '';
  $('#speedSeg').style.display = isVideo ? '' : 'none';
  $('#clipVolume').style.display = isVideo ? '' : 'none';
  $('#clipVolume').previousElementSibling.style.display = isVideo ? '' : 'none';
  $('#speedSeg').previousElementSibling.style.display = isVideo ? '' : 'none';

  if (isVideo) {
    $('#trimStart').value = Math.round(c.start / m.duration * 1000);
    $('#trimEnd').value = Math.round(c.end / m.duration * 1000);
    updateTrimLabels(c, m);
    buildStrip(m).then(strip => {
      if (selectedClip() !== c) return;
      $('#filmstrip').innerHTML = strip.map(s => `<img src="${s}" alt="">`).join('');
    });
  } else {
    $('#imageDuration').value = c.imageDuration;
    $('#imageDurationLabel').textContent = `${c.imageDuration.toFixed(1)}s`;
    $('#kenBurns').checked = !!c.kenBurns;
  }
  setSeg('speedSeg', 'speed', c.speed);
  $('#clipVolume').value = c.volume; $('#volumeLabel').textContent = `${Math.round(c.volume * 100)}%`;
  $('#transitionType').value = c.transition.type;
  $('#transitionDur').value = c.transition.duration; $('#transitionDurLabel').textContent = `${c.transition.duration.toFixed(1)}s`;
  setSeg('fitSeg', 'fit', c.fit);
  $('#clipZoom').value = c.zoom; $('#zoomLabel').textContent = `${c.zoom.toFixed(2)}×`;
  $('#panX').value = c.panX; $('#panY').value = c.panY;

  $('#brightness').value = c.filter.brightness; $('#brightnessLabel').textContent = c.filter.brightness.toFixed(2);
  $('#contrast').value = c.filter.contrast; $('#contrastLabel').textContent = c.filter.contrast.toFixed(2);
  $('#saturation').value = c.filter.saturation; $('#saturationLabel').textContent = c.filter.saturation.toFixed(2);
  $('#vignette').value = c.filter.vignette; $('#vignetteLabel').textContent = c.filter.vignette.toFixed(2);

  $('#textContent').value = c.text.content;
  setSeg('textPosSeg', 'pos', c.text.pos);
  $('#textStyle').value = c.text.style;
  $('#textSize').value = c.text.size; $('#textSizeLabel').textContent = `${Math.round(c.text.size * 100)}%`;
  $('#textColor').value = c.text.color; $('#textAccent').value = c.text.accent;
  $('#textAnim').value = c.text.anim;
  $('#textDur').value = c.text.dur; $('#textDurLabel').textContent = c.text.dur ? `${Math.round(c.text.dur * 100)}%` : 'whole clip';
}
function updateTrimLabels(c, m) {
  $('#trimStartLabel').textContent = `${c.start.toFixed(1)}s`;
  $('#trimEndLabel').textContent = `${c.end.toFixed(1)}s`;
  $('#trimDurLabel').textContent = `${(c.end - c.start).toFixed(1)}s selected → ${fmt(clipDuration(c))}`;
  const r = $('#trimRange');
  r.style.left = `${c.start / m.duration * 100}%`; r.style.width = `${(c.end - c.start) / m.duration * 100}%`;
}

function renderFilterGrid(c, m) {
  const grid = $('#filterGrid');
  const src = m ? m.thumb : '';
  grid.innerHTML = '';
  Object.entries(FILTERS).forEach(([key, f]) => {
    const d = document.createElement('div');
    d.className = 'filter-item' + (c && c.filter.preset === key ? ' active' : '');
    const img = document.createElement('img');
    img.alt = '';
    if (src) img.src = src; else { img.style.background = 'linear-gradient(135deg,#f6d365,#fda085,#4f8cff)'; }
    img.style.filter = f.css || 'none';
    d.appendChild(img);
    d.appendChild(document.createTextNode(f.name));
    d.addEventListener('click', () => {
      const cc = selectedClip();
      if (!cc) { toast('Select a clip first'); return; }
      pushUndo(); cc.filter.preset = key; invalidate(cc);
      renderInspector(); renderTimeline(); renderAt(state.playhead); save();
    });
    grid.appendChild(d);
  });
}
function renderThemeGrid() {
  const grid = $('#themeGrid');
  grid.innerHTML = '';
  Object.entries(THEMES).forEach(([key, th]) => {
    const d = document.createElement('div');
    d.className = 'theme-card' + (P().theme === key ? ' active' : '');
    d.innerHTML = `<div class="swatch" style="background:${th.swatch}"></div><div class="name">${th.name}</div><div class="desc">${th.desc}</div>`;
    d.addEventListener('click', () => { P().theme = key; P().pace = th.pace; renderThemeGrid(); setSeg('paceSeg', 'pace', P().pace); save(); });
    grid.appendChild(d);
  });
}
function renderMusicPanel() {
  const mus = P().music;
  renderLibrary();
  $('#musicEditor').hidden = !mus;
  $('#musicInfo').textContent = mus
    ? `♫ ${mus.name} · ${fmt(mus.duration)}${mus.bpm ? ` · ~${mus.bpm} BPM` : ''} · ${mus.beats.length} beats`
    : 'No music. Pick a built-in track or add your own to unlock beat sync.';
  if (!mus) return;
  $('#musicVolume').value = mus.volume; $('#musicVolumeLabel').textContent = `${Math.round(mus.volume * 100)}%`;
  $('#musicOffset').max = Math.max(0, mus.duration - 1); $('#musicOffset').value = mus.offset; $('#musicOffsetLabel').textContent = `${mus.offset.toFixed(1)}s`;
  $('#musicFadeIn').value = mus.fadeIn; $('#musicFadeInLabel').textContent = `${mus.fadeIn.toFixed(1)}s`;
  $('#musicFadeOut').value = mus.fadeOut; $('#musicFadeOutLabel').textContent = `${mus.fadeOut.toFixed(1)}s`;
  $('#musicLoop').checked = !!mus.loop; $('#duckVideo').checked = !!mus.duck;
}

function renderAll() {
  renderMediaGrid();
  renderTimeline();
  renderInspector();
  if (!state.playing) renderAt(state.playhead);
  updateUndoButtons();
}

/* ---------- Generic binding helpers ---------- */
/* Range/number inputs: undo snapshot once per drag gesture, live preview on input, save on change. */
function bindRange(sel, apply, { rerenderTimeline = false, seekTo: seekFn = null } = {}) {
  const el = $(sel);
  el.addEventListener('input', () => {
    const c = selectedClip();
    if (!el._gesture) { pushUndo(); el._gesture = true; }
    apply(Number(el.value), c);
    if (c) invalidate(c);
    if (seekFn) { const t = seekFn(c); if (t !== null && t !== undefined) state.playhead = clamp(t, 0, totalDuration()); }
    if (rerenderTimeline) renderTimeline(); else updatePlayheadUI();
    renderAt(state.playhead);
  });
  el.addEventListener('change', () => { el._gesture = false; save(); renderInspector(); });
}
function bindSelect(sel, apply, { rerenderTimeline = false } = {}) {
  $(sel).addEventListener('change', (e) => {
    const c = selectedClip();
    pushUndo(); apply(e.target.value, c); if (c) invalidate(c);
    if (rerenderTimeline) renderTimeline();
    renderInspector(); renderAt(state.playhead); save();
  });
}
function bindSeg(segId, attr, apply, { rerenderTimeline = false } = {}) {
  $$(`#${segId} button`).forEach(b => b.addEventListener('click', () => {
    const c = selectedClip();
    pushUndo(); apply(b.dataset[attr], c); if (c) invalidate(c);
    if (rerenderTimeline) renderTimeline();
    renderInspector(); renderAt(state.playhead); save();
  }));
}

function bindUI() {
  // Tabs
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    $$('.tab-page').forEach(p => p.classList.toggle('active', p.dataset.page === t.dataset.tab));
    state.activeTab = t.dataset.tab;
  }));

  // Phone layout: the media bin lives in a "Media" tab instead of a side panel.
  const mediaPanel = $('.media-panel'), workspace = $('.workspace'), mediaPage = $('.media-page');
  const placeMediaPanel = () => {
    if (phoneLayout.matches) { if (mediaPanel.parentElement !== mediaPage) mediaPage.appendChild(mediaPanel); }
    else if (mediaPanel.parentElement !== workspace) workspace.insertBefore(mediaPanel, workspace.firstChild);
    if (!phoneLayout.matches && state.activeTab === 'media') $('.tab[data-tab="clip"]').click();
    renderTimeline();
  };
  placeMediaPanel();
  (phoneLayout.addEventListener ? phoneLayout.addEventListener('change', placeMediaPanel) : phoneLayout.addListener(placeMediaPanel));
  if (phoneLayout.matches && !state.media.size) $('.tab[data-tab="media"]').click();

  // Top bar
  const onTitle = (e) => { P().title = e.target.value; $('#projectTitle').value = $('#projectTitleMobile').value = P().title; save(); };
  $('#projectTitle').addEventListener('change', onTitle);
  $('#projectTitleMobile').addEventListener('change', onTitle);
  $('#aspectSelect').addEventListener('change', (e) => { pushUndo(); P().aspect = e.target.value; applyAspect(); renderAt(state.playhead); save(); });
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#exportBtn').addEventListener('click', openExport);
  const newProjectHandler = async () => {
    if (!confirm('Start a new project? Imported media and the current edit will be removed from this browser.')) return;
    pause();
    await DB.clear();
    state.media.forEach(m => URL.revokeObjectURL(m.url));
    state.media.clear();
    state.project = newProject(); state.selectedId = null; state.playhead = 0;
    state.undo = []; state.redo = []; state.snapCache.clear();
    musicEl.pause(); musicEl.removeAttribute('src');
    applyAspect(); renderAll();
  };
  $('#newProjectBtn').addEventListener('click', newProjectHandler);
  $('#newProjectBtnMobile').addEventListener('click', newProjectHandler);

  // Media
  $('#addMediaBtn').addEventListener('click', () => $('#fileInput').click());
  $('#dropZone').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => { await importFiles(e.target.files); e.target.value = ''; });
  $('#addAllBtn').addEventListener('click', () => addToTimeline(Array.from(state.media.keys())));
  $('#autoCreateBtn').addEventListener('click', async () => { autoCreate(); });
  ['#dropZone', '.preview-area', '.media-panel'].forEach(sel => {
    const el = $(sel);
    el.addEventListener('dragover', (e) => { if (dragId) return; e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', async (e) => {
      el.classList.remove('over');
      if (dragId) return;
      e.preventDefault();
      const added = await importFiles(e.dataTransfer.files);
      if (sel === '.preview-area' && added.length) addToTimeline(added.map(m => m.id));
    });
  });

  // Transport
  $('#playBtn').addEventListener('click', togglePlay);
  $('#toStartBtn').addEventListener('click', () => { pause(); setPlayhead(0); });
  $('#toEndBtn').addEventListener('click', () => { pause(); setPlayhead(totalDuration()); });
  $('#splitBtn').addEventListener('click', () => { pause(); splitAtPlayhead(); });
  $('#frameGrabBtn').addEventListener('click', frameGrab);
  $('#fullscreenBtn').addEventListener('click', () => { const w = $('#previewWrap'); if (document.fullscreenElement) document.exitFullscreen(); else if (w.requestFullscreen) w.requestFullscreen(); });
  canvas.addEventListener('click', () => { if (P().clips.length) togglePlay(); });

  // Clip tab
  const trimApply = (which) => (v, c) => {
    const m = state.media.get(c.mediaId);
    const t = v / 1000 * m.duration;
    const minSrc = MIN_CLIP * c.speed;
    if (which === 'start') c.start = clamp(t, 0, c.end - minSrc); else c.end = clamp(t, c.start + minSrc, m.duration);
    $('#trimStart').value = Math.round(c.start / m.duration * 1000);
    $('#trimEnd').value = Math.round(c.end / m.duration * 1000);
    updateTrimLabels(c, m);
  };
  bindRange('#trimStart', trimApply('start'), { rerenderTimeline: true, seekTo: (c) => clipOffset(c.id) });
  bindRange('#trimEnd', trimApply('end'), { rerenderTimeline: true, seekTo: (c) => clipOffset(c.id) + clipDuration(c) - 0.02 });
  $('#setInBtn').addEventListener('click', () => {
    const loc = locate(state.playhead); const c = selectedClip();
    if (!loc || !c || loc.clip.id !== c.id || c.kind !== 'video') { toast('Move the playhead inside the selected clip'); return; }
    const t = c.start + loc.lt * c.speed;
    if (c.end - t < MIN_CLIP * c.speed) return;
    pushUndo(); c.start = t; invalidate(c); renderAll(); save();
  });
  $('#setOutBtn').addEventListener('click', () => {
    const loc = locate(state.playhead); const c = selectedClip();
    if (!loc || !c || loc.clip.id !== c.id || c.kind !== 'video') { toast('Move the playhead inside the selected clip'); return; }
    const t = c.start + loc.lt * c.speed;
    if (t - c.start < MIN_CLIP * c.speed) return;
    pushUndo(); c.end = t; invalidate(c); renderAll(); save();
  });
  bindRange('#imageDuration', (v, c) => { c.imageDuration = v; $('#imageDurationLabel').textContent = `${v.toFixed(1)}s`; }, { rerenderTimeline: true });
  $('#kenBurns').addEventListener('change', (e) => { const c = selectedClip(); if (!c) return; pushUndo(); c.kenBurns = e.target.checked; invalidate(c); renderAt(state.playhead); save(); });
  bindSeg('speedSeg', 'speed', (v, c) => { c.speed = Number(v); }, { rerenderTimeline: true });
  bindRange('#clipVolume', (v, c) => { c.volume = v; $('#volumeLabel').textContent = `${Math.round(v * 100)}%`; }, { rerenderTimeline: true });
  bindSelect('#transitionType', (v, c) => { c.transition.type = v; }, { rerenderTimeline: true });
  bindRange('#transitionDur', (v, c) => { c.transition.duration = v; $('#transitionDurLabel').textContent = `${v.toFixed(1)}s`; }, { seekTo: (c) => clipOffset(c.id) + c.transition.duration * 0.5 });
  bindSeg('fitSeg', 'fit', (v, c) => { c.fit = v; });
  bindRange('#clipZoom', (v, c) => { c.zoom = v; $('#zoomLabel').textContent = `${v.toFixed(2)}×`; });
  bindRange('#panX', (v, c) => { c.panX = v; });
  bindRange('#panY', (v, c) => { c.panY = v; });
  $('#moveLeftBtn').addEventListener('click', () => { if (state.selectedId) nudgeClip(state.selectedId, -1); });
  $('#moveRightBtn').addEventListener('click', () => { if (state.selectedId) nudgeClip(state.selectedId, 1); });
  $('#dupClipBtn').addEventListener('click', () => { if (state.selectedId) duplicateClip(state.selectedId); });
  $('#deleteClipBtn').addEventListener('click', () => { if (state.selectedId) deleteClip(state.selectedId); });

  // Style tab
  bindRange('#brightness', (v, c) => { c.filter.brightness = v; $('#brightnessLabel').textContent = v.toFixed(2); });
  bindRange('#contrast', (v, c) => { c.filter.contrast = v; $('#contrastLabel').textContent = v.toFixed(2); });
  bindRange('#saturation', (v, c) => { c.filter.saturation = v; $('#saturationLabel').textContent = v.toFixed(2); });
  bindRange('#vignette', (v, c) => { c.filter.vignette = v; $('#vignetteLabel').textContent = v.toFixed(2); });
  $('#applyStyleAllBtn').addEventListener('click', () => {
    const c = selectedClip(); if (!c) { toast('Select a clip whose look you want to copy'); return; }
    pushUndo();
    P().clips.forEach(x => { x.filter = { ...c.filter }; });
    state.snapCache.clear(); renderAll(); save(); toast('Look applied to all clips');
  });

  // Text tab
  $('#textContent').addEventListener('input', (e) => {
    const c = selectedClip(); if (!c) return;
    if (!e.target._gesture) { pushUndo(); e.target._gesture = true; }
    c.text.content = e.target.value; c.text._auto = false; invalidate(c); renderAt(state.playhead);
  });
  $('#textContent').addEventListener('change', (e) => { e.target._gesture = false; renderTimeline(); save(); });
  bindSeg('textPosSeg', 'pos', (v, c) => { c.text.pos = v; });
  bindSelect('#textStyle', (v, c) => { c.text.style = v; });
  bindRange('#textSize', (v, c) => { c.text.size = v; $('#textSizeLabel').textContent = `${Math.round(v * 100)}%`; });
  $('#textColor').addEventListener('input', (e) => { const c = selectedClip(); if (!c) return; if (!e.target._g) { pushUndo(); e.target._g = true; } c.text.color = e.target.value; invalidate(c); renderAt(state.playhead); });
  $('#textColor').addEventListener('change', (e) => { e.target._g = false; save(); });
  $('#textAccent').addEventListener('input', (e) => { const c = selectedClip(); if (!c) return; if (!e.target._g) { pushUndo(); e.target._g = true; } c.text.accent = e.target.value; invalidate(c); renderAt(state.playhead); });
  $('#textAccent').addEventListener('change', (e) => { e.target._g = false; save(); });
  bindSelect('#textAnim', (v, c) => { c.text.anim = v; });
  bindRange('#textDur', (v, c) => { c.text.dur = v; $('#textDurLabel').textContent = v ? `${Math.round(v * 100)}%` : 'whole clip'; });

  // Music tab
  $('#addMusicBtn').addEventListener('click', () => $('#musicInput').click());
  $('#musicInput').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await setMusic(f); });
  const bindMusic = (sel, key, label, fmtFn) => {
    const el = $(sel);
    el.addEventListener('input', () => { const mus = P().music; if (!mus) return; if (!el._g) { pushUndo(); el._g = true; } mus[key] = Number(el.value); if (label) $(label).textContent = fmtFn(mus[key]); if (key === 'offset') renderTimeline(); });
    el.addEventListener('change', () => { el._g = false; save(); });
  };
  bindMusic('#musicVolume', 'volume', '#musicVolumeLabel', v => `${Math.round(v * 100)}%`);
  bindMusic('#musicOffset', 'offset', '#musicOffsetLabel', v => `${v.toFixed(1)}s`);
  bindMusic('#musicFadeIn', 'fadeIn', '#musicFadeInLabel', v => `${v.toFixed(1)}s`);
  bindMusic('#musicFadeOut', 'fadeOut', '#musicFadeOutLabel', v => `${v.toFixed(1)}s`);
  $('#musicLoop').addEventListener('change', (e) => { if (!P().music) return; pushUndo(); P().music.loop = e.target.checked; renderTimeline(); save(); });
  $('#duckVideo').addEventListener('change', (e) => { if (!P().music) return; pushUndo(); P().music.duck = e.target.checked; save(); });
  $('#beatSyncBtn').addEventListener('click', () => { pause(); beatSync(); });
  $('#fitToMusicBtn').addEventListener('click', () => { pause(); fitToMusic(); });
  $('#removeMusicBtn').addEventListener('click', removeMusic);

  // Theme tab
  $$('#paceSeg button').forEach(b => b.addEventListener('click', () => { P().pace = b.dataset.pace; setSeg('paceSeg', 'pace', P().pace); save(); }));
  $('#themeTitle').addEventListener('change', (e) => { P().themeTitle = e.target.checked; save(); });
  $('#themeMusic').addEventListener('change', (e) => { P().themeMusic = e.target.checked; save(); });
  $('#applyThemeBtn').addEventListener('click', () => { if (!P().clips.length) { toast('Add clips first'); return; } pause(); pushUndo(); applyTheme({ retrim: false }); renderAll(); save(); toast(`${THEMES[P().theme].name} theme applied`); });
  $('#shuffleBtn').addEventListener('click', () => { pause(); shuffleClips(); });

  // Timeline zoom
  $('#tlZoom').addEventListener('input', (e) => { state.tlZoom = Number(e.target.value); renderTimeline(); });

  // Export dialog
  $('#exportCancelBtn').addEventListener('click', closeExport);
  $('#exportStartBtn').addEventListener('click', startExport);
  $('#exportShareBtn').addEventListener('click', shareExport);
  $('#exportDownloadBtn').addEventListener('click', () => { if (exportBlob) downloadBlob(exportBlob, exportName); });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'Home': pause(); setPlayhead(0); break;
      case 'End': pause(); setPlayhead(totalDuration()); break;
      case 'ArrowLeft': pause(); setPlayhead(state.playhead - (e.shiftKey ? 1 : 1 / 30)); break;
      case 'ArrowRight': pause(); setPlayhead(state.playhead + (e.shiftKey ? 1 : 1 / 30)); break;
      case 's': case 'S': pause(); splitAtPlayhead(); break;
      case 'Delete': case 'Backspace': if (state.selectedId) { e.preventDefault(); deleteClip(state.selectedId); } break;
      case '[': $('#setInBtn').click(); break;
      case ']': $('#setOutBtn').click(); break;
      case 'Escape': if (!$('#exportDialog').hidden) closeExport(); break;
    }
  });
  window.addEventListener('resize', () => renderTimeline());
}

/* ======================================================================
   Boot
   ====================================================================== */
async function restore() {
  try {
    const mediaList = (await DB.getKV('media')) || [];
    for (const item of mediaList) {
      const blob = await DB.getFile(item.id);
      if (!blob) continue;
      try { await loadMedia({ ...item, blob }); } catch (e) { console.warn('restore media failed', e); }
    }
    const saved = await DB.getKV('project');
    if (saved && saved.clips) {
      state.project = { ...newProject(), ...saved };
      P().clips = P().clips.filter(c => state.media.has(c.mediaId));
      if (P().music) await restoreMusic(P().music);
    }
  } catch (e) { console.warn('restore failed', e); }
}

async function boot() {
  bindUI();
  applyAspect();
  renderAll();
  await restore();
  applyAspect();
  renderAll();
  loadLibrary();
  if (state.media.size) toast('Welcome back – your project was restored');
}
boot();

window.addEventListener('error', (e) => { if (e && e.message) toast(`Error: ${e.message}`, 6000); });
window.addEventListener('unhandledrejection', (e) => { const r = e && e.reason; toast(`Error: ${r && r.message ? r.message : r}`, 6000); });

/* Exposed for debugging / tests */
window.QuikWeb = { state, importFiles, addToTimeline, autoCreate, applyTheme, beatSync, play, pause, setPlayhead, renderAt, totalDuration, layout, setMusic, splitAtPlayhead, startExport, pickMime, useLibraryTrack, loadLibrary };
})();
