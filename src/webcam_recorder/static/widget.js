// Webcam recorder anywidget front-end (vanilla, no build step).
//
// Pipeline: getUserMedia -> <video> (hidden source) -> per-frame draw onto a
// <canvas> with CSS filters + mirror applied -> canvas.captureStream() gives a
// "post-processed" video track, which we mux with the live microphone track
// into a single MediaRecorder. On stop we ship the bytes to Python.

function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=h264,opus",
    "video/webm",
  ];
  for (const mt of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(mt)) return mt;
  }
  return "video/webm";
}

function render({ model, el }) {
  el.classList.add("wrec");
  el.innerHTML = `
    <div class="wrec-stage">
      <video class="wrec-video" autoplay playsinline muted></video>
      <canvas class="wrec-canvas"></canvas>
      <div class="wrec-msg">Camera is off</div>
      <div class="wrec-rec-badge" hidden><span class="wrec-rec-dot"></span><span class="wrec-time">0:00</span></div>
    </div>
    <div class="wrec-controls">
      <button class="wrec-btn wrec-cam">Start Camera</button>
      <button class="wrec-btn wrec-rec" disabled>Record</button>
      <select class="wrec-select" title="Camera" disabled></select>
      <label class="wrec-check"><input type="checkbox" class="wrec-mirror" checked /> Mirror</label>
      <label class="wrec-check"><input type="checkbox" class="wrec-audio" checked /> Mic</label>
      <span class="wrec-status"><span class="wrec-dot"></span><span class="wrec-status-text">idle</span></span>
    </div>
    <div class="wrec-filters">
      <label>Brightness <input type="range" class="wrec-brightness" min="0.2" max="2" step="0.05" value="1"></label>
      <label>Contrast <input type="range" class="wrec-contrast" min="0.2" max="2" step="0.05" value="1"></label>
      <label>Saturation <input type="range" class="wrec-saturation" min="0" max="2" step="0.05" value="1"></label>
      <label>Grayscale <input type="range" class="wrec-grayscale" min="0" max="1" step="0.05" value="0"></label>
      <button class="wrec-btn wrec-reset" type="button">Reset</button>
    </div>
    <div class="wrec-footer">
      <a class="wrec-download" download hidden>Download last clip</a>
      <span class="wrec-saved"></span>
    </div>
  `;

  const q = (sel) => {
    const node = el.querySelector(sel);
    if (!node) throw new Error("widget DOM missing " + sel);
    return node;
  };

  const video = q(".wrec-video");
  const canvas = q(".wrec-canvas");
  const ctx = canvas.getContext("2d");
  const msg = q(".wrec-msg");
  const recBadge = q(".wrec-rec-badge");
  const timeEl = q(".wrec-time");
  const camBtn = q(".wrec-cam");
  const recBtn = q(".wrec-rec");
  const select = q(".wrec-select");
  const mirrorInput = q(".wrec-mirror");
  const audioInput = q(".wrec-audio");
  const statusEl = q(".wrec-status");
  const downloadLink = q(".wrec-download");
  const savedEl = q(".wrec-saved");
  const filterInputs = {
    brightness: q(".wrec-brightness"),
    contrast: q(".wrec-contrast"),
    saturation: q(".wrec-saturation"),
    grayscale: q(".wrec-grayscale"),
  };

  let stream = null;        // raw getUserMedia stream (camera + mic)
  let recorder = null;
  let chunks = [];
  let rafId = null;
  let running = false;
  let recording = false;
  let timerId = null;
  let startTs = 0;
  let lastObjectUrl = null;
  const mimeType = pickMimeType();

  const setStatus = (s) => {
    statusEl.dataset.state = s;
    const text = statusEl.querySelector(".wrec-status-text");
    if (text) text.textContent = s;
    model.set("status", s);
    model.save_changes();
  };

  const filterString = () => {
    const b = model.get("brightness");
    const c = model.get("contrast");
    const s = model.get("saturation");
    const g = model.get("grayscale");
    return `brightness(${b}) contrast(${c}) saturate(${s}) grayscale(${g})`;
  };

  const drawLoop = () => {
    rafId = requestAnimationFrame(drawLoop);
    if (video.readyState < 2 || !video.videoWidth) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      model.set("width", w);
      model.set("height", h);
      model.save_changes();
    }
    ctx.save();
    ctx.filter = filterString();
    if (model.get("mirror")) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
  };

  const populateDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === "videoinput");
      select.innerHTML = "";
      const current =
        stream && stream.getVideoTracks()[0]
          ? stream.getVideoTracks()[0].getSettings().deviceId
          : null;
      for (const cam of cams) {
        const opt = document.createElement("option");
        opt.value = cam.deviceId;
        opt.textContent = cam.label || `Camera ${select.length + 1}`;
        if (cam.deviceId === current) opt.selected = true;
        select.appendChild(opt);
      }
      select.disabled = cams.length === 0;
    } catch (_) {
      /* enumerateDevices can fail before permission; ignore */
    }
  };

  const startCamera = async (deviceId) => {
    if (running && !deviceId) return;
    try {
      setStatus("requesting");
      const wantAudio = model.get("record_audio");
      const constraints = {
        video: deviceId
          ? { deviceId: { exact: deviceId } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: wantAudio,
      };
      const next = await navigator.mediaDevices.getUserMedia(constraints);
      if (stream) stream.getTracks().forEach((tr) => tr.stop());
      stream = next;
      video.srcObject = stream;
      await video.play();
      running = true;
      msg.style.display = "none";
      camBtn.textContent = "Stop Camera";
      camBtn.classList.add("wrec-btn-danger");
      recBtn.disabled = false;
      await populateDevices();
      if (rafId === null) drawLoop();
      setStatus("ready");
      if (!model.get("streaming")) {
        model.set("streaming", true);
        model.save_changes();
      }
    } catch (err) {
      setStatus("error");
      savedEl.textContent = "Error: " + (err && err.message ? err.message : err);
    }
  };

  const stopCamera = async () => {
    if (recording) stopRecording();
    running = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (stream) {
      stream.getTracks().forEach((tr) => tr.stop());
      stream = null;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    msg.style.display = "";
    camBtn.textContent = "Start Camera";
    camBtn.classList.remove("wrec-btn-danger");
    recBtn.disabled = true;
    setStatus("idle");
    if (model.get("streaming")) {
      model.set("streaming", false);
      model.save_changes();
    }
  };

  const fmtTime = (sec) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const startRecording = () => {
    if (recording || !running || !stream) return;
    const fps = model.get("fps") || 30;
    const canvasStream = canvas.captureStream(fps);
    const tracks = [...canvasStream.getVideoTracks()];
    if (model.get("record_audio")) {
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length) tracks.push(audioTracks[0]);
    }
    const mixed = new MediaStream(tracks);
    chunks = [];
    try {
      recorder = new MediaRecorder(mixed, { mimeType });
    } catch (_) {
      recorder = new MediaRecorder(mixed);
    }
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: mimeType });
      // Browser-side download link as a convenience / fallback.
      if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
      lastObjectUrl = URL.createObjectURL(blob);
      downloadLink.href = lastObjectUrl;
      downloadLink.download = `recording_${Date.now()}.webm`;
      downloadLink.hidden = false;
      // Ship bytes to Python to write to disk. model.send is
      // send(content, callbacks, buffers) -- buffers MUST be the 3rd arg.
      const buf = await blob.arrayBuffer();
      model.send({ type: "save", mime: mimeType, ext: "webm" }, undefined, [
        new DataView(buf),
      ]);
      setStatus("ready");
    };
    recorder.start();
    recording = true;
    startTs = performance.now();
    recBadge.hidden = false;
    recBtn.textContent = "Stop";
    recBtn.classList.add("wrec-btn-danger");
    setStatus("recording");
    if (!model.get("recording")) {
      model.set("recording", true);
      model.save_changes();
    }
    timerId = window.setInterval(() => {
      const sec = (performance.now() - startTs) / 1000;
      timeEl.textContent = fmtTime(sec);
      model.set("elapsed_s", sec);
      model.save_changes();
    }, 250);
  };

  const stopRecording = () => {
    if (!recording) return;
    recording = false;
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recBadge.hidden = true;
    recBtn.textContent = "Record";
    recBtn.classList.remove("wrec-btn-danger");
    setStatus("saving");
    if (model.get("recording")) {
      model.set("recording", false);
      model.save_changes();
    }
  };

  // --- DOM events ---
  camBtn.addEventListener("click", () => {
    void (running ? stopCamera() : startCamera());
  });
  recBtn.addEventListener("click", () => {
    if (recording) stopRecording();
    else startRecording();
  });
  select.addEventListener("change", () => {
    if (running) void startCamera(select.value);
  });
  mirrorInput.addEventListener("change", () => {
    model.set("mirror", mirrorInput.checked);
    model.save_changes();
  });
  audioInput.addEventListener("change", () => {
    model.set("record_audio", audioInput.checked);
    model.save_changes();
  });

  const bindFilter = (key, input) => {
    input.addEventListener("input", () => {
      model.set(key, parseFloat(input.value));
      model.save_changes();
    });
  };
  for (const [key, input] of Object.entries(filterInputs)) bindFilter(key, input);

  q(".wrec-reset").addEventListener("click", () => {
    const defaults = { brightness: 1, contrast: 1, saturation: 1, grayscale: 0 };
    for (const [key, val] of Object.entries(defaults)) {
      model.set(key, val);
      filterInputs[key].value = String(val);
    }
    model.save_changes();
  });

  // --- Model (Python -> JS) ---
  const onStreaming = () => {
    const want = model.get("streaming");
    if (want && !running) void startCamera();
    else if (!want && running) void stopCamera();
  };
  const onRecording = () => {
    const want = model.get("recording");
    if (want && !recording) startRecording();
    else if (!want && recording) stopRecording();
  };
  const onMirror = () => {
    mirrorInput.checked = model.get("mirror");
  };
  const onAudio = () => {
    audioInput.checked = model.get("record_audio");
  };
  const onFilter = (key) => () => {
    if (filterInputs[key]) filterInputs[key].value = String(model.get(key));
  };

  model.on("change:streaming", onStreaming);
  model.on("change:recording", onRecording);
  model.on("change:mirror", onMirror);
  model.on("change:record_audio", onAudio);
  const filterHandlers = {};
  for (const key of Object.keys(filterInputs)) {
    filterHandlers[key] = onFilter(key);
    model.on("change:" + key, filterHandlers[key]);
  }
  const onSaved = () => {
    const p = model.get("last_saved_path");
    if (p) savedEl.textContent = "Saved: " + p;
  };
  model.on("change:last_saved_path", onSaved);

  // Reflect initial state into the DOM.
  mirrorInput.checked = model.get("mirror");
  audioInput.checked = model.get("record_audio");
  for (const [key, input] of Object.entries(filterInputs)) {
    input.value = String(model.get(key));
  }

  // --- Cleanup ---
  return () => {
    model.off("change:streaming", onStreaming);
    model.off("change:recording", onRecording);
    model.off("change:mirror", onMirror);
    model.off("change:record_audio", onAudio);
    model.off("change:last_saved_path", onSaved);
    for (const key of Object.keys(filterHandlers)) {
      model.off("change:" + key, filterHandlers[key]);
    }
    if (timerId !== null) clearInterval(timerId);
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach((tr) => tr.stop());
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
  };
}

export default { render };
