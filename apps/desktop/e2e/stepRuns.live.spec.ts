import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { attachRepository, closeApp, homeEnv, launchApp } from "./support/app.js";
import { liveHome } from "./support/liveHome.js";
import { seedItem } from "./support/seed.js";

/**
 * An agent on a pipeline step, against the real backends, surviving
 * what happens around it — the way Claude Desktop's sessions survive a
 * quit and a crash.
 *
 * The unit tests hold the supervisor to scripted providers. This runs
 * the built app on the person's own Claude and Codex sign-ins and asks
 * the questions only a real backend can answer: does a session stopped
 * mid-turn actually resume, and does the agent carry on from it.
 *
 * - **Stop agents and close.** EO is closed while the implementer works,
 *   opened again, and resumed: the stopped run is carried on in its own
 *   thread, told why, as the same attempt.
 * - **A hard kill.** EO is killed outright mid-run and opened again:
 *   the run is found still marked running and carried on the same way.
 * - **A failing backend.** The implementer is pointed at a model that
 *   does not exist, so every run fails: the retry waits out its backoff
 *   rather than starting on the next tick.
 *
 * **Opt-in, because it spends real usage on a real account**, and it
 * needs the managed runtimes installed and both CLIs signed in:
 *
 *     pnpm --filter @eo/desktop exec electron-vite build
 *     EO_LIVE_STEPS=1 xvfb-run -a pnpm --filter @eo/desktop exec playwright test e2e/stepRuns.live.spec.ts
 */
const OPTED_IN = process.env["EO_LIVE_STEPS"] === "1";

test.describe.configure({ mode: "serial" });
test.skip(!OPTED_IN, "spends real usage: set EO_LIVE_STEPS=1 to run");
test.setTimeout(900_000);

type RunRow = {
  id: string;
  status: string;
  thread_id: string | null;
  attempt: number;
  initiation_id: string | null;
  interruption: string | null;
  started_at: number | null;
  ended_at: number | null;
  error: string | null;
};

/** Read straight out of the profile's database: the app writes it, the spec only looks. */
function runsOf(home: string, itemId: string): RunRow[] {
  const db = new Database(path.join(home, ".config/Electron/eo.db"), { readonly: true });
  try {
    return db
      .prepare("SELECT id, status, thread_id, attempt, initiation_id, interruption, started_at, ended_at, error FROM runs WHERE item_id = ? AND action = 'implement' ORDER BY started_at, id")
      .all(itemId) as RunRow[];
  } finally {
    db.close();
  }
}

function eventsOf(home: string, runId: string): { type: string; payload: string }[] {
  const db = new Database(path.join(home, ".config/Electron/eo.db"), { readonly: true });
  try {
    return db.prepare("SELECT type, payload FROM run_events WHERE run_id = ? ORDER BY seq").all(runId) as { type: string; payload: string }[];
  } finally {
    db.close();
  }
}

/** Guardrails saved as the Guardrails screen would save them: merged over the defaults when they are read. */
function setGuards(home: string, guards: Record<string, unknown>): void {
  const db = new Database(path.join(home, ".config/Electron/eo.db"));
  try {
    const value = JSON.stringify(guards);
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('engine.guards', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value, Date.now());
  } finally {
    db.close();
  }
}

/** Every prompt EO hands a backend is kept on the run's log (debug mode), which is how the spec reads what a continuation was told. */
function captureWhatIsSent(home: string): void {
  const db = new Database(path.join(home, ".config/Electron/eo.db"));
  try {
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('engine.debugMode', 'true', ?) ON CONFLICT(key) DO UPDATE SET value = 'true'").run(Date.now());
  } finally {
    db.close();
  }
}

function launch(home: string): Promise<{ app: ElectronApplication; window: Page }> {
  return launchApp(homeEnv(home));
}

async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  const answer = (await page.evaluate(([name, body]) => window.eo.ipc.invoke(name as never, body as never), [channel, payload] as const)) as { ok: boolean; data?: T; error?: { message: string } };
  if (!answer.ok) throw new Error(`${channel}: ${answer.error?.message ?? "refused"}`);
  return answer.data as T;
}

/** The implementer, put on a backend — and on an executable of the spec's own, where it wants one that crashes. */
async function implementerOn(page: Page, provider: "claude" | "codex", executablePath: string | null = null): Promise<void> {
  // The detailed list, because saving takes the instructions and the config back and the summary has neither.
  const { agents } = await invoke<{ agents: { id: string; name: string; role: string; instructions: string; enabled: boolean; config: Record<string, unknown> }[] }>(page, "agents:listDetailed");
  const implementer = agents.find((agent) => agent.role === "implementer");
  if (!implementer) throw new Error("the scratch profile has no implementer");
  await invoke(page, "agents:save", {
    id: implementer.id,
    name: implementer.name,
    role: "implementer",
    provider,
    model: null,
    instructions: implementer.instructions,
    enabled: true,
    // Sent whole, because this channel replaces the config it is given.
    config: executablePath ? { ...implementer.config, executablePath } : implementer.config,
  });
}

/** Where the managed runtime keeps each backend's executable, in the person's own install. */
const REAL_EXECUTABLES = {
  claude: path.join(homedir(), ".config/EO/runtimes/claude@0.3.312/claude"),
  codex: path.join(homedir(), ".config/EO/runtimes/codex@0.165.0-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"),
} as const;

/**
 * The backend, crashing whenever it is asked to take a turn.
 *
 * Every other invocation — a version check, a sign-in probe — reaches the
 * real executable, so what fails is the run and nothing before it: a
 * Claude turn is the one that streams JSON, a Codex turn the one that
 * starts the app server. What a person sees when a backend falls over
 * mid-work, which is what the retry's wait is for.
 */
function crashingOnEveryTurn(scratch: string, provider: "claude" | "codex"): string {
  return wrappedBackend(scratch, provider, "crashes", 'echo "eo live spec: the backend fell over" >&2; exit 1');
}

/** The backend, never answering once it is asked to take a turn — a hang, as an inactivity guard sees one. */
function hangingOnEveryTurn(scratch: string, provider: "claude" | "codex"): string {
  return wrappedBackend(scratch, provider, "hangs", "exec sleep 3600");
}

/**
 * The backend, compacting its conversation early: once the context holds
 * a few tens of thousands of tokens rather than near the model's limit,
 * so a step that reads one large file is compacted part-way through.
 */
function compactingEarly(scratch: string, provider: "claude" | "codex"): string {
  const wrapper = path.join(scratch, `${provider}-that-compacts-early`);
  const real = REAL_EXECUTABLES[provider];
  writeFileSync(
    wrapper,
    provider === "claude"
      ? ["#!/bin/sh", "export CLAUDE_CODE_AUTO_COMPACT_WINDOW=60000", "export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50", `exec "${real}" "$@"`, ""].join("\n")
      : ["#!/bin/sh", 'case " $* " in *" app-server "*)', // After EO's own options, which follow the subcommand and would
      // otherwise replace one given before it.
      `  exec "${real}" "$@" -c model_auto_compact_token_limit=10000;;`, "esac", `exec "${real}" "$@"`, ""].join("\n"),
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function wrappedBackend(scratch: string, provider: "claude" | "codex", what: string, onTurn: string): string {
  const wrapper = path.join(scratch, `${provider}-that-${what}`);
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      'for argument in "$@"; do',
      `  case "$argument" in stream-json|app-server) ${onTurn};; esac`,
      "done",
      `exec "${REAL_EXECUTABLES[provider]}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function repository(scratch: string): string {
  const repoPath = path.join(scratch, "the repo");
  mkdirSync(repoPath, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "eo@example.com");
  git("config", "user.name", "EO E2E");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  return repoPath;
}

/** A piece of work long enough to be interrupted in the middle of, short enough not to cost much. */
const WORK = {
  title: "Add NOTES.md listing five fruits, one per line, then commit it",
  acceptanceCriteria: ["NOTES.md exists at the repository root, lists five fruits one per line, and is committed on the branch."],
};

/** Waits until the implementer is under way: running, with a session, and past its first few steps. */
async function underWay(home: string, itemId: string): Promise<RunRow> {
  let run: RunRow | undefined;
  await expect
    .poll(
      () => {
        run = runsOf(home, itemId).find((row) => row.status === "running" && row.thread_id !== null);
        return run ? eventsOf(home, run.id).filter((event) => event.type !== "debug_sent").length : 0;
      },
      { timeout: 300_000, intervals: [1_000] },
    )
    .toBeGreaterThanOrEqual(3);
  return run!;
}

/** The run that carried `stopped` on, once it has finished. */
async function carriedOn(home: string, itemId: string, stopped: RunRow): Promise<RunRow> {
  let continuation: RunRow | undefined;
  await expect
    .poll(
      () => {
        continuation = runsOf(home, itemId).find((row) => row.id !== stopped.id && row.thread_id === stopped.thread_id && row.interruption === null);
        return continuation?.status ?? "none";
      },
      { timeout: 480_000, intervals: [2_000] },
    )
    .toMatch(/^(succeeded|failed|awaiting_input)$/);
  return continuation!;
}

function toldWhy(home: string, runId: string): string {
  return eventsOf(home, runId)
    .filter((event) => event.type === "debug_sent")
    .map((event) => event.payload)
    .join("\n");
}

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: a step stopped by closing EO carries on in its own thread when EO is resumed`, async () => {
    const { scratch, home } = liveHome(`live steps ${provider}`, provider);
    const repoPath = repository(scratch);
    let app: ElectronApplication | null = null;
    try {
      ({ app } = await launch(home));
      const window = await app.firstWindow();
      await attachRepository(window, repoPath);
      await implementerOn(window, provider);
      captureWhatIsSent(home);
      const item = seedItem(home, { ...WORK, stepId: "todo", branch: `eo/live-stop-${provider}` });
      await window.reload();

      const before = await underWay(home, item.id);

      // "Stop agents and close": index 2 of the close dialog's buttons.
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = (async () => ({ response: 2, checkboxChecked: false })) as typeof dialog.showMessageBox;
      });
      const closing = app.process();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
      await expect.poll(() => closing.exitCode, { timeout: 30_000 }).not.toBeNull();
      app = null;

      const stopped = runsOf(home, item.id).find((row) => row.id === before.id)!;
      expect(stopped).toMatchObject({ status: "cancelled", interruption: "quit", thread_id: before.thread_id });

      // Opened again: paused, as a forced close leaves it, until resumed.
      ({ app } = await launch(home));
      const reopened = await app.firstWindow();
      await invoke(reopened, "engine:resume");

      const continuation = await carriedOn(home, item.id, stopped);
      console.log(`[${provider}] stopped ${stopped.id} on ${stopped.thread_id}; carried on as ${continuation.id}: ${continuation.status}${continuation.error ? ` (${continuation.error.slice(0, 160)})` : ""}`);
      // The same piece of work: same thread, same initiation, same attempt.
      expect(continuation.thread_id).toBe(stopped.thread_id);
      expect(continuation.initiation_id).toBe(stopped.initiation_id);
      expect(continuation.attempt).toBe(stopped.attempt);
      // Told why, and it went on working from there.
      expect(toldWhy(home, continuation.id)).toContain("EO was closed while you were working");
      expect(eventsOf(home, continuation.id).filter((event) => event.type !== "debug_sent").length).toBeGreaterThan(0);
    } finally {
      if (app) await closeApp(app);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(`${provider}: a step EO was killed under carries on in its own thread on the next launch`, async () => {
    const { scratch, home } = liveHome(`live kill ${provider}`, provider);
    const repoPath = repository(scratch);
    let app: ElectronApplication | null = null;
    try {
      ({ app } = await launch(home));
      const window = await app.firstWindow();
      await attachRepository(window, repoPath);
      await implementerOn(window, provider);
      captureWhatIsSent(home);
      const item = seedItem(home, { ...WORK, stepId: "todo", branch: `eo/live-kill-${provider}` });
      await window.reload();

      const before = await underWay(home, item.id);

      // Killed outright: nothing of EO's runs on the way out.
      const killed = app.process();
      killed.kill("SIGKILL");
      await expect.poll(() => killed.exitCode !== null || killed.signalCode !== null, { timeout: 30_000 }).toBe(true);
      app = null;
      expect(runsOf(home, item.id).find((row) => row.id === before.id)).toMatchObject({ status: "running", thread_id: before.thread_id });

      ({ app } = await launch(home));
      const stale = runsOf(home, item.id).find((row) => row.id === before.id)!;
      const continuation = await carriedOn(home, item.id, { ...stale, interruption: "restart" });
      console.log(`[${provider}] killed under ${before.id}; carried on as ${continuation.id}: ${continuation.status}${continuation.error ? ` (${continuation.error.slice(0, 160)})` : ""}`);
      expect(runsOf(home, item.id).find((row) => row.id === before.id)).toMatchObject({ status: "cancelled", interruption: "restart" });
      expect(continuation.thread_id).toBe(before.thread_id);
      expect(continuation.attempt).toBe(before.attempt);
      expect(toldWhy(home, continuation.id)).toContain("EO restarted after an interruption");
      expect(eventsOf(home, continuation.id).filter((event) => event.type !== "debug_sent").length).toBeGreaterThan(0);
    } finally {
      if (app) await closeApp(app);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(`${provider}: a step whose runs keep failing waits before each retry`, async () => {
    const { scratch, home } = liveHome(`live backoff ${provider}`, provider);
    const repoPath = repository(scratch);
    let app: ElectronApplication | null = null;
    try {
      ({ app } = await launch(home));
      const window = await app.firstWindow();
      await attachRepository(window, repoPath);
      // A backend that falls over on every turn: every run fails, and fails fast.
      await implementerOn(window, provider, crashingOnEveryTurn(scratch, provider));
      const item = seedItem(home, { ...WORK, stepId: "todo", branch: `eo/live-backoff-${provider}` });
      await window.reload();

      await expect.poll(() => runsOf(home, item.id).filter((row) => row.ended_at !== null).length, { timeout: 180_000, intervals: [1_000] }).toBeGreaterThanOrEqual(1);
      const first = runsOf(home, item.id)[0]!;
      console.log(`[${provider}] first run ${first.status}: ${(first.error ?? "").slice(0, 200)}`);
      expect(first.status).toBe("failed");

      await expect.poll(() => runsOf(home, item.id).length, { timeout: 120_000, intervals: [1_000] }).toBeGreaterThanOrEqual(2);
      const second = runsOf(home, item.id)[1]!;
      const waited = second.started_at! - first.ended_at!;
      console.log(`[${provider}] the retry started ${Math.round(waited / 1000)}s after the failure`);
      expect(waited).toBeGreaterThanOrEqual(30_000);
      expect(second.attempt).toBe(2);
    } finally {
      if (app) await closeApp(app);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(`${provider}: a backend that stops answering is stopped after the silence limit, and says so`, async () => {
    const { scratch, home } = liveHome(`live hang ${provider}`, provider);
    const repoPath = repository(scratch);
    let app: ElectronApplication | null = null;
    try {
      ({ app } = await launch(home));
      const window = await app.firstWindow();
      await attachRepository(window, repoPath);
      setGuards(home, { inactivityTimeoutMs: 60_000 });
      await implementerOn(window, provider, hangingOnEveryTurn(scratch, provider));
      const item = seedItem(home, { ...WORK, stepId: "todo", branch: `eo/live-hang-${provider}` });
      await window.reload();

      await expect.poll(() => runsOf(home, item.id).find((row) => row.status !== "running")?.status ?? "running", { timeout: 240_000, intervals: [2_000] }).not.toBe("running");
      const stopped = runsOf(home, item.id)[0]!;
      console.log(`[${provider}] hung backend's run: ${stopped.status}: ${(stopped.error ?? "").slice(0, 300)}`);
      expect(stopped.status).toBe("awaiting_input");
      const took = stopped.ended_at! - stopped.started_at!;
      console.log(`[${provider}] a hung backend was stopped after ${Math.round(took / 1000)}s: ${(stopped.error ?? "").slice(0, 200)}`);
      expect(stopped.error).toContain("No word from");
      // The limit and at most one watchdog pass past it, not the wall clock's two hours.
      expect(took).toBeLessThan(180_000);
    } finally {
      if (app) await closeApp(app);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(`${provider}: a quiet tool that runs longer than the silence limit is not taken for a hang`, async () => {
    const { scratch, home } = liveHome(`live quiet tool ${provider}`, provider);
    const repoPath = repository(scratch);
    let app: ElectronApplication | null = null;
    try {
      ({ app } = await launch(home));
      const window = await app.firstWindow();
      await attachRepository(window, repoPath);
      setGuards(home, { inactivityTimeoutMs: 60_000 });
      await implementerOn(window, provider);
      const item = seedItem(home, {
        // Not `sleep`: Claude Code refuses a long foreground sleep and runs
        // it in the background, which would leave no quiet tool to test.
        title: "Run `python3 -c 'import time; time.sleep(100); print(42)'` in the foreground and wait for it, then add NOTES.md listing three fruits and commit it",
        acceptanceCriteria: [
          "The command `python3 -c 'import time; time.sleep(100); print(42)'` was run in the foreground, to completion, first.",
          "NOTES.md exists at the repository root, lists three fruits, and is committed on the branch.",
        ],
        stepId: "todo",
        branch: `eo/live-quiet-${provider}`,
      });
      await window.reload();

      await expect.poll(() => runsOf(home, item.id).find((row) => row.status !== "running")?.status ?? "running", { timeout: 600_000, intervals: [3_000] }).not.toBe("running");
      const run = runsOf(home, item.id)[0]!;
      const slept = eventsOf(home, run.id).some((event) => event.type === "tool_call" && event.payload.includes("time.sleep(100)"));
      for (const event of eventsOf(home, run.id).filter((one) => one.type === "tool_call" || one.type === "tool_result")) console.log(`[${provider}]   ${event.type}: ${event.payload.slice(0, 220)}`);
      console.log(`[${provider}] quiet tool run: ${run.status} after ${Math.round((run.ended_at! - run.started_at!) / 1000)}s; ran the long command: ${slept}${run.error ? ` (${run.error.slice(0, 160)})` : ""}`);
      expect(slept).toBe(true);
      expect(run.error ?? "").not.toContain("No word from");
      expect(run.status).not.toBe("awaiting_input");
      // The tool really ran longer than the silence limit: otherwise this
      // proves nothing about a quiet tool.
      expect(run.ended_at! - run.started_at!).toBeGreaterThan(100_000);
    } finally {
      if (app) await closeApp(app);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(`${provider}: a step whose conversation is compacted is told what it is working on again, and carries on`, async () => {
    const { scratch, home } = liveHome(`live compaction ${provider}`, provider);
    const repoPath = repository(scratch);
    // Large enough that reading it pushes the conversation past the early limit.
    const paragraph = "The quick brown fox jumps over the lazy dog while the archivist catalogues every ledger in the eastern wing. ";
    writeFileSync(path.join(repoPath, "BIG.md"), Array.from({ length: 900 }, (_, line) => `${line + 1}. ${paragraph}`).join("\n"));
    execFileSync("git", ["add", "-A"], { cwd: repoPath });
    execFileSync("git", ["commit", "-m", "a large file"], { cwd: repoPath });
    let app: ElectronApplication | null = null;
    try {
      ({ app } = await launch(home));
      const window = await app.firstWindow();
      await attachRepository(window, repoPath);
      await implementerOn(window, provider, compactingEarly(scratch, provider));
      const item = seedItem(home, {
        title: "Read BIG.md in full, then add NOTES.md saying in one sentence what it is about, and commit it",
        acceptanceCriteria: ["BIG.md was read in full.", "NOTES.md exists at the repository root, says in one sentence what BIG.md is about, and is committed on the branch."],
        stepId: "todo",
        branch: `eo/live-compaction-${provider}`,
      });
      await window.reload();

      await expect
        .poll(() => runsOf(home, item.id).find((row) => row.status !== "running")?.status ?? "running", { timeout: 360_000, intervals: [3_000] })
        .not.toBe("running")
        .catch((error: unknown) => {
          const seen = runsOf(home, item.id).flatMap((run) => eventsOf(home, run.id).map((event) => event.type));
          console.log(`[${provider}] still running; events so far:`, JSON.stringify(seen.slice(-40)), `compacted ${seen.filter((type) => type === "compacted").length}x`);
          throw error;
        });
      const runs = runsOf(home, item.id);
      const types = runs.flatMap((run) => eventsOf(home, run.id).map((event) => event.type));
      const last = runs.at(-1)!;
      console.log(`[${provider}] compaction run: ${last.status}; compacted ${types.filter((type) => type === "compacted").length}x, reminded ${types.filter((type) => type === "reminder").length}x${last.error ? ` (${last.error.slice(0, 160)})` : ""}`);
      if (!types.includes("compacted")) {
        const db = new Database(path.join(home, ".config/Electron/eo.db"), { readonly: true });
        console.log(`[${provider}] tokens:`, JSON.stringify(db.prepare("SELECT tokens_in, turns, status FROM runs WHERE item_id = ?").all(item.id)));
        db.close();
        for (const event of runs.flatMap((run) => eventsOf(home, run.id)).filter((one) => one.type === "tool_call")) console.log(`[${provider}]   ${event.payload.slice(0, 200)}`);
      }
      expect(types).toContain("compacted");
      expect(types).toContain("reminder");
      expect(types.indexOf("reminder")).toBeGreaterThan(types.indexOf("compacted"));
      // Got through to the agent at least once — not only written down.
      const reminders = runs.flatMap((run) => eventsOf(home, run.id).filter((event) => event.type === "reminder"));
      console.log(`[${provider}] reminders delivered: ${reminders.filter((event) => event.payload.includes('"delivered":true')).length} of ${reminders.length}`);
      expect(reminders.some((event) => event.payload.includes('"delivered":true'))).toBe(true);
      expect(last.status).toBe("succeeded");
    } finally {
      if (app) await closeApp(app);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(`${provider}: a step's transcript shows the agent's words as it writes them`, async () => {
    const { scratch, home } = liveHome(`live words ${provider}`, provider);
    const repoPath = repository(scratch);
    let app: ElectronApplication | null = null;
    try {
      ({ app } = await launch(home));
      const window = await app.firstWindow();
      await attachRepository(window, repoPath);
      await implementerOn(window, provider);
      const item = seedItem(home, {
        title: "Before doing anything, explain in four or five sentences what you plan to do and why; then add NOTES.md listing three fruits and commit it",
        acceptanceCriteria: ["NOTES.md exists at the repository root, lists three fruits, and is committed on the branch."],
        stepId: "todo",
        branch: `eo/live-words-${provider}`,
      });
      await window.evaluate((id) => {
        window.location.hash = `#/items/${id}/runs`;
      }, item.id);
      await window.reload();
      await window.waitForLoadState("domcontentloaded");

      // Sampled while it grows, and counted one block at a time: a sample
      // belongs to the block before it when it carries on that block's
      // text. Counted across blocks, three blocks each appearing whole
      // would read as three steps of growth; within one, a block that
      // appears whole is a single length, so three means it was seen
      // twice before it was finished. Claude's stream reaches EO in
      // bursts of a dozen deltas or so, half a second apart (the API
      // sends them that way — the CLI and EO pass each on within a
      // millisecond), so a paragraph is seen three to five times.
      const live = window.getByRole("article", { name: "Live agent output" });
      await expect(live).toBeVisible({ timeout: 240_000 });
      const blocks: number[][] = [];
      let previous: string | null = null;
      const started = Date.now();
      while (Date.now() - started < 120_000 && !blocks.some((lengths) => lengths.length > 2)) {
        const text = await live.textContent({ timeout: 500 }).catch(() => null);
        if (text !== null && text !== "") {
          const current = blocks.at(-1);
          if (current && previous !== null && text.startsWith(previous)) {
            if (text.length > previous.length) current.push(text.length);
          } else {
            blocks.push([text.length]);
          }
        }
        previous = text;
        await window.waitForTimeout(100);
      }
      const longest = blocks.reduce<number[]>((best, lengths) => (lengths.length > best.length ? lengths : best), []);
      console.log(`[${provider}] the best-watched block of a step's live words grew through ${longest.length} lengths (${longest.join(",")}) across ${blocks.length} blocks`);
      expect(longest.length).toBeGreaterThan(2);
    } finally {
      if (app) await closeApp(app);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(`${provider}: a step is stopped at its budget part-way through a turn, not after it`, async () => {
    const { scratch, home } = liveHome(`live budget ${provider}`, provider);
    const repoPath = repository(scratch);
    let app: ElectronApplication | null = null;
    try {
      ({ app } = await launch(home));
      const window = await app.firstWindow();
      await attachRepository(window, repoPath);
      // One cent: a turn of real work passes it within its first few model calls.
      setGuards(home, { perItemBudgetCents: 1 });
      await implementerOn(window, provider);
      const item = seedItem(home, { ...WORK, stepId: "todo", branch: `eo/live-budget-${provider}` });
      await window.reload();

      await expect.poll(() => runsOf(home, item.id).find((row) => row.status !== "running")?.status ?? "running", { timeout: 300_000, intervals: [2_000] }).not.toBe("running");
      const run = runsOf(home, item.id)[0]!;
      const db = new Database(path.join(home, ".config/Electron/eo.db"), { readonly: true });
      const { cost_cents: cost } = db.prepare("SELECT cost_cents FROM runs WHERE id = ?").get(run.id) as { cost_cents: number | null };
      db.close();
      const answered = eventsOf(home, run.id).some((event) => event.type === "result");
      console.log(`[${provider}] budget run: ${run.status}, ${cost ?? "?"}¢ spent, answered: ${answered}: ${(run.error ?? "").slice(0, 160)}`);
      expect(run.status).toBe("awaiting_input");
      expect(run.error).toContain("budget");
      // Stopped before the turn could finish its work and answer.
      expect(answered).toBe(false);
    } finally {
      if (app) await closeApp(app);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
