const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "bridge",
  Object.freeze({
    snapshot: () => ipcRenderer.invoke("bridge:snapshot"),
    subscribe: (callback) => {
      const fn = (_e, value) => callback(value);
      ipcRenderer.on("bridge:update", fn);
      return () => ipcRenderer.removeListener("bridge:update", fn);
    },
    request: (method, params) =>
      ipcRenderer.invoke("bridge:request", method, params),
    window: (action) => ipcRenderer.send("bridge:window", action),
    dockPreview: (value = true) =>
      ipcRenderer.invoke("bridge:dock-preview", value),
    dragStart: () => ipcRenderer.invoke("bridge:drag-start"),
    dragEnd: (reason) => ipcRenderer.invoke("bridge:drag-end", reason),
    copy: (text) => ipcRenderer.invoke("bridge:copy", text),
    openArtifact: (id, folder) =>
      ipcRenderer.invoke("bridge:artifact", id, folder),
  }),
);
