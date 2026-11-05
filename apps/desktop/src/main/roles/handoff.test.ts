import type { Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listCommentsForItem, listRunsForItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { buildDispatchContext } from "../supervisor/buildDispatchContext.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { createRoleWiring } from "../packs/developer/wiring.js";

/**
 * The implementer's account of its own work (KAN-31).
 *
 * From a real run: a story was implemented for 40¢, the implementer
 * wrote a careful summary — which files, which API, why it built on what
 * was already there — and the item's entire comment thread afterwards
 * was the reviewer's verdict and a pull request link. The implementer
 * left nothing, because `buildDispatchContext` reads same-item
 * *comments* and its summary lived only in `runs.result`.
 *
 * So the reviewer reviewed the diff having never read what the person
 * who wrote it thought they were doing.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

const HANDOFF = "Built on the existing sliding window rather than a second counter; the retry maths is the part worth checking.";

let handle: DbHandle;
let item: Item;

function supervisor() {
  return createRunSupervisor({
    db: handle.db,
    limits: LIMITS,
    provider: createScriptedProvider([
      {
        when: (context) => context.includes(`"implement" action`),
        script: { result: { branch: "eo/EO-1", summary: "Did the work.", handoff: HANDOFF } },
      },
      {
        when: (context) => context.includes(`"review" action`),
        script: { result: { verdict: "approve", feedback: "Fine.", blocking_issues: [] } },
      },
    ]),
    ...createRoleWiring(handle.db),
  });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
});

afterEach(() => {
  handle.close();
});

describe("what the implementer leaves behind", () => {
  it("puts its account in the thread", async () => {
    await supervisor().runOnce();

    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "agent");
    expect(note, "the implementer used to leave nothing at all").toBeDefined();
    expect(note!.body).toBe(HANDOFF);
    expect(note!.kind).toBe("note");
  });

  it("does not interrupt anyone with it", async () => {
    // Something to read, not something to answer. An inbox that pings
    // every time work happened stops being worth opening.
    await supervisor().runOnce();

    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "agent")!;
    expect(note.kind).not.toBe("question");
    expect(note.body).not.toContain("@user");
  });

  it("reaches the reviewer, which is the whole point", async () => {
    // Asserted against the assembled context rather than assumed from
    // the fact that a comment exists — the gap this closes was exactly
    // a comment existing somewhere the reviewer never read.
    await supervisor().runOnce();

    const context = await buildDispatchContext(handle.db, { ...item, stepId: "review" }, "review");

    expect(context).toContain(HANDOFF);
  });

  it("is still there for the next attempt when a review sends the story back", async () => {
    // The case it matters most in. A rejection puts the reviewer's
    // complaint in the thread; without this, the next attempt has no
    // record of what the previous one was thinking and re-derives it.
    await supervisor().runOnce();

    const context = await buildDispatchContext(handle.db, item, "implement");

    expect(context).toContain(HANDOFF);
  });

  it("refuses a result that does not carry one", async () => {
    // Required rather than defaulted: `io: "input"` makes a defaulted
    // field optional for the model, and optional means omitted on
    // exactly the runs where it would have mattered.
    const bare = createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: createScriptedProvider([{ when: () => true, script: { result: { branch: "eo/EO-1", summary: "Did the work." } } }]),
      ...createRoleWiring(handle.db),
    });

    await bare.runOnce();

    // A-02 re-prompts and then stops rather than acting on it.
    expect(listRunsForItem(handle.db, item.id)[0]?.status).not.toBe("succeeded");
  });
});
