import { z } from "zod";
import type { JsonSchema } from "../agent-provider.js";
import { jsonSchemaOutputSchema, type OutputSchema } from "./outputSchema.js";
import { specFromAnswer } from "./intake.js";
import { narrowEnvelopeField, withoutEoKeywords, type ComposableItemType, type SpecShape } from "./specShape.js";
import { ItemPrioritySchema } from "./priority.js";

/**
 * What the product owner returns from `refine` (ARCHITECTURE.md, "What it proposes, and what a
 * person approves").
 *
 * This is the one transition the engine cannot verify for itself — it
 * can't invent stories, so the data can only come from the agent. Zod
 * proves the shape is well-formed; nothing here proves it's *good*.
 * That's the human gate, deliberately (ARCHITECTURE.md, "What it proposes, and what a person
 * approves", and this story's
 * out-of-scope note).
 */
export const RefineStorySchema = z.object({
  title: z.string().min(1),
  /**
   * Which repository this story belongs in, by name (KAN-17).
   *
   * Only meaningful on a project spanning several — the prompt lists them
   * and asks for one. Optional in the schema because a single-repo
   * project neither shows the list nor needs the answer, and requiring it
   * everywhere would make every existing agent's output invalid for a
   * field it was never told about.
   *
   * A *story* always lands in exactly one repository. That is what
   * keeps one worktree, one branch, one verification run and one pull
   * request per story.
   *
   * Deliberately still a free string rather than an enum of the project's
   * repositories (KAN-31). An enum would rule out a hallucinated name at
   * generation time instead of catching it in a guard afterwards, which
   * is the better place — but it needs `outputSchemaFor` to take the
   * project's members, and that makes the schema vary per dispatch, so the
   * JSON handed to the provider stops being a function of the action
   * alone. That is a real change to how A-02 works and wants its own
   * slice.
   *
   * Left as is because the failure it would prevent has not been seen:
   * across every real multi-repo run the routing was correct, and the
   * project-membership guard in `refine.ts` — which fails the transition
   * with a comment — has never fired. Worth doing when there is either
   * a sighting or another reason to touch that signature.
   */
  repository: z.string().optional(),
  body: z.string(),
  /**
   * Checkable by someone who did not write the story (KAN-31).
   *
   * At least one, because the prompt has always insisted on this and the
   * schema has always shrugged — and a story with none is one G-02 has
   * nothing to check the implementer's claim against.
   */
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  /** Indices into the sibling `stories` array — real item ids don't exist yet at this point. */
  depends_on: z.array(z.number().int().nonnegative()).default([]),
  /**
   * Repository-relative paths this story touches; feeds
   * deriveDepsFromTouches (ARCHITECTURE.md, "One work entity"), which serialises work that would
   * collide.
   *
   * Paths, not prose (KAN-31). The overlap check compares these against
   * each other, so an entry that is not a path can never match anything
   * and is dead weight in a field that looks like a safety feature. A
   * real run returned `["gateway/", "gateway middleware / request
   * pipeline"]` — the second could not have collided with anything ever.
   *
   * Whitespace is what separates the two, and rejecting it is the whole
   * rule: a path with a space in it is not supported here, which is a
   * real limitation and a smaller one than the field not working.
   */
  touches: z.array(z.string().min(1).regex(/^\S+$/, "must be a repository-relative path, with no spaces")).default([]),
  /**
   * The Jira issue this story already is (EO-124).
   *
   * A field a *submitter* fills in and the product owner never does. An
   * agent that agreed a plan outside EO is often mirroring an epic whose
   * stories are already written under it, and `work_submit_plan` had
   * nowhere to say which. The product owner is proposing work that does
   * not exist anywhere yet, so it has no key to give — which is why
   * `ProposedStorySchema` below takes this field back off before any
   * schema reaches a provider.
   *
   * Attaching is a local write: `applyNewFeature` checks the shape, that
   * no other item holds the key, and that the plan does not give the
   * same key twice. Nothing is fetched and nothing is imported —
   * `jira_pull` is still how an issue's words come across.
   *
   * Deliberately a plain string rather than `JiraIssueKeySchema`, which
   * is what the other two fields of this kind use. A key is refused
   * three ways, and only one of them can be seen from here — the other
   * two need the database and the rest of the plan. Checking the format
   * at this boundary would make that one arrive as an `Invalid request
   * payload` envelope while its two siblings arrive as the `problem`
   * `work_submit_plan` documents: the tool's refusal never renders, and
   * a submitter is told its transport was wrong rather than which of its
   * keys was. `resolveSubmittedJiraKey` parses through
   * `JiraIssueKeySchema` before anything is created, so what is *stored*
   * is still the canonical spelling `jira/pull.ts` matches on.
   */
  jira_key: z.string().optional(),
  /**
   * Whether this story talks to Jira at all (EO-122), and the other
   * field only a submitter fills in.
   *
   * Omitted means inherit the plan's setting, which the feature carries
   * and `createItem` reads off it at creation. Explicit `false`
   * overrides a plan that said nothing or said `true`.
   */
  jira_sync: z.boolean().optional(),
  /**
   * The branch this story's branch is to be cut from, and its pull
   * request opened against, when it is not the repository's base branch
   * (EO-364).
   *
   * Carried by a plan and by a conversation's proposal, and written onto
   * the story's `git` extension when it is created — before its first
   * dispatch, which matters because the first step of a git pipeline
   * cuts the branch as soon as the story lands. Never asked of a
   * decomposition: `ProposedStorySchema` takes it off, because the
   * product owner breaking a feature down has no reason to send work
   * anywhere but where the repository says.
   *
   * A plain string for the reason `jira_key` is one: a name git would
   * not accept is refused by the plan's own `problem`, naming the story,
   * rather than as a malformed payload. Whether the branch exists is
   * asked of the remote when the branch is cut.
   */
  base_branch: z.string().optional(),
  /**
   * A branch that already exists — locally or on the repository's
   * remote — for this story to be worked on, instead of one being cut
   * for it (EO-365).
   *
   * Written onto the story's `git` extension as its `branch` when it is
   * created, so Worktree's first dispatch checks that branch out with
   * every commit on it rather than cutting `<prefix>/<key>`. The branch
   * stays the person's: EO never renames, deletes, rebases or
   * force-pushes it, and its pull request opens from it. Taken off a
   * decomposition for the reason `base_branch` is. A plain string for
   * the same reason too.
   */
  existing_branch: z.string().optional(),
  /**
   * The story's own priority, when the plan gives it one (EO-568).
   *
   * Held to the rule `items:update` applies — an integer, 0 or more —
   * so a plan carrying a negative one is refused whole, with nothing
   * created, rather than half-built and then edited. Left out, the story
   * is 0, as every story was before this field: it does not inherit its
   * feature's, because urgency is a fact about a piece of work and a
   * feature's stories are seldom all equally urgent.
   *
   * Taken off a decomposition, as `base_branch` is: the product owner
   * breaking a feature down is not who decides what is urgent.
   */
  priority: ItemPrioritySchema.optional(),
});

/**
 * A story as an *agent* is asked for it: `RefineStorySchema` with the
 * submitter's two Jira fields taken back off (EO-124).
 *
 * This is what keeps "the product owner never fills these in" true
 * rather than merely intended. `outputSchemaFor` derives the JSON Schema
 * handed to the provider from `RefineOutputSchema`, and
 * `DiscussionOutputSchema` derives the `discuss` one the same way — so
 * adding a field to `RefineStorySchema` would have advertised it to both
 * agents, and a model shown `jira_key` will eventually invent one. Both
 * schemas point here instead, and only the two submit paths — which
 * carry keys from a caller who has them — use the wider shape. (The
 * `discuss` one points at `PlannedStorySchema` below since EO-364, which
 * is this plus the base branch a conversation may name.)
 *
 * Unknown keys are stripped rather than refused, as everywhere else in
 * zod, so an agent that sends one anyway is not failed for it: the field
 * is dropped and the story is created unlinked.
 */
export const ProposedStorySchema = RefineStorySchema.omit({ jira_key: true, jira_sync: true, base_branch: true, existing_branch: true, priority: true });

/**
 * A story in a plan somebody agreed with a person: `ProposedStorySchema`
 * with the base branch it may name (EO-364).
 *
 * What a conversation's `new_feature` carries per story. Separate from
 * `ProposedStorySchema` because that one is also the decomposition's,
 * and a decomposition has no business naming a base; a conversation in
 * which a person said "this goes on the release branch" does.
 */
export const PlannedStorySchema = RefineStorySchema.omit({ jira_key: true, jira_sync: true });

export const RefineOutputSchema = z.object({
  stories: z.array(ProposedStorySchema).min(1),
});

export type RefineStory = z.infer<typeof RefineStorySchema>;
export type ProposedStory = z.infer<typeof ProposedStorySchema>;
export type PlannedStory = z.infer<typeof PlannedStorySchema>;

/**
 * A plan's story as `work:submitPlan` hands it over: a planned story,
 * plus the other fields of its type in `spec` (EO-735) — a field a
 * project added to a pack's type, say. Only that channel carries it; a
 * conversation's `new_feature` and a decomposition do not.
 */
export type SubmittedStory = PlannedStory & { spec?: Record<string, unknown> | undefined };
export type RefineOutput = z.infer<typeof RefineOutputSchema>;

// ── Composed from the project's item types (KAN-147) ────────────

/** The action that produces an item's children: a decomposition (ARCHITECTURE.md, "An item type is data"). */
export const REFINE_ACTION = "refine";

/**
 * What a decomposition answers with, composed from the types this
 * project has (ARCHITECTURE.md, "An item type is data", "Zod for schemas in code, ajv for schemas
 * that arrive as data").
 *
 * `RefineOutputSchema` above is story-shaped, and that is the last place
 * the three words EO ships were written into a contract: a `stories`
 * array whose entries carry `acceptance_criteria` because a story is
 * what a feature decomposes into. Refine means *produce children*,
 * whatever the pack calls them — a support pack's container decomposes
 * into Cases, and a Case carries a customer and a channel.
 *
 * So the answer is `children`, each stating its `type` and carrying that
 * type's own fields, exactly as `intakeOutputSchemaFor` composes a
 * classification. Same choices, for the same reasons: a document rather
 * than zod, because the branches are data; `anyOf` rather than `oneOf`,
 * because two packs may ship one slug and an answer matching twice is an
 * ambiguous type rather than a malformed result; and the type's fields
 * flat beside the envelope, because a nested object is a second level in
 * a tool's JSON Schema and models handle it worse.
 *
 * **Only the types that are work.** A container child would be a plan
 * nothing could schedule: it would need decomposing itself, and the
 * lifecycle derives its state from children it does not have. Which
 * types are work is the container flag, read as data (KAN-146).
 */

/** The keys a child carries itself. Everything else it answers with is its spec. */
export const REFINE_CHILD_ENVELOPE: readonly string[] = ["type", "title", "body", "repository", "depends_on", "touches"];

function childBranch(type: ComposableItemType): JsonSchema {
  const properties: Record<string, unknown> = {
    type: { type: "string", const: type.slug },
    title: { type: "string", minLength: 1 },
    body: { type: "string" },
    /**
     * Which repository this child belongs in, by name (KAN-17). Only
     * meaningful on a project spanning several; `routeChild` refuses a
     * name that is not on the project rather than guessing.
     */
    repository: { type: "string" },
    // Indices into the sibling array — real ids do not exist yet.
    depends_on: { default: [], type: "array", items: { type: "integer", minimum: 0 } },
    // Paths, not prose: the overlap check compares these against each
    // other, so an entry with a space in it can never match anything
    // (KAN-31).
    touches: { default: [], type: "array", items: { type: "string", pattern: "^\\S+$" } },
  };

  for (const [name, property] of Object.entries(type.specShape.properties)) {
    const declared = withoutEoKeywords(property);
    const envelope = properties[name];
    properties[name] = envelope === undefined ? declared : narrowEnvelopeField(envelope as Record<string, unknown>, declared);
  }

  // A shape *requiring* one of the six still makes it required, too
  // (KAN-147). Dropping the requirement is how a type could demand a
  // field, pass a document that never asked for it, and produce a child
  // whose stored spec its own shape calls incomplete — `childSpec` is
  // the other half, which carries the envelope's value into the spec so
  // the item satisfies the shape it was created against.
  const demanded = type.specShape.required.filter((name) => !["type", "title", "body"].includes(name));

  return { type: "object", properties, required: ["type", "title", "body", ...demanded] };
}

/**
 * What a project with no work types at all can still be held to.
 *
 * The counterpart of `ANY_CLASSIFICATION`, reachable the same two ways:
 * a lookup with no project in hand, and an installation with no pack
 * installed, which the core must build and run without (invariant 13).
 * A child needs a type and a title whoever shipped it, and an `anyOf`
 * with no branches is a document that accepts nothing and would fail
 * every decomposition rather than saying why.
 */
const ANY_CHILD: JsonSchema = {
  type: "object",
  properties: { type: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, body: { type: "string" } },
  required: ["type", "title"],
};

/** ajv compiles a document once; the composer is called per dispatch. */
const composedDecompositions = new Map<string, OutputSchema>();

/**
 * The decomposition schema for these types, memoized on the document it
 * composes to — see `intakeOutputSchemaFor`, which memoizes the same way
 * and for the same reasons.
 */
export function refineOutputSchemaFor(types: Iterable<ComposableItemType>): OutputSchema {
  const branches = [...types].filter((type) => !type.container).map(childBranch);
  const document: JsonSchema = {
    type: "object",
    properties: { children: { type: "array", minItems: 1, items: branches.length === 0 ? ANY_CHILD : { anyOf: branches } } },
    required: ["children"],
  };
  const key = JSON.stringify(document);
  const found = composedDecompositions.get(key);
  if (found) return found;
  const made = jsonSchemaOutputSchema(document);
  composedDecompositions.set(key, made);
  return made;
}

/**
 * One child of a decomposition, as everything downstream reads it.
 *
 * A reader rather than the contract, exactly as `IntakeAnswerSchema` is:
 * the composed document above is what the agent is held to, and this is
 * how EO picks a child out of an answer that already passed it. `type`
 * is nullable because this also reads a plan written before the field
 * existed — see `refineChildren`.
 */
export interface RefineChild {
  /** The type's slug, or null when the plan predates the field. */
  type: string | null;
  title: string;
  body: string;
  repository?: string;
  /** Indices into the sibling array. */
  depends_on: number[];
  /** Repository-relative paths, which EO serialises colliding work against (E-01). */
  touches: string[];
  /** Everything the answer carried that the envelope does not name. Narrowed to the type's shape when one is in hand. */
  spec: Record<string, unknown>;
  /**
   * The branch to cut this child's branch from, when a plan named one
   * (EO-364). Only ever set from a plan's stories — `childrenFromStories`
   * — and never read out of a decomposition's answer, which has no such
   * field to give.
   */
  baseBranch?: string;
  /**
   * An existing branch to work on instead of cutting one, when a plan
   * named one (EO-365). Set from the same place `baseBranch` is, and
   * never from a decomposition.
   */
  existingBranch?: string;
  /**
   * The child's own priority, when a plan gave it one (EO-568). Set from
   * the same place `baseBranch` is, and never from a decomposition.
   * Absent is 0, which is what `createItem` writes when it is not told.
   */
  priority?: number;
}

const ChildEnvelopeSchema = z.looseObject({
  type: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().default(""),
  repository: z.string().optional(),
  depends_on: z.array(z.number().int().nonnegative()).default([]),
  touches: z.array(z.string().min(1)).default([]),
});

/**
 * The children of a decomposition, whichever way it was written.
 *
 * Two spellings, and the second is compatibility rather than contract.
 * `children` is what the composed document asks for. `stories` is what
 * every plan written before this composition used — and unlike intake's
 * dropped back-compatibility, a plan is not a result that is read once
 * and forgotten: it sits in a proposal comment until a person approves
 * it, and `applyApprovedProposal` re-reads the run's stored result at
 * that moment. An approval that lost the plan because a key was renamed
 * would be work somebody had already agreed to, dropped on the floor.
 *
 * A child that is not one at all is skipped rather than thrown over:
 * A-02 held the whole answer to the composed document before any of this
 * ran, so an unreadable entry here is a caller reading something that
 * was never a decomposition.
 */
export function refineChildren(value: unknown): RefineChild[] {
  if (typeof value !== "object" || value === null) return [];
  const bag = value as Record<string, unknown>;
  const entries = bag["children"] ?? bag["stories"];
  if (!Array.isArray(entries)) return [];

  const children: RefineChild[] = [];
  for (const entry of entries) {
    const parsed = ChildEnvelopeSchema.safeParse(entry);
    if (!parsed.success) continue;
    const answered = parsed.data as Record<string, unknown>;
    const spec: Record<string, unknown> = {};
    for (const [name, answeredValue] of Object.entries(answered)) {
      if (REFINE_CHILD_ENVELOPE.includes(name)) continue;
      if (answeredValue !== undefined) spec[name] = answeredValue;
    }
    children.push({
      type: parsed.data.type ?? null,
      title: parsed.data.title,
      body: parsed.data.body,
      ...(parsed.data.repository === undefined ? {} : { repository: parsed.data.repository }),
      depends_on: parsed.data.depends_on,
      touches: parsed.data.touches,
      spec,
    });
  }
  return children;
}

/**
 * The spec a child of this type stores, from everything it answered
 * (KAN-147).
 *
 * The type's declared fields, taken from the child's own fields *and*
 * from the envelope — because a shape may name one of the six the
 * envelope owns, and then the value is in the envelope rather than
 * beside it. A type whose shape declares `touches` gets the paths it
 * answered with; one declaring `title` gets the title it gave. Without
 * this the composed document would ask for the field once, as the
 * envelope, and the item would be created without it: a child whose
 * stored spec its own type calls incomplete.
 *
 * The mirror of what intake does, and deliberately: a classification's
 * answer is flat, so `specFromAnswer` reads the type's fields off the
 * whole of it. A decomposition's children are read into a typed shape
 * first, which is what splits the envelope from the rest — so this puts
 * the two back together before the shape picks what it declared.
 */
export function childSpec(shape: SpecShape, child: RefineChild): Record<string, unknown> {
  const answered: Record<string, unknown> = {
    ...child.spec,
    ...(child.type === null ? {} : { type: child.type }),
    title: child.title,
    body: child.body,
    ...(child.repository === undefined ? {} : { repository: child.repository }),
    depends_on: child.depends_on,
    touches: child.touches,
  };
  return specFromAnswer(shape, answered);
}

/**
 * A story-shaped plan as children (KAN-147).
 *
 * `work:submitPlan` and the `new_feature` proposal still speak in
 * stories with acceptance criteria, and deliberately: they are a
 * submitter's contract with a plan already in hand, not a shape composed
 * from anybody's types. What applies them is the generic path, so this
 * is where the two meet — the type is left unstated, and the caller says
 * which of its own types an unstated child is.
 */
export function childrenFromStories(stories: readonly SubmittedStory[]): RefineChild[] {
  return stories.map((story) => ({
    type: null,
    title: story.title,
    body: story.body,
    ...(story.repository === undefined ? {} : { repository: story.repository }),
    depends_on: [...story.depends_on],
    touches: [...story.touches],
    // The story's own `spec` first, so the criteria the plan names
    // outright are the ones stored. What the type's shape does not
    // declare is dropped by `childSpec`, and what it does is held to the
    // shape before anything is written.
    spec: { ...(story.spec ?? {}), acceptance_criteria: story.acceptance_criteria },
    // Trimmed here, once, so the plan's card and the row it writes name
    // the same branch. A blank one is a story that named nothing.
    ...(story.base_branch === undefined || story.base_branch.trim() === "" ? {} : { baseBranch: story.base_branch.trim() }),
    ...(story.existing_branch === undefined || story.existing_branch.trim() === "" ? {} : { existingBranch: story.existing_branch.trim() }),
    ...(story.priority === undefined ? {} : { priority: story.priority }),
  }));
}
