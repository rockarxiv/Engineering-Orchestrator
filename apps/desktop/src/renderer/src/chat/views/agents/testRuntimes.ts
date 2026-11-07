import type { RuntimeStatusView } from "@eo/core";

/**
 * Runtime statuses for tests of the screens that install and sign in a
 * coding agent (EO-659): what `runtime:status` answers for a runtime EO
 * has not fetched, which the other two states are spread from.
 */
export function absent(id: "codex" | "claude", label: string): RuntimeStatusView {
  return {
    id,
    label,
    publisher: `${label}'s publisher`,
    termsUrl: "https://example.com/terms",
    source: "absent",
    path: null,
    version: null,
    packageName: `@example/${id}`,
    packageVersion: "1.0.0",
    state: "needs_consent",
    enabled: true,
    auth: { state: "unknown", method: null, kind: "unknown", storedKey: false, account: null, problem: null },
    automaticUpdates: false,
    problem: null,
    usedBy: [],
    components: [],
  };
}

/** Fetched and unpacked, and nobody has signed in to it. */
export function signedOut(id: "codex" | "claude", label: string): RuntimeStatusView {
  return {
    ...absent(id, label),
    source: "cache",
    state: "ready",
    path: `/runtimes/${id}`,
    auth: { state: "signed_out", method: null, kind: "unknown", storedKey: false, account: null, problem: null },
  };
}

/** Fetched, unpacked and signed in. */
export function signedIn(id: "codex" | "claude", label: string): RuntimeStatusView {
  return {
    ...signedOut(id, label),
    auth: { state: "signed_in", method: "subscription", kind: "subscription", storedKey: false, account: "anna@example.com", problem: null },
  };
}
