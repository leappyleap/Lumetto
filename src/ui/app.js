'use strict';

const api = window.lumetto;
const $ = (id) => document.getElementById(id);

const state = {
  shots: [],
  settings: null,
  status: { state: 'starting' },
  viewerIndex: -1,
  viewerBusy: false,
};

// ---------------------------------------------------------------------------
// Форматирование
// ---------------------------------------------------------------------------
const { t } = I18N;
const sec = (s) => I18N.num(Math.round(s * 10) / 10, 1);
const secU = (s) => `${sec(s)}${t('unit.s')}`;
const p2 = (n) => String(n).padStart(2, '0');
const sizeLabel = (bytes) => {
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${I18N.num(mb / 1024, 1)}${t('unit.gb')}` : `${I18N.num(Math.max(0.1, mb), 1)}${t('unit.mb')}`;
};

const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (dayKey(ts) === dayKey(today)) return t('day.today');
  if (dayKey(ts) === dayKey(yest)) return t('day.yesterday');
  const opts = { day: 'numeric', month: 'long', weekday: 'long' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  const s = new Intl.DateTimeFormat(I18N.locale, opts).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const timeLabel = (ts) => { const d = new Date(ts); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };

function keysFor(acc) {
  const frag = document.createDocumentFragment();
  if (!acc) return frag;
  for (const part of acc.split('+')) {
    const k = document.createElement('kbd');
    k.textContent = part.replace(/^(CommandOrControl|Control)$/, 'Ctrl').replace(/^(Super|Meta)$/, 'Win');
    frag.appendChild(k);
  }
  return frag;
}

function setKeys(el, acc) { el.replaceChildren(keysFor(acc)); }

const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;

// ---------------------------------------------------------------------------
// Уведомления внутри окна
// ---------------------------------------------------------------------------
function toast(text, iconName = 'check') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `${icon(iconName)}<span></span>`;
  el.querySelector('span').textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 2400);
}

// ---------------------------------------------------------------------------
// Сетка
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Серии: моменты, чьи клипы перекрываются по времени, играют одно за другим
// ---------------------------------------------------------------------------
const SERIES_GAP_MS = 250;

function computeSeries() {
  const arr = state.shots.filter((x) => x.start != null).sort((a, b) => a.start - b.start);
  state.series = new Map();
  let cur = null;
  let n = 0;
  for (const x of state.shots) { x.seriesId = null; x.seriesIndex = 0; x.seriesCount = 1; }
  for (const x of arr) {
    const end = x.start + (x.duration || 3) * 1000;
    if (cur && x.start <= cur.end + SERIES_GAP_MS) {
      cur.items.push(x);
      cur.end = Math.max(cur.end, end);
    } else {
      cur = { id: `s${n++}`, items: [x], end };
      state.series.set(cur.id, cur);
    }
    x.seriesId = cur.id;
  }
  for (const c of state.series.values()) {
    c.items.forEach((x, i) => { x.seriesIndex = i; x.seriesCount = c.items.length; });
  }
}

function seriesItems(shot) {
  const c = shot && shot.seriesId && state.series && state.series.get(shot.seriesId);
  return c ? c.items : [shot];
}

// Следующий по времени момент серии; после последнего — снова первый
function nextInSeries(shot, wrap = true) {
  const items = seriesItems(shot);
  if (items.length < 2) return null;
  const i = items.indexOf(shot);
  if (i < items.length - 1) return items[i + 1];
  return wrap ? items[0] : null;
}

function refreshSeriesBadges() {
  for (const x of state.shots) {
    const t = tileEl(x.id);
    if (!t) continue;
    let b = t.querySelector('.t-series');
    if (x.seriesCount > 1) {
      if (!b) {
        b = document.createElement('span');
        b.className = 't-series';
        t.appendChild(b);
      }
      b.innerHTML = `${icon('series')}<span>${x.seriesIndex + 1}/${x.seriesCount}</span>`;
      b.title = I18N.t('series.badge');
    } else if (b) b.remove();
  }
}

let hoveredTile = null;

function tileEl(id) { return document.querySelector(`.tile[data-id="${CSS.escape(id)}"]`); }

function createTile(shot, delay = 0) {
  const t = document.createElement('button');
  t.className = 'tile';
  t.dataset.id = shot.id;
  t.style.setProperty('--d', `${delay}ms`);
  t.innerHTML = `
    <span class="shade"></span>
    <span class="t-live">${icon('live')}LIVE</span>
    <span class="t-meta"><span class="t-time"></span><span class="t-dur"></span></span>`;
  t.querySelector('.t-time').textContent = timeLabel(shot.created);
  t.querySelector('.t-dur').textContent = shot.duration ? secU(shot.duration) : '';

  if (shot.poster) {
    const img = new Image();
    img.decoding = 'async';
    img.loading = 'lazy';
    img.alt = '';
    img.onload = () => img.classList.add('loaded');
    img.src = shot.poster;
    t.prepend(img);
  }

  // Как в «Фото» на iPhone: это фото, а оживает, пока зажат пробел
  let video = null;
  t._live = () => {
    if (video) return;
    const v = document.createElement('video');
    video = v;
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = shot.video;
    v.addEventListener('playing', () => { if (video === v) { v.classList.add('on'); t.classList.add('playing'); } }, { once: true });
    v.addEventListener('ended', () => t._still());
    t.prepend(v);
    v.play().catch(() => {});
  };
  t._still = () => {
    t.classList.remove('playing');
    const v = video; video = null;
    if (v) {
      v.classList.remove('on');
      setTimeout(() => { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }, 380);
    }
  };
  t.title = I18N.t('tile.hold');
  t.addEventListener('mouseenter', () => { hoveredTile = t; });
  t.addEventListener('mouseleave', () => { if (hoveredTile === t) hoveredTile = null; t._still(); });
  t.addEventListener('click', () => openViewer(state.shots.findIndex((s) => s.id === shot.id)));
  return t;
}

function createGroup(key, label) {
  const g = document.createElement('section');
  g.className = 'group';
  g.dataset.day = key;
  g.innerHTML = '<div class="group-head"><span class="group-title"></span><span class="group-count"></span></div><div class="grid"></div>';
  g.querySelector('.group-title').textContent = label;
  return g;
}

function updateGroupCounts() {
  document.querySelectorAll('.group').forEach((g) => {
    const n = g.querySelectorAll('.tile:not(.removing)').length;
    g.querySelector('.group-count').textContent = String(n);
  });
}

function updateMeta() {
  const n = state.shots.length;
  const bytes = state.shots.reduce((a, s) => a + (s.size || 0), 0);
  $('count').textContent = n ? `${I18N.count(n)} · ${sizeLabel(bytes)}` : t('hero.empty');
  $('empty').hidden = n > 0;
  $('hint').style.visibility = n ? 'visible' : 'hidden';
  updateGroupCounts();
}

function renderAll() {
  computeSeries();
  const root = $('groups');
  root.replaceChildren();
  let group = null;
  let i = 0;
  for (const shot of state.shots) {
    const key = dayKey(shot.created);
    if (!group || group.dataset.day !== key) {
      group = createGroup(key, dayLabel(shot.created));
      root.appendChild(group);
    }
    group.querySelector('.grid').appendChild(createTile(shot, i < 24 ? i * 28 : 0));
    i++;
  }
  updateMeta();
  refreshSeriesBadges();
}

function addShot(shot) {
  state.shots.unshift(shot);
  if (state.viewerIndex >= 0) state.viewerIndex++;
  const key = dayKey(shot.created);
  let first = $('groups').firstElementChild;
  if (!first || first.dataset.day !== key) {
    first = createGroup(key, dayLabel(shot.created));
    $('groups').prepend(first);
  }
  const tile = createTile(shot);
  tile.classList.add('fresh');
  first.querySelector('.grid').prepend(tile);
  computeSeries();
  updateMeta();
  refreshSeriesBadges();
}

function removeShotFromGrid(id) {
  const idx = state.shots.findIndex((s) => s.id === id);
  if (idx >= 0) state.shots.splice(idx, 1);
  computeSeries();
  refreshSeriesBadges();
  const t = tileEl(id);
  if (t) {
    t.classList.add('removing');
    setTimeout(() => {
      const g = t.closest('.group');
      t.remove();
      if (g && !g.querySelector('.tile')) g.remove();
      updateMeta();
    }, 380);
  }
  updateMeta();
}

async function loadShots() {
  state.shots = await api.listShots();
  renderAll();
}

// ---------------------------------------------------------------------------
// Просмотрщик
// ---------------------------------------------------------------------------
const viewer = $('viewer');
const vFrame = $('vFrame');
const vPoster = $('vPoster');
// Два плеера: активный и запасной — для бесшовного перехода внутри серии
let vVideo = $('vVideo');
let vSpare = $('vVideo2');
let standby = null;       // id момента, загруженного в запасной плеер
let crossfading = false;
let xfadeAnim = null;
const XFADE = 0.45;       // секунды на перетекание
let rafId = 0;
let scrubbing = false;
let live = false;          // идёт ли сейчас «живое» воспроизведение
let holdTimer = 0;
let reloadTimer = 0;       // отложенная подгрузка видео после возврата к началу серии

function currentShot() { return state.shots[state.viewerIndex]; }

function fitFrame(shot) {
  const stage = $('vStage').getBoundingClientRect();
  const ar = shot.width && shot.height ? shot.width / shot.height : 16 / 9;
  let w = stage.width, h = w / ar;
  if (h > stage.height) { h = stage.height; w = h * ar; }
  vFrame.style.width = `${Math.round(w)}px`;
  vFrame.style.height = `${Math.round(h)}px`;
}

function shotDuration(shot) {
  return Number.isFinite(vVideo.duration) && vVideo.duration > 0 ? vVideo.duration : (shot.duration || 3);
}

function updateViewerMeta(shot) {
  $('vDate').textContent = t('v.dateTime', { day: dayLabel(shot.created), time: timeLabel(shot.created) });
  const parts = [];
  if (shot.width) parts.push(`${shot.width} × ${shot.height}`);
  if (shot.size) parts.push(sizeLabel(shot.size));
  parts.push(t('v.of', { a: state.viewerIndex + 1, b: state.shots.length }));
  $('vSub').replaceChildren(document.createTextNode(parts.join(' · ')));
  if (shot.seriesCount > 1) {
    const sp = document.createElement('span');
    sp.className = 'v-series';
    sp.textContent = ` · ${t('v.series', { a: shot.seriesIndex + 1, b: shot.seriesCount })}`;
    $('vSub').appendChild(sp);
  }

  const dur = shot.duration || 3;
  $('vDur').textContent = sec(dur);
  const key = $('vKey');
  if (shot.keyTime != null) { key.style.display = ''; key.style.left = `${Math.min(100, (shot.keyTime / dur) * 100)}%`; }
  else key.style.display = 'none';

  $('vPrev').disabled = state.viewerIndex <= 0;
  $('vNext').disabled = state.viewerIndex >= state.shots.length - 1;
}

function clearVideo(v) {
  v.getAnimations().forEach((a) => a.cancel());
  v.pause();
  v.removeAttribute('src');
  v.load();
}

function resetPlayers() {
  crossfading = false;
  standby = null;
  clearVideo(vSpare);
  vSpare.style.opacity = '0';
  vSpare.style.zIndex = '0';
  vVideo.style.opacity = '1';
  vVideo.style.zIndex = '1';
}

// Положение «фото» на шкале — момент нажатия хоткея
function showStillPosition(shot) {
  if (!shot) return;
  const dur = shotDuration(shot);
  const k = shot.keyTime != null ? Math.min(1, shot.keyTime / dur) : 0;
  $('vFill').style.width = `${k * 100}%`;
  $('vThumb').style.left = `${k * 100}%`;
  $('vTime').textContent = sec(k * dur);
}

function setLiveUi(on) {
  vFrame.classList.toggle('live', on);
  $('vLiveBtn').classList.toggle('on', on);
}

// Момент открывается как фото; видео лишь подгружается заранее
function loadStill(shot) {
  resetPlayers();
  vVideo.pause();
  vVideo.loop = false;
  vVideo.src = shot.video;
  vVideo.currentTime = 0;
  showStillPosition(shot);
}

// Серия доиграла — плавно возвращаемся к первому фото серии, чтобы можно было пересмотреть
function finishSeries() {
  const shot = currentShot();
  const first = seriesItems(shot)[0];
  if (!first || first === shot) { stopLive(); return; }
  live = false;
  setLiveUi(false);
  if (crossfading) resetPlayers();

  const oldTile = tileEl(shot.id);
  if (oldTile) oldTile.classList.remove('hidden-for-viewer');
  state.viewerIndex = state.shots.indexOf(first);
  const t = tileEl(first.id);
  if (t) t.classList.add('hidden-for-viewer');
  if (first.width !== shot.width || first.height !== shot.height) fitFrame(first);
  updateViewerMeta(first);

  // Фото первого кадра проявляется поверх доигравшего видео
  const reveal = () => vPoster.classList.remove('gone');
  if (first.poster) {
    vPoster.src = first.poster;
    vPoster.decode().then(reveal, reveal);
  } else reveal();

  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = 0;
    if (!live) loadStill(first);
  }, 420);
}

function setViewerShot(shot) {
  clearTimeout(holdTimer);
  clearTimeout(reloadTimer);
  reloadTimer = 0;
  live = false;
  setLiveUi(false);
  updateViewerMeta(shot);
  resetPlayers();
  vPoster.classList.remove('gone');
  if (shot.poster) vPoster.src = shot.poster; else vPoster.removeAttribute('src');
  vVideo.loop = false;
  vVideo.preload = 'auto';
  vVideo.src = shot.video;
  vVideo.pause();
  vVideo.currentTime = 0;
  showStillPosition(shot);
}

function startLive() {
  const shot = currentShot();
  if (!shot || live || scrubbing || state.viewerBusy || viewer.hidden) return;
  if (reloadTimer) {
    // пробел нажат сразу после возврата к началу серии — грузим её первый клип
    clearTimeout(reloadTimer);
    reloadTimer = 0;
    loadStill(shot);
  }
  live = true;
  setLiveUi(true);
  resetPlayers();
  vVideo.currentTime = 0;
  vVideo.play().catch(() => {});
}

function stopLive() {
  clearTimeout(holdTimer);
  if (!live) return;
  live = false;
  if (crossfading) resetPlayers(); // отпустили посреди перехода — остаёмся на текущем
  setLiveUi(false);
  vPoster.classList.remove('gone'); // фото плавно возвращается поверх видео
  const v = vVideo;
  setTimeout(() => { if (!live && v === vVideo) { v.pause(); v.currentTime = 0; } }, 380);
  showStillPosition(currentShot());
}

// Где в следующем клипе «то же самое мгновение», что сейчас в текущем
function offsetFor(cur, nxt, tCur) {
  if (seriesItems(cur).indexOf(nxt) === 0) return 0; // круг замкнулся — с начала
  const t = (cur.start + tCur * 1000 - nxt.start) / 1000;
  return Math.max(0, Math.min(t, (nxt.duration || 3) - 0.1));
}

function prepareStandby(cur, nxt) {
  if (standby === nxt.id) return;
  standby = nxt.id;
  vSpare.loop = false;
  vSpare.src = nxt.video;
  vSpare.currentTime = offsetFor(cur, nxt, shotDuration(cur) - XFADE);
  vSpare.pause();
}

function crossfadeTo(nxt) {
  const cur = currentShot();
  crossfading = true;
  prepareStandby(cur, nxt);
  const incoming = vSpare;
  const outgoing = vVideo;
  const off = offsetFor(cur, nxt, outgoing.currentTime);
  if (Math.abs(incoming.currentTime - off) > 0.08) incoming.currentTime = off;
  incoming.style.zIndex = '2';
  outgoing.style.zIndex = '1';
  incoming.play().catch(() => {});
  xfadeAnim = incoming.animate([{ opacity: 0 }, { opacity: 1 }], { duration: XFADE * 1000, easing: 'ease-in-out' });
  xfadeAnim.finished.then(() => {
      if (!crossfading) return; // за это время пользователь пролистал
      incoming.style.opacity = '1';
      clearVideo(outgoing);
      outgoing.style.opacity = '0';
      outgoing.style.zIndex = '0';
      vVideo = incoming;
      vSpare = outgoing;
      standby = null;
      crossfading = false;

      const oldTile = tileEl(cur.id);
      if (oldTile) oldTile.classList.remove('hidden-for-viewer');
      state.viewerIndex = state.shots.indexOf(nxt);
      const t = tileEl(nxt.id);
      if (t) t.classList.add('hidden-for-viewer');
      vVideo.loop = false;
      if (nxt.poster) vPoster.src = nxt.poster;
      if (nxt.width !== cur.width || nxt.height !== cur.height) fitFrame(nxt);
      updateViewerMeta(nxt);
    }, () => {});
}

// Следит за серией: заранее грузит следующий клип и перетекает в него у конца
function seriesTick() {
  const shot = currentShot();
  if (!shot || !live || scrubbing || crossfading) return;
  const dur = shotDuration(shot);
  const nxt = nextInSeries(shot, false);
  if (nxt) {
    prepareStandby(shot, nxt);
    if (vVideo.ended || vVideo.currentTime >= dur - XFADE - 0.04) crossfadeTo(nxt);
  } else if (vVideo.ended || vVideo.currentTime >= dur - 0.04) {
    // Как на iPhone: клип доиграл — снова фото, даже если пробел ещё зажат.
    // Для серии — фото её первого момента.
    if (shot.seriesCount > 1) finishSeries();
    else stopLive();
  }
}

for (const v of [vVideo, vSpare]) {
  v.addEventListener('playing', () => { if (v === vVideo && live) vPoster.classList.add('gone'); });
  v.addEventListener('loadedmetadata', onMeta);
}
function onMeta(e) {
  if (e.target !== vVideo || crossfading) return;
  const shot = currentShot();
  if (!shot) return;
  const dur = shotDuration(shot);
  $('vDur').textContent = sec(dur);
  if (shot.keyTime != null) $('vKey').style.left = `${Math.min(100, (shot.keyTime / dur) * 100)}%`;
  if (!live && !scrubbing) showStillPosition(shot);
}

function loop() {
  const shot = currentShot();
  if (shot && !scrubbing && live && !crossfading) {
    const dur = shotDuration(shot);
    const k = Math.min(1, vVideo.currentTime / dur);
    $('vFill').style.width = `${k * 100}%`;
    $('vThumb').style.left = `${k * 100}%`;
    $('vTime').textContent = sec(vVideo.currentTime);
  }
  seriesTick();
  rafId = requestAnimationFrame(loop);
}

function frameRect() { return vFrame.getBoundingClientRect(); }

function flipFrom(rect, opts = {}) {
  const f = frameRect();
  const dx = rect.left - f.left, dy = rect.top - f.top;
  const sx = rect.width / f.width, sy = rect.height / f.height;
  return vFrame.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: `${12 / sx}px / ${12 / sy}px` },
    { transform: 'none', borderRadius: '14px' },
  ], { duration: 460, easing: 'cubic-bezier(.2,.8,.2,1)', ...opts });
}

function openViewer(index) {
  if (index < 0 || state.viewerBusy) return;
  state.viewerIndex = index;
  const shot = currentShot();
  const tile = tileEl(shot.id);
  viewer.hidden = false;
  fitFrame(shot);
  setViewerShot(shot);
  cancelAnimationFrame(rafId);
  loop();

  if (tile) {
    flipFrom(tile.getBoundingClientRect());
    tile.classList.add('hidden-for-viewer');
  } else {
    vFrame.animate([{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  requestAnimationFrame(() => viewer.classList.add('open'));
  showLiveHint();
}

function showLiveHint() {
  let n = 0;
  try { n = Number(localStorage.getItem('liveHint') || 0); } catch { /* */ }
  if (n >= 3) return;
  try { localStorage.setItem('liveHint', String(n + 1)); } catch { /* */ }
  setTimeout(() => { if (!viewer.hidden && !live) toast(t('toast.hint'), 'live'); }, 700);
}

function isInView(el) {
  const r = el.getBoundingClientRect();
  const sc = $('scroll').getBoundingClientRect();
  return r.bottom > sc.top + 44 && r.top < sc.bottom && r.width > 0;
}

function closeViewer() {
  if (viewer.hidden || state.viewerBusy) return;
  stopLive();
  state.viewerBusy = true;
  const shot = currentShot();
  const tile = shot && tileEl(shot.id);
  viewer.classList.remove('open');

  const finish = () => {
    viewer.hidden = true;
    resetPlayers();
    clearVideo(vVideo);
    cancelAnimationFrame(rafId);
    document.querySelectorAll('.hidden-for-viewer').forEach((t) => t.classList.remove('hidden-for-viewer'));
    state.viewerIndex = -1;
    state.viewerBusy = false;
  };

  if (tile && isInView(tile)) {
    const f = frameRect();
    const r = tile.getBoundingClientRect();
    const sx = r.width / f.width, sy = r.height / f.height;
    vFrame.animate([
      { transform: 'none', borderRadius: '14px' },
      { transform: `translate(${r.left - f.left}px, ${r.top - f.top}px) scale(${sx}, ${sy})`, borderRadius: `${12 / sx}px / ${12 / sy}px` },
    ], { duration: 400, easing: 'cubic-bezier(.3,.7,.1,1)', fill: 'forwards' }).finished.then(() => {
      finish();
      vFrame.getAnimations().forEach((a) => a.cancel());
    });
  } else {
    vFrame.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.96)' }], { duration: 260, easing: 'ease-in', fill: 'forwards' })
      .finished.then(() => { finish(); vFrame.getAnimations().forEach((a) => a.cancel()); });
  }
}

function navigate(delta) {
  const next = state.viewerIndex + delta;
  if (next < 0 || next >= state.shots.length) return;
  const old = currentShot();
  const oldTile = old && tileEl(old.id);
  if (oldTile) oldTile.classList.remove('hidden-for-viewer');
  state.viewerIndex = next;
  const shot = currentShot();
  const t = tileEl(shot.id);
  if (t) {
    t.classList.add('hidden-for-viewer');
    if (!isInView(t)) t.scrollIntoView({ block: 'center' });
  }
  fitFrame(shot);
  setViewerShot(shot);
  vFrame.animate([
    { opacity: 0, transform: `translateX(${delta * 28}px) scale(.985)` },
    { opacity: 1, transform: 'none' },
  ], { duration: 360, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

// Удержание: мышью на фото (с небольшой задержкой, чтобы клик не дёргал) и на кнопке LIVE
function holdStart(e, delay) {
  if (e.button !== 0) return;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(startLive, delay);
}

// Перемотка
(() => {
  const scrub = $('vScrub');
  const seek = (e) => {
    const r = scrub.getBoundingClientRect();
    const k = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const dur = shotDuration(currentShot());
    vVideo.currentTime = Math.min(dur - 0.01, k * dur);
    $('vFill').style.width = `${k * 100}%`;
    $('vThumb').style.left = `${k * 100}%`;
    $('vTime').textContent = sec(k * dur);
  };
  scrub.addEventListener('pointerdown', (e) => {
    stopLive();
    scrubbing = true; scrub.classList.add('dragging');
    vVideo.pause();
    vPoster.classList.add('gone'); // пока тянем — видны кадры видео
    scrub.setPointerCapture(e.pointerId);
    seek(e);
  });
  scrub.addEventListener('pointermove', (e) => { if (scrubbing) seek(e); });
  const end = () => {
    if (!scrubbing) return;
    scrubbing = false; scrub.classList.remove('dragging');
    vPoster.classList.remove('gone'); // отпустили — снова фото
    showStillPosition(currentShot());
  };
  scrub.addEventListener('pointerup', end);
  scrub.addEventListener('pointercancel', end);
})();

async function deleteCurrent() {
  const shot = currentShot();
  if (!shot || state.viewerBusy) return;
  const idx = state.viewerIndex;
  await api.deleteShot(shot.id);
  toast(t('toast.trash'), 'trash');
  if (state.shots.length <= 1) {
    removeShotFromGrid(shot.id);
    state.viewerIndex = -1;
    viewer.classList.remove('open');
    vFrame.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.96)' }], { duration: 240, fill: 'forwards' })
      .finished.then(() => { viewer.hidden = true; vFrame.getAnimations().forEach((a) => a.cancel()); resetPlayers(); clearVideo(vVideo); });
    return;
  }
  vFrame.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.97)' }], { duration: 200, easing: 'ease-in' }).finished.then(() => {
    removeShotFromGrid(shot.id);
    state.viewerIndex = Math.min(idx, state.shots.length - 1);
    const next = currentShot();
    const tl = tileEl(next.id);
    if (tl) tl.classList.add('hidden-for-viewer');
    fitFrame(next);
    setViewerShot(next);
    vFrame.animate([{ opacity: 0, transform: 'scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
  });
}

// Экспорт в GIF
function once(el, ev) { return new Promise((res, rej) => { el.addEventListener(ev, res, { once: true }); el.addEventListener('error', rej, { once: true }); }); }

async function exportGif() {
  const shot = currentShot();
  const btn = $('vGif');
  if (!shot || btn.classList.contains('busy')) return;
  btn.classList.add('busy');
  btn.innerHTML = '<svg class="ring-prog" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-opacity=".2"/><circle id="gifRing" cx="12" cy="12" r="9" stroke-dasharray="56.5" stroke-dashoffset="56.5" transform="rotate(-90 12 12)"/></svg>';
  const ring = btn.querySelector('#gifRing');
  const progress = (k) => { ring.style.strokeDashoffset = String(56.5 * (1 - k)); };

  try {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = shot.video;
    await once(v, 'loadeddata');
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : (shot.duration || 3);
    const fps = 15;
    const n = Math.max(2, Math.floor(dur * fps));
    const w = Math.min(560, v.videoWidth);
    const h = Math.round((w * v.videoHeight) / v.videoWidth / 2) * 2;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    const frames = [];
    for (let i = 0; i < n; i++) {
      v.currentTime = Math.min(dur - 0.02, i / fps);
      await once(v, 'seeked');
      ctx.drawImage(v, 0, 0, w, h);
      frames.push(ctx.getImageData(0, 0, w, h));
      progress((i + 1) / n * 0.45);
    }
    v.removeAttribute('src'); v.load();
    const data = await GifEncoder.encode(frames, 1000 / fps, (k) => progress(0.45 + k * 0.55));
    const saved = await api.saveGif(shot.id, data.buffer);
    if (saved) toast(t('toast.gifSaved'));
  } catch (e) {
    console.error(e);
    toast(t('toast.gifFail'), 'close');
  } finally {
    btn.classList.remove('busy');
    btn.innerHTML = icon('gif');
  }
}

$('vClose').addEventListener('click', closeViewer);
$('vBackdrop').addEventListener('click', closeViewer);
$('vPrev').addEventListener('click', () => navigate(-1));
$('vNext').addEventListener('click', () => navigate(1));
vFrame.addEventListener('pointerdown', (e) => holdStart(e, 160));
$('vLiveBtn').addEventListener('pointerdown', (e) => holdStart(e, 0));
for (const el of [vFrame, $('vLiveBtn')]) {
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(ev, stopLive);
}
$('vDelete').addEventListener('click', deleteCurrent);
$('vReveal').addEventListener('click', () => currentShot() && api.revealShot(currentShot().id));
$('vCopy').addEventListener('click', async () => {
  if (currentShot() && await api.copyFrame(currentShot().id)) toast(t('toast.copied'));
});
$('vGif').addEventListener('click', exportGif);

window.addEventListener('resize', () => { if (!viewer.hidden && currentShot()) fitFrame(currentShot()); });

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------
const drawer = $('drawer');
let recording = false;

function applySettingsToUi() {
  const s = state.settings;
  setKeys($('hintKeys'), s.hotkey);
  renderEmptyText();
  setKeys($('hotkeyKeys'), s.hotkey);
  $('saveDir').textContent = s.saveDir;
  $('tToast').checked = !!s.showToast;
  $('tFlash').checked = s.flash !== false;
  $('tLogin').checked = !!s.launchAtLogin;
  $('tBuffer').checked = !state.status.paused;
  const note = $('hotkeyNote');
  if (s.hotkeyOk === false) { note.textContent = t('set.hotkeyBusy'); note.classList.add('err'); }
  document.querySelectorAll('.seg').forEach((seg) => setSeg(seg, s[seg.dataset.key], false));
}

function renderEmptyText() {
  const s = state.settings;
  if (!s) return;
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const parts = t('empty.text').split('<br>').map(esc).join('<br>');
  $('emptyText').innerHTML = parts
    .replace('{keys}', '<span class="keys" id="emptyKeys"></span>')
    .replace('{before}', `<b>${esc(secU(s.before))}</b>`)
    .replace('{after}', `<b>${esc(secU(s.after))}</b>`);
  setKeys($('emptyKeys'), s.hotkey);
}

function applyStatic() {
  document.documentElement.lang = I18N.locale;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  $('hotkeyKeys').dataset.placeholder = t('set.hotkeyRec');
  const sel = $('lang');
  if (!sel.options.length) {
    for (const code of I18N.LANGS) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = I18N.NAMES[code];
      sel.appendChild(o);
    }
  }
  sel.value = I18N.lang;
}

async function setLanguage(code) {
  const res = await api.setSettings({ lang: code });
  state.settings = res.settings;
  I18N.setLang(state.settings.lang);
  const scroll = $('scroll').scrollTop;
  applyStatic();
  buildSegs();
  applySettingsToUi();
  renderStatus(state.status);
  renderAll();
  $('scroll').scrollTop = scroll;
  document.querySelectorAll('.tile').forEach((el) => { el.style.animation = 'none'; });
  if (!viewer.hidden && currentShot()) {
    updateViewerMeta(currentShot());
    const tile = tileEl(currentShot().id);
    if (tile) tile.classList.add('hidden-for-viewer');
  }
  // подписи мониторов тоже на новом языке
  if (drawer.classList.contains('on')) {
    const keep = $('display').value;
    await fillDisplays();
    $('display').value = keep;
  }
}

function buildSegs() {
  document.querySelectorAll('.seg').forEach((seg) => {
    const values = seg.dataset.values.split(',');
    const labels = seg.dataset.labels ? seg.dataset.labels.split(',').map((l) => (l[0] === '@' ? t(l.slice(1)) : l)) : null;
    const suffix = seg.dataset.unit ? t(seg.dataset.unit) : '';
    seg.innerHTML = '<span class="pill"></span>';
    values.forEach((v, i) => {
      const b = document.createElement('button');
      b.dataset.value = v;
      b.textContent = labels ? labels[i] : `${Number.isInteger(Number(v)) ? v : I18N.num(Number(v), 1)}${suffix}`;
      b.addEventListener('click', () => updateSetting(seg.dataset.key, Number(v)));
      seg.appendChild(b);
    });
  });
}

function setSeg(seg, value, animate = true) {
  const pill = seg.querySelector('.pill');
  let target = null;
  seg.querySelectorAll('button').forEach((b) => {
    const on = Number(b.dataset.value) === Number(value);
    b.classList.toggle('on', on);
    if (on) target = b;
  });
  if (!target) { pill.style.opacity = 0; return; }
  if (!animate) pill.style.transition = 'none';
  pill.style.opacity = 1;
  pill.style.width = `${target.offsetWidth}px`;
  pill.style.transform = `translateX(${target.offsetLeft}px)`;
  if (!animate) { void pill.offsetWidth; pill.style.transition = ''; }
}

async function updateSetting(key, value) {
  const res = await api.setSettings({ [key]: value });
  state.settings = res.settings;
  applySettingsToUi();
  return res;
}

async function fillDisplays() {
  const displays = await api.displays();
  const sel = $('display');
  sel.replaceChildren();
  displays.forEach((d) => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = `${d.label} — ${d.size}${d.primary ? ` (${t('set.primary')})` : ''}`;
    sel.appendChild(o);
  });
  const primary = displays.find((d) => d.primary);
  sel.value = state.settings.displayId || (primary && primary.id) || '';
}

async function openSettings() {
  state.settings = await api.getSettings();
  await fillDisplays();
  $('lang').value = I18N.lang;
  drawer.classList.add('on');
  drawer.setAttribute('aria-hidden', 'false');
  $('scrim').classList.add('on');
  requestAnimationFrame(applySettingsToUi);
}

function closeSettings() {
  stopRecording(true);
  drawer.classList.remove('on');
  drawer.setAttribute('aria-hidden', 'true');
  $('scrim').classList.remove('on');
}

// Запись сочетания клавиш
const CODE_MAP = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Insert: 'Insert', Delete: 'Delete',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down',
  ArrowLeft: 'Left', ArrowRight: 'Right', PrintScreen: 'PrintScreen', Pause: 'MediaPlayPause',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};
const STANDALONE_OK = /^(F\d{1,2}|PrintScreen|Insert|MediaPlayPause)$/;

function keyFromCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
  return CODE_MAP[code] || null;
}

function onRecordKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape') { stopRecording(true); return; }
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const key = keyFromCode(e.code);
  if (!key) { setKeys($('hotkeyKeys'), mods.join('+')); return; }
  if (!mods.length && !STANDALONE_OK.test(key)) {
    $('hotkeyNote').textContent = t('set.hotkeyMod');
    $('hotkeyNote').classList.add('err');
    return;
  }
  const acc = [...mods, key].join('+');
  setKeys($('hotkeyKeys'), acc);
  finishRecording(acc);
}

function startRecording() {
  if (recording) return;
  recording = true;
  api.suspendHotkey();
  $('hotkey').classList.add('rec');
  $('hotkeyKeys').replaceChildren();
  $('hotkeyNote').textContent = t('set.hotkeyNote');
  $('hotkeyNote').classList.remove('err');
  window.addEventListener('keydown', onRecordKey, true);
}

async function finishRecording(acc) {
  window.removeEventListener('keydown', onRecordKey, true);
  recording = false;
  $('hotkey').classList.remove('rec');
  const res = await updateSetting('hotkey', acc);
  await api.resumeHotkey();
  const note = $('hotkeyNote');
  if (res.ok) { note.textContent = t('set.saved'); note.classList.remove('err'); }
  else { note.textContent = res.error; note.classList.add('err'); }
}

function stopRecording(cancel) {
  if (!recording) return;
  window.removeEventListener('keydown', onRecordKey, true);
  recording = false;
  $('hotkey').classList.remove('rec');
  api.resumeHotkey();
  if (cancel && state.settings) setKeys($('hotkeyKeys'), state.settings.hotkey);
}

$('hotkey').addEventListener('click', startRecording);
$('openSettings').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', closeSettings);
$('scrim').addEventListener('click', closeSettings);
$('openFolder').addEventListener('click', () => api.openFolder());
$('lang').addEventListener('change', (e) => setLanguage(e.target.value));
$('display').addEventListener('change', (e) => updateSetting('displayId', e.target.value));
$('tToast').addEventListener('change', (e) => updateSetting('showToast', e.target.checked));
$('tFlash').addEventListener('change', (e) => updateSetting('flash', e.target.checked));
$('tLogin').addEventListener('change', (e) => updateSetting('launchAtLogin', e.target.checked));
$('tBuffer').addEventListener('change', (e) => api.setPaused(!e.target.checked));
$('pickDir').addEventListener('click', async () => {
  const dir = await api.pickDir();
  if (dir) await updateSetting('saveDir', dir);
});

// ---------------------------------------------------------------------------
// Статус буфера
// ---------------------------------------------------------------------------
function renderStatus(s) {
  state.status = s;
  const el = $('status');
  const st = s.paused ? 'paused' : s.state;
  el.dataset.state = st;
  const fps = s.fps || (state.settings && state.settings.fps);
  $('statusText').textContent =
    st === 'live' ? `${t('status.buffer')} · ${s.height ? s.height + 'p · ' : ''}${fps}${t('unit.fps')}`
      : st === 'paused' ? t('status.paused')
        : st === 'error' ? (I18N.msg(s.message) || t('status.error'))
          : t('status.starting');
  $('tBuffer').checked = !s.paused;
}

$('status').addEventListener('click', () => api.setPaused(!state.status.paused));

// ---------------------------------------------------------------------------
// Клавиатура, прокрутка, события
// ---------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (recording) return;
  if (e.key === ' ') {
    // пробел — только «оживление», а не нажатие сфокусированной кнопки
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (viewer.hidden && !drawer.classList.contains('on')) {
      e.preventDefault();
      if (!e.repeat && hoveredTile) hoveredTile._live();
      return;
    }
  }
  if (!viewer.hidden) {
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowLeft') navigate(-1);
    else if (e.key === 'ArrowRight') navigate(1);
    else if (e.key === ' ') { e.preventDefault(); if (!e.repeat) startLive(); }
    else if (e.key === 'Delete') deleteCurrent();
    return;
  }
  if (e.key === 'Escape' && drawer.classList.contains('on')) closeSettings();
  if (e.key === ',' && e.ctrlKey) openSettings();
});

window.addEventListener('keyup', (e) => {
  if (e.key !== ' ' || recording) return;
  e.preventDefault();
  stopLive();
  if (hoveredTile) hoveredTile._still();
});
window.addEventListener('blur', () => {
  stopLive();
  if (hoveredTile) hoveredTile._still();
});

$('scroll').addEventListener('scroll', () => {
  document.querySelector('.titlebar').classList.toggle('scrolled', $('scroll').scrollTop > 4);
}, { passive: true });

api.onShotAdded((shot) => {
  addShot(shot);
  if (pendingOpen === shot.id) { pendingOpen = null; showShot(shot.id); }
});

// Клик по превью в углу экрана — сразу открыть этот момент
let pendingOpen = null;
let ready = null;

async function showShot(id) {
  await ready;
  const idx = state.shots.findIndex((s) => s.id === id);
  if (idx < 0) { pendingOpen = id; return; }
  if (drawer.classList.contains('on')) closeSettings();
  if (!viewer.hidden) {
    if (state.viewerIndex === idx) return;
    navigate(idx - state.viewerIndex);
    return;
  }
  const tile = tileEl(id);
  if (tile && !isInView(tile)) tile.scrollIntoView({ block: 'center' });
  // Даём окну проявиться, чтобы раскрытие из карточки было видно
  setTimeout(() => openViewer(state.shots.findIndex((s) => s.id === id)), 160);
}
api.onOpenShot((id) => showShot(id));
api.onReload(() => loadShots());
api.onStatus(renderStatus);

ready = (async function init() {
  state.settings = await api.getSettings();
  I18N.setLang(state.settings.lang);
  applyStatic();
  buildSegs();
  applySettingsToUi();
  renderStatus(await api.status());
  await loadShots();
})();
