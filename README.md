# Lumetto

**Live Photos for your Windows screen.**

Press a hotkey and Lumetto saves a short clip of the moment: what happened just *before* you pressed it and just *after*. In the gallery, each moment looks like a photo. Hold <kbd>Space</kbd> and it comes to life, like Live Photos on iPhone.

It's handy for the "wait, did you see that?" moments in games, calls, streams or anywhere else, without running a screen recorder all day.

## Features

- **Captures before and after the press.** By default you get 1.5 s before and 1.5 s after the hotkey. Both lengths are adjustable.
- **Photo first, video on hold.** Each moment opens as the exact frame from when you pressed the hotkey. Hold <kbd>Space</kbd> (or hold the mouse on it) to play the clip, and let go to return to the photo.
- **Screenshot-style feedback.** The screen flashes softly white, the frame shrinks into a corner preview, and the preview plays the clip once it's saved. Click the preview to open that moment in the gallery.
- **Series.** If you press the hotkey again while the previous clip is still running, the moments are grouped into a series. While you hold Space, the clips flow into each other seamlessly at the same instant. When the series ends, the view goes back to its first photo.
- **Gallery.** Moments are grouped by day. You can browse with the arrow keys, scrub the timeline (a marker shows the exact moment of the press), export a GIF, copy the frame, show the file in its folder, or delete it to the Recycle Bin.
- **Lives in the tray.** It uses little memory, and you can pause the buffer at any time.
- **5 languages:** English, Русский, 简体中文, Español, 日本語. You can switch languages instantly, with no restart.

## How it works

Lumetto keeps a small rolling buffer of your screen:

1. The selected display is captured continuously and encoded to **VP9** on the fly with WebCodecs, hardware-accelerated where available.
2. Only the last few seconds of **already compressed** video stay in memory. That's a few megabytes, not hundreds.
3. When you press the hotkey, Lumetto takes the "before" part from the buffer, records the "after" part, and muxes both into a `.webm` file that you can seek through. The frame at the moment of the press is saved separately and becomes the photo.

Nothing is written to disk until you press the hotkey. Audio is not recorded.

The flash and the corner preview are excluded from screen capture, so they never end up in your clips (requires Windows 10 version 2004 or newer).

## Usage

| Action | How |
|---|---|
| Save a moment | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>L</kbd> (configurable) |
| Bring a photo to life | Hold <kbd>Space</kbd>, or hold the mouse on the photo or the LIVE button |
| Play a moment in the grid | Hover the card and hold <kbd>Space</kbd> |
| Previous / next | <kbd>←</kbd> / <kbd>→</kbd> |
| Delete | <kbd>Del</kbd> |
| Close viewer | <kbd>Esc</kbd> |
| Settings | <kbd>Ctrl</kbd> + <kbd>,</kbd> |

Moments are saved to `Videos\Lumetto`. Each one has three files:

- `<timestamp>.webm`: the clip (VP9)
- `<timestamp>.jpg`: the photo, i.e. the frame at the moment of the press
- `<timestamp>.json`: metadata (duration, resolution, press time)

## Settings

- Language
- Hotkey
- Seconds before and after the press (0.5 to 3 s)
- Quality: 720p, 1080p or native
- Frame rate: 24, 30 or 60 fps
- Display to capture
- Save folder
- Recording buffer on or off
- Flash on capture
- Corner preview
- Start with Windows

## Installation

### Build from source

Requirements: Windows 10 or 11, and [Node.js](https://nodejs.org) 20 or newer.

**The easy way:** double-click `build.bat`. It installs the dependencies, builds the app and opens the `dist` folder, which will contain:

- `Lumetto Setup 1.0.0.exe`: the installer
- `Lumetto-portable-1.0.0.exe`: a portable version that needs no installation

**Manually:**

```bash
npm install
npm start          # run in development
npm run dist       # build the installer and the portable .exe
```

If the build fails with a *symbolic link* error, run it as administrator or turn on **Developer Mode** in Windows Settings.

## Notes

- **Exclusive fullscreen games:** clips are saved normally, but the flash and the corner preview are not visible on top of the game. Borderless windowed mode works fully.
- **Migrating from LiveShot:** Lumetto used to be called LiveShot. On first launch it moves your old settings and renames `Videos\LiveShot` to `Videos\Lumetto` automatically.

## Tech

- [Electron](https://www.electronjs.org/)
- WebCodecs (VP9 / VP8) for real-time encoding
- A small built-in WebM muxer and GIF encoder

There are no native modules, no FFmpeg and no external services.

## License

MIT
