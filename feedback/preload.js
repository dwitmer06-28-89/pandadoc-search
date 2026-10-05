'use strict';
// The feedback window's only door to the main process (main.js). Sandboxed: it
// requires nothing but `electron`, and the page sees exactly these five calls.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('feedbackBridge', {
  /** { app, id, source, hasLog, senderName, senderNotice } */
  context: () => ipcRenderer.invoke('desktop-feedback:context'),
  /** The app's log, or null. */
  log: () => ipcRenderer.invoke('desktop-feedback:log'),
  /** Posts a built row to the inbox. Resolves { ok: true } or { ok: false, error }. */
  send: (row) => ipcRenderer.invoke('desktop-feedback:send', row),
  close: () => ipcRenderer.send('desktop-feedback:close'),
  resize: (height) => ipcRenderer.send('desktop-feedback:resize', height),
});
