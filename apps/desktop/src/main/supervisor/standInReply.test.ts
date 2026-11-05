import { adminToolsEnabled, type Agent, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAgents } from "../db/repos/agentsRepo.js";
import { listCommentsForItem, postComment } from "../db/repos/commentsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { postHumanComment } from "../ipc/domainCommands.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { ON_YOUR_BEHALF_TRIAL } from "../trials/onBehalf.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";

/**
 * A reply the system agent posts in the person's place on a trial item
 * (EO-585) is a reply to everything that waits on one — including the
 * scheduler's recovery of a reply whose immediate resume was deferred.
 *
 * The case this holds: an agent under test parks asking the person; the
 * reply arrives while EO is paused, so the resume it would have started
 * is put off; EO is resumed. A person's reply is picked up on the next
 * tick by `deferredReplyItemIds`. The assistant's has to be too, or the
 * trial sits parked for ever, waiting on an answer it already has.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

describe("a stand-in reply on a trial item, posted while EO is paused", () => {
  let handle: DbHandle;
  let writes: TestWriteBridge;
  let systemAgent: Agent;

  beforeEach(async () => {
    handle = openMigratedTestDb();
    writes = await startTestWriteBridge();
    // The installation's own: seeded with the administrative grant (EO-185).
    systemAgent = listAgents(handle.db).find((agent) => agent.role === "system" && adminToolsEnabled(agent))!;
  });

  afterEach(async () => {
    await writes.close();
    handle.close();
  });

  function supervisorAskingTheUser(): RunSupervisor {
    const provider = createFakeProvider({
      steps: [{ toolCall: { name: "comment", args: { body: "@user proceed?", mentions: ["user"], blocking: true } } }],
      result: validImplementResult,
    });
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, agentWriteBridge: writes.agentWriteBridge });
    writes.serve(supervisor);
    return supervisor;
  }

  async function parkedTrialItem(supervisor: RunSupervisor): Promise<Item> {
    const item = createTestItem(handle.db, { type: "story", title: "A test item", stepId: "todo", spec: REVIEWABLE_SPEC, trialAt: Date.now() });
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id).map((run) => run.status)).toEqual(["awaiting_input"]);
    return item;
  }

  /** Paused, replied to, the deferred resume attempted, unpaused, one tick: how many runs then. */
  async function afterPausedReply(supervisor: RunSupervisor, item: Item, reply: () => Promise<unknown>): Promise<number> {
    supervisor.pause();
    await reply();
    // What `postHumanComment` hands the engine; paused, it starts nothing.
    await supervisor.resumeItem(item.id);
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);
    supervisor.resume();
    await supervisor.runOnce();
    return listRunsForItem(handle.db, item.id).length;
  }

  it("resumes the trial for the person's reply and for the system agent's alike", async () => {
    for (const actingAgentId of [undefined, systemAgent.id]) {
      const supervisor = supervisorAskingTheUser();
      const item = await parkedTrialItem(supervisor);

      const runs = await afterPausedReply(supervisor, item, () =>
        postHumanComment(handle.db, undefined, {
          itemId: item.id,
          body: "Proceed.",
          mentions: [],
          pinned: false,
          parentId: null,
          ...(actingAgentId === undefined ? {} : { actingAgentId }),
        }),
      );

      expect(runs).toBe(2);
      const second = listRunsForItem(handle.db, item.id)[1];
      expect(second).toMatchObject({ status: "succeeded" });
      if (actingAgentId !== undefined) {
        const reply = listCommentsForItem(handle.db, item.id).find((comment) => comment.body.startsWith("Proceed."))!;
        expect(reply).toMatchObject({ authorType: "agent", authorId: systemAgent.id, runId: null });
        expect(reply.body).toContain(ON_YOUR_BEHALF_TRIAL);
      }
      supervisor.stop();
    }
  });

  it("does not take the system agent's ordinary commentary for a reply", async () => {
    const supervisor = supervisorAskingTheUser();
    const item = await parkedTrialItem(supervisor);

    // Its words with no stand-in note, as anything but `comments:post`
    // on the administrative host writes them.
    const runs = await afterPausedReply(supervisor, item, async () =>
      postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: systemAgent.id }, body: "Looking at this." }),
    );

    expect(runs).toBe(1);
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
  });
});
