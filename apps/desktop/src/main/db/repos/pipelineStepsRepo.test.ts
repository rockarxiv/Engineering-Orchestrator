import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Uuid } from "@eo/core";
import type { DbHandle } from "../client.js";
import { createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { createProject } from "./projectsRepo.js";
import { localPerson } from "./peopleRepo.js";
import { setItemArchived } from "./itemsRepo.js";
import {
  archivePipeline,
  createPipeline,
  createRoute,
  createStep,
  getStep,
  listPipelineSteps,
  listRoutableStepsElsewhere,
  listRoutesForPipeline,
  listStepsElsewhere,
  listStepsForPipeline,
  replacePipelineGraph,
  setEntryStep,
  updateStep,
} from "./pipelineStepsRepo.js";

describe("pipelineStepsRepo", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("round-trips owner_role = NULL for a human-owned gate", () => {
    const created = createStep(handle.db, { id: "awaiting_signoff", pipelineId: "default" as Uuid, position: 10, name: "Awaiting signoff" });
    expect(created.ownerRole).toBeNull();
    expect(created.entryAction).toBeNull();
    expect(created.isTerminal).toBe(false);

    expect(getStep(handle.db, "awaiting_signoff")?.ownerRole).toBeNull();
  });

  it("seed migration produces the default pipeline in project order", () => {
    // Off-project states are not part of the pipeline — that is what the
    // flag means, and it is how the project renders its columns.
    const states = listPipelineSteps(handle.db).filter((state) => !state.offBoard);
    // pending_approval is the R-01 human gate: owned by nobody, so the
    // engine hands off and stops dispatching until a human approves.
    expect(states.map((state) => state.id)).toEqual(["worktree", "repository_index", "todo", "review", "merge_request", "pull_request_watch", "ready_to_merge"]);
    // Only the `agent` steps carry a role: a person's step and a built-in
    // one have nobody to dispatch to.
    expect(states.map((state) => state.ownerRole)).toEqual([
      null, // worktree — built in
      null, // repository_index — built in
      "implementer",
      "reviewer",
      null, // merge_request — built in
      null, // pull_request_watch — built in, keeps checking
      null, // ready_to_merge — terminal
    ]);
  });

  it("seeds `discussion` off the project and owned by nobody, so the scheduler never dispatches it", () => {
    const discussion = getStep(handle.db, "discussion");

    expect(discussion?.offBoard).toBe(true);
    // The load-bearing half: `tick()` skips human-owned states, so a
    // conversation never takes a capacity slot from work. What runs it
    // is the mention path instead.
    expect(discussion?.ownerRole).toBeNull();
    expect(discussion?.entryAction).toBeNull();
    expect(discussion?.isTerminal).toBe(false);
  });

  it("marks only ready_to_merge as terminal, and it has no owner", () => {
    const terminal = listPipelineSteps(handle.db).filter((state) => state.isTerminal);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.id).toBe("ready_to_merge");
    expect(terminal[0]?.ownerRole).toBeNull();
  });
});

/**
 * What a step sets for the inputs its module declares (EO-78).
 *
 * On the step's own row, so the values are published by the same
 * transaction as the module that reads them — and reloaded by the same
 * query. The one subtlety is absence: a caller with nothing to say about
 * inputs must not erase them, or applying an architect's draft would wipe
 * every number somebody tuned.
 */
describe("a step's configured inputs", () => {
  let handle: DbHandle;
  // Its own pipeline, so a republish here rewrites this graph and not the
  // seeded one — whose steps hold the entry pointer and every route.
  let pipelineId: Uuid;
  beforeEach(() => {
    handle = openMigratedTestDb();
    pipelineId = createPipeline(handle.db, { name: "Deploys" }).id;
  });
  afterEach(() => handle.close());

  const stepFor = (id: string, inputs?: Record<string, string | number | boolean>) => ({
    id,
    pipelineId,
    position: 20,
    name: id,
    type: "module" as const,
    entryAction: "mod-deploy",
    ...(inputs ? { inputs } : {}),
  });

  it("stores a value for each of the three declared types", () => {
    const created = createStep(handle.db, stepFor("deploy", { wait_seconds: 90, environment: "production", force: true }));

    expect(created.inputs).toEqual({ wait_seconds: 90, environment: "production", force: true });
    // Through a fresh read, because JSON that only survives in the
    // returning row is JSON nothing has actually round-tripped.
    expect(getStep(handle.db, "deploy")?.inputs).toEqual({ wait_seconds: 90, environment: "production", force: true });
  });

  it("configures nothing by default", () => {
    expect(createStep(handle.db, stepFor("deploy")).inputs).toEqual({});
    expect(getStep(handle.db, "todo")?.inputs).toEqual({});
  });

  // The editor's round trip: publish, reload, and the numbers are still
  // the ones somebody set.
  it("survives a republish of the whole graph", () => {
    createStep(handle.db, stepFor("deploy", { wait_seconds: 90 }));

    replacePipelineGraph(handle.db, pipelineId, [{ ...stepFor("deploy", { wait_seconds: 90 }), position: 20 }], []);

    expect(getStep(handle.db, "deploy")?.inputs).toEqual({ wait_seconds: 90 });
  });

  it("is replaced by what a republish carries", () => {
    createStep(handle.db, stepFor("deploy", { wait_seconds: 90, retired: "left behind" }));

    replacePipelineGraph(handle.db, pipelineId, [stepFor("deploy", { wait_seconds: 30 })], []);

    // Wholesale, like every other field of a published graph: what the
    // editor sent is what the step now has, so discarding a value it no
    // longer declares is one save rather than two writes.
    expect(getStep(handle.db, "deploy")?.inputs).toEqual({ wait_seconds: 30 });
  });

  /**
   * The architect's path. A draft says nothing about configured inputs —
   * it is not asked for them — so a rewrite that omits them must leave
   * them exactly as they are. `{}` still clears; absent does not.
   */
  it("is left alone by a rewrite that says nothing about it", () => {
    createStep(handle.db, stepFor("deploy", { wait_seconds: 90 }));

    replacePipelineGraph(handle.db, pipelineId, [{ ...stepFor("deploy"), name: "Deploy it" }], []);

    const step = getStep(handle.db, "deploy");
    expect(step?.name).toBe("Deploy it");
    expect(step?.inputs).toEqual({ wait_seconds: 90 });
  });

  it("is cleared by a rewrite that says it configures nothing", () => {
    createStep(handle.db, stepFor("deploy", { wait_seconds: 90 }));

    replacePipelineGraph(handle.db, pipelineId, [stepFor("deploy", {})], []);

    expect(getStep(handle.db, "deploy")?.inputs).toEqual({});
  });

  /**
   * A hand-edited row, or one written by something that never read
   * `StepInputsSchema`. Reading it as a configuration would hand a module
   * an object where it declared a number — so it reads as nothing
   * configured, which is the honest answer and the safe one.
   */
  it("reads a blob that is not a map of scalars as nothing configured", () => {
    createStep(handle.db, stepFor("deploy"));
    handle.db.run(sql`update pipeline_steps set inputs = '{"wait_seconds":{"nested":true}}' where id = 'deploy'`);

    expect(getStep(handle.db, "deploy")?.inputs).toEqual({});
  });
});

describe("plan mode", () => {
  let handle: DbHandle;
  beforeEach(() => {
    handle = openMigratedTestDb();
  });
  afterEach(() => handle.close());

  it("is a step setting, so two pipelines in one project can disagree", () => {
    // It lived on the project group with a note saying a per-group gate
    // could not be a state while `workflow_states` was global (ARCHITECTURE.md, "Pipelines and
    // routes").
    // Workflows are per-pipeline now, and this is what that buys.
    const cautious = createPipeline(handle.db, { name: "Cautious" });
    const step = createStep(handle.db, {
      id: "cautious_build",
      pipelineId: cautious.id,
      position: 0,
      name: "Build",
      type: "agent",
      ownerRole: "implementer",
      entryAction: "implement",
      planMode: true,
    });

    expect(step.planMode).toBe(true);
    expect(getStep(handle.db, "todo")?.planMode).toBe(false);
  });

  it("can be switched on without republishing the whole graph", () => {
    updateStep(handle.db, "todo", { planMode: true });
    expect(getStep(handle.db, "todo")?.planMode).toBe(true);
  });
});

/**
 * How a step uses a git workspace (EO-296,
 * ARCHITECTURE.md, "The four kinds").
 *
 * A branch of its own, or the repository as it stands. On the step for
 * plan mode's reason — it asks one step to work differently, and two
 * steps of one pipeline may legitimately disagree: the step that reads
 * the code to answer a question wants no branch, and the step after it
 * that changes the code wants nothing else.
 */
describe("a step's workspace mode", () => {
  let handle: DbHandle;
  let pipelineId: Uuid;
  beforeEach(() => {
    handle = openMigratedTestDb();
    pipelineId = createPipeline(handle.db, { name: "Answers" }).id;
  });
  afterEach(() => handle.close());

  const stepFor = (id: string, workspaceMode?: "isolated" | "read") => ({
    id,
    pipelineId,
    position: 20,
    name: id,
    type: "agent" as const,
    ownerRole: "implementer",
    entryAction: "implement",
    ...(workspaceMode ? { workspaceMode } : {}),
  });

  it("is a branch of its own until somebody says otherwise", () => {
    expect(createStep(handle.db, stepFor("answer")).workspaceMode).toBe("isolated");
    // Including every step that existed before the column did, which is
    // what the migration's default is for.
    expect(getStep(handle.db, "todo")?.workspaceMode).toBe("isolated");
  });

  it("is stored and read back, so two steps of one pipeline can disagree", () => {
    createStep(handle.db, stepFor("answer", "read"));

    expect(getStep(handle.db, "answer")?.workspaceMode).toBe("read");
    expect(getStep(handle.db, "todo")?.workspaceMode).toBe("isolated");
  });

  it("is published wholesale, like every other field the editor sends", () => {
    createStep(handle.db, stepFor("answer", "read"));

    replacePipelineGraph(handle.db, pipelineId, [stepFor("answer", "isolated")], []);

    expect(getStep(handle.db, "answer")?.workspaceMode).toBe("isolated");
  });

  /**
   * The import's path, and the architect's. Neither is asked how a step
   * uses its workspace — it is a fact about the disk this machine has,
   * not about the shape of the graph — so a rewrite that omits it must
   * leave it alone. Otherwise importing a pipeline over an existing one
   * would quietly start cutting branches for a step somebody had set to
   * read only.
   */
  it("is left alone by a rewrite that says nothing about it", () => {
    createStep(handle.db, stepFor("answer", "read"));

    replacePipelineGraph(handle.db, pipelineId, [{ ...stepFor("answer"), name: "Answer it" }], []);

    const step = getStep(handle.db, "answer");
    expect(step?.name).toBe("Answer it");
    expect(step?.workspaceMode).toBe("read");
  });

  it("can be switched without republishing the whole graph", () => {
    updateStep(handle.db, "todo", { workspaceMode: "read" });
    expect(getStep(handle.db, "todo")?.workspaceMode).toBe("read");
  });

  it("reads as a branch of its own when the column holds something no version of EO wrote", () => {
    // Open text, like `workspaces.kind` one table over. A value this
    // build cannot honour is not a mode — and "isolated" is the same
    // answer a step nobody has touched gives, rather than a refusal that
    // would take the whole pipeline down with it.
    createStep(handle.db, stepFor("answer"));
    handle.db.run(sql`UPDATE pipeline_steps SET workspace_mode = 'sideways' WHERE id = 'answer'`);

    expect(getStep(handle.db, "answer")?.workspaceMode).toBe("isolated");
  });
});

/**
 * Who a human step waits on (EO-302, the original design).
 *
 * "Human steps may name a person or a group." Nothing in EO names one
 * yet — the picker is 7b's and claiming is the seventh story of this
 * phase — but the column is reachable through the ordinary write path,
 * which is what stops it being a column only a migration can fill.
 *
 * `ownerGroupId` is deliberately absent from all of this. The story
 * reserves it for 7b and leaves it unread, there is no `groups` table
 * for it to name, and a field on `PipelineStep` would be read by
 * definition.
 */
describe("a step's owner", () => {
  let handle: DbHandle;
  let pipelineId: Uuid;
  beforeEach(() => {
    handle = openMigratedTestDb();
    pipelineId = createPipeline(handle.db, { name: "Approvals" }).id;
  });
  afterEach(() => handle.close());

  const stepFor = (id: string, ownerPersonId?: Uuid | null) => ({
    id,
    pipelineId,
    position: 20,
    name: id,
    type: "user" as const,
    ...(ownerPersonId === undefined ? {} : { ownerPersonId }),
  });

  it("is nobody in particular until somebody says otherwise", () => {
    // Which is every step there is: one waits for whoever is there, and
    // in solo mode that is the one person.
    expect(createStep(handle.db, stepFor("approve")).ownerPersonId).toBeNull();
    expect(getStep(handle.db, "todo")?.ownerPersonId).toBeNull();
  });

  it("is stored and read back through the ordinary write path", () => {
    const person = localPerson(handle.db);
    const created = createStep(handle.db, stepFor("approve", person.id));

    expect(created.ownerPersonId).toBe(person.id);
    expect(getStep(handle.db, "approve")?.ownerPersonId).toBe(person.id);
    expect(listStepsForPipeline(handle.db, pipelineId).find((step) => step.id === "approve")?.ownerPersonId).toBe(person.id);
  });

  it("is a real row, so a step cannot wait on somebody who does not exist", () => {
    // The foreign key, asked rather than assumed: `owner_person_id`
    // references `people`, which is the difference between "Anna
    // approves here" and a column holding a string.
    expect(() => createStep(handle.db, stepFor("approve", "0199aa00-0000-7000-8000-00000000dead" as Uuid))).toThrow();
  });

  it("is published like any other field when the caller names one", () => {
    const person = localPerson(handle.db);
    createStep(handle.db, stepFor("approve"));

    replacePipelineGraph(handle.db, pipelineId, [stepFor("approve", person.id)], []);

    expect(getStep(handle.db, "approve")?.ownerPersonId).toBe(person.id);
  });

  /**
   * The case that matters most, and the one that would have broken
   * silently.
   *
   * A pipeline document carries no person — an id means nothing on the
   * machine importing it, and in 7b nothing in another organisation —
   * so neither the architect applying a draft nor the configuration
   * screen publishing one says anything about an owner. If "says
   * nothing" wrote null, every publish would quietly unname whoever a
   * human step was waiting on, and the next person to open the board
   * would find "Nobody assigned" with nothing in the record to say when
   * it happened.
   */
  it("survives a rewrite that says nothing about it", () => {
    const person = localPerson(handle.db);
    createStep(handle.db, stepFor("approve", person.id));

    replacePipelineGraph(handle.db, pipelineId, [{ ...stepFor("approve"), name: "Approve it" }], []);

    const step = getStep(handle.db, "approve");
    expect(step?.name).toBe("Approve it"); // the rewrite did land
    expect(step?.ownerPersonId).toBe(person.id); // and left the owner where it was
  });

  it("is cleared by a rewrite that says null, which is a caller meaning it", () => {
    createStep(handle.db, stepFor("approve", localPerson(handle.db).id));

    replacePipelineGraph(handle.db, pipelineId, [stepFor("approve", null)], []);

    expect(getStep(handle.db, "approve")?.ownerPersonId).toBeNull();
  });
});

/**
 * Where a route out of one pipeline may land (EO-58, EO-69, EO-72).
 *
 * Two lists, and the second is a subset of the first: the validator asks
 * "may a route say this?" and the picker asks "should the screen propose
 * it?", which are different questions. Answering them with one list is
 * what made being permissive about the first force being permissive about
 * the second.
 *
 * Both are scoped to one project, and both take the project the pipeline is
 * being edited in as an argument rather than reading it: this file is the
 * repo layer, and which project the window is showing is an ipc concern.
 */
describe("hand-off targets", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => handle.close());

  /** A pipeline of the project, with a step and somewhere for work to enter. */
  function pipelineOn(projectId: Uuid | null, name: string) {
    const pipeline = createPipeline(handle.db, { projectId, name });
    const step = createStep(handle.db, { pipelineId: pipeline.id, position: 0, name, type: "user" });
    setEntryStep(handle.db, pipeline.id, step.id);
    return { pipeline, step };
  }

  const project = (name = "EO", keyPrefix = "EO") => createProject(handle.db, { name, keyPrefix });

  /** The shipped `default` pipeline belongs to no project, so it is the case that broke. */
  const accepted = (editingProjectId: Uuid | null) => listStepsElsewhere(handle.db, "default", editingProjectId).map((step) => step.id);
  const offered = (editingProjectId: Uuid | null) => listRoutableStepsElsewhere(handle.db, "default", editingProjectId).map((step) => step.id);

  describe("what the validator will accept", () => {
    /**
     * The shipped `default` pipeline is project-less, and a project-less
     * pipeline belongs to every project — so it must see the pipelines of
     * the project it is being edited in, not only the other pipelines
     * nothing has adopted. Asking `listPipelines` with its own `null`
     * collapsed the filter to "project-less only" and hid every pipeline
     * anyone had created.
     */
    it("shows a project-less pipeline the pipelines of the project it is being edited in", () => {
      const editing = project();
      const { step } = pipelineOn(editing.id, "Merge");

      expect(accepted(editing.id)).toContain(step.id);
    });

    /**
     * And only that project's. Belonging to every project is not licence to
     * hand work to every project: a route into a pipeline of the project
     * nobody is looking at is one this project could never sensibly take,
     * and offering it is how "sees the project's pipelines" overshoots into
     * "sees all of them".
     */
    it("leaves out the pipelines of a project it is not being edited in", () => {
      const editing = project("Ours", "OURS");
      const ours = pipelineOn(editing.id, "Merge");
      const theirs = pipelineOn(project("Theirs", "THRS").id, "Someone else's Merge");

      const ids = accepted(editing.id);
      expect(ids).toContain(ours.step.id);
      expect(ids).not.toContain(theirs.step.id);
    });

    // The rule only ever reads outwards from a pipeline nothing adopted.
    // One that a project owns still keeps to its own project's pipelines —
    // its own project, note, not whichever one happens to be open: what a
    // route may resolve to must not move under a graph because someone
    // switched projects.
    it("keeps an adopted pipeline to its own project", () => {
      const ours = pipelineOn(project("Ours", "OURS").id, "Delivery Two");
      const theirsProject = project("Theirs", "THRS");
      const theirs = pipelineOn(theirsProject.id, "Someone else's");

      const ids = listStepsElsewhere(handle.db, ours.pipeline.id, theirsProject.id).map((candidate) => candidate.id);
      expect(ids).not.toContain(theirs.step.id);
      // A project-less pipeline is nobody's to hand work to any more
      // (EO-766): no pipeline is shared between projects.
      expect(ids).not.toContain("todo");
    });

    // `wiring.ts` hands `resolveRoute` every step of every other pipeline
    // at runtime, so refusing to save one here would be validation
    // stricter than the engine (EO-69). Left in deliberately.
    it("still accepts an off-dashboard step, which the engine would route to", () => {
      expect(accepted(null)).toContain("discussion");
    });
  });

  describe("what the editor offers", () => {
    // Everything offered saves. That is the whole point of the picker's
    // set being a subset rather than a different list.
    it("offers only what the validator would accept", () => {
      const editing = project();
      pipelineOn(editing.id, "Merge");
      pipelineOn(project("Theirs", "THRS").id, "Someone else's Merge");

      const acceptable = new Set(accepted(editing.id));
      expect(offered(editing.id).every((id) => acceptable.has(id))).toBe(true);
    });

    it("offers a live pipeline of the project that has somewhere to enter", () => {
      const editing = project();
      const { step } = pipelineOn(editing.id, "Merge");

      expect(offered(editing.id)).toContain(step.id);
    });

    it("does not offer a pipeline of another project", () => {
      const editing = project("Ours", "OURS");
      const theirs = pipelineOn(project("Theirs", "THRS").id, "Someone else's Merge");

      expect(offered(editing.id)).not.toContain(theirs.step.id);
    });

    /**
     * `discussion` and `architecture` host conversations. `offBoardStepIds`
     * exists precisely so the dashboard, the archive and the inbox leave
     * them out; offering them here invites somebody to send real work into
     * a conversation.
     */
    it("does not offer a step that holds a conversation rather than work", () => {
      expect(offered(null)).not.toContain("discussion");
      expect(offered(null)).not.toContain("architecture");
    });

    // No entry step means nowhere for the work to arrive — the same rule
    // EO-70 applies to the destinations a card's `⋯` menu offers.
    it("does not offer a pipeline work cannot enter, until it has an entry step", () => {
      const pipeline = createPipeline(handle.db, { projectId: null, name: "Merge" });
      const step = createStep(handle.db, { pipelineId: pipeline.id, position: 0, name: "Merge", type: "user" });

      expect(offered(null)).not.toContain(step.id);

      setEntryStep(handle.db, pipeline.id, step.id);
      expect(offered(null)).toContain(step.id);
    });

    it("does not offer an archived pipeline", () => {
      const { pipeline, step } = pipelineOn(null, "Merge");
      archivePipeline(handle.db, pipeline.id);

      expect(offered(null)).not.toContain(step.id);
    });
  });
});

/**
 * The guard under the validator (EO-230). `pipeline:save` validates
 * first, but it is one caller of several, and `items.stepId` is a
 * foreign key with no cascade: a graph that removes a step items sit on
 * is refused here, by name and count, with nothing written — a
 * foreign-key error mid-transaction is not an answer anybody can act on.
 */
describe("replacing a graph that removes a step with items on it", () => {
  let handle: DbHandle;
  let pipelineId: Uuid;
  let review: string;
  let build: string;

  beforeEach(() => {
    handle = openMigratedTestDb();
    pipelineId = createPipeline(handle.db, { name: "Delivery" }).id;
    build = createStep(handle.db, { pipelineId, position: 0, name: "Build", type: "agent", ownerRole: "implementer", entryAction: "implement" }).id;
    review = createStep(handle.db, { pipelineId, position: 1, name: "Reviewer", type: "agent", ownerRole: "reviewer", entryAction: "review" }).id;
    createRoute(handle.db, { pipelineId, fromStepId: build, resultKey: "done", label: "Done", target: review });
  });
  afterEach(() => handle.close());

  const graph = (steps: { id: string; name: string; position: number }[]) =>
    steps.map((step) => ({ ...step, pipelineId, type: "agent" as const, ownerRole: "implementer", entryAction: "implement" }));

  it("refuses with the step's name and how many, and writes nothing", () => {
    createTestItem(handle.db, { type: "story", title: "One", stepId: review });
    createTestItem(handle.db, { type: "story", title: "Two", stepId: review });
    const stepsBefore = listStepsForPipeline(handle.db, pipelineId);
    const routesBefore = listRoutesForPipeline(handle.db, pipelineId);

    const result = replacePipelineGraph(handle.db, pipelineId, graph([{ id: build, name: "Build", position: 0 }]), []);

    expect(result).toEqual({ replaced: false, holding: [{ stepId: review, stepName: "Reviewer", count: 2, archived: 0 }] });
    // Untouched — the routes too, which used to be the first thing
    // deleted on the way in.
    expect(listStepsForPipeline(handle.db, pipelineId)).toEqual(stepsBefore);
    expect(listRoutesForPipeline(handle.db, pipelineId)).toEqual(routesBefore);
  });

  it("counts archived items, and says how many of the total they are", () => {
    // The foreign key does not care whether the dashboard shows them —
    // but the screen does, because the board cannot show an archived
    // item and the Archive can, so the two are told apart.
    const item = createTestItem(handle.db, { type: "story", title: "Old", stepId: review });
    setItemArchived(handle.db, item.id, Date.now());
    createTestItem(handle.db, { type: "story", title: "Live", stepId: review });

    const result = replacePipelineGraph(handle.db, pipelineId, graph([{ id: build, name: "Build", position: 0 }]), []);

    expect(result).toEqual({ replaced: false, holding: [{ stepId: review, stepName: "Reviewer", count: 2, archived: 1 }] });
  });

  it("removes an empty step", () => {
    createTestItem(handle.db, { type: "story", title: "Elsewhere", stepId: build });

    const result = replacePipelineGraph(handle.db, pipelineId, graph([{ id: build, name: "Build", position: 0 }]), []);

    expect(result).toMatchObject({ replaced: true });
    expect(listStepsForPipeline(handle.db, pipelineId).map((step) => step.id)).toEqual([build]);
  });

  it("renames a step with items on it, and lets it change type — only removal is refused", () => {
    createTestItem(handle.db, { type: "story", title: "One", stepId: review });

    const result = replacePipelineGraph(
      handle.db,
      pipelineId,
      [
        ...graph([{ id: build, name: "Build", position: 0 }]),
        { id: review, pipelineId, position: 1, name: "Code review", type: "user" as const, ownerRole: null, entryAction: null },
      ],
      [],
    );

    expect(result).toMatchObject({ replaced: true });
    expect(getStep(handle.db, review)).toMatchObject({ name: "Code review", type: "user" });
  });
});
