import { SKILL_LOADED_EVENT, SkillDraftSchema, SKILLS_DELIVERED_EVENT, type Agent, type AgentEvent, type AgentProvider, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { listAgents } from "../db/repos/agentsRepo.js";
import { listRunEvents, listRunsForItem, transitionItem } from "../db/repos/index.js";
import { saveSkill } from "../db/repos/skillsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listSkillsCommand } from "../ipc/skillCommands.js";
import { createFakeProvider } from "../providers/fake.js";
import { codexSkillsRead } from "../providers/skillUsage.js";
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

  /** What the Codex adapter says of one command (`codex.ts`): the call, then any skill it read. */
  const codexCommand = (command: string): AgentEvent[] => [{ type: "tool_call", name: "command_execution", args: { command } }, ...codexSkillsRead(command)];

  it("counts a Codex search of the skill's file as a load, and a help invocation naming it as none", async () => {
    attachSkill("House style");
    const usage = () => listSkillsCommand(handle.db, {}).skills.find((skill) => skill.slug === "house-style")!.usage;

    // Mentions only: the stretch of runs without a load goes on.
    await dispatch(
      saying([
        { type: "skills_delivered", slugs: ["house-style"] },
        ...codexCommand("/bin/bash -lc 'cat --help .agent/skills/house-style/SKILL.md'"),
        ...codexCommand("/bin/bash -lc 'sed -n -e .agent/skills/house-style/SKILL.md /dev/null'"),
      ]),
    );
    expect(usage()).toMatchObject({ runsDelivered: 1, runsLoaded: 0, lastLoadedAt: null, deliveriesSinceLoad: 1 });

    // A real read by `rg`: loaded, and the stretch starts again. The first
    // item is put out of the way, so the next dispatch is the new one's.
    transitionItem(handle.db, { itemId: item.id, toStepId: "ready_to_merge", actor: "human" });
    const next = createTestItem(handle.db, { type: "story", title: "Another story", stepId: "todo" });
    const events = await dispatch(saying([{ type: "skills_delivered", slugs: ["house-style"] }, ...codexCommand("/bin/bash -lc 'rg -n . .agent/skills/house-style/SKILL.md'")]), next);
    expect(events.map((event) => event.type)).toEqual([SKILLS_DELIVERED_EVENT, SKILL_LOADED_EVENT]);
    expect(usage()).toMatchObject({ runsDelivered: 2, runsLoaded: 1, deliveriesSinceLoad: 0 });
    expect(usage().lastLoadedAt).not.toBeNull();
  });

  it("records nothing for a run given no skill, whatever it loads", async () => {
    attachSkill("House style");
    expect(await dispatch(saying([{ type: "skill_loaded", slug: "house-style" }]))).toEqual([]);
  });
});
