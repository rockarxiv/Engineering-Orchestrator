import type { BrowserWindow } from "electron";
import type { Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { onCommentPosted } from "../db/commentEvents.js";
import { listRunsForItem, postComment } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createEngine } from "../engine.js";
import { bridgePushChannels } from "../ipc/push.js";
import { webContentsTransport } from "../platform/webContentsTransport.js";
import { createFakeProvider } from "../providers/fake.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { startTestWriteBridge } from "../testing/agentWrites.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * A comment reaching the outside world *while the run is still going*.
 *
 * This is the defect behind "other parts of the app don't update":
 * `announceRun` was the only thing emitting `items:changed`, and all
 * thirteen of its call sites passed a terminal run status. So an open
 * item was frozen from the moment a run started until it finished, no
 * matter how much the agent wrote into it.
 *
 * Asserted on the *run's status at the moment of notification*, not
 * merely on a notification arriving — a notification that only shows up
 * once the run has ended is precisely the old behaviour.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;
let item: Item;

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
});

afterEach(() => {
  handle.close();
});

describe("comments while a run is in flight", () => {
  it("announces one before the run has finished", async () => {
    const statusesWhenHeard: (string | undefined)[] = [];
    onCommentPosted(handle.db, () => {
      statusesWhenHeard.push(listRunsForItem(handle.db, item.id)[0]?.status);
    });

    // The agent's comment reaches EO over the write bridge, as a real
    // one's does (EO-543), and is posted while the turn is still open.
    const writes = await startTestWriteBridge();
    const supervisor = createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      agentWriteBridge: writes.agentWriteBridge,
      provider: createFakeProvider({
        steps: [
          {
            toolCall: { name: "comment", args: { body: "Halfway through; the retry maths is the tricky part.", blocking: false } },
          },
          { sleepMs: 5 },
        ],
        result: { branch: "eo/EO-1", summary: "Did it.", handoff: "Nothing to flag." },
      }),
      ...createRoleWiring(handle.db),
    });
    writes.serve(supervisor);

    try {
      await supervisor.runOnce();
    } finally {
      await writes.close();
    }

    expect(statusesWhenHeard, "no comment reached a listener at all").not.toEqual([]);
    expect(statusesWhenHeard[0], "the agent's mid-run comment was only announced once the run was over").toBe("running");
  });

  it("still announces the ones written as the run ends", async () => {
    // The implementer's handoff is posted from `onRunSucceeded`, after
    // the run is terminal. Both paths have to work — this is the one
    // that already did, and must not regress.
    const heard: string[] = [];
    onCommentPosted(handle.db, (comment) => void heard.push(comment.body));

    const supervisor = createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: createFakeProvider({
        result: { branch: "eo/EO-1", summary: "Did it.", handoff: "Built on the existing sliding window." },
      }),
      ...createRoleWiring(handle.db),
    });

    await supervisor.runOnce();

    expect(heard).toContain("Built on the existing sliding window.");
  });
});

/**
 * The whole main-side chain, through the real engine wiring:
 * `postComment` → `notifyCommentPosted` → the engine's subscription →
 * the coalescer → `emitPush` → a bridged window.
 *
 * Every other test here stops at one end or the other of that chain.
 */
describe("a comment reaching a window", () => {
  function bridgedWindow() {
    const send = vi.fn();
    let destroyed = false;
    const fake = { isDestroyed: () => destroyed, webContents: { send }, destroy: () => void (destroyed = true) };
    const transport = webContentsTransport(fake as unknown as BrowserWindow);
    return { send, dispose: bridgePushChannels(transport) };
  }

  it("tells every window, whoever wrote it", () => {
    createEngine({ db: handle.db, eoMcpServerPath: "/unused", worktreeRoot: "/unused" });
    const { send, dispose } = bridgedWindow();

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Cap it at 100." });

    expect(send).toHaveBeenCalledWith("push:items:changed", { itemId: item.id });
    dispose();
  });

  it("collapses a burst into one push rather than one each", async () => {
    // An agent writing five notes in a second should cost the renderer
    // one round of refetching the project, inbox, archive and repository
    // list — not five.
    createEngine({ db: handle.db, eoMcpServerPath: "/unused", worktreeRoot: "/unused" });
    const { send, dispose } = bridgedWindow();

    for (let i = 0; i < 5; i++) {
      postComment(handle.db, { itemId: item.id, author: { type: "engine" }, body: `note ${i}` });
    }

    const pushes = send.mock.calls.filter(([channel]) => channel === "push:items:changed");
    expect(pushes.length).toBeLessThan(5);
    expect(pushes.length).toBeGreaterThan(0); // ...but the first is immediate
    dispose();
  });
});

describe("a run announcing itself", () => {
  it("says it is running when it starts, not only when it ends", async () => {
    // Until this, the first thing the project heard about a run was it
    // ending — so a card sat there looking idle for the whole of its
    // work.
    const announced: string[] = [];
    const supervisor = createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: createFakeProvider({
        steps: [{ sleepMs: 5 }],
        result: { branch: "eo/EO-1", summary: "Did it.", handoff: "Nothing to flag." },
      }),
      onRunChanged: (_runId, _itemId, status) => void announced.push(status),
      ...createRoleWiring(handle.db),
    });

    await supervisor.runOnce();

    expect(announced[0], "the first thing announced was the run ending").toBe("running");
    expect(announced.at(-1)).toBe("succeeded");
  });
});
