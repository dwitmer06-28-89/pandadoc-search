const { contextBridge, ipcRenderer } = require('electron');

// The floating controls over the PandaDoc window. Kept separate from
// preload.js so the search pill and the overlay can't reach each other's
// channels.
contextBridge.exposeInMainWorld('overlay', {
  ready: () => ipcRenderer.send('overlay:ready'),
  toggleDark: () => ipcRenderer.send('overlay:toggle-dark'),
  ai: () => ipcRenderer.send('overlay:ai'),
  search: () => ipcRenderer.send('overlay:search'),
  onDarkState: (cb) => ipcRenderer.on('overlay:dark-state', cb),
  onAIAvailable: (cb) => ipcRenderer.on('overlay:ai-available', cb),
});
