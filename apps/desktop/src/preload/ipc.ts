import { ipcRenderer } from "electron";
import {
  pushWireChannel,
  type IpcChannel,
  type IpcPushChannel,
  type IpcPushPayload,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
} from "@eo/core";

// The single generic bridge (F-04 scope) — no per-feature methods here.
export interface IpcBridge {
  invoke: <K extends IpcChannel>(channel: K, payload: IpcRequest<K>) => Promise<IpcResult<IpcResponse<K>>>;
  subscribe: <K extends IpcPushChannel>(channel: K, callback: (payload: IpcPushPayload<K>) => void) => () => void;
}

function invoke<K extends IpcChannel>(channel: K, payload: IpcRequest<K>): Promise<IpcResult<IpcResponse<K>>> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResult<IpcResponse<K>>>;
}

function subscribe<K extends IpcPushChannel>(channel: K, callback: (payload: IpcPushPayload<K>) => void): () => void {
  const wireChannel = pushWireChannel(channel);
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
    callback(payload as IpcPushPayload<K>);
  };
  ipcRenderer.on(wireChannel, listener);
  return () => ipcRenderer.removeListener(wireChannel, listener);
}

export const ipcBridge: IpcBridge = { invoke, subscribe };
