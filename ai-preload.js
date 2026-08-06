const { contextBridge, ipcRenderer } = require('electron');

// The AI panel. Its own channels rather than preload.js's, so the search pill
// and the panel can't reach each other's — same reasoning as overlay-preload.js.
contextBridge.exposeInMainWorld('ai', {
  ready: () => ipcRenderer.send('ai:ready'),
  cancel: () => ipcRenderer.send('ai:cancel'),
  resize: (height) => ipcRenderer.send('ai:resize', height),

  ask: (payload) => ipcRenderer.invoke('ai:ask', payload),
  saveKey: (key) => ipcRenderer.invoke('ai:save-key', key),
  getAssessments: () => ipcRenderer.invoke('ai:get-assessments'),
  saveAssessments: (list) => ipcRenderer.invoke('ai:save-assessments', list),
  openKeyPage: () => ipcRenderer.send('ai:open-key-page'),

  onOpen: (cb) => ipcRenderer.on('ai:open', (_e, state) => cb(state)),
  onDelta: (cb) => ipcRenderer.on('ai:delta', (_e, text) => cb(text)),
});
