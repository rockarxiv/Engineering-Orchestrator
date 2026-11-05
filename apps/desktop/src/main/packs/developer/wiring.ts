import {
  actionOverrideFor,
  developerRegistry,
  INTAKE_ACTION,
  INTERPRET_ACTION,
  IntakeAnswerSchema,
  ReviewOutputSchema,
  UNKNOWN_ITEM_TYPE,
  type Agent,
  type Registry,
  type Item,
  type Uuid,
  type PipelineStep,
} from "@eo/core";
import { emitPush } from "../../ipc/push.js";
import type { Db } from "../../db/client.js";
import { getItemType, resolveItemType } from "../../db/repos/index.js";
import type { RoleWiring } from "../pack.js";
import type { NextStep } from "../../supervisor/runSupervisor.js";
import { routeResult } from "../../supervisor/routeResult.js";
import { packMeaningInForce } from "../../registry.js";
import { RESPOND_ACTION } from "../../supervisor/manualDispatch.js";
import { ASSIST_ACTION, postAssistReply } from "../../roles/assist.js";
import { SCENARIO_ACTION, postScenarioReply } from "../../roles/scenario.js";
import { postImplementHandoff } from "../../roles/handoff.js";
import { postIntakeSummary } from "../../roles/intake.js";
import { postInterpretation } from "../../roles/interpretation.js";
import { postMentionReply } from "../../roles/mentionReply.js";
import { postReviewFeedback } from "../../roles/reviewVerdict.js";
import { createPosters } from "./posters.js";
import { continueTrialLoop } from "../../trials/design.js";

/**
 * Whether the type `intake` answered with is a container (KAN-146).
 *
 * Read from the result rather than from `item.container`: the item's own
 * row has not been updated yet at this point in the run, and this has to
 * agree with the update `postIntakeSummary` is about to make
 * (KAN-37/EO-5).
 *
 * A bare slug, since KAN-147 composes intake's shape from every type the
 * project has rather than from this pack's three words — so the answer may
 * name another pack's type, and a word two packs both ship is refused
 * rather than guessed at (ARCHITECTURE.md, "An item type is data"). Then the row's flag decides,
 * not the
 * word.
 *
 * A word EO cannot apply is not a container: the same answer the string
 * comparison gave for `story` and `bug`, and the one that lands the item
 * at the approval gate where a person can say what it should have been —
 * which is also what `postIntakeSummary` puts in the thread (invariant 8).
 */
function answeredContainer(db: Db, item: Item, slug: string): boolean {
  const type = resolveItemType(db, item.projectId, slug);
  return type.ok && type.type.container;
}

/**
 * Which of the step's declared results this run produced (KAN-53).
 *
 * The reviewer is the only role that ever returned a branch signal of its
 * own (`verdict`); the rest are derived here from the action and the
 * item. That is deliberate. These are decisions that turn on item
 * *data* rather than on anything the agent chose — whether the thing being
 * refined was a feature to decompose or work someone already wrote — and
 * the design prefers what the engine can establish itself over
 * what an agent asserts. Keeping them here also keeps `resolveRoute` pure
 * and ignorant of what any particular role means.
 */
function resultKeyFor(
  db: Db,
  contributed: Registry,
  action: string,
  parsedResult: unknown,
  item: Item,
  ownFunctions: ReadonlySet<string>,
): string | null {
  // An interpretation is not a stage (EO-184). It reads a reply for a
  // step that is parked and stays parked, so it declares no result and
  // moves nothing — invariant #1 is untouched, and `items.step_id` is
  // never written on its account.
  //
  // First, before the builtin branch below, because of where this run
  // happens: the item is sitting on the very builtin or module step
  // that parked, so a check ordered after that one would read an
  // interpretation's answer as that step's own result key and route on
  // it.
  if (action === INTERPRET_ACTION) return null;

  // One of this pack's own functions, reporting its own key. Nothing to
  // derive: EO ran the function itself, so what happened is not a claim
  // needing checking — it is the one thing here the engine knows
  // first-hand.
  //
  // This pack's builtins, not the installation's: `isBuiltinAction`
  // reads the folded registry, which after KAN-144 answers for every
  // pack, and a second pack's function is that pack's business to
  // interpret. Modules are gone from here for the same reason in the
  // other direction — a module is the core's own machinery rather than
  // anybody's pack, `claimedActions` therefore does not name one, and
  // the supervisor's default does exactly this to a module's reported
  // key. What used to be guarded against here — an agent run finishing
  // while the item sits on a module step, its output read as that
  // module's result — is guarded by the same fact: the run's action is
  // the agent's, not the module's, so it never reaches this branch.
  if (ownFunctions.has(action)) {
    const reported = (parsedResult as { result?: unknown } | null)?.result;
    return typeof reported === "string" ? reported : null;
  }

  if (action === "review") {
    const parsed = ReviewOutputSchema.safeParse(parsedResult);
    // A-02 validated this before the supervisor asked, so an unreadable
    // verdict means something is wrong upstream. Null lands on "no route",
    // which asks a human rather than guessing a direction.
    if (!parsed.success) return null;
    // The verdict *is* the result key, spelled the way a step declares it.
    // A reviewer that cannot decide says so and the route sends it to the
    // human, rather than the engine picking a direction on its behalf.
    if (parsed.data.verdict === "needs_user_input") return "needs_user_input";
    return parsed.data.verdict === "approve" ? "approved" : "changes_requested";
  }

  // A conversation is not a stage with something after it. It is a place
  // two parties talk, and it ends when a human closes it. What the
  // assistant's room (EO-188) talks about is usually somebody *else's*
  // item, or a graph, while the item it talks *on* is the chat — so a
  // turn moves no item anywhere. A module's scenario chat (EO-356) moves
  // no item for the same reason.
  if (action === ASSIST_ACTION || action === SCENARIO_ACTION) return null;

  // What this item's type says this action answers as (KAN-163).
  //
  // `refine` is the whole of it today, and it was a branch here: only a
  // container has an invented graph of work for a human to approve
  // (KAN-19), while work that arrived already written was clarified
  // rather than decomposed, and stopping someone to approve their own
  // words would be a gate on nothing. Both keys are the type's data now
  // — its own `refine` override, or the default the role shipping the
  // action declared for its kind — so a project whose container is an
  // Epic routes as a feature does, a hand-made leaf routes as a story
  // does, and a pack's leaf whose `refine` means some third thing
  // reports whatever key it says (ARCHITECTURE.md, "An item type is data").
  //
  // After the branches above and not before them: `review` reads a
  // verdict the agent returned, and a conversation moves nothing. This
  // answers for an action whose *type* has something to say about it,
  // which none of those does.
  const override = actionOverrideFor(contributed, action, getItemType(db, item.typeId) ?? UNKNOWN_ITEM_TYPE);
  if (override !== undefined) return override.resultKey;

  if (action === INTAKE_ACTION) {
    // Read from the result rather than from the item, and by the flag
    // rather than by the word — see `answeredContainer`.
    //
    // `IntakeAnswerSchema` rather than the whole composed shape (KAN-147):
    // the supervisor has already held this result to the shape composed
    // from the project's types, and all the route needs from it is which
    // type it classified into.
    const parsed = IntakeAnswerSchema.safeParse(parsedResult);
    if (parsed.success && !answeredContainer(db, item, parsed.data.type)) return "classified_non_feature";
    return "done";
  }

  // One of this pack's actions with nothing special to say about it —
  // `implement`, `respond`. It reached a step, the step declares what
  // comes next, and `done` is what such a step routes on.
  return "done";
}

/**
 * The actions this pack has an opinion about.
 *
 * Derived from what the pack contributes to the registry rather than
 * listed a second time here: the functions its `builtin` steps run, and
 * every action one of its roles declares a schema for. Adding a schema
 * to the pack therefore claims the action, and removing one releases
 * it, with no list to keep in step.
 *
 * **Anything else is somebody else's** (KAN-144). `resolveNextState`
 * answers `undefined` for it, which the fold reads as "no opinion" and
 * passes to the next installed pack, and which the supervisor reads as
 * "route on the reported result key, else `done`". Until this existed
 * the wiring's final `return "done"` answered for every action in
 * existence, so the developer pack placed first in the list would have
 * routed a second pack's action before that pack was ever asked — the
 * fold takes the first answer, and this one always had one.
 *
 * A module's id is deliberately not in here. A module is the core's own
 * machinery (KAN-105) rather than any pack's, and what the supervisor
 * does with an unclaimed action is exactly what this file used to do
 * with a module's: take the key it reported.
 */
function claimedActions(contributed: Registry): ReadonlySet<string> {
  const actions = new Set<string>(contributed.builtins.keys());
  for (const role of contributed.roles.values()) {
    for (const action of role.schemasByAction.keys()) actions.add(action);
  }
  return actions;
}

/**
 * Role-specific behaviour, in one place, for the supervisor to be handed
 * (R-01..R-03).
 *
 * The supervisor stays generic: it knows how to run an agent and record
 * what happened, not what any particular role means. Everything here is the
 * opposite — knowledge about `refine` and `review` specifically — so it
 * lives beside the roles rather than inside the engine.
 *
 * Which is why it is the developer pack's, since KAN-144: the review,
 * refine and intake result keys below and the comments each role posts
 * are what makes EO a developer tool, and a pack that contributed
 * prompts and schemas without them would have left the knowledge in the
 * core. `CodePack.wiring` is the shape; a pack that has no opinion
 * about an action returns `undefined` from `resolveNextState` and the
 * supervisor routes on the reported result key instead.
 */
export function createRoleWiring(db: Db, contributed: Registry = developerRegistry()): RoleWiring {
  const claimed = claimedActions(contributed);
  const ownFunctions = new Set(contributed.builtins.keys());
  // As a map, so a poster somebody named `constructor` is a poster and
  // not a surprise — the reason the registry is maps throughout.
  const posters = new Map(Object.entries(createPosters(db)));
  return {
    /**
     * Where a finished run sends its item.
     *
     * Two halves, and only the first is this pack's: which result key
     * the run produced (`resultKeyFor`), and where that key routes
     * (`routeResult`, in the supervisor since KAN-144). The second is a
     * lookup in `step_routes` and knows nothing about any role — it is
     * what the supervisor falls back to when no pack claims an action.
     *
     * `undefined` for an action this pack does not own, so that the
     * fold can ask the next one — see `claimedActions`.
     *
     * `role` is the dispatched agent's, or null where EO ran the step
     * itself. It is what says whether the action's name means what this
     * pack means by it.
     */
    resolveNextState(currentStep: PipelineStep, steps: PipelineStep[], parsedResult: unknown, action: string, item: Item, role: string | null = null): NextStep | undefined {
      if (!claimed.has(action)) return undefined;
      // An action the dispatched role defined for itself is not this
      // pack's to interpret, whatever it is called (EO-422): no verdict
      // is read off a `qa` role's `review`. No opinion, like any action
      // this pack does not own, and the supervisor routes on the
      // `result` the run answered with.
      if (!packMeaningInForce(db, item, role, action)) return undefined;
      return routeResult(db, currentStep, steps, resultKeyFor(db, contributed, action, parsedResult, item, ownFunctions), item);
    },

    onRunSucceeded(item: Item, agent: Agent, action: string, parsedResult: unknown, runId: Uuid): void {
      // Everything below is what this pack leaves in the thread for an
      // action *it* means something by. A role that defined the action
      // for itself gets none of it (EO-422) — no review feedback, no
      // implement handoff, no intake summary, no plan — because its
      // answer is in the role's own shape and its `summary`, which the
      // supervisor has already posted, is the handoff.
      if (!packMeaningInForce(db, item, agent.role, action)) return;

      // The record of a run whose type said what it means (KAN-163).
      //
      // This was the same `refine` branch `resultKeyFor` had, one field
      // along: a container got a plan to approve and a leaf a note
      // saying its work can be implemented as written. The type names
      // the poster now, and the pack's table says what that name posts —
      // so an Epic gets the plan, a hand-made leaf gets the note, and
      // neither this file nor the engine compares a type against
      // anything.
      //
      // An override naming a poster this pack does not have is another
      // pack's, and staying silent is right: every wiring is asked, so
      // whoever registered the name will post it. The fold has already
      // refused a name no pack at all registers, which is the case where
      // silence would mean nothing in the thread.
      const override = actionOverrideFor(contributed, action, getItemType(db, item.typeId) ?? UNKNOWN_ITEM_TYPE);
      if (override !== undefined) {
        posters.get(override.poster)?.(item, agent.id, runId, parsedResult);
        return;
      }
      // The implementer was the only role that left nothing in the thread
      // (KAN-31). Posted before the transition, so it is in front of the
      // reviewer that the transition dispatches.
      if (action === "implement") {
        postImplementHandoff(db, item, agent.id, runId, parsedResult);
        return;
      }

      // Intake's understanding and whatever the human settled, pinned
      // (KAN-32) — the last thing an agent was still being asked to write
      // with the comment tool, and the one it could not do.
      if (action === INTAKE_ACTION) {
        postIntakeSummary(db, item, agent.id, runId, parsedResult);
        return;
      }

      // What the system agent said in the assistant's chat, and whatever
      // it proposed doing. Unlike most branches here, nothing is applied:
      // a draft is posted for a person to publish and a proposal for a
      // person to approve.
      if (action === ASSIST_ACTION) {
        const posted = postAssistReply(db, item, agent.id, runId, parsedResult);
        // A card's modules are saved as it is posted (EO-381), and the
        // person is then asked to approve them. Somebody already on
        // Settings → Modules is looking at a cached catalog that only
        // this push refreshes, so without it the module they were just
        // asked to approve is not in the list in front of them.
        if (posted.modulesSaved) emitPush("config:changed", {});
        // A draft returned while a design is under test (EO-587): EO
        // classifies it, and either leaves it a new design card or applies
        // it to the trial and starts the next round.
        continueTrialLoop(db, item, posted.draftCardIds ?? []);
        return;
      }

      // What the system agent said in a module's scenario chat (EO-356),
      // with EO's own record of the case it reports on and, when that
      // case failed, the evidence. A change to the module is posted as a
      // card and applied by nobody here: the person presses Apply.
      if (action === SCENARIO_ACTION) {
        postScenarioReply(db, item, agent.id, runId, parsedResult);
        return;
      }

      // What the system agent made of a free-text reply to a parked
      // builtin or module step (EO-184): the answer the step can use, a
      // note about what it did instead, or an escalation saying the
      // reply could not be read. Nothing here moves the item; whether
      // the step runs again is decided from the same result once this
      // run has ended.
      if (action === INTERPRET_ACTION) {
        postInterpretation(db, item, agent.id, runId, parsedResult);
        return;
      }

      // The answer to whoever `@`-mentioned this agent. The only role
      // half that is also a *stop* condition: an unposted answer leaves
      // the mention open, and an open mention is dispatched again.
      if (action === RESPOND_ACTION) {
        postMentionReply(db, item, agent.id, runId, parsedResult);
        return;
      }

      if (action !== "review") return;
      const review = ReviewOutputSchema.safeParse(parsedResult);
      if (!review.success) return; // resolveNextState already declines to move it
      postReviewFeedback(db, item, agent.id, runId, review.data);
    },
  };
}
