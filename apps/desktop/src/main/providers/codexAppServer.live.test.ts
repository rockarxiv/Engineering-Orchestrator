import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@eo/core";
import { createCodexProvider } from "./codex.js";

/**
 * A real thread over `codex app-server`, started and then resumed
 * (EO-372).
 *
 * The unit tests run the client against a stand-in server
 * (`codexClient.test.ts`), which shows what EO writes and how it reads
 * what comes back — and nothing about whether the real binary agrees.
 * This asks the binary: a thread opened with a strict output schema
 * answers in that shape, its id comes back, and resuming that id
 * carries the conversation on, answering in the shape again.
 *
 * **Opt-in, because it spends real API credit on a real account.** Two
 * short turns, cents rather than dollars, and it needs `codex login`.
 * Skipped otherwise, so `pnpm test` and CI never reach it:
 *
 *     EO_LIVE_CODEX=1 EO_CODEX_BIN=<userData>/runtimes/codex@<pin>-<platform>/…/codex \
 *       pnpm exec vitest run --root apps/desktop src/main/providers/codexAppServer.live.test.ts
 *
 * `EO_CODEX_BIN` is the pinned binary EO downloads (A-08); without it,
 * whatever `codex` is on PATH is asked, which may not be the pin.
 */

const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";

/** The pinned binary if the caller names one, otherwise whatever is on PATH. */
const CODEX = process.env["EO_CODEX_BIN"] ?? "codex";

const SCHEMA = {
  type: "object",
  properties: { word: { type: "string" } },
  required: ["word"],
  additionalProperties: false,
};

let workspace: string | null = null;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe.skipIf(!OPTED_IN)("a Codex thread over the pinned app-server", () => {
  it(
    "starts a thread, resumes it by id, and answers in the schema's shape both times",
    async () => {
      workspace = mkdtempSync(join(tmpdir(), "eo-codex-app-server-"));
      // A real repository, because code-bearing roles keep the check on.
      execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "pipe" });
      writeFileSync(join(workspace, "README.md"), "# app-server\n");

      const unmapped: string[] = [];
      const provider = createCodexProvider({
        executablePath: CODEX,
        onUnmappedEvent: (event) => unmapped.push("method" in event ? event.method : event.type),
      });

      const first = await collect(
        provider.start({
          instructions: "You are a test fixture. Do not run any commands.",
          context: "Choose the word `pineapple` and reply with it as `word`.",
          cwd: workspace,
          outputSchema: SCHEMA,
          signal: new AbortController().signal,
        }),
      );
      const started = first.find((event) => event.type === "thread_started");
      expect(started, "the thread's id never came back").toBeDefined();
      const threadId = (started as { threadId: string }).threadId;
      expect(first.at(-1)).toEqual({ type: "result", data: { word: "pineapple" } });
      expect(first.some((event) => event.type === "usage" && event.tokensIn > 0), "the turn reported no tokens").toBe(true);

      const second = await collect(
        provider.resume(threadId, "Reply with the word you chose in your previous answer, as `word` again.", {
          cwd: workspace,
          outputSchema: SCHEMA,
          signal: new AbortController().signal,
        }),
      );
      // With the model `thread/resume` answered with (EO-392), which this
      // assertion predated: it failed on that alone at EO-453's bump.
      expect(second.find((event) => event.type === "thread_started")).toEqual({ type: "thread_started", threadId, model: expect.any(String) });
      // The conversation came with the id: the resumed turn knows the word.
      expect(second.at(-1)).toEqual({ type: "result", data: { word: "pineapple" } });

      expect(unmapped, `unmapped events and notifications: ${unmapped.join(", ")}`).toEqual([]);
    },
    300_000,
  );
});

/**
 * The two controls EO-373 wired, against the real binary.
 *
 * `codex.test.ts` shows what EO writes for `turn/steer` and
 * `turn/interrupt` and how it reads what comes back, against a stand-in.
 * Whether the real app-server *does* anything with them is the half only
 * it can answer: that a message said mid-turn reaches the turn that is
 * running and changes how it ends, and that an interrupted turn still
 * reports what it spent. Measured by hand at 0.161.0 before this was
 * written — the steered turn answered `pineapple`, the interrupted one
 * ended `interrupted` with its token reading already sent — and both
 * cases passed again against 0.163.0 (EO-453) and 0.165.0 (EO-599).
 *
 * The turn is held open by a command the agent is asked to run, so there
 * is a turn to speak into: the model is told to wait, then answer with a
 * word it is given, or `banana` if it is given none. Same opt-in, same
 * cost: two short turns.
 */
describe.skipIf(!OPTED_IN)("speaking to and interrupting a Codex turn over the pinned app-server", () => {
  const HOLD = "Run the shell command `sleep 12`, and only once it has finished, reply with exactly one word as `word`: the word I tell you, or `banana` if I tell you nothing.";
  /** Two commands, one after the other: the first completes, and the turn is interrupted while it is still going. */
  const TWO_STEPS = "Run the shell command `echo first`. Then, as a separate command, run `sleep 30`. Only after both, reply with the word `banana` as `word`.";

  function repository(): string {
    workspace = mkdtempSync(join(tmpdir(), "eo-codex-app-server-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "pipe" });
    writeFileSync(join(workspace, "README.md"), "# app-server\n");
    return workspace;
  }

  it(
    "takes a message into the running turn, and the turn's answer is the one it was told",
    async () => {
      const cwd = repository();
      const stream = createCodexProvider({ executablePath: CODEX }).start({
        instructions: "You are a test fixture.",
        context: HOLD,
        cwd,
        outputSchema: SCHEMA,
        signal: new AbortController().signal,
      });

      // Said beside the stream, as a person's message is, a few seconds
      // into the turn — while the command holds it open.
      let steering: Promise<boolean> | undefined;
      const events: AgentEvent[] = [];
      for await (const event of stream) {
        events.push(event);
        if (event.type === "thread_started") {
          steering = new Promise((resolve) => setTimeout(resolve, 6_000)).then(() => stream.steer?.("The word is pineapple.") ?? false);
        }
      }

      expect(await steering, "the app-server did not take the message into the turn").toBe(true);
      // Without the message this turn answers `banana`.
      expect(events.at(-1)).toEqual({ type: "result", data: { word: "pineapple" } });
    },
    300_000,
  );

  it(
    "ends the turn when interrupted, and still reports the tokens it spent",
    async () => {
      const cwd = repository();
      const stream = createCodexProvider({ executablePath: CODEX }).start({
        instructions: "You are a test fixture.",
        context: TWO_STEPS,
        cwd,
        outputSchema: SCHEMA,
        signal: new AbortController().signal,
      });

      // Where the supervisor interrupts: straight after a call the agent
      // made has come back — an escalation is a completed call to EO's
      // own `comment` tool. Awaited inside the loop, as the supervisor
      // awaits it.
      const events: AgentEvent[] = [];
      let interrupted = false;
      for await (const event of stream) {
        events.push(event);
        if (event.type === "tool_result" && !interrupted) {
          interrupted = true;
          await stream.interrupt?.();
        }
      }

      expect(events.some((event) => event.type === "error" && event.message === "Codex turn interrupted"), "the turn was not interrupted").toBe(true);
      expect(events.some((event) => event.type === "usage" && event.tokensIn > 0), "the interrupted turn reported no tokens").toBe(true);
      expect(events.some((event) => event.type === "result" && JSON.stringify(event.data).includes("banana"))).toBe(false);
    },
    300_000,
  );
});
