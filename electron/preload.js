'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  chooseDirectory: (options) => ipcRenderer.invoke('dialog:choose-directory', options),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (value) => ipcRenderer.invoke('settings:save', value),
  loadLabels: () => ipcRenderer.invoke('labels:load'),
  saveLabels: (value) => ipcRenderer.invoke('labels:save', value),
  loadPairs: (value) => ipcRenderer.invoke('pairs:load', value),
  imageMetadata: (filePath) => ipcRenderer.invoke('image:metadata', filePath),
  imageUrl: (filePath) => ipcRenderer.invoke('image:url', filePath),
  prepareSamImage: (value) => ipcRenderer.invoke('sam:prepare-image', value),
  predictSamMask: (value) => ipcRenderer.invoke('sam:predict', value),
  paintPolygon: (value) => ipcRenderer.invoke('mask:paint-polygon', value),
  mergeBinaryMask: (value) => ipcRenderer.invoke('mask:merge-binary', value),
  eraseConnected: (value) => ipcRenderer.invoke('mask:erase-connected', value),
  replaceConnectedColor: (value) => ipcRenderer.invoke('mask:replace-connected-color', value),
  deletePair: (value) => ipcRenderer.invoke('pair:delete', value),
  undoDelete: () => ipcRenderer.invoke('pair:undo-delete'),
  permanentDelete: (pair) => ipcRenderer.invoke('pair:permanent-delete', pair),
  swapPairFiles: (pair) => ipcRenderer.invoke('pair:swap-files', pair),
  showApp: () => ipcRenderer.invoke('app:show'),
  appVersion: () => ipcRenderer.invoke('app:version'),
});
