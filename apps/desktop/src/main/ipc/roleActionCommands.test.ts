import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_MCP_SERVER_NAME, SECTION_LOCKED_CHANNELS, type IpcChannel, type IpcResponse } from "@eo/core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminDeliveryFor, adminDispatchFor } from "../agentAttachments/adminDelivery.js";
import type { DbHandle } from "../db/client.js";
import { markReplica } from "../db/recordRole.js";
import { createPipeline, createStep, currentVersion, getActionDefinition, listActionDefinitions, listAgents, listRetiredStepsForPipeline, publishSection, setItemArchived } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { TOOLS, type Dispatch, type ToolOutcome } from "../mcpHost/catalog.js";
import { toolsFor } from "../mcpHost/gate.js";
import { sourcePromptsDir } from "../roles/prompts.js";

import { fakePlatform } from "../testing/platform.js";
import { listPipelineStepViews } from "./domainQueries.js";
import { clearHandlerRegistry, dispatchIpc } from "./registry.js";

/**
 * The action catalog as the system agent reads and writes it (EO-425).
 *
 * Through the tools rather than the commands behind them, and through
 * the real handlers rather than stand-ins: what is under test is what
 * an agent holding `eo_admin` is answered, including the refusal a
 * managed installation gives before any command is reached.
 */

const directories: string[] = [];
let handle: DbHandle;
let stopBeingAReplica: (() => void) | null = null;

const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);

function tool(name: string) {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

function answered(outcome: ToolOutcome): Extract<ToolOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`the tool failed: ${outcome.message}`);
  return outcome;
}

const ALIGNMENT = {
  role: "qa",
  action: "alignment",
  description: "Checks the work against the brief.",
  results: [
    { key: "aligned", label: "Aligned", meaning: "The work does everything the brief asks." },
    { key: "gaps_found", label: "Gaps found", meaning: "Something the brief asks for is missing." },
  ],
  fields: { properties: { gaps: { type: "array", items: { type: "string" } } }, required: ["gaps"] },
};

/** A pipeline called "Quality" whose "Check" step is `qa` running `alignment`. */
function aStepUsingAlignment(): void {
  const pipeline = createPipeline(handle.db, { name: "Quality" });
  createStep(handle.db, { pipelineId: pipeline.id, position: 0, name: "Check", type: "agent", ownerRole: "qa", entryAction: "alignment" });
}

beforeEach(async () => {
  handle = openMigratedTestDb();
  const platform = fakePlatform();
  directories.push(platform.userDataPath);
  const { registerAllHandlers } = await import("./handlers.js");
  registerAllHandlers(handle.db, undefined, { platform });
});

afterEach(() => {
  stopBeingAReplica?.();
  stopBeingAReplica = null;
  clearHandlerRegistry();
  handle.close();
});

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe("registry_get, as the action catalog", () => {
  it("returns qa's alignment with its keys, labels, meanings and fields, and the pipeline and step that use it", async () => {
    answered(await tool("role_action_save").run(dispatch, ALIGNMENT));
    aStepUsingAlignment();

    const outcome = answered(await tool("registry_get").run(dispatch, {}));
    const data = outcome.data as IpcResponse<"registry:get">;

    expect(data.roleActions).toEqual([
      {
        role: "qa",
        actions: [
          {
            action: "alignment",
            description: "Checks the work against the brief.",
            results: ALIGNMENT.results,
            packShipped: false,
            fields: ALIGNMENT.fields,
            usedBy: [{ pipelineId: expect.any(String), pipelineName: "Quality", stepId: expect.any(String), stepName: "Check" }],
          },
        ],
      },
    ]);

    // And the same answer in the words a transcript reader gets.
    expect(outcome.text).toContain('qa / alignment (defined by the role) — Checks the work against the brief.');
    expect(outcome.text).toContain("result `aligned` (Aligned) — The work does everything the brief asks.");
    expect(outcome.text).toContain("result `gaps_found` (Gaps found) — Something the brief asks for is missing.");
    expect(outcome.text).toContain('"gaps"');
    expect(outcome.text).toContain('used by "Check" (Quality)');
  });

  it("lists a pack's own action as shipped, with the shipped pipeline's step that uses it", async () => {
    const outcome = answered(await tool("registry_get").run(dispatch, {}));
    const data = outcome.data as IpcResponse<"registry:get">;
    const review = data.roles.find((role) => role.slug === "reviewer")?.actions?.find((action) => action.action === "review");

    expect(review?.packShipped).toBe(true);
    expect(review?.results.map((result) => result.key)).toEqual(["approved", "changes_requested", "needs_user_input"]);
    expect(review?.usedBy?.length).toBeGreaterThan(0);
    expect(outcome.text).toContain("reviewer / review (ships with the role, read-only)");
  });

  it("lists the plan for other accounts' pull request comments and its review as shipped, with their results (EO-760)", async () => {
    const outcome = answered(await tool("registry_get").run(dispatch, {}));
    const data = outcome.data as IpcResponse<"registry:get">;
    const actionOf = (role: string, action: string) => data.roles.find((entry) => entry.slug === role)?.actions?.find((entry) => entry.action === action);

    expect(actionOf("implementer", "plan_comment_response")?.packShipped).toBe(true);
    expect(actionOf("implementer", "plan_comment_response")?.results.map((result) => result.key)).toEqual(["planned"]);
    expect(actionOf("reviewer", "review_plan")?.packShipped).toBe(true);
    expect(actionOf("reviewer", "review_plan")?.results.map((result) => result.key)).toEqual(["approved", "changes_requested", "needs_user_input"]);
    expect(outcome.text).toContain("implementer / plan_comment_response (ships with the role, read-only)");
    expect(outcome.text).toContain("reviewer / review_plan (ships with the role, read-only)");
  });

  it("lists the reply on the pull request as a built-in function, with its results (EO-761)", async () => {
    const outcome = answered(await tool("registry_get").run(dispatch, {}));
    const data = outcome.data as IpcResponse<"registry:get">;

    expect(data.builtins.find((builtin) => builtin.action === "reply_on_pull_request")?.results).toEqual(["replied", "nothing_to_reply", "failed"]);
    expect(outcome.text).toContain("- reply_on_pull_request: replied, nothing_to_reply, failed");
  });

  it("says a definition no step dispatches is used by none", async () => {
    answered(await tool("role_action_save").run(dispatch, ALIGNMENT));

    const outcome = answered(await tool("registry_get").run(dispatch, {}));

    expect((outcome.data as IpcResponse<"registry:get">).roleActions?.[0]?.actions[0]?.usedBy).toEqual([]);
    expect(outcome.text).toContain("used by no step");
  });
});

describe("role_action_save", () => {
  it("creates a definition, and edits the one that exists", async () => {
    const created = answered(await tool("role_action_save").run(dispatch, ALIGNMENT));
    expect(created.refused).toBe(false);
    expect(created.text).toContain("aligned, gaps_found");
    const first = getActionDefinition(handle.db, "qa", "alignment");
    expect(first?.results.map((result) => result.key)).toEqual(["aligned", "gaps_found"]);

    const edited = answered(
      await tool("role_action_save").run(dispatch, { ...ALIGNMENT, description: "Holds the work to the brief.", results: [...ALIGNMENT.results, { key: "unclear" }] }),
    );
    expect(edited.refused).toBe(false);

    const second = getActionDefinition(handle.db, "qa", "alignment");
    expect(listActionDefinitions(handle.db)).toHaveLength(1);
    expect(second?.id).toBe(first?.id);
    expect(second?.description).toBe("Holds the work to the brief.");
    expect(second?.results.map((result) => result.key)).toEqual(["aligned", "gaps_found", "unclear"]);
  });

  it.each([
    ["no results", { ...ALIGNMENT, results: [] }, "at least one result"],
    ["a repeated key", { ...ALIGNMENT, results: [{ key: "aligned" }, { key: "aligned" }] }, '"aligned" is declared more than once'],
    ["a field named summary", { ...ALIGNMENT, fields: { properties: { summary: { type: "string" } } } }, 'may not be named "summary"'],
    ["an action EO runs for itself", { ...ALIGNMENT, action: "assist" }, '"assist" cannot be defined'],
    ["a pack's own role on its own action", { ...ALIGNMENT, role: "reviewer", action: "review" }, 'reviewer role\'s "review" action cannot be redefined'],
  ])("refuses %s with the reason, and writes nothing", async (_name, draft, reason) => {
    const outcome = answered(await tool("role_action_save").run(dispatch, draft));

    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain(reason);
    expect(outcome.text).toContain("Nothing has changed");
    expect(listActionDefinitions(handle.db)).toEqual([]);
  });

  it("leaves the definition as it was when an edit is refused", async () => {
    answered(await tool("role_action_save").run(dispatch, ALIGNMENT));
    const before = getActionDefinition(handle.db, "qa", "alignment");

    const outcome = answered(await tool("role_action_save").run(dispatch, { ...ALIGNMENT, results: [] }));

    expect(outcome.refused).toBe(true);
    expect(getActionDefinition(handle.db, "qa", "alignment")).toEqual(before);
  });
});

describe("role_action_delete", () => {
  it("is refused while a step uses the definition, naming the pipeline and the step", async () => {
    answered(await tool("role_action_save").run(dispatch, ALIGNMENT));
    aStepUsingAlignment();

    const outcome = answered(await tool("role_action_delete").run(dispatch, { role: "qa", action: "alignment" }));

    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("Quality");
    expect(outcome.text).toContain("Check");
    expect((outcome.data as IpcResponse<"roleActions:delete">).usedBy).toEqual([
      { pipelineId: expect.any(String), pipelineName: "Quality", stepId: expect.any(String), stepName: "Check" },
    ]);
    expect(getActionDefinition(handle.db, "qa", "alignment")).toBeDefined();
  });

  it("is not held by a step another role owns, or one on another action", async () => {
    answered(await tool("role_action_save").run(dispatch, ALIGNMENT));
    const pipeline = createPipeline(handle.db, { name: "Quality" });
    createStep(handle.db, { pipelineId: pipeline.id, position: 0, name: "Theirs", type: "agent", ownerRole: "auditor", entryAction: "alignment" });
    createStep(handle.db, { pipelineId: pipeline.id, position: 1, name: "Other", type: "agent", ownerRole: "qa", entryAction: "smoke" });

    const outcome = answered(await tool("role_action_delete").run(dispatch, { role: "qa", action: "alignment" }));

    expect(outcome.refused).toBe(false);
    expect(getActionDefinition(handle.db, "qa", "alignment")).toBeUndefined();
  });

  /** The shipped Delivery graph, as `pipeline:save` takes it. */
  function delivery() {
    const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });
    return { pipelineId: "default", entryStepId: graph.entryStepId, steps: graph.steps, routes: graph.routes };
  }

  /** Publishes Delivery with a "Check" step added: `qa` running `alignment`, both keys routed. */
  async function publishWithCheck(before: ReturnType<typeof delivery>) {
    const check = { ...before.steps[0]!, id: "qa_check", name: "Check", type: "agent" as const, ownerRole: "qa", entryAction: "alignment", isTerminal: false, position: 99 };
    const withCheck = {
      ...before,
      steps: [...before.steps, check],
      routes: [
        ...before.routes,
        { ...before.routes[0]!, id: "qa-aligned", fromStepId: "qa_check", resultKey: "aligned", target: "terminal" },
        { ...before.routes[0]!, id: "qa-gaps", fromStepId: "qa_check", resultKey: "gaps_found", target: "user_attention" },
      ],
    };
    const published = await dispatchIpc("pipeline:save", withCheck);
    expect(published, JSON.stringify(published)).toMatchObject({ ok: true, data: { saved: true } });
    return withCheck;
  }

  async function publish(graph: ReturnType<typeof delivery>) {
    const published = await dispatchIpc("pipeline:save", graph);
    expect(published, JSON.stringify(published)).toMatchObject({ ok: true, data: { saved: true } });
  }

  async function usedByOfAlignment() {
    const catalog = answered(await tool("registry_get").run(dispatch, {}));
    return { text: catalog.text, usedBy: (catalog.data as IpcResponse<"registry:get">).roleActions?.[0]?.actions[0]?.usedBy };
  }

  /**
   * An item finishes on the version it entered on (EO-327), dispatched
   * by that version's definition of each step, while its answer schema
   * is resolved from the definitions as they stand. So a definition a
   * removed step named is still needed for as long as work is bound to
   * the version that has the step.
   */
  it("is still held by a step a publish removed while an item is finishing on the version that has it", async () => {
    answered(await tool("role_action_save").run(dispatch, ALIGNMENT));
    const before = delivery();
    await publishWithCheck(before);
    // Upstream of Check, and bound to the version that has it.
    const item = createTestItem(handle.db, { type: "story", title: "Mid-flight", stepId: "todo" });
    const boundTo = currentVersion(handle.db, "default")!;
    await publish(before);
    expect(currentVersion(handle.db, "default")!.number).toBeGreaterThan(boundTo.number);

    const use = { pipelineId: "default", pipelineName: "Delivery", stepId: "qa_check", stepName: "Check", finishing: { version: boundTo.number, items: 1 } };
    const catalog = await usedByOfAlignment();
    expect(catalog.usedBy).toEqual([use]);
    expect(catalog.text).toContain(`used by "Check" (Delivery v${boundTo.number}, 1 ticket still finishing on it)`);

    const refused = answered(await tool("role_action_delete").run(dispatch, { role: "qa", action: "alignment" }));
    expect(refused.refused).toBe(true);
    expect(refused.text).toContain(`"Check" (Delivery v${boundTo.number}, 1 ticket still finishing on it)`);
    // How to clear it, which is not by editing the pipeline.
    expect(refused.text).toContain("finished or been archived");
    expect(refused.text).not.toContain("Give each step of a current pipeline another action");
    expect((refused.data as IpcResponse<"roleActions:delete">).usedBy).toEqual([use]);
    expect(getActionDefinition(handle.db, "qa", "alignment")).toBeDefined();

    // The item goes, and the version is no longer one anything runs on.
    setItemArchived(handle.db, item.id, Date.now());
    expect((await usedByOfAlignment()).usedBy).toEqual([]);
    const outcome = answered(await tool("role_action_delete").run(dispatch, { role: "qa", action: "alignment" }));
    expect(outcome.refused).toBe(false);
    expect(getActionDefinition(handle.db, "qa", "alignment")).toBeUndefined();
  });

  it("is still held by a current step that was given another action while an item keeps its old definition", async () => {
    answered(await tool("role_action_save").run(dispatch, ALIGNMENT));
    answered(await tool("role_action_save").run(dispatch, { ...ALIGNMENT, action: "smoke" }));
    const before = delivery();
    const withCheck = await publishWithCheck(before);
    createTestItem(handle.db, { type: "story", title: "Mid-flight", stepId: "todo" });
    const boundTo = currentVersion(handle.db, "default")!;
    // The same step, still there, now running `smoke`.
    await publish({ ...withCheck, steps: withCheck.steps.map((step) => (step.id === "qa_check" ? { ...step, entryAction: "smoke" } : step)) });

    expect((await usedByOfAlignment()).usedBy).toEqual([
      { pipelineId: "default", pipelineName: "Delivery", stepId: "qa_check", stepName: "Check", finishing: { version: boundTo.number, items: 1 } },
    ]);
    const refused = answered(await tool("role_action_delete").run(dispatch, { role: "qa", action: "alignment" }));
    expect(refused.refused).toBe(true);
    expect(refused.text).toContain(`"Check" (Delivery v${boundTo.number}, 1 ticket still finishing on it)`);
    expect(getActionDefinition(handle.db, "qa", "alignment")).toBeDefined();

    // And `smoke`, which the step runs now, is held the ordinary way.
    const current = answered(await tool("role_action_delete").run(dispatch, { role: "qa", action: "smoke" }));
    expect(current.refused).toBe(true);
    expect(current.text).toContain('"Check" (Delivery)');
    expect(current.text).toContain("Give each step of a current pipeline another action");
  });

  it("says a step once when the current graph and an older version in use both define it the same way", async () => {
    answered(await tool("role_action_save").run(dispatch, ALIGNMENT));
    const withCheck = await publishWithCheck(delivery());
    createTestItem(handle.db, { type: "story", title: "Mid-flight", stepId: "todo" });
    await publish({ ...withCheck, steps: withCheck.steps.map((step) => (step.id === "qa_check" ? { ...step, name: "Check again" } : step)) });

    expect((await usedByOfAlignment()).usedBy).toEqual([{ pipelineId: "default", pipelineName: "Delivery", stepId: "qa_check", stepName: "Check again" }]);
  });

  it("is not held by an older version whose only items have finished", async () => {
    answered(await tool("role_action_save").run(dispatch, ALIGNMENT));
    const before = delivery();
    await publishWithCheck(before);
    const terminal = before.steps.find((step) => step.isTerminal)!;
    createTestItem(handle.db, { type: "story", title: "Done", stepId: terminal.id });
    await publish(before);

    expect((await usedByOfAlignment()).usedBy).toEqual([]);
    expect(answered(await tool("role_action_delete").run(dispatch, { role: "qa", action: "alignment" })).refused).toBe(false);
  });

  /**
   * A step a publish removes is retired, not dropped (EO-327): its row
   * stays, still naming the role and the action. Counting it would make
   * the refusal one its own advice — remove the step — could not clear.
   */
  it("lets go once a publish has removed the last step that used it, though that step's row is kept", async () => {
    answered(await tool("role_action_save").run(dispatch, ALIGNMENT));
    const before = listPipelineStepViews(handle.db, { pipelineId: "default" });
    await publishWithCheck(delivery());

    const using = answered(await tool("role_action_delete").run(dispatch, { role: "qa", action: "alignment" }));
    expect(using.refused).toBe(true);
    expect(using.text).toContain('"Check" (Delivery)');

    const removed = await dispatchIpc("pipeline:save", { pipelineId: "default", entryStepId: before.entryStepId, steps: before.steps, routes: before.routes });
    expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true, data: { saved: true } });
    // Retired rather than gone, which is the state under test.
    expect(listRetiredStepsForPipeline(handle.db, "default").map((retired) => retired.step.id)).toContain("qa_check");

    const catalog = answered(await tool("registry_get").run(dispatch, {}));
    expect((catalog.data as IpcResponse<"registry:get">).roleActions?.[0]?.actions[0]?.usedBy).toEqual([]);

    const outcome = answered(await tool("role_action_delete").run(dispatch, { role: "qa", action: "alignment" }));
    expect(outcome.refused).toBe(false);
    expect(getActionDefinition(handle.db, "qa", "alignment")).toBeUndefined();
  });

  it("removes a definition nothing uses", async () => {
    answered(await tool("role_action_save").run(dispatch, ALIGNMENT));

    const outcome = answered(await tool("role_action_delete").run(dispatch, { role: "qa", action: "alignment" }));

    expect(outcome.refused).toBe(false);
    expect(listActionDefinitions(handle.db)).toEqual([]);
  });

  it("says so when there is no such definition, a pack's own action included", async () => {
    const outcome = answered(await tool("role_action_delete").run(dispatch, { role: "reviewer", action: "review" }));

    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain('reviewer role defines no "review" action');
  });
});

describe("on an installation whose agents section is managed", () => {
  beforeEach(async () => {
    answered(await tool("role_action_save").run(dispatch, ALIGNMENT));
    publishSection(handle.db, {
      section: "agents",
      subjectId: "agents",
      versionId: null,
      versionNumber: null,
      publishedAt: Date.now(),
      publishedBy: "dana-id",
      publishedByName: "Dana",
    });
    stopBeingAReplica = markReplica(handle.db, () => true);
  });

  it("counts both writes among what the agents section locks", () => {
    expect(SECTION_LOCKED_CHANNELS.agents).toContain("roleActions:save");
    expect(SECTION_LOCKED_CHANNELS.agents).toContain("roleActions:delete");
  });

  it("refuses role_action_save naming the section, and writes nothing", async () => {
    const before = listActionDefinitions(handle.db);

    const edit = await tool("role_action_save").run(dispatch, { ...ALIGNMENT, description: "Changed." });
    const create = await tool("role_action_save").run(dispatch, { ...ALIGNMENT, action: "smoke" });

    for (const outcome of [edit, create]) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.message).toContain("The agents section is managed by your organisation");
      expect(outcome.message).toContain("Nothing has been written");
    }
    expect(listActionDefinitions(handle.db)).toEqual(before);
  });

  it("refuses role_action_delete naming the section, and removes nothing", async () => {
    const outcome = await tool("role_action_delete").run(dispatch, { role: "qa", action: "alignment" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("The agents section is managed by your organisation");
    expect(getActionDefinition(handle.db, "qa", "alignment")).toBeDefined();
  });

  it("still answers registry_get, which writes nothing", async () => {
    const outcome = answered(await tool("registry_get").run(dispatch, {}));
    expect(outcome.text).toContain("qa / alignment");
  });
});

describe("the system agent's prompt", () => {
  const prompt = readFileSync(join(sourcePromptsDir(), "system-agent.md"), "utf8");
  const start = prompt.indexOf("### Results and routes");
  const section = prompt.slice(start, prompt.indexOf("### Step ids", start));

  it("no longer carries the Action / Result keys table", () => {
    expect(prompt).not.toContain("| Action | Result keys |");
    // No table at all where it stood, and none of its rows: a key
    // written here is a key that can disagree with the catalog.
    expect(section).not.toMatch(/^\|/m);
    expect(section).not.toContain("`changes_requested`, `needs_user_input`");
    expect(section).not.toContain("`classified_non_feature`");
  });

  it("sends the agent to the catalog, and a step with its own outcomes to its own definition", () => {
    expect(section).toContain("`registry_get`");
    expect(section).toContain("action catalog");
    expect(section).toContain("A step that needs its own outcomes gets its own action definition.");
    expect(section).toContain("Do not borrow a pack action's name");
    expect(section).toContain("`role_action_save`");
    expect(section).toContain("`role_action_delete`");
  });

  // Invariant 12: the tools are named by the server every backend
  // agrees on, never with one harness's punctuation around them.
  it("names its tools by the eo_admin server, and by no backend's punctuation", () => {
    expect(section).toContain(`\`${ADMIN_MCP_SERVER_NAME}\``);
    expect(section).not.toMatch(/mcp__/);
    expect(section).not.toMatch(/\b[a-z_]+\/[a-z_]+\b/);
    expect(section).not.toMatch(/\b(claude|codex)\b/i);
  });

  it("is a newer version than the prompt that carried the table", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(17);
  });
});

describe("both backends' system agent", () => {
  const ENDPOINT = { url: "http://127.0.0.1:54321/mcp", lease: () => ({ token: "a-token", release: () => {} }) };

  /**
   * One catalogue behind one socket. A Claude-backed agent is handed
   * the server in its generated plugin directory (`adminDeliveryFor`)
   * and a Codex-backed one inline (`adminDispatchFor`); both are the
   * same entry, pointing at the listener that serves `toolsFor(true,
   * "admin")`. So a tool is reachable from both exactly when it is in
   * that list — there is no per-backend tool list for it to be missing
   * from.
   */
  it("is delivered the one eo_admin server, which serves all three tools", () => {
    const system = listAgents(handle.db).find((agent) => agent.role === "system")!;
    const claude = adminDeliveryFor(system, () => ENDPOINT);
    const codex = adminDispatchFor(system, () => ENDPOINT);

    expect(claude).toEqual({ url: ENDPOINT.url, envName: expect.any(String) });
    expect(codex?.server).toEqual(claude);

    const served = toolsFor(true, "admin").map((candidate) => candidate.name);
    for (const name of ["registry_get", "role_action_save", "role_action_delete"]) expect(served, name).toContain(name);
  });

  it("advertises role_action_save's arguments as a schema, results and fields included", () => {
    const schema = tool("role_action_save").inputSchema as { properties?: Record<string, unknown>; required?: string[] };

    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(["role", "action", "description", "results", "fields"]));
    expect(schema.required).toEqual(expect.arrayContaining(["role", "action", "results"]));
  });
});
