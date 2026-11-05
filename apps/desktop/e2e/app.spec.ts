import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { attachRepository, homeEnv, launchApp } from "./support/app.js";
import { openPlace } from "./support/rail.js";

/**
 * A home of this launch's own, which every other spec in this directory
 * already gives itself.
 *
 * This one did not, and was the only spec that did not: it launches with
 * no repository, so it needed no fixture on disk and the machine's real
 * `HOME` looked like one less thing to arrange. What that actually meant
 * is that both tests below shared a `userData` directory with every
 * other run of this suite the machine had ever done — and `index.ts`
 * takes `app.requestSingleInstanceLock()` and calls `app.quit()` when it
 * does not get it, *without ever opening a window*.
 *
 * So an Electron left behind by an earlier job — a run cancelled
 * mid-launch, a worker killed — makes both tests here fail with
 * `Test timeout of 30000ms exceeded` and nothing else: no assertion, no
 * stderr, no mention of a lock. Every other spec in the run passes,
 * because every other spec has its own home and therefore its own lock.
 * That is exactly what turned CI red on a branch whose change was to
 * `items`, and it is reproducible in one command: hold a window open on
 * a home, point this spec at the same one, and watch both tests spend
 * thirty seconds each saying nothing.
 *
 * Neither test asserts anything about the real home, so there was never
 * anything to lose by isolating them. `closeApp`'s note above this one
 * describes the same shape of bug from the other end — "one cause, two
 * clocks, and a failure whose message names neither".
 */
/**
 * A checkout for the one test here that needs to get past first run.
 *
 * EO clones nothing and refuses a path git does not recognise, so
 * "somewhere on disk" is not a repository — three git commands are.
 */
function checkout(home: string): string {
  const repoPath = path.join(home, "a repo");
  mkdirSync(repoPath, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "eo@example.com");
  git("config", "user.name", "EO E2E");
  git("commit", "--allow-empty", "-m", "initial");
  return repoPath;
}

function scratchHome(): { home: string; env: NodeJS.ProcessEnv; cleanUp: () => void } {
  const home = mkdtempSync(path.join(tmpdir(), "eo e2e app "));
  return {
    home,
    env: homeEnv(home),
    cleanUp: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("app launches with a secure renderer and leaves no orphaned process after quit", async () => {
  const { env, cleanUp } = scratchHome();
  // Named to avoid shadowing the browser global `window` referenced inside
  // the evaluate() callbacks below.
  const { app, window: mainWindow } = await launchApp(env);

  // What a launch with nothing configured lands on since EO-317: first
  // run, at its first question (ARCHITECTURE.md, "What a person sees first"). It was the shell's
  // "EO"
  // wordmark behind an empty board, which is the screen the flow
  // replaced — the rail is not drawn until this installation has
  // something of its own.
  await expect(mainWindow.getByRole("heading", { name: "Welcome to EO" })).toBeVisible();

  const hasNodeRequire = await mainWindow.evaluate(
    () => typeof (window as unknown as { require?: unknown }).require !== "undefined",
  );
  expect(hasNodeRequire).toBe(false);

  const bridgeVersions = await mainWindow.evaluate(() => window.eo?.versions);
  expect(bridgeVersions?.electron).toBeTruthy();

  const pid = app.process().pid;
  await app.close();
  cleanUp();

  expect(pid).toBeTruthy();
  if (pid) {
    // process.kill(pid, 0) throws ESRCH once the process is gone — this is
    // what "no orphaned process after quit" actually verifies.
    expect(() => process.kill(pid, 0)).toThrow();
  }
});

test("the invoke round-trip and the push channel both work against the real app", async () => {
  const { home, env, cleanUp } = scratchHome();
  const { app, window: mainWindow } = await launchApp(env);

  // app:getVersion round-trip, rendered where the chat layout shows the
  // running version: Settings → Updates. (It was the classic rail's
  // footer, and before that "App version: x.y.z" on F-04's scaffold
  // page.)
  //
  // The rail is behind first run since EO-317, so this launch is given a
  // repository before it looks for the rail — through the channel, the
  // way every other spec's setup does.
  await attachRepository(mainWindow, checkout(home));
  await openPlace(mainWindow, "Settings");
  await mainWindow.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Updates" }).click();
  await expect(mainWindow.getByText(/^EO \d+\.\d+\.\d+/)).toBeVisible();

  // A push reaching the renderer over real IPC. Asserted through the
  // bridge rather than the page: this channel is the one every push in
  // the app rides on. It used to be proved with the `app:tick` demo push,
  // which fired every second for nobody and is gone (EO-557); a new
  // chat is a write that pushes `items:changed` and leaves nothing
  // behind this launch's own home would mind.
  const pushed = await mainWindow.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        const unsubscribe = window.eo.ipc.subscribe("items:changed", () => {
          clearTimeout(timer);
          unsubscribe();
          resolve(true);
        });
        void window.eo.ipc.invoke("assist:new" as never, undefined as never);
      }),
  );
  expect(pushed).toBe(true);

  await app.close();
  cleanUp();
});
