import { McpServerDraftSchema, SkillDraftSchema, type Agent, type Item, type SkillScope, UNSCOPED_RUN, uuidv7 } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import type { CreateRunInput } from "../db/repos/runsRepo.js";
import { addItemAttachments, createRun, insertAttachments, listAgents, postComment, removeItemAttachment, saveMcpServer, saveSkill, setAgentAttachment, updateAgent, updateRun } from "../db/repos/index.js";
import { agentAttachmentsHash, EMPTY_ATTACHMENTS_HASH } from "../agentAttachments/fingerprint.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { promptHash } from "../roles/prompts.js";
import type { ThreadReuse } from "./threadReuse.js";
import { EMPTY_ITEM_FILES_HASH, findReusableThread, itemFilesHash } from "./threadReuse.js";
import { skillRunScope } from "./workspaceResolution.js";

/**
 * Which prior run, if any, a dispatch may resume (EO-86).
 *
 * The rules are all of the form "this thread is not the one you think it
 * is": a thread born on another backend, under other instructions, in
 * another directory, for another agent or another item. Each one gets
 * a test, because the cost of getting one wrong is an agent silently
 * carrying on a conversation that does not apply to what it has been
 * asked to do.
 *
 * And every no-resume answer gets a sentence. A decision that says only
 * "no" leaves whoever calls it nothing to post, which is what invariant
 * #8 is about — so the assertions below check the reason as well as the
 * verdict.
 */
describe("findReusableThread", () => {
  /** Every action on an item shares one worktree — `createWorktreeWorkspace` sees to that. */
  const CWD = "/tmp/eo/worktrees/EO-90";

  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;
  let reviewer: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const agents = listAgents(handle.db);
    implementer = agents.find((agent) => agent.role === "implementer")!;
    reviewer = agents.find((agent) => agent.role === "reviewer")!;
  });

  afterEach(() => {
    handle.close();
  });

  /**
   * A run that finished the way a real dispatch does: a thread, a
   * backend, a recorded prompt, a recorded tool surface and a cwd.
   *
   * The surface is read from the database at the moment the row is
   * written, exactly as `dispatchRun` does it — so a test that attaches
   * something first gets a row that was genuinely born with it, and a
   * test about a row that recorded none says `null` out loud.
   */
  const dispatched = (overrides: Partial<CreateRunInput> = {}) =>
    createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "succeeded",
      threadId: "session-1",
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      agentAttachmentsHash: agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN),
      cwd: CWD,
      ...overrides,
    });

  const ask = (agent: Agent = implementer, cwd: string = CWD) =>
    findReusableThread(handle.db, { itemId: item.id, agent, cwd });

  /**
   * Asserts the verdict and hands back the sentence that came with it.
   *
   * Going through here rather than reading `.reason` inline is what
   * makes "no answer is silent" a property of every case below: there is
   * no way to assert a no-resume outcome in this file without also
   * asserting it said something.
   */
  const reasonFor = (decision: ThreadReuse, kind: "refused" | "no-thread"): string => {
    expect(decision.kind).toBe(kind);
    const reason = decision.kind === "resume" ? "" : decision.reason;
    expect(reason.length).toBeGreaterThan(0);
    return reason;
  };

  it("resumes the thread of a run that matches on every rule", () => {
    const prior = dispatched();

    expect(ask()).toEqual({ kind: "resume", run: prior });
  });

  it("says so plainly when this agent has never run on this item", () => {
    // Not a refusal — nothing was weighed up and turned down. A first
    // dispatch is a full-context run and always was, so this reason is
    // told apart by kind: a caller that posts every `refused` reason
    // does not put a comment on every new item saying EO did the
    // ordinary thing.
    const reason = reasonFor(ask(), "no-thread");

    expect(reason).toContain(implementer.name);
    expect(reason).toContain("hasn't run on this ticket before");
  });

  describe("what does not count as a candidate, and what it says about it", () => {
    it("skips a guard placeholder, and says the guard is why", () => {
      // `isGuardPlaceholder` is exactly `awaiting_input` with a null
      // thread: the attempt-limit guard refuses before any provider is
      // reached, so there is no session behind that row to resume.
      dispatched({ status: "awaiting_input", threadId: null });

      const reason = reasonFor(ask(), "no-thread");

      expect(reason).toContain("attempt-limit guard");
      expect(reason).toContain("no conversation was ever started");
    });

    it("skips a run that ended without ever opening a session", () => {
      // Not the guard — a run that died before the backend answered.
      // Same absence of a thread, different account of it.
      dispatched({ status: "failed", threadId: null });

      const reason = reasonFor(ask(), "no-thread");

      expect(reason).toContain("never opened a provider session");
    });

    it("skips a dry run, and says it was one", () => {
      // Somebody ran that to watch it work. Its conversation is not the
      // item's history, and resuming it would make it so.
      dispatched({ dryRun: true });

      const reason = reasonFor(ask(), "no-thread");

      expect(reason).toContain("was a dry run");
    });

    it("skips a run that is still running, and says it is still going", () => {
      dispatched({ status: "running" });

      const reason = reasonFor(ask(), "no-thread");

      expect(reason).toContain("still running");
    });

    it("skips a run parked awaiting input, and says the reply owns it", () => {
      // A parked run belongs to `resumeItem` — the person's reply is
      // what continues it. Handing its thread to a fresh dispatch too
      // would put two runs in one conversation.
      dispatched({ status: "awaiting_input" });

      const reason = reasonFor(ask(), "no-thread");

      expect(reason).toContain("parked waiting on a reply");
    });

    it("skips a thread the backend has already said it does not have", () => {
      // EO-93. The session was gone when a resume tried it, and the run
      // that found out marked it rather than nulling its own thread id.
      const lost = dispatched();
      updateRun(handle.db, lost.id, { threadLost: true });

      const reason = reasonFor(ask(), "no-thread");

      expect(reason).toContain("no longer on the backend");
      // Not a refusal: the person was already told, on the run that
      // discovered it. A second comment saying the same thing on the
      // very next dispatch would be EO explaining itself twice.
      expect(ask().kind).toBe("no-thread");
    });

    it("skips the runs before it too, since they are the same conversation", () => {
      // The whole bug this exists for. The marker sits on whichever run
      // found the session missing; the run before it holds the same
      // thread id and is older, so a check that looked only at the newest
      // run would skip the marked one and offer the dead thread again —
      // and again, on every dispatch, until the attempt limit refused the
      // item for a reason that has nothing to do with the work.
      dispatched(); // the original run, which opened session-1 and succeeded
      const lost = dispatched({ status: "cancelled" });
      updateRun(handle.db, lost.id, { threadLost: true });

      expect(reasonFor(ask(), "no-thread")).toContain("no longer on the backend");
    });

    it("still offers a later thread of the same agent's — the marker is on the conversation, not the agent", () => {
      const lost = dispatched();
      updateRun(handle.db, lost.id, { threadLost: true });
      // What the recovery dispatch leaves behind: a fresh full-context
      // run, on a session of its own. Losing one conversation must not
      // cost the item every one after it.
      const fresh = dispatched({ threadId: "session-2" });

      expect(ask()).toEqual({ kind: "resume", run: fresh });
    });

    it("skips a run by another agent on the same item", () => {
      const theirs = dispatched({
        agentId: reviewer.id,
        action: "review",
        instructionsHash: promptHash(reviewer.instructions),
        provider: reviewer.provider,
      });

      // Same item, same worktree, same backend — and still not the
      // implementer's conversation. From the implementer's side that is
      // indistinguishable from never having run here, and it is not owed
      // an account of somebody else's thread.
      expect(reasonFor(ask(), "no-thread")).toContain("hasn't run on this ticket before");
      expect(ask(reviewer)).toEqual({ kind: "resume", run: theirs });
    });

    it("skips this agent's run on another item", () => {
      const other = createTestItem(handle.db, { type: "story", title: "Another story", stepId: "todo" });
      createRun(handle.db, {
        itemId: other.id,
        agentId: implementer.id,
        action: "implement",
        status: "succeeded",
        threadId: "session-elsewhere",
        provider: implementer.provider,
        instructionsHash: promptHash(implementer.instructions),
        cwd: CWD,
      });

      expect(reasonFor(ask(), "no-thread")).toContain("hasn't run on this ticket before");
    });
  });

  describe("what breaks the thread, and what it says about it", () => {
    it("refuses a thread issued by another backend, naming both", () => {
      dispatched({ provider: "claude" });
      const agent = updateAgent(handle.db, implementer.id, { provider: "codex" });

      const reason = reasonFor(ask(agent), "refused");

      // The same thing `resumeBlockedReason` says on the human-reply
      // path. The two land on one board and must not disagree about what
      // happened.
      expect(reason).toContain('"claude"');
      expect(reason).toContain('"codex"');
      expect(reason).toContain("couldn't be carried over");
    });

    it("refuses a thread started under instructions that have since been edited, and says so", () => {
      dispatched();
      const agent = updateAgent(handle.db, implementer.id, {
        instructions: "Implement the ticket, and read ARCHITECTURE.md first.",
        promptHash: null,
      });

      const reason = reasonFor(ask(agent), "refused");

      // Neither backend re-sends instructions on resume, so without this
      // an edit would silently do nothing to every item in flight.
      expect(reason).toContain("instructions have changed");
      expect(reason).toContain("starting");
      expect(reason).toContain("picks the new instructions up");
    });

    it("refuses a run that recorded no backend at all, without naming a null one", () => {
      // A row predating A-07. `resumeBlockedReason` trusts one of these,
      // because there a person is waiting on a reply; here the whole
      // prize is tokens, so an unknown backend is refused.
      dispatched({ provider: null });

      const reason = reasonFor(ask(), "refused");

      expect(reason).toContain("no record of which backend");
      expect(reason).not.toContain("null");
    });

    it("refuses a run that has no recorded instructions at all", () => {
      // Null is the absence of an answer, not a match: a row written
      // before EO-87 says nothing about what its thread was born with,
      // and "nothing is known" is not "they are the same".
      dispatched({ instructionsHash: null });

      expect(reasonFor(ask(), "refused")).toContain("no record of the instructions");
    });

    /**
     * The tool surface, which is the other half of what a session is
     * opened with (EO-106).
     *
     * `threadReuse` refused on the provider, the worktree and the
     * instructions and said nothing about the servers and skills — on
     * backends that re-send configuration on resume no more than they
     * re-send instructions. Attaching a server mid-item would have
     * appeared to work and changed nothing.
     */
    it("refuses a thread born before a server was attached", () => {
      const prior = dispatched();
      // The row recorded the surface it was really born with: nothing.
      expect(prior.agentAttachmentsHash).toBe(EMPTY_ATTACHMENTS_HASH);

      const github = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name: "github", transport: "stdio", command: "gh-mcp" }));
      expect(github.ok).toBe(true);
      if (!github.ok) return;
      setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.server.id, attached: true });

      const reason = reasonFor(ask(), "refused");

      expect(reason).toContain("MCP servers or skills attached");
      expect(reason).toContain("keeps the tools it was started with");
    });

    it("refuses a thread whose attached skill has been edited since", () => {
      // Nothing was attached or detached — the same skill says something
      // different now, which is why the recorded value is a fingerprint
      // of the content rather than of the ids.
      const playbook = saveSkill(handle.db, SkillDraftSchema.parse({ name: "House style", description: "A house playbook.", body: "Read the diff." }));
      expect(playbook.ok).toBe(true);
      if (!playbook.ok) return;
      setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: playbook.skill.id, attached: true });
      dispatched();

      saveSkill(handle.db, SkillDraftSchema.parse({ id: playbook.skill.id, name: "House style", description: "A house playbook.", body: "Read the diff twice." }));

      expect(reasonFor(ask(), "refused")).toContain("MCP servers or skills attached");
    });

    it("refuses a thread started before an attached server was detached", () => {
      const github = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name: "github", transport: "stdio", command: "gh-mcp" }));
      expect(github.ok).toBe(true);
      if (!github.ok) return;
      setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.server.id, attached: true });
      dispatched();

      setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.server.id, attached: false });

      expect(reasonFor(ask(), "refused")).toContain("MCP servers or skills attached");
    });

    it("refuses a thread started in a different working directory", () => {
      // A Claude session resumes only from the cwd it started in, so
      // this is correctness rather than caution — even though in
      // practice every action on an item shares one worktree.
      dispatched({ cwd: "/tmp/eo/worktrees/EO-89" });

      const reason = reasonFor(ask(), "refused");

      expect(reason).toContain("/tmp/eo/worktrees/EO-89");
      expect(reason).toContain(CWD);
    });
  });

  describe("what deliberately does not break the thread", () => {
    it("resumes a run that failed", () => {
      // Breaking here would lose the saving exactly where retries are
      // most likely, and the in-run correction retry already resumes a
      // failed thread today.
      const prior = dispatched({ status: "failed" });

      expect(ask()).toEqual({ kind: "resume", run: prior });
    });

    it("resumes a run that was cancelled", () => {
      const prior = dispatched({ status: "cancelled" });

      expect(ask()).toEqual({ kind: "resume", run: prior });
    });

    /**
     * The one place a null is read as an answer rather than as a gap,
     * and the reason it is not the mistake `instructionsHash` would be
     * making (EO-106).
     *
     * Instructions always existed, so a row that recorded none has a
     * hole in it. Nothing could be attached before migration 0052, so a
     * row predating the column is not missing an answer — its thread was
     * born with an empty tool surface, which is exactly what it is read
     * as. Refusing here instead would cost every item in flight at
     * upgrade its conversation, to protect against a change that had not
     * happened.
     */
    it("resumes a run written before the attachments column, while the agent still has nothing attached", () => {
      const prior = dispatched({ agentAttachmentsHash: null });

      expect(ask()).toEqual({ kind: "resume", run: prior });
    });

    it("refuses that same run once something is attached", () => {
      // The other side of the rule above: read as the empty surface, a
      // pre-column row is refused the moment the agent has one — which
      // is the truthful answer, since the thread cannot have been given
      // a server that did not exist when it opened.
      dispatched({ agentAttachmentsHash: null });
      const playbook = saveSkill(handle.db, SkillDraftSchema.parse({ name: "House style", description: "A house playbook.", body: "Read the diff." }));
      expect(playbook.ok).toBe(true);
      if (!playbook.ok) return;
      setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: playbook.skill.id, attached: true });

      expect(reasonFor(ask(), "refused")).toContain("MCP servers or skills attached");
    });

    it("resumes when an attached server is untouched between two dispatches", () => {
      const github = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name: "github", transport: "stdio", command: "gh-mcp" }));
      expect(github.ok).toBe(true);
      if (!github.ok) return;
      setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.server.id, attached: true });
      const prior = dispatched();

      expect(ask()).toEqual({ kind: "resume", run: prior });
    });

    it("resumes after the agent's model changed", () => {
      // Both SDKs take a model override on resume, so breaking here
      // would be conservatism rather than a technical requirement.
      const prior = dispatched();
      const agent = updateAgent(handle.db, implementer.id, { model: "claude-opus-4" });

      expect(ask(agent)).toEqual({ kind: "resume", run: prior });
    });
  });

  describe("which of several qualifying runs wins", () => {
    it("takes the newest by id", () => {
      dispatched({ threadId: "session-older" });
      const newest = dispatched({ threadId: "session-newer" });

      expect(ask()).toEqual({ kind: "resume", run: newest });
    });

    it("still takes the newest by id when two runs share a started_at", () => {
      // `started_at` is a millisecond and ties — two runs on one tick is
      // exactly the case uuidv7's monotonic ids resolve. Sorting on the
      // timestamp would leave the winner to whatever order SQLite
      // happened to return.
      const older = dispatched({ threadId: "session-older" });
      const newest = dispatched({ threadId: "session-newer" });
      updateRun(handle.db, older.id, { startedAt: 1_700_000_000_000 });
      const tied = updateRun(handle.db, newest.id, { startedAt: 1_700_000_000_000 });

      expect(ask()).toEqual({ kind: "resume", run: tied });
    });

    it("reports the newest run's refusal when none of them qualifies", () => {
      dispatched({ threadId: "session-older", provider: "claude" });
      dispatched({ threadId: "session-newer", instructionsHash: "a-hash-of-something-else" });

      // The newest is the conversation the agent would have expected to
      // carry on, so it is the one the person is owed an account of.
      expect(reasonFor(ask(), "refused")).toContain("instructions have changed");
    });

    it("reports the refusal rather than a newer run that was never a candidate", () => {
      // A real thread EO decided against is the thing worth saying.
      // Answering "the last run was a dry run" would leave a person
      // wondering why the run before it wasn't used.
      dispatched({ threadId: "session-real", cwd: "/tmp/eo/worktrees/EO-89" });
      dispatched({ threadId: "session-dry", dryRun: true });

      expect(reasonFor(ask(), "refused")).toContain("/tmp/eo/worktrees/EO-89");
    });
  });
});

/**
 * A thread is not carried across a change to the item's own files
 * (EO-703). A dispatch lists them beside the description and a resumed
 * thread is told nothing about the item again, so a file added mid-work
 * would never be seen, and one removed would still be listed.
 */
describe("findReusableThread, with the item's own files (EO-703)", () => {
  const CWD = "/tmp/eo/worktrees/EO-703";

  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  });

  afterEach(() => {
    handle.close();
  });

  const addFile = (on: Item = item) => {
    const id = uuidv7();
    addItemAttachments(handle.db, on.id, [{ id, storagePath: `/tmp/eo/attachments/${id}`, name: "mock.png", mimeType: "image/png", size: 8 }]);
    return id;
  };

  /** A run recorded the way `dispatchRun` records one: with the item's files as they are now. */
  const dispatched = (overrides: Partial<CreateRunInput> = {}) =>
    createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "succeeded",
      threadId: "session-1",
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      agentAttachmentsHash: agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN),
      itemFilesHash: itemFilesHash(handle.db, item.id),
      cwd: CWD,
      ...overrides,
    });

  const ask = () => findReusableThread(handle.db, { itemId: item.id, agent: implementer, cwd: CWD });

  it("resumes a thread born with the files the item still holds", () => {
    addFile();
    const prior = dispatched();

    expect(ask()).toEqual({ kind: "resume", run: prior });
  });

  it("refuses the thread once a file is added to the item, and says why", () => {
    dispatched();
    addFile();

    const decision = ask();
    expect(decision.kind).toBe("refused");
    expect(decision.kind === "refused" ? decision.reason : "").toContain("The files on this item have changed");
  });

  it("refuses the thread once a file is removed from the item", () => {
    const id = addFile();
    dispatched();
    removeItemAttachment(handle.db, id);

    expect(ask().kind).toBe("refused");
  });

  it("does not fall back to an older thread across a change to the files: add, run, remove", () => {
    // Thread A is born with no files; a file is added and thread B is
    // born with it; the file is removed. A's list matches again, but
    // every turn since A has worked from another one.
    dispatched({ threadId: "session-a" });
    const id = addFile();
    dispatched({ threadId: "session-b" });
    removeItemAttachment(handle.db, id);

    const decision = ask();
    expect(decision.kind).toBe("refused");
    expect(decision.kind === "refused" ? decision.reason : "").toContain("The files on this item have changed");
  });

  it("still falls back past a newer thread refused for something else, where the files never changed", () => {
    addFile();
    const older = dispatched({ threadId: "session-a" });
    dispatched({ threadId: "session-b", cwd: "/tmp/eo/worktrees/elsewhere" });

    expect(ask()).toEqual({ kind: "resume", run: older });
  });

  it("is not moved by a file on another item, or by a comment's file on this one", () => {
    const prior = dispatched();
    addFile(createTestItem(handle.db, { type: "story", title: "Another story", stepId: "todo" }));
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "A screenshot." });
    insertAttachments(handle.db, [{ id: uuidv7(), itemId: item.id, commentId: comment.id, storagePath: "/tmp/eo/attachments/c", name: "shot.png", mimeType: "image/png", size: 8 }]);

    expect(ask()).toEqual({ kind: "resume", run: prior });
  });

  it("reads a run written before the column as born with no files", () => {
    const prior = dispatched({ itemFilesHash: null });
    expect(itemFilesHash(handle.db, item.id)).toBe(EMPTY_ITEM_FILES_HASH);
    expect(ask()).toEqual({ kind: "resume", run: prior });

    addFile();
    expect(ask().kind).toBe("refused");
  });
});

/**
 * Thread reuse measures the skills a run is actually given (EO-470).
 *
 * A skill scoped to the item's project or its step's workspace is part
 * of that run's surface; one scoped anywhere else is not. So attaching a
 * skill for this project refuses the old thread, and attaching one for
 * another project leaves it resumable.
 */
describe("findReusableThread, with scoped skills (EO-470)", () => {
  const CWD = "/tmp/eo/worktrees/P-1";
  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;
  let projectId: string;
  let workspaceId: string;

  beforeEach(() => {
    handle = openMigratedTestDb();
    const workspace = attachWorkspace(handle.db, { keyPrefix: "P", name: "app", repoPath: "/tmp/eo/app" });
    projectId = workspace.projectId!;
    workspaceId = workspace.id;
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", projectId: workspace.projectId, workspaceId: workspace.id });
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  });

  afterEach(() => {
    handle.close();
  });

  const attachScoped = (name: string, scope: SkillScope) => {
    const saved = saveSkill(handle.db, SkillDraftSchema.parse({ name, description: "A procedure.", body: "Step one.", scope }));
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: saved.skill.id, attached: true });
  };

  const dispatched = () =>
    createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "succeeded",
      threadId: "session-1",
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      agentAttachmentsHash: agentAttachmentsHash(handle.db, implementer.id, skillRunScope(handle.db, item)),
      cwd: CWD,
    });

  const ask = () => findReusableThread(handle.db, { itemId: item.id, agent: implementer, cwd: CWD });

  it("refuses the thread once a skill scoped to this item's project is attached", () => {
    dispatched();
    attachScoped("E2E", { kind: "project", projectId });
    const decision = ask();
    expect(decision.kind).toBe("refused");
  });

  it("refuses the thread once a skill scoped to the workspace its step works in is attached", () => {
    dispatched();
    attachScoped("Build", { kind: "workspace", workspaceId });
    expect(ask().kind).toBe("refused");
  });

  it("still resumes when the skill attached is scoped to another project or workspace", () => {
    const prior = dispatched();
    attachScoped("Elsewhere", { kind: "project", projectId: "another-project" });
    attachScoped("Other disk", { kind: "workspace", workspaceId: "another-workspace" });
    expect(ask()).toEqual({ kind: "resume", run: prior });
  });

  it("resolves the run's scope to the item's project and its step's workspace", () => {
    expect(skillRunScope(handle.db, item)).toEqual({ projectId, workspaceId });
  });
});
