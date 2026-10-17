'use strict';
// Скрытое окно захвата.
// Экран непрерывно кодируется (WebCodecs), а в памяти держится только несколько
// секунд уже сжатых кадров — кольцевой буфер в пару мегабайт. По хоткею берём
// кусок «до» из буфера, дожидаемся «после» и собираем клип.
//
// Как держим нагрузку низкой:
//  • предпочитаем H.264 на видеокарте (NVENC / AMF / Quick Sync) — процессор почти не участвует;
//  • без видеокарты — программный H.264, он примерно вдвое легче VP9;
//  • кадр уменьшает сам захват экрана, а в кодировщик он идёт напрямую, без копий через холст;
//  • на паузе захват экрана полностью останавливается.

const api = window.lumetto;

let cfg = null;
let stream = null;
let reader = null;
let latest = null;            // последний кадр с экрана (VideoFrame)
let encoder = null;
let enc = null;               // выбранный вариант кодировщика
let avcC = null;              // параметры H.264 для MP4
let canvas = null;            // только для обложки и редкого масштабирования
let ctx = null;
let W = 0;
let H = 0;
let frameIndex = 0;
let encodedOk = 0;
let keyInterval = 8;
let chunks = [];              // { key, ts (мкс), data }
let paused = false;
let ticker = null;
let restartTimer = null;
let generation = 0;
const posterWaiters = [];
const badCodecs = new Set();  // варианты, которые заявлены, но на деле не работают

const nowUs = () => Math.round(performance.now() * 1000);
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function status(state, extra = {}) {
  api.reportStatus({
    state, width: W, height: H, fps: cfg && cfg.fps,
    codec: enc && enc.label, hardware: enc && enc.hw === 'prefer-hardware', ...extra,
  });
}

function vp9Codec(w, h) {
  const px = w * h;
  const level = px <= 983040 ? '31' : px <= 2228224 ? '41' : px <= 8912896 ? '51' : '61';
  return `vp09.00.${level}.08`;
}

// Уровень H.264 по размеру кадра и частоте (в макроблоках 16×16)
function avcLevel(w, h, fps) {
  const fs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const mbps = fs * fps;
  const table = [[0x28, 8192, 245760], [0x2A, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600]];
  for (const [lvl, maxFs, maxMbps] of table) if (fs <= maxFs && mbps <= maxMbps) return lvl.toString(16).toUpperCase().padStart(2, '0');
  return '34';
}

function candidates(w, h) {
  const lvl = avcLevel(w, h, cfg.fps);
  const avc = (prof, hw) => ({ codec: `avc1.${prof}${lvl}`, container: 'mp4', hw, avc: { format: 'avc' }, label: `H.264${hw === 'prefer-hardware' ? ' HW' : ''}` });
  return [
    avc('6400', 'prefer-hardware'), avc('4D00', 'prefer-hardware'), avc('4200', 'prefer-hardware'),
    { codec: vp9Codec(w, h), container: 'webm', id: 'V_VP9', hw: 'prefer-hardware', label: 'VP9 HW' },
    avc('6400', 'prefer-software'), avc('4200', 'prefer-software'),
    { codec: 'vp8', container: 'webm', id: 'V_VP8', hw: 'no-preference', label: 'VP8' },
    { codec: vp9Codec(w, h), container: 'webm', id: 'V_VP9', hw: 'no-preference', label: 'VP9' },
  ];
}

async function pickEncoder(w, h) {
  const bitrate = Math.min(14e6, Math.max(2e6, Math.round(w * h * cfg.fps * 0.09)));
  for (const c of candidates(w, h)) {
    const key = `${c.codec}|${c.hw}`;
    if (badCodecs.has(key)) continue;
    const config = {
      codec: c.codec, width: w, height: h, framerate: cfg.fps, bitrate,
      latencyMode: 'realtime', bitrateMode: 'variable', hardwareAcceleration: c.hw,
      ...(c.avc ? { avc: c.avc } : {}),
    };
    try {
      const r = await VideoEncoder.isConfigSupported(config);
      if (r.supported) return { ...c, key, config };
    } catch { /* следующий */ }
  }
  throw new Error('err.codec');
}

async function start() {
  stop();
  const gen = ++generation;
  cfg = await api.getSettings();
  paused = !!cfg.paused;
  if (paused) { status('paused'); return; } // на паузе экран вообще не захватываем
  status('starting');

  try {
    // Уменьшает кадр сам захват — так дешевле, чем рисовать через холст
    const video = { frameRate: { ideal: cfg.fps, max: cfg.fps }, cursor: 'always' };
    if (cfg.maxHeight) video.height = { ideal: cfg.maxHeight, max: cfg.maxHeight };
    stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
  } catch (e) {
    status('error', { message: 'err.noScreen' });
    scheduleRestart(4000);
    return;
  }
  if (gen !== generation) { stream.getTracks().forEach((t) => t.stop()); return; }

  const track = stream.getVideoTracks()[0];
  track.contentHint = 'motion';
  track.addEventListener('ended', () => { status('error', { message: 'err.displayLost' }); scheduleRestart(1500); });
  const s = track.getSettings();
  const srcW = s.width || 1920;
  const srcH = s.height || 1080;
  const scale = cfg.maxHeight ? Math.min(1, cfg.maxHeight / srcH) : 1;
  W = even(srcW * scale);
  H = even(srcH * scale);

  try {
    enc = await pickEncoder(W, H);
    avcC = null;
    encodedOk = 0;
    const myEnc = enc;
    encoder = new VideoEncoder({
      output: onChunk,
      error: (e) => {
        console.error(e);
        // заявленный, но неработающий кодировщик (бывает с драйверами) — пробуем следующий
        if (encodedOk < 30) badCodecs.add(myEnc.key);
        status('error', { message: 'err.encoder' });
        scheduleRestart(800);
      },
    });
    encoder.configure(enc.config);
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

  status('live');
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

function ensureCanvas() {
  if (canvas && canvas.width === W && canvas.height === H) return;
  canvas = new OffscreenCanvas(W, H);
  ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

function tick() {
  if (paused || !latest || !encoder || encoder.state !== 'configured') return;
  if (encoder.encodeQueueSize > 3) return; // не копим очередь, если машина занята

  const ts = nowUs();
  let frame;
  if (latest.displayWidth === W && latest.displayHeight === H) {
    // Обычный путь: тот же кадр, только с нашей отметкой времени — без копирования
    frame = new VideoFrame(latest, { timestamp: ts });
  } else {
    // Редкий случай (сменилось разрешение экрана): масштабируем через холст
    ensureCanvas();
    ctx.drawImage(latest, 0, 0, W, H);
    frame = new VideoFrame(canvas, { timestamp: ts });
  }

  if (posterWaiters.length) makePoster(latest);

  encoder.encode(frame, { keyFrame: frameIndex % keyInterval === 0 });
  frame.close();
  frameIndex++;
}

// Обложка рисуется только в момент нажатия, а не на каждом кадре
function makePoster(src) {
  const waiters = posterWaiters.splice(0);
  ensureCanvas();
  ctx.drawImage(src, 0, 0, W, H);
  const blob = canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  for (const w of waiters) w(blob);
}

function onChunk(chunk, metadata) {
  if (metadata && metadata.decoderConfig && metadata.decoderConfig.description) {
    avcC = new Uint8Array(metadata.decoderConfig.description.slice
      ? metadata.decoderConfig.description.slice(0)
      : metadata.decoderConfig.description);
  }
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  chunks.push({ key: chunk.type === 'key', ts: chunk.timestamp, data });
  encodedOk++;
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

    const container = enc.container;
    const video = container === 'mp4'
      ? MP4.mux({ width: W, height: H, fps: cfg.fps, avcC, chunks: selected })
      : WebM.mux({ codecId: enc.id, width: W, height: H, fps: cfg.fps, chunks: selected });
    const posterBlob = await Promise.race([posterPromise, sleep(1000).then(() => null)]);
    const poster = posterBlob ? await posterBlob.arrayBuffer() : null;
    const first = selected[0].ts;
    const last = selected[selected.length - 1].ts;

    await api.saveCapture({
      id,
      ext: container,
      video: video.buffer,
      poster,
      meta: {
        width: W,
        height: H,
        fps: cfg.fps,
        codec: enc.label,
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
  if (paused) {
    // На паузе ничего не захватываем и ничего не держим в памяти
    generation++;
    stop();
    status('paused');
  } else {
    start();
  }
});

start();
