import { UNSCOPED_RUN, type Agent, type AgentProvider, type AgentProviderStartOptions, type CliToolDetection, type Item } from "@eo/core";
import { agentAttachmentsHash } from "../agentAttachments/fingerprint.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { missingCliToolNotice } from "../agentAttachments/cliToolsPrompt.js";
import { listAgents } from "../db/repos/agentsRepo.js";
import { saveCliTool, setAgentCliTool } from "../db/repos/cliToolsRepo.js";
import { listCommentsForItem } from "../db/repos/commentsRepo.js";
import { createRun, listRunsForItem, updateRun } from "../db/repos/runsRepo.js";
import { postComment } from "../db/repos/commentsRepo.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { promptHash } from "../roles/prompts.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";

/**
 * The agent's command-line tools at dispatch (EO-820): each looked for on
 * this machine, the ones found handed to the turn that opens the thread,
 * and each one not found left out, said once on the item, and never a
 * reason to hold the run.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

describe("command-line tools at dispatch (EO-820)", () => {
  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", spec: REVIEWABLE_SPEC });
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  });

  afterEach(() => handle.close());

  function attach(name: string, command: string, description: string) {
    const saved = saveCliTool(handle.db, { name, command, description });
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    setAgentCliTool(handle.db, { agentId: implementer.id, cliToolId: saved.cliTool.id, attached: true });
    return saved.cliTool;
  }

  /** The fake backend, with every start's options kept. */
  function recording(): { provider: AgentProvider; starts: AgentProviderStartOptions[] } {
    const inner = createFakeProvider({ result: validImplementResult });
    const starts: AgentProviderStartOptions[] = [];
    return {
      starts,
      provider: {
        ...inner,
        start(opts) {
          starts.push(opts);
          return inner.start(opts);
        },
      },
    };
  }

  const engineNotes = () => listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine").map((comment) => comment.body);

  it("hands the turn the CLIs found, with their path, and says once on the item which one was not found", async () => {
    attach("GitHub CLI", "gh", "GitHub from the command line.\nFor PRs.");
    const missing = attach("Terraform", "terraform", "Plans infrastructure.");
    const asked: { command: string; cwd: string }[] = [];
    const { provider, starts } = recording();
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider,
      limits: LIMITS,
      detectCliTool: async (command, cwd): Promise<CliToolDetection> => {
        asked.push({ command, cwd });
        return command === "gh" ? { found: true, path: "/usr/bin/gh" } : { found: false };
      },
    });

    await supervisor.runOnce();

    expect(asked.map((ask) => ask.command).sort()).toEqual(["gh", "terraform"]);
    // Looked up from where the run is spawned.
    expect(new Set(asked.map((ask) => ask.cwd))).toEqual(new Set([starts[0]?.cwd]));
    expect(starts).toHaveLength(1);
    expect(starts[0]?.cliTools).toEqual([{ command: "gh", description: "GitHub from the command line.\nFor PRs.", path: "/usr/bin/gh" }]);

    // The run went ahead, and the item was told about the missing one on it, once.
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("succeeded");
    const said = listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes("`terraform`"));
    expect(said).toHaveLength(1);
    expect(said[0]?.body).toBe(missingCliToolNotice(missing, implementer.name));
    expect(said[0]?.body).toContain("was not found on this machine, so this run went ahead without it");
    expect(said[0]?.runId).toBe(runs[0]?.id);
    expect(engineNotes().some((body) => body.includes("`gh`"))).toBe(false);
  });

  it("looks for a CLI on this machine itself by default, and one not on PATH is left out and said", async () => {
    attach("Not installed", "eo-no-such-cli-820", "Never installed anywhere.");
    const { provider, starts } = recording();
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });

    await supervisor.runOnce();

    expect(starts).toHaveLength(1);
    expect(starts[0]?.cliTools).toBeUndefined();
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);
    expect(engineNotes().filter((body) => body.includes("`eo-no-such-cli-820`"))).toHaveLength(1);
  });

  it("gives an agent with no CLIs attached nothing, and looks for nothing", async () => {
    const asked: string[] = [];
    const { provider, starts } = recording();
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider,
      limits: LIMITS,
      detectCliTool: async (command) => {
        asked.push(command);
        return { found: false };
      },
    });

    await supervisor.runOnce();

    expect(asked).toEqual([]);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.cliTools).toBeUndefined();
  });

  it("turns back having written nothing when a CLI is attached while the others are being looked for, and looks again", async () => {
    attach("GitHub CLI", "gh", "GitHub from the command line.");
    let attachedMidway = false;
    const { provider, starts } = recording();
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider,
      limits: LIMITS,
      detectCliTool: async (command): Promise<CliToolDetection> => {
        if (!attachedMidway) {
          attachedMidway = true;
          attach("psql", "psql", "The staging database.");
        }
        return { found: true, path: `/usr/bin/${command}` };
      },
    });

    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);

    await supervisor.runOnce();
    expect(starts).toHaveLength(1);
    expect(starts[0]?.cliTools?.map((tool) => tool.command).sort()).toEqual(["gh", "psql"]);
  });

  it("says a missing CLI on a dispatch that resumes the agent's thread too, once, and sends the thread no section", async () => {
    attach("GitHub CLI", "gh", "GitHub from the command line.");
    const missing = attach("Terraform", "terraform", "Plans infrastructure.");
    const cwd = "/tmp/eo/worktrees/EO-820";
    // The run that opened the thread, born with the CLIs attached now.
    const prior = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "succeeded",
      threadId: "session-1",
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      cwd,
      agentAttachmentsHash: agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN),
    });
    updateRun(handle.db, prior.id, { startedAt: 1_000, endedAt: 1_000 });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Carry on, please." });

    const { provider, starts } = recording();
    const resumed: string[] = [];
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: {
        ...provider,
        resume(threadId, message, opts) {
          resumed.push(threadId);
          return provider.resume(threadId, message, opts);
        },
      },
      kinds: kindsPreparing(cwd),
      limits: LIMITS,
      detectCliTool: async (command): Promise<CliToolDetection> =>
        command === "gh" ? { found: true, path: "/usr/bin/gh" } : { found: false },
    });

    await supervisor.runOnce();

    // The thread was carried on, not reopened, so nothing names the CLIs again.
    expect(resumed).toEqual(["session-1"]);
    expect(starts).toEqual([]);
    // And the run went without terraform, which the item is told once, on it.
    const run = listRunsForItem(handle.db, item.id).find((candidate) => candidate.id !== prior.id);
    expect(run?.status).toBe("succeeded");
    const said = listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes("`terraform`"));
    expect(said.map((comment) => comment.body)).toEqual([missingCliToolNotice(missing, implementer.name)]);
    expect(said[0]?.runId).toBe(run?.id);
    expect(engineNotes().some((body) => body.includes("`gh`"))).toBe(false);
  });
});
