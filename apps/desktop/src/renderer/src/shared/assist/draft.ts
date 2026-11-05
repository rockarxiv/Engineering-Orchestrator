import { ipcQuery } from "../../query/client";

/** What publishing a pipeline draft came to: saved, or the reason it was not. */
export interface PublishedDraft {
  saved: boolean;
  problem: string | null;
  pipelineId: string | null;
  /** True when publishing created the pipeline (EO-381), so a surface listing pipelines has one more to show. */
  created: boolean;
  /** True when publishing renamed the pipeline or changed its icon (EO-520), so a surface listing pipelines shows it differently. */
  renamed: boolean;
}

/** Said only if the main process named no module, which it always does. */
const WAITING_ON_MODULES = "Publish is waiting on a module this draft runs, which has not been approved.";

/**
 * Publishes the pipeline graph an assist turn drafted.
 *
 * Two calls rather than one, and deliberately: `assist:draft` re-reads
 * the graph from the run and carries every setting the draft leaves out
 * across from the pipeline as it stands, then `pipeline:save` publishes
 * it — the same channel the configuration screen uses, so there is one
 * path that writes a graph and a person is always on it. A draft that
 * renames the pipeline or changes its icon (EO-520) adds a third,
 * `pipelines:update`, once the graph has saved; one raised in the chat
 * that holds a template update conflict (EO-534) a fourth,
 * `assist:draftPublished`, which resolves it.
 *
 * Shared by every surface that draws the assistant's room — the help
 * widget's panel and the chat layout's conversation — so the two cannot
 * publish a draft two different ways.
 */
export async function publishAssistDraft(conversationId: string, messageId: string): Promise<PublishedDraft> {
  const read = await ipcQuery("assist:draft", { conversationId, messageId });

  // A draft still waiting on a module (EO-399). `assist:draft` answers
  // one with its graph now, so that the chat layout's card can keep its
  // picture — which means the graph is here and must not be sent. The
  // main process would refuse it on either channel; stopping here is what
  // makes Publish end in the sentence naming the module, on a surface
  // with nowhere else to say it (the classic help widget), rather than in
  // a validator's sentence about one step.
  if (read.problem === null && (read.waiting ?? []).length > 0) {
    return { saved: false, problem: read.waitingProblem ?? WAITING_ON_MODULES, pipelineId: read.pipelineId, created: false, renamed: false };
  }

  // A draft that creates a pipeline (EO-381). There is nothing for
  // `pipeline:save` to save into until the pipeline exists, so the main
  // process creates it and saves the graph in one transaction — through
  // the same `savePipeline` that channel calls — and a refusal leaves no
  // empty pipeline behind.
  if (read.problem === null && read.newPipelineName != null) {
    const created = await ipcQuery("assist:publishNew", { conversationId, messageId });
    return { saved: created.saved, problem: created.problem, pipelineId: created.pipelineId, created: created.saved, renamed: false };
  }
  if (read.pipelineId === null) return { saved: false, problem: read.problem, pipelineId: null, created: false, renamed: false };

  // A draft resolving a template update the organisation's record holds
  // (EO-534): the record's pipeline is what was compared, so the draft is
  // published there, and this desktop's copy follows. Never `pipeline:save`
  // into this copy alone, which would leave the update held on the record.
  if (read.updateConflictOnRecord === true) {
    const onRecord = await ipcQuery("assist:publishOnRecord", { conversationId, messageId });
    return { saved: onRecord.saved, problem: onRecord.problem, pipelineId: read.pipelineId, created: false, renamed: false };
  }

  const saved = await ipcQuery("pipeline:save", {
    pipelineId: read.pipelineId,
    steps: read.steps,
    routes: read.routes,
    entryStepId: read.entryStepId,
    // The entry rules it sets (EO-610). Left out, the pipeline keeps its own.
    ...(read.entryRules === undefined ? {} : { entryRules: read.entryRules }),
    // The action definitions the card proposed (EO-426), written by the
    // same save: both or neither.
    ...((read.actions ?? []).length > 0 ? { actions: read.actions } : {}),
    // A restore (EO-520): the main process reads who each of that
    // version's person steps waited on out of the version itself and
    // puts them back, as the editor's Restore did.
    ...(read.restoredFrom != null ? { restoredFrom: read.restoredFrom } : {}),
  });

  // The pipeline's new name or icon (EO-520), once its graph has saved —
  // through `pipelines:update`, the channel every rename goes through. Not
  // before: a refused graph is a card nothing was applied from.
  const rename = read.rename ?? null;
  const icon = read.icon ?? null;
  const renamed = saved.saved && (rename !== null || icon !== null);
  if (renamed) {
    await ipcQuery("pipelines:update", { id: read.pipelineId, ...(rename !== null ? { name: rename } : {}), ...(icon !== null ? { icon } : {}) });
  }
  // A draft from the chat that holds a template update conflict (EO-534):
  // published, it resolves the conflict. The main process checks that the
  // pipeline is now this draft before it believes it.
  const resolved = saved.saved && (read.updateConflictId ?? null) !== null ? await ipcQuery("assist:draftPublished", { conversationId, messageId }) : null;
  return {
    saved: saved.saved,
    // The validator's own words. A graph refused at the boundary has
    // to say which step and why, or the only way to find out is to
    // ask the agent to guess. Saved, the only thing left to say is a
    // template update it should have resolved and did not.
    problem: saved.saved ? (resolved?.problem ?? null) : saved.problems.map((entry) => entry.message).join(" "),
    pipelineId: read.pipelineId,
    created: false,
    renamed,
  };
}

/** What Approve and publish came to (EO-581): `PublishedDraft`, and how each module's tests went. */
export interface ApprovedAndPublishedDraft extends PublishedDraft {
  /** Each module whose tests ran, and what refused it — a failing case, tests that did not run — where something did. */
  modules: { id: string; slug: string; name: string; outcome: "passed" | "refused" | "coverage"; problem: string | null }[];
  /** Modules under the coverage bar the person has not confirmed. Not empty means nothing was written, and the card asks. */
  coverage: { id: string; name: string; lineCoverage: number }[];
}

/**
 * Approve and publish on a draft card that needs modules nobody has
 * approved (EO-581): one call, `assist:approveAndPublish`, which runs
 * every module's tests and then approves them all and publishes the
 * pipeline in one transaction, or writes nothing.
 *
 * One call rather than `modules:approve` per module and then
 * `publishAssistDraft`, because those are separate commits: a refusal
 * part-way would leave modules approved for live work behind a pipeline
 * nobody published. `acknowledgeLowCoverage` names the modules whose
 * coverage figure the person has confirmed on the card.
 */
export async function approveAndPublishAssistDraft(conversationId: string, messageId: string, acknowledgeLowCoverage: readonly string[] = []): Promise<ApprovedAndPublishedDraft> {
  const answer = await ipcQuery("assist:approveAndPublish", { conversationId, messageId, acknowledgeLowCoverage: [...acknowledgeLowCoverage] });
  return {
    saved: answer.saved,
    problem: answer.problem,
    pipelineId: answer.pipelineId,
    created: answer.created,
    renamed: answer.renamed,
    modules: answer.modules ?? [],
    coverage: answer.coverage ?? [],
  };
}

/** What Approve design came to (EO-587): the trial started, or why nothing was made. */
export interface ApprovedDesign {
  approved: boolean;
  trialPipelineId: string | null;
  round: number | null;
  items: { id: string; key: string; title: string }[];
  problem: string | null;
}

/**
 * Approve design on a design card (EO-587): one call, which makes the
 * trial pipeline, grants the draft's modules trial-only permission,
 * files the test items and starts the first round — or makes nothing and
 * says why. Nothing is published.
 */
export async function approveAssistDesign(conversationId: string, messageId: string): Promise<ApprovedDesign> {
  const answer = await ipcQuery("assist:approveDesign", { conversationId, messageId });
  return { approved: answer.approved, trialPipelineId: answer.trialPipelineId, round: answer.round, items: answer.items ?? [], problem: answer.problem };
}
