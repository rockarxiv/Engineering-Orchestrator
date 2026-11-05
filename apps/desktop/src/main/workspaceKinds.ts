import type { WorkspaceKindSlug } from "@eo/core";
import { describesChecks, verifiesAnything, type VerifiedStep, type WorkspaceKind } from "./supervisor/workspaceKind.js";

/**
 * The workspace kinds in force for this process (EO-312).
 *
 * A sibling of `registry.ts`, and for exactly its reason. The supervisor
 * is handed the folded kinds as options and needs nothing else; the
 * *screens* need them too — a column head says what its step's kind
 * checks (ARCHITECTURE.md, "What 'EO checks' means on a step") and the route editor asks whether
 * `verification_failed`
 * is a result a step could ever report — and an IPC handler has no
 * supervisor to ask. Threading a kinds map through every query that
 * draws a step would put an argument on functions with no other reason
 * to know a kind exists, with one caller forgetting it and answering for
 * a different installation than the one running.
 *
 * Only what a *screen* may ask is exposed. `prepare`, `attach` and
 * `release` do work, and nothing reachable from an IPC handler should be
 * able to start it from here — this answers questions about kinds and
 * hands none of them out.
 *
 * Empty until the composition root fills it, which is the honest default
 * for a process that never composed an engine: a test of a single
 * lookup, a handler exercised on its own. An installation with no kinds
 * checks nothing, and a board told so says so.
 */
let current: ReadonlyMap<string, WorkspaceKind> = new Map();

/**
 * Installed once, by `createEngine`, from whatever packs it folded.
 *
 * Called in the same breath as `useRegistry` and for the same reason:
 * both are what the installed packs contribute, and both are read by
 * screens that are not the engine.
 */
export function useWorkspaceKinds(kinds: ReadonlyMap<string, WorkspaceKind>): void {
  current = kinds;
}

/** What one kind checks on one step, and whether it checks anything at all (EO-312, ARCHITECTURE.md, "What 'EO checks' means on a step"). */
export interface KindVerification {
  /** The phrases a column head joins — empty when nothing on this step is checked. */
  checks: readonly string[];
  /** Whether anything would be checked here, which is what decides whether `verification_failed` can be routed. */
  verifiesAction: boolean;
  /** Whether this kind vouches for anything, which is what decides whether a board explains itself. */
  kindVerifies: boolean;
}

/**
 * What a step on `kind` can say for itself.
 *
 * Asked of the step rather than of its action alone, because for the
 * folder kind the two differ: it checks the files a step *declares* it
 * produces, so a step declaring none is checked for nothing even though
 * its kind answers for every action. `verifiesAction` therefore follows
 * the words rather than the table — the question the editor is really
 * asking is "could a check fail here", and a verifier that would produce
 * no checks on this step can fail none.
 *
 * That is a change from asking `verifies(kind, action)` directly, and it
 * is the narrower of the two: every step the table would have said yes
 * to and the step's own configuration says nothing about is one where
 * a `verification_failed` route could never be taken.
 *
 * A kind nothing installed — a slug from a pack that has since been
 * removed, or an installation with no packs at all — checks nothing and
 * says so. That is the same answer as the `none` kind's, which is right:
 * in both cases EO cannot vouch for the work, and the difference between
 * "no kind" and "a kind that checks nothing" is EO's bookkeeping rather
 * than anything a person is being told.
 */
export function verificationOfKind(slug: WorkspaceKindSlug, step: VerifiedStep): KindVerification {
  const kind = current.get(slug);
  if (kind === undefined) return { checks: [], verifiesAction: false, kindVerifies: false };
  const checks = describesChecks(kind, step);
  return {
    checks,
    verifiesAction: checks.length > 0,
    kindVerifies: verifiesAnything(kind),
  };
}
