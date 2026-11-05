import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/**
 * A scratch profile that runs on the person's own Claude and Codex
 * sign-ins, for the opt-in live specs.
 *
 * The profile is a scratch one, as every spec's is, and what it borrows
 * from the person's own is borrowed so that nothing of theirs can be
 * changed by it:
 *
 * - **Each installed runtime is linked one by one into a scratch runtimes
 *   directory.** An install replaces its target by removing it and
 *   renaming a new one into place, which on a link removes the link and
 *   leaves the person's copy alone.
 * - **`~/.claude.json` is copied**, not linked: the CLI writes project
 *   entries and counters into it, and those belong to the scratch run.
 * - **The two sign-ins are linked**, so a token the CLI refreshes in
 *   place is refreshed where it lives. A CLI that saved a refreshed token
 *   by writing a new file and renaming it over the link would leave the
 *   person's own copy holding a token already rotated out — so a run can,
 *   in that case, sign them out of that CLI, and they sign in again.
 *
 *   Which is why a run refuses to start on a Claude token about to need
 *   refreshing (`claudeTokenLastsTheRun`): the Claude CLI does save a
 *   refreshed token by renaming a new file over the old one, and two
 *   scratch processes refreshing at once rotated the person's token out
 *   from under them, once. Never refreshed here, it cannot be rotated here.
 */
export function liveHome(label: string, uses?: "claude" | "codex"): { scratch: string; home: string } {
  const realHome = homedir();
  // Only where Claude will run: a Codex-only run spawns no Claude CLI.
  if (uses !== "codex") claudeTokenLastsTheRun(realHome);
  const scratch = mkdtempSync(path.join(tmpdir(), `eo e2e ${label} `));
  const home = path.join(scratch, "home");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  symlinkSync(path.join(realHome, ".claude", ".credentials.json"), path.join(home, ".claude", ".credentials.json"));
  copyFileSync(path.join(realHome, ".claude.json"), path.join(home, ".claude.json"));
  symlinkSync(path.join(realHome, ".codex", "auth.json"), path.join(home, ".codex", "auth.json"));
  const runtimes = path.join(realHome, ".config", "EO", "runtimes");
  const scratchRuntimes = path.join(home, ".config", "Electron", "runtimes");
  mkdirSync(scratchRuntimes, { recursive: true });
  for (const runtime of readdirSync(runtimes)) symlinkSync(path.join(runtimes, runtime), path.join(scratchRuntimes, runtime));
  return { scratch, home };
}

/** How long the person's Claude token must still be good for when a live run starts. */
const TOKEN_MARGIN_MS = 30 * 60 * 1000;

/**
 * Refuses to start a live run on a Claude sign-in that would have to be
 * refreshed during it — see `liveHome` on what a refresh from a scratch
 * profile can do to the person's own. Any `claude` command run in their
 * own terminal refreshes it where it lives.
 */
function claudeTokenLastsTheRun(realHome: string): void {
  let expiresAt: unknown;
  try {
    const credentials = JSON.parse(readFileSync(path.join(realHome, ".claude", ".credentials.json"), "utf8")) as { claudeAiOauth?: { expiresAt?: unknown; accessToken?: unknown } };
    if (!credentials.claudeAiOauth?.accessToken) throw new Error("Claude is not signed in: sign in with `claude` before running the live specs.");
    expiresAt = credentials.claudeAiOauth.expiresAt;
  } catch (error) {
    throw error instanceof Error && error.message.startsWith("Claude is not signed in") ? error : new Error(`Could not read the Claude sign-in: ${String(error)}`);
  }
  if (typeof expiresAt === "number" && expiresAt - Date.now() < TOKEN_MARGIN_MS) {
    throw new Error(
      "The Claude sign-in expires within half an hour, and a live run would refresh it from a scratch profile, which can sign you out. " +
        "Run any `claude` command in your own terminal to refresh it first, then run the live specs again.",
    );
  }
}
