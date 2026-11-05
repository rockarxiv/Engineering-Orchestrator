import { contextBridge } from "electron";
import { ipcBridge } from "./ipc.js";

const api = {
  versions: process.versions,
  ipc: ipcBridge,
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("eo", api);
} else {
  // Only reachable if contextIsolation is ever disabled in main/index.ts.
  // @ts-expect-error window.eo is declared for the isolated-world case only.
  window.eo = api;
}
