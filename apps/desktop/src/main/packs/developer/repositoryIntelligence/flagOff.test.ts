import type { Agent, AgentProvider, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { listAgents, listRunEvents, listRunsForItem, updateAgent } from "../../../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { providerForAgent } from "../../../engine.js";
import { createRunSupervisor } from "../../../supervisor/runSupervisor.js";
import { validImplementResult } from "../../../providers/fixtures.js";
import { createDispatchGate } from "../scheduling.js";
import { readRepositoryIntelligenceConfig, writeRepositoryIntelligenceConfig } from "./gate.js";

/**
 * What a dispatch looks like with the flag off (EO-141, EO-148).
 *
 * The rollout promise this feature is shipping on is that a build
 * carrying all of it behaves, until somebody says otherwise, exactly
 * like a build carrying none of it: no binary fetched, no index built,
 * no MCP server injected, no extra process, no new run events. That
 * promise is worth as much as the test that checks it, and "we looked
 * and did not see one" is not a test — so this pins the three sets a
 * leak would show up in and asserts each of them exactly.
 *
 * It is written now, before there is anything to leak, on purpose. An
 * assertion added after the code it constrains has to be argued for
 * against working software; this one is here to fail the first time a
 * later story does its work unconditionally.
 *
 * **How the observation points were chosen.** Each is where the thing
 * being watched for would actually appear:
 *
 * - the MCP server set, as the options the backend is handed. EO-141
 *   settles that the index reaches an agent as a second EO-owned stdio
 *   server "injected the way `eo` already is" — and `eo` is injected in
 *   `buildProvider`, materialising in `options.mcpServers`. So the
 *   dispatch runs through `providerForAgent`, the production builder,
 *   rather than through a provider this file assembled: a server added
 *   there is a server this test can see.
 * - the subprocesses, as every entry point in `node:child_process`. A
 *   provider spawning an indexer, and a downloader shelling out, both
 *   land here.
 * - the network, as `fetch`. That is the seam `runtimes/install.ts`
 *   fetches through, and the binary fetcher is specified as a sibling
 *   of it.
 * - the run events, as the rows. Append-only and the durability
 *   substrate, so anything that ran and reported itself is in them.
 *
 * The SDK is mocked rather than the provider, so everything between the
 * supervisor and the backend's front door is the real code.
 */

const sdk = vi.hoisted(() => ({
  calls: [] as { options: Record<string, unknown> }[],
  messages: [] as unknown[],
}));

vi.mock("../../../providers/claudeSdk.js", () => ({
  loadClaudeSdk: () =>
    Promise.resolve({
      query: (params: { prompt: unknown; options?: Record<string, unknown> }) => {
        sdk.calls.push({ options: params.options ?? {} });
        return (async function* () {
          for (const message of sdk.messages) yield message;
        })();
      },
      tool: () => ({}),
      createSdkMcpServer: () => ({}),
    }),
  ClaudeSdkMissing: class ClaudeSdkMissing extends Error {},
}));

/** Every way this codebase can start a process, recorded rather than blocked. */
const spawned = vi.hoisted(() => [] as string[]);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const record = <T extends (...args: never[]) => unknown>(name: string, real: T) =>
    ((...args: never[]) => {
      spawned.push(`${name} ${String(args[0])}`);
      return real(...args);
    }) as T;
  return {
    ...actual,
    spawn: record("spawn", actual.spawn),
    spawnSync: record("spawnSync", actual.spawnSync),
    exec: record("exec", actual.exec),
    execFile: record("execFile", actual.execFile),
    execSync: record("execSync", actual.execSync),
    fork: record("fork", actual.fork),
  };
});

let handle: DbHandle;
let item: Item;
let implementer: Agent;
let fetched: string[];

/**
 * Every provider a dispatch was handed, in order, with the agent it was
 * built for.
 *
 * The agent id is not decoration: a second `runOnce` may well dispatch a
 * different role, and a comparison that ignored which agent it was
 * looking at would "prove" a rebuild by comparing the implementer's
 * provider with the reviewer's. It did, until this field existed.
 */
const handedOut: { agentId: string; provider: AgentProvider }[] = [];

const EO_MCP_SERVER_PATH = "/app/resources/eoServer.mjs";
const DB_PATH = "/home/somebody/.eo/eo.db";
const RUNTIME_ROOT = "/home/somebody/.eo/runtimes";

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  const seeded = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  // A real backend rather than the seeded fake one: what an agent is
  // handed is assembled by the provider adapter, and a fake provider
  // assembles nothing — a server could appear beside `eo` all day
  // without such a test noticing.
  updateAgent(handle.db, seeded.id, { provider: "claude" });
  implementer = listAgents(handle.db).find((agent) => agent.id === seeded.id)!;

  sdk.calls.length = 0;
  sdk.messages = [
    { type: "system", subtype: "init", session_id: "sess_1" },
    { type: "assistant", message: { content: [{ type: "text", text: "Reading the ticket." }] }, session_id: "sess_1" },
    {
      type: "result",
      subtype: "success",
      structured_output: validImplementResult,
      result: JSON.stringify(validImplementResult),
      total_cost_usd: 0.01,
      usage: { input_tokens: 100, output_tokens: 50 },
      session_id: "sess_1",
    },
  ];
  spawned.length = 0;
  handedOut.length = 0;

  fetched = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(((input: unknown) => {
    fetched.push(String(input));
    return Promise.reject(new Error("this test has no network"));
  }) as typeof fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  handle.close();
});

/**
 * One supervisor, of the shape `createEngine` builds.
 *
 * Kept as a value rather than made per dispatch where a test needs two
 * dispatches out of the same one: "no restart" is only a claim you can
 * make about something that was not rebuilt in between.
 */
function supervisor() {
  return createRunSupervisor({
    db: handle.db,
    provider: (agent) => {
      const built = providerForAgent(agent, EO_MCP_SERVER_PATH, DB_PATH, RUNTIME_ROOT, handle.db);
      handedOut.push({ agentId: agent.id, provider: built });
      return built;
    },
    limits: { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 },
    // The pack's own scheduling, because the shape `createEngine` builds
    // includes it (KAN-161): a review of an item with no acceptance
    // criteria is turned away before it takes the one slot these caps
    // allow. The bucket a run consumes is the workspace kind's since
    // EO-296, so it arrives with the kinds rather than here.
    dispatchGate: createDispatchGate(handle.db),
  });
}

/** One dispatch, through the real supervisor and the real provider construction. */
async function dispatch(): Promise<void> {
  await supervisor().runOnce();
}

/** What the backend was told to launch, by name. */
function serversHandedToTheBackend(): Record<string, unknown> {
  return (sdk.calls[0]?.options["mcpServers"] as Record<string, unknown> | undefined) ?? {};
}

function eventsOfTheOnlyRun(): { type: string }[] {
  const runs = listRunsForItem(handle.db, item.id);
  expect(runs).toHaveLength(1);
  return listRunEvents(handle.db, runs[0]!.id).map((event) => ({ type: event.type }));
}

describe("a dispatch while repository intelligence is switched off", () => {
  it("is what it is on a build that has never heard of it", async () => {
    expect(readRepositoryIntelligenceConfig(handle.db)).toEqual({ enabled: false, provider: "codewiki" });

    await dispatch();

    // The run events, exactly. A step that indexed, a provider that
    // reported a status, a guard that posted a refusal — each of them
    // is a row, and each of them breaks this line.
    expect(eventsOfTheOnlyRun()).toEqual([{ type: "thread_started" }, { type: "output" }, { type: "usage" }, { type: "result" }]);

    // The MCP server set, exactly — down to the environment, because a
    // second EO-owned server pointed at an index is what this feature
    // adds and it would arrive right here.
    expect(serversHandedToTheBackend()).toEqual({
      eo: {
        type: "stdio",
        command: process.execPath,
        args: [EO_MCP_SERVER_PATH],
        // EO's own servers are exempt from tool search whether or not
        // this feature is on (EO-161) — the exemption is about the two
        // servers being EO's, not about there being an index.
        alwaysLoad: true,
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          EO_MCP_DB_PATH: DB_PATH,
          EO_MCP_COMMENT_ENABLED: "0",
          EO_MCP_CONFIG_ENABLED: "0",
          EO_MCP_FULL_THREAD_ENABLED: "0",
          // The shipped implementer holds the memory grant (0126,
          // EO-479); nothing to do with an index.
          EO_MCP_MEMORY_NOTE_ENABLED: "1",
        },
      },
    });

    // The subprocess set, exactly. Empty here because the backend itself
    // is mocked out, which is what makes any entry at all a process EO
    // started on its own account.
    expect(spawned).toEqual([]);

    // And nothing was fetched, which is the acceptance criterion in its
    // own words: with the flag off, no binary download is ever
    // attempted.
    expect(fetched).toEqual([]);
  });

  it("still dispatched, so the assertions above are about a run that happened", async () => {
    // Every set above is small, and three of them are empty. Without
    // this, a dispatch that silently did nothing at all would satisfy
    // the whole test.
    await dispatch();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("succeeded");
    expect(run?.agentId).toBe(implementer.id);
    expect(sdk.calls).toHaveLength(1);
    expect(Object.keys(serversHandedToTheBackend())).toEqual(["eo"]);
  });
});

/**
 * The switch has to reach the *next* dispatch (EO-148).
 *
 * `mcpHost/gate.ts` states this as the third layer of its gate and
 * `createEngine` gets it by passing `limits` and `guards` as functions:
 * a value resolved at startup would mean a person turning this off —
 * because it is spawning something they do not want — had to quit the
 * app to be believed.
 *
 * The provider cache is the one thing between the setting and the
 * agent that genuinely outlives a write, which is why the assertion is
 * about identity: the same supervisor, no restart, nothing flushed, and
 * the dispatch after the flip is handed a provider built since it.
 */
describe("flipping the switch while EO is running", () => {
  /** The providers one agent was handed, dispatch by dispatch. */
  function providersFor(agentId: string): AgentProvider[] {
    return handedOut.filter((entry) => entry.agentId === agentId).map((entry) => entry.provider);
  }

  /**
   * Two dispatches of the same agent out of one supervisor, with
   * something happening in between.
   *
   * The same agent both times, and a second item to give it something
   * to do: the first item has moved on to review by then, and a
   * comparison across two different roles would say a provider was
   * rebuilt when all that happened was that somebody else's was built.
   *
   * Ticked until the implementer comes round again rather than exactly
   * twice, because what a tick picks up is the pipeline's business and
   * not this test's — the first item's review attempts sit in between.
   * Bounded so a supervisor that never dispatches again fails here
   * rather than hanging.
   */
  async function dispatchTwice(between: () => void): Promise<AgentProvider[]> {
    const running = supervisor();
    await running.runOnce();
    expect(providersFor(implementer.id)).toHaveLength(1);

    between();

    createTestItem(handle.db, { type: "story", title: "Another story", stepId: "todo" });
    for (let tick = 0; tick < 8 && providersFor(implementer.id).length < 2; tick += 1) await running.runOnce();

    const providers = providersFor(implementer.id);
    // Both halves have to have happened for anything below to mean
    // something: one provider is a supervisor that dispatched once.
    expect(providers).toHaveLength(2);
    return providers;
  }

  it("is picked up by the next dispatch, with no restart and no cache flush", async () => {
    const [before, after] = await dispatchTwice(() => writeRepositoryIntelligenceConfig(handle.db, { enabled: true }));

    expect(after).not.toBe(before);
  });

  it("does the same when the implementation is swapped rather than switched on", async () => {
    writeRepositoryIntelligenceConfig(handle.db, { enabled: true });

    const [before, after] = await dispatchTwice(() => writeRepositoryIntelligenceConfig(handle.db, { provider: "somebody-elses" }));

    expect(after).not.toBe(before);
  });

  it("hands back the same provider when nothing was flipped", async () => {
    // The control, and the reason the two above are worth reading. A
    // cache that missed every time would satisfy them while proving
    // nothing about the setting at all.
    const [before, after] = await dispatchTwice(() => {});

    expect(after).toBe(before);
  });
});

/**
 * The assertions above are worth exactly what the instruments are, and
 * three of them assert that a list stayed empty. These prove each
 * instrument can be made to say something, so an empty list is a fact
 * about the dispatch rather than about the wiring.
 */
describe("the instruments this file measures with", () => {
  it("sees a process when one is started", async () => {
    const { spawnSync } = await import("node:child_process");

    spawnSync(process.execPath, ["-e", ""]);

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain(process.execPath);
  });

  it("sees a fetch when one is attempted", async () => {
    await expect(fetch("https://example.invalid/codewiki.tar.gz")).rejects.toThrow();

    expect(fetched).toEqual(["https://example.invalid/codewiki.tar.gz"]);
  });

  it("reads the options out of the real provider construction, not out of a literal", async () => {
    // Change something `buildProvider` decides and the recorded options
    // change with it. If they did not, the server assertion above would
    // be checking a fixture against itself.
    updateAgent(handle.db, implementer.id, { config: { enableCommentTool: true } });

    await dispatch();

    expect(serversHandedToTheBackend()["eo"]).toMatchObject({ env: { EO_MCP_COMMENT_ENABLED: "1" } });
  });
});
