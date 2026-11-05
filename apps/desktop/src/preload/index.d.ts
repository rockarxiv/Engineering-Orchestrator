import type { IpcBridge } from "./ipc.js";

// A structural echo of NodeJS.ProcessVersions, not that type itself — this
// file is included in the renderer's tsconfig, which has no "node" types
// (and shouldn't: process/require must stay absent from the renderer).
export type ProcessVersions = Readonly<Record<string, string>>;

export interface EoBridge {
  versions: ProcessVersions;
  ipc: IpcBridge;
}

declare global {
  interface Window {
    eo: EoBridge;
  }
}
