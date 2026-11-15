import type { RuntimeId } from "./catalog.js";
import { invalidateRuntimeAuth } from "./auth.js";

/**
 * "A runtime was just signed in", as main code can hear it (EO-795).
 *
 * Fired by EO's own sign-in flows (`runtimes/signIn.ts`, and Claude's
 * stored API key in `ipc/runtimeCommands.ts`) when the CLI — not the
 * renderer — says the sign-in worked: the child exited 0, or the key was
 * stored. So it is what the `SignInDialog` reports as a success, whichever
 * screen opened it, and nothing a renderer could claim on its own.
 *
 * The cached auth answer is dropped before anyone is told, so a listener
 * that asks `checkRuntimeAuth` hears the new state rather than the one
 * from a moment ago. A listener that throws is its own problem: the rest
 * are still told, and the sign-in still succeeded.
 */
export type RuntimeSignedInListener = (runtime: RuntimeId) => void;

const listeners = new Set<RuntimeSignedInListener>();

/** Hears every sign-in EO completes from here on. Returns the way to stop. */
export function onRuntimeSignedIn(listener: RuntimeSignedInListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A sign-in of `runtime` completed: forget what EO knew of its auth, then tell every listener. */
export function runtimeSignedIn(runtime: RuntimeId): void {
  invalidateRuntimeAuth(runtime);
  for (const listener of [...listeners]) {
    try {
      listener(runtime);
    } catch (error) {
      console.error(`[eo] a listener for ${runtime} being signed in failed`, error);
    }
  }
}
