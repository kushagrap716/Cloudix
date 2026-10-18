'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (serverUrl) => ipcRenderer.invoke('settings:save', serverUrl),
  cancel: () => ipcRenderer.invoke('settings:cancel'),
})
