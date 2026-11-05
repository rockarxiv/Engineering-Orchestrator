import { EventEmitter } from "node:events";
import { ipcPushContract, pushWireChannel, type IpcPushChannel, type IpcPushPayload } from "@eo/core";

const emitter = new EventEmitter();

/**
 * Somewhere a push can be delivered (KAN-127).
 *
 * `emitPush` fans a validated payload out to every bridged transport;
 * what a transport does with it is its own business. There are two.
 * `platform/webContentsTransport.ts` sends on a window's `webContents`
 * — under `platform/` with the rest of the machine (EO-318) so that
 * this file, like registry.ts, never names Electron even in a type.
 * `server/pushStream.ts` writes server-sent events to every browser
 * holding the app open (EO-321), which is the same interface answering
 * a harder question: several clients rather than one, any of which can
 * go away and come back.
 *
 * Neither is visible from here, and no handler that calls `emitPush`
 * knows which of them it reached — that was the point of putting a
 * transport between them.
 */
export interface PushTransport {
  /**
   * Deliver one push. `wireChannel` is already the on-the-wire name
   * (`push:items:changed`), and `payload` has already passed the
   * push contract's schema.
   */
  send(wireChannel: string, payload: unknown): void;
}

/** Fans a push event out to whatever transports are currently bridged. */
export function emitPush<K extends IpcPushChannel>(pushChannel: K, payload: IpcPushPayload<K>): void {
  const schema = ipcPushContract[pushChannel];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`emitPush("${pushChannel}") payload failed its own schema: ${parsed.error.message}`);
  }
  emitter.emit(pushChannel, parsed.data);
}

/**
 * Hears one push channel inside this process, after its payload has
 * passed the contract. Returns a disposer.
 *
 * For what follows from a push wherever it was sent, rather than from
 * any one sender: `assistDeltas.ts` sends a chat's `assist:delta` after
 * every `items:changed` naming it (EO-553), and the dozen places that
 * send one should not each have to remember to.
 */
export function onPush<K extends IpcPushChannel>(pushChannel: K, listener: (payload: IpcPushPayload<K>) => void): () => void {
  const heard = (payload: unknown): void => {
    try {
      listener(payload as IpcPushPayload<K>);
    } catch (error) {
      // Hearing a push must never be able to take down whatever sent it.
      console.error(`[eo] a listener on "${pushChannel}" threw:`, error);
    }
  };
  emitter.on(pushChannel, heard);
  return () => {
    emitter.off(pushChannel, heard);
  };
}

/** Forwards every push channel to one transport. Returns a disposer. */
export function bridgePushChannels(transport: PushTransport): () => void {
  const channels = Object.keys(ipcPushContract) as IpcPushChannel[];

  const subscriptions = channels.map((pushChannel) => {
    const listener = (payload: unknown): void => {
      transport.send(pushWireChannel(pushChannel), payload);
    };
    emitter.on(pushChannel, listener);
    return { pushChannel, listener };
  });

  return () => {
    for (const { pushChannel, listener } of subscriptions) {
      emitter.off(pushChannel, listener);
    }
  };
}
