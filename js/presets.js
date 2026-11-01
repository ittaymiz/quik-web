/* Looks (filters), themes and text styles. */
const FILTERS = {
  none:     { name: 'Original', css: '' },
  vivid:    { name: 'Vivid',    css: 'saturate(1.45) contrast(1.1)' },
  warm:     { name: 'Warm',     css: 'sepia(0.3) saturate(1.2) brightness(1.03)' },
  cool:     { name: 'Cool',     css: 'hue-rotate(-12deg) saturate(1.1) brightness(1.02) contrast(1.05)' },
  bw:       { name: 'B&W',      css: 'grayscale(1) contrast(1.15)' },
  vintage:  { name: 'Vintage',  css: 'sepia(0.55) contrast(0.9) brightness(1.05) saturate(1.2)' },
  dramatic: { name: 'Dramatic', css: 'contrast(1.35) saturate(0.85) brightness(0.92)' },
  fade:     { name: 'Fade',     css: 'contrast(0.85) brightness(1.1) saturate(0.8)' },
  punch:    { name: 'Punch',    css: 'contrast(1.2) saturate(1.3) brightness(0.98)' },
  pastel:   { name: 'Pastel',   css: 'saturate(0.7) brightness(1.12) contrast(0.9)' },
  night:    { name: 'Night',    css: 'brightness(0.85) contrast(1.2) hue-rotate(-20deg) saturate(0.9)' },
  golden:   { name: 'Golden',   css: 'sepia(0.45) saturate(1.5) brightness(1.05)' },
  /* Environment looks, in the spirit of GoPro's snow / water / desert filters */
  snow:     { name: 'Snow',     css: 'brightness(1.08) contrast(1.12) saturate(0.9) hue-rotate(-6deg)' },
  water:    { name: 'Water',    css: 'hue-rotate(-14deg) saturate(1.35) contrast(1.12) brightness(1.02)' },
  desert:   { name: 'Desert',   css: 'sepia(0.35) saturate(1.3) contrast(1.08) brightness(1.04)' },
  beach:    { name: 'Beach',    css: 'saturate(1.3) brightness(1.06) contrast(1.04) hue-rotate(-4deg)' },
  forest:   { name: 'Forest',   css: 'saturate(1.25) contrast(1.1) hue-rotate(8deg) brightness(0.98)' },
  urban:    { name: 'Urban',    css: 'contrast(1.25) saturate(0.8) brightness(0.97)' },
  sunset:   { name: 'Sunset',   css: 'sepia(0.3) saturate(1.6) contrast(1.08) hue-rotate(-8deg)' },
  indoor:   { name: 'Indoor',   css: 'brightness(1.1) contrast(1.05) saturate(1.05) hue-rotate(6deg)' },
  dirt:     { name: 'Dirt',     css: 'sepia(0.2) saturate(1.15) contrast(1.15) brightness(0.98)' },
  cinema:   { name: 'Cinematic', css: 'contrast(1.18) saturate(0.85) sepia(0.12) brightness(0.96)' },
  tealorange: { name: 'Teal & Orange', css: 'sepia(0.25) saturate(1.5) hue-rotate(-18deg) contrast(1.12)' },
  moody:    { name: 'Moody',    css: 'contrast(1.2) saturate(0.7) brightness(0.9) hue-rotate(-10deg)' },
  bright:   { name: 'Bright',   css: 'brightness(1.15) saturate(1.2) contrast(1.02)' }
};

/* Each theme also carries an `fx` preset: camera motion amount, beat pulse, letterbox, light leaks, grain. */
const THEMES = {
  classic: { name: 'Classic',  desc: 'Clean crossfades, true colors', filter: 'none',     transition: 'crossfade', pace: 'medium', textStyle: 'bold', transitions: ['crossfade', 'push', 'slide', 'wipe'], fx: { motion: 0.6, pulse: true, letterbox: false, leaks: true, grain: 0.08 },  swatch: 'linear-gradient(135deg,#4f8cff,#7c5cff)' },
  action:  { name: 'Action',   desc: 'Punchy, fast cuts, flashes',   filter: 'vivid',    transition: 'flash',     pace: 'fast',   textStyle: 'outline', transitions: ['flash', 'whip', 'zoom', 'push'], fx: { motion: 0.7, pulse: true, letterbox: false, leaks: false, grain: 0.1 }, swatch: 'linear-gradient(135deg,#ff6b35,#ffb52e)' },
  chill:   { name: 'Chill',    desc: 'Warm tones, slow fades',       filter: 'warm',     transition: 'fade',      pace: 'slow',   textStyle: 'minimal', transitions: ['fade', 'crossfade', 'push'], fx: { motion: 0.4, pulse: true, letterbox: false, leaks: true, grain: 0.15 }, swatch: 'linear-gradient(135deg,#f6d365,#fda085)' },
  noir:    { name: 'Noir',     desc: 'Black & white, moody',         filter: 'bw',       transition: 'fade',      pace: 'medium', textStyle: 'box', transitions: ['fade', 'crossfade', 'wipe'], fx: { motion: 0.4, pulse: true, letterbox: true, leaks: false, grain: 0.35 },     swatch: 'linear-gradient(135deg,#222,#999)' },
  retro:   { name: 'Retro',    desc: 'Faded film look, zooms',       filter: 'vintage',  transition: 'zoom',      pace: 'medium', textStyle: 'box', transitions: ['zoom', 'whip', 'flash', 'crossfade'], fx: { motion: 0.5, pulse: true, letterbox: false, leaks: true, grain: 0.3 },     swatch: 'linear-gradient(135deg,#c79081,#dfa579)' },
  epic:    { name: 'Epic',     desc: 'Cinematic contrast',           filter: 'dramatic', transition: 'zoom',      pace: 'medium', textStyle: 'outline', transitions: ['zoom', 'push', 'fade', 'whip'], fx: { motion: 0.6, pulse: true, letterbox: true, leaks: false, grain: 0.12 }, swatch: 'linear-gradient(135deg,#0f2027,#2c5364)' },
  dreamy:  { name: 'Dreamy',   desc: 'Soft, airy, pastel',           filter: 'pastel',   transition: 'crossfade', pace: 'slow',   textStyle: 'minimal', transitions: ['crossfade', 'push', 'fade'], fx: { motion: 0.4, pulse: true, letterbox: false, leaks: true, grain: 0.1 }, swatch: 'linear-gradient(135deg,#a18cd1,#fbc2eb)' },
  travel:  { name: 'Travel',   desc: 'Golden hour, slides',          filter: 'golden',   transition: 'slide',     pace: 'medium', textStyle: 'lower', transitions: ['slide', 'whip', 'push', 'crossfade'], fx: { motion: 0.6, pulse: true, letterbox: false, leaks: true, grain: 0.05 },   swatch: 'linear-gradient(135deg,#f7971e,#ffd200)' }
};

/* Target seconds per clip for each pace. */
const PACE = { slow: 6, medium: 4, fast: 2.5 };
/* Auto edits never cut a clip shorter than this (unless the footage itself is shorter). */
const AUTO_MIN_CLIP = 2.5;
