import {
  ADMINS_GROUP_NAME,
  divergedLine,
  suggestionBody,
  suggestionDiff,
  suggestionTitle,
  SUGGESTION_APPROVED,
  SUGGESTION_DONE_STEP_NAME,
  SUGGESTION_ITEM_TYPE_SLUG,
  SUGGESTION_PACK_SLUG,
  SUGGESTION_RESULTS,
  SUGGESTION_STEP_NAME,
  SUGGESTIONS_PIPELINE_NAME,
  type ItemTypeEntry,
  type IpcPayload,
  type IpcResponse,
  type Item,
  type MentionTarget,
  type PipelineExport,
  type StepResult,
  type SuggestionView,
  type Uuid,
} from "@eo/core";
import { entryRuleProblems } from "@eo/engine";
import type { Db } from "../db/client.js";
import type { ActingCaller } from "../identity/acting.js";
import { actingCaller, humanAuthor } from "../identity/acting.js";
import type { ManagedDirectory } from "../managed/directory.js";
import type { ModuleSecretsOptions } from "../modules/secrets.js";
import { exportPipeline, parseExport, preflightImport } from "../modules/pipelineTransfer.js";
import { registry } from "../registry.js";
import { itemTypesJudged, projectsServedByPipeline } from "./configCommands.js";
import { galleryNeeds } from "../gallery/form.js";
import {
  clearDivergence,
  createPipeline,
  createRoute,
  createStep,
  currentOutputOf,
  currentVersion,
  divergence,
  findGroupByName,
  getPipeline,
  getPipelineVersion,
  getPerson,
  hasItemType,
  insertItemType,
  isDiverged,
  listModules,
  listPeople,
  listPipelines,
  listProjects,
  listStepsForPipeline,
  markDiverged,
  postComment,
  postOutputComment,
  publishedPipelineRow,
  replacePipelineGraph,
  saveGroup,
  setEntryStep,
  setStepOwner,
  versionGraph,
  createItem,
  getItem,
  getItemType,
} from "../db/repos/index.js";
import { publishSectionCommand, restoreVersion } from "./sectionCommands.js";
import { activeProjectId } from "./repositoryCommands.js";

/**
 * Suggesting a change to a pipeline the organisation manages, and the
 * state a machine is in while it has one outstanding (EO-331,
 * `ARCHITECTURE.md`, "Divergence and suggestions").
 *
 * Both ends of it are here, and deliberately so: what a desktop does
 * when somebody presses *Suggest my change*, and what the record does
 * with the document that arrives. They are one conversation, and a file
 * each would be two accounts of the same document's shape.
 *
 * What is **not** here is the decision. Approving a suggestion is a
 * human step's result like any other, taken through `items:decide`, and
 * the engine owns the transition (invariant #1). What this file
 * contributes to that is the part that is about pipelines rather than
 * about items: `settleSuggestion` applies the document and publishes
 * it, called from the one door a decision goes through.
 */

/** What the suggestion channels need from the process they run in. */
export interface SuggestionContext {
  /** How this installation reaches its organisation, where it has one. */
  managed?: ManagedDirectory;
  /** For the preflight the needs list is derived from — the same reading the gallery's does. */
  moduleSecrets: ModuleSecretsOptions;
  /** What a pack's recommendation is measured against (ARCHITECTURE.md, "An agent is a row"). */
  signedInBackends: readonly string[];
}

/** What an item carries about the change it suggests. */
interface SuggestionSpec {
  pipelineId: string;
  pipelineName: string;
  basedOn: number | null;
}

/**
 * The item type a suggestion is filed as.
 *
 * Its own type rather than a story, because it is not work in anybody's
 * backlog: it is a document waiting for one decision, and the word on
 * the card should say so. `specShape` asks for nothing — what a
 * suggestion carries is its *output*, which is the document, and a
 * required field here would be a form nobody fills in.
 */
const SUGGESTION_ITEM_TYPE: ItemTypeEntry = {
  packSlug: SUGGESTION_PACK_SLUG,
  slug: SUGGESTION_ITEM_TYPE_SLUG,
  label: "Pipeline change",
  plural: "Pipeline changes",
  container: false,
  specShape: { type: "object", properties: {}, required: [] },
  actionOverrides: {},
};

// ── The desktop's half ───────────────────────────────────────────────

/**
 * Whether this machine's copy of a pipeline is its own, and the line
 * that says so (ARCHITECTURE.md, "Divergence and suggestions").
 *
 * Reads three rows and composes one sentence. `basedOn` is the number
 * of the version the copy was made from — looked up rather than stored,
 * because a number stored beside the id would be the same fact twice —
 * and `available` is whatever the organisation has published since.
 */
export function divergenceCommand(db: Db, input: IpcPayload<"pipelines:divergence">): IpcResponse<"pipelines:divergence"> {
  const diverged = divergence(db, input.pipelineId);
  const published = publishedPipelineRow(db, input.pipelineId);
  const available = published?.versionNumber ?? null;
  if (diverged === undefined) return { diverged: false, basedOn: null, available, line: null };
  const basedOn = getPipelineVersion(db, diverged.versionId)?.number ?? null;
  return { diverged: true, basedOn, available, line: divergedLine({ basedOn, available }) };
}

/**
 * Pushes this machine's copy of a pipeline to the organisation as a
 * suggestion (ARCHITECTURE.md, "Divergence and suggestions").
 *
 * Three things in an order that matters:
 *
 * 1. **The copy becomes the person's.** The original design's sentence is "*Suggest a
 *    change* … opens an editable copy that pushes as a suggestion", so
 *    a pipeline that is not diverged yet is diverged here — which is
 *    what makes the editor on the other side of the button live, and
 *    what stops the next publish overwriting what they are about to
 *    type. Already diverged is left exactly as it is, because "based on
 *    v6" is what their edits were made against.
 * 2. **The document is exported**, by the same function a person
 *    exporting a pipeline to a file uses. One document, one set of
 *    refusals — a pipeline that cannot be exported cannot be suggested
 *    either, and for the same reasons in the same words.
 * 3. **It is sent**, and the record's own answer comes back verbatim.
 *
 * A failure at step 3 leaves the copy diverged, and that is the right
 * way round: the person asked for an editable copy and has one, the
 * screen now draws the diverged state with *Suggest my change* on it,
 * and pressing it again is the retry. Undoing the divergence on a
 * network error would throw away edits that were already theirs.
 */
export async function suggestChangeCommand(
  db: Db,
  context: SuggestionContext,
  input: IpcPayload<"pipelines:suggest">,
): Promise<IpcResponse<"pipelines:suggest">> {
  const refuse = (problem: string): IpcResponse<"pipelines:suggest"> => ({ suggested: false, itemId: null, itemKey: null, problem });
  const pipeline = getPipeline(db, input.pipelineId);
  if (pipeline === undefined) return refuse("That pipeline no longer exists.");

  const client = context.managed?.client() ?? null;
  if (client === null) {
    return refuse(
      "This machine is not signed in to an organisation server, so there is nobody to suggest this to. " +
        "A pipeline nobody publishes is yours to edit here.",
    );
  }

  // Diverged only where there is something to diverge *from*. A
  // pipeline this organisation has not published is this machine's
  // already, and marking it would draw "Edited locally · based on
  // nothing" over a screen that was never locked — sending a copy of
  // your own pipeline to your administrator is a thing somebody may
  // do, and it does not change whose pipeline it is here.
  const published = publishedPipelineRow(db, input.pipelineId);
  if (published !== undefined) markDiverged(db, input.pipelineId, published.versionId, Date.now());

  const exported = exportPipeline(db, input.pipelineId);
  if (!exported.ok) return refuse(exported.reason);

  const basedOn = basedOnVersion(db, input.pipelineId);
  const answer = await client.request("suggestions:create", {
    pipelineId: input.pipelineId,
    pipelineName: pipeline.name,
    basedOn,
    document: JSON.stringify(exported.document, null, 2),
  });
  if (!answer.ok) return refuse(answer.error.message);
  return {
    suggested: answer.data.itemId !== null,
    itemId: answer.data.itemId,
    itemKey: answer.data.itemKey,
    problem: answer.data.problem,
  };
}

/**
 * Throws this machine's edits away and takes the published version back
 * (the design's third action).
 *
 * The published version's own document, restored exactly as a rollback
 * restores one — `replacePipelineGraph` with `republishVersionId`, so
 * the graph comes from the frozen document and no new version is filed
 * for a graph the organisation already has a number for. It meets the
 * same strand refusal as every other graph change: an edit that added a
 * step and put work on it cannot be discarded out from under that work,
 * and saying so beats deleting it.
 *
 * The mark comes off last, so a refusal leaves the machine diverged —
 * which is what it still is.
 */
export function discardEditsCommand(db: Db, input: IpcPayload<"pipelines:discardEdits">): IpcResponse<"pipelines:discardEdits"> {
  const refuse = (problem: string): IpcResponse<"pipelines:discardEdits"> => ({ discarded: false, version: null, problem });
  if (!isDiverged(db, input.pipelineId)) return refuse("Nothing has been edited locally on this pipeline, so there is nothing to discard.");

  const published = publishedPipelineRow(db, input.pipelineId);
  const versionId = published?.versionId ?? divergence(db, input.pipelineId)?.versionId ?? null;
  const version = versionId === null ? undefined : getPipelineVersion(db, versionId);
  if (version === undefined) {
    return refuse(
      "This machine does not hold the version your organisation published, so there is nothing to put back. " +
        "It will arrive on the next sync — try again then.",
    );
  }

  // The same write a rollback makes, through the same function: the
  // graph comes out of the version's own frozen document, and no new
  // version is filed for a graph the organisation already numbered.
  const problem = restoreVersion(db, input.pipelineId, version);
  if (problem !== null) return refuse(problem);
  clearDivergence(db, input.pipelineId, Date.now());
  return { discarded: true, version: version.number, problem: null };
}

/** The version this machine's copy was made from, as a number. */
function basedOnVersion(db: Db, pipelineId: string): number | null {
  const diverged = divergence(db, pipelineId);
  if (diverged === undefined) return null;
  return getPipelineVersion(db, diverged.versionId)?.number ?? null;
}

// ── The record's half ────────────────────────────────────────────────

/**
 * Files a suggested change as an item (ARCHITECTURE.md, "Divergence and suggestions").
 *
 * The document is parsed to be refused early — a document that will not
 * parse is not a suggestion anybody can review — and then stored *as it
 * was sent*, as the item's output. That is what makes the thread the
 * whole of it: the output is the document, the diff is drawn from the
 * output, and approving it applies the output. Nothing about the
 * suggestion lives anywhere the admin cannot read.
 */
export function createSuggestionCommand(db: Db, input: IpcPayload<"suggestions:create">): IpcResponse<"suggestions:create"> {
  const parsed = parseExport(input.document);
  if (!parsed.ok) return { itemId: null, itemKey: null, problem: parsed.reason };

  const caller = actingCaller(db, input.actingDeviceId);
  const projectId = whereSuggestionsLand(db, input.pipelineId);
  const place = suggestionsPipeline(db);
  ensureSuggestionItemType(db, projectId);

  const spec: SuggestionSpec = { pipelineId: input.pipelineId, pipelineName: input.pipelineName, basedOn: input.basedOn };
  const created = createItem(db, {
    type: { packSlug: SUGGESTION_PACK_SLUG, slug: SUGGESTION_ITEM_TYPE_SLUG },
    projectId,
    title: suggestionTitle(input.pipelineName),
    body: suggestionBody({ pipelineName: input.pipelineName, basedOn: input.basedOn, author: caller.person?.name ?? null }),
    spec: { ...spec },
    stepId: place.stepId,
    pipelineId: place.pipelineId as Uuid,
    ...(caller.person === null ? {} : { createdBy: caller.person.id }),
  });
  if (!created.ok) return { itemId: null, itemKey: null, problem: created.problem };

  postOutputComment(db, { itemId: created.item.id, author: humanAuthor(caller), body: input.document });
  return { itemId: created.item.id, itemKey: created.item.key, problem: null };
}

/**
 * What the admin reviewing a suggestion is shown (ARCHITECTURE.md, "Divergence and suggestions").
 *
 * The diff against what is published now rather than against what the
 * author started from, and that is the decision in this function: a
 * suggestion made on Monday and reviewed on Friday is a change to the
 * pipeline as it stands on Friday, and a diff against v6 would show an
 * admin a change they cannot make any more. "Based on v6" is beside it
 * so the gap is visible rather than silently resolved.
 */
export function suggestionDetailCommand(
  db: Db,
  context: SuggestionContext,
  input: IpcPayload<"suggestions:detail">,
): IpcResponse<"suggestions:detail"> {
  const found = suggestionOf(db, input.itemId as Uuid);
  if (found === null) return { suggestion: null };
  const { item, spec, document } = found;

  // What is published, and failing that what the record is on. The
  // fallback is not a loophole in the original design's "against the current
  // published version": it is the same sentence on a server that has
  // not published that pipeline yet, where the version the record runs
  // *is* what approving this would add one to, and a screen with no
  // diff at all would be a decision made blind.
  const published = publishedPipelineRow(db, spec.pipelineId);
  const against = published?.versionId ?? currentVersion(db, spec.pipelineId)?.id ?? null;
  const number = published?.versionNumber ?? currentVersion(db, spec.pipelineId)?.number ?? null;
  const snapshot = against === null ? undefined : versionGraph(db, against);
  const diff = snapshot === undefined || number === null ? null : suggestionDiff({ published: { number, ...snapshot }, document });

  // The same lines the author's own needs check drew, from the same
  // function: what the document asks of the machine that would run it.
  const preflight = preflightImport(db, context.moduleSecrets, document, { signedInBackends: context.signedInBackends });
  const author = item.createdBy === null ? null : (getPerson(db, item.createdBy as Uuid)?.name ?? null);

  return {
    suggestion: {
      itemId: item.id,
      pipelineId: spec.pipelineId,
      pipelineName: spec.pipelineName,
      basedOn: spec.basedOn,
      publishedVersion: number,
      diff,
      needs: galleryNeeds(preflight, [], context.signedInBackends),
      unapprovedModules: unapprovedModules(db, document),
      author,
      problem: applyProblem(db, spec.pipelineId, document),
    } satisfies SuggestionView,
  };
}

/**
 * The suggestion an item is, or null for an item that is not one.
 *
 * Read from the item's own rows rather than from a table of
 * suggestions: the type says what it is, the spec says which pipeline,
 * and the output is the document. An item whose output has been
 * superseded — an author who corrected themselves by posting a new
 * document — is read at its newest, which is what `currentOutputOf`
 * means everywhere else in EO.
 */
export function suggestionOf(db: Db, itemId: Uuid): { item: Item; spec: SuggestionSpec; document: PipelineExport } | null {
  const item = getItemForSuggestion(db, itemId);
  if (item === null) return null;
  const spec = specOf(item);
  if (spec === null) return null;
  const output = currentOutputOf(db, itemId);
  if (output === undefined) return null;
  const parsed = parseExport(output.body);
  if (!parsed.ok) return null;
  return { item, spec, document: parsed.document };
}

/** The item, where it is one of ours. */
function getItemForSuggestion(db: Db, itemId: Uuid): Item | null {
  const item = getItem(db, itemId);
  if (item === undefined) return null;
  const type = getItemType(db, item.typeId as Uuid);
  if (type === undefined) return null;
  return type.packSlug === SUGGESTION_PACK_SLUG && type.slug === SUGGESTION_ITEM_TYPE_SLUG ? item : null;
}

function specOf(item: Item): SuggestionSpec | null {
  const spec = item.spec;
  if (spec === null || typeof spec !== "object") return null;
  const pipelineId = (spec as { pipelineId?: unknown }).pipelineId;
  const pipelineName = (spec as { pipelineName?: unknown }).pipelineName;
  const basedOn = (spec as { basedOn?: unknown }).basedOn;
  if (typeof pipelineId !== "string") return null;
  return {
    pipelineId,
    pipelineName: typeof pipelineName === "string" ? pipelineName : pipelineId,
    basedOn: typeof basedOn === "number" ? basedOn : null,
  };
}

// ── Deciding one ─────────────────────────────────────────────────────

/**
 * Who a decision on a suggestion is addressed to (ARCHITECTURE.md, "Divergence and suggestions").
 *
 * The author, so that "why did you drop the review step?" reaches the
 * person who dropped it. Comments are the only channel (invariant #4)
 * and a mention is what makes one an inbox entry — without this, an
 * admin sending a change back would be writing into a thread nobody is
 * watching on a machine that is not theirs.
 *
 * Empty for anything that is not a suggestion, and for a suggestion
 * whose author is the person deciding: mentioning yourself is an inbox
 * entry about your own sentence.
 */
export function suggestionMentions(db: Db, item: Item, acting: ActingCaller): MentionTarget[] {
  if (getItemForSuggestion(db, item.id as Uuid) === null) return [];
  const author = item.createdBy;
  if (author === null || author === acting.person?.id) return [];
  return [{ type: "human", personId: author as Uuid }];
}

/**
 * What approving or sending back a suggestion *does*, beyond moving the
 * item (ARCHITECTURE.md, "Divergence and suggestions").
 *
 * Approving publishes: the document is applied to the pipeline, which
 * files the next version, and that version is published to every
 * signed-in desktop. Sending back does nothing here — the admin's own
 * comment is the whole of it, and it reaches the author because
 * `suggestionMentions` put them on it.
 *
 * Called from `decideItem` after the person's comment and before the
 * transition, so the thread reads in the order things happened.
 * Refusals are `refusalFor` below, asked *before* anything is written,
 * because a publish that failed halfway through a decision would leave
 * an item settled about a change that never landed.
 */
export function settleSuggestion(db: Db, item: Item, resultKey: string, acting: ActingCaller): void {
  if (resultKey !== SUGGESTION_APPROVED) return;
  const found = suggestionOf(db, item.id as Uuid);
  if (found === null) return;

  const applied = applyDocument(db, found.spec.pipelineId, found.document, acting.person?.id ?? null);
  if (!applied.ok) {
    // Guarded above by `suggestionRefusal`, so this is the race rather
    // than the ordinary path — and invariant #8 applies to it as much:
    // nothing silently drops work on the floor.
    postComment(db, { itemId: item.id as Uuid, author: { type: "engine" }, body: applied.problem });
    return;
  }

  const publish = publishSectionCommand(db, {
    section: "pipelines",
    pipelineId: found.spec.pipelineId,
    versionNumber: null,
    ...(acting.deviceId === null ? {} : { actingDeviceId: acting.deviceId }),
  });
  postComment(db, {
    itemId: item.id as Uuid,
    author: { type: "engine" },
    body:
      publish.problem === null
        ? `Published as v${applied.version} of "${found.spec.pipelineName}". Every signed-in desktop takes it on its next sync.`
        : `Applied as v${applied.version} of "${found.spec.pipelineName}", and not published: ${publish.problem}`,
    mentions: suggestionMentions(db, item, acting),
  });
}

/**
 * Why this suggestion cannot be approved, before anything is written.
 *
 * Only ever about approving: sending one back asks nothing of the
 * pipeline and can always be done. Returned as a sentence the decision
 * refuses with, so an admin meets it on the button rather than in a
 * thread after the fact.
 */
export function suggestionRefusal(db: Db, item: Item, resultKey: string): string | null {
  if (resultKey !== SUGGESTION_APPROVED) return null;
  const found = suggestionOf(db, item.id as Uuid);
  if (found === null) {
    return getItemForSuggestion(db, item.id as Uuid) === null
      ? null
      : "This suggestion carries no document EO can read, so there is nothing to publish. Ask its author to suggest the change again.";
  }
  return applyProblem(db, found.spec.pipelineId, found.document);
}

/**
 * Whether this document could be applied here, in one sentence or null.
 *
 * Read by the admin's screen *and* by the refusal, so that what the
 * button says before it is pressed and what the decision says when it
 * is are the same answer.
 */
function applyProblem(db: Db, pipelineId: string, document: PipelineExport): string | null {
  if (getPipeline(db, pipelineId) === undefined) {
    return `The pipeline this changes is not on this server any more, so there is nothing to publish it to.`;
  }
  const missing = missingModules(db, document);
  if (missing.length > 0) {
    return (
      `This change runs ${missing.length === 1 ? "a module" : "modules"} this server does not have — ${missing.join(", ")}. ` +
      `A suggestion carries a graph, not the code inside it: add the module here and approve it, then approve this.`
    );
  }
  // Held to what a save holds them to (EO-610): approving this publishes them.
  const types = itemTypesJudged(db, pipelineId, { serving: projectsServedByPipeline(db, pipelineId) });
  return entryRuleProblems(document.pipeline.entryRules, types, registry.entryRuleKinds)[0] ?? null;
}

/** The module slugs a document's steps name and this installation has no row for. */
function missingModules(db: Db, document: PipelineExport): string[] {
  const here = new Set(listModules(db, true).map((module) => module.slug));
  return [
    ...new Set(
      document.steps
        .filter((step) => step.type === "module" && step.entryAction !== null)
        .map((step) => step.entryAction as string)
        .filter((slug) => !here.has(slug)),
    ),
  ];
}

/** The modules this document names that nobody here has read and approved (ARCHITECTURE.md, "The needs check"). */
function unapprovedModules(db: Db, document: PipelineExport): string[] {
  const byslug = new Map(listModules(db, true).map((module) => [module.slug, module]));
  return document.modules.filter((module) => (byslug.get(module.slug)?.approvedAt ?? null) === null).map((module) => module.name);
}

/**
 * Applies a suggested document to the pipeline it is a change to.
 *
 * **Merged over the rows that are here, never written over them.** An
 * export document is deliberately narrower than a step: it carries no
 * workspace, no module inputs, no time limit, no owner and no off-board
 * step, because none of those means anything on another machine
 * (`exportPipeline`). Applying it as though it were the whole step
 * would clear every one of them on the server — a step's configured
 * module inputs gone because somebody on a laptop suggested renaming a
 * column.
 *
 * So each step in the document updates the fields the document is
 * *about* — its name, its role, its prose, its results, where it sits —
 * and the record's own fields are left unmentioned, which is exactly
 * what `replacePipelineGraph` treats as "leave what the row had". Steps
 * the document does not carry because they never travel (off-board
 * ones) are passed through unchanged, so that applying a suggestion
 * does not retire a conversation's host step.
 */
function applyDocument(
  db: Db,
  pipelineId: string,
  document: PipelineExport,
  by: string | null,
): { ok: true; version: number } | { ok: false; problem: string } {
  const problem = applyProblem(db, pipelineId, document);
  if (problem !== null) return { ok: false, problem };

  const bySlug = new Map(listModules(db, true).map((module) => [module.slug, module.id as string]));
  const existing = listStepsForPipeline(db, pipelineId);
  const carried = new Set(document.steps.map((step) => step.id));

  const steps = [
    ...document.steps.map((step) => ({
      id: step.id,
      pipelineId: pipelineId as Uuid,
      position: step.position,
      name: step.name,
      type: step.type,
      ownerRole: step.ownerRole,
      // Back from the slug the document travels as, into the id this
      // installation's rows use — the inverse of what `exportPipeline`
      // did on the way out.
      entryAction: step.type === "module" && step.entryAction !== null ? (bySlug.get(step.entryAction) ?? step.entryAction) : step.entryAction,
      instructionsSummary: step.instructionsSummary,
      isTerminal: step.isTerminal,
      planMode: step.planMode,
      results: step.results as StepResult[],
    })),
    // What never travelled, exactly as it is.
    ...existing
      .filter((step) => step.offBoard && !carried.has(step.id))
      .map((step) => ({
        id: step.id,
        pipelineId: pipelineId as Uuid,
        position: step.position,
        name: step.name,
        type: step.type,
        ownerRole: step.ownerRole,
        entryAction: step.entryAction,
        instructionsSummary: step.instructionsSummary,
        isTerminal: step.isTerminal,
        planMode: step.planMode,
        offBoard: true,
      })),
  ];
  const routes = document.routes.map((route) => ({
    pipelineId: pipelineId as Uuid,
    fromStepId: route.fromStepId,
    resultKey: route.resultKey,
    label: route.label,
    tone: route.tone,
    target: route.target,
    position: route.position,
  }));

  const entryStepId = document.pipeline.entryStepId;
  const replaced = replacePipelineGraph(db, pipelineId, steps, routes, {
    ...(entryStepId === null ? {} : { entryStepId }),
    // What the suggestion says work must have to enter (EO-610): part of
    // the document, and shown on the diff the admin approved.
    entryRules: document.pipeline.entryRules,
    createdBy: by,
  });
  if (!replaced.replaced) {
    const holding = replaced.holding.map((step) => `"${step.stepName}" has ${step.count}`).join(", ");
    return { ok: false, problem: `This change removes a step work is standing on: ${holding}. Move that work first, then approve it.` };
  }
  return { ok: true, version: replaced.version };
}

// ── The internal pipeline, and where its items live ──────────────────

/**
 * The "pipeline changes" pipeline, made the first time anybody suggests
 * anything (ARCHITECTURE.md, "Divergence and suggestions").
 *
 * One human step, which is what the design asks for, and a terminal step
 * after it for the settled ones to rest on — a result has to route
 * somewhere, and an item that finishes a pipeline needs a step marked
 * terminal to finish on. Found by name, because that is what makes it
 * *the* pipeline rather than one per suggestion, and an admin who
 * renames it has renamed their own screen and gets a second one only if
 * they also stop having the first.
 *
 * Project-less, so it appears wherever an admin is looking:
 * `listPipelines` already reads a pipeline with no project as belonging
 * to whichever project is asking.
 */
export function suggestionsPipeline(db: Db): { pipelineId: string; stepId: string } {
  const existing = listPipelines(db).find((pipeline) => pipeline.name === SUGGESTIONS_PIPELINE_NAME);
  if (existing !== undefined) {
    const review = listStepsForPipeline(db, existing.id).find((step) => step.name === SUGGESTION_STEP_NAME);
    if (review !== undefined) return { pipelineId: existing.id, stepId: review.id };
  }

  const pipeline = existing ?? createPipeline(db, { name: SUGGESTIONS_PIPELINE_NAME, position: 0 });
  const review = createStep(db, {
    pipelineId: pipeline.id as Uuid,
    position: 0,
    name: SUGGESTION_STEP_NAME,
    type: "user",
    instructionsSummary:
      "Somebody suggested a change to a pipeline this organisation manages. Read the diff, ask in the thread, then approve it or send it back.",
    results: SUGGESTION_RESULTS,
  });
  const settled = createStep(db, {
    pipelineId: pipeline.id as Uuid,
    position: 1,
    name: SUGGESTION_DONE_STEP_NAME,
    type: "user",
    isTerminal: true,
    instructionsSummary: "Where a suggestion comes to rest, approved or not.",
  });
  for (const result of SUGGESTION_RESULTS) {
    createRoute(db, {
      pipelineId: pipeline.id as Uuid,
      fromStepId: review.id,
      resultKey: result.key,
      label: result.label,
      tone: result.tone,
      target: settled.id,
      position: SUGGESTION_RESULTS.indexOf(result),
    });
  }
  setEntryStep(db, pipeline.id, review.id);
  // Offered to the admins rather than held by one of them: which admin
  // picks it up is not EO's to decide, and a group-owned step arrives
  // unclaimed for whoever is there.
  setStepOwner(db, review.id, { personId: null, groupId: adminsGroupId(db) });
  return { pipelineId: pipeline.id, stepId: review.id };
}

/**
 * The group a suggestion waits on.
 *
 * Created with every admin on the list where there is no group by that
 * name, and left entirely alone where there is: an organisation that
 * has curated its own "Admins" group has said who they are, and a
 * membership EO refreshed on every suggestion would quietly undo that.
 */
function adminsGroupId(db: Db): string {
  const existing = findGroupByName(db, ADMINS_GROUP_NAME);
  if (existing !== undefined) return existing.id;
  return saveGroup(db, { name: ADMINS_GROUP_NAME, memberIds: listPeople(db).filter((person) => person.isAdmin).map((person) => person.id) }).id;
}

/**
 * Which project a suggestion appears on.
 *
 * The project of the pipeline it changes, because that is where the
 * people who care about that pipeline are looking. A pipeline with no
 * project of its own falls back to whichever project this installation
 * is showing, and then to the first one it has — an item filed onto no
 * project at all would be an item on a board nobody opens.
 */
function whereSuggestionsLand(db: Db, pipelineId: string): Uuid | null {
  const pipeline = getPipeline(db, pipelineId);
  const project = pipeline?.projectId ?? activeProjectId(db) ?? listProjects(db)[0]?.id ?? null;
  return project as Uuid | null;
}

/** The suggestion type, in the scope the item will be filed in. */
function ensureSuggestionItemType(db: Db, projectId: Uuid | null): void {
  if (hasItemType(db, projectId, SUGGESTION_PACK_SLUG, SUGGESTION_ITEM_TYPE_SLUG)) return;
  insertItemType(db, projectId, SUGGESTION_ITEM_TYPE);
}
