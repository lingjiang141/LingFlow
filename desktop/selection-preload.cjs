const { contextBridge, ipcRenderer } = require("electron");
let previous;
contextBridge.exposeInMainWorld("lingflowDesktop", {
  showPet: () => ipcRenderer.send("lingflow-pet:show"),
  onSelection: callback => { ipcRenderer.on("lingflow-pet:selection-changed", (_event, selection) => callback(selection)); },
  select: selection => {
    const value = JSON.stringify(selection);
    if (value === previous) return;
    previous = value;
    ipcRenderer.send("lingflow-pet:selection", selection);
  },
});
