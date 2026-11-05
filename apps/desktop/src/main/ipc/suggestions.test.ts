import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUGGESTIONS_PIPELINE_NAME, type IpcChannel, type IpcPayload, type IpcResponse, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { markReplica } from "../db/recordRole.js";
import { pipelines } from "../db/schema.js";
import {
  createPerson,
  currentOutputOf,
  getPipeline,
  insertItemType,
  isDiverged,
  issueDevice,
  listItemsForProject,
  listPipelines,
  listPipelineVersions,
  listPublishedSections,
  listStepsForPipeline,
  openMentionsForHuman,
  publishSection,
  publishedPipelineRow,
  setPipelineVersionsToKeep,
} from "../db/repos/index.js";
import { upsertReplicaPipeline, listPipelinesUpdatedSince } from "../db/repos/projectMoveRepo.js";
import { sectionLockFor } from "../managed/locks.js";
import type { ManagedDirectory } from "../managed/directory.js";
import { savePipeline } from "./configCommands.js";
import { claimItem, decideItem } from "./domainCommands.js";
import { listPipelineStepViews } from "./domainQueries.js";
import { pipelineVersionsCommand } from "./pipelineCommands.js";
import { publishSectionCommand } from "./sectionCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";
import { createSuggestionCommand, discardEditsCommand, divergenceCommand, suggestChangeCommand, suggestionDetailCommand } from "./suggestionCommands.js";
import { TOOLS, type Dispatch } from "../mcpHost/catalog.js";
import { loadRolePrompt } from "../roles/prompts.js";

/**
 * A change suggested from a desktop, and what an admin does with it
 * (EO-331, `ARCHITECTURE.md`, "Divergence and suggestions").
 *
 * Two databases, because the story is about two machines: a desktop
 * whose organisation manages its pipelines, and the record it is signed
 * in to. The wire between them is a stub of `ServerClient.request` that
 * calls the record's own handler — which is exactly what the HTTP door
 * does, minus the socket, and keeps the acceptance criterion's "creates
 * one item on the server" a statement about the server's rows.
 *
 * The sync is stubbed the same way and for the same reason: `drain.ts`
 * applies a publication and then the graph it published, so the two
 * functions it calls are the two called here.
 */

let device: DbHandle;
let record: DbHandle;
let stopBeingAReplica: (() => void) | null = null;
let anna: string;
let annasDevice: string;
let dana: string;
let danasDevice: string;

/** The options `registerAllHandlers` builds, including the payload the lock now reads (EO-331). */
const opts = () => ({
  exposeErrorDetails: true,
  sectionLock: (channel: IpcChannel, payload: unknown) => sectionLockFor(device.db, channel, payload),
});

const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);

function tool(name: string) {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

/**
 * The organisation's server, as this desktop reaches it.
 *
 * `suggestions:create` is the one channel a suggestion sends, and the
 * door stamps the asking device onto it — so the stub does too, which
 * is what makes the item on the far side carry an author.
 */
const managed = {
  client: () => ({
    request: async (channel: string, payload: unknown) => {
      if (channel !== "suggestions:create") throw new Error(`unexpected channel ${channel}`);
      const input = { ...(payload as IpcPayload<"suggestions:create">), actingDeviceId: annasDevice };
      return await Promise.resolve({ ok: true as const, data: createSuggestionCommand(record.db, input) });
    },
  }),
} as unknown as ManagedDirectory;

const context = () => ({ managed, moduleSecrets: { directory: "", store: nothingStored }, signedInBackends: [] as string[] });

/** A keychain that holds nothing, for the preflight the needs list is read from. */
const nothingStored = { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" };

/** The graph as it stands on a machine, ready to go back through `pipeline:save`. */
function graphOf(handle: DbHandle, pipelineId = "default"): IpcPayload<"pipeline:save"> {
  const graph = listPipelineStepViews(handle.db, { pipelineId });
  return { pipelineId, steps: graph.steps, routes: graph.routes, entryStepId: graph.entryStepId };
}

/** What the sync does: the publication first, then the graph it published. */
function syncPublishedPipelines(to: DbHandle): void {
  for (const row of listPublishedSections(record.db)) {
    publishSection(to.db, {
      section: row.section,
      subjectId: row.subjectId,
      versionId: row.versionId,
      versionNumber: row.versionNumber,
      publishedAt: row.publishedAt,
      publishedBy: row.publishedBy,
      publishedByName: row.publishedByName,
      document: row.document,
    });
  }
  for (const pipeline of listPipelinesUpdatedSince(record.db, { ts: 0, id: "" }, 100)) {
    upsertReplicaPipeline(to.db, pipeline);
  }
}

/** The name a step carries on a machine, which is what every assertion here is about. */
function stepName(handle: DbHandle, stepId: string, pipelineId = "default"): string | undefined {
  return listStepsForPipeline(handle.db, pipelineId).find((step) => step.id === stepId)?.name;
}

/** Anna edits her own copy, which she may because she has diverged it. */
async function renameOnTheDesktop(to: string): Promise<IpcResponse<"pipeline:save">> {
  const graph = graphOf(device);
  const answer = await dispatchIpc("pipeline:save", {
    ...graph,
    steps: graph.steps.map((step) => (step.id === "review" ? { ...step, name: to } : step)),
  });
  if (!answer.ok) throw new Error(`the save was refused: ${answer.error.message}`);
  return answer.data as IpcResponse<"pipeline:save">;
}

/** Every suggestion the record holds, newest last. */
function suggestions() {
  const place = listPipelines(record.db).find((pipeline) => pipeline.name === SUGGESTIONS_PIPELINE_NAME);
  if (place === undefined) return [];
  return listItemsForProject(record.db, null)
    .concat(listItemsForProject(record.db, listPipelines(record.db)[0]?.projectId as Uuid | null))
    .filter((item, index, all) => item.pipelineId === place.id && all.findIndex((other) => other.id === item.id) === index);
}

beforeEach(() => {
  device = openMigratedTestDb();
  record = openMigratedTestDb();

  anna = createPerson(record.db, { name: "Anna" }).id;
  dana = createPerson(record.db, { name: "Dana", isAdmin: true }).id;
  annasDevice = issueDevice(record.db, { personId: anna, name: "Anna's laptop", tokenHash: "anna", secretsKeyHash: null }).id;
  danasDevice = issueDevice(record.db, { personId: dana, name: "Dana's laptop", tokenHash: "dana", secretsKeyHash: null }).id;

  // The organisation publishes its pipelines, and the desktop receives
  // them: the world every screen in this story is drawn in.
  publishSectionCommand(record.db, { section: "pipelines", pipelineId: null, versionNumber: null, actingDeviceId: danasDevice });
  syncPublishedPipelines(device);
  stopBeingAReplica = markReplica(device.db, () => true);

  registerHandler("pipeline:save", (payload) => savePipeline(device.db, undefined, payload), opts());
  registerHandler("pipelines:suggest", async (payload) => suggestChangeCommand(device.db, context(), payload), opts());
});

afterEach(() => {
  stopBeingAReplica?.();
  stopBeingAReplica = null;
  clearHandlerRegistry();
  device.close();
  record.close();
});

describe("suggesting a change from a desktop", () => {
  it("refuses the save until the copy is the person's, and then allows it", async () => {
    // The lock as EO-329 left it: the section is published, so the
    // graph is not this machine's to write.
    const refused = await dispatchIpc("pipeline:save", graphOf(device));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("section-locked");

    // *Suggest a change* opens the editable copy (ARCHITECTURE.md, "Divergence and suggestions"),
    // which is what
    // makes the next save the person's own rather than a way round the
    // lock.
    await dispatchIpc("pipelines:suggest", { pipelineId: "default" });
    expect(isDiverged(device.db, "default")).toBe(true);

    await renameOnTheDesktop("Second opinion");
    expect(stepName(device, "review")).toBe("Second opinion");

    // And the section is no less locked for it: a pipeline nobody
    // diverged, and every other write the section covers, still refuse.
    expect(sectionLockFor(device.db, "pipeline:save", { pipelineId: "somebody-elses" })).not.toBeNull();
    expect(sectionLockFor(device.db, "pipelines:create", { pipelineId: "default" })).not.toBeNull();
    expect(sectionLockFor(device.db, "pipeline:save", { pipelineId: "default" })).toBeNull();
  });

  it("creates one item on the server, with the diff the admin reads", async () => {
    await dispatchIpc("pipelines:suggest", { pipelineId: "default" });
    await renameOnTheDesktop("Second opinion");
    const answer = (await dispatchIpc("pipelines:suggest", { pipelineId: "default" })) as { ok: true; data: IpcResponse<"pipelines:suggest"> };

    expect(answer.ok).toBe(true);
    expect(answer.data.suggested).toBe(true);
    expect(answer.data.itemKey).not.toBeNull();

    // One item per suggestion, on the internal pipeline the design describes,
    // waiting on its one human step.
    const filed = suggestions();
    expect(filed.length).toBe(2);
    const newest = filed[filed.length - 1]!;
    expect(newest.id).toBe(answer.data.itemId);
    expect(newest.createdBy).toBe(anna);

    // Its output *is* the document (ARCHITECTURE.md, "Divergence and suggestions"), so the thread
    // holds the
    // whole of what is being decided about.
    expect(currentOutputOf(record.db, newest.id as Uuid)?.body).toContain("Second opinion");

    // And the admin's screen is a diff against what is published now.
    const detail = suggestionDetailCommand(record.db, context(), { itemId: newest.id });
    expect(detail.suggestion?.pipelineName).toBe("Delivery");
    expect(detail.suggestion?.author).toBe("Anna");
    expect(detail.suggestion?.problem).toBeNull();
    expect(detail.suggestion?.diff?.steps).toContainEqual({
      stepId: "review",
      name: "Second opinion",
      change: "changed",
      fields: [{ field: "name", before: "Review", after: "Second opinion" }],
    });
  });

  it("produces the same item whether the person pressed the button or the assistant did it", async () => {
    // "The assistant's suggestion path produces the same item as the
    // button" — and the way to be sure is that there is one path: the
    // tool names the channel the button calls, through the registry
    // both doors share.
    await dispatchIpc("pipelines:suggest", { pipelineId: "default" });
    await renameOnTheDesktop("Second opinion");
    const byHand = suggestions()[0]!;

    const outcome = await tool("pipeline_suggest").run(dispatch, { pipelineId: "default" });
    expect(outcome.ok).toBe(true);

    const filed = suggestions();
    expect(filed.length).toBe(2);
    const byTheAssistant = filed[1]!;
    expect(byTheAssistant.title).toBe(byHand.title);
    expect(byTheAssistant.stepId).toBe(byHand.stepId);
    expect(byTheAssistant.pipelineId).toBe(byHand.pipelineId);
    expect(byTheAssistant.createdBy).toBe(anna);
    expect(currentOutputOf(record.db, byTheAssistant.id as Uuid)?.body).toContain("Second opinion");
  });

  it("says nothing was suggested where there is nobody to suggest it to", async () => {
    const alone = await suggestChangeCommand(device.db, { ...context(), managed: undefined as unknown as ManagedDirectory }, {
      pipelineId: "default",
    });

    expect(alone.suggested).toBe(false);
    expect(alone.problem).toContain("not signed in to an organisation server");
  });
});

describe("the admin deciding on one", () => {
  let suggestion: string;

  /**
   * Dana takes the suggestion before she decides on it (EO-368). It waits
   * on the Admins group, and on a step that waits on a group only the
   * person holding the item decides — an unclaimed one is claimed first.
   */
  const decide = (input: Omit<IpcPayload<"items:decide">, "actingDeviceId">) => {
    claimItem(record.db, { itemId: input.itemId, actingDeviceId: danasDevice });
    return decideItem(record.db, undefined, { ...input, actingDeviceId: danasDevice });
  };

  beforeEach(async () => {
    await dispatchIpc("pipelines:suggest", { pipelineId: "default" });
    await renameOnTheDesktop("Second opinion");
    await dispatchIpc("pipelines:suggest", { pipelineId: "default" });
    suggestion = suggestions()[1]!.id;
  });

  it("publishes the next version on Approve, and devices receive it", () => {
    const before = publishedPipelineRow(record.db, "default")?.versionNumber ?? 0;

    const decided = decide({ itemId: suggestion, resultKey: "approved", comment: "" });

    expect(decided.decided).toBe(true);
    expect(decided.problem).toBeNull();
    // Applied to the record's own graph, as a version of it.
    expect(stepName(record, "review")).toBe("Second opinion");
    const numbers = listPipelineVersions(record.db, "default").map((version) => version.number);
    expect(Math.max(...numbers)).toBe(before + 1);
    // And published, which is what makes it everybody's.
    expect(publishedPipelineRow(record.db, "default")?.versionNumber).toBe(before + 1);

    // A second desktop, which diverged nothing, takes it on its next
    // sync — the whole point of approving rather than merely applying.
    const other = openMigratedTestDb();
    const stop = markReplica(other.db, () => true);
    try {
      syncPublishedPipelines(other);
      expect(stepName(other, "review")).toBe("Second opinion");
      expect(publishedPipelineRow(other.db, "default")?.versionNumber).toBe(before + 1);
    } finally {
      stop();
      other.close();
    }
  });

  it("keeps the record's history to its limit as suggestions are approved (EO-359)", async () => {
    setPipelineVersionsToKeep(record.db, 2);
    const approve = (itemId: string) => decide({ itemId, resultKey: "approved", comment: "" });

    expect(approve(suggestion).decided).toBe(true);
    for (const name of ["Third look", "Fourth look", "Fifth look"]) {
      await renameOnTheDesktop(name);
      await dispatchIpc("pipelines:suggest", { pipelineId: "default" });
      expect(approve(suggestions().at(-1)!.id).decided).toBe(true);
    }

    expect(stepName(record, "review")).toBe("Fifth look");
    const numbers = listPipelineVersions(record.db, "default").map((version) => version.number);
    // The two newest, and nothing else: the published one is the newest,
    // and no item on the record is bound to an older one.
    expect(numbers).toHaveLength(2);
    expect(numbers[1]).toBe(publishedPipelineRow(record.db, "default")?.versionNumber);
    expect(numbers[0]).toBe(numbers[1]! - 1);
  });

  it("reaches the author's inbox when it is sent back", () => {
    const decided = decide({
      itemId: suggestion,
      resultKey: "changes",
      comment: "Why did you drop the review step?",
    });

    expect(decided.decided).toBe(true);
    // Comments are the only channel (invariant #4), and a mention is
    // what makes one an inbox entry.
    const inbox = openMentionsForHuman(record.db, anna as Uuid);
    expect(inbox.some((row) => row.comment.body.includes("Why did you drop the review step?"))).toBe(true);
    // And nothing was published: a send-back changes no graph.
    expect(stepName(record, "review")).toBe("Review");
    expect(publishedPipelineRow(record.db, "default")?.versionNumber).toBe(1);
  });

  it("shows the entry rules a suggestion carries on its diff, publishes them, and refuses ones this server cannot answer (EO-610)", async () => {
    const save = await dispatchIpc("pipeline:save", { ...graphOf(device), entryRules: [{ kind: "description" }] });
    expect(save.ok).toBe(true);
    await dispatchIpc("pipelines:suggest", { pipelineId: "default" });
    const carrying = suggestions().at(-1)!.id;

    expect(suggestionDetailCommand(record.db, context(), { itemId: carrying }).suggestion?.diff?.entryRules).toEqual({ before: "none", after: "a description" });
    expect(decide({ itemId: carrying, resultKey: "approved", comment: "" }).decided).toBe(true);
    expect(getPipeline(record.db, "default")?.entryRules).toEqual([{ kind: "description" }]);

    // A type the desktop has and this server does not.
    insertItemType(device.db, null, { packSlug: "local", slug: "case", label: "Case", plural: "Cases", container: false, specShape: { type: "object", properties: {}, required: [] }, actionOverrides: {} });
    const again = await dispatchIpc("pipeline:save", { ...graphOf(device), entryRules: [{ kind: "description", types: ["local:case"] }] });
    expect(again.ok).toBe(true);
    await dispatchIpc("pipelines:suggest", { pipelineId: "default" });

    const refused = decide({ itemId: suggestions().at(-1)!.id, resultKey: "approved", comment: "" });
    expect(refused.decided).toBe(false);
    expect(refused.problem).toContain('"local:case"');
  });

  it("refuses to approve a change this server cannot apply, before anything is written", () => {
    // The pipeline it changes has gone. Approving would be publishing a
    // graph with nowhere to put it, and an admin meets that on the
    // button rather than in a thread afterwards.
    const detailBefore = suggestionDetailCommand(record.db, context(), { itemId: suggestion });
    expect(detailBefore.suggestion?.problem).toBeNull();

    record.db.run(sql`delete from ${pipelines} where ${pipelines.id} = 'default'`);

    const decided = decide({ itemId: suggestion, resultKey: "approved", comment: "" });
    expect(decided.decided).toBe(false);
    expect(decided.problem).toContain("not on this server any more");
  });
});

describe("a pipeline this machine diverged", () => {
  beforeEach(async () => {
    await dispatchIpc("pipelines:suggest", { pipelineId: "default" });
    await renameOnTheDesktop("Second opinion");
  });

  it("is never overwritten by a publish, and still hears about the versions", () => {
    // The organisation publishes something else entirely, as a version
    // of its own.
    const theirs = graphOf(record);
    savePipeline(record.db, undefined, {
      ...theirs,
      steps: theirs.steps.map((step) => (step.id === "review" ? { ...step, name: "Dana's review" } : step)),
    });
    publishSectionCommand(record.db, { section: "pipelines", pipelineId: null, versionNumber: null, actingDeviceId: danasDevice });

    syncPublishedPipelines(device);

    // "Updates stop applying silently" (ARCHITECTURE.md, "Divergence and suggestions"): the
    // person's own words
    // are still on their own screen.
    expect(stepName(device, "review")).toBe("Second opinion");
    // And the history arrived anyway, which is what Compare and
    // Discard read.
    expect(listPipelineVersions(device.db, "default").length).toBeGreaterThan(1);
    // The line the screens draw says both halves.
    const state = divergenceCommand(device.db, { pipelineId: "default" });
    expect(state.diverged).toBe(true);
    expect(state.line).toContain("Edited locally");
    expect(state.available).toBe(publishedPipelineRow(record.db, "default")?.versionNumber);
  });

  it("files no version of its own, because that history is the organisation's", () => {
    // A desktop filing its own v2 would be claiming a publish nobody
    // made, and would collide with the record's v2 the moment it
    // arrives.
    expect(listPipelineVersions(device.db, "default").map((version) => version.number)).toEqual([1]);
  });

  it("shows the person their own edit, which no version holds", () => {
    // The design's first action. The history cannot answer this and never
    // will: a diverged copy files no version, so in the ordinary case
    // this machine holds exactly one and the version diff is null —
    // which is what *Compare* used to draw over a graph somebody had
    // just rewritten.
    const answer = pipelineVersionsCommand(device.db, { pipelineId: "default" });

    expect(answer.versions.length).toBe(1);
    expect(answer.diff).toBeNull();
    expect(answer.local?.basedOn).toBe(publishedPipelineRow(device.db, "default")?.versionNumber);
    expect(answer.local?.diff.steps).toContainEqual({
      stepId: "review",
      name: "Second opinion",
      change: "changed",
      fields: [{ field: "name", before: "Review", after: "Second opinion" }],
    });
  });

  it("says nothing about local edits on a pipeline nobody here has diverged", () => {
    // The other half, and the one that keeps this off every ordinary
    // screen: a pipeline nobody diverged has no local half to draw, on
    // a desktop or on a server.
    discardEditsCommand(device.db, { pipelineId: "default" });

    expect(pipelineVersionsCommand(device.db, { pipelineId: "default" }).local).toBeNull();
    expect(pipelineVersionsCommand(record.db, { pipelineId: "default" }).local).toBeNull();
  });

  it("goes back to the published version when the edits are discarded", () => {
    const discarded = discardEditsCommand(device.db, { pipelineId: "default" });

    expect(discarded.discarded).toBe(true);
    expect(discarded.version).toBe(publishedPipelineRow(device.db, "default")?.versionNumber);
    expect(stepName(device, "review")).toBe("Review");
    expect(isDiverged(device.db, "default")).toBe(false);
    expect(divergenceCommand(device.db, { pipelineId: "default" }).line).toBeNull();
    // And the lock binds again, which is what un-diverging means.
    expect(sectionLockFor(device.db, "pipeline:save", { pipelineId: "default" })).not.toBeNull();
  });

  it("refuses to discard what was never edited here", () => {
    const other = getPipeline(device.db, "default");
    expect(other).toBeDefined();
    discardEditsCommand(device.db, { pipelineId: "default" });

    const again = discardEditsCommand(device.db, { pipelineId: "default" });
    expect(again.discarded).toBe(false);
    expect(again.problem).toContain("nothing to discard");
  });
});

describe("what the assistant is told about a lock", () => {
  it("names the one route out of it, and whose decision it is", () => {
    // "The assistant, told a section is locked, offers to draft the
    // change as a suggestion and, on yes, does exactly what the button
    // does" — so the prompt has to name the tool that is the button,
    // and has to say that the offer is an offer.
    const prompt = loadRolePrompt("system") ?? "";

    expect(prompt).toContain("pipeline_suggest");
    expect(prompt).toContain("only if they say yes");
    // And the state it leaves the machine in, because a person told
    // "sent" and not "your organisation's updates have stopped applying
    // to this pipeline" has been told half of it.
    expect(prompt).toContain("edited locally");
    // For the other four sections there is still nothing to offer, and
    // the prompt must not send the assistant looking for a tool that
    // does not exist.
    expect(prompt).toContain("For the other four sections there is no suggestion");
  });

  it("is offered as a tool that goes through the same channel the button does", () => {
    expect(TOOLS.find((candidate) => candidate.name === "pipeline_suggest")?.channels).toEqual(["pipelines:suggest"]);
  });
});
