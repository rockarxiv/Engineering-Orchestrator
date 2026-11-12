import type { z } from "zod";
import { JIRA_EXTENSION } from "../itemExtensions.js";
import { AssistOutputSchema } from "../schemas/assist.js";
import { ScenarioOutputSchema } from "../schemas/scenario.js";
import { CLARIFY_ACTION, ClarifyOutputSchema } from "../schemas/clarify.js";
import { ImplementOutputSchema } from "../schemas/implement.js";
import { INTAKE_ACTION, intakeOutputSchemaFor } from "../schemas/intake.js";
import { InterpretOutputSchema } from "../schemas/interpret.js";
import { REFINE_ACTION, RefineOutputSchema } from "../schemas/refine.js";
import { RespondOutputSchema } from "../schemas/respond.js";
import { zodOutputSchema, type OutputSchema } from "../schemas/outputSchema.js";
import { ReviewOutputSchema } from "../schemas/review.js";
import {
  buildRegistry,
  FAILED_RESULT,
  PER_CONVERSATION,
  NEEDS_USER_INPUT_RESULT,
  type ActionDefaults,
  type ActionFacts,
  type ActionOverride,
  type BuiltinInput,
  type ItemTypeEntry,
  type ItemTypeRef,
  type PackVocabulary,
  type Registry,
  type RoleEntry,
  type ThreadReuse,
} from "./index.js";

/**
 * What makes EO a developer tool today, as registry data (KAN-124).
 *
 * The four constants below are the ones the design names: they were
 * closed sets in `domain.ts` and `schemas/index.ts`, typed the runners,
 * the prompt file map and the editor's built-in marking, and made adding
 * a role, a builtin or a type a change to `packages/core`. They keep
 * their names, their values and their exports, because the desktop app
 * still types its runners and its prompt files on them — and because
 * they are exactly what the developer pack will contribute when it
 * exists (KAN-144). That story moves this file; nothing in this package
 * reads any of them except `developerRegistry` below, and a test holds
 * it to that.
 */

/**
 * The roles EO ships, and the only ones it has an opinion about.
 *
 * `system` is one agent behind every conversation (EO-181): the product
 * owner and the pipeline architect were both "one conversation with one
 * person and a gate at the end of it" — and neither owned a pipeline
 * step, so neither was ever dispatched by a column. Two rows, two prompts
 * and two sets of tools bought nothing but the chance for them to drift.
 * Their rooms are gone (EO-526); the assistant's chat is where both kinds
 * of work are asked for now.
 *
 * `role` stays a plain string everywhere else (ARCHITECTURE.md, "An agent is a row": "roles are
 * configuration, not code") — a pipeline step can name a role nobody
 * has created yet and that must keep working. This is not a closed
 * union of what a role may be; it is the list of the ones EO ships.
 */
export const BUILTIN_ROLES = ["system", "implementer", "reviewer"] as const;

export type BuiltinRole = (typeof BUILTIN_ROLES)[number];

/**
 * Thread reuse for the roles EO ships (EO-178, EO-210).
 *
 * Migration 0048 turned reuse on for the implementer and said in as many
 * words that it "says nothing about any other role". Leaving it a
 * checkbox on every agent meant that argument had to be re-had by
 * whoever opened the editor, so it is settled here instead — once, for
 * the roles whose runs EO knows the shape of.
 *
 * The implementer is on for 0048's reason: dispatched a second time on an
 * item, after a review bounce or a clarification, it is doing the same
 * work in the same worktree, and a fresh conversation re-reads the
 * codebase to get back where the last one already was.
 *
 * The reviewer is off, and it is why this is a decision rather than a
 * default. A reviewer resuming its own thread is re-reading a diff it
 * has already formed an opinion about, which is the one thing a review
 * must not do.
 *
 * The system agent is neither. It was `false` here from EO-178, decided
 * for the two roles EO-181 merged into it and on the grounds that "each
 * dispatch is a separate question" — written before the assist room
 * existed and never revisited after it did. In the assistant's chat each
 * dispatch is plainly
 * *not* a separate question: it is the next message of one chat, and a
 * fresh thread every turn meant EO re-assembled the whole history into
 * the prompt to fake the continuity, so a conversation's token cost grew
 * with the square of its length. Everywhere else — `interpret`,
 * `respond` — EO-178's sentence still holds, so the answer depends on
 * the action rather than on the role (`THREAD_PER_CONVERSATION_ACTIONS`).
 */
const THREAD_REUSE_BY_ROLE: Record<BuiltinRole, ThreadReuse> = {
  system: PER_CONVERSATION,
  implementer: true,
  reviewer: false,
};

/**
 * Filename per role, in the desktop app's prompt directory. A role with
 * no file has no default prompt; each of these has one.
 */
const PROMPT_FILE_BY_ROLE: Record<BuiltinRole, string> = {
  system: "system-agent.md",
  implementer: "implementer.md",
  reviewer: "reviewer.md",
};

/**
 * The functions a `builtin` step can run.
 *
 * A closed set, unlike roles: a role is configuration (ARCHITECTURE.md, "An agent is a row")
 * because a person can write one as a prompt, while each of these is code
 * EO ships. Adding one is a feature; naming one that does not exist is a
 * configuration error the validator catches.
 *
 * Each was a side effect before it was a step. The worktree was made
 * during dispatch, so an item whose branch was being cut looked identical
 * to one where nothing was happening; the pull request hung off a boolean
 * on a terminal state. As steps they have a card, an elapsed time, a
 * transcript, and somewhere to route when they fail.
 *
 * `index_repository` is the third and was never anything else (EO-149).
 * It describes the checkout so an agent can query it rather than grep it,
 * and it is a step for the reason the other two are: scaffolding nobody
 * can see is scaffolding nobody can cancel, time, or diagnose. It is also
 * the one a person is most likely to want *gone* — the whole feature is
 * optional — and removing a step is a row, which is what invariant #7 is
 * for.
 */
export const BUILTIN_ACTIONS = ["create_worktree", "index_repository", "open_pull_request", "watch_pull_request"] as const;
export type BuiltinAction = (typeof BUILTIN_ACTIONS)[number];

/**
 * Watches the item's open pull request until something happens to it
 * (EO-460). The fourth, and the first made to be checked rather than run
 * once: a step in keep-checking mode asks it on an interval, and it says
 * `waiting` until the pull request is merged, closed, conflicted, failing,
 * sent back — or, when the step asks for it, ready.
 */
export const WATCH_PULL_REQUEST_ACTION = "watch_pull_request";

/**
 * The step input that asks `watch_pull_request` to say `ready` — approved,
 * every check green — rather than go on waiting for the merge. Off unless
 * the step sets it, because most pipelines want to hear only that a person
 * merged it.
 */
export const WATCH_PULL_REQUEST_REPORT_READY_INPUT = "reportReady";

/**
 * The step input that says what `ready` means to `watch_pull_request`
 * (EO-515), and the values it takes.
 *
 * `approved` — the default, and what `ready` always meant — is an approval
 * on the forge with every check green. `mergeable` is the forge's own
 * verdict that the pull request can be merged, with every check green: for
 * a repository where nobody approves on the forge, such as one whose pull
 * requests are opened and merged by one account that the forge will not let
 * approve its own. The forge's verdict already holds whatever the
 * repository's branch protection asks — a required review, required checks
 * — so it skips no rule the repository set.
 */
export const WATCH_PULL_REQUEST_READY_WHEN_INPUT = "readyWhen";
export const WATCH_PULL_REQUEST_READY_WHEN = ["approved", "mergeable"] as const;
export type WatchPullRequestReadyWhen = (typeof WATCH_PULL_REQUEST_READY_WHEN)[number];

/**
 * What each built-in function can return (EO-77).
 *
 * Data, for the reason a module's `manifest.results` is data: three places
 * need to know, and only one of them can run the function. The runner
 * produces an outcome, the configuration editor offers a row per outcome,
 * and `validatePipeline` checks a route key against them. Until this
 * existed only the first knew — the outcomes were string literals inside
 * `builtins.ts` — so a builtin step's routing was checked by nothing at
 * all, while a module step's had been checked since KAN-104. Delivery
 * routes `opened` and `skipped` correctly; a typo in either would have
 * been found by an item stopping dead.
 *
 * The order is the order the editor draws: the outcome, then its
 * exceptions, then `failed` — which is what they are.
 *
 * `failed` is every way the function did not do its work: a branch that
 * already exists, a repository nobody assigned, a forge that refused the
 * credentials. It is declared for the same reason the others are — until
 * it was, a failure had no name, so a pipeline could not send it
 * anywhere and every one of them ended the same way, parked with a
 * question. That is still the default when nothing routes it (ARCHITECTURE.md, "Results and
 * routes"), but
 * it is now a default rather than the only possibility: a route from
 * `failed` to a triage step is a row, not a change to this file.
 *
 * `BuiltinResult` is the half that keeps this honest at the other end —
 * `builtins.ts` types each runner by it, so an outcome that is not
 * declared here cannot be returned without failing `pnpm typecheck`.
 */
export const BUILTIN_RESULTS = {
  create_worktree: ["ready", FAILED_RESULT],
  // `skipped` is repository intelligence being switched off, or an item
  // with no repository to describe — nothing went wrong and nothing was
  // built. `failed` is everything that went wrong, and for this one step
  // that includes every kind of degradation: an unsupported platform, a
  // binary that would not download, an index that fell over. They are
  // one result rather than several because the item does the same
  // thing after all of them — carry on with the filesystem and git tools
  // the agent has always had — and the shipped pipeline routes it
  // onward for exactly that reason (EO-149).
  index_repository: ["indexed", "skipped", FAILED_RESULT],
  // `uncommitted_changes` and `remote_diverged` are the two things the
  // step finds and will not resolve itself (EO-429): files left in the
  // worktree that nobody committed, and a remote branch holding commits
  // the local one does not, which EO never force-pushes over. Results
  // rather than failures because both are the implementer's to fix, and
  // a pipeline can only send them there if they have a key of their own.
  open_pull_request: ["opened", "skipped", "uncommitted_changes", "remote_diverged", FAILED_RESULT],
  // In the order a check answers them (EO-460): the first that is true of
  // the pull request wins, so a merged one is `merged` whatever its checks
  // say, and `ready` — approved, every check green, and only when the step
  // asks — is what is left once nothing is wrong. `failed` is an item with
  // no pull request to watch. `waiting` is not here: it is the reserved
  // outcome of every check, and never a route.
  //
  // Comments are split by who wrote them (EO-759). `author_commented` is a
  // comment, review or request for changes by the account the forge CLI is
  // signed in as — the person EO works for — to be acted on. A formal
  // request for changes by anybody else is `changes_requested`, and any
  // other account's comment is `others_commented`: neither is an
  // instruction until a plan for it is approved.
  watch_pull_request: ["merged", "closed", "conflict", "checks_failed", "author_commented", "changes_requested", "others_commented", "ready", FAILED_RESULT],
} as const satisfies Record<BuiltinAction, readonly [string, ...string[]]>;

/**
 * Which of them reaches outside EO (EO-334, ARCHITECTURE.md, "A connector is an MCP server with a
 * setup flow", "Results and routes").
 *
 * The pack's own word about its functions, and the half of
 * `BuiltinEntry.sideEffects` this pack fills in. One reader: the
 * validator's refusal to publish a pipeline a webhook enters and a side
 * effect ends with nobody asked in between. A payload from the internet
 * is not something EO can filter, so what a pipeline carrying one is
 * held to is where it can get to.
 *
 * Opening a pull request is the one that sends something somebody else
 * sees, and it is irreversible in the sense that matters: a review
 * request on somebody's repository cannot be taken back by deleting a
 * row here. Cutting a worktree and building an index both write to
 * disks of EO's own, which nobody outside this machine can see, so
 * neither is one.
 *
 * Exhaustive by type rather than by set, for `BUILTIN_RESULTS`' reason:
 * a fourth function has to answer this before it compiles, and
 * "nobody said" is not an answer a `send` step should get by default.
 */
export const BUILTIN_SIDE_EFFECTS = {
  create_worktree: false,
  index_repository: false,
  open_pull_request: true,
  // Reads a pull request and writes nothing to the forge: the comments it
  // posts are on the item, which is EO's own.
  watch_pull_request: false,
} as const satisfies Record<BuiltinAction, boolean>;

/**
 * What the editor calls each of them (EO-507) — the half of
 * `BuiltinEntry.label` this pack fills in.
 *
 * Exhaustive by type for `BUILTIN_SIDE_EFFECTS`' reason: a fifth function
 * the picker offered as a blank would be one nobody could find.
 */
export const BUILTIN_LABELS = {
  create_worktree: "Create the worktree and branch",
  // The person's words, not the provider's (EO-141). What this step
  // does is describe the code; which tool describes it is a setting.
  index_repository: "Index the code for the agents",
  open_pull_request: "Open the pull request",
  watch_pull_request: "Watch the pull request",
} as const satisfies Record<BuiltinAction, string>;

/**
 * What a step running each of them can set (EO-507) — the half of
 * `BuiltinEntry.inputs` this pack fills in. Only the pull request watch
 * takes any.
 */
export const BUILTIN_INPUTS: Partial<Record<BuiltinAction, Readonly<Record<string, BuiltinInput>>>> = {
  watch_pull_request: {
    [WATCH_PULL_REQUEST_REPORT_READY_INPUT]: {
      type: "boolean",
      description: "Also report ready once the pull request is approved and every check is green, rather than go on waiting for somebody to merge it.",
      default: false,
    },
    [WATCH_PULL_REQUEST_READY_WHEN_INPUT]: {
      type: "string",
      description:
        'What counts as ready, when ready is reported: "approved" (the default) waits for an approval on the forge; "mergeable" takes the forge\'s own word that the pull request can be merged — every rule the repository sets still applies — and counts a branch that is only behind its base as ready.',
      default: "approved",
    },
  },
};

/**
 * Which of them a step may run in keep-checking mode (EO-456, EO-460) —
 * the pack's half of `BuiltinEntry.watch`.
 *
 * Exhaustive by type for `BUILTIN_SIDE_EFFECTS`' reason. Only the pull
 * request watch is a check; the other three do their work once, and a
 * worktree cut every five minutes would be a mistake the validator should
 * refuse.
 */
export const BUILTIN_WATCH = {
  create_worktree: false,
  index_repository: false,
  open_pull_request: false,
  watch_pull_request: true,
} as const satisfies Record<BuiltinAction, boolean>;

/** The outcomes one built-in function can return; every one of them by default. */
export type BuiltinResult<A extends BuiltinAction = BuiltinAction> = (typeof BUILTIN_RESULTS)[A][number];

/**
 * Which schema an action's result must satisfy, keyed by a step's
 * `entry_action`.
 *
 * Deliberately a lookup rather than a closed union: steps are data
 * (invariant #7), so a pipeline can define an action this map has never
 * heard of. An unknown action simply has no schema — see
 * `outputSchemaFor`.
 */
export const SCHEMAS_BY_ACTION: Record<string, z.ZodType> = {
  [REFINE_ACTION]: RefineOutputSchema,
  // The other half of what `refine` can mean (KAN-19, KAN-129). No step
  // declares `clarify` as an entry action and none will: it is reached
  // by dispatching `refine` against a leaf, and `resultSchemaFor` has
  // always answered that case with this shape through a branch of its
  // own. Registered here so the shape has a *name* — the leaf types'
  // `refine` override says `schema: "clarify"`, and an override naming
  // something the registry cannot resolve would be data that only looks
  // like data (`buildRegistry` refuses one that does). Since KAN-163 the
  // override is the only way to this shape: the branch that reached it by
  // asking whether an item was a container is gone.
  [CLARIFY_ACTION]: ClarifyOutputSchema,
  implement: ImplementOutputSchema,
  review: ReviewOutputSchema,
  // The conversational action (EO-188): what the assistant's room runs.
  // Not a step any pipeline dispatches — the `assist` step is
  // human-owned, so `tick()` never dispatches it and the mention path is
  // the only way in — and registered here for the reason every other
  // entry is: an action with no schema gets no constrained generation
  // (KAN-32). Its answer can carry a graph *and* items, so a turn that
  // came back as prose would be two gated artefacts nobody could act on
  // rather than one.
  assist: AssistOutputSchema,
  // The other conversational action (EO-356): a turn of a module page's
  // "+ Add scenario" chat. Off any pipeline like the one above, and
  // registered for the reason it is — the reply names the test case
  // it reports on and may carry a proposed fix, and a fix written as
  // prose is a fix nobody can apply.
  scenario: ScenarioOutputSchema,
  // The other action no pipeline declares: what an agent runs when a
  // comment mentions it. See respond.ts — without a schema its answer
  // came back in whatever shape its role's prompt implied, so nothing
  // could post it, and an unanswered mention re-dispatches until the
  // attempt limit stops it.
  respond: RespondOutputSchema,
  // The third action no pipeline declares (EO-184): what the system
  // agent runs when somebody answers a parked builtin or module step in
  // their own words instead of clicking one of the answers it offered.
  // A schema matters here for the reason it does everywhere — without
  // one the reading comes back as prose — and for one more: the three
  // branches are three different things to *do*, and prose cannot say
  // which of them happened.
  interpret: InterpretOutputSchema,
};

/**
 * Which shipped role declares each action's schema.
 *
 * The registry keeps schemas on the role that ships them
 * (`RoleEntry.schemasByAction`), and `SCHEMAS_BY_ACTION` never said
 * whose each was — it did not need to, being looked up by action, which
 * it still is. So the assignment is made here, once: the implementer
 * answers `implement`, the reviewer `review`, and the system agent
 * everything else, which is what dispatches those actions today. A role
 * somebody invents and puts on an `implement` step is still held to the
 * implementer's shape, exactly as before — see `resultSchemaFor`.
 */
const SCHEMA_OWNER: Record<string, BuiltinRole> = {
  implement: "implementer",
  review: "reviewer",
};

/** This pack's name, and the namespace its item types are in (ARCHITECTURE.md, "An item type is data"). */
export const DEVELOPER_PACK = "developer";

/**
 * One of this pack's item types, named so that another pack's cannot be
 * mistaken for it (KAN-129).
 *
 * Every caller inside the developer pack that creates a `story`, a
 * `feature` or a `bug` knows exactly which type it means: the one this
 * pack ships. A bare word would leave that to a lookup, and the lookup
 * has to refuse the word the day a support pack ships a `story` of its
 * own — refusing a decomposition, a Jira import or a conversation for a
 * reason that has nothing to do with any of them.
 *
 * So a caller that knows says so, and a bare slug is left to the
 * boundaries that genuinely do not: `items:update` taking a word a
 * person chose from a list, and whatever the type editor offers in
 * the design.
 */
export function developerType(slug: string): ItemTypeRef {
  return { packSlug: DEVELOPER_PACK, slug };
}

/**
 * The two comment posters an override may name, by the name it names
 * them by (KAN-163).
 *
 * A name rather than a function because the registry is plain data and
 * posting a comment is a write: the pack keeps the table from name to
 * poster, the way `builtins` keeps one from action to runner, and the
 * fold refuses an override naming one no installed pack registers.
 * Spelled once, here, so the override, the table and the refusal cannot
 * drift.
 */
export const REFINE_PROPOSAL_POSTER = "refine_proposal";
export const CLARIFICATION_NOTE_POSTER = "clarification_note";

/**
 * What `refine` means on a container, as data (ARCHITECTURE.md, "An item type is data").
 *
 * The five branches said one thing: a container is broken into the work
 * under it, the result routes as `decomposed`, and the thread gets a plan
 * a person can approve. Which item that applies to is the container flag
 * since KAN-146; what each answer is called is read from here since
 * KAN-163, by the schema lookup, the graph check, the route key and the
 * poster alike.
 */
const DECOMPOSES: ActionOverride = { schema: REFINE_ACTION, resultKey: "decomposed", poster: REFINE_PROPOSAL_POSTER };

/**
 * And on a leaf: work that arrived already written is *checked* rather
 * than broken up, answers in the clarify shape, routes as `clarified`
 * and leaves a note rather than a plan — stopping someone to approve
 * their own words would be a gate on nothing (KAN-19).
 *
 * The leaf answer is the default a hand-made type inherits (ARCHITECTURE.md, "An item type is
 * data"), and
 * it is written on the rows anyway: a default nobody can see on the row
 * it applies to is the kind of thing the type editor would have to
 * re-derive.
 */
const CLARIFIES: ActionOverride = { schema: CLARIFY_ACTION, resultKey: "clarified", poster: CLARIFICATION_NOTE_POSTER };

/**
 * And what `refine` means on a type that overrides nothing (KAN-163).
 *
 * The *pack defaults* of the design. The three types this pack
 * ships carry the same two answers on their own rows, which is the
 * ordinary case and what the type editor will show; this is what a type
 * somebody creates in the configure screen inherits, since the design offers
 * labels, a container flag and a spec shape and says nothing about
 * actions. A hand-made leaf is checked rather than decomposed, which is
 * the conservative answer and the one the deleted branch gave.
 */
const REFINE_DEFAULTS: ActionDefaults = { container: DECOMPOSES, leaf: CLARIFIES };

/** By action, handed to whichever role declares each — see `RoleEntry.actionDefaults`. */
const ACTION_DEFAULTS: Record<string, ActionDefaults> = { [REFINE_ACTION]: REFINE_DEFAULTS };

/**
 * The actions this pack's steps dispatch, and what each can return, as
 * data (EO-423).
 *
 * The keys were literals in the pack's wiring — what a review's verdict
 * is spelled as, what an intake that found no container reports — so
 * nothing could check a step's routes against them, and a reviewer step
 * with no way out for `changes_requested` was found by an item stopping.
 * Declared, `validatePipeline` holds every step using one of these to
 * routing each key, exactly as it holds a step to an action a role
 * defined for itself.
 *
 * Only the four a pipeline step dispatches. The rest of
 * `SCHEMAS_BY_ACTION` is run by EO for itself and routes nothing
 * (`UNDISPATCHED_ACTIONS`).
 *
 * `refine` lists both of its answers, because which one a run gives is
 * the item's type's business and a step cannot know what will arrive on
 * it. The keys are read off the two overrides so the declaration and the
 * route key a run reports cannot drift.
 */
export const DEVELOPER_ACTIONS: Record<string, Omit<ActionFacts, "packShipped">> = {
  implement: {
    description: "Does the work the item describes and reports what was done.",
    results: [{ key: "done", label: "Done" }],
  },
  review: {
    description: "Reviews the work against the item and gives a verdict.",
    results: [
      { key: "approved", label: "Approved" },
      { key: "changes_requested", label: "Changes requested" },
      { key: NEEDS_USER_INPUT_RESULT, label: "Needs user input" },
    ],
  },
  [REFINE_ACTION]: {
    description: "Breaks a container into the work under it, or checks that work which arrived already written is clear.",
    results: [
      { key: DECOMPOSES.resultKey, label: "Decomposed" },
      { key: CLARIFIES.resultKey, label: "Clarified" },
    ],
  },
  [INTAKE_ACTION]: {
    description: "Classifies what arrived into one of the project's item types and fills in its fields.",
    results: [
      { key: "done", label: "Done" },
      { key: "classified_non_feature", label: "Classified non-feature" },
    ],
  },
};

/**
 * The three developer item types, as data (ARCHITECTURE.md, "An item type is data").
 *
 * The container flag is read since KAN-146, the spec shape since KAN-147
 * and the overrides since KAN-163. What is written here is what the code
 * used to branch on, which is what let each branch be replaced by a read
 * of it. A feature is the one container. A story must arrive with acceptance
 * criteria — nothing downstream can check the implementer's claim
 * without them — and a bug with its four repro fields; each may also
 * carry criteria (EO-205).
 *
 * Keyed by `packSlug:slug`, which is what the registry is keyed by and
 * what `item_types` is unique on: two packs may both ship a `case`, and
 * the word alone cannot say whose.
 */
const DEVELOPER_ITEM_TYPES: Record<string, ItemTypeEntry> = {
  "developer:feature": {
    packSlug: DEVELOPER_PACK,
    slug: "feature",
    label: "Feature",
    plural: "Features",
    container: true,
    // A container is decomposed rather than implemented, so it has no
    // definition of done of its own and no fields to arrive with. One
    // imported from Jira may still *hold* criteria (EO-205), which the
    // spec keeps and the rail shows: a shape says what a type demands and
    // what an editor offers, not what its `spec` is allowed to contain.
    specShape: { type: "object", properties: {}, required: [] },
    actionOverrides: { refine: DECOMPOSES },
  },
  "developer:story": {
    packSlug: DEVELOPER_PACK,
    slug: "story",
    label: "Story",
    plural: "Stories",
    container: false,
    specShape: {
      type: "object",
      properties: {
        acceptance_criteria: {
          minItems: 1,
          type: "array",
          items: { type: "string", minLength: 1 },
          // The phrase a refusal names it by, and the reason. Both were
          // written into `submitItem` by hand until KAN-147; they are the
          // type's words now, which is why the sentence a person reads
          // when a story arrives without criteria is unchanged.
          title: "at least one acceptance criterion",
          description: "it is what EO checks the implementer's claim against",
          "x-eo-criteria": true,
        },
      },
      required: ["acceptance_criteria"],
    },
    actionOverrides: { refine: CLARIFIES },
  },
  "developer:bug": {
    packSlug: DEVELOPER_PACK,
    slug: "bug",
    label: "Bug",
    plural: "Bugs",
    container: false,
    specShape: {
      type: "object",
      properties: {
        steps_to_reproduce: { type: "string", minLength: 1 },
        // The one field EO may *offer* as a criterion without adopting it
        // (EO-200, EO-213): a bug's `expected` reads exactly like a
        // definition of done, and `missingCriteriaRefusal` quotes it for a
        // person to accept in one line. Data, so that a type whose
        // outcome field is called something else is quoted too.
        expected: { type: "string", minLength: 1, "x-eo-criteria-offer": true },
        actual: { type: "string", minLength: 1 },
        environment: { type: "string", minLength: 1 },
        // Accepted, not demanded (EO-205): the four fields above are the
        // bar a bug report clears, and a bug with no criterion anybody
        // thought of is still a bug worth having. What this stops is the
        // other half — a conversation that *did* settle what "fixed"
        // means having nowhere to put it.
        acceptance_criteria: { default: [], type: "array", items: { type: "string", minLength: 1 }, "x-eo-criteria": true },
      },
      required: ["steps_to_reproduce", "expected", "actual", "environment"],
    },
    actionOverrides: { refine: CLARIFIES },
  },
};

/**
 * The actions whose shape is composed from data rather than written out
 * (KAN-147).
 *
 * `intake` classifies an item into one of the project's types and answers
 * with that type's fields, so its schema is a function of the item types
 * rather than a constant — which is what removed the three-branch union
 * `SCHEMAS_BY_ACTION` used to hold.
 *
 * Composed here from the three types this pack *ships*, which is what the
 * pack's registry entry has always meant; `resultSchemaFor` recomposes it
 * from the types a project *has*, which is what lets a type somebody
 * added in the configure screen (ARCHITECTURE.md, "An item type is data") be classified into. Both
 * go
 * through `intakeOutputSchemaFor`, so the two cannot disagree about what
 * an intake answer looks like — only about which types are on offer.
 */
function composedSchemas(): ReadonlyMap<string, OutputSchema> {
  return new Map([[INTAKE_ACTION, intakeOutputSchemaFor(Object.values(DEVELOPER_ITEM_TYPES))]]);
}

/**
 * The registry holding exactly today's constants.
 *
 * What the desktop composition root uses until KAN-144 folds packs, and
 * what every test that wants "the registry as EO ships it" asks for.
 * Built fresh on each call so a test that mutates one cannot leak into
 * the next; a `Map` is cheap and there are three roles.
 */
/**
 * The developer pack's own words (EO-309, ARCHITECTURE.md, "What a pack labels").
 *
 * "Ticket" because that is what this pack has always called its work,
 * and the design's promise is that a developer notices nothing when phase 6
 * ships. The three type labels — Feature, Story, Bug — are on the type
 * entries below; this is the fourth word, the one the cross-pipeline
 * chrome uses when a developer installation is all there is.
 *
 * The two results are the engine's own rather than any runner's, which
 * is why they are named here and not in `BUILTIN_RESULTS`. The
 * spellings are the ones already on the shipped pipeline's routes
 * (migration 0028) and in the thread an escalation lands in, so a
 * developer reads the same two words after this as before it.
 */
export const DEVELOPER_VOCABULARY: PackVocabulary = {
  item: "Ticket",
  items: "Tickets",
  results: { needs_user_input: "Needs user input", escalation: "Escalation" },
};

export function developerRegistry(): Registry {
  // Wrapped here rather than in `SCHEMAS_BY_ACTION` itself (KAN-125):
  // the constant stays the zod map the desktop's runners are still typed
  // on, and the registry — the thing every lookup reads — holds the
  // `OutputSchema` form. One wrap per registry, not one per lookup.
  const ownedBy = (role: BuiltinRole) => (action: string) => (SCHEMA_OWNER[action] ?? "system") === role;
  const schemasOwnedBy = (role: BuiltinRole): ReadonlyMap<string, OutputSchema> =>
    new Map<string, OutputSchema>([
      ...Object.entries(SCHEMAS_BY_ACTION)
        .filter(([action]) => ownedBy(role)(action))
        .map(([action, schema]): [string, OutputSchema] => [action, zodOutputSchema(schema)]),
      // Already an `OutputSchema`: composed rather than written, so there
      // is no zod to wrap (KAN-147).
      ...[...composedSchemas()].filter(([action]) => ownedBy(role)(action)),
    ]);

  // The defaults go to whoever owns the action, exactly as the schemas
  // do: `refine` is the system agent's, so the system agent is who says
  // what it means on a type that did not.
  const defaultsOwnedBy = (role: BuiltinRole): ReadonlyMap<string, ActionDefaults> =>
    new Map(Object.entries(ACTION_DEFAULTS).filter(([action]) => ownedBy(role)(action)));

  // And the actions, to whoever owns each — the same assignment again,
  // so an action is declared by the role whose schema holds its answer.
  const actionsOwnedBy = (role: BuiltinRole): ReadonlyMap<string, ActionFacts> =>
    new Map(
      Object.entries(DEVELOPER_ACTIONS)
        .filter(([action]) => ownedBy(role)(action))
        .map(([action, facts]): [string, ActionFacts] => [action, { ...facts, packShipped: true }]),
    );

  const roles = new Map<string, RoleEntry>(
    BUILTIN_ROLES.map((role) => [
      role,
      {
        prompt: PROMPT_FILE_BY_ROLE[role],
        threadReuse: THREAD_REUSE_BY_ROLE[role],
        schemasByAction: schemasOwnedBy(role),
        actionDefaults: defaultsOwnedBy(role),
        actions: actionsOwnedBy(role),
      },
    ]),
  );

  return buildRegistry({
    roles,
    builtins: new Map(
      BUILTIN_ACTIONS.map((action) => [
        action,
        {
          label: BUILTIN_LABELS[action],
          results: BUILTIN_RESULTS[action],
          ...(BUILTIN_INPUTS[action] === undefined ? {} : { inputs: BUILTIN_INPUTS[action] }),
          sideEffects: BUILTIN_SIDE_EFFECTS[action],
          ...(BUILTIN_WATCH[action] ? { watch: true } : {}),
          // Through `gh` or `glab`, which the needs check asks for (EO-663).
          ...(action === "open_pull_request" ? { opensPullRequest: true } : {}),
        },
      ]),
    ),
    itemTypes: new Map(Object.entries(DEVELOPER_ITEM_TYPES)),
    packs: new Map([[DEVELOPER_PACK, DEVELOPER_VOCABULARY]]),
    // A Jira key is the developer pack's fact about an item, so asking
    // for one is the pack's to offer (EO-610, invariant 13).
    entryRuleKinds: new Map([["jira_key", { noun: "a Jira key", extension: JIRA_EXTENSION, property: "key" }]]),
  });
}
