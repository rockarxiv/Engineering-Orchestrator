import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ModuleManifest, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getJob, listJobs, saveModule } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createJobCommand, deleteJobCommand, getJobCommand, listJobsCommand, updateJobCommand } from "../ipc/jobCommands.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { recordItemsFromConversation } from "../jobs/fromDiscussion.js";
import { createJob } from "../jobs/jobs.js";
import { openAssistConversation } from "../roles/assist.js";
import { TOOLS } from "./catalog.js";
import { toolsFor } from "./gate.js";
import { answerToolCall } from "./server.js";

/**
 * The job tools (EO-785): outside clients list, read, create, edit and
 * delete jobs, through the `jobs:*` commands the Jobs screen used, and
 * EO's own agents are offered the two reads only. No answer carries a
 * webhook trigger's signing secret.
 */

let handle: DbHandle;

/** A machine nothing binds to itself, so every placement is allowed — `jobCommands.test.ts`'s. */
const JOBS = { facts: async () => ({ authKind: () => "api_key" as const }) };
const TEMPLATE = { type: "developer:story", title: "{{job}} for {{date}}", body: null };
/** Reversed in the source, so the literal value is nowhere a test could match by accident. */
const SECRET = "terces-gninigis-siht-seod-reven-yna-ot-nwohs-tnega".split("").reverse().join("");
const MANIFEST: ModuleManifest = {
  name: "PR watch",
  description: "Finds pull requests.",
  inputs: { repo: { type: "string" } },
  needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: [],
  watch: true,
};

beforeEach(() => {
  handle = openMigratedTestDb();
  const opts = { exposeErrorDetails: true };
  registerHandler("jobs:list", (payload) => listJobsCommand(handle.db, payload), opts);
  registerHandler("jobs:get", (payload) => getJobCommand(handle.db, payload), opts);
  registerHandler("jobs:create", (payload) => createJobCommand(handle.db, JOBS, payload), opts);
  registerHandler("jobs:update", (payload) => updateJobCommand(handle.db, JOBS, payload), opts);
  registerHandler("jobs:delete", (payload) => deleteJobCommand(handle.db, payload), opts);
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

function call(name: string, args: Record<string, unknown>, audience: "admin" | "external" = "external", dangerous = false) {
  return answerToolCall({ name, arguments: args }, audience, dangerous);
}

function stored(jobId: string) {
  return getJob(handle.db, jobId as Uuid);
}

function textOf(result: CallToolResult): string {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

function webhookJob() {
  const created = createJob(handle.db, {
    projectId: null,
    name: "Deploys",
    trigger: { kind: "webhook", path: "deploys", secret: SECRET, mapping: { title: null, body: null, eventKey: null, spec: {} } },
    pipelineId: "default",
    template: TEMPLATE,
  });
  if (!created.ok) throw new Error(created.problem);
  return created.job;
}

function conversationJob() {
  recordItemsFromConversation(handle.db, openAssistConversation(handle.db, null), [
    createTestItem(handle.db, { type: "story", title: "Page the importer", stepId: "todo", projectId: null }),
  ]);
  const job = listJobs(handle.db, null).find((one) => one.trigger.kind === "from-discussion");
  if (!job) throw new Error("no conversation job");
  return job;
}

function module(approve: boolean) {
  const saved = saveModule(handle.db, {
    slug: `pr-watch-${approve ? "approved" : "unapproved"}`,
    name: approve ? "PR watch" : "Unapproved watch",
    description: "Finds pull requests.",
    code: 'export default async function run() { return { ok: true, result: "waiting" }; }',
    manifest: MANIFEST,
    approve,
  });
  if (!saved.ok) throw new Error(saved.reason);
  return saved.module;
}

describe("who is offered which job tool", () => {
  const names = ["jobs_list", "job_get", "job_create", "job_update", "job_delete"];

  it("offers the reads to outside clients and eo_admin alike", () => {
    for (const audience of ["admin", "external"] as const) {
      const offered = toolsFor(false, audience).map((tool) => tool.name);
      expect(offered, audience).toContain("jobs_list");
      expect(offered, audience).toContain("job_get");
    }
    expect(TOOLS.find((tool) => tool.name === "jobs_list")?.channels).toEqual(["jobs:list"]);
    expect(TOOLS.find((tool) => tool.name === "job_get")?.channels).toEqual(["jobs:get"]);
  });

  it("offers create and update as writes and delete as dangerous, to outside clients", () => {
    const kinds = Object.fromEntries(names.map((name) => [name, TOOLS.find((tool) => tool.name === name)?.kind]));
    expect(kinds).toEqual({ jobs_list: "read", job_get: "read", job_create: "write", job_update: "write", job_delete: "dangerous" });

    const closed = toolsFor(false, "external").map((tool) => tool.name);
    expect(closed).toContain("job_create");
    expect(closed).toContain("job_update");
    expect(closed).not.toContain("job_delete");
    expect(toolsFor(true, "external").map((tool) => tool.name)).toContain("job_delete");
  });

  it("refuses job_delete until dangerous operations are on, and then deletes", async () => {
    const job = (await createJobCommand(handle.db, JOBS, { projectId: null, name: "Report", trigger: { kind: "manual" }, pipelineId: "default", template: TEMPLATE })).job!;

    const gated = await call("job_delete", { jobId: job.id });
    expect(gated.isError).toBe(true);
    expect(textOf(gated)).toContain("Allow destructive operations");
    expect(stored(job.id)?.deletedAt).toBeNull();

    const deleted = await call("job_delete", { jobId: job.id }, "external", true);
    expect(textOf(deleted)).toContain("Deleted the job.");
    expect(stored(job.id)?.deletedAt).not.toBeNull();
  });

  it("offers eo_admin none of the writes, listed or called", async () => {
    for (const dangerous of [false, true]) {
      const offered = toolsFor(dangerous, "admin").map((tool) => tool.name);
      for (const name of ["job_create", "job_update", "job_delete"]) expect(offered, name).not.toContain(name);
    }
    const job = (await createJobCommand(handle.db, JOBS, { projectId: null, name: "Report", trigger: { kind: "manual" }, pipelineId: "default", template: TEMPLATE })).job!;
    const attempts: [string, Record<string, unknown>][] = [
      ["job_create", { name: "Another", trigger: { kind: "manual" }, pipelineId: "default", template: TEMPLATE }],
      ["job_update", { jobId: job.id, name: "Renamed" }],
      ["job_delete", { jobId: job.id }],
    ];
    for (const [name, args] of attempts) {
      const answer = await call(name, args, "admin", true);
      expect(answer.isError, name).toBe(true);
      expect(textOf(answer), name).toBe(`EO has no tool named "${name}".`);
    }
    expect(listJobsCommand(handle.db, { projectId: null }).jobs.map((one) => one.name)).toEqual(["Report"]);
  });
});

describe("the reads", () => {
  it("never carry a webhook trigger's signing secret, on either listener", async () => {
    const job = webhookJob();

    for (const audience of ["admin", "external"] as const) {
      const list = await call("jobs_list", { projectId: null }, audience);
      const one = await call("job_get", { jobId: job.id }, audience);
      for (const answer of [list, one]) {
        expect(answer.isError, audience).toBe(false);
        expect(textOf(answer)).toContain("Deploys");
        expect(textOf(answer)).toContain("/webhooks/deploys");
        expect(JSON.stringify(answer)).not.toContain(SECRET);
      }
      expect((list.structuredContent as { jobs: { trigger: Record<string, unknown> }[] }).jobs[0]?.trigger).toEqual({
        kind: "webhook",
        path: "deploys",
        mapping: { title: null, body: null, eventKey: null, spec: {} },
      });
    }
  });

  it("keeps the secret out of a narrowed answer too", async () => {
    webhookJob();
    const answer = await call("jobs_list", { projectId: null, fields: ["jobs.trigger"] });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(JSON.stringify(answer.structuredContent)).toContain("deploys");
  });
});

describe("job_create", () => {
  const base = { projectId: null, pipelineId: "default", template: TEMPLATE };

  it("makes manual, schedule and watch jobs through jobs:create", async () => {
    const watcher = module(true);
    const triggers = [
      { kind: "manual" },
      { kind: "schedule", schedule: { kind: "daily", hour: 8, minute: 0 }, timeZone: "Europe/Berlin" },
      { kind: "watch", moduleId: watcher.id, inputs: { repo: "eo/eo" }, everyMinutes: 60 },
    ];
    for (const [index, trigger] of triggers.entries()) {
      const answer = await call("job_create", { ...base, name: `Job ${index}`, trigger });
      expect(textOf(answer), trigger.kind).toContain(`Created "Job ${index}".`);
    }
    expect(listJobsCommand(handle.db, { projectId: null }).jobs.map((job) => job.trigger.kind).sort()).toEqual(["manual", "schedule", "watch"]);
  });

  it("hands the command's refusal to the client for a watch job naming an unapproved module", async () => {
    const unapproved = module(false);
    const answer = await call("job_create", {
      ...base,
      name: "PR intake",
      trigger: { kind: "watch", moduleId: unapproved.id, inputs: { repo: "eo/eo" }, everyMinutes: 60 },
    });

    expect(textOf(answer)).toBe(
      'Nothing was created: "Unapproved watch" has not been approved. Approve it under Settings → Modules before a watch job runs it. Nothing has changed.',
    );
    expect(listJobs(handle.db, null)).toEqual([]);
  });

  it("refuses a blank template title by its field, not as an invalid payload", async () => {
    for (const title of ["", "   "]) {
      const answer = await call("job_create", { ...base, name: "Report", trigger: { kind: "manual" }, template: { ...TEMPLATE, title } });
      const text = textOf(answer);
      expect(text).toContain("template.title: must not be blank");
      expect(text).not.toContain("Invalid request payload");
    }
    expect(listJobs(handle.db, null)).toEqual([]);
  });

  it("does not make a webhook job", async () => {
    const answer = await call("job_create", { ...base, name: "Hook", trigger: { kind: "webhook", path: "deploys", secret: SECRET } });
    expect(textOf(answer)).toContain("trigger.kind: must be manual, schedule or watch — a webhook job is not made over MCP");
    expect(listJobs(handle.db, null)).toEqual([]);
  });

  it("passes on the module-rules notice the save did not check (EO-736)", async () => {
    // The notice is `moduleRulesNotice`'s; with no rules on the pipeline there is none, and the answer says nothing of one.
    const answer = await call("job_create", { ...base, name: "Report", trigger: { kind: "manual" } });
    expect(textOf(answer)).not.toContain("Not checked:");
    expect((answer.structuredContent as { notice?: unknown }).notice ?? null).toBeNull();
  });
});

describe("job_update", () => {
  it("saves a change through jobs:update", async () => {
    const job = (await createJobCommand(handle.db, JOBS, { projectId: null, name: "Report", trigger: { kind: "manual" }, pipelineId: "default", template: TEMPLATE })).job!;
    const answer = await call("job_update", { jobId: job.id, name: "Monday report" });
    expect(textOf(answer)).toContain('Saved "Monday report".');
    expect(stored(job.id)?.name).toBe("Monday report");
  });

  it("refuses a change to a webhook trigger's path or secret, and says why", async () => {
    const job = webhookJob();

    const moved = textOf(await call("job_update", { jobId: job.id, trigger: { kind: "webhook", path: "elsewhere" } }));
    expect(moved).toContain("Nothing has changed: A webhook's address is not changed over MCP");
    const rekeyed = textOf(await call("job_update", { jobId: job.id, trigger: { kind: "webhook", secret: "x".repeat(64) } }));
    expect(rekeyed).toContain("Nothing has changed: A webhook's signing secret is not changed over MCP");
    const unhooked = textOf(await call("job_update", { jobId: job.id, trigger: { kind: "manual" } }));
    expect(unhooked).toContain("Nothing has changed: This is a webhook job");

    expect(stored(job.id)?.trigger).toEqual(job.trigger);
  });

  it("changes a webhook job's mapping, keeping its address and secret and answering neither secret", async () => {
    const job = webhookJob();
    const mapping = { title: "{{event.title}}", body: null, eventKey: null, spec: {} };

    const answer = await call("job_update", { jobId: job.id, trigger: { kind: "webhook", mapping } });

    expect(textOf(answer)).toContain('Saved "Deploys".');
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(stored(job.id)?.trigger).toEqual({ kind: "webhook", path: "deploys", secret: SECRET, mapping });
  });

  it("does not make a job a webhook job", async () => {
    const job = (await createJobCommand(handle.db, JOBS, { projectId: null, name: "Report", trigger: { kind: "manual" }, pipelineId: "default", template: TEMPLATE })).job!;
    const answer = textOf(await call("job_update", { jobId: job.id, trigger: { kind: "webhook", path: "deploys", secret: SECRET } }));
    expect(answer).toContain("Nothing has changed: A job is not made a webhook job over MCP");
    expect(stored(job.id)?.trigger).toEqual({ kind: "manual" });
  });

  it("refuses a blank template title by its field", async () => {
    const job = (await createJobCommand(handle.db, JOBS, { projectId: null, name: "Report", trigger: { kind: "manual" }, pipelineId: "default", template: TEMPLATE })).job!;
    const answer = textOf(await call("job_update", { jobId: job.id, template: { ...TEMPLATE, title: "" } }));
    expect(answer).toContain("template.title: must not be blank");
    expect(answer).not.toContain("Invalid request payload");
  });

  it("refuses a conversation's job with the command's reason", async () => {
    const job = conversationJob();
    const answer = textOf(await call("job_update", { jobId: job.id, name: "Renamed" }));
    expect(answer).toBe(
      "Nothing has changed: This job belongs to its conversation, so there is nothing here to change. Deleting it is what stops items being recorded as coming from that chat.",
    );
    expect(stored(job.id)?.name).toBe(job.name);
  });
});

describe("job_delete", () => {
  it("refuses a conversation's job, and says why", async () => {
    const job = conversationJob();
    const answer = textOf(await call("job_delete", { jobId: job.id }, "external", true));
    expect(answer).toContain("EO did not delete it:");
    expect(answer).toContain("a conversation's job (a from-discussion job), which ends with its conversation rather than through this tool");
    expect(stored(job.id)?.deletedAt).toBeNull();
  });

  it("archives what the job filed when asked to", async () => {
    const job = (await createJobCommand(handle.db, JOBS, { projectId: null, name: "Report", trigger: { kind: "manual" }, pipelineId: "default", template: TEMPLATE })).job!;
    const answer = textOf(await call("job_delete", { jobId: job.id, archiveItems: true }, "external", true));
    expect(answer).toBe("Deleted the job. Archived 0 item(s) it filed.");
  });
});
