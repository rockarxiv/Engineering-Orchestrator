import type { Db } from "../../../db/client.js";
import type { AttachmentStorage } from "../../../attachments/storage.js";
import { getSetting, hasJiraPullPending, setSetting } from "../../../db/repos/index.js";
import { startInterval } from "../../../schedule/interval.js";
import type { JiraContext } from "./connection.js";
import { combinePullResults, pullEverything, pullPending, type PullResult } from "./pull.js";

/** How often EO asks Jira what changed. Minutes. */
export const JIRA_PULL_MINUTES_KEY = "jira.pullMinutes";

/**
 * Five minutes. Frequent enough that a comment written in Jira is on the
 * project before anyone wonders where it went, rare enough that a day at
 * the desk is a couple of hundred read-only requests rather than
 * thousands.
 */
export const DEFAULT_JIRA_PULL_MINUTES = 5;

/**
 * The configured interval, or `null` when auto-sync is off.
 *
 * Wrapped in an object because `app_settings.value` is NOT NULL, so a
 * bare `null` cannot be stored — the same shape `archiveAfterDays` uses,
 * and for the same reason. An absent row means "never configured", which
 * is what gives the default.
 */
export function jiraPullMinutes(db: Db): number | null {
  return getSetting<{ minutes: number | null }>(db, JIRA_PULL_MINUTES_KEY, { minutes: DEFAULT_JIRA_PULL_MINUTES }).minutes;
}

export function setJiraPullMinutes(db: Db, minutes: number | null): void {
  setSetting(db, JIRA_PULL_MINUTES_KEY, { minutes });
}

export interface JiraPullScheduleOptions {
  /** Overridable so an end-to-end test does not wait out five minutes. */
  intervalMs?: number;
  onPulled?: (result: PullResult) => void;
  attachmentStorage?: AttachmentStorage;
}

/**
 * How the running schedule is asked to look now rather than on its next
 * tick (EO-127).
 *
 * A module-level slot rather than a handle threaded through the IPC
 * layer, for the same reason `emitPush` is one: the callers are
 * synchronous write handlers deep in `ipc/`, and giving each of them a
 * schedule to hold — in tests as well as in the app — would be a lot of
 * plumbing to make an attach feel instant.
 *
 * It is only ever an optimisation. Nothing is lost when no schedule is
 * running or a tick is already in flight and the kick is dropped: the
 * marker is in the database, and the next tick drains it. That is the
 * division the whole story rests on, and it is what keeps this a slot
 * that may be empty rather than a dependency.
 */
let kickPendingDrain: (() => void) | null = null;

/**
 * Asks the pull schedule to drain its pending items now (EO-127).
 *
 * Called by the handlers that attach a key — `work:submitItem`,
 * `work:submitPlan`, `items:update` — after the write has landed. A
 * no-op when nothing is running, which is every test that does not
 * start a schedule and the window between quitting and the next launch.
 */
export function requestJiraPullDrain(): void {
  kickPendingDrain?.();
}

/**
 * Asks Jira what changed, on a timer (and once at launch).
 *
 * At launch as well as on the timer, because a desktop app closed every
 * evening would otherwise never reach a five-minute tick — the same
 * reason the archive sweep runs at boot.
 *
 * Reads the interval on every tick rather than capturing it, so turning
 * auto-sync off in Settings takes effect on the next tick instead of the
 * next launch. A tick that finds it disabled does nothing; the timer
 * keeps its own rhythm and costs nothing while off.
 *
 * Two jobs since EO-127, in this order: the items somebody has just
 * attached to an issue, and then the ordinary sweep. They are gated
 * differently on purpose. The sweep is polling — "what moved in the
 * last five minutes" — and the interval, including turning it off
 * entirely, is how often somebody wants EO asking that. A pending drain
 * is not polling: it is one issue a person or an agent just said this
 * item *is*, and the request to read it was made explicitly, at a
 * moment, by them. Holding that until the next five-minute boundary
 * would make attaching feel broken, and holding it until auto-sync is
 * switched back on would leave the attach silently unfinished.
 */
export function startJiraPull(db: Db, context: JiraContext, options: JiraPullScheduleOptions = {}): () => void {
  // The tick interval, not the sync interval: the timer wakes up often
  // enough to notice a settings change, and each wake decides whether
  // there is anything to do. Constant, so `readIntervalMs` below returns
  // it unchanged — the sync interval is the one that is read per tick,
  // and it is read inside the tick because the drain answers to neither
  // it nor the setting.
  const tickMs = options.intervalMs ?? 60_000;
  let lastPullAt = 0;

  const tick = async (): Promise<void> => {
    const minutes = jiraPullMinutes(db);
    const now = Date.now();
    // Two questions, because the drain answers to neither the interval
    // nor the setting — see this function's own comment. `sweepMinutes`
    // is null unless the sweep is due, so the branch below carries the
    // interval it is due for rather than deriving it a second time.
    const sweepMinutes = minutes !== null && now - lastPullAt >= minutes * 60_000 ? minutes : null;
    const draining = hasJiraPullPending(db);
    if (sweepMinutes === null && !draining) return;

    if (sweepMinutes !== null) lastPullAt = now;
    const results: PullResult[] = [];
    // Pending first. Somebody is watching for this one, and a sweep of
    // forty repositories ahead of it is forty round trips of waiting.
    if (draining) results.push(await pullPending(db, context, options.attachmentStorage));
    if (sweepMinutes !== null) results.push(await pullEverything(db, context, sweepMinutes, options.attachmentStorage));

    const result = combinePullResults(results);
    if (result.comments > 0 || result.edits > 0 || result.attachments > 0) {
      console.log(`[eo] pulled ${result.comments} comment(s), ${result.edits} edit(s), and ${result.attachments} attachment change(s) from Jira`);
    }
    if (result.problem) console.warn(`[eo] Jira sync: ${result.problem}`);
    options.onPulled?.(result);
  };

  // Non-overlapping, the launch tick, the unref and the kick all belong
  // to the shared loop now (EO-303). The drain is inside the non-overlap
  // rule rather than beside it, exactly as it was: a kick arriving while
  // a sweep is in flight is dropped, and the marker it was about is
  // drained by the next tick. Reading Jira must never be the reason the
  // app falls over, and the loop's own catch — `[eo] Jira sync failed:`
  // — is what holds that.
  const loop = startInterval({ name: "Jira sync", tick, readIntervalMs: () => tickMs });

  // Where `requestJiraPullDrain` lands while this schedule is the one
  // running. Last one in wins, which in the app is the only one there
  // has ever been and in a test is the one that test just started.
  kickPendingDrain = loop.kick;
  return () => {
    loop.stop();
    // Only if it is still ours: a disposed schedule must not unhook a
    // later one that has already claimed the slot.
    if (kickPendingDrain === loop.kick) kickPendingDrain = null;
  };
}
