import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PIPELINE_ID, SECTION_LOCK_TEXT, type GalleryNeedView } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { archiveAgent, createGitWorkspace, addWorkspaceToProject, getProject, listAgents, listGitWorkspaces, listJobs, listPipelines, listProjects, projectWorkspaceList, publishSection } from "../db/repos/index.js";
import { beginAdoption } from "../db/repos/projectsRepo.js";
import { markReplica } from "../db/recordRole.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { attachWorkspaceCommand, galleryNeedsCommand, listGalleryCommand, staffRoleCommand, useGalleryCommand } from "../ipc/galleryCommands.js";
import DEVELOPER_FIRST_RUN from "../../renderer/src/chat/views/gallery/__fixtures__/developerFirstRun.json" with { type: "json" };
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
 *    everybody else gets;
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
  it("asks for a repository and a backend, and nothing else", async () => {
    const installed = await install("software-feature-to-merge", { keyPrefix: "ACME" });

    const needs = await galleryNeedsCommand(handle.db, context(), {
      projectId: installed.projectId as string,
      slug: "software-feature-to-merge",
    });

    expect(needs.problem).toBeNull();
    expect(needs.needs.filter((need) => !need.met).map((need) => need.key)).toEqual(["workspace", "backend"]);

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
    expect(line(before.needs, "role:reporter").fix).toEqual({ kind: "role", label: "Use claude for this", target: "reporter" });

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
