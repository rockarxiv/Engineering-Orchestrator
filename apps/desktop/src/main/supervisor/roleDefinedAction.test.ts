import { outputSchemaFor, developerRegistry, type AgentEvent, type AgentProviderStartOptions, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createAgent } from "../db/repos/agentsRepo.js";
import { saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { listCommentsForItem } from "../db/repos/commentsRepo.js";
import { createRoute } from "../db/repos/index.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { createStep } from "../db/repos/pipelineStepsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { listTransitionsForItem, transitionItem } from "../db/repos/transitionsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/**
 * A provider that answers each turn with the next scripted result and
 * keeps what every turn was sent: the schema, the prompt and, on a
 * resume, the correction.
 */
function recordingProvider(results: unknown[]) {
  let index = 0;
  const started: AgentProviderStartOptions[] = [];
  const corrections: string[] = [];

  async function* emit(): AsyncIterable<AgentEvent> {
    const data = results[Math.min(index, results.length - 1)];
    index += 1;
    yield { type: "result", data };
  }

  return {
    started,
    corrections,
    provider: {
      async *start(opts: AgentProviderStartOptions): AsyncIterable<AgentEvent> {
        started.push(opts);
        yield { type: "thread_started", threadId: `t${started.length}` };
        yield* emit();
      },
      async *resume(_threadId: string, message: string): AsyncIterable<AgentEvent> {
        corrections.push(message);
        yield* emit();
      },
    },
  };
}

/** The action's own branch of the provider wrapper, beside the clarification. */
function answerBranch(schema: Record<string, unknown> | undefined): { properties: Record<string, { enum?: string[] }>; required: string[] } {
  return (schema?.["properties"] as { outcome: { anyOf: never[] } }).outcome.anyOf[1]!;
}

/**
 * A role's own action, from dispatch to the move (EO-421).
 *
 * `qa` defines `alignment` with two results. Nothing here is the
 * developer pack's: the supervisor is built with no pack wiring at all,
 * which is the point — the schema, the route and the comment are the
 * core's.
 */
describe("a step whose owner role defines its entry action", () => {
  let handle: DbHandle;
  let item: Item;
  let qaId: string;

  beforeEach(() => {
    handle = openMigratedTestDb();
    const qa = createAgent(handle.db, { name: "QA", role: "qa", provider: "claude", instructions: "You check work." });
    qaId = qa.id;
    createStep(handle.db, { id: "check", pipelineId: "default" as never, position: -3, name: "Alignment", type: "agent", ownerRole: "qa", entryAction: "alignment" });
    createStep(handle.db, { id: "rework", pipelineId: "default" as never, position: -2, name: "Rework", type: "user", ownerRole: null, entryAction: null });
    createStep(handle.db, { id: "accepted", pipelineId: "default" as never, position: -1, name: "Accepted", type: "user", ownerRole: null, entryAction: null });
    createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "check", resultKey: "aligned", label: "Aligned", target: "accepted", position: 0 });
    createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "check", resultKey: "gaps_found", label: "Gaps found", target: "rework", position: 1 });

    const saved = saveActionDefinition(handle.db, {
      role: "qa",
      action: "alignment",
      description: "Check the work against what was asked for.",
      results: [
        { key: "aligned", label: "Aligned", meaning: "Everything asked for is there." },
        { key: "gaps_found", label: "Gaps found", meaning: "Something asked for is missing." },
      ],
      fields: { type: "object", properties: { gaps: { type: "array", items: { type: "string" } } } },
    });
    expect(saved.ok).toBe(true);

    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "check" });
  });

  afterEach(() => {
    handle.close();
  });

  it("is dispatched with a schema whose result is exactly the declared keys and which requires summary", async () => {
    const { provider, started } = recordingProvider([{ result: "aligned", summary: "All there." }]);

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    const branch = answerBranch(started[0]?.outputSchema);
    expect(branch.properties["result"]?.enum).toEqual(["aligned", "gaps_found"]);
    expect(branch.required).toEqual(["result", "summary"]);
  });

  it("tells the agent the action's description and each result key with its meaning", async () => {
    const { provider, started } = recordingProvider([{ result: "aligned", summary: "All there." }]);

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    const prompt = started[0]?.context ?? "";
    expect(prompt).toContain("Check the work against what was asked for.");
    expect(prompt).toContain("- `aligned` — Everything asked for is there.");
    expect(prompt).toContain("- `gaps_found` — Something asked for is missing.");
  });

  it("moves the item along the route of the result it answered with", async () => {
    const { provider } = recordingProvider([{ result: "gaps_found", summary: "The export button is missing.", gaps: ["export button"] }]);

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).toBe("rework");
  });

  it("posts the summary as the agent's own comment, once, before the transition", async () => {
    const { provider } = recordingProvider([{ result: "gaps_found", summary: "The export button is missing." }]);

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    const fromTheAgent = listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "agent");
    expect(fromTheAgent).toHaveLength(1);
    expect(fromTheAgent[0]).toMatchObject({ authorType: "agent", authorId: qaId, body: "The export button is missing." });

    const moved = listTransitionsForItem(handle.db, item.id).find((transition) => transition.toStepId === "rework");
    expect(moved).toBeDefined();
    // UUIDv7 ids sort by when they were made, which is the order the
    // thread is read in: the comment is above the move.
    expect(fromTheAgent[0]!.id < moved!.id).toBe(true);
    expect(fromTheAgent[0]!.createdAt).toBeLessThanOrEqual(moved!.ts);
  });

  it("re-prompts an answer outside the enum with the validation issues, and does not move the item", async () => {
    const { provider, corrections } = recordingProvider([{ result: "looks_fine", summary: "Seems OK." }]);

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(corrections.length).toBeGreaterThan(0);
    expect(corrections[0]).toContain('"alignment"');
    expect(corrections[0]).toContain("result");
    expect(getItem(handle.db, item.id)?.stepId).toBe("check");
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "agent")).toHaveLength(0);
  });

  it("recovers when the corrected answer is in the enum", async () => {
    const { provider, corrections } = recordingProvider([{ result: "looks_fine", summary: "Seems OK." }, { result: "aligned", summary: "All there." }]);

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(corrections).toHaveLength(1);
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
  });

  it("gives another role on the same action name its own schema, and a role that defines nothing none at all", async () => {
    createAgent(handle.db, { name: "Editor", role: "editor", provider: "claude", instructions: "You edit." });
    createAgent(handle.db, { name: "Intern", role: "intern", provider: "claude", instructions: "You help." });
    saveActionDefinition(handle.db, { role: "editor", action: "alignment", results: [{ key: "on_brief" }, { key: "off_brief" }] });
    createStep(handle.db, { id: "copy_edit", pipelineId: "default" as never, position: -6, name: "Edit", type: "agent", ownerRole: "editor", entryAction: "alignment" });
    createStep(handle.db, { id: "lend_a_hand", pipelineId: "default" as never, position: -5, name: "Assist", type: "agent", ownerRole: "intern", entryAction: "alignment" });
    createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "copy_edit", resultKey: "on_brief", label: "On brief", target: "accepted", position: 0 });
    createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "lend_a_hand", resultKey: "done", label: "Done", target: "accepted", position: 0 });
    createTestItem(handle.db, { type: "story", title: "For the editor", stepId: "copy_edit" });
    createTestItem(handle.db, { type: "story", title: "For the intern", stepId: "lend_a_hand" });

    const sent = new Map<string, Record<string, unknown> | undefined>();
    const provider = {
      async *start(opts: AgentProviderStartOptions): AsyncIterable<AgentEvent> {
        const role = opts.instructions === "You check work." ? "qa" : opts.instructions === "You edit." ? "editor" : "intern";
        sent.set(role, opts.outputSchema);
        yield { type: "thread_started", threadId: `t-${role}` };
        yield { type: "result", data: role === "qa" ? { result: "aligned", summary: "Yes." } : role === "editor" ? { result: "on_brief", summary: "Yes." } : "Had a look." };
      },
      async *resume(): AsyncIterable<AgentEvent> {
        yield { type: "result", data: "unused" };
      },
    };

    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });
    await supervisor.runOnce();
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(answerBranch(sent.get("qa")).properties["result"]?.enum).toEqual(["aligned", "gaps_found"]);
    expect(answerBranch(sent.get("editor")).properties["result"]?.enum).toEqual(["on_brief", "off_brief"]);
    expect(sent.has("intern")).toBe(true);
    expect(sent.get("intern")).toBeUndefined();
  });

  /**
   * A preview runs on the placeholder backend, whose canned answer is in
   * no shape a person defined. Holding it to the role's definition would
   * end every rehearsal of such a step in a validation guard, so a
   * preview is answered as it always was: no schema for a custom action,
   * and the step's first declared result as its route.
   */
  it("does not hold a preview to the definition: it walks the step's first route", async () => {
    transitionItem(handle.db, { itemId: item.id, toStepId: "accepted", actor: "human" });
    const rehearsal = createTestItem(handle.db, { type: "story", title: "Rehearsal", stepId: "check", previewAt: Date.now() });
    const { provider, started, corrections } = recordingProvider([{ summary: "A placeholder's answer." }]);

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(started[0]?.outputSchema).toBeUndefined();
    expect(started[0]?.context).not.toContain("Check the work against what was asked for.");
    expect(corrections).toEqual([]);
    expect(getItem(handle.db, rehearsal.id)?.stepId).toBe("accepted");
    expect(listCommentsForItem(handle.db, rehearsal.id).filter((comment) => comment.authorType === "agent")).toHaveLength(0);
  });

  it("still holds a custom role with no definition of its own to the pack's implement shape", async () => {
    createStep(handle.db, { id: "build", pipelineId: "default" as never, position: -4, name: "Build", type: "agent", ownerRole: "qa", entryAction: "implement" });
    createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "build", resultKey: "done", label: "Done", target: "accepted", position: 0 });
    const story = createTestItem(handle.db, { type: "story", title: "Built by QA", stepId: "build" });
    // Out of the way, so the one dispatch is the `implement` one.
    transitionItem(handle.db, { itemId: item.id, toStepId: "accepted", actor: "human" });

    const { provider, started, corrections } = recordingProvider([{ result: "aligned", summary: "Built it." }]);
    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(JSON.stringify(started[0]?.outputSchema)).toEqual(JSON.stringify(outputSchemaFor(developerRegistry(), "implement")));
    expect(corrections[0]).toContain("branch");
    expect(getItem(handle.db, story.id)?.stepId).toBe("build");
  });
});
