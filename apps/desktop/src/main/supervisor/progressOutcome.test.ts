import { gitStateOf, parsedResultOf, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAgents } from "../db/repos/agentsRepo.js";
import { listCommentsForItem } from "../db/repos/commentsRepo.js";
import { listRunEvents } from "../db/repos/runEventsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { listTransitionsForItem } from "../db/repos/transitionsRepo.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider, type FakeProviderScript } from "../providers/fake.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/** What dispatchWorkspace wrote, once, before any of this ran. */
const REAL_BRANCH = "eo/EO-1";

/**
 * The payload from #144, verbatim.
 *
 * A complete, schema-valid `ImplementOutput` — `branch` is only
 * `z.string().min(1)`, so `in_progress` is as good a branch as any as far
 * as validation is concerned — sent as the run's *first* progress update,
 * long before the agent had done anything.
 */
const EARLY_PROGRESS = JSON.stringify({
  outcome: {
    branch: "in_progress",
    summary: "...starting...",
    files_changed: [],
    tests_run: false,
    handoff: "Work in progress.",
  },
});

const REAL_OUTCOME = JSON.stringify({
  outcome: {
    branch: REAL_BRANCH,
    summary: "Added the parser and its tests.",
    files_changed: ["src/parse.ts"],
    tests_run: true,
    handoff: "The fenced-input case is deliberately left to EO-2.",
  },
});

let handle: DbHandle;
let item: Item;

function supervisorWith(script: FakeProviderScript) {
  return createRunSupervisor({
    db: handle.db,
    provider: createFakeProvider(script),
    limits: LIMITS,
    ...createRoleWiring(handle.db),
  });
}

/** The implementer's run row, whatever became of it. */
function implementRun() {
  return listRunsForItem(handle.db, item.id).find((run) => run.action === "implement");
}

describe("an outcome-shaped payload sent mid-run (#144)", () => {
  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", git: { branch: REAL_BRANCH } });
  });

  afterEach(() => {
    handle.close();
  });

  /**
   * The report, reproduced: an implementer opens with a terminal-shaped
   * progress update and then gets on with the work — tool calls, more
   * messages, none of it JSON.
   */
  const keptWorkingAfter = (payload: string): FakeProviderScript => ({
    steps: [
      { output: "Reading the story and the surrounding code." },
      { output: payload },
      { toolCall: { name: "Read", args: { file_path: "src/parse.ts" } } },
      { output: "Now writing the parser." },
      { fileEdit: "src/parse.ts" },
      { output: "Running the suite." },
    ],
    usage: { tokensIn: 12_000, tokensOut: 900, costCents: 6 },
  });

  it("surfaces no branch from it, anywhere", async () => {
    await supervisorWith(keptWorkingAfter(EARLY_PROGRESS)).runOnce();

    const run = implementRun();
    // Not the run's result. This is the value that travels: `runs.result`
    // is what `ticket_detail` prints under "What it shipped", what the
    // next agent's dispatch context quotes as what a dependency
    // produced, and what the implementer's handoff comment is read out
    // of. A sentinel reaching it is a sentinel a downstream consumer
    // takes for the branch to review.
    expect(JSON.stringify(parsedResultOf(run?.result ?? null) ?? null)).not.toContain("in_progress");
    expect(run?.status).not.toBe("succeeded");

    // And not the item's branch, which dispatchWorkspace wrote once and
    // nothing an agent says mid-run may shadow.
    expect(gitStateOf(getItem(handle.db, item.id)!).branch).toBe(REAL_BRANCH);

    // Nor was the item routed on it. The run produced nothing, so the
    // story is still the implementer's.
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(listTransitionsForItem(handle.db, item.id).filter((entry) => entry.fromStepId === "todo")).toEqual([]);

    // The give-away in the report: "Work in progress." was posted as the
    // implementer's handoff — the account of finished work the reviewer
    // reads (KAN-31).
    const bodies = listCommentsForItem(handle.db, item.id).map((comment) => comment.body);
    expect(bodies).not.toContain("Work in progress.");
  });

  it("says so on the item, naming the agent and what it sent", async () => {
    // Invariant #8. EO has just decided to ignore a complete, valid
    // outcome; an agent using the wrong shape for progress is a thing to
    // make visible, not to tolerate quietly.
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;

    await supervisorWith(keptWorkingAfter(EARLY_PROGRESS)).runOnce();

    const note = listCommentsForItem(handle.db, item.id).find(
      (comment) => comment.authorType === "engine" && comment.body.includes("carried on working"),
    );
    expect(note?.kind).toBe("note");
    expect(note?.body).toContain(implementer.name);
    expect(note?.body).toContain("implement");
    // What it sent, quoted as it was sent, so the person reading can see
    // the shape that caused this.
    expect(note?.body).toContain('"branch":"in_progress"');
    // And said once, however many progress updates follow.
    const notes = listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes("carried on working"));
    expect(notes).toHaveLength(1);
  });

  it("still shows the run's live progress, with the log untouched", async () => {
    // The fix distinguishes progress from a terminal outcome; it does not
    // achieve that by hiding progress. `run_events` is append-only
    // (invariant #3), so every word the agent said is still there in the
    // order it arrived — including the payload itself, as the `output`
    // event it always was rather than as this run's result.
    await supervisorWith(keptWorkingAfter(EARLY_PROGRESS)).runOnce();

    const events = listRunEvents(handle.db, implementRun()!.id);
    expect(events.map((event) => event.type)).toEqual([
      "thread_started",
      "output",
      "output",
      "tool_call",
      "output",
      "file_edit",
      "output",
      "usage",
    ]);
    expect(JSON.stringify(events[2]?.payload)).toContain("in_progress");
    expect(events.some((event) => event.type === "result")).toBe(false);
    expect(JSON.stringify(events[6]?.payload)).toContain("Running the suite.");
  });

  it("finalises on the outcome the agent actually ended on", async () => {
    // The other half, and the one that must not be broken to get the
    // first: an agent that reports progress in the wrong shape and then
    // finishes properly is finished. The last word is the answer.
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const script = keptWorkingAfter(EARLY_PROGRESS);
    const supervisor = supervisorWith({ ...script, steps: [...script.steps!, { output: REAL_OUTCOME }] });

    await supervisor.runOnce();

    const run = implementRun();
    expect(run?.status).toBe("succeeded");
    expect(parsedResultOf(run?.result ?? null)).toMatchObject({ branch: REAL_BRANCH, tests_run: true });
    expect(gitStateOf(getItem(handle.db, item.id)!).branch).toBe(REAL_BRANCH);

    // Routed on the real outcome, through transitionItem (invariant #1).
    const transition = listTransitionsForItem(handle.db, item.id).find((entry) => entry.fromStepId === "todo");
    expect(transition).toMatchObject({ toStepId: "review", actor: implementer.id });

    // And the handoff in the thread is the one addressed to the reviewer,
    // not the placeholder from the opening progress update.
    const bodies = listCommentsForItem(handle.db, item.id).map((comment) => comment.body);
    expect(bodies).toContain("The fenced-input case is deliberately left to EO-2.");
    expect(bodies).not.toContain("Work in progress.");
  });

  it("keeps quiet about JSON that was never a usable outcome", async () => {
    // Only a payload that would actually have ended the run is worth a
    // word. An agent that quotes a config blob mid-run has made no
    // mistake, and a comment telling it off for one is noise in the one
    // channel EO has (invariant #4).
    await supervisorWith(keptWorkingAfter(JSON.stringify({ note: "here is the config I found", enabled: true }))).runOnce();

    const notes = listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes("carried on working"));
    expect(notes).toEqual([]);
  });
});

/**
 * The same payload, from a backend that shaped it (EO-199).
 *
 * Everything above is an agent choosing to send a terminal outcome and
 * then carrying on. This is the case that looks identical and is not:
 * Codex takes `outputSchema` on `runStreamed`, so it is in force for the
 * whole turn, and the preamble a reasoning model writes before its first
 * tool call has no shape available to it *but* the answer's. Five
 * reviews on EO-194 produced five engine notes that way — one per
 * review, every review, none of them a mistake anybody made.
 *
 * The guard was right every time and is not touched here. What changed
 * is upstream of it: a message whose shape the backend chose is no longer
 * a candidate answer, so there is nothing for `superseded()` to drop and
 * nothing to report. Nothing is lost by that, because this backend does
 * not need the shape read — it names its answer in a `result` event,
 * which is the `result` in these scripts.
 *
 * The pair at the end is the whole claim: the same script, one flag
 * apart, is silent or is reported.
 */
describe("an outcome-shaped payload from a turn-level schema (EO-199)", () => {
  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", git: { branch: REAL_BRANCH } });
  });

  afterEach(() => {
    handle.close();
  });

  /**
   * A Codex turn as the adapter delivers one: every message marked, and
   * the real answer announced rather than inferred.
   */
  const narratedThenWorked = (payload: string): FakeProviderScript => ({
    steps: [
      { output: payload },
      { toolCall: { name: "Read", args: { file_path: "src/parse.ts" } } },
      { output: "Now writing the parser." },
      { fileEdit: "src/parse.ts" },
    ],
    turnLevelSchema: true,
    result: JSON.parse(REAL_OUTCOME) as unknown,
    usage: { tokensIn: 12_000, tokensOut: 900, costCents: 6 },
  });

  it("says nothing on the item about a preamble the backend shaped", async () => {
    await supervisorWith(narratedThenWorked(EARLY_PROGRESS)).runOnce();

    const notes = listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes("carried on working"));
    expect(notes).toEqual([]);
  });

  it("finalises on the answer the backend announced, not on the preamble", async () => {
    // The protection #144 exists to give is not weakened by the silence
    // above — on this backend it is stronger, because the answer is named
    // rather than guessed at from a message's shape. A run that opens
    // with `in_progress` still ends on the branch it really produced.
    await supervisorWith(narratedThenWorked(EARLY_PROGRESS)).runOnce();

    const run = implementRun();
    expect(run?.status).toBe("succeeded");
    expect(parsedResultOf(run?.result ?? null)).toMatchObject({ branch: REAL_BRANCH, tests_run: true });
    expect(gitStateOf(getItem(handle.db, item.id)!).branch).toBe(REAL_BRANCH);
    expect(listTransitionsForItem(handle.db, item.id).find((entry) => entry.fromStepId === "todo")).toMatchObject({ toStepId: "review" });
    expect(JSON.stringify(parsedResultOf(run?.result ?? null) ?? null)).not.toContain("in_progress");
  });

  it("keeps the preamble in the log, exactly as the agent sent it", async () => {
    // Invariant #3. Not reading a message as an answer is not the same as
    // pretending it was never said, and the transcript is where somebody
    // establishes what a run actually did.
    await supervisorWith(narratedThenWorked(EARLY_PROGRESS)).runOnce();

    const events = listRunEvents(handle.db, implementRun()!.id);
    expect(JSON.stringify(events.find((event) => event.type === "output")?.payload)).toContain("in_progress");
  });

  it("still reports the same payload when the shape was the agent's own choice", async () => {
    // The guard, unchanged and still live: drop `superseded()` and this
    // fails while the three above keep passing. One flag apart — the
    // backend said nothing about the shape, so the agent meant it.
    const chosen = { ...narratedThenWorked(EARLY_PROGRESS) };
    delete chosen.turnLevelSchema;

    await supervisorWith(chosen).runOnce();

    const notes = listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes("carried on working"));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toContain('"branch":"in_progress"');
  });
});
