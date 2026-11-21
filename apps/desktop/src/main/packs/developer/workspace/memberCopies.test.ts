import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import type { Item } from "@eo/core";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../../db/repos/index.js";
import { openMigratedTestDb } from "../../../db/testHelpers.js";
import type { MemberCopy } from "../../../supervisor/teamEvidence.js";
import type { PreparedWorkspace } from "../../../supervisor/workspaceKind.js";
import { gitEvidenceCapability } from "./gitEvidence.js";
import { inspectCopy, listMemberCopies, makeMemberCopy, releaseMemberCopies, teamCopiesRoot } from "./memberCopies.js";

/**
 * An isolated team member's own copy of an item's repository (EO-867,
 * EO-872): the item's worktree exactly, outside every checkout, which
 * nothing done in it can carry back to the item's worktree, its branch, a
 * sibling's copy or the remote — and whose shared refs are watched.
 */

const scratch: string[] = [];
afterEach(() => {
  for (const made of scratch.splice(0)) rmSync(made, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=eo@example.com", "-c", "user.name=EO", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

/** `git` as a member's processes run it: with what its copy asks of their environment, as its turn is started with. */
function gitAs(copy: MemberCopy, cwd: string, ...args: string[]): string {
  const env = { ...process.env, ...copy.environment!({}) };
  return execFileSync("git", ["-c", "user.email=eo@example.com", "-c", "user.name=EO", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env }).trim();
}

/** A repository with a remote, and an item's worktree on its own branch with committed, modified, deleted and untracked work. */
function itemWorktree(): { root: string; repo: string; remote: string; worktree: string; copies: string } {
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
  writeFileSync(join(repo, "old.ts"), "export const old = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  const worktree = join(root, "worktrees", "EO-1");
  git(repo, "worktree", "add", "-q", "-b", "eo/EO-1", worktree);
  writeFileSync(join(worktree, "export.ts"), "export const csv = true;\n");
  git(worktree, "commit", "-qam", "csv");
  writeFileSync(join(worktree, "export.ts"), "export const csv = true; // and headers\n");
  unlinkSync(join(worktree, "old.ts"));
  writeFileSync(join(worktree, "notes.md"), "untracked notes\n");
  return { root, repo, remote, worktree, copies: teamCopiesRoot(join(root, "worktrees")) };
}

const item = { id: "item-1", key: "EO-1" } as Item;
const at = (cwd: string): PreparedWorkspace => ({ cwd, kind: "git-worktree", workspaceId: null }) as PreparedWorkspace;

async function captured(worktree: string): Promise<{ tree: string; head: string | null; added?: string[] | undefined }> {
  const capture = await gitEvidenceCapability().capture(item, at(worktree));
  if (!capture.ok || capture.evidence.source.kind !== "git") throw new Error("not captured");
  return capture.evidence.source;
}


/** `git status --porcelain` as Git writes it, untrimmed, with each entry's index and worktree columns folded into one: what differs, not where it is staged. */
function statusApartFromStaging(cwd: string): string[] {
  const raw = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" });
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => `${line.slice(0, 2).replace(/ /g, "")} ${line.slice(3)}`)
    .sort();
}

/** Every file under `root` but Git's own, by path, as bytes. */
function filesOf(root: string, under = ""): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  for (const name of readdirSync(join(root, under))) {
    if (under === "" && name === ".git") continue;
    const path = under === "" ? name : `${under}/${name}`;
    if (statSync(join(root, path)).isDirectory()) for (const [inner, bytes] of filesOf(root, path)) found.set(inner, bytes);
    else found.set(path, readFileSync(join(root, path)));
  }
  return found;
}

/** Is `path` the directory `container` or inside it? */
function inside(path: string, container: string): boolean {
  const between = relative(container, path);
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}

describe("an isolated member's copy (EO-867, EO-872)", () => {
  it("is the item's worktree exactly: its HEAD, its uncommitted changes uncommitted, its untracked files untracked, and no commit of EO's", async () => {
    const { repo, worktree, copies } = itemWorktree();
    // An added file the item's index tracks and HEAD does not.
    writeFileSync(join(worktree, "added.ts"), "export const added = true;\n");
    git(worktree, "add", "added.ts");
    const source = await captured(worktree);
    const objectsBefore = git(repo, "rev-list", "--all").split("\n").sort();

    const made = await makeMemberCopy(worktree, item.key, source, "attempt-a", copies);
    if (!made.ok) throw new Error(made.problem);
    const copy = made.copy.cwd;

    expect(git(copy, "rev-parse", "HEAD")).toBe(git(worktree, "rev-parse", "HEAD"));
    expect(git(copy, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(git(copy, "log", "--format=%H", "main..HEAD")).toBe(git(worktree, "log", "--format=%H", "main..eo/EO-1"));
    expect(git(copy, "log", "--format=%H")).toBe(git(worktree, "log", "--format=%H"));
    // Committed, modified, deleted, added and untracked — as the item has them, staging apart.
    expect(statusApartFromStaging(copy)).toEqual(statusApartFromStaging(worktree));
    expect(statusApartFromStaging(copy)).toEqual(["?? notes.md", "A added.ts", "D old.ts", "M export.ts"]);
    expect(filesOf(copy)).toEqual(filesOf(worktree));
    // No commit was made for it: the repository reaches exactly what it did.
    expect(git(repo, "rev-list", "--all").split("\n").sort()).toEqual(objectsBefore);
    expect(git(repo, "log", "--all", "--format=%an %s")).not.toContain("team member");
  }, 30_000);

  it("says nothing changed of a member that changed nothing, however dirty the item it was handed", async () => {
    const { worktree, copies } = itemWorktree();
    const made = await makeMemberCopy(worktree, item.key, await captured(worktree), "attempt-a", copies);
    if (!made.ok) throw new Error(made.problem);
    expect(git(worktree, "status", "--porcelain")).not.toBe("");
    expect(await made.copy.changes()).toEqual([]);
  }, 30_000);

  it("lives outside every checkout and git directory, beside the items' worktrees, and is a worktree of the item's repository", async () => {
    const { root, repo, worktree, copies } = itemWorktree();
    const made = await makeMemberCopy(worktree, item.key, await captured(worktree), "attempt-a", copies);
    if (!made.ok) throw new Error(made.problem);
    const copy = made.copy.cwd;
    expect(copy).toBe(join(root, "team-copies", "EO-1", "attempt-a"));
    const containers = [repo, worktree, join(repo, ".git"), git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")];
    for (let directory = copy; dirname(directory) !== directory; directory = dirname(directory)) {
      for (const container of containers) expect(inside(directory, container), `${directory} is inside ${container}`).toBe(false);
    }
    expect(git(copy, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    expect(git(repo, "worktree", "list")).toContain(copy);
  }, 30_000);

  it("keeps whatever a member writes, commits and resets to its own copy: the item's worktree, branch, a sibling's copy and the remote are untouched", async () => {
    const { repo, remote, worktree, copies } = itemWorktree();
    const source = await captured(worktree);
    const mine = await makeMemberCopy(worktree, item.key, source, "attempt-a", copies);
    const sibling = await makeMemberCopy(worktree, item.key, source, "attempt-b", copies);
    if (!mine.ok || !sibling.ok) throw new Error("no copies");
    expect(mine.copy.cwd).not.toBe(sibling.copy.cwd);

    const branchBefore = git(repo, "rev-parse", "refs/heads/eo/EO-1");
    const mainBefore = git(repo, "rev-parse", "refs/heads/main");
    const remoteBefore = git(remote, "for-each-ref");
    const itemStatusBefore = git(worktree, "status", "--porcelain");
    const itemFile = readFileSync(join(worktree, "export.ts"), "utf8");
    const siblingHead = git(sibling.copy.cwd, "rev-parse", "HEAD");

    // The member works: commits what it was handed, adds a file, resets back, writes again.
    const copy = mine.copy.cwd;
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
    expect(git(sibling.copy.cwd, "status", "--porcelain")).toBe(itemStatusBefore);
    expect(readFileSync(join(sibling.copy.cwd, "export.ts"), "utf8")).toBe("export const csv = true; // and headers\n");

    // What it did against what it was handed is said, then the copy goes — and only it.
    // `reset --hard` brought back `old.ts` and took the committed `notes.md` with it.
    expect(await mine.copy.changes()).toEqual(["1 file changed: `export.ts`", "3 files added: `fix.ts`, `old.ts`, `scratch.ts`", "1 file deleted: `notes.md`"]);
    await mine.copy.remove();
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(sibling.copy.cwd)).toBe(true);
    expect(git(repo, "worktree", "list")).not.toContain("attempt-a");
  }, 30_000);

  it("says the branches, tags and stash entries a member left in the shared repository, and deletes the branches and tags it made under new names", async () => {
    const { repo, worktree, copies } = itemWorktree();
    git(repo, "branch", "side", "main");
    const sideBefore = git(repo, "rev-parse", "refs/heads/side");
    const made = await makeMemberCopy(worktree, item.key, await captured(worktree), "attempt-a", copies);
    if (!made.ok) throw new Error(made.problem);
    const copy = made.copy.cwd;

    gitAs(made.copy, copy, "stash", "push", "-q", "-u", "-m", "member-stash");
    gitAs(made.copy, copy, "checkout", "-q", "-b", "review/try");
    gitAs(made.copy, copy, "tag", "review-tag");
    gitAs(made.copy, copy, "branch", "-f", "side", "HEAD");
    const stashed = git(repo, "rev-parse", "refs/stash");
    const at = git(copy, "rev-parse", "HEAD").slice(0, 12);

    const said = await made.copy.changes();
    expect(said).toContain(`in the repository it shares with the item, branch \`review/try\` was created at ${at} since its attempt started, by this member, and EO deletes it with the copy`);
    expect(said).toContain(`in the repository it shares with the item, tag \`review-tag\` was created at ${at} since its attempt started, by this member, and EO deletes it with the copy`);
    expect(said).toContain(`in the repository it shares with the item, branch \`side\` moved from ${sideBefore.slice(0, 12)} to ${at} since its attempt started`);
    expect(said).toContain(`a stash entry ${stashed.slice(0, 12)} (\`On (no branch): member-stash\`) was pushed since its attempt started, and EO left it: the stash is shared with every worktree`);

    await made.copy.remove();
    expect(git(repo, "branch", "--list", "review/try")).toBe("");
    expect(git(repo, "tag", "--list", "review-tag")).toBe("");
    // Moved, not made: left where the member put it, and said. The stash entry stays.
    expect(git(repo, "rev-parse", "refs/heads/side")).not.toBe(sideBefore);
    expect(git(repo, "rev-parse", "refs/stash")).toBe(stashed);
  }, 30_000);

  it("deletes no ref another member or the person made while its attempt ran: two members at once each take only their own", async () => {
    const { repo, worktree, copies } = itemWorktree();
    const source = await captured(worktree);
    const a = await makeMemberCopy(worktree, item.key, source, "attempt-a", copies);
    const b = await makeMemberCopy(worktree, item.key, source, "attempt-b", copies);
    if (!a.ok || !b.ok) throw new Error("no copies");

    gitAs(a.copy, a.copy.cwd, "tag", "a-tag");
    gitAs(b.copy, b.copy.cwd, "tag", "b-tag");
    gitAs(b.copy, b.copy.cwd, "branch", "b-branch");
    // The person, in their own checkout, while both members work.
    git(repo, "branch", "persons-branch", "main");
    git(repo, "tag", "persons-tag", "main");

    const said = (await a.copy.changes()).join("; ");
    expect(said).toContain("tag `a-tag` was created at");
    expect(said).toMatch(/tag `b-tag` was created at [0-9a-f]{12} since its attempt started, and EO left it, since not every write to it was this member's/);
    expect(said).toMatch(/branch `persons-branch` was created at [0-9a-f]{12} since its attempt started, and EO left it, since not every write to it was this member's/);

    // A finishes first: its own tag goes, and nothing of B's or the person's.
    await a.copy.remove();
    const refs = () => git(repo, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags").split("\n");
    expect(refs()).not.toContain("refs/tags/a-tag");
    expect(refs()).toEqual(expect.arrayContaining(["refs/tags/b-tag", "refs/heads/b-branch", "refs/heads/persons-branch", "refs/tags/persons-tag"]));

    // Then B: its own go, and the person's stay.
    await b.copy.remove();
    expect(refs()).not.toContain("refs/tags/b-tag");
    expect(refs()).not.toContain("refs/heads/b-branch");
    expect(refs()).toEqual(expect.arrayContaining(["refs/heads/persons-branch", "refs/tags/persons-tag"]));
  }, 30_000);

  it("deletes on a sweep the refs a member made and alone wrote to, and keeps one the person has written to since", async () => {
    const { repo, worktree, copies } = itemWorktree();
    const handle = openMigratedTestDb();
    try {
      createWorkspace(handle.db, { config: { name: "shop", repoPath: repo } });
      const made = await makeMemberCopy(worktree, item.key, await captured(worktree), "attempt-a", copies);
      if (!made.ok) throw new Error(made.problem);
      gitAs(made.copy, made.copy.cwd, "branch", "review/left");
      gitAs(made.copy, made.copy.cwd, "branch", "review/taken-up");
      // After the crash, before the sweep: the person builds on one of them.
      git(repo, "branch", "-f", "review/taken-up", "main");
      const said: string[] = [];
      await releaseMemberCopies(handle.db, { item, report: (_attemptId, changed) => said.push(...changed) }, copies);
      expect(existsSync(made.copy.cwd)).toBe(false);
      expect(said.join("; ")).toContain("branch `review/left` was created at");
      expect(said.join("; ")).toMatch(/branch `review\/left` was created at [0-9a-f]{12} since its attempt started, by this member, and EO deletes it with the copy/);
      expect(said.join("; ")).toMatch(/branch `review\/taken-up` was created at [0-9a-f]{12} since its attempt started, and EO left it, since not every write to it was this member's/);
      expect(git(repo, "branch", "--list", "review/left")).toBe("");
      expect(git(repo, "branch", "--list", "review/taken-up")).not.toBe("");
    } finally {
      handle.close();
    }
  }, 30_000);

  it("has the item's new files as the capture classified them, whatever the item stages or unstages afterwards", async () => {
    const { worktree, copies } = itemWorktree();
    writeFileSync(join(worktree, "added.ts"), "export const added = true;\n");
    git(worktree, "add", "added.ts");
    const source = await captured(worktree);
    expect(source.added).toEqual(["added.ts"]);
    // After the capture: the untracked file staged, the added one unstaged.
    git(worktree, "add", "notes.md");
    git(worktree, "rm", "-q", "--cached", "added.ts");
    const made = await makeMemberCopy(worktree, item.key, source, "attempt-a", copies);
    if (!made.ok) throw new Error(made.problem);
    expect(statusApartFromStaging(made.copy.cwd)).toEqual(["?? notes.md", "A added.ts", "D old.ts", "M export.ts"]);
  }, 30_000);

  it("says a moved HEAD, and the sweep removes every copy but the ones still at work — in the new place and the old — saying what was changed in each first", async () => {
    const { repo, worktree, copies } = itemWorktree();
    const handle = openMigratedTestDb();
    try {
      createWorkspace(handle.db, { config: { name: "shop", repoPath: repo } });
      const source = await captured(worktree);
      const live = await makeMemberCopy(worktree, item.key, source, "attempt-live", copies);
      const left = await makeMemberCopy(worktree, item.key, source, "attempt-left", copies);
      if (!live.ok || !left.ok) throw new Error("no copies");
      writeFileSync(join(left.copy.cwd, "a.ts"), "a\n");
      git(left.copy.cwd, "add", "-A");
      git(left.copy.cwd, "commit", "-qm", "moved");
      expect((await inspectCopy(left.copy.cwd)).join("; ")).toMatch(/HEAD moved from [0-9a-f]{12} to [0-9a-f]{12}/);

      // A copy made before EO-872, where they lived then: a commit of the captured tree, under the git directory.
      const legacy = join(repo, ".git", "eo-team-copies", "EO-1", "attempt-old");
      mkdirSync(dirname(legacy), { recursive: true });
      const wrapped = git(repo, "commit-tree", source.tree, "-p", source.head!, "-m", "EO: what a team member of EO-1 works on");
      git(repo, "worktree", "add", "-q", "--detach", legacy, wrapped);
      writeFileSync(join(git(legacy, "rev-parse", "--absolute-git-dir"), "eo-team-copy.json"), JSON.stringify({ commit: wrapped, attemptId: "attempt-old" }));
      writeFileSync(join(legacy, "b.ts"), "b\n");
      expect((await listMemberCopies(repo, copies)).map((one) => one.attemptId).sort()).toEqual(["attempt-left", "attempt-live", "attempt-old"]);

      const said: { attemptId: string; changed: string[] }[] = [];
      const removed = await releaseMemberCopies(handle.db, { keep: (attemptId) => attemptId === "attempt-live", report: (attemptId, changed) => said.push({ attemptId, changed }) }, copies);
      expect(removed.sort()).toEqual([legacy, left.copy.cwd].sort());
      expect(said.map((one) => one.attemptId).sort()).toEqual(["attempt-left", "attempt-old"]);
      expect(said.find((one) => one.attemptId === "attempt-old")?.changed).toEqual(["1 file added: `b.ts`"]);
      expect((await listMemberCopies(repo, copies)).map((one) => one.attemptId)).toEqual(["attempt-live"]);

      // An item's own release takes what is left of its copies.
      await releaseMemberCopies(handle.db, { item, report: () => undefined }, copies);
      expect(await listMemberCopies(repo, copies)).toEqual([]);
      expect(git(repo, "worktree", "list")).not.toContain("attempt-");
    } finally {
      handle.close();
    }
  }, 30_000);
});
