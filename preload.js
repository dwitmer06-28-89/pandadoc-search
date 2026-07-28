const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  search: (term) => ipcRenderer.send('search', term),
  cancel: () => ipcRenderer.send('cancel'),
  resize: (height) => ipcRenderer.send('resize', height),
  onReset: (cb) => ipcRenderer.on('reset', cb),
});
