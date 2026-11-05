import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { listItemSummaries } from "../ipc/domainQueries.js";
import { submitItem } from "../ipc/itemCommands.js";
import { submitPlan } from "../ipc/planCommands.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { answerToolCall } from "./server.js";

/**
 * A ticket an agent creates carries the priority it was sent (EO-568),
 * read back the way the agent would read it: through `items_list`.
 *
 * Driven through `answerToolCall`, which is what a client's `tools/call`
 * reaches, so the tool's own input schema and the channel's are both in
 * the path — a priority the boundary strips would read back as 0 here
 * and pass every handler-level test.
 */
const opts = { exposeErrorDetails: true };

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
  registerHandler("work:submitItem", (payload) => submitItem(handle.db, undefined, payload), opts);
  registerHandler("work:submitPlan", (payload) => submitPlan(handle.db, undefined, payload), opts);
  registerHandler("items:list", () => listItemSummaries(handle.db, null), opts);
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

function call(name: string, args: Record<string, unknown>) {
  return answerToolCall({ name, arguments: args }, "admin", true);
}

/** Each listed ticket's priority by its title, whichever vocabulary the answer is spelled in. */
async function prioritiesByTitle(): Promise<Record<string, number>> {
  const answer = await call("items_list", {});
  expect(answer.isError).toBe(false);
  const structured = answer.structuredContent as Record<string, unknown>;
  const rows = (structured["items"] ?? structured["tickets"]) as { title: string; priority: number }[];
  return Object.fromEntries(rows.map((row) => [row.title, row.priority]));
}

const STORY = { type: "story", body: "Throttle it.", acceptanceCriteria: ["Refuses past 200/s."] };

describe("work_submit_item and priority", () => {
  it("creates the ticket with the priority it was sent, and 0 without one", async () => {
    expect((await call("work_submit_item", { ...STORY, title: "Urgent one", priority: 2 })).isError).toBe(false);
    expect((await call("work_submit_item", { ...STORY, title: "Ordinary one" })).isError).toBe(false);

    expect(await prioritiesByTitle()).toMatchObject({ "Urgent one": 2, "Ordinary one": 0 });
  });

  it.each([-1, 1.5])("refuses a priority of %s and creates nothing", async (priority) => {
    const answer = await call("work_submit_item", { ...STORY, title: "Refused", priority });

    expect(answer.isError).toBe(true);
    expect(await prioritiesByTitle()).not.toHaveProperty("Refused");
  });
});

describe("work_submit_plan and priority", () => {
  const plan = (overrides: Record<string, unknown> = {}, stories?: Record<string, unknown>[]) => ({
    title: "Rate limiting",
    understanding: "Throttle the API per key.",
    stories: stories ?? [
      { title: "Urgent story", body: "", acceptance_criteria: ["It is fast."], priority: 2 },
      { title: "Silent story", body: "", acceptance_criteria: ["It is quiet."] },
    ],
    ...overrides,
  });

  it("gives the feature the plan's priority and each story only its own", async () => {
    expect((await call("work_submit_plan", plan({ priority: 1 }))).isError).toBe(false);

    // The story sent without one is 0 though its feature is High.
    expect(await prioritiesByTitle()).toMatchObject({ "Rate limiting": 1, "Urgent story": 2, "Silent story": 0 });
  });

  it("leaves every ticket at 0 when the plan says nothing", async () => {
    await call("work_submit_plan", plan({}, [{ title: "Only story", body: "", acceptance_criteria: ["It works."] }]));

    expect(await prioritiesByTitle()).toMatchObject({ "Rate limiting": 0, "Only story": 0 });
  });

  it.each([
    ["the plan", plan({ priority: -1 })],
    ["the plan, fractionally", plan({ priority: 0.5 })],
    ["one story", plan({}, [{ title: "Fine", body: "", acceptance_criteria: ["Ok."] }, { title: "Bad", body: "", acceptance_criteria: ["Ok."], priority: -2 }])],
  ])("refuses a bad priority on %s and creates nothing at all", async (_where, payload) => {
    const answer = await call("work_submit_plan", payload);

    expect(answer.isError).toBe(true);
    expect(await prioritiesByTitle()).toEqual({});
  });
});
