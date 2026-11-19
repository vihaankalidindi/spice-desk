const { contextBridge, ipcRenderer } = require('electron');

const bridge = {};
for (const name of [
  'getSettings', 'saveSettings', 'createDraft', 'demo', 'addClips', 'preview',
  'exportVideo', 'cancel', 'saveProject', 'openProject', 'openExternal', 'showItem',
]) {
  bridge[name] = payload => ipcRenderer.invoke(`studio:${name}`, payload);
}

bridge.onProgress = callback => {
  const listener = (_event, details) => callback(details);
  ipcRenderer.on('studio:progress', listener);
  return () => ipcRenderer.removeListener('studio:progress', listener);
};

contextBridge.exposeInMainWorld('studio', bridge);
