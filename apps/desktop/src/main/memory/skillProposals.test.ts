import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SKILL_PROPOSAL_DISCARD,
  SKILL_PROPOSAL_PROPOSE_AGAIN,
  SKILL_PROPOSAL_SAVE,
  type Comment,
  type MemoryEntryView,
  type MemoryScope,
  type SideCallResult,
  type SkillProposal,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import {
  addMemory,
  createRun,
  getAgentAttachments,
  getItem,
  getSkill,
  getSkillBySlug,
  listAgents,
  listAttachmentsForComment,
  listCommentsForItem,
  listConsolidations,
  listMemories,
  listMentionsForComment,
  listSkills,
  restoreConsolidation,
  saveSkill,
  setAgentAttachment,
  archiveSkill,
  decideSkillProposal,
  recordSkillProposal,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { postHumanComment } from "../ipc/domainCommands.js";
import { findProjectThread } from "../projects/projectThread.js";
import type { SideCallRequest } from "../sideCalls/sideCall.js";
import { MEMORY_PROPOSE_SKILLS_SYSTEM } from "./consolidation.js";
import { createMemoryConsolidator } from "./consolidator.js";
import { coveringEntries, type ProposalFileStore } from "./skillProposals.js";

/**
 * Memory consolidation proposes skills (EO-483): what a proposal posts on
 * the project's thread, and what Save and Discard on it do — through the
 * reply path a person's press actually takes (`comments:post`). The
 * proposals come from a call of their own, made once a consolidation has
 * succeeded (EO-575).
 */
type Answer = SideCallResult<unknown>;
type AnyRequest = SideCallRequest<unknown>;

const isProposing = (request: AnyRequest) => request.system === MEMORY_PROPOSE_SKILLS_SYSTEM;

const DAY = 24 * 60 * 60 * 1000;
const CAPS = { maxEntries: 6, maxChars: 40_000 };

const E2E_BODY = [
  "## Trigger",
  "Use this when the e2e suite has to run or has failed.",
  "",
  "## Steps",
  "1. Start a virtual display: `Xvfb :99 &` and `export DISPLAY=:99`.",
  "2. Run `pnpm e2e`.",
  "3. On a failure, rerun the one spec with `pnpm e2e --debug <spec>`.",
  "",
  "## Verification",
  "The run ends with every spec passing and no `Missing X server` line.",
].join("\n");

describe("skills proposed by memory consolidation", () => {
  let handle: DbHandle;
  let scratch: string;
  let storage: AttachmentStorage;
  let workspace: MemoryScope;
  let projectId: Uuid;
  let itemId: Uuid;
  let itemKey: string;
  let implementerId: Uuid;
  let reviewerId: Uuid;
  let implementerRun: Uuid;
  let reviewerRun: Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
    scratch = mkdtempSync(join(tmpdir(), "eo-skill-proposals-"));
    storage = new AttachmentStorage(join(scratch, "files"));
    const w = attachWorkspace(handle.db, { keyPrefix: "P", name: "api", repoPath: scratch });
    workspace = { kind: "workspace", id: w.id };
    projectId = w.projectId! as Uuid;
    const item = createTestItem(handle.db, { type: "story", title: "Add CSV export", stepId: "todo", projectId, workspaceId: w.id });
    itemId = item.id;
    itemKey = item.key;
    const agents = listAgents(handle.db);
    implementerId = agents.find((agent) => agent.role === "implementer")!.id as Uuid;
    reviewerId = agents.find((agent) => agent.role === "reviewer")!.id as Uuid;
    implementerRun = createRun(handle.db, { itemId, agentId: implementerId, action: "implement", status: "succeeded" }).id;
    reviewerRun = createRun(handle.db, { itemId, agentId: reviewerId, action: "review", status: "succeeded" }).id;
  });

  afterEach(() => {
    handle.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  function note(body: string, run: Uuid, at: number): MemoryEntryView {
    const written = addMemory(handle.db, { scope: workspace, body, source: { type: "run", runId: run, itemId }, now: at });
    if (!written.ok) throw new Error(written.problem);
    return written.entry;
  }

  /** Six agent-written entries — the cap — two of which are the e2e procedure, written by two agents' runs. */
  function memory(at = Date.now() - 3 * DAY): { evidence: MemoryEntryView[]; facts: MemoryEntryView[] } {
    const evidence = [
      note("To run e2e here: `Xvfb :99 &`, `export DISPLAY=:99`, then `pnpm e2e`.", implementerRun, at),
      note("e2e failed with Missing X server again; started Xvfb and reran one spec with `pnpm e2e --debug`.", reviewerRun, at + 1),
    ];
    const facts = [1, 2, 3, 4].map((index) => note(`The ledger is in UTC (${index}).`, implementerRun, at + 10 + index));
    return { evidence, facts };
  }

  function proposal(evidence: readonly MemoryEntryView[], overrides: Partial<SkillProposal> = {}): SkillProposal {
    return {
      kind: "new",
      slug: "run-e2e",
      name: "Run the e2e suite",
      description: "Run or debug this repository's e2e suite under a virtual display.",
      scope: workspace,
      evidence: { entryIds: evidence.map((entry) => entry.id), itemIds: [itemId] },
      body: E2E_BODY,
      ...overrides,
    } as SkillProposal;
  }

  /** A scripted answer, put through the request's own schema as a real side call's is, so one that would not pass it fails here. */
  function answering(request: AnyRequest, value: unknown): Answer {
    const parsed = request.schema.safeParse(value);
    if (!parsed.success) throw new Error(`the scripted answer fails its schema: ${parsed.error.message}`);
    return { ok: true, value: parsed.data };
  }

  /** A consolidator whose consolidation answers `operations` and whose skill proposal call answers `skills`. */
  async function run(operations: (request: AnyRequest) => unknown, skills: (request: AnyRequest) => SkillProposal[], store: ProposalFileStore = storage) {
    const sideCall = vi.fn(async (request: AnyRequest): Promise<Answer> => answering(request, isProposing(request) ? { skills: skills(request) } : operations(request)));
    const consolidator = createMemoryConsolidator({ db: handle.db, sideCall: sideCall as never, caps: () => CAPS, store });
    consolidator.start();
    await consolidator.idle();
    consolidator.stop();
    return sideCall.mock.calls.map((call) => call[0]);
  }

  /**
   * One consolidation that folds the four facts into one and retires what
   * an earlier one left, then the skill proposal call after it, which
   * proposes `answer` — the evidence, untouched by the consolidation, is
   * among the entries it is given. Answers with the proposal call's request.
   */
  async function consolidate(
    answer: (sent: { evidence: MemoryEntryView[]; facts: MemoryEntryView[] }) => SkillProposal[],
    given = memory(),
    store: ProposalFileStore = storage,
  ) {
    const requests = await run(
      (request) => {
        // What an earlier consolidation left is retired, so the scope ends
        // as the evidence and one fact whatever came before.
        const mine = new Set([...given.evidence, ...given.facts].map((entry) => entry.id));
        const earlier = [...request.input.matchAll(/^### (\S+) \(written /gm)].map((match) => match[1]!).filter((id) => !mine.has(id));
        return {
          retire: earlier.map((id) => ({ id, reason: "Stale." })),
          merge: [{ body: "The ledger is in UTC.", from: given.facts.map((entry) => entry.id), contradictsRepositoryFile: false }],
          rewrite: [],
        };
      },
      () => answer(given),
      store,
    );
    // The consolidation's call, then the proposal call after it.
    expect(requests.map(isProposing)).toEqual([false, true]);
    return { ...given, request: requests[1]! };
  }

  function thread(): Uuid {
    const found = findProjectThread(handle.db, projectId);
    if (!found) throw new Error("the project has no thread");
    return found.id as Uuid;
  }

  function proposals(): Comment[] {
    const at = findProjectThread(handle.db, projectId);
    return at ? listCommentsForItem(handle.db, at.id as Uuid).filter((comment) => comment.authorType === "engine" && comment.parentId === null) : [];
  }

  function press(offer: Comment, option: string) {
    return postHumanComment(handle.db, undefined, { itemId: offer.itemId, body: option, parentId: offer.id, mentions: [], pinned: false, attachmentIds: [] });
  }

  function replyTo(offer: Comment): Comment | undefined {
    return listCommentsForItem(handle.db, offer.itemId as Uuid).find((comment) => comment.parentId === offer.id && comment.authorType === "engine");
  }

  describe("posting", () => {
    it("posts each proposal as one comment on the project thread that mentions the person, lists its evidence with the items, attaches SKILL.md and offers Save and Discard", async () => {
      const { evidence, request } = await consolidate((sent) => [proposal(sent.evidence)]);

      // What the consolidation is told it may propose against.
      expect(request.input).toContain(`"kind":"workspace","id":"${workspace.id}"`);
      expect(request.input).toContain(`from item ${itemId}`);
      expect(request.input).toContain("## Existing skills");
      // Nothing was discarded yet, so there is nothing to be told about.
      expect(request.input).not.toContain("## Skill proposals a person discarded");

      const posted = proposals();
      expect(posted).toHaveLength(1);
      const [offer] = posted;
      expect(offer!.itemId).toBe(thread());
      expect(offer!.kind).toBe("question");
      expect(offer!.options).toEqual([SKILL_PROPOSAL_SAVE, SKILL_PROPOSAL_DISCARD]);
      expect(listMentionsForComment(handle.db, offer!.id)).toEqual([expect.objectContaining({ targetType: "human", status: "open" })]);

      expect(offer!.body).toContain("`run-e2e`");
      expect(offer!.body).toContain("Run or debug this repository's e2e suite under a virtual display.");
      for (const entry of evidence) expect(offer!.body).toContain(entry.id);
      // Item keys in a comment are drawn as links to the item.
      expect(offer!.body).toContain(`from ${itemKey}`);
      expect(offer!.body).toContain(`Seen on ${itemKey}.`);
      expect(offer!.body).toMatch(/attaches it to (Implementer and Reviewer|Reviewer and Implementer)/);

      const files = listAttachmentsForComment(handle.db, offer!.id);
      expect(files.map((file) => file.name)).toEqual(["SKILL.md"]);
      const draft = readFileSync(files[0]!.path, "utf8");
      expect(draft).toContain('name: "run-e2e"');
      expect(draft).toContain(`description: "Run or debug this repository's e2e suite under a virtual display."`);
      for (const section of ["## Trigger", "## Steps", "## Verification"]) expect(draft).toContain(section);
    });

    it("saves and attaches nothing, and retires nothing, until a person presses Save", async () => {
      const before = listSkills(handle.db, true).length;
      const { evidence } = await consolidate((sent) => [proposal(sent.evidence)]);

      expect(listSkills(handle.db, true)).toHaveLength(before);
      expect(getSkillBySlug(handle.db, "run-e2e")).toBeUndefined();
      expect(getAgentAttachments(handle.db, implementerId).skillIds).toEqual([]);
      const active = listMemories(handle.db, workspace).map((entry) => entry.id);
      for (const entry of evidence) expect(active).toContain(entry.id);
    });

    it("posts at most what it was given, one comment per proposal", async () => {
      await consolidate((sent) => [
        proposal(sent.evidence),
        proposal(sent.evidence, { slug: "debug-e2e", description: "Debug one failing e2e spec." }),
      ]);
      expect(proposals()).toHaveLength(2);
    });

    it("posts a proposal whose slug is taken without Save, and says why", async () => {
      const taken = saveSkill(handle.db, { slug: "run-e2e", name: "Someone's", description: "Already here.", body: "Body.", files: [] });
      expect(taken.ok).toBe(true);
      await consolidate((sent) => [proposal(sent.evidence)]);

      const [offer] = proposals();
      expect(offer!.options).toEqual([SKILL_PROPOSAL_DISCARD]);
      expect(offer!.body).toContain("This cannot be saved.");
      expect(offer!.body).toContain("The slug `run-e2e` is already taken");
      // Typing Save anyway does nothing: it was not offered.
      await press(offer!, SKILL_PROPOSAL_SAVE);
      expect(getSkillBySlug(handle.db, "run-e2e")!.description).toBe("Already here.");
      expect(replyTo(offer!)).toBeUndefined();
    });

    it("posts an improvement whose target is gone without Save, and says why", async () => {
      await consolidate((sent) => [proposal(sent.evidence, { kind: "improvement", target: "run-tests", slug: "run-tests" } as Partial<SkillProposal>)]);

      const [offer] = proposals();
      expect(offer!.options).toEqual([SKILL_PROPOSAL_DISCARD]);
      expect(offer!.body).toContain("The skill it improves, `run-tests`, no longer exists");
    });

    it("posts nothing and notes nothing for an answer that proposes no skill", async () => {
      // An empty `skills` posts nothing and says nothing.
      memory();
      await run(
        () => ({ retire: [], merge: [], rewrite: [] }),
        () => [],
      );
      expect(proposals()).toEqual([]);
      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "succeeded", note: null });
    });
  });

  describe("Save on a new skill", () => {
    it("creates it in the proposal's scope, attaches it to the agents whose runs wrote the evidence, and retires the evidence with a tag the consolidation's restore brings back", async () => {
      const { evidence, facts } = await consolidate((sent) => [proposal(sent.evidence)]);
      const [offer] = proposals();
      const [consolidation] = listConsolidations(handle.db, workspace);

      await press(offer!, SKILL_PROPOSAL_SAVE);

      const skill = getSkillBySlug(handle.db, "run-e2e");
      expect(skill).toMatchObject({
        name: "Run the e2e suite",
        description: "Run or debug this repository's e2e suite under a virtual display.",
        body: E2E_BODY,
        scope: { kind: "workspace", workspaceId: workspace.id },
        enabled: true,
      });
      expect(getAgentAttachments(handle.db, implementerId).skillIds).toEqual([skill!.id]);
      expect(getAgentAttachments(handle.db, reviewerId).skillIds).toEqual([skill!.id]);
      const other = listAgents(handle.db).filter((agent) => agent.id !== implementerId && agent.id !== reviewerId);
      for (const agent of other) expect(getAgentAttachments(handle.db, agent.id).skillIds).toEqual([]);

      const all = listMemories(handle.db, workspace, { includeRetired: true });
      for (const entry of evidence) {
        expect(all.find((candidate) => candidate.id === entry.id)).toMatchObject({ retiredReason: "moved_to_skill", consolidationId: consolidation!.id });
      }
      expect(replyTo(offer!)!.body).toContain("Saved the skill `run-e2e`");
      expect(listMentionsForComment(handle.db, offer!.id)[0]).toMatchObject({ status: "addressed" });

      // Restoring the consolidation puts the moved entries back with the
      // ones it folded, and retires what it wrote. The skill stays.
      const restored = restoreConsolidation(handle.db, consolidation!.id, { caps: CAPS });
      expect(restored.ok).toBe(true);
      const active = listMemories(handle.db, workspace).map((entry) => entry.id).sort();
      expect(active).toEqual([...evidence, ...facts].map((entry) => entry.id).sort());
      expect(getSkill(handle.db, skill!.id)?.archivedAt).toBeNull();
    });

    it("moves an entry the consolidation rewrote, named as evidence by the proposal call after it, and the consolidation's restore puts back what it replaced", async () => {
      const given = memory();
      const rewritten = "To run e2e here: start Xvfb on :99 (`Xvfb :99 &`, `export DISPLAY=:99`), then `pnpm e2e`.";
      await run(
        () => ({
          retire: [],
          merge: [{ body: "The ledger is in UTC.", from: given.facts.map((entry) => entry.id), contradictsRepositoryFile: false }],
          rewrite: [{ id: given.evidence[0]!.id, body: rewritten, contradictsRepositoryFile: false }],
        }),
        // The proposal call is given the entries as the consolidation left them: the rewritten one, not the one it replaced.
        (request) => {
          const written = listMemories(handle.db, workspace).find((entry) => entry.body === rewritten)!;
          expect(request.input).toContain(written.id);
          expect(request.input).not.toContain(given.evidence[0]!.id);
          return [proposal([written, given.evidence[1]!])];
        },
      );

      const [offer] = proposals();
      expect(offer!.body).toContain("moves the 2 entries holding this procedure out of memory");
      await press(offer!, SKILL_PROPOSAL_SAVE);
      expect(listMemories(handle.db, workspace).map((entry) => entry.body)).toEqual(["The ledger is in UTC."]);

      // Restored, the scope is the set from before the consolidation: the
      // entries it replaced are back, the evidence it left as it was comes
      // back from the skill, and the one it wrote — moved since — stays retired.
      const [consolidation] = listConsolidations(handle.db, workspace);
      expect(restoreConsolidation(handle.db, consolidation!.id, { caps: CAPS }).ok).toBe(true);
      const active = listMemories(handle.db, workspace).map((entry) => entry.id).sort();
      expect(active).toEqual([...given.evidence, ...given.facts].map((entry) => entry.id).sort());
    });

    it("leaves in memory an entry the consolidation merged the procedure into together with another fact, and says so", async () => {
      const given = memory();
      const mixed = "e2e needs Xvfb on :99. The ledger is in UTC.";
      await run(
        () => ({
          retire: [],
          merge: [{ body: mixed, from: [...given.evidence, ...given.facts].map((entry) => entry.id), contradictsRepositoryFile: false }],
          rewrite: [],
        }),
        // The proposal call sees only the merged entry, and cites it.
        () => [proposal(listMemories(handle.db, workspace).filter((entry) => entry.body === mixed))],
      );

      const [offer] = proposals();
      expect(offer!.body).toContain("One memory entry holds this procedure folded together with other entries, so Save leaves it in memory");
      expect(offer!.body).not.toContain("moves the");
      await press(offer!, SKILL_PROPOSAL_SAVE);

      expect(getSkillBySlug(handle.db, "run-e2e")).toBeDefined();
      // The unrelated fact is still in memory, in the entry that holds it.
      expect(listMemories(handle.db, workspace).map((entry) => entry.body)).toEqual([mixed]);
    });

    it("leaves in memory an entry folded from several, though they all held the procedure: nothing kept says which did", async () => {
      const given = memory();
      const folded = "e2e needs Xvfb on :99; debug one spec with `pnpm e2e --debug`.";
      await run(
        () => ({
          retire: [],
          merge: [
            { body: folded, from: given.evidence.map((entry) => entry.id), contradictsRepositoryFile: false },
            { body: "The ledger is in UTC.", from: given.facts.map((entry) => entry.id), contradictsRepositoryFile: false },
          ],
          rewrite: [],
        }),
        () => [proposal(listMemories(handle.db, workspace).filter((entry) => entry.body === folded))],
      );

      await press(proposals()[0]!, SKILL_PROPOSAL_SAVE);
      expect(getSkillBySlug(handle.db, "run-e2e")).toBeDefined();
      expect(listMemories(handle.db, workspace).map((entry) => entry.body).sort()).toEqual([folded, "The ledger is in UTC."].sort());
    });

    it("refuses, writing nothing, once the consolidation that proposed it has been restored — and a later one may propose it again", async () => {
      const { evidence } = await consolidate((sent) => [proposal(sent.evidence)]);
      const [consolidation] = listConsolidations(handle.db, workspace);
      expect(restoreConsolidation(handle.db, consolidation!.id, { caps: CAPS }).ok).toBe(true);
      const before = listMemories(handle.db, workspace, { includeRetired: true });

      const [offer] = proposals();
      await press(offer!, SKILL_PROPOSAL_SAVE);

      expect(replyTo(offer!)!.body).toContain("has since been restored");
      expect(getSkillBySlug(handle.db, "run-e2e")).toBeUndefined();
      expect(getAgentAttachments(handle.db, implementerId).skillIds).toEqual([]);
      expect(listMemories(handle.db, workspace, { includeRetired: true })).toEqual(before);
      for (const entry of evidence) expect(listMemories(handle.db, workspace).map((active) => active.id)).toContain(entry.id);

      // Not "still waiting": a later consolidation posts it afresh.
      await consolidate((sent) => [proposal(sent.evidence)], memory(Date.now() + 1_000));
      expect(proposals()).toHaveLength(2);
    });

    it("is answered once: a second press changes nothing", async () => {
      await consolidate((sent) => [proposal(sent.evidence)]);
      const [offer] = proposals();
      await press(offer!, SKILL_PROPOSAL_SAVE);
      await press(offer!, SKILL_PROPOSAL_SAVE);
      expect(listCommentsForItem(handle.db, offer!.itemId as Uuid).filter((comment) => comment.parentId === offer!.id && comment.authorType === "engine")).toHaveLength(1);
    });

    it("refuses, saying why, when the slug was taken after it was posted", async () => {
      await consolidate((sent) => [proposal(sent.evidence)]);
      const [offer] = proposals();
      saveSkill(handle.db, { slug: "run-e2e", name: "Meanwhile", description: "Made by hand.", body: "Body.", files: [] });

      await press(offer!, SKILL_PROPOSAL_SAVE);
      expect(getSkillBySlug(handle.db, "run-e2e")!.description).toBe("Made by hand.");
      expect(replyTo(offer!)!.body).toContain("Nothing was saved.");
      expect(getAgentAttachments(handle.db, implementerId).skillIds).toEqual([]);
    });
  });

  describe("Save on an improvement", () => {
    it("is bound to the skill it was posted against: renamed, with another skill now holding its slug, it refuses and changes neither skill nor memory", async () => {
      const a = saveSkill(handle.db, { slug: "run-e2e", name: "Run e2e", description: "Run the e2e suite.", body: "A's body.", files: [] });
      if (!a.ok) throw new Error(a.problems.join(" "));
      await consolidate((sent) => [proposal(sent.evidence, { kind: "improvement", target: "run-e2e", slug: "run-e2e" } as Partial<SkillProposal>)]);
      const [offer] = proposals();
      expect(offer!.options).toContain(SKILL_PROPOSAL_SAVE);

      // A is renamed, and B takes the slug it left.
      const renamed = saveSkill(handle.db, { id: a.skill.id, slug: "run-e2e-old", name: a.skill.name, description: a.skill.description, body: a.skill.body, files: [] });
      expect(renamed.ok).toBe(true);
      const b = saveSkill(handle.db, { slug: "run-e2e", name: "Someone else's", description: "Unrelated.", body: "B's body.", files: [] });
      if (!b.ok) throw new Error(b.problems.join(" "));
      const memoryBefore = listMemories(handle.db, workspace, { includeRetired: true });

      await press(offer!, SKILL_PROPOSAL_SAVE);

      expect(getSkill(handle.db, b.skill.id)).toEqual(b.skill);
      expect(getSkill(handle.db, a.skill.id)!.body).toBe("A's body.");
      expect(listMemories(handle.db, workspace, { includeRetired: true })).toEqual(memoryBefore);
      expect(replyTo(offer!)!.body).toContain("Nothing was saved.");
      expect(replyTo(offer!)!.body).toContain("has since been renamed `run-e2e-old`");
    });

    it("refuses when its target was archived and another skill took the slug", async () => {
      const a = saveSkill(handle.db, { slug: "run-e2e", name: "Run e2e", description: "Run the e2e suite.", body: "A's body.", files: [] });
      if (!a.ok) throw new Error(a.problems.join(" "));
      await consolidate((sent) => [proposal(sent.evidence, { kind: "improvement", target: "run-e2e", slug: "run-e2e" } as Partial<SkillProposal>)]);
      saveSkill(handle.db, { id: a.skill.id, slug: "run-e2e-archived", name: a.skill.name, description: a.skill.description, body: a.skill.body, files: [] });
      archiveSkill(handle.db, a.skill.id);
      const b = saveSkill(handle.db, { slug: "run-e2e", name: "B", description: "B.", body: "B's body.", files: [] });
      if (!b.ok) throw new Error("no B");

      await press(proposals()[0]!, SKILL_PROPOSAL_SAVE);
      expect(getSkill(handle.db, b.skill.id)!.body).toBe("B's body.");
      expect(replyTo(proposals()[0]!)!.body).toContain("no longer exists");
    });

    it("updates the target's body and leaves its scope and attachments as they were, with the diff attached beside the draft", async () => {
      const existing = saveSkill(handle.db, { slug: "run-e2e", name: "Run the e2e suite", description: "Run the e2e suite.", body: "## Steps\nRun `pnpm e2e`.", files: [{ path: "notes.md", content: "x" }] });
      if (!existing.ok) throw new Error(existing.problems.join(" "));
      const target = existing.skill;
      // Attached to another agent only, and global.
      const designer = listAgents(handle.db).find((agent) => agent.id !== implementerId && agent.id !== reviewerId)!;
      setAgentAttachment(handle.db, { agentId: designer.id, kind: "skill", id: target.id, attached: true });

      await consolidate((sent) => [proposal(sent.evidence, { kind: "improvement", target: "run-e2e", slug: "run-e2e" } as Partial<SkillProposal>)]);
      const [offer] = proposals();
      expect(offer!.options).toEqual([SKILL_PROPOSAL_SAVE, SKILL_PROPOSAL_DISCARD]);
      expect(listAttachmentsForComment(handle.db, offer!.id).map((file) => file.name)).toEqual(["SKILL.md", "SKILL.md.diff"]);
      expect(offer!.body).toContain("leaving its scope and the agents it is attached to as they are");

      await press(offer!, SKILL_PROPOSAL_SAVE);

      const after = getSkill(handle.db, target.id)!;
      expect(after.body).toBe(E2E_BODY);
      expect(after).toMatchObject({ slug: "run-e2e", name: target.name, description: target.description, scope: target.scope, files: target.files, enabled: true });
      expect(getAgentAttachments(handle.db, designer.id).skillIds).toEqual([target.id]);
      expect(getAgentAttachments(handle.db, implementerId).skillIds).toEqual([]);
      expect(getAgentAttachments(handle.db, reviewerId).skillIds).toEqual([]);
      expect(replyTo(offer!)!.body).toContain("Updated the skill `run-e2e`'s body");
    });

    it("refuses when the target was archived after it was posted", async () => {
      const existing = saveSkill(handle.db, { slug: "run-e2e", name: "Run", description: "Run.", body: "Body.", files: [] });
      if (!existing.ok) throw new Error("no skill");
      await consolidate((sent) => [proposal(sent.evidence, { kind: "improvement", target: "run-e2e", slug: "run-e2e" } as Partial<SkillProposal>)]);
      archiveSkill(handle.db, existing.skill.id);

      await press(proposals()[0]!, SKILL_PROPOSAL_SAVE);
      expect(getSkill(handle.db, existing.skill.id)!.body).toBe("Body.");
      expect(replyTo(proposals()[0]!)!.body).toContain("no longer exists");
    });
  });

  describe("Discard", () => {
    it("records the fingerprint, and a later consolidation that returns the same proposal posts nothing for it", async () => {
      await consolidate((sent) => [proposal(sent.evidence)]);
      const [offer] = proposals();
      await press(offer!, SKILL_PROPOSAL_DISCARD);
      expect(replyTo(offer!)!.body).toContain("will not propose `run-e2e` again");
      expect(getSkillBySlug(handle.db, "run-e2e")).toBeUndefined();

      // A later consolidation, worded with different capitals and
      // punctuation, proposes it again.
      // Written after the first one settled the scope, so it is due again.
      await consolidate((sent) => [proposal(sent.evidence, { description: "run or debug this repository's E2E suite, under a virtual display!" })], memory(Date.now() + 1_000));
      expect(proposals()).toHaveLength(1);
      const [later] = listConsolidations(handle.db, workspace);
      expect(later!.note).toContain("was discarded before");
    });

    it("holds back a proposal with the same scope and slug whatever its description says (EO-512)", async () => {
      await consolidate((sent) => [proposal(sent.evidence)]);
      await press(proposals()[0]!, SKILL_PROPOSAL_DISCARD);

      // Reworded from end to end: no fingerprint of the description could match it.
      await consolidate(
        (sent) => [proposal(sent.evidence, { name: "E2E under Xvfb", description: "Use when Playwright cannot find an X server: start Xvfb, then rerun the failing spec." })],
        memory(Date.now() + 1_000),
      );
      expect(proposals()).toHaveLength(1);
      const [later] = listConsolidations(handle.db, workspace);
      expect(later!.note).toContain("`run-e2e` was discarded before");
    });

    it("tells a later proposal call for the scope what was discarded, by slug and description, and not to propose it again", async () => {
      await consolidate((sent) => [proposal(sent.evidence)]);
      await press(proposals()[0]!, SKILL_PROPOSAL_DISCARD);

      const { request } = await consolidate(() => [], memory(Date.now() + 1_000));
      const told = request.input.slice(request.input.indexOf("## Skill proposals a person discarded"));
      expect(told).toMatch(/^## Skill proposals a person discarded\n/);
      expect(told).toContain("Do not propose them again");
      expect(told).toContain("- `run-e2e`: Run or debug this repository's e2e suite under a virtual display.");
    });

    it("holds back a reworded one whose slug a person discards while it is being posted (EO-512)", async () => {
      await consolidate((sent) => [proposal(sent.evidence)]);
      const [earlier] = proposals();

      // The draft is stored between the first check and the write: the
      // person presses Discard on the earlier one, still open, right then.
      const staged: string[] = [];
      let discarded = false;
      const pausing: ProposalFileStore = {
        async storeImported(file) {
          if (!discarded) {
            discarded = true;
            await press(earlier!, SKILL_PROPOSAL_DISCARD);
          }
          const record = await storage.storeImported(file);
          staged.push(record.storagePath);
          return record;
        },
        rollback: (records) => storage.rollback(records),
      };
      // Reworded, so the fingerprint of the open one did not hold it back when it was first asked.
      await consolidate(
        (sent) => [proposal(sent.evidence, { description: "Use when Playwright cannot find an X server: start Xvfb, then rerun the failing spec." })],
        memory(Date.now() + 1_000),
        pausing,
      );

      expect(discarded).toBe(true);
      expect(proposals()).toHaveLength(1);
      const [later] = listConsolidations(handle.db, workspace);
      expect(later!.note).toContain("`run-e2e` was discarded before");
      // Its draft was staged, and removed again: it belongs to no comment.
      expect(staged).toHaveLength(1);
      for (const path of staged) expect(existsSync(path)).toBe(false);
    });

    it("tells the proposal call of every discarded proposal, however many there are (EO-512)", async () => {
      const slugs = Array.from({ length: 45 }, (_, at) => `old-procedure-${at + 1}`);
      slugs.forEach((slug, at) => {
        const description = `Do old procedure ${at + 1}.`;
        const record = recordSkillProposal(handle.db, {
          consolidationId: "earlier",
          scope: workspace,
          kind: "new",
          targetSlug: null,
          targetSkillId: null,
          slug,
          name: slug,
          description,
          body: E2E_BODY,
          evidenceEntryIds: [],
          evidenceItemIds: [],
          coveringEntryIds: [],
          fingerprint: `${slug}:${description}`,
          unsaveable: null,
          commentId: null,
          createdAt: at,
        });
        decideSkillProposal(handle.db, record.id, { status: "discarded", now: at });
      });

      const { request } = await consolidate(() => []);
      for (const [at, slug] of slugs.entries()) expect(request.input).toContain(`- \`${slug}\`: Do old procedure ${at + 1}.`);
    });

    it("says on the thread how to allow it again, and a Propose again reply removes the discard record so a later one is posted", async () => {
      await consolidate((sent) => [proposal(sent.evidence)]);
      const [offer] = proposals();
      await press(offer!, SKILL_PROPOSAL_DISCARD);
      expect(replyTo(offer!)!.body).toContain(`reply **${SKILL_PROPOSAL_PROPOSE_AGAIN}** here`);

      await press(offer!, SKILL_PROPOSAL_PROPOSE_AGAIN);
      const answers = listCommentsForItem(handle.db, offer!.itemId as Uuid).filter((comment) => comment.parentId === offer!.id && comment.authorType === "engine");
      expect(answers.map((comment) => comment.body)).toEqual([expect.stringContaining("Discarded."), expect.stringContaining("Allowed again.")]);
      // Pressed twice, it removes nothing more and says nothing more.
      await press(offer!, SKILL_PROPOSAL_PROPOSE_AGAIN);
      expect(listCommentsForItem(handle.db, offer!.itemId as Uuid).filter((comment) => comment.parentId === offer!.id && comment.authorType === "engine")).toHaveLength(2);

      const { request } = await consolidate(
        (sent) => [proposal(sent.evidence, { description: "Run the e2e suite with a virtual display." })],
        memory(Date.now() + 1_000),
      );
      expect(request.input).not.toContain("## Skill proposals a person discarded");
      expect(proposals()).toHaveLength(2);
      // The old comment has no record behind it any more: Save on it does nothing.
      await press(offer!, SKILL_PROPOSAL_SAVE);
      expect(getSkillBySlug(handle.db, "run-e2e")).toBeUndefined();
    });

    it("does nothing on Propose again under a proposal nobody discarded", async () => {
      await consolidate((sent) => [proposal(sent.evidence)]);
      const [offer] = proposals();
      await press(offer!, SKILL_PROPOSAL_PROPOSE_AGAIN);
      expect(replyTo(offer!)).toBeUndefined();
      // Still open: Discard still works.
      await press(offer!, SKILL_PROPOSAL_DISCARD);
      expect(replyTo(offer!)!.body).toContain("Discarded.");
    });

    it("does not hold back a different proposal in the same scope", async () => {
      await consolidate((sent) => [proposal(sent.evidence)]);
      await press(proposals()[0]!, SKILL_PROPOSAL_DISCARD);
      await consolidate((sent) => [proposal(sent.evidence, { slug: "debug-e2e" })], memory(Date.now() + 1_000));
      expect(proposals()).toHaveLength(2);
    });
  });

  it("acts on nothing that is not a reply to a proposal on its own thread", async () => {
    await consolidate((sent) => [proposal(sent.evidence)]);
    const [offer] = proposals();
    // "Save" on the item, citing the proposal as its parent: not answered where it was asked.
    await postHumanComment(handle.db, undefined, { itemId, body: SKILL_PROPOSAL_SAVE, parentId: offer!.id, mentions: [], pinned: false, attachmentIds: [] });
    // "Save" on the thread, filed under nothing.
    await postHumanComment(handle.db, undefined, { itemId: offer!.itemId, body: SKILL_PROPOSAL_SAVE, parentId: null, mentions: [], pinned: false, attachmentIds: [] });
    expect(getSkillBySlug(handle.db, "run-e2e")).toBeUndefined();
    expect(getItem(handle.db, itemId)).toBeDefined();
  });
});

describe("the entries Save moves (EO-483, EO-575)", () => {
  it("is the evidence, less any entry a consolidation folded from several, which stays in memory", () => {
    expect(coveringEntries(["a", "b"], [])).toEqual({ covering: ["a", "b"], mixed: [] });
    expect(coveringEntries(["a", "ab", "a"], ["ab", "cd"])).toEqual({ covering: ["a"], mixed: ["ab"] });
  });
});
