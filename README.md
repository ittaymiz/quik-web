# Quik Web

A free, open-source video editor that runs in your phone's browser. Drop in the videos and photos
from a trip, press **Auto Create** and get a finished highlight video with a theme, transitions, a
title and music-synced cuts. Then fine-tune every clip the way you would in a native app.

It was built to replace the paid auto-edit feature of GoPro Quik. Everything runs on your device:
no account, no upload, no server, no subscription.

**Live app:** <https://ittaymiz.github.io/quik-web/>

## Use it on your phone

iPhone (Safari, iOS 17 or newer; iOS 18+ gives the best results):

1. Open <https://ittaymiz.github.io/quik-web/> in Safari.
2. Tap **Share → Add to Home Screen**. The app opens full screen like a native app and works offline.
3. **Media** tab → **+ Add** picks videos and photos from your Photos library.
4. Tap **Auto Create**. Then use the **Clip / Style / Text / Music / Theme** tabs to edit.
5. **Export** renders the video. When it is done, tap **Save to Photos / Share…**, then **Save Video**.
   Keep the app in the foreground while it renders (the screen is kept awake automatically).

Android (Chrome): open the same URL, then **⋮ → Add to Home screen**. The steps are the same.

On the phone the timeline is scrubbed by dragging on the time ruler; clips are reordered with the
**Move earlier / Move later** buttons in the Clip tab (or long-press and drag).

Your media never leaves the phone. Files and the project are kept in the browser's IndexedDB,
so closing the app and coming back restores your work.

## Run it on a computer

Chrome or Edge are recommended. Open `index.html` directly, or serve the folder:

```
python3 -m http.server 8000
# then open http://localhost:8000
```

## Host your own copy

The app is static files, so any HTTPS host works. GitHub Pages is free:

1. Fork this repository.
2. In your fork open **Settings → Pages** and set **Source** to **GitHub Actions**. The included
   workflow (`.github/workflows/pages.yml`) publishes the app on every push to `main`.
3. Open `https://<your-github-user>.github.io/quik-web/` on the phone.

## Contributing

Issues, ideas and pull requests are welcome. Fork the repo, create a branch, open a PR against `main`.
Every PR is reviewed and merged by the maintainer; nobody pushes to `main` directly.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the short version of how the code is laid out and how to test a change
on a real phone. Good first contributions: a new theme or look in `js/presets.js`, a new music track
(see [Built-in music](#built-in-music)), transition types, or a bug you hit on your own footage.

If you use it, share it with someone who still pays a subscription for auto-edits.

## Features

| Area | What you can do |
| --- | --- |
| Import | Drag & drop or pick videos and photos. Files stay in the browser (IndexedDB) so a reload restores your project. Duplicate files are detected and removed. |
| Auto Create | Plans a whole edit for a chosen length (default 30 seconds). Each video is analysed once for people (on-device face detector), scenic views, action (motion + audio) and quality; the best moments win, several clips may come from one file (always different sections), look-alike files and repeated footage are excluded, and cuts are aligned to the music. **Re-arrange** rebuilds, **Fit** rescales. |
| HiLight tags | Mark a moment in a clip; Auto Create always keeps a window around it. |
| Themes | 14 themes (Classic, Action, Chill, Noir, Retro, Epic, Dreamy, Snow, Beach, Sunset, Urban, Party, Rainy day, Travel) with their own look, transition pool, pace, text style, effects and particles. |
| Speed tool | ¼× to 8× per clip, plus speed ramps: slow-mo at the start / middle / end, ramp up / down, freeze frames (0.5–3 s) at the start / middle / end, with ½×, ¼×, ⅛× slow motion. Auto slow-mo on the strongest action moment. |
| Trim / split / order | Dual-handle trim with a filmstrip, set start/end at the playhead, split, duplicate, delete, drag or move to reorder. |
| Reframe | 16:9, 9:16, 1:1, 4:5; Fill/Fit; zoom and pan; level horizon (±30°), rotate 90°, flip; custom keyframed zoom/pan moves. Photos get Ken Burns motion. |
| Looks | 25 looks including environment filters (Snow, Water, Desert, Beach, Forest, Urban, Sunset, Indoor, Dirt, Cinematic, Teal & Orange, Moody, Bright) plus brightness, contrast, saturation, temperature, tint, fade and vignette. |
| Effects | Camera motion on every clip (zoom in/out, pan, custom), beat pulse, light leaks, film grain, letterbox bars, particles (snow, bokeh, sparkles, confetti, rain, dust). Effects are randomised per clip so no two clips look alike, and can be tuned in the FX tab. |
| Transitions | Cut, Crossfade, Fade, White flash, Slide, Zoom, Wipe, Push in, Whip, with adjustable length. |
| Text | Title per clip with six fonts, five styles, position, size, colours, eight animations and duration. |
| Stickers | 48 emoji, text stickers, date and time badges; pop/float/spin animations; drag to position in the preview. |
| Music | 10 built-in tracks with preview, or your own file. Auto Create adds the theme's track. Volume, offset, fades, loop, ducking, beat detection, **Sync cuts to beats**, **Fit video length to music**. |
| Playback | Smooth native playback on phones (two shared players), scrubbing, keyboard shortcuts, timeline zoom. |
| Export | Hardware-decoded, frame-accurate MP4 (H.264 + AAC) at Share 720p, High 1080p or Max 1080p60, with an offline audio mix; share straight to Photos / WhatsApp. Frame grab saves a PNG. A built-in check verifies the audio and a technical report explains every step. |
| Undo / redo | Every edit is undoable (Ctrl+Z / Ctrl+Y). |

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ← / → | Step one frame (Shift: one second) |
| Home / End | Go to start / end |
| S | Split selected clip at playhead |
| Delete | Delete selected clip |
| [ / ] | Set trim start / end at playhead |
| Ctrl+Z / Ctrl+Y | Undo / redo |

## Built-in music

The `music/` folder holds ten original tracks that were synthesised for this project with
`tools/make_music.py` (numpy + ffmpeg). They carry no third-party licence, so the exported videos can
be shared freely. `music/library.json` describes each track (name, mood, BPM, duration, and which themes
pick it by default).

To use your own tracks instead, drop MP3 files into `music/` and add entries to `library.json`.
To regenerate or tweak the built-in ones, edit the `LIBRARY` table in `tools/make_music.py` and run it.

## How it works

- `js/app.js` – timeline model, canvas renderer (filters, text, transitions, reframe), playback engine, audio graph, UI, export.
- `js/beats.js` – decodes the music track and finds beat onsets from short-window energy peaks.
- `js/presets.js` – filter looks, themes and pace settings.
- `js/db.js` – IndexedDB persistence for media files and the project.

Rendering uses an HTML canvas. Export decodes the source clips with hardware decoders, encodes
frames with WebCodecs (H.264 + AAC) and muxes them into MP4 in the browser (`mp4-muxer`); `mediabunny`
handles decoding and demuxing. Browsers without WebCodecs fall back to `MediaRecorder`. A 1‑minute
video takes about a minute. Keep the tab visible while it renders.

## Known limitations

- Export is MP4 (H.264 + AAC) wherever WebCodecs is available (Safari 17+, Chrome, Edge). Browsers without WebCodecs (e.g. Firefox) fall back to `MediaRecorder` and produce WebM, which carries no duration header; players still play it, and ffmpeg can remux it if needed.
- On iPhone, Safari limits how much video memory a page may use. Very long 4K clips can be slow; shorter or 1080p clips work best.
- Reverse playback is not available (browsers cannot play video backwards).
- Keep the tab in the foreground during export; background tabs are throttled by the browser.

## License

MIT. See [LICENSE](LICENSE). The built-in music is CC0 (see [Built-in music](#built-in-music)).
Vendored libraries keep their own licences in `js/vendor/`.
