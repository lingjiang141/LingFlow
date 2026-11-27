const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("lingflowPet", {
  initialize: () => ipcRenderer.invoke("lingflow-pet:initialize"),
  snapshot: () => ipcRenderer.invoke("lingflow-pet:snapshot"),
  image: (character, animation) => ipcRenderer.invoke("lingflow-pet:image", character, animation),
  select: selection => ipcRenderer.send("lingflow-pet:pick", selection),
  openTool: (projectId, tool) => ipcRenderer.invoke("lingflow-pet:open-tool", projectId, tool),
  expanded: value => ipcRenderer.invoke("lingflow-pet:expanded", value),
  drag: phase => ipcRenderer.send("lingflow-pet:drag", phase),
  regions: regions => ipcRenderer.send("lingflow-pet:regions", regions),
  menu: () => ipcRenderer.send("lingflow-pet:menu"),
  onChange: callback => { ipcRenderer.on("lingflow-pet:change", (_event, value) => callback(value)); },
});
