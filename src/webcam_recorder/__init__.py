"""A JupyterLab anywidget that records webcam video + microphone audio.

The widget shows a live, filtered preview of your webcam. Hit *Record* and it
captures the (post-processed) canvas stream together with the microphone into a
single WebM file. When you stop, the bytes are streamed back to Python and
written to disk automatically -- no manual download dance required.

    from webcam_recorder import WebcamRecorderWidget

    w = WebcamRecorderWidget(save_dir="recordings")
    w                       # display, then Start Camera -> Record
    w.last_saved_path       # -> '/abs/path/recordings/webcam_20260601_141233.webm'
    w.to_mp4()              # optional: transcode the last clip with ffmpeg

The brightness / contrast / saturation / grayscale sliders are *baked into* the
recording (the recorder captures the filtered canvas, not the raw camera), so
what you see is what you get.
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
from datetime import datetime

import anywidget
import traitlets as t

__version__ = "0.1.0"

_HERE = pathlib.Path(__file__).parent
_ESM = (_HERE / "static" / "widget.js").read_text(encoding="utf-8")
_CSS = (_HERE / "static" / "widget.css").read_text(encoding="utf-8")


class WebcamRecorderWidget(anywidget.AnyWidget):
    """Record webcam video + audio to disk, with live post-processing."""

    _esm = _ESM
    _css = _CSS

    # --- Controls (Python <-> JS) ---
    streaming = t.Bool(False).tag(sync=True)  # camera preview on/off
    recording = t.Bool(False).tag(sync=True)  # MediaRecorder active
    mirror = t.Bool(True).tag(sync=True)
    record_audio = t.Bool(True).tag(sync=True)
    fps = t.Int(30).tag(sync=True)

    # --- Live post-processing filters (baked into the recording) ---
    brightness = t.Float(1.0).tag(sync=True)
    contrast = t.Float(1.0).tag(sync=True)
    saturation = t.Float(1.0).tag(sync=True)
    grayscale = t.Float(0.0).tag(sync=True)

    # --- Saving ---
    save_dir = t.Unicode("recordings").tag(sync=True)
    filename_prefix = t.Unicode("webcam").tag(sync=True)
    last_saved_path = t.Unicode("").tag(sync=True)

    # --- Status / metrics (JS -> Python) ---
    status = t.Unicode("idle").tag(sync=True)
    elapsed_s = t.Float(0.0).tag(sync=True)
    width = t.Int(0).tag(sync=True)
    height = t.Int(0).tag(sync=True)

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self.on_msg(self._handle_custom_msg)

    # --- Imperative API ---
    def start(self) -> None:
        """Start the camera preview (subject to browser permission)."""
        self.streaming = True

    def stop(self) -> None:
        """Stop the camera preview (also stops any active recording)."""
        self.streaming = False

    def record(self) -> None:
        """Begin recording. Starts the camera first if needed."""
        self.streaming = True
        self.recording = True

    def stop_recording(self) -> None:
        """Stop recording and flush the clip to disk."""
        self.recording = False

    # --- Binary receive: JS hands us the finished recording ---
    def _handle_custom_msg(self, content: dict, buffers: list) -> None:
        if not isinstance(content, dict) or content.get("type") != "save":
            return
        if not buffers:
            return
        data = buffers[0]
        ext = str(content.get("ext", "webm"))

        out_dir = pathlib.Path(self.save_dir).expanduser()
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = out_dir / f"{self.filename_prefix}_{stamp}.{ext}"
        path.write_bytes(bytes(data))

        self.last_saved_path = str(path.resolve())
        self.status = "saved"

    # --- Optional post-processing helpers (require ffmpeg on PATH) ---
    def to_mp4(self, path: str | None = None, *, faststart: bool = True) -> str:
        """Transcode a recording to H.264/AAC MP4 (better for editing/sharing).

        Defaults to the most recent clip. Returns the output path. Raises if
        ffmpeg is not installed.
        """
        src = pathlib.Path(path or self.last_saved_path)
        if not src.exists():
            raise FileNotFoundError(f"No recording found at {src!s}")
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise RuntimeError(
                "ffmpeg not found on PATH. Install it (e.g. `brew install ffmpeg`)."
            )
        dst = src.with_suffix(".mp4")
        cmd = [
            ffmpeg, "-y", "-i", str(src),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k",
        ]
        if faststart:
            cmd += ["-movflags", "+faststart"]
        cmd.append(str(dst))
        subprocess.run(cmd, check=True, capture_output=True)
        return str(dst)

    def extract_audio(self, path: str | None = None) -> str:
        """Extract the audio track to a standalone .m4a (requires ffmpeg)."""
        src = pathlib.Path(path or self.last_saved_path)
        if not src.exists():
            raise FileNotFoundError(f"No recording found at {src!s}")
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise RuntimeError("ffmpeg not found on PATH.")
        dst = src.with_suffix(".m4a")
        subprocess.run(
            [ffmpeg, "-y", "-i", str(src), "-vn", "-c:a", "aac", "-b:a", "192k", str(dst)],
            check=True, capture_output=True,
        )
        return str(dst)


__all__ = ["WebcamRecorderWidget"]
