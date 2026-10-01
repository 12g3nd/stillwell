import { contextBridge, ipcRenderer } from "electron";
import type { Bridge } from "../editor/model/document";
const bridge: Bridge = {
  strokeImage: (id, stroke) => ipcRenderer.invoke("image:stroke", id, stroke),
  newPaintLayer: () => ipcRenderer.invoke("image:paint-layer"),
  cancelStroke: () => ipcRenderer.send("image:cancel-stroke"),
  filterImage: (id, settings) =>
    ipcRenderer.invoke("image:filter", id, settings),
  exportPdf: (svg) => ipcRenderer.invoke("image:pdf", svg),
  adjustImage: (id, settings) =>
    ipcRenderer.invoke("image:adjust", id, settings),
  checkpointPreview: (id) =>
    ipcRenderer.invoke("project:checkpoint-preview", id),
  exportPortable: () => ipcRenderer.invoke("project:portable-export"),
  openPortable: () => ipcRenderer.invoke("project:portable-open"),
  shelfList: () => ipcRenderer.invoke("shelf:list"),
  shelfRemove: (id) => ipcRenderer.invoke("shelf:remove", id),
  shelfSave: (id, name) => ipcRenderer.invoke("shelf:save", id, name),
  shelfLoad: (id) => ipcRenderer.invoke("shelf:load", id),
  textEditingActive: (value) => ipcRenderer.send("project:text-editing", value),
  operationActive: (value) => ipcRenderer.send("project:operation", value),
  importFont: () => ipcRenderer.invoke("font:import"),
  createSelection: (id, selection) =>
    ipcRenderer.invoke("mask:selection", id, selection),
  editMask: (id, edit) => ipcRenderer.invoke("mask:edit", id, edit),
  trimBounds: (bytes) => ipcRenderer.invoke("mask:trim", bytes),
  cancelMaskJob: () => ipcRenderer.send("mask:cancel"),
  openImage: () => ipcRenderer.invoke("image:open"),
  addImage: () => ipcRenderer.invoke("image:add"),
  exportPng: (bytes, width, height) =>
    ipcRenderer.invoke("image:export", bytes, width, height),
  importBytes: (bytes, name) => ipcRenderer.invoke("image:bytes", bytes, name),
  pasteImage: () => ipcRenderer.invoke("image:paste"),
  exportImage: (bytes, width, height, options) =>
    ipcRenderer.invoke("image:export", bytes, width, height, options),
  recent: () => ipcRenderer.invoke("project:recent"),
  loadProject: (id) => ipcRenderer.invoke("project:load", id),
  saveProject: (document, version) =>
    ipcRenderer.invoke("project:save", document, version),
  markDirty: (version) => ipcRenderer.send("project:dirty", version),
  checkpoints: () => ipcRenderer.invoke("project:checkpoints"),
  checkpoint: (name) => ipcRenderer.invoke("project:checkpoint", name),
  restoreCheckpoint: (id) => ipcRenderer.invoke("project:restore", id),
  revealLibrary: () => ipcRenderer.invoke("project:reveal"),
  onClose: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("app:closing", listener);
    return () => ipcRenderer.removeListener("app:closing", listener);
  },
  closeReady: () => ipcRenderer.send("app:close-ready"),
  previewActive: (value) => ipcRenderer.send("project:preview", value),
};
contextBridge.exposeInMainWorld("photo", bridge);
