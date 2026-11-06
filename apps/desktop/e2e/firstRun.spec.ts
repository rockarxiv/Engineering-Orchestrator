import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";
import { closeApp, homeEnv, launchApp } from "./support/app.js";
import { openView } from "./support/board.js";
import { openPlace } from "./support/rail.js";
import { RUNTIMES, versionFor } from "../src/main/runtimes/catalog.js";

// The pinned Claude build, read off the catalog the main process reads —
// `runtimes.spec.ts` explains at length why this is not a literal.
const CLAUDE_VERSION = versionFor(RUNTIMES.claude, process.platform, process.arch)!;

/**
 * First run, in the order the design settled (EO-317,
 * the original design).
 *
 * "Mode, then gallery, then optional Preview with no sign-in, then the
 * template's own blanks as a short form, then the needs check with a
 * 'why' line per red item and 'Continue with Preview only', then the
 * first real item."
 *
 * Unit tests drive each of those screens; what only a real launch can
 * show is that they are one gesture — that the mode question comes
 * before anything else, that Preview runs an item under the fake
 * provider with no sign-in anywhere, that submitting the blanks writes a
 * project, that a red line's button turns that line green **in place**
 * against a real database and a real disk, and that pressing the last
 * button on the last screen files real work and the engine picks it up.
 *
 * Two things have to be arranged for that last part, and both are about
 * a hosted runner rather than about the product: nobody is signed in to
 * a coding agent on one (`seedSignedInClaude`), and nothing on one can
 * run a real turn (`runOnTheFakeProvider`). Each is written down where
 * it is done.
 *
 * This is also the spec that drives the flow as a person does. Every
 * other spec in this directory reaches past it — `attachRepository` —
 * because their subjects are elsewhere and a screen's wording is not
 * something twelve unrelated specs should be coupled to.
 */

/** A launch of its own, for the reason `app.spec.ts` writes down at length. */
function scratch(name: string) {
  const root = mkdtempSync(path.join(tmpdir(), `eo e2e ${name} `));
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true });
  return {
    root,
    home,
    env: homeEnv(home),
    cleanUp: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * A machine that is signed in to Claude, as far as EO can tell.
 *
 * "A coding agent signed in" is a real line of the needs check and it is
 * read the way EO reads it anywhere: resolve the managed CLI, run its
 * auth probe, believe what it prints. No hosted runner has a Claude
 * subscription, so the probe is what this fixture answers — a script at
 * the path the main process computes for itself, printing what
 * `claude auth status --json` prints for somebody who is signed in.
 *
 * It answers that one question and can do nothing else, which is exactly
 * why `runOnTheFakeProvider` below exists: a stub cannot write a report,
 * and the provider EO ships for work that must not spend anything can.
 */
function seedSignedInClaude(home: string): void {
  const cache = path.join(home, `.config/Electron/runtimes/claude@${CLAUDE_VERSION}`);
  mkdirSync(cache, { recursive: true });
  writeFileSync(
    path.join(cache, "claude"),
    `#!/bin/sh\necho '{"loggedIn":true,"authMethod":"subscription","email":"e2e@example.com"}'\n`,
  );
  chmodSync(path.join(cache, "claude"), 0o755);
}

/**
 * Points this project's agents at the provider EO ships for work that
 * must not spend anything.
 *
 * Written straight into the database, the way `seedItem` writes an item:
 * setup may reach past the UI as long as what is under test does not.
 * What is under test here is the flow — the needs check going green and
 * the job filing its first item — and not which backend a person picked,
 * which the Agents screen has its own spec for.
 *
 * It is needed because the two halves of "signed in" and "can actually
 * run" come apart on a test machine: the stub above satisfies the check,
 * and nothing on a runner can satisfy a real turn. `fake` is EO's own
 * answer to that, and it is what the first item runs on.
 */
function runOnTheFakeProvider(home: string): void {
  const db = new Database(path.join(home, ".config/Electron/eo.db"));
  try {
    db.prepare("UPDATE agents SET provider = 'fake', model = NULL WHERE archived_at IS NULL").run();
  } finally {
    db.close();
  }
}

/** A checkout, because EO clones nothing and refuses a path git does not recognise. */
function checkout(root: string): string {
  const repoPath = path.join(root, "acme-api");
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

test("a fresh installation walks solo, gallery, Preview, blanks, the needs check and its first item", async () => {
  // Skipped on Windows, and only there: the signed-in Claude above is a
  // script at the managed CLI's path, which the main process runs with
  // `execFile` and no shell. On Windows that path is `claude.exe`, and
  // only a real executable can answer there. The two tests below cover
  // the same screens on Windows, short of a sign-in to turn green.
  test.skip(process.platform === "win32", "the signed-in Claude is a shell script, and Windows runs claude.exe, which a script cannot stand in for");
  // Longer than the default: this drives six screens, waits on a
  // rehearsal under the fake provider, and then on a real dispatch.
  test.setTimeout(180_000);

  const { root, home, env, cleanUp } = scratch("first run");
  // Where the weekly report's material lives. It has to exist already —
  // EO never creates one, because a path that is not there is usually a
  // typo.
  const material = path.join(root, "the reports drive");
  mkdirSync(material, { recursive: true });
  // And a machine that is signed in, because "nothing real runs until
  // every line is green" and one of those lines is a backend.
  seedSignedInClaude(home);

  const { app, window } = await launchApp(env);
  try {

    // ── 1. One question before anything else ───────────────────────
    await expect(window.getByRole("heading", { name: "Welcome to EO" })).toBeVisible({ timeout: 15_000 });
    // And no board behind it: the empty rail this flow replaces is not
    // drawn at all.
    await expect(window.getByRole("navigation", { name: "Main" })).toHaveCount(0);
    await window.getByRole("button", { name: "Just me" }).click();

    // ── 2. A gallery, not an empty board ───────────────────────────
    await expect(window.getByRole("heading", { name: "Start with a template" })).toBeVisible();
    const weekly = window.getByRole("listitem").filter({ hasText: "Weekly report" });
    await expect(weekly).toBeVisible();

    // ── 3. Preview, before any sign-in ─────────────────────────────
    await weekly.getByRole("button", { name: "Preview" }).click();
    // The item itself, because watching it is the whole point — with the
    // banner that says what it is (ARCHITECTURE.md, "Preview"). The rehearsal runs on the fake
    // provider, and nothing was authorised to get here.
    await expect(window.getByText("Preview. Nothing was sent, nothing cost money.").first()).toBeVisible({ timeout: 30_000 });

    // Back to where they were. The rail is reachable from the item, and
    // Templates, behind its gear, is the door back into the gallery.
    await openPlace(window, "Templates");
    await expect(window.getByRole("heading", { name: "Start with a template" })).toBeVisible();

    // ── 4. The template's own blanks ───────────────────────────────
    await window.getByRole("listitem").filter({ hasText: "Weekly report" }).getByRole("button", { name: "Use this" }).click();
    // Typed rather than picked: Playwright cannot answer a native
    // directory dialog, which is why the field is typeable at all.
    await window.getByLabel("Where the material lives").fill(material);
    await window.getByLabel("When it runs — day").selectOption("monday");
    await window.getByRole("button", { name: "Create" }).click();

    // ── 5. The needs check ─────────────────────────────────────────
    await expect(window.getByRole("heading", { name: "Weekly report is set up" })).toBeVisible({ timeout: 15_000 });
    // Green: the folder they typed is there, and the backend line reads
    // the machine's own answer.
    await expect(window.getByText("A folder — somewhere its work happens")).toBeVisible();
    await expect(window.getByText("A coding agent signed in")).toBeVisible();

    // Red, and this is the line every import leaves behind: the pack's
    // `reporter` names no backend, so the agent it brought points at
    // nothing and is switched off. Signing in did not move it, which is
    // why it carries a button of its own.
    await expect(window.getByText(/the one this pack brought names no backend/)).toBeVisible();
    await window.getByRole("button", { name: /^Use claude for this$/ }).click();

    // Green, without leaving the screen, and now nothing is left.
    await expect(window.getByText("Everything it needs is here.")).toBeVisible({ timeout: 15_000 });
    await expect(window.getByText(/the one this pack brought names no backend/)).toHaveCount(0);

    // ── 6. The first item runs, and they watch it ──────────────────
    //
    // On the fake provider from here, for `runOnTheFakeProvider`'s
    // reason: the stub answered the sign-in question and can do nothing
    // else, and the job is about to file real work.
    runOnTheFakeProvider(home);

    await window.getByRole("button", { name: /^Start the first/ }).click();

    // A real item, filed by the job the template made — not the
    // rehearsal: it carries no banner, and it is on the project the form
    // created rather than in EO's preview project.
    const view = openView(window);
    await expect(view.getByRole("heading", { level: 1, name: "Weekly report" })).toBeVisible({ timeout: 30_000 });
    await expect(window.getByText("Preview. Nothing was sent, nothing cost money.")).toHaveCount(0);

    // And it ran: the item was dispatched to the fake provider, which
    // answers real work with the one honest thing a placeholder can say.
    // That sentence arriving in the thread is the dispatch, end to end —
    // the job fired, the engine picked the item up, and the provider
    // answered. Nothing was clicked to make it appear.
    const timeline = view.getByRole("region", { name: "Timeline" });
    await expect(timeline.getByText(/No coding agent is configured/)).toBeVisible({ timeout: 60_000 });
  } finally {
    await closeApp(app);
    cleanUp();
  }
});

test("Continue with Preview only lands on the board the rehearsal is on", async () => {
  test.setTimeout(120_000);

  const { root, env, cleanUp } = scratch("first run preview only");
  const material = path.join(root, "the reports drive");
  mkdirSync(material, { recursive: true });

  const { app, window } = await launchApp(env);
  try {

    await expect(window.getByRole("heading", { name: "Welcome to EO" })).toBeVisible({ timeout: 15_000 });
    await window.getByRole("button", { name: "Just me" }).click();
    await window.getByRole("listitem").filter({ hasText: "Weekly report" }).getByRole("button", { name: "Use this" }).click();
    await window.getByLabel("Where the material lives").fill(material);
    await window.getByRole("button", { name: "Create" }).click();

    // Nothing is signed in on this launch, so the needs check has lines
    // this machine cannot turn green — which is the state the design's exit
    // exists for, and it says why rather than leaving somebody guessing.
    await expect(window.getByRole("heading", { name: "Weekly report is set up" })).toBeVisible({ timeout: 15_000 });
    await expect(window.getByText("A coding agent signed in")).toBeVisible();
    await expect(window.getByText(/Nothing on this machine is signed in/).first()).toBeVisible();
    await expect(window.getByRole("button", { name: /^Start the first/ })).toHaveCount(0);

    await window.getByRole("button", { name: "Continue with Preview only" }).click();

    await new Promise((r) => setTimeout(r, 4000));
    // The **board** the rehearsal is on: the columns, with the marked
    // card in the first of them. Not the item's own page — what is being
    // shown is work moving through a pipeline.
    const board = openView(window);
    await expect(board.getByRole("heading", { level: 2, name: "Gather" })).toBeVisible({ timeout: 30_000 });
    await expect(board.getByText("Weekly report — week of 8 September")).toBeVisible({ timeout: 30_000 });
    await expect(board.getByText("Preview").first()).toBeVisible();

    // Nothing real was created beyond the project the form made: the one
    // item anywhere is the rehearsal, which every count EO keeps
    // excludes — starting with the inbox.
    const rail = window.getByRole("navigation", { name: "Main" });
    await expect(rail).toBeVisible();
    await expect(rail.getByRole("link", { name: /^Waiting on you/ })).not.toContainText(/\d/);
  } finally {
    await closeApp(app);
    cleanUp();
  }
});

test("a developer's first run reaches the board it reaches today, through the same screen", async () => {
  test.setTimeout(120_000);

  const { root, env, cleanUp } = scratch("first run developer");
  const repoPath = checkout(root);

  const { app, window } = await launchApp(env);
  try {

    await expect(window.getByRole("heading", { name: "Welcome to EO" })).toBeVisible({ timeout: 15_000 });
    await window.getByRole("button", { name: "Just me" }).click();

    // The developer's template is one card in everybody's gallery.
    await window.getByRole("listitem").filter({ hasText: "Software feature to merge" }).getByRole("button", { name: "Use this" }).click();
    await window.getByLabel("Ticket prefix").fill("ACME");
    await window.getByRole("button", { name: "Create" }).click();

    // The same two needs it has today — a repository and a backend —
    // rendered through everybody's needs check.
    await expect(window.getByRole("heading", { name: "Software feature to merge is set up" })).toBeVisible({ timeout: 15_000 });
    await expect(window.getByText("A repository — the checkout its work happens in")).toBeVisible();
    await expect(window.getByText(/This project has no repository yet/)).toBeVisible();
    await expect(window.getByText("A coding agent signed in")).toBeVisible();

    // The one button that fixes the red line, pressed — and the line
    // goes green without leaving the screen.
    await window.getByLabel("Repository path").fill(repoPath);
    await window.getByRole("button", { name: "Save" }).click();
    await expect(window.getByText(/This project has no repository yet/)).toHaveCount(0, { timeout: 15_000 });
    await expect(window.getByRole("heading", { name: "Software feature to merge is set up" })).toBeVisible();
    await expect(window.getByLabel("Repository path")).toHaveCount(0);

    // ── 6. The board ───────────────────────────────────────────────
    await window.getByRole("button", { name: "Go to the board" }).click();
    const rail = window.getByRole("navigation", { name: "Main" });
    await expect(rail).toBeVisible({ timeout: 15_000 });
    // One Delivery, not two: the pack is an export of the pipeline EO
    // already seeded, so first run adopts that board rather than
    // installing a copy of it beside itself.
    await expect(rail.getByRole("link", { name: "Delivery" })).toHaveCount(1);
    // The columns EO ships, which is the board a developer reaches
    // today.
    await expect(openView(window).getByRole("heading", { level: 2, name: "To Do" })).toBeVisible({ timeout: 15_000 });
    // And no Jobs entry: the developer template makes no job, and the
    // rail lists Jobs only for a project that has one (`ChatRail.tsx`).
    await expect(rail.getByRole("link", { name: "Jobs" })).toHaveCount(0);
  } finally {
    await closeApp(app);
    cleanUp();
  }
});
