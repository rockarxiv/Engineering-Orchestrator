import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@eo/core";
import { startAgentWriteBridge } from "../mcp/writeBridge.js";
import { createCodexProvider } from "./codex.js";

/**
 * A Codex agent whose instructions are the thread's system prompt and
 * nothing else (EO-385).
 *
 * `codex.test.ts` and `providerParity.test.ts` show what EO writes: the
 * instructions as `baseInstructions` on `thread/start`, and a first turn
 * without them. Neither can show the two things that decided whether
 * that was safe to ship, because both are facts about the binary and the
 * model behind it:
 *
 * 1. **`baseInstructions` replaces the CLI's built-in prompt**, and that
 *    prompt might have been how the model learns its own tools. So the
 *    first test gives the agent EO's instructions alone and asks for the
 *    three things an EO agent has to be able to do: follow a rule that
 *    is written only in the instructions, change a file, and call a tool
 *    on EO's MCP server — the real `mcp/eoServer.mjs`, not a stand-in.
 *    If this ever fails on a new pin, the answer is not to move the
 *    instructions back into the user turn and not to switch quietly to
 *    `developerInstructions` (which keeps the CLI's prompt and puts EO's
 *    beside it): that is a different trade, and EO-385 left it to
 *    the person to choose.
 *
 * 2. **Nothing is sent on a resume.** `AgentProviderResumeOptions` has no
 *    instructions and `thread/resume` goes out without any, so a resumed
 *    turn is governed by them only if the app-server kept them with the
 *    thread. The second test resumes a thread and triggers a rule its
 *    first turn never exercised — so the answer cannot be the model
 *    copying its own earlier reply out of the history.
 *
 * Measured by hand at 0.161.0 before this was written, alongside one
 * thing these tests do not repeat: `thread/resume` accepts different
 * base instructions and applies them to that resumed turn only — the
 * next resume that sends none is governed by the originals again. Both
 * cases here passed again against 0.163.0 (EO-453) and 0.165.0 (EO-599);
 * that third reading was not re-taken, so it stands as measured at
 * 0.161.0.
 *
 * **Opt-in, because it spends real API credit on a real account.** Three
 * short turns, cents rather than dollars, and it needs `codex login`.
 * Skipped otherwise, so `pnpm test` and CI never reach it:
 *
 *     EO_LIVE_CODEX=1 EO_CODEX_BIN=<userData>/runtimes/codex@<pin>-<platform>/…/codex \
 *       pnpm exec vitest run --root apps/desktop src/main/providers/codexInstructions.live.test.ts
 *
 * `EO_CODEX_BIN` is the pinned binary EO downloads (A-08); without it,
 * whatever `codex` is on PATH is asked, which may not be the pin.
 */

const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";

/** The pinned binary if the caller names one, otherwise whatever is on PATH. */
const CODEX = process.env["EO_CODEX_BIN"] ?? "codex";

/** EO's own MCP service, the file both backends launch. Its `comment` tool needs no database, only a bridge to hand the comment to. */
const EO_SERVER = fileURLToPath(new URL("../mcp/eoServer.mjs", import.meta.url));

const workspaces: string[] = [];

afterEach(() => {
  for (const directory of workspaces.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "eo-codex-instructions-"));
  workspaces.push(directory);
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "pipe" });
  writeFileSync(join(directory, "README.md"), "# instructions\n");
  return directory;
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const said = (events: readonly AgentEvent[]): string => events.flatMap((event) => (event.type === "output" ? [event.text] : [])).join("\n");

describe.skipIf(!OPTED_IN)("a Codex agent under EO's instructions as the thread's base instructions", () => {
  it(
    "obeys a rule written only in the instructions, edits a file and calls an EO MCP tool",
    async () => {
      const cwd = repository();
      // Random, so neither can be guessed and neither is in the context.
      const header = `# EO-HOUSE-${Math.random().toString(36).slice(2, 10)}`;
      const signOff = `FINISHED-${Math.random().toString(36).slice(2, 10)}`;
      const instructions = [
        "You are an implementer working for EO, an application that dispatches coding agents. You work in the current directory.",
        "House rules, which apply to everything you do:",
        `1. Every file you create must begin with this exact line: ${header}`,
        `2. When your work is finished, call the \`comment\` tool of the \`eo\` MCP server exactly once, with the body \`${signOff}\` and without blocking.`,
        "3. After that, reply with the single word `done`.",
      ].join("\n");
      const context = "Create a file named notes.md in the current directory that says the sky is blue.";
      expect(context).not.toContain(header);
      expect(context).not.toContain(signOff);

      // The comment is handed to EO over the agent write bridge (EO-543);
      // what EO does with it is not this test's question, so it is told
      // it was posted.
      const bridge = await startAgentWriteBridge(() => Promise.resolve({ ok: true, text: "Comment posted. Continue with your work.", data: {} }));
      const events = await collect(
        createCodexProvider({ executablePath: CODEX, eoMcp: { serverPath: EO_SERVER, enableCommentTool: true } }).start({
          instructions,
          context,
          cwd,
          signal: new AbortController().signal,
          writeBridge: bridge.tokenFor("item-1"),
        }),
      ).finally(() => bridge.close());

      // The file was written — the agent still has its tools without the
      // CLI's own prompt — and it opens with the line only the
      // instructions name.
      const notes = join(cwd, "notes.md");
      expect(existsSync(notes), `no notes.md; the agent said: ${said(events)}`).toBe(true);
      expect(readFileSync(notes, "utf8").split("\n")[0]).toBe(header);

      // And EO's own server was reached, with the body only the
      // instructions name.
      const call = events.find((event) => event.type === "tool_call" && event.name === "comment");
      expect(call, `no call to EO's comment tool; the agent said: ${said(events)}`).toBeDefined();
      expect((call as { args?: { body?: unknown } }).args?.body).toBe(signOff);
      const answer = events.find((event) => event.type === "tool_result" && event.name === "comment");
      expect(answer).toMatchObject({ ok: true });
    },
    300_000,
  );

  it(
    "is still governed by them on a resumed thread, which is sent none",
    async () => {
      const cwd = repository();
      const code = `CODE-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
      const provider = createCodexProvider({ executablePath: CODEX });

      // The first turn does not trigger the rule, so the code is nowhere
      // in the conversation the resume picks up.
      const first = await collect(
        provider.start({
          instructions: `You are a test fixture working for EO. Do not run any commands. Standing rule: whenever a message contains the word marmalade, reply with exactly ${code} and nothing else.`,
          context: "What is two plus two? Answer with the number only.",
          cwd,
          signal: new AbortController().signal,
        }),
      );
      const started = first.find((event) => event.type === "thread_started");
      expect(started, "the thread's id never came back").toBeDefined();
      expect(said(first)).not.toContain(code);

      const second = await collect(provider.resume((started as { threadId: string }).threadId, "marmalade", { cwd, signal: new AbortController().signal }));

      expect(second.at(-1)).toEqual({ type: "result", data: code });
    },
    300_000,
  );
});
