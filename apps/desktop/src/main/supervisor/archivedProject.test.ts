import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Item } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createAgent,
  createProject,
  createRun,
  getAgent,
  getItem,
  listAgents,
  listCommentsForItem,
  listRunsForItem,
  postComment,
  updateRun,
  type Project,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { archiveProjectCommand, restoreProjectCommand } from "../ipc/archiveProjectCommand.js";
import { holdItem, postHumanComment, resumeHeldItem } from "../ipc/domainCommands.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor, type RunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";

/**
 * An archived project's tickets pause, and a restored project's carry
 * on (EO-347) — asked of a real supervisor rather than of its input,
 * because "no agent is dispatched" is a claim about every door an agent
 * comes through: the tick, a run already in preflight, and a mention.
 *
 * Caps are wide, because nothing here is about capacity.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const CWD = "/tmp/eo/worktrees/EO-347";

let handle: DbHandle;
let shop: Project;
let web: Project;

beforeEach(() => {
  handle = openMigratedTestDb();
  shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
  web = createProject(handle.db, { name: "Web", keyPrefix: "WEB" });
});

afterEach(() => {
  handle.close();
});

function storyOn(project: Project, title: string): Item {
  return createTestItem(handle.db, { type: "story", title, stepId: "todo", projectId: project.id });
}

function supervisor(sleepMs = 40, overrides: Partial<RunSupervisorOptions> = {}): RunSupervisor {
  return createRunSupervisor({
    db: handle.db,
    provider: createFakeProvider({ steps: [{ sleepMs, output: "working" }], result: validImplementResult }),
    limits: LIMITS,
    kinds: kindsPreparing(CWD),
    ...overrides,
  });
}

/**
 * A dispatch held at its first preflight await, the auth probe
 * (`dispatchAuthorisation.test.ts`'s harness). Whatever is decided
 * before it is released has already been decided; whatever the archive
 * does while it is held is exactly the window a run row does not exist
 * yet for the archive to cancel.
 *
 * Only the first probe is held. Every later one answers at once, so a
 * restore afterwards is not left waiting on a gate nobody will open.
 */
function gatedOnAuth() {
  let release!: () => void;
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const open = new Promise<{ ok: true }>((resolve) => {
    release = () => resolve({ ok: true });
  });
  let first = true;
  return {
    started,
    release,
    options: {
      checkAuth: () => {
        if (!first) return Promise.resolve({ ok: true as const });
        first = false;
        reached();
        return open;
      },
    },
  };
}

function archive(project: Project, engine: RunSupervisor) {
  return archiveProjectCommand(handle.db, engine, { projectId: project.id, confirm: true });
}

function restore(project: Project, engine: RunSupervisor) {
  return restoreProjectCommand(handle.db, engine, { projectId: project.id });
}

describe("a supervisor, while a project is archived", () => {
  it("dispatches nothing on its tickets, and goes on dispatching everyone else's", async () => {
    const cart = storyOn(shop, "Cart");
    const home = storyOn(web, "Homepage");
    const engine = supervisor();
    expect(archive(shop, engine).archived).toBe(true);

    await engine.runOnce();
    await engine.runOnce();

    expect(listRunsForItem(handle.db, cart.id)).toEqual([]);
    expect(listRunsForItem(handle.db, home.id)).not.toEqual([]);
    // And when asked why, it says which project — not that the item is
    // on no step an agent is dispatched at, which is what the engine
    // alone would answer about an item it was never shown.
    expect(engine.dispatchBlockerFor(cart.id)).toEqual({ kind: "project_archived", projectName: "Shop" });
  });

  it("stops the run in flight, dispatches nothing more, and picks the item up again on restore from the step it was on", async () => {
    const cart = storyOn(shop, "Cart");
    const engine = supervisor(2000);
    const running = engine.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [first] = listRunsForItem(handle.db, cart.id);
    expect(first?.status).toBe("running");

    const answer = archive(shop, engine);
    await running;

    expect(answer.running).toEqual([{ itemKey: cart.key, title: "Cart" }]);
    expect(listRunsForItem(handle.db, cart.id).map((run) => run.status)).toEqual(["cancelled"]);
    expect(listCommentsForItem(handle.db, cart.id).some((comment) => comment.body.includes("was archived"))).toBe(true);
    // A cancellation that belongs to the archive is not a person's stop,
    // so nothing says "EO has stopped with it" about it.
    expect(listCommentsForItem(handle.db, cart.id).some((comment) => comment.body.includes("EO has stopped with it"))).toBe(false);

    await engine.runOnce();
    await engine.runOnce();
    expect(listRunsForItem(handle.db, cart.id)).toHaveLength(1);

    restore(shop, engine);
    await engine.runOnce();
    await engine.waitForIdle();

    // Nobody resumed it: the restore is all it took.
    const fresh = listRunsForItem(handle.db, cart.id).filter((run) => run.id !== first!.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ stepId: "todo", action: "implement" });
  });

  it("keeps an item somebody held on hold through the archive and the restore", async () => {
    const held = storyOn(shop, "Held by hand");
    const free = storyOn(shop, "Free");
    const engine = supervisor();
    holdItem(handle.db, engine, { itemId: held.id, cancelActiveRun: false, comment: "" });

    archive(shop, engine);
    restore(shop, engine);
    await engine.runOnce();
    await engine.waitForIdle();

    expect(getItem(handle.db, held.id)?.heldAt).not.toBeNull();
    expect(listRunsForItem(handle.db, held.id)).toEqual([]);
    expect(listRunsForItem(handle.db, free.id)).not.toEqual([]);

    // The hold is still the person's to lift, and lifting it works.
    resumeHeldItem(handle.db, engine, { itemId: held.id, cancelActiveRun: false });
    await engine.runOnce();
    await engine.waitForIdle();
    expect(listRunsForItem(handle.db, held.id)).not.toEqual([]);
  });

  it("does not answer a mention on one of its tickets until the project is restored", async () => {
    const cart = storyOn(shop, "Cart");
    const engine = supervisor();
    archive(shop, engine);

    await postHumanComment(handle.db, engine, {
      itemId: cart.id,
      body: "@implementer how far did you get?",
      mentions: [],
      pinned: false,
      parentId: null,
    });
    await engine.runOnce();
    await engine.waitForIdle();
    expect(listRunsForItem(handle.db, cart.id)).toEqual([]);

    restore(shop, engine);
    await engine.runOnce();
    await engine.waitForIdle();
    // Kept, not dropped: the question is answered once there is a
    // project to answer it on.
    expect(listRunsForItem(handle.db, cart.id).some((run) => run.action === "respond")).toBe(true);
  });
});

/**
 * The window the archive's own cancellation cannot reach (EO-347,
 * review): a dispatch decided before the archive and still preparing
 * when it lands has no run row yet, so there is nothing to cancel — and
 * every door a run comes through has to ask again before it writes one.
 */
describe("a dispatch still in preflight when its project is archived", () => {
  it("does not start the scheduled run, and starts it after the restore", async () => {
    const cart = storyOn(shop, "Cart");
    const gate = gatedOnAuth();
    const engine = supervisor(40, gate.options);

    const tick = engine.runOnce();
    await gate.started;
    // Nothing to stop yet: the run has no row.
    expect(archive(shop, engine).running).toEqual([]);
    gate.release();
    await tick;
    await engine.waitForIdle();

    expect(listRunsForItem(handle.db, cart.id)).toEqual([]);

    restore(shop, engine);
    await engine.runOnce();
    await engine.waitForIdle();
    expect(listRunsForItem(handle.db, cart.id).map((run) => run.action)).toEqual(["implement"]);
  });

  it("does not answer a mention it was preparing to answer, and answers it after the restore", async () => {
    const cart = storyOn(shop, "Cart");
    // Held so the scheduler has nothing of its own to dispatch: what is
    // under test is the mention's door, which a hold does not close.
    holdItem(handle.db, undefined, { itemId: cart.id, cancelActiveRun: false, comment: "" });
    const gate = gatedOnAuth();
    const engine = supervisor(40, gate.options);
    await postHumanComment(handle.db, engine, {
      itemId: cart.id,
      body: "@implementer how far did you get?",
      mentions: [],
      pinned: false,
      parentId: null,
    });

    const tick = engine.runOnce();
    await gate.started;
    archive(shop, engine);
    gate.release();
    await tick;
    await engine.waitForIdle();

    expect(listRunsForItem(handle.db, cart.id)).toEqual([]);

    restore(shop, engine);
    await engine.runOnce();
    await engine.waitForIdle();
    expect(listRunsForItem(handle.db, cart.id).map((run) => run.action)).toEqual(["respond"]);
  });

  it("does not start a forced restart it was preparing, and keeps it for the restore", async () => {
    const cart = storyOn(shop, "Cart");
    const first = supervisor(2000);
    const running = first.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // A pause that stops what is running promises each run a
    // replacement when the engine resumes.
    first.pause({ cancelRunning: true });
    await running;
    expect(listRunsForItem(handle.db, cart.id).map((run) => run.status)).toEqual(["cancelled"]);

    // The replacement, from a relaunched engine, held in its preflight.
    const gate = gatedOnAuth();
    const engine = supervisor(40, gate.options);
    const tick = engine.runOnce();
    await gate.started;
    archive(shop, engine);
    gate.release();
    await tick;
    await engine.waitForIdle();

    expect(listRunsForItem(handle.db, cart.id)).toHaveLength(1);

    restore(shop, engine);
    await engine.runOnce();
    await engine.waitForIdle();
    // The replacement the pause promised, now that there is a project
    // to run it on — and the item carries on from there as usual.
    // Carried on in the stopped run's own thread and initiation.
    const [stopped, ...after] = listRunsForItem(handle.db, cart.id);
    const restarted = after.filter((run) => run.action === "implement");
    expect(restarted).toHaveLength(1);
    expect(restarted[0]).toMatchObject({ action: "implement", stepId: "todo", initiationId: stopped!.initiationId, threadId: stopped!.threadId });
  });

  it("does not resume a parked conversation on a reply, and resumes it after the restore", async () => {
    const cart = storyOn(shop, "Cart");
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const parked = createRun(handle.db, {
      itemId: cart.id,
      agentId: implementer.id,
      action: "implement",
      status: "awaiting_input",
      threadId: "thread-1",
      provider: implementer.provider,
      cwd: CWD,
    });
    updateRun(handle.db, parked.id, { startedAt: 1_000, endedAt: 1_000 });
    const engine = supervisor();
    archive(shop, engine);

    // The person answers the parked question while the project is put
    // away. Kept in the thread, and not acted on.
    postComment(handle.db, { itemId: cart.id, author: { type: "human" }, body: "The importer, not the parser." });
    await engine.resumeItem(cart.id);
    await engine.runOnce();
    await engine.waitForIdle();
    expect(listRunsForItem(handle.db, cart.id).map((run) => run.id)).toEqual([parked.id]);

    restore(shop, engine);
    await engine.runOnce();
    await engine.waitForIdle();
    expect(listRunsForItem(handle.db, cart.id).filter((run) => run.id !== parked.id)).not.toEqual([]);
  });
});

/**
 * A project's own agents while the project is put away (EO-476,
 * ARCHITECTURE.md, "An agent is a row").
 *
 * Archiving writes nothing onto the agents: they stay where they are,
 * scoped and enabled, and are simply not dispatched — a project's own
 * agent works on that project's items only, and nothing of an archived
 * project runs by any door. Restoring the project is all it takes to
 * have them dispatched again, and it is the project's own agent, not
 * the global one, that picks the work back up.
 */
describe("an archived project's own agents (EO-476)", () => {
  function ownImplementer(project: Project) {
    return createAgent(handle.db, { name: "ShopImplementer", role: "implementer", provider: "fake", instructions: "Implement for the shop.", projectId: project.id });
  }

  it("are left in place but not dispatched, and pick the project's work up again once it is restored", async () => {
    const own = ownImplementer(shop);
    const cart = storyOn(shop, "Cart");
    const engine = supervisor();
    expect(archive(shop, engine).archived).toBe(true);

    await engine.runOnce();
    await engine.runOnce();
    await engine.waitForIdle();

    // Nothing ran, and the agent is exactly as it was: archiving the
    // project is not archiving its agents.
    expect(listRunsForItem(handle.db, cart.id)).toEqual([]);
    expect(getAgent(handle.db, own.id)).toMatchObject({ projectId: shop.id, enabled: true, archivedAt: null });
    expect(engine.dispatchBlockerFor(cart.id)).toEqual({ kind: "project_archived", projectName: "Shop" });

    restore(shop, engine);
    await engine.runOnce();
    await engine.waitForIdle();

    // The project's own agent, not the global implementer, which was
    // never handed the project's work.
    const runs = listRunsForItem(handle.db, cart.id);
    expect(runs.map((run) => [run.action, run.agentId])).toEqual([["implement", own.id]]);
  });

  it("do not answer a mention while the project is archived, and answer it once it is restored", async () => {
    const own = ownImplementer(shop);
    const cart = storyOn(shop, "Cart");
    const engine = supervisor();
    archive(shop, engine);

    await postHumanComment(handle.db, engine, {
      itemId: cart.id,
      body: "@ShopImplementer how far did you get?",
      mentions: [],
      pinned: false,
      parentId: null,
    });
    await engine.runOnce();
    await engine.waitForIdle();
    expect(listRunsForItem(handle.db, cart.id)).toEqual([]);

    restore(shop, engine);
    await engine.runOnce();
    await engine.waitForIdle();
    expect(listRunsForItem(handle.db, cart.id).some((run) => run.action === "respond" && run.agentId === own.id)).toBe(true);
  });
});
