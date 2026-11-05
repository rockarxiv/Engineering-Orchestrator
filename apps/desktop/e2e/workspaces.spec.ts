import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";
import { seedItem } from "./support/seed.js";
import { itemCard, openView } from "./support/board.js";
import { openPipeline, openPlace } from "./support/rail.js";
import { attachRepository, closeApp, homeEnv, launchApp } from "./support/app.js";

/**
 * A folder workspace, attached and assigned to a step (EO-301,
 * ARCHITECTURE.md, "A workspace is a kind, attached to the project").
 *
 * Unit tests drive `workspaceFor` and the folder kind's `prepare`
 * directly; what they cannot show is that the screen this story builds
 * is wired to them. The claim being driven here runs the whole length of
 * the app: a person attaches a directory in Settings → Workspaces, one
 * pipeline step is pointed at it, and a run on that step happens **in
 * that directory** — while the ticket itself is on the repository, which
 * is where every ticket in a one-repository project is.
 *
 * That last part is the reason this is worth an end-to-end test rather
 * than a unit one. Until EO-301 the ticket's workspace was the only
 * answer to *where*, and every step of a pipeline shared it; the
 * assertion below is that the step's pick beat it, end to end, through
 * Settings and a dispatch.
 *
 * **Pointing the step is setup, not the subject** (EO-528). It was the
 * classic configure screen's step editor, which is gone with the pipeline
 * editor: a pipeline changes through the assistant now, and an assistant
 * turn is not something this suite can drive without a live backend. So
 * the step's pick is written the way `decide.spec.ts` writes its step —
 * straight into the row the editor's publish wrote — and what is under
 * test is still the screen that attaches the folder and the run that
 * honours the pick.
 *
 * **`runs.cwd` is the assertion, not the filesystem.** The folder kind
 * with no per-ticket subfolder does not create anything — a shared drive
 * is somebody else's directory and EO makes nothing under it — so there
 * is no new file on disk to look for. The column is where the cwd
 * `prepare` handed back is recorded, and it is what every later question
 * about that run reads.
 */
test("a folder workspace assigned to a step is where that step's runs happen", async () => {
  // Longer than the 30s default: this spec drives first run and
  // Settings before it waits on a dispatch, and the dispatch tick alone
  // is worth twenty seconds of that budget.
  test.setTimeout(120_000);

  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e workspaces "));
  const home = path.join(scratch, "home");
  mkdirSync(home, { recursive: true });

  // The repository, which is what the first run attaches and what the
  // seeded ticket will belong to.
  const repoPath = path.join(scratch, "the repo");
  mkdirSync(repoPath, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "eo@example.com");
  git("config", "user.name", "EO E2E");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(repoPath, "README.md"), "# the repo\n");
  git("add", "-A");
  git("commit", "-m", "initial");

  // The shared drive. It has to exist already: EO never creates one,
  // because a path that is not there is usually a typo and a folder made
  // to match one is a folder nobody will look in.
  const drive = path.join(scratch, "the reports drive");
  mkdirSync(drive, { recursive: true });

  const { app, window } = await launchApp(homeEnv(home));
  let reader: Database.Database | undefined;

  try {

    // First run attaches the repository, exactly as it always has.
    await attachRepository(window, repoPath);
    await expect(window.getByRole("button", { name: "Switch project" })).toContainText("the repo", { timeout: 10_000 });

    // Nothing dispatched while the workspace and the graph are being set
    // up — the run under test has to be the one that follows the change.
    await window.getByRole("button", { name: "Pause agent activity" }).click();

    // ── Attach the folder, in Settings → Workspaces ──────────────────
    const view = openView(window);
    await openPlace(window, "Settings");
    await view.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Workspaces" }).click();

    const workspaces = view.getByRole("region", { name: "Workspaces" });
    // The repository is already here, as a workspace of the git kind —
    // "the developer's existing repositories appear as git workspaces".
    await expect(workspaces.getByText("the repo", { exact: true })).toBeVisible({ timeout: 10_000 });

    await workspaces.getByRole("button", { name: "Add a workspace" }).click();
    const form = view.getByRole("region", { name: "Add workspace" });
    // The kind first, which is what decides what the form asks next.
    await form.getByLabel("Kind").selectOption("folder");
    // Typed rather than chosen: Playwright cannot answer a native
    // directory dialog, which is why the field is typeable at all.
    await form.getByLabel("Folder path").fill(drive);
    await form.getByRole("button", { name: "Save" }).click();

    // `.first()`: a folder is *named* by its path, because that is what a
    // person would call it anyway — so the row's label and its summary
    // are the same string and the match is two elements rather than one.
    await expect(workspaces.getByText(drive, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await expect(workspaces.getByText("Folder", { exact: true })).toBeVisible();

    // ── Point the Review step at it ─────────────────────────────────
    // Setup, for the reason at the top of this file: the row the step
    // editor's publish wrote, written here.
    pointStepAtFolder(home, "review", drive);

    // ── A ticket on that step, and the run it gets ──────────────────
    // `seedItem` puts it on the first workspace, which is the repository
    // — so the ticket and the step disagree, and the step is what must
    // win.
    const seeded = seedItem(home, { title: "The quarterly report", stepId: "review" });
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await openPipeline(window, "Delivery");
    await expect(itemCard(window, "The quarterly report")).toBeVisible({ timeout: 10_000 });

    await window.getByRole("button", { name: "Resume agent activity" }).click();

    // The whole claim, in one column: the run worked in the folder, not
    // in a worktree cut from the repository the ticket is on.
    reader = openReader(home);
    await expect
      .poll(() => cwdOfRun(reader!, seeded.id, "review"), { timeout: 30_000, message: "the review run's recorded working directory" })
      .toBe(drive);
  } finally {
    reader?.close();
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});

/**
 * Points one step of the seeded pipeline at the folder workspace whose
 * path is `folder` — `pipeline_steps.workspace_id`, the column the
 * classic step editor's "Works on" published to.
 *
 * Found by its path rather than taken as the only folder there is, so a
 * fixture that attached a second one would fail here, naming why, rather
 * than at the cwd assertion thirty seconds later.
 */
function pointStepAtFolder(home: string, stepId: string, folder: string): void {
  const db = new Database(path.join(home, ".config/Electron/eo.db"));
  try {
    const folders = (db.prepare("SELECT id, config FROM workspaces WHERE kind = 'folder'").all() as { id: string; config: string }[]).filter(
      (row) => (JSON.parse(row.config) as { path?: unknown }).path === folder,
    );
    if (folders.length !== 1) throw new Error(`pointStepAtFolder: expected one folder workspace at ${folder}, found ${folders.length}`);
    // The pipeline `seedItem` puts its item on, so the step and the item agree on which board they are.
    const changed = db
      .prepare("UPDATE pipeline_steps SET workspace_id = ? WHERE id = ? AND pipeline_id = (SELECT id FROM pipelines WHERE entry_step_id IS NOT NULL LIMIT 1)")
      .run(folders[0]!.id, stepId).changes;
    if (changed !== 1) throw new Error(`pointStepAtFolder: expected one "${stepId}" step, found ${changed}`);
  } finally {
    db.close();
  }
}

/**
 * One read-only connection, opened once and reused by every poll.
 *
 * Reopening the file on each attempt is the obvious way to write this
 * and the wrong one: the app is writing to that database throughout, and
 * an open that loses the race throws rather than answering — which
 * `expect.poll` reports as the last value it *could* compute, so a
 * genuine failure comes back as "Received: null" naming a moment before
 * anything had started. One connection, opened after the app has
 * certainly created the file, has no such race.
 */
function openReader(home: string): Database.Database {
  return new Database(path.join(home, ".config/Electron/eo.db"), { readonly: true });
}

/**
 * Where the run of one *action* on this ticket worked, as the app
 * recorded it. Null until that run has started.
 *
 * By action rather than "the latest run", and the difference is a test
 * that passes for the right reason rather than by being quick. Approving
 * routes the ticket onward, and the step it lands on opens a pull
 * request — a builtin, which records no cwd of its own — about four
 * seconds later. A query for the most recent run therefore answers
 * `null` from then on, so the assertion held only while it was sampled
 * before that happened, and would have started failing the first time a
 * loaded CI machine was a few seconds slower.
 *
 * The claim is about *that step's* runs in any case, which is what
 * naming the action says.
 */
function cwdOfRun(db: Database.Database, itemId: string, action: string): string | null {
  const row = db.prepare("SELECT cwd FROM runs WHERE item_id = ? AND action = ? ORDER BY started_at DESC LIMIT 1").get(itemId, action) as
    | { cwd: string | null }
    | undefined;
  return row?.cwd ?? null;
}
