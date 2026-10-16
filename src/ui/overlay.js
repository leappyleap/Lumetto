'use strict';
// Вспышка и превью «как скриншот на айфоне»:
// 1) экран мягко вспыхивает;
// 2) кадр момента нажатия появляется на весь экран и пружинисто сжимается в угол;
// 3) пока дописываются секунды «после», внизу превью бежит тонкая полоска;
// 4) клип сохранён — превью оживает (играет сам клип) и через пару секунд уезжает.

const api = window.lumetto;
const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const flash = $('flash');
const thumb = $('thumb');
const img = $('img');
const vid = $('vid');
const bar = $('bar');
const err = $('err');

const SPRING = 'cubic-bezier(.32, 1.18, .42, 1)';
const OUT = 'cubic-bezier(.2, .8, .2, 1)';
const IN = 'cubic-bezier(.4, 0, .9, .5)';

let cur = null;          // { id, t0, after, preview, flashAt, saved, hovering, shown }
let hideTimer = 0;
let errTimer = 0;
let posterUrl = null;

function setGeometry(p) {
  root.style.setProperty('--aspect', String(p.aspect || 16 / 9));
  root.style.setProperty('--inset-r', `${(p.inset && p.inset.right) || 0}px`);
  root.style.setProperty('--inset-b', `${(p.inset && p.inset.bottom) || 0}px`);
  // Превью ~15% ширины экрана, но в разумных пределах
  const w = Math.round(Math.min(300, Math.max(200, window.innerWidth * 0.15)));
  root.style.setProperty('--thumb-w', `${w}px`);
}

function anyVisible() {
  return thumb.classList.contains('on') || err.dataset.on === '1' || flash.getAnimations().length > 0;
}

function maybeDone() {
  if (!anyVisible()) api.overlayDone();
}

function resetThumb() {
  clearTimeout(hideTimer);
  thumb.getAnimations().forEach((a) => a.cancel());
  bar.getAnimations().forEach((a) => a.cancel());
  thumb.classList.remove('on', 'saved', 'settled');
  thumb.style.transform = '';
  thumb.querySelector('.inner').style.borderRadius = '';
  vid.classList.remove('on');
  vid.pause();
  vid.removeAttribute('src');
  vid.load();
  img.removeAttribute('src');
  if (posterUrl) { URL.revokeObjectURL(posterUrl); posterUrl = null; }
  api.overlayMouse(true);
}

function doFlash() {
  flash.getAnimations().forEach((a) => a.cancel());
  // Быстро вспыхивает, держится и плавно гаснет (~0,95 с)
  const a = flash.animate([
    { opacity: 0, easing: 'ease-out' },
    { opacity: 1, offset: 0.06 },
    { opacity: 0.94, offset: 0.3, easing: 'cubic-bezier(.3, 0, .2, 1)' },
    { opacity: 0 },
  ], { duration: 950 });
  a.finished.then(maybeDone, () => {});
}

async function showPoster(data) {
  if (!cur || !cur.preview || cur.shown) return;
  cur.shown = true;
  posterUrl = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
  img.src = posterUrl;
  try { await img.decode(); } catch { /* покажем как есть */ }
  if (!cur) return;

  thumb.classList.add('on');
  const r = thumb.getBoundingClientRect();
  const s = window.innerWidth / r.width;
  const from = `translate(${-r.left}px, ${-r.top}px) scale(${s})`;

  // Пусть кадр «родится» под вспышкой и начнёт сжиматься, когда она гаснет
  const delay = Math.max(0, (cur.flashAt + 320) - performance.now());
  const inner = thumb.querySelector('.inner');
  // Держим кадр во весь экран, пока гаснет вспышка, затем — пружина в угол
  thumb.style.transform = from;
  inner.style.borderRadius = `${2 / s}px`;
  setTimeout(() => {
    if (!cur || !thumb.classList.contains('on')) return;
    thumb.style.transform = '';
    inner.style.borderRadius = '';
    thumb.animate([{ transform: from }, { transform: 'none' }], { duration: 640, easing: SPRING })
      .finished.then(() => thumb.classList.add('settled'), () => {});
    inner.animate([{ borderRadius: `${2 / s}px` }, { borderRadius: '14px' }], { duration: 640, easing: OUT });
  }, delay);

  // Полоска «дописываю после»: от текущего момента до конца записи
  if (!cur.saved) {
    const total = cur.after * 1000 + 300;
    const done = Math.min(total, performance.now() - cur.t0);
    bar.animate([{ width: `${(done / total) * 100}%` }, { width: '100%' }], {
      duration: Math.max(1, total - done), easing: 'linear', fill: 'forwards',
    });
  }
}

function markSaved(p) {
  if (!cur || p.id !== cur.id) return;
  cur.saved = true;
  if (!cur.preview) { cur = null; maybeDone(); return; }
  thumb.classList.add('saved');
  if (p.video) {
    vid.src = p.video;
    vid.addEventListener('playing', () => vid.classList.add('on'), { once: true });
    vid.play().catch(() => {});
  }
  // Короткий «вдох» превью — момент ожил
  thumb.querySelector('.inner').animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.04)' }, { transform: 'scale(1)' }],
    { duration: 520, easing: OUT },
  );
  scheduleHide(3600);
}

function scheduleHide(ms) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (cur && cur.hovering) return;
    hideThumb();
  }, ms);
}

function hideThumb(fast = false) {
  clearTimeout(hideTimer);
  if (!thumb.classList.contains('on')) { cur = null; maybeDone(); return; }
  const a = thumb.animate([
    { transform: 'none', opacity: 1 },
    { transform: 'translateX(calc(100% + 40px))', opacity: 0 },
  ], { duration: fast ? 220 : 420, easing: IN, fill: 'forwards' });
  a.finished.then(() => {
    resetThumb();
    cur = null;
    maybeDone();
  }, () => {});
}

function showError(p) {
  clearTimeout(errTimer);
  if (thumb.classList.contains('on') && cur && p.id === cur.id) hideThumb(true);
  $('errTitle').textContent = p.title || 'Error';
  $('errText').textContent = p.text || '';
  err.dataset.on = '1';
  err.getAnimations().forEach((a) => a.cancel());
  err.animate([{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'none' }],
    { duration: 380, easing: OUT, fill: 'forwards' });
  errTimer = setTimeout(() => {
    err.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(16px)' }],
      { duration: 300, easing: IN, fill: 'forwards' }).finished.then(() => {
      err.dataset.on = '0';
      maybeDone();
    }, () => {});
  }, 2600);
}

api.onOverlay((p) => {
  if (p.aspect) setGeometry(p);

  if (p.type === 'start') {
    resetThumb();
    cur = {
      id: p.id, t0: performance.now(), after: p.after || 1.5,
      preview: p.preview !== false, flashAt: performance.now(), saved: false, hovering: false, shown: false,
    };
    if (p.flash !== false) doFlash();
    else cur.flashAt = performance.now() - 320;
    if (!cur.preview && p.flash === false) maybeDone();
  } else if (p.type === 'poster') {
    if (cur && p.id === cur.id) showPoster(p.data);
  } else if (p.type === 'saved') {
    markSaved(p);
  } else if (p.type === 'error') {
    showError(p);
  }
});

thumb.addEventListener('mouseenter', () => {
  api.overlayMouse(false);
  if (cur) cur.hovering = true;
  clearTimeout(hideTimer);
});
thumb.addEventListener('mouseleave', () => {
  api.overlayMouse(true);
  if (cur) {
    cur.hovering = false;
    if (cur.saved) scheduleHide(1600);
  }
});
thumb.addEventListener('click', () => {
  if (!cur) return;
  const id = cur.id;
  api.overlayMouse(true);
  hideThumb(true);
  api.overlayOpen(id);
});
