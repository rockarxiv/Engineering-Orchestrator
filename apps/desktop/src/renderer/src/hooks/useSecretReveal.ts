import { useCallback, useEffect, useRef, useState } from "react";
import type { RevealedSecret } from "@eo/core";
import { machineAvailable } from "../ipc/bridge";

/**
 * Reveal for a personal secret (EO-489, ARCHITECTURE.md §14.2): one
 * hook, for the four places a secret row is drawn — both layouts' module
 * secrets and both layouts' MCP server secrets.
 *
 * **The value lives in this hook's state and nowhere else.** It is asked
 * for only when the button is pressed, through a machine-half channel,
 * and by a plain call rather than a query or a mutation: TanStack keeps
 * a query's answer in its cache and a mutation's in its mutation cache,
 * and either would outlive the row. Nothing here writes it anywhere.
 *
 * It goes again three ways, and each is the whole of one acceptance
 * criterion:
 *
 * - **Hide** — `hide(key)`.
 * - **Leaving the screen** — unmounting drops the state, and the
 *   cleanup below cancels every timer and makes any answer still in
 *   flight land on nothing.
 * - **Thirty seconds** — `REVEAL_FOR_MS` after the answer arrived.
 *
 * `available` is false on a renderer served by an organisation server,
 * where the channel is refused as `machine-only`: a screen there draws no
 * Reveal button at all rather than one that can only fail.
 */

/** How long a revealed value stays on screen before it hides itself. */
export const REVEAL_FOR_MS = 30_000;

/** What a row draws for a value that is stored and can no longer be decrypted. Never an empty value. */
export const UNREADABLE_REVEAL_LINE = "This value cannot be read on this machine — its keychain no longer opens it. Save a new value to replace it.";

/** What a row draws when the value went between listing it and pressing Reveal. */
export const NOTHING_TO_REVEAL_LINE = "Nothing is stored here any more.";

export type RevealState =
  | { state: "pending" }
  | { state: "value"; value: string }
  | { state: "unreadable" }
  /** `absent` or `reference`: nothing stored that Reveal shows. */
  | { state: "nothing" }
  | { state: "failed"; message: string };

export interface SecretReveal {
  /** Whether this renderer can reveal at all — false where the machine half is refused. */
  available: boolean;
  /** What is showing for a key, or undefined when nothing is. */
  revealed: (key: string) => RevealState | undefined;
  reveal: (key: string) => void;
  hide: (key: string) => void;
}

/** A copy of `map` with `key` set, or removed when `value` is undefined. */
function updated(map: ReadonlyMap<string, RevealState>, key: string, value: RevealState | undefined): ReadonlyMap<string, RevealState> {
  const next = new Map(map);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  return next;
}

/**
 * `ask` is how one key's value is fetched — `moduleSecrets:reveal` for a
 * scope, `mcpServers:revealSecret` for a server. Read through a ref, so a
 * caller can pass a fresh closure on every render.
 */
export function useSecretReveal(ask: (key: string) => Promise<RevealedSecret>): SecretReveal {
  // A Map rather than an object keyed by name: `constructor`, `toString`
  // and `__proto__` are all valid variable names, and an object would
  // answer each of them with what it inherits before anything was asked.
  const [shown, setShown] = useState<ReadonlyMap<string, RevealState>>(() => new Map());
  const askRef = useRef(ask);
  useEffect(() => {
    askRef.current = ask;
  }, [ask]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Which press an answer belongs to, per key, so one that arrives after
  // Hide — or after a second press — is dropped rather than shown.
  const presses = useRef(new Map<string, number>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const pending = timers.current;
    return () => {
      mounted.current = false;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const stopTimer = (key: string) => {
    const timer = timers.current.get(key);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(key);
  };

  const hide = useCallback((key: string) => {
    stopTimer(key);
    presses.current.set(key, (presses.current.get(key) ?? 0) + 1);
    setShown((current) => (current.has(key) ? updated(current, key, undefined) : current));
  }, []);

  const reveal = useCallback(
    (key: string) => {
      stopTimer(key);
      const press = (presses.current.get(key) ?? 0) + 1;
      presses.current.set(key, press);
      setShown((current) => updated(current, key, { state: "pending" }));

      const settle = (next: RevealState) => {
        if (!mounted.current || presses.current.get(key) !== press) return;
        setShown((current) => updated(current, key, next));
        timers.current.set(
          key,
          setTimeout(() => hide(key), REVEAL_FOR_MS),
        );
      };

      askRef.current(key).then(
        (answer) => {
          if (answer.state === "value") settle({ state: "value", value: answer.value });
          else if (answer.state === "unreadable") settle({ state: "unreadable" });
          else settle({ state: "nothing" });
        },
        (error: unknown) => settle({ state: "failed", message: error instanceof Error ? error.message : String(error) }),
      );
    },
    [hide],
  );

  const revealed = useCallback((key: string) => shown.get(key), [shown]);

  return { available: machineAvailable(), revealed, reveal, hide };
}

/** The line a row draws under its controls for what Reveal answered, or null while there is nothing to draw. */
export function revealLine(state: RevealState | undefined): { kind: "value"; value: string } | { kind: "message"; text: string; danger: boolean } | null {
  if (state === undefined || state.state === "pending") return null;
  if (state.state === "value") return { kind: "value", value: state.value };
  if (state.state === "unreadable") return { kind: "message", text: UNREADABLE_REVEAL_LINE, danger: true };
  if (state.state === "failed") return { kind: "message", text: state.message, danger: true };
  return { kind: "message", text: NOTHING_TO_REVEAL_LINE, danger: false };
}

/**
 * What a row's own state holds for a name, and nothing it inherits.
 *
 * The secret rows keep what is typed in objects keyed by variable name,
 * and `constructor`, `toString` and `__proto__` are valid names: a plain
 * `record[name]` answers those with `Object.prototype`'s members, which
 * then sit in the box as a value nobody typed.
 */
export function byName<T>(record: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}
