import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compareTemplateVersions, loadTemplateHistory, readVersion, templateHistoryDirectory, type TemplateVersion } from "./history.js";
import { bundledTemplates } from "./templates.js";

/**
 * Every version of every bundled template ships with the app (EO-531).
 *
 * The loader skips a file it cannot read rather than refusing to start,
 * so these cases are what notice a version EO forgot to ship or shipped
 * damaged: each bundled template is checked against its own history,
 * file by file.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const SOFTWARE = "software-feature-to-merge";

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("the shipped template history", () => {
  it("has every bundled template, with its gallery version as the newest", () => {
    const history = loadTemplateHistory(GALLERY_DIRECTORY);
    const templates = bundledTemplates(GALLERY_DIRECTORY);
    expect(templates.length).toBeGreaterThan(0);

    for (const template of templates) {
      const versions = history.get(template.slug);
      expect(versions, `no history ships for ${template.slug}`).toBeDefined();
      const newest = versions![versions!.length - 1]!;
      expect(newest.version).toBe(template.version);
      // The card and the newest version are one document, not two that
      // happen to share a number.
      expect(newest.document).toEqual(template.document);
    }
  });

  it("drops no file it was shipped with: every file on disk is a version that loads", () => {
    const history = loadTemplateHistory(GALLERY_DIRECTORY);
    const root = templateHistoryDirectory(GALLERY_DIRECTORY);
    for (const slug of readdirSync(root)) {
      const files = readdirSync(join(root, slug)).filter((name) => name.endsWith(".json"));
      expect(history.get(slug)?.map((version) => `${version.version}.json`).sort()).toEqual(files.sort());
    }
  });

  it("carries release notes on every version, and lists them oldest first", () => {
    for (const [slug, versions] of loadTemplateHistory(GALLERY_DIRECTORY)) {
      for (const version of versions) {
        expect(version.slug).toBe(slug);
        expect(version.notes.trim().length, `${slug} ${version.version} has no release notes`).toBeGreaterThan(10);
      }
      const order = versions.map((version) => version.version);
      expect(order).toEqual([...order].sort(compareTemplateVersions));
    }
  });
});

describe("Software feature to merge", () => {
  const versions = () => loadTemplateHistory(GALLERY_DIRECTORY).get(SOFTWARE)!;

  it("has the graph from before EO-461, the one that gave up after a week, and the current one", () => {
    expect(versions().map((version) => version.version)).toEqual(["1.0", "1.1", "1.2", "1.3", "1.4"]);
  });

  it("1.0 opens the pull request and waits at Done, with no step watching it", () => {
    const before = versions()[0]!.document;
    expect(before.steps.map((step) => step.id)).toEqual(["worktree", "repository_index", "todo", "review", "merge_request", "ready_to_merge"]);
    expect(before.routes.find((route) => route.fromStepId === "merge_request" && route.resultKey === "opened")?.target).toBe("ready_to_merge");
    expect(before.routes.some((route) => route.fromStepId === "pull_request_watch")).toBe(false);
  });

  it("1.1 watches the pull request, and says what that does for the person", () => {
    const current = versions()[1]!;
    expect(current.document.steps.map((step) => step.id)).toContain("pull_request_watch");
    expect(current.document.routes.find((route) => route.fromStepId === "merge_request" && route.resultKey === "opened")?.target).toBe("pull_request_watch");
    expect(current.notes).toContain("CI failures, merge conflicts and review comments send the work back to the implementer");
    expect(current.document.steps.find((step) => step.id === "pull_request_watch")?.watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 168 });
  });

  it("1.2 watches the pull request with no deadline, and says so for the person (EO-571)", () => {
    const current = versions()[2]!;
    expect(current.document.eoPipelineExport).toBeGreaterThanOrEqual(10);
    expect(current.document.steps.find((step) => step.id === "pull_request_watch")?.watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true });
    expect(current.notes).toContain("no longer gives up");
  });

  /**
   * Not the roles' prompts. A template version is compared and applied by
   * its graph (`templateUpdates.ts`); a shipped role's prompt reaches an
   * agent through `syncRolePrompts`, from the build, whatever version its
   * pipeline is on. So the newest file carries the prompts this build
   * ships, as the gallery file it must equal does, and they moved under
   * 1.2 when the memory paragraph left them (EO-593) without the graph
   * changing — a version of its own for that would be two versions with
   * the same steps, which `origins.ts` could not tell apart.
   *
   * Nor the answer schemas the roles carry, for the same reason: an
   * installed pack's role answers with the build's schema whatever a
   * template carries (`adoptCarriedSchemas` skips one the pack ships), so
   * the newest file carries this build's — `memoryUsed` on implement and
   * review since EO-597.
   */
  it("differs between 1.1 and 1.2 only in the watch's deadline", () => {
    const [, before, current] = versions();
    const strip = (document: TemplateVersion["document"]) => ({
      ...document,
      eoPipelineExport: 0,
      template: { ...document.template, version: "" },
      steps: document.steps.map((step) => (step.id === "pull_request_watch" ? { ...step, watch: null } : step)),
      roles: document.roles.map((role) => ({ ...role, prompt: null, schemasByAction: {} })),
    });
    expect(strip(before!.document)).toEqual(strip(current!.document));
  });

  it("differs between 1.2 and 1.3 only in the question the assistant opens first run with (EO-664)", () => {
    const [, , before, current] = versions();
    expect(current!.document.template.openingQuestion).toMatch(/first feature/);
    expect(current!.notes).toContain("chat with the assistant");
    const strip = (document: TemplateVersion["document"]) => ({ ...document, template: { ...document.template, version: "", openingQuestion: undefined } });
    expect(strip(current!.document)).toEqual(strip(before!.document));
  });

  /**
   * 1.4 (EO-763) is the first version with two boards: Delivery replies on
   * the pull request and sends other accounts' comments to the Pull request
   * comments board, where a plan is made, reviewed and approved before any
   * of it reaches the implementer.
   */
  it("1.4 adds the Pull request comments board and the reply step, and says so for the person (EO-763)", () => {
    const current = versions()[4]!;
    const delivery = current.document;
    const board = delivery.boards.find((each) => each.key === "pull_request_comments");
    expect(board?.pipeline.name).toBe("Pull request comments");
    expect(board?.steps.map((step) => [step.id, step.name, step.type, step.ownerRole, step.entryAction])).toEqual([
      ["pr_comments_plan", "Plan response", "agent", "implementer", "plan_comment_response"],
      ["pr_comments_review", "Review plan", "agent", "reviewer", "review_plan"],
      ["pr_comments_approve", "Approve plan", "user", null, null],
    ]);
    expect(board?.steps[2]!.results.map((result) => [result.label, result.requiresComment])).toEqual([
      ["Approve", false],
      ["Revise", true],
      ["Reject", true],
    ]);
    const target = (fromStepId: string, resultKey: string) => [...delivery.routes, ...(board?.routes ?? [])].find((route) => route.fromStepId === fromStepId && route.resultKey === resultKey)?.target;
    expect(target("merge_request", "opened")).toBe("pull_request_reply");
    expect(target("pull_request_reply", "replied")).toBe("pull_request_watch");
    expect(target("pull_request_reply", "nothing_to_reply")).toBe("pull_request_watch");
    expect(target("pull_request_reply", "failed")).toBe("user_attention");
    expect(target("pull_request_watch", "author_commented")).toBe("todo");
    expect(target("pull_request_watch", "changes_requested")).toBe("pr_comments_plan");
    expect(target("pull_request_watch", "others_commented")).toBe("pr_comments_plan");
    expect(target("pr_comments_plan", "planned")).toBe("pr_comments_review");
    expect(target("pr_comments_review", "approved")).toBe("pr_comments_approve");
    expect(target("pr_comments_review", "changes_requested")).toBe("pr_comments_plan");
    expect(target("pr_comments_review", "needs_user_input")).toBe("user_attention");
    expect(target("pr_comments_approve", "approved")).toBe("todo");
    expect(target("pr_comments_approve", "revise")).toBe("pr_comments_plan");
    expect(target("pr_comments_approve", "rejected")).toBe("pull_request_reply");
    expect(current.notes).toContain("Pull request comments board");
    expect(current.notes).toContain("for a plan you approve");
    expect(current.notes).toContain("EO now replies on the pull request");
  });

  it("differs between 1.3 and 1.4 only in the reply step, the comment routes and the new board", () => {
    const [, , , before, current] = versions();
    const changed = new Set(["pull_request_reply", "pull_request_watch:author_commented", "pull_request_watch:others_commented", "pull_request_watch:changes_requested", "merge_request:opened"]);
    const strip = (document: TemplateVersion["document"]) => ({
      ...document,
      template: { ...document.template, version: "" },
      boards: [],
      vocabulary: { ...document.vocabulary, results: document.vocabulary.results.filter((result) => result.key === "approved" || result.key === "send_back") },
      steps: document.steps.filter((step) => !changed.has(step.id)).map((step) => ({ ...step, position: 0 })),
      routes: document.routes.filter((route) => !changed.has(route.fromStepId) && !changed.has(`${route.fromStepId}:${route.resultKey}`)),
    });
    expect(strip(current!.document)).toEqual(strip(before!.document));
  });

  it("differs between 1.0 and 1.1 only in what EO-461 changed", () => {
    const [before, current] = versions();
    const strip = (document: TemplateVersion["document"]) => ({
      ...document,
      template: { ...document.template, version: "" },
      steps: document.steps.filter((step) => step.id !== "pull_request_watch").map((step) => ({ ...step, position: 0 })),
      routes: document.routes.filter((route) => route.fromStepId !== "pull_request_watch" && !(route.fromStepId === "merge_request" && route.resultKey === "opened")),
    });
    expect(strip(before!.document)).toEqual(strip(current!.document));
  });
});

/**
 * A template with no job has no first item of its own, so first run ends
 * in the assistant asking for one (EO-664) — with the template's own
 * question, which arrived as a version of its own.
 */
describe("the templates with no job", () => {
  const withoutJob = () => bundledTemplates(GALLERY_DIRECTORY).filter((template) => !template.document.template!.blanks.some((blank) => blank.kind === "schedule"));

  it("are the three that do not file work on a schedule", () => {
    expect(withoutJob().map((template) => template.slug).sort()).toEqual(["content-draft-and-approve", "inbox-triage", SOFTWARE]);
  });

  it("each ask their own opening question, from a version whose notes say so, changing nothing else", () => {
    const history = loadTemplateHistory(GALLERY_DIRECTORY);
    for (const template of withoutJob()) {
      expect(template.document.template!.openingQuestion, `${template.slug} has no opening question`).toMatch(/\?/);
      const versions = history.get(template.slug)!;
      // The version that brought the question in, which a later one may follow (1.4 of the software template, EO-763).
      const asked = versions.findIndex((version) => version.document.template!.openingQuestion !== undefined);
      const [before, current] = [versions[asked - 1], versions[asked]];
      expect(current!.notes).toContain("chat with the assistant");
      expect(before!.document.template!.openingQuestion).toBeUndefined();
      const strip = (document: TemplateVersion["document"]) => ({ ...document, template: { ...document.template!, version: "", openingQuestion: undefined } });
      expect(strip(current!.document), `${template.slug} changed more than its question`).toEqual(strip(before!.document));
    }
  });
});

describe("reading the history", () => {
  function copyOfHistory(): string {
    const directory = mkdtempSync(join(tmpdir(), "eo-template-history-"));
    scratch.push(directory);
    cpSync(templateHistoryDirectory(GALLERY_DIRECTORY), templateHistoryDirectory(directory), { recursive: true });
    return directory;
  }

  it("is empty, not an error, where nothing shipped", () => {
    const directory = mkdtempSync(join(tmpdir(), "eo-template-history-"));
    scratch.push(directory);
    expect(loadTemplateHistory(directory).size).toBe(0);
  });

  it("skips a damaged file and keeps the versions around it", () => {
    const directory = copyOfHistory();
    writeFileSync(join(templateHistoryDirectory(directory), SOFTWARE, "1.0.json"), "{ not json");
    expect(loadTemplateHistory(directory).get(SOFTWARE)?.map((version) => version.version)).toEqual(["1.1", "1.2", "1.3", "1.4"]);
  });

  it("skips a file whose path disagrees with the version it carries", () => {
    const directory = copyOfHistory();
    const misplaced = join(templateHistoryDirectory(directory), "somebody-else");
    mkdirSync(misplaced);
    cpSync(join(templateHistoryDirectory(directory), SOFTWARE, "1.0.json"), join(misplaced, "1.0.json"));
    cpSync(join(templateHistoryDirectory(directory), SOFTWARE, "1.0.json"), join(templateHistoryDirectory(directory), SOFTWARE, "0.9.json"));

    const history = loadTemplateHistory(directory);
    expect(history.has("somebody-else")).toBe(false);
    expect(history.get(SOFTWARE)?.map((version) => version.version)).toEqual(["1.0", "1.1", "1.2", "1.3", "1.4"]);
  });

  it("refuses a pack that asks for the admin grant, as every other door does", () => {
    const directory = copyOfHistory();
    const path = join(templateHistoryDirectory(directory), "weekly-report", "1.0.json");
    const entry = readVersion(path)!;
    const roles = entry.document.roles.map((role) => ({ ...role, allowedTools: ["mcp__eo_admin__pipeline_publish"] }));
    writeFileSync(path, JSON.stringify({ eoTemplateHistory: 1, notes: entry.notes, pack: { ...entry.document, roles } }));
    expect(readVersion(path)).toBeNull();
  });
});

describe("version order", () => {
  it("reads runs of digits as numbers", () => {
    expect(["1.10", "1.9", "1.0", "2.0"].sort(compareTemplateVersions)).toEqual(["1.0", "1.9", "1.10", "2.0"]);
    expect(compareTemplateVersions("2026-09-01", "2026-10-01")).toBeLessThan(0);
  });
});
