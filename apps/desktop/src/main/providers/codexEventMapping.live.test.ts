import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@eo/core";
import type { AppServerNotification } from "./codexAppServer.js";
import type { ThreadEvent } from "./codexClient.js";
import { createCodexProvider } from "./codex.js";

/**
 * Does the pinned CLI still speak only events `mapThreadEvent` knows
 * (EO-179)?
 *
 * `codex.ts` maps `ThreadEvent` and `ThreadItem` by hand, arm by arm,
 * and returns `recognised: false` for anything it does not know rather
 * than dropping it — which is the right shape, but it turns an unmapped
 * event into a line in a log that nobody is reading during the run that
 * produced it. A version bump is exactly when a new arm appears, and
 * Codex moves on a 0.x line where the minor is where breaking changes
 * live. So the bump is the moment to *ask*, rather than to infer from a
 * clean compile: the vocabulary is EO's (`codexClient.ts`, translated
 * from the app-server since EO-372), the notifications come from the
 * CLI, and the two are different artefacts that a pin can pull apart.
 *
 * A fixture cannot answer it. `codex.test.ts` establishes that every arm
 * EO knows maps to the right `AgentEvent`, against events EO's own test
 * constructs — which is a test of the mapping and not of the vocabulary.
 * What is unknown here is what the *binary* emits, and only the binary
 * can say.
 *
 * The turn is written to reach the arms that carry EO's real payload
 * rather than to be short: a command execution and a file change are the
 * two an implementer run is made of, and `agent_message`, `reasoning`
 * and the todo list arrive along the way. A one-word reply would exercise
 * `agent_message` and prove nothing about the rest.
 *
 * **Opt-in, because it spends real API credit on a real account.** One
 * small turn, and it needs `codex login`. Skipped otherwise, so
 * `pnpm test` and CI never reach it:
 *
 *     EO_LIVE_CODEX=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/codexEventMapping.live.test.ts
 *
 * Driven through `createCodexProvider`, because `onUnmappedEvent` is the
 * seam being read. Since EO-372 it carries two kinds of surprise: an
 * `exec`-vocabulary event `mapThreadEvent` does not know, and an
 * app-server notification `codexClient.ts` neither translates nor
 * deliberately ignores. Either fails this test by name.
 */

const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";

/** The pinned binary if the caller names one, otherwise whatever is on PATH. */
const CODEX = process.env["EO_CODEX_BIN"] ?? "codex";

let workspace: string | null = null;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

function newWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "eo-codex-mapping-"));
  // Codex refuses to run outside a repository unless told to skip the
  // check; a real one costs nothing and keeps the flag out of it.
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "VERSION.txt"), "1\n");
  return dir;
}

describe.skipIf(!OPTED_IN)("the pinned Codex CLI's event vocabulary", () => {
  it(
    "says nothing mapThreadEvent does not recognise, on a turn that runs a command and edits a file",
    async () => {
      workspace = newWorkspace();

      const unmapped: (ThreadEvent | AppServerNotification)[] = [];
      const provider = createCodexProvider({
        executablePath: CODEX,
        onUnmappedEvent: (event) => unmapped.push(event),
      });

      const events: AgentEvent[] = [];
      for await (const event of provider.start({
        instructions: "You are a test fixture. Work directly and do not ask questions.",
        context: [
          "Do all three steps, in order:",
          "1. Run the shell command `cat VERSION.txt` to read the file.",
          // The *mechanism* is named, not just the outcome (EO-342).
          // Asking only for the contents to change leaves the choice to
          // the model, and at codex-cli 0.155.1 it reliably takes the
          // cheaper route — `printf '2\n' > VERSION.txt` through the
          // shell, which is a `command_execution` item and emits no
          // `file_change`. That is a legitimate way to edit a file and
          // not a regression; it just exercises the `command_execution`
          // arm twice and the `file_change` arm not at all, which is the
          // one thing this turn is shaped to avoid. With the tool named,
          // `file_change` → `file_edit` still maps exactly as before.
          "2. Using the apply_patch tool rather than a shell command, change the contents of VERSION.txt to the single line `2`.",
          "3. Reply with the single word done.",
        ].join("\n"),
        cwd: workspace,
        signal: new AbortController().signal,
      })) {
        events.push(event);
      }

      // The turn has to have *done* something, or "nothing unmapped" is
      // true for the wrong reason — a refusal emits `agent_message` and
      // nothing else, and would pass an assertion about the absence of
      // surprises while exercising one arm out of the set.
      expect(readFileSync(join(workspace, "VERSION.txt"), "utf8").trim(), "the turn never edited the file").toBe("2");
      expect(events.filter((event) => event.type === "tool_call")).not.toHaveLength(0);
      expect(events.filter((event) => event.type === "file_edit")).not.toHaveLength(0);

      // The subject. Reported with the event types in the message, so a
      // failure names the arm to add rather than only saying there was
      // one.
      expect(unmapped.map((event) => ("method" in event ? event.method : event.type)), `unmapped events and notifications: ${JSON.stringify(unmapped, null, 2)}`).toEqual([]);
    },
    300_000,
  );
});
