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

  const MATRIX = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

  /**
   * @param {object} o
   * @param {number} o.width
   * @param {number} o.height
   * @param {number} o.fps
   * @param {Uint8Array|ArrayBuffer} o.avcC   decoderConfig.description из VideoEncoder
   * @param {{key:boolean, ts:number, data:Uint8Array}[]} o.chunks  ts — микросекунды
   */
  function mux({ width, height, fps, avcC, chunks }) {
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

    // stts: сжатые серии одинаковых длительностей
    const stts = [];
    for (const d of durs) {
      const last = stts[stts.length - 1];
      if (last && last[1] === d) last[0]++;
      else stts.push([1, d]);
    }
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

    const moov = (chunkOffset) => box('moov',
      fullBox('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_TS), u32(movieDur),
        u32(0x00010000), u16(0x0100), new Array(10).fill(0), MATRIX, new Array(24).fill(0), u32(2)),
      box('trak',
        fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDur), new Array(8).fill(0),
          u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16)),
        box('mdia',
          fullBox('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(mediaDur), u16(0x55C4), u16(0)),
          fullBox('hdlr', 0, 0, u32(0), str('vide'), new Array(12).fill(0), str('VideoHandler'), u8(0)),
          box('minf',
            fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
            box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
            stbl(chunkOffset)))));

    const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
    const moovSize = moov(0).length; // размер не зависит от смещения (stco 32-бит)
    let dataLen = 0;
    for (const c of chunks) dataLen += c.data.byteLength;
    const offset = ftyp.length + moovSize + 8;
    const mdatHeader = concat([u32(dataLen + 8), str('mdat')]);
    return concat([ftyp, moov(offset), mdatHeader, ...chunks.map((c) => c.data)]);
  }

  const api = { mux };
  global.MP4 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
