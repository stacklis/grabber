# grabber

Local web UI that wraps `yt-dlp` and `gallery-dl` for downloading videos and image galleries. Runs as a Next.js 14 app on `http://localhost:3001`. Includes a companion browser extension that sends the active tab to your local instance with one click.

## What it does

- Paste one or more URLs, pick a quality preset, hit Start
- Auto-detects the right tool: `yt-dlp` for video sites, `gallery-dl` for image-gallery sites (configurable allow-list, plus an explicit override)
- Streams real-time progress (percent / speed / ETA / filename) over Server-Sent Events
- Quality presets: best, 1080p, 720p, 480p MP4, or audio-only MP3
- Optional full-playlist mode (yt-dlp)
- Per-host cookie support: drop a `<host>.txt` file into `cookies/` and it'll be used automatically; otherwise falls back to your Firefox cookies
- Persistent download history (localStorage, last 200)
- Browser extension (Manifest V3, Firefox-targeted via `gecko` settings) sends current page or a right-click link to the local instance via `?url=...` autostart

## Requirements

External binaries the API will look for (in order of search paths, then PATH):

- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) — required for video downloads
- [`gallery-dl`](https://github.com/mikf/gallery-dl) — required for image-gallery downloads
- `ffmpeg` — required by yt-dlp for merging/conversion. Default search path: `C:\ffmpeg\bin`

Default output folder: `~/Downloads` (overridable per-download in the UI).

## Run

```
npm install
npm run dev          # or double-click start-server.bat on Windows
```

Then open `http://localhost:3001`. The dev server binds `0.0.0.0`, so it's reachable from your LAN / Tailscale.

## Browser extension

Load `extension/` as an unpacked extension in Firefox (or any Chromium browser supporting MV3). The popup and right-click menu hand off URLs to the local UI.
