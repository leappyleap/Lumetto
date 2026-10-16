'use strict';

const {
  app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage,
  screen, desktopCapturer, session, protocol, shell, dialog, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const I18N = require('./ui/i18n.js');
const { t } = I18N;

// ---------------------------------------------------------------------------
// Протокол lumetto://local/... — и интерфейс, и медиа живут на одном origin,
// поэтому кадры видео можно читать в canvas (нужно для экспорта в GIF).
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([{
  scheme: 'lumetto',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('app.lumetto');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const UI_DIR = path.join(__dirname, 'ui');

const DEFAULTS = {
  hotkey: 'Control+Alt+L',
  before: 1.5,          // секунд до нажатия
  after: 1.5,           // секунд после нажатия
  fps: 30,
  maxHeight: 1080,      // 720 | 1080 | 0 (исходное)
  displayId: null,      // null — основной монитор
  launchAtLogin: false,
  showToast: true,     // превью в углу
  flash: true,         // вспышка при нажатии
  saveDir: null,
  lang: 'en',
};

let settings = null;
let galleryWin = null;
let captureWin = null;
let overlayWin = null;
let tray = null;
let quitting = false;
let paused = false;
let captureStatus = { state: 'starting' };
let hotkeyOk = true;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

// Переезд с прежнего названия (LiveShot): настройки и папка с клипами
function migrateFromLiveShot() {
  try {
    if (fs.existsSync(settingsPath())) return;
    const oldSettingsPath = path.join(app.getPath('appData'), 'LiveShot', 'settings.json');
    let old = null;
    try { old = JSON.parse(fs.readFileSync(oldSettingsPath, 'utf8')); } catch { /* не было */ }
    const oldDefault = path.join(app.getPath('videos'), 'LiveShot');
    const newDefault = path.join(app.getPath('videos'), 'Lumetto');
    const usedDefault = !old || !old.saveDir || path.normalize(old.saveDir) === path.normalize(oldDefault);
    if (usedDefault && fs.existsSync(oldDefault) && !fs.existsSync(newDefault)) {
      try { fs.renameSync(oldDefault, newDefault); } catch { if (old) old.saveDir = oldDefault; }
    }
    if (old) {
      if (usedDefault && old.saveDir && path.normalize(old.saveDir) === path.normalize(oldDefault) && fs.existsSync(newDefault)) old.saveDir = null;
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(old, null, 2));
    }
  } catch { /* переезд не критичен */ }
}

function loadSettings() {
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    settings = { ...DEFAULTS };
  }
  if (!settings.saveDir) settings.saveDir = path.join(app.getPath('videos'), 'Lumetto');
  settings.lang = I18N.setLang(settings.lang);
  fs.mkdirSync(settings.saveDir, { recursive: true });
}

function persistSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// Протокол
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webm': 'video/webm', '.json': 'application/json',
};

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  if (!p.startsWith(path.normalize(base + path.sep))) return null;
  return p;
}

async function serveFile(filePath, request) {
  let buf;
  try { buf = await fsp.readFile(filePath); } catch { return new Response('Not found', { status: 404 }); }
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.get('range');
  const common = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] === '' ? buf.length - Number(m[2]) : Number(m[1]);
      let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : buf.length - 1;
      start = Math.max(0, start); end = Math.min(end, buf.length - 1);
      if (start <= end) {
        return new Response(buf.subarray(start, end + 1), {
          status: 206,
          headers: { ...common, 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': String(end - start + 1) },
        });
      }
    }
  }
  return new Response(buf, { status: 200, headers: { ...common, 'Content-Length': String(buf.length) } });
}

function registerProtocol() {
  protocol.handle('lumetto', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel.startsWith('media/')) {
      const name = path.basename(rel);
      return serveFile(path.join(settings.saveDir, name), request);
    }
    if (rel.startsWith('app/')) {
      const p = safeJoin(UI_DIR, rel.slice(4));
      if (!p) return new Response('Forbidden', { status: 403 });
      return serveFile(p, request);
    }
    return new Response('Not found', { status: 404 });
  });
}

const uiUrl = (file) => `lumetto://local/app/${file}`;
const mediaUrl = (file) => `lumetto://local/media/${encodeURIComponent(file)}`;

// ---------------------------------------------------------------------------
// Снимки на диске: <id>.webm + <id>.jpg (кадр в момент нажатия) + <id>.json
// ---------------------------------------------------------------------------
function makeId(date = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${p(date.getMilliseconds(), 3)}`;
}

async function readShot(id) {
  const dir = settings.saveDir;
  const video = path.join(dir, `${id}.webm`);
  let stat;
  try { stat = await fsp.stat(video); } catch { return null; }
  let meta = {};
  try { meta = JSON.parse(await fsp.readFile(path.join(dir, `${id}.json`), 'utf8')); } catch { /* старый или чужой файл */ }
  const hasPoster = fs.existsSync(path.join(dir, `${id}.jpg`));
  // Абсолютное начало клипа (мс) — по нему моменты собираются в серии
  let start = typeof meta.start === 'number' ? meta.start : null;
  if (start == null && meta.keyTime != null) {
    const m = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)-(\d{3})/.exec(id);
    if (m) start = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime() - meta.keyTime * 1000;
  }
  return {
    id,
    video: mediaUrl(`${id}.webm`),
    poster: hasPoster ? mediaUrl(`${id}.jpg`) : null,
    created: meta.created || stat.mtimeMs,
    duration: meta.duration || null,
    width: meta.width || null,
    height: meta.height || null,
    keyTime: meta.keyTime ?? null,
    start,
    size: stat.size,
  };
}

async function listShots() {
  let names = [];
  try { names = await fsp.readdir(settings.saveDir); } catch { return []; }
  const ids = names.filter((n) => n.toLowerCase().endsWith('.webm')).map((n) => n.slice(0, -5));
  const shots = (await Promise.all(ids.map(readShot))).filter(Boolean);
  return shots.sort((a, b) => b.created - a.created);
}

function shotFiles(id) {
  const safe = path.basename(id);
  return ['webm', 'jpg', 'json'].map((ext) => path.join(settings.saveDir, `${safe}.${ext}`));
}

// ---------------------------------------------------------------------------
// Окна
// ---------------------------------------------------------------------------
const preload = path.join(__dirname, 'preload.js');

function appIcon() {
  return nativeImage.createFromPath(path.join(ASSETS, 'icon.png'));
}

function createGallery(show = true) {
  if (galleryWin && !galleryWin.isDestroyed()) {
    if (show) { if (galleryWin.isMinimized()) galleryWin.restore(); galleryWin.show(); galleryWin.focus(); }
    return galleryWin;
  }
  galleryWin = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 540,
    show: false,
    backgroundColor: '#111113',
    icon: appIcon(),
    title: 'Lumetto',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#111113', symbolColor: '#9d9b95', height: 44 },
    webPreferences: { preload, sandbox: false, contextIsolation: true },
  });
  galleryWin.loadURL(uiUrl('index.html'));
  galleryWin.once('ready-to-show', () => { if (show) galleryWin.show(); });
  galleryWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); galleryWin.hide(); }
  });
  galleryWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return galleryWin;
}

function createCapture() {
  if (captureWin && !captureWin.isDestroyed()) captureWin.destroy();
  captureWin = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
    skipTaskbar: true,
    webPreferences: { preload, sandbox: false, contextIsolation: true, backgroundThrottling: false },
  });
  captureWin.loadURL(uiUrl('capture.html'));
  captureWin.on('closed', () => { captureWin = null; });
}

// Прозрачный слой на весь монитор: вспышка, превью «как на айфоне», ошибки.
// Исключён из захвата экрана, поэтому в клипы не попадает.
function createOverlay() {
  overlayWin = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: { preload, sandbox: false, contextIsolation: true, backgroundThrottling: false },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setContentProtection(true);
  overlayWin.setVisibleOnAllWorkspaces(true);
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.loadURL(uiUrl('overlay.html'));
}

function overlay(payload) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const d = targetDisplay();
  const b = d.bounds;
  const wa = d.workArea;
  overlayWin.setBounds(b);
  overlayWin.webContents.send('overlay:event', {
    ...payload,
    flash: settings.flash,
    preview: settings.showToast,
    aspect: (d.size.width / d.size.height) || 16 / 9,
    inset: { right: b.x + b.width - (wa.x + wa.width), bottom: b.y + b.height - (wa.y + wa.height) },
  });
  if (!overlayWin.isVisible()) {
    overlayWin.setIgnoreMouseEvents(true, { forward: true });
    overlayWin.showInactive();
  }
}

function openShotInGallery(id) {
  const win = createGallery(true);
  const send = () => win.webContents.send('viewer:open', id);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function targetDisplay() {
  const all = screen.getAllDisplays();
  return all.find((d) => String(d.id) === String(settings.displayId)) || screen.getPrimaryDisplay();
}

function broadcast(channel, payload) {
  for (const w of [galleryWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Хоткей и захват
// ---------------------------------------------------------------------------
function registerHotkey(acc) {
  globalShortcut.unregisterAll();
  try {
    return globalShortcut.register(acc, triggerCapture);
  } catch {
    return false;
  }
}

function triggerCapture() {
  if (paused) {
    overlay({ type: 'error', title: t('ov.paused.title'), text: t('ov.paused.text') });
    return;
  }
  if (!captureWin || captureStatus.state !== 'live') {
    overlay({ type: 'error', title: t('ov.notReady.title'), text: I18N.msg(captureStatus.message) || t('ov.notReady.text') });
    return;
  }
  const id = makeId();
  captureWin.webContents.send('capture:trigger', { id });
  overlay({ type: 'start', id, after: settings.after });
}

async function saveCapture({ id, video, poster, meta }) {
  const safe = path.basename(id);
  const dir = settings.saveDir;
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${safe}.webm`), Buffer.from(video));
  if (poster) await fsp.writeFile(path.join(dir, `${safe}.jpg`), Buffer.from(poster));
  await fsp.writeFile(path.join(dir, `${safe}.json`), JSON.stringify({ ...meta, created: Date.now() }, null, 2));
  const shot = await readShot(safe);
  broadcast('shots:added', shot);
  overlay({ type: 'saved', id: safe, video: shot.video, poster: shot.poster });
  updateTrayMenu();
  return true;
}

function setPaused(value) {
  paused = value;
  if (captureWin) captureWin.webContents.send('capture:paused', paused);
  broadcast('app:status', { ...captureStatus, paused });
  updateTrayMenu();
}

// ---------------------------------------------------------------------------
// Трей
// ---------------------------------------------------------------------------
const prettyHotkey = (acc) => acc
  .replace(/CommandOrControl|Control/g, 'Ctrl').replace(/Super|Meta/g, 'Win')
  .split('+').join(' + ');

function createTray() {
  const img = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip('Lumetto');
  tray.on('click', () => createGallery(true));
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setImage(nativeImage.createFromPath(path.join(ASSETS, paused ? 'tray-paused.png' : 'tray.png')));
  tray.setToolTip(paused ? `Lumetto — ${t('status.paused')}` : `Lumetto — ${prettyHotkey(settings.hotkey)}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('hint.save'), accelerator: settings.hotkey, registerAccelerator: false, click: triggerCapture, enabled: !paused },
    { label: t('tray.gallery'), click: () => createGallery(true) },
    { label: t('tray.folder'), click: () => shell.openPath(settings.saveDir) },
    { type: 'separator' },
    { label: t('tray.pause'), type: 'checkbox', checked: paused, click: (item) => setPaused(item.checked) },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function publicSettings() {
  return { ...settings, paused, hotkeyOk };
}

function setupIpc() {
  ipcMain.handle('settings:get', () => publicSettings());

  ipcMain.handle('settings:set', async (_e, patch) => {
    const prev = { ...settings };
    const next = { ...settings, ...patch };
    if (patch.hotkey && patch.hotkey !== prev.hotkey) {
      if (!registerHotkey(patch.hotkey)) {
        registerHotkey(prev.hotkey);
        return { ok: false, error: t('set.hotkeyBusy'), settings: publicSettings() };
      }
      hotkeyOk = true;
    }
    if ('launchAtLogin' in patch) {
      app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin, args: ['--hidden'] });
    }
    if (patch.saveDir) await fsp.mkdir(patch.saveDir, { recursive: true });
    if ('lang' in patch) next.lang = I18N.setLang(patch.lang);
    settings = next;
    persistSettings();
    const captureKeys = ['fps', 'maxHeight', 'displayId', 'before', 'after'];
    if (captureKeys.some((k) => k in patch && patch[k] !== prev[k])) createCapture();
    if (patch.saveDir && patch.saveDir !== prev.saveDir) broadcast('shots:reload');
    updateTrayMenu();
    return { ok: true, settings: publicSettings() };
  });

  ipcMain.handle('settings:pickDir', async () => {
    const r = await dialog.showOpenDialog(galleryWin, {
      title: t('dlg.pickFolder'), defaultPath: settings.saveDir, properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('settings:displays', () => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      label: d.label || t('set.displayN', { n: i + 1 }),
      size: `${Math.round(d.size.width * d.scaleFactor)} × ${Math.round(d.size.height * d.scaleFactor)}`,
      primary: d.id === primary,
    }));
  });

  ipcMain.handle('hotkey:suspend', () => { globalShortcut.unregisterAll(); });
  ipcMain.handle('hotkey:resume', () => { registerHotkey(settings.hotkey); });

  ipcMain.handle('shots:list', () => listShots());
  ipcMain.handle('shots:delete', async (_e, id) => {
    for (const f of shotFiles(id)) {
      if (fs.existsSync(f)) {
        try { await shell.trashItem(f); } catch { await fsp.rm(f, { force: true }); }
      }
    }
    return true;
  });
  ipcMain.handle('shots:reveal', (_e, id) => shell.showItemInFolder(shotFiles(id)[0]));
  ipcMain.handle('shots:copyFrame', (_e, id) => {
    const img = nativeImage.createFromPath(shotFiles(id)[1]);
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
    return true;
  });
  ipcMain.handle('shots:copyFile', (_e, id) => {
    // Путь к видео как текст — удобно вставлять в мессенджеры, принимающие пути
    clipboard.writeText(shotFiles(id)[0]);
    return true;
  });
  ipcMain.handle('shots:saveGif', async (_e, { id, data }) => {
    const r = await dialog.showSaveDialog(galleryWin, {
      title: t('dlg.saveGif'),
      defaultPath: path.join(app.getPath('pictures'), `Lumetto-${path.basename(id)}.gif`),
      filters: [{ name: 'GIF', extensions: ['gif'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fsp.writeFile(r.filePath, Buffer.from(data));
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });

  ipcMain.handle('app:openFolder', () => shell.openPath(settings.saveDir));
  ipcMain.handle('app:status', () => ({ ...captureStatus, paused }));
  ipcMain.handle('app:setPaused', (_e, v) => setPaused(!!v));
  ipcMain.handle('app:trigger', () => triggerCapture());

  ipcMain.handle('capture:save', (_e, payload) => saveCapture(payload));
  ipcMain.on('capture:status', (_e, status) => {
    captureStatus = status;
    broadcast('app:status', { ...status, paused });
  });
  ipcMain.on('capture:failed', (_e, { id, message }) => {
    overlay({ type: 'error', id, title: t('ov.failed.title'), text: I18N.msg(message) || t('ov.failed.text') });
  });

  ipcMain.on('capture:poster', (_e, { id, data }) => {
    if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
      overlayWin.webContents.send('overlay:event', { type: 'poster', id, data });
    }
  });
  ipcMain.on('overlay:mouse', (_e, ignore) => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  ipcMain.on('overlay:done', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setIgnoreMouseEvents(true, { forward: true });
      overlayWin.hide();
    }
  });
  ipcMain.on('overlay:open', (_e, id) => openShotInGallery(id));
}

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------
app.on('second-instance', () => createGallery(true));

app.whenReady().then(() => {
  migrateFromLiveShot();
  loadSettings();
  if (settings.launchAtLogin) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  registerProtocol();
  setupIpc();

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const wanted = String(targetDisplay().id);
      const source = sources.find((s) => s.display_id === wanted) || sources[0];
      callback(source ? { video: source } : {});
    } catch {
      callback({});
    }
  });

  createTray();
  createOverlay();
  createCapture();
  hotkeyOk = registerHotkey(settings.hotkey);
  const hidden = process.argv.includes('--hidden');
  createGallery(!hidden);

  screen.on('display-removed', () => createCapture());
  screen.on('display-metrics-changed', () => { /* размер подхватится при перезапуске захвата */ });
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* живём в трее */ });
