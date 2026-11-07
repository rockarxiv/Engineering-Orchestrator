import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PIPELINE_ID, GIT_WORKTREE_KIND, SECTION_LOCK_TEXT, type GalleryNeedView, type PipelineExport } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { archiveAgent, asGitWorkspace, updateWorkspace, createGitWorkspace, addWorkspaceToProject, getProject, listAgents, listGitWorkspaces, listJobs, listPipelines, listProjects, projectWorkspaceList, publishSection } from "../db/repos/index.js";
import { beginAdoption } from "../db/repos/projectsRepo.js";
import { markReplica } from "../db/recordRole.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { detectForge } from "../ipc/forgeCommands.js";
import { attachWorkspaceCommand, galleryNeedsCommand, listGalleryCommand, staffRoleCommand, useGalleryCommand } from "../ipc/galleryCommands.js";
import { addRepositoryToProjectCommand, createProjectCommand } from "../ipc/projectCommands.js";
import { createWorkspaceCommand } from "../ipc/workspaceCommands.js";
import DEVELOPER_FIRST_RUN from "../../renderer/src/chat/views/gallery/__fixtures__/developerFirstRun.json" with { type: "json" };
import { forgeCardNeed } from "./form.js";
import { forgetListed } from "./session.js";

/**
 * The needs check, line by line (EO-317, `ARCHITECTURE.md`,
 * "The needs check", "What a person sees first").
 *
 * "Each red line says why it is red and carries the one button that
 * fixes it." Three claims are made here, and each is one a screen alone
 * could not make true:
 *
 *  - a developer's fresh installation has **the same two needs** it has
 *    today — a repository and a backend — through the same screen
 *    everybody else gets, and, since EO-663, the forge CLI its pull
 *    requests go through;
 *  - a red line about a folder EO cannot see **names the path** and
 *    carries a button whose kind says what pressing it does;
 *  - pressing it **turns the line green**, which is only provable by
 *    asking the machine the question a second time.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const NO_SECRETS = {
  directory: join(tmpdir(), "eo-needs-no-secrets"),
  store: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" },
};

let handle: DbHandle;
let folder: string;

beforeEach(() => {
  handle = openMigratedTestDb();
  folder = mkdtempSync(join(tmpdir(), "eo needs folder "));
  forgetListed();
});

afterEach(() => {
  handle.close();
  rmSync(folder, { recursive: true, force: true });
});

function context() {
  return { directory: GALLERY_DIRECTORY, moduleSecrets: NO_SECRETS, signedInBackends: [] as string[] };
}

/** Installs a bundled template the way the form does, and answers with the project it made. */
async function install(slug: string, answers: Record<string, string>) {
  const result = await useGalleryCommand(handle.db, context(), { slug, answers, roleSlots: {} });
  expect(result.problem).toBeNull();
  expect(result.projectId).not.toBeNull();
  return result;
}

function line(needs: readonly GalleryNeedView[], key: string): GalleryNeedView {
  const found = needs.find((need) => need.key === key);
  expect(found, `no "${key}" line: ${needs.map((need) => need.key).join(", ")}`).toBeDefined();
  return found!;
}

/** A checkout, because a repository in EO is one that already exists — EO clones nothing. */
function checkout(): string {
  const path = mkdtempSync(join(tmpdir(), "eo needs repo "));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "eo@example.com");
  git("config", "user.name", "EO");
  // Unsigned, because this machine's own git config may require a
  // signature and the agent that holds the key is not this test's to
  // depend on.
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-m", "initial");
  return path;
}

describe("a developer's first run, through everybody's screen", () => {
  /**
   * The acceptance criterion, stated as the two red lines it names: "a
   * developer's fresh installation reaches the same board it reaches
   * today with the same two needs".
   *
   * The roles are green because EO seeds an implementer and a reviewer
   * on every installation, which is what makes the developer's list two
   * lines rather than four.
   */
  it("asks for a repository, the forge CLI and a backend, and nothing else", async () => {
    const installed = await install("software-feature-to-merge", { keyPrefix: "ACME" });

    const needs = await galleryNeedsCommand(handle.db, context(), {
      projectId: installed.projectId as string,
      slug: "software-feature-to-merge",
    });

    expect(needs.problem).toBeNull();
    expect(needs.needs.filter((need) => !need.met).map((need) => need.key)).toEqual(["workspace", "forge", "backend"]);

    const workspace = line(needs.needs, "workspace");
    expect(workspace.line).toContain("repository");
    expect(workspace.why).toContain("no repository yet");
    expect(workspace.fix).toEqual({ kind: "repository", label: "Choose a repository", target: "" });

    const backend = line(needs.needs, "backend");
    expect(backend.why).toContain("Nothing on this machine is signed in");
    expect(backend.fix?.kind).toBe("backend");
  });

  /**
   * The copy itself, held to what a fresh installation actually derives.
   *
   * "A snapshot test proves the developer's first-run copy" — and a
   * snapshot of hand-written lines proves only that somebody typed them
   * twice. So the words a developer reads are checked in, as
   * `developerFirstRun.json`, and this is what holds them to the real
   * thing: the bundled pack, installed on a migrated database, read back
   * through `gallery:needs`. The screen that renders them snapshots that
   * same file (`NeedsCheck.test.tsx`), so a change to the pack, the
   * preflight or the derivation moves both or neither.
   *
   * **When this fails, regenerate the file rather than editing it** —
   * the same instruction `softwarePack.test.ts` gives about the pack it
   * holds, and for the same reason: what is asserted is that the file
   * *is* the answer, not that it resembles one.
   */
  it("derives the first-run copy the developer's screen is snapshotted from", async () => {
    const listed = await listGalleryCommand(handle.db, context());
    const card = listed.templates.find((template) => template.slug === "software-feature-to-merge");
    expect(card, "the gallery no longer ships software-feature-to-merge").toBeDefined();

    const installed = await install("software-feature-to-merge", { keyPrefix: "ACME" });
    const needs = await galleryNeedsCommand(handle.db, context(), {
      projectId: installed.projectId as string,
      slug: "software-feature-to-merge",
    });

    expect({
      template: { slug: card!.slug, title: card!.title, pipelineName: card!.pipelineName, previewable: card!.previewable },
      needs: needs.needs,
      jobId: needs.jobId,
    }).toEqual(DEVELOPER_FIRST_RUN);
  });

  /**
   * "The same board it reaches today", meaning the one board.
   *
   * "Software feature to merge" is generated from an export of the
   * Delivery pipeline EO seeds, so importing it wrote a second Delivery
   * into the rail beside the first — two identical boards, on a screen
   * whose whole claim is that a developer's first run is unchanged. A
   * fresh installation adopts the pipeline it is already holding.
   */
  it("lands on the Delivery board EO ships rather than a second copy of it", async () => {
    const installed = await install("software-feature-to-merge", { keyPrefix: "ACME" });

    expect(installed.pipelineId).toBe(DEFAULT_PIPELINE_ID);
    const boards = listPipelines(handle.db, installed.projectId as never).map((pipeline) => pipeline.name);
    expect(boards.filter((name) => name === "Delivery")).toHaveLength(1);
  });

  /**
   * And only on a fresh one. An installation with a project of its own
   * is shown every unadopted pipeline, so adopting one there would take
   * a board off the projects that were being shown it.
   */
  it("imports a copy when the installation already has a project", async () => {
    await install("weekly-report", { folder, schedule: "monday 08:00", keyPrefix: "REP" });
    const second = await install("software-feature-to-merge", { keyPrefix: "ACME" });

    expect(second.pipelineId).not.toBe(DEFAULT_PIPELINE_ID);
  });

  /** And the developer template makes no job, so no Jobs entry appears for it in the rail (ARCHITECTURE.md, "The chat-centric layout"). */
  it("makes no job, so the rail gains no Jobs entry", async () => {
    const installed = await install("software-feature-to-merge", { keyPrefix: "ACME" });
    expect(installed.jobId).toBeNull();
    expect(listJobs(handle.db, installed.projectId as never)).toEqual([]);
  });

  /** The one button on the red line, pressed: a repository, attached to *this* project. */
  it("turns the repository line green when a checkout is chosen", async () => {
    const repoPath = checkout();
    try {
      const installed = await install("software-feature-to-merge", { keyPrefix: "ACME" });
      const projectId = installed.projectId as string;

      const attached = await attachWorkspaceCommand(handle.db, { projectId, path: repoPath, kind: "git" });
      expect(attached).toEqual({ ok: true, problem: null });

      const after = await galleryNeedsCommand(handle.db, context(), { projectId, slug: "software-feature-to-merge" });
      expect(line(after.needs, "workspace").met).toBe(true);
      // On the project the template made, rather than on one of its own
      // — which is what `repositories:create` would have done, and what
      // would have left this line red beside a second project nobody
      // asked for.
      expect(listProjects(handle.db).filter((project) => project.name !== "Preview")).toHaveLength(1);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  describe("on a project mid-move to the organisation's record (EO-605)", () => {
    const refusal = (name: string) => `"${name}" is being moved to your organisation's record. Wait for the move to finish, then change its repositories.`;

    it("refuses a repository and writes nothing, while a folder is still accepted", async () => {
      const repoPath = checkout();
      try {
        const projectId = (await install("software-feature-to-merge", { keyPrefix: "ACME" })).projectId as never;
        const name = getProject(handle.db, projectId)!.name;
        beginAdoption(handle.db, projectId);

        expect(await attachWorkspaceCommand(handle.db, { projectId, path: repoPath, kind: "git" })).toEqual({ ok: false, problem: refusal(name) });
        expect(listGitWorkspaces(handle.db)).toEqual([]);

        expect(await attachWorkspaceCommand(handle.db, { projectId, path: folder, kind: "folder" })).toEqual({ ok: true, problem: null });
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });

    it("refuses to repoint a repository EO cannot see", async () => {
      const repoPath = checkout();
      try {
        const projectId = (await install("software-feature-to-merge", { keyPrefix: "ACME" })).projectId as never;
        const gone = join(folder, "gone");
        addWorkspaceToProject(handle.db, projectId, createGitWorkspace(handle.db, { config: { name: "gone", repoPath: gone } }).id);
        beginAdoption(handle.db, projectId);

        expect((await attachWorkspaceCommand(handle.db, { projectId, path: repoPath, kind: "git" })).ok).toBe(false);
        expect(projectWorkspaceList(handle.db, projectId).map((workspace) => (workspace.config as { repoPath: string }).repoPath)).toEqual([gone]);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  it("refuses a path git does not recognise, in words that say what to do", async () => {
    const installed = await install("software-feature-to-merge", { keyPrefix: "ACME" });
    const attached = await attachWorkspaceCommand(handle.db, {
      projectId: installed.projectId as string,
      path: folder,
      kind: "git",
    });
    expect(attached.ok).toBe(false);
    expect(attached.problem).toContain("is not a git repository");
  });
});

describe("several repositories on one first-run project (EO-662)", () => {
  const credentials = { directory: "/nowhere", store: NO_SECRETS.store };
  const repositories: string[] = [];
  const repository = () => {
    const path = checkout();
    repositories.push(path);
    return path;
  };
  afterEach(() => {
    for (const path of repositories.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  const realProjects = () => listProjects(handle.db).filter((project) => project.name !== "Preview");
  const needsOf = async (projectId: string) =>
    line((await galleryNeedsCommand(handle.db, context(), { projectId, slug: "software-feature-to-merge" })).needs, "workspace");

  it("asks for the repository on the setup form, and attaches it to the project it makes", async () => {
    const listed = await listGalleryCommand(handle.db, context());
    const card = listed.templates.find((template) => template.slug === "software-feature-to-merge")!;
    expect(card.blanks.find((blank) => blank.kind === "repository")).toMatchObject({ key: "repository", required: false });

    const first = repository();
    const installed = await install("software-feature-to-merge", { keyPrefix: "ACME", repository: first });

    const workspace = line(installed.needs, "workspace");
    expect(workspace.met).toBe(true);
    expect(workspace.parts).toEqual([{ key: expect.any(String), line: basename(first), met: true, why: null }]);
    expect(workspace.fix).toEqual({ kind: "addRepository", label: "Add another repository", target: null });
    expect(realProjects()).toHaveLength(1);
  });

  it("refuses a repository git does not know on the form, before anything is made", async () => {
    const refused = await useGalleryCommand(handle.db, context(), { slug: "software-feature-to-merge", answers: { keyPrefix: "ACME", repository: folder }, roleSlots: {} });
    expect(refused.problem).toContain("is not a git repository");
    expect(realProjects()).toEqual([]);
    expect(listGitWorkspaces(handle.db)).toEqual([]);
  });

  it("attaches a second repository through the channels Settings → Projects uses, and lists both by name", async () => {
    const first = repository();
    const second = repository();
    const third = repository();
    const projectId = (await install("software-feature-to-merge", { keyPrefix: "ACME", repository: first })).projectId as string;

    // workspaces:create, as "Add another repository" sends it.
    const created = await createWorkspaceCommand(handle.db, credentials, { kind: GIT_WORKTREE_KIND, projectId, config: { name: "payments", repoPath: second } });
    expect(created.problem).toBeNull();

    const workspace = await needsOf(projectId);
    expect(workspace.met).toBe(true);
    expect(workspace.parts?.map((part) => [part.line, part.met])).toEqual([
      [basename(first), true],
      ["payments", true],
    ]);
    expect(workspace.fix?.kind).toBe("addRepository");
    expect(realProjects()).toHaveLength(1);
    expect(projectWorkspaceList(handle.db, projectId as never)).toHaveLength(2);

    // projects:addProject, for one EO already holds on another project.
    const other = await createProjectCommand(handle.db, { name: "Other", keyPrefix: "OTH", repositoryIds: [] });
    const elsewhere = await createWorkspaceCommand(handle.db, credentials, { kind: GIT_WORKTREE_KIND, projectId: other.project!.id, config: { name: "docs", repoPath: third } });
    expect(addRepositoryToProjectCommand(handle.db, { projectId, repositoryId: elsewhere.workspace!.id }).ok).toBe(true);
    expect((await needsOf(projectId)).parts?.map((part) => part.line)).toEqual([basename(first), "payments", "docs"]);
  });

  it("stays green with one working and one missing repository, and says why on the missing one's row", async () => {
    const working = repository();
    const projectId = (await install("software-feature-to-merge", { keyPrefix: "ACME", repository: working })).projectId as never;
    const gone = join(folder, "gone");
    addWorkspaceToProject(handle.db, projectId, createGitWorkspace(handle.db, { config: { name: "gone", repoPath: gone } }).id);

    const workspace = await needsOf(projectId);
    expect(workspace.met).toBe(true);
    expect(workspace.why).toBeNull();
    const [ok, missing] = workspace.parts ?? [];
    expect(ok).toMatchObject({ line: basename(working), met: true, why: null });
    expect(missing).toMatchObject({ line: "gone", met: false });
    expect(missing?.why).toContain(gone);
  });

  it("goes red when none works, each row saying its own reason", async () => {
    const projectId = (await install("software-feature-to-merge", { keyPrefix: "ACME" })).projectId as never;
    for (const name of ["one", "two"]) {
      addWorkspaceToProject(handle.db, projectId, createGitWorkspace(handle.db, { config: { name, repoPath: join(folder, name) } }).id);
    }

    const workspace = await needsOf(projectId);
    expect(workspace.met).toBe(false);
    expect(workspace.fix?.kind).toBe("repository");
    expect(workspace.parts?.map((part) => [part.line, part.met])).toEqual([
      ["one", false],
      ["two", false],
    ]);
    expect(workspace.parts?.[1]?.why).toContain(join(folder, "two"));
  });

  /**
   * A pack may key its own blanks however it likes, "repository"
   * included. The derived field must not share that key, or the two
   * fields share one answer and the template cannot be installed.
   */
  it("keeps the repository answer apart from a pack blank keyed \"repository\"", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eo needs gallery "));
    try {
      const pack = JSON.parse(readFileSync(join(GALLERY_DIRECTORY, "software-feature-to-merge.json"), "utf8")) as {
        template: { slug: string; blanks: { key: string; kind: string }[] };
      };
      pack.template.slug = "repository-keyed";
      pack.template.blanks = pack.template.blanks.map((blank) => (blank.kind === "keyPrefix" ? { ...blank, key: "repository" } : blank));
      writeFileSync(join(directory, "repository-keyed.json"), JSON.stringify(pack));
      const here = { ...context(), directory };

      const card = (await listGalleryCommand(handle.db, here)).templates.find((template) => template.slug === "repository-keyed")!;
      const keys = card.blanks.map((blank) => blank.key);
      expect(new Set(keys).size).toBe(keys.length);
      const derived = card.blanks.find((blank) => blank.kind === "repository")!;
      expect(derived.key).not.toBe("repository");

      const path = repository();
      const installed = await useGalleryCommand(handle.db, here, { slug: "repository-keyed", answers: { repository: "ACME", [derived.key]: path }, roleSlots: {} });
      expect(installed.problem).toBeNull();
      expect(getProject(handle.db, installed.projectId as never)?.keyPrefix).toBe("ACME");
      expect(line(installed.needs, "workspace").parts?.map((part) => part.line)).toEqual([basename(path)]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves a template that wants a folder as it was", async () => {
    const listed = await listGalleryCommand(handle.db, context());
    expect(listed.templates.find((template) => template.slug === "weekly-report")?.blanks.some((blank) => blank.kind === "repository")).toBe(false);

    const installed = await install("weekly-report", { folder, schedule: "monday 08:00", keyPrefix: "REP" });
    expect(line(installed.needs, "workspace")).toEqual({ key: "workspace", line: "A folder — somewhere its work happens", met: true, why: null, fix: null });
  });
});

describe("a role nobody here can play", () => {
  /**
   * The line the weekly report lands with, on every installation there
   * is.
   *
   * Its `reporter` role names no backend — a backend is a fact about the
   * installing machine rather than about the pack — so the import writes
   * the agent pointed at nothing and switched off. Signing in does not
   * move that line, which is why it needs a button of its own rather
   * than the sign-in.
   */
  it("says so, and offers the sign-in while there is nothing to point an agent at", async () => {
    const installed = await install("weekly-report", { folder, schedule: "monday 08:00", keyPrefix: "REP" });
    const needs = await galleryNeedsCommand(handle.db, context(), {
      projectId: installed.projectId as string,
      slug: "weekly-report",
    });

    const role = line(needs.needs, "role:reporter");
    expect(role.met).toBe(false);
    expect(role.why).toContain("Nothing on this machine is signed in");
    expect(role.fix).toEqual({ kind: "backend", label: "Sign in", target: null });
  });

  /**
   * And once something *is* signed in, the line carries the gesture that
   * staffs it — which is the whole of ARCHITECTURE.md, "The needs check"'s "the one button that
   * fixes
   * it" for this line, and the last thing between the weekly report and
   * its first item.
   */
  it("offers the backend by name once one is signed in, and goes green when it is pressed", async () => {
    const installed = await install("weekly-report", { folder, schedule: "monday 08:00", keyPrefix: "REP" });
    const projectId = installed.projectId as string;
    const signedIn = { ...context(), signedInBackends: ["claude"] };

    const before = await galleryNeedsCommand(handle.db, signedIn, { projectId, slug: "weekly-report" });
    const red = line(before.needs, "role:reporter");
    expect(red.line).toBe("An agent for the Reporter steps");
    expect(red.why).toBe("The Reporter steps have no agent to run on yet.");
    expect(red.why).not.toMatch(/pack|backend|slug/i);
    expect(red.fix).toEqual({ kind: "role", label: "Use Claude Code for these steps", target: "reporter" });

    expect(await staffRoleCommand(handle.db, signedIn, { slug: "weekly-report", role: "reporter" })).toEqual({ ok: true, problem: null, locked: null });

    const after = await galleryNeedsCommand(handle.db, signedIn, { projectId, slug: "weekly-report" });
    expect(line(after.needs, "role:reporter").met).toBe(true);
    // The row the import wrote, pointed and switched on — not a second
    // agent beside it, which would leave the pack's prompt on one and
    // the backend on the other.
    const reporters = listAgents(handle.db).filter((agent) => agent.role === "reporter" && agent.archivedAt === null);
    expect(reporters).toHaveLength(1);
    expect(reporters[0]).toMatchObject({ provider: "claude", enabled: true });
    expect(reporters[0]?.instructions).not.toBe("");
  });

  /**
   * The lock's line through this command (EO-329, review).
   *
   * Staffing does two different things and a published agents section
   * separates them: pointing an agent that already exists at a backend
   * is the design's local half and stays the person's, while *creating* one —
   * with the pack's prompt and its `allowedTools` — is the agents
   * section arriving by a side door. The refusal has to fall between
   * them, or the lock takes away the one thing it promises to leave.
   */
  it("still binds a published role to this machine's backend, and refuses to create an agent for one", async () => {
    await install("weekly-report", { folder, schedule: "monday 08:00", keyPrefix: "REP" });
    const signedIn = { ...context(), signedInBackends: ["claude"] };
    publishSection(handle.db, { section: "agents", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });
    const stop = markReplica(handle.db, () => true);

    try {
      // The row the pack left is here, so this is a binding: the one
      // write a locked agents section does not refuse.
      expect(await staffRoleCommand(handle.db, signedIn, { slug: "weekly-report", role: "reporter" })).toEqual({ ok: true, problem: null, locked: null });
      expect(listAgents(handle.db).filter((agent) => agent.role === "reporter" && agent.archivedAt === null)[0]).toMatchObject({
        provider: "claude",
        enabled: true,
      });

      // With nothing to bind, the same call would *create* an agent —
      // and that is the section itself.
      for (const agent of listAgents(handle.db).filter((one) => one.role === "reporter")) {
        archiveAgent(handle.db, agent.id);
      }
      const refused = await staffRoleCommand(handle.db, signedIn, { slug: "weekly-report", role: "reporter" });

      expect(refused.ok).toBe(false);
      // The design's own words, and not the sentence the command layer writes
      // for an assistant reading a transcript (EO-329, review). This
      // channel is answered on a screen: "tell the person it is managed
      // and stop" is an instruction about the very person reading it.
      expect(refused.problem).toContain(SECTION_LOCK_TEXT);
      expect(refused.problem).not.toContain("Tell the person");
      // …and the marker beside it, so the screen draws the lock rather
      // than red text (`ManagedLockNotice`).
      expect(refused.locked).toMatchObject({ locked: true, section: "agents", publishedBy: "Dana" });
      expect(listAgents(handle.db).filter((agent) => agent.role === "reporter" && agent.archivedAt === null)).toEqual([]);
    } finally {
      stop();
    }
  });

  /** Never at a backend this machine is not signed in to, and never at the placeholder. */
  it("refuses rather than pointing an agent at something that cannot run", async () => {
    await install("weekly-report", { folder, schedule: "monday 08:00", keyPrefix: "REP" });

    const refused = await staffRoleCommand(handle.db, context(), { slug: "weekly-report", role: "reporter" });
    expect(refused.ok).toBe(false);
    expect(refused.problem).toContain("Sign in first");
    expect(listAgents(handle.db).filter((agent) => agent.role === "reporter").every((agent) => !agent.enabled)).toBe(true);
  });

  /**
   * And the whole point of it: with every line green, the job the
   * template made is what step 6 fires.
   */
  it("leaves the weekly report with nothing red, once the folder, the sign-in and the role are answered", async () => {
    const installed = await install("weekly-report", { folder, schedule: "monday 08:00", keyPrefix: "REP" });
    const projectId = installed.projectId as string;
    const signedIn = { ...context(), signedInBackends: ["claude"] };

    await staffRoleCommand(handle.db, signedIn, { slug: "weekly-report", role: "reporter" });

    const needs = await galleryNeedsCommand(handle.db, signedIn, { projectId, slug: "weekly-report" });
    expect(needs.needs.filter((need) => !need.met)).toEqual([]);
    expect(needs.jobId).toBe(installed.jobId);
  });
});

describe("a folder that is no longer there", () => {
  /**
   * The story's own example: "a red needs line for a missing folder
   * shows the path and a 'Choose folder' button; fixing it turns the
   * line green without leaving the screen".
   *
   * The folder was checked when the form was submitted — `useTemplate`
   * refuses one that is not there — so this is the state that happens
   * afterwards, on a disk somebody renamed, unmounted or tidied up.
   */
  it("says which path, and repoints the workspace rather than adding a second", async () => {
    const installed = await install("weekly-report", { folder, schedule: "monday 08:00", keyPrefix: "REP" });
    const projectId = installed.projectId as string;
    expect(line(installed.needs, "workspace").met).toBe(true);

    rmSync(folder, { recursive: true, force: true });

    const red = await galleryNeedsCommand(handle.db, context(), { projectId, slug: "weekly-report" });
    const workspace = line(red.needs, "workspace");
    expect(workspace.met).toBe(false);
    expect(workspace.why).toContain(folder);
    expect(workspace.fix).toEqual({ kind: "folder", label: "Choose folder", target: folder });

    const chosen = mkdtempSync(join(tmpdir(), "eo needs elsewhere "));
    try {
      expect(await attachWorkspaceCommand(handle.db, { projectId, path: chosen, kind: "folder" })).toEqual({ ok: true, problem: null });

      const green = await galleryNeedsCommand(handle.db, context(), { projectId, slug: "weekly-report" });
      expect(line(green.needs, "workspace").met).toBe(true);
      // Repointed, not joined: a second folder beside a dead one would
      // leave the items that name the dead one with nowhere to be
      // written, while this line went green about a different disk.
      expect(listProjects(handle.db)).toHaveLength(1);
      const job = listJobs(handle.db, projectId as never);
      expect(green.jobId).toBe(job[0]?.id ?? null);
    } finally {
      rmSync(chosen, { recursive: true, force: true });
    }
  });

  /** The weekly report does file work on a schedule, so there is a first item to start. */
  it("names the job the template made, which is what step 6 fires", async () => {
    const installed = await install("weekly-report", { folder, schedule: "monday 08:00", keyPrefix: "REP" });
    const needs = await galleryNeedsCommand(handle.db, context(), {
      projectId: installed.projectId as string,
      slug: "weekly-report",
    });
    expect(needs.jobId).toBe(installed.jobId);
    expect(needs.jobId).not.toBeNull();
  });
});

/**
 * The forge CLI line (EO-663): a pipeline with a step that opens a pull
 * request needs `gh` or `glab`, one line per repository, read from
 * `forge:detect`'s answer for it. The CLI is faked — what is under test
 * is the line, not whether this machine has `gh`.
 */
describe("the forge CLI a pull request goes through (EO-663)", () => {
  type Run = NonNullable<Parameters<typeof detectForge>[2]>;
  /** `gh auth status` / `glab auth status`, answered as `state` says. */
  let state: "missing" | "signedOut" | "signedIn";
  const calls: string[] = [];
  const run: Run = async (cli) => {
    calls.push(cli);
    if (state === "missing") return { ok: false, stdout: "", error: "not found", notFound: true };
    return state === "signedIn" ? { ok: true, stdout: "", error: "", notFound: false } : { ok: false, stdout: "", error: "not logged in", notFound: false };
  };
  const forgeContext = () => ({ ...context(), detectForge: (repositoryId: string) => detectForge(handle.db, { repositoryId }, run) });

  beforeEach(() => {
    state = "signedIn";
    calls.length = 0;
  });

  /** A checkout whose `origin` is `remote`. */
  function withRemote(remote: string): string {
    const path = checkout();
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: path });
    return path;
  }

  async function needsFor(projectId: string) {
    const answer = await galleryNeedsCommand(handle.db, forgeContext(), { projectId, slug: "software-feature-to-merge" });
    expect(answer.problem).toBeNull();
    return answer.needs;
  }

  it("is on the card of a template whose pipeline opens a pull request, and only there", async () => {
    const listed = await listGalleryCommand(handle.db, context());
    const lines = (slug: string) => listed.templates.find((template) => template.slug === slug)?.needs.map((need) => need.line) ?? [];
    expect(lines("software-feature-to-merge")).toContain("GitHub or GitLab CLI");
    const others = listed.templates.filter((template) => template.slug !== "software-feature-to-merge");
    expect(others.length).toBeGreaterThan(0);
    for (const template of others) expect(template.needs.map((need) => need.key)).not.toContain("forge");
  });

  it("asks nothing of a pipeline without a pull-request step", async () => {
    const installed = await useGalleryCommand(handle.db, forgeContext(), { slug: "weekly-report", answers: { folder, schedule: "monday 08:00", keyPrefix: "REP" }, roleSlots: {} });
    expect(installed.problem).toBeNull();
    expect(installed.needs.filter((need) => need.key.startsWith("forge"))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("gives each repository its own line, from forge:detect's answer for its remote", async () => {
    const github = withRemote("git@github.com:acme/payments.git");
    const gitlab = withRemote("https://gitlab.com/acme/web.git");
    try {
      const projectId = (await install("software-feature-to-merge", { keyPrefix: "ACME" })).projectId as string;
      expect((await attachWorkspaceCommand(handle.db, { projectId, path: github, kind: "git" })).ok).toBe(true);
      expect((await attachWorkspaceCommand(handle.db, { projectId, path: gitlab, kind: "git" })).ok).toBe(true);
      const [first, second] = projectWorkspaceList(handle.db, projectId as never);

      const needs = await needsFor(projectId);
      const keys = needs.map((need) => need.key);
      // The card's line gives way to one per repository, under the repositories.
      expect(keys).not.toContain("forge");
      expect(keys.slice(keys.indexOf("workspace"), keys.indexOf("backend"))).toEqual(["workspace", `forge:${first!.id}`, `forge:${second!.id}`]);
      expect(line(needs, `forge:${first!.id}`)).toEqual({
        key: `forge:${first!.id}`,
        line: `GitHub CLI (gh) installed and signed in, for ${basename(github)}`,
        met: true,
        why: null,
        fix: null,
      });
      expect(line(needs, `forge:${second!.id}`).line).toBe(`GitLab CLI (glab) installed and signed in, for ${basename(gitlab)}`);
      expect([...calls].sort()).toEqual(["gh", "glab"]);
    } finally {
      rmSync(github, { recursive: true, force: true });
      rmSync(gitlab, { recursive: true, force: true });
    }
  });

  it("says which CLI is missing and why, links to its install page, and goes green when checked again", async () => {
    const path = withRemote("git@github.com:acme/payments.git");
    try {
      const projectId = (await install("software-feature-to-merge", { keyPrefix: "ACME" })).projectId as string;
      await attachWorkspaceCommand(handle.db, { projectId, path, kind: "git" });
      const id = projectWorkspaceList(handle.db, projectId as never)[0]!.id;

      state = "missing";
      const missing = line(await needsFor(projectId), `forge:${id}`);
      expect(missing.met).toBe(false);
      expect(missing.why).toContain("GitHub CLI, gh, which is not installed");
      expect(missing.why).toContain("EO opens its pull requests through");
      expect(missing.fix).toEqual({ kind: "forge", label: "Check again", target: id, link: { label: "Install gh", url: "https://cli.github.com" } });

      state = "signedOut";
      const signedOut = line(await needsFor(projectId), `forge:${id}`);
      expect(signedOut.met).toBe(false);
      expect(signedOut.why).toContain("run: gh auth login");
      expect(signedOut.fix).toEqual({ kind: "forge", label: "Check again", target: id });

      // Check again is the same question asked once more.
      state = "signedIn";
      expect(line(await needsFor(projectId), `forge:${id}`).met).toBe(true);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("names glab auth login, with the host, for a self-hosted GitLab", async () => {
    const path = withRemote("git@gitlab.acme.dev:acme/web.git");
    try {
      const projectId = (await install("software-feature-to-merge", { keyPrefix: "ACME" })).projectId as string;
      await attachWorkspaceCommand(handle.db, { projectId, path, kind: "git" });
      const workspace = projectWorkspaceList(handle.db, projectId as never)[0]!;
      updateWorkspace(handle.db, workspace.id, { config: { forgeKind: "gitlab" } });

      state = "signedOut";
      expect(line(await needsFor(projectId), `forge:${workspace.id}`).why).toContain("run: glab auth login --hostname gitlab.acme.dev");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("shows forge:detect's own problem for a host it cannot place, and lets the person say which", async () => {
    const path = withRemote("git@code.acme.dev:acme/web.git");
    try {
      const projectId = (await install("software-feature-to-merge", { keyPrefix: "ACME" })).projectId as string;
      await attachWorkspaceCommand(handle.db, { projectId, path, kind: "git" });
      const workspace = projectWorkspaceList(handle.db, projectId as never)[0]!;
      const detected = await detectForge(handle.db, { repositoryId: workspace.id }, run);
      expect(detected.kind).toBeNull();

      const unplaced = line(await needsFor(projectId), `forge:${workspace.id}`);
      expect(unplaced.line).toBe(`GitHub or GitLab CLI, for ${asGitWorkspace(workspace)!.config.name}`);
      expect(unplaced.why).toBe(detected.problem);
      expect(unplaced.fix).toEqual({ kind: "forgeKind", label: "Say which", target: workspace.id });

      // What the choice writes — the Forge field Settings → Workspaces has.
      updateWorkspace(handle.db, workspace.id, { config: { forgeKind: "gitlab" } });
      const placed = line(await needsFor(projectId), `forge:${workspace.id}`);
      expect(placed.line).toBe(`GitLab CLI (glab) installed and signed in, for ${asGitWorkspace(workspace)!.config.name}`);
      expect(placed.met).toBe(true);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("is read off the steps, never off the template", () => {
    const step = (type: string, entryAction: string | null) => ({ type, entryAction }) as unknown as PipelineExport["steps"][number];
    expect(forgeCardNeed({ steps: [step("agent", null), step("builtin", "open_pull_request")] }).map((need) => need.key)).toEqual(["forge"]);
    expect(forgeCardNeed({ steps: [step("builtin", "create_worktree"), step("module", "open_pull_request")] })).toEqual([]);
  });

  it("keeps the card's line, with no button, until a repository is attached", async () => {
    const projectId = (await install("software-feature-to-merge", { keyPrefix: "ACME" })).projectId as string;
    const waiting = line(await needsFor(projectId), "forge");
    expect(waiting).toMatchObject({ line: "GitHub or GitLab CLI", met: false, fix: null });
    expect(calls).toEqual([]);
  });
});
