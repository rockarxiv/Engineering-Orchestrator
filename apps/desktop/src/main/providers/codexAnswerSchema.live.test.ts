import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { developerRegistry, outputSchemaFor, validateActionResult, type AgentEvent } from "@eo/core";
import { createCodexProvider } from "./codex.js";

/**
 * The real `assist` answer schema, taken by the real API (EO-387).
 *
 * `codex.test.ts` holds every action's schema to OpenAI's strict subset
 * as EO understands it, and `providerParity.test.ts` holds both adapters
 * to "every answer schema is sendable". Both are EO's reading of a rule
 * somebody else enforces, and v0.7.0 is what a wrong reading costs:
 * every `assist` turn on Codex refused with `invalid_json_schema` before
 * the model ran, on a schema every unit test passed.
 *
 * So this asks the one party that knows. Two turns of `assist`, with the
 * schema exactly as the supervisor hands it to the adapter:
 *
 * 1. **An ordinary turn gets an answer, not a 400.** The refusal arrives
 *    as a fatal error before any output, so an answer at all is the
 *    proof the schema was taken.
 *
 * 2. **A map is still something a Codex agent can set.** Taking the
 *    schema is not the fix on its own — the cheap way to be accepted is
 *    to drop the keyword and leave an object nothing can be put in. The
 *    second turn asks for a draft whose new step sets one input, and
 *    reads it back out of the validated answer as the map a Claude agent
 *    would have written.
 *
 * If the first fails on a new pin with `invalid_json_schema`, the
 * message names the keyword and the path: that keyword comes off the
 * allowlist in `testing/answerSchemas.ts`, which then fails for every
 * schema carrying it, and the adapter's `normalizeSchemaNode` is where it
 * is dealt with.
 *
 * **Opt-in, because it spends real API credit on a real account.** Two
 * short turns with no tools, cents rather than dollars, and it needs
 * `codex login`. Skipped otherwise, so `pnpm test` and CI never reach it:
 *
 *     EO_LIVE_CODEX=1 EO_CODEX_BIN=<userData>/runtimes/codex@<pin>-<platform>/…/codex \
 *       pnpm exec vitest run --root apps/desktop src/main/providers/codexAnswerSchema.live.test.ts
 *
 * `EO_CODEX_BIN` is the pinned binary EO downloads (A-08); without it,
 * whatever `codex` is on PATH is asked, which may not be the pin.
 */

const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";

/** The pinned binary if the caller names one, otherwise whatever is on PATH. */
const CODEX = process.env["EO_CODEX_BIN"] ?? "codex";

const registry = developerRegistry();
const ASSIST_SCHEMA = outputSchemaFor(registry, "assist")!;

const workspaces: string[] = [];

afterEach(() => {
  for (const directory of workspaces.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "eo-codex-answer-schema-"));
  workspaces.push(directory);
  return directory;
}

async function assistTurn(context: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const stream = createCodexProvider({ executablePath: CODEX }).start({
    instructions: [
      "You are the assistant inside EO, an application that moves work through pipelines of steps.",
      "You answer in the structured shape you are given. Do not run commands and do not read files: answer from what you are told.",
    ].join("\n"),
    context,
    cwd: workspace(),
    outputSchema: ASSIST_SCHEMA,
    signal: new AbortController().signal,
  });
  for await (const event of stream) events.push(event);
  return events;
}

/** Every error the turn raised that would end a run, in the backend's own words. */
const fatal = (events: readonly AgentEvent[]): string[] => events.flatMap((event) => (event.type === "error" && event.fatal !== false ? [event.message] : []));

function answerOf(events: readonly AgentEvent[]): unknown {
  expect(fatal(events), "the turn was refused").toEqual([]);
  const result = events.find((event) => event.type === "result");
  expect(result, `no answer; the turn's events were ${events.map((event) => event.type).join(", ")}`).toBeDefined();
  return result?.type === "result" ? result.data : undefined;
}

describe.skipIf(!OPTED_IN)("the real assist answer schema on a real Codex turn", () => {
  it(
    "gets an answer, not a 400",
    async () => {
      const answer = answerOf(await assistTurn("The person asks: what is a pipeline step? Answer in one sentence, and propose nothing."));

      const validated = validateActionResult(registry, "assist", answer);
      expect(validated.ok ? null : validated.error).toBeNull();
      expect(validated.ok && typeof (validated.value as { message: unknown }).message).toBe("string");
    },
    300_000,
  );

  it(
    "lets the agent set a new step's inputs, which arrive as the map",
    async () => {
      const answer = answerOf(
        await assistTurn(
          [
            "The person asks for a pipeline draft. Return exactly this draft and ask no questions:",
            "- target: a new pipeline named `Release`.",
            "- rationale: `Merging waits for CI.`; entryStepId: `merge`.",
            "- step `merge`: position 0, name `Merge`, type `module`, no owner role, no entry action, no instructions summary, not terminal, not plan mode,",
            "  with a time limit of 3480000 milliseconds and its inputs set to: ciWaitSeconds = 2400 (a number) and branch = main (a string).",
            "- step `done`: position 1, name `Done`, type `user`, no owner role, no entry action, no instructions summary, terminal, not plan mode, with no time limit and no inputs.",
            "- one route: from `merge`, result key `merged`, label `Merged`, tone `success`, target `done`, position 0.",
            "Propose no modules and no items.",
          ].join("\n"),
        ),
      );

      const validated = validateActionResult(registry, "assist", answer);
      expect(validated.ok ? null : validated.error).toBeNull();
      if (!validated.ok) return;
      const steps = (validated.value as { draft?: { steps: { id: string; inputs?: unknown; timeoutMs?: unknown }[] } }).draft?.steps ?? [];
      const merge = steps.find((step) => step.id === "merge");
      expect(merge?.inputs).toEqual({ ciWaitSeconds: 2400, branch: "main" });
      expect(merge?.timeoutMs).toBe(3_480_000);
      // The step that was given none has none — not an empty map, and
      // not the null the strict schema made it write.
      expect(steps.find((step) => step.id === "done")).not.toHaveProperty("inputs");
    },
    300_000,
  );
});
