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

  // The quick-jump list. `headings` reads the document on every open, since it
  // may be a different one than last time. `size` is awaited rather than fired
  // and forgotten: this view swallows clicks wherever it sits, so it's kept at
  // button size until there's a list to show, and the list can't be revealed
  // until the main process has actually grown the view around it.
  headings: () => ipcRenderer.invoke('overlay:jump-headings'),
  jumpTo: (id) => ipcRenderer.send('overlay:jump-to', id),
  size: (width, height) => ipcRenderer.invoke('overlay:jump-size', { width, height }),
  onJumpClose: (cb) => ipcRenderer.on('overlay:jump-close', cb),
  onJumpToggle: (cb) => ipcRenderer.on('overlay:jump-toggle', cb),
});
