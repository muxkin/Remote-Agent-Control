const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld(
  'adapter',
  Object.freeze({
    state: () => ipcRenderer.invoke('adapter:state'),
    save: (value) => ipcRenderer.invoke('adapter:save', value),
    pair: () => ipcRenderer.invoke('adapter:pair'),
    check: () => ipcRenderer.invoke('adapter:check'),
    open: () => ipcRenderer.invoke('adapter:open'),
  }),
);
