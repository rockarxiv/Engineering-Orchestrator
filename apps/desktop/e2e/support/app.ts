import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

/** The built main process every spec launches. `pnpm e2e` builds it first. */
const mainEntry = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "out/main/index.js");

/**
 * The environment that gives a launch a home of its own.
 *
 * All three, because Electron resolves `userData` through a different one
 * on each platform, and a spec that set only `HOME` would still share a
 * directory — and the single-instance lock that comes with it — on
 * Windows. `extra` is anything else the spec's subject needs.
 */
export function homeEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), USERPROFILE: home, ...extra };
}

/**
 * Starts the app on a home and hands back its window.
 *
 * The window is the chat layout, the only one there is (EO-529), and it
 * opens on the conversation at `/chat`: the main window loads with no
 * address, and the frame sends an address it draws nothing at to its
 * home. First run, sign-in and an invitation sit above the frame, so a
 * fresh installation still lands on first run.
 */
export async function launchApp(env: NodeJS.ProcessEnv): Promise<{ app: ElectronApplication; window: Page }> {
  // Only the variables that are set: Electron takes strings, and an
  // inherited variable that is unset is not one.
  const strings = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const app = await electron.launch({ args: [mainEntry], env: strings });
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  return { app, window };
}

/**
 * Closing the app at the end of a spec, without rolling a die.
 *
 * `app.close()` on its own is a coin flip for any spec that lets the
 * engine dispatch. EO asks before it exits while an agent is working —
 * "Agents are still working", three buttons, see
 * `shutdownCoordinator.ts` — and in a test nobody is there to answer it.
 * The app then sits on a native dialog that will never be dismissed, the
 * test burns its 30s timeout, and the worker burns another 30s on
 * teardown: one cause, two clocks, and a failure whose message names
 * neither. Measured on the archive spec at two failures in ten runs
 * before this, and none in twelve after; the same shape had already
 * turned CI red twice on changes that had nothing to do with it —
 * `configurePipeline` (a spec since removed) on one branch, `archive` on
 * the next.
 *
 * So the dialog is answered before the close, with the answer a teardown
 * means: *Stop agents and close*. Nothing is asserted about it — a
 * spec that never raises one closes exactly as it did before.
 *
 * Two specs do not use it. `shutdown.spec.ts`, because the dialog is its
 * subject: it stubs the same call itself and drives all three answers
 * through it. And `app.spec.ts`, which launches with no repository — so
 * there is no work to be mid-flight — and whose first claim is about the
 * close itself, that no process is left behind; swallowing anything
 * there would be swallowing the thing it asserts.
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  // Swallowed, both of them, and only here: by this point the spec's
  // assertions have all run, and the two ways these throw are an app
  // that has already gone — which is what a spec that closed its own
  // window wanted — and a process that exited while we were asking.
  // Neither is a failure of the thing under test, and a hang is not
  // something a catch could have helped with anyway.
  await app
    .evaluate(({ dialog }) => {
      // Index 2 of the buttons index.ts passes: "Stop agents and
      // close". shutdown.spec.ts asserts that list, so a reordering
      // there fails loudly rather than silently changing what every
      // other spec's teardown answers.
      dialog.showMessageBox = (async () => ({ response: 2, checkboxChecked: false })) as typeof dialog.showMessageBox;
    })
    .catch(() => {});
  await app.close().catch(() => {});
}

/**
 * Attaches a repository to a fresh installation, past the UI (EO-317).
 *
 * First run is no longer "point EO at a repository" — it is the flow
 * the design describes: solo or organisation, the gallery, an optional Preview,
 * the template's blanks, the needs check. `firstRun.spec.ts` drives that
 * whole order as a person does, because it is the thing under test
 * there.
 *
 * Everywhere else it is *setup*, and setup is allowed to reach past the
 * UI — the same licence `seedItem` takes for an item and `worktrees.spec`
 * takes for a checkout. Driving six screens to reach the subject of a
 * spec about something else would make every one of those specs fail
 * when the flow changed a word, which is exactly the coupling that made
 * thirteen of them go through the old panel in the first place.
 *
 * It goes through the real channel, so what it creates is what the app
 * creates: a repository, the project it gets, and the active-project
 * setting that follows. First run ends the moment that project exists —
 * see `firstRunDone` — and the window is told by the same
 * `config:changed` push any other window would get.
 */
export async function attachRepository(window: Page, repoPath: string): Promise<void> {
  const answer = await window.evaluate(
    ([path]) =>
      window.eo.ipc.invoke("repositories:create" as never, {
        // The directory's name, which is what the first-run panel sent
        // and what the needs check sends now.
        name: (path as string).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path,
        repoPath: path,
        baseBranch: "main",
        testCommand: null,
        lintCommand: null,
        buildCommand: null,
      } as never),
    [repoPath],
  );

  const result = answer as { ok: boolean; data?: { ok: boolean; problem: string | null }; error?: string };
  // Thrown rather than asserted: a spec whose fixture did not land
  // should fail here, naming the reason, rather than thirty seconds
  // later on an assertion about something else.
  if (!result.ok || result.data?.ok !== true) {
    throw new Error(`attachRepository(${repoPath}) failed: ${result.data?.problem ?? result.error ?? "unknown"}`);
  }
}

/**
 * Puts first run behind an installation that is going to stay empty
 * (EO-317).
 *
 * `attachRepository` is the usual way past the flow, because most specs
 * want a project anyway. This is for the ones whose subject is a screen
 * an installation with *no* project still has — the Runtimes tab, which
 * is about what this machine has installed rather than about any work —
 * and which reach it through a rail the flow is in front of.
 *
 * It takes the same exit "Continue with Preview only" takes, and writes
 * exactly what that writes: a settings row saying somebody has been
 * through it. Nothing is created.
 */
export async function skipFirstRun(window: Page): Promise<void> {
  await window.evaluate(() => window.eo.ipc.invoke("firstRun:finish" as never, undefined as never));
}
