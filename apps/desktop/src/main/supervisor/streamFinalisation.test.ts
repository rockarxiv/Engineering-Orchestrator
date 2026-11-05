import { parsedResultOf, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAgents } from "../db/repos/agentsRepo.js";
import { listCommentsForItem } from "../db/repos/commentsRepo.js";
import { listRunEvents } from "../db/repos/runEventsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { listTransitionsForItem } from "../db/repos/transitionsRepo.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { createFakeProvider, type FakeProviderScript } from "../providers/fake.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { fakeWorkspaceKind, installedKinds } from "./testWorkspaceKinds.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;
let item: Item;

/**
 * #141's stream, reproduced: the agent narrates, writes a valid terminal
 * payload as its last message, the turn's usage is reported — and then
 * the stream simply closes. No `result` event is ever emitted, which is
 * the whole of the defect: the approval was delivered, recorded in
 * `run_events`, and then dropped on the floor.
 *
 * A `FakeProviderScript` with neither `result` nor `throwMessage` is that
 * shape by construction, so nothing here has to fake a provider quirk.
 */
function streamEndingAfter(finalMessage: string): FakeProviderScript {
  return {
    steps: [{ output: "Reading the diff." }, { output: finalMessage }],
    usage: { tokensIn: 4_000, tokensOut: 300, costCents: 2 },
  };
}

/** With the role wiring: the approval comment and the Review step's route both live in it. */
function supervisorWith(script: FakeProviderScript, extra: Record<string, unknown> = {}) {
  return createRunSupervisor({
    db: handle.db,
    provider: createFakeProvider(script),
    limits: LIMITS,
    ...createRoleWiring(handle.db),
    ...extra,
  });
}

describe("a stream that ends without a result event (#141)", () => {
  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "review", spec: REVIEWABLE_SPEC });
  });

  afterEach(() => {
    handle.close();
  });

  it("finalises a run whose approval arrived as the agent's last message", async () => {
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    // The wrapper is `outputSchemaFor`'s: constrained generation nests
    // every result under `outcome`, and that is how the payload looked on
    // the run that went missing.
    const payload = JSON.stringify({
      outcome: { verdict: "approve", feedback: "Reads well and the tests cover the new branch." },
    });

    await supervisorWith(streamEndingAfter(payload)).runOnce();

    const run = listRunsForItem(handle.db, item.id).find((candidate) => candidate.action === "review");
    expect(run?.status).toBe("succeeded");
    expect(run?.endedAt).not.toBeNull();
    // The thread the approval came out of. The stranded run's null here is
    // what made it unreadable, and unresumable, after the fact.
    expect(run?.threadId).not.toBeNull();
    expect(parsedResultOf(run?.result ?? null)).toMatchObject({ verdict: "approve" });

    // The reviewer's own approval, carrying its feedback, in the thread.
    const approval = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "approval");
    expect(approval?.authorId).toBe(reviewer.id);
    expect(approval?.body).toContain("Reads well and the tests cover the new branch.");

    // And the Review step's configured route for an approval, applied
    // through `transitionItem` (invariant #1) rather than by any other
    // write to the item's step.
    const transition = listTransitionsForItem(handle.db, item.id).find((candidate) => candidate.fromStepId === "review");
    expect(transition).toMatchObject({ toStepId: "merge_request", actor: reviewer.id });
    expect(getItem(handle.db, item.id)?.stepId).not.toBe("review");
  });

  it("recovers by appending, and rewrites none of the stream it already has", async () => {
    // Invariant #3: `run_events` is append-only, so a stranded run is
    // closed by writing the run row — never by tidying the stream to make
    // its result look announced. The events stay exactly as they arrived,
    // trailing usage event and all.
    const payload = JSON.stringify({ outcome: { verdict: "approve", feedback: "Fine." } });

    await supervisorWith(streamEndingAfter(payload)).runOnce();

    const run = listRunsForItem(handle.db, item.id).find((candidate) => candidate.action === "review");
    const events = listRunEvents(handle.db, run!.id);
    // `review_verdict` is EO-200's, appended after the recovery decided
    // this stranded stream had in fact produced a verdict — which is the
    // same shape of write this test is about, and it takes the next
    // sequence number rather than displacing anything.
    expect(events.map((event) => event.type)).toEqual(["thread_started", "output", "output", "usage", "review_verdict"]);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4]);
    // The agent's words, still the agent's words — no result event was
    // manufactured behind them and nothing was edited.
    expect(JSON.stringify(events[2]?.payload)).toContain("verdict");
  });

  it("finalises a rejection down its own route just the same", async () => {
    // The fix is about finalisation, not about approvals: a reject verdict
    // arriving the same way takes the Review step's changes-requested
    // route back to the implementer.
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    const payload = JSON.stringify({
      outcome: {
        verdict: "reject",
        feedback: "The error path is untested.",
        criteria_coverage: [{ criterion: "The error path is tested", result: "not_met" }],
        blocking_issues: ["No test covers the empty payload."],
      },
    });

    await supervisorWith(streamEndingAfter(payload)).runOnce();

    const run = listRunsForItem(handle.db, item.id).find((candidate) => candidate.action === "review");
    expect(run?.status).toBe("succeeded");
    expect(run?.endedAt).not.toBeNull();

    const sentBack = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "rejection");
    expect(sentBack?.authorId).toBe(reviewer.id);
    expect(sentBack?.body).toContain("The error path is untested.");

    const transition = listTransitionsForItem(handle.db, item.id).find((candidate) => candidate.fromStepId === "review");
    expect(transition).toMatchObject({ toStepId: "todo", actor: reviewer.id });
  });

  it("closes a stream that ends with nothing usable, and says where that leaves the item", async () => {
    // The other half: a turn that really did produce nothing. It reaches a
    // terminal status with a stated reason rather than staying open — and
    // says so on the item, because a board that looks unchanged is
    // indistinguishable from one still being worked on (invariant #8).
    await supervisorWith(streamEndingAfter("I had a look but I'm not sure what to say.")).runOnce();

    const run = listRunsForItem(handle.db, item.id).find((candidate) => candidate.action === "review");
    expect(run?.status).toBe("failed");
    expect(run?.endedAt).not.toBeNull();
    expect(run?.error).toContain("without a result");

    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine");
    expect(note?.body).toContain("ended without a usable result");
    expect(note?.body).toContain('The ticket is at "Review".');

    // And nothing was routed on an answer nobody gave.
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });

  it("never leaves a run open once its stream has ended, whatever finalising it threw", async () => {
    // The hole underneath #141. Every branch of the dispatch loop writes a
    // terminal status — but a throw *after* the stream loop leaves by a
    // path that writes none of them, the dispatch promise is settled and
    // forgotten, and nothing in the process ever looks at a `running` run
    // with no stream behind it again. That is a run row left exactly as
    // dispatch created it, with no comment anywhere.
    const supervisor = supervisorWith(
      { result: { verdict: "approve", feedback: "Good." } },
      {
        kinds: installedKinds(
          fakeWorkspaceKind({
            // Keyed on the action this run is (EO-297): a kind lists what
            // it can check, and the supervisor runs the entry the run's
            // action names.
            verifiers: {
              review: () => {
                throw new Error("the verifier itself fell over");
              },
            },
          }),
        ),
      },
    );

    await supervisor.runOnce();

    const run = listRunsForItem(handle.db, item.id).find((candidate) => candidate.action === "review");
    expect(run?.status).not.toBe("running");
    expect(run?.endedAt).not.toBeNull();
    expect(run?.error).toContain("ended without finalising it");
    // The session it was talking to, kept: a run closed this way is still
    // a conversation somebody can pick up.
    expect(run?.threadId).not.toBeNull();

    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine");
    expect(note?.body).toContain("ended without finalising it");
    expect(note?.body).toContain('The ticket is at "Review".');
  });
});
