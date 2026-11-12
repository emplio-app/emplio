// What the Emplio page can ask of the app (and nothing else): who this computer is, to be connected, to be let go.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("emplioDesktop", {
  platform: process.platform,
  // { installId, name, platform, state, userId } — state: off | needs-pairing | connecting | online
  info: () => ipcRenderer.invoke("emplio:info"),
  // after POST /devices: { apiUrl, token, userId }
  connect: (options) => ipcRenderer.invoke("emplio:connect", options),
  // the agent's browser is drawn by the app over the panel the page keeps clear for it
  pane: {
    ready: () => ipcRenderer.invoke("emplio:pane-ready"),
    show: (spot) => ipcRenderer.send("emplio:pane", spot),
    // "Take control" pressed in the browser itself, which the page can't see being drawn over it
    onTake: (listener) => {
      const on = () => listener();
      ipcRenderer.on("emplio:pane-take", on);
      return () => ipcRenderer.removeListener("emplio:pane-take", on);
    },
  },
  // a tapped notification: open this path (a chat) in the page
  onOpen: (listener) => {
    const on = (_event, path) => listener(path);
    ipcRenderer.on("emplio:open", on);
    return () => ipcRenderer.removeListener("emplio:open", on);
  },
  onState: (listener) => {
    const on = (_event, state) => listener(state);
    ipcRenderer.on("emplio:state", on);
    return () => ipcRenderer.removeListener("emplio:state", on);
  },
});

// tells the page it is inside the app (its top strip and spacing depend on it)
window.addEventListener("DOMContentLoaded", () => document.documentElement.setAttribute("data-desktop", process.platform));
