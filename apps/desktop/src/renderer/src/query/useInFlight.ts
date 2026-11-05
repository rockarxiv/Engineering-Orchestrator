import { useCallback, useRef, useState } from "react";

/**
 * Which keys have a write in flight, and what each is on its way to
 * (EO-562), for a screen with one control per row: a Claim per card, a pin
 * per comment, a Restore per archived item.
 *
 * A mutation's own `isPending` cannot say which row it is about — it
 * tracks the latest call, so one row pending would disable every other —
 * and TanStack draws it a macrotask after the call, so a double click
 * lands both presses before the control has been disabled. `run` checks
 * and marks the key synchronously, so a second press on a row that is
 * already sending does nothing, and `pending` is what the screen draws.
 *
 * The key is let go however the task ends; a failure still rejects, for
 * the caller to say why.
 */
export function useInFlight<K, V = true>() {
  const current = useRef(new Map<K, V>());
  const [pending, setPending] = useState<ReadonlyMap<K, V>>(() => new Map());

  const run = useCallback(async (key: K, value: V, task: () => Promise<unknown>): Promise<void> => {
    if (current.current.has(key)) return;
    current.current.set(key, value);
    setPending(new Map(current.current));
    try {
      await task();
    } finally {
      current.current.delete(key);
      setPending(new Map(current.current));
    }
  }, []);

  return { pending, run };
}
