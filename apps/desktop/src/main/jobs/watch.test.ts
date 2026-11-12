import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CustomModule, Job, ModuleManifest, Uuid, WatchFinding, WatchTrigger } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  getItem,
  getJob,
  getJobWatchState,
  itemGeneration,
  listJobEvents,
  listOccurrences,
  saveJobWatchState,
  saveModule,
  setItemArchived,
} from "../db/repos/index.js";
import { archiveModule } from "../db/repos/modulesRepo.js";
import { markReplica } from "../db/recordRole.js";
import { messagesAboutJob, openMigratedTestDb } from "../db/testHelpers.js";
import { createJobCommand, getJobCommand, resumeJobCommand, runJobNowCommand } from "../ipc/jobCommands.js";
import type { ModuleOutcome } from "../modules/runModule.js";
import { pauseJob } from "./budget.js";
import { createJob, updateJob } from "./jobs.js";
import { originOfItem } from "./origin.js";
import { placementForJob } from "./placement.js";
import { createWatchCheck, runWatchTick, type WatchCheck } from "./watch.js";

/**
 * A watch job (EO-753): its module run as an intake check, and what it
 * finds filed on the job's pipeline. Driven by a scripted module host —
 * a `WatchCheck` answering what each test tells it to — except for the
 * one test that runs the real host.
 */

let handle: DbHandle;
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 12, 9, 0);

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

const MANIFEST: ModuleManifest = {
  name: "PR watch",
  description: "Finds pull requests.",
  inputs: { repo: { type: "string" }, limit: { type: "number", default: 10 } },
  needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["broken"],
  watch: true,
};

function module(overrides: Partial<ModuleManifest> = {}, approve = true, code = "export default async function run() { return { ok: true, result: \"waiting\" }; }"): CustomModule {
  const saved = saveModule(handle.db, {
    slug: `pr-watch-${Math.random().toString(36).slice(2)}`,
    name: "PR watch",
    description: "Finds pull requests.",
    code,
    manifest: { ...MANIFEST, ...overrides },
    approve,
  });
  if (!saved.ok) throw new Error(saved.reason);
  return saved.module;
}

function trigger(moduleId: string, overrides: Partial<WatchTrigger> = {}): WatchTrigger {
  return { kind: "watch", moduleId, inputs: { repo: "eo/eo" }, everyMinutes: 60, waitWhileOpen: false, ...overrides };
}

const TEMPLATE = { type: "developer:story", title: "Template title", body: "Template body." };

function watchJob(overrides: Partial<WatchTrigger> = {}, moduleId = module().id): Job {
  const created = createJob(handle.db, { projectId: null, name: "PR intake", trigger: trigger(moduleId, overrides), pipelineId: "default", template: TEMPLATE });
  if (!created.ok) throw new Error(created.problem);
  return created.job;
}

/** A module host that answers each check with the next scripted outcome, and counts the checks. */
function scripted(...outcomes: (ModuleOutcome | Error)[]): WatchCheck & { calls: number } {
  const counter = { calls: 0 };
  const run: WatchCheck = async () => {
    counter.calls += 1;
    const next = outcomes.length > 1 ? outcomes.shift()! : outcomes[0]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return Object.defineProperty(run, "calls", { get: () => counter.calls }) as WatchCheck & { calls: number };
}

const waiting = (...findings: WatchFinding[]): ModuleOutcome => ({ ok: true, result: "waiting", detail: "", findings });
const FIRST: WatchFinding = { key: "dependabot:eo/eo#1", title: "Bump zod", body: "Found by the watch.", spec: { size: "s" } };

describe("filing what a watch finds", () => {
  it("files a first finding from the template, with the finding's title, body and spec, and records it", async () => {
    const job = watchJob();
    const check = scripted(waiting(FIRST));

    const result = await runWatchTick(handle.db, { check, now: () => T0 });

    expect(check.calls).toBe(1);
    expect(result.filed).toHaveLength(1);
    const item = getItem(handle.db, result.filed[0] as Uuid)!;
    expect(item.title).toBe("Bump zod");
    expect(item.body).toBe("Found by the watch.");
    expect(item.spec).toEqual({ size: "s" });
    expect(item.pipelineId).toBe("default");
    const events = listJobEvents(handle.db, job.id as Uuid);
    expect(events.map((event) => [event.outcome, event.eventKey, event.itemId])).toEqual([["created", FIRST.key, item.id]]);
    // Its origin names the job, the watch trigger and the finding, and it is nobody's creation.
    expect(originOfItem(handle.db, item.id as Uuid)).toMatchObject({ jobId: job.id, trigger: "watch", findingKey: FIRST.key });
    expect(itemGeneration(handle.db, item.id as Uuid)).toBe(0);
    // Counted from the end of the check.
    expect(getJobWatchState(handle.db, job.id as Uuid)).toMatchObject({ lastCheckedAt: T0, lastAnswer: "waiting", nextCheckAt: T0 + 60 * MINUTE, consecutiveFailures: 0 });
    // And the jobs IPC returns that state.
    expect(getJobCommand(handle.db, { jobId: job.id }).job?.watch).toMatchObject({ lastAnswer: "waiting", nextCheckAt: T0 + 60 * MINUTE });
  });

  it("files nothing and writes nothing for a key already filed, on the next check", async () => {
    const job = watchJob();
    const check = scripted(waiting(FIRST));
    await runWatchTick(handle.db, { check, now: () => T0 });

    const again = await runWatchTick(handle.db, { check, now: () => T0 + 60 * MINUTE });

    expect(check.calls).toBe(2);
    expect(again.filed).toEqual([]);
    expect(listJobEvents(handle.db, job.id as Uuid)).toHaveLength(1);
    expect(listOccurrences(handle.db, job.id as Uuid)).toHaveLength(1);
  });

  it("does not check a job before its next check is due", async () => {
    watchJob();
    const check = scripted(waiting(FIRST));
    await runWatchTick(handle.db, { check, now: () => T0 });
    await runWatchTick(handle.db, { check, now: () => T0 + 59 * MINUTE });
    expect(check.calls).toBe(1);
  });

  it("messages the owner the first time a key is refused, and writes nothing when it is refused again for the same reason", async () => {
    const job = watchJob();
    // The shipped pipeline works on no branch, so `ctx.createItem`'s
    // own check (EO-648) refuses an existing branch on it.
    const onABranch: WatchFinding = { key: "pr:7", title: "Fix the build", existingBranch: "fix/build" };
    const check = scripted(waiting(onABranch));

    await runWatchTick(handle.db, { check, now: () => T0 });

    const events = listJobEvents(handle.db, job.id as Uuid);
    expect(events.map((event) => event.outcome)).toEqual(["refused"]);
    expect(events[0]?.reason).toContain("does not work on a branch");
    const messages = messagesAboutJob(handle.db, job.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain("pr:7");
    expect(messages[0]?.body).toContain("does not work on a branch");
    const occurrences = listOccurrences(handle.db, job.id as Uuid).length;

    await runWatchTick(handle.db, { check, now: () => T0 + 60 * MINUTE });

    expect(check.calls).toBe(2);
    expect(listJobEvents(handle.db, job.id as Uuid)).toHaveLength(1);
    expect(messagesAboutJob(handle.db, job.id)).toHaveLength(1);
    expect(listOccurrences(handle.db, job.id as Uuid)).toHaveLength(occurrences);
  });

  it("does not check a paused job", async () => {
    const job = watchJob();
    pauseJob(handle.db, job.id as Uuid);
    const check = scripted(waiting(FIRST));
    await runWatchTick(handle.db, { check, now: () => T0 });
    expect(check.calls).toBe(0);
  });
});

describe("waiting while an item it filed is open", () => {
  it("holds every check while an item it filed is unfinished, names that item, and checks again once it is archived", async () => {
    const job = watchJob({ waitWhileOpen: true });
    const check = scripted(waiting(FIRST));
    const first = await runWatchTick(handle.db, { check, now: () => T0 });
    const filed = first.filed[0]!;

    const held = await runWatchTick(handle.db, { check, now: () => T0 + 61 * MINUTE });

    expect(held.held).toEqual([job.id]);
    expect(check.calls).toBe(1);
    expect(getJobWatchState(handle.db, job.id as Uuid)?.waitingForItemId).toBe(filed);
    expect(getJobCommand(handle.db, { jobId: job.id }).job?.watch?.waitingForItemKey).toBe(getItem(handle.db, filed as Uuid)?.key);

    setItemArchived(handle.db, filed as Uuid, T0 + 62 * MINUTE);
    await runWatchTick(handle.db, { check, now: () => T0 + 62 * MINUTE });

    expect(check.calls).toBe(2);
    expect(getJobWatchState(handle.db, job.id as Uuid)?.waitingForItemId).toBeNull();
  });
});

describe("a check that fails", () => {
  it("retries after 1, 2, 5, 10 and 30 minutes, and the sixth failure in a row pauses the job and messages the owner", async () => {
    const job = watchJob();
    const check = scripted({ ok: false, reason: "gh is not signed in." });
    let now = T0;
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await runWatchTick(handle.db, { check, now: () => now });
      const state = getJobWatchState(handle.db, job.id as Uuid)!;
      expect(state.consecutiveFailures).toBe(attempt);
      delays.push((state.nextCheckAt! - now) / MINUTE);
      now = state.nextCheckAt!;
    }

    expect(check.calls).toBe(6);
    expect(delays.slice(0, 5)).toEqual([1, 2, 5, 10, 30]);
    const paused = getJob(handle.db, job.id as Uuid)!;
    expect(paused.pausedAt).not.toBeNull();
    expect(paused.pausedReason).toBe("watch");
    const messages = messagesAboutJob(handle.db, job.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain('"PR intake"');
    expect(messages[0]?.body).toContain("gh is not signed in.");

    // Paused, it is not checked.
    await runWatchTick(handle.db, { check, now: () => now + 60 * MINUTE });
    expect(check.calls).toBe(6);
  });

  it("counts a crash, and an answer that is neither waiting nor declared, as failures", async () => {
    const job = watchJob();
    const check = scripted(new Error("host died"), { ok: true, result: "done", detail: "" });
    await runWatchTick(handle.db, { check, now: () => T0 });
    expect(getJobWatchState(handle.db, job.id as Uuid)).toMatchObject({ consecutiveFailures: 1, lastAnswer: "failed" });
    expect(getJobWatchState(handle.db, job.id as Uuid)?.lastError).toContain("host died");

    await runWatchTick(handle.db, { check, now: () => T0 + MINUTE });
    expect(getJobWatchState(handle.db, job.id as Uuid)?.consecutiveFailures).toBe(2);
    expect(getJobWatchState(handle.db, job.id as Uuid)?.lastError).toContain('answered "done"');
  });

  it("starts the count again after a check that answers", async () => {
    const job = watchJob();
    const check = scripted({ ok: false, reason: "offline" }, waiting());
    await runWatchTick(handle.db, { check, now: () => T0 });
    await runWatchTick(handle.db, { check, now: () => T0 + MINUTE });
    expect(getJobWatchState(handle.db, job.id as Uuid)).toMatchObject({ consecutiveFailures: 0, lastError: null, lastAnswer: "waiting" });
  });
});

describe("a check answering one of the module's declared results", () => {
  it("pauses the job at once and messages the owner with the result and its detail; resuming checks it right away with a fresh count", async () => {
    const job = watchJob();
    saveJobWatchState(handle.db, job.id as Uuid, { consecutiveFailures: 3 });
    const check = scripted({ ok: true, result: "broken", detail: "The token was revoked." }, waiting());

    await runWatchTick(handle.db, { check, now: () => T0 });

    const paused = getJob(handle.db, job.id as Uuid)!;
    expect(paused.pausedAt).not.toBeNull();
    expect(paused.pausedReason).toBe("watch");
    const messages = messagesAboutJob(handle.db, job.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain('"broken"');
    expect(messages[0]?.body).toContain("The token was revoked.");

    saveJobWatchState(handle.db, job.id as Uuid, { consecutiveFailures: 2 });
    resumeJobCommand(handle.db, { jobId: job.id });
    expect(getJobWatchState(handle.db, job.id as Uuid)?.consecutiveFailures).toBe(0);
    const due = getJobWatchState(handle.db, job.id as Uuid)!.nextCheckAt!;
    await runWatchTick(handle.db, { check, now: () => due });
    expect(check.calls).toBe(2);
  });
});

describe("a job overdue at launch", () => {
  it("is checked once, not once per missed interval", async () => {
    const job = watchJob({ everyMinutes: 15 });
    // Last checked five hours ago, so twenty intervals were missed.
    saveJobWatchState(handle.db, job.id as Uuid, { lastCheckedAt: T0 - 300 * MINUTE, nextCheckAt: T0 - 285 * MINUTE });
    const check = scripted(waiting());

    await runWatchTick(handle.db, { check, now: () => T0 });
    await runWatchTick(handle.db, { check, now: () => T0 + MINUTE });

    expect(check.calls).toBe(1);
    expect(getJobWatchState(handle.db, job.id as Uuid)?.nextCheckAt).toBe(T0 + 15 * MINUTE);
  });
});

describe("setting up a watch job", () => {
  const save = (input: Partial<Parameters<typeof createJob>[1]> & { trigger: WatchTrigger }) =>
    createJob(handle.db, { projectId: null, name: "PR intake", pipelineId: "default", template: TEMPLATE, ...input });
  const problemOf = (result: ReturnType<typeof save>): string => (result.ok ? "" : result.problem);

  it("refuses a module that is missing, archived, unapproved or not a watch, naming the problem", () => {
    expect(problemOf(save({ trigger: trigger("no-such-module") }))).toContain('No module "no-such-module"');
    const archived = module();
    archiveModule(handle.db, archived.id);
    expect(problemOf(save({ trigger: trigger(archived.id) }))).toContain("archived");
    expect(problemOf(save({ trigger: trigger(module({}, false).id) }))).toContain("has not been approved");
    expect(problemOf(save({ trigger: trigger(module({ watch: false }).id) }))).toContain("does not declare watch: true");
  });

  it("refuses an input the module does not declare, or of the wrong type", () => {
    const id = module().id;
    expect(problemOf(save({ trigger: trigger(id, { inputs: { branch: "main" } }) }))).toContain('declares no input "branch"');
    expect(problemOf(save({ trigger: trigger(id, { inputs: { limit: "ten" } }) }))).toContain('"limit" expects a number');
  });

  it("refuses one with no pipeline or no template", () => {
    const id = module().id;
    expect(problemOf(save({ trigger: trigger(id), pipelineId: null }))).toContain("needs a pipeline");
    expect(problemOf(save({ trigger: trigger(id), template: null }))).toContain("needs a pipeline");
  });

  it("refuses the organisation server, on create and on update", () => {
    const id = module().id;
    expect(problemOf(save({ trigger: trigger(id), runsOn: "server" }))).toContain("runs its module on this machine");
    const job = watchJob({}, id);
    const updated = updateJob(handle.db, { jobId: job.id as Uuid, runsOn: "server" });
    expect(updated.ok === false && updated.problem).toContain("runs its module on this machine");
  });

  it("refuses a project an organisation's record holds", () => {
    const id = module().id;
    const unmark = markReplica(handle.db, () => true, () => true);
    try {
      const result = createJob(handle.db, { projectId: "p1" as Uuid, name: "PR intake", trigger: trigger(id), pipelineId: "default", template: TEMPLATE });
      expect(problemOf(result)).toContain("organisation's record");
    } finally {
      unmark();
    }
  });

  it("refuses an update that would break its watch", () => {
    const job = watchJob();
    const updated = updateJob(handle.db, { jobId: job.id as Uuid, trigger: trigger(job.trigger.kind === "watch" ? job.trigger.moduleId : "", { inputs: { nope: 1 } }) });
    expect(updated.ok).toBe(false);
  });

  it("greys the organisation server in its placement, saying a watch intake runs here", async () => {
    const job = watchJob();
    const placement = placementForJob(handle.db, job, { authKind: () => "unknown" });
    expect(placement.machineBound.map((reason) => reason.kind)).toContain("watch-intake");
    expect(placement.machineBound.find((reason) => reason.kind === "watch-intake")?.fix).toContain("runs its module on this machine");

    const created = await createJobCommand(handle.db, { facts: async () => ({ authKind: () => "unknown" }) }, {
      projectId: null,
      name: "Elsewhere",
      trigger: trigger(job.trigger.kind === "watch" ? job.trigger.moduleId : ""),
      pipelineId: "default",
      template: TEMPLATE,
      runsOn: "server",
    });
    expect(created.job).toBeNull();
    expect(created.problem).toContain("watch intake");
  });

  it("has nothing to run now", () => {
    const job = watchJob();
    const answer = runJobNowCommand(handle.db, undefined, { jobId: job.id });
    expect(answer.fired).toBe(false);
    expect(answer.problem).toContain("files what its module finds");
  });
});

describe("the real intake check", () => {
  const hostPath = join(dirname(fileURLToPath(import.meta.url)), "..", "modules", "moduleHost.mjs");

  it("runs the module with no item, in a temporary directory it removes, and returns its findings", async () => {
    const code = `export default async function run(ctx) {
      return { ok: true, result: "waiting", findings: [{ key: "cwd", title: ctx.cwd, body: ctx.run.intake.job.name + " " + ctx.inputs.repo }] };
    }`;
    const watch = module({}, true, code);
    const job = watchJob({}, watch.id);
    const check = createWatchCheck(handle.db, {
      launcher: { execPath: process.execPath, hostPath, hostEnv: { ELECTRON_RUN_AS_NODE: "1" } },
      secrets: { directory: join(tmpdir(), "eo-watch-test-secrets"), store: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" } },
    });

    const outcome = await check(job, watch, job.trigger as WatchTrigger);

    expect(outcome.ok).toBe(true);
    const finding = outcome.ok ? outcome.findings?.[0] : undefined;
    expect(finding?.body).toBe("PR intake eo/eo");
    expect(finding?.title.startsWith(join(tmpdir(), "eo-watch-"))).toBe(true);
    expect(existsSync(finding!.title)).toBe(false);
  }, 30_000);
});
