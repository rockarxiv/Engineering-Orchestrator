import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FOLDER_KIND } from "@eo/core";
import { afterAll, describe, expect, it } from "vitest";
import { addMemory, createProject, createRun, createWorkspace, listAgents, listSideCalls, postComment } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { sideCallCodexHome } from "../providers/codexHome.js";
import { createSideCallProvider } from "../providers/sideCallProviders.js";
import { resolveSmallModel, smallModelSources } from "../providers/smallModels.js";
import { RUNTIMES } from "../runtimes/catalog.js";
import { runtimeRoot } from "../runtimes/install.js";
import { CLAUDE_SDK, resolvePackageSet } from "../runtimes/packages.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { createSideCaller } from "../sideCalls/sideCall.js";
import { createSideCallSlots } from "../sideCalls/slots.js";
import { deliverMemory, type DeliveredMemory } from "./dispatchMemory.js";
import type { MemoryScopeInfo } from "./selection.js";

/**
 * Selection against the real small models (EO-611), in the shape of
 * `extraction.live.test.ts`.
 *
 * One item, whose work is about a package with a test command of its own,
 * and two runs on it: an implement action, which will run those tests and
 * is held to picking the note about them, and a review action, which
 * judges the work done and is held to leaving that note out. Each goes
 * through `deliverMemory` — the production prompt, input and checks — on
 * each backend's small model, several times over, each attempt in a
 * database of its own. Each backend is held to the wanted answer in four
 * attempts of five at both actions, counting the calls that answered.
 *
 * **Opt-in, because it spends real usage on a real account** — twenty
 * short side calls — and needs both runtimes installed and signed in:
 *
 *     EO_LIVE_MEMORY=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/memory/selection.live.test.ts
 *
 * `EO_LIVE_MEMORY_ATTEMPTS` changes the number of attempts at each action
 * (five), `EO_CODEX_BIN` the Codex binary, and `EO_LIVE_MEMORY_REPORT`
 * names a file each backend's report is appended to as well as printed.
 */
const OPTED_IN = process.env["EO_LIVE_MEMORY"] === "1";
const ATTEMPTS = Number(process.env["EO_LIVE_MEMORY_ATTEMPTS"] ?? "5");
/** Four in five: the bar EO-511 set. */
const NEEDED = Math.ceil((ATTEMPTS * 4) / 5);

const TEST_NOTE = "Reports tests run with `pnpm --filter @app/reports test`; the root `pnpm test` skips that package, so a change to it looks green without its tests having run.";

/** True of the project, each about something other than this item's work or running its tests. */
const OTHER_NOTES = [
  "Run `pnpm db:migrate` after pulling if the API fails to start with a missing-column error. Migrations are numbered SQL files in `apps/api/migrations/`; never edit one that has been merged.",
  "The acquirer client in `packages/acquirer` retries idempotent calls three times with backoff; capture and refund are not idempotent on their side and must never be retried automatically.",
  "Feature flags are read from `config/flags.json` at startup and are not hot-reloaded; restart the API after changing one.",
  "Background jobs run on BullMQ with Redis from `docker compose up redis`. Job handlers live in `apps/worker/src/jobs/` and must be idempotent.",
  "Logging goes through `packages/logger`, which redacts card numbers and IBANs. Never log a request body directly.",
  "The merchant dashboard is a separate deployment; its environment variables are in `apps/dashboard/.env.example`, and a new one has to be added to the deploy config by hand.",
];

const ITEM = {
  title: "Export the settlement ledger as CSV",
  body: "Finance reconciles settlements in a spreadsheet. Give them a CSV export of the settlement ledger, written by a new streaming writer in packages/reports, with tests.",
  criteria: ["The reports page offers a CSV download of the settlement ledger.", "The columns are date, merchant, amount, currency and status, in that order.", "Merchant names with commas or quotes come out as one field."],
};

/** One of the two runs: the action it is dispatched with, and what it comes to. */
interface Fixture {
  action: "implement" | "review";
  role: "implementer" | "reviewer";
  /** What another agent said on the item since this one last ran. */
  comments: string[];
  wanted: (one: Attempt) => boolean;
}

interface Attempt {
  delivered: DeliveredMemory;
  picked: boolean;
  model: string | null;
}

const FIXTURES: Fixture[] = [
  { action: "implement", role: "implementer", comments: [], wanted: (one) => one.delivered.choice.mode === "selected" && one.picked },
  {
    action: "review",
    role: "reviewer",
    comments: ["Added the CSV writer in packages/reports/src/csv.ts with tests and the download route. Reviewer: start with csv.test.ts, the comma-in-merchant-name case."],
    wanted: (one) => one.delivered.choice.mode === "selected" && !one.picked,
  },
];

const cleanup: string[] = [];

afterAll(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

type Backend = "claude" | "codex";

const ROOT = runtimeRoot(join(homedir(), ".config", "EO"));

function executableFor(backend: Backend): string | null {
  return backend === "codex" && process.env["EO_CODEX_BIN"] ? process.env["EO_CODEX_BIN"] : resolveRuntime({ spec: RUNTIMES[backend], root: ROOT }).path;
}

/** The small model a side call on this backend runs on by default, asked up to three times: Codex's sometimes does not answer. */
async function smallModelOf(backend: Backend): Promise<string> {
  const handle = openMigratedTestDb();
  try {
    for (let tries = 0; tries < 3; tries++) {
      const model = await resolveSmallModel(handle.db, backend, smallModelSources(() => executableFor(backend)));
      if (model !== null) return model;
    }
    throw new Error(`No small model could be found for ${backend}.`);
  } finally {
    handle.close();
  }
}

/** One selection for one run on the item, in a database of its own. */
async function attempt(backend: Backend, model: string, fixture: Fixture): Promise<Attempt> {
  const handle = openMigratedTestDb();
  const folder = mkdtempSync(join(tmpdir(), "eo-selection-live-"));
  cleanup.push(folder);
  try {
    const { db } = handle;
    const workspace = createWorkspace(db, { kind: FOLDER_KIND, config: { path: folder } });
    const project = createProject(db, { name: "Payments", keyPrefix: "PAY", workspaceIds: [workspace.id] });
    const item = createTestItem(db, { type: "story", title: ITEM.title, body: ITEM.body, spec: { acceptance_criteria: ITEM.criteria }, stepId: "todo", projectId: project.id, workspaceId: workspace.id });
    const scopes: MemoryScopeInfo[] = [{ scope: { kind: "project", id: project.id }, name: "Payments" }];
    const source = { type: "person", personId: null } as const;
    const written = addMemory(db, { scope: scopes[0]!.scope, body: TEST_NOTE, source });
    if (!written.ok) throw new Error(written.problem);
    for (const body of OTHER_NOTES) addMemory(db, { scope: scopes[0]!.scope, body, source });
    const agent = listAgents(db).find((candidate) => candidate.role === fixture.role)!;
    const someoneElse = listAgents(db).find((candidate) => candidate.id !== agent.id)!;
    for (const body of fixture.comments) postComment(db, { itemId: item.id, author: { type: "agent", agentId: someoneElse.id }, kind: "note", body });
    const run = createRun(db, { itemId: item.id, agentId: agent.id, action: fixture.action, status: "running" });

    const codexHomes = mkdtempSync(join(homedir(), ".eo-selection-live-homes-"));
    cleanup.push(codexHomes);
    const provider = createSideCallProvider(backend, {
      executablePath: executableFor(backend),
      claudeSdkEntryPath: () => resolvePackageSet(ROOT, CLAUDE_SDK),
      codexHome: () => {
        const home = sideCallCodexHome({ roots: [codexHomes] });
        if (!home.ok) throw new Error(home.problem);
        return home.path;
      },
    });
    const caller = createSideCaller({
      db,
      provider: () => provider,
      smallModel: async () => model,
      guards: () => ({ perItemBudgetCents: null, dailyBudgetCents: null }),
      slots: createSideCallSlots({ limit: () => 1, busy: () => 0 }),
    });

    const delivered = await deliverMemory({
      db,
      item,
      agent,
      action: fixture.action,
      runId: run.id,
      backend,
      scopes,
      conversation: false,
      // Under what the entries come to, so a selection is always asked for.
      thresholdChars: 1,
      sideCall: caller.sideCall,
      now: Date.now(),
    });
    return { delivered, picked: delivered.event.entryIds.includes(written.entry.id), model: listSideCalls(db).at(-1)?.model ?? null };
  } finally {
    handle.close();
  }
}

function report(backend: Backend, fixture: Fixture, attempts: Attempt[]): void {
  const lines = attempts.map((one, index) => {
    const { mode, reason } = one.delivered.choice;
    return `  attempt ${index + 1}: ${fixture.wanted(one) ? "as wanted" : "NOT as wanted"}, ${mode}${reason ? ` (${reason})` : ""} on ${one.model ?? "the default model"}, ${one.delivered.event.entryIds.length} picked, the test note ${one.picked ? "among them" : "left out"}`;
  });
  const text = [`[EO-611] ${backend}, ${fixture.action}: ${attempts.filter((one) => fixture.wanted(one)).length}/${attempts.length} attempts as wanted`, ...lines].join("\n");
  console.log(text);
  const file = process.env["EO_LIVE_MEMORY_REPORT"];
  if (file) appendFileSync(file, `${text}\n`);
}

describe.skipIf(!OPTED_IN)("memory selection on the real small models (live)", () => {
  for (const backend of ["claude", "codex"] as const) {
    it(`${backend} picks the note about running the tests for an action that will run them, and leaves it out of one that will not`, { timeout: 30 * 60_000 }, async () => {
      const model = await smallModelOf(backend);
      const held: Record<string, boolean> = {};
      for (const fixture of FIXTURES) {
        // One at a time, as production makes them, for extraction's reason.
        // A call that did not answer says nothing about the prompt, and
        // Codex's small model can pass the 20-second limit on its own, so
        // it is asked again and shown in the report as what it was.
        const attempts: Attempt[] = [];
        const answered = () => attempts.filter((one) => one.delivered.choice.mode === "selected");
        for (let tries = 0; tries < ATTEMPTS * 2 && answered().length < ATTEMPTS; tries++) attempts.push(await attempt(backend, model, fixture));
        report(backend, fixture, attempts);
        held[fixture.action] = answered().length === ATTEMPTS && answered().filter((one) => fixture.wanted(one)).length >= NEEDED;
      }
      expect(held).toEqual({ implement: true, review: true });
    });
  }
});
