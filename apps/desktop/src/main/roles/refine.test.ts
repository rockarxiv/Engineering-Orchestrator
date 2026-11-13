import { developerRegistry, EMPTY_SPEC_SHAPE, missingSpecFields, parsedResultOf, specIssues, refineChildren, refineOutputSchemaFor, ADMIN_MCP_SERVER_NAME, REPOSITORY_INTELLIGENCE_PROVIDER_IDS, REPOSITORY_MCP_SERVER_NAME, type BuiltinRole,  type RefineChild, type Item } from "@eo/core";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  createProject,
  getItemType,
  projectForWorkspace,
  listAgents,
  listDependencies,
  listItems,
  listPipelineSteps,
  setItemHeld,
  syncItemTypes,
  updateAgent,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { createRoute, createStep, listCommentsForItem, listRunsForItem } from "../db/repos/index.js";
import { REPOSITORY_INDEX_DIRECTORIES } from "../packs/developer/repositoryIntelligence/index.js";
import { loadRolePrompt, PLACEHOLDER_PREFIX, promptFiles, promptHash, sourcePromptsDir, syncRolePrompts } from "./prompts.js";
import { applyApprovedProposal, buildProposal, mergeRefineEdges } from "./refine.js";

/**
 * `applyApprovedProposal` with the shipped pipeline's placement.
 *
 * Stories need a pipeline and an entry step now: the literal `"todo"` they
 * used to be created on assumed one pipeline's slugs (ARCHITECTURE.md, "Vocabulary").
 */
function applyApprovedProposalAt(db: Parameters<typeof applyApprovedProposal>[0], feature: Parameters<typeof applyApprovedProposal>[1], output: Parameters<typeof applyApprovedProposal>[2]) {
  return applyApprovedProposal(db, feature, output, { pipelineId: "default" as never, entryStepId: "worktree" });
}


let handle: DbHandle;
let feature: Item;

// A decomposition's children since KAN-147: each states its type and
// carries the fields that type's shape demands, which for a story is its
// acceptance criteria.
function story(title: string, overrides: Partial<RefineChild> = {}): RefineChild {
  return {
    type: "story",
    title,
    body: `${title} body`,
    depends_on: [],
    touches: [],
    spec: { acceptance_criteria: [`${title} works`] },
    ...overrides,
  };
}

function output(...children: RefineChild[]): RefineChild[] {
  return children;
}

beforeEach(() => {
  handle = openMigratedTestDb();
  feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null });
});

afterEach(() => {
  handle.close();
});

describe("the shipped pipeline", () => {
  it("is the shipped pipeline: work enters, is built, reviewed, opened, watched until merged", () => {
    const states = listPipelineSteps(handle.db)
      .filter((state) => !state.offBoard) // `discussion` is not a pipeline stage
      .sort((a, b) => a.position - b.position);

    expect(states.map((state) => state.id)).toEqual(["worktree", "repository_index", "todo", "review", "merge_request", "pull_request_watch", "ready_to_merge"]);
    // The approval gate is not a column any more (ARCHITECTURE.md, "A column is a responsibility,
    // not a status") — it is Discussions'
    // Create item. What is left here holds only work, which is what
    // makes "who is responsible right now" a complete description of it.
    const done = states.find((state) => state.id === "ready_to_merge")!;
    expect(done.isTerminal).toBe(true);
    expect(done.ownerRole).toBeNull(); // nothing runs where work has finished
    expect(done.entryAction).toBeNull();
  });
});

describe("mergeRefineEdges", () => {
  it("keeps the agent's own depends_on", () => {
    const { edges, derivedEdgeCount } = mergeRefineEdges(output(story("A"), story("B", { depends_on: [0] })));

    expect(edges).toEqual([{ from: 1, to: 0, gate: { wait: "finished", step: null } }]);
    expect(derivedEdgeCount).toBe(0);
  });

  it("infers an edge when two stories touch the same module (§7)", () => {
    const { edges, derivedEdgeCount } = mergeRefineEdges(
      output(story("A", { touches: ["src/api.ts"] }), story("B", { touches: ["src/api.ts"] })),
    );

    expect(edges).toContainEqual({ from: 1, to: 0, gate: { wait: "finished", step: null } }); // serialised, though the agent never said so
    expect(derivedEdgeCount).toBe(1);
  });

  it("does not double-count an edge the agent already declared", () => {
    const { edges, derivedEdgeCount } = mergeRefineEdges(
      output(story("A", { touches: ["src/api.ts"] }), story("B", { depends_on: [0], touches: ["src/api.ts"] })),
    );

    expect(edges).toEqual([{ from: 1, to: 0, gate: { wait: "finished", step: null } }]);
    expect(derivedEdgeCount).toBe(0);
  });

  it("leaves stories touching different files independent", () => {
    const { edges } = mergeRefineEdges(output(story("A", { touches: ["src/a.ts"] }), story("B", { touches: ["src/b.ts"] })));
    expect(edges).toEqual([]);
  });
});

describe("applyApprovedProposal", () => {
  it("creates story items parented to the feature, ready to work on", () => {
    // Approving *is* the gate (R-04) — these are created because a
    // human already agreed to them, so there is no second wait.
    const result = applyApprovedProposalAt(handle.db, feature, output(story("A"), story("B", { depends_on: [0] })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stories).toHaveLength(2);
    for (const created of result.stories) {
      expect(created.parentId).toBe(feature.id);
      // Where the pipeline says work enters, not a literal (ARCHITECTURE.md, "Vocabulary").
      expect(created.stepId).toBe("worktree");
    }
  });

  it("decomposes a plan that states no type as this pack's story, whoever else ships the word (KAN-129)", () => {
    // A plan with no type on its children is a *submitted* one, or one
    // written before the composed schema asked for a type — and
    // decomposing a container has always produced this pack's stories.
    // That is not ambiguous however many packs ship the word, so a
    // support pack arriving must not stop a feature being broken up.
    syncItemTypes(handle.db, [{ packSlug: "support", slug: "story", label: "Request", plural: "Requests", container: false, specShape: EMPTY_SPEC_SHAPE, actionOverrides: {} }]);

    const result = applyApprovedProposalAt(handle.db, feature, output(story("A", { type: null })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // And on the developer pack's row, not the other one's.
    expect(getItemType(handle.db, result.stories[0]!.typeId)?.packSlug).toBe("developer");
  });

  it("refuses a plan that states a word two packs both ship, naming both (KAN-147)", () => {
    // The opposite case, and the one the composed schema created: a
    // child states its type now, and the document offered every work
    // type the project has — so the bare word is a question with two
    // answers. `resolveItemType` answers it by naming both spellings
    // rather than picking, exactly as it does for a classification, and
    // nothing is created meanwhile.
    syncItemTypes(handle.db, [{ packSlug: "support", slug: "story", label: "Request", plural: "Requests", container: false, specShape: EMPTY_SPEC_SHAPE, actionOverrides: {} }]);

    const result = applyApprovedProposalAt(handle.db, feature, output(story("A")));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("developer:story");
    expect(result.ok === false && result.reason).toContain("support:story");
    expect(listItems(handle.db).filter((item) => item.parentId === feature.id)).toHaveLength(0);
  });

  it("persists acceptance criteria and touches onto the item spec, where E-06 reads them", () => {
    const result = applyApprovedProposalAt(
      handle.db,
      feature,
      output(story("A", { spec: { acceptance_criteria: ["429 after 100 req/min"] }, touches: ["src/limiter.ts"] })),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stories[0]?.spec).toEqual({ acceptance_criteria: ["429 after 100 req/min"], touches: ["src/limiter.ts"] });
  });

  it("writes the dependency edges, including inferred ones", () => {
    const result = applyApprovedProposalAt(
      handle.db,
      feature,
      output(story("A", { touches: ["src/api.ts"] }), story("B", { touches: ["src/api.ts"] })),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const deps = listDependencies(handle.db, result.stories[1]!.id);
    expect(deps.map((dep) => dep.dependsOnId)).toEqual([result.stories[0]!.id]);
  });

});

describe("buildProposal", () => {
  it("refuses a graph that only becomes cyclic once touches are merged", () => {
    // Individually fine: B depends on A. But both touch the same file, so
    // the derived edge would point A at B as well — a cycle that A-02's
    // pre-merge validation cannot have caught. Checked here, at proposal
    // time, so an unbuildable plan never reaches the human as
    // approvable (R-04).
    const result = buildProposal(handle.db, feature.projectId, output(story("A", { depends_on: [1], touches: ["src/shared.ts"] }), story("B", { touches: ["src/shared.ts"] })));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("cycle");
    expect(listItems(handle.db).filter((item) => item.parentId === feature.id)).toHaveLength(0); // nothing written
  });

  it("renders the plan with each story's criteria and what it depends on", () => {
    // The proposal is the artefact you decide on, so it has to carry
    // everything the decision needs.
    const result = buildProposal(
      handle.db,
      feature.projectId,
      output(story("Limit", { spec: { acceptance_criteria: ["429 after 100 req/min"] } }), story("Respond", { depends_on: [0] })),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain("Limit");
    expect(result.body).toContain("429 after 100 req/min");
    expect(result.body).toContain("Depends on #1");
    expect(result.body).toContain("Approve");
  });

  it("says when a dependency was inferred rather than asked for", () => {
    const result = buildProposal(handle.db, feature.projectId, output(story("A", { touches: ["src/api.ts"] }), story("B", { touches: ["src/api.ts"] })));

    expect(result.ok && result.body).toContain("inferred");
  });
});

describe("role prompts", () => {
  it("ships a versioned prompt file per role", () => {
    for (const role of ["system", "implementer", "reviewer"]) {
      const prompt = loadRolePrompt(role);
      expect(prompt, role).toBeDefined();
      expect(prompt).toContain("prompt-version:");
    }
  });

  it("has no prompt for a role it doesn't know", () => {
    expect(loadRolePrompt("tester")).toBeUndefined();
  });

  it("never asks the system agent for a story's Jira key or switch", () => {
    // EO-124. `jira_key` and `jira_sync` are fields whoever *hands over*
    // a plan fills in, because that plan mirrors an epic that already
    // exists. This agent is proposing work that exists nowhere yet, so
    // it has no key to give — and a prompt naming the field would be
    // inviting it to invent one. The other half of this is
    // `ProposedStorySchema`, which keeps them out of the JSON schema the
    // provider constrains generation with.
    const prompt = loadRolePrompt("system")!;

    expect(prompt).not.toContain("jira_key");
    expect(prompt).not.toContain("jira_sync");
  });

  it("replaces the seed placeholder with the real prompt", () => {
    const before = listAgents(handle.db);
    expect(before.every((agent) => agent.instructions.startsWith(PLACEHOLDER_PREFIX))).toBe(true);

    const { updated } = syncRolePrompts(handle.db);

    // Three, not four. 0062 left the retired architect row on
    // `pipeline_architect`, which is no longer a role EO ships, so
    // `loadRolePrompt` finds no file for it and the sync passes over it
    // — which is what must happen: writing `system-agent.md` into a
    // switched-off row would replace its text with a prompt for a job it
    // is not doing.
    expect(updated.sort()).toEqual(["implementer", "reviewer", "system"]);
    const agent = listAgents(handle.db).find((candidate) => candidate.role === "system")!;
    // Both halves of the merge, in one prompt.
    expect(agent.instructions).toContain("## refine");
    expect(agent.instructions).toContain("## Pipeline drafts");
    // …and the retired row still holds 0036's placeholder, untouched.
    expect(
      listAgents(handle.db).find((candidate) => candidate.role === "pipeline_architect")!.instructions.startsWith(PLACEHOLDER_PREFIX),
    ).toBe(true);
  });

  it("never overwrites instructions a human has customised", () => {
    const po = listAgents(handle.db).find((agent) => agent.role === "system")!;
    updateAgent(handle.db, po.id, { instructions: "My own carefully tuned prompt." });

    syncRolePrompts(handle.db);

    expect(listAgents(handle.db).find((agent) => agent.role === "system")?.instructions).toBe("My own carefully tuned prompt.");
  });

  /**
   * A build that ships a newer prompt than the one already installed.
   *
   * The whole point of versioning prompts is that they improve, and until
   * `agents.prompt_hash` existed an improvement reached nobody past their
   * first launch — the sync could not tell an untouched default from an
   * edit, so it left everything alone.
   */
  function shippingNewer(role: BuiltinRole, text: string): string {
    const directory = mkdtempSync(join(tmpdir(), "eo prompts "));
    cpSync(sourcePromptsDir(), directory, { recursive: true });
    // `promptFiles()` rather than `role.replace("_", "-") + ".md"`, which
    // guessed right only while every filename happened to be its role's.
    // `system` is served by `system-agent.md`, so the guess would have
    // written a file nothing reads and this helper would have silently
    // stopped shipping anything newer at all.
    const file = promptFiles()[role];
    if (file === undefined) throw new Error(`No prompt file for "${role}".`);
    writeFileSync(join(directory, file), text);
    return directory;
  }

  it("brings a prompt EO wrote up to a newer shipped version", () => {
    syncRolePrompts(handle.db); // installs this build's defaults, and records that EO wrote them
    const directory = shippingNewer("system", "<!-- prompt-version: 99 -->\nA better prompt.");

    try {
      const { updated, customised } = syncRolePrompts(handle.db, directory);

      expect(updated).toContain("system");
      expect(customised).toEqual([]);
      expect(listAgents(handle.db).find((agent) => agent.role === "system")?.instructions).toContain("A better prompt.");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  /**
   * The two gates, stated in the prompt (EO-181).
   *
   * The merged agent holds a wider tool surface than either role it
   * replaces did, and later work in this arc widens it further — so
   * "propose it" stops being the only thing it *can* do and becomes the
   * thing it is told to do. Asserted here because a prompt is the only
   * place that instruction lives, and a rewrite that dropped it would
   * leave nothing to notice.
   */
  it("tells the system agent that both approval gates are the route", () => {
    const prompt = loadRolePrompt("system")!;

    // A pipeline change is a draft somebody publishes…
    expect(prompt).toContain("Publish");
    expect(prompt).toMatch(/pipeline change is a draft/i);
    // …and work is proposed for somebody to accept.
    expect(prompt).toMatch(/a person accepts/i);
    // Both halves of the merge are in the one file — and the third job
    // the arc added to it (EO-184), which the schema alone cannot teach:
    // that `answer` is the step's own words rather than a paraphrase,
    // and that guessing between two readings is not an answer.
    for (const section of ["## assist", "## intake", "## refine", "## Pipeline drafts", "## interpret"]) {
      expect(prompt, section).toContain(section);
    }
    expect(prompt).toMatch(/do not answer on their behalf/i);
  });

  it("tells the system agent a bug keeps acceptance criteria without being asked for them", () => {
    // EO-205. Both payloads this agent produces — `intake`'s bug branch
    // and a `new_bug` proposal — now carry an optional
    // `acceptance_criteria`, and a prompt that says nothing would leave
    // the field to be discovered from the JSON schema alone. Both
    // halves are asserted, because they pull in opposite directions:
    // the field is kept when it is there, and it is never something to
    // hold a bug report hostage over.
    const prompt = loadRolePrompt("system")!;

    expect(prompt).toMatch(/`acceptance_criteria` is optional here and kept when you send it/i);
    expect(prompt).toMatch(/accepted on a bug and is not required/i);
    expect(prompt).toMatch(/do not\s+ask for one/i);
  });

  /**
   * EO-209. The gate refuses a draft that drops a step it never declared,
   * so a prompt that never mentions `removes` turns the first honest
   * whole-graph proposal into a rejection — the agent is told the rule
   * only by breaking it.
   *
   * Both halves, because they pull in opposite directions: omission is
   * deletion (so the whole graph still has to be typed out), and a
   * deletion is declared (so leaving a step out is not how you achieve
   * one).
   */
  it("tells the system agent that a step left out of a draft is a step removed, and that a removal is declared", () => {
    const prompt = loadRolePrompt("system")!;

    expect(prompt).toMatch(/a step you leave out of a draft\s+is a step you have removed/i);
    expect(prompt).toMatch(/`removes`/);
    expect(prompt).toMatch(/not\s+something you achieve by not typing it/i);
  });

  it("bumped the system prompt, so the wording reaches an install already holding EO's own copy", () => {
    // The same reason as every bump before it: `syncRolePrompts`
    // compares the text, so an install already holding EO's own copy
    // keeps the old wording until a newer version says otherwise. 2 was
    // EO-184's, 3 was EO-205's; 4 carries EO-209's `removes`.
    expect(Number(/prompt-version:\s*(\d+)/.exec(loadRolePrompt("system")!)![1])).toBeGreaterThanOrEqual(4);
  });

  it("recognises a default installed before the role was renamed and before EO recorded what it wrote", () => {
    // The pre-0033 install that migration 0062 renamed. Its row now says
    // `system`, its text is still the product owner's, and it carries no
    // provenance — so the only thing that can tell EO's own words from a
    // human's afternoon is `SHIPPED_PROMPT_HASHES`, which is keyed on the
    // role. Without the old hashes travelling to the new key this reads
    // as customised and the install is stranded on a prompt for a role
    // that no longer exists.
    const system = listAgents(handle.db).find((agent) => agent.role === "system")!;
    const shipped = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "product-owner-v8.md"), "utf8");
    updateAgent(handle.db, system.id, { instructions: shipped.trim(), promptHash: null });

    const { updated, customised } = syncRolePrompts(handle.db);

    expect(updated).toContain("system");
    expect(customised).not.toContain("system");
    expect(listAgents(handle.db).find((agent) => agent.role === "system")?.instructions).toBe(loadRolePrompt("system"));
  });

  it("recognises a default installed before EO recorded what it wrote", () => {
    // Exactly the state every pre-0033 install is in: EO's own text, and
    // no provenance saying so.
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    // A prompt EO shipped at version 4, kept as a fixture. It used to read
    // `loadRolePrompt("implementer")`, which worked only while the current
    // file happened to still be one of the versions that predate the
    // provenance column. Nothing current is in that set any more — for any
    // role — which is exactly the steady state `SHIPPED_PROMPT_HASHES`
    // describes, so the historical text has to be pinned rather than
    // borrowed from whatever ships today.
    const shipped = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "implementer-v4.md"), "utf8");
    updateAgent(handle.db, implementer.id, { instructions: shipped.trim(), promptHash: null });
    const directory = shippingNewer("implementer", "<!-- prompt-version: 99 -->\nA better implementer prompt.");

    try {
      expect(syncRolePrompts(handle.db, directory).updated).toContain("implementer");
      expect(listAgents(handle.db).find((agent) => agent.role === "implementer")?.instructions).toContain("A better implementer prompt.");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves an edited prompt alone across versions, and says it did", () => {
    syncRolePrompts(handle.db);
    const po = listAgents(handle.db).find((agent) => agent.role === "system")!;
    // Through the same path the Agents screen writes: a human's save
    // carries no provenance, which is what makes it theirs.
    updateAgent(handle.db, po.id, { instructions: `${loadRolePrompt("system")!}\n\nAlways ask about analytics.`, promptHash: null });
    const directory = shippingNewer("system", "<!-- prompt-version: 99 -->\nA better prompt.");

    try {
      const { updated, customised } = syncRolePrompts(handle.db, directory);

      expect(updated).not.toContain("system");
      expect(customised).toContain("system");
      expect(listAgents(handle.db).find((agent) => agent.role === "system")?.instructions).toContain("Always ask about analytics.");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records provenance for a prompt that is already current", () => {
    const po = listAgents(handle.db).find((agent) => agent.role === "system")!;
    updateAgent(handle.db, po.id, { instructions: loadRolePrompt("system")!, promptHash: null });

    syncRolePrompts(handle.db);

    // Nothing to change today; everything to change on the next version.
    expect(listAgents(handle.db).find((agent) => agent.role === "system")?.promptHash).toBe(promptHash(loadRolePrompt("system")!));
  });

  /**
   * The reviewer answering before it has reviewed (EO-199).
   *
   * Five review runs on EO-194 opened with a complete, schema-valid
   * outcome — "I'll review the diff and its repository impact against
   * every acceptance criterion" — and every one was dropped by
   * `superseded()` and reported as an engine note in the item thread.
   *
   * Most of that was never the reviewer's to fix, and the fix is not
   * here: Codex takes `outputSchema` on `runStreamed`, so the schema is
   * in force for the whole turn and a preamble has no shape available to
   * it but the answer's. `providers/codex.ts` marks those messages and
   * the supervisor no longer reads them as candidate answers, which is
   * what `supervisor/progressOutcome.test.ts` establishes. The guard is
   * untouched and still fires for an agent that chose the shape.
   *
   * What is left for the prompt is the part that is genuinely the
   * reviewer's: a verdict is the end of a review rather than its opening
   * move, and `needs_user_input` — which `reviewer.md` had never named,
   * leaving the schema as its only account, and the schema offers the
   * shared `clarification_required` shape beside it.
   */
  describe("when the reviewer answers", () => {
    /** Whitespace-insensitive: these sentences wrap mid-clause in the file. */
    const flat = (text: string) => text.replace(/\s+/g, " ").trim();

    it("says the verdict is the last thing the reviewer says, and what becomes of one sent early", () => {
      const reviewer = flat(loadRolePrompt("reviewer")!);

      expect(reviewer).toContain("Your verdict is the last thing you say");
      // The consequence, not just the rule. An instruction with no reason
      // attached is the one an agent talks itself out of.
      expect(reviewer).toContain("it drops the payload and says so on the ticket");
      // And the other half: there is no reason to open with a plan, since
      // the work is already visible to whoever is watching the run.
      expect(reviewer).toContain("anything to announce before you have a verdict");
      // Not a claim about any one backend. What a message's shape means
      // is settled in the adapter now, so a prompt asserting it here
      // would be describing a mechanism it no longer shares in.
      expect(reviewer).not.toContain("wearing the answer's shape");
    });

    it("gives the reviewer one way to ask, and says what it carries", () => {
      const reviewer = flat(loadRolePrompt("reviewer")!);

      expect(reviewer).toContain("`needs_user_input` is the third verdict");
      expect(reviewer).toContain("that shape is not yours");
      // Read against EO-200, whose subject is the same one: what each
      // verdict carries. `criteria_coverage` and `blocking_issues` are
      // both on the rejection branch alone, so the third verdict has to
      // account for itself against that rather than beside it — a prompt
      // implying otherwise asks for fields generation cannot produce.
      expect(reviewer).toContain("carries neither `blocking_issues` nor a coverage table");
    });

    it("bumped the reviewer prompt, so the wording reaches an install already holding EO's own copy", () => {
      // `syncRolePrompts` compares text and provenance, not version — but
      // a prompt changed without a version bump is a change nobody can
      // see in the file. 11 was EO-198's and EO-200's; this is the next.
      expect(Number(/prompt-version:\s*(\d+)/.exec(loadRolePrompt("reviewer")!)![1])).toBeGreaterThanOrEqual(12);
    });
  });

  describe("repository intelligence", () => {
    /**
     * The one bullet a prompt spends on it.
     *
     * Found by the server's own name rather than by `mcp__repo__`, which
     * is what it used to be and what EO-198 was: that prefix is one
     * backend's punctuation, so keying on it made this helper — and the
     * prompt it reads — quietly about Claude.
     */
    function instruction(role: string): string {
      const bullets = `\n${loadRolePrompt(role)!}`.split(/\n- /).slice(1);
      const found = bullets.filter((bullet) => bullet.includes(`\`${REPOSITORY_MCP_SERVER_NAME}\``));
      expect(found, role).toHaveLength(1);
      return found[0]!;
    }

    /** Whitespace-insensitive: the two files wrap the same shared sentence differently. */
    const flat = (text: string) => text.replace(/\s+/g, " ").trim();

    it("names the server the tools answer to, in both prompts", () => {
      // Not "repository intelligence is available to you", which is a
      // pointer to nothing — and not `mcp__repo__` either, which is a
      // pointer to nothing on half the backends EO dispatches to
      // (EO-198). That prefix is Claude's punctuation for a tool id and
      // Codex sends `repo/<tool>`, so the Codex-backed reviewer looked
      // for what its instructions named, found none, and reported the
      // index missing on a run where the server was wired and running.
      //
      // What every backend's spelling has in common is the one part EO
      // owns: the server's name sits in the middle of the tool id
      // whichever way the punctuation falls. So the prompt names that,
      // which is a substring an agent can match on today and on the next
      // backend. The tool ids themselves stay unnamed for the reason they
      // always were — they belong to whichever implementation is behind
      // the port, and "names no implementation" below is the rule.
      for (const role of ["implementer", "reviewer"]) {
        expect(flat(instruction(role)), role).toContain(`an MCP server EO registers as \`${REPOSITORY_MCP_SERVER_NAME}\``);
        // And says when to reach for them: ahead of a search, not after one.
        expect(flat(instruction(role)), role).toContain("before broad filesystem exploration");
      }
    });

    it("keeps the worktree's source authoritative and admits the index can lag", () => {
      // The one sentence that stops this being a licence to review the
      // index instead of the code. Shared verbatim, because it is the
      // same rule for both roles.
      const rule =
        "The source files in this worktree are the source of truth, not the index — always read the relevant source " +
        "before you modify or judge it, and never assume the index is current for files that have changed since it " +
        "was last synchronised.";

      expect(flat(instruction("implementer"))).toContain(rule);
      expect(flat(instruction("reviewer"))).toContain(rule);
    });

    it("tells the reviewer to work outward from the diff to callers and dependents", () => {
      // The reviewer's half of this is impact analysis: the caller a
      // changed signature broke is the thing a diff cannot show, and it
      // is the thing this index is best at finding.
      const reviewer = flat(instruction("reviewer"));

      expect(reviewer).toContain("Work outward from the diff");
      expect(reviewer).toContain("what calls it, what implements it and what depends on it");
      expect(reviewer).toContain("read the affected code");
    });

    /**
     * The tools are in the tool list, and this time it is true (EO-161).
     *
     * Read this one beside its own history, because the sentence being
     * asserted is the sentence EO-160 removed. It said these tools were
     * "in your tool list, each with its own description" and then handed
     * the agent an escape hatch keyed on not finding them there. Neither
     * half was true: MCP tools arrived deferred — named in a
     * system-reminder, schemas unloaded — so an agent looked where it
     * was told, found nothing, took the fallback it had been offered one
     * sentence later, and grepped. Repository intelligence was not
     * queried once on any run between EO-151 shipping and EO-160.
     *
     * EO-160 made the prompt describe that harness. EO-161 changed the
     * harness instead: the Claude adapter marks EO's own two servers
     * `alwaysLoad`, so their tools are in the turn-1 prompt with nothing
     * to load first, and Codex never deferred them at all. So the claim
     * is true on both backends now — and it is true *because* of a line
     * in `providers/claude.ts` rather than by luck, which is why this
     * asserts it and `providers/toolLoading.live.test.ts` establishes it
     * against the real CLI.
     *
     * The fallback stays, and stays second. It is what makes the prompt
     * degrade rather than rot if a future CLI stops honouring the
     * exemption: an agent that finds a deferral notice instead of a tool
     * is told, in the same bullet, what to do about it. Getting that half
     * wrong is how EO-160 happened.
     *
     * What it no longer does is name the call (EO-198). It used to say
     * "one `ToolSearch` call", and `ToolSearch` is a tool the Claude Code
     * harness has and Codex does not — so on the backend the reviewer
     * actually runs on, the escape hatch was a pointer to nothing, in the
     * bullet whose whole job is to stop the agent concluding there is
     * nothing there. Every harness that defers a tool says so and says
     * how to load it; the prompt tells the agent to do that rather than
     * telling it which button one harness calls it.
     */
    it("says the repository tools are already listed, and how to load them if they are not", () => {
      for (const role of ["implementer", "reviewer"]) {
        const bullet = flat(instruction(role));

        // The claim EO-161 made true. Whoever removes the `alwaysLoad`
        // line has to come here and explain themselves.
        expect(bullet, role).toContain("They are in your tool list");
        // And the fallback, still there and still second: an agent told
        // only that the index "is available" has been given a pointer to
        // nothing. Named by what the harness does rather than by what one
        // harness calls it.
        expect(bullet, role).toContain("If your harness has deferred them instead of listing them, it says so and says how to load them");
        // Never the shape EO-160 found, where the escape hatch is the
        // second sentence and the agent is invited to take it.
        expect(bullet, role).not.toContain("They are not in your tool list");
      }
    });

    it("keys the fallback on the load coming back empty, not on the tool list", () => {
      // Graceful degradation is a promise this subsystem makes, so the
      // prompt has to survive it: an agent that finds no `repo` tools
      // must know that is a state of the world and not a mistake of its
      // own. What it must not be given is a test that cannot come out
      // false — "no `mcp__repo__` in your tool list" is true on every
      // run, index or no index, so keying on it declares the feature
      // dead every time (EO-160). Loading them and getting nothing back
      // is the same question asked where it has two answers, and the
      // engine comment `agentServer.ts` posts is the other half.
      for (const role of ["implementer", "reviewer"]) {
        expect(flat(instruction(role)), role).toContain(
          "Not finding them listed is not the signal that there is no index; if loading them turns up no " +
            `\`${REPOSITORY_MCP_SERVER_NAME}\` tool at all then repository intelligence is unavailable on this run, ` +
            "an engine comment on the ticket says why, and you",
        );
      }
    });

    it("costs a paragraph rather than a context window", () => {
      // The guard on the thing this feature is for. No symbol list, no
      // file inventory, no fenced dump — one bullet that says where to
      // ask, so the agent pays for the symbols it actually wanted rather
      // than for all of them on every turn.
      //
      // The ceiling is loose against the regression it is for: the
      // bullets sit near 1,400 characters, an index pasted into one is an
      // order of magnitude bigger, so this fires on that rather than on
      // somebody rewording a sentence.
      //
      // "Near 1,000" is what this used to say and it was already wrong by
      // the time EO-198 read it — the reviewer's bullet was 1,446. Left
      // at 1,500 rather than raised, because the wording that replaced
      // Claude's tool-id spelling is *shorter* than what it replaced
      // (1,337 to 1,324 and 1,446 to 1,431), so nothing here needed room.
      // Whoever does need it should raise the number deliberately rather
      // than find out by tripping it.
      for (const role of ["implementer", "reviewer"]) {
        const bullet = instruction(role);
        expect(bullet.length, role).toBeLessThan(1_500);
        expect(bullet, role).not.toContain("```");
      }
    });

    /**
     * A prompt may not name what is behind the port (EO-163).
     *
     * A role prompt is the furthest place in this codebase from the
     * implementation and the worst place to name one: swap the provider
     * and the instruction does not fail, it goes quietly wrong — warning
     * an agent off a directory nothing writes any more and saying
     * nothing about the one now appearing in its worktree. The
     * implementer prompt did exactly that, spelling the index directory
     * into the bullet that tells an agent not to commit it. The advice
     * was right and stayed; the name went.
     *
     * Asserted over every prompt EO ships rather than the two that
     * mention repository intelligence, and against the catalogue rather
     * than a word typed here, so a second provider is covered on the day
     * its row lands without anybody remembering this test exists.
     *
     * What this cannot reach, stated so it is not mistaken for a claim:
     * the tool ids a model sees are `mcp__repo__<implementation>_*`. The
     * middle is EO's and the suffix is the provider's, and only a
     * renaming proxy in front of the server would hide it — deliberately
     * out of scope when the subsystem was designed and still out of
     * scope. The narrow claim this defends is the honest one: nothing an
     * agent is *instructed* to rely on names the implementation.
     */
    it("names no implementation, in any prompt EO ships", () => {
      const forbidden = [...REPOSITORY_INTELLIGENCE_PROVIDER_IDS, ...REPOSITORY_INDEX_DIRECTORIES];
      // Neither list may be empty, or the scan below is a scan for
      // nothing that passes for ever.
      expect(REPOSITORY_INTELLIGENCE_PROVIDER_IDS.length).toBeGreaterThan(0);
      expect(REPOSITORY_INDEX_DIRECTORIES.length).toBeGreaterThan(0);

      const prompts = readdirSync(sourcePromptsDir()).filter((file) => file.endsWith(".md"));
      expect(prompts.length).toBeGreaterThan(0);

      const offenders = prompts.filter((file) => {
        const text = readFileSync(join(sourcePromptsDir(), file), "utf8");
        return forbidden.some((name) => text.includes(name));
      });

      expect(offenders).toEqual([]);
    });

    /**
     * A prompt may not name one backend's punctuation either (EO-198).
     *
     * The rule above keeps the *implementation* out of a prompt. This one
     * keeps the *harness* out, and it is the same mistake one layer up:
     * `mcp__<server>__<tool>` is Claude's spelling of a tool id and
     * `<server>/<tool>` is Codex's. `repositoryIntelligence/measurement.ts`
     * already carries both, and says why in as many words — a census that
     * knew only the first "reports zero index calls for every run on the
     * second backend". A prompt that picks one is that same half-truth
     * pointed at an agent instead of at a report, and it fails worse: the
     * reviewer runs on Codex, looked for the `mcp__repo__` tools its
     * instructions named, found none, and reported the repository index
     * missing on a run where the server was wired and answering.
     *
     * `ToolSearch` is here for the same reason and is not a server name
     * at all. It is a tool the Claude Code harness provides, and the
     * prompt offered it as the recovery for exactly the situation the
     * Codex agent was in — so the one sentence written to stop an agent
     * concluding the index is absent named a tool that agent does not
     * have.
     *
     * Over every prompt EO ships rather than the two that mention
     * repository intelligence, and derived from the reserved server name
     * rather than typed here, so renaming the server moves the rule with
     * it.
     *
     * **`eo_admin` joined the list, and the rule grew a sibling
     * (EO-203).** EO-198 left this server's spelling alone on the
     * reasoning that a suffix like `comment_search` is distinctive enough
     * for an agent to match on — which held where it was measured, and is
     * a weaker bet for a sentence that names one exact id and instructs
     * the agent to call it *first*. The dispatch context said exactly
     * that, in `mcp__eo_admin__` punctuation, and this scan could never
     * have caught it: that string is generated in `packages/engine` and
     * written in no `.md` at all. So the same rule is now asserted over
     * generated prompt text as well, in `packages/engine/src/context.test.ts`,
     * and the two lists are deliberately the same shape.
     *
     * `eo` is still not on either list, and that is still EO-198's call.
     */
    it("spells no repository or administrative tool id in one backend's punctuation, in any prompt EO ships", () => {
      const forbidden = [
        `mcp__${REPOSITORY_MCP_SERVER_NAME}__`,
        `${REPOSITORY_MCP_SERVER_NAME}/`,
        `mcp__${ADMIN_MCP_SERVER_NAME}__`,
        `${ADMIN_MCP_SERVER_NAME}/`,
        "ToolSearch",
      ];

      const prompts = readdirSync(sourcePromptsDir()).filter((file) => file.endsWith(".md"));
      expect(prompts.length).toBeGreaterThan(0);

      const offenders = prompts.filter((file) => {
        const text = readFileSync(join(sourcePromptsDir(), file), "utf8");
        return forbidden.some((spelling) => text.includes(spelling));
      });

      expect(offenders).toEqual([]);
    });

    it("tells the implementer what to do about a diverged remote branch, and what never to do", () => {
      // EO-429. The pull request step never forces; when the remote
      // branch has diverged it says so in an engine note and routes
      // here, so this is the only place the resolution is written down.
      // Collapsed to single spaces, since the prompt is hard-wrapped.
      const prompt = loadRolePrompt("implementer")!.replace(/\s+/g, " ");

      expect(prompt).toContain("engine note on the ticket says the remote branch has diverged");
      expect(prompt).toContain("rebase the local branch onto the base ref the note names");
      expect(prompt).toContain("`git push --force-with-lease`");
      expect(prompt).toContain("Never a bare `--force`, `-f` or a `+refspec`");
      expect(prompt).toContain("Never any branch but this ticket's own");
      expect(prompt).toContain("Never a branch a person named on the ticket");
      expect(prompt).toContain("do not overwrite it. Bring it into the local branch, or return a question");
      // Bumped, for the reason below: an install holding EO's own copy
      // keeps the old text until a newer version says otherwise.
      expect(Number(/prompt-version:\s*(\d+)/.exec(loadRolePrompt("implementer")!)![1])).toBeGreaterThanOrEqual(13);
    });

    it("lists the pull request step's two new results where the system agent routes from", () => {
      // In prose, beside what it already says about `failed`: the table
      // of keys that once stood here was taken out so that it could not
      // disagree with the catalog, and `registry_get` is still where the
      // whole list comes from. What the catalog cannot say is where
      // these two should go.
      const prompt = loadRolePrompt("system")!.replace(/\s+/g, " ");

      expect(prompt).toContain("`open_pull_request` has two results that are neither its success nor a failure: `uncommitted_changes`");
      expect(prompt).toContain("and `remote_diverged`, when the remote branch holds commits the local one does not");
      expect(prompt).toContain("route both to the step the implementer owns");
      expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(19);
    });

    it("bumped both prompts again, so the backend-neutral wording reaches an existing install", () => {
      // EO-198, and the same reason as every bump before it:
      // `syncRolePrompts` compares the text, so an install already
      // holding EO's own copy keeps the Claude-only wording until a
      // newer version says otherwise.
      const version = (role: string) => Number(/prompt-version:\s*(\d+)/.exec(loadRolePrompt(role)!)![1]);

      expect(version("implementer")).toBeGreaterThanOrEqual(12);
      expect(version("reviewer")).toBeGreaterThanOrEqual(10);
    });

    it("bumped the implementer prompt again, so the wording without the name reaches an existing install", () => {
      // Same reason as below, one story later: `syncRolePrompts`
      // compares the text, and an install already holding EO's own copy
      // keeps whatever it has until a newer version says otherwise.
      expect(Number(/prompt-version:\s*(\d+)/.exec(loadRolePrompt("implementer")!)![1])).toBeGreaterThanOrEqual(11);
    });

    it("bumped both prompt versions so the change reaches an existing install", () => {
      // Without this an install that already holds EO's own copy keeps
      // the old text forever: `syncRolePrompts` compares the text, and a
      // prompt nobody is told has changed is a change that did not happen.
      const version = (role: string) => Number(/prompt-version:\s*(\d+)/.exec(loadRolePrompt(role)!)![1]);

      expect(version("implementer")).toBeGreaterThanOrEqual(10);
      expect(version("reviewer")).toBeGreaterThanOrEqual(9);
    });

    it("upgrades EO's own copy of these prompts and still leaves an edited one alone", () => {
      syncRolePrompts(handle.db); // this build's defaults, with provenance recorded
      const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
      // A human's save carries no provenance, which is what makes it theirs.
      updateAgent(handle.db, reviewer.id, { instructions: `${loadRolePrompt("reviewer")!}\n\nAlways check the migrations.`, promptHash: null });
      const directory = shippingNewer("implementer", "<!-- prompt-version: 99 -->\nA better implementer prompt.");

      try {
        const { updated, customised } = syncRolePrompts(handle.db, directory);

        expect(updated).toContain("implementer");
        expect(customised).toContain("reviewer");
        expect(listAgents(handle.db).find((agent) => agent.role === "reviewer")?.instructions).toContain("Always check the migrations.");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});

/**
 * Routing stories to repositories (KAN-17).
 *
 * The rule the whole feature rests on: a story lands in exactly one
 * repository. Getting this wrong does not fail loudly — it produces a
 * branch and a pull request in the wrong repo, which is discovered by a
 * person, later, in someone else's repository.
 *
 * A project over one repository must behave exactly as it did before any
 * of this existed, which is what most of these assert.
 */
describe("which repository a story lands in", () => {
  function twoRepoProject() {
    const web = attachWorkspace(handle.db, { name: "shop-web", keyPrefix: "WEB", repoPath: "/tmp/web" });
    const api = attachWorkspace(handle.db, { name: "shop-api", keyPrefix: "API", repoPath: "/tmp/api" });
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [web.id, api.id] });
    const spanning = createTestItem(handle.db, { type: "feature", title: "Checkout", stepId: null, projectId: project.id });
    return { web, api, project, feature: spanning };
  }

  it("puts each story in the repository the plan named", () => {
    const { web, api, feature: spanning } = twoRepoProject();

    const applied = applyApprovedProposalAt(
      handle.db,
      spanning,
      output(story("Cart page", { repository: "shop-web" }), story("Charge endpoint", { repository: "shop-api" })),
    );

    expect(applied.ok).toBe(true);
    const byTitle = new Map(listItems(handle.db).map((item) => [item.title, item]));
    expect(byTitle.get("Cart page")?.workspaceId).toBe(web.id);
    expect(byTitle.get("Charge endpoint")?.workspaceId).toBe(api.id);
  });

  it("gives every story its feature's project, whichever repository it went to", () => {
    // Without this the stories exist but appear on no project — the same
    // way imported Jira issues vanished in slice 2.
    const { project, feature: spanning } = twoRepoProject();

    applyApprovedProposalAt(handle.db, spanning, output(story("Cart page", { repository: "shop-web" })));

    expect(listItems(handle.db).find((item) => item.title === "Cart page")?.projectId).toBe(project.id);
  });

  it("keys each story from the project, whichever repository it landed in", () => {
    // KAN-128 turned this round. A story used to key from its repository,
    // which meant one decomposition of one feature produced WEB-1 and
    // API-1 — two counters numbering one project's work, and neither key
    // saying which project it belonged to. The repository is still on the
    // item, and still where the branch is cut.
    const { feature: spanning } = twoRepoProject();

    applyApprovedProposalAt(
      handle.db,
      spanning,
      output(story("Cart page", { repository: "shop-web" }), story("Charge endpoint", { repository: "shop-api" })),
    );

    const byTitle = new Map(listItems(handle.db).map((item) => [item.title, item]));
    expect(byTitle.get("Cart page")?.key).toBe("SHOP-2");
    expect(byTitle.get("Charge endpoint")?.key).toBe("SHOP-3");
  });

  it("matches the name whatever case the agent used", () => {
    const { web, feature: spanning } = twoRepoProject();

    applyApprovedProposalAt(handle.db, spanning, output(story("Cart page", { repository: "SHOP-WEB" })));

    expect(listItems(handle.db).find((item) => item.title === "Cart page")?.workspaceId).toBe(web.id);
  });

  it("refuses a repository that is not on the project, and creates nothing", () => {
    // Guessing would put the branch somewhere nobody is looking. The
    // whole decomposition is rejected rather than partly applied,
    // because a half-built plan is harder to recover from than none.
    const { feature: spanning } = twoRepoProject();
    const before = listItems(handle.db).length;

    const applied = applyApprovedProposalAt(
      handle.db,
      spanning,
      output(story("Cart page", { repository: "shop-web" }), story("Mystery", { repository: "shop-mobile" })),
    );

    expect(applied).toMatchObject({ ok: false });
    expect(applied.ok === false && applied.reason).toContain("shop-mobile");
    expect(applied.ok === false && applied.reason).toContain("shop-web, shop-api");
    expect(listItems(handle.db)).toHaveLength(before);
  });

  it("refuses a story that names no repository when the project spans several", () => {
    const { feature: spanning } = twoRepoProject();

    const applied = applyApprovedProposalAt(handle.db, spanning, output(story("Cart page")));

    expect(applied).toMatchObject({ ok: false });
    expect(applied.ok === false && applied.reason).toContain("does not say which repository");
  });

  it("ignores the field entirely on a project over one repository", () => {
    // The regression guard. A single-repo project never shows the agent a
    // list, so whatever it puts here must not change where work lands.
    const api = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
    const project = projectForWorkspace(handle.db, api.id)!;
    const single = createTestItem(handle.db, { type: "feature", title: "One repo", stepId: null, workspaceId: api.id, projectId: project.id });

    const applied = applyApprovedProposalAt(handle.db, single, output(story("Work", { repository: "somewhere-else" })));

    expect(applied.ok).toBe(true);
    expect(listItems(handle.db).find((item) => item.title === "Work")?.workspaceId).toBe(api.id);
  });

  it("routes a projectless project-level feature to the project's sole repository", () => {
    // Discussions creates features at project scope. The feature therefore has
    // no repository, but its executable stories still need one in order to
    // receive an isolated worktree.
    const api = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
    const project = projectForWorkspace(handle.db, api.id)!;
    const projectFeature = createTestItem(handle.db, { type: "feature", title: "From a discussion", stepId: null, projectId: project.id });

    const applied = applyApprovedProposalAt(handle.db, projectFeature, output(story("Work")));

    expect(applied.ok).toBe(true);
    expect(listItems(handle.db).find((item) => item.title === "Work")?.workspaceId).toBe(api.id);
  });

  it("still inherits the feature's repository when there is no project at all", () => {
    // Onboarding: work described before any repository was attached.
    const applied = applyApprovedProposalAt(handle.db, feature, output(story("Early work")));

    expect(applied.ok).toBe(true);
    expect(listItems(handle.db).find((item) => item.title === "Early work")?.workspaceId).toBeNull();
  });
});

/**
 * Decomposing into a type this code has never heard of (KAN-147).
 *
 * The mirror of intake's own case, and the whole of what the composed
 * decomposition schema is for. `RefineOutputSchema` was story-shaped —
 * a `stories` array whose entries carried `acceptance_criteria` — so a
 * pack's container could not be broken into anything but this pack's
 * stories, and the fields such a child would need were not in the
 * document either. The answer is `children` of a stated type now, each
 * held to that type's own shape.
 *
 * Driven through the real supervisor and a scripted provider, because
 * what is being tested is the document the run is *held to*: a child
 * missing a field its type demands has to be refused by A-02 before any
 * of this pack's code sees it.
 */
describe("decomposing into a type the pack shipped (KAN-147)", () => {
  const CASE = {
    packSlug: "support",
    slug: "case",
    label: "Case",
    plural: "Cases",
    container: false,
    specShape: {
      type: "object" as const,
      properties: {
        customer: { type: "string" as const, minLength: 1 },
        channel: { type: "string" as const, enum: ["email", "phone"] },
      },
      required: ["customer", "channel"],
    },
    actionOverrides: {},
  };

  const PLAN = {
    children: [
      { type: "case", title: "Chase the refund", body: "Ring them.", customer: "ACME", channel: "phone", depends_on: [] },
      { type: "case", title: "Write to the customer", body: "Explain the delay.", customer: "ACME", channel: "email", depends_on: [0] },
    ],
  };

  let container: Item;

  beforeEach(() => {
    syncItemTypes(handle.db, [CASE]);
    // `refine` is an action rather than a column (ARCHITECTURE.md, "A column is a responsibility,
    // not a status"), so a step that
    // runs it is configured here — which is exactly what a person could
    // do, and all this needs from a pipeline.
    createStep(handle.db, { id: "plan", pipelineId: "default" as never, position: -1, name: "Refine", type: "agent", ownerRole: "system", entryAction: "refine" });
    createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "plan", resultKey: "decomposed", label: "Decomposed", target: "todo", position: 0 });
    createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "plan", resultKey: "clarified", label: "Clarified", target: "todo", position: 1 });
    container = createTestItem(handle.db, { type: "feature", title: "Refunds", stepId: "plan" });
  });

  function supervisorReturning(result: unknown) {
    return createRunSupervisor({
      db: handle.db,
      limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 },
      provider: createScriptedProvider([{ when: (context) => context.includes(`"refine" action`), script: { result } }]),
      ...createRoleWiring(handle.db),
    });
  }

  /** The plan the run posted, read back the way approval reads it. */
  function proposalBody(): string {
    return listCommentsForItem(handle.db, container.id).find((comment) => comment.kind === "decision")?.body ?? "";
  }

  it("accepts children of that type and posts the plan for approval", async () => {
    await supervisorReturning(PLAN).runOnce();

    expect(listRunsForItem(handle.db, container.id)[0]?.status).toBe("succeeded");
    // The plan a person reads names both and the dependency between
    // them, and shows each child's own fields — drawn from the type's
    // shape, so a `Case` reads as one without this code knowing what a
    // customer is.
    expect(proposalBody()).toContain("Chase the refund");
    expect(proposalBody()).toContain("**Customer:** ACME");
    expect(proposalBody()).toContain("Depends on #1");
  });

  it("creates them on approval, carrying the fields their type declares", async () => {
    await supervisorReturning(PLAN).runOnce();

    const applied = applyApprovedProposalAt(handle.db, container, refineChildren(parsedResultOf(listRunsForItem(handle.db, container.id)[0]!.result)));

    expect(applied.ok, applied.ok ? "" : applied.reason).toBe(true);
    if (!applied.ok) return;
    expect(applied.stories.map((story) => story.type)).toEqual(["case", "case"]);
    expect(applied.stories[1]?.spec).toMatchObject({ customer: "ACME", channel: "email" });
    // And the dependency the plan stated, as an edge between the two
    // items it created.
    expect(listDependencies(handle.db, applied.stories[1]!.id).map((dependency) => dependency.dependsOnId)).toEqual([applied.stories[0]!.id]);
  });

  it("routes children to the repository they name, all the way from the provider", async () => {
    // The prompt tells the agent which field to name a repository in;
    // the composed schema offers it; `routeChild` reads it. A
    // disagreement between the three is invisible on a board with one
    // repository — where nothing is named and nothing is read — and
    // fatal on a board with two, where every approved child is refused
    // for not saying where it goes. So this walks the whole way: a
    // scripted answer through A-02 and the poster, then the approval
    // that creates the items.
    setItemHeld(handle.db, container.id, Date.now());
    const web = attachWorkspace(handle.db, { name: "shop-web", keyPrefix: "WEB", repoPath: "/tmp/refine-web" });
    const api = attachWorkspace(handle.db, { name: "shop-api", keyPrefix: "API", repoPath: "/tmp/refine-api" });
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [web.id, api.id] });
    const spanning = createTestItem(handle.db, { type: "feature", title: "Checkout", stepId: "plan", projectId: project.id });

    await supervisorReturning({
      children: [
        { type: "story", title: "Cart page", body: "Draw it.", repository: "shop-web", acceptance_criteria: ["It adds up"], depends_on: [] },
        { type: "story", title: "Charge endpoint", body: "Take the money.", repository: "shop-api", acceptance_criteria: ["It charges once"], depends_on: [0] },
      ],
    }).runOnce();

    const run = listRunsForItem(handle.db, spanning.id)[0]!;
    expect(run.status, run.error ?? "").toBe("succeeded");

    const applied = applyApprovedProposalAt(handle.db, spanning, refineChildren(parsedResultOf(run.result)));

    expect(applied.ok, applied.ok ? "" : applied.reason).toBe(true);
    if (!applied.ok) return;
    const byTitle = new Map(applied.stories.map((story) => [story.title, story]));
    expect(byTitle.get("Cart page")?.workspaceId).toBe(web.id);
    expect(byTitle.get("Charge endpoint")?.workspaceId).toBe(api.id);
  });

  it("tells the agent to read its types off the schema rather than naming three", () => {
    // The prompt is the other half of the composed schemas (KAN-147). A
    // document offering a `case` branch reaches an agent that has been
    // told intake is a choice between a feature, a story and a bug, and
    // the instruction wins: a real provider classifies away from the
    // type the project actually has. So both sections point at the
    // schema for what the types are and what each demands, and name the
    // developer pack's three as an example rather than as the set.
    const prompt = loadRolePrompt("system") ?? "";
    const intake = prompt.split("## intake")[1]?.split("## refine")[0] ?? "";
    const refine = prompt.split("## refine")[1] ?? "";

    expect(intake).toMatch(/one of this project's\s+item types/i);
    expect(intake).toMatch(/your schema is the list of types/i);
    // The container split said as the branch says it, rather than as the
    // word `feature`: that is what makes a pack's own container behave.
    expect(intake).toMatch(/holds work/i);
    expect(intake).toMatch(/is work/i);
    // And a worked example of a type EO ships nothing for, so the
    // instruction is not three words with a caveat.
    expect(intake).toContain('"type": "case"');

    expect(refine).toMatch(/one\s+branch per type this project has/i);
    expect(refine).toMatch(/read the branch/i);
  });

  it("bumped the system prompt so the type-agnostic wording reaches an existing install", () => {
    // `syncRolePrompts` compares the text, so an install already holding
    // EO's own copy keeps the feature/story/bug-only instructions until
    // a newer version says otherwise — and a prompt nobody is told has
    // changed is a change that did not happen.
    expect(Number(/prompt-version:\s*(\d+)/.exec(loadRolePrompt("system")!)![1])).toBeGreaterThanOrEqual(7);
  });

  it("tells the agent to name the repository in the field the schema offers", () => {
    // The other half of the same fact, and the half a test can hold
    // still: the prompt and the composed document have to agree about
    // the word, because nothing downstream reads what the agent was
    // told — it reads what the schema carried.
    // The refine section alone: up to the next top-level heading, so a
    // later part of the prompt saying `project` about something else is
    // not read as this one.
    const refine = ((loadRolePrompt("system") ?? "").split("## refine")[1] ?? "").split(/^# /m)[0] ?? "";

    expect(refine).toContain("`repository` on every child");
    expect(refine).not.toContain("`project`");
    expect(JSON.stringify(refineOutputSchemaFor(developerRegistry().itemTypes.values()).toJsonSchema())).toContain('"repository"');
  });

  it("carries a field the envelope owns into the spec when the type declares one", async () => {
    // A shape may name one of the six the envelope owns — `touches` here,
    // which a support pack might well demand of every Case. The document
    // asks for it once, as the envelope, so the value arrives there; if
    // creation read only the child's *other* fields the item would be
    // stored without it and its own type would call it incomplete.
    const demanding = {
      ...CASE,
      slug: "logged",
      specShape: {
        type: "object" as const,
        properties: {
          customer: { type: "string" as const, minLength: 1 },
          touches: { type: "array" as const, items: { type: "string" as const } },
        },
        required: ["customer", "touches"],
      },
    };
    syncItemTypes(handle.db, [demanding]);

    await supervisorReturning({
      children: [{ type: "logged", title: "Chase it", body: "Ring them.", customer: "ACME", touches: ["support/acme.md"], depends_on: [] }],
    }).runOnce();

    const run = listRunsForItem(handle.db, container.id)[0]!;
    expect(run.status, run.error ?? "").toBe("succeeded");

    const applied = applyApprovedProposalAt(handle.db, container, refineChildren(parsedResultOf(run.result)));
    expect(applied.ok, applied.ok ? "" : applied.reason).toBe(true);
    if (!applied.ok) return;

    // Stored under the name the shape declares, so the item satisfies
    // the type it was created as.
    const created = applied.stories[0]!;
    expect(created.spec).toMatchObject({ customer: "ACME", touches: ["support/acme.md"] });
    expect(missingSpecFields(demanding.specShape, created.spec)).toEqual([]);
  });

  it("creates a closed shape's children without breaking the shape with EO's own `touches`", async () => {
    // A type that closes its shape is saying what fields it has. EO's
    // `touches` is not one of them — the overlap check's paths are a
    // property of the work — so a child carrying them must still satisfy
    // its type, and one that touched nothing must not be given an empty
    // list it never declared.
    const sealed = { ...CASE, slug: "sealed", specShape: { ...CASE.specShape, additionalProperties: false } };
    syncItemTypes(handle.db, [sealed]);

    await supervisorReturning({
      children: [
        { type: "sealed", title: "Chase it", body: "Ring them.", customer: "ACME", channel: "phone", touches: ["support/acme.md"], depends_on: [] },
        { type: "sealed", title: "Write to them", body: "Explain.", customer: "ACME", channel: "email", depends_on: [0] },
      ],
    }).runOnce();

    const run = listRunsForItem(handle.db, container.id)[0]!;
    expect(run.status, run.error ?? "").toBe("succeeded");

    const applied = applyApprovedProposalAt(handle.db, container, refineChildren(parsedResultOf(run.result)));
    expect(applied.ok, applied.ok ? "" : applied.reason).toBe(true);
    if (!applied.ok) return;

    const [touched, untouched] = applied.stories;
    // Stored where the overlap check reads it, and the item still
    // satisfies the shape it was created against.
    expect(touched!.spec).toMatchObject({ customer: "ACME", touches: ["support/acme.md"] });
    expect(specIssues(sealed.specShape, touched!.spec)).toEqual([]);
    // And nothing invented for the child that touched nothing.
    expect(untouched!.spec).not.toHaveProperty("touches");
    expect(specIssues(sealed.specShape, untouched!.spec)).toEqual([]);
  });

  it("narrows an envelope field the type declares, keeping both sides' rules", () => {
    // A shape naming one of the six is narrowing a field that already
    // exists rather than adding a second beside it, so the document has
    // to carry both: what the type says where it says anything, and EO's
    // own keywords where it is silent. A `minItems` that never reached
    // the document is an agent answering an empty list the type forbids,
    // with nothing downstream to notice.
    const demanding = {
      slug: "logged",
      container: false,
      specShape: {
        type: "object" as const,
        properties: { touches: { type: "array" as const, minItems: 1 } },
        required: ["touches"],
      },
    };

    /** One step down a JSON Schema document, without a cast per level. */
    const at = (value: unknown, ...path: (string | number)[]): unknown =>
      path.reduce<unknown>((cursor, key) => (typeof cursor === "object" && cursor !== null ? (cursor as Record<string, unknown>)[String(key)] : undefined), value);

    const branch = at(refineOutputSchemaFor([demanding]).toJsonSchema(), "properties", "children", "items", "anyOf", 0);

    expect(at(branch, "required")).toContain("touches");
    expect(at(branch, "properties", "touches")).toMatchObject({ minItems: 1 });
    // EO's own rule for the field survives where the type said nothing
    // about it: a touch is still a path with no spaces in it.
    expect(at(branch, "properties", "touches", "items")).toMatchObject({ pattern: "^\\S+$" });
  });

  it("keeps its own reading of an envelope field a type redefines", async () => {
    // A type may narrow one of the six; it may not say what one *is*.
    // `depends_on` is indices into the plan and everything that reads it
    // — the graph check, the edges, the proposal — is written to that,
    // so a shape calling it a string would compose a document whose
    // valid answers the reader cannot read, and the plan would vanish
    // between validation and the proposal. The document keeps EO's kind,
    // so the wrong answer is refused where every other malformed answer
    // is: at A-02, with a re-prompt.
    const confused = {
      ...CASE,
      slug: "confused",
      specShape: {
        type: "object" as const,
        properties: { depends_on: { type: "string" as const } },
        required: [],
      },
    };
    syncItemTypes(handle.db, [confused]);

    /** One step down a JSON Schema document, without a cast per level. */
    const at = (value: unknown, ...path: (string | number)[]): unknown =>
      path.reduce<unknown>((cursor, key) => (typeof cursor === "object" && cursor !== null ? (cursor as Record<string, unknown>)[String(key)] : undefined), value);
    const branch = at(refineOutputSchemaFor([{ slug: "confused", container: false, specShape: confused.specShape }]).toJsonSchema(), "properties", "children", "items", "anyOf", 0);
    expect(at(branch, "properties", "depends_on")).toMatchObject({ type: "array", items: { anyOf: expect.arrayContaining([expect.objectContaining({ type: "integer" })]) } });

    await supervisorReturning({ children: [{ type: "confused", title: "Chase it", body: "Ring them.", depends_on: "prior" }] }).runOnce();

    // Turned down rather than accepted-then-lost, and the thread says so
    // — a run that reported success with no plan on it would leave the
    // container sitting at the refine step looking finished.
    expect(listRunsForItem(handle.db, container.id)[0]?.status).not.toBe("succeeded");
    expect(listCommentsForItem(handle.db, container.id).some((comment) => comment.kind === "decision")).toBe(false);
    expect(listItems(handle.db).every((item) => item.type !== "confused")).toBe(true);
  });

  it("holds a child to a constraint the type put on an envelope field", async () => {
    // The point of carrying `minItems` through: the document refuses the
    // empty list, so A-02 turns the answer down and nothing is created.
    const demanding = {
      ...CASE,
      slug: "logged",
      specShape: {
        type: "object" as const,
        properties: { touches: { type: "array" as const, minItems: 1 } },
        required: ["touches"],
      },
    };
    syncItemTypes(handle.db, [demanding]);

    await supervisorReturning({ children: [{ type: "logged", title: "Chase it", body: "Ring them.", touches: [], depends_on: [] }] }).runOnce();

    expect(listRunsForItem(handle.db, container.id)[0]?.status).not.toBe("succeeded");
    expect(listItems(handle.db).every((item) => item.type !== "logged")).toBe(true);
  });

  it("refuses a child that is missing a field its type demands", async () => {
    // Held to the composed document by A-02, which is a step before any
    // of this pack's code: nothing is posted and nothing is created.
    const missingCustomer = { children: [{ type: "case", title: "Chase the refund", body: "Ring them.", channel: "phone", depends_on: [] }] };

    await supervisorReturning(missingCustomer).runOnce();

    expect(listRunsForItem(handle.db, container.id)[0]?.status).not.toBe("succeeded");
    expect(proposalBody()).toBe("");
  });

  it("refuses a child of a type this project does not have", async () => {
    await supervisorReturning({ children: [{ type: "incident", title: "Page someone", body: "Now." }] }).runOnce();

    expect(listRunsForItem(handle.db, container.id)[0]?.status).not.toBe("succeeded");
  });
});
