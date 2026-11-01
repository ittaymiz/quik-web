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
const PREVIEW_LONG = window.matchMedia('(max-width: 760px)').matches ? 960 : 1280;
const MIN_CLIP = 1.0;
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
  return { title: '', aspect: '16:9', theme: 'classic', pace: 'medium', themeTitle: true, themeMusic: true, targetLength: 30, clips: [], music: null };
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
    DB.putKV('media', Array.from(state.media.values()).map(m => ({ id: m.id, kind: m.kind, name: m.name, scores: m.scores || null })));
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

/* ---------- Player pool ----------
   Phones allow only a few hardware video decoders at once, so instead of one element per file the
   whole timeline is played by two shared elements (one playing, one pre-loading the next clip) plus
   one off-screen element for thumbnails and transition frames. Clip i always uses players[i % 2]. */
function makeVideoEl(inStage) {
  const el = document.createElement('video');
  el.preload = 'auto'; el.playsInline = true; el.muted = true;
  el.setAttribute('muted', ''); el.setAttribute('playsinline', '');
  if (inStage) { el.className = 'stage-el'; $('#stageMedia').appendChild(el); }
  return el;
}
const players = [{ el: makeVideoEl(true), mediaId: null }, { el: makeVideoEl(true), mediaId: null }];
const scratch = { el: makeVideoEl(false), mediaId: null };
function playerForIdx(idx) { return players[Math.abs(idx) % 2]; }
function waitMeta(el, ms = 8000) {
  return new Promise(res => {
    if (el.readyState >= 1) return res();
    const t = setTimeout(res, ms);
    el.addEventListener('loadedmetadata', () => { clearTimeout(t); res(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(t); res(); }, { once: true });
  });
}
function bindSync(p, m) {
  if (p.mediaId === m.id) return false;
  p.mediaId = m.id;
  p.el.pause();
  p.el.src = m.url;
  try { p.el.load(); } catch (e) {}
  return true;
}
async function bind(p, m) {
  if (p.mediaId !== m.id) bindSync(p, m);
  if (p.el.readyState < 1) await waitMeta(p.el);
}
function unbind(p) {
  p.mediaId = null; p.el.pause();
  p.el.removeAttribute('src');
  try { p.el.load(); } catch (e) {}
}
function unbindMedia(id) { [...players, scratch].forEach(p => { if (p.mediaId === id) unbind(p); }); }

async function loadVideoMedia(entry) {
  bindSync(scratch, entry);
  const el = scratch.el;
  // Starts muted: iOS only decodes a muted video before the user has tapped play.
  // unlockMedia() unmutes it inside the first play gesture.
  await new Promise((res, rej) => {
    if (el.readyState >= 1) return res();
    const timer = setTimeout(() => rej(new Error('timed out while reading the video')), 25000);
    el.addEventListener('loadedmetadata', () => { clearTimeout(timer); res(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(timer); rej(new Error('the browser cannot play this video format')); }, { once: true });
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
  entry.duration = isFinite(el.duration) ? el.duration : 10;
  entry.w = el.videoWidth || 1280; entry.h = el.videoHeight || 720;
  entry.thumb = await grabVideoThumb(el, Math.min(0.5, entry.duration / 2), entry.w, entry.h);
  if (isBlack(entry.thumb)) entry.thumb = await grabVideoThumb(el, Math.min(1.5, entry.duration / 3), entry.w, entry.h);
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
  entry.el.className = 'stage-el'; $('#stageMedia').appendChild(entry.el);
  entry.thumb = thumbFrom(entry.el, entry.w, entry.h);
  try { probeCtx.drawImage(entry.el, 0, 0, 64, 36); entry.scores = { step: 0, values: [], sig: cellSignature() }; } catch (e) {}
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
    const dup = Array.from(state.media.values()).find(m => m.name === file.name && m.blob && m.blob.size === file.size);
    if (dup) { failed.push(`${file.name}: already in the media bin`); continue; }
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
  queueAnalysis(added);
  if (failed.length && failed.every(f => /already in the media bin/.test(f))) toast(`Skipped ${failed.length} duplicate file${failed.length > 1 ? 's' : ''} (already imported)`, 4000);
  else if (failed.length) toast(`Could not open ${failed.length} file${failed.length > 1 ? 's' : ''} – ${failed[0]}`, 7000);
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
  unbindMedia(id);
  if (m.el && m.el.parentElement) m.el.parentElement.removeChild(m.el);
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
  await withScratch(async () => {
    await bind(scratch, m);
    const el = scratch.el;
    for (let i = 0; i < n; i++) out.push(await grabVideoThumb(el, (i + 0.5) / n * m.duration, m.w, m.h, 120));
  });
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
  // Make sure both players carry a source so the gesture unlocks them.
  let firstVideo = null; state.media.forEach(m => { if (!firstVideo && m.kind === 'video') firstVideo = m; });
  players.forEach(p => { if (!p.mediaId && firstVideo) bindSync(p, firstVideo); });
  const els = [musicEl, players[0].el, players[1].el];
  els.forEach(el => {
    if (unlockedEls.has(el) || !el.src) return;
    unlockedEls.add(el);
    // Play silently, then pause again unless playback has meanwhile started on this element.
    const g = gainFor.get(el);
    const savedGain = g ? g.gain.value : null, savedMuted = false;
    if (g) { g.gain.value = 0; el.muted = false; } else el.muted = true;
    const restore = () => {
      const activeClip = state.playing && activeIdx >= 0 ? P().clips[activeIdx] : null;
      const keep = (el === musicEl && state.playing && P().music) || (activeClip && activeClip.kind === 'video' && playerForIdx(activeIdx).el === el);
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
  players.forEach(p => connectAudioEl(p.el));
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
const ctxRef = { ctx };
let W = canvas.width, H = canvas.height;
function drawSourceTo(target, c, m, el, lt, dur) { const keep = ctxRef.ctx; ctxRef.ctx = target; try { drawSource(c, m, el, lt, dur); } finally { ctxRef.ctx = keep; } }
function drawTextTo(target, c, lt, dur) { const keep = ctxRef.ctx; ctxRef.ctx = target; try { drawText(c, lt, dur); } finally { ctxRef.ctx = keep; } }

function setCanvasSize(long) {
  const [aw, ah] = ASPECTS[P().aspect] || ASPECTS['16:9'];
  if (aw >= ah) { W = long; H = Math.round(long * ah / aw); } else { H = long; W = Math.round(long * aw / ah); }
  W -= W % 2; H -= H % 2;
  canvas.width = W; canvas.height = H;
  try { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; } catch (e) {}
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
  const cx = ctxRef.ctx;
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
  cx.save();
  const css = filterCss(c.filter);
  if (HAS_CTX_FILTER) cx.filter = css;
  try { cx.drawImage(el, dx, dy, dw, dh); } catch (e) { /* frame not ready */ }
  cx.restore();
  if (!HAS_CTX_FILTER && css !== 'none') applyFilterFallback(css);
  if (c.filter.vignette > 0) {
    const g = cx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${0.85 * c.filter.vignette})`);
    cx.fillStyle = g; cx.fillRect(0, 0, W, H);
  }
}

/* Approximates CSS filter functions with canvas blend modes when ctx.filter is unavailable. */
function applyFilterFallback(css) {
  const cx = ctxRef.ctx;
  const re = /(\w[\w-]*)\(([^)]*)\)/g; let m;
  cx.save();
  while ((m = re.exec(css))) {
    const fn = m[1]; const v = parseFloat(m[2]);
    const blend = (mode, color, alpha) => { cx.globalCompositeOperation = mode; cx.globalAlpha = clamp(alpha, 0, 1); cx.fillStyle = color; cx.fillRect(0, 0, W, H); };
    switch (fn) {
      case 'grayscale': blend('saturation', '#808080', v); break;
      case 'saturate':
        if (v < 1) blend('saturation', '#808080', 1 - v);
        else if (v > 1) { cx.globalCompositeOperation = 'saturation'; cx.globalAlpha = clamp((v - 1) * 0.6, 0, 1); cx.drawImage(canvas, 0, 0); }
        break;
      case 'sepia': blend('color', '#a67c52', v * 0.8); break;
      case 'brightness': if (v > 1) blend('screen', '#ffffff', (v - 1)); else if (v < 1) blend('multiply', '#000000', 1 - v); break;
      case 'contrast':
        if (v > 1) { cx.globalCompositeOperation = 'overlay'; cx.globalAlpha = clamp((v - 1) * 1.2, 0, 1); cx.drawImage(canvas, 0, 0); }
        else if (v < 1) blend('source-over', '#808080', (1 - v));
        break;
      case 'hue-rotate': blend('hue', v < 0 ? '#4f8cff' : '#ff7a4f', Math.min(0.35, Math.abs(v) / 90)); break;
    }
  }
  cx.restore();
  cx.globalCompositeOperation = 'source-over'; cx.globalAlpha = 1;
}

function drawText(c, lt, dur) {
  const cx = ctxRef.ctx;
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
  cx.save();
  cx.globalAlpha = (t.anim === 'fade' || t.anim === 'slideUp' ? p : 1) * outP;
  cx.font = `${weight} ${fontSize}px ${family}`;
  cx.textBaseline = 'middle';
  cx.textAlign = isLower ? 'left' : 'center';
  const x = isLower ? W * 0.08 : W / 2;
  let y0;
  if (isLower) y0 = H * 0.86 - (lines.length - 1) * lineH;
  else if (t.pos === 'top') y0 = H * 0.14;
  else if (t.pos === 'bottom') y0 = H * 0.86 - (lines.length - 1) * lineH;
  else y0 = H / 2 - (lines.length - 1) * lineH / 2;
  let dy = 0, scale = 1;
  if (t.anim === 'slideUp') dy = (1 - easeOut(p)) * fontSize * 0.8;
  if (t.anim === 'pop') scale = 0.6 + 0.4 * easeOut(p);
  cx.translate(x, y0 + dy); cx.scale(scale, scale); cx.translate(-x, -(y0 + dy));
  cx.shadowColor = 'rgba(0,0,0,0.6)'; cx.shadowBlur = fontSize * 0.15; cx.shadowOffsetY = fontSize * 0.04;
  lines.forEach((line, i) => {
    const y = y0 + dy + i * lineH;
    if (t.style === 'box' || isLower) {
      const w = cx.measureText(line).width;
      const padX = fontSize * 0.4, padY = fontSize * 0.2;
      cx.save(); cx.shadowColor = 'transparent';
      cx.fillStyle = t.accent;
      const bx = isLower ? x - padX : x - w / 2 - padX;
      cx.fillRect(bx, y - lineH / 2 - padY / 2 + fontSize * 0.1, w + padX * 2, lineH + padY - fontSize * 0.1);
      if (isLower) { cx.fillStyle = t.color; cx.fillRect(bx - fontSize * 0.25, y - lineH / 2 - padY / 2 + fontSize * 0.1, fontSize * 0.12, lineH + padY - fontSize * 0.1); }
      cx.restore();
    }
    if (t.style === 'outline') {
      cx.lineWidth = fontSize * 0.1; cx.lineJoin = 'round'; cx.strokeStyle = t.accent;
      cx.strokeText(line, x, y);
    }
    cx.fillStyle = t.color;
    cx.fillText(line, x, y);
  });
  cx.restore();
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
  if (snap && !state.playing) state.snapCache.delete(clip.id);   // stage-sized snapshot: re-render at canvas size
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
  if (clip.kind === 'video') { await withScratch(async () => { await bind(scratch, m); await seekTo(scratch.el, clip.end - 0.03); await waitFrame(scratch.el, 150); }); el = scratch.el; }
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
  const el = srcEl || (clip.kind === 'video' ? playerForIdx(idx).el : m.el);
  drawSource(clip, m, el, lt, dur);
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
    const p = playerForIdx(loc.idx);
    await bind(p, m);
    if (token !== renderToken) return;
    await seekTo(p.el, st); await waitFrame(p.el, 120);
    if (token !== renderToken) return;
    if (p.el.readyState < 2) { await bind(scratch, m); await seekTo(scratch.el, st); await waitFrame(scratch.el, 120); if (token !== renderToken) return; srcEl = scratch.el; }
  }
  drawFrameNow(loc, srcEl);
}

function setPlayhead(t, render = true) {
  state.playhead = clamp(t, 0, Math.max(0, totalDuration()));
  updatePlayheadUI();
  if (render && !state.playing) renderAt(state.playhead);
}

/* ======================================================================
   Stage: native playback layer used while playing (video elements render
   themselves; look, reframe, text and transitions are applied as CSS).
   ====================================================================== */
const stage = $('#stage'), stagePrev = $('#stagePrev'), stageText = $('#stageText'), stageOverlay = $('#stageOverlay'), stageVignette = $('#stageVignette');
let stageClip = null, stageTextEl = null, stageH = 540;

function sizeStage() {
  const wrap = $('#previewWrap').getBoundingClientRect();
  const r = canvas.getBoundingClientRect();
  stage.style.left = `${r.left - wrap.left}px`; stage.style.top = `${r.top - wrap.top}px`;
  stage.style.width = `${r.width}px`; stage.style.height = `${r.height}px`;
  stageH = r.height || 540;
  if (stageTextEl && stageClip) stageTextEl.style.fontSize = `${stageClip.text.size * stageH}px`;
}
function showStage(on) {
  if (on) { sizeStage(); stage.hidden = false; canvas.style.visibility = 'hidden'; }
  else {
    stage.hidden = true; canvas.style.visibility = '';
    players.forEach(p => { p.el.style.visibility = 'hidden'; });
    state.media.forEach(m => { if (m.el && m.el.style) m.el.style.visibility = 'hidden'; });
    stagePrev.style.display = 'none'; stageOverlay.style.background = 'transparent'; stageText.innerHTML = ''; stageTextEl = null; stageClip = null;
  }
}
/* Same geometry as drawSource(), expressed in percentages of the stage. */
function placeStageEl(c, m, lt, dur, el) {
  const sw = m.w, sh = m.h;
  let scale = c.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  let z = c.zoom, drift = 0;
  if (c.kind === 'image' && c.kenBurns) { const p = clamp(lt / dur, 0, 1); z *= 1 + 0.12 * p; drift = (p - 0.5) * 0.06 * W; }
  scale *= z;
  const dw = sw * scale, dh = sh * scale;
  const dx = (W - dw) / 2 - c.panX * Math.abs(dw - W) / 2 + drift;
  const dy = (H - dh) / 2 - c.panY * Math.abs(dh - H) / 2;
  el.style.left = `${dx / W * 100}%`; el.style.top = `${dy / H * 100}%`;
  el.style.width = `${dw / W * 100}%`; el.style.height = `${dh / H * 100}%`;
}
function stageSetup(loc) {
  const { clip, idx } = loc;
  const m = state.media.get(clip.mediaId);
  stageClip = clip;
  const el = m ? (clip.kind === 'video' ? playerForIdx(idx).el : m.el) : null;
  players.forEach(p => { if (p.el !== el) p.el.style.visibility = 'hidden'; });
  state.media.forEach(x => { if (x.el && x.el !== el && x.el.style) x.el.style.visibility = 'hidden'; });
  if (m && el && el.style) {
    placeStageEl(clip, m, loc.lt, loc.dur, el);
    const f = filterCss(clip.filter);
    el.style.filter = f === 'none' ? '' : f;
    el.style.visibility = 'visible';
  }
  const v = clip.filter.vignette;
  stageVignette.style.background = v > 0 ? `radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,${0.85 * v}) 100%)` : 'transparent';
  // Text
  stageText.innerHTML = ''; stageTextEl = null;
  const t = clip.text;
  if ((t.content || '').trim()) {
    const d = document.createElement('div');
    d.className = 'stage-text';
    const isLower = t.style === 'lower';
    d.style.fontWeight = t.style === 'minimal' ? 300 : 800;
    d.style.fontSize = `${t.size * stageH}px`;
    d.style.color = t.color;
    d.style.textAlign = isLower ? 'left' : 'center';
    d.style.maxWidth = '90%';
    if (isLower) { d.style.left = '8%'; d.style.bottom = '10%'; d.style.transformOrigin = 'left bottom'; }
    else {
      d.style.left = '50%';
      d.style.top = t.pos === 'top' ? '14%' : t.pos === 'bottom' ? '86%' : '50%';
      d.style.transform = 'translate(-50%, -50%)';
    }
    if (t.style === 'outline') { d.style.webkitTextStroke = `${0.05 * t.size * stageH}px ${t.accent}`; d.style.paintOrder = 'stroke fill'; }
    if (t.style === 'box' || isLower) { d.style.background = t.accent; d.style.padding = '0.1em 0.4em'; d.style.textShadow = 'none'; }
    if (isLower) d.style.borderLeft = `0.12em solid ${t.color}`;
    d.textContent = t.content.trim();
    stageText.appendChild(d);
    stageTextEl = d;
  }
  // Transition source: last frame of the previous clip
  const tr = clip.transition;
  stagePrev.style.display = 'none';
  if (idx > 0 && tr && tr.type !== 'none') {
    const prev = state.snapCache.get(P().clips[idx - 1].id);
    if (prev) {
      if (stagePrev.width !== prev.width || stagePrev.height !== prev.height) { stagePrev.width = prev.width; stagePrev.height = prev.height; }
      stagePrev.getContext('2d').drawImage(prev, 0, 0);
      stagePrev.style.display = 'block';
      stagePrev.style.opacity = '1'; stagePrev.style.transform = 'none'; stagePrev.style.clipPath = 'none';
    }
  } else if (idx > 0) {
    // Hard cut: show the previous frame until the new video has painted one (avoids a black blink).
    const prev = state.snapCache.get(P().clips[idx - 1].id);
    if (prev) {
      if (stagePrev.width !== prev.width || stagePrev.height !== prev.height) { stagePrev.width = prev.width; stagePrev.height = prev.height; }
      stagePrev.getContext('2d').drawImage(prev, 0, 0);
      stagePrev.style.display = 'block'; stagePrev.style.opacity = '1'; stagePrev.style.transform = 'none'; stagePrev.style.clipPath = 'none';
    }
  }
  stageOverlay.style.background = 'transparent';
}
function stageUpdate(loc) {
  const { clip, lt, dur } = loc;
  const m = state.media.get(clip.mediaId);
  if (clip.kind === 'image' && clip.kenBurns && m) placeStageEl(clip, m, lt, dur, m.el);
  if (stageTextEl) {
    const t = clip.text;
    const showDur = t.dur > 0 ? Math.max(0.5, dur * t.dur) : dur;
    if (lt > showDur) stageTextEl.style.opacity = '0';
    else {
      const p = t.anim === 'none' ? 1 : clamp(lt / 0.5, 0, 1);
      const outP = clamp((showDur - lt) / 0.3, 0, 1);
      let opacity = outP, extra = '';
      if (t.anim === 'fade' || t.anim === 'slideUp') opacity *= p;
      if (t.anim === 'slideUp') extra = ` translateY(${(1 - easeOut(p)) * 0.8}em)`;
      if (t.anim === 'pop') extra = ` scale(${0.6 + 0.4 * easeOut(p)})`;
      if (t.anim === 'typewriter') {
        const full = t.content.trim();
        const want = full.slice(0, Math.floor(clamp(lt / Math.min(1.5, showDur), 0, 1) * full.length));
        if (stageTextEl.textContent !== want) stageTextEl.textContent = want;
      }
      stageTextEl.style.opacity = String(opacity);
      stageTextEl.style.transform = (t.style === 'lower' ? '' : 'translate(-50%, -50%)') + extra;
    }
  }
  const tr = clip.transition;
  const hasPrev = stagePrev.style.display === 'block';
  if (tr && tr.type !== 'none' && lt < tr.duration) {
    const p = clamp(lt / tr.duration, 0, 1);
    switch (tr.type) {
      case 'crossfade': if (hasPrev) stagePrev.style.opacity = String(1 - easeInOut(p)); break;
      case 'fade':
        if (hasPrev && p < 0.5) { stagePrev.style.opacity = '1'; stageOverlay.style.background = `rgba(0,0,0,${p * 2})`; }
        else { if (hasPrev) stagePrev.style.opacity = '0'; stageOverlay.style.background = `rgba(0,0,0,${hasPrev ? 1 - (p - 0.5) * 2 : 1 - p})`; }
        break;
      case 'flash':
        if (hasPrev && p < 0.5) { stagePrev.style.opacity = '1'; stageOverlay.style.background = `rgba(255,255,255,${p * 2})`; }
        else { if (hasPrev) stagePrev.style.opacity = '0'; stageOverlay.style.background = `rgba(255,255,255,${hasPrev ? 1 - (p - 0.5) * 2 : 1 - p})`; }
        break;
      case 'slide': if (hasPrev) stagePrev.style.transform = `translateX(${-easeInOut(p) * 100}%)`; break;
      case 'wipe': if (hasPrev) stagePrev.style.clipPath = `inset(0 0 0 ${easeInOut(p) * 100}%)`; break;
      case 'zoom': if (hasPrev) { stagePrev.style.transform = `scale(${1 + easeOut(p) * 0.6})`; stagePrev.style.opacity = String(1 - p); } break;
    }
  } else {
    if (hasPrev && (frameReady || (tr && tr.type !== 'none') || lt > 0.4)) stagePrev.style.display = 'none';
    stageOverlay.style.background = 'transparent';
  }
}
/* Captures the previous clip's final frame straight from its element at the cut (one small draw). */
function snapshotClip(loc) {
  const m = state.media.get(loc.clip.mediaId);
  if (!m) return null;
  const c = document.createElement('canvas');
  c.width = Math.min(W, 960); c.height = Math.round(c.width * H / W);
  const x = c.getContext('2d');
  const saveW = W, saveH = H;
  W = c.width; H = c.height;
  const el = loc.clip.kind === 'video' ? playerForIdx(loc.idx).el : m.el;
  try { x.fillStyle = '#000'; x.fillRect(0, 0, W, H); drawSourceTo(x, loc.clip, m, el, loc.dur, loc.dur); drawTextTo(x, loc.clip, loc.dur, loc.dur); }
  finally { W = saveW; H = saveH; }
  return c;
}

/* ======================================================================
   Playback engine
   ====================================================================== */
let wallStart = 0, tStart = 0, activeIdx = -1, rafId = 0, holdFrame = null, frameReady = true;
/* Live render: the timeline plays through the stage (smooth on phones) while every presented
   frame is composed on the canvas and encoded with its exact timestamp. */
let liveExport = null;   // { venc, fps, total, lastT, lastKey, frames, resolve, reject, onProgress }
function liveEncodeFrame(loc, t) {
  const le = liveExport;
  const el = loc.clip.kind === 'video' ? playerForIdx(loc.idx).el : null;
  if (!frameReady && holdFrame) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.drawImage(holdFrame, 0, 0, W, H); }
  else drawFrameNow(loc, el);
  const key = el ? el.currentTime : t;
  const inMotion = loc.clip.kind !== 'video' || loc.lt < (loc.clip.transition.duration || 0) + 0.1 || (loc.clip.text.content || '').trim();
  if (t - le.lastT < 1 / le.fps * 0.7) return;
  if (!inMotion && key === le.lastKey) return;      // no new video frame yet
  try {
    const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / le.fps) });
    le.venc.encode(frame, { keyFrame: le.frames % (le.fps * 2) === 0 });
    frame.close();
    le.frames++; le.lastT = t; le.lastKey = key;
  } catch (e) { le.error = e; }
  if (le.onProgress && le.frames % 5 === 0) le.onProgress(t / le.total);
}
function renderLive(venc, fps, total, onProgress) {
  return new Promise((resolve, reject) => {
    liveExport = { venc, fps, total, lastT: -1, lastKey: null, frames: 0, resolve, reject, onProgress, error: null };
    state.snapCache.clear();
    if (masterGain) masterGain.gain.value = 0;
    state.playhead = 0;
    play();
    if (!state.playing) { liveExport = null; reject(new Error('could not start playback for live render')); }
  });
}
function endLive(err) {
  const le = liveExport; if (!le) return;
  liveExport = null;
  if (masterGain) masterGain.gain.value = 1;
  if (err) le.reject(err); else le.resolve(le.frames);
}
const prerolled = new Set();
function prerollNext(loc) {
  const next = P().clips[loc.idx + 1];
  if (!next || next.kind !== 'video' || prerolled.has(next.id)) return;
  if (loc.dur - loc.lt > 1.2) return;
  const nm = state.media.get(next.mediaId);
  if (!nm) return;
  const p = playerForIdx(loc.idx + 1);   // the other player: free while the current clip plays
  prerolled.add(next.id);
  bindSync(p, nm);
  try { p.el.playbackRate = clamp(next.speed, 0.0625, 16); p.el.currentTime = next.start; } catch (e) {}
}

function effectiveClipVolume(c) {
  const mus = P().music;
  const duck = mus && mus.duck ? 0.35 : 1;
  return clamp(c.volume * duck, 0, 1);
}
function startClipMedia(clip, lt, idx) {
  const m = state.media.get(clip.mediaId);
  if (!m || clip.kind !== 'video') return;
  const p = playerForIdx(idx);
  bindSync(p, m);
  const el = p.el;
  if (prerolled.has(clip.id) && Math.abs(el.currentTime - (clip.start + lt * clip.speed)) < 0.25) { el.playbackRate = clamp(clip.speed, 0.0625, 16); setElVolume(el, effectiveClipVolume(clip)); el.play().catch(() => {}); return; }
  el.playbackRate = clamp(clip.speed, 0.0625, 16);
  try { el.preservesPitch = true; } catch (e) {}
  setElVolume(el, effectiveClipVolume(clip));
  el.currentTime = clip.start + lt * clip.speed;
  el.play().catch(() => {});
}
function stopClipMedia(clip, idx) {
  if (clip.kind === 'video') playerForIdx(idx).el.pause();
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
let musicNode = null, musicGain = null, musicBuffer = null, musicBufferKey = null;
async function prepareMusicBuffer() {
  const mus = P().music;
  if (!mus || !state.musicBlob) { musicBuffer = null; musicBufferKey = null; return; }
  const key = 'music:' + mus.fileId;
  if (musicBufferKey === key && musicBuffer) return;
  const buf = await getAudioBuffer(key, state.musicBlob);
  if (P().music && 'music:' + P().music.fileId === key) { musicBuffer = buf; musicBufferKey = key; }
}
function stopMusicNode() {
  if (musicNode) { try { musicNode.stop(); } catch (e) {} try { musicNode.disconnect(); } catch (e) {} musicNode = null; }
  if (musicGain) { try { musicGain.disconnect(); } catch (e) {} musicGain = null; }
}
function startMusic(t) {
  const mus = P().music;
  if (!mus) return;
  stopMusicNode();
  if (actx && masterGain && musicBuffer && musicBufferKey === 'music:' + mus.fileId) {
    // Web Audio playback: sample-accurate and never interrupted by video elements on iOS.
    const len = musicBuffer.duration;
    let pos = (mus.offset || 0) + t;
    if (pos >= len) { if (!mus.loop) return; pos = (pos - len) % len; }
    const src = actx.createBufferSource();
    src.buffer = musicBuffer; src.loop = !!mus.loop;
    musicGain = actx.createGain(); musicGain.gain.value = musicVolumeAt(t);
    src.connect(musicGain); musicGain.connect(masterGain); if (recDest) musicGain.connect(recDest);
    src.start(0, pos);
    musicNode = src;
    return;
  }
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
  const total = totalDuration();
  if (state.playhead >= total - 0.05) state.playhead = 0;
  const loc0 = locate(state.playhead);
  if (loc0) {
    for (let k = 0; k < 2; k++) { const c = P().clips[loc0.idx + k]; const m = c && state.media.get(c.mediaId); if (c && c.kind === 'video' && m) bindSync(playerForIdx(loc0.idx + k), m); }
  }
  unlockMedia();
  state.playing = true;
  wallStart = performance.now(); tStart = state.playhead; activeIdx = -1; prerolled.clear();
  if (!state.exporting) showStage(true);
  startMusic(state.playhead);
  $('#playBtn').textContent = '❚❚';
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}
function pause() {
  if (!state.playing) return;
  state.playing = false;
  cancelAnimationFrame(rafId);
  if (activeIdx >= 0 && P().clips[activeIdx]) stopClipMedia(P().clips[activeIdx], activeIdx);
  activeIdx = -1; prerolled.clear();
  stopMusicNode();
  musicEl.pause();
  showStage(false);
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
    if (liveExport) endLive(liveExport.error);
    return;
  }
  if (liveExport && ((offline && offline.cancelled) || liveExport.error)) { const e = liveExport.error || new Error('cancelled'); pause(); endLive(e); return; }
  const loc = locate(t);
  if (loc.idx !== activeIdx) {
    if (activeIdx >= 0 && P().clips[activeIdx]) {
      const prevLoc = layout()[activeIdx];
      if (prevLoc) { const snap = (state.exporting || liveExport) ? snapshotCanvas() : snapshotClip(prevLoc); if (snap) state.snapCache.set(P().clips[activeIdx].id, snap); }
      stopClipMedia(P().clips[activeIdx], activeIdx);
    }
    activeIdx = loc.idx;
    startClipMedia(loc.clip, loc.lt, loc.idx);
    if (!state.exporting) stageSetup(loc);
    // Until the new clip has actually presented a frame, keep showing the last frame of the previous one.
    const pel = loc.clip.kind === 'video' ? playerForIdx(loc.idx).el : null;
    if (pel && typeof pel.requestVideoFrameCallback === 'function') {
      holdFrame = loc.idx > 0 ? state.snapCache.get(P().clips[loc.idx - 1].id) || null : null;
      frameReady = false;
      const token = activeIdx;
      waitFrame(pel, 350).then(() => { if (token === activeIdx) { frameReady = true; holdFrame = null; } });
    } else { frameReady = true; holdFrame = null; }
  } else if (loc.clip.kind === 'video') {
    const pel = playerForIdx(loc.idx).el;
    if (pel.readyState >= 2) {
      const expected = loc.clip.start + loc.lt * loc.clip.speed;
      if (Math.abs(pel.currentTime - expected) > 0.35) pel.currentTime = expected;
      if (pel.paused) pel.play().catch(() => {});
    }
  }
  state.playhead = t;
  prerollNext(loc);
  if (state.exporting) {
    if (!frameReady && holdFrame) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.drawImage(holdFrame, 0, 0); }
    else drawFrameNow(loc);
  } else { stageUpdate(loc); if (liveExport) liveEncodeFrame(loc, t); }
  if (P().music) {
    if (musicGain) musicGain.gain.value = musicVolumeAt(t);
    else { setElVolume(musicEl, musicVolumeAt(t)); if (musicEl.paused && musicEl.src && (P().music.loop || P().music.offset + t < P().music.duration)) musicEl.play().catch(() => {}); }
  }
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

/* ---------- Target length / edit planner ---------- */
function targetSeconds() {
  const t = P().targetLength;
  if (t === 'music') return P().music ? Math.max(10, P().music.duration - (P().music.offset || 0)) : 120;
  return clamp(Number(t) || 120, 5, 3600);
}
function fmtLen(sec) { const m = Math.floor(sec / 60), r = Math.round(sec % 60); return m ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`; }
/* ---------- Highlight analysis ----------
   Samples each video about once a second (scratch element), measures contrast, sharpness, motion and
   exposure on a tiny frame, and stores a 0..1 "interest" curve. Auto Create picks the best windows. */
let scratchLock = Promise.resolve();
function withScratch(fn) { const run = scratchLock.then(fn, fn); scratchLock = run.catch(() => {}); return run; }
const analysisQueue = [];
let analysisRunning = false, analysisProgress = { done: 0, total: 0 };
const probeCanvas = document.createElement('canvas'); probeCanvas.width = 64; probeCanvas.height = 36;
const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });

function frameFeatures(prevL) {
  const d = probeCtx.getImageData(0, 0, 64, 36).data;
  const L = new Float32Array(64 * 36);
  let mean = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; L[j] = l; mean += l; }
  mean /= L.length;
  let varSum = 0, sharp = 0, motion = 0;
  for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) {
    const i = y * 64 + x, l = L[i];
    varSum += (l - mean) * (l - mean);
    if (x < 63) sharp += Math.abs(L[i + 1] - l);
    if (prevL) motion += Math.abs(prevL[i] - l);
  }
  const std = Math.sqrt(varSum / L.length);
  sharp /= (36 * 63); motion = prevL ? motion / L.length : 0;
  let score = 0.35 * Math.min(1, std / 60) + 0.35 * Math.min(1, sharp / 18) + 0.3 * Math.min(1, motion / 22);
  if (mean < 28) score *= 0.45; else if (mean < 50) score *= 0.8;
  if (mean > 235) score *= 0.6;
  if (motion > 60) score *= 0.7;            // violent shake / whip pans
  return { score, L };
}
/* 4x4 grid of mean R,G,B (48 values, 0..1) of whatever is on the probe canvas. */
function cellSignature() {
  const d = probeCtx.getImageData(0, 0, 64, 36).data;
  const sig = new Array(48).fill(0), cnt = new Array(16).fill(0);
  for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) {
    const cell = Math.floor(y / 9) * 4 + Math.floor(x / 16), i = (y * 64 + x) * 4;
    sig[cell * 3] += d[i]; sig[cell * 3 + 1] += d[i + 1]; sig[cell * 3 + 2] += d[i + 2]; cnt[cell]++;
  }
  return sig.map((v, k) => v / cnt[Math.floor(k / 3)] / 255);
}
async function analyzeMedia(m) {
  if (m.kind !== 'video' || (m.scores && m.scores.sig && m.scores.sig.length === 144) || m.duration < 1) return;
  const step = Math.max(1, m.duration / 24);
  const values = [];
  const sig = [new Array(48).fill(0), new Array(48).fill(0), new Array(48).fill(0)], sigN = [0, 0, 0];   // first / middle / last third
  await withScratch(async () => {
    await bind(scratch, m);
    const el = scratch.el;
    let prevL = null;
    for (let t = step / 2; t < m.duration; t += step) {
      await seekTo(el, t); await waitFrame(el, 150);
      try { probeCtx.drawImage(el, 0, 0, 64, 36); } catch (e) { values.push(0.5); continue; }
      const f = frameFeatures(prevL);
      values.push(f.score); prevL = f.L;
      // 4x4 colour grid accumulated over the file = a coarse picture of what the scene looks like
      const cs = cellSignature();
      const third = Math.min(2, Math.floor(t / m.duration * 3));
      for (let k = 0; k < 48; k++) sig[third][k] += cs[k];
      sigN[third]++;
    }
  });
  if (!values.length) return;
  // Smooth a little and normalise within the file
  const sm = values.map((v, i) => (values[i - 1] ?? v) * 0.25 + v * 0.5 + (values[i + 1] ?? v) * 0.25);
  const lo = Math.min(...sm), hi = Math.max(...sm);
  m.scores = { step, values: hi - lo > 1e-3 ? sm.map(v => (v - lo) / (hi - lo)) : sm.map(() => 0.5), sig: sigN.some(n => n) ? [0, 1, 2].flatMap(th => { const n = sigN[th] || sigN.find(x => x) || 1; const src = sigN[th] ? sig[th] : sig[sigN.findIndex(x => x)]; return src.map(v => v / n); }) : null };
  save();
}
function queueAnalysis(list) {
  const needs = (m) => m.kind === 'video' && !(m.scores && m.scores.sig && m.scores.sig.length === 144);
  list.forEach(m => { if (needs(m) && !analysisQueue.includes(m)) analysisQueue.push(m); });
  analysisProgress.total += list.filter(needs).length;
  runAnalysis();
}
async function runAnalysis() {
  if (analysisRunning) return;
  analysisRunning = true;
  while (analysisQueue.length) {
    const m = analysisQueue.shift();
    if (!state.media.has(m.id)) continue;
    try { await analyzeMedia(m); } catch (e) { console.info('analysis failed', m.name, e); }
    analysisProgress.done++;
  }
  analysisRunning = false;
  analysisProgress = { done: 0, total: 0 };
}
/* Waits (with a progress toast) until every video in the bin has an interest curve. */
async function ensureAnalyzed(maxWaitMs = 120000) {
  const pending = () => Array.from(state.media.values()).filter(m => m.kind === 'video' && !(m.scores && m.scores.sig && m.scores.sig.length === 144));
  if (!pending().length) return true;
  queueAnalysis(pending());
  const t0 = performance.now();
  while (pending().length && performance.now() - t0 < maxWaitMs) {
    toast(`Finding the best moments… ${analysisProgress.done}/${analysisProgress.total}`, 4000);
    await sleep(400);
  }
  return !pending().length;
}
/* 0 = looks different, 1 = looks the same (coarse brightness layout of the whole file). */
function sceneSimilarity(a, b) {
  const sa = a.scores && a.scores.sig, sb = b.scores && b.scores.sig;
  if (!sa || !sb) return 0;
  if (sa.length !== sb.length) return 0;      // old brightness-only fingerprint vs new colour one
  let d = 0; for (let i = 0; i < sa.length; i++) d += Math.abs(sa[i] - sb[i]);
  return clamp(1 - (d / sa.length) / 0.12, 0, 1);   // avg difference of 12% per colour channel or more = different scenes
}
/* Same content? Identical file (name+size), or same duration/size with an almost identical look. */
function sameContent(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.name === b.name && a.blob && b.blob && a.blob.size === b.blob.size) return true;
  if (a.name && a.name === b.name && a.w === b.w && a.h === b.h && (a.kind === 'image' || Math.abs(a.duration - b.duration) < 0.15)) return true;
  const sim = sceneSimilarity(a, b);
  if (a.kind === 'video') return Math.abs(a.duration - b.duration) < 0.1 && a.w === b.w && a.h === b.h && sim > 0.95;
  return sim > 0.93 && a.w === b.w && a.h === b.h;
}
/* Exact duplicates in the bin: same kind, name, dimensions and duration. Returns [{keep, dupes[]}]. */
function findDuplicateMedia() {
  const groups = new Map();
  state.media.forEach(m => {
    const key = `${m.kind}|${(m.name || '').toLowerCase()}|${m.w}x${m.h}|${m.kind === 'video' ? Math.round(m.duration * 10) : 0}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });
  return Array.from(groups.values()).filter(g => g.length > 1).map(g => ({ keep: g[0], dupes: g.slice(1) }));
}
async function removeDuplicateMedia({ silent = false } = {}) {
  const groups = findDuplicateMedia();
  if (!groups.length) { if (!silent) toast('No duplicate files in the media bin'); return 0; }
  if (!silent) pushUndo();
  let n = 0;
  for (const { keep, dupes } of groups) {
    for (const d of dupes) {
      P().clips.forEach(c => { if (c.mediaId === d.id) c.mediaId = keep.id; });
      if (!keep.scores && d.scores) keep.scores = d.scores;
      state.media.delete(d.id);
      unbindMedia(d.id);
      if (d.el && d.el.parentElement) d.el.parentElement.removeChild(d.el);
      try { URL.revokeObjectURL(d.url); } catch (e) {}
      DB.deleteFile(d.id);
      n++;
    }
  }
  // Clips that now point at the same file and footage are real repeats: keep the first of each.
  const seen = new Set();
  P().clips = P().clips.filter(c => { if (c.kind !== 'video') return true; const k = `${c.mediaId}|${c.start.toFixed(1)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  state.snapCache.clear();
  renderAll(); save();
  toast(`Removed ${n} duplicate file${n > 1 ? 's' : ''} from the media bin`, 4000);
  return n;
}
/* Collapses files that are the same content or show the same scene into one representative each
   (first in bin order). strict: similarity above which two files count as the same scene. */
function uniqueMedia(list, strict) {
  const kept = [];
  let dropped = 0;
  list.forEach(m => {
    const twin = kept.find(k => sameContent(k, m) || sceneSimilarity(k, m) >= strict);
    if (twin) dropped++; else kept.push(m);
  });
  return { kept, dropped };
}
/* Average interest of the window [s, s+len] of a video (0.5 when unknown). */
function windowScore(m, s, len) {
  const sc = m.scores; if (!sc) return 0.5;
  let sum = 0, n = 0;
  for (let i = 0; i < sc.values.length; i++) { const t = (i + 0.5) * sc.step; if (t >= s - 0.25 && t <= s + len + 0.25) { sum += sc.values[i]; n++; } }
  return n ? sum / n : 0.5;
}
/* Picks k non-overlapping windows of length len in a video, best interest first, spread out. */
function pickWindows(m, k, len) {
  const dur = m.duration;
  if (len >= dur - 0.05) return [[0, dur]];
  const margin = Math.min(dur * 0.04, 0.75);
  const lo = margin, hi = dur - margin;
  const cands = [];
  for (let st = lo; st + len <= hi + 1e-6; st += 0.25) cands.push({ s: st, base: windowScore(m, st, len) });
  if (!cands.length) cands.push({ s: 0, base: 0.5 });
  const chosen = [];
  const overlaps = (st) => chosen.some(w => st < w[1] + 0.5 && st + len > w[0] - 0.5);
  // Split the file into k zones and take the best window inside each zone, so every pick comes
  // from a different section of the recording (no two picks of the same scene).
  const zone = (hi - lo) / k;
  for (let z = 0; z < k; z++) {
    const z0 = lo + z * zone, z1 = lo + (z + 1) * zone;
    let best = null, bestV = -1;
    for (const c of cands) {
      if (c.s < z0 - 1e-6 || c.s + len > z1 + 1e-6) continue;
      if (overlaps(c.s)) continue;
      let v = c.base;
      const centre = (z0 + z1) / 2 - len / 2;
      v *= 1 - 0.15 * Math.min(1, Math.abs(c.s - centre) / Math.max(0.5, zone)); // mild preference for the zone middle
      if (c.s < 0.5) v *= 0.9;
      if (v > bestV) { bestV = v; best = c; }
    }
    if (!best) {
      // Zone too short for a full window: take the best non-overlapping window anywhere, farthest from the others.
      for (const c of cands) {
        if (overlaps(c.s)) continue;
        let v = c.base; chosen.forEach(w => { v *= Math.min(1, 0.4 + Math.abs(c.s - w[0]) / Math.max(1, dur)); });
        if (v > bestV) { bestV = v; best = c; }
      }
    }
    if (!best) break;
    chosen.push([best.s, best.s + len]);
  }
  chosen.sort((a, b) => a[0] - b[0]);
  return chosen;
}
/* Final safety net: no two clips from the same file may share footage. */
function dedupeClips(clips) {
  const byMedia = new Map();
  clips.forEach(c => { if (c.kind === 'video') { if (!byMedia.has(c.mediaId)) byMedia.set(c.mediaId, []); byMedia.get(c.mediaId).push(c); } });
  const drop = new Set();
  byMedia.forEach(list => {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], c = list[i];
      if (c.start < prev.end - 0.05) {
        const m = state.media.get(c.mediaId);
        const len = c.end - c.start;
        if (m && prev.end + 0.25 + len <= m.duration) { c.start = prev.end + 0.25; c.end = c.start + len; }
        else drop.add(c.id);
      }
    }
  });
  return clips.filter(c => !drop.has(c.id));
}

/* Picks n items spread evenly across a list (keeps order). */
function pickEvenly(arr, n) {
  if (n >= arr.length) return arr.slice();
  if (n <= 0) return [];
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.min(arr.length - 1, Math.floor((i + 0.5) * arr.length / n))]);
  return out;
}
/* Builds a fresh clip list from the media bin so that the whole video lasts ~target seconds.
   The number of clips is capped by the target and the minimum clip length; files are chosen
   evenly across the bin, segments are spread evenly inside each video, photos are interleaved. */
function planEdit(target) {
  const pace = PACE[P().pace] || PACE.medium;
  let videos = [], images = [];
  state.media.forEach(m => (m.kind === 'video' ? videos : images).push(m));
  // Hard uniqueness: one file per piece of content / scene, even if the video ends up shorter.
  const uv = uniqueMedia(videos, 0.85), ui = uniqueMedia(images, 0.85);
  videos = uv.kept; images = ui.kept;
  planEdit.lastDropped = uv.dropped + ui.dropped;
  if (!videos.length && !images.length) return [];
  // Clip count follows the pace (longer, fewer clips); the 2.5s minimum only bounds it.
  const maxClips = clamp(Math.round(target / pace), 1, Math.max(1, Math.floor(target / AUTO_MIN_CLIP)));
  // Photos take at most a third of the slots (all of them when there is no video).
  const imgSlots = videos.length ? Math.min(images.length, Math.floor(maxClips / 3)) : Math.min(images.length, maxClips);
  if (images.length > imgSlots) {
    // Spread the photo picks across the bin while avoiding look-alikes.
    const chosenI = [];
    const pool = images.slice();
    while (chosenI.length < imgSlots && pool.length) {
      let bi = 0, bv = -1;
      pool.forEach((m, idx) => { const sim = chosenI.reduce((mx, c) => Math.max(mx, sceneSimilarity(m, c)), 0); const v = (1 - 0.9 * sim) + 0.001 * (idx % 7); if (v > bv) { bv = v; bi = idx; } });
      chosenI.push(pool.splice(bi, 1)[0]);
    }
    const order = new Map(images.map((m, i) => [m.id, i]));
    images = chosenI.sort((a, b) => order.get(a.id) - order.get(b.id));
  }
  let imgDur = clamp(pace, 2, 4);
  if (images.length && images.length * imgDur > target * 0.4) imgDur = Math.max(2, target * 0.4 / images.length);
  const videoBudget = Math.max(0, target - images.length * imgDur);
  const videoSlots = Math.max(0, maxClips - images.length);
  if (videos.length > videoSlots) {
    // More files than slots: keep the files whose best moment scores highest, in original order.
    const probeLen = Math.max(AUTO_MIN_CLIP, Math.min(pace, 6));
    const ranked = videos.map((m, i) => ({ m, i, v: m.scores ? Math.max(...pickWindows(m, 1, Math.min(probeLen, m.duration)).map(w => windowScore(m, w[0], w[1] - w[0]))) : 0.5 + (i % 2) * 0.01 }));
    const anyScores = videos.some(m => m.scores);
    let keep;
    if (anyScores) {
      // Greedy: best moment first, then penalise files that look like an already chosen one.
      const chosen = [];
      const pool = ranked.slice();
      while (chosen.length < videoSlots && pool.length) {
        let bi = -1, bv = -1;
        pool.forEach((r, idx) => {
          const sim = chosen.reduce((mx, c) => Math.max(mx, sceneSimilarity(r.m, c.m)), 0);
          if (sim >= 0.7) return;                      // same scene as one already chosen: skip
          const v = r.v * (1 - 0.7 * sim); if (v > bv) { bv = v; bi = idx; }
        });
        if (bi < 0) break;                              // only look-alikes left: leave slots empty
        chosen.push(pool.splice(bi, 1)[0]);
      }
      keep = chosen.sort((a, b) => a.i - b.i).map(r => r.m);
    } else keep = pickEvenly(videos, videoSlots);
    videos = keep;
  }
  const totalSrc = videos.reduce((a, m) => a + m.duration, 0);
  const videoClips = [];
  if (videos.length && videoSlots > 0) {
    if (totalSrc <= videoBudget * 1.02) {
      // Less footage than the target: use everything, cut into pace-sized pieces for rhythm.
      videos.forEach(m => {
        const k = Math.max(1, Math.round(m.duration / pace));
        const seg = m.duration / k;
        for (let j = 0; j < k; j++) { const c = defaultClip(m); c.start = j * seg; c.end = Math.min(m.duration, (j + 1) * seg); videoClips.push(c); }
      });
    } else {
      // One segment per file first, then hand out the remaining slots to the longest files.
      const ks = videos.map(() => 1);
      let extra = videoSlots - videos.length;
      const want = videos.map(m => Math.max(1, Math.round(videoBudget * m.duration / totalSrc / pace)));
      while (extra > 0) {
        let best = -1, bestGap = 0;
        videos.forEach((m, i) => { const gap = (want[i] - ks[i]) * m.duration; if (gap > bestGap && ks[i] < Math.floor(m.duration / AUTO_MIN_CLIP)) { bestGap = gap; best = i; } });
        if (best < 0) break;
        ks[best]++; extra--;
      }
      const totalK = ks.reduce((a, b) => a + b, 0);
      videos.forEach((m, i) => {
        const k = ks[i];
        const share = videoBudget * k / totalK;
        // Windows must fit side by side without overlap; shorten them if the file is too short for k of them.
        let segLen = clamp(share / k, Math.min(AUTO_MIN_CLIP, m.duration), m.duration);
        segLen = Math.min(segLen, Math.max(AUTO_MIN_CLIP, (m.duration - 0.5 * (k - 1)) / k));
        pickWindows(m, k, segLen).forEach(([a, b]) => { const c = defaultClip(m); c.start = a; c.end = b; videoClips.push(c); });
      });
    }
  }
  const imageClips = images.map(m => { const c = defaultClip(m); c.imageDuration = imgDur; c.kenBurns = true; return c; });
  const uniqueVideoClips = dedupeClips(videoClips);
  // Interleave photos evenly between video clips.
  const out = [];
  if (!uniqueVideoClips.length) return imageClips;
  videoClips.length = 0; videoClips.push(...uniqueVideoClips);
  const every = (videoClips.length + 1) / (imageClips.length + 1);
  let nextImg = every, ii = 0;
  videoClips.forEach((c, i) => {
    out.push(c);
    while (ii < imageClips.length && i + 1 >= nextImg) { out.push(imageClips[ii++]); nextImg += every; }
  });
  while (ii < imageClips.length) out.push(imageClips[ii++]);
  return out;
}
/* Latest source time a clip may extend to without running into another clip cut from the same file. */
function maxEndFor(c) {
  const m = state.media.get(c.mediaId);
  if (!m) return c.end;
  let lim = m.duration;
  P().clips.forEach(o => { if (o !== c && o.mediaId === c.mediaId && o.start >= c.end - 0.01 && o.start < lim) lim = o.start; });
  return lim;
}
/* Scales every clip so the video lasts ~target seconds (bounded by the available footage). */
function fitToLength(target, { silent = false } = {}) {
  const total = totalDuration();
  if (!total || !P().clips.length) return;
  const f = target / total;
  P().clips.forEach(c => {
    const m = state.media.get(c.mediaId);
    if (c.kind === 'image') c.imageDuration = clamp(c.imageDuration * f, 2, 6);
    else if (m) {
      const maxDur = (maxEndFor(c) - c.start) / c.speed;   // never beyond the clip's own footage
      const want = Math.max(Math.min(AUTO_MIN_CLIP, maxDur), clipDuration(c) * f);
      c.end = c.start + Math.min(want, maxDur) * c.speed;
    }
    c.transition.duration = Math.min(c.transition.duration, Math.max(0.2, clipDuration(c) / 2));
  });
  state.snapCache.clear();
  if (!silent) { renderAll(); save(); toast(`Video is now ${fmt(totalDuration())}`); }
}

/* ---------- Theme / auto create / beat sync ---------- */
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
  const target = targetSeconds();
  await ensureAnalyzed();
  P().clips = planEdit(target);
  applyTheme({ retrim: false });
  const effTarget = Math.min(target, totalDuration());   // cannot be longer than the footage
  if (P().music && P().music.beats && P().music.beats.length) beatSync({ silent: true, noUndo: true, target: effTarget });
  else fitToLength(effTarget, { silent: true });
  state.selectedId = P().clips[0] ? P().clips[0].id : null;
  // Park just after the opening fade so the preview shows a real frame.
  state.playhead = P().clips[0] ? Math.min(P().clips[0].transition.duration, clipDuration(P().clips[0]) / 2) : 0;
  renderAll(); save();
  if (phoneLayout.matches) $('.tab[data-tab="clip"]').click();
  const got = totalDuration();
  const short = got < target * 0.9 ? ` (only ${fmt(got)} of unique footage for a ${fmtLen(target)} target)` : '';
  const uniq = `${P().clips.length} clips from ${new Set(P().clips.map(c => c.mediaId)).size} files`;
  const skipped = planEdit.lastDropped ? ` · ${planEdit.lastDropped} duplicate/same-scene file${planEdit.lastDropped > 1 ? 's' : ''} skipped` : '';
  toast(`Auto-created a ${THEMES[P().theme].name} edit · ${fmt(got)} · ${uniq}${skipped}${short}${P().music ? ` · ♫ ${P().music.name.replace(/\.mp3$/, '')}` : ''}`, 5000);
}
function beatSync({ silent = false, noUndo = false, target = null } = {}) {
  const mus = P().music;
  if (!mus || !mus.beats || !mus.beats.length) { toast('Add a music track first'); return; }
  if (!P().clips.length) { toast('Add some clips first'); return; }
  if (!noUndo) pushUndo();
  const pace = PACE[P().pace] || PACE.medium;
  // Beats repeat when the music loops, so cuts can be aligned beyond the track length.
  const span = Math.max(1, mus.duration - (mus.offset || 0));
  const base = mus.beats.map(b => b - mus.offset).filter(b => b > 0.3);
  const beats = [];
  const needed = target || totalDuration();
  for (let k = 0; k * span < needed + span && k < 50; k++) base.forEach(b => beats.push(b + k * span));
  const scale = target ? target / Math.max(0.1, totalDuration()) : 1;
  let t = 0;
  P().clips.forEach(c => {
    const m = state.media.get(c.mediaId);
    const avail = c.kind === 'image' ? 15 : (m ? (maxEndFor(c) - c.start) / c.speed : 0);
    const minLen = Math.min(AUTO_MIN_CLIP, Math.max(0.3, avail));
    const want = Math.max(minLen, target ? clipDuration(c) * scale : pace);
    const desired = t + want;
    let best = null, bestD = Infinity;
    for (const b of beats) {
      if (b < t + Math.max(minLen, want * 0.5)) continue;
      const d = Math.abs(b - desired);
      if (d < bestD) { bestD = d; best = b; }
      if (b > desired + want) break;
    }
    let dur = best !== null ? best - t : want;
    if (c.kind === 'image') c.imageDuration = clamp(dur, 2, 6);
    else if (m) {
      const maxDur = (maxEndFor(c) - c.start) / c.speed;
      dur = Math.min(dur, maxDur);
      if (dur < minLen) dur = Math.min(maxDur, Math.max(want, minLen));
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
  state.musicBlob = file;
  audioBufferCache.clear(); musicBuffer = null; musicBufferKey = null;
  prepareMusicBuffer();
  ensureAudioIfReady();
  renderAll(); save();
  if (!opts.silent) toast(`Music added · ${analysis.beats.length} beats${analysis.bpm ? ` · ~${analysis.bpm} BPM` : ''}`);
}
function ensureAudioIfReady() { if (actx) connectAudioEl(musicEl); }
async function restoreMusic(mus) {
  const blob = await DB.getFile(mus.fileId);
  if (!blob) { P().music = null; return; }
  state.musicBlob = blob;
  musicEl.src = URL.createObjectURL(blob);
  prepareMusicBuffer();
}
function removeMusic() {
  if (!P().music) return;
  pushUndo();
  DB.deleteFile(P().music.fileId);
  P().music = null; state.musicBlob = null; musicBuffer = null; musicBufferKey = null;
  stopMusicNode(); musicEl.pause(); musicEl.removeAttribute('src');
  renderAll(); save();
}

/* ======================================================================
   Offline export: frame-accurate render with WebCodecs, muxed to MP4.
   Falls back to the real-time MediaRecorder path when unavailable.
   ====================================================================== */
const HAS_WEBCODECS = typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof Mp4Muxer !== 'undefined';
const audioBufferCache = new Map();   // key -> AudioBuffer | null
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let offline = null;                   // { cancelled }

async function pickVideoCodec(w, h, fps, bitrate) {
  const cands = [
    { codec: 'avc1.640028', mux: 'avc' }, { codec: 'avc1.4d0028', mux: 'avc' }, { codec: 'avc1.42e028', mux: 'avc' },
    { codec: 'avc1.640032', mux: 'avc' }, { codec: 'avc1.42001f', mux: 'avc' },
    { codec: 'hvc1.1.6.L123.B0', mux: 'hevc' },
    { codec: 'vp09.00.40.08', mux: 'vp9' }
  ];
  for (const c of cands) {
    const cfg = { codec: c.codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality' };
    if (c.mux === 'avc') cfg.avc = { format: 'avc' };
    if (c.mux === 'hevc') cfg.hevc = { format: 'hevc' };
    try { const r = await VideoEncoder.isConfigSupported(cfg); if (r && r.supported) return { ...c, cfg }; } catch (e) {}
  }
  return null;
}
async function pickAudioCodec(sampleRate) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
  for (const c of [{ codec: 'mp4a.40.2', mux: 'aac' }, { codec: 'opus', mux: 'opus' }]) {
    const cfg = { codec: c.codec, sampleRate, numberOfChannels: 2, bitrate: 160000 };
    try { const r = await AudioEncoder.isConfigSupported(cfg); if (r && r.supported) return { ...c, cfg }; } catch (e) {}
  }
  return null;
}
/* ---------- Audio sources for export ----------
   1. decodeAudioData (fast; Chrome/Firefox, and audio-only files in Safari)
   2. mediabunny demux + WebCodecs AudioDecoder (Safari with .mov/.mp4 video files)
   3. real-time capture through Web Audio while the clip plays silently (works everywhere) */
const MB = () => window.Mediabunny || null;
const audioFallback = { decode: false, encode: false };   // test hooks: force the fallback paths
async function decodeViaWebAudio(blob) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const dctx = new OAC(2, 1, 48000);
  const ab = await blob.arrayBuffer();
  return await new Promise((res, rej) => { const p = dctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
}
/* Returns { buffer } or { none: true } when the file has no audio track, or null when it could not decode. */
async function decodeViaMediabunny(blob) {
  const mb = MB(); if (!mb) return null;
  let input = null;
  try {
    input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) return { none: true };
    if (!(await track.canDecode())) { exportDiag.push(`mediabunny: ${track.codec || 'unknown'} track cannot be decoded here (AudioDecoder ${typeof AudioDecoder !== 'undefined' ? 'present' : 'missing'})`); return null; }
    const sink = new mb.AudioBufferSink(track);
    const parts = []; let end = 0, sr = 48000, ch = 2;
    for await (const w of sink.buffers()) { parts.push(w); end = Math.max(end, w.timestamp + w.duration); sr = w.buffer.sampleRate; ch = w.buffer.numberOfChannels; }
    if (!parts.length) return { none: true };
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const out = new OAC(ch, 1, sr).createBuffer(ch, Math.ceil(end * sr) + 1, sr);
    for (const w of parts) {
      const off = Math.round(w.timestamp * sr);
      for (let c = 0; c < ch; c++) out.getChannelData(c).set(w.buffer.getChannelData(Math.min(c, w.buffer.numberOfChannels - 1)).subarray(0, Math.max(0, out.length - off)), off);
    }
    return { buffer: out };
  } catch (e) { exportDiag.push(`mediabunny decode failed: ${e && e.message}`); return null; }
  finally { try { input && input.dispose && input.dispose(); } catch (e) {} }
}
async function getAudioBuffer(key, blob) {
  if (audioBufferCache.has(key)) return audioBufferCache.get(key);
  if (audioFallback.capture && !key.startsWith('music')) return null;   // test hook: force live capture
  let buf = null, info = 'decoded';
  let why = '';
  if (!audioFallback.decode) { try { buf = await decodeViaWebAudio(blob); } catch (e) { buf = null; why = `decodeAudioData: ${e && e.message || e}`; } }
  if (!buf) {
    const r = await decodeViaMediabunny(blob);
    if (r && r.buffer) { buf = r.buffer; info = 'decoded (mediabunny)'; }
    else if (r && r.none) { info = 'no audio track'; audioBufferCache.set(key, null); audioNoTrack.add(key); return null; }
    else { info = 'undecodable'; exportDiag.push(`${key.startsWith('music') ? 'music' : 'clip'} undecodable (${why || 'mediabunny: ' + (MB() ? (typeof AudioDecoder === 'undefined' ? 'no AudioDecoder' : 'cannot decode') : 'not loaded')}) → live capture`); }
  }
  console.info('audio', key, info);
  audioBufferCache.set(key, buf);
  return buf;
}
const audioNoTrack = new Set();
let capSrc = null;
function bufferPeak(buf) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i += 7) { const v = Math.abs(d[i]); if (v > peak) peak = v; } }
  return peak;
}
/* Plays [start,end] of a clip's file silently through the audio graph and records the PCM.
   Captures at 2x first; if that comes back silent (some players mute fast rates) it retries at 1x. */
async function captureElementAudio(m, start, end, speed, onProgress) {
  return withScratch(() => captureElementAudioInner(m, start, end, speed, onProgress));
}
async function captureElementAudioInner(m, start, end, speed, onProgress) {
  const fast = await captureElementAudioAt(m, start, end, speed, 2, onProgress);
  if (fast && bufferPeak(fast) > 1e-4) return { buffer: fast, rate: 2 };
  exportDiag.push(`2x capture of ${m.name} was silent; retrying at 1x`);
  const slow = await captureElementAudioAt(m, start, end, speed, 1, onProgress);
  if (slow && bufferPeak(slow) > 1e-4) return { buffer: slow, rate: 1 };
  if (slow) exportDiag.push(`capture of ${m.name} is silent (play allowed: ${!scratch.el.paused || scratch.el.currentTime > start + 0.1}, ctx: ${actx ? actx.state : 'none'})`);
  return slow ? { buffer: slow, rate: 1 } : null;
}
async function captureElementAudioAt(m, start, end, speed, CAP_RATE, onProgress) {
  ensureAudio();
  if (!actx || typeof actx.createScriptProcessor !== 'function') return null;
  await bind(scratch, m);
  const el = scratch.el;
  if (!capSrc) { try { capSrc = actx.createMediaElementSource(el); } catch (e) { return null; } }
  const proc = actx.createScriptProcessor(4096, 2, 2);
  const mute = actx.createGain(); mute.gain.value = 0;
  capSrc.connect(proc); proc.connect(mute); mute.connect(actx.destination);
  const L = [], R = []; let collecting = false;
  proc.onaudioprocess = (e) => {
    if (!collecting) return;
    const ib = e.inputBuffer;
    L.push(new Float32Array(ib.getChannelData(0)));
    R.push(new Float32Array(ib.getChannelData(Math.min(1, ib.numberOfChannels - 1))));
  };
  const expected = Math.max(0.05, (end - start) / Math.max(0.0625, speed * CAP_RATE));
  el.muted = false;
  try { el.preservesPitch = CAP_RATE === 1; } catch (e) {}
  el.playbackRate = clamp(speed * CAP_RATE, 0.0625, 16);
  await seekTo(el, start);
  await new Promise((res) => {
    let finished = false;
    const done = () => { if (finished) return; finished = true; collecting = false; el.pause(); clearInterval(iv); clearTimeout(guard); res(); };
    const iv = setInterval(() => { if (el.currentTime >= end - 0.03 || el.ended) done(); else if (onProgress) onProgress(clamp((el.currentTime - start) / Math.max(0.01, end - start), 0, 1)); }, 20);
    const guard = setTimeout(done, (expected + 4) * 1000);
    el.addEventListener('playing', () => { collecting = true; }, { once: true });
    el.play().catch(() => done());
  });
  el.muted = true;
  try { el.preservesPitch = true; } catch (e) {}
  try { capSrc.disconnect(proc); proc.disconnect(); mute.disconnect(); } catch (e) {}
  const n = L.reduce((a, c) => a + c.length, 0);
  if (!n) return null;
  const sr = actx.sampleRate;
  const len = Math.min(n, Math.round(expected * sr));
  const buf = actx.createBuffer(2, Math.max(1, len), sr);
  let pos = 0;
  for (let i = 0; i < L.length && pos < len; i++) {
    const take = Math.min(L[i].length, len - pos);
    buf.getChannelData(0).set(L[i].subarray(0, take), pos);
    buf.getChannelData(1).set(R[i].subarray(0, take), pos);
    pos += take;
  }
  return buf;
}
/* Mixes clip audio and music exactly like the preview, but offline and sample-accurate.
   Returns { buffer, notes } (buffer null when there is no audio at all). */
async function renderAudioOffline(total, onStatus, sr = 48000) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC || total <= 0) return { buffer: null, notes: ['no offline audio support'] };
  const octx = new OAC(2, Math.ceil(total * sr), sr);
  let any = false; const notes = []; let captured = 0, decoded = 0;
  const items = layout();
  for (let i = 0; i < items.length; i++) {
    const { clip, offset } = items[i];
    if (clip.kind !== 'video' || clip.volume <= 0) continue;
    const m = state.media.get(clip.mediaId); if (!m) continue;
    if (onStatus) onStatus(`Preparing audio ${i + 1}/${items.length}…`);
    const d = clipDuration(clip), v = effectiveClipVolume(clip);
    let buf = await getAudioBuffer(m.id, m.blob);
    let src, capRate = 1;
    if (buf) {
      src = octx.createBufferSource(); src.buffer = buf; src.playbackRate.value = clip.speed;
      decoded++;
    } else if (!audioNoTrack.has(m.id)) {
      // Could not decode the file: capture this segment live (takes as long as the segment).
      const cap = await captureElementAudio(m, clip.start, clip.end, clip.speed, (p) => onStatus && onStatus(`Capturing audio ${i + 1}/${items.length} · ${Math.round(p * 100)}%`));
      if (!cap) continue;
      src = octx.createBufferSource(); src.buffer = cap.buffer; src.playbackRate.value = 1 / cap.rate;   // undo the fast capture
      capRate = cap.rate;
      captured++;
    } else continue;
    const g = octx.createGain();
    const edge = Math.min(0.03, d / 4);
    g.gain.setValueAtTime(0, offset); g.gain.linearRampToValueAtTime(v, offset + edge);
    g.gain.setValueAtTime(v, offset + d - edge); g.gain.linearRampToValueAtTime(0, offset + d);
    src.connect(g).connect(octx.destination);
    if (buf) src.start(offset, Math.min(clip.start, Math.max(0, buf.duration - 0.01)), Math.max(0.01, clip.end - clip.start));
    else src.start(offset, 0, d / capRate);
    any = true;
  }
  const mus = P().music;
  if (mus && state.musicBlob) {
    if (onStatus) onStatus('Preparing music…');
    const buf = await getAudioBuffer('music:' + mus.fileId, state.musicBlob);
    if (buf) {
      const src = octx.createBufferSource(); src.buffer = buf; src.loop = !!mus.loop;
      const g = octx.createGain(); const v = clamp(mus.volume, 0, 1);
      const fi = Math.max(0.01, mus.fadeIn || 0), foStart = Math.max(fi, total - (mus.fadeOut || 0));
      g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(v, fi);
      g.gain.setValueAtTime(v, foStart); g.gain.linearRampToValueAtTime(0, total);
      src.connect(g).connect(octx.destination);
      src.start(0, Math.min(mus.offset || 0, Math.max(0, buf.duration - 0.01)));
      src.stop(total);
      any = true; notes.push('music');
    } else notes.push('music could not be decoded');
  }
  if (decoded) notes.push(`${decoded} clip${decoded > 1 ? 's' : ''} decoded`);
  if (captured) notes.push(`${captured} clip${captured > 1 ? 's' : ''} captured live`);
  if (!any) return { buffer: null, notes: notes.length ? notes : ['no audio in the clips'] };
  if (onStatus) onStatus('Mixing audio…');
  const rendered = await octx.startRendering();
  const peak = bufferPeak(rendered);
  notes.push(`mix peak ${peak.toFixed(3)}`);
  if (peak < 1e-4) exportDiag.push('the audio mix is silent');
  return { buffer: rendered, notes };
}
/* AudioSpecificConfig for AAC-LC (what an MP4 esds box must carry). */
function aacLcConfig(sampleRate, channels) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const idx = Math.max(0, rates.indexOf(sampleRate));
  const bits = (2 << 11) | (idx << 7) | (channels << 3);   // objectType(5) | freqIndex(4) | channelConfig(4) | 000
  return new Uint8Array([bits >> 8, bits & 0xff]);
}
/* Some encoders (Safari's) hand back a full ESDS "magic cookie" instead of the bare AudioSpecificConfig.
   Returns a valid 2-byte AAC-LC config for the muxer, extracting it from the cookie when possible. */
function normalizeAacDescription(desc, sampleRate, channels) {
  const want = aacLcConfig(sampleRate, channels);
  if (!desc) { exportDiag.push('AAC config missing; synthesized'); return want; }
  const u8 = ArrayBuffer.isView(desc) ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength) : new Uint8Array(desc);
  const looksLikeAsc = (b) => b.length >= 2 && b.length <= 5 && [1, 2, 3, 4].includes(b[0] >> 3) && ((b[0] & 7) << 1 | (b[1] >> 7)) <= 12;
  if (looksLikeAsc(u8)) {
    if (u8[0] !== want[0] || (u8[1] & 0xf8) !== (want[1] & 0xf8)) exportDiag.push(`AAC config from encoder (${Array.from(u8).map(x => x.toString(16).padStart(2, '0')).join(' ')}) differs from the mix (${sampleRate} Hz, ${channels} ch); using the mix values`);
    return want;
  }
  // Walk MPEG-4 descriptors looking for DecoderSpecificInfo (tag 5).
  for (let i = 0; i < u8.length - 2; i++) {
    if (u8[i] === 0x05) {
      let j = i + 1, size = 0, k = 0;
      while (j < u8.length && k < 4) { const b = u8[j++]; size = (size << 7) | (b & 0x7f); k++; if (!(b & 0x80)) break; }
      const cand = u8.subarray(j, j + size);
      if (looksLikeAsc(cand)) { exportDiag.push(`AAC config extracted from encoder cookie (${Array.from(cand).map(x => x.toString(16).padStart(2, '0')).join(' ')}); muxing with mix values (${sampleRate} Hz)`); return want; }
    }
  }
  exportDiag.push(`AAC config from encoder not understood (${u8.length} bytes); synthesized`);
  return want;
}
/* Encodes the mix without WebCodecs: records it with MediaRecorder in real time, then pulls the
   compressed packets back out with mediabunny so they can be muxed next to the video. */
async function encodeMixWithRecorder(audioBuf, onStatus) {
  const mb = MB();
  if (!mb || !window.MediaRecorder) return null;
  ensureAudio(); if (!actx) return null;
  const mimes = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  const mime = mimes.find(x => { try { return MediaRecorder.isTypeSupported(x); } catch (e) { return false; } });
  if (!mime) return null;
  const dest = actx.createMediaStreamDestination();
  const src = actx.createBufferSource(); src.buffer = audioBuf; src.connect(dest);
  const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 160000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  const t0 = performance.now();
  rec.start();
  await sleep(60);
  src.start();
  await new Promise(r => {
    src.onended = r;
    const iv = setInterval(() => { if (onStatus) onStatus(`Encoding audio (recorder) · ${fmt(Math.min(audioBuf.duration, (performance.now() - t0) / 1000))} / ${fmt(audioBuf.duration)}`); if (offline && offline.cancelled) { clearInterval(iv); r(); } }, 250);
    src.onended = () => { clearInterval(iv); r(); };
  });
  await sleep(200);
  rec.stop(); await stopped;
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const codec = track.codec === 'aac' ? 'aac' : track.codec === 'opus' ? 'opus' : null;
    if (!codec) return null;
    const decoderConfig = await track.getDecoderConfig();
    const packets = [];
    const sink = new mb.EncodedPacketSink(track);
    for await (const pk of sink.packets()) packets.push({ data: pk.data, type: pk.type, timestamp: pk.timestamp, duration: pk.duration });
    return { codec, decoderConfig, packets, sampleRate: track.sampleRate || decoderConfig.sampleRate, channels: track.numberOfChannels || decoderConfig.numberOfChannels };
  } finally { try { input.dispose && input.dispose(); } catch (e) {} }
}
async function encodeAudio(buffer, enc) {
  const sr = buffer.sampleRate, ch = buffer.numberOfChannels, total = buffer.length, step = sr;
  for (let pos = 0; pos < total; pos += step) {
    if (offline && offline.cancelled) return;
    const n = Math.min(step, total - pos);
    const data = new Float32Array(n * 2);
    for (let c = 0; c < 2; c++) data.set(buffer.getChannelData(Math.min(c, ch - 1)).subarray(pos, pos + n), c * n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(pos / sr * 1e6), data });
    enc.encode(ad); ad.close();
    while (enc.encodeQueueSize > 8) await sleep(5);
  }
  await enc.flush();
}
/* ---------- Fast frame source: hardware decoding through mediabunny (no per-frame seeking) ---------- */
const frameSources = new Map();   // mediaId -> source | null
async function getFrameSource(m) {
  if (frameSources.has(m.id)) return frameSources.get(m.id);
  let src = null;
  const mb = MB();
  if (mb && !exportDiag.noFastFrames) {
    let input = null;
    try {
      input = new mb.Input({ source: new mb.BlobSource(m.blob), formats: mb.ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (track && await track.canDecode()) {
        const scale = Math.min(1, Math.max(W, H) * 1.0 / Math.max(m.w, m.h));
        const sink = new mb.CanvasSink(track, { width: Math.max(2, Math.round(m.w * scale)), height: Math.max(2, Math.round(m.h * scale)), fit: 'fill', poolSize: 3 });
        exportDiag.push(`frames: hardware decoder for ${m.name}`);
        src = {
          input, sink, iter: null, cur: null, nxt: null, done: true, lastT: -1, yielded: 0,
          async restart(st) {
            if (this.iter) { try { await this.iter.return(); } catch (e) {} }
            this.iter = this.sink.canvases(Math.max(0, st)); this.cur = null; this.nxt = null; this.done = false; this.lastT = st;
          },
          async frameAt(st) {
            if (!this.iter || st < this.lastT - 0.001) await this.restart(st);
            this.lastT = st;
            while (!this.done && (this.nxt === null || this.nxt.timestamp <= st + 1e-4)) {
              if (this.nxt) this.cur = this.nxt;
              const r = await this.iter.next();
              if (r.done) { this.done = true; this.nxt = null; break; }
              this.nxt = r.value; this.yielded++;
              if (!this.cur) this.cur = this.nxt;
            }
            return this.cur ? this.cur.canvas : null;
          },
          async lastFrame(t) {
            let last = null;
            try { for await (const c of this.sink.canvases(Math.max(0, t - 0.5), t)) last = c; } catch (e) {}
            if (!last) { await this.restart(Math.max(0, t - 0.1)); return await this.frameAt(t); }
            return last.canvas;
          },
          close() { try { this.iter && this.iter.return(); } catch (e) {} try { input.dispose && input.dispose(); } catch (e) {} }
        };
      } else { exportDiag.push(`fast frames: ${track ? 'decoder unsupported' : 'no video track'} for ${m.name}`); try { input.dispose && input.dispose(); } catch (e) {} }
    } catch (e) { exportDiag.push(`fast frames failed: ${e && e.message}`); try { input && input.dispose && input.dispose(); } catch (x) {} src = null; }
  }
  frameSources.set(m.id, src);
  return src;
}
function closeFrameSources() { frameSources.forEach(s => { if (s) s.close(); }); frameSources.clear(); }
/* Final frame of a clip for transitions during export (never touches the scratch element,
   which may be busy capturing audio). */
async function renderClipLastFrameExport(clip, idx) {
  const m = state.media.get(clip.mediaId);
  if (!m) return null;
  const dur = clipDuration(clip);
  let el = m.el;
  if (clip.kind === 'video') {
    const fs = await getFrameSource(m);
    el = fs ? await fs.lastFrame(clip.end - 0.03) : null;
    if (!el) { const p = playerForIdx(idx); await bind(p, m); await seekTo(p.el, clip.end - 0.03); await waitFrame(p.el, 150); el = p.el; }
  }
  const saved = snapshotCanvas();
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  drawSource(clip, m, el, dur, dur);
  drawText(clip, dur, dur);
  const out = snapshotCanvas();
  ctx.drawImage(saved, 0, 0);
  return out;
}
async function renderFrameOffline(t, cs) {
  const loc = locate(t);
  if (!loc) { drawFrameNow(null); return; }
  if (cs.idx !== loc.idx) {
    if (loc.idx > 0 && loc.clip.transition.type !== 'none') {
      const prev = P().clips[loc.idx - 1];
      const have = state.snapCache.get(prev.id);
      if (!have || have.width !== W || have.height !== H) { const c = await renderClipLastFrameExport(prev, loc.idx - 1); if (c) state.snapCache.set(prev.id, c); }
    }
    cs.idx = loc.idx; cs.fresh = true;
  }
  const m = state.media.get(loc.clip.mediaId);
  let img = null;
  if (loc.clip.kind === 'video' && m) {
    const st = loc.clip.start + loc.lt * loc.clip.speed;
    const fs = await getFrameSource(m);
    if (fs) { if (cs.fresh) await fs.restart(st); img = await fs.frameAt(st); }
    if (!img) {
      const p = playerForIdx(loc.idx);
      await bind(p, m);
      await seekTo(p.el, st);
      await waitFrame(p.el, 150);
    }
  }
  cs.fresh = false;
  drawFrameNow(loc, img);
}
function setExportStatus(p, text) {
  $('#exportProgress').style.width = `${Math.round(p * 100)}%`;
  $('#exportStatus').textContent = text;
}
let exportMode = 'auto';   // 'auto' | 'offline' | 'live'
const exportDiag = [];
exportDiag.push = function (msg) { if (this.length < 12) Array.prototype.push.call(this, msg); console.info('[export]', msg); };
const QUALITY = { share: { res: 1280, fps: 30, bitrate: 4e6, label: '720p' }, high: { res: 1920, fps: 30, bitrate: 10e6, label: '1080p' }, max: { res: 1920, fps: 60, bitrate: 14e6, label: '1080p60' } };

function recorderTrack(r) {
  return { codec: r.codec, sampleRate: r.sampleRate, channels: r.channels, label: r.codec.toUpperCase() + ' (recorder)', source: 'recorder',
    add: (mx) => r.packets.forEach((pk, i) => mx.addAudioChunkRaw(pk.data, pk.type, Math.round(pk.timestamp * 1e6), Math.round(pk.duration * 1e6), i === 0 ? { decoderConfig: r.decoderConfig } : undefined)) };
}
/* @returns true when the file was produced (or cancelled), false to fall back to MediaRecorder. */
async function startOfflineExport(q) {
  if (!HAS_WEBCODECS) return false;
  const { res, fps, bitrate } = QUALITY[q] || QUALITY.share;
  pause();
  setCanvasSize(res);
  state.snapCache.clear();
  exportDiag.length = 0;
  const total = totalDuration();
  const frames = Math.max(1, Math.ceil(total * fps));
  const vcodec = await pickVideoCodec(W, H, fps, bitrate);
  if (!vcodec) { setCanvasSize(PREVIEW_LONG); return false; }
  offline = { cancelled: false };
  state.exportingOffline = true;
  keepAwake(true);
  $('#exportProgressWrap').hidden = false; $('#exportResult').hidden = true; $('#exportStartBtn').disabled = true;
  let venc = null, aenc = null, err = null;
  let audioStatus = 'Preparing audio…', videoStatus = '';
  const show = (p) => setExportStatus(p, [videoStatus, audioStatus].filter(Boolean).join('  ·  '));
  try {
    // ---- Audio pipeline runs in parallel with the video rendering.
    const audioPromise = (async () => {
      const mix = await renderAudioOffline(total, (txt) => { audioStatus = txt; });
      if (offline.cancelled || !mix.buffer) { audioStatus = mix.buffer ? '' : `no audio (${mix.notes.join(', ')})`; return { mix, track: null }; }
      const acodec = audioFallback.encode ? null : await pickAudioCodec(48000);
      if (acodec) {
        audioStatus = 'Encoding audio…';
        const chunks = [];
        aenc = new AudioEncoder({ output: (c, m) => chunks.push([c, m]), error: (e) => { err = e; } });
        aenc.configure(acodec.cfg);
        await encodeAudio(mix.buffer, aenc);
        aenc.close(); aenc = null;
        audioStatus = 'Audio ready';
        const sr = 48000, ch = 2;
        const add = (mx) => chunks.forEach(([c, m], i) => {
          let meta = m;
          if (acodec.mux === 'aac') {
            const desc = m && m.decoderConfig ? m.decoderConfig.description : null;
            meta = i === 0 ? { decoderConfig: { codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch, description: normalizeAacDescription(desc, sr, ch) } } : undefined;
          }
          mx.addAudioChunk(c, meta);
        });
        return { mix, track: { codec: acodec.mux, sampleRate: sr, channels: ch, label: acodec.mux.toUpperCase(), source: 'encoder', add } };
      }
      exportDiag.push('AudioEncoder unavailable; using the recorder');
      const r = await encodeMixWithRecorder(mix.buffer, (txt) => { audioStatus = txt; });
      if (r && r.packets.length) {
        audioStatus = 'Audio ready';
        return { mix, track: recorderTrack(r) };
      }
      mix.notes.push('audio could not be encoded in this browser');
      audioStatus = 'no audio (encoder unavailable)';
      return { mix, track: null };
    })().catch(e => { exportDiag.push(`audio failed: ${e && e.message}`); audioStatus = 'no audio (failed)'; return { mix: { notes: [String(e && e.message || e)] }, track: null }; });

    // ---- Video: decode + render + encode, chunks kept in memory until the audio is ready.
    const vchunks = [];
    venc = new VideoEncoder({ output: (c, m) => vchunks.push([c, m]), error: (e) => { err = e; } });
    venc.configure(vcodec.cfg);
    const t0 = performance.now();
    // Which frame strategy? Hardware decoding when every video file supports it; otherwise, on phones,
    // live render through the stage (the seek-the-player path returns stale frames on iOS).
    let useLive = exportMode === 'live';
    if (exportMode === 'auto') {
      const vids = []; state.media.forEach(m => { if (m.kind === 'video' && P().clips.some(c => c.mediaId === m.id)) vids.push(m); });
      let fastAll = true;
      for (const m of vids) { if (!(await getFrameSource(m))) { fastAll = false; break; } }
      if (!fastAll && IS_IOS) { useLive = true; exportDiag.push('live render: hardware decoding unavailable for some files'); }
    }
    const renderOffline = async () => {
      const cs = { idx: -1, fresh: true };
      let clipStartYield = 0, clipStartTime = 0, checked = false;
      for (let i = 0; i < frames; i++) {
        if (offline.cancelled) throw new Error('cancelled');
        if (err) throw err;
        const t = Math.min(i / fps, Math.max(0, total - 0.0005));
        const before = cs.idx;
        await renderFrameOffline(t, cs);
        // Starvation check on the first full video clip: too few decoded frames → switch to live render.
        if (exportMode === 'auto' && !checked && cs.idx !== before) {
          const prev = P().clips[before];
          const pm = prev && prev.kind === 'video' ? state.media.get(prev.mediaId) : null;
          const fs = pm ? frameSources.get(pm.id) : null;
          if (fs && before >= 0) {
            const srcDur = (prev.end - prev.start), got = fs.yielded - clipStartYield;
            if (srcDur > 1 && got < srcDur * 24 * 0.4) { exportDiag.push(`hardware decoder starved (${got} frames for ${srcDur.toFixed(1)}s) → live render`); throw new Error('switch-live'); }
            checked = true;
          }
          const nm = cs.idx >= 0 && P().clips[cs.idx] && P().clips[cs.idx].kind === 'video' ? state.media.get(P().clips[cs.idx].mediaId) : null;
          const nfs = nm ? frameSources.get(nm.id) : null;
          clipStartYield = nfs ? nfs.yielded : 0; clipStartTime = t;
        }
        const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
        frame.close();
        while (venc.encodeQueueSize > 4) await sleep(4);
        if (i % 5 === 0) {
          const el = (performance.now() - t0) / 1000, eta = el / (i + 1) * (frames - i - 1);
          videoStatus = `Video ${Math.round((i + 1) / frames * 100)}% · ${fmt(t)} / ${fmt(total)} · ~${Math.ceil(eta)}s left`;
          show(0.03 + 0.9 * i / frames);
        }
      }
    };
    const renderLiveMode = async () => {
      exportDiag.push('frames: live render through the player');
      const n = await renderLive(venc, fps, total, (p) => { videoStatus = `Video ${Math.round(p * 100)}% (live render) · ${fmt(p * total)} / ${fmt(total)}`; show(0.03 + 0.9 * p); });
      exportDiag.push(`live render produced ${n} frames`);
    };
    if (useLive) await renderLiveMode();
    else {
      try { await renderOffline(); }
      catch (e) {
        if (!(e && e.message === 'switch-live')) throw e;
        // Restart the video with a fresh encoder in live mode; audio keeps running in parallel.
        try { venc.close(); } catch (x) {}
        vchunks.length = 0;
        venc = new VideoEncoder({ output: (c, m) => vchunks.push([c, m]), error: (e2) => { err = e2; } });
        venc.configure(vcodec.cfg);
        await renderLiveMode();
      }
    }
    await venc.flush(); venc.close(); venc = null;
    videoStatus = 'Video ready';
    show(0.94);
    const { mix } = await audioPromise;
    let audioTrack = (await audioPromise).track;
    if (offline.cancelled) throw new Error('cancelled');
    // ---- Mux, then verify the audio really decodes; if not, re-encode with the recorder and mux again.
    const mux = (track) => {
      const target = new Mp4Muxer.ArrayBufferTarget();
      const muxer = new Mp4Muxer.Muxer({
        target,
        video: { codec: vcodec.mux, width: W, height: H, frameRate: fps },
        audio: track ? { codec: track.codec, sampleRate: track.sampleRate, numberOfChannels: track.channels } : undefined,
        fastStart: 'in-memory', firstTimestampBehavior: 'offset'
      });
      vchunks.forEach(([c, m]) => muxer.addVideoChunk(c, m));
      if (track) track.add(muxer);
      muxer.finalize();
      return new Blob([target.buffer], { type: 'video/mp4' });
    };
    setExportStatus(0.97, 'Writing file…');
    let blob = mux(audioTrack);
    if (audioTrack && audioTrack.source === 'encoder' && mix.buffer) {
      setExportStatus(0.98, 'Checking audio…');
      const check = await verifyExportAudio(blob);
      exportDiag.push(`first audio check: ${check.text}`);
      if (check.ok === false || (check.ok === null && /cannot decode/.test(check.text))) {
        audioStatus = 'Re-encoding audio with the recorder…';
        show(0.98);
        const r = await encodeMixWithRecorder(mix.buffer, (txt) => { audioStatus = txt; show(0.98); });
        if (offline.cancelled) throw new Error('cancelled');
        if (r && r.packets.length) { audioTrack = recorderTrack(r); blob = mux(audioTrack); exportDiag.push('audio re-encoded with the recorder'); }
      }
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    const vLabel = `${vcodec.mux === 'avc' ? 'H.264' : vcodec.mux.toUpperCase()} ${QUALITY[q] ? QUALITY[q].label : ''}`;
    const aLabel = audioTrack ? `${audioTrack.label} audio (${(mix.notes || []).join(', ')})` : `no audio (${(mix.notes || []).join(', ')})`;
    showExportResult(blob, 'mp4', `${vLabel} · ${aLabel} · ${secs}s` + (exportDiag.length ? ` · ${exportDiag.join('; ')}` : ''));
  } catch (e) {
    try { if (venc && venc.state !== 'closed') venc.close(); } catch (x) {}
    try { if (aenc && aenc.state !== 'closed') aenc.close(); } catch (x) {}
    if (!(offline && offline.cancelled)) {
      console.warn('offline export failed', e);
      toast(`High-quality export failed (${e && e.message ? e.message : e}); using the compatible recorder instead.`, 5000);
      finishOffline();
      return false;
    }
  }
  finishOffline();
  return true;
}
function finishOffline() {
  state.exportingOffline = false;
  if (liveExport) { const le = liveExport; liveExport = null; if (masterGain) masterGain.gain.value = 1; try { le.reject(new Error('cancelled')); } catch (e) {} }
  if (state.playing) pause();
  closeFrameSources();
  offline = null;
  keepAwake(false);
  setCanvasSize(PREVIEW_LONG);
  state.snapCache.clear();
  $('#exportStartBtn').disabled = false;
  setPlayhead(state.playhead);
}
/* Opens the finished file and checks that it carries an audible audio track. */
async function verifyExportAudio(blob) {
  const mb = MB();
  if (!mb) return { ok: null, text: 'Audio check unavailable (mediabunny not loaded)' };
  let input = null;
  try {
    input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) return { ok: false, text: 'No audio track in the file' };
    const dur = await input.computeDuration([track]).catch(() => 0);
    const base = `${(track.codec || '?').toUpperCase()} audio track, ${track.numberOfChannels}ch ${track.sampleRate} Hz, ${fmt(dur)}`;
    if (!(await track.canDecode())) return { ok: null, text: `${base}. This browser cannot decode it for checking.` };
    const sink = new mb.AudioBufferSink(track);
    let peak = 0, n = 0;
    for await (const w of sink.buffers(0, Math.min(dur || 6, 6))) { peak = Math.max(peak, bufferPeak(w.buffer)); if (++n > 400) break; }
    return peak > 1e-4 ? { ok: true, text: `${base}. Sound detected ✓` } : { ok: false, text: `${base}, but it is silent ✗` };
  } catch (e) { return { ok: null, text: `Audio check failed: ${e && e.message}` }; }
  finally { try { input && input.dispose && input.dispose(); } catch (e) {} }
}
function diagnosticsText() {
  const lines = [buildReport('')];
  lines.push('', '== Media bin ==');
  state.media.forEach(m => lines.push(`${m.kind} ${m.name} ${m.kind === 'video' ? fmt(m.duration) : ''} ${m.w}x${m.h} ${(m.blob && m.blob.size / 1e6).toFixed(1)}MB analysed:${!!(m.scores && m.scores.sig)}`));
  const dups = findDuplicateMedia(); if (dups.length) lines.push(`duplicate groups: ${dups.map(g => `${g.keep.name} x${g.dupes.length + 1}`).join(', ')}`);
  lines.push('', `== Timeline (${P().clips.length} clips, ${fmt(totalDuration())}, target ${P().targetLength}, theme ${P().theme}, pace ${P().pace}) ==`);
  layout().forEach(({ clip, offset, dur }) => lines.push(`${fmt(offset)} ${clip.kind} ${clip.name}${clip.kind === 'video' ? ` src ${clip.start.toFixed(2)}-${clip.end.toFixed(2)}` : ''} len ${dur.toFixed(2)} x${clip.speed} ${clip.filter.preset} ${clip.transition.type}`));
  const byFile = {}; P().clips.forEach(c => { byFile[c.name] = (byFile[c.name] || 0) + 1; });
  lines.push('', 'clips per file: ' + Object.entries(byFile).map(([k, v]) => `${k}:${v}`).join(', '));
  return lines.join('\n');
}
async function shareDiagnostics() {
  const txt = diagnosticsText();
  const file = new File([txt], `quik-web-diagnostics-${Date.now()}.txt`, { type: 'text/plain' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Quik Web diagnostics' }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(txt); toast('Diagnostics copied to the clipboard – paste them into the chat'); }
  catch (e) { downloadBlob(new Blob([txt], { type: 'text/plain' }), file.name); }
}
function buildReport(extra) {
  const lines = [
    `Quik Web ${new Date().toISOString()}`,
    navigator.userAgent,
    `WebCodecs: VideoEncoder ${typeof VideoEncoder !== 'undefined'}, AudioEncoder ${typeof AudioEncoder !== 'undefined'}, AudioDecoder ${typeof AudioDecoder !== 'undefined'}, mediabunny ${!!MB()}`,
    `AudioContext: ${actx ? actx.state + ' @' + actx.sampleRate : 'none'}`,
    `MediaRecorder audio/mp4: ${window.MediaRecorder && MediaRecorder.isTypeSupported('audio/mp4') ? 'yes' : 'no'}`,
    `Project: ${P().clips.length} clips, music ${P().music ? P().music.name : 'none'}, musicBlob ${!!state.musicBlob}`,
    extra || ''
  ].concat(exportDiag.map(d => '- ' + d));
  return lines.join('\n');
}
function showExportResult(blob, ext, codecLabel) {
  $('#exportAudioCheck').textContent = 'Checking audio…'; $('#exportAudioCheck').className = 'small-text audio-check';
  $('#exportReport').textContent = buildReport(`Result: ${codecLabel || ''}`);
  verifyExportAudio(blob).then(r => {
    const el = $('#exportAudioCheck');
    el.textContent = (r.ok === true ? '🔊 ' : r.ok === false ? '🔇 ' : 'ℹ️ ') + r.text;
    el.className = 'small-text audio-check' + (r.ok === false ? ' bad' : '');
    $('#exportReport').textContent = buildReport(`Result: ${codecLabel || ''}\nAudio check: ${r.text}`);
  });
  exportBlob = blob;
  exportName = `${(P().title.trim() || 'quik-video').replace(/[^\w\-]+/g, '_')}.${ext}`;
  $('#exportDialog').hidden = false;
  $('#exportProgressWrap').hidden = true;
  $('#exportResult').hidden = false;
  $('#exportResultText').textContent = `Done · ${exportName} · ${(blob.size / 1e6).toFixed(1)} MB · ${fmt(totalDuration())}${codecLabel ? ' · ' + codecLabel : ''}` +
    (ext === 'webm' && IS_IOS ? ' · This browser could only record WebM, which Photos cannot save; use “Download file” to keep it in Files.' : '');
  let canShare = false;
  try { canShare = !!(navigator.canShare && navigator.canShare({ files: [new File([blob], exportName, { type: blob.type })] })); } catch (e) {}
  $('#exportShareBtn').hidden = !canShare;
  $('#exportShareBtn').textContent = ext === 'mp4' ? 'Save to Photos / Share…' : 'Share…';
  $('#exportStartBtn').hidden = true;
  $('#exportCancelBtn').textContent = 'Close';
  if (!canShare && !IS_IOS) downloadBlob(blob, exportName);
  toast(`Exported ${exportName}`, 4000);
}

/* ======================================================================
   Export (real-time MediaRecorder fallback)
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
  if (state.exportingOffline) { $('#exportDialog').hidden = false; return; }
  pause();
  $('#exportHint').textContent = HAS_WEBCODECS
    ? 'The video is rendered frame by frame at full quality, with a clean audio mix. A 1‑minute video takes a minute or two. Keep the app open while it renders.'
    : 'This browser records the preview in real time, so a 1‑minute video takes about a minute. Keep this tab visible while it renders.';
  $('#exportProgressWrap').hidden = true;
  $('#exportResult').hidden = true;
  $('#exportStartBtn').hidden = false; $('#exportStartBtn').disabled = false;
  $('#exportCancelBtn').textContent = 'Cancel';
  $('#exportDialog').hidden = false;
}
function closeExport() {
  if (state.exportingOffline && offline) { offline.cancelled = true; toast('Export cancelled'); }
  if (state.exporting) cancelExport();
  $('#exportDialog').hidden = true;
}
// Export frames are drawn by requestAnimationFrame, which browsers pause for hidden tabs.
document.addEventListener('visibilitychange', () => { if (document.hidden && state.exporting) { cancelExport(); toast('Export stopped because the app went to the background. Keep it open while rendering.', 5000); } });
function unlockScratch() {
  let firstVideo = null; state.media.forEach(m => { if (!firstVideo && m.kind === 'video') firstVideo = m; });
  if (!firstVideo) return;
  if (!scratch.mediaId) bindSync(scratch, firstVideo);
  try { const p = scratch.el.play(); if (p && p.then) p.then(() => scratch.el.pause()).catch(() => {}); } catch (e) {}
}
async function startExport() {
  ensureAudio();          // must happen inside the tap on iOS, otherwise the audio graph stays suspended
  unlockScratch();
  unlockMedia();          // players too, in case the user never pressed play (live render needs them)
  const q = $('#exportQuality').value || 'share';
  const { res, fps } = QUALITY[q] || QUALITY.share;
  if (state.exportingOffline || state.exporting) return;
  if (HAS_WEBCODECS) {
    const done = await startOfflineExport(q);
    if (done) return;
  }
  startRecorderExport(res, fps);
}
function startRecorderExport(res, fps) {
  const mime = pickMime();
  if (!mime || !canvas.captureStream) { toast('This browser cannot record video. Try Chrome, Edge or Safari 16.4+.'); return; }
  ensureAudio();
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
      const blob = new Blob(recChunks, { type: exportMime.split(';')[0] });
      showExportResult(blob, exportMime.includes('mp4') ? 'mp4' : 'webm', 'recorded live');
    }
    recChunks = [];
  };
  state.exporting = true; state.exportCancelled = false;
  keepAwake(true);
  showStage(false);
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
  const dups = findDuplicateMedia().reduce((a, g) => a + g.dupes.length, 0);
  $('#dedupeBtn').hidden = !dups; if (dups) $('#dedupeBtn').textContent = `🧹 Remove ${dups} duplicate file${dups > 1 ? 's' : ''}`;
  $('#dropZone').style.display = state.media.size ? 'none' : '';
}

/* ======================================================================
   UI – timeline
   ====================================================================== */
let dragId = null;
const stripQueue = new Set();
let stripRunning = false;
/* Thumbnail for a clip: the filmstrip frame nearest to the clip's start (built lazily in the background). */
function clipThumb(clip, m) {
  if (clip.kind !== 'video' || !m.duration) return m.thumb;
  if (m.strip && m.strip.length > 1) return m.strip[clamp(Math.floor(((clip.start + clip.end) / 2) / m.duration * m.strip.length), 0, m.strip.length - 1)];
  if (!m.strip && !stripQueue.has(m.id)) { stripQueue.add(m.id); runStripQueue(); }
  return m.thumb;
}
async function runStripQueue() {
  if (stripRunning) return;
  stripRunning = true;
  while (stripQueue.size) {
    const id = stripQueue.values().next().value; stripQueue.delete(id);
    const m = state.media.get(id);
    if (!m || m.strip) continue;
    try { await buildStrip(m); if (!state.playing) renderTimeline(); } catch (e) {}
  }
  stripRunning = false;
}
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
    if (m) d.style.backgroundImage = `url(${clipThumb(clip, m)})`;
    d.draggable = true; d.dataset.id = clip.id;
    const badges = [];
    if (clip.speed !== 1) badges.push(`${clip.speed}×`);
    if (clip.filter.preset !== 'none') badges.push(FILTERS[clip.filter.preset].name);
    if (clip.text.content.trim()) badges.push('T');
    if (clip.volume === 0 && clip.kind === 'video') badges.push('🔇');
    d.innerHTML = (clip.transition.type !== 'none' ? '<div class="trans"></div>' : '') +
      `<div class="badges">${badges.map(b => `<span class="badge">${b}</span>`).join('')}</div>` +
      `<div class="label">${clip.name}${clip.kind === 'video' ? ` @${fmt(clip.start).replace(/^00:/, '')}` : ''} · ${fmt(dur)}</div>`;
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
  renderLengthControl();
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
function renderLengthControl() {
  const t = P().targetLength;
  setSeg('lengthSeg', 'len', t === 'music' ? 'music' : String(t));
  const sec = targetSeconds();
  $('#lengthSlider').value = clamp(sec, 10, 600);
  $('#lengthLabel').textContent = t === 'music' ? `♫ ${fmtLen(sec)}` : fmtLen(sec);
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
    [...players, scratch].forEach(unbind);
    state.media.forEach(m => { if (m.el && m.el.parentElement) m.el.parentElement.removeChild(m.el); URL.revokeObjectURL(m.url); });
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
  $('#dedupeBtn').addEventListener('click', () => { pause(); removeDuplicateMedia(); });
  $('#diagBtn').addEventListener('click', shareDiagnostics);
  $('#autoCreateBtn').addEventListener('click', async () => { pause(); autoCreate(); });
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
  stage.addEventListener('click', () => { if (P().clips.length) togglePlay(); });
  window.addEventListener('resize', () => { if (state.playing) sizeStage(); });
  document.addEventListener('fullscreenchange', () => setTimeout(() => { if (state.playing) sizeStage(); }, 50));

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
  $$('#lengthSeg button').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.len;
    if (v === 'music' && !P().music) { toast('Add a music track first to use its length'); return; }
    P().targetLength = v === 'music' ? 'music' : Number(v);
    renderLengthControl(); save();
  }));
  $('#lengthSlider').addEventListener('input', (e) => { P().targetLength = Number(e.target.value); renderLengthControl(); });
  $('#lengthSlider').addEventListener('change', () => save());
  $('#rearrangeBtn').addEventListener('click', () => { pause(); autoCreate(); });
  $('#fitLengthBtn').addEventListener('click', () => {
    if (!P().clips.length) { toast('Add clips first'); return; }
    pause(); pushUndo();
    const target = targetSeconds();
    fitToLength(target, { silent: true });
    if (P().music && P().music.beats && P().music.beats.length) beatSync({ silent: true, noUndo: true, target });
    renderAll(); save();
    toast(`Fitted to ${fmt(totalDuration())}`);
  });
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
  $('#copyReportBtn').addEventListener('click', async () => {
    const txt = $('#exportReport').textContent;
    try { await navigator.clipboard.writeText(txt); toast('Report copied'); }
    catch (e) { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Report copied'); } catch (x) { toast('Select the text and copy it manually'); } ta.remove(); }
  });
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
  if (findDuplicateMedia().length) await removeDuplicateMedia({ silent: true });
  queueAnalysis(Array.from(state.media.values()));
}
boot();

window.addEventListener('error', (e) => { if (e && e.message) toast(`Error: ${e.message}`, 6000); });
window.addEventListener('unhandledrejection', (e) => { const r = e && e.reason; toast(`Error: ${r && r.message ? r.message : r}`, 6000); });

/* Exposed for debugging / tests */
window.QuikWeb = { findDuplicateMedia, removeDuplicateMedia, diagnosticsText, ensureAnalyzed, pickWindows, dedupeClips, uniqueMedia, sceneSimilarity, HAS_WEBCODECS, startOfflineExport, audioFallback, setExportMode: (m) => { exportMode = m; }, audioBufferCache, normalizeAacDescription, aacLcConfig, players, scratch, planEdit, fitToLength, targetSeconds, state, importFiles, addToTimeline, autoCreate, applyTheme, beatSync, play, pause, setPlayhead, renderAt, totalDuration, layout, setMusic, splitAtPlayhead, startExport, pickMime, useLibraryTrack, loadLibrary };
})();
