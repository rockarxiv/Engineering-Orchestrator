import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscussionOutput, DiscussionProposal, IpcPayload, Item, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import {
  addDependency,
  createProject,
  createRun,
  getItem,
  listAgents,
  listCommentsForItem,
  listDependencies,
  setDependencyGate,
  setItemAssignee,
  updateItem,
  updateRun,
} from "../db/repos/index.js";
import { saveGroup } from "../db/repos/groupsRepo.js";
import { createStep, setStepOwner } from "../db/repos/pipelineStepsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "../ipc/registry.js";
import { updateItemCommand } from "../ipc/itemAttachmentCommands.js";
import { answerToolCall } from "../mcpHost/server.js";
import { fakePlatform } from "../testing/platform.js";
import { updateItemFields } from "../ipc/domainCommands.js";
import { getItemDetail } from "../ipc/domainQueries.js";
import { approveWorkProposalThroughRecord } from "../ipc/conversationTurns.js";
import { openAssistConversation, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { createLocalRecord } from "./localRecord.js";
import { serveChangeDependencies, serveChanges, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * What an item waits for, on a project the organisation holds (EO-600,
 * ARCHITECTURE.md, "The record").
 *
 * The edges are the record's: its scheduler reads them, and a cycle is a
 * question about its whole graph. So `items:update` on a desktop asks
 * the record, which makes the change and answers with it, and these
 * tests look at the *record's* database for what changed.
 */

interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
  online: boolean;
}

let recordDb: DbHandle;
let serving: ServeRecordContext;
let anna: Desktop;
let annaPersonId: Uuid;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eo dependency change record "));
  recordDb = openMigratedTestDb();
  serving = {
    db: recordDb.db,
    record: createLocalRecord(recordDb.db),
    attachments: new AttachmentStorage(join(root, "record-files")),
    offerWork: async () => [],
  };
  const person = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" });
  annaPersonId = person.id;
  const deviceId = issueDevice(recordDb.db, { personId: person.id, name: "anna-desk", tokenHash: "h1", secretsKeyHash: null }).id;
  anna = desktop(openMigratedTestDb(), deviceId);
});

afterEach(() => {
  anna.record.stop();
  anna.handle.close();
  recordDb.close();
  rmSync(root, { recursive: true, force: true });
});

function desktop(handle: DbHandle, deviceId: string): Desktop {
  const machine: Desktop = { handle, online: true, record: undefined as unknown as DeviceRecord };
  const transport: RecordTransport = {
    async request(channel, payload) {
      if (!machine.online) return { ok: false, error: { message: "EO could not reach https://eo.example: fetch failed" } };
      // Stamped at the server's door with the device the credential is
      // for (`withDeviceIdentity`), whatever the payload said.
      if (channel === "record:changeDependencies") {
        return { ok: true, data: (await serveChangeDependencies(serving, { ...(payload as IpcPayload<"record:changeDependencies">), deviceId })) as never };
      }
      if (channel === "record:changes") return { ok: true, data: serveChanges(serving, payload as IpcPayload<"record:changes">) as never };
      return { ok: false, error: { message: `EO has no channel called "${channel}".` } };
    },
  };
  machine.record = createDeviceRecord({ db: handle.db, deviceId: () => deviceId, transport: () => transport, pullPageSize: 500 });
  return machine;
}

/** Two items on a project the record holds, pulled down to Anna's desktop. */
async function organisationItems(): Promise<{ release: Item; story: Item }> {
  const project = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP", managed: true });
  const release = createTestItem(recordDb.db, { type: "story", title: "Release 2.4", stepId: "todo", projectId: project.id });
  const story = createTestItem(recordDb.db, { type: "story", title: "Rate limit the import", stepId: "todo", projectId: project.id });
  await anna.record.sync();
  if (getItem(anna.handle.db, release.id) === undefined || getItem(anna.handle.db, story.id) === undefined) throw new Error("the items did not reach the desktop");
  return { release, story };
}

const dependsOn = (handle: DbHandle, item: Item): string[] => listDependencies(handle.db, item.id).map((edge) => edge.dependsOnId as string);
const gatesOf = (handle: DbHandle, item: Item) =>
  listDependencies(handle.db, item.id).map((edge) => ({ dependsOnId: edge.dependsOnId as string, wait: edge.wait, waitStepId: edge.waitStepId }));

describe("a project the organisation holds", () => {
  it("has the change made by the record, filed under the person who asked, and copied into the desktop", async () => {
    const { release, story } = await organisationItems();

    const answer = await updateItemFields(anna.handle.db, anna.record, { itemId: release.id, addDependsOn: [story.key] });

    expect(answer).toEqual({ updated: true, problem: null, dependencies: { added: [story.key], removed: [], stillWaitsFor: [story.key], freed: false } });
    expect(dependsOn(recordDb, release)).toEqual([story.id]);
    expect(dependsOn(anna.handle, release)).toEqual([story.id]);
    const onTheRecord = listCommentsForItem(recordDb.db, release.id).filter((comment) => comment.authorType === "engine");
    expect(onTheRecord).toHaveLength(1);
    expect(onTheRecord[0]?.body).toContain(`What ${release.key} waits for was changed by Anna.`);
    // The same comment, copied rather than written again.
    expect(listCommentsForItem(anna.handle.db, release.id).map((comment) => comment.id)).toContain(onTheRecord[0]?.id);
  });

  it("removes on the record too, and the next pull agrees", async () => {
    const { release, story } = await organisationItems();
    addDependency(recordDb.db, release.id as Uuid, story.id as Uuid);

    const answer = await updateItemFields(anna.handle.db, anna.record, { itemId: release.id, removeDependsOn: [story.key] });
    await anna.record.sync();

    expect(answer.dependencies).toMatchObject({ removed: [story.key], freed: true });
    expect(dependsOn(recordDb, release)).toEqual([]);
    expect(dependsOn(anna.handle, release)).toEqual([]);
  });

  it("changes nothing when the record refuses, and answers in its words", async () => {
    const { release } = await organisationItems();

    const answer = await updateItemFields(anna.handle.db, anna.record, { itemId: release.id, addDependsOn: [release.key] });

    expect(answer).toEqual({ updated: false, problem: `${release.key} cannot depend on itself.` });
    expect(dependsOn(recordDb, release)).toEqual([]);
  });

  it("sets a rule on a new edge on the record, resolving the step there, and the desktop shows the gate (EO-778)", async () => {
    const { release, story } = await organisationItems();

    const answer = await updateItemFields(anna.handle.db, anna.record, { itemId: release.id, addDependsOn: [{ item: story.key, wait: "reached", step: "Review" }] });

    expect(answer).toEqual({ updated: true, problem: null, dependencies: { added: [story.key], removed: [], stillWaitsFor: [story.key], freed: false } });
    expect(gatesOf(recordDb, release)).toEqual([{ dependsOnId: story.id, wait: "reached", waitStepId: "review" }]);
    expect(gatesOf(anna.handle, release)).toEqual([{ dependsOnId: story.id, wait: "reached", waitStepId: "review" }]);
    // The item page on the desktop reads its replica.
    expect(getItemDetail(anna.handle.db, { itemId: release.id })?.dependsOn).toEqual([
      expect.objectContaining({ key: story.key, wait: "reached", waitStepId: "review", waitStepName: "Review" }),
    ]);
    const said = listCommentsForItem(recordDb.db, release.id).filter((comment) => comment.authorType === "engine");
    expect(said).toHaveLength(1);
    expect(said[0]?.body).toContain(`waits for ${story.key} (${story.title}) to reach Review`);
  });

  it("changes the rule of an edge the record has with updateDependsOn, and the desktop reflects it after the answer (EO-778)", async () => {
    const { release, story } = await organisationItems();
    addDependency(recordDb.db, release.id as Uuid, story.id as Uuid);
    updateItem(recordDb.db, release.id as Uuid, {});
    await anna.record.sync();
    expect(gatesOf(anna.handle, release)).toEqual([{ dependsOnId: story.id, wait: "finished", waitStepId: null }]);

    const answer = await updateItemFields(anna.handle.db, anna.record, { itemId: release.id, updateDependsOn: [{ item: story.key, wait: "none" }] });

    expect(answer).toEqual({
      updated: true,
      problem: null,
      dependencies: { added: [], removed: [], updated: [story.key], stillWaitsFor: [], freed: true },
    });
    expect(gatesOf(recordDb, release)).toEqual([{ dependsOnId: story.id, wait: "none", waitStepId: null }]);
    expect(gatesOf(anna.handle, release)).toEqual([{ dependsOnId: story.id, wait: "none", waitStepId: null }]);
    const said = listCommentsForItem(recordDb.db, release.id).filter((comment) => comment.authorType === "engine");
    expect(said[0]?.body).toContain(`links to ${story.key} (${story.title}) without waiting for it`);
    expect(listCommentsForItem(anna.handle.db, release.id).map((comment) => comment.id)).toContain(said[0]?.id);
  });

  it("is refused by the record for a step the dependency's pipeline does not have, naming the steps it has, and nothing is written", async () => {
    const { release, story } = await organisationItems();

    const answer = await updateItemFields(anna.handle.db, anna.record, { itemId: release.id, addDependsOn: [{ item: story.key, wait: "reached", step: "Nowhere" }] });

    expect(answer.updated).toBe(false);
    expect(answer.problem).toContain(`${story.key}'s pipeline has no step "Nowhere"`);
    expect(answer.problem).toContain('"Review"');
    expect(dependsOn(recordDb, release)).toEqual([]);
    expect(dependsOn(anna.handle, release)).toEqual([]);
  });

  it("brings a rule set or changed on the record down with the next pull", async () => {
    const { release, story } = await organisationItems();
    addDependency(recordDb.db, release.id as Uuid, story.id as Uuid, { wait: "reached", stepId: "review" });
    updateItem(recordDb.db, release.id as Uuid, {});
    await anna.record.sync();
    expect(gatesOf(anna.handle, release)).toEqual([{ dependsOnId: story.id, wait: "reached", waitStepId: "review" }]);

    setDependencyGate(recordDb.db, release.id as Uuid, story.id as Uuid, { wait: "none" });
    updateItem(recordDb.db, release.id as Uuid, {});
    await anna.record.sync();
    expect(gatesOf(anna.handle, release)).toEqual([{ dependsOnId: story.id, wait: "none", waitStepId: null }]);
  });

  it("changes nothing anywhere when the record cannot be reached, and says why", async () => {
    const { release, story } = await organisationItems();
    anna.online = false;

    const answer = await updateItemFields(anna.handle.db, anna.record, { itemId: release.id, addDependsOn: [story.key] });

    expect(answer.updated).toBe(false);
    expect(answer.problem).toMatch(/belongs to your organisation's record, which could not be reached, so what it waits for was not changed/);
    expect(dependsOn(recordDb, release)).toEqual([]);
    expect(dependsOn(anna.handle, release)).toEqual([]);
    expect(listCommentsForItem(recordDb.db, release.id).filter((comment) => comment.authorType === "engine")).toHaveLength(0);
  });

  it("changes no rule anywhere when the record cannot be reached, and says why", async () => {
    const { release, story } = await organisationItems();
    addDependency(recordDb.db, release.id as Uuid, story.id as Uuid);
    updateItem(recordDb.db, release.id as Uuid, {});
    await anna.record.sync();
    anna.online = false;

    for (const request of [{ addDependsOn: [{ item: release.key, wait: "none" as const }] }, { updateDependsOn: [{ item: story.key, wait: "reached" as const, step: "Review" }] }]) {
      const answer = await updateItemFields(anna.handle.db, anna.record, { itemId: release.id, ...request });

      expect(answer.updated).toBe(false);
      expect(answer.problem).toMatch(/could not be reached, so what it waits for was not changed/);
    }
    expect(gatesOf(recordDb, release)).toEqual([{ dependsOnId: story.id, wait: "finished", waitStepId: null }]);
    expect(gatesOf(anna.handle, release)).toEqual([{ dependsOnId: story.id, wait: "finished", waitStepId: null }]);
    expect(listCommentsForItem(recordDb.db, release.id).filter((comment) => comment.authorType === "engine")).toHaveLength(0);
  });

  /**
   * Through the external MCP host, which stamps `pathsFrom` on every
   * `items:update` (EO-704): the grant is not an edit, so a call that
   * only changes the edges still goes to the record — and one that also
   * names a file to add is still refused, naming it.
   */
  it("makes a dependency-only change asked through the external MCP host, and refuses one that also adds a file", async () => {
    const { release, story } = await organisationItems();
    const storage = new AttachmentStorage(join(root, "anna-files"));
    registerHandler("items:update", (payload) => updateItemCommand(anna.handle.db, anna.record, payload, storage), { exposeErrorDetails: true });
    try {
      const text = async (args: Record<string, unknown>) =>
        ((await answerToolCall({ name: "item_update", arguments: { itemId: release.id, ...args } }, "external", false)).content[0] as { text: string }).text;

      const withFile = await text({ addDependsOn: [story.key], paths: [join(root, "mock.png")] });
      expect(withFile).toContain("`paths`");
      expect(dependsOn(recordDb, release)).toEqual([]);

      await text({ addDependsOn: [story.key] });
      expect(dependsOn(recordDb, release)).toEqual([story.id]);
      expect(dependsOn(anna.handle, release)).toEqual([story.id]);
    } finally {
      clearHandlerRegistry();
    }
  });

  it("refuses a change that also edits other fields, since the two would land on two machines", async () => {
    const { release, story } = await organisationItems();

    const answer = await updateItemFields(anna.handle.db, anna.record, { itemId: release.id, title: "Release 2.5", addDependsOn: [story.key] });

    expect(answer.updated).toBe(false);
    expect(answer.problem).toContain("`title`");
    expect(getItem(anna.handle.db, release.id)?.title).toBe("Release 2.4");
    expect(dependsOn(recordDb, release)).toEqual([]);
  });
});

/**
 * The assistant chat's reorder card, approved on Anna's desktop about an
 * item the record holds. The same shared change as `items:update`'s, made
 * by the record rather than on the replica.
 */
describe("a reorder card about an item the organisation holds", () => {
  /** One assistant turn on Anna's desktop proposing `proposal`, and the card it posted. */
  function cardFor(proposal: DiscussionProposal): { conversation: Item; cardId: Uuid } {
    const db = anna.handle.db;
    const conversation = openAssistConversation(db, null);
    const agent = listAgents(db).find((candidate) => candidate.role === "system")!;
    const output: DiscussionOutput = { message: "Reordering.", questions: [], proposals: [proposal] };
    const run = createRun(db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION });
    updateRun(db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });
    postAssistReply(db, conversation, agent.id, run.id, output);
    const card = listCommentsForItem(db, conversation.id).find((comment) => comment.runId === run.id && comment.kind === PROPOSAL_KIND);
    if (card === undefined) throw new Error("the card was not posted");
    return { conversation, cardId: card.id };
  }

  const underTheCard = (conversation: Item, cardId: Uuid) => listCommentsForItem(anna.handle.db, conversation.id).filter((comment) => comment.parentId === cardId);

  it("is applied by the record, with its comment, and copied into the desktop", async () => {
    const { release, story } = await organisationItems();
    const { conversation, cardId } = cardFor({ action: "reorder", item: release.key, why: "the release ships the story", add_depends_on: [story.key], remove_depends_on: [] });

    const applied = await approveWorkProposalThroughRecord(anna.handle.db, undefined, anna.record, conversation, cardId);

    expect(applied).toMatchObject({ applied: true, problem: null, changedKeys: [release.key] });
    expect(dependsOn(recordDb, release)).toEqual([story.id]);
    expect(dependsOn(anna.handle, release)).toEqual([story.id]);
    const said = listCommentsForItem(recordDb.db, release.id).filter((comment) => comment.authorType === "engine");
    expect(said).toHaveLength(1);
    expect(said[0]?.body).toContain("Reordered from a conversation by Anna: the release ships the story");
    expect(underTheCard(conversation, cardId).map((comment) => comment.kind)).toEqual(["approval"]);
  });

  it("is sent to the record by the channels the app calls, assist:approve and items:update", async () => {
    const { release, story } = await organisationItems();
    const platform = fakePlatform();
    const { registerAllHandlers } = await import("../ipc/handlers.js");
    registerAllHandlers(anna.handle.db, undefined, { platform, record: anna.record });
    try {
      const { conversation, cardId } = cardFor({ action: "reorder", item: release.key, why: "w", add_depends_on: [story.key], remove_depends_on: [] });
      const approved = await dispatchIpc("assist:approve", { conversationId: conversation.id, messageId: cardId });
      expect(approved).toMatchObject({ ok: true, data: { applied: true, changedKeys: [release.key] } });
      expect(dependsOn(recordDb, release)).toEqual([story.id]);

      const updated = await dispatchIpc("items:update", { itemId: release.id, removeDependsOn: [story.key] });
      expect(updated).toMatchObject({ ok: true, data: { updated: true, dependencies: { removed: [story.key], freed: true } } });
      expect(dependsOn(recordDb, release)).toEqual([]);
    } finally {
      clearHandlerRegistry();
      rmSync(platform.userDataPath, { recursive: true, force: true });
    }
  });

  it("changes nothing anywhere when the record cannot be reached, and the card says why", async () => {
    const { release, story } = await organisationItems();
    const { conversation, cardId } = cardFor({ action: "reorder", item: release.key, why: "w", add_depends_on: [story.key], remove_depends_on: [] });
    anna.online = false;

    const applied = await approveWorkProposalThroughRecord(anna.handle.db, undefined, anna.record, conversation, cardId);

    expect(applied.applied).toBe(false);
    expect(applied.problem).toMatch(/could not be reached, so what it waits for was not changed/);
    expect(dependsOn(recordDb, release)).toEqual([]);
    expect(dependsOn(anna.handle, release)).toEqual([]);
    const reply = underTheCard(conversation, cardId);
    expect(reply.map((comment) => comment.kind)).toEqual(["rejection"]);
    expect(reply[0]?.body).toMatch(/could not be reached/);
  });

  it("is refused whole by the record, leaving its removal unapplied, when its addition would close a cycle", async () => {
    const { release, story } = await organisationItems();
    const third = createTestItem(recordDb.db, { type: "story", title: "Third", stepId: "todo", projectId: release.projectId });
    addDependency(recordDb.db, release.id as Uuid, third.id as Uuid);
    addDependency(recordDb.db, story.id as Uuid, release.id as Uuid);
    await anna.record.sync();
    const { conversation, cardId } = cardFor({ action: "reorder", item: release.key, why: "w", add_depends_on: [story.key], remove_depends_on: [third.key] });

    const applied = await approveWorkProposalThroughRecord(anna.handle.db, undefined, anna.record, conversation, cardId);

    expect(applied.applied).toBe(false);
    expect(applied.problem).toContain("circular");
    expect(dependsOn(recordDb, release)).toEqual([third.id]);
  });
});

/**
 * On a step that waits on a group, only the person holding the item may
 * change it (EO-368) — and the record judges that against its own item,
 * since a replica's idea of who holds it may be a takeover behind.
 */
describe("an item on a step that waits on a group", () => {
  async function heldByAnna(): Promise<{ release: Item; story: Item; bob: Uuid }> {
    const { release, story } = await organisationItems();
    const bob = createPerson(recordDb.db, { name: "Bob", email: "bob@example.com" }).id;
    const design = saveGroup(recordDb.db, { name: "Design", memberIds: [annaPersonId, bob] });
    // A person's step the work waits on, before it is finished — the
    // seeded pipeline's only person step is its last, where no content
    // may change at all.
    const step = { id: "launch_review", pipelineId: release.pipelineId!, position: 50, name: "Launch review", type: "user" as const };
    const userStep = createStep(recordDb.db, step);
    // The desktop's copy of the pipeline has the step too, without the
    // group — so nothing on the desktop stands between Anna and the
    // record, and what is refused below is refused by the record.
    createStep(anna.handle.db, step);
    setStepOwner(recordDb.db, userStep.id, { personId: null, groupId: design.id });
    const onGroupStep = createTestItem(recordDb.db, { type: "story", title: "Launch post", stepId: userStep.id, projectId: release.projectId });
    setItemAssignee(recordDb.db, onGroupStep.id, annaPersonId);
    await anna.record.sync();
    expect(getItem(anna.handle.db, onGroupStep.id)?.assigneeId).toBe(annaPersonId);
    return { release: onGroupStep, story, bob };
  }

  it("lets the person holding it change what it waits for", async () => {
    const { release, story } = await heldByAnna();

    const answer = await updateItemFields(anna.handle.db, anna.record, { itemId: release.id, addDependsOn: [story.key] });

    expect(answer.updated).toBe(true);
    expect(dependsOn(recordDb, release)).toEqual([story.id]);
  });

  it("refuses a former holder whose desktop has not heard of the takeover yet", async () => {
    const { release, story, bob } = await heldByAnna();
    // Bob took it over on the record; Anna's replica still says it is hers.
    setItemAssignee(recordDb.db, release.id as Uuid, bob);

    const answer = await updateItemFields(anna.handle.db, anna.record, { itemId: release.id, addDependsOn: [story.key] });

    expect(answer.updated).toBe(false);
    expect(answer.problem).toContain(release.key);
    expect(answer.problem).toContain("Bob");
    expect(dependsOn(recordDb, release)).toEqual([]);
    expect(dependsOn(anna.handle, release)).toEqual([]);
    // Said on the item too, to the person refused.
    const told = listCommentsForItem(recordDb.db, release.id).filter((comment) => comment.kind === "escalation");
    expect(told).toHaveLength(1);
    expect(told[0]?.body).toBe(answer.problem);
  });

  it("refuses a device whose person is not in the group, asking the record directly", async () => {
    const { release, story } = await heldByAnna();
    const pat = createPerson(recordDb.db, { name: "Pat", email: "pat@example.com" });
    const patsDevice = issueDevice(recordDb.db, { personId: pat.id, name: "pat-desk", tokenHash: "h2", secretsKeyHash: null }).id;

    const answer = await serveChangeDependencies(serving, { deviceId: patsDevice, itemId: release.id, add: [story.key], remove: [], update: [], why: null });

    expect(answer.changed).toBe(false);
    expect(answer.problem).toContain("Design");
    expect(dependsOn(recordDb, release)).toEqual([]);
  });
});
