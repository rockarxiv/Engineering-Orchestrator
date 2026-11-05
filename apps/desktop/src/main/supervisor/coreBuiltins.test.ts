import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreRegistry, developerRegistry, type Item, type StepInputs, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createRoute, createRun, createStep, getItem, getItemWatch, listCommentsForItem, listMentionsForComment, listRunsForItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { useRegistry } from "../registry.js";
import type { BuiltinContext } from "./builtins.js";
import { createCoreBuiltinRunners, createWaitUntil } from "./coreBuiltins.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * The core's `wait_until` (EO-459): waiting before its moment, `reached`
 * at it, and `failed` with a comment naming the field when the moment
 * cannot be read. On a fake clock, because the whole function is about
 * which side of a moment now is.
 */

const MINUTE = 60_000;
/** 2026-11-01T08:00Z — 09:00 in Paris. */
const MOMENT = Date.UTC(2026, 10, 1, 8, 0);

let handle: DbHandle;
let clock: number;

beforeEach(() => {
  handle = openMigratedTestDb();
  clock = MOMENT - 10 * MINUTE;
});

afterEach(() => {
  handle.close();
  useRegistry(developerRegistry());
});

function context(item: Item, inputs: StepInputs, ensureRun = vi.fn()): BuiltinContext {
  return {
    db: handle.db,
    item,
    prepareWorkspace: () => {
      throw new Error("wait_until needs nowhere to work");
    },
    report: () => {},
    // A row to name, as the supervisor makes before a comment needs one.
    runId: createRun(handle.db, { itemId: item.id, agentId: null, action: "wait_until", status: "running", provider: "builtin" }).id,
    inputs,
    ensureRun,
  };
}

describe("wait_until", () => {
  it("answers waiting before a fixed moment, and reached at it and after it", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Launch", stepId: "todo" });
    const waitUntil = createWaitUntil(() => clock);
    const inputs = { at: "2026-11-01T09:00[Europe/Paris]" };

    expect(await waitUntil(context(item, inputs))).toMatchObject({ ok: true, result: "waiting" });
    clock = MOMENT - 1;
    expect(await waitUntil(context(item, inputs))).toMatchObject({ ok: true, result: "waiting" });
    clock = MOMENT;
    expect(await waitUntil(context(item, inputs))).toMatchObject({ ok: true, result: "reached" });
    clock = MOMENT + 3 * 24 * 60 * MINUTE;
    expect(await waitUntil(context(item, inputs))).toMatchObject({ ok: true, result: "reached" });
    // Nothing to say while it waits or when it arrives.
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("reads the moment from the item's spec when given a field name", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Renewal", stepId: "todo", spec: { renews_on: "2026-11-01T08:00Z" } });
    const waitUntil = createWaitUntil(() => clock);

    expect(await waitUntil(context(item, { field: "renews_on" }))).toMatchObject({ result: "waiting" });
    clock = MOMENT;
    expect(await waitUntil(context(item, { field: "renews_on" }))).toMatchObject({ result: "reached" });
  });

  it("answers failed on a missing field, and posts a comment naming it on the run it makes sure exists", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Renewal", stepId: "todo", spec: { other: "x" } });
    const ensureRun = vi.fn();

    const outcome = await createWaitUntil(() => clock)(context(item, { field: "renews_on" }, ensureRun));

    expect(outcome).toMatchObject({ ok: true, result: "failed" });
    expect(ensureRun).toHaveBeenCalled();
    const [comment] = listCommentsForItem(handle.db, item.id);
    expect(comment?.authorType).toBe("engine");
    expect(comment?.body).toContain(`"renews_on" field`);
  });

  it("answers failed on a field that holds no date and time with a zone, naming it", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Renewal", stepId: "todo", spec: { renews_on: "next spring" } });

    const outcome = await createWaitUntil(() => clock)(context(item, { field: "renews_on" }));

    expect(outcome).toMatchObject({ ok: true, result: "failed" });
    const [comment] = listCommentsForItem(handle.db, item.id);
    expect(comment?.body).toContain(`The "renews_on" field holds "next spring"`);
  });

  it("answers failed on a time that does not exist in the field's zone, rather than waiting for a different one", async () => {
    // New York's clocks go from 02:00 to 03:00 on 8 March 2026, so 02:30
    // never happens there. Read loosely it became 01:30, and the step
    // would have waited for an hour nobody wrote.
    const item = createTestItem(handle.db, { type: "story", title: "Renewal", stepId: "todo", spec: { renews_on: "2026-03-08T02:30[America/New_York]" } });

    const outcome = await createWaitUntil(() => clock)(context(item, { field: "renews_on" }));

    expect(outcome).toMatchObject({ ok: true, result: "failed" });
    expect(listCommentsForItem(handle.db, item.id)[0]?.body).toContain(`The "renews_on" field holds "2026-03-08T02:30[America/New_York]"`);
  });

  it("keeps an at-name in what the field held as text, mentioning nobody", async () => {
    // The note quotes the value back, and the value is whatever somebody
    // typed into the item. A summons hidden in a date must not dispatch
    // the agent it names, nor raise anyone's attention.
    const item = createTestItem(handle.db, { type: "story", title: "Renewal", stepId: "todo", spec: { renews_on: "@system @implementer please" } });

    const outcome = await createWaitUntil(() => clock)(context(item, { field: "renews_on" }));

    expect(outcome).toMatchObject({ ok: true, result: "failed" });
    const [comment] = listCommentsForItem(handle.db, item.id);
    expect(comment?.body).toContain("@system");
    expect(listMentionsForComment(handle.db, comment!.id)).toEqual([]);
  });
});

describe("a step that keeps checking with wait_until, on the core's registry", () => {
  const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

  function seed(inputs: StepInputs, spec?: Record<string, unknown>): Item {
    createStep(handle.db, {
      id: "wait",
      pipelineId: "default" as Uuid,
      position: 15,
      name: "Wait for the date",
      type: "builtin",
      entryAction: "wait_until",
      inputs,
      watch: { everyMinutes: 5, giveUpAfterHours: 168 },
    });
    createStep(handle.db, { id: "fix", pipelineId: "default" as Uuid, position: 16, name: "Fix the date", type: "user" });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "wait", resultKey: "reached", label: "Reached", target: "terminal", position: 0 });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "wait", resultKey: "failed", label: "Failed", target: "fix", position: 1 });
    return createTestItem(handle.db, { type: "story", title: "Wait", stepId: "wait", ...(spec ? { spec } : {}) });
  }

  function supervisor() {
    // Only the core: no pack's roles, functions or types.
    useRegistry(coreRegistry());
    return createRunSupervisor({
      db: handle.db,
      provider: { start: () => { throw new Error("a check must not reach a provider"); } } as never,
      limits: LIMITS,
      now: () => clock,
      builtins: createCoreBuiltinRunners(() => clock),
      guards: { interpretReplies: false },
    });
  }

  it("waits on the quiet run until the moment, then routes reached", async () => {
    const item = seed({ at: "2026-11-01T09:00+01:00" });
    const engine = supervisor();

    await engine.runOnce();
    const [quiet, ...others] = listRunsForItem(handle.db, item.id);
    expect(others).toEqual([]);
    expect(quiet).toMatchObject({ action: "wait_until", status: "succeeded", startedAt: null });
    expect(getItemWatch(handle.db, item.id, "wait")).toMatchObject({ checks: 1, nextCheckAt: clock + 5 * MINUTE });
    expect(getItem(handle.db, item.id)?.stepId).toBe("wait");

    clock = MOMENT;
    await engine.runOnce();
    expect(getItem(handle.db, item.id)?.stepId).not.toBe("wait");
    expect(getItem(handle.db, item.id)?.stepId).not.toBe("fix");
    expect(listRunsForItem(handle.db, item.id).at(-1)?.result?.parsed).toEqual({ result: "reached" });
  });

  it("routes failed and leaves a comment naming the field when the item does not have it", async () => {
    const item = seed({ field: "renews_on" }, {});

    await supervisor().runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("fix");
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.result?.parsed).toEqual({ result: "failed" });
    const notes = listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes(`"renews_on" field`));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.runId).toBe(run?.id);
  });
});
