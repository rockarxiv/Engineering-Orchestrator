import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitStateOf, GIT_WORKTREE_KIND, type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createRoute,
  createStep,
  createWorkspace,
  currentOutputOf,
  getItem,
  listAgents,
  listCommentsForItem,
  listRunsForItem,
  needsAttention,
  transitionItem,
} from "../db/repos/index.js";
import { createDefaultProject } from "../db/repos/projectsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { noneWorkspaceKind } from "./noneKind.js";
import { createRunSupervisor, type RunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { fakeWorkspaceKind, installedKinds } from "./testWorkspaceKinds.js";
import { verifier } from "./workspaceKind.js";
import type { Artifact, Check, WorkspaceKind } from "./workspaceKind.js";

/**
 * The supervisor against more than one kind of workspace (EO-295,
 * ARCHITECTURE.md, "The interface").
 *
 * Everything else in this folder runs against one installed kind, which
 * is what a developer installation is — and which is exactly the shape
 * that let eight git-typed hooks sit on the supervisor for a year
 * looking like the only way a run could have somewhere to work. So this
 * file installs two, gives the item the second one, and holds the
 * supervisor to the rule the interface exists for: **the kind an item's
 * workspace names is the only one it ever calls.**
 *
 * The git kind's stand-in refuses every method with a throw rather than
 * recording a call. A test that counted calls would report the failure
 * as a number at the end; this one fails inside the dispatch, where the
 * run can still be looked at — and a throw is the only assertion that
 * holds for a method somebody adds to the interface later without
 * touching this file.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/** The pipeline every seeded step belongs to. */
const DEFAULT_PIPELINE = "default" as Uuid;

/** Somewhere that is not a checkout: a helpdesk reached over a connector has no branch to cut. */
const HELPDESK_KIND = "helpdesk";
const HELPDESK_CWD = "/tmp/eo/helpdesk/EO-1";

let handle: DbHandle;
/** Where the `none` kind's empty directories go, so no test writes into the person's `~/.eo`. */
let noDiskRoot: string;
let writes: TestWriteBridge;

/**
 * A supervisor whose agents' comments reach it over the agent write
 * bridge, as a real `eo` server's do (EO-543). Without one a scripted
 * `comment` call is only said, never made.
 */
function writingSupervisor(options: Omit<RunSupervisorOptions, "agentWriteBridge">): RunSupervisor {
  const supervisor = createRunSupervisor({ ...options, agentWriteBridge: writes.agentWriteBridge });
  writes.serve(supervisor);
  return supervisor;
}

/** A git kind that proves it was not consulted, whichever method is asked. */
function refusesEverything(): WorkspaceKind {
  const refuse = (method: string) => (): never => {
    throw new Error(`the git kind's ${method} was called for an item whose workspace is not a git worktree`);
  };
  return {
    slug: GIT_WORKTREE_KIND,
    prepare: refuse("prepare"),
    attach: refuse("attach"),
    verifiers: { implement: verifier(["nothing this test reads"], refuse("verify")) },
    release: refuse("release"),
    artifacts: refuse("artifacts"),
    capacityKeyOf: refuse("capacityKeyOf"),
  };
}

/** An item on a workspace of the given kind, with a project of its own. */
function itemOn(kind: string, title = "A story"): Item {
  const workspace = createWorkspace(handle.db, { kind, config: { name: kind, repoPath: "/tmp/eo/not-a-checkout" } });
  const project = createDefaultProject(handle.db, workspace, "EO");
  return createTestItem(handle.db, { type: "story", title, stepId: "todo", workspaceId: workspace.id, projectId: project.id });
}

beforeEach(async () => {
  handle = openMigratedTestDb();
  noDiskRoot = mkdtempSync(join(tmpdir(), "eo-no-disk-"));
  writes = await startTestWriteBridge();
});

afterEach(async () => {
  await writes.close();
  handle.close();
  rmSync(noDiskRoot, { recursive: true, force: true });
});

describe("an item whose workspace is a second kind", () => {
  it("is dispatched into the cwd that kind prepared, and no git function is called for it", async () => {
    let dispatchedIn: string | undefined;
    const inner = createFakeProvider({ result: validImplementResult });
    const item = itemOn(HELPDESK_KIND);

    await createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: {
        start: (opts) => {
          dispatchedIn = opts.cwd;
          return inner.start(opts);
        },
        resume: inner.resume.bind(inner),
      },
      kinds: installedKinds(refusesEverything(), fakeWorkspaceKind({ slug: HELPDESK_KIND, cwd: HELPDESK_CWD })),
    }).runOnce();

    expect(dispatchedIn).toBe(HELPDESK_CWD);
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("succeeded");
    // Recorded on the run, because a resume has to be pointed back at
    // it — and it is a cwd rather than a worktree path, which is the
    // whole of what the column rename is for.
    expect(run?.cwd).toBe(HELPDESK_CWD);
  });

  it("is verified by its own kind, which is free to have nothing to check", async () => {
    const asked: string[] = [];
    const item = itemOn(HELPDESK_KIND);

    await createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: createFakeProvider({ result: validImplementResult }),
      kinds: installedKinds(
        refusesEverything(),
        fakeWorkspaceKind({
          slug: HELPDESK_KIND,
          cwd: HELPDESK_CWD,
          verifying: async (_item, run) => {
            asked.push(`${run.action}:${run.ended}`);
            return [];
          },
        }),
      ),
    }).runOnce();

    expect(asked).toEqual(["implement:succeeded"]);
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).not.toBe("todo"); // nothing checked, nothing blocked
  });
});

describe("what a check does to the run", () => {
  const blocking: Check = {
    key: "delivered",
    passed: false,
    blocks: true,
    describes: "The reply was never sent: the helpdesk has no record of it.",
    comment: "The reply was never sent.\n\nThe helpdesk has no record of case 4821 being answered, so this run's claim could not be confirmed.",
    evidence: { case: "4821", answered: false },
  };

  async function runWith(checks: readonly Check[]): Promise<Item> {
    const item = itemOn(HELPDESK_KIND);
    await createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: createFakeProvider({ result: validImplementResult }),
      kinds: installedKinds(fakeWorkspaceKind({ slug: HELPDESK_KIND, cwd: HELPDESK_CWD, verifying: async () => checks })),
    }).runOnce();
    return item;
  }

  it("keeps the item where it is and posts the rejection, when a check that blocks did not pass", async () => {
    const item = await runWith([blocking]);

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("failed");
    // The sentence on the row, the long form in the thread: what the
    // next attempt reads is the comment (E-06), and what a person
    // scanning the run list reads is the sentence.
    expect(run?.error).toBe(blocking.describes);
    expect(run?.verification).toEqual(blocking.evidence);
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");

    const rejection = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "rejection");
    expect(rejection?.body).toBe(blocking.comment);
  });

  it("lets the work stand and says what it noticed, when a check that only reports did not pass", async () => {
    const item = await runWith([
      { key: "borrowed-files", passed: false, describes: "A file on this branch came from work nobody has approved." },
    ]);

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).not.toBe("todo");
    // Invariant 8: it ends in a comment, and it is a note rather than a
    // rejection because nothing was refused.
    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine");
    expect(note?.kind).toBe("note");
    expect(note?.body).toBe("A file on this branch came from work nobody has approved.");
  });

  /**
   * A failed check is a result the graph can be wired for (EO-297).
   *
   * And a result nothing that *runs* declares: an agent cannot report it
   * — the whole point is that the agent claimed the opposite — and no
   * manifest lists it. The workspace kind is what contributes it, which
   * is why the supervisor asks the kind whether it verifies this action
   * at all before reading the graph. The rejection is posted either way;
   * the route only decides whether the item waits here for the next
   * attempt or goes somewhere that handles it.
   */
  it("takes the verification_failed route when the pipeline declares one", async () => {
    // Somewhere for a claim nobody could confirm to go: a column a
    // person owns, which is what a pipeline that wants these triaged
    // rather than retried would draw.
    createStep(handle.db, { id: "unconfirmed", pipelineId: DEFAULT_PIPELINE, position: 20, name: "Unconfirmed", ownerRole: "product_owner" });
    createRoute(handle.db, {
      pipelineId: DEFAULT_PIPELINE,
      fromStepId: "todo",
      resultKey: "verification_failed",
      label: "Could not be confirmed",
      target: "unconfirmed",
      position: 9,
    });

    const item = await runWith([blocking]);

    expect(getItem(handle.db, item.id)?.stepId).toBe("unconfirmed");
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("failed");
    // What the next attempt reads, wherever the next attempt happens.
    expect(listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "rejection")?.body).toBe(blocking.comment);
  });

  /**
   * And what it checked is kept, not only what it concluded (EO-312,
   * ARCHITECTURE.md, "The item").
   *
   * Invariant 5 reads "verify where you can, and *say what you
   * checked*", and the second half is only kept where somebody can read
   * it afterwards. `verification` beside this holds the evidence one
   * check carried; this is the list the sidebar's step block draws.
   */
  it("keeps every check on the run, so the sidebar can list what was looked at", async () => {
    const item = await runWith([
      { key: "delivered", passed: true, blocks: true, describes: "The helpdesk has the reply against case 4821." },
      { key: "tone", passed: true, describes: "The reply reads as an answer rather than an acknowledgement." },
      { key: "borrowed-files", passed: false, describes: "A file on this branch came from work nobody has approved." },
    ]);

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.checks).toEqual([
      { key: "delivered", passed: true, describes: "The helpdesk has the reply against case 4821." },
      { key: "tone", passed: true, describes: "The reply reads as an answer rather than an acknowledgement." },
      { key: "borrowed-files", passed: false, describes: "A file on this branch came from work nobody has approved." },
    ]);
  });

  it("keeps the checks of a run a failed check stopped, which is the run somebody opens", async () => {
    const item = await runWith([blocking]);

    expect(listRunsForItem(handle.db, item.id)[0]?.checks).toEqual([{ key: blocking.key, passed: false, describes: blocking.describes }]);
  });

  it("leaves the column alone where nothing was checked, rather than writing an empty list", async () => {
    const item = await runWith([]);

    expect(listRunsForItem(handle.db, item.id)[0]?.checks).toBeNull();
  });

  it("says nothing at all when every check passed", async () => {
    const item = await runWith([{ key: "delivered", passed: true, blocks: true, describes: "The helpdesk has the reply against case 4821." }]);

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine")).toEqual([]);
  });
});

describe("what the run produced", () => {
  const REPLY: Artifact = {
    kind: "reply",
    name: "case-4821.md",
    mediaType: "text/markdown",
    body: "Thanks for waiting — your refund was issued this morning.",
  };

  /** One run against a kind that produces `artifacts`, on a fresh item. */
  async function runProducing(artifacts: readonly Artifact[] | (() => Promise<never>), item?: Item): Promise<Item> {
    const on = item ?? itemOn(HELPDESK_KIND);
    await createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: createFakeProvider({ result: validImplementResult }),
      kinds: installedKinds(
        fakeWorkspaceKind({
          slug: HELPDESK_KIND,
          cwd: HELPDESK_CWD,
          artifacts: typeof artifacts === "function" ? artifacts : async () => artifacts,
        }),
      ),
    }).runOnce();
    return on;
  }

  const outputs = (item: Item) => listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "output");

  it("is posted as the item's output, authored by the run", async () => {
    const item = await runProducing([REPLY]);

    const [output] = outputs(item);
    expect(output?.body).toBe(REPLY.body);
    // Authored by the run: the agent that produced it, and the run it
    // was produced during — which is what places it at a step.
    expect(output?.authorType).toBe("agent");
    expect(output?.runId).toBe(listRunsForItem(handle.db, item.id)[0]?.id);
    // Nothing to supersede on a ticket that has produced nothing before.
    expect(output?.parentId).toBeNull();
  });

  it("is fenced when it is not prose, so a diff survives being read as markdown", async () => {
    const diff = "--- a/limit.ts\n+++ b/limit.ts\n@@ -1 +1 @@\n-const cap = 10;\n+const cap = 100;\n";
    const item = await runProducing([{ kind: "diff", name: "EO-1.diff", mediaType: "text/x-diff", body: diff }]);

    expect(outputs(item)[0]?.body).toBe("```diff\n" + diff.trimEnd() + "\n```");
  });

  it("fences a diff longer than the backticks inside it, which is the commonest diff there is", async () => {
    // A change to a documentation file carries fenced code blocks of its
    // own. A three-backtick fence around one ends at the first of them,
    // and the rest of the diff renders as prose — on the ticket, in
    // Jira, and in the next step's prompt.
    const diff = "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-```sh\n+```bash\n";
    const item = await runProducing([{ kind: "diff", name: "EO-1.diff", mediaType: "text/x-diff", body: diff }]);

    expect(outputs(item)[0]?.body).toBe("````diff\n" + diff.trimEnd() + "\n````");
  });

  it("leaves prose alone, since there is nothing to protect it from", async () => {
    const item = await runProducing([REPLY]);

    expect(outputs(item)[0]?.body).toBe(REPLY.body);
  });

  it("supersedes the last one and leaves it in the thread", async () => {
    const item = await runProducing([REPLY]);
    const [first] = outputs(item);

    // A second attempt on the same ticket: the item is back where a
    // dispatch finds it, and the kind produces a corrected reply.
    const [anyAgent] = listAgents(handle.db);
    transitionItem(handle.db, { itemId: item.id, toStepId: "todo", actor: anyAgent!.id, reason: "another go" });
    const corrected = { ...REPLY, body: "Your refund was issued this morning, and the fee is waived." };
    await runProducing([corrected], item);

    const both = outputs(item);
    expect(both).toHaveLength(2);
    // The chain: the new one points at what it replaced, and what it
    // replaced is still there, still saying what it said.
    expect(both[1]?.parentId).toBe(first?.id);
    expect(both[0]?.body).toBe(REPLY.body);
    // And the derived answer is the latest of them.
    expect(currentOutputOf(handle.db, item.id)?.id).toBe(both[1]?.id);
  });

  it("is nothing at all when the kind produced nothing", async () => {
    const item = await runProducing([]);

    expect(outputs(item)).toEqual([]);
  });

  it("does not fail a run whose work already passed, when the kind could not say what it produced", async () => {
    const item = await runProducing(async () => {
      throw new Error("the helpdesk API timed out");
    });

    // The work stands and the item moves: an output is a claim about
    // what the ticket has, not a check on whether it may keep it.
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).not.toBe("todo");
    expect(outputs(item)).toEqual([]);
    // Invariant 8 — it ends in a comment rather than on the floor.
    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine");
    expect(note?.body).toContain("the helpdesk API timed out");
  });

  it("still moves the item when the output itself could not be written", async () => {
    // The other half of the same guard, and the one that matters more: a
    // body of no bounded size is assembled and handed to SQLite, and a
    // throw from *that* would escape into a run already recorded as
    // succeeded — leaving an item that never transitioned.
    const item = itemOn(HELPDESK_KIND);
    const unwritable = { ...REPLY, get body(): string {
      throw new Error("the reply was too large to record");
    } } as unknown as Artifact;

    await runProducing([unwritable], item);

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).not.toBe("todo");
    expect(outputs(item)).toEqual([]);
    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine");
    expect(note?.body).toContain("the reply was too large to record");
  });
});

describe("what the workspace lends", () => {
  it("reaches the backend, and what it could not lend is said in the thread", async () => {
    const item = itemOn(HELPDESK_KIND);
    let toolsOnTheTurn: string | undefined;
    const inner = createFakeProvider({ result: validImplementResult });

    await createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: {
        start: (opts) => {
          toolsOnTheTurn = opts.repositoryMcp?.name;
          return inner.start(opts);
        },
        resume: inner.resume.bind(inner),
      },
      kinds: installedKinds(
        fakeWorkspaceKind({
          slug: HELPDESK_KIND,
          cwd: HELPDESK_CWD,
          attach: async () => ({
            mcpServers: [{ name: "helpdesk", command: "helpdesk-mcp", args: [], env: {} }],
            skills: [],
            notices: ["The helpdesk's search index is rebuilding, so this run answers without it."],
          }),
        }),
      ),
    }).runOnce();

    expect(toolsOnTheTurn).toBe("helpdesk");
    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine");
    expect(note?.body).toContain("search index is rebuilding");
  });
});

describe("an item with no workspace at all", () => {
  /**
   * `none` is a real kind, not the absence of one (EO-296,
   * ARCHITECTURE.md, "The four kinds").
   *
   * Until this story such a run was handed EO's own launch directory
   * with a note in the thread saying so — which for a packaged app is
   * not a checkout of anything and frequently not a git repository at
   * all, so a provider that checks it is inside a trusted repository
   * refused before the agent started, naming itself rather than the
   * directory. The kind is built into the supervisor rather than
   * contributed by a pack, because a core with nothing installed still
   * has to have somewhere to put a run.
   */
  it("runs in an empty directory of its own, not in the process's", async () => {
    let dispatchedIn: string | undefined;
    const inner = createFakeProvider({ result: validImplementResult });
    const item = createTestItem(handle.db, { type: "story", title: "No workspace anywhere", stepId: "todo" });

    await createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      noDiskRoot,
      provider: {
        start: (opts) => {
          dispatchedIn = opts.cwd;
          return inner.start(opts);
        },
        resume: inner.resume.bind(inner),
      },
      // Nothing installed at all, which is the core with no pack — and
      // the answer is the same one an installation full of packs gives
      // an item none of their kinds answers for.
    }).runOnce();

    expect(dispatchedIn).toBe(join(noDiskRoot, item.key));
    expect(dispatchedIn).not.toBe(process.cwd());
    expect(existsSync(dispatchedIn!)).toBe(true);
    expect(readdirSync(dispatchedIn!)).toEqual([]);
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
  });

  it("takes its output from the agent's own comment tool, in the shape a workspace's would have (EO-298)", async () => {
    // `none` has no directory to gather anything from, so `artifacts`
    // has nothing to offer and an agent that drafted a reply says so
    // itself. What it writes has to be an output in every sense the
    // supervisor's is, or "the current output" would mean one thing on a
    // repository and another on a helpdesk.
    const item = createTestItem(handle.db, { type: "story", title: "Answer the customer", stepId: "todo" });
    const drafted = "Thanks for waiting — your refund was issued this morning.";

    await writingSupervisor({
      db: handle.db,
      limits: LIMITS,
      noDiskRoot,
      provider: createFakeProvider({
        steps: [{ toolCall: { name: "comment", args: { body: drafted, kind: "output" } } }],
        result: validImplementResult,
      }),
    }).runOnce();

    const output = currentOutputOf(handle.db, item.id);
    expect(output?.body).toBe(drafted);
    expect(output?.kind).toBe("output");
    // The same shape a workspace's artifacts take: authored by the run,
    // and placed at the step by the run it was written during.
    expect(output?.authorType).toBe("agent");
    expect(output?.runId).toBe(listRunsForItem(handle.db, item.id)[0]?.id);
    expect(output?.parentId).toBeNull();
  });

  it("chains an agent's second output to its first, the way a second run's does", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Answer the customer", stepId: "todo" });

    await writingSupervisor({
      db: handle.db,
      limits: LIMITS,
      noDiskRoot,
      provider: createFakeProvider({
        steps: [
          { toolCall: { name: "comment", args: { body: "a first draft", kind: "output" } } },
          { toolCall: { name: "comment", args: { body: "a better draft", kind: "output" } } },
        ],
        result: validImplementResult,
      }),
    }).runOnce();

    const outputs = listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "output");
    expect(outputs.map((comment) => comment.body)).toEqual(["a first draft", "a better draft"]);
    expect(outputs[1]?.parentId).toBe(outputs[0]?.id);
    expect(currentOutputOf(handle.db, item.id)?.body).toBe("a better draft");
  });

  it("keeps the output an output when the agent stops to have it approved (EO-298)", async () => {
    // "Here is what I produced, and I am stopping until somebody looks
    // at it" is one comment and two facts. The kind carries the first
    // and the mention carries the second — and the tool description
    // invites exactly this combination, so filing the deliverable as a
    // question would lose it on the commonest `none` run there is.
    const item = createTestItem(handle.db, { type: "story", title: "Answer the customer", stepId: "todo" });
    const drafted = "Thanks for waiting — your refund was issued this morning.";

    await writingSupervisor({
      db: handle.db,
      limits: LIMITS,
      noDiskRoot,
      provider: createFakeProvider({
        steps: [{ toolCall: { name: "comment", args: { body: drafted, kind: "output", mentions: ["user"], blocking: true } } }],
      }),
    }).runOnce();

    const output = currentOutputOf(handle.db, item.id);
    expect(output?.body).toBe(drafted);
    expect(output?.kind).toBe("output");
    // The run still parks, and the person is still asked: what stops it
    // is the mention and the interrupt, neither of which reads the kind.
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
    expect(needsAttention(handle.db, item.id)).toBe(true);
    // And the item stays where it is, waiting on the person.
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("checks nothing, and says so by returning no checks rather than by passing one", async () => {
    // What a run on `none` claimed is judged by whoever reads it. The
    // alternative — a check that always passes — would put a tick beside
    // a run nothing looked at.
    const item = createTestItem(handle.db, { type: "story", title: "Nothing to check", stepId: "todo" });

    await createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      noDiskRoot,
      provider: createFakeProvider({ result: validImplementResult }),
    }).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.verification).toBeNull();
    expect(gitStateOf(getItem(handle.db, item.id)!).branch).toBeNull();
  });

  it("lets go of the directory when the item settles, and never on the stale sweep", async () => {
    // A settled item is the one moment nothing on it will be resumed
    // again. The sweep is deliberately not the other half of that: it is
    // handed which item keys still have a run behind them, and an item
    // parked between two steps looks exactly like one that is finished
    // (EO-177). An empty directory is worth nothing, so there is nothing
    // to be gained by guessing.
    const kind = noneWorkspaceKind(noDiskRoot);
    const item = createTestItem(handle.db, { type: "story", title: "Finished", stepId: "todo" });
    const prepared = await kind.prepare(item, "implement");
    const step = { id: "done", pipelineId: "p" as Item["pipelineId"], position: 9, name: "Done" } as never;

    await kind.release({ what: "stale", hasActiveRun: () => false });
    expect(existsSync(join(noDiskRoot, item.key))).toBe(true);

    await kind.release({ what: "settled", item, step });
    expect(existsSync(join(noDiskRoot, item.key))).toBe(false);
    expect(prepared.ok && prepared.workspace.cwd).toBe(join(noDiskRoot, item.key));
  });

  /**
   * **Concurrency is per shared filesystem** (ARCHITECTURE.md, "Capacity and concurrency"), and two
   * empty directories share nothing.
   *
   * The cap that used to hold these back was an artefact: every item
   * with no repository shared one bucket — the empty string — because
   * they all ran in EO's own process directory, where they genuinely
   * could tread on each other. Nothing runs there any more, so the
   * bucket goes with it. Invariant 10 is untouched: the global cap is
   * still what decides how much runs at once, and this only changes what
   * the *per-filesystem* cap is keyed on.
   */
  it("puts two items on `none` in no bucket, so the per-filesystem cap does not queue them behind each other", async () => {
    const started: string[] = [];
    const inner = createFakeProvider({ result: validImplementResult });
    const first = createTestItem(handle.db, { type: "story", title: "One", stepId: "todo" });
    const second = createTestItem(handle.db, { type: "story", title: "Two", stepId: "todo" });

    await createRunSupervisor({
      db: handle.db,
      // One run per filesystem, two overall: the only thing that can let
      // both of these start in one tick is answering `null` to "which
      // bucket are you in?".
      limits: { globalConcurrency: 2, perAgentConcurrency: 2, perRepositoryConcurrency: 1 },
      noDiskRoot,
      provider: {
        start: (opts) => {
          started.push(opts.cwd);
          return inner.start(opts);
        },
        resume: inner.resume.bind(inner),
      },
    }).runOnce();

    expect(started).toHaveLength(2);
    // And each in its own directory, which is what makes sharing no
    // bucket safe rather than merely permitted.
    expect(new Set(started)).toEqual(new Set([join(noDiskRoot, first.key), join(noDiskRoot, second.key)]));
  });

  it("keeps two items in one checkout behind each other, which is what the same cap is for", async () => {
    // The contrast, in the same tick and under the same caps: a git
    // workspace answers with its id in either mode, so the second item
    // waits. Without this the test above would pass just as well against
    // a capacity key that had stopped working altogether.
    const started: string[] = [];
    const inner = createFakeProvider({ result: validImplementResult });
    const workspace = createWorkspace(handle.db, { kind: GIT_WORKTREE_KIND, config: { name: "api", repoPath: "/tmp/eo/api" } });
    const project = createDefaultProject(handle.db, workspace, "EO");
    for (const title of ["One", "Two"]) {
      createTestItem(handle.db, { type: "story", title, stepId: "todo", workspaceId: workspace.id, projectId: project.id });
    }

    await createRunSupervisor({
      db: handle.db,
      limits: { globalConcurrency: 2, perAgentConcurrency: 2, perRepositoryConcurrency: 1 },
      noDiskRoot,
      provider: {
        start: (opts) => {
          started.push(opts.cwd);
          return inner.start(opts);
        },
        resume: inner.resume.bind(inner),
      },
      kinds: installedKinds(fakeWorkspaceKind({ cwd: "/tmp/eo/worktree" })),
    }).runOnce();

    expect(started).toHaveLength(1);
  });
});
