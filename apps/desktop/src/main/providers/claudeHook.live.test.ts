import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentEvent } from "@eo/core";
import { afterAll, describe, expect, it } from "vitest";
import { createClaudeProvider, type SearchNudge } from "./claude.js";

/**
 * That the interception actually reaches a running agent (EO-165).
 *
 * `claude.test.ts` asserts what EO hands the SDK and what the callback
 * answers. Neither of those establishes the thing the whole story rests
 * on: that the CLI honours a `PreToolUse` matcher on `Bash` and calls
 * back before the command runs. That is a property of the binary, not of
 * EO's code, and this is the only place it can be observed.
 *
 * The vocabulary below is a stand-in. Nothing outside the
 * implementation's own directory may spell its tool names — or, for that
 * matter, name it at all — tests included, and three invariant scans in
 * `repositoryIntelligence/` say so.
 *
 * So is the classifier. Since KAN-126 the adapter delivers a nudge the
 * caller supplies and has none of its own, and the shipped one lives in
 * a directory this file may not import from. What this turn establishes
 * is that the CLI calls back and that the adapter qualifies whatever
 * vocabulary and says whatever sentence it was given — neither needs the
 * real classifier, and `liftedFromPack.test.ts` is what keeps it out.
 *
 * **And it cannot be observed the obvious way**, which is why this file
 * exists rather than a line in a script. Nothing EO records shows a hook
 * firing: the SDK's `hook_started` and `hook_response` messages carry
 * `stdout`, `stderr` and `exit_code` — they describe a *command* hook —
 * while EO's is an in-process callback invoked over the control protocol
 * and announced nowhere. `onUnmappedMessage` never sees it either, since
 * `mapSdkMessage` reports every `system` message as recognised. Two
 * attempts at counting this in `scripts/index-adoption-trial.mjs`
 * recorded zero on runs that had fired. The only honest observation is
 * to wrap the callback itself, which the `sdk` option makes possible
 * from outside the adapter.
 *
 * **Opt-in, because it spends real Claude credit** — one turn, a handful
 * of tool calls:
 *
 *     EO_LIVE_CLAUDE=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/claudeHook.live.test.ts
 *
 * Skipped otherwise, so `pnpm test` and CI never reach it.
 */

const OPTED_IN = process.env["EO_LIVE_CLAUDE"] === "1";

/** The runtimes the app dispatches with, laid out the way `runtimes/resolve.ts` lays them out. */
const RUNTIME_ROOT = process.env["EO_RUNTIME_ROOT"] ?? join(homedir(), ".config", "EO", "runtimes");

function newest(prefix: string): string {
  const chosen = readdirSync(RUNTIME_ROOT)
    .filter((name) => name.startsWith(`${prefix}@`))
    .sort()
    .at(-1);
  if (chosen === undefined) throw new Error(`No ${prefix} runtime under ${RUNTIME_ROOT}.`);
  return join(RUNTIME_ROOT, chosen);
}

let scratch: string | null = null;

/**
 * A stand-in judgement: any shell search for a word is a broad search
 * for that word, and the answer names the index's symbol tool in the
 * adapter's own spelling of it. Enough to show the sentence reached
 * the model through the hook, which is all this file is for.
 */
const standInNudge: SearchNudge = async (request) => {
  if (request.tool !== "Bash") return null;
  const command = (request.input as { command?: unknown }).command;
  const needle = typeof command === "string" ? /\bgrep\b.*?\s(\w+)\s+\.$/.exec(command)?.[1] : undefined;
  if (needle === undefined) return null;
  return {
    kind: "symbol",
    needle,
    nudge: `That searched the whole checkout for \`${needle}\`. This repository has an index: \`${request.qualify(request.answers.symbol)}\` answers it in one call. Your command was not blocked and has run.`,
  };
};

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(!OPTED_IN)("the interception, against the real CLI", () => {
  it(
    "is called before a repository-wide grep runs, and names the index's own tool in its answer",
    async () => {
      scratch = mkdtempSync(join(tmpdir(), "eo165-claude-hook-"));
      writeFileSync(join(scratch, "alpha.ts"), "export function transitionItem(): number {\n  return 1;\n}\n");

      const answered: string[] = [];
      const sdkEntry = join(newest("claude-sdk"), "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");
      const realSdk = (await import(pathToFileURL(sdkEntry).href)) as { query: (params: unknown) => unknown };

      const provider = createClaudeProvider({
        sdk: {
          ...realSdk,
          // Wrapping EO's own callback, which is the only channel that
          // carries this — see the note above about why the SDK's hook
          // messages are not it.
          query: (params: unknown) => {
            const options = (params as { options?: { hooks?: Record<string, { hooks: ((...args: never[]) => Promise<unknown>)[] }[]> } }).options;
            for (const group of options?.hooks?.["PreToolUse"] ?? []) {
              group.hooks = group.hooks.map((hook) => async (...args: never[]) => {
                const answer = (await hook(...args)) as { hookSpecificOutput?: { additionalContext?: string } };
                const said = answer.hookSpecificOutput?.additionalContext;
                if (typeof said === "string" && said.trim() !== "") answered.push(said);
                return answer;
              });
            }
            return realSdk.query(params);
          },
        } as never,
        executablePath: join(newest("claude"), "claude"),
        searchNudge: standInNudge,
      });

      const controller = new AbortController();
      const calls: string[] = [];
      const stream = provider.start({
        instructions: "You are working in a checkout. Do exactly what you are asked and nothing more.",
        context: "Run exactly this shell command, then tell me the single line it printed: grep -rn transitionItem .",
        cwd: scratch,
        repositoryMcp: {
          name: "repo",
          // A server that starts and answers nothing. The question here
          // is whether the *hook* fires, and a real index would make the
          // turn slower and the assertion no stronger.
          command: process.execPath,
          args: ["-e", "process.stdin.resume()"],
          env: {},
          // Stand-in names, not the shipped implementation's, and that
          // is a rule rather than a preference — see the note at the top.
          // What this turn establishes is that the CLI calls back and
          // that the adapter qualifies whatever vocabulary it was given.
          // Neither needs the real one, and one of them is asserted more
          // sharply without it.
          answers: { symbol: "idx_symbol", area: "idx_area", reach: ["idx_callers"], files: "idx_files" },
          // An index that holds whatever it is asked about (EO-173).
          // Required, not optional: vocabulary without a way of asking
          // gets no hook at all — and this file predates that rule, so
          // it had been registering nothing before KAN-126 noticed.
          knows: async () => [{ name: "transitionItem", path: "alpha.ts" }],
        },
        signal: controller.signal,
      });

      for await (const event of stream as AsyncIterable<AgentEvent>) {
        if (event.type === "tool_call") calls.push(event.name);
        // Stopped on the *answer*, never on the tool call — and the
        // first version of this stopped on the call and failed a run
        // that was working. `tool_call` is mapped off the assistant
        // message, which is the model *asking* for the tool; the hook
        // fires afterwards, when the CLI goes to run it. Aborting at the
        // first `Bash` cuts the turn between the two.
        if (answered.length > 0 || calls.length > 6) {
          controller.abort();
          break;
        }
        if (event.type === "result") break;
      }

      expect(calls, "the agent never made a shell call, so no hook could fire").toContain("Bash");
      expect(answered.length, "the CLI did not call EO's PreToolUse hook").toBeGreaterThan(0);
      // Named in the model's own spelling of a tool id, with the thing
      // the agent was actually looking for in it.
      expect(answered[0]).toContain("mcp__repo__idx_symbol");
      expect(answered[0]).toContain("transitionItem");
      // And nothing that would have stopped the command.
      expect(answered[0]).toContain("not blocked");
    },
    600_000,
  );
});
