import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item } from "@eo/core";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../../db/repos/index.js";
import { openMigratedTestDb } from "../../../db/testHelpers.js";
import type { PreparedWorkspace } from "../../../supervisor/workspaceKind.js";
import { gitEvidenceCapability } from "./gitEvidence.js";
import { inspectCopy, listMemberCopies, makeMemberCopy, releaseMemberCopies } from "./memberCopies.js";

/**
 * An isolated team member's own copy of an item's repository (EO-867): a
 * detached worktree of the tree the team captured, which nothing done in
 * it can carry back to the item's worktree, its branch, a sibling's copy
 * or the remote.
 */

const scratch: string[] = [];
afterEach(() => {
  for (const made of scratch.splice(0)) rmSync(made, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=eo@example.com", "-c", "user.name=EO", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

/** A repository with a remote, and an item's worktree on its own branch with committed, modified and untracked work. */
function itemWorktree(): { repo: string; remote: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), "eo-member-copies-"));
  scratch.push(root);
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", repo);
  // The bytes as written, whatever the machine's own Git says: a Windows
  // runner's global `core.autocrlf=true` would check the copy out with
  // CRLF, as it would any checkout there, and the comparisons below are
  // of content, not of line endings.
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "export.ts"), "export const csv = false;\n");
  writeFileSync(join(repo, ".gitignore"), "build/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  const worktree = join(root, "worktrees", "EO-1");
  git(repo, "worktree", "add", "-q", "-b", "eo/EO-1", worktree);
  writeFileSync(join(worktree, "export.ts"), "export const csv = true;\n");
  git(worktree, "commit", "-qam", "csv");
  writeFileSync(join(worktree, "export.ts"), "export const csv = true; // and headers\n");
  writeFileSync(join(worktree, "notes.md"), "untracked notes\n");
  return { repo, remote, worktree };
}

const item = { id: "item-1", key: "EO-1" } as Item;
const at = (cwd: string): PreparedWorkspace => ({ cwd, kind: "git-worktree", workspaceId: null }) as PreparedWorkspace;

async function captured(worktree: string): Promise<{ tree: string; head: string | null }> {
  const capture = await gitEvidenceCapability().capture(item, at(worktree));
  if (!capture.ok || capture.evidence.source.kind !== "git") throw new Error("not captured");
  return capture.evidence.source;
}

describe("an isolated member's copy (EO-867)", () => {
  it("holds what the team captured — committed, modified and untracked — on a detached HEAD whose parent is the branch's", async () => {
    const { worktree } = itemWorktree();
    const source = await captured(worktree);
    const made = await makeMemberCopy(worktree, item.key, source, "attempt-a");
    if (!made.ok) throw new Error(made.problem);
    const copy = made.copy.cwd;
    expect(copy).not.toBe(worktree);
    expect(readFileSync(join(copy, "export.ts"), "utf8")).toBe("export const csv = true; // and headers\n");
    expect(readFileSync(join(copy, "notes.md"), "utf8")).toBe("untracked notes\n");
    expect(git(copy, "rev-parse", "HEAD^{tree}")).toBe(source.tree);
    expect(git(copy, "rev-parse", "HEAD~1")).toBe(git(worktree, "rev-parse", "HEAD"));
    expect(git(copy, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    // Clean as EO made it, so nothing is said of a copy nobody touched.
    expect(await inspectCopy(copy)).toEqual([]);
    // Not among the items' worktrees, and invisible to the person's status.
    expect(copy).toContain(join(".git", "eo-team-copies", "EO-1", "attempt-a"));
  }, 30_000);

  it("keeps whatever a member writes, commits and resets to its own copy: the item's worktree, branch, a sibling's copy and the remote are untouched", async () => {
    const { repo, remote, worktree } = itemWorktree();
    const source = await captured(worktree);
    const mine = await makeMemberCopy(worktree, item.key, source, "attempt-a");
    const sibling = await makeMemberCopy(worktree, item.key, source, "attempt-b");
    if (!mine.ok || !sibling.ok) throw new Error("no copies");
    expect(mine.copy.cwd).not.toBe(sibling.copy.cwd);

    const branchBefore = git(repo, "rev-parse", "refs/heads/eo/EO-1");
    const mainBefore = git(repo, "rev-parse", "refs/heads/main");
    const remoteBefore = git(remote, "for-each-ref");
    const itemStatusBefore = git(worktree, "status", "--porcelain");
    const itemFile = readFileSync(join(worktree, "export.ts"), "utf8");
    const siblingHead = git(sibling.copy.cwd, "rev-parse", "HEAD");

    // The member works: writes, commits, writes again, resets, adds a file.
    const copy = mine.copy.cwd;
    writeFileSync(join(copy, "export.ts"), "export const csv = 'rewritten';\n");
    git(copy, "add", "-A");
    git(copy, "commit", "-qm", "a member's commit");
    writeFileSync(join(copy, "fix.ts"), "export const fix = 1;\n");
    git(copy, "reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(copy, "export.ts"), "export const csv = 'again';\n");
    writeFileSync(join(copy, "scratch.ts"), "left behind\n");

    expect(git(repo, "rev-parse", "refs/heads/eo/EO-1")).toBe(branchBefore);
    expect(git(repo, "rev-parse", "refs/heads/main")).toBe(mainBefore);
    expect(git(remote, "for-each-ref")).toBe(remoteBefore);
    expect(git(worktree, "status", "--porcelain")).toBe(itemStatusBefore);
    expect(readFileSync(join(worktree, "export.ts"), "utf8")).toBe(itemFile);
    expect(existsSync(join(worktree, "scratch.ts"))).toBe(false);
    expect(git(sibling.copy.cwd, "rev-parse", "HEAD")).toBe(siblingHead);
    expect(git(sibling.copy.cwd, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(sibling.copy.cwd, "export.ts"), "utf8")).toBe("export const csv = true; // and headers\n");

    // What it did is said, then the copy goes — and only it.
    const changes = await mine.copy.changes();
    expect(changes.join("; ")).toContain("1 tracked file changed: `export.ts`");
    expect(changes.join("; ")).toContain("2 untracked files added: `fix.ts`, `scratch.ts`");
    await mine.copy.remove();
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(sibling.copy.cwd)).toBe(true);
    expect(git(repo, "worktree", "list")).not.toContain("attempt-a");
  }, 30_000);

  it("says a moved HEAD, and the sweep removes every copy but the ones still at work, saying what was changed in each first", async () => {
    const { repo, worktree } = itemWorktree();
    const handle = openMigratedTestDb();
    try {
      createWorkspace(handle.db, { config: { name: "shop", repoPath: repo } });
      const source = await captured(worktree);
      const live = await makeMemberCopy(worktree, item.key, source, "attempt-live");
      const left = await makeMemberCopy(worktree, item.key, source, "attempt-left");
      if (!live.ok || !left.ok) throw new Error("no copies");
      writeFileSync(join(left.copy.cwd, "a.ts"), "a\n");
      git(left.copy.cwd, "add", "-A");
      git(left.copy.cwd, "commit", "-qm", "moved");
      expect((await inspectCopy(left.copy.cwd)).join("; ")).toMatch(/HEAD moved from [0-9a-f]{12} to [0-9a-f]{12}/);

      const said: { attemptId: string; changed: string[] }[] = [];
      const removed = await releaseMemberCopies(handle.db, { keep: (attemptId) => attemptId === "attempt-live", report: (attemptId, changed) => said.push({ attemptId, changed }) });
      expect(removed).toEqual([left.copy.cwd]);
      expect(said.map((one) => one.attemptId)).toEqual(["attempt-left"]);
      expect((await listMemberCopies(repo)).map((one) => one.attemptId)).toEqual(["attempt-live"]);

      // An item's own release takes what is left of its copies.
      await releaseMemberCopies(handle.db, { item, report: () => undefined });
      expect(await listMemberCopies(repo)).toEqual([]);
    } finally {
      handle.close();
    }
  }, 30_000);
});
