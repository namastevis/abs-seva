// Camera capture + on-device person check + background removal.
// Uses MediaPipe Face Detection and Selfie Segmentation (Apache-2.0), vendored
// under /vendor so it works on the venue Wi-Fi and offline after first load.

const BASE = new URL('../../vendor/mediapipe/', import.meta.url).href;
const OUT_W = 600, OUT_H = 800;   // passport-style 3:4 portrait

let stream = null;
let fd = null, seg = null, modelsPromise = null;

/* ---------------- camera ---------------- */
export async function startCamera(video, facingMode = 'user') {
  stopCamera();
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false,
  });
  video.srcObject = stream;
  video.classList.toggle('mirror', facingMode === 'user');
  await video.play();
}
export function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}
export function grabFrame(video, mirror) {
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  const ctx = c.getContext('2d');
  if (mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, 0, 0);
  return c;
}
export async function fileToCanvas(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(async () => {
    const img = new Image(); img.src = URL.createObjectURL(file); await img.decode(); return img;
  });
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return c;
}

/* ---------------- models ---------------- */
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.crossOrigin = 'anonymous'; s.onload = res; s.onerror = () => rej(new Error('load ' + src));
    document.head.appendChild(s);
  });
}
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}
export function warmUpModels() {
  if (modelsPromise) return modelsPromise;
  modelsPromise = (async () => {
    // The two MediaPipe runtimes share a global Emscripten `Module`, so they
    // must be loaded and initialised one after the other, never in parallel.
    await loadScript(BASE + 'seg/selfie_segmentation.js');
    seg = new window.SelfieSegmentation({ locateFile: (f) => BASE + 'seg/' + f });
    seg.setOptions({ modelSelection: 0 });
    await seg.initialize();
    await loadScript(BASE + 'fd/face_detection.js');
    fd = new window.FaceDetection({ locateFile: (f) => BASE + 'fd/' + f });
    fd.setOptions({ model: 'short', minDetectionConfidence: 0.6 });
    await fd.initialize();
    return true;
  })();
  modelsPromise.catch(() => { modelsPromise = null; });
  return modelsPromise;
}
// MediaPipe solutions have a single onResults callback, so calls must never
// overlap (the live guide and a capture/upload can otherwise collide).
let queue = Promise.resolve();
function run(model, image) {
  const job = queue.then(() => new Promise((resolve, reject) => {
    model.onResults(resolve);
    Promise.resolve(model.send({ image })).catch(reject);
  }));
  queue = job.catch(() => {});
  return job;
}

/* ---------------- processing ---------------- */
function downscale(src, max = 1024) {
  const k = Math.min(1, max / Math.max(src.width, src.height));
  if (k === 1) return src;
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** Crop rectangle (3:4) around the face, head in the upper third. */
function portraitRect(W, H, face) {
  let w, h, x, y;
  if (face) {
    const fw = face.width * W, fh = face.height * H;
    const cx = face.xCenter * W, cy = face.yCenter * H;
    h = Math.min(H, Math.max(fh * 3.2, fw * 3.2 * 4 / 3));
    w = h * 3 / 4;
    if (w > W) { w = W; h = w * 4 / 3; }
    x = cx - w / 2; y = cy - h * 0.38;
  } else {
    w = Math.min(W, H * 3 / 4); h = w * 4 / 3; x = (W - w) / 2; y = (H - h) / 2;
  }
  x = Math.max(0, Math.min(W - w, x)); y = Math.max(0, Math.min(H - h, y));
  return { x, y, w, h };
}

function encode(canvas) {
  let url = canvas.toDataURL('image/webp', 0.9);
  if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/png');
  return url;
}

/**
 * Check for exactly one person and remove the background.
 * Returns { status: 'ok'|'noface'|'many'|'unavailable', dataUrl }
 */
export async function processPhoto(source) {
  const img = downscale(source);
  const W = img.width, H = img.height;
  try {
    await withTimeout(warmUpModels(), 25000);
  } catch (e) {
    console.warn('[photo] models unavailable', e);
    return { status: 'unavailable', dataUrl: plainCrop(img, null) };
  }

  const faces = await withTimeout(run(fd, img), 15000).then((r) => r.detections || []).catch(() => null);
  if (faces === null) return { status: 'unavailable', dataUrl: plainCrop(img, null) };
  const strong = faces.filter((d) => d.boundingBox && d.boundingBox.width * W > W * 0.06);
  if (strong.length === 0) return { status: 'noface' };
  // Pick the largest face; reject if another face is nearly as large (a second person)
  strong.sort((a, b) => b.boundingBox.width - a.boundingBox.width);
  if (strong.length > 1 && strong[1].boundingBox.width > strong[0].boundingBox.width * 0.6) return { status: 'many' };
  const face = strong[0].boundingBox;

  const res = await withTimeout(run(seg, img), 15000).catch(() => null);
  if (!res || !res.segmentationMask) return { status: 'unavailable', dataUrl: plainCrop(img, face) };

  // Cut-out: mask → source-in → image
  const cut = document.createElement('canvas');
  cut.width = W; cut.height = H;
  const cx = cut.getContext('2d');
  cx.filter = 'blur(1.5px)';
  cx.drawImage(res.segmentationMask, 0, 0, W, H);
  cx.filter = 'none';
  cx.globalCompositeOperation = 'source-in';
  cx.drawImage(img, 0, 0, W, H);

  const r = portraitRect(W, H, face);
  const out = document.createElement('canvas');
  out.width = OUT_W; out.height = OUT_H;
  out.getContext('2d').drawImage(cut, r.x, r.y, r.w, r.h, 0, 0, OUT_W, OUT_H);
  return { status: 'ok', dataUrl: encode(out) };
}

function plainCrop(img, face) {
  const r = portraitRect(img.width, img.height, face);
  const out = document.createElement('canvas');
  out.width = OUT_W; out.height = OUT_H;
  out.getContext('2d').drawImage(img, r.x, r.y, r.w, r.h, 0, 0, OUT_W, OUT_H);
  return out.toDataURL('image/jpeg', 0.88);
}

/** Faces in a live video frame (normalised boxes), used for the alignment guide. */
export async function detectFaces(source) {
  await warmUpModels();
  const r = await run(fd, source);
  return (r.detections || []).map((d) => d.boundingBox).filter(Boolean);
}
