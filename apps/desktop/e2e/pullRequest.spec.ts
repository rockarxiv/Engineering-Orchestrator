import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { seedItem } from "./support/seed.js";
import { attachRepository, closeApp, homeEnv, launchApp } from "./support/app.js";
import { itemCard, openView } from "./support/board.js";
import { openPipeline } from "./support/rail.js";

/**
 * EO opens the pull request (F-06).
 *
 * The gate for this story, and it needs no network: a real repository
 * with a real **bare** repository as its remote, so `git push` is a
 * genuine push, and a fake `gh` on PATH that records every argument it
 * was given and answers the way the real one would.
 *
 * What the unit tests cannot show is that the whole thing is wired
 * together in the shipped process — the engine dispatches the step, the
 * CLI is spawned inside its run, and the url comes back to the item.
 */
const git = (args: string[], cwd: string): string => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A `gh` that writes down what it was asked and prints what the real one prints. */
function fakeGh(binDir: string, logPath: string): void {
  mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");

if (args[0] === "pr" && args[1] === "list") {
  // Nothing open until create has run — which is what makes the
  // read-back after create meaningful.
  const already = fs.readFileSync(${JSON.stringify(logPath)}, "utf8").includes('"create"');
  process.stdout.write(already ? JSON.stringify([{ url: "https://github.com/acme/api/pull/7", state: "OPEN" }]) : "[]");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const index = args.indexOf("--body-file");
  if (index >= 0) fs.copyFileSync(args[index + 1], ${JSON.stringify(logPath)} + ".body");
  process.stdout.write("https://github.com/acme/api/pull/7");
  process.exit(0);
}
process.stdout.write("");
`;
  const file = path.join(binDir, "gh");
  writeFileSync(file, script);
  chmodSync(file, 0o755);
}

/**
 * Why `gh` was never called, read out of the app's own database.
 *
 * The `runs` row is the whole answer now (EO-77). The pull request used
 * to be queued on the outbox, so "no `gh`" could mean a send sitting out
 * a thirty-second backoff, a drain loop that never ticked, or a push
 * dropped as unretryable — three states that looked identical from
 * outside and lived in a table nothing on screen showed. Opening it
 * inside the step's own run collapses all of that into a status and an
 * error on one row: `running` means it is still going, `failed` or
 * `awaiting_input` carries the reason the forge gave, and no row at all
 * means the step was never dispatched, which is the engine rather than
 * the forge.
 */
function whyNoPullRequest(home: string, mainLog: string[]): string {
  const db = new Database(path.join(home, ".config/Electron/eo.db"), { readonly: true });
  try {
    const runs = db.prepare("SELECT action, status, error, started_at, ended_at FROM runs ORDER BY started_at").all() as {
      action: string;
      status: string;
      error: string | null;
    }[];
    const comments = db.prepare("SELECT author_type, kind, body FROM comments ORDER BY created_at").all();
    // The branch and the pull request are an `item_extensions` row since
    // KAN-169, not columns — and this runs only when something has
    // already gone wrong, so a query naming a dropped column would
    // replace the diagnosis with an SQLite error.
    const item = db
      .prepare(
        `SELECT i.key, i.step_id, json_extract(g.data, '$.branch') AS branch, json_extract(g.data, '$.pullRequest') AS pr_url
           FROM items i
      LEFT JOIN item_extensions g ON g.item_id = i.id AND g.extension = 'git'`,
      )
      .all();

    const attempted =
      runs.length === 0
        ? "no run at all — the step was never dispatched, which is the engine rather than the forge"
        : runs.map((run) => `${run.action}: ${run.status}${run.error ? `, error: ${run.error}` : ""}`).join("\n");

    return [
      `runs:\n${attempted}`,
      `ticket: ${JSON.stringify(item)}`,
      `comments: ${JSON.stringify(comments, null, 2)}`,
      `main process:\n${mainLog.join("")}`,
    ].join("\n\n");
  } finally {
    db.close();
  }
}

test("a story reaching ready_to_merge is pushed and opened as a pull request", async () => {
  // Skipped on Windows, and only there: the fake `gh` is a Node script on
  // PATH, and EO starts `gh` with `execFile` and no shell
  // (`forge/cli.ts`), which on Windows finds only an executable —
  // `gh.exe` — and never a script. The real `gh.exe` is what EO runs
  // there, and the unit tests hold the arguments it is given.
  test.skip(process.platform === "win32", "the fake gh is a script, and without a shell Windows starts only gh.exe");
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e pr "));
  const home = path.join(scratch, "home");
  const repoPath = path.join(scratch, "acme-api");
  const remotePath = path.join(scratch, "remote.git");
  const binDir = path.join(scratch, "bin");
  const ghLog = path.join(scratch, "gh.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(ghLog, "");
  fakeGh(binDir, ghLog);

  execFileSync("git", ["init", "--bare", remotePath], { encoding: "utf8" });
  git(["init", "-b", "main"], repoPath);
  git(["config", "user.email", "eo@example.com"], repoPath);
  git(["config", "user.name", "EO E2E"], repoPath);
  git(["config", "commit.gpgsign", "false"], repoPath);
  writeFileSync(path.join(repoPath, "README.md"), "# acme-api\n");
  // A template, so the body is proved to carry the repository's own headings.
  mkdirSync(path.join(repoPath, ".github"), { recursive: true });
  writeFileSync(path.join(repoPath, ".github/pull_request_template.md"), "## Why is this needed?\n\n## How was it checked?\n");
  git(["add", "-A"], repoPath);
  git(["commit", "-m", "initial"], repoPath);
  git(["remote", "add", "origin", remotePath], repoPath);
  git(["push", "-u", "origin", "main"], repoPath);

  // Exactly what a finished dispatch leaves behind: a branch with work on it.
  git(["checkout", "-b", "eo/API-1"], repoPath);
  writeFileSync(path.join(repoPath, "outbox.ts"), "export const queued = true;\n");
  git(["add", "-A"], repoPath);
  git(["commit", "-m", "add the outbox"], repoPath);
  git(["checkout", "main"], repoPath);

  const mainLog: string[] = [];
  // No login shell (EO-655). EO puts the shell's PATH ahead of the one it
  // inherited, and on a macOS runner `/etc/zprofile`'s path_helper puts
  // the real `gh` in /usr/local/bin ahead of this fake — so with $SHELL
  // set, EO would run the runner's `gh` and not the one under test.
  const { app, window } = await launchApp(homeEnv(home, { PATH: `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`, SHELL: "" }));

  app.process().stdout?.on("data", (chunk: Buffer) => mainLog.push(`[out] ${chunk.toString()}`));
  app.process().stderr?.on("data", (chunk: Buffer) => mainLog.push(`[err] ${chunk.toString()}`));

  try {
    const call = (channel: string, payload: unknown) =>
      window.evaluate(([c, p]) => window.eo.ipc.invoke(c as never, p as never), [channel, payload] as [string, unknown]);

    // First run creates the repository.
    await attachRepository(window, repoPath);
    await expect(window.getByRole("button", { name: "Switch project" })).toContainText("acme-api", { timeout: 10_000 });

    // Turn it on, the way the Settings panel does. The id comes from
    // the repository list itself: `repositories:list` stopped reporting an
    // active repository when projects became their own thing (KAN-17), and
    // reading the field that no longer exists sent `id: undefined` into
    // the update, which failed quietly and left the forge switched off.
    const repositories = (await call("repositories:list", undefined)) as { data: { repositories: { id: string }[] } };
    const repositoryId = repositories.data.repositories[0]!.id;
    const updated = (await call("repositories:update", { id: repositoryId, forgeOpenPr: true, forgeKind: "github" })) as {
      data: { ok: boolean };
    };
    expect(updated.data.ok, "the forge could not be switched on").toBe(true);

    // Seeded, with the branch a dispatch would have recorded. There is no
    // "create an item" door any more — work arrives from the assistant or from
    // Jira — and no channel sets a branch, which is the same reason
    // worktrees.spec.ts makes its checkout with git rather than through
    // the app. Everything after this is the real path.
    const created = seedItem(home, { title: "Outbox table and enqueue", branch: "eo/API-1" });

    // Move it onto the step that opens the pull request. That used to be
    // a flag on arriving at the terminal step; it is a `builtin` step now
    // (ARCHITECTURE.md, "A step"), so the engine dispatches it like any other work — and since
    // EO-77 the function opens the pull request inside that run rather
    // than queueing it for a timer to send later.
    await call("items:move", { itemId: created.id, toStepId: "merge_request", cancelActiveRun: true, comment: "" });

    // The engine's own dispatch tick does the work.
    //
    // Twenty seconds is not a guess at how slow a loaded machine gets:
    // the tick is five seconds and the send is a push to a local bare
    // repository plus two spawns, so a healthy run calls `gh` within one
    // tick of the move. What the limit separates is a run that worked
    // from one that did not — a retryable failure is retried twice within
    // seven seconds and then reported, so a longer wait would not catch a
    // slower forge, only a failure nobody looked at. `whyNoPullRequest`
    // reads that failure off the run instead.
    try {
      await expect
        .poll(async () => readFileSync(ghLog, "utf8"), { timeout: 20_000, message: "gh was never called" })
        .toContain("create");
    } catch (error) {
      throw new Error(`${(error as Error).message}\n\n${whyNoPullRequest(home, mainLog)}`);
    }

    const calls = readFileSync(ghLog, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string[]);

    // It looked before it created, so a retry cannot open a second one.
    expect(calls[0]).toEqual(["pr", "list", "--head", "eo/API-1", "--state", "all", "--json", "url,state", "--limit", "1"]);
    const create = calls.find((args) => args[1] === "create")!;
    expect(create[create.indexOf("--head") + 1]).toBe("eo/API-1");
    expect(create[create.indexOf("--base") + 1]).toBe("main");

    // The body carries the repository's template and EO's own facts.
    const body = readFileSync(`${ghLog}.body`, "utf8");
    expect(body).toContain("## Why is this needed?");
    expect(body).toContain("<!-- eo:facts -->");
    expect(body).toContain("`eo/API-1` → `main`");

    // The branch really reached the remote.
    expect(execFileSync("git", ["branch", "--list", "eo/API-1"], { cwd: remotePath, encoding: "utf8" })).toContain("eo/API-1");

    // And the url came back to the item, and is on screen — opened
    // from its card on the board, the way a person would look for it.
    await openPipeline(window, "Delivery");
    await itemCard(window, "Outbox table and enqueue").click();
    await expect(openView(window).getByRole("link", { name: "pull request" })).toHaveAttribute("href", "https://github.com/acme/api/pull/7", {
      timeout: 15_000,
    });
  } finally {
    await closeApp(app);
    // Two git repositories and a database — ~7MB a run, and nothing
    // reads it afterwards. The failure path has already lifted what it
    // needs out of the database and into the error.
    rmSync(scratch, { recursive: true, force: true });
  }
});
