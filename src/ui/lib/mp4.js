// Минимальный MP4-муксер для одной видеодорожки H.264 (сэмплы в формате AVCC).
// moov пишется перед mdat, поэтому клип сразу перематывается и открывается где угодно.
(function (global) {
  'use strict';

  const TIMESCALE = 90000; // тики дорожки
  const MOVIE_TS = 1000;   // тики ролика (мс)

  function u8(n) { return [n & 255]; }
  function u16(n) { return [(n >>> 8) & 255, n & 255]; }
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function str(s) { return Array.from(s, (c) => c.charCodeAt(0)); }
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

  function box(type, ...children) {
    const body = concat(children);
    return concat([u32(body.length + 8), str(type), body]);
  }
  function fullBox(type, version, flags, ...children) {
    return box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...children);
  }

  // AudioSpecificConfig для AAC-LC, если кодировщик его не отдал
  function buildAsc(sampleRate, channels) {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const fi = Math.max(0, rates.indexOf(sampleRate));
    return [(2 << 3) | (fi >> 1), ((fi & 1) << 7) | (channels << 3)];
  }

  // Дескриптор MPEG-4 с длиной в одном байте (наши дескрипторы короткие)
  const desc = (tag, body) => [tag, body.length, ...body];

  function audioEntry(a) {
    const head = [
      0, 0, 0, 0, 0, 0, ...u16(1),          // reserved, data_reference_index
      ...u32(0), ...u32(0),                 // reserved
      ...u16(a.channels), ...u16(16),       // channelcount, samplesize
      ...u16(0), ...u16(0),                 // pre_defined, reserved
      ...u32((a.sampleRate & 0xFFFF) << 16 >>> 0),
    ];
    if (a.codec === 'aac') {
      const asc = a.description ? Array.from(bytes(a.description)) : buildAsc(a.sampleRate, a.channels);
      const esd = desc(0x03, [
        ...u16(2), 0,                       // ES_ID, flags
        ...desc(0x04, [
          0x40, 0x15, 0, 0, 0,              // AAC, audio stream, bufferSizeDB
          ...u32(192000), ...u32(160000),   // max / avg bitrate
          ...desc(0x05, asc),
        ]),
        ...desc(0x06, [0x02]),
      ]);
      return box('mp4a', head, fullBox('esds', 0, 0, esd));
    }
    // Opus в MP4: из OpusHead (little-endian) делаем dOps (big-endian)
    let preSkip = 312;
    let inRate = a.sampleRate;
    if (a.description) {
      const d = bytes(a.description);
      if (d.length >= 19 && String.fromCharCode(...d.slice(0, 8)) === 'OpusHead') {
        preSkip = d[10] | (d[11] << 8);
        inRate = (d[12] | (d[13] << 8) | (d[14] << 16) | (d[15] << 24)) >>> 0;
      }
    }
    const dOps = box('dOps', [0, a.channels, ...u16(preSkip), ...u32(inRate), ...u16(0), 0]);
    return box('Opus', head, dOps);
  }

  function runLengths(durs) {
    const out = [];
    for (const d of durs) {
      const last = out[out.length - 1];
      if (last && last[1] === d) last[0]++;
      else out.push([1, d]);
    }
    return out;
  }

  const MATRIX = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

  /**
   * @param {object} o
   * @param {number} o.width
   * @param {number} o.height
   * @param {number} o.fps
   * @param {Uint8Array|ArrayBuffer} o.avcC   decoderConfig.description из VideoEncoder
   * @param {{key:boolean, ts:number, data:Uint8Array}[]} o.chunks  ts — микросекунды
   * @param {object} [o.audio]  { codec:'aac'|'opus', sampleRate, channels, description, chunks:[{ts,dur,data}] }
   */
  function mux({ width, height, fps, avcC, chunks, audio }) {
    if (!chunks.length) throw new Error('err.fewFrames');
    if (!avcC) throw new Error('err.encoder');
    const n = chunks.length;
    const frameTicks = Math.round(TIMESCALE / fps);

    // Длительности сэмплов из реальных отметок времени (переменная частота кадров допустима)
    const durs = new Array(n);
    for (let i = 0; i < n - 1; i++) {
      durs[i] = Math.max(1, Math.round(((chunks[i + 1].ts - chunks[i].ts) * TIMESCALE) / 1e6));
    }
    durs[n - 1] = frameTicks;
    const mediaDur = durs.reduce((a, b) => a + b, 0);
    const movieDur = Math.round((mediaDur * MOVIE_TS) / TIMESCALE);

    const stts = runLengths(durs);

    // Звук (необязательно)
    const hasAudio = !!(audio && audio.chunks && audio.chunks.length);
    let aDurs = [];
    let aMediaDur = 0;
    let aDataLen = 0;
    if (hasAudio) {
      const def = audio.codec === 'aac' ? 1024 : Math.round(audio.sampleRate * 0.02);
      const nominal = (c) => (c.dur ? Math.max(1, Math.round((c.dur * audio.sampleRate) / 1e6)) : def);
      // Если звук прерывался (в системе было тихо), растягиваем длительность по меткам времени,
      // чтобы следующий звук не «съехал» раньше картинки
      aDurs = audio.chunks.map((c, i) => {
        const n = nominal(c);
        const next = audio.chunks[i + 1];
        if (!next) return n;
        const byTs = Math.round(((next.ts - c.ts) * audio.sampleRate) / 1e6);
        return byTs > n * 1.5 ? byTs : n;
      });
      aMediaDur = aDurs.reduce((a, b) => a + b, 0);
      for (const c of audio.chunks) aDataLen += c.data.byteLength;
    }
    const aMovieDur = hasAudio ? Math.round((aMediaDur * MOVIE_TS) / audio.sampleRate) : 0;
    // Звук начался позже видео — пустой интервал в начале дорожки (edit list)
    const aGap = hasAudio ? Math.max(0, Math.round((audio.chunks[0].ts - chunks[0].ts) / 1000)) : 0;
    const useGap = aGap > 30;
    const totalDur = Math.max(movieDur, aMovieDur + (useGap ? aGap : 0));
    const keys = [];
    chunks.forEach((c, i) => { if (c.key) keys.push(i + 1); });

    const avc1 = box('avc1',
      [0, 0, 0, 0, 0, 0], u16(1),           // reserved, data_reference_index
      u16(0), u16(0), u32(0), u32(0), u32(0), // pre_defined/reserved
      u16(width), u16(height),
      u32(0x00480000), u32(0x00480000),       // 72 dpi
      u32(0), u16(1),                         // reserved, frame_count
      new Array(32).fill(0),                  // compressorname
      u16(0x0018), u16(0xFFFF),               // depth, pre_defined
      box('avcC', bytes(avcC)));

    const stbl = (chunkOffset) => box('stbl',
      fullBox('stsd', 0, 0, u32(1), avc1),
      fullBox('stts', 0, 0, u32(stts.length), ...stts.map(([c, d]) => [...u32(c), ...u32(d)])),
      fullBox('stss', 0, 0, u32(keys.length), ...keys.map((k) => u32(k))),
      fullBox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
      fullBox('stsz', 0, 0, u32(0), u32(n), ...chunks.map((c) => u32(c.data.byteLength))),
      fullBox('stco', 0, 0, u32(1), u32(chunkOffset)));

    const audioTrak = (aOffset) => box('trak',
      fullBox('tkhd', 0, 3, u32(0), u32(0), u32(2), u32(0), u32(aMovieDur + (useGap ? aGap : 0)), new Array(8).fill(0),
        u16(0), u16(1), u16(0x0100), u16(0), MATRIX, u32(0), u32(0)),
      ...(useGap ? [box('edts', fullBox('elst', 0, 0, u32(2),
        u32(aGap), u32(0xFFFFFFFF), u32(0x00010000),
        u32(aMovieDur), u32(0), u32(0x00010000)))] : []),
      box('mdia',
        fullBox('mdhd', 0, 0, u32(0), u32(0), u32(audio.sampleRate), u32(aMediaDur), u16(0x55C4), u16(0)),
        fullBox('hdlr', 0, 0, u32(0), str('soun'), new Array(12).fill(0), str('SoundHandler'), u8(0)),
        box('minf',
          fullBox('smhd', 0, 0, u16(0), u16(0)),
          box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
          box('stbl',
            fullBox('stsd', 0, 0, u32(1), audioEntry(audio)),
            fullBox('stts', 0, 0, ...(() => { const r = runLengths(aDurs); return [u32(r.length), ...r.map(([c, d]) => [...u32(c), ...u32(d)])]; })()),
            fullBox('stsc', 0, 0, u32(1), u32(1), u32(audio.chunks.length), u32(1)),
            fullBox('stsz', 0, 0, u32(0), u32(audio.chunks.length), ...audio.chunks.map((c) => u32(c.data.byteLength))),
            fullBox('stco', 0, 0, u32(1), u32(aOffset))))));

    const moov = (chunkOffset) => box('moov',
      fullBox('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_TS), u32(totalDur),
        u32(0x00010000), u16(0x0100), new Array(10).fill(0), MATRIX, new Array(24).fill(0), u32(hasAudio ? 3 : 2)),
      box('trak',
        fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDur), new Array(8).fill(0),
          u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16)),
        box('mdia',
          fullBox('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(mediaDur), u16(0x55C4), u16(0)),
          fullBox('hdlr', 0, 0, u32(0), str('vide'), new Array(12).fill(0), str('VideoHandler'), u8(0)),
          box('minf',
            fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
            box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
            stbl(chunkOffset)))),
      ...(hasAudio ? [audioTrak(chunkOffset + videoLen)] : []));

    let videoLen = 0;
    for (const c of chunks) videoLen += c.data.byteLength;
    const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
    const moovSize = moov(0).length; // размер не зависит от смещений (stco 32-бит)
    const offset = ftyp.length + moovSize + 8;
    const mdatHeader = concat([u32(videoLen + aDataLen + 8), str('mdat')]);
    return concat([
      ftyp, moov(offset), mdatHeader,
      ...chunks.map((c) => c.data),
      ...(hasAudio ? audio.chunks.map((c) => c.data) : []),
    ]);
  }

  const api = { mux };
  global.MP4 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
