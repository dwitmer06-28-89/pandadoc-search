const { contextBridge, ipcRenderer } = require('electron');

// Window controls and dragging for the results window's chrome strip. The real
// traffic lights don't render on a transparent window, and transparency is what
// a window radius larger than Chromium's own needs — so the strip draws its own
// and talks to the main process through here.
contextBridge.exposeInMainWorld('shell', {
  close: () => ipcRenderer.send('shell:close'),
  minimize: () => ipcRenderer.send('shell:minimize'),
  zoom: () => ipcRenderer.send('shell:zoom'),

  dragStart: (x, y) => ipcRenderer.send('shell:drag-start', x, y),
  dragMove: (x, y) => ipcRenderer.send('shell:drag-move', x, y),
  dragEnd: () => ipcRenderer.send('shell:drag-end'),

  onFocus: (fn) => ipcRenderer.on('shell:focus', (_e, active) => fn(active)),
  onChrome: (fn) => ipcRenderer.on('shell:chrome', (_e, color) => fn(color)),
});
