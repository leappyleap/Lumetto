# Lumetto

**Live Photos for your Windows screen.**

Press a shortcut, and Lumetto saves a short clip of what just happened on your screen — the seconds *before* you pressed it and the seconds after. It works like a Live Photo on an iPhone: every moment opens as a still photo, and it comes to life when you hold <kbd>Space</kbd>.

It's for anything you'd otherwise miss — a clutch play in a game, a bug that appears for half a second, a funny moment on a call. You react, press the key, and the moment is already saved.

---

## Highlights

- **Captures the past.** Lumetto keeps a few seconds of your screen in memory, so the clip starts *before* you pressed the shortcut. By default it saves 1.5 s before and 1.5 s after.
- **Feels like taking a screenshot on an iPhone.** A soft white flash, then the frame shrinks into a preview in the corner of your screen. Once the clip is saved, the preview comes to life. Click it to jump straight to that moment.
- **A photo first, a video when you want it.** In the gallery, every moment is a still frame taken exactly when you pressed the key. Hold <kbd>Space</kbd> (or hold the mouse on the photo) to play it.
- **Series.** If you press the shortcut again while the previous clip is still recording, the clips are linked. Holding <kbd>Space</kbd> plays them as one continuous video, cross-fading at the exact same instant. When the series ends, it returns to its first photo.
- **Light on your PC.** Clips are encoded in H.264 on your graphics card (NVENC, AMF or Quick Sync), so Lumetto typically uses around 3% CPU in the background. Without a supported GPU, it falls back to software encoding automatically.
- **Sound, if you want it.** You can record system sound, your microphone, or both mixed together. Both are off by default.
- **High-quality GIF export.** 720p at 20 fps, with a separate palette for each frame and dithering, so gradients stay smooth.
- **Five languages:** English, Русский, 简体中文, Español and 日本語. You choose one on first launch and can change it at any time.
- **Private by design.** Nothing is written to disk until you press the shortcut. Lumetto doesn't use the network.

---

## Requirements

- Windows 10 version 2004 or later, or Windows 11
- Building from source requires [Node.js](https://nodejs.org) 20 or later (LTS recommended)

---

## Getting started

### Build the app

1. Install [Node.js](https://nodejs.org) (LTS).
2. Double-click **`build.bat`**. It installs dependencies and builds the app, and then opens the `dist` folder with:
   - `Lumetto Setup 1.0.0.exe` — the installer
   - `Lumetto-portable-1.0.0.exe` — a portable version that needs no installation

To run Lumetto without building, double-click **`start.bat`**.

### Or use the command line

```bash
npm install
npm start        # run in development
npm run dist     # build the installer and the portable .exe
```

> **If the build fails with a "symbolic link" error,** run `build.bat` as administrator, or turn on *Developer Mode* in Windows Settings → Privacy & security → For developers.

---

## Using Lumetto

Lumetto runs in the system tray. Press **<kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>L</kbd>** in any app or game to save a moment. You can change the shortcut in Settings.

### Gallery and viewer

| Action | How |
|---|---|
| Bring a photo to life | Hold <kbd>Space</kbd>, hold the mouse on the photo, or hold the **LIVE** button |
| Preview from the grid | Hover over a card and hold <kbd>Space</kbd> |
| Previous / next moment | <kbd>←</kbd> / <kbd>→</kbd> |
| Delete (to Recycle Bin) | <kbd>Del</kbd> |
| Close the viewer | <kbd>Esc</kbd> |
| Open Settings | <kbd>Ctrl</kbd> + <kbd>,</kbd> |

The accent mark on the timeline shows the exact moment you pressed the shortcut. The viewer also lets you export a GIF, copy the frame to the clipboard, show the file in its folder, and mute or unmute clips that have sound.

The status indicator in the top bar shows the buffer's resolution and frame rate, and **GPU** when your graphics card is doing the encoding. Click it to pause the buffer. While paused, the screen isn't captured at all.

---

## Settings

| Setting | Options |
|---|---|
| Language | English, Русский, 简体中文, Español, 日本語 |
| Shortcut | Any combination with <kbd>Ctrl</kbd>, <kbd>Alt</kbd> or <kbd>Shift</kbd>, or a single <kbd>F1</kbd>–<kbd>F12</kbd>, <kbd>Print Screen</kbd> or <kbd>Insert</kbd> |
| Before / after the press | 0.5 – 3 s each |
| Quality | 720p, 1080p or native resolution |
| Frame rate | 24, 30 or 60 fps |
| Display | Which monitor to capture |
| Folder | Where moments are saved (default: `Videos\Lumetto`) |
| Recording buffer | On / off |
| Flash on capture | On / off |
| Corner preview | On / off |
| System sound | Off by default |
| Microphone | Off by default; choose the input device |
| Start with Windows | Off by default |

> **About the microphone.** To capture the seconds *before* you press the shortcut, the microphone has to listen all the time while it's enabled, so Windows will show it as in use. Audio is only saved when you press the shortcut.

---

## How it works

- **Ring buffer of compressed video.** A hidden window captures the selected display and encodes it right away with WebCodecs. Only the last few seconds of *already compressed* frames are kept in memory, a couple of megabytes rather than hundreds.
- **No extra copies.** The screen capture scales frames to the target resolution and hands them straight to the encoder.
- **Precise clips.** A keyframe every quarter-second lets each clip start almost exactly where you asked. Lumetto writes MP4 files itself, with the index at the front, so clips open and seek instantly in any player.
- **The exact moment.** The frame at the instant you pressed the key is saved separately. It becomes the photo you see in the gallery.
- **Invisible overlay.** The flash and the corner preview are excluded from screen capture, so they never appear in your clips.
- **Audio** goes into the same kind of ring buffer (AAC or Opus). System sound and the microphone are mixed into a single track.

Each moment is saved as three files in your folder:

```
20261018-223047-512.mp4    the clip (H.264, with audio if enabled)
20261018-223047-512.jpg    the photo: the frame at the moment you pressed the shortcut
20261018-223047-512.json   metadata: duration, resolution, timing
```

---

## Troubleshooting

- **The flash doesn't appear over a game.** Games in *exclusive* fullscreen mode draw over everything, including Lumetto's overlay. The clip is still saved. Switch the game to *borderless window* to see the flash.
- **No "GPU" in the status indicator.** Your graphics card or driver doesn't offer hardware H.264 encoding, so Lumetto encodes in software. Lower the quality to 720p or the frame rate to 24 fps to reduce the load.
- **The microphone isn't recorded.** Check *Windows Settings → Privacy & security → Microphone* and allow desktop apps to use it.
- **Something else.** Lumetto keeps a short log at `%APPDATA%\Lumetto\lumetto.log` (paste the path into File Explorer's address bar). It records shortcut presses, capture status, the encoder in use and graphics resets.

---

## Project structure

```
src/
  main.js            app lifecycle, tray, global shortcut, settings, file storage
  preload.js         safe bridge between windows and the main process
  ui/
    index.html       gallery, viewer, settings, welcome screen
    app.js           gallery logic (Live Photo playback, series, GIF export)
    styles.css
    capture.js       hidden capture window: ring buffer, encoders, clip assembly
    overlay.js       flash and corner preview
    i18n.js          translations for all five languages
    lib/
      mp4.js         MP4 muxer (H.264 + AAC/Opus)
      webm.js        WebM muxer (VP8/VP9 + Opus fallback)
      gif-worker.js  GIF encoder, runs in a background thread
assets/              app and tray icons
build.bat            one-click build for Windows
start.bat            one-click run
```

Built with [Electron](https://www.electronjs.org/). No other runtime dependencies.

---

## License

MIT
