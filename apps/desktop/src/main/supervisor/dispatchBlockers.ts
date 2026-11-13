import type { PipelineStep } from "@eo/core";
import type { DispatchBlocker } from "@eo/engine";
import { blockedByActiveRunRefusal } from "./itemLock.js";

/**
 * The refusals an installed pack's dispatch gate can answer with, as far
 * as this process has words for them (KAN-161).
 *
 * The engine carries a gate's refusal without reading it — `kind` is an
 * open string there, because a pack's rule is a pack's business. Here it
 * is closed to the one EO ships, and deliberately: `blockerWords` below
 * is a total mapping from a reason to a sentence, and a refusal nobody
 * has words for is a guard that ends in silence (invariant #8). A second
 * pack with a rule of its own widens this type and the switch in the
 * same commit, which is the point — the compiler asks for the sentence.
 */
export type GateRefusal = { kind: "no_acceptance_criteria" };

/**
 * The item's project has been archived (EO-347).
 *
 * Not a gate refusal — no pack decided it — and not something the
 * engine can report either, since an item on an archived project is
 * never in the scheduler's input. So it is asked first, by
 * `archivedProjectBlocker`, everywhere EO explains an item.
 *
 * Carries the project's name because that is the fix: a person told
 * "its project is archived" goes looking for which one.
 */
export type ProjectArchived = { kind: "project_archived"; projectName: string };

/**
 * The scheduler's `open_dependency`, with the names a person reads it in
 * (EO-776): the engine carries ids only, and this file has no database,
 * so `namedBlocker` in `buildTickInput.ts` resolves them.
 *
 * `dependencyKey` is the item holding this one, `nowAt` the name of the
 * step it stands on (null on none), and `gateStepName` the name of the
 * step a `reached` edge waits for it to reach (null for `finished`).
 */
export type WaitingOnDependency = Extract<DispatchBlocker<GateRefusal>, { kind: "open_dependency" }> & {
  dependencyKey: string;
  nowAt: string | null;
  gateStepName: string | null;
};

/**
 * Why an item is not going to be dispatched, as EO says it (EO-347).
 *
 * The scheduler's reasons, plus the one that is decided before the
 * scheduler is asked. What `EngineHandle.dispatchBlockerFor` answers.
 * An open dependency is the scheduler's own reason with its names
 * resolved (`WaitingOnDependency`).
 */
export type ItemBlocker = Exclude<DispatchBlocker<GateRefusal>, { kind: "open_dependency" }> | WaitingOnDependency | ProjectArchived;

/**
 * "Waits for EO-12 to reach Watch merge request (now at Review)": what a
 * `reached` edge that still holds is waiting for, in one sentence
 * (EO-776). Null for a `finished` edge, which keeps the words it has
 * always had.
 */
export function gateWords(blocker: Pick<WaitingOnDependency, "dependencyKey" | "gateStepName" | "nowAt"> & { wait: string }): string | null {
  if (blocker.wait !== "reached") return null;
  const gate = blocker.gateStepName ?? "a step its pipeline no longer has";
  return `Waits for ${blocker.dependencyKey} to reach ${gate} (now at ${blocker.nowAt ?? "no step"})`;
}

/**
 * Why a *rerun* will not run: the scheduler's reasons, plus the one only
 * a request naming somebody can have (EO-135).
 *
 * `tick()` staffs a step from whoever holds its role, so "is anybody
 * enabled for this role" is the only staffing question it can ask, and
 * `DispatchBlocker` says no more than that. A rerun names an agent, and
 * that agent being switched off is a different fact from the role being
 * unstaffed — with two reviewers and one of them off, the scheduler's
 * answer is "fine" and the honest answer to the person is "not that one".
 *
 * Kept out of the engine deliberately: it is not a scheduling condition,
 * and `packages/engine` has no business knowing that requests can name
 * an agent.
 */
export type RerunBlocker =
  | ItemBlocker
  | { kind: "agent_disabled"; agentName: string }
  /**
   * The agent the request named has been retired (EO-186).
   *
   * Its own reason rather than `agent_disabled`, because the two differ
   * in the only part of a refusal that is any use: what to do about it.
   * "Enable it in Settings" is a switch a disabled agent has and an
   * archived one does not — nothing un-archives — so a person sent
   * looking for it would be sent looking for nothing.
   *
   * `role` travels with the name so the fix can point at the thing that
   * still exists. The step is owned by a role, not by this agent, and
   * another agent on that role is what makes the step run again.
   */
  | { kind: "agent_archived"; agentName: string; role: string }
  /**
   * The item left the step the request was about.
   *
   * `nowAt` is where it is instead, and `rerunWith` the enabled agent
   * that owns *that* step, or null when nothing there is an agent's to
   * run. Both are resolved by the caller: this file has no database.
   */
  | { kind: "step_moved"; nowAt: string; rerunWith: string | null }
  /**
   * The item stayed put and the step changed underneath it.
   *
   * A step is data somebody can edit (invariant #7), so the contract a
   * request was classified against — this agent owns this step, and its
   * action is that one — can stop holding while the run is still being
   * prepared. Distinct from `step_moved` because nothing moved, and
   * telling somebody their item went somewhere it did not is worse
   * than saying nothing.
   */
  | { kind: "step_reassigned"; stepName: string; rerunWith: string | null }
  /**
   * The agents have been talking to each other for long enough
   * (EO-212, ARCHITECTURE.md, "Agent to agent").
   *
   * Here rather than in `DispatchBlocker` for `agent_disabled`'s reason:
   * the engine staffs a step from a role and knows nothing about
   * requests that name somebody, and a mention chain is made entirely of
   * those. It is also not a scheduling condition — the item is
   * perfectly dispatchable, and it is this particular request that is
   * not.
   *
   * `agents` are the names in the chain, `hops` how many it ran to and
   * `cap` what it was allowed. All three, because the fix is a person
   * saying something and a person will not say anything about "the
   * mention depth cap was reached".
   */
  | { kind: "mention_depth"; agents: string[]; hops: number; cap: number };

/**
 * "A", "A and B", "A, B and C" — the chain read out in order.
 *
 * Its own function because the empty case is real: an agent deleted
 * outright leaves hops in the thread whose author has no name left to
 * print, and "and have mentioned each other" is worse than saying
 * nothing about who.
 */
function namesInWords(names: string[]): string {
  if (names.length === 0) return "agents on this ticket";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

/**
 * What each reason the scheduler will not dispatch an item means in
 * words, and what a person would do about it (EO-135).
 *
 * One mapping, in one file, because two different parts of EO have to
 * say the same things: the rerun request that is being turned down, and
 * the resume acknowledgement that must not promise a pickup that is not
 * coming. Those two sentences drifting apart is a smaller version of the
 * bug this exists to fix — EO saying one thing and doing another.
 *
 * `run_active` has no entry. It has a wording already, and it is the one
 * every blocked action in EO answers with: `blockedByActiveRunRefusal`.
 */
export function blockerWords(blocker: Exclude<RerunBlocker, { kind: "run_active" }>): {
  /** The condition, as the tail of "... : <condition>." */
  condition: string;
  /** The one thing to do about it, as a whole sentence. */
  fix: string;
} {
  switch (blocker.kind) {
    case "step_reassigned":
      return {
        condition: `"${blocker.stepName}" has been reconfigured since you asked`,
        fix:
          blocker.rerunWith === null
            ? `Nothing there is an agent's to run any more, so there is no step to hand back.`
            : `Mention ${blocker.rerunWith} if you want "${blocker.stepName}" run as it stands now.`,
      };
    case "step_moved":
      return {
        condition: `this ticket has moved to "${blocker.nowAt}" since you asked`,
        fix:
          blocker.rerunWith === null
            ? `Nothing there is an agent's to run, so there is no step to hand back.`
            : `Mention ${blocker.rerunWith} if you want "${blocker.nowAt}" run instead.`,
      };
    case "agent_disabled":
      // Names the agent, because the person named it. "No enabled agent
      // holds the reviewer role" is false when a second reviewer is on,
      // and sends somebody to Settings looking for the wrong switch.
      return { condition: `${blocker.agentName} is switched off`, fix: `Enable ${blocker.agentName} in Settings.` };
    case "agent_archived":
      return {
        condition: `${blocker.agentName} has been archived`,
        // Says the one-way part out loud. Without it the obvious next
        // move is to go and un-archive it, and there is nothing to
        // press: the row is kept for the record and nothing brings it
        // back into service.
        fix: `Archiving is one way, so give the "${blocker.role}" role another agent and mention that one.`,
      };
    case "mention_depth":
      return {
        condition:
          `${namesInWords(blocker.agents)} have mentioned each other ${blocker.hops} time(s) here ` +
          `since anybody else said anything, and the limit is ${blocker.cap}`,
        // The whole of the fix, and the only one there is: the count is
        // taken from the last human comment, so any comment at all — an
        // answer, a nudge, "carry on" — starts the allowance again.
        fix: "Say something on this ticket and they can carry on from there.",
      };
    case "paused":
      return { condition: "EO is paused", fix: "Resume the engine." };
    case "project_archived":
      return {
        condition: `its project, "${blocker.projectName}", is archived`,
        fix: `Restore "${blocker.projectName}" in Settings → Projects and it carries on from this step.`,
      };
    case "held":
      return { condition: "this ticket is on hold", fix: "Resume it." };
    case "retry_backoff":
      return {
        condition: `its last run here failed, and EO waits until ${new Date(blocker.until).toLocaleTimeString()} before trying again`,
        fix: "Nothing to do: it is tried again by itself then.",
      };
    case "watching":
      // When, in the words a person reads a clock in, because "when is
      // the next check" is the whole of what they came to ask (EO-456).
      // A deadline that comes first is the moment that matters, so it
      // leads — but the next check is still named, because a person
      // reading this asked when EO looks next, and the honest answer is
      // "not before it gives up". A watch that never gives up (EO-571)
      // has no such moment, so it is only ever the next check.
      return blocker.giveUpAt !== null && blocker.giveUpAt <= blocker.nextCheckAt
        ? {
            condition:
              `this step keeps checking on something outside EO; its next check would be at ${new Date(blocker.nextCheckAt).toLocaleString()}, ` +
              `but it gives up first, at ${new Date(blocker.giveUpAt).toLocaleString()}, and will not check again before then`,
            fix: "Nothing to do until then: when it gives up it stops and asks you itself.",
          }
        : {
            condition: `this step keeps checking on something outside EO, and its next check is at ${new Date(blocker.nextCheckAt).toLocaleString()}`,
            fix: "Nothing to do: it checks again by itself then, and moves on as soon as a check has a result.",
          };
    case "watch_held":
      // Why a watch that is due is not being checked (EO-457): a check
      // that cannot reach what it checks fails, and failures escalate.
      return blocker.reason === "offline"
        ? {
            condition: "this step keeps checking on something outside EO, and EO is offline, so it does not check until the connection is back",
            fix: "Nothing to do: it checks again by itself once EO is online.",
          }
        : {
            condition:
              `this step keeps checking on something outside EO, and the computer has just woken, ` +
              `so it waits until ${new Date(blocker.until).toLocaleTimeString()} for the network to come back before it checks`,
            fix: "Nothing to do: it checks once by itself then.",
          };
    case "awaiting_input":
      return {
        condition: "the last run here is waiting for an answer from you",
        fix: "Answer it above and this step carries on by itself.",
      };
    case "open_dependency": {
      // A `reached` edge says which item and which step (EO-776); a
      // `finished` edge keeps today's words.
      const gate = gateWords(blocker);
      return gate === null
        ? {
            condition: "this ticket is waiting on another that has not finished",
            fix: "Finish that ticket, or remove the dependency.",
          }
        : {
            condition: `it ${gate.charAt(0).toLowerCase()}${gate.slice(1)}`,
            fix: `Nothing to do: it carries on by itself once ${blocker.dependencyKey} gets there or finishes. Or remove the dependency.`,
          };
    }
    case "no_enabled_agent":
      return {
        condition:
          blocker.role === null
            ? "this step names no role, so nobody can be staffed on it"
            : `no enabled agent holds the "${blocker.role}" role`,
        fix: "Enable one in Settings.",
      };
    case "no_acceptance_criteria":
      return {
        condition: "this ticket declares no acceptance criteria, so a review would have nothing to judge it against",
        fix: "Add at least one — `ticket_update` takes them on any type, and the ticket screen edits them.",
      };
    case "unknown_step":
    case "step_not_dispatchable":
      return {
        condition: "this ticket is not sitting on a step an agent is dispatched at",
        fix: "Move it to one.",
      };
  }
}

/**
 * EO turning down a request to hand a step back to its agent.
 *
 * `blockedByActiveRunRefusal`'s four-part shape for every reason, not
 * only the busy one: EO did not do *this*, because of *that*, and *here
 * is what would work*. A person who has just watched an item sit still
 * needs the third part most — "nothing happened" is the report they
 * already have.
 */
export function rerunRefusal(step: PipelineStep, blocker: RerunBlocker): string {
  const action = `run "${step.name}" again as you asked`;
  if (blocker.kind === "run_active") return blockedByActiveRunRefusal(action);
  const { condition, fix } = blockerWords(blocker);
  // These four already name what to ask for and who to ask, so the
  // generic tail would be saying it twice. `agent_archived` is one of
  // them because "then ask again" is the one thing that will never work
  // here: the agent that was asked for is not coming back. So is
  // `mention_depth`, for the opposite reason — asking again is precisely
  // what has just been capped, and the fix already says who has to move.
  const tail =
    blocker.kind === "step_moved" ||
    blocker.kind === "step_reassigned" ||
    blocker.kind === "agent_archived" ||
    blocker.kind === "mention_depth"
      ? ""
      : " Then ask again.";
  return `EO did not ${action}: ${condition}. ${fix}${tail} Nothing has changed.`;
}

/**
 * EO turning down work that would have started a retired agent (EO-186).
 *
 * `rerunRefusal`'s shape and, deliberately, `rerunRefusal`'s words: the
 * reason and the fix are the same fact about the same agent however the
 * work arrived, so both are composed from `blockerWords` rather than
 * written out again — the whole point of that mapping is that EO cannot
 * come to say two different things about one condition.
 *
 * `did` is the only part that changes, and it has to: "EO did not answer
 * this mention" and "EO did not start this run" are different promises
 * being withdrawn, and a person reading the thread is owed the one that
 * was actually made to them.
 *
 * Only the archived reason has this. A *disabled* agent is still
 * mentioned, still resumed and still restarted — off is "not right now",
 * and the work keeps — so there is nothing to turn down and nothing to
 * say.
 */
export function archivedAgentRefusal(blocker: Extract<RerunBlocker, { kind: "agent_archived" }>, did: string): string {
  const { condition, fix } = blockerWords(blocker);
  return `EO did not ${did}: ${condition}, so nothing dispatches it. ${fix} Nothing has changed.`;
}

/**
 * Who an agent works for and where the item is, for every refusal of
 * an agent whose project is not this item's (EO-474, ARCHITECTURE.md,
 * "An agent is a row").
 *
 * `itemProject` is null for an item on no project, which no project's
 * agent reaches either. One phrasing for every door — a mention, a
 * reply to a parked run, a recovery after a restart, a forced restart,
 * a dispatch — so EO says the same thing about one fact wherever it
 * comes up.
 */
export interface OutOfProject {
  agentName: string;
  agentProject: string;
  itemProject: string | null;
}

function outOfProjectCondition({ agentName, agentProject, itemProject }: OutOfProject): string {
  const where = itemProject === null ? "this ticket belongs to no project" : `this ticket is on "${itemProject}"`;
  return `${agentName} works for the "${agentProject}" project only, and ${where}`;
}

/**
 * EO turning down a mention of another project's agent.
 *
 * A project's own agent works for that project and nobody else, and a
 * mention is a dispatch like any other: the agent would read this
 * item's thread and workspace and answer on it. Said rather than
 * skipped, and the mention closed with it, for `archivedAgentRefusal`'s
 * reason — an open mention is offered again on every tick.
 */
export function outOfProjectMentionRefusal(words: OutOfProject): string {
  return (
    `EO did not answer this mention: ${outOfProjectCondition(words)}. ` +
    "Mention an agent that works for this ticket's project, or a global one. Nothing has changed."
  );
}

/**
 * A start refused at the one door every start goes through, for an
 * agent that no longer works for this item's project — the last line
 * behind the recovery paths, which settle their own cases first.
 */
export function outOfProjectDispatchRefusal(words: OutOfProject): string {
  return (
    `EO did not start this run: ${outOfProjectCondition(words)}, so it does not run here. ` +
    "Give this ticket's project an agent of its own in this role, or use a global one. Nothing has changed."
  );
}

/**
 * A parked run, a run interrupted by a restart or a run stopped for a
 * forced restart, whose agent has moved to another project since —
 * written off rather than carried on, and the item left for whoever
 * staffs the step for its own project.
 *
 * `what` is the run in the person's words, as the start of a sentence
 * ("The run that was waiting for your answer here"), and `role` is the
 * step's role, which is who picks the work up now.
 */
export function outOfProjectRecoveryNote(words: OutOfProject, what: string, role: string): string {
  return (
    `${what} is closed rather than carried on: ${outOfProjectCondition(words)}. ` +
    `This ticket is free to carry on — whoever works for its project in the "${role}" role picks the step up again.`
  );
}

/**
 * EO turning down a mention because the agents have been at it long
 * enough (EO-212, ARCHITECTURE.md, "Agent to agent").
 *
 * `archivedAgentRefusal`'s shape and, for the same reason,
 * `blockerWords`' words: the condition and the fix are one fact about
 * one item, and EO must not come to say two different things about it
 * depending on which door the mention arrived at.
 *
 * "Nothing has changed" is the sentence every refusal in this file ends
 * on, and it is worth as much here as anywhere: no run was started, the
 * item has not moved, and the only thing that happened is that the
 * mention was closed rather than left to be offered again on every tick.
 */
export function mentionDepthRefusal(blocker: Extract<RerunBlocker, { kind: "mention_depth" }>): string {
  const { condition, fix } = blockerWords(blocker);
  return `EO did not answer this mention: ${condition}, so nothing dispatches it. ${fix} Nothing has changed.`;
}

/**
 * What a resume can honestly promise about what happens next (EO-135).
 *
 * "It can be picked up again from the same step" was said unconditionally,
 * and #142 is what that costs when it is not true: the person is told the
 * item is live, watches nothing happen, and has nothing on the thread
 * to tell them why. So the claim is now checked before it is made.
 *
 * `run_active` is deliberately not reported. Resuming an item with a run
 * in flight cancels that run, and the cancellation is asynchronous — the
 * row is still `running` when this is written. Naming it would report the
 * resume's own doing as the reason the resume will not take.
 */
export function resumeOutlook(stepName: string, blocker: ItemBlocker | null): string {
  if (blocker === null || blocker.kind === "run_active") {
    return `It can be picked up again from the same step.`;
  }
  const { condition, fix } = blockerWords(blocker);
  return `Nothing will pick it up from "${stepName}" yet, though: ${condition}. ${fix}`;
}

/**
 * What EO says when somebody stops a run and nothing else (EO-175,
 * invariant 8).
 *
 * A cancellation now ends the initiation it stopped: the scheduler does
 * not offer the same step again by itself, which is the difference
 * between a person's decision and a hiccup EO recovers from. That is a
 * change to what happens *after* the run ends, so a person who cancels
 * and watches nothing happen has no way to tell it from EO having
 * forgotten. Hence the sentence — and hence its second half, which is
 * the part that matters: what starts it again.
 *
 * The three things offered are the three that re-authorise a step, and
 * they are offered because each of them is a person: a mention hands the
 * step back to its agent, a move puts the item in a new initiation,
 * and a hold resumed gives the item back to the scheduler where it
 * stands. That last one is not filler — on a step EO runs itself there
 * is nobody to mention, so holding and resuming is the only way to have
 * the same step run again without moving the item off it and back.
 *
 * `rerunWith` is null exactly there, and the mention is then left unsaid
 * rather than pointed at nobody.
 */
export function stoppedByHandNote(stepName: string, rerunWith: string | null): string {
  const ways =
    rerunWith === null
      ? `Move the ticket, or hold it and resume it, and it is picked up again.`
      : `Mention ${rerunWith} to hand the step back, move the ticket, or hold it and resume it — any of the three picks it up again.`;
  return `Run cancelled, and EO has stopped with it: nothing will pick "${stepName}" up again on its own. ${ways}`;
}
