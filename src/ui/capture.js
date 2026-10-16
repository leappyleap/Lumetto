'use strict';
// Скрытое окно захвата.
// Экран непрерывно кодируется в VP9 (WebCodecs), а в памяти держится только
// несколько секунд уже сжатых кадров — это кольцевой буфер в пару мегабайт.
// По хоткею берём кусок «до» из буфера, дожидаемся «после» и собираем WebM.

const api = window.lumetto;

let cfg = null;
let stream = null;
let reader = null;
let latest = null;            // последний кадр с экрана (VideoFrame)
let encoder = null;
let codecId = 'V_VP9';
let canvas = null;
let ctx = null;
let W = 0;
let H = 0;
let frameIndex = 0;
let keyInterval = 15;
let chunks = [];              // { key, ts (мкс), data }
let paused = false;
let ticker = null;
let restartTimer = null;
const posterWaiters = [];

const nowUs = () => Math.round(performance.now() * 1000);
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function status(state, extra = {}) {
  api.reportStatus({ state, width: W, height: H, fps: cfg && cfg.fps, codec: codecId, ...extra });
}

function vp9Codec(w, h) {
  const px = w * h;
  const level = px <= 983040 ? '31' : px <= 2228224 ? '41' : px <= 8912896 ? '51' : '61';
  return `vp09.00.${level}.08`;
}

async function pickEncoderConfig(w, h, fps) {
  const bitrate = Math.min(14e6, Math.max(2e6, Math.round(w * h * fps * 0.09)));
  const base = { width: w, height: h, framerate: fps, bitrate, latencyMode: 'realtime', bitrateMode: 'variable' };
  const candidates = [
    { codec: vp9Codec(w, h), id: 'V_VP9' },
    { codec: 'vp8', id: 'V_VP8' },
  ];
  for (const c of candidates) {
    const config = { ...base, codec: c.codec };
    try {
      const r = await VideoEncoder.isConfigSupported(config);
      if (r.supported) return { config, id: c.id };
    } catch { /* следующий */ }
  }
  throw new Error('err.codec');
}

async function start() {
  stop();
  cfg = await api.getSettings();
  paused = !!cfg.paused;
  status('starting');

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: cfg.fps, max: cfg.fps }, cursor: 'always' },
      audio: false,
    });
  } catch (e) {
    status('error', { message: 'err.noScreen' });
    scheduleRestart(4000);
    return;
  }

  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => { status('error', { message: 'err.displayLost' }); scheduleRestart(1500); });
  const s = track.getSettings();
  const srcW = s.width || 1920;
  const srcH = s.height || 1080;
  const scale = cfg.maxHeight ? Math.min(1, cfg.maxHeight / srcH) : 1;
  W = even(srcW * scale);
  H = even(srcH * scale);

  canvas = new OffscreenCanvas(W, H);
  ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  try {
    const picked = await pickEncoderConfig(W, H, cfg.fps);
    codecId = picked.id;
    encoder = new VideoEncoder({
      output: onChunk,
      error: (e) => { console.error(e); status('error', { message: 'err.encoder' }); scheduleRestart(1500); },
    });
    encoder.configure(picked.config);
  } catch (e) {
    status('error', { message: e.message });
    return;
  }

  // Ключевой кадр каждые ~0,25 с — от них начинается клип, так что длина
  // получается почти точной, а перемотка — мгновенной
  keyInterval = Math.max(1, Math.round(cfg.fps / 4));
  frameIndex = 0;
  chunks = [];

  const processor = new MediaStreamTrackProcessor({ track });
  reader = processor.readable.getReader();
  pump(reader);

  // Таймер в воркере не замедляется в фоне — кадры идут ровно
  const src = 'let t;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}';
  ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  ticker.onmessage = tick;
  ticker.postMessage(1000 / cfg.fps);

  status(paused ? 'paused' : 'live');
}

async function pump(r) {
  try {
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      if (latest) latest.close();
      latest = value;
    }
  } catch { /* поток закрыт */ }
}

function tick() {
  if (paused || !latest || !encoder || encoder.state !== 'configured') return;
  if (encoder.encodeQueueSize > 3) return; // не копим очередь, если машина занята

  ctx.drawImage(latest, 0, 0, W, H);

  if (posterWaiters.length) {
    const waiters = posterWaiters.splice(0);
    const blob = canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    for (const w of waiters) w(blob);
  }

  const frame = new VideoFrame(canvas, { timestamp: nowUs() });
  encoder.encode(frame, { keyFrame: frameIndex % keyInterval === 0 });
  frame.close();
  frameIndex++;
}

function onChunk(chunk) {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  chunks.push({ key: chunk.type === 'key', ts: chunk.timestamp, data });
  prune();
}

function prune() {
  const keepUs = (cfg.before + cfg.after + 2.5) * 1e6;
  const limit = nowUs() - keepUs;
  let cut = -1;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].ts > limit) break;
    if (chunks[i].key) cut = i;
  }
  if (cut > 0) chunks.splice(0, cut);
}

async function capture({ id }) {
  try {
    const tTrig = nowUs();
    const posterPromise = new Promise((res) => posterWaiters.push(res)).then((p) => p);
    // Кадр момента нажатия — сразу в слой превью, чтобы он «сжался» в угол
    posterPromise.then(async (blob) => {
      if (blob) api.sendPoster({ id, data: await blob.arrayBuffer() });
    }).catch(() => {});

    await sleep(cfg.after * 1000 + 300);

    const startLimit = tTrig - cfg.before * 1e6;
    const endLimit = tTrig + cfg.after * 1e6;
    let startIdx = -1;
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].ts > startLimit) break;
      if (chunks[i].key) startIdx = i;
    }
    if (startIdx < 0) startIdx = chunks.findIndex((c) => c.key);
    if (startIdx < 0) throw new Error('err.bufferEmpty');

    const selected = chunks.slice(startIdx).filter((c) => c.ts <= endLimit);
    if (selected.length < 2) throw new Error('err.fewFrames');

    const video = WebM.mux({ codecId, width: W, height: H, fps: cfg.fps, chunks: selected });
    const posterBlob = await Promise.race([posterPromise, sleep(1000).then(() => null)]);
    const poster = posterBlob ? await posterBlob.arrayBuffer() : null;
    const first = selected[0].ts;
    const last = selected[selected.length - 1].ts;

    await api.saveCapture({
      id,
      video: video.buffer,
      poster,
      meta: {
        width: W,
        height: H,
        fps: cfg.fps,
        codec: codecId,
        duration: (last - first) / 1e6 + 1 / cfg.fps,
        keyTime: Math.max(0, (tTrig - first) / 1e6),
        start: Date.now() - (nowUs() - first) / 1000,
      },
    });
  } catch (e) {
    console.error(e);
    api.reportFailed({ id, message: e.message });
  }
}

function stop() {
  clearTimeout(restartTimer);
  if (ticker) { ticker.postMessage(0); ticker.terminate(); ticker = null; }
  if (reader) { reader.cancel().catch(() => {}); reader = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (encoder && encoder.state !== 'closed') { try { encoder.close(); } catch { /* */ } }
  encoder = null;
  if (latest) { latest.close(); latest = null; }
  chunks = [];
}

function scheduleRestart(ms) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(start, ms);
}

api.onTrigger((p) => capture(p));
api.onPaused((v) => {
  paused = v;
  if (paused) chunks = []; // на паузе в памяти не остаётся ничего
  frameIndex = 0;          // после паузы начнём с ключевого кадра
  status(paused ? 'paused' : 'live');
});

start();
