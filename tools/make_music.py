#!/usr/bin/env python3
"""Renders the built-in music library (music/*.mp3 + music/library.json).

Everything is synthesised here from scratch (numpy only), so the tracks are original
works with no third-party licence attached. Re-run to regenerate:  python3 tools/make_music.py
Requires numpy and ffmpeg (with libmp3lame) on the PATH.
"""
import json, math, os, subprocess, sys, wave
import numpy as np

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'music')
MAJOR = [0, 2, 4, 5, 7, 9, 11]
MINOR = [0, 2, 3, 5, 7, 8, 10]
DORIAN = [0, 2, 3, 5, 7, 9, 10]
SCALES = {'major': MAJOR, 'minor': MINOR, 'dorian': DORIAN}

# ---------------------------------------------------------------- DSP helpers
def midi_hz(m): return 440.0 * 2 ** ((m - 69) / 12)

def env(n, a, d, s, r, hold=None):
    """ADSR over n samples (seconds for a/d/r). hold = seconds of note before release starts."""
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    if hold is None: hold_n = max(0, n - r_n)
    else: hold_n = min(n, int(hold * SR))
    e = np.zeros(n)
    i = 0
    seg = min(a_n, n); e[:seg] = np.linspace(0, 1, seg, endpoint=False); i = seg
    seg = min(d_n, max(0, hold_n - i)); e[i:i + seg] = np.linspace(1, s, seg, endpoint=False); i += seg
    seg = max(0, hold_n - i); e[i:i + seg] = s; i += seg
    seg = max(0, n - i); e[i:i + seg] = np.linspace(e[i - 1] if i else s, 0, seg, endpoint=False)
    return e

def additive(freq, n, brightness=1.0, bright_decay=0.0, rolloff=1.0, odd_only=False, detune=0.0, phase=0.0):
    """Band-limited tone: harmonics with 1/k^rolloff amplitudes that darken over time."""
    t = np.arange(n) / SR
    kmax = int(min(24, (SR / 2.2) / max(freq, 1)))
    ks = np.arange(1, kmax + 1)
    if odd_only: ks = ks[ks % 2 == 1]
    out = np.zeros(n)
    for k in ks:
        amp = (1.0 / k ** rolloff) * brightness ** (k - 1)
        if bright_decay > 0: amp = amp * np.exp(-t * bright_decay * (k - 1))
        f = freq * k * (1 + detune * 1e-4 * (1 if k % 2 else -1))
        out += amp * np.sin(2 * np.pi * f * t + phase * k)
    return out / (np.abs(out).max() + 1e-9)

def fft_filter(x, lo=None, hi=None, order=2):
    """Zero-phase Butterworth-shaped band filter via FFT (whole-buffer, static)."""
    n = len(x)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    H = np.ones_like(f)
    if hi: H *= 1 / np.sqrt(1 + (f / hi) ** (2 * order))
    if lo: H *= 1 / np.sqrt(1 + (lo / np.maximum(f, 1e-3)) ** (2 * order))
    return np.fft.irfft(X * H, n)

def reverb(x, tau=1.4, mix=0.25, seed=1, lowpass=5000):
    rng = np.random.default_rng(seed)
    n_ir = int(tau * 3 * SR)
    t = np.arange(n_ir) / SR
    irL = rng.standard_normal(n_ir) * np.exp(-t / tau)
    irR = rng.standard_normal(n_ir) * np.exp(-t / tau)
    irL[:int(0.01 * SR)] *= np.linspace(0, 1, int(0.01 * SR)); irR[:int(0.01 * SR)] *= np.linspace(0, 1, int(0.01 * SR))
    irL = fft_filter(irL, hi=lowpass); irR = fft_filter(irR, hi=lowpass)
    irL /= np.sqrt((irL ** 2).sum()); irR /= np.sqrt((irR ** 2).sum())
    N = 1 << int(math.ceil(math.log2(len(x) + n_ir)))
    X = np.fft.rfft(x, N)
    wetL = np.fft.irfft(X * np.fft.rfft(irL, N), N)[:len(x)]
    wetR = np.fft.irfft(X * np.fft.rfft(irR, N), N)[:len(x)]
    return np.stack([x * (1 - mix) + wetL * mix * 3, x * (1 - mix) + wetR * mix * 3])

def stereo_widen(x, delay_ms=12, amount=0.3):
    d = int(delay_ms * SR / 1000)
    L = x.copy(); R = x.copy()
    R[d:] += amount * x[:-d]; L[d:] -= amount * x[:-d]
    return np.stack([L, R])

# ---------------------------------------------------------------- drum samples
def kick(punch=1.0, length=0.45):
    n = int(length * SR); t = np.arange(n) / SR
    f = 50 + 120 * punch * np.exp(-t * 35)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 7)
    click = np.random.default_rng(3).standard_normal(n) * np.exp(-t * 400) * 0.4 * punch
    return np.tanh(1.8 * (body + click))

def snare(tone=180, length=0.22, seed=5):
    n = int(length * SR); t = np.arange(n) / SR
    noise = np.random.default_rng(seed).standard_normal(n) * np.exp(-t * 18)
    noise = fft_filter(noise, lo=1200, hi=9000)
    body = np.sin(2 * np.pi * tone * t) * np.exp(-t * 30) * 0.8
    return np.tanh(2.0 * (noise * 1.2 + body))

def clap(length=0.25, seed=9):
    n = int(length * SR); t = np.arange(n) / SR
    rng = np.random.default_rng(seed)
    x = np.zeros(n)
    for i, off in enumerate([0, 0.011, 0.022, 0.03]):
        s = int(off * SR); seg = rng.standard_normal(n - s) * np.exp(-(t[: n - s]) * (60 if i < 3 else 12))
        x[s:] += seg
    return np.tanh(1.5 * fft_filter(x, lo=900, hi=7000))

def hat(length=0.06, seed=7, lo=6500):
    n = int(length * SR); t = np.arange(n) / SR
    x = np.random.default_rng(seed).standard_normal(n) * np.exp(-t * (6 / length))
    return fft_filter(x, lo=lo) * 0.8

def shaker(length=0.09, seed=11):
    n = int(length * SR); t = np.arange(n) / SR
    e = np.minimum(t / 0.02, 1) * np.exp(-t * 40)
    return fft_filter(np.random.default_rng(seed).standard_normal(n) * e, lo=3000) * 0.7

def tom(freq=110, length=0.4):
    n = int(length * SR); t = np.arange(n) / SR
    f = freq * (1 + 0.6 * np.exp(-t * 30))
    return np.tanh(1.5 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 8))

# ---------------------------------------------------------------- instruments
def pluck(freq, dur, bright=0.75, decay=6.0):
    n = int(dur * SR)
    tone = additive(freq, n, brightness=bright, bright_decay=decay, rolloff=0.9)
    return tone * env(n, 0.003, dur * 0.9, 0.0, 0.05, hold=dur * 0.9) * np.exp(-np.arange(n) / SR * 2.5)

def epiano(freq, dur):
    n = int(dur * SR); t = np.arange(n) / SR
    tone = np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(2 * np.pi * freq * 2 * t) * np.exp(-t * 4) + 0.12 * np.sin(2 * np.pi * freq * 3.01 * t) * np.exp(-t * 6)
    trem = 1 + 0.08 * np.sin(2 * np.pi * 5 * t)
    return tone * trem * env(n, 0.004, 0.6, 0.5, 0.25, hold=dur - 0.25) * np.exp(-t * 1.2)

def pad(freq, dur, bright=0.6):
    n = int(dur * SR)
    a = additive(freq, n, brightness=bright, rolloff=1.1, detune=6)
    b = additive(freq * 1.003, n, brightness=bright, rolloff=1.1, detune=-6, phase=1.3)
    c = additive(freq * 0.997, n, brightness=bright * 0.8, rolloff=1.2, phase=0.7)
    return (a + b + c) / 3 * env(n, 0.35, 0.3, 0.8, 0.6, hold=dur - 0.6)

def strings(freq, dur):
    n = int(dur * SR); t = np.arange(n) / SR
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.5 * t) * np.minimum(t / 0.6, 1)
    out = np.zeros(n)
    for det, ph in [(1.0, 0), (1.004, 1.1), (0.996, 2.3)]:
        f = freq * det * vib
        ph_acc = 2 * np.pi * np.cumsum(f) / SR + ph
        for k in range(1, 12):
            out += np.sin(ph_acc * k) / k ** 1.3
    out /= np.abs(out).max() + 1e-9
    return out * env(n, 0.25, 0.2, 0.9, 0.5, hold=dur - 0.5)

def bass(freq, dur, kind='sub'):
    n = int(dur * SR); t = np.arange(n) / SR
    if kind == 'sub':
        x = np.sin(2 * np.pi * freq * t) + 0.3 * np.sin(2 * np.pi * freq * 2 * t) * np.exp(-t * 8)
        return np.tanh(1.4 * x) * env(n, 0.005, 0.2, 0.7, 0.05, hold=dur - 0.05)
    if kind == 'pick':
        x = additive(freq, n, brightness=0.8, bright_decay=10, rolloff=0.8)
        return x * env(n, 0.003, 0.3, 0.5, 0.05, hold=dur - 0.05)
    x = additive(freq, n, brightness=0.85, bright_decay=14, rolloff=0.7, odd_only=False)  # synth
    return np.tanh(1.6 * x) * env(n, 0.004, 0.15, 0.6, 0.04, hold=dur - 0.04)

def lead(freq, dur, kind='sine'):
    n = int(dur * SR); t = np.arange(n) / SR
    vib = 1 + 0.006 * np.sin(2 * np.pi * 5.8 * t) * np.minimum(np.maximum(t - 0.15, 0) / 0.3, 1)
    ph = 2 * np.pi * np.cumsum(freq * vib) / SR
    if kind == 'sine': x = np.sin(ph) + 0.25 * np.sin(2 * ph) + 0.08 * np.sin(3 * ph)
    elif kind == 'square': x = sum(np.sin(ph * k) / k for k in (1, 3, 5, 7, 9))
    else: x = sum(np.sin(ph * k) / k ** 1.1 for k in range(1, 9))
    return x / (np.abs(x).max() + 1e-9) * env(n, 0.02, 0.1, 0.8, 0.12, hold=dur - 0.12)

def bell(freq, dur):
    n = int(dur * SR); t = np.arange(n) / SR
    x = np.sin(2 * np.pi * freq * t) * np.exp(-t * 3) + 0.5 * np.sin(2 * np.pi * freq * 2.76 * t) * np.exp(-t * 7) + 0.25 * np.sin(2 * np.pi * freq * 5.4 * t) * np.exp(-t * 12)
    return x * env(n, 0.002, dur, 0, 0.05, hold=dur - 0.05)

def marimba(freq, dur):
    n = int(dur * SR); t = np.arange(n) / SR
    x = np.sin(2 * np.pi * freq * t) * np.exp(-t * 6) + 0.4 * np.sin(2 * np.pi * freq * 4 * t) * np.exp(-t * 25) + 0.15 * np.sin(2 * np.pi * freq * 9.2 * t) * np.exp(-t * 40)
    return x * env(n, 0.002, 0.3, 0.0, 0.03, hold=min(dur, 0.6))

INSTR = {'pluck': pluck, 'epiano': epiano, 'pad': pad, 'strings': strings, 'lead': lead, 'bell': bell, 'marimba': marimba}

# ---------------------------------------------------------------- sequencer
class Track:
    def __init__(self, cfg):
        self.cfg = cfg
        self.bpm = cfg['bpm']; self.beat = 60 / self.bpm; self.bar = self.beat * 4
        self.bars = cfg['bars']
        self.n = int((self.bars * self.bar + 4) * SR)
        self.buses = {k: np.zeros(self.n) for k in ('drums', 'bass', 'chords', 'melody', 'perc')}
        self.rng = np.random.default_rng(cfg.get('seed', 1))
        self.scale = SCALES[cfg['scale']]
        self.root = cfg['root']
        self.kick_times = []

    def add(self, bus, sample, t, gain=1.0):
        s = int(t * SR)
        if s >= self.n: return
        seg = sample[: self.n - s]
        self.buses[bus][s:s + len(seg)] += seg * gain

    def deg(self, degree, octave=0):
        """Scale degree (0-based, may exceed 7) -> midi."""
        return self.root + 12 * (octave + degree // 7) + self.scale[degree % 7]

    def chord_notes(self, degree, octave=0, sevenths=False, inversion=0):
        tones = [0, 2, 4] + ([6] if sevenths else [])
        notes = [self.deg(degree + x, octave) for x in tones]
        for _ in range(inversion): notes.append(notes.pop(0) + 12)
        return notes

    # ----- parts
    def drums(self, section, bar_idx, t0):
        d = self.cfg['drums']
        step = self.beat / 4
        swing = self.cfg.get('swing', 0)
        intensity = {'intro': 0.0, 'build': 0.6, 'full': 1.0, 'break': 0.35, 'outro': 0.5}[section]
        if intensity == 0: return
        pats = d['pat']
        fill = (bar_idx % 8 == 7 and section == 'full')
        for i in range(16):
            t = t0 + i * step + (swing * step if i % 2 else 0)
            if pats.get('kick', '')[i:i + 1] == 'x': self.add('drums', self.kick_s, t, 1.0 * d.get('kick_gain', 1)); self.kick_times.append(t)
            if intensity >= 0.5 and pats.get('snare', '')[i:i + 1] == 'x': self.add('drums', self.snare_s, t, 0.9 * d.get('snare_gain', 1))
            if intensity >= 0.5 and pats.get('clap', '')[i:i + 1] == 'x': self.add('drums', self.clap_s, t, 0.7)
            if pats.get('hat', '')[i:i + 1] == 'x' and (intensity >= 0.6 or i % 4 == 0): self.add('drums', self.hat_s, t, (0.55 if i % 4 else 0.75) * d.get('hat_gain', 1))
            if intensity >= 0.6 and pats.get('open', '')[i:i + 1] == 'x': self.add('drums', self.open_s, t, 0.5)
            if pats.get('shaker', '')[i:i + 1] == 'x': self.add('perc', self.shaker_s, t, 0.5 if i % 2 else 0.35)
            if fill and i >= 12: self.add('drums', self.tom_s if i % 2 == 0 else self.snare_s, t, 0.7)

    def bassline(self, chord_deg, section, t0, bar_idx):
        if section == 'intro' and not self.cfg.get('bass_in_intro'): return
        style = self.cfg['bass']['style']; kind = self.cfg['bass']['kind']
        root = self.deg(chord_deg, -2)
        fifth = root + 7; octv = root + 12
        if style == 'eighths':
            for i in range(8):
                note = root if i not in (3, 7) else (fifth if i == 3 else octv)
                self.add('bass', bass(midi_hz(note), self.beat / 2 * 0.95, kind), t0 + i * self.beat / 2, 0.9)
        elif style == 'offbeat':
            for i in range(8):
                if i % 2 == 1: self.add('bass', bass(midi_hz(root if i < 6 else fifth), self.beat / 2 * 0.9, kind), t0 + i * self.beat / 2, 0.95)
            self.add('bass', bass(midi_hz(root), self.beat * 0.9, kind), t0, 0.8)
        elif style == 'long':
            self.add('bass', bass(midi_hz(root), self.bar * 0.98, kind), t0, 0.9)
        elif style == 'root5':
            for i, nt in enumerate([root, root, fifth, root]):
                self.add('bass', bass(midi_hz(nt), self.beat * 0.9, kind), t0 + i * self.beat, 0.9)
        elif style == 'boom':
            hits = [(0, root, 0.7), (0.75, root, 0.4), (1.5, root, 0.6), (2.5, fifth - 12 if fifth - 12 > 24 else fifth, 0.6), (3.25, root, 0.4)]
            for off, nt, ln in hits: self.add('bass', bass(midi_hz(nt), ln * self.beat, kind), t0 + off * self.beat, 0.95)
        elif style == 'walk':
            notes = [root, root + 4 if self.cfg['scale'] == 'major' else root + 3, fifth, root + 10 if bar_idx % 2 else fifth + 2]
            for i, nt in enumerate(notes): self.add('bass', bass(midi_hz(nt), self.beat * 0.85, kind), t0 + i * self.beat, 0.85)

    def chords(self, chord_deg, section, t0, bar_idx):
        c = self.cfg['chords']
        notes = self.chord_notes(chord_deg, 0, sevenths=c.get('sevenths', False), inversion=(bar_idx % 3) if c.get('invert') else 0)
        inst = INSTR[c['inst']]
        gain = c.get('gain', 0.5) * (0.7 if section == 'intro' else 1)
        if c['rhythm'] == 'sustain':
            for nt in notes: self.add('chords', inst(midi_hz(nt), self.bar * 1.02), t0, gain / len(notes))
        elif c['rhythm'] == 'stab':
            hits = [0, 1.5, 2.5] if section != 'intro' else [0]
            for h in hits:
                for nt in notes: self.add('chords', inst(midi_hz(nt), self.beat * 0.6), t0 + h * self.beat, gain / len(notes) * 1.3)
        elif c['rhythm'] == 'offbeat':
            for i in range(1, 8, 2):
                for nt in notes: self.add('chords', inst(midi_hz(nt), self.beat * 0.45), t0 + i * self.beat / 2, gain / len(notes) * 1.2)
        elif c['rhythm'] == 'arp':
            seq = notes + notes[1:-1][::-1] if len(notes) > 2 else notes
            step = self.beat / 2 if c.get('arp_eighths') else self.beat / 4
            k = 0; t = t0
            while t < t0 + self.bar - 1e-6:
                nt = seq[k % len(seq)] + (12 if (k // len(seq)) % 2 else 0)
                self.add('chords', inst(midi_hz(nt), step * 1.8), t, gain * 0.9)
                k += 1; t += step
        elif c['rhythm'] == 'strum':
            for h in [0, 1, 2, 2.5, 3]:
                for j, nt in enumerate(notes): self.add('chords', inst(midi_hz(nt), self.beat * 0.9), t0 + h * self.beat + j * 0.018, gain / len(notes) * 1.1)

    def melody(self, chord_deg, section, t0, bar_idx, phrase):
        m = self.cfg.get('melody')
        if not m or section in ('intro',) or (section == 'break' and not m.get('in_break')): return
        inst = INSTR[m['inst']] if m['inst'] != 'lead' else (lambda f, d: lead(f, d, m.get('lead_kind', 'sine')))
        chord_tones = [chord_deg, chord_deg + 2, chord_deg + 4]
        rhythm = phrase  # list of (offset_beats, length_beats, degree_offset or None)
        for off, ln, dg in rhythm:
            if dg is None: continue
            degree = chord_tones[dg % 3] + (dg // 3) * 1 + m.get('octave', 1) * 7
            self.add('melody', inst(midi_hz(self.deg(degree)), ln * self.beat * 0.95), t0 + off * self.beat, m.get('gain', 0.35))

    def make_phrases(self):
        """Two 2-bar motifs (A, B) made of (offset, length, chord-degree-index|None)."""
        rng = self.rng
        density = self.cfg.get('melody', {}).get('density', 0.6)
        def motif():
            notes = []; t = 0.0
            while t < 4.0:
                ln = rng.choice([0.5, 0.5, 1.0, 1.0, 1.5, 2.0])
                if t + ln > 4.0: ln = 4.0 - t
                if rng.random() < density: notes.append((t, ln, int(rng.integers(0, 6)) - 1))
                else: notes.append((t, ln, None))
                t += ln
            return notes
        A, B = motif(), motif()
        return [A, [(o, l, d + 1 if d is not None else None) for o, l, d in A], B, A]

    def render(self):
        cfg = self.cfg
        self.kick_s = kick(cfg['drums'].get('punch', 1.0)); self.snare_s = snare(cfg['drums'].get('snare_tone', 180))
        self.clap_s = clap(); self.hat_s = hat(); self.open_s = hat(0.28, seed=8, lo=5000); self.shaker_s = shaker(); self.tom_s = tom()
        prog = cfg['prog']
        sections = cfg['sections']  # list of (name, bars)
        phrases = self.make_phrases()
        bar_idx = 0
        for sec, nbars in sections:
            for b in range(nbars):
                t0 = bar_idx * self.bar
                chord_deg = prog[bar_idx % len(prog)]
                self.drums(sec, bar_idx, t0)
                self.bassline(chord_deg, sec, t0, bar_idx)
                self.chords(chord_deg, sec, t0, bar_idx)
                self.melody(chord_deg, sec, t0, bar_idx, phrases[(bar_idx // 2) % len(phrases)])
                bar_idx += 1
        # Final chord ring-out
        t_end = bar_idx * self.bar
        final = self.chord_notes(prog[0], 0, sevenths=cfg['chords'].get('sevenths', False))
        inst = INSTR[cfg['chords']['inst']]
        for nt in final: self.add('chords', inst(midi_hz(nt), 3.5), t_end, cfg['chords'].get('gain', 0.5) / len(final))
        self.add('bass', bass(midi_hz(self.deg(prog[0], -2)), 3.0, cfg['bass']['kind']), t_end, 0.8)
        self.add('drums', self.kick_s, t_end, 1.0)
        if cfg['drums'].get('crash', True): self.add('drums', hat(1.6, seed=21, lo=3000), t_end, 0.5)
        return self.mix(t_end + 3.6)

    def mix(self, length):
        n = int(length * SR)
        # sidechain-style ducking of chords/bass under the kick
        duck = np.ones(self.n)
        if self.cfg.get('duck', 0) > 0:
            seg_n = int(0.25 * SR); t = np.arange(seg_n) / SR
            shape = 1 - self.cfg['duck'] * np.exp(-t * 14)
            for kt in self.kick_times:
                s = int(kt * SR); e = min(self.n, s + seg_n)
                duck[s:e] = np.minimum(duck[s:e], shape[: e - s])
        drums = fft_filter(self.buses['drums'], hi=15000)
        bassb = fft_filter(self.buses['bass'], hi=3500) * duck
        chords = fft_filter(self.buses['chords'], lo=120, hi=9000) * duck
        melody = fft_filter(self.buses['melody'], lo=200, hi=10000)
        perc = fft_filter(self.buses['perc'], lo=2000)
        g = self.cfg.get('mix', {})
        dry = np.stack([drums, drums]) * g.get('drums', 1.0) + np.stack([bassb, bassb]) * g.get('bass', 0.9)
        wetc = reverb(chords, tau=self.cfg.get('reverb', 1.2), mix=self.cfg.get('reverb_mix', 0.22), seed=2) * g.get('chords', 1.0)
        wetm = reverb(melody, tau=self.cfg.get('reverb', 1.2) * 1.2, mix=self.cfg.get('reverb_mix', 0.22) + 0.08, seed=4) * g.get('melody', 1.0)
        percs = stereo_widen(perc) * g.get('perc', 1.0)
        out = dry + wetc + wetm + percs
        if self.cfg.get('vinyl'):
            rng = np.random.default_rng(42)
            crackle = (rng.random(self.n) < 0.0004) * rng.standard_normal(self.n) * 0.6
            hiss = fft_filter(rng.standard_normal(self.n), lo=2500) * 0.012
            out += np.stack([crackle + hiss, np.roll(crackle, 300) + hiss])
        out = out[:, :n]
        # master: soft clip, fade in/out, normalise
        out = np.tanh(out * 0.9)
        fi = int(0.05 * SR); fo = int(3.0 * SR)
        out[:, :fi] *= np.linspace(0, 1, fi)
        out[:, -fo:] *= np.linspace(1, 0, fo) ** 1.5
        out /= (np.abs(out).max() + 1e-9) / 0.92
        return out

# ---------------------------------------------------------------- library
LIBRARY = [
    dict(id='sunrise-drive', name='Sunrise Drive', mood='Uplifting pop', bpm=112, root=60, scale='major', prog=[0, 4, 5, 3], bars=36, seed=11,
         sections=[('intro', 4), ('build', 4), ('full', 16), ('break', 4), ('full', 8)],
         drums=dict(pat=dict(kick='x...x...x...x...', snare='....x.......x...', hat='x.x.x.x.x.x.x.x.', open='..............x.'), punch=1.0),
         bass=dict(style='eighths', kind='pick'), chords=dict(inst='epiano', rhythm='offbeat', gain=0.5, sevenths=False),
         melody=dict(inst='lead', lead_kind='sine', octave=1, gain=0.3, density=0.65), duck=0.3, reverb=1.1, themes=['classic', 'travel']),
    dict(id='adrenaline', name='Adrenaline', mood='Energetic electronic', bpm=140, root=57, scale='minor', prog=[0, 5, 3, 4], bars=40, seed=23,
         sections=[('intro', 4), ('build', 4), ('full', 16), ('break', 4), ('full', 12)],
         drums=dict(pat=dict(kick='x...x...x...x...', clap='....x.......x...', hat='..x...x...x...x.', open='......x.......x.'), punch=1.2),
         bass=dict(style='offbeat', kind='synth'), chords=dict(inst='pad', rhythm='sustain', gain=0.45),
         melody=dict(inst='lead', lead_kind='square', octave=1, gain=0.28, density=0.8), duck=0.55, reverb=0.9, reverb_mix=0.18, themes=['action']),
    dict(id='lazy-afternoon', name='Lazy Afternoon', mood='Lo-fi chill', bpm=80, root=65, scale='major', prog=[1, 4, 0, 5], bars=28, seed=5,
         sections=[('intro', 2), ('full', 14), ('break', 4), ('full', 8)], swing=0.25,
         drums=dict(pat=dict(kick='x.....x...x.....', snare='....x.......x...', hat='x.x.x.x.x.x.x.x.'), punch=0.7, snare_tone=160, hat_gain=0.6, crash=False),
         bass=dict(style='boom', kind='sub'), chords=dict(inst='epiano', rhythm='sustain', gain=0.55, sevenths=True, invert=True),
         melody=dict(inst='epiano', octave=1, gain=0.3, density=0.5, in_break=True), duck=0.15, reverb=1.0, vinyl=True, themes=['chill']),
    dict(id='night-city', name='Night City', mood='Synthwave', bpm=100, root=62, scale='minor', prog=[0, 5, 2, 6], bars=32, seed=8,
         sections=[('intro', 4), ('build', 4), ('full', 16), ('break', 4), ('full', 4)],
         drums=dict(pat=dict(kick='x.......x.......', snare='....x.......x...', hat='x.x.x.x.x.x.x.x.', shaker='..x...x...x...x.'), punch=1.1, snare_tone=200),
         bass=dict(style='eighths', kind='synth'), chords=dict(inst='pluck', rhythm='arp', gain=0.42),
         melody=dict(inst='lead', lead_kind='saw', octave=1, gain=0.27, density=0.55), duck=0.4, reverb=1.6, reverb_mix=0.3, themes=['noir', 'epic']),
    dict(id='mountain-air', name='Mountain Air', mood='Acoustic folk', bpm=92, root=55, scale='major', prog=[0, 3, 5, 4], bars=32, seed=14,
         sections=[('intro', 4), ('full', 16), ('break', 4), ('full', 8)],
         drums=dict(pat=dict(kick='x......x..x.....', snare='....x.......x...', hat='', shaker='x.x.x.x.x.x.x.x.'), punch=0.6, snare_gain=0.5, crash=False),
         bass=dict(style='root5', kind='pick', bass_in_intro=False), chords=dict(inst='pluck', rhythm='strum', gain=0.5),
         melody=dict(inst='pluck', octave=2, gain=0.32, density=0.6), duck=0.1, reverb=1.3, themes=['travel', 'classic']),
    dict(id='deep-focus', name='Deep Focus', mood='Ambient', bpm=70, root=64, scale='minor', prog=[0, 3, 5, 2], bars=24, seed=31,
         sections=[('intro', 4), ('full', 12), ('break', 4), ('full', 4)],
         drums=dict(pat=dict(kick='x.......x.......', snare='', hat='....x.......x...', shaker='..x...x...x...x.'), punch=0.5, hat_gain=0.4, crash=False),
         bass=dict(style='long', kind='sub'), chords=dict(inst='pad', rhythm='sustain', gain=0.6, sevenths=True),
         melody=dict(inst='bell', octave=2, gain=0.22, density=0.35, in_break=True), duck=0.2, reverb=2.2, reverb_mix=0.35, themes=['dreamy', 'chill']),
    dict(id='street-beat', name='Street Beat', mood='Hip-hop', bpm=94, root=58, scale='minor', prog=[0, 0, 5, 3], bars=32, seed=19,
         sections=[('intro', 2), ('full', 14), ('break', 4), ('full', 12)], swing=0.12,
         drums=dict(pat=dict(kick='x..x..x...x.x...', snare='....x.......x...', hat='x.xxx.x.x.xxx.x.', open='..............x.'), punch=1.3, snare_tone=190),
         bass=dict(style='boom', kind='sub'), chords=dict(inst='epiano', rhythm='stab', gain=0.45, sevenths=True),
         melody=dict(inst='lead', lead_kind='sine', octave=1, gain=0.25, density=0.5), duck=0.35, reverb=1.0, themes=['action', 'noir']),
    dict(id='festival', name='Festival', mood='House', bpm=126, root=60, scale='minor', prog=[0, 5, 3, 4], bars=40, seed=27,
         sections=[('intro', 4), ('build', 8), ('full', 16), ('break', 4), ('full', 8)],
         drums=dict(pat=dict(kick='x...x...x...x...', clap='....x.......x...', hat='..x...x...x...x.', open='..x...x...x...x.', shaker='x.x.x.x.x.x.x.x.'), punch=1.1),
         bass=dict(style='offbeat', kind='synth'), chords=dict(inst='epiano', rhythm='stab', gain=0.5, sevenths=True),
         melody=dict(inst='lead', lead_kind='saw', octave=1, gain=0.26, density=0.7), duck=0.6, reverb=1.2, themes=['action', 'travel']),
    dict(id='golden-hour', name='Golden Hour', mood='Tropical', bpm=104, root=56, scale='major', prog=[0, 5, 3, 4], bars=36, seed=37,
         sections=[('intro', 4), ('full', 16), ('break', 4), ('full', 12)],
         drums=dict(pat=dict(kick='x.....x.x.....x.', snare='....x.......x...', hat='x.x.x.x.x.x.x.x.', shaker='..x...x...x...x.'), punch=0.9, snare_tone=170),
         bass=dict(style='boom', kind='sub'), chords=dict(inst='marimba', rhythm='arp', gain=0.5, arp_eighths=False),
         melody=dict(inst='marimba', octave=1, gain=0.3, density=0.6), duck=0.3, reverb=1.4, themes=['travel', 'dreamy', 'chill']),
    dict(id='epic-horizon', name='Epic Horizon', mood='Cinematic', bpm=84, root=60, scale='minor', prog=[0, 5, 3, 4], bars=28, seed=41,
         sections=[('intro', 4), ('build', 4), ('full', 12), ('break', 2), ('full', 6)],
         drums=dict(pat=dict(kick='x.......x.x.....', snare='....x.......x...', hat='', shaker=''), punch=1.4, snare_tone=140, snare_gain=1.1),
         bass=dict(style='long', kind='sub'), chords=dict(inst='strings', rhythm='sustain', gain=0.6),
         melody=dict(inst='lead', lead_kind='saw', octave=1, gain=0.3, density=0.45), duck=0.25, reverb=2.4, reverb_mix=0.35, themes=['epic', 'noir']),
]

def write_wav(path, stereo):
    data = (np.clip(stereo.T, -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(data.tobytes())

def main():
    os.makedirs(OUT, exist_ok=True)
    only = sys.argv[1:] 
    meta = []
    for cfg in LIBRARY:
        if only and cfg['id'] not in only: continue
        print('rendering', cfg['name'], '...', flush=True)
        audio = Track(cfg).render()
        wav = os.path.join(OUT, cfg['id'] + '.wav'); mp3 = os.path.join(OUT, cfg['id'] + '.mp3')
        write_wav(wav, audio)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', mp3], check=True)
        os.remove(wav)
        meta.append(dict(id=cfg['id'], name=cfg['name'], mood=cfg['mood'], bpm=cfg['bpm'], file=f"music/{cfg['id']}.mp3",
                         duration=round(audio.shape[1] / SR, 1), themes=cfg['themes'], license='Original work generated for this project (CC0 / public domain)'))
        print(f"  {audio.shape[1] / SR:.1f}s -> {os.path.getsize(mp3) / 1e6:.2f} MB")
    if not only:
        with open(os.path.join(OUT, 'library.json'), 'w') as f: json.dump(meta, f, indent=2)
        print('wrote library.json with', len(meta), 'tracks')

if __name__ == '__main__':
    main()
