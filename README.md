# Quik Web

A browser-based video editor inspired by GoPro Quik. Drop in your videos and photos,
press **Auto Create** and get a finished highlight video with a theme, transitions,
a title and music-synced cuts. Then fine-tune every clip the way you would in the app.

Everything runs locally in your browser. No upload, no server, no build step.

## Run it

Open `index.html` in Chrome or Edge (recommended – they can record the export), or serve the folder:

```
python3 -m http.server 8000
# then open http://localhost:8000
```

## Use it on your iPhone

The editor runs in Safari on iOS 17 or newer (iOS 18+ gives the best results: colour filters
are rendered natively there). It needs to be served over HTTPS, which GitHub Pages provides for free:

1. In this repository open **Settings → Pages** and set **Source** to **GitHub Actions**. The included
   workflow (`.github/workflows/pages.yml`) publishes the app on every push.
2. Open `https://<your-github-user>.github.io/<repo-name>/` on the phone (for this repo:
   `https://ittaymiz.github.io/quik-web/`).
3. Tap **Share → Add to Home Screen**. The app then opens full screen like a native app and works offline.
4. **Media** tab → **+ Add** picks videos and photos from your Photos library. Tap **Auto Create**,
   then use the **Clip / Style / Text / Music / Theme** tabs to edit.
5. **Export** renders the video. When it is done, tap **Save to Photos / Share…**, then **Save Video**.
   Keep the app in the foreground while it renders (the screen is kept awake automatically).

On the phone the timeline is scrubbed by dragging on the time ruler; clips are reordered with the
**Move earlier / Move later** buttons in the Clip tab (or long-press and drag). Safari exports MP4 (H.264).

## Features

| Area | What you can do |
| --- | --- |
| Import | Drag & drop or pick videos and photos. Files stay in the browser (IndexedDB) so a reload restores your project. |
| Auto Create | Plans a whole edit for a chosen length (default 2 minutes): spreads segments across every video, interleaves photos, applies the theme, adds the title and music, and aligns the cuts to the beats. **Re-arrange** rebuilds it for a new length; **Fit** rescales the current clips. |
| Themes | Classic, Action, Chill, Noir, Retro, Epic, Dreamy, Travel. Each sets a look, a transition style, a pace and a text style. |
| Trim | Dual-handle trim slider with a filmstrip, or set start/end at the playhead (`[` and `]`). |
| Split / reorder | Split at the playhead (`S`), drag clips on the timeline to reorder, duplicate, delete. |
| Speed | ¼×, ½×, 1×, 2×, 4×, 8× (slow motion and time-lapse). |
| Reframe | Fill or Fit, zoom and pan for 16:9, 9:16, 1:1 and 4:5 output. Photos get Ken Burns motion. |
| Filters | 12 looks (Vivid, Warm, Cool, B&W, Vintage, Dramatic, …) plus brightness, contrast, saturation and vignette. Apply to one clip or all. |
| Text | Title per clip with position, style (Bold, Outline, Box, Lower third, Minimal), size, colors, animation and duration. |
| Transitions | Cut, Crossfade, Fade through black, White flash, Slide, Zoom, Wipe, with adjustable length. |
| Music | 10 built-in tracks (pop, electronic, lo-fi, synthwave, folk, ambient, hip-hop, house, tropical, cinematic) with preview, or add any audio file. Auto Create adds the theme's track automatically. Volume, start offset, fade in/out, loop, auto-ducking of clip audio. Beat detection with **Sync cuts to beats** and **Fit video length to music**. |
| Playback | Real-time preview with scrubbing, keyboard shortcuts and timeline zoom. |
| Export | Renders to WebM (VP9/Opus, or MP4 where the browser supports it) at 720p or 1080p, 30 or 60 fps. Frame grab saves the current frame as PNG. |
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

Rendering uses an HTML canvas, so export runs in real time through `MediaRecorder`
(a 1‑minute video takes about a minute). Keep the tab visible while it renders.

## Known limitations

- Export is WebM in Chrome/Edge/Firefox. Safari produces MP4 when `MediaRecorder` supports it. WebM files recorded in the browser carry no duration header; players still play them, and tools such as ffmpeg can remux them if needed.
- On iPhone, Safari limits how much video memory a page may use. Very long 4K clips can be slow; shorter or 1080p clips work best.
- Reverse playback is not available (browsers cannot play video backwards).
- Exported audio comes from the browser's live mix, so keep the tab in the foreground during export.
