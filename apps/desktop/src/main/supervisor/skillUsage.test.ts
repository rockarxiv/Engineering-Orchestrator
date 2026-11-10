import {
  SKILL_LOADED_EVENT,
  SKILL_READ_TOOL_NAME,
  SkillDraftSchema,
  SKILLS_DELIVERED_EVENT,
  SKILLS_SETTLED_EVENT,
  type Agent,
  type AgentEvent,
  type AgentProvider,
  type AgentWriteAnswer,
  type Item,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { listAgents } from "../db/repos/agentsRepo.js";
import { appendRunEventAt, createProject, createRun, listRunEvents, listRunsForItem, listSkillVersions, ownRunsToSettle } from "../db/repos/index.js";
import { skillUsageById, usageOfSkill } from "../db/repos/skillUsageRepo.js";
import { getSkill, saveSkill } from "../db/repos/skillsRepo.js";
import { findProjectThread } from "../projects/projectThread.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listSkillsCommand } from "../ipc/skillCommands.js";
import { createFakeProvider } from "../providers/fake.js";
import { codexSkillLoaded } from "../providers/skillUsage.js";
import { sendAgentWrite } from "../mcp/writeBridge.js";
import { validImplementResult } from "../providers/fixtures.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

/**
 * A run's skill usage, recorded by a real dispatch (EO-715): what the
 * adapter says it delivered and what the backend loaded become the run's
 * `skills_delivered` and `skill_loaded` events, with the skills' ids, held
 * to what the run was given and to once per skill.
 */
describe("skill usage on a dispatch", () => {
  let handle: DbHandle;
  let writes: TestWriteBridge;
  let item: Item;
  let implementer: Agent;

  beforeEach(async () => {
    writes = await startTestWriteBridge();
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  });

  afterEach(async () => {
    await writes.close();
    handle.close();
  });

  function attachSkill(name: string): string {
    const saved = saveSkill(handle.db, SkillDraftSchema.parse({ name, description: "A house playbook.", body: "Read the diff." }));
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: saved.skill.id, attached: true });
    return saved.skill.id;
  }

  /** The fake backend, saying `said` before the turn it would have run anyway. */
  function saying(said: AgentEvent[]): AgentProvider {
    const fake = createFakeProvider({ result: validImplementResult });
    return {
      ...fake,
      start(opts) {
        const turn = fake.start(opts);
        return (async function* () {
          yield* said;
          yield* turn;
        })();
      },
    };
  }

  /** Dispatches once, and answers the skill events of the run that dispatch made. */
  async function dispatch(provider: AgentProvider, on: Item = item) {
    const before = new Set(listRunsForItem(handle.db, on.id).map((run) => run.id));
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, agentWriteBridge: writes.agentWriteBridge });
    writes.serve(supervisor);
    await supervisor.runOnce();
    const run = listRunsForItem(handle.db, on.id).find((candidate) => !before.has(candidate.id))!;
    expect(run.status).toBe("succeeded");
    return listRunEvents(handle.db, run.id).filter((event) => event.type === SKILLS_DELIVERED_EVENT || event.type === SKILL_LOADED_EVENT);
  }

  it("records what the run was given once, and each delivered skill it loaded once", async () => {
    const houseStyle = attachSkill("House style");
    const review = attachSkill("Review");
    attachSkill("Never offered");

    const events = await dispatch(
      saying([
        // `ghost` is no skill of this agent's: there is nothing to count it as.
        { type: "skills_delivered", slugs: ["house-style", "review", "ghost"] },
        { type: "skill_loaded", slug: "house-style" },
        { type: "tool_call", name: "Read", args: { file_path: "README.md" } },
        { type: "skill_loaded", slug: "house-style" },
        // Attached, but not what this run was given.
        { type: "skill_loaded", slug: "never-offered" },
        { type: "skill_loaded", slug: "ghost" },
        // A later turn of the same run is the same delivery.
        { type: "skills_delivered", slugs: ["house-style", "review"] },
      ]),
    );

    expect(events.map((event) => event.payload)).toEqual([
      { type: SKILLS_DELIVERED_EVENT, skillIds: [houseStyle, review], slugs: ["house-style", "review"] },
      { type: SKILL_LOADED_EVENT, skillId: houseStyle, slug: "house-style" },
    ]);
    const usage = Object.fromEntries(listSkillsCommand(handle.db, {}).skills.map((skill) => [skill.slug, skill.usage]));
    expect(usage["house-style"]).toMatchObject({ runsDelivered: 1, runsLoaded: 1, deliveriesSinceLoad: 0 });
    expect(usage["review"]).toMatchObject({ runsDelivered: 1, runsLoaded: 0, lastLoadedAt: null, deliveriesSinceLoad: 1 });
    expect(usage["never-offered"]).toEqual({ runsDelivered: 0, runsLoaded: 0, lastLoadedAt: null, deliveriesSinceLoad: 0 });
  });

  it("serves a Codex skill_read for a skill the run was given, records one load however often, and refuses one it was not given (EO-721)", async () => {
    const saved = saveSkill(
      handle.db,
      SkillDraftSchema.parse({ name: "House style", description: "A house playbook.", body: "Read the diff.\n\nSee checklist.md.", files: [{ path: "checklist.md", content: "- [ ] tests\n" }] }),
    );
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: saved.skill.id, attached: true });
    attachSkill("Never offered");

    // The Codex adapter's half, as `codex.ts` does it: the call handed to
    // EO over the bridge by the `eo` server, and a load read off the
    // call only when EO answered it.
    const answers: AgentWriteAnswer[] = [];
    const provider: AgentProvider = {
      ...createFakeProvider({ result: validImplementResult }),
      async *start(opts) {
        yield { type: "skills_delivered", slugs: ["house-style"] };
        if (opts.writeBridge === undefined) throw new Error("the turn was given no agent write bridge");
        for (const slug of ["house-style", "house-style", "never-offered"]) {
          const answer = await sendAgentWrite(opts.writeBridge, { tool: SKILL_READ_TOOL_NAME, args: { slug } });
          answers.push(answer);
          yield { type: "tool_call", name: SKILL_READ_TOOL_NAME, args: { slug } };
          yield* codexSkillLoaded("eo", SKILL_READ_TOOL_NAME, { slug }, answer.ok);
        }
        yield* createFakeProvider({ result: validImplementResult }).start(opts);
      },
    };
    const events = await dispatch(provider);

    expect(answers[0]).toMatchObject({ ok: true, data: { slug: "house-style", directory: ".agent/skills/house-style", files: ["checklist.md"] } });
    expect(answers[0]?.ok === true && answers[0].text).toContain("Read the diff.");
    expect(answers[0]?.ok === true && answers[0].text).toContain("`.agent/skills/house-style/`");
    expect(answers[1]?.ok).toBe(true);
    expect(answers[2]).toMatchObject({ ok: false, code: "SKILL_NOT_GIVEN" });
    expect(answers[2]?.ok === false && answers[2].problem).toContain("`house-style`");
    expect(events.map((event) => event.payload)).toEqual([
      { type: SKILLS_DELIVERED_EVENT, skillIds: [saved.skill.id], slugs: ["house-style"] },
      { type: SKILL_LOADED_EVENT, skillId: saved.skill.id, slug: "house-style" },
    ]);
  });

  it("records nothing for a run given no skill, whatever it loads", async () => {
    attachSkill("House style");
    expect(await dispatch(saying([{ type: "skill_loaded", slug: "house-style" }]))).toEqual([]);
  });
});

/** EO's pass after a run (EO-720): an agent's skill given past the guardrail without a load is archived, and the project's thread told. */
describe("archiving unused agent skills after a dispatch", () => {
  let handle: DbHandle;
  let writes: TestWriteBridge;

  beforeEach(async () => {
    writes = await startTestWriteBridge();
    handle = openMigratedTestDb();
  });

  afterEach(async () => {
    await writes.close();
    handle.close();
  });

  it("archives an agent's skill nobody loads after the run that crosses the guardrail, posting nothing: the archive version says why (EO-728)", async () => {
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const item = createTestItem(handle.db, { type: "story", title: "On a project", stepId: "todo", projectId: project.id });
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const saved = saveSkill(handle.db, SkillDraftSchema.parse({ name: "Release", description: "How to release.", body: "Tag it." }), Date.now(), { kind: "consolidation", consolidationId: "c-1" });
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: saved.skill.id, attached: true });

    const fake = createFakeProvider({ result: validImplementResult });
    const provider: AgentProvider = {
      ...fake,
      async *start(opts) {
        yield { type: "skills_delivered", slugs: ["release"] };
        yield* fake.start(opts);
      },
    };
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, agentWriteBridge: writes.agentWriteBridge, guards: { skillStaleAfterRuns: 1, skillArchiveAfterRuns: 1 } });
    writes.serve(supervisor);
    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run).toBeDefined();
    // The run closed its skill usage after everything else it wrote about skills.
    const types = listRunEvents(handle.db, run!.id).map((event) => event.type).filter((type) => type.startsWith("skill"));
    expect(types).toEqual([SKILLS_DELIVERED_EVENT, SKILLS_SETTLED_EVENT]);
    expect(getSkill(handle.db, saved.skill.id)!.archivedAt).not.toBeNull();
    expect(listSkillVersions(handle.db, saved.skill.id)[0]).toMatchObject({ action: "archive", author: { kind: "eo" }, report: { kind: "unused", runsWithoutLoad: 1 } });
    expect(findProjectThread(handle.db, project.id)).toBeUndefined();
  });

  /** An installation upgraded with runs recorded before `skills_settled` existed: they count, once settled on reconciling. */
  it("counts the runs recorded before settling existed, deliveries and loads, so an upgrade keeps a skill's stretch", async () => {
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const item = createTestItem(handle.db, { type: "story", title: "On a project", stepId: "todo", projectId: project.id });
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const saved = saveSkill(handle.db, SkillDraftSchema.parse({ name: "Release", description: "How to release.", body: "Tag it." }), Date.now(), { kind: "consolidation", consolidationId: "c-1" });
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    const skillId = saved.skill.id;
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: skillId, attached: true });

    // Before the upgrade: one run that loaded it, then four that did not — none of them settled.
    // Each line a second apart and well in the past: on one clock tick a
    // later run's delivery would not be after the load, and would not count.
    const base = Date.now() - 60_000;
    const legacy = (index: number, load: boolean) => {
      const runId = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" }).id;
      appendRunEventAt(handle.db, runId, { seq: 0, ts: base + index * 1_000 }, SKILLS_DELIVERED_EVENT, { type: SKILLS_DELIVERED_EVENT, skillIds: [skillId], slugs: ["release"] });
      if (load) appendRunEventAt(handle.db, runId, { seq: 1, ts: base + index * 1_000 + 500 }, SKILL_LOADED_EVENT, { type: SKILL_LOADED_EVENT, skillId, slug: "release" });
      return runId;
    };
    legacy(0, true);
    for (let index = 1; index <= 4; index++) legacy(index, false);
    expect(usageOfSkill(skillUsageById(handle.db), skillId)).toMatchObject({ runsDelivered: 5, runsLoaded: 1, deliveriesSinceLoad: 0 });

    const fake = createFakeProvider({ result: validImplementResult });
    const provider: AgentProvider = {
      ...fake,
      async *start(opts) {
        yield { type: "skills_delivered", slugs: ["release"] };
        yield* fake.start(opts);
      },
    };
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, agentWriteBridge: writes.agentWriteBridge, guards: { skillStaleAfterRuns: 2, skillArchiveAfterRuns: 5 } });
    writes.serve(supervisor);
    await supervisor.reconcile();

    // Settled on reconciling: their deliveries and their load count as they did.
    expect(ownRunsToSettle(handle.db)).toEqual([]);
    expect(usageOfSkill(skillUsageById(handle.db), skillId)).toMatchObject({ runsDelivered: 5, runsLoaded: 1, deliveriesSinceLoad: 4 });
    expect(getSkill(handle.db, skillId)!.archivedAt).toBeNull();

    // The fifth run in a row without a load archives it.
    await supervisor.runOnce();
    expect(getSkill(handle.db, skillId)!.archivedAt).not.toBeNull();
  });
});
