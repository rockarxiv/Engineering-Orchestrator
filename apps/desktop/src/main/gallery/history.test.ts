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
    expect(versions().map((version) => version.version)).toEqual(["1.0", "1.1", "1.2"]);
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
    expect(loadTemplateHistory(directory).get(SOFTWARE)?.map((version) => version.version)).toEqual(["1.1", "1.2"]);
  });

  it("skips a file whose path disagrees with the version it carries", () => {
    const directory = copyOfHistory();
    const misplaced = join(templateHistoryDirectory(directory), "somebody-else");
    mkdirSync(misplaced);
    cpSync(join(templateHistoryDirectory(directory), SOFTWARE, "1.0.json"), join(misplaced, "1.0.json"));
    cpSync(join(templateHistoryDirectory(directory), SOFTWARE, "1.0.json"), join(templateHistoryDirectory(directory), SOFTWARE, "0.9.json"));

    const history = loadTemplateHistory(directory);
    expect(history.has("somebody-else")).toBe(false);
    expect(history.get(SOFTWARE)?.map((version) => version.version)).toEqual(["1.0", "1.1", "1.2"]);
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
