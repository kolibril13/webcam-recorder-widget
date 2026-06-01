# webcam-recorder-widget

A Jupyter [anywidget](https://anywidget.dev) that records **video + audio** from
your webcam and writes the clip straight to disk from Python — with live,
WYSIWYG post-processing.

It's a sibling to the gesture-recognizer widget: same anywidget spirit, but no
build step. The front-end is plain browser APIs (`getUserMedia`,
`canvas.captureStream`, `MediaRecorder`) inlined into the Python package, so
`pip install -e .` is all you need.

## How it works

```
getUserMedia (camera + mic)
      │
      ▼
 <video> (hidden source)
      │  per-frame draw with CSS filters + mirror
      ▼
 <canvas> ──► canvas.captureStream()  ── video track ─┐
                                                       ├─► MediaRecorder ─► WebM
 microphone ─────────────────────────── audio track ─┘        │
                                                               ▼
                                                  bytes streamed to Python
                                                               ▼
                                                     written to save_dir/
```

Because the recorder captures the **filtered canvas** (not the raw camera), the
brightness / contrast / saturation / grayscale sliders are baked into the saved
file. What you see is what you get.

## Install

```bash
cd webcam-recorder-widget
pip install -e .
# optional, for the post-processing helpers:
#   brew install ffmpeg   (macOS)  |  apt install ffmpeg  (Linux)
```

## Use

```python
from webcam_recorder import WebcamRecorderWidget

w = WebcamRecorderWidget(save_dir="recordings", filename_prefix="take")
w                       # display the cell, then: Start Camera → Record → Stop
```

The recording is saved automatically when you hit **Stop**:

```python
w.last_saved_path       # '/abs/.../recordings/take_20260601_141233.webm'
```

### Drive it from Python

Every control is a traitlet, so you can script it (great for timed captures):

```python
import time
w.record()              # start camera (if needed) + recording
time.sleep(5)
w.stop_recording()      # flush to disk
print(w.last_saved_path)
```

| Trait | Meaning |
|---|---|
| `streaming` | camera preview on/off |
| `recording` | MediaRecorder active |
| `mirror` | mirror the preview/recording |
| `record_audio` | include the microphone track |
| `fps` | canvas capture frame rate (default 30) |
| `brightness` / `contrast` / `saturation` / `grayscale` | live filters (baked in) |
| `save_dir` / `filename_prefix` | where/how files are named |
| `last_saved_path` | absolute path of the most recent clip |
| `elapsed_s`, `width`, `height`, `status` | read-only status |

### Post-processing (optional, needs ffmpeg)

WebM is great for capture but awkward for editing/sharing. Convert when you're
done:

```python
w.to_mp4()              # -> H.264/AAC .mp4 next to the .webm, +faststart
w.extract_audio()       # -> standalone .m4a of just the audio
```

## Notes & gotchas

- **HTTPS / localhost only.** Browsers only grant camera+mic on secure origins.
  Local Jupyter (`localhost`) counts as secure.
- **Permissions.** The browser prompts for camera and mic the first time. If you
  untick *Mic*, recordings are video-only and no mic permission is requested.
- **Format.** Output is WebM (VP9/VP8 + Opus, whichever the browser supports).
  Use `to_mp4()` for an H.264 MP4.
- The clip is held in memory in the browser until you stop, then transferred in
  one message — fine for short-to-medium takes; very long recordings will use
  proportional memory.
