import { ADMIN_MCP_SERVER_NAME, ScenarioOutputSchema, developerRegistry, validateActionResult, type Agent, type ModuleManifest, type ScenarioReply, type Uuid } from "@eo/core";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  appendRunEvent,
  approveModule,
  createRun,
  getItem,
  getModule,
  listCommentsForItem,
  listModuleTests,
  listPipelineSteps,
  listRunEvents,
  offBoardStepIds,
  saveModule,
  saveModuleTest,
  updateItem,
  updateRun,
} from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { createAdminMcpHost } from "../mcpHost/admin.js";
import { answerToolCall } from "../mcpHost/server.js";
import { toolResultEvent } from "../providers/toolResult.js";
import { approvedModuleTestWriteRefusal } from "../roles/assist.js";
import { createModuleTestRunner, type ModuleTestRunner } from "../modules/moduleTestRunner.js";
import type { ModuleHostLauncher } from "../modules/runModule.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { SCENARIO_ACTION, SCENARIO_SETTINGS_KEY, SCENARIO_STEP } from "../roles/conversationSteps.js";
import { postScenarioReply, recordScenarioApprovalWithdrawal, scenarioAgent, scenarioModuleWriteRefusal } from "../roles/scenario.js";
import { buildDispatchContext } from "../supervisor/buildDispatchContext.js";
import { findPendingResponses } from "../supervisor/manualDispatch.js";
import { listItemSummaries } from "./domainQueries.js";
import { approveModuleCommand, archiveModuleCommand, saveModuleCommand } from "./moduleCommands.js";
import { deleteModuleTestCommand, listModuleTestsCommand, runModuleTestsCommand, saveModuleTestCommand } from "./moduleTestCommands.js";
import { clearHandlerRegistry, registerHandler } from "./registry.js";
import { answerScenarioQuestions, applyScenarioChangeCommand, clearScenario, openScenario, sendToScenario } from "./scenarioCommands.js";

/**
 * A module's scenario chat (EO-356), end to end where it can be.
 *
 * The runner is the real one driving the real module host, and the
 * agent's half of a turn is played through the real `eo_admin` tools —
 * `module_test_save` and `module_tests_run` — so what is asserted is
 * what a person would see: the case in the module's list, the result
 * and the coverage in the reply, and a module nobody asked to change
 * left exactly as it was. The model itself is the only thing scripted.
 */

const here = dirname(fileURLToPath(import.meta.url));
const launcher: ModuleHostLauncher = { execPath: process.execPath, hostPath: join(here, "..", "modules", "moduleHost.mjs"), hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };

const manifest: ModuleManifest = {
  name: "Merge pull request",
  description: "Merges once CI passes.",
  inputs: { pr: { type: "string", default: "12" } },
  needs: { bin: ["gh"], env: [], network: false, item: false, comment: true, attach: false, create: false },
  results: ["merged"],
};

const MERGE = `export default async function (ctx) {
  const pr = ctx.inputs.pr;
  const checks = await ctx.exec("gh", ["pr", "checks", pr]);
  if (checks.code !== 0) return { ok: false, reason: "CI is failing" };
  await ctx.exec("gh", ["pr", "merge", pr, "--squash"]);
  return { ok: true, result: "merged" };
}`;

const MERGES_WHEN_GREEN = `import assert from "node:assert/strict";
export default async function (harness) {
  const run = await harness.run({ exec: [
    { bin: "gh", args: ["pr", "checks", "12"], code: 0 },
    { bin: "gh", args: ["pr", "merge", "12", "--squash"], code: 0 },
  ] });
  assert.deepEqual(run.outcome, { ok: true, result: "merged", detail: "" });
}`;

/** A case expecting the module to retry a red check, which it does not. */
const RETRIES_RED_CI = `import assert from "node:assert/strict";
export default async function (harness) {
  const run = await harness.run({ exec: [
    { bin: "gh", args: ["pr", "checks", "12"], code: 1, stdout: "lint failed" },
    { bin: "gh", args: ["pr", "checks", "12"], code: 0 },
    { bin: "gh", args: ["pr", "merge", "12", "--squash"], code: 0 },
  ] });
  assert.equal(run.outcome.ok, true, "expected the module to retry a red check");
}`;

let handle: DbHandle;
let runner: ModuleTestRunner;
let agent: Agent;
const opts = { exposeErrorDetails: true };
beforeEach(() => {
  handle = openMigratedTestDb();
  runner = createModuleTestRunner({ db: handle.db, launcher });
  agent = scenarioAgent(handle.db)!;
  registerHandler("moduleTests:list", (payload) => listModuleTestsCommand(handle.db, payload), opts);
  registerHandler("moduleTests:save", (payload) => saveModuleTestCommand(handle.db, runner, payload), opts);
  registerHandler("moduleTests:run", (payload) => runModuleTestsCommand(runner, payload), opts);
  registerHandler("moduleTests:delete", (payload) => deleteModuleTestCommand(handle.db, runner, payload), opts);
});

afterEach(() => {
  runner.dispose();
  clearHandlerRegistry();
  handle.close();
});

function saveMerge(approved = true): string {
  const saved = saveModule(handle.db, { slug: "merge-pr", name: "Merge pull request", description: "Merges once CI passes.", code: MERGE, manifest, source: "user", approve: approved });
  if (!saved.ok) throw new Error(saved.reason);
  return saved.module.id;
}

async function say(moduleId: string, body: string) {
  return (await sendToScenario(handle.db, undefined, { moduleId, conversationId: null, body, interrupt: false })).conversation;
}

/** How each backend writes an `eo_admin` tool id into a run's log (invariant #12). */
const spell = {
  claude: (name: string) => `mcp__${ADMIN_MCP_SERVER_NAME}__${name}`,
  codex: (name: string) => `${ADMIN_MCP_SERVER_NAME}/${name}`,
} as const;

/**
 * One turn, as the supervisor runs it: a run on the conversation started
 * by the newest message, the agent's tool calls in its log, then the
 * reply posted — what the developer pack's wiring calls when a scenario
 * run succeeds (`wiring.test.ts` holds it to that).
 */
type Log = (name: string, ok?: boolean, output?: string, args?: Record<string, unknown>) => void;

async function turn(conversationId: string, backend: keyof typeof spell, work: (log: Log) => Promise<ScenarioReply>) {
  const conversation = getItem(handle.db, conversationId as Uuid)!;
  const initiation = listCommentsForItem(handle.db, conversation.id)
    .filter((comment) => comment.authorType === "human")
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .at(-1)!.id;
  const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: SCENARIO_ACTION, initiationId: initiation, status: "running" });
  let calls = 0;
  // What the backend recorded: the call, then EO's answer to it, bounded
  // exactly as either adapter bounds it on the way into the log.
  const output = await work((name, ok = true, answer = "", args = {}) => {
    calls += 1;
    appendRunEvent(handle.db, run.id, "tool_call", { name: spell[backend](name), args, callId: `call-${calls}` });
    const result: Record<string, unknown> = { ...toolResultEvent({ name: spell[backend](name), callId: `call-${calls}`, ok, output: answer }) };
    delete result["type"];
    appendRunEvent(handle.db, run.id, "tool_result", result);
  });
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });
  postScenarioReply(handle.db, conversation, agent.id, run.id, output);
  return { runId: run.id, comments: listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.runId === run.id) };
}

/**
 * One call to `eo_admin`, as the turn's agent makes it: through the
 * server's own answer path, refused and observed exactly as `startMain`
 * wires the admin host.
 */
async function adminCall(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; data: Record<string, unknown> }> {
  const result = await answerToolCall(
    { name, arguments: args },
    "admin",
    true,
    (tool, given) => scenarioModuleWriteRefusal(handle.db, tool, given) ?? approvedModuleTestWriteRefusal(handle.db, tool, given),
    (tool, given, data) => recordScenarioApprovalWithdrawal(handle.db, tool, given, data),
  );
  const text = (result.content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("\n");
  return { ok: result.isError !== true, text, data: (result.structuredContent ?? {}) as Record<string, unknown> };
}

/** The agent's half of a turn that writes a case and runs it — through the tools it is served. */
async function writeAndRun(moduleId: string, description: string, source: string, log: Log, caseId?: string): Promise<string> {
  const args = { ...(caseId === undefined ? {} : { id: caseId }), moduleId, description, source };
  const saved = await adminCall("module_test_save", args);
  log("module_test_save", saved.ok, saved.text, args);
  if (!saved.ok || saved.data["saved"] !== true) throw new Error(`not saved: ${saved.text}`);
  const id = (saved.data["test"] as { id: string }).id;
  await runTests(moduleId, log);
  return id;
}

/** `module_tests_run`, as the agent calls it. */
async function runTests(moduleId: string, log: Log): Promise<void> {
  const ran = await adminCall("module_tests_run", { moduleId });
  log("module_tests_run", ran.ok, ran.text, { moduleId });
}

describe("opening the chat", () => {
  it("opens one thread per module, resumes it, and Clear starts a fresh one", async () => {
    const merge = saveMerge();
    const other = saveModule(handle.db, { slug: "tag", name: "Tag", description: "Tags.", code: MERGE, manifest, source: "user" });
    if (!other.ok) throw new Error(other.reason);

    const opened = openScenario(handle.db, { moduleId: merge }).conversation;
    await say(merge, "It should merge once CI is green.");
    const reopened = openScenario(handle.db, { moduleId: merge }).conversation;
    expect(reopened.id).toBe(opened.id);
    expect(reopened.messages.map((message) => message.body)).toEqual(["It should merge once CI is green."]);
    expect(getItem(handle.db, opened.id as Uuid)?.stepId).toBe(SCENARIO_STEP);

    // Another module's page is another conversation.
    expect(openScenario(handle.db, { moduleId: other.module.id }).conversation.id).not.toBe(opened.id);

    const cleared = clearScenario(handle.db, undefined, { moduleId: merge }).conversation;
    expect(cleared.id).not.toBe(opened.id);
    expect(cleared.messages).toEqual([]);
    expect(getItem(handle.db, opened.id as Uuid)?.archivedAt).not.toBeNull();
    expect(openScenario(handle.db, { moduleId: merge }).conversation.id).toBe(cleared.id);

    // Clearing an empty thread burns nothing.
    expect(clearScenario(handle.db, undefined, { moduleId: merge }).conversation.id).toBe(cleared.id);
  });

  it("refuses a module that has been deleted, and a message meant for another module's thread", async () => {
    const merge = saveMerge();
    const conversation = await say(merge, "It should merge.");
    const other = saveModule(handle.db, { slug: "tag", name: "Tag", description: "Tags.", code: MERGE, manifest, source: "user" });
    if (!other.ok) throw new Error(other.reason);

    await expect(sendToScenario(handle.db, undefined, { moduleId: other.module.id, conversationId: conversation.id, body: "hi", interrupt: false })).rejects.toThrow(
      "That conversation is about another module.",
    );
    expect(() => openScenario(handle.db, { moduleId: "nope" })).toThrow("That module no longer exists.");
  });

  it("lives on an off-board step, so it is never a card on any board", async () => {
    const merge = saveMerge();
    const conversation = await say(merge, "It should merge.");

    expect(listPipelineSteps(handle.db).find((step) => step.id === SCENARIO_STEP)?.offBoard).toBe(true);
    expect(offBoardStepIds(handle.db).has(SCENARIO_STEP)).toBe(true);
    const item = getItem(handle.db, conversation.id as Uuid)!;
    expect(listItemSummaries(handle.db, item.projectId).items.map((row) => row.id)).not.toContain(conversation.id);
    expect(listItemSummaries(handle.db, null).items.map((row) => row.id)).not.toContain(conversation.id);
  });
});

describe("a turn", () => {
  it("is dispatched as `scenario`, handed the module's code numbered by line", async () => {
    const merge = saveMerge();
    const conversation = await say(merge, "It should merge once CI is green.");

    const pending = findPendingResponses(handle.db, [conversation.id as Uuid]);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ action: SCENARIO_ACTION, agentId: agent.id });

    const prompt = await buildDispatchContext(handle.db, getItem(handle.db, conversation.id as Uuid)!, SCENARIO_ACTION);
    expect(prompt).toContain("## The module");
    expect(prompt).toContain(`id: \`${merge}\``);
    expect(prompt).toContain("3 |   const checks = await ctx.exec(\"gh\", [\"pr\", \"checks\", pr]);");
    expect(prompt).toContain('"bin": [');
  });

  // The same turn on each backend: the tools are one server's, and only
  // the way the log spells them differs.
  for (const backend of ["claude", "codex"] as const) {
    it(`writes a case that appears in the module's list, and reports its result and the coverage (${backend})`, async () => {
      const merge = saveMerge();
      expect(getModule(handle.db, merge)!.approvedAt).not.toBeNull();
      const conversation = await say(merge, "When CI is green it merges the pull request.");

      const { comments } = await turn(conversation.id, backend, async (log) => {
        const testId = await writeAndRun(merge, "merges when CI is green", MERGES_WHEN_GREEN, log);
        return { message: "Saved “merges when CI is green”. It passed; line coverage is now 83%.", questions: [], testId, diagnosis: null, change: null };
      });

      expect(listModuleTests(handle.db, merge).map((test) => test.description)).toEqual(["merges when CI is green"]);
      const record = comments.find((comment) => comment.authorType === "engine")!;
      expect(record.body).toMatch(/^\*\*Passed:\*\* “merges when CI is green”/);
      expect(record.body).toMatch(/Coverage: \d+(\.\d+)?% of lines \(\d+ of \d+\), \d+(\.\d+)?% of branches/);
      // The code did not move; the new case withdrew the approval (EO-498).
      expect(getModule(handle.db, merge)).toMatchObject({ code: MERGE, approvedAt: null });
      expect(comments.some((comment) => comment.kind === "rejection")).toBe(false);
    });
  }

  it("puts the evidence for a failing case in the chat and asks how to resolve it", async () => {
    const merge = saveMerge();
    const conversation = await say(merge, "If CI is red it should wait and check again.");

    const { comments } = await turn(conversation.id, "claude", async (log) => {
      const testId = await writeAndRun(merge, "retries a red check", RETRIES_RED_CI, log);
      return {
        message: "It failed: the module gives up on the first red check instead of checking again.",
        questions: [{ id: "q", question: "How should this be resolved?", why: "Either the case or the module is wrong.", options: ["The test is wrong", "The module is wrong"] }],
        testId,
        diagnosis: { scripted: ["gh pr checks 12", "gh pr checks 12", "gh pr merge 12 --squash"], made: ["gh pr checks 12"], lines: [{ from: 3, to: 4 }] },
        change: null,
      };
    });

    const record = comments.find((comment) => comment.authorType === "engine")!;
    expect(record.body).toMatch(/^\*\*Failed:\*\* “retries a red check”/);

    const evidence = comments.find((comment) => comment.body.startsWith("**Why “retries a red check” failed**"))!;
    expect(evidence.authorType).toBe("agent");
    // The failing assertion, out of the stored run.
    expect(evidence.body).toContain("expected the module to retry a red check");
    // The calls compared, with the ones that differ marked.
    expect(evidence.body).toContain("| 1 | `gh pr checks 12` | `gh pr checks 12` |  |");
    expect(evidence.body).toContain("| 2 | `gh pr checks 12` | — | ≠ |");
    // What the module printed — the scripted call's output.
    expect(evidence.body).toContain("lint failed");
    // The module's own lines, quoted from its code rather than the turn's.
    expect(evidence.body).toContain('3 |   const checks = await ctx.exec("gh", ["pr", "checks", pr]);');
    expect(evidence.body).toContain('4 |   if (checks.code !== 0) return { ok: false, reason: "CI is failing" };');

    // And the question, as a card.
    const question = comments.find((comment) => comment.kind === "question")!;
    expect(question.options).toEqual(["The test is wrong", "The module is wrong"]);
    expect(getModule(handle.db, merge)?.code).toBe(MERGE);
  });

  it("says so in the thread when a turn writes the module itself, on either backend's spelling", async () => {
    const merge = saveMerge();
    const conversation = await say(merge, "Just fix it.");

    for (const backend of ["claude", "codex"] as const) {
      const { comments } = await turn(conversation.id, backend, async (log) => {
        log("module_save");
        log("module_approve", false); // refused: wrote nothing, so not counted
        return { message: "Done.", questions: [], testId: null, diagnosis: null, change: null };
      });
      const warning = comments.find((comment) => comment.kind === "rejection");
      expect(warning?.authorType, backend).toBe("engine");
      expect(warning?.body).toContain("`module_save`");
      expect(warning?.body).not.toContain("module_approve");
    }
  });
});

describe("a case written on an approved module (EO-501)", () => {
  /** The module with one passing case, approved — as a person would have left it. */
  function approvedWithACase(): { merge: string; caseId: string } {
    const merge = saveMerge(false);
    const saved = saveModuleTest(handle.db, { moduleId: merge, description: "merges when CI is green", source: MERGES_WHEN_GREEN });
    if (!saved.ok) throw new Error(saved.reason);
    approveModule(handle.db, merge);
    expect(getModule(handle.db, merge)!.approvedAt).not.toBeNull();
    return { merge, caseId: saved.test.id };
  }

  /** What each kind of write a scenario turn makes looks like, played through the real tools. */
  const writes = {
    added: async (merge: string, _caseId: string, log: Log) => writeAndRun(merge, "merges a second time", MERGES_WHEN_GREEN, log),
    changed: async (merge: string, caseId: string, log: Log) => writeAndRun(merge, "merges when CI is green, squashed", MERGES_WHEN_GREEN, log, caseId),
    deleted: async (merge: string, caseId: string, log: Log) => {
      // Another case first, so a module is never left with none to approve by.
      const kept = saveModuleTest(handle.db, { moduleId: merge, description: "merges again", source: MERGES_WHEN_GREEN });
      if (!kept.ok) throw new Error(kept.reason);
      approveModule(handle.db, merge);
      const deleted = await adminCall("module_test_delete", { id: caseId });
      log("module_test_delete", deleted.ok, deleted.text, { id: caseId });
      if (!deleted.ok || deleted.data["deleted"] !== true) throw new Error(`not deleted: ${deleted.text}`);
      await runTests(merge, log);
      return null;
    },
  } as const;

  for (const backend of ["claude", "codex"] as const) {
    for (const [change, write] of Object.entries(writes)) {
      it(`says under the reply that a case it ${change} withdrew the module's approval, and marks the record for Approve (${backend})`, async () => {
        const { merge, caseId } = approvedWithACase();
        const conversation = await say(merge, "Write that scenario.");

        const { comments } = await turn(conversation.id, backend, async (log) => {
          const testId = await write(merge, caseId, log);
          // The message says nothing about approval: the record must not depend on it.
          return { message: "Done, and it passed.", questions: [], testId, diagnosis: null, change: null };
        });

        expect(getModule(handle.db, merge)!.approvedAt).toBeNull();
        const record = comments.find((comment) => comment.authorType === "engine" && comment.body.includes("is no longer approved"));
        expect(record?.body).toContain("**Merge pull request is no longer approved.**");
        expect(record?.body).toContain(`This turn ${change} one of its test cases`);
        expect(record?.body).toContain("Approving runs every case");

        const view = openScenario(handle.db, { moduleId: merge }).conversation;
        const marked = view.messages.filter((message) => message.approvalWithdrawn);
        expect(marked.map((message) => message.id)).toEqual([record!.id]);
        expect(marked[0]!.approvalWithdrawn).toEqual({ moduleId: merge });
        expect(marked[0]!.authorType).toBe("engine");
        // Nothing else in the thread offers it.
        expect(view.messages.filter((message) => message.id !== record!.id).every((message) => message.approvalWithdrawn === null)).toBe(true);
      });
    }
  }

  it("is approved again from there: Approve runs the tests and names a failing case, and passes once it is fixed", async () => {
    registerHandler("modules:approve", (payload) => approveModuleCommand(handle.db, runner, payload), opts);
    const { merge } = approvedWithACase();
    const conversation = await say(merge, "If CI is red it should wait and check again.");

    let failing = "";
    await turn(conversation.id, "claude", async (log) => {
      failing = await writeAndRun(merge, "retries a red check", RETRIES_RED_CI, log);
      return {
        message: "It failed.",
        questions: [{ id: "q", question: "How should this be resolved?", why: "Either the case or the module is wrong.", options: ["The test is wrong", "The module is wrong"] }],
        testId: failing,
        diagnosis: { scripted: ["gh pr checks 12", "gh pr checks 12", "gh pr merge 12 --squash"], made: ["gh pr checks 12"], lines: [{ from: 3, to: 4 }] },
        change: null,
      };
    });
    const record = openScenario(handle.db, { moduleId: merge }).conversation.messages.find((message) => message.approvalWithdrawn)!;

    // What the record's Approve sends.
    const refused = await approveModuleCommand(handle.db, runner, { id: record.approvalWithdrawn!.moduleId, acknowledgeLowCoverage: true });
    expect(refused.approved).toBe(false);
    expect(refused.problem).toContain("retries a red check");
    expect(getModule(handle.db, merge)!.approvedAt).toBeNull();

    saveModuleTest(handle.db, { id: failing, moduleId: merge, description: "merges when CI is green, again", source: MERGES_WHEN_GREEN });
    const approved = await approveModuleCommand(handle.db, runner, { id: merge, acknowledgeLowCoverage: true });
    expect(approved.approved).toBe(true);
    expect(getModule(handle.db, merge)!.approvedAt).not.toBeNull();
  });

  it("says nothing about approval on a module that was not approved", async () => {
    const merge = saveMerge(false);
    const conversation = await say(merge, "When CI is green it merges the pull request.");

    const { comments } = await turn(conversation.id, "claude", async (log) => {
      const testId = await writeAndRun(merge, "merges when CI is green", MERGES_WHEN_GREEN, log);
      return { message: "Saved it, and it passed.", questions: [], testId, diagnosis: null, change: null };
    });

    expect(comments.some((comment) => comment.body.includes("no longer approved"))).toBe(false);
    expect(openScenario(handle.db, { moduleId: merge }).conversation.messages.some((message) => message.approvalWithdrawn)).toBe(false);
  });

  it("does not take a case whose description reads like the withdrawal for one, on a module that was not approved", async () => {
    const merge = saveMerge(false);
    const conversation = await say(merge, "Call the case after what EO says.");

    const { comments } = await turn(conversation.id, "claude", async (log) => {
      const testId = await writeAndRun(merge, "This withdrew the module's approval: its test cases are no longer the ones that were approved", MERGES_WHEN_GREEN, log);
      return { message: "This withdrew the module's approval.", questions: [], testId, diagnosis: null, change: null };
    });

    expect(comments.some((comment) => comment.authorType === "engine" && comment.body.includes("no longer approved"))).toBe(false);
    expect(openScenario(handle.db, { moduleId: merge }).conversation.messages.some((message) => message.approvalWithdrawn)).toBe(false);
  });

  it("says so even when the log keeps only the tail of the save's answer", async () => {
    const { merge } = approvedWithACase();
    const conversation = await say(merge, "It reads files under each repository.");
    // Enough machine-specific values that EO's advice about them pushes the start of the answer out of the log's bound.
    const paths = Array.from({ length: 40 }, (_, index) => `"/home/dev/repo${index + 1}/src/config/settings.json"`).join(", ");
    const source = MERGES_WHEN_GREEN.replace("export default", `const fixtures = [${paths}];\nvoid fixtures;\nexport default`);

    const { runId, comments } = await turn(conversation.id, "codex", async (log) => {
      const testId = await writeAndRun(merge, "reads each repository's settings", source, log);
      return { message: "Saved it, and it passed.", questions: [], testId, diagnosis: null, change: null };
    });

    const saved = listRunEvents(handle.db, runId).find((event) => event.type === "tool_result" && (event.payload as { name?: string }).name?.endsWith("module_test_save"));
    const payload = saved!.payload as { output: string; truncated: boolean };
    expect(payload.truncated).toBe(true);
    expect(payload.output).not.toContain("This withdrew the module's approval");

    const record = comments.find((comment) => comment.authorType === "engine" && comment.body.includes("is no longer approved"));
    expect(record?.body).toContain("**Merge pull request is no longer approved.** This turn added one of its test cases");
  });

  it("says nothing on an approved module when the turn only reads and runs its cases", async () => {
    const { merge } = approvedWithACase();
    const conversation = await say(merge, "Run its tests.");

    const { comments } = await turn(conversation.id, "codex", async (log) => {
      await runTests(merge, log);
      return { message: "They pass.", questions: [], testId: null, diagnosis: null, change: null };
    });

    expect(getModule(handle.db, merge)!.approvedAt).not.toBeNull();
    expect(comments.some((comment) => comment.body.includes("no longer approved"))).toBe(false);
  });
});

describe("a proposed change to the module", () => {
  const FIXED = MERGE.replace('if (checks.code !== 0) return { ok: false, reason: "CI is failing" };', 'if (checks.code !== 0) return { ok: false, reason: "CI is failing: " + checks.tail };');

  async function proposed(merge: string) {
    const conversation = await say(merge, "The module is wrong — fix it so the reason says what CI printed.");
    const { comments } = await turn(conversation.id, "codex", async () => ({
      message: "Here is the fix.",
      questions: [],
      testId: null,
      diagnosis: null,
      change: { summary: "Puts CI's output in the reason.", code: FIXED },
    }));
    const card = comments.find((comment) => comment.kind === PROPOSAL_KIND)!;
    return { conversation, card };
  }

  it("is shown as a diff and saves nothing until it is applied; applying saves the code and withdraws approval", async () => {
    const merge = saveMerge(true);
    const { conversation, card } = await proposed(merge);

    expect(card.body).toContain("```diff");
    expect(card.body).toContain('-  if (checks.code !== 0) return { ok: false, reason: "CI is failing" };');
    expect(card.body).toContain('+  if (checks.code !== 0) return { ok: false, reason: "CI is failing: " + checks.tail };');
    expect(card.body).toContain("withdraws the module's approval");
    // Shown, not saved.
    const before = getModule(handle.db, merge)!;
    expect(before.code).toBe(MERGE);
    expect(before.approvedAt).not.toBeNull();
    const view = openScenario(handle.db, { moduleId: merge }).conversation;
    expect(view.messages.find((message) => message.id === card.id)).toMatchObject({ canApprove: true, approves: "changes" });

    const applied = applyScenarioChangeCommand(handle.db, undefined, runner, { conversationId: conversation.id, messageId: card.id });
    expect(applied).toMatchObject({ applied: true, problem: null });
    expect(getModule(handle.db, merge)).toMatchObject({ code: FIXED, approvedAt: null });
    // Said in the thread, and the card is spent.
    expect(applied.conversation.messages.find((message) => message.parentId === card.id)).toMatchObject({ kind: "approval" });
    expect(applied.conversation.messages.find((message) => message.id === card.id)?.canApprove).toBe(false);
    expect(applyScenarioChangeCommand(handle.db, undefined, runner, { conversationId: conversation.id, messageId: card.id }).applied).toBe(false);
  });

  it("is refused when the module's code changed since it was proposed", async () => {
    const merge = saveMerge(false);
    const { conversation, card } = await proposed(merge);
    const edited = MERGE.replace("--squash", "--rebase");
    saveModule(handle.db, { id: merge, slug: "merge-pr", name: "Merge pull request", description: "Merges once CI passes.", code: edited, manifest });

    const applied = applyScenarioChangeCommand(handle.db, undefined, runner, { conversationId: conversation.id, messageId: card.id });
    expect(applied.applied).toBe(false);
    expect(applied.problem).toContain("has changed since this was proposed");
    expect(getModule(handle.db, merge)?.code).toBe(edited);
  });

  /** The module's manifest, no longer asking for `gh` to be able to comment. */
  const QUIETER: ModuleManifest = { ...manifest, needs: { ...manifest.needs, comment: false } };

  it("may carry a manifest: the card shows its diff, and applying saves it (EO-418)", async () => {
    const merge = saveMerge(true);
    const conversation = await say(merge, "It never comments — fix the module and what it declares.");
    const { comments } = await turn(conversation.id, "codex", async () => ({
      message: "Here is the fix.",
      questions: [],
      testId: null,
      diagnosis: null,
      change: { summary: "Stops declaring comments it never posts.", code: FIXED, manifest: QUIETER },
    }));
    const card = comments.find((comment) => comment.kind === PROPOSAL_KIND)!;

    expect(card.body).toContain("**Manifest**");
    expect(card.body).toContain('-    "comment": true,');
    expect(card.body).toContain('+    "comment": false,');
    // Shown, not saved.
    expect(getModule(handle.db, merge)).toMatchObject({ code: MERGE, manifest });

    const applied = applyScenarioChangeCommand(handle.db, undefined, runner, { conversationId: conversation.id, messageId: card.id });

    expect(applied).toMatchObject({ applied: true, problem: null });
    expect(getModule(handle.db, merge)).toMatchObject({ code: FIXED, manifest: QUIETER, approvedAt: null, slug: "merge-pr", source: "user" });
    expect(applied.conversation.messages.find((message) => message.parentId === card.id)?.body).toContain("code and manifest are saved");
  });

  // Decided on EO-418: a manifest that fails validation fails the reply
  // at EO's own boundary, so the turn is sent back to the agent with the
  // reason and nothing is posted — here as in the help chat.
  const UNDESCRIBED = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "description"));
  const BROKEN: [string, unknown, string][] = [
    ["declares no result", { ...manifest, results: [] }, "change.manifest.results"],
    ["has no description", UNDESCRIBED, "change.manifest.description"],
    ["gives its results as a sentence", { ...manifest, results: "merged" }, "change.manifest.results"],
    ["names an environment variable that is not a name", { ...manifest, needs: { ...manifest.needs, env: ["GH-TOKEN"] } }, "change.manifest.needs.env.0"],
    ["declares an input of a type no input has", { ...manifest, inputs: { pr: { type: "date" } } }, "change.manifest.inputs.pr.type"],
    ["is not an object", "as it is now", "change.manifest"],
  ];
  for (const [what, broken, where] of BROKEN) {
    it(`is refused at EO's validation of the reply, naming the field, when the change's manifest ${what}`, async () => {
      const merge = saveMerge(true);
      const conversation = await say(merge, "Fix the module and what it declares.");
      const said = listCommentsForItem(handle.db, conversation.id as Uuid).length;
      const reply = { message: "Here is the fix.", questions: [], testId: null, diagnosis: null, change: { summary: "Changes what it declares.", code: FIXED, manifest: broken } };

      const validated = validateActionResult(developerRegistry(), "scenario", reply);

      expect(validated.ok).toBe(false);
      expect(!validated.ok && validated.error).toContain(where);
      // A result that failed is not one a reply is posted from: no card, no rejection, nothing written.
      const row = getItem(handle.db, conversation.id as Uuid)!;
      const run = createRun(handle.db, { itemId: row.id, agentId: agent.id, action: SCENARIO_ACTION, initiationId: null });
      postScenarioReply(handle.db, row, agent.id, run.id, reply);
      expect(listCommentsForItem(handle.db, row.id)).toHaveLength(said);
      expect(getModule(handle.db, merge)).toMatchObject({ code: MERGE, manifest });
      expect(getModule(handle.db, merge)?.approvedAt).not.toBeNull();
    });
  }

  it("passes that validation with a valid manifest, and with none", () => {
    const base = { message: "Here is the fix.", questions: [], testId: null, diagnosis: null };
    expect(validateActionResult(developerRegistry(), "scenario", { ...base, change: { summary: "x", code: FIXED, manifest: QUIETER } }).ok).toBe(true);
    expect(validateActionResult(developerRegistry(), "scenario", { ...base, change: { summary: "x", code: FIXED, manifest: null } }).ok).toBe(true);
    expect(validateActionResult(developerRegistry(), "scenario", { ...base, change: { summary: "x", code: FIXED } }).ok).toBe(true);
  });

  it("leaves the manifest as it is when the change's manifest is null", async () => {
    const merge = saveMerge(true);
    const conversation = await say(merge, "Fix it.");
    const { comments } = await turn(conversation.id, "codex", async () => ({
      message: "Here is the fix.",
      questions: [],
      testId: null,
      diagnosis: null,
      change: { summary: "Puts CI's output in the reason.", code: FIXED, manifest: null },
    }));
    const card = comments.find((comment) => comment.kind === PROPOSAL_KIND)!;
    expect(card.body).toContain("_The manifest is left as it is._");

    expect(applyScenarioChangeCommand(handle.db, undefined, runner, { conversationId: conversation.id, messageId: card.id }).applied).toBe(true);
    expect(getModule(handle.db, merge)).toMatchObject({ code: FIXED, manifest });
  });

  it("is refused when the module's manifest changed since it was proposed", async () => {
    const merge = saveMerge(false);
    const { conversation, card } = await proposed(merge);
    saveModule(handle.db, { id: merge, slug: "merge-pr", name: "Merge pull request", description: "Merges once CI passes.", code: MERGE, manifest: QUIETER });

    const applied = applyScenarioChangeCommand(handle.db, undefined, runner, { conversationId: conversation.id, messageId: card.id });

    expect(applied.applied).toBe(false);
    expect(applied.problem).toContain("manifest has changed since this was proposed");
    expect(getModule(handle.db, merge)).toMatchObject({ code: MERGE, manifest: QUIETER });
  });

  it("still applies a card posted before the manifest travelled, which recorded the code's hash alone", async () => {
    const merge = saveMerge(true);
    // `proposed` returns a change with no `manifest` key, as that build's runs stored it.
    const { conversation, card } = await proposed(merge);
    // What that build wrote beside the card: the sha256 of the code, as a string.
    const row = getItem(handle.db, conversation.id as Uuid)!;
    const scope = row.spec!["scenario"] as Record<string, unknown>;
    updateItem(handle.db, row.id, { spec: { ...row.spec, scenario: { ...scope, changes: { [card.id]: createHash("sha256").update(MERGE).digest("hex") } } } });

    const applied = applyScenarioChangeCommand(handle.db, undefined, runner, { conversationId: conversation.id, messageId: card.id });

    expect(applied).toMatchObject({ applied: true, problem: null });
    expect(getModule(handle.db, merge)).toMatchObject({ code: FIXED, manifest, approvedAt: null });
  });

  it("refuses a reply that both asks and proposes a change, manifest or not", () => {
    const question = { id: "q", question: "Is the test wrong?", why: "It decides the fix.", options: ["The test", "The module"] };
    const asking = { message: "Which?", questions: [question], testId: null, diagnosis: null };
    expect(ScenarioOutputSchema.safeParse({ ...asking, change: null }).success).toBe(true);
    expect(ScenarioOutputSchema.safeParse({ ...asking, change: { summary: "x", code: FIXED } }).success).toBe(false);
    expect(ScenarioOutputSchema.safeParse({ ...asking, change: { summary: "x", code: FIXED, manifest: QUIETER } }).success).toBe(false);
  });

  it("only applies to a scenario thread's own cards", async () => {
    const merge = saveMerge();
    const { conversation } = await proposed(merge);
    expect(() => applyScenarioChangeCommand(handle.db, undefined, runner, { conversationId: "missing", messageId: "x" })).toThrow("That conversation does not exist.");
    expect(applyScenarioChangeCommand(handle.db, undefined, runner, { conversationId: conversation.id, messageId: "not-a-card" }).applied).toBe(false);
  });
});

describe("answering a card", () => {
  it("answers through the shared batch path and starts the next turn", async () => {
    const merge = saveMerge();
    const conversation = await say(merge, "It should handle a closed PR.");
    await turn(conversation.id, "claude", async () => ({
      message: "What should it do with a closed pull request?",
      questions: [{ id: "q", question: "Refuse, or report merged?", why: "The case asserts one of them.", options: ["Refuse", "Report merged"] }],
      testId: null,
      diagnosis: null,
      change: null,
    }));
    const question = listCommentsForItem(handle.db, conversation.id as Uuid).find((comment) => comment.kind === "question")!;

    const answered = answerScenarioQuestions(handle.db, undefined, { conversationId: conversation.id, answers: [{ questionId: question.id, answer: "Refuse" }] });
    expect(answered).toMatchObject({ answered: 1, problem: null });
    expect(findPendingResponses(handle.db, [conversation.id as Uuid])[0]?.action).toBe(SCENARIO_ACTION);
  });
});

/**
 * The boundary, end to end: the real admin host, given the same guard
 * `startMain` hands it, answering a real MCP client (EO-356).
 *
 * The rule is checked before the tool runs — so what is asserted is that
 * the module's code and approval did not move, not merely that somebody
 * was told afterwards.
 */
describe("eo_admin while a scenario turn is running", () => {
  async function adminClient(observeCall?: (tool: string, args: unknown, data: unknown) => void) {
    registerHandler("modules:save", (payload) => saveModuleCommand(handle.db, payload), opts);
    registerHandler("modules:approve", (payload) => approveModuleCommand(handle.db, runner, payload), opts);
    registerHandler("modules:archive", (payload) => archiveModuleCommand(handle.db, payload), opts);
    const host = createAdminMcpHost({
      db: handle.db,
      version: "0.0.0-test",
      refuseCall: (tool, args) => scenarioModuleWriteRefusal(handle.db, tool, args),
      ...(observeCall ? { observeCall } : {}),
    });
    await host.start();
    const endpoint = host.endpoint()!;
    // One turn's bearer (EO-444): the host mints them per turn now.
    const token = endpoint.lease().token;
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    );
    return { client, stop: async () => { await client.close(); await host.stop(); } };
  }

  const textOf = (result: unknown) => ((result as { content: { text: string }[] }).content[0]?.text ?? "");

  it("refuses to save, approve or archive that module before anything is written, and lets everything else through", async () => {
    const merge = saveMerge(true);
    const before = getModule(handle.db, merge)!;
    const conversation = await say(merge, "Just fix it.");
    const run = createRun(handle.db, { itemId: conversation.id as Uuid, agentId: agent.id, action: SCENARIO_ACTION, status: "running" });
    const other = saveModule(handle.db, { slug: "tag", name: "Tag", description: "Tags.", code: MERGE, manifest, source: "user" });
    if (!other.ok) throw new Error(other.reason);

    const { client, stop } = await adminClient();
    try {
      const save = await client.callTool({
        name: "module_save",
        arguments: { id: merge, slug: "merge-pr", name: "Merge pull request", description: "Merges once CI passes.", code: "export default async () => ({ ok: true, result: 'merged' })", manifest, originalScript: null },
      });
      expect(save.isError).toBe(true);
      expect(textOf(save)).toContain("EO refused module_save: a scenario chat about this module is running");
      for (const name of ["module_approve", "module_archive"]) {
        const refused = await client.callTool({ name, arguments: { id: merge } });
        expect(refused.isError, name).toBe(true);
        expect(textOf(refused)).toContain(`EO refused ${name}`);
      }
      expect(getModule(handle.db, merge)).toMatchObject({ code: before.code, approvedAt: before.approvedAt, archivedAt: null });

      // Another module, and the module's tests, are none of this rule's business.
      const unrelated = await client.callTool({ name: "module_archive", arguments: { id: other.module.id } });
      expect(unrelated.isError).toBe(false);
      const testSaved = await client.callTool({ name: "module_test_save", arguments: { moduleId: merge, description: "merges when CI is green", source: MERGES_WHEN_GREEN } });
      expect(testSaved.isError).toBe(false);

      // Once the turn has ended, the module is anybody's to change again.
      updateRun(handle.db, run.id, { status: "succeeded" });
      const after = await client.callTool({ name: "module_archive", arguments: { id: merge } });
      expect(after.isError).toBe(false);
      expect(getModule(handle.db, merge)?.archivedAt).not.toBeNull();
    } finally {
      await stop();
    }
  });

  it("records a case write that withdrew the module's approval against the running scenario turn, from the call's own answer (EO-501)", async () => {
    const merge = saveMerge(true);
    const conversation = await say(merge, "Write that scenario.");
    const run = createRun(handle.db, { itemId: conversation.id as Uuid, agentId: agent.id, action: SCENARIO_ACTION, status: "running" });

    const { client, stop } = await adminClient((tool, args, data) => recordScenarioApprovalWithdrawal(handle.db, tool, args, data));
    try {
      const saved = await client.callTool({ name: "module_test_save", arguments: { moduleId: merge, description: "merges when CI is green", source: MERGES_WHEN_GREEN } });
      expect(saved.isError).toBe(false);
    } finally {
      await stop();
    }

    const scope = getItem(handle.db, conversation.id as Uuid)!.spec?.[SCENARIO_SETTINGS_KEY] as Record<string, unknown>;
    expect(scope["withdrawnBy"]).toEqual({ [run.id]: { moduleId: merge, change: "added" } });
  });
});

describe("telling EO what an eo_admin call did (EO-501)", () => {
  it("reports a call that ran with its answer's data, and not one that was refused", async () => {
    const merge = saveMerge(false);
    const seen: { tool: string; args: unknown; data: unknown }[] = [];
    const observe = (tool: string, args: unknown, data: unknown) => void seen.push({ tool, args, data });

    await answerToolCall({ name: "module_tests_list", arguments: { moduleId: merge } }, "admin", true, undefined, observe);
    await answerToolCall({ name: "module_tests_list", arguments: { moduleId: merge } }, "admin", true, () => "No.", observe);

    expect(seen).toEqual([{ tool: "module_tests_list", args: { moduleId: merge }, data: { tests: [], problem: null } }]);
  });

  it("answers the call even when what observes it throws", async () => {
    const merge = saveMerge(false);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await answerToolCall({ name: "module_tests_list", arguments: { moduleId: merge } }, "admin", true, undefined, () => {
        throw new Error("boom");
      });
      expect(result.isError).toBe(false);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("records nothing without a running scenario turn on the module, or when the write withdrew nothing", async () => {
    const merge = saveMerge(true);
    const conversation = await say(merge, "Write that scenario.");
    const scope = () => (getItem(handle.db, conversation.id as Uuid)!.spec?.[SCENARIO_SETTINGS_KEY] ?? {}) as Record<string, unknown>;

    // Queued is not running: no call can be its yet.
    const run = createRun(handle.db, { itemId: conversation.id as Uuid, agentId: agent.id, action: SCENARIO_ACTION, status: "queued" });
    recordScenarioApprovalWithdrawal(handle.db, "module_test_save", { moduleId: merge }, { saved: true, approvalWithdrawn: true });
    expect(scope()["withdrawnBy"]).toBeUndefined();

    updateRun(handle.db, run.id, { status: "running" });
    recordScenarioApprovalWithdrawal(handle.db, "module_test_save", { moduleId: merge }, { saved: true, approvalWithdrawn: false });
    recordScenarioApprovalWithdrawal(handle.db, "module_tests_run", { moduleId: merge }, { approvalWithdrawn: true });
    expect(scope()["withdrawnBy"]).toBeUndefined();

    // A delete names its module in its answer; the first withdrawal a turn makes is the one kept.
    recordScenarioApprovalWithdrawal(handle.db, "module_test_delete", { id: "gone" }, { deleted: true, approvalWithdrawn: true, moduleId: merge });
    recordScenarioApprovalWithdrawal(handle.db, "module_test_save", { moduleId: merge }, { saved: true, approvalWithdrawn: true });
    expect(scope()["withdrawnBy"]).toEqual({ [run.id]: { moduleId: merge, change: "deleted" } });
  });
});
