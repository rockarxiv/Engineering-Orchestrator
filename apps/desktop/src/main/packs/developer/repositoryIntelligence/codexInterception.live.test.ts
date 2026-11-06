import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, RepositoryMcpServer } from "@eo/core";
import { afterAll, describe, expect, it } from "vitest";
import { createCodexProvider } from "../../../providers/codex.js";
import { repositorySearchNudge } from "./broadSearch.js";

/**
 * The interception on a real Codex turn (EO-379).
 *
 * `codexInterception.test.ts` runs everything EO wrote and stands in for
 * the CLI. This is the part it has to take on trust, checked against the
 * binary instead — each of them something the delivery rests on and a
 * stand-in cannot show:
 *
 * 1. **The hook EO configures is run.** Inline, matched on `Bash`, as one
 *    shell command line with a variable set in front of it, and trusted
 *    alone — by the key and hash the CLI reports for it when asked
 *    (`probeHookTrust`), with no thread-wide waiver of review.
 * 2. **The command inherits the CLI's environment.** The listener's
 *    address and bearer travel there and nowhere else, so a hook spawned
 *    into a scrubbed environment would be one that could never answer.
 * 3. **The id in the hook's payload is the id of the completed command.**
 *    That is what puts an interception beside the `tool_call` it fired
 *    on, and what `callId` exists to join.
 * 4. **The nudge reaches the model and the command still runs.**
 * 5. **Nobody else's hook runs because EO's does.** The turn runs in a
 *    Codex home holding a hook nobody reviewed — what an agent using the
 *    person's own setup may find there — and that hook must stay unrun.
 *    A thread-wide waiver of review would run it.
 *
 * Last run against the 0.166.0 binary EO pins (EO-644).
 *
 * The index is a stand-in on purpose: a vocabulary and a `knows` that
 * says yes, served by a command that is not an MCP server at all. The
 * turn is about the hook, and a server that fails to start does not stop
 * a Codex turn.
 *
 * **Opt-in, because it spends real credit on a real account** — one short
 * turn:
 *
 *     EO_LIVE_CODEX=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/packs/developer/repositoryIntelligence/codexInterception.live.test.ts
 */
const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";

/** The pinned binary if the caller names one, otherwise whatever is on PATH. */
const CODEX = process.env["EO_CODEX_BIN"] ?? execFileSyncOrNull("which", ["codex"]) ?? "codex";

const HOOK_COMMAND = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "providers", "codexSearchHookCommand.mjs");

function execFileSyncOrNull(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

let scratch: string | null = null;

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(!OPTED_IN)("the broad-search interception on a real Codex turn", () => {
  it(
    "fires on a real grep, is recorded against that call, and reaches the model without breaking the command",
    async () => {
      expect(existsSync(join(process.env["HOME"] ?? "", ".codex", "auth.json")), "no credential — run `codex login` first").toBe(true);
      scratch = mkdtempSync(join(tmpdir(), "eo379-codex-nudge-"));
      const work = join(scratch, "work");
      const home = join(scratch, "home");
      mkdirSync(work);
      mkdirSync(home);
      execFileSync("git", ["init", "-b", "main"], { cwd: work, stdio: "pipe" });
      writeFileSync(join(work, "note.txt"), "transitionItem lives here\n");
      // A Codex home with the person's sign-in and one hook of theirs
      // that nobody has reviewed. If it runs, it leaves a file.
      const personalRan = join(scratch, "personal-hook-ran");
      symlinkSync(join(process.env["HOME"] ?? "", ".codex", "auth.json"), join(home, "auth.json"));
      writeFileSync(join(home, "config.toml"), `[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(`touch ${personalRan}`)}\n`);

      const asked: unknown[] = [];
      const repositoryMcp = {
        name: "repo",
        command: "true",
        args: [],
        env: {},
        answers: { symbol: "idx_symbol", area: "idx_area", reach: ["idx_callers"], files: "idx_files" },
        knows: async (question: unknown) => {
          asked.push(question);
          return [
            { name: "transitionItem", path: "packages/engine/src/routing.ts" },
            { name: "transitionItem", path: "apps/desktop/src/main/supervisor/runSupervisor.ts" },
          ];
        },
      } as unknown as RepositoryMcpServer;

      const provider = createCodexProvider({ executablePath: CODEX, searchNudge: repositorySearchNudge, searchHookCommandPath: HOOK_COMMAND, codexHome: () => home });
      const events: AgentEvent[] = [];
      for await (const event of provider.start({
        instructions: "You run exactly the shell command you are given, once, and nothing else.",
        context:
          "Run the shell command: grep -rn transitionItem .\n" +
          "Then reply with the matching line it printed. If, around that command, you were shown any message naming a tool whose name contains `idx_symbol`, end your reply with that tool's full name exactly as it was written, on its own line.",
        cwd: work,
        repositoryMcp,
        signal: AbortSignal.timeout(240_000),
      })) {
        events.push(event);
      }

      const said = events.map((event) => JSON.stringify(event)).join("\n");
      const interceptions = events.filter((event) => event.type === "search_interception");
      // (1) and (2): it fired, which takes the hook being run *and* the
      // command finding the listener.
      expect(asked.length, `the classifier was never asked — the hook did not run, or could not reach EO:\n${said}`).toBeGreaterThan(0);
      expect(interceptions, said).toHaveLength(1);
      expect(interceptions[0]).toMatchObject({ tool: "Bash", kind: "symbol", needle: "transitionItem" });

      // (3): the id it carries is the id of a shell call this turn
      // reported, and it sits directly after that call.
      const callId = (interceptions[0] as { callId: string | null }).callId;
      const at = events.indexOf(interceptions[0] as AgentEvent);
      expect(callId, "the hook payload carried no tool_use_id").not.toBeNull();
      expect(events[at - 1], `the interception did not join the call it fired on:\n${said}`).toMatchObject({ type: "tool_call", name: "command_execution", callId });

      // Nothing waived review for the thread: the CLI warns when
      // something does, and a warning is recorded as a non-fatal error.
      expect(events.filter((event) => event.type === "error"), said).toEqual([]);

      // (5): EO's hook ran and the unreviewed one beside it did not.
      expect(existsSync(personalRan), "a hook nobody reviewed was run because EO's was").toBe(false);

      // (4): the command ran, and the model was told.
      expect(events.find((event) => event.type === "tool_result" && event.callId === callId), said).toMatchObject({ ok: true });
      const result = events.find((event) => event.type === "result") as { data?: unknown } | undefined;
      expect(String(result?.data), "the nudge never reached the model").toContain("repo/idx_symbol");
    },
    300_000,
  );
});
