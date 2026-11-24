import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { documentStepTeam, ExportedTeamSchema, SkillDraftSchema, FOLDER_KIND, GIT_WORKTREE_KIND, StepTeamSchema, type ExportedTeam, type LeaderTeam, type StepTeam, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { adoptPipeline, getPipeline, getPipelineOrigin, getStep, listStepsForPipeline, openUpdateConflict, replacePipelineGraph, listRoutesForPipeline } from "../db/repos/index.js";
import { addWorkspaceToProject, createProject } from "../db/repos/projectsRepo.js";
import { createWorkspace } from "../db/repos/workspacesRepo.js";
import { agentOfKind, openMigratedTestDb } from "../db/testHelpers.js";
import { agentToolSurfaces, changeTeam, exportedTeamOf, getTeam, sameExportedTeam, setTeamLocked, setTeamMemberSettings } from "../db/repos/teamsRepo.js";
import { saveCliTool, setAgentCliTool } from "../db/repos/cliToolsRepo.js";
import { saveSkill, setAgentAttachment } from "../db/repos/index.js";
import { getAgent } from "../db/repos/agentsRepo.js";
import { savePipeline, storedGraphProblems } from "../ipc/configCommands.js";
import { importPipeline, parseExport } from "../modules/pipelineTransfer.js";
import { loadRolePrompt } from "../roles/prompts.js";
import type { WorkspaceKind } from "../supervisor/workspaceKind.js";
import { useWorkspaceKinds } from "../workspaceKinds.js";
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
/** Review's team as the bundled version ships it (EO-885, 1.8): a declared team, a lead reviewer and one reviewer per pass. */
const TEAM = reviewOf(bundled).team as Extract<ExportedTeam, { coordination: "leader" }>;
/** Review's team as 1.7 shipped it, staffed by role (EO-888). */
const TEAM_17 = reviewOf(versionOf("1.7").document).team as LeaderTeam;
/** Review's team as 1.5 shipped it, before its outcomes ruled anything out (EO-873). */
const TEAM_15 = reviewOf(versionOf("1.5").document).team as LeaderTeam;
/** Review's team as 1.6 shipped it, before its lead said what each pass covers (EO-888). */
const TEAM_16 = reviewOf(versionOf("1.6").document).team as LeaderTeam;

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
  // EO itself, by name: the platform is "the platform" here, as it is to
  // any repository under review.
  /\bEO\b/,
  // A tool id spelled in one backend's punctuation, or one of the tools
  // EO serves by its own name. The prompt names what the tool does.
  /\bmcp__/,
  /\b(eo|eo_admin|repo)\/[a-z]/,
  /\b(comment|attachment|memory|skill)_(search|read|note|add|view|create|patch)\b/,
  "item_detail",
  "ticket_detail",
];
const eoOnlyIn = (text: string): string[] => EO_ONLY.filter((term) => (typeof term === "string" ? text.includes(term) : term.test(text))).map(String);

describe("the software template's Review team (EO-868)", () => {
  it("is a declared, leader-led team in isolated mode, led by a reviewer, whose members are a reviewer per pass, within the declared limits (EO-885)", () => {
    expect(ExportedTeamSchema.parse(TEAM)).toEqual(TEAM);
    expect(TEAM).toMatchObject({ coordination: "leader", memberMode: "isolated", leader: { name: "Lead reviewer", kind: "reviewer" }, memberCap: 6 });
    // The lead is the template's own reviewer: its instructions are the reviewer's prompt.
    expect(TEAM.leader.instructions).toBe(bundled.roles.find((role) => role.slug === "reviewer")!.prompt);
    expect(TEAM.members.map((member) => [member.name, member.kind])).toEqual([
      ["Criteria reviewer", "reviewer"],
      ["Impact reviewer", "reviewer"],
      ["Tests reviewer", "reviewer"],
      ["Rules reviewer", "reviewer"],
      ["Security reviewer", "reviewer"],
      ["User-facing reviewer", "reviewer"],
    ]);
    // Each with instructions of its own, none of them the single reviewer's.
    expect(new Set(TEAM.members.map((member) => member.instructions)).size).toBe(6);
    for (const member of TEAM.members) expect(member.instructions, member.name).not.toContain("prompt-version");
    // As a step reads it, by kind: led by a reviewer, assigning reviewers alone.
    expect(documentStepTeam(TEAM)).toMatchObject({ coordination: "leader", members: "isolated", leader: { role: "reviewer" }, roles: ["reviewer"] });
    expect(TEAM.limits).toEqual({ maxParticipants: 8, maxParallel: 4, maxRounds: 2, maxRetries: 1 });
    // Review is still the reviewer's review.
    expect(reviewOf(bundled)).toMatchObject({ type: "agent", ownerRole: "reviewer", entryAction: "review" });
  });

  it("is a new version that adds no role and no agent, and leaves every route and label as 1.4 had them", () => {
    const before = versionOf("1.4").document;
    expect(versionOf("1.5").document.template!.version).toBe("1.5");
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

  it("rules out an approval where a pass reports a blocking issue or something only a person can decide, and nothing where it reports none (EO-873)", () => {
    expect(bundled.template!.version).toBe("1.8");
    expect(TEAM.outcomes.map((outcome) => [outcome.key, outcome.rulesOut])).toEqual([
      ["clear", undefined],
      ["blocking", ["approved"]],
      ["needs_decision", ["approved"]],
    ]);
    expect({ ...TEAM_16, outcomes: TEAM_16.outcomes.map(({ rulesOut: _rulesOut, ...outcome }) => outcome) }).toEqual(TEAM_15);
    expect(TEAM.outcomes).toEqual(TEAM_16.outcomes);
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
      expect(steps.find((step) => step.id === review)?.team).toEqual(documentStepTeam(TEAM));
      // The declared team itself, as the document carried it (EO-885).
      expect(sameExportedTeam(exportedTeamOf(handle.db, steps.find((step) => step.id === review)!.teamId), TEAM)).toBe(true);
      const problems = storedGraphProblems(handle.db, pipelineId, steps, listRoutesForPipeline(handle.db, pipelineId), getPipeline(handle.db, pipelineId)!.entryStepId);
      expect(problems.filter((problem) => problem.severity === "error")).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("1.7 had the leader assign four focused passes on every review, the rules pass skipped with a line where there are no rules", () => {
    const leader = flat(TEAM_17.leader.instructions);
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

  /**
   * A member reads what its assignment covers (EO-888), so the leader is
   * told to say what each covers, and which part of the change that is:
   * the criteria pass alone is given the whole of it.
   */
  it("1.7 had the leader say what each pass covers, giving the whole change to the criteria pass alone (EO-888)", () => {
    const leader = flat(TEAM_17.leader.instructions);
    expect(leader).toContain("Every assignment says what it covers: the files, areas or questions it is about, by name.");
    expect(leader).toContain("A member reads what its assignment covers and what that leads to, not the whole change");
    expect(leader).toContain("Only `criteria` covers the whole change.");
    const passes = TEAM_17.leader.instructions.split("\n").filter((line) => /^(\d+\. `\w+`:|- `\w+`, when )/.test(line));
    const covering = Object.fromEntries(passes.map((line) => [/`(\w+)`/.exec(line)![1]!, line.slice(line.indexOf("It covers"))]));
    expect(Object.keys(covering)).toEqual(["criteria", "impact", "tests", "rules", "security", "user_facing"]);
    expect(covering["criteria"]).toContain("It covers the whole change");
    expect(covering["impact"]).toContain("It covers the symbols, schemas and configuration the change alters, named, and what depends on them, not the rest of the diff.");
    expect(covering["tests"]).toContain("It covers the test files the change adds or alters and the code they test, both named.");
    expect(covering["rules"]).toContain("It covers those files and the parts of the change they govern, named.");
    expect(covering["security"]).toContain("It covers the files that do, named, and what their input reaches.");
    expect(covering["user_facing"]).toContain("It covers the files that do, named.");
    for (const key of ["impact", "tests", "rules", "security", "user_facing"]) expect(covering[key], key).not.toContain("whole");
    expect(leader).toContain("and to say what it did not read");
  });

  /**
   * 1.8 (EO-885): each pass is its own member, and the lead assigns each
   * to that member by name, saying what it covers; the member's own
   * instructions say how to do the pass.
   */
  it("has the leader assign each pass to its own member by name, saying what each covers, the whole change to the criteria pass alone (EO-885)", () => {
    const leader = flat(TEAM.leader.teamInstructions);
    expect(leader).toContain("Assign these four on every review, each required");
    expect(leader).toContain("Assign each pass to its member, by name, with the pass as the assignment's key, and never give a pass to another pass's member.");
    expect(leader).toContain("Every assignment says what it covers: the files, areas or questions it is about, by name.");
    expect(leader).toContain("Only `criteria` covers the whole change.");
    expect(leader).toContain('When the repository has none, do not assign it, and say so in one line in your note and in your final answer\'s limitations: "Rules pass skipped: the repository has no written rules."');
    const passes = TEAM.leader.teamInstructions.split("\n").filter((line) => /^(\d+\. `\w+`, to |- `\w+`, to )/.test(line));
    const assigned = passes.map((line) => /`(\w+)`, to ([A-Za-z-]+ reviewer)/.exec(line)!.slice(1, 3));
    expect(assigned).toEqual([
      ["criteria", "Criteria reviewer"],
      ["impact", "Impact reviewer"],
      ["tests", "Tests reviewer"],
      ["rules", "Rules reviewer"],
      ["security", "Security reviewer"],
      ["user_facing", "User-facing reviewer"],
    ]);
    // Every member it names is a member of the team.
    for (const [, name] of assigned) expect(TEAM.members.map((member) => member.name)).toContain(name);
    for (const line of passes) expect(line, line).toContain("It covers");
    expect(passes.filter((line) => line.includes("the whole change")).map((line) => /`(\w+)`/.exec(line)![1])).toEqual(["criteria"]);
    expect(TEAM.leader.teamInstructions.length).toBeLessThanOrEqual(4000);
  });

  it("gives each member instructions for its pass alone: what to read, what a finding is, and how to report it (EO-885)", () => {
    const member = (name: string) => flat(TEAM.members.find((one) => one.name === name)!.instructions);
    expect(member("Criteria reviewer")).toContain("Check the change against each acceptance criterion the story lists, one at a time");
    expect(member("Criteria reviewer")).toContain("You cover the whole change");
    expect(member("Impact reviewer")).toContain("its callers, its implementations and dependents, the contracts it is part of");
    expect(member("Tests reviewer")).toContain("Check whether each test the change adds or alters tests what it claims");
    expect(member("Rules reviewer")).toContain("Every rule you check comes from those files");
    expect(member("Security reviewer")).toContain("authentication, permissions, input handling, secrets, network or file-system access");
    expect(member("User-facing reviewer")).toContain("a UI, CLI output, error messages, a public API or documentation");
    for (const { name, instructions } of TEAM.members) {
      const said = flat(instructions);
      if (name !== "Criteria reviewer") expect(said, name).not.toContain("whole change, so read all");
      expect(said, name).toContain("Read what it names and what that leads to, not the whole change");
      expect(said, name).toContain("Report every finding that blocks with the file, the case and what correct would look like");
      expect(said, name).toContain("say what you did not read");
      expect(said, name).toContain("`clear`");
      expect(said, name).toContain("`blocking`");
      expect(said, name).toContain("`needs_decision`");
    }
  });

  it("has the leader add a security and a user-facing pass when the change calls for them, and say why it did or did not", () => {
    const leader = flat(TEAM.leader.teamInstructions);
    expect(leader).toContain("`security`, to Security reviewer, when it touches authentication, permissions, input handling, secrets, network or file-system access, or adds or changes a dependency.");
    expect(leader).toContain("`user_facing`, to User-facing reviewer, when it touches a UI, CLI output, error messages, a public API or docs.");
    expect(leader).toContain("say for each of these two why you did or did not assign it, naming what in the change decided it");
    // No pass of possible improvements: suggestions stay in feedback.
    expect(leader).not.toMatch(/improvements/i);
    expect(leader).toContain("Suggestions that do not block go in `feedback`.");
  });

  it("has the leader answer with the ordinary review verdict, built from the accepted reports", () => {
    const leader = flat(TEAM.leader.teamInstructions);
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
    // Nor what it said after that: EO by name, and a tool id in Claude's punctuation, Codex's, or bare.
    for (const said of ["EO does not dispatch a review", "an MCP server EO registers as", "reachable with `mcp__eo__comment_search`", "`eo/comment_search`", "`comment_search`"]) {
      expect(eoOnlyIn(said), said).not.toEqual([]);
    }
    expect(eoOnlyIn(JSON.stringify(TEAM))).toEqual([]);
    for (const part of [TEAM.leader, ...TEAM.members]) expect(eoOnlyIn(part.instructions), part.name).toEqual([]);
    expect(eoOnlyIn(TEAM.leader.teamInstructions)).toEqual([]);
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
    expect(Number(/prompt-version:\s*(\d+)/.exec(loadRolePrompt("reviewer")!)![1])).toBeGreaterThanOrEqual(18);
  });
});

/**
 * An installation already on the template (EO-868): Delivery on 1.4, as
 * one is that last launched before 1.5 shipped. 1.5 reaches it as any
 * template update does.
 */
describe("an installation on 1.4, when 1.5 ships", () => {
  let handle: DbHandle;
  let shop: Uuid;
  let drive: string;
  const upToFifteen = templateHistoryUpTo(GALLERY_DIRECTORY, SOFTWARE, "1.5");

  beforeEach(() => {
    handle = openMigratedTestDb();
    drive = mkdtempSync(join(tmpdir(), "eo-template-team-"));
    const onFourteen = templateHistoryUpTo(GALLERY_DIRECTORY, SOFTWARE, "1.4");
    // Adopted first, so the board 1.4 adds is made on the same project (EO-763).
    backfillPipelineOrigins(handle.db, onFourteen);
    shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid;
    adoptPipeline(handle.db, "default", shop);
    applyTemplateUpdates(handle.db, onFourteen, { isTheRecord: false });
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");
  });

  afterEach(() => {
    useWorkspaceKinds(new Map());
    handle.close();
    rmSync(drive, { recursive: true, force: true });
  });

  /** A workspace of `kind` on Shop: a Git repository, or a folder on this machine. */
  function shopWorks(kind: typeof GIT_WORKTREE_KIND | typeof FOLDER_KIND): void {
    const workspace =
      kind === FOLDER_KIND ? createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: drive } }) : createWorkspace(handle.db, { config: { name: "shop", repoPath: join(drive, "shop.git") } });
    addWorkspaceToProject(handle.db, shop, workspace.id as Uuid);
  }

  /** The git kind installed, as the developer pack installs it: one that makes each member a copy. */
  function gitInstalled(): void {
    useWorkspaceKinds(new Map([[GIT_WORKTREE_KIND, { slug: GIT_WORKTREE_KIND, evidence: { copy: {} } } as unknown as WorkspaceKind]]));
  }

  const review = () => listStepsForPipeline(handle.db, "default").find((step) => step.id === "review")!;

  /** The person configures Review, through the repository every save goes through. */
  function personEdits(change: Partial<{ team: StepTeam; instructionsSummary: string }>): void {
    // A team given inline is declared from it (EO-881): the step's own team id is left out, which would otherwise name the team.
    const steps = listStepsForPipeline(handle.db, "default").map(({ teamId, ...step }) =>
      step.id === "review" ? { ...step, ...change, ...(change.team === undefined ? { teamId } : {}) } : { ...step, teamId },
    );
    replacePipelineGraph(handle.db, "default", steps, listRoutesForPipeline(handle.db, "default"));
  }

  it("is compared as a change to Review's team alone, and applied where the person left Review as it was", () => {
    expect(review().team).toBeNull();
    const routesBefore = listRoutesForPipeline(handle.db, "default");

    expect(compareWithTemplate(handle.db, "default", versionOf("1.5"))!.merge.comparison.changes).toEqual([
      expect.objectContaining({ key: { kind: "setting", stepId: "review", field: "team" }, outcome: "template", base: null, current: null, template: TEAM_15 }),
    ]);

    expect(applyTemplateUpdates(handle.db, upToFifteen, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.4", to: "1.5" }));
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    expect(review().team).toEqual(TEAM_15);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.5");
    expect(listRoutesForPipeline(handle.db, "default").map(({ fromStepId, resultKey, label, target }) => ({ fromStepId, resultKey, label, target }))).toEqual(
      routesBefore.map(({ fromStepId, resultKey, label, target }) => ({ fromStepId, resultKey, label, target })),
    );
  });

  it("is held as a conflict where the person gave Review a team of their own, and leaves theirs", () => {
    const theirs = StepTeamSchema.parse({ coordination: "leader", members: "isolated", leader: { role: "reviewer", instructions: "Review it by risk." }, roles: ["reviewer"] });
    personEdits({ team: theirs });

    expect(applyTemplateUpdates(handle.db, upToFifteen, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "conflict", from: "1.4", to: "1.5" }));
    expect(review().team).toEqual(theirs);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");
    expect(openUpdateConflict(handle.db, "default")?.conflicts).toEqual([
      expect.objectContaining({ key: { kind: "setting", stepId: "review", field: "team" }, current: theirs, template: TEAM_15 }),
    ]);
  });

  it("is applied for a project with a Git and a folder workspace, its origin moving to 1.5, and Publish warns of the folder rather than refusing (EO-871)", () => {
    gitInstalled();
    shopWorks(GIT_WORKTREE_KIND);
    shopWorks(FOLDER_KIND);

    expect(applyTemplateUpdates(handle.db, upToFifteen, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.4", to: "1.5" }));
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    expect(review().team).toEqual(TEAM_15);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.5");

    const problems = storedGraphProblems(handle.db, "default", listStepsForPipeline(handle.db, "default"), listRoutesForPipeline(handle.db, "default"), getPipeline(handle.db, "default")!.entryStepId);
    expect(problems.filter((problem) => problem.severity === "error")).toEqual([]);
    const warned = problems.filter((problem) => problem.severity === "warning" && problem.message.includes("has isolated members"));
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toContain('"folder"');
    expect(warned[0]!.message).not.toContain('"git-worktree"');
    // And Publish saves it, warning and all.
    const steps = listStepsForPipeline(handle.db, "default");
    const published = savePipeline(handle.db, { notifyStateChange: () => {} }, { pipelineId: "default", steps: steps.map((step) => ({ ...step })), routes: listRoutesForPipeline(handle.db, "default"), entryStepId: getPipeline(handle.db, "default")!.entryStepId });
    expect(published.saved).toBe(true);
  });

  it("is applied for a project whose only workspace is a folder, its origin moving to 1.5, though Publish refuses the team there (EO-871)", () => {
    shopWorks(FOLDER_KIND);

    expect(applyTemplateUpdates(handle.db, upToFifteen, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.4", to: "1.5" }));
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    expect(review().team).toEqual(TEAM_15);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.5");
    // A person publishing the board is still told the team cannot run anywhere it works.
    const problems = storedGraphProblems(handle.db, "default", listStepsForPipeline(handle.db, "default"), listRoutesForPipeline(handle.db, "default"), getPipeline(handle.db, "default")!.entryStepId);
    expect(problems.filter((problem) => problem.severity === "error").map((problem) => problem.message)).toEqual([expect.stringContaining('"folder" workspace, which cannot give each member a copy of its own')]);
  });

  it("keeps an edit the person made to another of Review's settings, and adds the team beside it", () => {
    personEdits({ instructionsSummary: "Our own words for Review." });

    expect(applyTemplateUpdates(handle.db, upToFifteen, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", to: "1.5" }));
    expect(review().instructionsSummary).toBe("Our own words for Review.");
    expect(review().team).toEqual(TEAM_15);
  });
});

/**
 * An installation on 1.5 (EO-873): 1.6 reaches it as any template update
 * does, and is held where the person changed Review's team.
 */
describe("an installation on 1.5, when 1.6 ships", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
    const onFifteen = templateHistoryUpTo(GALLERY_DIRECTORY, SOFTWARE, "1.5");
    backfillPipelineOrigins(handle.db, onFifteen);
    adoptPipeline(handle.db, "default", createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid);
    applyTemplateUpdates(handle.db, onFifteen, { isTheRecord: false });
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.5");
  });

  afterEach(() => handle.close());

  const review = () => listStepsForPipeline(handle.db, "default").find((step) => step.id === "review")!;

  it("is compared as a change to Review's team alone, and applied where the person left Review as it was", () => {
    expect(review().team).toEqual(TEAM_15);
    expect(compareWithTemplate(handle.db, "default", versionOf("1.6"))!.merge.comparison.changes).toEqual([
      expect.objectContaining({ key: { kind: "setting", stepId: "review", field: "team" }, outcome: "template", base: TEAM_15, current: TEAM_15, template: TEAM_16 }),
    ]);
    expect(applyTemplateUpdates(handle.db, templateHistoryUpTo(GALLERY_DIRECTORY, SOFTWARE, "1.6"), { isTheRecord: false })).toContainEqual(
      expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.5", to: "1.6" }),
    );
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    expect(review().team).toEqual(TEAM_16);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.6");
  });
});

/**
 * An installation on 1.6 (EO-888): 1.7, whose lead says what each pass
 * covers, reaches it as any template update does, and is held where the
 * person changed Review's team.
 */
describe("an installation on 1.6, when 1.7 ships", () => {
  let handle: DbHandle;
  const upToSeventeen = templateHistoryUpTo(GALLERY_DIRECTORY, SOFTWARE, "1.7");

  beforeEach(() => {
    handle = openMigratedTestDb();
    const onSixteen = templateHistoryUpTo(GALLERY_DIRECTORY, SOFTWARE, "1.6");
    backfillPipelineOrigins(handle.db, onSixteen);
    adoptPipeline(handle.db, "default", createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid);
    applyTemplateUpdates(handle.db, onSixteen, { isTheRecord: false });
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.6");
  });

  afterEach(() => handle.close());

  const review = () => listStepsForPipeline(handle.db, "default").find((step) => step.id === "review")!;

  it("is compared as a change to Review's team alone, and applied where the person left Review as it was", () => {
    expect(review().team).toEqual(TEAM_16);
    expect(compareWithTemplate(handle.db, "default", versionOf("1.7"))!.merge.comparison.changes).toEqual([
      expect.objectContaining({ key: { kind: "setting", stepId: "review", field: "team" }, outcome: "template", base: TEAM_16, current: TEAM_16, template: TEAM_17 }),
    ]);
    expect(applyTemplateUpdates(handle.db, upToSeventeen, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.6", to: "1.7" }));
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    expect(review().team).toEqual(TEAM_17);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.7");
  });

  it("is held as a conflict where the person changed Review's team, and leaves theirs", () => {
    const theirs = { ...TEAM_16, leader: { ...TEAM_16.leader, instructions: "Review it by risk." } };
    const steps = listStepsForPipeline(handle.db, "default").map(({ teamId, ...step }) => (step.id === "review" ? { ...step, team: theirs } : { ...step, teamId }));
    replacePipelineGraph(handle.db, "default", steps, listRoutesForPipeline(handle.db, "default"));

    expect(applyTemplateUpdates(handle.db, upToSeventeen, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "conflict", from: "1.6", to: "1.7" }));
    expect(review().team).toEqual(theirs);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.6");
  });
});

/**
 * An installation on 1.7 (EO-885): 1.8, whose Review is a declared team of
 * a reviewer per pass, reaches it as any template update does. The team
 * the step already runs as becomes the template's, as a new version of it,
 * where the person left it as 1.7 had it; the update is held where they
 * changed it, or locked it.
 */
describe("an installation on 1.7, when 1.8 ships", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
    const onSeventeen = templateHistoryUpTo(GALLERY_DIRECTORY, SOFTWARE, "1.7");
    backfillPipelineOrigins(handle.db, onSeventeen);
    adoptPipeline(handle.db, "default", createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid);
    applyTemplateUpdates(handle.db, onSeventeen, { isTheRecord: false });
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.7");
  });

  afterEach(() => handle.close());

  const review = () => listStepsForPipeline(handle.db, "default").find((step) => step.id === "review")!;

  it("is compared as a change to Review's team alone, and applied where the person left it, as a new version of the team the step runs as", () => {
    expect(review().team).toEqual(TEAM_17);
    const teamId = review().teamId!;
    const versionBefore = getTeam(handle.db, teamId)!.version;
    const nameBefore = getTeam(handle.db, teamId)!.name;
    expect(compareWithTemplate(handle.db, "default", versionOf("1.8"))!.merge.comparison.changes).toEqual([
      expect.objectContaining({ key: { kind: "setting", stepId: "review", field: "team" }, outcome: "template", base: TEAM_17, current: TEAM_17, template: TEAM }),
    ]);

    expect(applyTemplateUpdates(handle.db, shipped, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.7", to: "1.8" }));
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.8");
    // The same team, changed: a new version by EO, under the name it had here.
    expect(review().teamId).toBe(teamId);
    const team = getTeam(handle.db, teamId)!;
    expect(team.version).toBe(versionBefore + 1);
    expect(team.name).toBe(nameBefore);
    expect(sameExportedTeam(exportedTeamOf(handle.db, teamId), TEAM)).toBe(true);
    // Every member the team's own, a reviewer with its pass's instructions.
    const definition = team.definition!;
    if (definition.coordination !== "leader") throw new Error("not leader-led");
    const members = definition.members.map((member) => getAgent(handle.db, member.agentId as Uuid)!);
    expect(members.map((agent) => [agent.name, agent.role, agent.teamId])).toEqual(TEAM.members.map((member) => [member.name, "reviewer", teamId]));
    expect(members.map((agent) => agent.instructions)).toEqual(TEAM.members.map((member) => member.instructions));
    expect(review().team).toEqual(documentStepTeam(TEAM));
  });

  it("is held as a conflict where the person changed Review's team, and leaves theirs", () => {
    const theirs = { ...TEAM_17, leader: { ...TEAM_17.leader, instructions: "Review it by risk." } };
    const steps = listStepsForPipeline(handle.db, "default").map(({ teamId, ...step }) => (step.id === "review" ? { ...step, team: theirs } : { ...step, teamId }));
    replacePipelineGraph(handle.db, "default", steps, listRoutesForPipeline(handle.db, "default"));

    expect(applyTemplateUpdates(handle.db, shipped, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "conflict", from: "1.7", to: "1.8" }));
    expect(review().team).toEqual(theirs);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.7");
    expect(openUpdateConflict(handle.db, "default")?.conflicts).toEqual([
      expect.objectContaining({ key: { kind: "setting", stepId: "review", field: "team" }, current: theirs, template: TEAM }),
    ]);
  });

  it("is held, saying so, where a person locked the team, and changes nothing of it", () => {
    const teamId = review().teamId!;
    setTeamLocked(handle.db, teamId, true);
    const before = getTeam(handle.db, teamId)!;

    const results = applyTemplateUpdates(handle.db, shipped, { isTheRecord: false });
    expect(results).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "conflict", from: "1.7", to: "1.8" }));
    expect(openUpdateConflict(handle.db, "default")?.problems).toEqual([expect.stringContaining("is locked, and this version changes it")]);
    expect(getTeam(handle.db, teamId)).toEqual(before);
    expect(review().teamId).toBe(teamId);
  });
});

/**
 * An installation on 1.8 (EO-885): a later version that changes one
 * member's instructions reaches the team as a new version of it, keeping
 * the members whose instructions it did not change — and what a person
 * set them to run on — and is held where the person changed the team.
 */
describe("an installation on 1.8, when a later version changes a member", () => {
  let handle: DbHandle;
  const next = (): ReturnType<typeof loadTemplateHistory> => {
    const document = structuredClone(versionOf("1.8").document);
    document.template!.version = "1.9";
    const review = document.steps.find((step) => step.id === "review")!;
    const team = review.team as typeof TEAM;
    review.team = { ...team, members: team.members.map((member) => (member.name === "Tests reviewer" ? { ...member, instructions: `${member.instructions}\n\nAlso check the test names.` } : member)) };
    const history = new Map(shipped);
    history.set(SOFTWARE, [...shipped.get(SOFTWARE)!, { ...versionOf("1.8"), version: "1.9", notes: "Tests reviewer checks names.", document }]);
    return history;
  };

  beforeEach(() => {
    handle = openMigratedTestDb();
    backfillPipelineOrigins(handle.db, shipped);
    adoptPipeline(handle.db, "default", createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid);
    applyTemplateUpdates(handle.db, shipped, { isTheRecord: false });
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.8");
  });

  afterEach(() => handle.close());

  const review = () => listStepsForPipeline(handle.db, "default").find((step) => step.id === "review")!;
  const membersOf = (teamId: string) => {
    const definition = getTeam(handle.db, teamId)!.definition!;
    return definition.members.map((member) => getAgent(handle.db, member.agentId as Uuid)!);
  };

  it("keeps each member it did not change, with the runtime a person gave it, and gives the changed one a new agent of the team's own", () => {
    const teamId = review().teamId!;
    const before = membersOf(teamId);
    const criteria = before.find((agent) => agent.name === "Criteria reviewer")!;
    expect(setTeamMemberSettings(handle.db, teamId, criteria.id, { provider: "codex", model: null, reasoning: null }, { personId: null }).ok).toBe(true);

    expect(applyTemplateUpdates(handle.db, next(), { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.8", to: "1.9" }));
    expect(review().teamId).toBe(teamId);
    const after = membersOf(teamId);
    expect(after.map((agent) => agent.name)).toEqual(before.map((agent) => agent.name));
    for (const [index, agent] of after.entries()) {
      if (agent.name === "Tests reviewer") {
        expect(agent.id).not.toBe(before[index]!.id);
        expect(agent.instructions).toContain("Also check the test names.");
        expect(agent.teamId).toBe(teamId);
      } else expect(agent.id, agent.name).toBe(before[index]!.id);
    }
    expect(getAgent(handle.db, criteria.id)!.provider).toBe("codex");
  });

  it("is held as a conflict where the person changed the team, and leaves theirs", () => {
    const teamId = review().teamId!;
    const team = getTeam(handle.db, teamId)!;
    const definition = team.definition!;
    if (definition.coordination !== "leader") throw new Error("not leader-led");
    expect(changeTeam(handle.db, teamId, { definition: { ...definition, leader: { ...definition.leader, instructions: "Review it by risk." } }, author: { kind: "assistant" } }).ok).toBe(true);

    expect(applyTemplateUpdates(handle.db, next(), { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "conflict", from: "1.8", to: "1.9" }));
    const leader = getTeam(handle.db, teamId)!.definition!;
    expect(leader.coordination === "leader" ? leader.leader.instructions : "").toBe("Review it by risk.");
    expect(openUpdateConflict(handle.db, "default")?.conflicts).toEqual([expect.objectContaining({ key: { kind: "setting", stepId: "review", field: "team" } })]);
  });

  it("is applied where a person only renamed the team, keeping their name", () => {
    const teamId = review().teamId!;
    const definition = getTeam(handle.db, teamId)!.definition!;
    expect(changeTeam(handle.db, teamId, { definition: { ...definition, name: "Our reviewers" }, author: { kind: "person", personId: null } }).ok).toBe(true);

    expect(applyTemplateUpdates(handle.db, next(), { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.8", to: "1.9" }));
    expect(getTeam(handle.db, teamId)!.name).toBe("Our reviewers");
  });
});

/**
 * A team's tool pool is the installation's (EO-885, the person's decision
 * B): 1.7 → 1.8 keeps the pool Review's team had, so every pass reviewer
 * starts with the tools the person's reviewer had, and a later update
 * neither replaces the pool nor holds on it.
 */
describe("an installation whose reviewer has a CLI tool and a skill, from 1.7 through 1.8 and on", () => {
  let handle: DbHandle;
  let tool: string;
  let skill: string;

  beforeEach(() => {
    handle = openMigratedTestDb();
    const reviewer = agentOfKind(handle.db, "reviewer");
    const saved = saveCliTool(handle.db, { name: "GitHub CLI", command: "gh", description: "Pull requests and issues." });
    if (!saved.ok) throw new Error("the CLI tool was refused");
    expect(setAgentCliTool(handle.db, { agentId: reviewer, cliToolId: saved.cliTool.id, attached: true }).ok).toBe(true);
    const playbook = saveSkill(handle.db, SkillDraftSchema.parse({ name: "Review playbook", description: "How this house reviews.", body: "Read the diff." }));
    if (!playbook.ok) throw new Error(playbook.problems.join("\n"));
    expect(setAgentAttachment(handle.db, { agentId: reviewer, kind: "skill", id: playbook.skill.id, attached: true }).ok).toBe(true);
    tool = saved.cliTool.command;
    skill = playbook.skill.slug;

    const onSeventeen = templateHistoryUpTo(GALLERY_DIRECTORY, SOFTWARE, "1.7");
    backfillPipelineOrigins(handle.db, onSeventeen);
    adoptPipeline(handle.db, "default", createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid);
    applyTemplateUpdates(handle.db, onSeventeen, { isTheRecord: false });
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.7");
  });

  afterEach(() => handle.close());

  const review = () => listStepsForPipeline(handle.db, "default").find((step) => step.id === "review")!;
  const surfacesOf = (teamId: string) => {
    const definition = getTeam(handle.db, teamId)!.definition!;
    if (definition.coordination !== "leader") throw new Error("not leader-led");
    const ids = [definition.leader.agentId, ...definition.members.map((member) => member.agentId)];
    return ids.map((id) => [getAgent(handle.db, id as Uuid)!.name, agentToolSurfaces(handle.db, [id])[id]!] as const);
  };

  it("keeps the team's pool on 1.8, every pass reviewer with the reviewer's tool and skill, and a later update leaves the pool alone without a conflict", () => {
    const teamId = review().teamId!;
    const pool = getTeam(handle.db, teamId)!.definition!.toolPool;
    expect(pool.cliTools).toContain(tool);
    expect(pool.skills).toContain(skill);

    expect(applyTemplateUpdates(handle.db, shipped, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.7", to: "1.8" }));
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    expect(review().teamId).toBe(teamId);
    expect(getTeam(handle.db, teamId)!.definition!.toolPool).toEqual(pool);
    const surfaces = surfacesOf(teamId);
    expect(surfaces.map(([name]) => name)).toEqual(["Lead reviewer", ...TEAM.members.map((member) => member.name)]);
    for (const [name, surface] of surfaces) {
      expect(surface.cliTools, name).toContain(tool);
      expect(surface.skills, name).toContain(skill);
    }

    // A later version changing one member: the pool is not the template's to replace, nor a conflict.
    const document = structuredClone(versionOf("1.8").document);
    document.template!.version = "1.9";
    const step = document.steps.find((each) => each.id === "review")!;
    const team = step.team as typeof TEAM;
    step.team = { ...team, members: team.members.map((member) => (member.name === "Tests reviewer" ? { ...member, instructions: `${member.instructions}\n\nAlso check the test names.` } : member)) };
    const history = new Map(shipped);
    history.set(SOFTWARE, [...shipped.get(SOFTWARE)!, { ...versionOf("1.8"), version: "1.9", notes: "Tests reviewer checks names.", document }]);

    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.8", to: "1.9" }));
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    expect(review().teamId).toBe(teamId);
    expect(getTeam(handle.db, teamId)!.definition!.toolPool).toEqual(pool);
    const tests = surfacesOf(teamId).find(([name]) => name === "Tests reviewer")!;
    expect(getAgent(handle.db, getTeam(handle.db, teamId)!.definition!.members.find((member) => getAgent(handle.db, member.agentId as Uuid)!.name === "Tests reviewer")!.agentId as Uuid)!.instructions).toContain("Also check the test names.");
    expect(tests[1].cliTools).toContain(tool);
    expect(tests[1].skills).toContain(skill);
  });

  it("does not hold a locked team's update where only its pool differs from the template's", () => {
    expect(applyTemplateUpdates(handle.db, shipped, { isTheRecord: false })).toContainEqual(expect.objectContaining({ outcome: "applied", to: "1.8" }));
    const teamId = review().teamId!;
    setTeamLocked(handle.db, teamId, true);
    // The installed pool is the reviewer's, the template's is empty: the same team all the same.
    expect(getTeam(handle.db, teamId)!.definition!.toolPool).not.toEqual(TEAM.toolPool);
    expect(sameExportedTeam(exportedTeamOf(handle.db, teamId), TEAM)).toBe(true);

    const document = structuredClone(versionOf("1.8").document);
    document.template!.version = "1.9";
    const history = new Map(shipped);
    history.set(SOFTWARE, [...shipped.get(SOFTWARE)!, { ...versionOf("1.8"), version: "1.9", notes: "Nothing of the team.", document }]);
    // Nothing to write, but not held: the origin moves on.
    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "caught-up", from: "1.8", to: "1.9" }));
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.9");
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
  });
});
