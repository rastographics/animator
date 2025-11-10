import './style.css';

// Register a no-cache service worker so the app is installable as a PWA.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    try {
      const scopeURL = new URL(import.meta.env.BASE_URL, window.location.href);
      const swURL = new URL('sw.js', scopeURL);
      navigator.serviceWorker.register(swURL.href, { scope: scopeURL.href }).catch((err) => {
        console.error('Service worker registration failed:', err);
      });
    } catch (err) {
      console.error('Service worker registration error:', err);
    }
  });
}

(() => {
  const supportsFileSystemAccess = typeof window.showDirectoryPicker === 'function';

  const state = {
    stream: null,
    facing: 'environment',
    frames: [],          // { preview: ImageBitmap, fileHandle?, filename?, memoryBlob? }
    thumbs: [],          // data URLs for quick thumb rendering
    slideshowTimer: null,
    slideIndex: 0,
    delay: 500,
    stageSize: { w: 1280, h: 720 },
    isPaused: false,
    ghostOpacity: 0.5,
    ghostSecondLayerEnabled: true,
    captureDir: null,
    captureMode: supportsFileSystemAccess ? 'disk' : 'memory',
    memoryNoticeShown: false,
  };

  const ghostStops = [0, 25, 50, 75, 90];
  const SECOND_LAYER_OPACITY_RATIO = 1;
  const PREVIEW_MAX_DIMENSION = 640;
  const CAPTURE_MIME = 'image/jpeg';
  const CAPTURE_QUALITY = 0.98;
  const EXPORT_VIDEO_FPS = 30;

  // Elements
  const el = (id) => document.getElementById(id);
  const cam = el('cam');
  const camTap = el('camTap');
  const camHint = el('camHint');
  const stage = el('stage');
  const ctx = stage.getContext('2d');
  const slideshowTap = el('slideshowTap');
  const slideshowHint = el('slideshowHint');
  const btnFlip = el('btnFlip');
  const btnClear = el('btnClear');
  const btnExportGif = el('btnExportGif');
  const btnExportVideo = el('btnExportVideo');
  const thumbs = el('thumbs');
  const frameCount = el('frameCount');
  const statusBadge = el('status');
  const speedControl = el('speedControl');
  const speedValue = el('speedValue');
  const gifWidth = el('gifWidth');
  const loops = el('loops');
  const loopsVid = el('loopsVid');
  const downloads = el('downloads');
  const ghostOpacityControl = el('ghostOpacityControl');
  const ghostOpacityValue = el('ghostOpacityValue');
  const ghostCanvas = el('ghostOverlay');
  const ghostCtx = ghostCanvas ? ghostCanvas.getContext('2d') : null;
  const ghostSecondLayerToggle = el('ghostSecondLayerToggle');

  // Utils
  const setStatus = (s) => (statusBadge.textContent = s);
  const updateCount = () => (frameCount.textContent = `${state.frames.length} frame${state.frames.length === 1 ? '' : 's'}`);
  const aspectFit = (srcW, srcH, dstW, dstH) => {
    const srcAR = srcW / srcH, dstAR = dstW / dstH;
    if (srcAR > dstAR) {
      const w = dstW, h = Math.round(dstW / srcAR);
      return { sx: 0, sy: 0, sw: srcW, sh: srcH, dx: 0, dy: Math.round((dstH - h) / 2), dw: w, dh: h };
    } else {
      const h = dstH, w = Math.round(dstH * srcAR);
      return { sx: 0, sy: 0, sw: srcW, sh: srcH, dx: Math.round((dstW - w) / 2), dy: 0, dw: w, dh: h };
    }
  };
  const syncStageDimensions = () => {
    if (!stage) return;
    stage.width = state.stageSize.w;
    stage.height = state.stageSize.h;
    stage.style.aspectRatio = `${state.stageSize.w} / ${state.stageSize.h}`;
    stage.style.width = '100%';
    stage.style.height = 'auto';
  };
  const getSpeedMs = () => {
    if (!speedControl) return 500;
    return Math.max(100, Number(speedControl.value) || 500);
  };
  const updateSpeedLabel = () => {
    const ms = getSpeedMs();
    if (speedValue) speedValue.textContent = `${ms} ms`;
    return ms;
  };
  const updateSlideshowHint = () => {
    if (!slideshowHint || !slideshowTap) return;
    const hasLoop = state.frames.length >= 2;
    const isPlaying = !!state.slideshowTimer;
    slideshowTap.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
    slideshowTap.setAttribute('aria-disabled', hasLoop ? 'false' : 'true');
    if (!hasLoop) {
      slideshowHint.textContent = 'Add 2+ frames to enable slideshow';
      return;
    }
    slideshowHint.textContent = isPlaying ? 'Tap preview to pause' : 'Paused — tap to resume';
  };
  const snapGhostOpacity = (val) => {
    if (!Number.isFinite(val)) return ghostStops[0];
    return ghostStops.reduce((closest, stop) => {
      return Math.abs(stop - val) < Math.abs(closest - val) ? stop : closest;
    }, ghostStops[0]);
  };

  function canvasToBlob(canvas, type = CAPTURE_MIME, quality = CAPTURE_QUALITY) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Could not create image blob.'));
        }
      }, type, quality);
    });
  }

  async function ensureDirectoryPermission(handle, mode = 'readwrite') {
    if (!handle || typeof handle.queryPermission !== 'function') return !!handle;
    const opts = { mode };
    try {
      const current = await handle.queryPermission(opts);
      if (current === 'granted') return true;
      const requested = await handle.requestPermission(opts);
      return requested === 'granted';
    } catch (err) {
      console.warn('Permission check failed', err);
      return false;
    }
  }

  function enterMemoryCaptureMode(reason, { notify = false } = {}) {
    if (state.captureMode !== 'memory') {
      state.captureMode = 'memory';
    }
    if (notify && !state.memoryNoticeShown) {
      alert('Saving to disk is unavailable; snaps will stay in memory for this session.');
      state.memoryNoticeShown = true;
    }
    if (reason) setStatus(reason);
  }

  async function ensureCaptureDirectory() {
    if (state.captureMode !== 'disk') {
      throw new Error('capture-mode-memory');
    }
    if (state.captureDir) {
      const stillGranted = await ensureDirectoryPermission(state.captureDir);
      if (stillGranted) return state.captureDir;
    }
    if (!supportsFileSystemAccess || typeof window.showDirectoryPicker !== 'function') {
      throw new Error('directory-picker-unavailable');
    }
    setStatus('choose folder…');
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    const ok = await ensureDirectoryPermission(dir);
    if (!ok) {
      throw new Error('directory-permission-denied');
    }
    state.captureDir = dir;
    setStatus('folder ready');
    return dir;
  }

  async function persistFrameBlob(blob, dirHandle) {
    const directory = dirHandle || await ensureCaptureDirectory();
    const filename = `frame_${Date.now()}_${Math.random().toString(16).slice(2)}.jpg`;
    const fileHandle = await directory.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return { fileHandle, filename };
  }

  async function createPreviewBitmap(sourceCanvas) {
    const { width, height } = sourceCanvas;
    if (!width || !height) return null;
    const maxDim = PREVIEW_MAX_DIMENSION;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));
    if (scale === 1) {
      return await createImageBitmap(sourceCanvas);
    }
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(sourceCanvas, {
          resizeWidth: targetW,
          resizeHeight: targetH,
          resizeQuality: 'high'
        });
      } catch (err) {
        console.warn('Resize via createImageBitmap failed, falling back to canvas scaling.', err);
      }
    }
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = targetW;
    previewCanvas.height = targetH;
    const pctx = previewCanvas.getContext('2d');
    pctx.drawImage(sourceCanvas, 0, 0, targetW, targetH);
    return await createImageBitmap(previewCanvas);
  }

  function drawBitmapToContext(bmp, context, targetW, targetH) {
    if (!bmp || !context) return;
    context.fillStyle = '#000';
    context.fillRect(0, 0, targetW, targetH);
    const box = aspectFit(bmp.width, bmp.height, targetW, targetH);
    context.drawImage(
      bmp,
      box.sx, box.sy, box.sw, box.sh,
      box.dx, box.dy, box.dw, box.dh
    );
  }

  async function deleteSavedFrameFile(frame) {
    if (!frame || !frame.filename) return;
    const dir = state.captureDir;
    if (!dir || typeof dir.removeEntry !== 'function') return;
    try {
      await dir.removeEntry(frame.filename);
    } catch (err) {
      console.warn('Unable to remove saved frame', err);
    }
  }

  async function loadFullResolutionBitmaps(options = {}) {
    const { preferPreviews = false } = options;
    const entries = [];
    let usedFallback = false;
    let usedPreview = false;
    for (const frame of state.frames) {
      let bmp = null;
      let volatile = false;
      if (preferPreviews && frame?.preview) {
        bmp = frame.preview;
        usedPreview = true;
      }
      if (!bmp) {
        if (frame?.fileHandle?.getFile) {
          try {
            const file = await frame.fileHandle.getFile();
            bmp = await createImageBitmap(file);
            volatile = true;
          } catch (err) {
            console.warn('Failed to load full-resolution frame from disk', err);
          }
        }
        if (!bmp && frame?.memoryBlob) {
          try {
            bmp = await createImageBitmap(frame.memoryBlob);
            volatile = true;
          } catch (err) {
            console.warn('Failed to recreate frame from in-memory blob', err);
          }
        }
      }
      if (!bmp && frame?.preview) {
        bmp = frame.preview;
        usedFallback = true;
      }
      if (bmp) {
        entries.push({ bmp, volatile });
      }
    }
    return { entries, usedFallback, usedPreview };
  }

  const syncGhostDimensions = () => {
    if (!ghostCanvas || !cam.videoWidth || !cam.videoHeight) return;
    ghostCanvas.width = cam.videoWidth;
    ghostCanvas.height = cam.videoHeight;
  };

  const updateCamAspectRatio = () => {
    if (!camTap || !cam || !cam.videoWidth || !cam.videoHeight) return;
    const ratio = `${cam.videoWidth} / ${cam.videoHeight}`;
    camTap.style.setProperty('--cam-ar', ratio);
    cam.style.aspectRatio = ratio;
    if (ghostCanvas) ghostCanvas.style.aspectRatio = ratio;
  };

  const refreshGhostOverlay = () => {
    if (!ghostCanvas || !ghostCtx) return;
    const baseOpacity = state.ghostOpacity;
    const overlays = [];
    const lastIndex = state.frames.length - 1;
    if (state.ghostSecondLayerEnabled && lastIndex - 1 >= 0) {
      const prevFrame = state.frames[lastIndex - 1];
      if (prevFrame?.preview) {
        overlays.push({
          bmp: prevFrame.preview,
          opacity: Math.min(1, Math.max(0, baseOpacity * SECOND_LAYER_OPACITY_RATIO))
        });
      }
    }
    if (lastIndex >= 0) {
      const latestFrame = state.frames[lastIndex];
      if (latestFrame?.preview) {
        overlays.push({ bmp: latestFrame.preview, opacity: baseOpacity });
      }
    }
    const shouldShow = overlays.some(layer => layer.opacity > 0 && layer.bmp);
    if (!shouldShow) {
      ghostCtx.clearRect(0, 0, ghostCanvas.width || 0, ghostCanvas.height || 0);
      ghostCanvas.classList.add('opacity-0');
      ghostCanvas.setAttribute('aria-hidden', 'true');
      return;
    }
    if (!ghostCanvas.width || !ghostCanvas.height) {
      syncGhostDimensions();
    }
    const targetW = ghostCanvas.width || state.stageSize.w;
    const targetH = ghostCanvas.height || state.stageSize.h;
    ghostCtx.clearRect(0, 0, targetW, targetH);
    overlays.forEach(layer => {
      if (!layer.bmp) return;
      const box = aspectFit(layer.bmp.width, layer.bmp.height, targetW, targetH);
      ghostCtx.globalAlpha = layer.opacity;
      ghostCtx.drawImage(
        layer.bmp,
        box.sx, box.sy, box.sw, box.sh,
        box.dx, box.dy, box.dw, box.dh
      );
    });
    ghostCtx.globalAlpha = 1;
    ghostCanvas.classList.remove('opacity-0');
    ghostCanvas.removeAttribute('aria-hidden');
  };

  syncStageDimensions();

  // Camera control
  async function startCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach(t => t.stop());
    }
    try {
      setStatus('requesting camera…');
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: state.facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      cam.srcObject = state.stream;
      await cam.play();
      syncGhostDimensions();
      updateCamAspectRatio();
      refreshGhostOverlay();

      // Initialize stage size to match the camera aspect (landscape default with letterbox in UI)
      const vW = cam.videoWidth || 1280;
      const vH = cam.videoHeight || 720;
      const maxDim = 1280;
      const scale = Math.min(1, maxDim / Math.max(vW, vH));
      state.stageSize = {
        w: Math.round(vW * scale) || 1280,
        h: Math.round(vH * scale) || 720
      };
      syncStageDimensions();
      setStatus('camera ready');
    } catch (err) {
      console.error(err);
      setStatus('camera error (check permissions/HTTPS)');
      alert('Could not access camera. Ensure you are on HTTPS and granted permission.');
    }
  }

  function flipCamera() {
    state.facing = state.facing === 'environment' ? 'user' : 'environment';
    startCamera();
  }

  // Snap current video frame
  async function snap() {
    if (!cam.videoWidth) return;

    // Draw to a temp canvas sized like the video to avoid scaling artifacts
    const temp = document.createElement('canvas');
    temp.width = cam.videoWidth;
    temp.height = cam.videoHeight;
    const tctx = temp.getContext('2d', { willReadFrequently: false });
    tctx.drawImage(cam, 0, 0);

    let blob;
    try {
      blob = await canvasToBlob(temp);
    } catch (err) {
      console.error('Failed to encode capture', err);
      alert('Unable to capture that frame. Please try again.');
      setStatus('capture failed');
      return;
    }

    let useDisk = state.captureMode === 'disk';
    let dir = null;
    if (useDisk) {
      try {
        dir = await ensureCaptureDirectory();
      } catch (err) {
        if (err?.name === 'AbortError') {
          setStatus('folder required');
          return;
        }
        console.warn('Capture folder unavailable; switching to memory mode.', err);
        useDisk = false;
        enterMemoryCaptureMode('memory capture (disk unavailable)', { notify: true });
      }
    }

    let saved = null;
    if (useDisk && dir) {
      try {
        saved = await persistFrameBlob(blob, dir);
      } catch (err) {
        console.error('Failed to persist frame', err);
        useDisk = false;
        enterMemoryCaptureMode('memory capture (disk write failed)', { notify: true });
      }
    }

    let preview;
    try {
      preview = await createPreviewBitmap(temp);
    } catch (err) {
      console.error('Preview generation failed', err);
      alert('Unable to generate a preview for that snap.');
      setStatus('preview error');
      if (saved?.filename) await deleteSavedFrameFile(saved);
      return;
    }
    if (!preview) {
      if (saved?.filename) await deleteSavedFrameFile(saved);
      alert('Preview frame missing; cannot continue.');
      return;
    }

    const record = { preview };
    if (useDisk && saved) {
      record.fileHandle = saved.fileHandle;
      record.filename = saved.filename;
    } else {
      record.memoryBlob = blob;
    }

    state.frames.push(record);
    if (state.frames.length === 1 && camHint) {
      camHint.classList.add('hidden');
      camHint.setAttribute('aria-hidden', 'true');
    }

    // Thumb for UI
    const fit = document.createElement('canvas');
    fit.width = 160; fit.height = 160;
    const fctx = fit.getContext('2d');
    const fitBox = aspectFit(preview.width, preview.height, 160, 160);
    fctx.fillStyle = '#000'; fctx.fillRect(0,0,160,160);
    fctx.drawImage(preview, fitBox.sx, fitBox.sy, fitBox.sw, fitBox.sh, fitBox.dx, fitBox.dy, fitBox.dw, fitBox.dh);
    const url = fit.toDataURL('image/jpeg', 0.9);
    state.thumbs.push(url);

    renderThumbs();
    updateCount();

    // If first frame, show it. If 2+, (re)start slideshow.
    if (state.frames.length === 1) drawFrame(record);
    if (state.frames.length >= 2) startSlideshow();
    updateSlideshowHint();
    refreshGhostOverlay();
    const savedStatus = record.fileHandle ? 'saved to disk' : 'saved (memory only)';
    setStatus(savedStatus);
  }

  function renderThumbs() {
    thumbs.innerHTML = '';
    state.thumbs.forEach((src, i) => {
      const img = document.createElement('img');
      img.src = src;
      img.className = 'thumb w-full rounded-lg border border-white/10 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70';
      img.title = `Remove frame ${i + 1}`;
      img.setAttribute('role', 'button');
      img.tabIndex = 0;
      img.setAttribute('aria-label', `Remove frame ${i + 1}`);
      const remove = () => removeFrameAt(i);
      img.addEventListener('click', remove);
      img.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          remove();
        }
      });
      thumbs.appendChild(img);
    });
  }

  function removeFrameAt(index) {
    if (index < 0 || index >= state.frames.length) return;
    const wasPlaying = !!state.slideshowTimer;
    const [removed] = state.frames.splice(index, 1);
    if (removed?.preview && typeof removed.preview.close === 'function') {
      removed.preview.close();
    }
    if (removed) removed.memoryBlob = null;
    deleteSavedFrameFile(removed);
    state.thumbs.splice(index, 1);
    if (state.slideIndex >= state.frames.length) {
      state.slideIndex = Math.max(0, state.frames.length - 1);
    }
    updateCount();
    renderThumbs();

    if (state.frames.length === 0) {
      stopSlideshow();
      ctx.clearRect(0, 0, stage.width, stage.height);
      if (camHint) {
        camHint.classList.remove('hidden');
        camHint.removeAttribute('aria-hidden');
      }
      setStatus('no frames');
    } else {
      if (state.frames.length < 2) {
        stopSlideshow();
      } else if (wasPlaying) {
        startSlideshow(true);
      }
      const nextFrame = state.frames[state.slideIndex % state.frames.length];
      drawFrame(nextFrame);
      setStatus('frame removed');
    }

    refreshGhostOverlay();
    updateSlideshowHint();
  }

  // Draw a single ImageBitmap to stage (letterboxed)
  function drawFrame(frameLike) {
    const bmp = frameLike?.preview || frameLike;
    if (!bmp) return;
    const { w, h } = state.stageSize;
    drawBitmapToContext(bmp, ctx, w, h);
  }

  function startSlideshow(keepIndex = false) {
    stopSlideshow(true);
    const delay = updateSpeedLabel();
    state.delay = delay;
    setStatus(`slideshow ${delay}ms`);
    if (!keepIndex) state.slideIndex = 0;
    state.slideshowTimer = setInterval(() => {
      if (state.frames.length === 0) return;
      const frame = state.frames[state.slideIndex % state.frames.length];
      drawFrame(frame);
      state.slideIndex++;
    }, delay);
    state.isPaused = false;
    updateSlideshowHint();
  }

  function stopSlideshow(preserveState = false) {
    if (state.slideshowTimer) {
      clearInterval(state.slideshowTimer);
      state.slideshowTimer = null;
    }
    if (!preserveState) state.isPaused = false;
    updateSlideshowHint();
  }

  function clearAll() {
    stopSlideshow();
    const removedFrames = state.frames.slice();
    state.frames = [];
    state.thumbs = [];
    state.slideIndex = 0;
    removedFrames.forEach(frame => {
      if (frame?.preview && typeof frame.preview.close === 'function') {
        frame.preview.close();
      }
      if (frame) frame.memoryBlob = null;
      deleteSavedFrameFile(frame);
    });
    updateCount();
    renderThumbs();
    ctx.clearRect(0, 0, stage.width, stage.height);
    refreshGhostOverlay();
    if (camHint) {
      camHint.classList.remove('hidden');
      camHint.removeAttribute('aria-hidden');
    }
    setStatus('cleared');
    updateSlideshowHint();
  }

  function handleCamTap() {
    if (!state.stream || !state.stream.active) {
      startCamera();
      return;
    }
    snap();
  }

  function handleCamKey(e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      handleCamTap();
    }
  }

  function handleSpeedChange() {
    const ms = updateSpeedLabel();
    state.delay = ms;
    if (state.frames.length >= 2 && state.slideshowTimer) {
      startSlideshow(true);
    }
  }

  function toggleSlideshow() {
    if (state.frames.length < 2) return;
    if (state.slideshowTimer) {
      stopSlideshow(true);
      state.isPaused = true;
      setStatus('slideshow paused');
    } else {
      state.isPaused = false;
      startSlideshow(true);
    }
    updateSlideshowHint();
  }

  function handleSlideshowTap() {
    if (state.frames.length < 2) return;
    toggleSlideshow();
  }

  function handleSlideshowKey(e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      handleSlideshowTap();
    }
  }

  function updateGhostOpacityLabel() {
    if (!ghostOpacityValue || !ghostOpacityControl) return;
    ghostOpacityValue.textContent = `${ghostOpacityControl.value}%`;
  }

  function handleGhostOpacityChange() {
    if (!ghostOpacityControl) return;
    const snapped = snapGhostOpacity(Number(ghostOpacityControl.value) || 0);
    ghostOpacityControl.value = snapped;
    state.ghostOpacity = snapped / 100;
    updateGhostOpacityLabel();
    refreshGhostOverlay();
  }

  function handleGhostSecondLayerToggle() {
    if (!ghostSecondLayerToggle) return;
    state.ghostSecondLayerEnabled = ghostSecondLayerToggle.checked;
    refreshGhostOverlay();
  }

  // Export GIF
  async function exportGIF() {
    if (state.frames.length === 0) {
      alert('Snap at least 1 frame first.');
      return;
    }
    const delay = getSpeedMs();
    const repeat = Math.max(1, Number(loops.value) || 1);
    const targetW = Math.max(64, Number(gifWidth.value) || 640);

    const preferPreviews = targetW <= PREVIEW_MAX_DIMENSION;
    const { entries, usedFallback, usedPreview } = await loadFullResolutionBitmaps({ preferPreviews });
    if (!entries.length) {
      alert('Unable to load frames from disk.');
      return;
    }
    const ref = entries[0].bmp;
    const ar = ref.width / ref.height || 1;
    const targetH = Math.max(1, Math.round(targetW / ar));

    setStatus('rendering GIF…');

    // Prepare a working canvas at export size
    const work = document.createElement('canvas');
    work.width = targetW; work.height = targetH;
    const wctx = work.getContext('2d');

    const gif = new GIF({
      workers: 2,
      quality: 10,         // lower = better quality, bigger file
      workerScript: 'assets/gif.worker.js',
      width: targetW,
      height: targetH
    });

    const cleanup = () => {
      entries.forEach(entry => {
        if (entry.volatile && entry.bmp?.close) {
          entry.bmp.close();
        }
      });
    };

    try {
      // Add frames (repeat sequence `repeat` times)
      for (let r = 0; r < repeat; r++) {
        for (const entry of entries) {
          drawBitmapToContext(entry.bmp, wctx, targetW, targetH);
          gif.addFrame(wctx, { copy: true, delay });
        }
      }
    } catch (err) {
      cleanup();
      console.error('GIF export failed', err);
      alert('GIF export failed. See console for details.');
      setStatus('GIF failed');
      return;
    }

    gif.on('finished', (blob) => {
      cleanup();
      const url = URL.createObjectURL(blob);
      download(url, `slideshow_${Date.now()}.gif`);
      if (usedFallback) {
        setStatus('GIF ready (preview fallback)');
      } else if (usedPreview) {
        setStatus('GIF ready (preview source)');
      } else {
        setStatus('GIF ready');
      }
    });

    gif.render();
  }

  // Export Video via MediaRecorder capturing the stage canvas at a controlled FPS
  async function exportVideo() {
    if (state.frames.length === 0) {
      alert('Snap at least 1 frame first.');
      return;
    }
    const frameDelay = getSpeedMs();
    const exportFps = EXPORT_VIDEO_FPS;
    const repeat = Math.max(1, Number(loopsVid.value) || 1);
    const totalFrames = state.frames.length * repeat;
    if (totalFrames === 0) {
      alert('No frames available for export.');
      return;
    }

    const { entries, usedFallback } = await loadFullResolutionBitmaps();
    if (!entries.length) {
      alert('Unable to load frames from disk.');
      return;
    }

    setStatus('recording…');
    // Pause live slideshow while exporting for a deterministic render
    const resume = !!state.slideshowTimer;
    stopSlideshow();

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = entries[0].bmp.width;
    exportCanvas.height = entries[0].bmp.height;
    const exportCtx = exportCanvas.getContext('2d');

    // Drive the offscreen canvas manually at exportFps, while capturing its stream
    const stream = exportCanvas.captureStream(exportFps);
    // Try preferred types (Safari may support mp4; most browsers webm)
    const typeCandidates = [
      'video/mp4;codecs=h264',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    const mimeType = typeCandidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve, reject) => {
      rec.onstop = resolve;
      rec.onerror = (err) => reject(err.error || err);
    });
    rec.start();

    // Each photo should last frameDelay ms. Determine how many video frames that is.
    const framesPerPhoto = Math.max(1, Math.round((frameDelay / 1000) * exportFps));
    const totalVideoFrames = totalFrames * framesPerPhoto;
    const frames = entries.map(entry => entry.bmp);
    const cleanupBitmaps = () => {
      entries.forEach(entry => {
        if (entry.volatile && entry.bmp?.close) {
          entry.bmp.close();
        }
      });
    };

    let rendered = 0;
    const drawInterval = Math.max(1, Math.round(1000 / exportFps));
    const interval = setInterval(() => {
      const photoAdvance = Math.floor(rendered / framesPerPhoto);
      const photoIndex = photoAdvance % frames.length;
      const bmp = frames[photoIndex];
      drawBitmapToContext(bmp, exportCtx, exportCanvas.width, exportCanvas.height);
      const previewFrame = state.frames[photoIndex];
      if (previewFrame) drawFrame(previewFrame);
      rendered++;
      if (rendered >= totalVideoFrames) {
        clearInterval(interval);
        rec.stop();
      }
    }, drawInterval);

    try {
      await stopped;
    } catch (err) {
      clearInterval(interval);
      cleanupBitmaps();
      console.error('Video export failed', err);
      alert('Video export failed. See console for details.');
      setStatus('video failed');
      return;
    }

    clearInterval(interval);

    const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
    const ext = /mp4/.test(blob.type) ? 'mp4' : 'webm';
    const url = URL.createObjectURL(blob);
    addDownload(url, `slideshow_${Date.now()}.${ext}`, `${blob.type} • ${(blob.size/1024/1024).toFixed(2)} MB`);

    cleanupBitmaps();

    setStatus(usedFallback ? 'video ready (preview fallback)' : 'video ready');
    if (resume && state.frames.length >= 2) startSlideshow();
  }

  function download(url, filename) {
    addDownload(url, filename);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function addDownload(url, filename, meta='') {
    const card = document.createElement('div');
    card.className = 'glass rounded-xl p-3 flex items-center justify-between';
    const left = document.createElement('div');
    left.innerHTML = `<div class="font-medium">${filename}</div><div class="text-xs text-white/70">${meta}</div>`;
    const right = document.createElement('div');
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    a.className = 'btn btn-primary';
    a.textContent = 'Download';
    right.appendChild(a);
    card.appendChild(left);
    card.appendChild(right);
    downloads.prepend(card);
  }

  // Wire up UI
  btnFlip.addEventListener('click', flipCamera);
  btnClear.addEventListener('click', clearAll);
  if (camTap) {
    camTap.addEventListener('click', handleCamTap);
    camTap.addEventListener('keydown', handleCamKey);
  }
  if (speedControl) speedControl.addEventListener('input', handleSpeedChange);
  if (slideshowTap) {
    slideshowTap.addEventListener('click', handleSlideshowTap);
    slideshowTap.addEventListener('keydown', handleSlideshowKey);
  }
  if (ghostOpacityControl) {
    ghostOpacityControl.addEventListener('input', handleGhostOpacityChange);
    ghostOpacityControl.addEventListener('change', handleGhostOpacityChange);
  }
  if (ghostSecondLayerToggle) {
    ghostSecondLayerToggle.addEventListener('change', handleGhostSecondLayerToggle);
  }
  if (cam) {
    cam.addEventListener('loadedmetadata', () => {
      updateCamAspectRatio();
      syncGhostDimensions();
      refreshGhostOverlay();
    }, { once: false });
  }

  btnExportGif.addEventListener('click', exportGIF);
  btnExportVideo.addEventListener('click', exportVideo);

  updateSpeedLabel();
  updateSlideshowHint();
  handleGhostOpacityChange();
  handleGhostSecondLayerToggle();

  // Autostart camera if permissions previously granted
  (async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasCam = devices.some(d => d.kind === 'videoinput');
      if (hasCam) startCamera();
    } catch {}
  })();
})();
