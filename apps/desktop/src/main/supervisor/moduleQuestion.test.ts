import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INTERPRET_ACTION, type ModuleManifest, type Item, type Uuid } from "@eo/core";
import { openDb, type DbHandle } from "../db/client.js";
import { moduleItemReader } from "../modules/moduleItemRead.js";
import { runMigrations } from "../db/migrate.js";
import { createRoute, createStep, getItem, listCommentsForItem, listRunsForItem, postComment, saveModule } from "../db/repos/index.js";
import { createModuleRunnerLookup } from "../modules/registry.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createRunSupervisor } from "./runSupervisor.js";

import { createTestItem } from "../db/testHelpers.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";
/**
 * Ask, park, hear, act — for a module (EO-73 / EO-76).
 *
 * The worktree builtin has been able to hold this conversation since
 * KAN-42: it refuses with the candidate keys, the escalation carries
 * them as buttons, the run parks, a person replies, and the next
 * dispatch re-reads the thread and acts on what it finds. A module could
 * do none of it — `ctx` had no thread to read (EO-74), no voice to
 * answer with (EO-75), and `normalize()` reduced every refusal to
 * `{ ok: false, reason }`, so it could not name what it would accept
 * (EO-76).
 *
 * This is the loop closing, once, through the parts that actually ship:
 * the real supervisor, the real registry, a real `moduleHost.mjs`
 * subprocess, and a real module that reads the reply back out of the
 * thread. Each half is unit-tested where it lives — `modules/
 * runModule.test.ts` for what the host will and will not carry,
 * `moduleSteps.test.ts` for the supervisor on a stub runner. What only a
 * test like this can catch is the loop failing to join up: options that
 * survive `normalize` and never reach the comment, or a reply the next
 * dispatch cannot see because the item never resumed.
 *
 * On disk rather than in memory, deliberately. The host opens EO's
 * database itself, read-only, in a second process — `:memory:` is
 * private to the handle that made it, so a module reading an item out
 * of one would find nothing there.
 */

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "modules", "moduleHost.mjs");
const migrationsFolder = join(here, "..", "db", "migrations");

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/** `safeStorage`, minus the OS — the seam `registry.test.ts` and `credentials.test.ts` both use. */
const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
};

/**
 * A module that asks, and hears the answer the way EO does.
 *
 * The matching is `recordedStackAnswer`'s, written out by hand rather
 * than taken from `ctx.answer()` (EO-183), and deliberately left that
 * way: what this test is about is the loop closing — options that survive
 * `normalize` reaching the comment, a reply the next dispatch can see —
 * and a module reading the thread for itself is the harder version of
 * that to keep working. Newest reply first; only human replies written
 * after EO's most recent escalation, since anything before that answered
 * a different question; and only what was actually offered. What
 * `ctx.answer()` hands a module instead is proved where it is computed,
 * in `modules/registry.test.ts`.
 */
const code = `
const OPTIONS = ["Merge anyway", "Send it back"];

export default async function run(ctx) {
  const seen = ctx.ticket();
  if (!seen.found) return { ok: false, reason: seen.reason };

  const thread = seen.ticket.comments;
  let lastAsk = -1;
  for (let i = 0; i < thread.length; i += 1) {
    if (thread[i].author.type === "engine" && thread[i].kind === "escalation") lastAsk = i;
  }

  for (let i = thread.length - 1; i > lastAsk; i -= 1) {
    if (thread[i].author.type !== "human") continue;
    const said = thread[i].body.toLowerCase();
    const chosen = OPTIONS.find((option) => said.includes(option.toLowerCase()));
    if (chosen === "Merge anyway") return { ok: true, result: "deployed", detail: "merged on your say-so" };
    if (chosen === "Send it back") return { ok: true, result: "failed", detail: "sent back on your say-so" };
  }

  return { ok: false, reason: "CI failed on this branch. What should happen?", options: OPTIONS };
}`;

const manifest: ModuleManifest = {
  name: "Gate on CI",
  description: "Checks CI, and asks when it failed.",
  inputs: {},
  needs: { bin: [], env: [], network: false, item: true, comment: false, attach: false, create: false },
  results: ["deployed", "failed"],
};

let directory: string;
let handle: DbHandle;
let item: Item;
let supervisor: ReturnType<typeof createRunSupervisor>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eo module question "));
  const dbPath = join(directory, "eo.db");
  handle = openDb(dbPath);
  runMigrations(handle.db, migrationsFolder);

  const saved = saveModule(handle.db, { slug: "gate-on-ci", name: "Gate on CI", description: "Checks CI, and asks when it failed.", code, manifest, approve: true });
  if (!saved.ok) throw new Error(saved.reason);

  createStep(handle.db, { id: "gate", pipelineId: "default" as Uuid, position: 15, name: "Gate", type: "module", entryAction: saved.module.id });
  createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "gate", resultKey: "deployed", label: "Deployed", target: "review" });
  createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "gate", resultKey: "failed", label: "Sent back", target: "todo", position: 1 });

  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "gate" });

  supervisor = createRunSupervisor({
    db: handle.db,
    // A module reaches no provider, and this one still does not. What
    // may is the system agent reading a reply the module could not use
    // (EO-184) — the fallback below is what keeps the original
    // assertion, since every other dispatch here would hit it.
    provider: createScriptedProvider(
      [
        {
          when: (context) => context.includes(`"${INTERPRET_ACTION}" action`),
          script: { result: { status: "unusable", problem: "it names a person rather than one of the two answers" } },
        },
      ],
      { throwMessage: "a module must not reach a provider" },
    ),
    ...createRoleWiring(handle.db),
    limits: LIMITS,
    // The real thing, reading this test's database the way the app does.
    moduleRunner: createModuleRunnerLookup({
      db: handle.db,
      launcher: { execPath: process.execPath, hostPath, hostEnv: { ELECTRON_RUN_AS_NODE: "1" }, items: moduleItemReader(handle.db) },
      secrets: { directory: join(directory, "secrets"), store },
    }),
    // No repository on this item, and none needed: what is being
    // tested is the conversation, not the worktree.
    kinds: kindsPreparing(directory),
  });
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("a module asking a question", () => {
  it("parks with the answers it named, hears the reply, and acts on it", async () => {
    await supervisor.runOnce();

    // Asked. The options are the module's own, carried through
    // `normalize`, the result channel and `runBuiltin` without anyone
    // rewriting them.
    const asked = listCommentsForItem(handle.db, item.id).at(-1);
    expect(asked?.kind).toBe("escalation");
    expect(asked?.body).toContain("CI failed on this branch.");
    expect(asked?.options).toEqual(["Merge anyway", "Send it back"]);

    // Parked. Invariant #9: the run ended rather than holding a
    // subprocess open waiting for a person.
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
    expect(getItem(handle.db, item.id)?.stepId).toBe("gate");

    // Answered, as a person does it: a reply filed under the question.
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, parentId: asked?.id ?? null, body: "Send it back." });

    await supervisor.runOnce();

    // Heard, and acted on. A different result from the same module, on
    // the strength of what it read in the thread — and the route, not
    // the module, is what moved the item (invariant #1).
    const rerun = listRunsForItem(handle.db, item.id).find((run) => run.status === "succeeded");
    expect(rerun?.result).toMatchObject({ parsed: { result: "failed" } });
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");

    // And nothing was paid for reading it (EO-184). "Send it back." is
    // one of the answers the module offered, normalised for the full
    // stop a person types, so the reply goes straight to the module and
    // no model is asked what it meant.
    expect(listRunsForItem(handle.db, item.id).some((run) => run.action === INTERPRET_ACTION)).toBe(false);
  }, 30_000);

  /**
   * The other button, so the test proves the module read the reply
   * rather than that "the second run returns failed".
   *
   * Same module, same question, a different answer — and a different
   * step at the end of it.
   */
  it("takes the other answer where the other answer leads", async () => {
    await supervisor.runOnce();

    const asked = listCommentsForItem(handle.db, item.id).at(-1);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, parentId: asked?.id ?? null, body: "Merge anyway." });

    await supervisor.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  }, 30_000);

  /**
   * A reply that names nothing on offer.
   *
   * This used to be where the loop gave up: the module could not use the
   * sentence, so it re-ran, hand-parsed the thread, found nothing and
   * asked the identical question again. Since EO-184 the sentence goes
   * to the system agent first — the module is not re-run at all, and
   * what the person hears back is about *their* reply rather than the
   * same question a second time.
   *
   * What has not changed is the part that mattered then and matters now:
   * the item parks rather than routing on a guess, and nobody is left
   * with an item that quietly stopped.
   */
  it("hands a reply naming none of the answers to the system agent, rather than re-asking", async () => {
    await supervisor.runOnce();

    const asked = listCommentsForItem(handle.db, item.id).at(-1);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, parentId: asked?.id ?? null, body: "I have no idea, ask Priya." });

    await supervisor.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("gate");
    // One interpretation, and the module was not run a second time — the
    // two runs are its first attempt and the interpretation.
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.filter((run) => run.action === INTERPRET_ACTION)).toHaveLength(1);
    expect(runs.filter((run) => run.agentId === null)).toHaveLength(1);

    // The question the module asked is still the last one anybody
    // offered answers for; what the agent added is about the reply.
    const escalations = listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation");
    expect(escalations).toHaveLength(2);
    expect(escalations[0]?.options).toEqual(["Merge anyway", "Send it back"]);
    expect(escalations.at(-1)?.authorType).toBe("agent");
    expect(escalations.at(-1)?.body).toContain("it names a person rather than one of the two answers");
  }, 30_000);
});
