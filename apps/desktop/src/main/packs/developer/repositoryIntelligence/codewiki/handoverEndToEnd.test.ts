import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentProvider, Item } from "@eo/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../../db/client.js";
import { listRunsForItem } from "../../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../../db/testHelpers.js";
import { validImplementResult } from "../../../../providers/fixtures.js";
import { createRoleWiring } from "../../wiring.js";
import { createRunSupervisor, type RunSupervisor } from "../../../../supervisor/runSupervisor.js";
import type { RepositoryIntelligenceFactory } from "../composition.js";
import { writeRepositoryIntelligenceConfig } from "../gate.js";
import type { RepositoryIndexQueryServer } from "../port.js";
import { createRepositoryIntelligenceService } from "../service.js";
import type { ResolveOptions } from "../binary/resolve.js";
import { createCodeWikiProvider } from "./provider.js";
import { fakeWorkspaceKind, installedKinds } from "../../../../supervisor/testWorkspaceKinds.js";
import { gitWorkspaceKind } from "../../workspace/gitKind.js";
import { runCodeWiki, type CodeWikiRunRequest, type CodeWikiRunResult } from "./run.js";
import { CODEWIKI_SHIM } from "./testShim.js";
import { run } from "../../../../testing/git.js";

/**
 * The whole of EO-153, end to end: what the reviewer can actually see
 * (EO-153).
 *
 * The acceptance criterion this file exists for is deliberately not "the
 * sync was called". Asserting that a function ran proves the wiring and
 * nothing about the outcome, and the outcome is the entire point — an
 * index that is stale by the time the reviewer reads it is worse than
 * no index, because the reviewer will believe it. So this drives a real
 * supervisor through a real handover, against a real child process
 * keeping a real index on disk, and then asks that index the question a
 * reviewer's agent would ask, through the server that reviewer was
 * actually handed.
 *
 * **Why this file lives under `codewiki/`.** It reaches an
 * implementation, and `architecturalInvariants.test.ts` says only this
 * directory may. The counterpart at the port —
 * `repositoryIntelligence/handover.test.ts` — owns the questions about
 * *when* the sync happens and what a failure does, because those are
 * answerable without knowing what is underneath and must stay that way.
 *
 * **What stands in for the binary, and what does not.** The executable
 * is the same Node stand-in the rest of this suite uses, reached the
 * same way: `configuredPath` is Node and the script goes in front of the
 * argv. Everything between the supervisor and that process is
 * production code — the gate, the service, the port, `runCodeWiki`, the
 * argument composition, the query server's own command line. The
 * stand-in keeps a real file on disk and answers real JSON-RPC over
 * stdio, so a symbol arriving in the reviewer's answer got there by
 * being written to a checkout, walked by a subprocess, written to an
 * index and read back out of it.
 */

/** Somewhere resolution reliably finds nothing, so the `cache` branch never fires by accident. */
const EMPTY_ROOT = join(tmpdir(), "eo-codewiki-no-such-root");

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const REVIEW_APPROVAL = { verdict: "approve", feedback: "Reads well." };

/**
 * A stand-in whose `sync` never finishes and says where to find it.
 *
 * Used for the cancellation criterion only, and swapped in after the
 * index has been built by the honest one — so the run reaches a
 * handover with a queryable index and then hangs inside the one call
 * this is about. It answers `--version` and `status` because the service
 * reconciles the row against the provider before it syncs, and a
 * stand-in that could not answer those would fail before ever getting
 * to the part being tested.
 */
const HANGING_SYNC_SHIM = `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const marker = argv.indexOf("--path");
const root = marker === -1 ? null : argv[marker + 1];
if (argv[0] === "--version") {
  process.stdout.write("codewiki 0.2.1\\n");
  process.exit(0);
}
if (argv[0] === "status") {
  const index = JSON.parse(readFileSync(join(root, ".codewiki", "codewiki.db"), "utf8"));
  const count = Object.keys(index.files).length;
  process.stdout.write(
    "CodeWiki Index Status\\n  Root:              " + root + "\\n  Nodes:             " + count * 2 + "\\n  Edges:             " + count + "\\n  Files:             " + count + "\\n",
  );
  process.exit(0);
}
if (argv[0] === "sync") {
  writeFileSync(process.env.EO_PID_FILE, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  process.exit(0);
}
`;

let shims: string;
let honest: string;
let hangingSync: string;

beforeAll(() => {
  shims = mkdtempSync(join(tmpdir(), "eo-handover-shims-"));
  const write = (name: string, body: string): string => {
    const path = join(shims, `${name}.mjs`);
    writeFileSync(path, body);
    return path;
  };
  honest = write("codewiki", CODEWIKI_SHIM);
  hangingSync = write("hanging-sync", HANGING_SYNC_SHIM);
});

afterAll(() => {
  rmSync(shims, { recursive: true, force: true });
});

let handle: DbHandle;
let scratch: string;
let workspace: string;
let item: Item;
/** Which stand-in the next provider will be built around. Read at call time so a test can swap it mid-run. */
let shim: string;
/** Every query server a dispatch was handed, in order. */
let delivered: (RepositoryIndexQueryServer | undefined)[];


beforeEach(async () => {
  handle = openMigratedTestDb();
  writeRepositoryIntelligenceConfig(handle.db, { enabled: true });
  scratch = mkdtempSync(join(tmpdir(), "eo-handover-e2e-"));
  workspace = join(scratch, "checkout");
  mkdirSync(join(workspace, "src"), { recursive: true });
  shim = honest;
  delivered = [];

  await run(["init", "-b", "main"], workspace);
  await run(["config", "user.email", "eo@example.com"], workspace);
  await run(["config", "user.name", "EO Test"], workspace);
  await run(["config", "commit.gpgsign", "false"], workspace);
  await run(["config", "tag.gpgsign", "false"], workspace);
  writeFileSync(join(workspace, "src", "alpha.ts"), "export function alpha() {\n  return 1;\n}\n");
  await run(["add", "-A"], workspace);
  await run(["commit", "-m", "first"], workspace);

  const repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: join(scratch, "origin") });
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the api", stepId: "todo", workspaceId: repository.id });
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * The real provider, with a stand-in at the end of it.
 *
 * The `run` seam is how `provider.test.ts` reaches a stand-in and it is
 * used identically here: what executes is `runCodeWiki` with the
 * production argument composition, capture and timeout, pointed at a
 * different executable. `EO_SHIM_HOOKS=none` because git hooks are
 * EO-146's criterion and installing them here would only add noise to
 * the checkout this file is asserting about.
 */
function providerFor(signal?: AbortSignal, env: Record<string, string> = {}) {
  const binary: ResolveOptions = { root: EMPTY_ROOT, configuredPath: process.execPath };
  const chosen = shim;
  const run = (request: CodeWikiRunRequest): Promise<CodeWikiRunResult> =>
    runCodeWiki({
      ...request,
      binary,
      args: [chosen, ...request.args],
      env: { ...request.env, ...env, EO_SHIM_HOOKS: "none" },
    });
  return createCodeWikiProvider({ binary, run, ...(signal === undefined ? {} : { signal }) });
}

function factoryFor(env: Record<string, string> = {}): RepositoryIntelligenceFactory {
  return ({ db, signal }) =>
    writeRepositoryIntelligenceConfig(handle.db, {}).enabled
      ? {
          service: createRepositoryIntelligenceService({ db, provider: providerFor(signal, env) }),
          ensureInstalled: async () => ({ ok: true as const }),
        }
      : null;
}

/** The index the `index_repository` step would have left behind before the implementer ran. */
async function indexTheWorktree(factory: RepositoryIntelligenceFactory): Promise<void> {
  const runtime = factory({ db: handle.db });
  if (runtime === null) throw new Error("the factory answered null with the feature on");
  const outcome = await runtime.service.ensureIndexed({ workspaceId: item.workspaceId!, itemId: item.id, workspacePath: workspace });
  if (!outcome.ok) throw new Error(outcome.reason);
}

/**
 * A backend that writes code on the implementer's turn and records what
 * every turn was handed.
 *
 * The write is the point: this is the implementer adding a symbol, and
 * everything downstream — the sync, the index, the reviewer's answer —
 * has to trace back to a file that was not there when the index was
 * built.
 */
function implementerThatWrites(work: () => void, ...results: unknown[]): AgentProvider {
  const scripted = results.length > 0 ? [...results] : [validImplementResult];
  let done = false;
  const next = (): unknown => (scripted.length > 1 ? scripted.shift() : scripted[0]);
  function replay(result: unknown): AsyncIterable<AgentEvent> {
    return (async function* (): AsyncIterable<AgentEvent> {
      yield { type: "thread_started", threadId: "session-1" };
      yield { type: "result", data: result };
    })();
  }
  const turn = (server: RepositoryIndexQueryServer | undefined): AsyncIterable<AgentEvent> => {
    delivered.push(server);
    if (!done) {
      work();
      done = true;
    }
    return replay(next());
  };
  return {
    start: (opts) => turn(opts.repositoryMcp),
    resume: (_threadId, _message, opts) => turn(opts?.repositoryMcp),
  };
}

function supervisorFor(factory: RepositoryIntelligenceFactory, provider: AgentProvider): RunSupervisor {
  return createRunSupervisor({
    db: handle.db,
    provider,
    ...createRoleWiring(handle.db),
    limits: LIMITS,
    // Both halves of what the workspace lends, exactly as `createEngine`
    // wires them: the git kind's own `attach`, over a directory this
    // test decides. The server and the handover sync come out of one
    // call now, which is the point of the interface.
    kinds: installedKinds(fakeWorkspaceKind({ cwd: workspace, attach: gitWorkspaceKind({ db: handle.db, intelligenceFor: factory }).attach })),
  });
}

/**
 * The question an agent's tool call becomes, asked of the server that
 * dispatch was handed.
 *
 * The stand-in is reached the way it is everywhere else in this suite —
 * Node is the executable and the script goes in front of the argv — so
 * `server.args` reaches the process byte for byte as composed. That is
 * the part worth being real: the `--path` in it is the whole of what
 * this agent's index can see.
 */
async function ask(server: RepositoryIndexQueryServer, symbol: string): Promise<{ symbol: string; file: string }[]> {
  const child = spawn(server.command, [shim, ...server.args], { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "ignore"] });
  try {
    const answered = new Promise<string>((resolve, reject) => {
      let buffered = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        const cut = buffered.indexOf("\n");
        if (cut !== -1) resolve(buffered.slice(0, cut));
      });
      child.on("error", reject);
      child.on("exit", () => reject(new Error("the query server exited before answering")));
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codewiki_search", arguments: { query: symbol } } })}\n`);
    const reply = JSON.parse(await answered) as { result?: { content?: { text?: string }[] } };
    return JSON.parse(reply.result?.content?.[0]?.text ?? "[]") as { symbol: string; file: string }[];
  } finally {
    child.kill();
  }
}

async function waitFor(condition: () => boolean, whatFor: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise((settle) => setTimeout(settle, 25));
  }
  throw new Error(`Timed out waiting for ${whatFor}.`);
}

/**
 * Whether a pid is a process that is still *running*, as opposed to one
 * that has died and not yet been reaped.
 *
 * `run.test.ts`'s helper and its reasoning: `kill(pid, 0)` cannot tell a
 * zombie from a live process, and in CI's container pid 1 reaps nothing
 * — so "is it gone?" answered yes forever on a developer machine and no
 * forever on CI. Reading the process state is what fixes that, rather
 * than a longer timeout.
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 1).trim().charAt(0) !== "Z";
  } catch {
    return false;
  }
}

describe("what the reviewer can see of the implementer's work", () => {
  /**
   * The criterion this whole story is for, proven by asking rather than
   * by asserting a call.
   *
   * `rateLimiterFor` does not exist when the index is built. The
   * implementer writes it, the handover syncs, and the reviewer — a
   * separate dispatch, handed its own server pointed at this item's
   * checkout — gets it back. Every link is real except the executable
   * at the far end, and if the sync were removed the answer would come
   * back empty rather than the test failing on a spy.
   */
  it("returns a symbol the implementer added, through the reviewer's own query server", async () => {
    const factory = factoryFor();
    await indexTheWorktree(factory);

    const supervisor = supervisorFor(
      factory,
      implementerThatWrites(
        () => writeFileSync(join(workspace, "src", "gamma.ts"), "export function rateLimiterFor(route) {\n  return route;\n}\n"),
        validImplementResult,
        REVIEW_APPROVAL,
      ),
    );
    await supervisor.runOnce(); // the implementer, and the handover after it
    await supervisor.runOnce(); // the reviewer

    expect(listRunsForItem(handle.db, item.id).map((run) => run.action)).toEqual(["implement", "review"]);

    const reviewersServer = delivered[delivered.length - 1];
    expect(reviewersServer?.args).toEqual(["serve", "--mcp", "--path", workspace, "--no-watch"]);

    expect(await ask(reviewersServer!, "rateLimiterFor")).toEqual([{ symbol: "rateLimiterFor", file: join("src", "gamma.ts") }]);
  });

  /**
   * The same run, asked about something that was never written.
   *
   * Without it the assertion above is satisfied by a server that says
   * yes to everything, which is exactly the failure a fake makes easy.
   */
  it("does not invent a symbol nobody wrote", async () => {
    const factory = factoryFor();
    await indexTheWorktree(factory);

    const supervisor = supervisorFor(
      factory,
      implementerThatWrites(
        () => writeFileSync(join(workspace, "src", "gamma.ts"), "export function rateLimiterFor(route) {\n  return route;\n}\n"),
        validImplementResult,
        REVIEW_APPROVAL,
      ),
    );
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(await ask(delivered[delivered.length - 1]!, "throttleFor")).toEqual([]);
  });

  /**
   * A worktree carries work nobody has committed yet, and that is not
   * an edge case — on a handover it is frequently all of it.
   *
   * This is why EO does not compute the changed-file set itself and hand
   * it over. A commit-to-commit diff would report nothing here, and the
   * reviewer would be handed an index that is confidently missing the
   * only thing it was asked about. The port's `sync` reconciles against
   * what is on disk, which is the property being pinned: the checkout is
   * deliberately left dirty and the symbol still arrives.
   */
  it("reflects work the implementer left uncommitted", async () => {
    const factory = factoryFor();
    await indexTheWorktree(factory);

    const supervisor = supervisorFor(
      factory,
      implementerThatWrites(
        () => writeFileSync(join(workspace, "src", "delta.ts"), "export const uncommittedBudget = 10;\n"),
        validImplementResult,
        REVIEW_APPROVAL,
      ),
    );
    await supervisor.runOnce();
    await supervisor.runOnce();

    // Nothing was committed: git still sees the file as untracked, and
    // HEAD has not moved since the index was built.
    expect(await run(["status", "--porcelain"], workspace)).toContain("src/delta.ts");

    expect(await ask(delivered[delivered.length - 1]!, "uncommittedBudget")).toEqual([
      { symbol: "uncommittedBudget", file: join("src", "delta.ts") },
    ]);
  });
});

describe("cancelling a run while its handover sync is running", () => {
  /**
   * The cost nobody agreed to pay.
   *
   * By the time a handover sync runs, the run's own controller has been
   * let go of — so a cancel that could not reach this would leave an
   * indexer walking a checkout the person has finished with, invisibly
   * and for as long as it took. The pid comes from the child itself
   * rather than from anything EO recorded, so this asks the operating
   * system rather than taking the supervisor's word for it.
   */
  it("leaves no indexer behind", async () => {
    const pidFile = join(scratch, "sync.pid");
    const factory = factoryFor({ EO_PID_FILE: pidFile });
    await indexTheWorktree(factory);

    // Swapped only now: the index above was built by the honest
    // stand-in, so the run below reaches a genuine handover with a
    // queryable index and hangs inside the one call this is about.
    shim = hangingSync;

    const supervisor = supervisorFor(factory, implementerThatWrites(() => {}, validImplementResult));
    const tick = supervisor.runOnce();

    await waitFor(() => existsSync(pidFile), "the hanging sync to start");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(isRunning(pid)).toBe(true);

    const [run] = listRunsForItem(handle.db, item.id);
    supervisor.cancelRun(run!.id);

    await tick;
    await waitFor(() => !isRunning(pid), "the cancelled sync's process to be gone");
  });
});
