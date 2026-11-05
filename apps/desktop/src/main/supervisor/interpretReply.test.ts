import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERPRET_ACTION, type AgentEvent, type AgentProvider, type AgentProviderStartOptions, type Comment, type Item } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createProject, getItem, listCommentsForItem, listRunsForItem, postComment } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { archiveProjectCommand, restoreProjectCommand } from "../ipc/archiveProjectCommand.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { answerToLastAsk } from "../roles/answers.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import type { BuiltinRunner } from "./builtins.js";
import { createRunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";

/**
 * A sentence, where a button was expected (EO-184).
 *
 * A builtin or a module that stops and asks hears the answer by finding
 * a matching comment in the thread. Click one of the offered answers and
 * it works. Type a sentence and, before this, nothing understood it: the
 * step re-ran from the top, hand-parsed the thread, found nothing and
 * asked the identical question again — which is what a person sees as EO
 * ignoring them.
 *
 * What is asserted here is the whole loop through the real supervisor:
 * which replies reach the system agent and which do not, that the model
 * is never called while the item lock is held, and that each of the
 * three answers it can give leads where it says it does.
 *
 * The step is a stub builtin standing in for `create_worktree`'s tied
 * stack target — it asks the same shape of question, offers the same
 * shape of answers, and reads the reply through the same shared reader
 * (`answerToLastAsk`, EO-183) that the real one does.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/** The dependencies EO would offer as buttons on a tied stack target. */
const OFFERED = ["EO-2", "EO-3"];

let handle: DbHandle;
let item: Item;
let step: ReturnType<typeof vi.fn<BuiltinRunner>>;
/** Every context a provider was started with, which is one entry per model call. */
let started: string[];

/**
 * The step that asks: it refuses with the two dependencies until the
 * thread holds an answer that is one of them.
 */
function askingStep(): ReturnType<typeof vi.fn<BuiltinRunner>> {
  return vi.fn<BuiltinRunner>(async ({ db, item: current }) => {
    const answer = answerToLastAsk(db, current.id);
    if (answer?.matched != null) return { ok: true, result: "ready", detail: `cut from ${answer.matched}` };
    return { ok: false, reason: "EO-2 and EO-3 are tied. Which should this stack on?", options: OFFERED };
  });
}

function supervisorWith(
  interpretation: unknown,
  opts: { interpretReplies?: boolean; checkAuth?: RunSupervisorOptions["checkAuth"] } = {},
) {
  const scripted = createScriptedProvider(
    [{ when: (context) => context.includes(`"${INTERPRET_ACTION}" action`), script: { result: interpretation } }],
    { throwMessage: "only an interpretation should reach a provider in this test" },
  );
  const provider: AgentProvider = {
    async *start(options: AgentProviderStartOptions): AsyncIterable<AgentEvent> {
      started.push(options.context);
      yield* scripted.start(options);
    },
    resume: scripted.resume.bind(scripted),
  };

  return createRunSupervisor({
    db: handle.db,
    provider,
    ...createRoleWiring(handle.db),
    limits: LIMITS,
    guards: () => ({ interpretReplies: opts.interpretReplies ?? true }),
    builtins: { create_worktree: step },
    ...(opts.checkAuth ? { checkAuth: opts.checkAuth } : {}),
  });
}

/** What a person does: a reply filed under the question. */
function reply(body: string): Comment {
  const asked = listCommentsForItem(handle.db, item.id).at(-1);
  return postComment(handle.db, { itemId: item.id, author: { type: "human" }, parentId: asked?.id ?? null, body });
}

function interpretRuns() {
  return listRunsForItem(handle.db, item.id).filter((run) => run.action === INTERPRET_ACTION);
}

function escalations() {
  return listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation");
}

beforeEach(() => {
  handle = openMigratedTestDb();
  step = askingStep();
  started = [];
  // The seeded pipeline enters at `worktree`, which is a builtin.
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "worktree" });
});

afterEach(() => {
  handle.close();
});

describe("a free-text reply to a parked builtin", () => {
  it("leaves the item parked and dispatches one interpretation instead of re-running the step", async () => {
    const supervisor = supervisorWith({ status: "answered", answer: "EO-3" });
    await supervisor.runOnce();
    expect(escalations()).toHaveLength(1);

    const said = reply("go with whichever one the rate limiter lives in");
    await supervisor.runOnce();

    // The step did not run again, so it did not ask again.
    expect(step).toHaveBeenCalledTimes(1);
    expect(escalations()).toHaveLength(1);
    // One interpretation, filed against the reply it was sent to read.
    expect(interpretRuns()).toHaveLength(1);
    expect(interpretRuns()[0]).toMatchObject({ status: "succeeded", initiationId: said.id });
    // And it moved nothing: an interpretation is not a stage.
    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");
  });

  it("posts the answer under the person's own comment, and the step acts on it", async () => {
    const supervisor = supervisorWith({ status: "answered", answer: "EO-3" });
    await supervisor.runOnce();
    const said = reply("go with whichever one the rate limiter lives in");
    await supervisor.runOnce();

    // Threaded under the reply and verbatim, which is the whole of the
    // contract with the waiting step: `answersSinceLastAsk` counts a
    // system agent's comment as an answer only when it is filed under a
    // person's, and the step matches the body against what it offered.
    const decision = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "decision");
    expect(decision).toMatchObject({ parentId: said.id, body: "EO-3" });
    expect(answerToLastAsk(handle.db, item.id)?.matched).toBe("EO-3");

    // The next tick runs the step against it, and this time it can act.
    await supervisor.runOnce();
    expect(step).toHaveBeenCalledTimes(2);
    expect(getItem(handle.db, item.id)?.stepId).toBe("repository_index");
  });

  it("never calls a model while the item lock is held", async () => {
    const supervisor = supervisorWith({ status: "answered", answer: "EO-3" });
    await supervisor.runOnce();
    reply("go with whichever one the rate limiter lives in");

    // The path `postHumanComment` takes: it resumes the item directly,
    // holding the lock for the whole of `resumeItemHeld`.
    await supervisor.resumeItem(item.id);

    expect(started).toEqual([]);
    expect(interpretRuns()).toEqual([]);
    expect(step).toHaveBeenCalledTimes(1);

    // The interpretation is an ordinary run that claims the item in
    // its own right, one tick later.
    await supervisor.runOnce();
    expect(started).toHaveLength(1);
    expect(interpretRuns()).toHaveLength(1);
  });

  it("acts on what was asked for, and retries or does not as it says", async () => {
    const supervisor = supervisorWith({ status: "acted", summary: "Deleted the stale branch.", retry: true });
    await supervisor.runOnce();
    reply("that branch is stale, get rid of it and try again");
    await supervisor.runOnce();

    const note = listCommentsForItem(handle.db, item.id).at(-1);
    expect(note?.kind).toBe("note");
    expect(note?.body).toContain("Deleted the stale branch.");

    // `retry: true` hands the item back to the step.
    await supervisor.runOnce();
    expect(step).toHaveBeenCalledTimes(2);
  });

  it("leaves the item parked when the interpretation asks for no retry", async () => {
    const supervisor = supervisorWith({ status: "acted", summary: "Moved it to the review step myself.", retry: false });
    await supervisor.runOnce();
    reply("this does not need a worktree, it is a documentation change");
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(step).toHaveBeenCalledTimes(1);
    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");
  });

  /**
   * The sentence the model wrote is not an instruction to EO.
   *
   * A mention is the scheduler's second entry point, so an `@name` in
   * generated prose would be a *dispatch*: the interpretation says it is
   * leaving the item parked and, on the very next tick, an unrelated
   * `respond` run starts on the same item. Asserted here rather than
   * only where the comment is written, because a run is the thing that
   * would actually go wrong.
   */
  it("starts nothing on the strength of an `@name` in its own summary", async () => {
    const supervisor = supervisorWith({
      status: "acted",
      summary: "Asked @implementer to rebase, and left this where it is.",
      retry: false,
    });
    await supervisor.runOnce();
    reply("get someone to look at the branch first");
    await supervisor.runOnce();
    await supervisor.runOnce();

    // Two runs and no more: the step that parked, and the one
    // interpretation. No `respond`, and the model was called exactly
    // once — for the reading it was dispatched for.
    expect(listRunsForItem(handle.db, item.id).map((run) => run.action)).toEqual(["create_worktree", INTERPRET_ACTION]);
    expect(started).toHaveLength(1);
    expect(step).toHaveBeenCalledTimes(1);
    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");
  });

  it("quotes an unusable reply back and stays parked, rather than dropping it", async () => {
    const supervisor = supervisorWith({ status: "unusable", problem: "it names a repository, and the question was which dependency to stack on" });
    await supervisor.runOnce();
    reply("ask Priya, she owns that repo");
    await supervisor.runOnce();

    const asked = escalations().at(-1);
    expect(asked?.authorType).toBe("agent");
    expect(asked?.body).toContain("it names a repository");
    // Invariant #9: the run ended. Invariant #8: it ended in a comment
    // addressed to somebody.
    expect(interpretRuns()[0]?.status).toBe("succeeded");
    expect(listRunsForItem(handle.db, item.id).some((run) => run.status === "running")).toBe(false);

    await supervisor.runOnce();
    expect(step).toHaveBeenCalledTimes(1);
    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");
  });

  it("interprets one reply once, and lets the step ask again if the reading was no use", async () => {
    // A reading the step cannot use either: "EO-9" is not one of the two
    // dependencies on offer.
    const supervisor = supervisorWith({ status: "answered", answer: "EO-9" });
    await supervisor.runOnce();
    reply("whichever one Priya was working on");
    await supervisor.runOnce();
    await supervisor.runOnce();
    await supervisor.runOnce();

    // The step ran again, could not use the reading, and asked its own
    // question — and no second interpretation was paid for.
    expect(step).toHaveBeenCalledTimes(2);
    expect(escalations()).toHaveLength(2);
    expect(escalations().at(-1)?.options).toEqual(OFFERED);
    expect(interpretRuns()).toHaveLength(1);
  });
});

describe("a reply that names one of the answers", () => {
  it("runs the step again with no model call at all", async () => {
    const supervisor = supervisorWith({ status: "answered", answer: "EO-2" });
    await supervisor.runOnce();

    // As a person types it, full stop and all — the normalisation
    // `unwrapAnswer` applies is what makes this a button press.
    reply("EO-3.");
    await supervisor.runOnce();

    expect(started).toEqual([]);
    expect(interpretRuns()).toEqual([]);
    expect(step).toHaveBeenCalledTimes(2);
    expect(getItem(handle.db, item.id)?.stepId).toBe("repository_index");
  });
});

describe("with interpretation switched off", () => {
  it("hands the reply straight back to the step, which asks again", async () => {
    const supervisor = supervisorWith({ status: "answered", answer: "EO-3" }, { interpretReplies: false });
    await supervisor.runOnce();
    reply("go with whichever one the rate limiter lives in");
    await supervisor.runOnce();

    expect(started).toEqual([]);
    expect(interpretRuns()).toEqual([]);
    expect(step).toHaveBeenCalledTimes(2);
    expect(escalations()).toHaveLength(2);
    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");
  });
});

/**
 * The interpretation is a dispatch like any other, and a project
 * archived while it is being prepared stops it like any other (EO-347).
 * Its preflight has no run row for the archive to cancel, so the door
 * it comes through has to ask again.
 */
describe("a reply on a project archived while its interpretation is being prepared", () => {
  it("starts no interpretation, and reads the reply once the project is restored", async () => {
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "worktree", projectId: shop.id });
    let release!: () => void;
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const open = new Promise<{ ok: true }>((resolve) => {
      release = () => resolve({ ok: true });
    });
    let held = false;
    const supervisor = supervisorWith(
      { status: "answered", answer: "EO-3" },
      {
        checkAuth: () => {
          if (held) return Promise.resolve({ ok: true as const });
          held = true;
          reached();
          return open;
        },
      },
    );
    await supervisor.runOnce();
    reply("go with whichever one the rate limiter lives in");

    const tick = supervisor.runOnce();
    await started;
    archiveProjectCommand(handle.db, supervisor, { projectId: shop.id, confirm: true });
    release();
    await tick;
    await supervisor.waitForIdle();

    expect(interpretRuns()).toEqual([]);

    restoreProjectCommand(handle.db, supervisor, { projectId: shop.id });
    await supervisor.runOnce();
    await supervisor.waitForIdle();
    expect(interpretRuns()).toHaveLength(1);
  });
});
