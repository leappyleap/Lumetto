// Минимальный WebM-муксер для одной видеодорожки (VP8/VP9).
// Пишет Duration и Cues в начало файла, поэтому клип сразу перематывается.
(function (global) {
  'use strict';

  const te = new TextEncoder();

  function idBytes(id) {
    const out = [];
    while (id > 0) { out.unshift(id % 256); id = Math.floor(id / 256); }
    return out;
  }

  function vint(n) {
    for (let len = 1; len <= 8; len++) {
      if (n < Math.pow(2, 7 * len) - 1) {
        const b = new Array(len);
        let v = n;
        for (let i = len - 1; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); }
        b[0] |= 0x80 >> (len - 1);
        return b;
      }
    }
    throw new Error('EBML size too large');
  }

  function uint(n, width) {
    const b = [];
    do { b.unshift(n % 256); n = Math.floor(n / 256); } while (n > 0);
    if (width) while (b.length < width) b.unshift(0);
    return b;
  }

  function float64(f) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, f);
    return b;
  }

  const bytes = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));

  function concat(list) {
    const arrs = list.map(bytes);
    let len = 0;
    for (const a of arrs) len += a.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }

  function el(id, children) {
    const body = concat(children);
    return concat([idBytes(id), vint(body.length), body]);
  }
  const u = (id, n, w) => el(id, [uint(n, w)]);
  const s = (id, str) => el(id, [te.encode(str)]);
  const f = (id, v) => el(id, [float64(v)]);

  /**
   * @param {object} o
   * @param {'V_VP9'|'V_VP8'} o.codecId
   * @param {number} o.width
   * @param {number} o.height
   * @param {number} o.fps
   * @param {{key:boolean, ts:number, data:Uint8Array}[]} o.chunks  ts — микросекунды
   * @param {object} [o.audio]  { codec:'opus', sampleRate, channels, description, chunks:[{ts,dur,data}] }
   * @returns {Uint8Array}
   */
  function mux({ codecId, width, height, fps, chunks, audio }) {
    if (!chunks.length) throw new Error('err.fewFrames');
    const t0 = chunks[0].ts;
    const frameMs = 1000 / fps;
    const durationMs = (chunks[chunks.length - 1].ts - t0) / 1000 + frameMs;

    const ebml = el(0x1A45DFA3, [
      u(0x4286, 1), u(0x42F7, 1), u(0x42F2, 4), u(0x42F3, 8),
      s(0x4282, 'webm'), u(0x4287, 4), u(0x4285, 2),
    ]);
    const info = el(0x1549A966, [
      u(0x2AD7B1, 1000000), s(0x4D80, 'Lumetto'), s(0x5741, 'Lumetto'), f(0x4489, durationMs),
    ]);
    const hasAudio = !!(audio && audio.codec === 'opus' && audio.chunks && audio.chunks.length);
    const opusHead = () => {
      if (audio.description) return bytes(audio.description);
      const h = new Uint8Array(19);
      h.set(te.encode('OpusHead'));
      const dv = new DataView(h.buffer);
      h[8] = 1; h[9] = audio.channels;
      dv.setUint16(10, 312, true); dv.setUint32(12, audio.sampleRate, true);
      return h;
    };
    const tracks = el(0x1654AE6B, [
      el(0xAE, [
        u(0xD7, 1), u(0x73C5, 1), u(0x83, 1), u(0x9C, 0), s(0x86, codecId),
        u(0x23E383, Math.round(1e9 / fps)),
        el(0xE0, [u(0xB0, width), u(0xBA, height)]),
      ]),
      ...(hasAudio ? [el(0xAE, [
        u(0xD7, 2), u(0x73C5, 2), u(0x83, 2), u(0x9C, 0), s(0x86, 'A_OPUS'),
        el(0x63A2, [opusHead()]),
        el(0xE1, [f(0xB5, audio.sampleRate), u(0x9F, audio.channels)]),
      ])] : []),
    ]);

    // Новый кластер — на каждом ключевом кадре (это и точки перемотки)
    // Видео и звук идут вперемешку по времени; кластер начинается с ключевого кадра видео
    const events = chunks.map((c) => ({ ...c, track: 1 }));
    if (hasAudio) for (const a of audio.chunks) if (a.ts >= t0) events.push({ ts: a.ts, data: a.data, key: true, track: 2 });
    events.sort((a, b) => a.ts - b.ts || a.track - b.track);
    const clusters = [];
    let cur = null;
    for (const c of events) {
      const tms = Math.round((c.ts - t0) / 1000);
      if ((c.track === 1 && c.key) || !cur || tms - cur.tc > 30000) {
        cur = { tc: tms, blocks: [] };
        clusters.push(cur);
      }
      const rel = tms - cur.tc;
      const hdr = new Uint8Array([0x80 | c.track, (rel >> 8) & 0xff, rel & 0xff, c.key ? 0x80 : 0x00]);
      cur.blocks.push(el(0xA3, [hdr, c.data]));
    }
    const clusterBytes = clusters.map((cl) => el(0x1F43B675, [u(0xE7, cl.tc), ...cl.blocks]));

    const buildCues = (pos) => el(0x1C53BB6B, clusters.map((cl, i) =>
      el(0xBB, [u(0xB3, cl.tc, 4), el(0xB7, [u(0xF7, 1), u(0xF1, pos[i], 4)])])));
    const cuesSize = buildCues(clusters.map(() => 0)).length;

    let pos = info.length + tracks.length + cuesSize;
    const positions = [];
    for (const cb of clusterBytes) { positions.push(pos); pos += cb.length; }

    const segment = el(0x18538067, [info, tracks, buildCues(positions), ...clusterBytes]);
    return concat([ebml, segment]);
  }

  const api = { mux };
  global.WebM = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
