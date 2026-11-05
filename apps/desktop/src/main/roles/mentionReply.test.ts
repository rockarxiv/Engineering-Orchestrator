import type { Agent, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { archiveAgent, listAgents, listCommentsForItem, listMentionsForComment, listRunsForItem, needsAttention, postComment } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { createRoleWiring } from "../packs/developer/wiring.js";

/**
 * What an `@`-mention leaves behind.
 *
 * From a real item: a human asked the implementer to fix a merge
 * conflict, it rebased the branch, force-pushed, and wrote a careful
 * account of it — into `runs.result`, where nothing read it. The thread
 * got nothing, so the mention stayed open, so the next tick asked for the
 * same thing again, twice, until the attempt limit parked the item with
 * "Stopped after 3 attempt(s)". The work was done correctly all three
 * times.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

const REPLY = "Rebased onto main and force-pushed; the PR reports MERGEABLE again.";

let handle: DbHandle;
let item: Item;
let implementer: Agent;

function supervisor(result: unknown = { message: REPLY }) {
  return createRunSupervisor({
    db: handle.db,
    limits: LIMITS,
    provider: createFakeProvider({ result: result as Record<string, unknown> }),
    ...createRoleWiring(handle.db),
  });
}

/** The asking comment, on a step nobody owns — so any run can only be the mention's doing. */
function mention(body = "@implementer there is a conflict on the PR. Can you fix it?") {
  return postComment(handle.db, {
    itemId: item.id,
    author: { type: "human" },
    body,
    mentions: [{ type: "agent", agentId: implementer.id }],
  });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Resolve internal ticket references", stepId: "ready_to_merge" });
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
});

afterEach(() => {
  handle.close();
});

describe("what an @-mentioned agent leaves behind", () => {
  it("puts its answer in the thread, as itself", async () => {
    mention();

    await supervisor().runOnce();

    const reply = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "agent");
    expect(reply, "the answer used to exist only in runs.result").toBeDefined();
    expect(reply!.body).toBe(REPLY);
    expect(reply!.authorId).toBe(implementer.id); // only the mentioned identity's own comment closes the mention
    expect(reply!.kind).toBe("note");
  });

  it("closes the mention that asked, so nothing dispatches again", async () => {
    const asked = mention();

    await supervisor().runOnce();
    expect(listMentionsForComment(handle.db, asked.id)[0]?.status).toBe("addressed");

    // The loop: an open mention is dispatched every tick, inside the same
    // initiation, until the attempt limit stops it.
    await supervisor().runOnce();
    await supervisor().runOnce();
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);
  });

  it("does not put the answer in the human's inbox", async () => {
    // A reply to a question someone asked is something to read. The `!`
    // marker is for what only a person can do.
    mention();

    await supervisor().runOnce();

    expect(needsAttention(handle.db, item.id)).toBe(false);
  });

  it("does not summon another agent by writing a name in prose", async () => {
    // The comment tool is where an agent asks another one, because that
    // path resolves the mention, validates it and caps its depth. A token
    // in the answer's prose must not become a dispatch.
    mention();

    await supervisor({ message: "Ask @reviewer — they wrote that check." }).runOnce();

    const reply = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "agent")!;
    expect(listMentionsForComment(handle.db, reply.id)).toEqual([]);
  });

  it("does not dispatch an agent archived after the mention was written, and says so once", async () => {
    // The mention path is the one route to a dispatch that does not go
    // through `tick()` (EO-186): the request names an agent, the row is
    // still there, and every tick offers the open mention again. So the
    // refusal is here, and it is a refusal rather than a silent skip —
    // a guard that dropped the request would leave it open forever with
    // nothing in the thread to say why (invariant #8).
    const asked = mention();
    archiveAgent(handle.db, implementer.id);

    await supervisor().runOnce();

    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine");
    expect(note?.body).toContain("Implementer has been archived");
    expect(note?.body).toContain("nothing dispatches it");
    // Closed as it is refused, or the same paragraph arrives every tick
    // for as long as the row stays archived — which is permanently.
    expect(listMentionsForComment(handle.db, asked.id)[0]?.status).toBe("dismissed");

    await supervisor().runOnce();
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine")).toHaveLength(1);
  });

  it("still leaves a comment when the result is unreadable, rather than reopening the loop", async () => {
    // Belt and braces on invariant #8. A-02 validates before this runs,
    // so the shape below should be impossible — and if it ever is not,
    // silence is what starts the re-dispatch cycle over again.
    const asked = mention();

    await supervisor().runOnce();
    const run = listRunsForItem(handle.db, item.id)[0]!;
    const { postMentionReply } = await import("./mentionReply.js");
    postMentionReply(handle.db, item, implementer.id, run.id, { not: "a reply" });

    expect(listMentionsForComment(handle.db, asked.id)[0]?.status).toBe("addressed");
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "agent")).toHaveLength(2);
  });
});
