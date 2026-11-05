import type { Agent, Item } from "@eo/core";
import type { Dispatch } from "@eo/engine";
import type { DispatchLease } from "../db/repos/leasesRepo.js";
import type { PrepareWorkspaceOutcome, PrepareWorkspaceRequest } from "../supervisor/workspaceKind.js";

/**
 * The device this desktop is, in the record/device split (EO-322,
 * `ARCHITECTURE.md`, "The record").
 *
 * A device is the machine the work actually happens on: the person's
 * laptop, their login to Claude or Codex, their files. It owns none of
 * the item state — it claims a dispatch under a lease, runs the
 * machine-local preflight, runs the dispatch, and reports what happened
 * as a comment and a transition command. The record decides and writes.
 *
 * Its one implementation wraps today's run supervisor, which is where
 * every one of these already lived: `checkAuth`, `isAgentAvailable` and
 * `prepareWorkspace` are the preflight, and they have always run before
 * the run row exists, which is exactly the gap a lease covers and the
 * in-process item lock could not.
 */
export interface Device {
  /** Which device this is. `local` for the one the desktop runs in its own process. */
  readonly id: string;
  /**
   * Take up a claim the record granted with an offer of work (EO-324).
   *
   * There is nothing to acquire here, and that is the change EO-324
   * made: the record leases an item *as* it offers it, because a
   * dispatch that is offered and not yet claimed is a window in which a
   * second device can be offered the same one. What this does is
   * register the claim, so that the tick renews it for as long as the
   * dispatch lasts and the record can tell a device that is working
   * from one that is gone.
   */
  adopt: (lease: DispatchLease) => void;
  /**
   * Push every claim this device is still working under out again,
   * before the record sweeps.
   *
   * A round trip when the record is elsewhere, which is why it is
   * awaited: a tick that dispatched before its renewal landed would be
   * a machine starting new work while the record was deciding it had
   * gone quiet.
   */
  renewClaims: () => Promise<void>;
  /** Give a claim back. */
  release: (lease: DispatchLease) => Promise<void>;
  /**
   * Is this machine able to run this dispatch at all?
   *
   * Everything here is local to the machine and unknowable to the
   * record: whether the backend is installed, whether the person is
   * signed in to it. A device that cannot preflight reports a refusal
   * rather than failing quietly (invariant #8).
   */
  preflight: (subject: DispatchSubject) => Promise<PreflightOutcome>;
  /**
   * The machine's filesystem for this dispatch, prepared before the run
   * row exists — so a dirty checkout or a clashing branch is a refusal
   * on the item rather than an agent that started and could not work.
   *
   * The second half of the preflight, and a step of its own rather than
   * folded into `preflight` above, because something is said between
   * them: a dispatch about to be turned away for a signed-out backend
   * has a more pressing thing to say than what EO will not carry to it.
   */
  prepareWorkspace: (item: Item, action: string, request?: PrepareWorkspaceRequest) => Promise<PrepareWorkspaceOutcome>;
  /** Run what was claimed. The supervisor's own dispatch, unchanged. */
  run: (dispatch: Dispatch, opts: { stillEligible: () => boolean }) => Promise<void>;
  /**
   * Say what happened, as a comment on the item (invariant #4).
   *
   * A refusal is reported and not swallowed: a placeholder run carrying
   * the reason, an escalation in the thread, and `!` on the item —
   * which is the treatment every other guard in the supervisor gives,
   * reached here through one named door.
   */
  report: (subject: DispatchSubject, refusal: RefusedPreflight, attempt: DispatchAttempt) => void;
}

/** What a dispatch is about: this item, this agent, this action. */
export interface DispatchSubject {
  item: Item;
  agent: Agent;
  action: string;
}

/** Which attempt at which initiation a refusal belongs to, so the limit counts it once. */
export interface DispatchAttempt {
  initiationId: string;
  attempt: number;
}

/** The machine says no, and here is what to tell the person. */
export interface RefusedPreflight {
  kind: "refused";
  reason: string;
  /** Answers to offer with it, where the refusal has any (a dirty checkout, say). */
  options?: string[];
}

/**
 * What the preflight found.
 *
 * `stand-down` is the silent one and deliberately so: the runtime was
 * uninstalled, the agent retired, the item deleted while an await was
 * open. Nothing was promised and nothing was written, and a comment
 * about EO's own timing is not something a person can act on.
 */
export type PreflightOutcome = { kind: "ready" } | RefusedPreflight | { kind: "stand-down" };

/** The device a desktop is when it is also the record — one process, one local lease. */
export const LOCAL_DEVICE_ID = "local";
