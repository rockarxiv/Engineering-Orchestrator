import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FOLDER_KIND, type Run } from "@eo/core";
import { afterAll, describe, expect, it } from "vitest";
import { addMemory, appendRunEvent, createProject, createRun, createWorkspace, getRun, listAgents, listMemories, listSideCalls, postComment, updateRun } from "../db/repos/index.js";
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
import { extractMemory, type ExtractionOutcome } from "./extraction.js";
import type { MemoryScopeInfo } from "./selection.js";

/**
 * Extraction against the real small models (EO-511, EO-592).
 *
 * Five fixture runs on one project, each on an item of its own with a
 * title, description and acceptance criteria:
 *
 * - one whose final answer states three facts that stay true for its
 *   repository, beside the usual account of what the run did — at least
 *   one correct note;
 * - a control that learned nothing — no notes;
 * - one reporting three defects in the change under way — no notes;
 * - one restating, as rules, what its item asks for — no notes;
 * - one reporting defects in the change and, among them, one trap that
 *   outlasts the item — exactly that note;
 * - one stating a known gap its change leaves — no notes.
 *
 * The last three (EO-592) are written in no pack's vocabulary: the run
 * checks a change and reports a result key, and nothing says what role it
 * is. Each is given to `extractMemory` — the production prompt, input and
 * checks — on each backend's small model, several times over, each
 * attempt in a database of its own so one attempt's notes are not the
 * next one's "memory already holds". Every attempt's outcome and notes
 * are printed; the test holds each backend to the wanted answer in four
 * attempts of five at every fixture.
 *
 * **Opt-in, because it spends real usage on a real account** — sixty
 * short side calls — and needs both runtimes installed and signed in,
 * Codex's sign-in kept in a file (EO-509):
 *
 *     EO_LIVE_MEMORY=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/memory/extraction.live.test.ts
 *
 * `EO_LIVE_MEMORY_ATTEMPTS` changes the number of attempts at each run
 * (five), `EO_LIVE_MEMORY_PARALLEL` how many are in flight at once (one),
 * `EO_CODEX_BIN` the Codex binary, and `EO_LIVE_MEMORY_REPORT` names a
 * file each backend's report is appended to as well as printed — vitest
 * keeps a passing test's output to itself.
 */
const OPTED_IN = process.env["EO_LIVE_MEMORY"] === "1";
const ATTEMPTS = Number(process.env["EO_LIVE_MEMORY_ATTEMPTS"] ?? "5");
/**
 * How many attempts are in flight at once: one, as production makes
 * them. Twenty Codex app-servers at once time out at the 60-second limit
 * the call is held to, which measures the machine and not the prompt —
 * and with twenty-five calls a backend (EO-592), two or four in flight
 * still had four to seven Codex calls time out with nothing answered,
 * while every call that did answer was right. One at a time takes about
 * five minutes a backend.
 */
const PARALLEL = Number(process.env["EO_LIVE_MEMORY_PARALLEL"] ?? "1");
/** Four in five: the bar EO-511 set. */
const NEEDED = Math.ceil((ATTEMPTS * 4) / 5);

/** The three durable facts, each as a test a correct note passes. */
const FACTS: { name: string; matches: (text: string) => boolean }[] = [
  { name: "reports tests need the filtered command", matches: (text) => /@app\/reports/.test(text) && /filter/i.test(text) },
  { name: "the CSV writer emits a UTF-8 BOM", matches: (text) => /csv/i.test(text) && /(byte[- ]order[- ]mark|\bBOM\b|\\uFEFF|EF BB BF)/i.test(text) },
  { name: "payments fixtures are generated", matches: (text) => /fixture/i.test(text) && /(regenerat|generat|by hand|hand-edit|manually)/i.test(text) },
];

/**
 * The fixture run's final answer: what it did, and in among it — said in
 * passing, the way a run says them, not set out as lessons — what it
 * learned.
 */
const FINAL_ANSWER = {
  branch: "rockarxiv/PAY-214",
  summary:
    "Implemented the settlement CSV export (PAY-214): new endpoint `GET /reports/settlements.csv` in apps/api, streaming writer in packages/reports/src/csv.ts with tests, refunded settlement added to the payments fixtures. The CSV writer must emit a UTF-8 byte order mark, so it does. Reports tests run with `pnpm --filter @app/reports test`, since the root command skips that package; 41 pass. The payments fixtures are regenerated by scripts/gen-fixtures.ts and must not be edited by hand, so the new settlement went into the generator.",
  handoff:
    "Column order matches the ledger screen as asked. Left out the date-range filter (PAY-215). Reviewer: start with csv.test.ts, the comma-in-merchant-name case. Renamed ledgerRows to settlementRows in apps/api/src/ledger/query.ts; no other callers.",
  files_changed: ["apps/api/src/routes/reports.ts", "packages/reports/src/csv.ts", "packages/reports/src/csv.test.ts", "scripts/gen-fixtures.ts", "apps/api/src/ledger/query.ts"],
  tests_run: true,
};

/** The item a fixture run worked on. */
interface FixtureItem {
  title: string;
  body: string;
  criteria: string[];
}

/** A run, as far as extraction reads one. */
interface Fixture {
  /** What the report calls it. */
  name: string;
  item: FixtureItem;
  /** Who ran it and the action it ran, as the input names them. */
  agentName: string;
  action: string;
  finalAnswer: Record<string, unknown>;
  /** The comments the run posted while it worked. */
  comments: string[];
  /** What a person said on the item before the run. */
  human: string[];
  /** Whether an attempt answered what this fixture wants. */
  wanted: (one: Attempt) => boolean;
}

const EXPORT_ITEM: FixtureItem = {
  title: "Export the settlement ledger as CSV",
  body: "Finance reconciles settlements in a spreadsheet. Give them a CSV export of the settlement ledger they can download from the reports page.",
  criteria: [
    "The reports page offers a CSV download of the settlement ledger.",
    "The columns are date, merchant, amount, currency and status, in that order.",
    "Merchant names with commas or quotes come out as one field.",
  ],
};

/** No notes at all: the model answered that there was nothing to keep. */
const noNotes = (one: Attempt) => one.outcome.kind === "nothing_to_save";

const LEARNED: Fixture = {
  name: "the run that learned three facts",
  item: EXPORT_ITEM,
  agentName: "Implementer",
  action: "implement",
  finalAnswer: FINAL_ANSWER,
  comments: [
    "Starting on the CSV export. Plan: endpoint in apps/api, writer in packages/reports, fixture for a refunded settlement.",
    "Endpoint and writer are in. Running the reports tests now.",
  ],
  human: ["Finance needs this by Friday. Keep the column order the same as the ledger screen: date, merchant, amount, currency, status."],
  wanted: (one) => one.facts.length > 0,
};

/**
 * The control: a run on the same item that says only what it did. A
 * prompt that finds the three facts by writing a note about everything
 * would show here.
 */
const LEARNED_NOTHING: Fixture = {
  name: "the run that learned nothing",
  item: EXPORT_ITEM,
  agentName: "Implementer",
  action: "implement",
  finalAnswer: {
    branch: "rockarxiv/PAY-216",
    summary:
      "Renamed the `Amount` column header in the settlement CSV export to `Amount (minor units)` and updated the two snapshot tests that assert the header row. Root `pnpm test` passes; 41 reports tests pass. No other behaviour changed.",
    handoff:
      "A one-line change to the header list in packages/reports/src/csv.ts plus the snapshots. Nothing was left out. The reviewer only needs to read the header list and confirm the snapshot diff is the header alone.",
    files_changed: ["packages/reports/src/csv.ts", "packages/reports/src/__snapshots__/csv.test.ts.snap"],
    tests_run: true,
  },
  comments: ["Renaming the column header now; this only touches the header list and its snapshots."],
  human: [],
  wanted: noNotes,
};

/**
 * The item the three runs of EO-592 checked: a change in progress, with
 * what it asks for written out as a person would.
 */
const STATEMENT_ITEM: FixtureItem = {
  title: "Let merchants download a monthly statement as PDF",
  body: "Merchants write to support every month asking for a statement. Let them download one themselves from the dashboard: one PDF per month, listing that month's settlements and refunds, with a total.",
  criteria: [
    "A merchant can download a PDF statement for any past month from the dashboard.",
    "The statement lists every settlement and refund in the month, dated in the merchant's time zone.",
    "The statement's total equals the month's settlements minus its refunds.",
    "A month with no settlements gives a statement saying so, not an error.",
  ],
};

/**
 * A run that checked the change and found three things wrong with it —
 * each written the way such findings are, as what the code "must" do.
 * None of it is true of the project once the change is put right.
 */
const DEFECTS: Fixture = {
  name: "the run reporting three defects in the change",
  item: STATEMENT_ITEM,
  agentName: "Checker",
  action: "check",
  finalAnswer: {
    result: "sent_back",
    summary: "Checked the monthly statement download against what the item asks. It is not ready: three things are wrong in this change.",
    findings: [
      "The total adds refunds instead of subtracting them: packages/statements/src/total.ts sums `Math.abs(amount)`, so a month with a 20.00 refund comes out 40.00 too high. It must use the signed amount.",
      "The new download route in apps/api/src/routes/statements.ts is never registered in routes/index.ts, so GET /statements/:month answers 404. Ensure it is registered before this goes further.",
      "renderStatement throws on a month with no settlements (it reads `rows[0].date` from an empty list), and there is no test for an empty month. It must render the 'no settlements' page instead, with a test.",
    ],
    next: "Fix the three findings above, add the empty-month test, and run the integration suite before handing it back.",
  },
  comments: ["Looking at the statement download now: the total, the route and the empty month."],
  human: [],
  wanted: noNotes,
};

/**
 * A run that found the change does what the item asks, and says so by
 * restating each criterion as a rule. Every one of them is already on
 * the item.
 */
const RESTATED: Fixture = {
  name: "the run restating what the item asks for",
  item: STATEMENT_ITEM,
  agentName: "Checker",
  action: "check",
  finalAnswer: {
    result: "accepted",
    summary:
      "The statement download does what the item asks. Merchants must be able to download a PDF statement for any past month from the dashboard, and they can. Statements must list every settlement and refund in the month, dated in the merchant's time zone; they do. The total must equal the month's settlements minus its refunds, and it does. A month with no settlements must give a statement saying so rather than an error, and it does.",
    checked: [
      "PDF download for a past month from the dashboard",
      "Every settlement and refund listed, in the merchant's time zone",
      "Total is settlements minus refunds",
      "An empty month gives a statement saying so",
    ],
  },
  comments: ["Going through the statement download criterion by criterion."],
  human: [],
  wanted: noNotes,
};

/** The one fact in the mixed run that outlasts the item. */
const FONT_TRAP = /loadStatementFonts/;

/**
 * A run that found two things wrong with the change and, while finding
 * them, hit a trap in code the change did not touch — the one thing in
 * it a later agent would need after the item is finished.
 */
const MIXED: Fixture = {
  name: "the run reporting defects and one lasting trap",
  item: STATEMENT_ITEM,
  agentName: "Checker",
  action: "check",
  finalAnswer: {
    result: "sent_back",
    summary:
      "Checked the monthly statement download. Two things are wrong in this change, listed below. To check the total I had to render statements myself, and the first renders came out with every amount blank: the PDF renderer in packages/pdf, which this change does not touch, draws with fonts loaded by `loadStatementFonts()`, which nothing awaits for you, and until it resolves it silently falls back to a font with no digits or currency signs and raises no error. Any test or script that renders a statement has to `await loadStatementFonts()` first.",
    findings: [
      "Refunds are listed on the statement with a positive amount; the item asks for the total to be settlements minus refunds, and the line items must show refunds as negative to match it.",
      "Dates are printed in UTC, not in the merchant's time zone, so a settlement just after midnight lands in the wrong month. Ensure the statement converts with the merchant's zone.",
    ],
    next: "Fix the two findings and send it back.",
  },
  comments: ["Rendering a few statements to check the totals and the dates."],
  human: [],
  wanted: (one) => one.notes.length === 1 && FONT_TRAP.test(one.notes[0]!),
};

/**
 * A run that finished its change and says, the way runs do, what it
 * leaves undone: statements for merchants paid in more than one
 * currency still come out with one wrong total, which the item did not
 * ask about — written as a "known gap" to close before relying on it, the
 * shape such things took in memory. It belongs in the run's answer, where
 * it is judged, and that is where it already is. Wanted: no note.
 */
const GAP: Fixture = {
  name: "the run stating a known gap its change leaves",
  item: STATEMENT_ITEM,
  agentName: "Builder",
  action: "build",
  finalAnswer: {
    result: "done",
    summary:
      "Built the monthly statement download: a Statements tab on the dashboard, `GET /statements/:month` in apps/api, and the PDF renderer in packages/statements with tests for a normal month, a month with refunds and an empty month. All four criteria are met.",
    handoff:
      "Known gap: a merchant paid in more than one currency gets one total that adds the amounts across currencies as if they were one, so the figure is wrong for them. The item did not ask about currencies and I left it out on purpose; it wants a total per currency on the statement. Close this before turning statements on for multi-currency merchants. Reviewer: start with packages/statements/src/total.test.ts.",
    files_changed: ["apps/api/src/routes/statements.ts", "packages/statements/src/render.ts", "packages/statements/src/total.ts", "packages/statements/src/total.test.ts"],
    tests_run: true,
  },
  comments: ["Starting on the statement download: route, renderer, then the dashboard tab."],
  human: [],
  wanted: (one) => one.notes.length === 0,
};

const FIXTURES = [LEARNED, LEARNED_NOTHING, DEFECTS, RESTATED, MIXED, GAP];

/** Notes about this run rather than the project: what a good extraction leaves out. */
const ABOUT_THE_RUN = /PAY-21[45]|settlementRows|ledgerRows|\b41\b|date-range/i;


/**
 * What memory already holds: true of the project, near what the run
 * learned in places, and none of it what the run learned.
 */
const EXISTING = [
  "Money is stored as integer cents everywhere; never use floats for amounts. Conversions to decimal strings happen only in `packages/money/src/format.ts`, and every API response that carries an amount carries its currency beside it as an ISO 4217 code.",
  "Settlement dates are in UTC; convert to the merchant's zone only when displaying. The merchant's zone is `merchants.timezone`, an IANA name; a merchant with none set is shown in Europe/London, which is where the first merchants were and what finance still expects.",
  "Run `pnpm db:migrate` after pulling if the API fails to start with a missing-column error. Migrations are numbered SQL files in `apps/api/migrations/`; never edit one that has been merged, add a new one instead, because production has already applied it.",
  "API routes live in `apps/api/src/routes/`, one file per resource; register each in `apps/api/src/routes/index.ts`. A route that is not registered there compiles and passes its unit tests but answers 404 in the integration suite, which has cost more than one review cycle.",
  "Run `pnpm lint` and `pnpm typecheck` before pushing; CI fails on either. Lint includes a rule that forbids `console.log` outside `scripts/`, and the typecheck runs with `noUncheckedIndexedAccess`, so array indexing needs a guard.",
  "The ledger query module (`apps/api/src/ledger/query.ts`) is the only place that reads the settlements table directly. Everything else goes through its functions, which apply the merchant's visibility rules; a direct query elsewhere leaks other merchants' rows in the admin view.",
  "Merchant names can contain commas, quotes and non-Latin characters; test any export or display with such a name. The seed data has three such merchants (`Café, Bar & Co`, `\"Quoted\" Ltd` and `株式会社テスト`) for exactly this.",
  "Integration tests need Postgres from `docker compose up db`; unit tests do not. The integration suite is `pnpm test:integration` and is not part of `pnpm test`; CI runs both, so a change to a query should be checked with the integration suite locally first.",
  "Refunds are settlements with a negative amount and `kind = 'refund'`; they reference the original settlement through `refund_of`. Partial refunds exist, so never assume a refund's amount equals the original's.",
  "Feature flags are read from `config/flags.json` at startup and are not hot-reloaded; restart the API after changing one. Flags are named `area.feature` in snake case, e.g. `reports.csv_export`.",
  "The payments service talks to the acquirer through `packages/acquirer`, which wraps their SOAP API. Its client retries idempotent calls three times with backoff; capture and refund are not idempotent on their side and must never be retried automatically.",
  "Reviewers here expect one logical change per pull request and a description that says how it was tested. A PR that mixes a refactor with a behaviour change is sent back to be split.",
  "Logging goes through `packages/logger`, which redacts card numbers and IBANs. Never log a request body directly; pass it to `logger.withBody`, which applies the redaction.",
  "Dates in API payloads are ISO 8601 strings with an explicit `Z`; the frontend parses them with `parseISO` from date-fns. Sending a date without a zone has produced off-by-one-day bugs in the settlement calendar twice.",
  "Background jobs run on BullMQ with Redis from `docker compose up redis`. Job handlers live in `apps/worker/src/jobs/` and must be idempotent, since a job can run more than once after a worker restart.",
];
const TOOLS = ["Read", "Grep", "Bash", "Edit", "Write"];

const cleanup: string[] = [];

afterAll(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

type Backend = "claude" | "codex";

const ROOT = runtimeRoot(join(homedir(), ".config", "EO"));

function executableFor(backend: Backend): string | null {
  return backend === "codex" && process.env["EO_CODEX_BIN"] ? process.env["EO_CODEX_BIN"] : resolveRuntime({ spec: RUNTIMES[backend], root: ROOT }).path;
}

/**
 * The small model a side call on this backend runs on by default, asked
 * once rather than by every attempt: finding Codex's spawns its CLI, and
 * several at once can fail to answer. Asked up to three times, since even
 * one sometimes does.
 */
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

interface Attempt {
  outcome: ExtractionOutcome;
  notes: string[];
  facts: string[];
  /** How many of its notes are about this run, not the project. */
  aboutTheRun: number;
  tokensOut: number;
  model: string | null;
}

/** One extraction of a fixture run, in a database of its own. */
async function attempt(backend: Backend, model: string, fixture: Fixture): Promise<Attempt> {
  const handle = openMigratedTestDb();
  const folder = mkdtempSync(join(tmpdir(), "eo-extraction-live-"));
  cleanup.push(folder);
  try {
    const { db } = handle;
    const workspace = createWorkspace(db, { kind: FOLDER_KIND, config: { path: folder } });
    const project = createProject(db, { name: "Payments", keyPrefix: "PAY", workspaceIds: [workspace.id] });
    const item = createTestItem(db, {
      type: "story",
      title: fixture.item.title,
      body: fixture.item.body,
      spec: { acceptance_criteria: fixture.item.criteria },
      stepId: "todo",
      projectId: project.id,
      workspaceId: workspace.id,
    });
    const scopes: MemoryScopeInfo[] = [
      { scope: { kind: "project", id: project.id }, name: "Payments" },
      { scope: { kind: "workspace", id: workspace.id }, name: "payments-api" },
    ];
    for (const body of EXISTING) addMemory(db, { scope: scopes[0]!.scope, body, source: { type: "person", personId: null } });
    for (const body of fixture.human) postComment(db, { itemId: item.id, author: { type: "human" }, kind: "note", body });
    // Any agent will do: extraction reads its name and nothing else of it.
    const agent = { ...listAgents(db).find((candidate) => candidate.role === "implementer")!, name: fixture.agentName };
    const created = createRun(db, { itemId: item.id, agentId: agent.id, action: fixture.action, status: "running" });
    for (const name of TOOLS) appendRunEvent(db, created.id, "tool_call", { name, input: {} });
    for (const body of fixture.comments) postComment(db, { itemId: item.id, runId: created.id, author: { type: "agent", agentId: agent.id }, kind: "note", body });
    updateRun(db, created.id, { status: "succeeded", endedAt: Date.now(), result: { raw: fixture.finalAnswer, parsed: fixture.finalAnswer } });
    const run = getRun(db, created.id) as Run;

    const executablePath = executableFor(backend);
    const codexHomes = mkdtempSync(join(homedir(), ".eo-extraction-live-homes-"));
    cleanup.push(codexHomes);
    const provider = createSideCallProvider(backend, {
      executablePath,
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

    const outcome = await extractMemory({ db, run, item, agent, backend, scopes, sideCall: caller.sideCall });
    const call = listSideCalls(db).at(-1);
    const notes = scopes.flatMap((info) => listMemories(db, info.scope)).filter((entry) => !EXISTING.includes(entry.body)).map((entry) => entry.body);
    const facts = FACTS.filter((fact) => notes.some((note) => fact.matches(note))).map((fact) => fact.name);
    return { outcome, notes, facts, aboutTheRun: notes.filter((note) => ABOUT_THE_RUN.test(note)).length, tokensOut: call?.tokensOut ?? 0, model: call?.model ?? null };
  } finally {
    handle.close();
  }
}

/** Runs every task, at most `PARALLEL` at once, and answers in their order. */
async function bounded<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(PARALLEL, tasks.length)) }, worker));
  return results;
}

function report(label: string, fixture: Fixture, attempts: Attempt[]): void {
  const lines = attempts.map((one, index) => {
    const head = `  attempt ${index + 1}: ${fixture.wanted(one) ? "as wanted" : "NOT as wanted"}, ${one.outcome.kind}${one.outcome.kind === "failed" ? ` (${one.outcome.reason}: ${one.outcome.message})` : ""} on ${one.model ?? "the default model"}, ${one.tokensOut} tokens out, ${one.notes.length} note(s)${one.outcome.kind === "written" && one.outcome.dropped.length > 0 ? `, ${one.outcome.dropped.length} dropped (${one.outcome.dropped.join(" | ")})` : ""}${fixture === LEARNED ? `, facts: ${one.facts.join("; ") || "none"}` : ""}`;
    return [head, ...one.notes.map((note) => `    - ${note}${ABOUT_THE_RUN.test(note) ? "  [about the run]" : ""}`)].join("\n");
  });
  const good = attempts.filter((one) => fixture.wanted(one)).length;
  const facts = attempts.reduce((sum, one) => sum + one.facts.length, 0);
  const aboutTheRun = attempts.reduce((sum, one) => sum + one.aboutTheRun, 0);
  const text = [
    `[EO-592] ${label}, ${fixture.name}: ${good}/${attempts.length} attempts as wanted; notes per attempt: ${attempts.map((one) => one.notes.length).join(", ")}` +
      (fixture === LEARNED ? `; facts found ${facts}/${attempts.length * FACTS.length}; notes about the run ${aboutTheRun}` : ""),
    ...lines,
  ].join("\n");
  console.log(text);
  const file = process.env["EO_LIVE_MEMORY_REPORT"];
  if (file) appendFileSync(file, `${text}\n`);
}

describe.skipIf(!OPTED_IN)("memory extraction on the real small models (live)", () => {
  for (const backend of ["claude", "codex"] as const) {
    it(`${backend} keeps what outlasts the item and leaves out the work under way, at every fixture`, { timeout: 30 * 60_000 }, async () => {
      const model = await smallModelOf(backend);
      const runs = await bounded(FIXTURES.flatMap((fixture) => Array.from({ length: ATTEMPTS }, () => () => attempt(backend, model, fixture))));
      const byFixture = FIXTURES.map((fixture, index) => ({ fixture, attempts: runs.slice(index * ATTEMPTS, (index + 1) * ATTEMPTS) }));
      for (const { fixture, attempts } of byFixture) report(backend, fixture, attempts);
      expect(runs.filter((one) => one.outcome.kind === "failed").map((one) => one.outcome)).toEqual([]);
      expect(Object.fromEntries(byFixture.map(({ fixture, attempts }) => [fixture.name, attempts.filter((one) => fixture.wanted(one)).length >= NEEDED]))).toEqual(
        Object.fromEntries(FIXTURES.map((fixture) => [fixture.name, true])),
      );
    });
  }
});
