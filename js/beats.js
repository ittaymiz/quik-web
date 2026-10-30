/* Beat / onset detection for "sync cuts to the music".
   Decodes the track, measures energy in short windows, and picks energy peaks that
   stand out from the local average. Returns beat times in seconds. */
const Beats = (() => {
  async function decode(blob) {
    const buf = await blob.arrayBuffer();
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
    return await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(buf, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  function energies(audio, hop) {
    const n = audio.numberOfChannels;
    const len = audio.length;
    const frames = Math.floor(len / hop);
    const out = new Float32Array(frames);
    const chans = [];
    for (let c = 0; c < n; c++) chans.push(audio.getChannelData(c));
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      const s0 = f * hop, s1 = s0 + hop;
      for (let c = 0; c < n; c++) {
        const d = chans[c];
        for (let i = s0; i < s1; i++) sum += d[i] * d[i];
      }
      out[f] = sum / (hop * n);
    }
    return out;
  }

  /** @returns {Promise<{beats:number[], duration:number, bpm:number}>} */
  async function analyze(blob) {
    const audio = await decode(blob);
    const sr = audio.sampleRate;
    const hop = Math.round(sr * 0.02);          // 20 ms windows
    const e = energies(audio, hop);
    const frames = e.length;
    const win = Math.round(1.0 / 0.02);         // 1 s local window
    const minGap = Math.round(0.25 / 0.02);     // at least 250 ms between beats
    const beats = [];
    let last = -minGap;
    for (let i = 1; i < frames - 1; i++) {
      let a = 0, cnt = 0;
      for (let j = Math.max(0, i - win); j < Math.min(frames, i + win); j++) { a += e[j]; cnt++; }
      const avg = a / cnt;
      const onset = e[i] - e[i - 1];
      if (e[i] > avg * 1.4 && onset > 0 && e[i] >= e[i + 1] && i - last >= minGap) {
        beats.push(i * 0.02);
        last = i;
      }
    }
    // Estimate tempo from the most common inter-beat interval.
    let bpm = 0;
    if (beats.length > 4) {
      const hist = new Map();
      for (let i = 1; i < beats.length; i++) {
        const iv = Math.round((beats[i] - beats[i - 1]) * 20) / 20;
        if (iv >= 0.25 && iv <= 1.5) hist.set(iv, (hist.get(iv) || 0) + 1);
      }
      let best = 0, bestIv = 0.5;
      hist.forEach((c, iv) => { if (c > best) { best = c; bestIv = iv; } });
      bpm = Math.round(60 / bestIv);
    }
    return { beats, duration: audio.duration, bpm };
  }

  return { analyze };
})();
