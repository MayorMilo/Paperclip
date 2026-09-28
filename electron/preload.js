const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('paperclips', {
  closePanel:   () => ipcRenderer.send('panel:close'),
  setTheme:     theme => ipcRenderer.send('theme:set', theme),
  setKeepOnTop: on => ipcRenderer.send('window:keep-on-top', !!on),
  onPanelShow: cb => {
    const listener = () => cb()
    ipcRenderer.on('panel:will-show', listener)
    return () => ipcRenderer.removeListener('panel:will-show', listener)
  },
  onWindowMove: cb => {
    const listener = () => cb()
    ipcRenderer.on('window:will-move', listener)
    return () => ipcRenderer.removeListener('window:will-move', listener)
  },
})
