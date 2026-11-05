import { ADMIN_MCP_SERVER_NAME, AssistOutputSchema, NO_WORKSPACE, SCRATCH_KIND, pageDescriptorFor, type AssistOutput, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { markReplica } from "../db/recordRole.js";
import {
  appendRunEvent,
  approveModule,
  createPerson,
  createPipeline,
  createProject,
  createRun,
  createWorkspace,
  getItem,
  getPipeline,
  getStep,
  listCommentsForItem,
  listModules,
  listStepsForPipeline,
  markDiverged,
  publishSection,
  replacePipelineGraph,
  setSetting,
  setStepOwner,
  updateRun,
} from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { sectionLockFor } from "../managed/locks.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { publishNewAssistPipeline, readAssistDraftForPublish, sendToAssist } from "./assistCommands.js";
import { DEFAULT_GUARD_CONFIG, GUARDS_KEY, savePipeline } from "./configCommands.js";
import { clearPublishedView } from "./currentView.js";
import { pipelineVersionsCommand, updatePipelineCommand } from "./pipelineCommands.js";
import { activeProjectId } from "./repositoryCommands.js";
import { clearHandlerRegistry } from "./registry.js";

/**
 * A help-chat draft that tunes what the pipeline editor used to be the
 * only way to change (EO-520): settings on a step that already exists,
 * "Needs a reason" on a person's result, the pipeline's name and icon,
 * and a restored version with who its person steps waited on.
 *
 * Driven the way the card is: a turn's reply posted, the card's body read,
 * and Publish done as `publishAssistDraft` does it — the graph read back
 * with `assist:draft`, saved through `savePipeline`, then the name and
 * icon through `pipelines:update`.
 */
let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  clearHandlerRegistry();
  clearPublishedView();
  handle.close();
});

const PIPELINE_READ = `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`;
const TEN_MINUTES = 10 * 60 * 1000;
const FIFTY_EIGHT_MINUTES = 58 * 60 * 1000;

function rowOf(id: string): Item {
  return getItem(handle.db, id as Uuid)!;
}

async function openedOn(path: string): Promise<Item> {
  const sent = await sendToAssist(handle.db, undefined, { page: pageDescriptorFor(path), conversationId: null, body: "what is here?", attachmentIds: [], interrupt: false });
  return rowOf(sent.conversation.id);
}

function newestQuestion(conversation: Item): Uuid {
  return listCommentsForItem(handle.db, conversation.id)
    .filter((comment) => comment.authorType === "human")
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .at(-1)!.id;
}

/** A succeeded `assist` run carrying `output`, which read `pipelineId` if given, and what it posted. */
function turn(conversation: Item, output: unknown, readPipeline?: string): { cardIds: Uuid[]; rejections: string[]; body: string } {
  const parsed: AssistOutput = AssistOutputSchema.parse(output);
  const agent = assistAgent(handle.db)!;
  const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: newestQuestion(conversation) });
  if (readPipeline !== undefined) {
    appendRunEvent(handle.db, run.id, "tool_call", { name: PIPELINE_READ, args: { pipelineId: readPipeline }, callId: "call-0" });
    appendRunEvent(handle.db, run.id, "tool_result", { name: PIPELINE_READ, callId: "call-0", ok: true, output: "", truncated: false });
  }
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(parsed), parsed } });
  postAssistReply(handle.db, conversation, agent.id, run.id, parsed);
  const posted = listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.runId === run.id);
  const cards = posted.filter((comment) => comment.kind === PROPOSAL_KIND);
  return {
    cardIds: cards.map((comment) => comment.id),
    rejections: posted.filter((comment) => comment.kind === "rejection").map((comment) => comment.body),
    body: cards[0]?.body ?? "",
  };
}

/** Publish, as the card's button does it (`renderer/src/shared/assist/draft.ts`). */
function publish(conversation: Item, cardId: Uuid) {
  const read = readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: cardId });
  expect(read.problem).toBeNull();
  const saved = savePipeline(handle.db, undefined, {
    pipelineId: read.pipelineId!,
    steps: read.steps,
    routes: read.routes,
    entryStepId: read.entryStepId,
    ...(read.entryRules === undefined ? {} : { entryRules: read.entryRules }),
    ...(read.restoredFrom !== null ? { restoredFrom: read.restoredFrom } : {}),
  });
  if (saved.saved && (read.rename !== null || read.icon !== null)) {
    updatePipelineCommand(handle.db, { id: read.pipelineId!, ...(read.rename !== null ? { name: read.rename } : {}), ...(read.icon !== null ? { icon: read.icon } : {}) });
  }
  return { read, saved };
}

const MERGE_MODULE = {
  name: "Release merge",
  slug: "release-merge",
  description: "Merges the release branch once CI is green.",
  code: "export default async () => ({ ok: true, result: 'merged' });",
  manifest: {
    name: "Release merge",
    description: "Merges the release branch once CI is green.",
    inputs: { ciWaitSeconds: { type: "number" }, branch: { type: "string" } },
    results: ["merged"],
  },
  why: "Before agents existed this was a script.",
  tests: [{ description: "merges", source: "export default async function (harness) { await harness.run({}); }" }],
};

const step = (id: string, position: number, name: string, extra: Record<string, unknown>) => ({
  id,
  position,
  name,
  ownerRole: null,
  entryAction: null,
  instructionsSummary: null,
  isTerminal: false,
  planMode: false,
  type: "user",
  ...extra,
});

/**
 * The Release pipeline: the merge module, a person who approves or sends
 * it back, and Released. `merge` is laid over the module step, `routes`
 * over the approval's two branches.
 */
function releaseDraft(target: Record<string, string>, entryAction: string, merge: Record<string, unknown> = {}, approval: Record<string, unknown>[] = [{}, {}]) {
  return {
    rationale: "A release pipeline.",
    entryStepId: "release_merge",
    target,
    steps: [
      step("release_merge", 0, "Merge", { type: "module", entryAction, ...merge }),
      step("release_approve", 1, "Approve", {}),
      step("release_done", 2, "Released", { isTerminal: true }),
    ],
    routes: [
      { fromStepId: "release_merge", resultKey: "merged", label: "Merged", tone: "success", target: "release_approve", position: 0 },
      { fromStepId: "release_approve", resultKey: "approve", label: "Approve", tone: "success", target: "release_done", position: 0, ...approval[0] },
      { fromStepId: "release_approve", resultKey: "send_back", label: "Send back", tone: "warning", target: "release_merge", position: 1, ...approval[1] },
    ],
  };
}

describe("a draft's entry rules (EO-610)", () => {
  const graph = (extra: Record<string, unknown> = {}) => ({
    rationale: "A pipeline with a door on it.",
    entryStepId: "start",
    target: { newPipeline: "Release" },
    steps: [step("start", 0, "Start", {}), step("end", 1, "End", { isTerminal: true })],
    routes: [{ fromStepId: "start", resultKey: "done", label: "Done", tone: "success", target: "end", position: 0 }],
    ...extra,
  });

  it("publishes them with the graph", async () => {
    const rules = [{ kind: "description" }];
    const conversation = await openedOn("/settings");
    const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: graph({ entryRules: rules }) });
    expect(rejections).toEqual([]);

    expect(readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: cardIds[0]! }).entryRules).toEqual(rules);
    const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
    expect(published.problem).toBeNull();
    expect(getPipeline(handle.db, published.pipelineId!)?.entryRules).toEqual(rules);
  });

  it("is refused before it is a card when a rule cannot be answered", async () => {
    const conversation = await openedOn("/settings");
    const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: graph({ entryRules: [{ kind: "telepathy" }] }) });
    expect(cardIds).toEqual([]);
    expect(rejections.join()).toContain("telepathy");
  });

  it("makes a card of a change to nothing but the rules, and Publish sets them", async () => {
    const { conversation, pipelineId, moduleId } = await releasePipeline();
    const { cardIds, rejections, body } = turn(conversation, { message: "Now it asks for a description.", draft: { ...releaseDraft({ pipelineId }, moduleId), entryRules: [{ kind: "description" }, { kind: "field", field: "customer", types: ["developer:story"], message: "the customer" }] } }, pipelineId);

    // The field is on no type of this project, so that is what stops it.
    expect(cardIds).toEqual([]);
    expect(rejections.join()).toContain('"customer"');

    const next = turn(conversation, { message: "Just the description, then.", draft: { ...releaseDraft({ pipelineId }, moduleId), entryRules: [{ kind: "description" }] } }, pipelineId);
    expect(next.rejections).toEqual([]);
    expect(next.body).toContain("**To enter, work needs** a description");
    expect(body).toBe("");

    expect(publish(conversation, next.cardIds[0]!).saved.saved).toBe(true);
    expect(getPipeline(handle.db, pipelineId)?.entryRules).toEqual([{ kind: "description" }]);
  });

  it("leaves the pipeline's alone when it says nothing", async () => {
    const conversation = await openedOn("/settings");
    const { cardIds } = turn(conversation, { message: "Here.", draft: graph() });

    expect(readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: cardIds[0]! }).entryRules).toBeUndefined();
  });
});

/** The Release pipeline, published from the chat, with a ten-minute limit and `ciWaitSeconds` 1800 on its merge step. */
async function releasePipeline(): Promise<{ conversation: Item; pipelineId: string; moduleId: string }> {
  setSetting(handle.db, GUARDS_KEY, { ...DEFAULT_GUARD_CONFIG, wallClockTimeoutMs: 60 * 60 * 1000 });
  const conversation = await openedOn("/settings");
  const created = turn(conversation, {
    message: "Here.",
    draft: releaseDraft({ newPipeline: "Release" }, "release-merge", { timeoutMs: TEN_MINUTES, inputs: { ciWaitSeconds: 1800, branch: "main" } }),
    modules: [MERGE_MODULE],
  });
  expect(created.rejections).toEqual([]);
  const moduleId = listModules(handle.db).find((module) => module.slug === "release-merge")!.id;
  approveModule(handle.db, moduleId, Date.now() + 1_000);
  const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: created.cardIds[0]! });
  expect(published.saved).toBe(true);
  return { conversation, pipelineId: published.pipelineId!, moduleId };
}

const stepOf = (pipelineId: string, id: string) => listStepsForPipeline(handle.db, pipelineId).find((candidate) => candidate.id === id)!;

describe("tuning a step that already exists", () => {
  /** AC: inputs, time limit, Works on and repository mode on an existing step, old → new under it, and Publish applies them. */
  it("lists each changed setting under its step as old → new, and Publish applies exactly those", async () => {
    const { conversation, pipelineId, moduleId } = await releasePipeline();

    const tuned = turn(
      conversation,
      {
        message: "Tuned.",
        draft: releaseDraft({ pipelineId }, moduleId, {
          timeoutMs: FIFTY_EIGHT_MINUTES,
          inputs: { ciWaitSeconds: 2400, branch: "main" },
          workspaceId: NO_WORKSPACE,
          workspaceMode: "read",
        }),
      },
      pipelineId,
    );

    expect(tuned.rejections).toEqual([]);
    expect(tuned.body).toContain("**Changed**");
    expect(tuned.body).toContain(
      [
        "- Merge",
        "  - Time limit: 10 minutes → 58 minutes",
        "  - `ciWaitSeconds`: 1800 → 2400",
        "  - Works on: the item's own → no disk",
        "  - Repository: works on a branch → reads only",
      ].join("\n"),
    );
    // `branch` was restated unchanged, so it is not a change.
    expect(tuned.body).not.toContain("`branch`");

    expect(publish(conversation, tuned.cardIds[0]!).saved.saved).toBe(true);
    expect(stepOf(pipelineId, "release_merge")).toMatchObject({
      timeoutMs: FIFTY_EIGHT_MINUTES,
      inputs: { ciWaitSeconds: 2400, branch: "main" },
      workspaceId: NO_WORKSPACE,
      workspaceMode: "read",
    });
  });

  /** AC: left out, every one of them stays as the step has it. */
  it("leaves every setting a draft does not name as the step has it", async () => {
    const { conversation, pipelineId, moduleId } = await releasePipeline();
    // Off its defaults first, so there is more than a default to keep.
    const tuned = turn(conversation, { message: "Tuned.", draft: releaseDraft({ pipelineId }, moduleId, { workspaceId: NO_WORKSPACE, workspaceMode: "read" }) }, pipelineId);
    expect(publish(conversation, tuned.cardIds[0]!).saved.saved).toBe(true);
    const before = stepOf(pipelineId, "release_merge");

    // Only the step's name changes.
    const renamed = turn(conversation, { message: "Renamed.", draft: releaseDraft({ pipelineId }, moduleId, { name: "Merge it" }) }, pipelineId);

    expect(renamed.rejections).toEqual([]);
    expect(renamed.body).toContain("- Merge — renamed to **Merge it**");
    expect(renamed.body).not.toContain("Time limit");
    expect(renamed.body).not.toContain("Works on");
    expect(publish(conversation, renamed.cardIds[0]!).saved.saved).toBe(true);
    const after = stepOf(pipelineId, "release_merge");
    expect(after.name).toBe("Merge it");
    expect({ ...after, name: before.name }).toEqual(before);
  });

  it("puts a time limit back to EO's default with \"default\"", async () => {
    const { conversation, pipelineId, moduleId } = await releasePipeline();

    const reset = turn(conversation, { message: "Reset.", draft: releaseDraft({ pipelineId }, moduleId, { timeoutMs: "default" }) }, pipelineId);

    expect(reset.body).toContain("  - Time limit: 10 minutes → EO's default");
    expect(publish(conversation, reset.cardIds[0]!).saved.saved).toBe(true);
    expect(stepOf(pipelineId, "release_merge").timeoutMs).toBeNull();
  });

  /** AC: still judged against the run timeout, naming the step. */
  it("refuses an existing step's time limit longer than the run timeout, naming the step", async () => {
    const { conversation, pipelineId, moduleId } = await releasePipeline();
    setSetting(handle.db, GUARDS_KEY, { ...DEFAULT_GUARD_CONFIG, wallClockTimeoutMs: 30 * 60 * 1000 });

    const refused = turn(conversation, { message: "Longer.", draft: releaseDraft({ pipelineId }, moduleId, { timeoutMs: FIFTY_EIGHT_MINUTES }) }, pipelineId);

    expect(refused.cardIds).toEqual([]);
    expect(refused.rejections.join(" ")).toContain('"Merge" may run for 58 minutes, which is longer than the run timeout');
  });

  /** AC: inputs still judged against the module's manifest, naming the step. */
  it("refuses an input the existing step's module does not declare, naming the step and what it declares", async () => {
    const { conversation, pipelineId, moduleId } = await releasePipeline();

    const refused = turn(conversation, { message: "More.", draft: releaseDraft({ pipelineId }, moduleId, { inputs: { ciWait: 5 } }) }, pipelineId);

    expect(refused.cardIds).toEqual([]);
    expect(refused.rejections.join(" ")).toContain('**Merge** sets `ciWait`, which "Release merge" does not declare');
    expect(refused.rejections.join(" ")).toContain("`ciWaitSeconds`, `branch`");
  });

  it("refuses a workspace the project does not hold, naming the step", async () => {
    // The project the chat, and so the pipeline it creates, is on.
    const home = createProject(handle.db, { name: "Home", keyPrefix: "HOM" });
    const { conversation, pipelineId, moduleId } = await releasePipeline();
    expect(getPipeline(handle.db, pipelineId)?.projectId).toBe(home.id);
    const elsewhere = createProject(handle.db, { name: "Elsewhere", keyPrefix: "ELS" });
    const theirs = createWorkspace(handle.db, { kind: SCRATCH_KIND, projectId: elsewhere.id });

    const refused = turn(conversation, { message: "There.", draft: releaseDraft({ pipelineId }, moduleId, { workspaceId: theirs.id }) }, pipelineId);

    expect(refused.cardIds).toEqual([]);
    expect(refused.rejections.join(" ")).toContain(`**Merge** is set to work on \`${theirs.id}\`, which belongs to another project`);
  });

  /**
   * Review of EO-520: an input Publish drops because the step's new
   * module does not declare it is shown going, rather than disappearing
   * from a card that said nothing about it.
   */
  it("lists an input the step's new module does not declare as going, and Publish drops exactly that", async () => {
    const { conversation, pipelineId } = await releasePipeline();
    const TAG_MODULE = {
      ...MERGE_MODULE,
      name: "Release tag",
      slug: "release-tag",
      description: "Tags the release branch.",
      manifest: { ...MERGE_MODULE.manifest, name: "Release tag", description: "Tags the release branch.", inputs: { branch: { type: "string" } } },
    };

    // The merge step moved onto the tag module, saying nothing about inputs.
    const moved = turn(conversation, { message: "Moved.", draft: releaseDraft({ pipelineId }, "release-tag"), modules: [TAG_MODULE] }, pipelineId);

    expect(moved.rejections).toEqual([]);
    expect(moved.body).toContain("  - `ciWaitSeconds`: 1800 → unset");
    // Still declared, so kept, and not a change.
    expect(moved.body).not.toContain("`branch`");

    approveModule(handle.db, listModules(handle.db).find((module) => module.slug === "release-tag")!.id, Date.now() + 2_000);
    expect(publish(conversation, moved.cardIds[0]!).saved.saved).toBe(true);
    expect(stepOf(pipelineId, "release_merge").inputs).toEqual({ branch: "main" });
  });

  it("accepts a workspace the pipeline's project holds, and names it on the card", async () => {
    const { conversation, pipelineId, moduleId } = await releasePipeline();
    // The project `pipeline:save` judges the step against: the pipeline's,
    // or the one in use where it has none.
    const projectId = getPipeline(handle.db, pipelineId)!.projectId ?? activeProjectId(handle.db) ?? createProject(handle.db, { name: "Home", keyPrefix: "HOM" }).id;
    const ours = createWorkspace(handle.db, { kind: SCRATCH_KIND, projectId: projectId as Uuid });

    const tuned = turn(conversation, { message: "Here.", draft: releaseDraft({ pipelineId }, moduleId, { workspaceId: ours.id }) }, pipelineId);

    expect(tuned.rejections).toEqual([]);
    expect(tuned.body).toContain("  - Works on: the item's own → scratch");
    expect(publish(conversation, tuned.cardIds[0]!).saved.saved).toBe(true);
    expect(stepOf(pipelineId, "release_merge").workspaceId).toBe(ours.id);
  });
});

describe("keep checking on a step that already exists", () => {
  function watchDraft(target: Record<string, string>, watch: unknown) {
    const elsewhere = ["closed", "conflict", "checks_failed", "changes_requested", "ready", "failed"];
    return {
      rationale: "Watch the pull request.",
      entryStepId: "pr_watch",
      target,
      steps: [
        step("pr_watch", 0, "Watching", { type: "builtin", entryAction: "watch_pull_request", ...(watch === undefined ? {} : { watch }) }),
        step("pr_done", 1, "Merged", { isTerminal: true }),
      ],
      routes: [
        { fromStepId: "pr_watch", resultKey: "merged", label: "Merged", tone: "success", target: "pr_done", position: 0 },
        ...elsewhere.map((resultKey, index) => ({ fromStepId: "pr_watch", resultKey, label: resultKey, tone: "warning", target: "user_attention", position: index + 1 })),
      ],
    };
  }

  it("changes the interval old → new, and keeps it where the draft says nothing", async () => {
    const conversation = await openedOn("/settings");
    const created = turn(conversation, { message: "Watch.", draft: watchDraft({ newPipeline: "Watch" }, { everyMinutes: 10, giveUpAfterHours: 72 }) });
    const { pipelineId } = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: created.cardIds[0]! });

    const faster = turn(conversation, { message: "Faster.", draft: watchDraft({ pipelineId: pipelineId! }, { everyMinutes: 5, giveUpAfterHours: 72 }) }, pipelineId!);

    expect(faster.rejections).toEqual([]);
    expect(faster.body).toContain("  - Keep checking: checks every 10 minutes · gives up after 3 days → checks every 5 minutes · gives up after 3 days");
    expect(publish(conversation, faster.cardIds[0]!).saved.saved).toBe(true);
    expect(stepOf(pipelineId!, "pr_watch").watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 72 });

    // Said nothing about it: still checking every five minutes.
    const renamed = turn(conversation, { message: "Renamed.", draft: { ...watchDraft({ pipelineId: pipelineId! }, undefined), name: "Watch PRs" } }, pipelineId!);
    expect(renamed.rejections).toEqual([]);
    expect(renamed.body).not.toContain("Keep checking");
    expect(publish(conversation, renamed.cardIds[0]!).saved.saved).toBe(true);
    expect(stepOf(pipelineId!, "pr_watch").watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 72 });
  });

  /**
   * Never giving up (EO-571), from a draft: on the card as old → new,
   * published as said, kept by a draft that says nothing, and back to a
   * deadline by one that names hours.
   */
  it("sets a step to never give up, says so on the card, and reads it back unchanged", async () => {
    const conversation = await openedOn("/settings");
    const created = turn(conversation, { message: "Watch.", draft: watchDraft({ newPipeline: "Watch" }, { everyMinutes: 5 }) });
    const { pipelineId } = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: created.cardIds[0]! });
    // Left out, the give-up time is a week.
    expect(stepOf(pipelineId!, "pr_watch").watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 168 });

    const never = turn(conversation, { message: "Never give up.", draft: watchDraft({ pipelineId: pipelineId! }, { everyMinutes: 5, neverGivesUp: true }) }, pipelineId!);

    expect(never.rejections).toEqual([]);
    expect(never.body).toContain("  - Keep checking: checks every 5 minutes · gives up after 7 days → checks every 5 minutes · never gives up");
    expect(publish(conversation, never.cardIds[0]!).saved.saved).toBe(true);
    expect(stepOf(pipelineId!, "pr_watch").watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true });

    // Said again as it reads, it is no change at all; said nothing about, it is kept.
    const same = turn(conversation, { message: "Same.", draft: { ...watchDraft({ pipelineId: pipelineId! }, stepOf(pipelineId!, "pr_watch").watch), name: "Watch PRs" } }, pipelineId!);
    expect(same.rejections).toEqual([]);
    expect(same.body).not.toContain("Keep checking");
    expect(publish(conversation, same.cardIds[0]!).saved.saved).toBe(true);
    expect(stepOf(pipelineId!, "pr_watch").watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true });

    // A number of hours is a deadline again, as it always was.
    const deadline = turn(conversation, { message: "A day.", draft: watchDraft({ pipelineId: pipelineId! }, { everyMinutes: 5, giveUpAfterHours: 24 }) }, pipelineId!);
    expect(deadline.body).toContain("  - Keep checking: checks every 5 minutes · never gives up → checks every 5 minutes · gives up after 24 hours");
    expect(publish(conversation, deadline.cardIds[0]!).saved.saved).toBe(true);
    expect(stepOf(pipelineId!, "pr_watch").watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 24 });
  });

  it("refuses \"off\" on a function made to be checked, naming the step", async () => {
    const conversation = await openedOn("/settings");
    const created = turn(conversation, { message: "Watch.", draft: watchDraft({ newPipeline: "Watch" }, { everyMinutes: 10 }) });
    const { pipelineId } = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: created.cardIds[0]! });

    const refused = turn(conversation, { message: "Once.", draft: watchDraft({ pipelineId: pipelineId! }, "off") }, pipelineId!);

    expect(refused.cardIds).toEqual([]);
    expect(refused.rejections.join(" ")).toContain('"Watching"');
  });
});

describe("Needs a reason on a person's result", () => {
  it("lists the change under the step, and Publish sets it on the result", async () => {
    const { conversation, pipelineId, moduleId } = await releasePipeline();
    expect(stepOf(pipelineId, "release_approve").results.find((result) => result.key === "send_back")?.requiresComment).toBe(true);

    const relaxed = turn(conversation, { message: "No reason needed.", draft: releaseDraft({ pipelineId }, moduleId, {}, [{}, { requiresComment: false }]) }, pipelineId);

    expect(relaxed.rejections).toEqual([]);
    expect(relaxed.body).toContain(["- Approve", "  - **Send back** needs a reason: yes → no"].join("\n"));
    expect(publish(conversation, relaxed.cardIds[0]!).saved.saved).toBe(true);
    expect(stepOf(pipelineId, "release_approve").results).toMatchObject([
      { key: "approve", requiresComment: false },
      { key: "send_back", requiresComment: false },
    ]);
  });

  it("refuses it on a branch out of a step nobody decides on, naming the step", async () => {
    const { conversation, pipelineId, moduleId } = await releasePipeline();
    const draft = releaseDraft({ pipelineId }, moduleId);
    draft.routes[0] = { ...draft.routes[0]!, requiresComment: true } as (typeof draft.routes)[number];

    const refused = turn(conversation, { message: "Reason.", draft }, pipelineId);

    expect(refused.cardIds).toEqual([]);
    expect(refused.rejections.join(" ")).toContain("**Merge** is not a person's step");
  });
});

describe("renaming a pipeline and changing its icon", () => {
  it("shows both on the card, and Publish applies them", async () => {
    const { conversation, pipelineId, moduleId } = await releasePipeline();

    const renamed = turn(conversation, { message: "Renamed.", draft: { ...releaseDraft({ pipelineId }, moduleId), name: "Ship it", icon: "boxes" } }, pipelineId);

    expect(renamed.rejections).toEqual([]);
    expect(renamed.body).toContain("**Renamed to** Ship it");
    expect(renamed.body).toContain("**Icon** the default → boxes");
    const { read } = publish(conversation, renamed.cardIds[0]!);
    expect(read).toMatchObject({ rename: "Ship it", icon: "boxes", restoredFrom: null });
    expect(getPipeline(handle.db, pipelineId)).toMatchObject({ name: "Ship it", icon: "boxes" });
  });

  /**
   * Review of EO-520: on a replica whose organisation publishes pipelines,
   * a diverged pipeline's graph may be saved while `pipelines:update` stays
   * locked. A draft that renames as well is refused whole, before its
   * graph is written — and one that does not is published as before.
   */
  it("refuses the whole of a draft whose rename this machine may not make, leaving the graph as it was", async () => {
    const { conversation, pipelineId, moduleId } = await releasePipeline();
    publishSection(handle.db, {
      section: "pipelines",
      subjectId: pipelineId,
      versionId: "a-version",
      versionNumber: 1,
      publishedAt: Date.now(),
      publishedBy: "dana-id",
      publishedByName: "Dana",
    });
    const stopBeingAReplica = markReplica(handle.db, () => true);
    try {
      markDiverged(handle.db, pipelineId, "a-version", Date.now());
      // The lock policy this must not change: the graph may be saved here, and the name may not.
      expect(sectionLockFor(handle.db, "pipeline:save", { pipelineId })).toBeNull();
      expect(sectionLockFor(handle.db, "pipelines:update", { id: pipelineId })).not.toBeNull();

      const both = turn(
        conversation,
        { message: "Longer, and renamed.", draft: { ...releaseDraft({ pipelineId }, moduleId, { timeoutMs: FIFTY_EIGHT_MINUTES }), name: "Ship it" } },
        pipelineId,
      );
      const read = readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: both.cardIds[0]! });

      // Nothing to send `pipeline:save`, so the renderer's Publish stops at the sentence.
      expect(read).toMatchObject({ pipelineId: null, steps: [], rename: null });
      expect(read.problem).toContain("The pipelines section is managed by your organisation. Dana published it.");
      expect(read.problem).toContain("renames the pipeline");
      expect(stepOf(pipelineId, "release_merge").timeoutMs).toBe(TEN_MINUTES);
      expect(getPipeline(handle.db, pipelineId)?.name).toBe("Release");

      // Without the rename, the diverged graph publishes as it always could.
      const tuned = turn(conversation, { message: "Longer.", draft: releaseDraft({ pipelineId }, moduleId, { timeoutMs: FIFTY_EIGHT_MINUTES }) }, pipelineId);
      expect(publish(conversation, tuned.cardIds[0]!).saved.saved).toBe(true);
      expect(stepOf(pipelineId, "release_merge").timeoutMs).toBe(FIFTY_EIGHT_MINUTES);
    } finally {
      stopBeingAReplica();
    }
  });

  it("refuses a name another pipeline on the project has", async () => {
    const { conversation, pipelineId, moduleId } = await releasePipeline();
    createPipeline(handle.db, { projectId: getPipeline(handle.db, pipelineId)!.projectId, name: "Hotfix" });

    const refused = turn(conversation, { message: "Renamed.", draft: { ...releaseDraft({ pipelineId }, moduleId), name: "hotfix" } }, pipelineId);

    expect(refused.cardIds).toEqual([]);
    expect(refused.rejections.join(" ")).toContain('already has a pipeline called "Hotfix"');
  });

  it("creates a new pipeline with the icon its draft gave it", async () => {
    setSetting(handle.db, GUARDS_KEY, { ...DEFAULT_GUARD_CONFIG, wallClockTimeoutMs: 60 * 60 * 1000 });
    const conversation = await openedOn("/settings");
    const created = turn(conversation, {
      message: "Here.",
      draft: { ...releaseDraft({ newPipeline: "Release" }, "release-merge"), icon: "database" },
      modules: [MERGE_MODULE],
    });
    expect(created.body).toContain("**Icon** database");
    approveModule(handle.db, listModules(handle.db).find((module) => module.slug === "release-merge")!.id, Date.now() + 1_000);

    const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: created.cardIds[0]! });

    expect(getPipeline(handle.db, published.pipelineId!)?.icon).toBe("database");
  });
});

describe("restoring a version", () => {
  /** A pipeline whose one person step waited on Dana at v3, named "Decide" then, and waits on Pat now. */
  function handedOver() {
    const pipeline = createPipeline(handle.db, { projectId: null, name: "Review" });
    const id = pipeline.id as Uuid;
    const graph = (decideName: string) =>
      replacePipelineGraph(
        handle.db,
        pipeline.id,
        [
          { id: "review_fix", pipelineId: id, position: 0, name: "Fix", type: "agent", ownerRole: "implementer", entryAction: "implement", isTerminal: false },
          { id: "review_decide", pipelineId: id, position: 1, name: decideName, type: "user", isTerminal: false },
          { id: "review_done", pipelineId: id, position: 2, name: "Done", type: "user", isTerminal: true },
        ],
        [
          { pipelineId: id, fromStepId: "review_fix", resultKey: "done", label: "Done", tone: "success", target: "review_decide", position: 0 },
          { pipelineId: id, fromStepId: "review_decide", resultKey: "approve", label: "Approve", tone: "success", target: "review_done", position: 0 },
        ],
        { entryStepId: "review_fix" },
      );
    const dana = createPerson(handle.db, { name: "Dana" });
    const pat = createPerson(handle.db, { name: "Pat" });
    graph("Decide first"); // v1 is the empty pipeline it replaced, v2 this
    setStepOwner(handle.db, "review_decide", { personId: dana.id, groupId: null });
    graph("Decide"); // v3, waiting on Dana
    setStepOwner(handle.db, "review_decide", { personId: pat.id, groupId: null });
    graph("Decide now"); // v4, waiting on Pat
    return { pipelineId: pipeline.id, dana, pat };
  }

  /** Version `number`'s graph, as the assistant reads it with `pipeline_versions` and writes it into a draft. */
  function versionDraft(pipelineId: string, number: number, extra: Record<string, unknown>) {
    const graph = pipelineVersionsCommand(handle.db, { pipelineId, graph: number }).graph!;
    return {
      rationale: `Back to v${number}.`,
      entryStepId: graph.entryStepId!,
      target: { pipelineId },
      steps: graph.steps.map(({ id, position, name, type, ownerRole, entryAction, instructionsSummary, isTerminal, planMode }) => ({
        id,
        position,
        name,
        type,
        ownerRole,
        entryAction,
        instructionsSummary,
        isTerminal,
        planMode,
      })),
      routes: graph.routes.map(({ fromStepId, resultKey, label, tone, target, position }) => ({ fromStepId, resultKey, label, tone, target, position })),
      ...extra,
    };
  }

  /** AC: proposed as a restore of v3, the card says so, and Publish puts back who the person step waited on. */
  it("says it restores the version, and Publish puts back who each person step waited on", async () => {
    const { pipelineId, dana } = handedOver();
    const conversation = await openedOn("/settings");

    const restored = turn(conversation, { message: "Restored.", draft: versionDraft(pipelineId, 3, { restoredFrom: 3 }) }, pipelineId);

    expect(restored.rejections).toEqual([]);
    expect(restored.body).toContain("**Restores version 3**");
    expect(restored.body).toContain("- Decide now — renamed to **Decide**");
    const { read, saved } = publish(conversation, restored.cardIds[0]!);
    expect(read.restoredFrom).toBe(3);
    expect(saved.saved).toBe(true);
    expect(getStep(handle.db, "review_decide")).toMatchObject({ name: "Decide", ownerPersonId: dana.id, ownerGroupId: null });
  });

  it("leaves who a step waits on alone when the same graph is not marked as a restore", async () => {
    const { pipelineId, pat } = handedOver();
    const conversation = await openedOn("/settings");

    const plain = turn(conversation, { message: "Back.", draft: versionDraft(pipelineId, 3, {}) }, pipelineId);

    expect(plain.body).not.toContain("Restores version");
    expect(publish(conversation, plain.cardIds[0]!).saved.saved).toBe(true);
    expect(getStep(handle.db, "review_decide")?.ownerPersonId).toBe(pat.id);
  });

  it("refuses a version the pipeline has never had", async () => {
    const { pipelineId } = handedOver();
    const conversation = await openedOn("/settings");

    const refused = turn(conversation, { message: "Restored.", draft: versionDraft(pipelineId, 3, { restoredFrom: 9 }) }, pipelineId);

    expect(refused.cardIds).toEqual([]);
    expect(refused.rejections.join(" ")).toContain("restores v9, which this pipeline has never had");
  });
});
