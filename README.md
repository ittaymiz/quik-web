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

## Features

| Area | What you can do |
| --- | --- |
| Import | Drag & drop or pick videos and photos. Files stay in the browser (IndexedDB) so a reload restores your project. |
| Auto Create | Picks highlight segments from each video, applies the selected theme, adds the project title and syncs cuts to the music beats. |
| Themes | Classic, Action, Chill, Noir, Retro, Epic, Dreamy, Travel. Each sets a look, a transition style, a pace and a text style. |
| Trim | Dual-handle trim slider with a filmstrip, or set start/end at the playhead (`[` and `]`). |
| Split / reorder | Split at the playhead (`S`), drag clips on the timeline to reorder, duplicate, delete. |
| Speed | ¼×, ½×, 1×, 2×, 4×, 8× (slow motion and time-lapse). |
| Reframe | Fill or Fit, zoom and pan for 16:9, 9:16, 1:1 and 4:5 output. Photos get Ken Burns motion. |
| Filters | 12 looks (Vivid, Warm, Cool, B&W, Vintage, Dramatic, …) plus brightness, contrast, saturation and vignette. Apply to one clip or all. |
| Text | Title per clip with position, style (Bold, Outline, Box, Lower third, Minimal), size, colors, animation and duration. |
| Transitions | Cut, Crossfade, Fade through black, White flash, Slide, Zoom, Wipe, with adjustable length. |
| Music | Add any audio file. Volume, start offset, fade in/out, loop, auto-ducking of clip audio. Beat detection with **Sync cuts to beats** and **Fit video length to music**. |
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

## How it works

- `js/app.js` – timeline model, canvas renderer (filters, text, transitions, reframe), playback engine, audio graph, UI, export.
- `js/beats.js` – decodes the music track and finds beat onsets from short-window energy peaks.
- `js/presets.js` – filter looks, themes and pace settings.
- `js/db.js` – IndexedDB persistence for media files and the project.

Rendering uses an HTML canvas, so export runs in real time through `MediaRecorder`
(a 1‑minute video takes about a minute). Keep the tab visible while it renders.

## Known limitations

- Export is WebM in Chrome/Edge/Firefox. Safari produces MP4 when `MediaRecorder` supports it. WebM files recorded in the browser carry no duration header; players still play them, and tools such as ffmpeg can remux them if needed.
- Reverse playback is not available (browsers cannot play video backwards).
- Exported audio comes from the browser's live mix, so keep the tab in the foreground during export.
