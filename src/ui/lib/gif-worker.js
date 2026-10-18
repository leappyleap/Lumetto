'use strict';
// GIF-кодировщик высокого качества (работает в фоновом потоке).
//
// Что даёт качество:
//  • у каждого кадра своя палитра на 255 цветов (median cut + уточнение k-means);
//  • палитра строится только по изменившимся пикселям — все 255 цветов уходят туда, где есть движение;
//  • сглаживание Флойда–Стейнберга убирает «ступеньки» на градиентах;
//  • неизменившиеся пиксели прозрачные — остаётся картинка прошлого кадра, поэтому
//    неподвижный фон не мерцает от сглаживания, а файл не раздувается;
//  • каждый кадр обрезается до прямоугольника, где что-то изменилось.
//
// Протокол: {type:'start', width, height, delayCs} → {type:'frame', data:ArrayBuffer(RGBA)}… → {type:'end'}
// Ответы: {type:'progress', done} и {type:'result', data:ArrayBuffer}

const TRANSPARENT = 255;
const SAME = 4;          // насколько пиксель может «дрожать», чтобы считаться неизменным
const DITHER = 0.85;     // сила сглаживания (1 — классический Флойд–Стейнберг)

let W = 0, H = 0, delay = 5;
let out = null;          // ByteWriter
let prevSrc = null;      // исходные цвета пикселей на момент последней записи
let frameNo = 0;

class ByteWriter {
  constructor() { this.buf = new Uint8Array(1 << 20); this.len = 0; }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  byte(v) { this.ensure(1); this.buf[this.len++] = v & 255; }
  u16(v) { this.ensure(2); this.buf[this.len++] = v & 255; this.buf[this.len++] = (v >> 8) & 255; }
  bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
  str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  result() { return this.buf.slice(0, this.len); }
}

// ---------------------------------------------------------------------------
// Палитра: median cut по гистограмме 6-6-6 бит + 3 прохода k-means
// ---------------------------------------------------------------------------
const WR = 2, WG = 4, WB = 3; // веса каналов для расстояния (глаз чувствительнее к зелёному)

function buildPalette(src, mask, n, maxColors) {
  const hist = new Uint32Array(1 << 18);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (mask && !mask[p]) continue;
    hist[((src[i] >> 2) << 12) | ((src[i + 1] >> 2) << 6) | (src[i + 2] >> 2)]++;
  }
  // Занятые ячейки: средний цвет и вес
  const bins = [];
  for (let k = 0; k < hist.length; k++) {
    const c = hist[k];
    if (!c) continue;
    bins.push({ r: ((k >> 12) << 2) + 2, g: (((k >> 6) & 63) << 2) + 2, b: ((k & 63) << 2) + 2, n: c });
  }
  if (!bins.length) return [[0, 0, 0]];
  if (bins.length <= maxColors) return bins.map((b) => [b.r, b.g, b.b]);

  // median cut: делим коробку с наибольшей «ошибкой» (взвешенная дисперсия)
  const stats = (items) => {
    let n2 = 0, sr = 0, sg = 0, sb = 0, qr = 0, qg = 0, qb = 0;
    for (const c of items) {
      n2 += c.n; sr += c.r * c.n; sg += c.g * c.n; sb += c.b * c.n;
      qr += c.r * c.r * c.n; qg += c.g * c.g * c.n; qb += c.b * c.b * c.n;
    }
    const vr = (qr - (sr * sr) / n2) * WR, vg = (qg - (sg * sg) / n2) * WG, vb = (qb - (sb * sb) / n2) * WB;
    const axis = vg >= vr && vg >= vb ? 'g' : vr >= vb ? 'r' : 'b';
    return { items, n: n2, err: vr + vg + vb, axis };
  };
  const boxes = [stats(bins)];
  while (boxes.length < maxColors) {
    let bi = -1, best = 0;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].items.length > 1 && boxes[i].err > best) { best = boxes[i].err; bi = i; }
    if (bi < 0) break;
    const box = boxes[bi];
    const ax = box.axis;
    box.items.sort((a, b) => a[ax] - b[ax]);
    let acc = 0, cut = 1;
    for (let i = 0; i < box.items.length; i++) {
      acc += box.items[i].n;
      if (acc >= box.n / 2) { cut = Math.min(Math.max(i, 1), box.items.length - 1); break; }
    }
    boxes.splice(bi, 1, stats(box.items.slice(0, cut)), stats(box.items.slice(cut)));
  }
  let pal = boxes.map((bx) => {
    let r = 0, g = 0, b = 0;
    for (const c of bx.items) { r += c.r * c.n; g += c.g * c.n; b += c.b * c.n; }
    return [r / bx.n, g / bx.n, b / bx.n];
  });

  // k-means: подтягиваем цвета палитры к реальным скоплениям цветов
  const m = pal.length;
  for (let iter = 0; iter < 3; iter++) {
    const sr = new Float64Array(m), sg = new Float64Array(m), sb = new Float64Array(m), sn = new Float64Array(m);
    for (const c of bins) {
      let best = Infinity, bi = 0;
      for (let j = 0; j < m; j++) {
        const p = pal[j];
        const dr = p[0] - c.r, dg = p[1] - c.g, db = p[2] - c.b;
        const d = dr * dr * WR + dg * dg * WG + db * db * WB;
        if (d < best) { best = d; bi = j; }
      }
      sr[bi] += c.r * c.n; sg[bi] += c.g * c.n; sb[bi] += c.b * c.n; sn[bi] += c.n;
    }
    pal = pal.map((p, j) => (sn[j] ? [sr[j] / sn[j], sg[j] / sn[j], sb[j] / sn[j]] : p));
  }
  return pal.map((p) => [Math.round(p[0]), Math.round(p[1]), Math.round(p[2])]);
}

function nearestFinder(pal) {
  const cache = new Int16Array(1 << 18).fill(-1);
  const m = pal.length;
  const pr = new Int32Array(m), pg = new Int32Array(m), pb = new Int32Array(m);
  pal.forEach((p, i) => { pr[i] = p[0]; pg[i] = p[1]; pb[i] = p[2]; });
  return (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let idx = cache[key];
    if (idx >= 0) return idx;
    let best = Infinity;
    for (let j = 0; j < m; j++) {
      const dr = pr[j] - r, dg = pg[j] - g, db = pb[j] - b;
      const d = dr * dr * WR + dg * dg * WG + db * db * WB;
      if (d < best) { best = d; idx = j; }
    }
    cache[key] = idx;
    return idx;
  };
}

// ---------------------------------------------------------------------------
// LZW
// ---------------------------------------------------------------------------
function lzw(indices, minCode, w) {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let size = minCode + 1;
  let maxcode = (1 << size) - 1;
  let next = clear + 2;
  let clearFlag = false;
  const dict = new Map();
  const block = new Uint8Array(255);
  let blen = 0, cur = 0, bits = 0;

  const flushByte = (b) => {
    block[blen++] = b;
    if (blen === 255) { w.byte(255); w.bytes(block); blen = 0; }
  };
  // Та же схема роста размера кода, что в классическом GIF-кодировщике
  const emit = (code) => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) { flushByte(cur & 255); cur >>>= 8; bits -= 8; }
    if (next > maxcode || clearFlag) {
      if (clearFlag) { size = minCode + 1; maxcode = (1 << size) - 1; clearFlag = false; }
      else { size++; maxcode = size === 12 ? 4096 : (1 << size) - 1; }
    }
  };

  w.byte(minCode);
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next < 4096) dict.set(key, next++);
    else { dict.clear(); next = clear + 2; clearFlag = true; emit(clear); }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) flushByte(cur & 255);
  if (blen) { w.byte(blen); w.bytes(block.subarray(0, blen)); }
  w.byte(0);
}

// ---------------------------------------------------------------------------
// Кадр
// ---------------------------------------------------------------------------
function encodeFrame(src) {
  const n = W * H;
  const first = frameNo === 0;

  // 1) какие пиксели изменились (на первом кадре — все)
  const changed = new Uint8Array(n);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    let ch = first;
    if (!ch) {
      const dr = Math.abs(src[i] - prevSrc[i]);
      const dg = Math.abs(src[i + 1] - prevSrc[i + 1]);
      const db = Math.abs(src[i + 2] - prevSrc[i + 2]);
      ch = dr > SAME || dg > SAME || db > SAME;
    }
    if (ch) {
      changed[p] = 1;
      const x = p % W, y = (p / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }

  // Ничего не изменилось — крошечный прозрачный кадр, только чтобы сохранить тайминг
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; }
  const fw = x1 - x0 + 1, fh = y1 - y0 + 1;

  // 2) палитра только по изменившимся пикселям
  const pal = buildPalette(src, first ? null : changed, n, 255);
  const nearest = nearestFinder(pal);

  // 3) сглаживание Флойда–Стейнберга змейкой внутри прямоугольника изменений
  const idx = new Uint8Array(fw * fh);
  let errCur = new Float32Array((fw + 2) * 3);
  let errNext = new Float32Array((fw + 2) * 3);
  for (let y = 0; y < fh; y++) {
    const ltr = (y & 1) === 0;
    errNext.fill(0);
    for (let xi = 0; xi < fw; xi++) {
      const x = ltr ? xi : fw - 1 - xi;
      const p = (y + y0) * W + (x + x0);
      const i = p * 4;
      const e = (x + 1) * 3;
      if (!changed[p]) { idx[y * fw + x] = TRANSPARENT; continue; }
      const r = Math.max(0, Math.min(255, src[i] + errCur[e] * DITHER));
      const g = Math.max(0, Math.min(255, src[i + 1] + errCur[e + 1] * DITHER));
      const b = Math.max(0, Math.min(255, src[i + 2] + errCur[e + 2] * DITHER));
      const k = nearest(r | 0, g | 0, b | 0);
      idx[y * fw + x] = k;
      const c = pal[k];
      const er = r - c[0], eg = g - c[1], eb = b - c[2];
      const dir = ltr ? 3 : -3;
      // вправо 7/16, вниз-влево 3/16, вниз 5/16, вниз-вправо 1/16
      errCur[e + dir] += er * 7 / 16; errCur[e + dir + 1] += eg * 7 / 16; errCur[e + dir + 2] += eb * 7 / 16;
      errNext[e - dir] += er * 3 / 16; errNext[e - dir + 1] += eg * 3 / 16; errNext[e - dir + 2] += eb * 3 / 16;
      errNext[e] += er * 5 / 16; errNext[e + 1] += eg * 5 / 16; errNext[e + 2] += eb * 5 / 16;
      errNext[e + dir] += er / 16; errNext[e + dir + 1] += eg / 16; errNext[e + dir + 2] += eb / 16;
      // запоминаем, что «показано» в этом пикселе
      prevSrc[i] = src[i]; prevSrc[i + 1] = src[i + 1]; prevSrc[i + 2] = src[i + 2];
    }
    const t = errCur; errCur = errNext; errNext = t;
  }

  // 4) запись: управление графикой (задержка, прозрачность, «оставить кадр»)
  out.byte(0x21); out.byte(0xF9); out.byte(4);
  out.byte((1 << 2) | 1);
  out.u16(delay);
  out.byte(TRANSPARENT);
  out.byte(0);
  // дескриптор кадра с собственной палитрой на 256 цветов
  out.byte(0x2C);
  out.u16(x0); out.u16(y0); out.u16(fw); out.u16(fh);
  out.byte(0x80 | 7);
  const table = new Uint8Array(256 * 3);
  pal.forEach((c, i) => { table[i * 3] = c[0]; table[i * 3 + 1] = c[1]; table[i * 3 + 2] = c[2]; });
  out.bytes(table);
  lzw(idx, 8, out);
  frameNo++;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') {
    W = m.width; H = m.height; delay = m.delayCs; frameNo = 0;
    prevSrc = new Uint8Array(W * H * 4);
    out = new ByteWriter();
    out.str('GIF89a');
    out.u16(W); out.u16(H);
    out.byte(0x70); out.byte(0); out.byte(0);   // без общей палитры
    out.byte(0x21); out.byte(0xFF); out.byte(11);
    out.str('NETSCAPE2.0');
    out.byte(3); out.byte(1); out.u16(0); out.byte(0); // бесконечный повтор
  } else if (m.type === 'frame') {
    encodeFrame(new Uint8ClampedArray(m.data));
    self.postMessage({ type: 'progress', done: frameNo });
  } else if (m.type === 'end') {
    out.byte(0x3B);
    const data = out.result();
    self.postMessage({ type: 'result', data: data.buffer }, [data.buffer]);
    out = null; prevSrc = null;
  }
};
