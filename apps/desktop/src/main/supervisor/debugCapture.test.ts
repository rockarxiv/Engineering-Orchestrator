import { actionSchemaName, DEBUG_SENT_EVENT, DebugSentSchema, developerRegistry, type Agent, type AgentEvent, type AgentProvider, type DebugSent, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRoute, createStep, getItemType, listAgents, listCommentsForItem, listRunEvents, listRunsForItem, postComment, updateAgent } from "../db/repos/index.js";
import { getSetting, setSetting } from "../db/repos/settingsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { DEBUG_MODE_KEY, readDebugMode, writeDebugMode } from "../debug/debugMode.js";
import { BUILTIN_RUNNERS } from "../packs/developer/builtins.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { openAssistConversation } from "../roles/assist.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";

/**
 * Debug mode records what a provider was handed, and nothing when it is
 * off (EO-392).
 *
 * Driven through the real supervisor against an in-memory database, with
 * a provider that keeps the arguments it received — so every assertion
 * about "what was sent" compares the `run_events` row with what actually
 * crossed the provider boundary, rather than with what the test thinks
 * the context assembly produces.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const CWD = "/tmp/eo/debug-capture";

/** What the provider was handed, exactly. */
type Received = { kind: "start"; instructions: string; prompt: string; threadId: string } | { kind: "resume"; prompt: string; threadId: string };

let handle: DbHandle;
let systemAgent: Agent;
let received: Received[];
/** Makes the next stream's answer fail its schema, forcing a corrective turn on the same run. */
let malformNextResult: boolean;
/** Runs once, inside the next stream, before it answers. */
let duringNextTurn: (() => void) | null;

beforeEach(() => {
  handle = openMigratedTestDb();
  systemAgent = listAgents(handle.db).find((agent) => agent.role === "system")!;
  received = [];
  malformNextResult = false;
  duringNextTurn = null;
});

afterEach(() => {
  handle.close();
});

function keepingProvider(): AgentProvider {
  let counter = 0;
  function* answer(): Generator<AgentEvent> {
    duringNextTurn?.();
    duringNextTurn = null;
    if (malformNextResult) {
      malformNextResult = false;
      yield { type: "result", data: { thisFieldDoesNotExist: true } };
      return;
    }
    yield { type: "output", text: "thinking about it" };
    yield { type: "result", data: { message: "Noted." } };
  }
  return {
    async *start(opts): AsyncIterable<AgentEvent> {
      counter += 1;
      const threadId = `thread-${counter}`;
      received.push({ kind: "start", instructions: opts.instructions, prompt: opts.context, threadId });
      yield { type: "thread_started", threadId };
      yield* answer();
    },
    async *resume(threadId, message): AsyncIterable<AgentEvent> {
      received.push({ kind: "resume", prompt: message, threadId });
      yield* answer();
    },
  };
}

function supervisor() {
  // No `debugMode` override: the default reads the setting out of this
  // database at each send, which is the behaviour under test.
  return createRunSupervisor({ db: handle.db, provider: keepingProvider(), ...createRoleWiring(handle.db), kinds: kindsPreparing(CWD), limits: LIMITS });
}

function say(conversation: Item, body: string) {
  return postComment(handle.db, { itemId: conversation.id, author: { type: "human" }, body, mentions: [{ type: "agent", agentId: systemAgent.id }] });
}

/** Every `debug_sent` row of a run, parsed against the schema the window reads them with. */
function sentOn(runId: string): DebugSent[] {
  return listRunEvents(handle.db, runId as never)
    .filter((event) => event.type === DEBUG_SENT_EVENT)
    .map((event) => DebugSentSchema.parse(event.payload));
}

const runsOf = (conversation: Item) => listRunsForItem(handle.db, conversation.id);

describe("the setting", () => {
  it("is off by default, and persists under its own key", () => {
    expect(readDebugMode(handle.db)).toBe(false);

    expect(writeDebugMode(handle.db, true)).toBe(true);

    // Its own row, so nothing that writes the shared preference object
    // can reset it — and it survives a restart because it is in the
    // database rather than in a process.
    expect(getSetting<unknown>(handle.db, DEBUG_MODE_KEY, null)).toBe(true);
    expect(readDebugMode(handle.db)).toBe(true);
    expect(writeDebugMode(handle.db, false)).toBe(false);
  });

  it("reads anything that is not exactly true as off", () => {
    // This decides whether prompts are written down, so a row somebody
    // hand-edited into nonsense must read as "no".
    for (const junk of ["true", 1, {}]) {
      setSetting(handle.db, DEBUG_MODE_KEY, junk);
      expect(readDebugMode(handle.db)).toBe(false);
    }
  });
});

describe("a run dispatched with debug mode on", () => {
  beforeEach(() => {
    writeDebugMode(handle.db, true);
  });

  it("records the instructions and the prompt byte-for-byte as the provider received them", async () => {
    const conversation = openAssistConversation(handle.db, null);
    say(conversation, "How should we bill this? — naïve “quotes”, tabs\tand\r\nCRLF kept.");
    await supervisor().runOnce();

    const [run] = runsOf(conversation);
    const [sent] = sentOn(run!.id);
    const [got] = received;

    expect(got?.kind).toBe("start");
    expect(sent?.instructions).toEqual({ sent: true, text: got?.kind === "start" ? got.instructions : null });
    expect(sent?.prompt).toBe(got?.prompt);
    // And the prompt is the real assembly, not a stub's: it carries what
    // the person said, unaltered.
    expect(sent?.prompt).toContain("naïve “quotes”, tabs\tand\r\nCRLF kept.");
    expect(sent?.instructions.text).toBe(systemAgent.instructions);
  });

  it("is the first event of the run, ahead of anything the agent did", async () => {
    const conversation = openAssistConversation(handle.db, null);
    say(conversation, "About billing.");
    await supervisor().runOnce();

    const events = listRunEvents(handle.db, runsOf(conversation)[0]!.id);
    expect(events[0]?.type).toBe(DEBUG_SENT_EVENT);
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index));
    // The activity is still all there after it.
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["thread_started", "output", "result"]));
  });

  it("says a fresh thread is one, with the session it was opened in", async () => {
    const conversation = openAssistConversation(handle.db, null);
    say(conversation, "About billing.");
    await supervisor().runOnce();

    const [sent] = sentOn(runsOf(conversation)[0]!.id);
    expect(sent?.purpose).toBe("dispatch");
    expect(sent?.thread).toEqual({ mode: "new", threadId: null, refusal: null });
    expect(sent?.session.backend).toBe(systemAgent.provider);
    expect(sent?.session.cwd).toBe(CWD);
    expect(sent?.session.outputSchema).toBe("assist");
    // And the thread the backend then issued is on the run row, which is
    // where the window reads a new thread's id from.
    expect(runsOf(conversation)[0]?.threadId).toBe("thread-1");
  });

  it("says a resumed thread is one, names it, and records only the follow-up as the prompt", async () => {
    const conversation = openAssistConversation(handle.db, null);
    const engine = supervisor();
    say(conversation, "Rate limiting should be per API key.");
    await engine.runOnce();
    say(conversation, "And the free tier?");
    await engine.runOnce();

    const second = runsOf(conversation)[1]!;
    const [sent] = sentOn(second.id);
    const got = received[1];

    expect(got?.kind).toBe("resume");
    expect(sent?.thread).toEqual({ mode: "resumed", threadId: "thread-1", refusal: null });
    expect(sent?.prompt).toBe(got?.prompt);
    expect(sent?.prompt).toContain("And the free tier?");
    // The follow-up only: what the thread already holds is not sent
    // again, so it is not recorded as sent.
    expect(sent?.prompt).not.toContain("Rate limiting should be per API key.");
    // No instructions cross on a resume. The ones the thread keeps are
    // shown, and they are the ones it was started with.
    expect(sent?.instructions).toEqual({ sent: false, text: systemAgent.instructions });
  });

  it("records why a thread that existed was not reused", async () => {
    const conversation = openAssistConversation(handle.db, null);
    const engine = supervisor();
    say(conversation, "About billing.");
    await engine.runOnce();
    updateAgent(handle.db, systemAgent.id, { instructions: `${systemAgent.instructions}\n\nAlways ask about pricing.` });
    say(conversation, "And the free tier?");
    await engine.runOnce();

    const [sent] = sentOn(runsOf(conversation)[1]!.id);
    const posted = listCommentsForItem(handle.db, conversation.id).find((comment) => comment.authorType === "engine")?.body;

    expect(sent?.thread.mode).toBe("new");
    expect(sent?.thread.refusal).toContain("instructions have changed since its last run");
    // The same sentence the item was told, not a second account of it.
    expect(sent?.thread.refusal).toBe(posted);
    // And the edited instructions are what this fresh thread was sent.
    expect(sent?.instructions.text).toContain("Always ask about pricing.");
  });

  it("records a corrective turn as a further send on the same run", async () => {
    const conversation = openAssistConversation(handle.db, null);
    malformNextResult = true;
    say(conversation, "About billing.");
    await supervisor().runOnce();

    const sent = sentOn(runsOf(conversation)[0]!.id);
    expect(sent.map((send) => send.purpose)).toEqual(["dispatch", "correction"]);
    expect(sent[1]?.thread).toEqual({ mode: "resumed", threadId: "thread-1", refusal: null });
    expect(sent[1]?.prompt).toBe(received[1]?.prompt);
    expect(sent[1]?.prompt).toContain("Please return a corrected result that matches the schema.");
  });
});

describe("the output schema a send names", () => {
  it("is the schema the answer is held to, not the action, where a type overrides it", async () => {
    // `refine` is two actions under one name: pointed at work somebody
    // already wrote, the developer pack holds it to `clarify`. The
    // window's "Output schema" has to say which answer was asked for.
    writeDebugMode(handle.db, true);
    createStep(handle.db, { id: "plan", pipelineId: "default" as never, position: -1, name: "Refine", type: "agent", ownerRole: "system", entryAction: "refine" });
    createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "plan", resultKey: "clarified", label: "Clarified", target: "todo", position: 1 });
    const story = createTestItem(handle.db, { type: "story", title: "Rate limit the public API", body: "Return 429 after 100 requests.", stepId: "plan" });
    const wiring = createRoleWiring(handle.db);
    // The premise, asserted rather than assumed: this registry does
    // override the action for this type.
    expect(actionSchemaName(developerRegistry(), "refine", getItemType(handle.db, story.typeId)!)).toBe("clarify");

    await createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      kinds: kindsPreparing(CWD),
      provider: createScriptedProvider([{ when: () => true, script: { result: { ready: true, understanding: "Return 429 after 100 requests." } } }]),
      builtins: BUILTIN_RUNNERS,
      ...wiring,
    }).runOnce();

    const refine = listRunsForItem(handle.db, story.id).find((run) => run.action === "refine")!;
    expect(sentOn(refine.id)[0]?.session.outputSchema).toBe("clarify");
  });

  it("is the action's own name where nothing overrides it", async () => {
    writeDebugMode(handle.db, true);
    const conversation = openAssistConversation(handle.db, null);
    say(conversation, "About billing.");
    await supervisor().runOnce();

    expect(sentOn(runsOf(conversation)[0]!.id)[0]?.session.outputSchema).toBe("assist");
  });
});

describe("turning debug mode off mid-run", () => {
  it("stops recording at once: the corrective turn that follows is sent and not written down", async () => {
    writeDebugMode(handle.db, true);
    const conversation = openAssistConversation(handle.db, null);
    malformNextResult = true;
    // Switched off while the first stream is running, before the
    // corrective turn its malformed answer forces.
    duringNextTurn = () => void writeDebugMode(handle.db, false);
    say(conversation, "About billing.");
    await supervisor().runOnce();

    // The correction did go to the provider…
    expect(received.map((turn) => turn.kind)).toEqual(["start", "resume"]);
    const correction = received[1]!.prompt;
    expect(correction).toContain("Please return a corrected result that matches the schema.");

    // …and only the dispatch, sent while the switch was on, is recorded.
    const run = runsOf(conversation)[0]!;
    expect(sentOn(run.id).map((send) => send.purpose)).toEqual(["dispatch"]);
    // No prompt text stored while the setting is off, under any type.
    const stored = JSON.stringify(listRunEvents(handle.db, run.id).map((event) => event.payload));
    expect(stored).not.toContain(correction);
  });

  it("records the correction again if the switch is back on by the time it is sent", async () => {
    writeDebugMode(handle.db, true);
    const conversation = openAssistConversation(handle.db, null);
    malformNextResult = true;
    duringNextTurn = () => {
      writeDebugMode(handle.db, false);
      writeDebugMode(handle.db, true);
    };
    say(conversation, "About billing.");
    await supervisor().runOnce();

    expect(sentOn(runsOf(conversation)[0]!.id).map((send) => send.purpose)).toEqual(["dispatch", "correction"]);
  });
});

describe("a run dispatched with debug mode off", () => {
  it("stores no record of what was sent, and no prompt text anywhere in run_events", async () => {
    const conversation = openAssistConversation(handle.db, null);
    say(conversation, "A sentence that must not be written down: zebra-quartz-41.");
    await supervisor().runOnce();

    const [run] = runsOf(conversation);
    const events = listRunEvents(handle.db, run!.id);
    const [got] = received;

    expect(got?.prompt).toContain("zebra-quartz-41");
    expect(events.filter((event) => event.type === DEBUG_SENT_EVENT)).toEqual([]);
    const stored = JSON.stringify(events.map((event) => event.payload));
    expect(stored).not.toContain("zebra-quartz-41");
    expect(stored).not.toContain(systemAgent.instructions.slice(0, 80));
    // Its activity is recorded as it always was.
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["thread_started", "output", "result"]));
  });

  it("stays unrecorded for its whole life, even when the switch is turned on mid-run", async () => {
    const conversation = openAssistConversation(handle.db, null);
    malformNextResult = true;
    // Turned on while the first stream is running, before the corrective
    // turn the malformed answer forces.
    duringNextTurn = () => void writeDebugMode(handle.db, true);
    say(conversation, "About billing.");
    await supervisor().runOnce();

    expect(received.map((turn) => turn.kind)).toEqual(["start", "resume"]);
    expect(sentOn(runsOf(conversation)[0]!.id)).toEqual([]);
  });
});

describe("turning debug mode on", () => {
  it("applies to the next dispatch of a supervisor that is already running", async () => {
    const conversation = openAssistConversation(handle.db, null);
    const engine = supervisor();

    say(conversation, "First message, sent with it off.");
    await engine.runOnce();
    expect(sentOn(runsOf(conversation)[0]!.id)).toEqual([]);

    // The switch in Settings: a write to the setting, and nothing else.
    // The same supervisor, never rebuilt.
    writeDebugMode(handle.db, true);

    say(conversation, "Second message, sent with it on.");
    await engine.runOnce();
    const sent = sentOn(runsOf(conversation)[1]!.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.prompt).toContain("Second message, sent with it on.");

    // And off again stops it, for the dispatch after that.
    writeDebugMode(handle.db, false);
    say(conversation, "Third message.");
    await engine.runOnce();
    expect(sentOn(runsOf(conversation)[2]!.id)).toEqual([]);
  });
});
