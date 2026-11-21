import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StepTeamSchema, type LeaderTeam, type StepTeam, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { adoptPipeline, getPipeline, getPipelineOrigin, getStep, listStepsForPipeline, openUpdateConflict, replacePipelineGraph, listRoutesForPipeline } from "../db/repos/index.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { storedGraphProblems } from "../ipc/configCommands.js";
import { importPipeline, parseExport } from "../modules/pipelineTransfer.js";
import { loadRolePrompt } from "../roles/prompts.js";
import { compareTemplateVersions, loadTemplateHistory, type TemplateVersion } from "./history.js";
import { templateHistoryUpTo } from "./historyTestHelpers.js";
import { backfillPipelineOrigins } from "./origins.js";
import { applyTemplateUpdates, compareWithTemplate } from "./templateUpdates.js";

/**
 * The software template's Review step as a team (EO-868, 1.5): a
 * leader-led team of focused reviewers, in isolated mode, led by the
 * template's own reviewer. What it is, what it tells the leader, that it
 * says nothing of EO's own, and how an installation already on the
 * template receives it — as any template update, held where the person
 * configured Review's team differently.
 *
 * Running it is `packs/developer/reviewTeam.test.ts`.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const SOFTWARE = "software-feature-to-merge";

type Document = TemplateVersion["document"];
const shipped = loadTemplateHistory(GALLERY_DIRECTORY);
const versionOf = (version: string): TemplateVersion => shipped.get(SOFTWARE)!.find((entry) => entry.version === version)!;
const bundled = JSON.parse(readFileSync(join(GALLERY_DIRECTORY, `${SOFTWARE}.json`), "utf8")) as Document;
const reviewOf = (document: Document) => document.steps.find((step) => step.id === "review")!;
const TEAM = reviewOf(bundled).team as LeaderTeam;

/** Whitespace-insensitive: the prompt is hard-wrapped. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Words that mean something only inside EO itself — its invariants, its
 * tables, its file layout, its internal vocabulary, its own tracker — and
 * nothing in a repository under review. The template is the generic
 * one: every rule a pass checks must come from that repository.
 */
const EO_ONLY: (string | RegExp)[] = [
  "run_events",
  /invariant/i,
  "transitionItem",
  "stepId",
  "pipeline_steps",
  "step_routes",
  "team_sessions",
  "eo_admin",
  "apps/desktop",
  "packages/",
  "packs/",
  "ARCHITECTURE.md",
  "docs/teams.md",
  "review-census",
  "scripts/",
  /\bKAN-\d/,
  /\bEO-\d/,
  "report-only",
  "needs-attention",
  /\bitems?\b/i,
  "domain-neutral",
  "EO's own",
];
const eoOnlyIn = (text: string): string[] => EO_ONLY.filter((term) => (typeof term === "string" ? text.includes(term) : term.test(text))).map(String);

describe("the software template's Review team (EO-868)", () => {
  it("is a leader-led team in isolated mode, led by the reviewer, assigning reviewers alone, within the declared limits", () => {
    expect(StepTeamSchema.parse(TEAM)).toEqual(TEAM);
    expect(TEAM).toMatchObject({ coordination: "leader", members: "isolated", leader: { role: "reviewer" }, roles: ["reviewer"] });
    expect(TEAM.limits).toEqual({ maxParticipants: 8, maxParallel: 4, maxRounds: 2, maxRetries: 1 });
    // Review is still the reviewer's review.
    expect(reviewOf(bundled)).toMatchObject({ type: "agent", ownerRole: "reviewer", entryAction: "review" });
  });

  it("is a new version that adds no role and no agent, and leaves every route and label as 1.4 had them", () => {
    const before = versionOf("1.4").document;
    expect(bundled.template!.version).toBe("1.5");
    expect(compareTemplateVersions(bundled.template!.version, before.template!.version)).toBeGreaterThan(0);
    expect(bundled.roles.map((role) => role.slug)).toEqual(before.roles.map((role) => role.slug));
    expect(bundled.steps.map((step) => [step.id, step.ownerRole])).toEqual(before.steps.map((step) => [step.id, step.ownerRole]));
    expect(bundled.routes).toEqual(before.routes);
    expect(bundled.routes.filter((route) => route.fromStepId === "review").map((route) => [route.resultKey, route.label, route.target])).toEqual([
      ["approved", "Approved", "merge_request"],
      ["changes_requested", "Changes requested", "todo"],
      ["needs_user_input", "Needs user input", "user_attention"],
    ]);
    // The only bundled team is this one: no other step, on either board, has one.
    const teams = [...bundled.steps, ...bundled.boards.flatMap((board) => board.steps)].filter((step) => step.team !== undefined).map((step) => step.id);
    expect(teams).toEqual(["review"]);
  });

  it("validates and imports cleanly, its team and all", () => {
    const handle = openMigratedTestDb();
    try {
      const parsed = parseExport(readFileSync(join(GALLERY_DIRECTORY, `${SOFTWARE}.json`), "utf8"));
      if (!parsed.ok) throw new Error(parsed.reason);
      const imported = importPipeline(handle.db, { document: parsed.document, signedInBackends: ["claude", "codex"] });
      if (!imported.ok) throw new Error(imported.reason);
      const review = imported.stepIds["review"]!;
      const pipelineId = getStep(handle.db, review)!.pipelineId;
      const steps = listStepsForPipeline(handle.db, pipelineId);
      expect(steps.find((step) => step.id === review)?.team).toEqual(TEAM);
      const problems = storedGraphProblems(handle.db, pipelineId, steps, listRoutesForPipeline(handle.db, pipelineId), getPipeline(handle.db, pipelineId)!.entryStepId);
      expect(problems.filter((problem) => problem.severity === "error")).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("has the leader assign four focused passes on every review, the rules pass skipped with a line where there are no rules", () => {
    const leader = flat(TEAM.leader.instructions);
    expect(leader).toContain("Assign these four on every review, each required");
    expect(leader).toContain("1. `criteria`: acceptance criteria and correctness.");
    expect(leader).toContain("2. `impact`: impact and side effects.");
    expect(leader).toContain("callers, implementations and dependents, the contracts it is part of, data and schema changes, configuration, and the behaviour of paths the diff did not touch");
    expect(leader).toContain("3. `tests`: whether each test tests what it claims, and whether the new behaviour and its edge cases are covered.");
    expect(leader).toContain("4. `rules`: the repository's own written rules.");
    expect(leader).toContain("CLAUDE.md, AGENTS.md, CONTRIBUTING and files like them");
    expect(leader).toContain("Every rule this pass checks comes from those files");
    expect(leader).toContain('When the repository has none, do not assign it, and say so in one line in your note and in your final answer\'s limitations: "Rules pass skipped: the repository has no written rules."');
    expect(leader).toContain("Keep every assignment focused and bounded");
    expect(leader).toContain("with the file, the case and what correct would look like");
  });

  it("has the leader add a security and a user-facing pass when the change calls for them, and say why it did or did not", () => {
    const leader = flat(TEAM.leader.instructions);
    expect(leader).toContain("`security`, when it touches authentication, permissions, input handling, secrets, network or file-system access, or adds or changes a dependency.");
    expect(leader).toContain("`user_facing`, when it touches a UI, CLI output, error messages, a public API or docs.");
    expect(leader).toContain("say for each of these two why you did or did not assign it, naming what in the change decided it");
    // No pass of possible improvements: suggestions stay in feedback.
    expect(leader).not.toMatch(/improvements/i);
    expect(leader).toContain("Suggestions that do not block go in `feedback`.");
  });

  it("has the leader answer with the ordinary review verdict, built from the accepted reports", () => {
    const leader = flat(TEAM.leader.instructions);
    expect(leader).toContain("`blocking_issues` carries every one of them, from every report, merged and de-duplicated");
    expect(leader).toContain("`criteria_coverage` has an entry for every criterion the story lists");
    expect(leader).toContain("`needs_user_input` when a report shows something only a person can decide. `feedback` says what must be decided");
    expect(leader).toContain("`approve` when no report shows a blocking issue, with `pull_request_body`");
    expect(leader).toContain("Name every report you relied on.");
  });

  it("tells a person choosing the template that Review runs several reviewers, and so several runs", () => {
    expect(bundled.template!.description).toContain("Review runs as a team");
    expect(bundled.template!.description).toContain("several agent runs");
  });

  it("names nothing of EO's own, in the team or the template's reviewer prompt", () => {
    // The list is not a list of nothing: it catches what the reviewer prompt said before.
    expect(eoOnlyIn("Over EO's own 136 rejections … recomputed from `run_events` … `scripts/review-census.mts`")).not.toEqual([]);
    expect(eoOnlyIn(JSON.stringify(TEAM))).toEqual([]);
    const prompt = bundled.roles.find((role) => role.slug === "reviewer")!.prompt;
    expect(prompt).not.toBeNull();
    expect(prompt).toBe(loadRolePrompt("reviewer"));
    expect(eoOnlyIn(prompt ?? "")).toEqual([]);
  });
});

describe("the template's reviewer prompt on a team (EO-868)", () => {
  const prompt = () => flat(loadRolePrompt("reviewer")!);

  it("says what a member does: stays in its focus, reports each finding with the file, the case and what correct looks like, and leaves the verdict to the leader", () => {
    expect(prompt()).toContain("**On an assignment**, stay within its focus.");
    expect(prompt()).toContain("Report each finding with the file, the case and what correct would look like, and say whether it blocks");
    expect(prompt()).toContain("The verdict is not yours: answer with your report, and the leader gives the step its one verdict.");
  });

  it("says what the leader does: assigns as the team's instructions say, then builds one verdict from the accepted reports", () => {
    expect(prompt()).toContain("**When you lead**, assign the passes your team's instructions list, as they say.");
    expect(prompt()).toContain("build one verdict from the accepted reports");
    expect(prompt()).toContain("merged and de-duplicated into one `blocking_issues` list, and a `criteria_coverage` entry for every criterion the story lists");
    expect(prompt()).toContain("Name the reports you relied on.");
  });

  it("keeps the single reviewer's guidance for a step with no team, and is a new version", () => {
    expect(prompt()).toContain("When they say nothing of a team, you are the only reviewer and everything above is your whole job.");
    expect(prompt()).toContain("**Report every blocking issue you found, in one verdict.**");
    expect(prompt()).toContain("**A rejection has to say what became of every acceptance criterion.**");
    expect(Number(/prompt-version:\s*(\d+)/.exec(loadRolePrompt("reviewer")!)![1])).toBeGreaterThanOrEqual(17);
  });
});

/**
 * An installation already on the template (EO-868): Delivery on 1.4, as
 * one is that last launched before 1.5 shipped. 1.5 reaches it as any
 * template update does.
 */
describe("an installation on 1.4, when 1.5 ships", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
    const onFourteen = templateHistoryUpTo(GALLERY_DIRECTORY, SOFTWARE, "1.4");
    // Adopted first, so the board 1.4 adds is made on the same project (EO-763).
    backfillPipelineOrigins(handle.db, onFourteen);
    adoptPipeline(handle.db, "default", createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid);
    applyTemplateUpdates(handle.db, onFourteen, { isTheRecord: false });
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");
  });

  afterEach(() => handle.close());

  const review = () => listStepsForPipeline(handle.db, "default").find((step) => step.id === "review")!;

  /** The person configures Review, through the repository every save goes through. */
  function personEdits(change: Partial<{ team: StepTeam; instructionsSummary: string }>): void {
    const steps = listStepsForPipeline(handle.db, "default").map((step) => (step.id === "review" ? { ...step, ...change } : step));
    replacePipelineGraph(handle.db, "default", steps, listRoutesForPipeline(handle.db, "default"));
  }

  it("is compared as a change to Review's team alone, and applied where the person left Review as it was", () => {
    expect(review().team).toBeNull();
    const routesBefore = listRoutesForPipeline(handle.db, "default");

    expect(compareWithTemplate(handle.db, "default", versionOf("1.5"))!.merge.comparison.changes).toEqual([
      expect.objectContaining({ key: { kind: "setting", stepId: "review", field: "team" }, outcome: "template", base: null, current: null, template: TEAM }),
    ]);

    expect(applyTemplateUpdates(handle.db, shipped, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.4", to: "1.5" }));
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    expect(review().team).toEqual(TEAM);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.5");
    expect(listRoutesForPipeline(handle.db, "default").map(({ fromStepId, resultKey, label, target }) => ({ fromStepId, resultKey, label, target }))).toEqual(
      routesBefore.map(({ fromStepId, resultKey, label, target }) => ({ fromStepId, resultKey, label, target })),
    );
  });

  it("is held as a conflict where the person gave Review a team of their own, and leaves theirs", () => {
    const theirs = StepTeamSchema.parse({ coordination: "leader", members: "isolated", leader: { role: "reviewer", instructions: "Review it by risk." }, roles: ["reviewer"] });
    personEdits({ team: theirs });

    expect(applyTemplateUpdates(handle.db, shipped, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "conflict", from: "1.4", to: "1.5" }));
    expect(review().team).toEqual(theirs);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");
    expect(openUpdateConflict(handle.db, "default")?.conflicts).toEqual([
      expect.objectContaining({ key: { kind: "setting", stepId: "review", field: "team" }, current: theirs, template: TEAM }),
    ]);
  });

  it("keeps an edit the person made to another of Review's settings, and adds the team beside it", () => {
    personEdits({ instructionsSummary: "Our own words for Review." });

    expect(applyTemplateUpdates(handle.db, shipped, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", to: "1.5" }));
    expect(review().instructionsSummary).toBe("Our own words for Review.");
    expect(review().team).toEqual(TEAM);
  });
});
