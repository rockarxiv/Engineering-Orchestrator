import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { attachRepository, homeEnv, launchApp } from "./support/app.js";
import { seedItem } from "./support/seed.js";

test("an active agent warns on close, stays open on Keep, and drains before closing", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e shutdown "));
  const home = path.join(scratch, "home");
  const repoPath = path.join(scratch, "the repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repoPath, { recursive: true });

  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "eo@example.com");
  git("config", "user.name", "EO E2E");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  git("add", "-A");
  git("commit", "-m", "initial");

  const { app, window } = await launchApp(homeEnv(home, { EO_E2E_AGENT_DELAY_MS: "3000" }));

  try {
    await attachRepository(window, repoPath);
    await expect(window.getByRole("button", { name: "Switch project" })).toContainText("the repo", { timeout: 10_000 });

    // Seeded rather than typed in: the form that used to create an item
    // is gone, and the two doors that remain (the assistant, Jira) each need a
    // fixture heavier than what this spec is about.
    // Straight onto the step that dispatches an agent: the built-in that
    // prepares the worktree would otherwise have to run first, and this
    // spec is about what happens while an agent is working.
    seedItem(home, { title: "Close safely", stepId: "todo", branch: "eo/seeded" });
    await window.reload();
    await window.waitForLoadState("domcontentloaded");

    // Longer than the default poll: new work now passes through the
    // built-in step that prepares the worktree before any agent runs, so
    // the first *agent* run is one tick further away than it used to be.
    await expect
      .poll(
        async () => {
          const result = await window.evaluate(() => window.eo.ipc.invoke("engine:status", undefined));
          return result.ok ? result.data.activeRunCount : 0;
        },
        { timeout: 20_000 },
      )
      .toBe(1);

    await app.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & {
        eoShutdownChoice?: number;
        eoShutdownWarning?: { title?: string; buttons?: string[] };
      };
      state.eoShutdownChoice = 0;
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string; buttons?: string[] };
        state.eoShutdownWarning = { title: options.title, buttons: options.buttons };
        return { response: state.eoShutdownChoice ?? 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    // Still open: "Keep EO open" was the answer. Asserted on the chrome
    // rather than on an item, since the window staying up is the claim.
    await expect(window.getByRole("button", { name: "Switch project" })).toBeVisible();
    expect(
      await app.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          eoShutdownWarning?: { title?: string; buttons?: string[] };
        };
        return state.eoShutdownWarning;
      }),
    ).toEqual({
      title: "Agents are still working",
      buttons: ["Keep EO open", "Close when finished", "Stop agents and close"],
    });

    await app.evaluate(() => {
      (globalThis as typeof globalThis & { eoShutdownChoice?: number }).eoShutdownChoice = 1;
    });
    const appProcess = app.process();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());

    await expect.poll(() => appProcess.exitCode, { timeout: 10_000 }).not.toBeNull();
  } finally {
    await app.close().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }
});
