'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('lumetto', {
  // настройки
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickDir: () => ipcRenderer.invoke('settings:pickDir'),
  displays: () => ipcRenderer.invoke('settings:displays'),
  suspendHotkey: () => ipcRenderer.invoke('hotkey:suspend'),
  resumeHotkey: () => ipcRenderer.invoke('hotkey:resume'),

  // галерея
  listShots: () => ipcRenderer.invoke('shots:list'),
  deleteShot: (id) => ipcRenderer.invoke('shots:delete', id),
  revealShot: (id) => ipcRenderer.invoke('shots:reveal', id),
  copyFrame: (id) => ipcRenderer.invoke('shots:copyFrame', id),
  saveGif: (id, data) => ipcRenderer.invoke('shots:saveGif', { id, data }),
  openFolder: () => ipcRenderer.invoke('app:openFolder'),
  status: () => ipcRenderer.invoke('app:status'),
  setPaused: (v) => ipcRenderer.invoke('app:setPaused', v),
  trigger: () => ipcRenderer.invoke('app:trigger'),
  onShotAdded: on('shots:added'),
  onReload: on('shots:reload'),
  onStatus: on('app:status'),

  // окно захвата
  onTrigger: on('capture:trigger'),
  onPaused: on('capture:paused'),
  reportStatus: (s) => ipcRenderer.send('capture:status', s),
  reportFailed: (f) => ipcRenderer.send('capture:failed', f),
  saveCapture: (payload) => ipcRenderer.invoke('capture:save', payload),

  sendPoster: (p) => ipcRenderer.send('capture:poster', p),
  onOpenShot: on('viewer:open'),

  // слой со вспышкой и превью
  onOverlay: on('overlay:event'),
  overlayMouse: (ignore) => ipcRenderer.send('overlay:mouse', ignore),
  overlayDone: () => ipcRenderer.send('overlay:done'),
  overlayOpen: (id) => ipcRenderer.send('overlay:open', id),
});
