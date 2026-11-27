const { contextBridge, ipcRenderer } = require("electron");
let previous;
let previousTheme;
contextBridge.exposeInMainWorld("lingflowDesktop", {
  showPet: () => ipcRenderer.send("lingflow-pet:show"),
  onSelection: callback => { ipcRenderer.on("lingflow-pet:selection-changed", (_event, selection) => callback(selection)); },
  select: selection => {
    const value = JSON.stringify(selection);
    if (value === previous) return;
    previous = value;
    ipcRenderer.send("lingflow-pet:selection", selection);
  },
  setTheme: theme => {
    if (typeof theme !== "string" || theme === previousTheme) return;
    previousTheme = theme;
    ipcRenderer.send("lingflow-pet:theme", theme);
  },
});
