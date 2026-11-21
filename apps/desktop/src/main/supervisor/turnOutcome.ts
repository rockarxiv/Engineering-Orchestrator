import type { Agent, AgentEvent, AttachmentSource, Item, QuotaEvent, QuotaRefusals, UsageEvent, Uuid } from "@eo/core";
import type { RunEventBuffer } from "../db/repos/runEventBuffer.js";

/**
 * How one turn of an agent ended (EO-886): what the shared turn driver
 * (`driveTurn` in `runSupervisor.ts`) answers for every turn EO drives —
 * an item's own run, a corrective turn on it, and a team's leader and
 * members alike — so a limit, a sign-in, a guard or an answer said only
 * as the last message is read the same way whoever's turn it was.
 */
export type TurnOutcome =
  | { kind: "escalated" }
  | { kind: "result"; data: unknown }
  /**
   * `retryable` is the backend's own word on whether trying again could
   * end differently (EO-437). It is carried rather than dropped because
   * the two answers end the run in different places: a failure worth
   * retrying is a failed run the scheduler offers again, and one that is
   * not is parked for a person after the one attempt.
   */
  | { kind: "error"; message: string; retryable: boolean }
  /**
   * The stream stopped without ever saying it was done.
   *
   * `finalText` is the last thing the agent wrote that *looked* like an
   * answer rather than prose — the raw text, unparsed, exactly as it
   * arrived. It is carried because a turn can deliver a perfectly good
   * terminal result and still end this way: the payload is in the
   * agent's own message and only the `result` event that would have
   * announced it is missing (#141).
   */
  | { kind: "ended"; finalText: string | null }
  | { kind: "paused" }
  /**
   * The backend refused because a plan window is full (EO-172).
   *
   * Its own outcome rather than a `guardTripped` with a different
   * sentence in it, because the two are opposite claims about whose
   * fault the stop was: a tripped guard is EO deciding to stop, and this
   * is EO being told it may not carry on. Only this one is exempt from
   * the correction attempts every other malformed result gets, and
   * making that exemption a distinct outcome is what keeps it from
   * quietly widening to cover a genuinely malformed result later.
   */
  | { kind: "limitReached"; quota: QuotaEvent }
  /**
   * The backend refused the turn because its sign-in is no good (EO-797,
   * `AgentEvent`'s `signIn`). Its own outcome for the reason
   * `limitReached` is: neither the agent's failure nor a guard EO chose
   * to trip, so neither an attempt nor a park for a person on this item.
   */
  | { kind: "signedOut"; message: string }
  | { kind: "guardTripped"; reason: string };

/**
 * One turn as the shared turn driver reads it (EO-886): its stream's
 * run, what counts as its answer, and what the caller keeps of what it
 * spent. The same for every turn; what is only an item's own run's — the
 * agent write bridge's live turn, the brief restated on compaction, the
 * note on an outcome sent mid-flight — comes in `itemRun`, and a team's
 * turn has none of it.
 */
export interface TurnDrive {
  /** The turn's own: once it is aborted, a backend that does not end its turn is not waited on for long (`untilStopped`). */
  signal: AbortSignal;
  runId: Uuid;
  buffer: RunEventBuffer;
  item: Item;
  agent: Agent;
  /** What this turn was actually given, not what the catalogue says now (EO-107). */
  expectedServers: string[];
  /**
   * Whether a message is a valid answer to this turn (#141, #144): the
   * bar a message the turn ends on must clear to be taken as its answer,
   * the same bar a `result` event has to clear.
   */
  accepts: (text: string) => boolean;
  /**
   * The refusals standing against the turn (EO-172): every reading of
   * the backend's own allowance is recorded here. The caller's, so one
   * held across a run's corrective turns is asked after each of them.
   */
  refusals: QuotaRefusals;
  onThreadId: (threadId: string) => void;
  onUsage: (usage: UsageEvent) => void;
  /** Asked after each reading of what the turn spent: why it must stop now, or null. */
  budgetGuard: () => string | null;
  /** Why the turn stopped when its backend stopped it at the budget it was given. */
  budgetStop: () => string;
  pushEvent: (event: AgentEvent) => void;
  /** Only an item's own run's (an ordinary dispatch, a reply, a correction): absent for a team's turn. */
  itemRun?: {
    /** Which action's outcome shape the run answers, for the note on an outcome sent mid-flight (#144). */
    action: string;
    /** Where this run may attach files from, as its turns were told — null when it has nowhere (EO-412). */
    attachFrom: AttachmentSource | null;
  };
}
