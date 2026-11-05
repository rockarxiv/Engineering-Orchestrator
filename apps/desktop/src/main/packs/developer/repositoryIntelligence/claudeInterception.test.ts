import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@eo/core";
import { describe, expect, it } from "vitest";
import { createClaudeProvider } from "../../../providers/claude.js";
import { repositorySearchNudge } from "./broadSearch.js";

/**
 * The shipped classifier, delivered through the Claude adapter (EO-165,
 * EO-168, EO-173).
 *
 * These two describes were `providers/claude.test.ts`'s until KAN-126,
 * and are unchanged apart from the nudge being passed in: the adapter
 * used to import the classifier and now takes it as an option, so a
 * test that drives real commands through the hook and asserts the
 * sentences it says is wiring this directory's judgement into the
 * core's delivery. That is the pack testing itself through the core —
 * the direction the dependency runs — so the tests live here, and
 * `liftedFromPack.test.ts` keeps the classifier out of `providers/`.
 * What the adapter does with *any* nudge, and with none, stays beside
 * the adapter.
 *
 * The fakes below are the ones `claude.test.ts` uses, copied rather
 * than shared: a fixture module under `providers/` would be one more
 * thing for a pack to import from the core, for six functions.
 */

function init(sessionId = "sess_1"): SDKMessage {
  return { type: "system", subtype: "init", session_id: sessionId } as unknown as SDKMessage;
}

function assistant(content: unknown[]): SDKMessage {
  return { type: "assistant", message: { content }, session_id: "sess_1" } as unknown as SDKMessage;
}

/** The envelope a tool result arrives in: a user message of `tool_result` blocks. */
function toolResults(content: unknown[]): SDKMessage {
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "sess_1" } as unknown as SDKMessage;
}

function result(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    result: "done",
    total_cost_usd: 0.0234,
    usage: { input_tokens: 1200, output_tokens: 340 },
    session_id: "sess_1",
    ...overrides,
  } as unknown as SDKMessage;
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

function fakeQuery(messages: SDKMessage[]) {
  const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
  const runQuery = ((params: { prompt: unknown; options?: Record<string, unknown> }) => {
    calls.push({ prompt: params.prompt, options: params.options ?? {} });
    return (async function* () {
      for (const message of messages) yield message;
    })();
  }) as never;
  return { runQuery, calls };
}

const startOpts = { instructions: "You are the implementer.", context: "EO-1: do the thing", cwd: "/tmp/wt", signal: new AbortController().signal };

/**
 * The interception, as the adapter delivers it (EO-165).
 *
 * What is asserted here is the delivery and nothing else: that a hook
 * reaches the SDK, that it is EO's own rather than a file written
 * somewhere, that it answers without deciding anything, and that it is
 * absent entirely on a run with no index. Which *commands* it fires on
 * is `broadSearch.test.ts` — one classifier, one place it is pinned.
 */
const withAnswers = {
  name: "repo",
  command: "/opt/eo/index-tool",
  args: ["serve", "--mcp", "--path", "/tmp/wt", "--no-watch"],
  env: {},
  answers: { symbol: "idx_symbol", area: "idx_area", reach: ["idx_callers"], files: "idx_files" },
  /**
   * An index that holds whatever it is asked about (EO-173).
   *
   * Required now, not optional: a provider that names its tools without
   * offering a way to check them gets no hook at all, which is the case
   * below. What it *answers* is the classifier's business and is pinned
   * in `broadSearch.test.ts`; here it says yes so that these tests stay
   * about delivery, which is what this describe is for.
   */
  knows: async (question: { of: string; name?: string; pattern?: string }) => [
    { name: question.of === "symbol" ? (question.name ?? "") : "packages/engine/src/routing.ts", path: "packages/engine/src/routing.ts" },
    { name: question.of === "symbol" ? (question.name ?? "") : "apps/desktop/src/main/providers/claude.ts", path: "apps/desktop/src/main/providers/claude.ts" },
  ],
};

/**
 * The adapter as the composition root wires it (KAN-126): the classifier
 * is this directory's and arrives as an option, so these tests pass it
 * in exactly as `engine.ts` does. Without it there is no hook — which
 * is the adapter's own case, pinned in `providers/claude.test.ts`.
 */
const nudged = { searchNudge: repositorySearchNudge };

type Hooks = { PreToolUse?: { matcher?: string; hooks: ((input: unknown) => Promise<Record<string, unknown>>)[] }[] };

/** A `PreToolUse` payload shaped the way the CLI sends one. */
const preToolUse = (tool: string, input: unknown, callId = "toolu_1"): unknown => ({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: input,
  tool_use_id: callId,
  session_id: "sess_1",
  transcript_path: "/tmp/t.jsonl",
  cwd: "/tmp/wt",
});

describe("intercepting a broad search", () => {
  /** The one hook EO registers, or a failure that says so rather than a type error. */
  function onlyHook(options: Record<string, unknown>): (input: unknown) => Promise<Record<string, unknown>> {
    const hooks = options["hooks"] as Hooks | undefined;
    const matcher = hooks?.PreToolUse?.[0];
    expect(matcher, "EO registered no PreToolUse hook").toBeDefined();
    // Bash is the one that matters — EO-162 was 176 shell calls — and
    // the tidier doors are covered too.
    expect(matcher?.matcher).toBe("Bash|Grep|Glob");
    expect(matcher?.hooks).toHaveLength(1);
    return matcher?.hooks[0] as (input: unknown) => Promise<Record<string, unknown>>;
  }

  async function optionsFor(repositoryMcp: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    const { runQuery, calls } = fakeQuery([init()]);
    await collect(createClaudeProvider({ runQuery, ...nudged }).start({ ...startOpts, ...(repositoryMcp ? { repositoryMcp } : {}) } as never));
    return calls[0]?.options ?? {};
  }

  it("answers a repository-wide grep with the call that would answer it, and blocks nothing", async () => {
    const hook = onlyHook(await optionsFor(withAnswers));

    const answer = (await hook(preToolUse("Bash", { command: "grep -rn transitionItem ." }))) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      permissionDecision?: string;
    };

    expect(answer.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    // Named in the model's own spelling of a tool id, built from the
    // server's name and the provider's bare words.
    expect(answer.hookSpecificOutput?.additionalContext).toContain("mcp__repo__idx_symbol");
    expect(answer.hookSpecificOutput?.additionalContext).toContain("transitionItem");
    // Nothing that could stop the call. Blocking mode is deliberately
    // not built (EO-165), and this is where that would first show up.
    expect(answer).not.toHaveProperty("permissionDecision");
    expect(answer.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(answer).not.toHaveProperty("decision");
  });

  it("says nothing about the commands a run is mostly made of", async () => {
    const hook = onlyHook(await optionsFor(withAnswers));

    for (const command of ["pnpm test", "git status --porcelain", "cat packages/engine/src/routing.ts", "pnpm install"]) {
      expect(await hook(preToolUse("Bash", { command })), command).toEqual({});
    }
  });

  it("ignores an event that is not a tool call it was asked about", async () => {
    // The matcher is a filter, never the decision — a CLI that reads the
    // pattern differently changes what the hook is offered, not what it
    // says.
    const hook = onlyHook(await optionsFor(withAnswers));

    expect(await hook({ hook_event_name: "SessionStart", session_id: "s", transcript_path: "/tmp/t", cwd: "/tmp/wt" })).toEqual({});
    expect(await hook(preToolUse("Read", { file_path: "/tmp/wt/x.ts" }))).toEqual({});
  });

  it("registers no hook at all on a run with no index", async () => {
    // Every reason arrives the same way — feature off, no repository, no
    // binary, a build that failed — because all of them mean the
    // supervisor hands this turn no server.
    expect(await optionsFor(undefined)).not.toHaveProperty("hooks");
  });

  it("registers no hook when the index offered no vocabulary to name", async () => {
    // A server with nothing to suggest is silent rather than
    // approximate: naming tools EO guessed at would be worse than
    // saying nothing.
    const options = await optionsFor({ name: "repo", command: "/opt/eo/index-tool", args: [], env: {} });
    expect(options).not.toHaveProperty("hooks");
  });

  it("registers no hook when the index offered no way of being asked (EO-173)", async () => {
    // Vocabulary alone is not enough any more. A suggestion is only
    // worth making when EO has established the index can answer, so a
    // provider that cannot be asked does not get suggested unchecked —
    // and the absence is the same absence as every other reason: no
    // hook, not a hook that stays quiet.
    const withoutAsking: Record<string, unknown> = { ...withAnswers };
    delete withoutAsking["knows"];
    expect(await optionsFor(withoutAsking)).not.toHaveProperty("hooks");
  });

  it("says nothing when the index does not hold what the search was for (EO-173)", async () => {
    // The story's whole point, at the point where an agent would see it.
    // The command is a broad search and the classifier says so; the
    // index has never heard of the needle, so the agent hears nothing
    // and its grep runs.
    const hook = onlyHook(await optionsFor({ ...withAnswers, knows: async () => [] }));

    expect(await hook(preToolUse("Bash", { command: "grep -rn transitionItem ." }))).toEqual({});
  });

  it("says nothing rather than failing when asking the index throws (EO-173)", async () => {
    const hook = onlyHook(
      await optionsFor({
        ...withAnswers,
        knows: async () => {
          throw new Error("the index went away");
        },
      }),
    );

    // Not a rejected hook, and not a stalled tool call: an ordinary
    // empty answer, which is what every other absence in this feature
    // looks like.
    expect(await hook(preToolUse("Bash", { command: "grep -rn transitionItem ." }))).toEqual({});
  });

  it("says nothing about a path the index answered with (EO-173)", async () => {
    // What the index returns decides whether to speak and never becomes
    // part of what is said. The sentence is composed from the needle the
    // agent typed and the provider's own tool names, so a path out of
    // somebody's index cannot ride into the conversation on it.
    const hook = onlyHook(
      await optionsFor({
        ...withAnswers,
        knows: async () => [
          { name: "transitionItem", path: "packages/engine/src/secret-place.ts" },
          { name: "transitionItem", path: "apps/desktop/src/main/another-secret.ts" },
        ],
      }),
    );

    const answer = (await hook(preToolUse("Bash", { command: "grep -rn transitionItem ." }))) as {
      hookSpecificOutput?: { additionalContext?: string };
    };

    expect(answer.hookSpecificOutput?.additionalContext).toContain("transitionItem");
    expect(answer.hookSpecificOutput?.additionalContext).not.toContain("secret-place");
    expect(answer.hookSpecificOutput?.additionalContext).not.toContain("another-secret");
  });

  it("writes no configuration file to make any of this work", async () => {
    // The whole mechanism is an in-process callback. The alternative —
    // a `.claude/settings.json` in the worktree — also works and is
    // deliberately refused: that file is meant to be committed, so an
    // agent running `git add -A` would put EO's configuration on
    // somebody's default branch.
    const options = await optionsFor(withAnswers);
    const hooks = options["hooks"] as Hooks;
    expect(typeof hooks.PreToolUse?.[0]?.hooks[0]).toBe("function");
    // And the settings EO does read are still only the project's.
    expect(options["settingSources"]).toEqual(["project"]);
  });
});

/**
 * An interception as something the run can be shown to have done
 * (EO-168).
 *
 * The describe above proves the hook is delivered and says the right
 * thing. This one proves the *other* half, which is the half two
 * previous attempts at measuring this got wrong: that a firing reaches
 * EO's own log, so a run where the interception never fired can be told
 * from one where it fired and the agent grepped on regardless. Those two
 * were indistinguishable — a pile of shell calls either way — and they
 * need opposite fixes.
 *
 * Every case here drives the adapter end to end rather than calling the
 * hook by hand: a fake CLI that announces a tool call, runs EO's hook
 * before it, and carries on. What the stream yields is what the
 * supervisor appends to `run_events`, unchanged.
 */
describe("recording an interception", () => {
  /**
   * A turn in which the agent makes calls and the CLI runs EO's hook
   * before each, which is the order the real one uses: the assistant
   * message announcing a `tool_use` has already been sent when
   * `PreToolUse` fires.
   */
  function agentQuery(script: { tool: string; input: unknown }[][], withResults = false) {
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const runQuery = ((params: { prompt: unknown; options?: Record<string, unknown> }) => {
      const options = params.options ?? {};
      calls.push({ prompt: params.prompt, options });
      const hook = (options["hooks"] as Hooks | undefined)?.PreToolUse?.[0]?.hooks[0];
      return (async function* () {
        yield init();
        let nextId = 0;
        for (const batch of script) {
          // Ids are the backend's, one per call and unique across the
          // turn, which is what makes two identical searches two calls.
          const ids = batch.map(() => `toolu_${++nextId}`);
          yield assistant(batch.map((call, at) => ({ type: "tool_use", id: ids[at], name: call.tool, input: call.input })));
          // Then the CLI runs the hook for each call, in the order the
          // blocks were sent, before executing any of them.
          for (const [at, call] of batch.entries()) {
            // No hook at all is the shape of a run with no index: the
            // CLI has nothing to call, so nothing here calls anything.
            if (hook) await hook(preToolUse(call.tool, call.input, ids[at]));
          }
          // And only then does the tool run and answer (EO-169).
          if (withResults) {
            yield toolResults(ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "…" })));
          }
        }
        yield result();
      })();
    }) as never;
    return { runQuery, calls };
  }

  /** One call per assistant message — the ordinary, sequential shape. */
  const oneAtATime = (script: { tool: string; input: unknown }[]) => script.map((call) => [call]);

  // `null` for "this run was handed no index", never `undefined` — an
  // omitted argument takes the default, which would quietly turn the
  // no-index case into the with-index one.
  const eventsForBatches = async (
    script: { tool: string; input: unknown }[][],
    repositoryMcp: Record<string, unknown> | null = withAnswers,
  ): Promise<AgentEvent[]> => {
    const { runQuery } = agentQuery(script);
    return collect(
      createClaudeProvider({ runQuery, ...nudged }).start({ ...startOpts, ...(repositoryMcp ? { repositoryMcp } : {}) } as never),
    );
  };

  const eventsFor = async (
    script: { tool: string; input: unknown }[],
    repositoryMcp: Record<string, unknown> | null = withAnswers,
  ): Promise<AgentEvent[]> => eventsForBatches(oneAtATime(script), repositoryMcp);

  const interceptions = (events: AgentEvent[]) => events.filter((event) => event.type === "search_interception");

  it("appends an interception naming the call that triggered it and what was suggested", async () => {
    const events = await eventsFor([{ tool: "Bash", input: { command: "grep -rn transitionItem ." } }]);

    expect(interceptions(events)).toEqual([
      {
        type: "search_interception",
        tool: "Bash",
        callId: "toolu_1",
        kind: "symbol",
        needle: "transitionItem",
        suggestion: expect.stringContaining("mcp__repo__idx_symbol"),
      },
    ]);
  });

  it("puts it after the call it is about and before the next one, so the two line up", async () => {
    // Ordering is the whole reason this is worth recording at all: the
    // question the log has to answer is what the agent did *next*, and
    // an interception filed after the calls that followed it cannot be
    // read that way. One call per message here, which is the ordinary
    // shape and the one where the interception is genuinely adjacent.
    const events = await eventsFor([
      { tool: "Bash", input: { command: "pnpm test" } },
      { tool: "Bash", input: { command: "rg transitionItem apps packages" } },
      { tool: "Bash", input: { command: "cat packages/engine/src/routing.ts" } },
    ]);

    expect(events.filter((event) => event.type === "tool_call" || event.type === "search_interception")).toEqual([
      { type: "tool_call", callId: "toolu_1", name: "Bash", args: { command: "pnpm test" } },
      { type: "tool_call", callId: "toolu_2", name: "Bash", args: { command: "rg transitionItem apps packages" } },
      expect.objectContaining({ type: "search_interception", needle: "transitionItem", callId: "toolu_2" }),
      { type: "tool_call", callId: "toolu_3", name: "Bash", args: { command: "cat packages/engine/src/routing.ts" } },
    ]);
  });

  it("keeps two parallel identical searches apart, which nothing about the text can", async () => {
    // The case that breaks every correlation built out of ordering and
    // content. A model can ask for several tools in one message, so both
    // `tool_call`s are emitted before either hook has run, and when the
    // two commands are character-for-character identical their
    // interceptions are identical too — same tool, same kind, same
    // needle, same sentence. Adjacency is gone and the text names the
    // pair rather than either one.
    //
    // The backend's own call id is what survives that: two ids, so two
    // calls, each nudged once. Without it the same log would be equally
    // consistent with one call having been intercepted twice, which is
    // an inflated count nobody could see.
    const search = { tool: "Bash", input: { command: "grep -rn transitionItem ." } };
    const events = await eventsForBatches([[search, search]]);

    expect(events.filter((event) => event.type === "tool_call" || event.type === "search_interception")).toEqual([
      { type: "tool_call", callId: "toolu_1", name: "Bash", args: { command: "grep -rn transitionItem ." } },
      { type: "tool_call", callId: "toolu_2", name: "Bash", args: { command: "grep -rn transitionItem ." } },
      expect.objectContaining({ type: "search_interception", callId: "toolu_1", needle: "transitionItem" }),
      expect.objectContaining({ type: "search_interception", callId: "toolu_2", needle: "transitionItem" }),
    ]);
  });

  it("lands between the call it interrupted and what that call returned", async () => {
    // Where it belongs, and where the merge with EO-169 puts it for
    // free: the agent was told before the tool ran, so the transcript
    // reads call, nudge, answer. Worth pinning rather than assuming —
    // the drain happens at a message boundary, and the boundary that
    // matters here is the one carrying the tool's reply.
    const { runQuery } = agentQuery([[{ tool: "Bash", input: { command: "grep -rn transitionItem ." } }]], true);
    const events = await collect(
      createClaudeProvider({ runQuery, ...nudged }).start({ ...startOpts, repositoryMcp: withAnswers } as never),
    );

    expect(events.map((event) => event.type)).toEqual([
      "thread_started",
      "tool_call",
      "search_interception",
      "tool_result",
      "usage",
      "result",
    ]);
    // And all three name the same call, which is the join the whole
    // round was about.
    const ids = events.flatMap((event) =>
      event.type === "tool_call" || event.type === "tool_result" || event.type === "search_interception" ? [event.callId] : [],
    );
    expect(ids).toEqual(["toolu_1", "toolu_1", "toolu_1"]);
  });

  it("joins every interception to the one recorded call it fired on", async () => {
    // The property the ids exist for, asserted as a join rather than as
    // two values that merely differ. A batch of four parallel calls, two
    // of which are the same search word for word: matching them up by
    // content would pair either interception with either grep, and
    // matching them up by position would pair the second interception
    // with the `cat` that was never intercepted at all.
    const events = await eventsForBatches([
      [
        { tool: "Bash", input: { command: "grep -rn transitionItem ." } },
        { tool: "Bash", input: { command: "cat packages/core/src/execution.ts" } },
        { tool: "Bash", input: { command: "grep -rn transitionItem ." } },
        { tool: "Bash", input: { command: "find . -name '*.test.ts'" } },
      ],
    ]);

    const callsById = new Map(
      events.flatMap((event) => (event.type === "tool_call" && event.callId !== undefined ? [[event.callId, event] as const] : [])),
    );
    expect(callsById.size).toBe(4);

    // Every firing finds its own call, and the call it finds is one the
    // classifier would have fired on.
    const joined = events
      .filter((event) => event.type === "search_interception")
      .map((event) => ({ needle: event.needle, command: (callsById.get(event.callId ?? "")?.args as { command?: string })?.command }));

    expect(joined).toEqual([
      { needle: "transitionItem", command: "grep -rn transitionItem ." },
      { needle: "transitionItem", command: "grep -rn transitionItem ." },
      { needle: "*.test.ts", command: "find . -name '*.test.ts'" },
    ]);
    // Distinct calls, not one call joined to twice — the two greps are
    // `toolu_1` and `toolu_3`, and the `cat` between them is joined to
    // by nothing.
    const ids = events.filter((event) => event.type === "search_interception").map((event) => event.callId);
    expect(ids).toEqual(["toolu_1", "toolu_3", "toolu_4"]);
  });

  it("keeps a batch in its own calls' order, and ahead of the next message's calls", async () => {
    // The weaker guarantee that does hold for parallel calls, stated so
    // that a change which breaks it fails here rather than in somebody's
    // analysis months later: a batch's interceptions follow that batch,
    // in the calls' order, and never cross a later message's calls.
    const events = await eventsForBatches([
      [
        { tool: "Bash", input: { command: "grep -rn transitionItem ." } },
        { tool: "Bash", input: { command: "cat packages/core/src/execution.ts" } },
        { tool: "Bash", input: { command: "find . -name '*.test.ts'" } },
      ],
      [{ tool: "Bash", input: { command: "rg RunEvent apps packages" } }],
    ]);

    expect(
      events
        .filter((event) => event.type === "tool_call" || event.type === "search_interception")
        .map((event) => (event.type === "tool_call" ? `call ${String((event.args as { command: string }).command)}` : `nudge ${String(event.callId)}`)),
    ).toEqual([
      "call grep -rn transitionItem .",
      "call cat packages/core/src/execution.ts",
      "call find . -name '*.test.ts'",
      // The batch's two firings, in the order its calls were made — the
      // `cat` between them was not intercepted and so appears here not
      // at all.
      "nudge toolu_1",
      "nudge toolu_3",
      "call rg RunEvent apps packages",
      "nudge toolu_4",
    ]);
  });

  it("records a firing that nothing followed, at the end of the turn", async () => {
    // The last search of a run has no message after it to be flushed
    // by, and it is precisely the one worth counting: an agent that was
    // nudged and then stopped took the suggestion nowhere.
    const events = await eventsFor([{ tool: "Bash", input: { command: "ls -R" } }]);

    expect(interceptions(events)).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("result");
  });

  // ── The two worlds, which is the point of the whole story ──────────

  it("records nothing on a run where the interception never fired", async () => {
    // Every reason arrives the same way — feature off, no repository, no
    // binary, an index that failed to build — because all of them mean
    // this turn was handed no server, and no server means no hook for
    // the CLI to call. A count of zero on this run is the honest answer
    // and it is a wiring question, not a persuasion one.
    const events = await eventsFor(
      [
        { tool: "Bash", input: { command: "grep -rn transitionItem ." } },
        { tool: "Bash", input: { command: "find . -name '*.test.ts'" } },
      ],
      null,
    );

    expect(interceptions(events)).toEqual([]);
    // And the searches themselves are still on the record, which is what
    // makes the zero readable rather than merely empty.
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(2);
  });

  it("records one per firing on a run where it fired and the agent went on searching", async () => {
    // The other world, and the one the old evidence could not tell from
    // the one above: EO spoke three times and the agent kept grepping.
    // Same shell calls, opposite diagnosis.
    const events = await eventsFor([
      { tool: "Bash", input: { command: "grep -rn transitionItem ." } },
      { tool: "Bash", input: { command: "grep -rn transitionItem ." } },
      { tool: "Bash", input: { command: "rg RunEvent apps packages" } },
      { tool: "Bash", input: { command: "cat packages/core/src/execution.ts" } },
    ]);

    expect(interceptions(events)).toHaveLength(3);
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(4);
  });

  it("says nothing about the calls a run is mostly made of", async () => {
    const events = await eventsFor([
      { tool: "Bash", input: { command: "pnpm typecheck" } },
      { tool: "Bash", input: { command: "git status --porcelain" } },
      { tool: "Read", input: { file_path: "/tmp/wt/packages/core/src/execution.ts" } },
    ]);

    expect(interceptions(events)).toEqual([]);
  });

  it("carries the agent's own words and nothing read off the disk", async () => {
    // The hook fires *before* the search runs, so there is no output to
    // carry — but the rule is worth pinning rather than inferring: the
    // payload is four fields, and the only free text in it is a sentence
    // EO composed plus the needle the agent typed, which the `tool_call`
    // beside it already records verbatim.
    const [interception] = interceptions(
      await eventsFor([{ tool: "Grep", input: { pattern: "transitionItem", output_mode: "content" } }]),
    );

    expect(Object.keys(interception ?? {}).sort()).toEqual(["callId", "kind", "needle", "suggestion", "tool", "type"]);
    expect(interception).toMatchObject({ tool: "Grep", kind: "symbol", needle: "transitionItem" });
  });

  it("counts a resumed turn's firings as that turn's own", async () => {
    // A resume spawns the CLI again and gets its own hook, so the queue
    // has to be the turn's rather than the provider's — a shared one
    // would file this run's interceptions under the run before it.
    const { runQuery } = agentQuery(oneAtATime([{ tool: "Bash", input: { command: "grep -rn transitionItem ." } }]));
    const provider = createClaudeProvider({ runQuery, ...nudged });

    const first = await collect(provider.start({ ...startOpts, repositoryMcp: withAnswers } as never));
    const second = await collect(provider.resume("sess_1", "carry on", { cwd: "/tmp/wt", repositoryMcp: withAnswers } as never));

    expect(interceptions(first)).toHaveLength(1);
    expect(interceptions(second)).toHaveLength(1);
  });
});
