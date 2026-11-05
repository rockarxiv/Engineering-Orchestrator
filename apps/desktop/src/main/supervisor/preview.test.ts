import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitStateOf, type Agent, type AgentProvider, type Item, type ModuleManifest, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createRoute,
  createRun,
  createStep,
  getItem,
  listAgents,
  listRunEvents,
  listRunsForItem,
  saveModule,
  updateAgent,
  updateRun,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { providerForAgent } from "../engine.js";
import { createModuleRunnerLookup } from "../modules/registry.js";
import type { ModuleSecretsOptions } from "../modules/secrets.js";
import { createFakeProvider, type FakeProviderScript } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * A preview runs, and reaches nothing (EO-313,
 * ARCHITECTURE.md, "Preview").
 *
 * The other half of this story is what a preview is kept *out* of —
 * counts, the archive, the day's spend — and that is tested over each
 * query in `ipc/preview.test.ts`. This half is what it is allowed to
 * *do*, which is the harder half: a preview that did nothing would show
 * nobody anything, so it walks a real pipeline, dispatches real steps
 * and takes real routes. It simply must not spend money and must not
 * send anything.
 *
 * Two mechanisms, because the two kinds of step differ in kind. An
 * agent step has a backend to swap, so it is swapped: the agent runs
 * whatever it is configured with, on `fake`. A `module` or `builtin`
 * step has nothing to swap — its whole content is the effect — so it is
 * not executed at all, and says what it would have done instead.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;
let implementer: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
});

afterEach(() => {
  handle.close();
});

describe("which backend a preview runs on", () => {
  /**
   * Every backend the supervisor asked to be built, in order.
   *
   * The factory *refuses* anything but `fake` as well as recording it,
   * so "no provider other than fake is constructed" is enforced here
   * rather than only asserted afterwards: a regression fails on the
   * throw, on the run row and on this list, and the first of those
   * cannot be argued with.
   */
  function recordingProvider(): { built: string[]; provider: (agent: Agent) => AgentProvider } {
    const built: string[] = [];
    const inner = createFakeProvider({ result: validImplementResult });
    return {
      built,
      provider: (agent: Agent) => {
        built.push(agent.provider);
        if (agent.provider !== "fake") throw new Error(`a preview constructed the "${agent.provider}" provider`);
        return inner;
      },
    };
  }

  it("runs an item on a `claude` agent through the fake provider, and builds no other", async () => {
    updateAgent(handle.db, implementer.id, { provider: "claude" });
    const item = createTestItem(handle.db, { type: "story", title: "Weekly report", stepId: "todo", previewAt: Date.now() });
    const { built, provider } = recordingProvider();

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(built).toEqual(["fake"]);
    const run = listRunsForItem(handle.db, item.id)[0];
    // The row says what actually ran, not what the agent is configured
    // with. A transcript header reading "claude" over a fake
    // conversation is the same lie the banner exists to stop.
    expect(run?.provider).toBe("fake");
    expect(run?.status).toBe("succeeded");
  });

  it("leaves real work on the backend its agent names", async () => {
    updateAgent(handle.db, implementer.id, { provider: "claude" });
    createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
    const built: string[] = [];
    const inner = createFakeProvider({ result: validImplementResult });

    await createRunSupervisor({
      db: handle.db,
      provider: (agent: Agent) => {
        built.push(agent.provider);
        return inner;
      },
      limits: LIMITS,
    }).runOnce();

    expect(built).toEqual(["claude"]);
  });

  /**
   * The sign-in check is asked of the backend that will run, which for
   * a preview is `fake` — and `fake` needs no account.
   *
   * Preview is offered *before* anyone signs in (ARCHITECTURE.md, "The gallery"), so a preview
   * refused because the machine has no Claude session would be the one
   * thing on the first-run screen that cannot be tried.
   */
  it("does not ask a preview to be signed into the agent's backend", async () => {
    updateAgent(handle.db, implementer.id, { provider: "claude" });
    const item = createTestItem(handle.db, { type: "story", title: "Weekly report", stepId: "todo", previewAt: Date.now() });
    const asked: string[] = [];

    await createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: validImplementResult }),
      limits: LIMITS,
      checkAuth: (agent: Agent) => {
        asked.push(agent.provider);
        return Promise.resolve(agent.provider === "fake" ? { ok: true } : { ok: false, reason: "Claude is not signed in" });
      },
    }).runOnce();

    expect(asked).toEqual(["fake"]);
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
  });
});

/**
 * The provider the app actually builds (EO-313, ARCHITECTURE.md, "Preview").
 *
 * Everything above injects a provider, which is the right way to ask
 * *which backend was chosen* and the wrong way to ask *whether the
 * chosen one can do the job*. It cannot answer the second at all: the
 * `fake` backend a test injects is `createFakeProvider`, scripted with
 * whatever that test wanted, and the one the composition root builds is
 * `createDemoProvider` — which deliberately refuses `implement` and
 * every action it has no canned answer for, because a placeholder
 * cannot write code and pretending otherwise is worse than stopping.
 *
 * That refusal is right for real work on an unconfigured EO and wrong
 * for a preview, which is asking to watch the machine rather than to
 * use it. Left in place it stopped a preview dead at its first agent
 * step with "no coding agent is configured" — the pipeline unwalked,
 * on the one feature whose whole promise is walking it.
 *
 * So these go through `providerForAgent`, the function the engine hands
 * the supervisor, and each has its real-work twin: the refusal has to
 * survive for the case it was written for.
 */
describe("the provider the app actually builds", () => {
  let runtimeRoot: string;

  beforeEach(() => {
    // Per test, which also keys `providerForAgent`'s module-level cache
    // apart: it holds one provider per agent id for the life of the
    // process, and these tests share the seeded agents' ids.
    runtimeRoot = mkdtempSync(join(tmpdir(), "eo preview runtimes "));
  });

  afterEach(() => {
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  /** The supervisor as the composition root wires it, minus the pack: no injected provider anywhere. */
  function supervisor() {
    return createRunSupervisor({
      db: handle.db,
      provider: (agent: Agent) => providerForAgent(agent, join(runtimeRoot, "eoServer.mjs"), undefined, runtimeRoot, handle.db),
      limits: LIMITS,
      // Somewhere disposable for the `none` kind to make its empty
      // directories, rather than the real `~/.eo/no-disk`.
      noDiskRoot: join(runtimeRoot, "no-disk"),
    });
  }

  it("walks a preview past `implement`, which it used to refuse", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Weekly report", stepId: "todo", previewAt: Date.now() });

    await supervisor().runOnce();

    const run = listRunsForItem(handle.db, item.id)[0];
    expect(run?.status).toBe("succeeded");
    expect(run?.provider).toBe("fake");
    // `todo --done--> review` on the shipped pipeline. The assertion
    // that matters is that it is no longer standing where it started.
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });

  /**
   * And the refusal survives, which is the whole reason the preview
   * needed a branch of its own rather than the demo simply learning to
   * answer `implement`.
   */
  it("still tells somebody doing real work that no coding agent is configured", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });

    await supervisor().runOnce();

    const run = listRunsForItem(handle.db, item.id)[0];
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("No coding agent is configured");
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  /**
   * A preview works nowhere, which is the other half of "nothing was
   * sent" — the half that would otherwise be written to a disk rather
   * than to a channel.
   *
   * A real story on this pipeline is on a `git-worktree` workspace, and
   * preparing one cuts a branch. A rehearsal that left a branch in
   * somebody's repository would have broken the banner's promise before
   * the agent said a word, so a preview is put on `none`: an empty
   * directory of EO's own making. Which is also why nothing verifies
   * its canned `implement` claim — `none` vouches for nothing, so no
   * check goes looking for commits a rehearsal never made.
   */
  it("gives the preview an empty directory rather than a branch, and checks nothing", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Weekly report", stepId: "todo", previewAt: Date.now() });

    await supervisor().runOnce();

    const run = listRunsForItem(handle.db, item.id)[0];
    expect(run?.cwd).toBe(join(runtimeRoot, "no-disk", item.key));
    // Nothing was checked, so there is no record of a check: a
    // verification either way would mean EO had gone looking for
    // commits a rehearsal never made.
    expect(run?.verification).toBeNull();
    expect(gitStateOf(getItem(handle.db, item.id)!).branch).toBeNull();
  });

  /**
   * The case the shipped pipeline cannot show: a step some template
   * defined, whose action the registry has never heard of and which
   * declares outcomes of its own.
   *
   * This is what a gallery preview actually walks (ARCHITECTURE.md, "The gallery") — "Draft",
   * "Post to Slack", "Done" rather than implement and review — and it
   * is two separate ways the old code stopped. The demo threw on the
   * unknown action; and had it not, the run would have reported no
   * result key, `done` is not among what this step declares, and
   * `resolveRoute` reads that as a configuration gap and parks asking
   * somebody to add a route.
   */
  it("walks a step a template defined, taking its first declared result", async () => {
    createStep(handle.db, { id: "draft", pipelineId: "default" as Uuid, position: 20, name: "Draft", type: "agent", ownerRole: "implementer", entryAction: "draft" });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "draft", resultKey: "drafted", label: "Drafted", target: "ready_to_merge" });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "draft", resultKey: "needs_another_pass", label: "Another pass", target: "todo", position: 1 });
    const item = createTestItem(handle.db, { type: "story", title: "Weekly report", stepId: "draft", previewAt: Date.now() });

    await supervisor().runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    // "drafted", the first of the two — not "needs another pass", and
    // not parked for want of a `done` route.
    expect(getItem(handle.db, item.id)?.stepId).toBe("ready_to_merge");
  });

  it("refuses that same step for real work, so the mark is what walked it", async () => {
    createStep(handle.db, { id: "draft", pipelineId: "default" as Uuid, position: 20, name: "Draft", type: "agent", ownerRole: "implementer", entryAction: "draft" });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "draft", resultKey: "drafted", label: "Drafted", target: "ready_to_merge" });
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "draft" });

    await supervisor().runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.error).toContain("No coding agent is configured");
    expect(getItem(handle.db, item.id)?.stepId).toBe("draft");
  });
});

/**
 * A preview cannot be stopped for spending money (EO-313, ARCHITECTURE.md, "Preview").
 *
 * The money guards read `sumCostCentsForItem`, which is nought for a
 * preview — so this is the behaviour that exclusion buys, asserted where
 * it would actually be felt. Left counting, a preview on a machine with
 * a per-item budget would park itself mid-walk with "reply to authorize
 * more": EO asking somebody to approve spending on the one item it had
 * just told them cost nothing, and the preview stopping halfway through
 * the demonstration it exists to give.
 */
describe("a preview and the money guards", () => {
  /** A backend that reports a cost far over any budget below. */
  const expensive: FakeProviderScript = {
    steps: [{ output: "working" }],
    usage: { tokensIn: 100, tokensOut: 50, costCents: 1000 },
    result: validImplementResult,
  };

  it("walks past a per-item budget its own runs have blown", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Weekly report", stepId: "todo", previewAt: Date.now() });

    await createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider(expensive),
      limits: LIMITS,
      guards: { perItemBudgetCents: 500 },
    }).runOnce();

    const run = listRunsForItem(handle.db, item.id)[0];
    expect(run?.status).toBe("succeeded");
    // Not parked, and nothing asked of anybody: the `!` is the other
    // half of the same promise, and `ipc/preview.test.ts` holds it.
    expect(run?.error).toBeNull();
    expect(getItem(handle.db, item.id)?.stepId).not.toBe("todo");
  });

  it("stops real work at the same budget, which is how we know the mark is what let it past", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });

    await createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider(expensive),
      limits: LIMITS,
      guards: { perItemBudgetCents: 500 },
    }).runOnce();

    const run = listRunsForItem(handle.db, item.id)[0];
    expect(run?.status).toBe("awaiting_input");
    expect(run?.error).toContain("budget");
  });

  /**
   * And it does not spend anybody else's budget either. The daily total
   * is cross-item by design, so a preview counted there would stop the
   * next real dispatch on the board — the loudest version of this bug,
   * because the item it stops is not the one anybody was watching.
   */
  it("does not put the day's budget out of reach for real work", async () => {
    const rehearsal = createTestItem(handle.db, { type: "story", title: "Weekly report", stepId: "ready_to_merge", previewAt: Date.now() });
    const spent = createRun(handle.db, { itemId: rehearsal.id, agentId: implementer.id, action: "implement", status: "succeeded" });
    updateRun(handle.db, spent.id, { costCents: 400, startedAt: Date.now(), endedAt: Date.now() });
    const work = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });

    await createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ ...expensive, usage: { tokensIn: 10, tokensOut: 10, costCents: 200 } }),
      limits: LIMITS,
      // 400 of preview + 200 of real work would be 600, over this.
      // Only the 200 counts, so the run finishes.
      guards: { dailyBudgetCents: 500 },
    }).runOnce();

    expect(listRunsForItem(handle.db, work.id)[0]?.status).toBe("succeeded");
  });
});

describe("a module step on a preview", () => {
  /** `safeStorage`, minus the OS — the same seam `modules/registry.test.ts` uses. */
  const store = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
  };

  const manifest: ModuleManifest = {
    name: "Post to Slack",
    description: "Posts the report to a channel.",
    inputs: {
      channel: { type: "string", default: "#general" },
      urgent: { type: "boolean", default: false },
    },
    needs: {
      bin: [],
      // Declared and never set. A module needing a secret is refused
      // before it runs, so a preview that got as far as reading the
      // environment would fail here rather than succeed — which is a
      // second, independent way this test would notice the gate moving.
      env: ["SLACK_TOKEN"],
      network: true,
      item: false,
      comment: false,
      attach: false,
      create: false,
    },
    results: ["sent", "failed"],
  };

  let scratch: string;
  let secrets: ModuleSecretsOptions;
  let moduleId: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "eo preview "));
    secrets = { directory: join(scratch, "secrets"), store };

    const saved = saveModule(handle.db, {
      slug: "post-to-slack",
      name: "Post to Slack",
      description: "Posts the report to a channel.",
      code: "export default async function run() { return { ok: true, result: 'sent', detail: '' }; }",
      manifest,
      approve: true,
    });
    if (!saved.ok) throw new Error(saved.reason);
    moduleId = saved.module.id;

    createStep(handle.db, {
      id: "post",
      pipelineId: "default" as Uuid,
      position: 15,
      name: "Post to Slack",
      type: "module",
      entryAction: moduleId,
      inputs: { channel: "#marketing" },
    });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "post", resultKey: "sent", label: "Sent", target: "review" });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "post", resultKey: "failed", label: "Failed", target: "todo", position: 1 });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /**
   * The real registry lookup, over a launcher that cannot start.
   *
   * This is what makes "does not launch the module host" an assertion
   * rather than a claim: `execPath` names nothing on this machine, so a
   * host that was launched would fail, the outcome would be
   * `{ ok: false }`, and every expectation below — the result, the
   * route, the succeeded run — would go the other way.
   */
  function supervisor() {
    return createRunSupervisor({
      db: handle.db,
      provider: { start: () => { throw new Error("a module step must not reach a provider"); } } as never,
      limits: LIMITS,
      moduleRunner: createModuleRunnerLookup({
        db: handle.db,
        launcher: { execPath: join(scratch, "no-such-node"), hostPath: join(scratch, "no-such-host.mjs") },
        secrets,
      }),
    });
  }

  async function ran(previewAt: number | null): Promise<Item> {
    const item = createTestItem(handle.db, {
      type: "story",
      title: "Weekly report",
      stepId: "post",
      ...(previewAt === null ? {} : { previewAt }),
    });
    await supervisor().runOnce();
    return item;
  }

  it("says what it would have sent, with the module's name and the step's inputs", async () => {
    const item = await ran(Date.now());

    const run = listRunsForItem(handle.db, item.id)[0]!;
    const transcript = listRunEvents(handle.db, run.id)
      .map((event) => (event.payload as { text?: string }).text ?? "")
      .join("\n");

    expect(transcript).toContain("Would have sent: Post to Slack");
    // The channel this step is configured with, not the manifest's
    // default — "#marketing" is the part a person previewing is
    // actually checking.
    expect(transcript).toContain('channel: "#marketing"');
    // And a declared input the step leaves alone, which is the
    // manifest's own default rather than a blank.
    expect(transcript).toContain("urgent: false");
    expect(transcript).toContain("Nothing ran and nothing was sent: this item is a preview.");
  });

  it("succeeds with the module's first declared result, and takes that route", async () => {
    const item = await ran(Date.now());

    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.status).toBe("succeeded");
    expect(run.result).toMatchObject({ parsed: { result: "sent" } });
    // The item carries on: a preview that stopped at the first module
    // step would have shown a person the half of the machine that does
    // not include the end of it.
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });

  it("does run the module for real work, which is how we know the gate is the mark", async () => {
    const item = await ran(null);

    const run = listRunsForItem(handle.db, item.id)[0]!;
    // The host really was launched, and really could not start — which
    // is the opposite outcome from the preview above, reached through
    // the same launcher.
    expect(run.status).not.toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).toBe("post");
  });
});

describe("a builtin step on a preview", () => {
  /**
   * The same rule, for EO's own functions.
   *
   * A builtin has no manifest and no inputs to state, but it has the
   * same problem: there is no rehearsal of cutting a worktree or opening
   * a pull request that is not cutting one and opening one. So it is not
   * executed either, and the registry's first declared result is what
   * carries the item onward.
   */
  function supervisor(ran: string[]) {
    return createRunSupervisor({
      db: handle.db,
      provider: { start: () => { throw new Error("a builtin must not reach a provider"); } } as never,
      limits: LIMITS,
      builtins: {
        create_worktree: () => {
          ran.push("create_worktree");
          return Promise.resolve({ ok: true as const, result: "ready", detail: "Worktree ready at /tmp/x" });
        },
      },
    });
  }

  it("says what it would have done, and routes on the first declared result", async () => {
    // The seeded pipeline enters at `worktree`, which is a builtin.
    const item = createTestItem(handle.db, { type: "story", title: "Weekly report", stepId: "worktree", previewAt: Date.now() });
    const ran: string[] = [];

    await supervisor(ran).runOnce();

    expect(ran).toEqual([]);
    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.status).toBe("succeeded");
    expect(
      listRunEvents(handle.db, run.id)
        .map((event) => (event.payload as { text?: string }).text ?? "")
        .join("\n"),
    ).toContain("Would have sent: create_worktree");
    // `ready` is the first of `BUILTIN_RESULTS.create_worktree`, and the
    // seeded pipeline routes it to the indexing step.
    expect(getItem(handle.db, item.id)?.stepId).toBe("repository_index");
  });

  it("still runs the function for real work", async () => {
    createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "worktree" });
    const ran: string[] = [];

    await supervisor(ran).runOnce();

    expect(ran).toEqual(["create_worktree"]);
  });
});
