import { z } from "zod";
import { GitItemStateSchema, ItemReferenceSchema, ItemReviewersSchema } from "../itemExtensions.js";
import { PageDescriptorSchema } from "./pageDescriptor.js";

/**
 * What is on the person's screen, as the renderer is allowed to say it
 * (EO-192).
 *
 * EO-189 built the same idea the other way round: a section describing
 * the page was rendered at dispatch and put into every assist prompt.
 * That shape decides in advance everything the agent might want, pays
 * for it on every turn, makes anything not chosen unreachable — and goes
 * stale the moment the person navigates, because a prompt written at
 * dispatch cannot follow them. This is the replacement: the renderer
 * publishes what it knows whenever it changes, the main process holds
 * the latest one, and an agent reads it when it wants to know.
 *
 * The discipline EO-189 established is the part worth protecting, and it
 * lives in what this shape *refuses* to carry. Everything here is an
 * **identifier or a view parameter** — which route matched, its
 * parameters, the filter as typed, which ids are selected, how the table
 * is ordered, what has been typed into a field and not saved. There is
 * nowhere to put a sentence about an item, and nowhere to put a fact
 * the renderer looked up. The handler resolves the identifiers against
 * the database, so "the seven items matching that filter" is a list EO
 * computed rather than a number a query cache believed. That is
 * invariant #5 applied to the one input this feature adds.
 */

/**
 * A screen's filter, in the two halves every filtered screen has.
 *
 * `text` is the search box, exactly as typed — not lowercased, not
 * trimmed, because what the person typed is the view parameter and how
 * it is matched is the handler's business.
 *
 * `facets` are the structured filters a screen offers, keyed by the name
 * that screen gives them. A record rather than a fixed object because
 * every list screen has different ones, and a closed shape here would
 * mean editing this package to add a dropdown. `all` — or absence — is
 * no filter; see `matchesItemFilter` for which names the item list's
 * are.
 */
export const ViewFilterSchema = z.object({
  text: z.string().max(300).default(""),
  facets: z.record(z.string().min(1).max(40), z.string().min(1).max(200)).default({}),
});

export type ViewFilter = z.infer<typeof ViewFilterSchema>;

/**
 * Something typed into a field and not saved.
 *
 * The one kind of thing here that has no row behind it, which is why it
 * travels in its own list rather than beside the resolved values it
 * would otherwise be mistaken for. A person who has typed a new base
 * branch into Settings and not pressed Save has *not* changed the base
 * branch, and an agent told "base branch: main-2" as though it were
 * stored would go on to act on a value nothing in EO holds.
 *
 * `value` is the text as typed and is capped rather than validated: a
 * field can hold an agent's whole instructions, and a publish that
 * failed its own schema would take the route and the filter down with
 * it. Callers truncate; see `MAX_UNSAVED_EDIT_VALUE`.
 *
 * **A credential is never an unsaved edit.** A Jira API token, a licence
 * key and a module secret are all typed into fields that hold them
 * before they are saved, and a screen that published everything unsaved
 * would put them in a snapshot an agent reads. So a screen publishes the
 * edits it names, one by one, and what it does not name stays out — and
 * an empty list therefore means *nothing was reported*, never "every
 * field holds what is stored". The reply says exactly that, because the
 * stronger sentence would be the same kind of confident falsehood this
 * whole shape exists to prevent.
 */
export const MAX_UNSAVED_EDIT_VALUE = 500;

export const UnsavedEditSchema = z.object({
  /** What the field is called on screen, so the person and the agent name it the same way. */
  field: z.string().min(1).max(120),
  /** What is in it now. Truncated by the publisher, never the stored value. */
  value: z.string().max(MAX_UNSAVED_EDIT_VALUE),
});

export type UnsavedEdit = z.infer<typeof UnsavedEditSchema>;

/** The parameters of a view — facts about the screen, never about the world. */
export const ViewParametersSchema = z.object({
  /** Null where the screen offers no filter at all, which is different from an empty one. */
  filter: ViewFilterSchema.nullable().default(null),
  /** What is selected, as ids. Rows are the handler's to resolve. */
  selection: z.array(z.string().min(1).max(200)).max(100).default([]),
  /** How the view is ordered, as `<column>:<asc|desc>`. */
  sort: z
    .string()
    .max(120)
    .regex(/^[a-zA-Z0-9_.-]+:(?:asc|desc)$/, "A sort is `<column>:asc` or `<column>:desc`.")
    .nullable()
    .default(null),
});

export type ViewParameters = z.infer<typeof ViewParametersSchema>;

/**
 * One publish from the renderer: where the person is, and how they have
 * the screen set up.
 *
 * Sent on navigation and whenever any of it changes. There is no id and
 * no timestamp because there is only ever one: the main process holds
 * the latest and replaces it, which is what makes a second call after a
 * walk answer about the new screen without anything being dispatched in
 * between.
 */
export const ViewSnapshotSchema = ViewParametersSchema.extend({
  page: PageDescriptorSchema,
  /** Typed and not saved. Never presented as a stored value — see `UnsavedEditSchema`. */
  unsavedEdits: z.array(UnsavedEditSchema).max(50).default([]),
});

export type ViewSnapshot = z.infer<typeof ViewSnapshotSchema>;

/** One result a step declares, and where it sends an item. */
export const ViewResultSchema = z.object({
  resultKey: z.string(),
  /** What the board calls this route, when it is labelled. */
  label: z.string().nullable(),
  /** The target step id — what a move is actually made with. */
  target: z.string(),
  /** Its name, when the target is a step that still exists. */
  targetName: z.string().nullable(),
});

export type ViewResult = z.infer<typeof ViewResultSchema>;

export const ViewItemStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  ownerRole: z.string().nullable(),
  entryAction: z.string().nullable(),
  isTerminal: z.boolean(),
  results: z.array(ViewResultSchema),
});

export const ViewItemSchema = z.object({
  /**
   * The row id, beside the key.
   *
   * The key is what a person quotes and the id is what a tool takes, so
   * an answer carrying only one of them either reads wrong to the human
   * or makes the agent look the other up before it can act.
   */
  id: z.string(),
  key: z.string(),
  title: z.string(),
  type: z.string(),
  /** Where it sits. Null for a feature, which is a container rather than work. */
  step: ViewItemStepSchema.nullable(),
  dependencies: z.array(z.object({ key: z.string(), title: z.string() })),
  /**
   * What the git workspace knows about it — its branch and its pull
   * request (KAN-169, ARCHITECTURE.md, "One work entity").
   *
   * The extension as a nested object rather than two fields here, for
   * the reason `ItemSummary` carries it the same way: three of the four
   * workspace kinds cut no branch, and a snapshot that named these flat
   * would describe every screen in terms of the one kind that does.
   */
  git: GitItemStateSchema,
  /** The Reference its work is filed under, own or inherited from its feature (EO-637). Null when none is. */
  reference: ItemReferenceSchema.nullable().default(null),
  /** Who its pull request asks to review it, and whether that is its own list, its feature's or the repository's (EO-742). */
  reviewers: ItemReviewersSchema.nullable().default(null),
});

export type ViewItem = z.infer<typeof ViewItemSchema>;

export const ViewStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number(),
  type: z.string(),
  ownerRole: z.string().nullable(),
  entryAction: z.string().nullable(),
  /** Live items sitting here right now — what this step is holding. */
  holding: z.number(),
  /** Of those, the ones an agent is working on. */
  running: z.number(),
  /**
   * What the column head says about keep checking (EO-571), or null for a
   * step that runs once: "Checks every 5 minutes · never gives up". The
   * board shows it under the step's name, so a description of the board
   * says it too.
   */
  keepsChecking: z.string().nullable().default(null),
});

export const ViewRouteSchema = ViewResultSchema.extend({
  fromStepId: z.string(),
  fromStepName: z.string().nullable(),
});

export const ViewPipelineSchema = z.object({
  id: z.string(),
  name: z.string(),
  steps: z.array(ViewStepSchema),
  /**
   * The edges between those steps — the graph, not just its columns.
   *
   * "Add a QA step after Review" is a question about what leaves Review,
   * which an ordered list of names cannot answer. Invariant #7 is that
   * the graph is data; an answer showing only the steps would be showing
   * half of it.
   */
  routes: z.array(ViewRouteSchema),
  /**
   * Cards in the rail beside the columns rather than in one of them.
   *
   * The board lifts held work out of its column (EO-44), and puts an
   * agent's parked question there too. Counted apart because it is
   * apart on screen: a step reported as holding a held item names a
   * card that is not in it, and dropping the item from the answer
   * altogether would describe a board without the rail it is visibly
   * showing.
   */
  paused: z.number(),
});

export type ViewRoute = z.infer<typeof ViewRouteSchema>;
export type ViewPipeline = z.infer<typeof ViewPipelineSchema>;

/** A screen that is about no single row — Settings, Agents, the archive. */
export const ViewScreenSchema = z.object({
  /** What the person would call it: the sidebar's own label. */
  name: z.string(),
  /** One line on what the screen is for, so "this" and "here" are unambiguous. */
  describes: z.string(),
});

/**
 * One row of a resolved list — looked up by EO, never asserted by the
 * renderer.
 *
 * Deliberately not item-shaped. Three screens the widget sits on
 * narrow a list — Items, Agents and the Inbox — and each row is a
 * different thing, so the shape carries what every row has (an id and
 * what the person reads first) and puts the rest in labelled facts. A
 * union of three row types would be three renderers and three ways for
 * one of them to drift; `facts` is still every value resolved from the
 * database, just carrying its own name.
 */
export const ViewRowSchema = z.object({
  /** The row id — what a tool takes. */
  id: z.string(),
  /** What the person sees first: an item's key, an agent's name, the item an inbox item is about. */
  name: z.string(),
  /** The rest of the row, as EO resolved it. Labelled values, never a sentence. */
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
});

export type ViewRow = z.infer<typeof ViewRowSchema>;

/** What a resolved list is a list *of*, so the reply can name its rows. */
export const ViewListKindSchema = z.enum(["items", "agents", "inbox"]);

export type ViewListKind = z.infer<typeof ViewListKindSchema>;

/**
 * The rows a filter actually matches, computed by the handler.
 *
 * `count` is `rows.length` unless the listing was capped, in which case
 * it is the real total and `rows` is the head of it. Both are given so a
 * capped answer says so rather than reading as the whole set.
 *
 * `ordered` is what makes "the first fifty" mean anything. The screen
 * lists rows in an order the person chose, and a cap applied to a
 * different order names fifty rows they cannot see while the fifty in
 * front of them go unmentioned. True when EO reproduced the screen's
 * ordering; false when it could not, and the reply says so rather than
 * implying a correspondence that is not there.
 */
export const ViewMatchingSchema = z.object({
  of: ViewListKindSchema,
  count: z.number(),
  rows: z.array(ViewRowSchema),
  ordered: z.boolean(),
});

/**
 * An item a work proposal would create, open before it is filed (EO-408).
 *
 * Not `ViewItemSchema` with holes in it: there is no id, no key and no
 * step, and an answer shaped like an item would invite a tool call
 * against one. What is here is what the proposal says, and whether the
 * proposal can still be approved.
 */
export const ViewProposedItemSchema = z.object({
  title: z.string(),
  /** The item type's label — "Story", "Case". */
  type: z.string(),
  acceptanceCriteria: z.array(z.string()),
  /** What it waits on, as the card says it: a title, with a key in front for an item that exists. */
  waitsOn: z.array(z.string()),
  /** The container the proposal creates it under, by title, or null. */
  container: z.string().nullable(),
  /** "Pipeline · Step", or null when where it lands cannot be said yet. */
  landsOn: z.string().nullable(),
  /** How many items the proposal holds, this one included. Approval is all of them or none. */
  proposedTogether: z.number(),
  /** Its place among them, from 1. */
  position: z.number(),
  /** `open` while it can be approved; otherwise why it cannot. */
  state: z.enum(["open", "applied", "refused", "superseded", "closed"]),
});

export type ViewProposedItem = z.infer<typeof ViewProposedItemSchema>;

/** One version of a pipeline, as the Changes view names it: its number, who filed it and when. */
export const ViewVersionSchema = z.object({
  number: z.number().int().positive(),
  /** Null for a version EO filed itself, or one whose author is no longer listed. */
  createdByName: z.string().nullable(),
  createdAt: z.number(),
});

/** What one comparison on the Changes view found changed: the steps and routes, by name, and how each changed. */
const ViewDiffSummary = {
  steps: z.array(z.object({ name: z.string(), change: z.enum(["added", "removed", "changed"]) })),
  routes: z.array(z.object({ fromStepName: z.string(), resultKey: z.string(), change: z.enum(["added", "removed", "changed"]) })),
};

/**
 * A pipeline's Changes view (EO-524): which pipeline, and which versions
 * are being compared — resolved by EO from the version numbers in the
 * address, so a number the address names that the pipeline does not
 * have is answered with the pair actually drawn.
 *
 * `versions` is two published versions; `local` is this machine's
 * unpublished edits against the version they were based on. Either is
 * null where the view draws no such comparison, or where there is
 * nothing to compare: a pipeline with one version, or one nobody here
 * has edited.
 */
export const ViewPipelineChangesSchema = z.object({
  id: z.string(),
  name: z.string(),
  versions: z.object({ from: ViewVersionSchema, to: ViewVersionSchema, ...ViewDiffSummary }).nullable(),
  local: z.object({ basedOn: z.number().int().positive(), ...ViewDiffSummary }).nullable(),
});

export type ViewPipelineChanges = z.infer<typeof ViewPipelineChangesSchema>;

/** What EO resolved the route to. */
export const ViewShowingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item"), item: ViewItemSchema }),
  z.object({ kind: z.literal("proposedItem"), proposed: ViewProposedItemSchema }),
  z.object({ kind: z.literal("pipeline"), pipeline: ViewPipelineSchema }),
  z.object({ kind: z.literal("pipelineChanges"), changes: ViewPipelineChangesSchema }),
  z.object({ kind: z.literal("screen"), screen: ViewScreenSchema }),
]);

export type ViewShowing = z.infer<typeof ViewShowingSchema>;

/**
 * The current view, in the three kinds of thing that must stay
 * distinguishable.
 *
 *   * `showing` and `matching` are **resolved rows** — the pipeline and
 *     its steps, the items in each column, the item being viewed,
 *     the rows a filter matches. EO looked these up; they are facts.
 *   * `parameters` are **view parameters** — the filter as typed, what
 *     is selected, the sort. Facts about the view, not about the world.
 *   * `unsavedEdits` are **what the person has typed and not saved**.
 *     There is no row behind any of them.
 *
 * Three fields rather than one merged description, because an answer
 * that flattened them would be an answer in which "base branch" means
 * either what is stored or what somebody is halfway through typing, and
 * the reader cannot tell which.
 */
export const CurrentViewSchema = z.object({
  route: z.string(),
  showing: ViewShowingSchema,
  matching: ViewMatchingSchema.nullable(),
  parameters: ViewParametersSchema,
  unsavedEdits: z.array(UnsavedEditSchema),
});

export type CurrentView = z.infer<typeof CurrentViewSchema>;

/**
 * What `view:current` answers.
 *
 * `view` is null and `absence` says why whenever there is nothing
 * honest to describe: no window, nothing published yet, a route nobody
 * listed, or a row deleted since the screen was drawn. Answering "there
 * is no view" is the whole of the requirement — an invented one is
 * worse than none, and a thrown error costs the turn the person asked
 * for.
 */
export const CurrentViewResultSchema = z.object({
  view: CurrentViewSchema.nullable(),
  absence: z.string().nullable(),
});

export type CurrentViewResult = z.infer<typeof CurrentViewResultSchema>;
