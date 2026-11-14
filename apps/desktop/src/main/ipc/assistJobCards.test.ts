import { rmSync } from "node:fs";
import { AssistOutputSchema, pageDescriptorFor, type AssistCard, type IpcChannel, type IpcResponse, type Item, type ModuleManifest, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRun, getItem, getJob, listAllJobs, listCommentsForItem, listProjects, saveModule, updateRun } from "../db/repos/index.js";
import { attachWorkspace, openMigratedTestDb } from "../db/testHelpers.js";
import { createJob } from "../jobs/jobs.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { fakePlatform } from "../testing/platform.js";
import { clearHandlerRegistry, dispatchIpc } from "./registry.js";

/**
 * Jobs through the assistant's cards (EO-786).
 *
 * The Jobs screen no longer makes or edits a job: the system agent
 * returns a card, and the person presses it, which calls the channel the
 * screen called — `jobs:create`, `update`, `delete`, `regenerateSecret`
 * or `testEvent`. Returning the card changes nothing; a card about
 * nothing is not offered; each card is pressed once; and a webhook's
 * signing secret is in no card, answer or comment. Every test drives the
 * app's own handlers and asserts against the rows.
 */

let handle: DbHandle;
let userData: string;
let projectId: Uuid;

/** Reversed in the source, so the literal value is nowhere a test could match by accident. */
const SECRET = "terces-gninigis-siht-seod-reven-yna-ot-nwohs-tnega".split("").reverse().join("");
const TEMPLATE = { type: "developer:story", title: "{{job}} for {{date}}", body: null };
const WATCH: ModuleManifest = {
  name: "PR watch",
  description: "Finds pull requests.",
  inputs: { repo: { type: "string" } },
  needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: [],
  watch: true,
};

beforeEach(async () => {
  handle = openMigratedTestDb();
  const platform = fakePlatform();
  userData = platform.userDataPath;
  attachWorkspace(handle.db, { name: "support", keyPrefix: "SUP", repoPath: "/tmp/eo-job-cards", baseBranch: "main" });
  projectId = listProjects(handle.db)[0]!.id;
  const { registerAllHandlers } = await import("./handlers.js");
  registerAllHandlers(handle.db, undefined, { platform });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
  rmSync(userData, { recursive: true, force: true });
});

async function call<K extends IpcChannel>(channel: K, payload: unknown): Promise<IpcResponse<K>> {
  const answer = await dispatchIpc(channel, payload);
  if (!answer.ok) throw new Error(`${channel} refused: ${answer.error.message}`);
  return answer.data as IpcResponse<K>;
}

async function chat(body = "Can you do that?"): Promise<Item> {
  const sent = await call("assist:send", { page: pageDescriptorFor("/jobs"), conversationId: null, body, attachmentIds: [], interrupt: false });
  return getItem(handle.db, sent.conversation.id as Uuid)!;
}

/** A succeeded `assist` run returning `card`, and what it posted. */
function turn(conversation: Item, card: AssistCard): { cardId: Uuid | undefined; rejections: string[]; bodies: string[] } {
  const output = { message: "That is yours to press.", card };
  const parsed = AssistOutputSchema.parse(output);
  const agent = assistAgent(handle.db)!;
  const initiationId = listCommentsForItem(handle.db, conversation.id)
    .filter((comment) => comment.authorType === "human" && comment.parentId === null)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .at(-1)!.id;
  const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION, initiationId });
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });
  postAssistReply(handle.db, conversation, agent.id, run.id, parsed);
  const posted = listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.runId === run.id);
  return {
    cardId: posted.find((comment) => comment.kind === PROPOSAL_KIND)?.id,
    rejections: posted.filter((comment) => comment.kind === "rejection").map((comment) => comment.body),
    bodies: posted.map((comment) => comment.body),
  };
}

const press = (conversation: Item, messageId: string, extra: Record<string, unknown> = {}) =>
  call("assist:applyCard", { conversationId: conversation.id, messageId, ...extra });
const read = (conversation: Item, messageId: string) => call("assist:card", { conversationId: conversation.id, messageId });

function create(overrides: Partial<Extract<AssistCard, { kind: "jobCreate" }>> = {}): AssistCard {
  return {
    kind: "jobCreate",
    projectId,
    name: "Monday report",
    trigger: { kind: "schedule", schedule: { kind: "weekly", weekday: 1, hour: 8, minute: 0 }, timeZone: "Europe/Berlin", catchUpWithinMinutes: null },
    pipelineId: "default",
    template: TEMPLATE,
    budgetPerOccurrenceCents: 150,
    maxItemsPerHour: null,
    runsOn: null,
    ...overrides,
  };
}

function update(jobId: string, overrides: Partial<Extract<AssistCard, { kind: "jobUpdate" }>> = {}): AssistCard {
  return { kind: "jobUpdate", jobId, name: null, trigger: null, pipelineId: null, template: null, budgetPerOccurrenceCents: null, maxItemsPerHour: null, runsOn: null, ...overrides };
}

function aJob(name = "Nightly", trigger: Parameters<typeof createJob>[1]["trigger"] = { kind: "manual" }) {
  const created = createJob(handle.db, { projectId, name, trigger, pipelineId: "default", template: TEMPLATE, budgetPerOccurrenceCents: 200 });
  if (!created.ok) throw new Error(created.problem);
  return created.job;
}

const aWebhookJob = () => aJob("Helpdesk", { kind: "webhook", path: "helpdesk", secret: SECRET, mapping: { title: null, body: null, eventKey: null, spec: {} } });

function aModule(approve: boolean) {
  const saved = saveModule(handle.db, {
    slug: `pr-watch-${approve ? "approved" : "unapproved"}`,
    name: approve ? "PR watch" : "Unapproved watch",
    description: "Finds pull requests.",
    code: 'export default async function run() { return { ok: true, result: "waiting" }; }',
    manifest: WATCH,
    approve,
  });
  if (!saved.ok) throw new Error(saved.reason);
  return saved.module;
}

async function messageOf(messageId: string) {
  const view = await call("assist:open", undefined);
  return view.conversation.messages.find((message) => message.id === messageId)!;
}

/** Everything the conversation holds — every comment's body, every card's read — for the secret to be absent from. */
async function everythingSaid(conversation: Item): Promise<string> {
  const comments = listCommentsForItem(handle.db, conversation.id);
  const reads = await Promise.all(comments.map((comment) => read(conversation, comment.id)));
  return JSON.stringify({ comments: comments.map((comment) => comment.body), reads, view: await call("assist:open", undefined) });
}

describe("creating a job", () => {
  it("shows the job as it would be, makes nothing until pressed, then calls jobs:create and links the job", async () => {
    const conversation = await chat("Make a Monday report job.");
    const { cardId, rejections } = turn(conversation, create());

    expect(rejections).toEqual([]);
    expect(await messageOf(cardId!)).toMatchObject({ canApprove: true, approves: "card", card: { kind: "jobCreate", outcome: null } });
    const shown = (await read(conversation, cardId!)).card;
    expect(shown).toMatchObject({ kind: "jobCreate", projectName: "support", name: "Monday report", created: null });
    const lines = shown?.kind === "jobCreate" ? Object.fromEntries(shown.lines.map((line) => [line.label, line.value])) : {};
    expect(lines).toMatchObject({
      Name: "Monday report",
      Trigger: "Mondays at 08:00, Europe/Berlin — a missed time is still run within 180 minutes",
      "Template type": "developer:story",
      Title: "{{job}} for {{date}}",
      "Budget per run": "$1.50",
      "Runs on": "This machine",
    });
    expect(lines["Pipeline"]).toBeTruthy();
    expect(listAllJobs(handle.db).filter((job) => job.name === "Monday report")).toEqual([]);

    const pressed = await press(conversation, cardId!);

    expect(pressed).toMatchObject({ applied: true, problem: null });
    const job = listAllJobs(handle.db).find((one) => one.name === "Monday report")!;
    expect(job).toMatchObject({ projectId, pipelineId: "default", budgetPerOccurrenceCents: 150, trigger: { kind: "schedule", timeZone: "Europe/Berlin", catchUpWithinMinutes: 180 } });
    expect(pressed.said).toContain("Created the job “Monday report”");
    expect((await read(conversation, cardId!)).card).toMatchObject({ kind: "jobCreate", created: { jobId: job.id, name: "Monday report" } });
    expect((await messageOf(cardId!)).card).toEqual({ kind: "jobCreate", outcome: { done: true, said: pressed.said } });
  });

  it("cannot be pressed twice", async () => {
    const conversation = await chat();
    const { cardId } = turn(conversation, create());
    await press(conversation, cardId!);

    const again = await press(conversation, cardId!);

    expect(again).toMatchObject({ applied: false, problem: "That card has already been pressed." });
    expect(listAllJobs(handle.db).filter((job) => job.name === "Monday report")).toHaveLength(1);
  });

  it("files the command's refusal under the card, and makes nothing", async () => {
    const conversation = await chat();
    const { cardId } = turn(conversation, create({ trigger: { kind: "schedule", schedule: { kind: "cron", expression: "not a schedule" }, timeZone: "Europe/Berlin", catchUpWithinMinutes: null } }));

    const pressed = await press(conversation, cardId!);

    expect(pressed.applied).toBe(false);
    expect(pressed.said).toMatch(/^“Monday report” was not created: /);
    expect((await messageOf(cardId!)).card?.outcome).toEqual({ done: false, said: pressed.said });
    expect(listAllJobs(handle.db).filter((job) => job.name === "Monday report")).toEqual([]);
  });

  it("shows a watch job's module, inputs, interval and Wait while open, and creates it", async () => {
    const module = aModule(true);
    const conversation = await chat();
    const { cardId, rejections } = turn(conversation, create({ name: "PRs", trigger: { kind: "watch", moduleId: module.id, inputs: { repo: "acme/shop" }, everyMinutes: 15, waitWhileOpen: true } }));

    expect(rejections).toEqual([]);
    const shown = (await read(conversation, cardId!)).card;
    const lines = shown?.kind === "jobCreate" ? Object.fromEntries(shown.lines.map((line) => [line.label, line.value])) : {};
    expect(lines).toMatchObject({ Module: "PR watch", Inputs: 'repo = "acme/shop"', "Checks every": "15 minutes", "Wait while open": expect.stringMatching(/^Yes/) });

    expect(await press(conversation, cardId!)).toMatchObject({ applied: true });
    expect(listAllJobs(handle.db).find((job) => job.name === "PRs")?.trigger).toMatchObject({ kind: "watch", moduleId: module.id, everyMinutes: 15, waitWhileOpen: true });
  });

  it("is not offered for a project, a pipeline or a watch module that is not here or not approved", async () => {
    const unapproved = aModule(false);
    const conversation = await chat();
    const cases: [AssistCard, string][] = [
      [create({ projectId: "no-such-project" }), 'there is no project with the ID "no-such-project"'],
      [create({ pipelineId: "no-such-pipeline" }), 'there is no pipeline with the ID "no-such-pipeline"'],
      [create({ trigger: { kind: "watch", moduleId: "no-such-module", inputs: {}, everyMinutes: 15, waitWhileOpen: false } }), 'No module "no-such-module" is installed here'],
      [create({ trigger: { kind: "watch", moduleId: unapproved.id, inputs: {}, everyMinutes: 15, waitWhileOpen: false } }), "has not been approved"],
    ];
    for (const [card, said] of cases) {
      const { cardId, rejections } = turn(conversation, card);
      expect(cardId).toBeUndefined();
      expect(rejections[0]).toContain("No card was offered");
      expect(rejections[0]).toContain(said);
    }
  });
});

describe("changing a job", () => {
  it("lists each changed field as old → new, and Save job calls jobs:update", async () => {
    const job = aJob();
    const conversation = await chat();
    const { cardId, rejections } = turn(conversation, update(job.id, { name: "Nightly build", budgetPerOccurrenceCents: "none", maxItemsPerHour: 4 }));

    expect(rejections).toEqual([]);
    expect((await read(conversation, cardId!)).card).toEqual({
      kind: "jobUpdate",
      jobId: job.id,
      jobName: "Nightly",
      changes: [
        { label: "Name", before: "Nightly", after: "Nightly build" },
        { label: "Budget per run", before: "$2.00", after: "None" },
        { label: "Items an hour", before: "No cap", after: "At most 4" },
      ],
    });
    expect(getJob(handle.db, job.id as Uuid)?.name).toBe("Nightly");

    const pressed = await press(conversation, cardId!);

    expect(pressed).toMatchObject({ applied: true, problem: null });
    expect(pressed.said).toContain("Saved the job “Nightly build”");
    expect(getJob(handle.db, job.id as Uuid)).toMatchObject({ name: "Nightly build", budgetPerOccurrenceCents: null, maxItemsPerHour: 4 });
  });

  it("is not offered when it changes nothing, names no job, or names a pipeline or module that is not here", async () => {
    const job = aJob();
    const conversation = await chat();
    const cases: [AssistCard, string][] = [
      [update(job.id, { name: "Nightly", budgetPerOccurrenceCents: 200 }), "“Nightly” already is what the card says, so there is nothing to change."],
      [update("no-such-job", { name: "Other" }), 'there is no job with the ID "no-such-job"'],
      [update(job.id, { pipelineId: "no-such-pipeline" }), 'there is no pipeline with the ID "no-such-pipeline"'],
      [update(job.id, { trigger: { kind: "watch", moduleId: "no-such-module", inputs: {}, everyMinutes: 5, waitWhileOpen: false } }), 'No module "no-such-module"'],
    ];
    for (const [card, said] of cases) {
      const { cardId, rejections } = turn(conversation, card);
      expect(cardId).toBeUndefined();
      expect(rejections[0]).toContain(said);
    }
  });

  it("keeps a webhook job's address and secret, changing only what it files", async () => {
    const job = aWebhookJob();
    const conversation = await chat();
    const refused = turn(conversation, update(job.id, { trigger: { kind: "manual" } }));
    expect(refused.cardId).toBeUndefined();
    expect(refused.rejections[0]).toContain("This is a webhook job");

    const mapping = { title: "/issue/title", body: null, eventKey: "/id", spec: {} };
    const { cardId } = turn(conversation, update(job.id, { trigger: { kind: "webhook", mapping } }));
    expect(await press(conversation, cardId!)).toMatchObject({ applied: true });

    expect(getJob(handle.db, job.id as Uuid)?.trigger).toEqual({ kind: "webhook", path: "helpdesk", secret: SECRET, mapping });
    expect(await everythingSaid(conversation)).not.toContain(SECRET);
  });
});

describe("deleting a job", () => {
  it("keeps its items unless the person chooses to archive them, through jobs:delete", async () => {
    const job = aJob();
    const fired = await call("jobs:runNow", { jobId: job.id });
    expect(fired.itemId).not.toBeNull();
    const conversation = await chat();
    const { cardId } = turn(conversation, { kind: "jobDelete", jobId: job.id });
    expect((await read(conversation, cardId!)).card).toMatchObject({ kind: "jobDelete", jobId: job.id, jobName: "Nightly", itemCount: 1 });

    const pressed = await press(conversation, cardId!, { archiveItems: true });

    expect(pressed).toMatchObject({ applied: true });
    expect(pressed.said).toBe("Deleted the job “Nightly”. The item it filed was archived with it.");
    expect(getJob(handle.db, job.id as Uuid)?.deletedAt).not.toBeNull();
    expect(getItem(handle.db, fired.itemId as Uuid)?.archivedAt).not.toBeNull();
  });

  it("leaves the items where they are by default", async () => {
    const job = aJob();
    const fired = await call("jobs:runNow", { jobId: job.id });
    const conversation = await chat();
    const { cardId } = turn(conversation, { kind: "jobDelete", jobId: job.id });

    const pressed = await press(conversation, cardId!);

    expect(pressed.said).toBe("Deleted the job “Nightly”. The items it filed are left where they are.");
    expect(getItem(handle.db, fired.itemId as Uuid)?.archivedAt).toBeNull();
  });

  it("is not offered for a job that is not on the Jobs list", async () => {
    const conversation = await chat();
    const { cardId, rejections } = turn(conversation, { kind: "jobDelete", jobId: "no-such-job" });
    expect(cardId).toBeUndefined();
    expect(rejections[0]).toContain("Read the jobs with `jobs_list` or `job_get`");
  });
});

describe("a webhook job's two buttons", () => {
  it("regenerates the secret, says the old one stops working, and never shows a secret", async () => {
    const job = aWebhookJob();
    const conversation = await chat();
    const { cardId, bodies } = turn(conversation, { kind: "jobWebhook", jobId: job.id, action: "regenerateSecret" });
    expect(bodies.at(-1)).toContain("The old secret stops working the moment the button is pressed");
    expect((await read(conversation, cardId!)).card).toEqual({
      kind: "jobWebhook",
      jobId: job.id,
      jobName: "Helpdesk",
      action: "regenerateSecret",
      address: "/webhooks/helpdesk",
      filed: null,
    });

    const pressed = await press(conversation, cardId!);

    expect(pressed).toMatchObject({ applied: true });
    const minted = getJob(handle.db, job.id as Uuid)!.trigger;
    expect(minted.kind === "webhook" ? minted.secret : null).not.toBe(SECRET);
    const said = await everythingSaid(conversation);
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain(minted.kind === "webhook" ? minted.secret : "unreachable");
  });

  it("sends a test event, shows its outcome and links the item it filed", async () => {
    const job = aWebhookJob();
    const conversation = await chat();
    const { cardId } = turn(conversation, { kind: "jobWebhook", jobId: job.id, action: "testEvent" });

    const pressed = await press(conversation, cardId!);

    expect(pressed).toMatchObject({ applied: true });
    expect(pressed.said).toContain("Sent a test event to “Helpdesk”: it was accepted and filed an item.");
    const shown = (await read(conversation, cardId!)).card;
    const filed = shown?.kind === "jobWebhook" ? shown.filed : null;
    expect(filed).not.toBeNull();
    expect(pressed.said).toContain(filed!.itemKey);
    expect(getItem(handle.db, filed!.itemId as Uuid)).toBeDefined();
    expect(await everythingSaid(conversation)).not.toContain(SECRET);
  });

  it("is not offered on a job that is not a webhook job", async () => {
    const job = aJob();
    const conversation = await chat();
    const { cardId, rejections } = turn(conversation, { kind: "jobWebhook", jobId: job.id, action: "testEvent" });
    expect(cardId).toBeUndefined();
    expect(rejections[0]).toContain("“Nightly” is not a webhook job");
  });
});
