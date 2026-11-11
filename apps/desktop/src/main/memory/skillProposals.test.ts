import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MemoryEntryView,
  type MemoryScope,
  type SideCallResult,
  type SkillProposal,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addMemory,
  createRun,
  getAgentAttachments,
  getSkill,
  getSkillBySlug,
  listAgents,
  listConsolidations,
  listMemories,
  restoreConsolidation,
  saveSkill,
  setAgentAttachment,
  archiveSkill,
  decideSkillProposal,
  listSkillProposalsOf,
  listSkillVersions,
  recordSkillProposal,
  restoreSkillVersion,
  setSkillLocked,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import type { SideCallRequest } from "../sideCalls/sideCall.js";
import { MEMORY_PROPOSE_SKILLS_SYSTEM } from "./consolidation.js";
import { createMemoryConsolidator } from "./consolidator.js";
import { sql } from "drizzle-orm";
import { coveringEntries } from "./skillProposals.js";

/**
 * Memory consolidation's skill proposals (EO-483, EO-719): applied as they
 * arrive, with no person's reply, posting nothing (EO-728) — the version
 * each writes keeps its evidence and, for an improvement, its diff. The proposals come from a call of their own,
 * made once a consolidation has succeeded (EO-575).
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
  async function run(operations: (request: AnyRequest) => unknown, skills: (request: AnyRequest) => SkillProposal[]) {
    const sideCall = vi.fn(async (request: AnyRequest): Promise<Answer> => answering(request, isProposing(request) ? { skills: skills(request) } : operations(request)));
    const consolidator = createMemoryConsolidator({ db: handle.db, sideCall: sideCall as never, caps: () => CAPS });
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
    );
    // The consolidation's call, then the proposal call after it.
    expect(requests.map(isProposing)).toEqual([false, true]);
    return { ...given, request: requests[1]! };
  }

  /** Nothing is posted for a proposal, applied or not (EO-728): no comment is written anywhere. */
  function expectNothingPosted(): void {
    expect(handle.db.all(sql`select id from comments`)).toEqual([]);
  }

  /** What the newest consolidation of the scope said on its own row. */
  const consolidationNote = () => listConsolidations(handle.db, workspace)[0]!.note ?? "";

  const improving = (target: string): Partial<SkillProposal> => ({ kind: "improvement", target, slug: target }) as Partial<SkillProposal>;

  function existing(slug = "run-e2e", body = "## Steps\nRun `pnpm e2e`.") {
    const saved = saveSkill(handle.db, { slug, name: "Run the e2e suite", description: "Run the e2e suite.", body, files: [{ path: "notes.md", content: "x" }] });
    if (!saved.ok) throw new Error(saved.problems.join(" "));
    return saved.skill;
  }

  describe("a new skill", () => {
    it("is created with no reply — the agent's, in the proposal's scope, attached to the agents whose runs wrote the evidence, its first version the consolidation's", async () => {
      const { request } = await consolidate((sent) => [proposal(sent.evidence)]);
      const [consolidation] = listConsolidations(handle.db, workspace);

      // What the proposal call is told it may propose against.
      expect(request.input).toContain(`"kind":"workspace","id":"${workspace.id}"`);
      expect(request.input).toContain(`from item ${itemId}`);
      expect(request.input).toContain("## Existing skills");
      expect(request.input).not.toContain("## Skill proposals a person discarded");

      const skill = getSkillBySlug(handle.db, "run-e2e");
      expect(skill).toMatchObject({
        name: "Run the e2e suite",
        description: "Run or debug this repository's e2e suite under a virtual display.",
        body: E2E_BODY,
        scope: { kind: "workspace", workspaceId: workspace.id },
        enabled: true,
        createdBy: "agent",
        locked: false,
      });
      const versions = listSkillVersions(handle.db, skill!.id);
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ action: "create", author: { kind: "consolidation", consolidationId: consolidation!.id } });
      expect(getAgentAttachments(handle.db, implementerId).skillIds).toEqual([skill!.id]);
      expect(getAgentAttachments(handle.db, reviewerId).skillIds).toEqual([skill!.id]);
      const other = listAgents(handle.db).filter((agent) => agent.id !== implementerId && agent.id !== reviewerId);
      for (const agent of other) expect(getAgentAttachments(handle.db, agent.id).skillIds).toEqual([]);
      expect(listSkillProposalsOf(handle.db, consolidation!.id)).toEqual([expect.objectContaining({ slug: "run-e2e", status: "saved", skillId: skill!.id })]);
    });

    it("retires the evidence as moved_to_skill with the consolidation's id, and restoring the consolidation brings it back, leaving the skill", async () => {
      const { evidence, facts } = await consolidate((sent) => [proposal(sent.evidence)]);
      const [consolidation] = listConsolidations(handle.db, workspace);
      const skill = getSkillBySlug(handle.db, "run-e2e")!;

      const all = listMemories(handle.db, workspace, { includeRetired: true });
      for (const entry of evidence) {
        expect(all.find((candidate) => candidate.id === entry.id)).toMatchObject({ retiredReason: "moved_to_skill", consolidationId: consolidation!.id });
      }

      const restored = restoreConsolidation(handle.db, consolidation!.id, { caps: CAPS });
      expect(restored.ok).toBe(true);
      const active = listMemories(handle.db, workspace).map((entry) => entry.id).sort();
      expect(active).toEqual([...evidence, ...facts].map((entry) => entry.id).sort());
      expect(getSkill(handle.db, skill.id)?.archivedAt).toBeNull();
    });

    it("posts nothing, and its first version keeps the evidence — each entry with the item it came from — and the items it was seen on (EO-728)", async () => {
      const { evidence } = await consolidate((sent) => [proposal(sent.evidence)]);
      expectNothingPosted();

      const skill = getSkillBySlug(handle.db, "run-e2e")!;
      const [created] = listSkillVersions(handle.db, skill.id);
      expect(created).toMatchObject({ action: "create", author: { kind: "consolidation" } });
      expect(created!.report).toEqual({
        kind: "consolidation",
        evidence: evidence.map((entry) => ({ entryId: entry.id, body: entry.body, itemKey })),
        itemKeys: [itemKey],
        diff: null,
      });
    });

    it("applies each proposal of an answer, posting nothing", async () => {
      await consolidate((sent) => [proposal(sent.evidence), proposal(sent.evidence, { slug: "debug-e2e", description: "Debug one failing e2e spec." })]);
      expectNothingPosted();
      expect(getSkillBySlug(handle.db, "run-e2e")).toBeDefined();
      expect(getSkillBySlug(handle.db, "debug-e2e")).toBeDefined();
    });

    it("is not created when its slug is taken, and the consolidation's note says why, posting nothing", async () => {
      existing("run-e2e");
      const { evidence } = await consolidate((sent) => [proposal(sent.evidence)]);

      expect(getSkillBySlug(handle.db, "run-e2e")!.description).toBe("Run the e2e suite.");
      expectNothingPosted();
      expect(consolidationNote()).toContain("The skill proposal `run-e2e` was not applied: The slug `run-e2e` is already taken by another skill.");
      const active = listMemories(handle.db, workspace).map((entry) => entry.id);
      for (const entry of evidence) expect(active).toContain(entry.id);
      expect(getAgentAttachments(handle.db, implementerId).skillIds).toEqual([]);
    });

    it("posts nothing and notes nothing for an answer that proposes no skill", async () => {
      memory();
      await run(
        () => ({ retire: [], merge: [], rewrite: [] }),
        () => [],
      );
      expectNothingPosted();
      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "succeeded", note: null });
    });

    it("is not applied when the consolidation was restored while the proposal call ran", async () => {
      const given = memory();
      await run(
        () => ({ retire: [], merge: [{ body: "The ledger is in UTC.", from: given.facts.map((entry) => entry.id), contradictsRepositoryFile: false }], rewrite: [] }),
        () => {
          const [consolidation] = listConsolidations(handle.db, workspace);
          expect(restoreConsolidation(handle.db, consolidation!.id, { caps: CAPS }).ok).toBe(true);
          return [proposal(given.evidence)];
        },
      );
      expect(getSkillBySlug(handle.db, "run-e2e")).toBeUndefined();
      expect(consolidationNote()).toContain("was restored while it was being proposed");
      const active = listMemories(handle.db, workspace).map((entry) => entry.id);
      for (const entry of given.evidence) expect(active).toContain(entry.id);
    });
  });

  describe("the evidence it moves", () => {
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

      expect(listMemories(handle.db, workspace).map((entry) => entry.body)).toEqual(["The ledger is in UTC."]);

      // Restored, the scope is the set from before the consolidation: the
      // entries it replaced are back, the evidence it left as it was comes
      // back from the skill, and the one it wrote — moved since — stays retired.
      const [consolidation] = listConsolidations(handle.db, workspace);
      expect(restoreConsolidation(handle.db, consolidation!.id, { caps: CAPS }).ok).toBe(true);
      const active = listMemories(handle.db, workspace).map((entry) => entry.id).sort();
      expect(active).toEqual([...given.evidence, ...given.facts].map((entry) => entry.id).sort());
    });

    it("leaves in memory an entry the consolidation merged the procedure into together with another fact", async () => {
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

      expect(getSkillBySlug(handle.db, "run-e2e")).toBeDefined();
      expect(listMemories(handle.db, workspace).map((entry) => entry.body).sort()).toEqual([folded, "The ledger is in UTC."].sort());
    });
  });

  describe("an improvement", () => {
    it("writes a new version of its target authored by the consolidation, replacing only its body, which keeps the evidence and the diff and posts nothing", async () => {
      const target = existing();
      // Attached to another agent only, and global.
      const designer = listAgents(handle.db).find((agent) => agent.id !== implementerId && agent.id !== reviewerId)!;
      setAgentAttachment(handle.db, { agentId: designer.id, kind: "skill", id: target.id, attached: true });

      const { evidence } = await consolidate((sent) => [proposal(sent.evidence, improving("run-e2e"))]);
      const [consolidation] = listConsolidations(handle.db, workspace);

      const after = getSkill(handle.db, target.id)!;
      expect(after.body).toBe(E2E_BODY);
      expect(after).toMatchObject({ slug: "run-e2e", name: target.name, description: target.description, scope: target.scope, files: target.files, enabled: true, createdBy: "person" });
      const [latest] = listSkillVersions(handle.db, target.id);
      expect(latest).toMatchObject({ action: "edit", body: E2E_BODY, author: { kind: "consolidation", consolidationId: consolidation!.id } });
      expect(getAgentAttachments(handle.db, designer.id).skillIds).toEqual([target.id]);
      expect(getAgentAttachments(handle.db, implementerId).skillIds).toEqual([]);
      expect(getAgentAttachments(handle.db, reviewerId).skillIds).toEqual([]);
      const retired = listMemories(handle.db, workspace, { includeRetired: true });
      for (const entry of evidence) expect(retired.find((candidate) => candidate.id === entry.id)).toMatchObject({ retiredReason: "moved_to_skill", consolidationId: consolidation!.id });

      expectNothingPosted();
      expect(latest!.report).toMatchObject({ kind: "consolidation", evidence: evidence.map((entry) => ({ entryId: entry.id, body: entry.body, itemKey })), itemKeys: [itemKey] });
      const diff = latest!.report?.kind === "consolidation" ? latest!.report.diff : null;
      expect(diff).toContain("--- a/run-e2e/SKILL.md");
      expect(diff).toContain("-Run `pnpm e2e`.");
      expect(diff).toContain("+## Trigger");
    });

    it("is not applied to a locked target, and the consolidation's note says a person locked it", async () => {
      const target = existing();
      setSkillLocked(handle.db, target.id, true);
      const { evidence } = await consolidate((sent) => [proposal(sent.evidence, improving("run-e2e"))]);

      expect(getSkill(handle.db, target.id)!.body).toBe(target.body);
      expect(listSkillVersions(handle.db, target.id).map((version) => version.action)).toEqual(["lock", "create"]);
      expectNothingPosted();
      expect(consolidationNote()).toContain("A person locked the skill `run-e2e`, so only a person can change it.");
      const active = listMemories(handle.db, workspace).map((entry) => entry.id);
      for (const entry of evidence) expect(active).toContain(entry.id);
    });

    it("is not applied to an archived target, and the consolidation's note says it is archived", async () => {
      const target = existing();
      archiveSkill(handle.db, target.id);
      await consolidate((sent) => [proposal(sent.evidence, improving("run-e2e"))]);

      expect(getSkill(handle.db, target.id)!.body).toBe(target.body);
      expect(consolidationNote()).toContain("The skill it improves, `run-e2e`, is archived");
    });

    it("is not applied to a target renamed while the proposal call ran, though another skill took its slug, and the consolidation's note says so", async () => {
      const a = existing();
      let b: string | undefined;
      await consolidate((sent) => {
        // A is renamed, and B takes the slug it left.
        expect(saveSkill(handle.db, { id: a.id, slug: "run-e2e-old", name: a.name, description: a.description, body: a.body, files: a.files }).ok).toBe(true);
        const other = saveSkill(handle.db, { slug: "run-e2e", name: "Someone else's", description: "Unrelated.", body: "B's body.", files: [] });
        if (!other.ok) throw new Error(other.problems.join(" "));
        b = other.skill.id;
        return [proposal(sent.evidence, improving("run-e2e"))];
      });

      expect(getSkill(handle.db, a.id)!.body).toBe(a.body);
      expect(getSkill(handle.db, b!)!.body).toBe("B's body.");
      expect(consolidationNote()).toContain("has since been renamed `run-e2e-old`");
    });

    it("is not applied to a skill made with its target's slug while the proposal call ran, which the call was never shown", async () => {
      let made: string | undefined;
      await consolidate((sent) => {
        const other = saveSkill(handle.db, { slug: "run-tests", name: "Made meanwhile", description: "Unseen.", body: "Its own body.", files: [] });
        if (!other.ok) throw new Error(other.problems.join(" "));
        made = other.skill.id;
        return [proposal(sent.evidence, improving("run-tests"))];
      });

      expect(getSkill(handle.db, made!)!.body).toBe("Its own body.");
      expect(listSkillVersions(handle.db, made!)).toHaveLength(1);
      expect(consolidationNote()).toContain("The skill `run-tests` was made while the proposal was being written");
    });

    it("is not applied to a target that does not exist, and the consolidation's note says so", async () => {
      await consolidate((sent) => [proposal(sent.evidence, improving("run-tests"))]);
      expect(getSkillBySlug(handle.db, "run-tests")).toBeUndefined();
      expect(consolidationNote()).toContain("There is no skill `run-tests` for it to improve");
    });
  });

  describe("a person archiving a skill consolidation created", () => {
    /** The first consolidation creates `run-e2e`; the person archives it. */
    async function created() {
      await consolidate((sent) => [proposal(sent.evidence)]);
      const skill = getSkillBySlug(handle.db, "run-e2e")!;
      expect(archiveSkill(handle.db, skill.id).ok).toBe(true);
      return skill;
    }

    it("discards it: a later consolidation proposing the same scope and slug creates nothing, posts nothing and says why on its note", async () => {
      const skill = await created();

      const { request } = await consolidate((sent) => [proposal(sent.evidence, { description: "Use when Playwright cannot find an X server." })], memory(Date.now() + 1_000));
      expectNothingPosted();
      expect(getSkill(handle.db, skill.id)!.archivedAt).not.toBeNull();
      const [later] = listConsolidations(handle.db, workspace);
      expect(later!.note).toContain("a person archived the skill `run-e2e` a consolidation created in this scope");
      // And the proposal call was told not to propose it.
      const told = request.input.slice(request.input.indexOf("## Skill proposals a person discarded"));
      expect(told).toMatch(/^## Skill proposals a person discarded\n/);
      expect(told).toContain("- `run-e2e`: Run or debug this repository's e2e suite under a virtual display.");
    });

    it("refuses an improvement to it, the consolidation's note saying a person archived it, and changes nothing", async () => {
      const skill = await created();
      const { evidence } = await consolidate((sent) => [proposal(sent.evidence, improving("run-e2e"))], memory(Date.now() + 1_000));
      expect(listSkillVersions(handle.db, skill.id).map((version) => version.action)).toEqual(["archive", "create"]);
      expectNothingPosted();
      expect(consolidationNote()).toContain("A person archived the skill `run-e2e`, which a consolidation created, and that discards it");
      const active = listMemories(handle.db, workspace).map((entry) => entry.id);
      for (const entry of evidence) expect(active).toContain(entry.id);
    });

    it("stops holding once a person restores it: proposals for it are applied again", async () => {
      const skill = await created();
      const [first] = listSkillVersions(handle.db, skill.id).reverse();
      expect(restoreSkillVersion(handle.db, skill.id, first!.id).ok).toBe(true);

      const { request } = await consolidate((sent) => [proposal(sent.evidence, improving("run-e2e"))], memory(Date.now() + 1_000));
      expect(request.input).not.toContain("## Skill proposals a person discarded");
      expectNothingPosted();
      expect(listSkillVersions(handle.db, skill.id)[0]).toMatchObject({ action: "edit", author: { kind: "consolidation" } });
    });

    it("does not count when the consolidation-created skill was archived by an agent, nor for a person's own skill", async () => {
      const own = existing("debug-e2e");
      archiveSkill(handle.db, own.id);
      await consolidate((sent) => [proposal(sent.evidence)]);
      const skill = getSkillBySlug(handle.db, "run-e2e")!;
      expect(archiveSkill(handle.db, skill.id, Date.now(), { kind: "run", runId: implementerRun }).ok).toBe(true);

      const { request } = await consolidate((sent) => [proposal(sent.evidence, improving("run-e2e")), proposal(sent.evidence, improving("debug-e2e"))], memory(Date.now() + 1_000));
      expect(request.input).not.toContain("## Skill proposals a person discarded");
      // Not held back: each is refused for its archived target.
      expect(consolidationNote()).toContain("The skill it improves, `run-e2e`, is archived");
      expect(consolidationNote()).toContain("The skill it improves, `debug-e2e`, is archived");
    });

  });

  describe("a proposal a person discarded before EO-719", () => {
    function discardedBefore(slug: string, description: string, at: number) {
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
    }

    it("still holds its scope and slug back, whatever the description says", async () => {
      discardedBefore("run-e2e", "Run the e2e suite.", 1);
      await consolidate((sent) => [proposal(sent.evidence)]);
      expect(getSkillBySlug(handle.db, "run-e2e")).toBeUndefined();
      expectNothingPosted();
      expect(listConsolidations(handle.db, workspace)[0]!.note).toContain("`run-e2e` was discarded before");
    });

    it("is told to the proposal call, every one, however many there are (EO-512)", async () => {
      const slugs = Array.from({ length: 45 }, (_, at) => `old-procedure-${at + 1}`);
      slugs.forEach((slug, at) => discardedBefore(slug, `Do old procedure ${at + 1}.`, at));

      const { request } = await consolidate(() => []);
      expect(request.input).toContain("Do not propose them again");
      for (const [at, slug] of slugs.entries()) expect(request.input).toContain(`- \`${slug}\`: Do old procedure ${at + 1}.`);
    });
  });
});

describe("the entries applying a proposal moves (EO-483, EO-575)", () => {
  it("is the evidence, less any entry a consolidation folded from several, which stays in memory", () => {
    expect(coveringEntries(["a", "b"], [])).toEqual({ covering: ["a", "b"], mixed: [] });
    expect(coveringEntries(["a", "ab", "a"], ["ab", "cd"])).toEqual({ covering: ["a"], mixed: ["ab"] });
  });
});
