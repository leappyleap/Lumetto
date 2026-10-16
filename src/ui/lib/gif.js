// Компактный GIF89a-энкодер: общая палитра median-cut на все кадры,
// неизменившиеся пиксели — прозрачные (файл заметно меньше), бесконечный повтор.
(function (global) {
  'use strict';

  const TRANSPARENT = 255;

  function buildPalette(frames, maxColors = 255) {
    // Гистограмма 5:5:5 бит по всем кадрам
    const hist = new Uint32Array(32768);
    for (const f of frames) {
      const d = f.data;
      for (let i = 0; i < d.length; i += 8) { // каждый второй пиксель
        hist[((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)]++;
      }
    }
    const bins = [];
    for (let i = 0; i < 32768; i++) {
      if (hist[i]) bins.push({ r: (i >> 10) & 31, g: (i >> 5) & 31, b: i & 31, n: hist[i] });
    }
    if (!bins.length) bins.push({ r: 0, g: 0, b: 0, n: 1 });

    const boxStats = (items) => {
      let rMin = 31, rMax = 0, gMin = 31, gMax = 0, bMin = 31, bMax = 0, n = 0;
      for (const c of items) {
        if (c.r < rMin) rMin = c.r; if (c.r > rMax) rMax = c.r;
        if (c.g < gMin) gMin = c.g; if (c.g > gMax) gMax = c.g;
        if (c.b < bMin) bMin = c.b; if (c.b > bMax) bMax = c.b;
        n += c.n;
      }
      const ranges = { r: rMax - rMin, g: gMax - gMin, b: bMax - bMin };
      const axis = ranges.g >= ranges.r && ranges.g >= ranges.b ? 'g' : ranges.r >= ranges.b ? 'r' : 'b';
      return { items, axis, range: ranges[axis], n, score: ranges[axis] * Math.sqrt(n) };
    };

    let boxes = [boxStats(bins)];
    while (boxes.length < maxColors) {
      let bi = -1, best = 0;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].items.length > 1 && boxes[i].score > best) { best = boxes[i].score; bi = i; }
      }
      if (bi < 0) break;
      const box = boxes[bi];
      const ax = box.axis;
      box.items.sort((a, b) => a[ax] - b[ax]);
      let acc = 0, cut = 1;
      for (let i = 0; i < box.items.length; i++) {
        acc += box.items[i].n;
        if (acc >= box.n / 2) { cut = Math.min(Math.max(i, 1), box.items.length - 1); break; }
      }
      boxes.splice(bi, 1, boxStats(box.items.slice(0, cut)), boxStats(box.items.slice(cut)));
    }

    return boxes.map((box) => {
      let r = 0, g = 0, b = 0;
      for (const c of box.items) { r += c.r * c.n; g += c.g * c.n; b += c.b * c.n; }
      const k = 255 / 31 / box.n;
      return [Math.round(r * k), Math.round(g * k), Math.round(b * k)];
    });
  }

  function makeMapper(palette) {
    const cache = new Int16Array(32768).fill(-1);
    return (r, g, b) => {
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let idx = cache[key];
      if (idx >= 0) return idx;
      let best = Infinity;
      for (let i = 0; i < palette.length; i++) {
        const p = palette[i];
        const dr = p[0] - r, dg = p[1] - g, db = p[2] - b;
        const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
        if (d < best) { best = d; idx = i; }
      }
      cache[key] = idx;
      return idx;
    };
  }

  function lzw(indices, minCode, out) {
    const clear = 1 << minCode;
    const eoi = clear + 1;
    let n = minCode + 1;
    let maxcode = (1 << n) - 1;
    let free = clear + 2;
    let clearFlag = false;
    const dict = new Map();
    const buf = [];
    let cur = 0, bits = 0;

    const output = (code) => {
      cur |= code << bits;
      bits += n;
      while (bits >= 8) { buf.push(cur & 255); cur >>>= 8; bits -= 8; }
      if (free > maxcode || clearFlag) {
        if (clearFlag) { n = minCode + 1; maxcode = (1 << n) - 1; clearFlag = false; }
        else { n++; maxcode = n === 12 ? 4096 : (1 << n) - 1; }
      }
    };

    output(clear);
    let ent = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (ent << 8) | k;
      const v = dict.get(key);
      if (v !== undefined) { ent = v; continue; }
      output(ent);
      ent = k;
      if (free < 4096) dict.set(key, free++);
      else { dict.clear(); free = clear + 2; clearFlag = true; output(clear); }
    }
    output(ent);
    output(eoi);
    if (bits > 0) buf.push(cur & 255);

    out.push(minCode);
    for (let i = 0; i < buf.length; i += 255) {
      const len = Math.min(255, buf.length - i);
      out.push(len);
      for (let j = 0; j < len; j++) out.push(buf[i + j]);
    }
    out.push(0);
  }

  const u16 = (out, v) => { out.push(v & 255, (v >> 8) & 255); };

  /**
   * @param {ImageData[]} frames
   * @param {number} delayMs
   * @param {(p:number)=>void} [onProgress]
   */
  async function encode(frames, delayMs, onProgress) {
    const w = frames[0].width, h = frames[0].height;
    const palette = buildPalette(frames);
    while (palette.length < 256) palette.push([0, 0, 0]);
    const map = makeMapper(palette.slice(0, 255));

    const out = [];
    for (const c of 'GIF89a') out.push(c.charCodeAt(0));
    u16(out, w); u16(out, h);
    out.push(0xF7, 0, 0);
    for (const p of palette) out.push(p[0], p[1], p[2]);
    out.push(0x21, 0xFF, 0x0B);
    for (const c of 'NETSCAPE2.0') out.push(c.charCodeAt(0));
    out.push(0x03, 0x01, 0x00, 0x00, 0x00);

    const delay = Math.max(2, Math.round(delayMs / 10));
    let prev = null;
    for (let f = 0; f < frames.length; f++) {
      const d = frames[f].data;
      const idx = new Uint8Array(w * h);
      for (let i = 0, p = 0; p < idx.length; i += 4, p++) idx[p] = map(d[i], d[i + 1], d[i + 2]);
      let frameIdx = idx;
      if (prev) {
        frameIdx = new Uint8Array(idx);
        for (let p = 0; p < idx.length; p++) if (idx[p] === prev[p]) frameIdx[p] = TRANSPARENT;
      }
      prev = idx;

      out.push(0x21, 0xF9, 0x04, (1 << 2) | (f ? 1 : 0));
      u16(out, delay);
      out.push(TRANSPARENT, 0);
      out.push(0x2C); u16(out, 0); u16(out, 0); u16(out, w); u16(out, h); out.push(0);
      lzw(frameIdx, 8, out);

      if (onProgress) onProgress((f + 1) / frames.length);
      await new Promise((r) => setTimeout(r, 0));
    }
    out.push(0x3B);
    return new Uint8Array(out);
  }

  const api = { encode };
  global.GifEncoder = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
