import { ipcContract, sectionLockedRefusal, type IpcChannel, type IpcPayload, type IpcResponse, type IpcResult, type SectionLock } from "@eo/core";

export type IpcHandlerFn<K extends IpcChannel> = (payload: IpcPayload<K>) => IpcResponse<K> | Promise<IpcResponse<K>>;

export interface HandleIpcRequestOptions {
  /** Never true in production — stack traces/messages must not reach the renderer. */
  exposeErrorDetails: boolean;
  /**
   * Whether this channel writes a section the organisation has
   * published (EO-329, `ARCHITECTURE.md`, "Publish, lock and versions").
   *
   * Asked here because here is where every door meets: the renderer's
   * `ipcMain.handle`, the MCP host's `dispatchIpc` and a server's HTTP
   * door all arrive through this one function, and the original design is
   * precisely that a lock only one of them knew about is not a lock —
   * "a renderer-only lock would let the assistant rewrite a published
   * pipeline from a chat".
   *
   * A function rather than a set, because the answer changes while the
   * process runs: a publish lands on the next sync, and a person signs
   * out of the organisation without relaunching.
   *
   * Absent in the tests that are about something else, and on any door
   * built before this existed. Absent means no lock — which is the
   * truth on a solo desktop, where nobody has published anything.
   *
   * The unparsed payload goes with the channel because one question
   * about a lock is about a *subject*: a pipeline this machine has
   * diverged is the person's own copy and stays editable (EO-331,
   * ARCHITECTURE.md, "Divergence and suggestions"). Unparsed, because the lock is asked before the
   * payload is
   * validated — see below — so whatever reads it reads it defensively
   * or not at all.
   */
  sectionLock?: (channel: IpcChannel, payload: unknown) => SectionLock | null;
}

/**
 * The electron-free core of request handling: validate input, run the
 * handler, validate output, and always return an envelope rather than
 * throwing — kept separate from registerHandler() so it's testable without
 * a running Electron process (ipcMain doesn't exist under plain Node).
 */
export async function handleIpcRequest<K extends IpcChannel>(
  channel: K,
  rawPayload: unknown,
  handler: IpcHandlerFn<K>,
  options: HandleIpcRequestOptions,
): Promise<IpcResult<IpcResponse<K>>> {
  // Before the payload is even read. A locked section refuses whatever
  // was sent, and saying "invalid request" first would tell a caller to
  // go and fix a payload that was never going to be written.
  const lock = options.sectionLock?.(channel, rawPayload) ?? null;
  if (lock !== null) return sectionLockedRefusal(lock);

  const { request: requestSchema, response: responseSchema } = ipcContract[channel];

  const parsedRequest = requestSchema.safeParse(rawPayload);
  if (!parsedRequest.success) {
    return {
      ok: false,
      error: {
        message: `Invalid request payload for "${channel}"`,
        issues: parsedRequest.error.issues.map((issue) => issue.message),
      },
    };
  }

  try {
    const result = await handler(parsedRequest.data as IpcPayload<K>);
    const parsedResponse = responseSchema.safeParse(result);
    if (!parsedResponse.success) {
      // The handler broke its own contract — a programmer error, not
      // something the caller can act on.
      throw new Error(`Handler for "${channel}" returned a response that fails its own schema`);
    }
    return { ok: true, data: parsedResponse.data as IpcResponse<K> };
  } catch (error) {
    return {
      ok: false,
      error: { message: options.exposeErrorDetails ? String(error) : "Internal error" },
    };
  }
}
