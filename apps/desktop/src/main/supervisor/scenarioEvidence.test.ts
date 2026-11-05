import type { AgentEvent, ModuleManifest, ModuleTestRun, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getItem, getModule, listModuleTests, listRunsForItem, moduleTestFingerprint, saveModule, saveModuleTest, storeModuleTestResult } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { sendToScenario } from "../ipc/scenarioCommands.js";
import { scenarioResultProblem } from "../roles/scenario.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * A scenario turn that reports a failed case is held to its evidence
 * (EO-356).
 *
 * The rule lives in `scenarioResultProblem`; this is the proof that the
 * supervisor actually applies it where every result is validated — so a
 * reply naming a failed case with no diagnosis and no question is sent
 * back to the agent with what is missing, rather than accepted as an
 * answer, and the corrected reply is the one that lands.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

const manifest: ModuleManifest = {
  name: "Merge pull request",
  description: "Merges.",
  inputs: {},
  needs: { bin: ["gh"], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["merged"],
};

/** Each start or resume answers with the next scripted result; what the supervisor sent back is recorded. */
function providerYielding(results: unknown[]) {
  let index = 0;
  const promptsSeen: string[] = [];
  async function* emit(): AsyncIterable<AgentEvent> {
    const data = results[Math.min(index, results.length - 1)];
    index += 1;
    yield { type: "result", data };
  }
  return {
    promptsSeen,
    provider: {
      async *start(): AsyncIterable<AgentEvent> {
        yield { type: "thread_started", threadId: "t1" };
        yield* emit();
      },
      async *resume(_threadId: string, message: string): AsyncIterable<AgentEvent> {
        promptsSeen.push(message);
        yield* emit();
      },
    },
  };
}

let handle: DbHandle;
let moduleId: string;
let testId: string;

beforeEach(() => {
  handle = openMigratedTestDb();
  const saved = saveModule(handle.db, { slug: "merge-pr", name: "Merge pull request", description: "Merges.", code: "export default async () => ({ ok: false, reason: 'no' })", manifest });
  if (!saved.ok) throw new Error(saved.reason);
  moduleId = saved.module.id;
  const test = saveModuleTest(handle.db, { moduleId, description: "retries a red check", source: "export default async () => {}" });
  if (!test.ok) throw new Error(test.reason);
  testId = test.test.id;

  // The run the turn made, stored as the runner stores it: a failure,
  // taken against exactly what is saved.
  const run: ModuleTestRun = {
    ranAt: 1,
    cases: [{ testId, description: "retries a red check", passed: false, failure: "expected the module to retry a red check", durationMs: 3, output: "$ gh pr checks 12 (scripted)\n" }],
    coverage: { lines: { covered: 2, total: 3, percent: 66.7 }, branches: { covered: 1, total: 2, percent: 50 } },
  };
  storeModuleTestResult(handle.db, moduleId, moduleTestFingerprint(saved.module, listModuleTests(handle.db, moduleId)), run);
});

afterEach(() => {
  handle.close();
});

const complete = () => ({
  message: "It failed: the module gives up on the first red check.",
  testId,
  diagnosis: { scripted: ["gh pr checks 12", "gh pr checks 12"], made: ["gh pr checks 12"], lines: [{ from: 1, to: 1 }] },
  questions: [{ id: "q", question: "How should this be resolved?", why: "Either the case or the module is wrong.", options: ["The test is wrong", "The module is wrong"] }],
});

describe("a scenario turn reporting a failed case", () => {
  it("is sent back until it carries the diagnosis and asks how to resolve it", async () => {
    const conversation = (await sendToScenario(handle.db, undefined, { moduleId, conversationId: null, body: "It should retry a red check.", interrupt: false })).conversation;
    const { provider, promptsSeen } = providerYielding([{ message: "It failed.", testId }, complete()]);

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(promptsSeen).toHaveLength(1);
    expect(promptsSeen[0]).toContain("“retries a red check” failed in the latest run");
    expect(promptsSeen[0]).toContain("`diagnosis`");
    expect(promptsSeen[0]).toContain("a question asking the person how to resolve it");

    const [run] = listRunsForItem(handle.db, conversation.id as Uuid);
    expect(run?.status).toBe("succeeded");
    expect(run?.result).toMatchObject({ parsed: { testId, diagnosis: { made: ["gh pr checks 12"] } } });
  });

  it("is not accepted as an answer when it never supplies them", async () => {
    const conversation = (await sendToScenario(handle.db, undefined, { moduleId, conversationId: null, body: "It should retry a red check.", interrupt: false })).conversation;
    const { provider, promptsSeen } = providerYielding([{ message: "It failed.", testId }]);

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(promptsSeen.length).toBeGreaterThan(0);
    const [run] = listRunsForItem(handle.db, conversation.id as Uuid);
    expect(run?.status).not.toBe("succeeded");
    expect(run?.error).toContain("`diagnosis`");
  });

  it("accepts the fix the person asked for in place of a question", async () => {
    const conversation = (await sendToScenario(handle.db, undefined, { moduleId, conversationId: null, body: "The module is wrong — fix it.", interrupt: false })).conversation;
    const { provider, promptsSeen } = providerYielding([{ ...complete(), questions: [], change: { summary: "Retries.", code: "export default async () => ({ ok: true, result: 'merged' })" } }]);

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(promptsSeen).toEqual([]);
    expect(listRunsForItem(handle.db, conversation.id as Uuid)[0]?.status).toBe("succeeded");
  });
});

describe("scenarioResultProblem", () => {
  async function conversation() {
    const view = (await sendToScenario(handle.db, undefined, { moduleId, conversationId: null, body: "hi", interrupt: false })).conversation;
    return getItem(handle.db, view.id as Uuid)!;
  }

  it("asks nothing of a turn that names no case", async () => {
    expect(scenarioResultProblem(handle.db, await conversation(), { message: "Which exit code?" })).toBeNull();
  });

  it("refuses a case that is not this module's", async () => {
    expect(scenarioResultProblem(handle.db, await conversation(), { message: "Passed.", testId: "nope" })).toContain("not one of Merge pull request's test cases");
  });

  it("refuses a report on a case that has not run against what is saved now", async () => {
    const chat = await conversation();
    // A case added after the run: the stored result is about other cases.
    saveModuleTest(handle.db, { moduleId, description: "merges", source: "export default async () => {}" });
    expect(scenarioResultProblem(handle.db, chat, complete())).toContain("has not been run against the module and cases as they are saved now");
  });

  it("accepts a passed case as it stands", async () => {
    const chat = await conversation();
    const module = getModule(handle.db, moduleId)!;
    const passed: ModuleTestRun = {
      ranAt: 2,
      cases: [{ testId, description: "retries a red check", passed: true, failure: null, durationMs: 3, output: "" }],
      coverage: { lines: { covered: 3, total: 3, percent: 100 }, branches: { covered: 2, total: 2, percent: 100 } },
    };
    storeModuleTestResult(handle.db, moduleId, moduleTestFingerprint(module, listModuleTests(handle.db, moduleId)), passed);
    expect(scenarioResultProblem(handle.db, chat, { message: "Passed.", testId })).toBeNull();
  });
});
