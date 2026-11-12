// The browser pane's tab strip and toolbar (pane-ui.html): what it shows comes from the app, what is clicked goes back.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("emplioPane", {
  act: (action, value) => ipcRenderer.send("pane:act", action, value),
  onState: (listener) => ipcRenderer.on("pane:state", (_event, state) => listener(state)),
});
