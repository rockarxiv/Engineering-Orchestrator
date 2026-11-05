import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { closeApp, homeEnv, launchApp, skipFirstRun } from "./support/app.js";
import { openView } from "./support/board.js";
import { openPlace } from "./support/rail.js";
import { RUNTIMES, versionFor } from "../src/main/runtimes/catalog.js";

// The pinned Claude build, read off the catalog the main process reads.
// The assertions below are about the app agreeing with its own pin, so a
// literal here would be a second copy of it — and a version bump would
// then have to remember to edit a Playwright spec that CI does not run
// on every push.
const CLAUDE_VERSION = versionFor(RUNTIMES.claude, "linux", "x64")!;

/**
 * The agent runtimes, in the shipped process (A-08).
 *
 * The gate for the story, and the one thing the unit tests cannot show:
 * that resolution, the IPC channels and the Runtimes tab agree with each
 * other inside the real main process, against a real disk.
 *
 * It also pins the part that carries legal weight. EO fetching a runtime
 * *on request* is what makes it a fetcher rather than a redistributor of
 * a binary marked "© Anthropic PBC. All rights reserved" — and that
 * distinction survives only as long as "Add runtime" opens a list, and a
 * choice from that list opens a dialog, instead of starting a download.
 *
 * No network: the launch environment is arranged so that resolution has
 * a definite answer either way, and the assertion about consent is about
 * what does *not* happen.
 */

/** A home and a PATH with no agent CLI anywhere in them. */
function isolate(scratch: string): { home: string; env: NodeJS.ProcessEnv } {
  const home = path.join(scratch, "home");
  mkdirSync(home, { recursive: true });
  return {
    home,
    env: homeEnv(home, {
      // Deliberately not process.env.PATH: the developer running this
      // very likely has `claude` on theirs, and then "reports absent"
      // would pass on CI and fail on their machine, or worse the other
      // way round.
      PATH: "/usr/bin:/bin",
    }),
  };
}

/** Places a fetched-looking Claude CLI where the main process computes its cache to be. */
function seedManagedClaudeCli(scratch: string): void {
  // Before launch, and in the directory the main process works out for
  // itself — so this pins the actual location, not a constant the test
  // and the code share.
  const cache = path.join(scratch, `home/.config/Electron/runtimes/claude@${CLAUDE_VERSION}`);
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(cache, "claude"), 0o755);
}

async function openRuntimes(scratch: string) {
  const { env } = isolate(scratch);
  const { app, window } = await launchApp(env);

  // This spec's installation stays empty — what it is about is what the
  // machine has, not what anybody is working on — and first run stands
  // in front of the rail until somebody has something of their own
  // (EO-317). Taken past it the way the flow's own exit does.
  await skipFirstRun(window);

  await openPlace(window, "Agents");
  await openView(window).getByRole("tab", { name: /Runtimes/ }).click();

  return { app, window };
}

test("a machine with no agent CLI says so, and offers to fetch one", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e runtime "));
  const { app, window } = await openRuntimes(scratch);

  try {
    await expect(window.getByText("No runtimes on this machine yet.")).toBeVisible({ timeout: 10_000 });

    // The gate, first half: "Add runtime" produces a list, not a download.
    await window.getByRole("button", { name: /Add runtime/ }).first().click();
    const picker = window.getByRole("dialog");
    await expect(picker.getByRole("button", { name: /Claude Code/ })).toBeVisible();
    await expect(picker.getByRole("button", { name: /Codex/ })).toBeVisible();

    // Second half: a choice produces a dialog, not a download.
    await picker.getByRole("button", { name: /Claude Code/ }).click();
    const consent = window.getByLabel("Download Claude Code");
    await expect(consent).toBeVisible();

    // Everything consent is actually about, and all of it from the
    // catalog rather than the network — so this holds offline.
    await expect(consent).toContainText(`@anthropic-ai/claude-agent-sdk-linux-x64@${CLAUDE_VERSION}`);
    await expect(consent).toContainText("Anthropic PBC");
    await expect(consent).toContainText("checksum");
    await expect(consent.getByRole("link", { name: /Read them/ })).toHaveAttribute(
      "href",
      "https://code.claude.com/docs/en/legal-and-compliance",
    );

    // And backing out leaves nothing behind.
    await consent.getByRole("button", { name: "Cancel" }).click();
    await window.keyboard.press("Escape");
    await expect(window.getByText("No runtimes on this machine yet.")).toBeVisible();
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a runtime EO has already fetched is listed as EO's own, with its version", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e runtime cached "));
  seedManagedClaudeCli(scratch);

  const { app, window } = await openRuntimes(scratch);

  try {
    // Where it came from, not just that it works. A `claude` off PATH is
    // one somebody else updates, and a run that starts behaving
    // differently after an unrelated `brew upgrade` is otherwise a
    // mystery with no thread to pull.
    const card = openView(window).getByRole("region", { name: "Claude Code runtime" });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("Managed by EO");
    await expect(card).toContainText("Claude Code CLI");
    await expect(card).toContainText(CLAUDE_VERSION);

    // A managed cache is itself consent, so this one is being kept
    // current rather than waiting to be asked about: it is listed, not
    // offered a second time.
    await window.getByRole("button", { name: /Add runtime/ }).first().click();
    await expect(window.getByRole("dialog").getByRole("button", { name: /Claude Code/ })).toHaveCount(0);
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the agent editor names the runtime its backend needs, where the backend is chosen", async () => {
  // The Runtimes tab is about a machine; this is about one agent. Both
  // read the same status, and the moment a backend is picked is the
  // moment someone can do something about it being absent.
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e runtime editor "));
  const { env } = isolate(scratch);
  const { app, window } = await launchApp(env);

  try {
    // Past first run, for `openRuntimes`' reason: this installation has
    // no project and is not about to get one (EO-317).
    await skipFirstRun(window);
    await openPlace(window, "Agents");

    const editor = openView(window).getByLabel("Edit agent");
    await expect(editor).toBeVisible();
    // The select rather than the section of the same name below it: the
    // field's name is "Runtime" followed by what it is set to now.
    await editor.getByRole("combobox", { name: /^Runtime/ }).selectOption("claude");

    await expect(editor.getByRole("group", { name: "Claude Code runtime" })).toContainText("needs managed components", {
      timeout: 10_000,
    });
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});
