/**
 * The backends an agent can be pointed at, named for a person.
 *
 * The real catalog lives in the main process (`main/runtimes/catalog.ts`)
 * because it is the thing that resolves, fetches and verifies these. That
 * module reaches for `node:fs`, so importing it here would drag the
 * filesystem into the renderer bundle to read two strings. Two lists that
 * have to agree is the cost; a channel whose entire job is to return
 * "codex" and "claude" is the alternative, and it is worse.
 *
 * `runtime:status` is still the authority on any *fact* about a runtime —
 * this only says which ones exist to ask about.
 */
export interface RuntimeChoice {
  id: string;
  label: string;
}

/** Runtimes EO knows how to fetch and keep up to date. Mirrors `RUNTIMES`. */
export const MANAGED_RUNTIMES: readonly RuntimeChoice[] = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
];

/**
 * Everything an agent's backend may be set to.
 *
 * `fake` runs in-process and fetches nothing, which is why it is not a
 * runtime: it never appears on the Runtimes tab and has nothing to
 * install. It is still a valid choice for an agent — the seeded ones use
 * it — so it belongs here and only here.
 */
export const PROVIDERS: readonly RuntimeChoice[] = [{ id: "fake", label: "Built in (fake)" }, ...MANAGED_RUNTIMES];

export function runtimeLabel(id: string): string {
  return PROVIDERS.find((choice) => choice.id === id)?.label ?? id;
}
