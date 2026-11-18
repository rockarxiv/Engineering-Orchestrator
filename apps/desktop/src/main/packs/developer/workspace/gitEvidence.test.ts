import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item } from "@eo/core";
import { afterEach, describe, expect, it } from "vitest";
import type { PreparedWorkspace } from "../../../supervisor/workspaceKind.js";
import { gitEvidenceCapability } from "./gitEvidence.js";

/**
 * A repository's evidence for a team (EO-845): the working tree's own tree
 * object — committed, modified and untracked material alike — read from
 * the object store, never from the disk it was taken from.
 */

const scratch: string[] = [];
afterEach(() => {
  for (const made of scratch.splice(0)) rmSync(made, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=eo@example.com", "-c", "user.name=EO", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "eo-git-evidence-"));
  scratch.push(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "committed.txt"), "as committed\n");
  writeFileSync(join(root, "changed.txt"), "before\n");
  writeFileSync(join(root, "deleted.txt"), "gone soon\n");
  writeFileSync(join(root, ".gitignore"), "ignored.log\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "first");
  return root;
}

const item = { id: "item-1", key: "EO-1" } as Item;
const at = (cwd: string): PreparedWorkspace => ({ cwd, kind: "git-worktree", workspaceId: null }) as PreparedWorkspace;
const text = async (evidence: { read(path: string): Promise<{ ok: true; value: Buffer } | { ok: false; problem: string }> }, path: string) => {
  const read = await evidence.read(path);
  return read.ok ? read.value.toString("utf8") : null;
};

describe("git evidence", () => {
  it("captures committed, modified and untracked files, leaves ignored ones out, and names the tree rather than HEAD", async () => {
    const root = repository();
    const head = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "changed.txt"), "after, uncommitted\n");
    writeFileSync(join(root, "untracked.txt"), "never added\n");
    writeFileSync(join(root, "ignored.log"), "noise\n");
    unlinkSync(join(root, "deleted.txt"));
    const statusBefore = git(root, "status", "--porcelain");

    const captured = await gitEvidenceCapability().capture(item, at(root));
    if (!captured.ok) throw new Error(captured.problem);
    const evidence = captured.evidence;
    expect(evidence.source).toMatchObject({ kind: "git", head });
    if (evidence.source.kind !== "git") throw new Error("not git");
    expect(evidence.source.tree).not.toBe(git(root, "rev-parse", "HEAD^{tree}"));

    expect(await text(evidence, "committed.txt")).toBe("as committed\n");
    expect(await text(evidence, "changed.txt")).toBe("after, uncommitted\n");
    expect(await text(evidence, "untracked.txt")).toBe("never added\n");
    expect(await text(evidence, "ignored.log")).toBeNull();
    expect(await text(evidence, "deleted.txt")).toBeNull();
    // The repository's own index and status are untouched.
    expect(git(root, "status", "--porcelain")).toBe(statusBefore);

    // What changes on disk afterwards is not what a participant reads.
    writeFileSync(join(root, "changed.txt"), "changed again\n");
    expect(await text(evidence, "changed.txt")).toBe("after, uncommitted\n");

    const found = await evidence.search("UNCOMMITTED", { ignoreCase: true, under: "", max: 5 });
    expect(found.ok && found.value).toEqual([{ path: "changed.txt", line: 1, text: "after, uncommitted" }]);

    // Opened again from its reference — a recovery — it is the same tree.
    const reopened = await gitEvidenceCapability().open(item, at(root), evidence.source);
    if (!reopened.ok) throw new Error(reopened.problem);
    expect(await text(reopened.evidence, "changed.txt")).toBe("after, uncommitted\n");
  });

  it("captures the same tree twice from the same working tree, and a clean one as HEAD's tree", async () => {
    const root = repository();
    const first = await gitEvidenceCapability().capture(item, at(root));
    const second = await gitEvidenceCapability().capture(item, at(root));
    if (!first.ok || !second.ok) throw new Error("not captured");
    expect(first.evidence.source).toEqual(second.evidence.source);
    expect(first.evidence.source.kind === "git" && first.evidence.source.tree).toBe(git(root, "rev-parse", "HEAD^{tree}"));
  });

  it("lists a symbolic link as one and never reads through it, inside the repository or out", async () => {
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), "eo-git-evidence-outside-"));
    scratch.push(outside);
    writeFileSync(join(outside, "secret.txt"), "the secret\n");
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
    symlinkSync(outside, join(root, "escape-dir"));
    const captured = await gitEvidenceCapability().capture(item, at(root));
    if (!captured.ok) throw new Error(captured.problem);
    const listed = await captured.evidence.list("");
    expect(listed.ok && listed.value.filter((entry) => entry.path.startsWith("escape")).map((entry) => `${entry.path}:${entry.type}`)).toEqual(["escape-dir:symlink", "escape.txt:symlink"]);
    expect(await text(captured.evidence, "escape.txt")).toBeNull();
    expect(await text(captured.evidence, "escape-dir/secret.txt")).toBeNull();
    const found = await captured.evidence.search("the secret", { ignoreCase: false, under: "", max: 5 });
    expect(found.ok && found.value).toEqual([]);
  });

  it("refuses a directory outside any repository, and a tree the repository no longer holds", async () => {
    const plain = mkdtempSync(join(tmpdir(), "eo-git-evidence-plain-"));
    scratch.push(plain);
    const refused = await gitEvidenceCapability().capture(item, at(plain));
    expect(refused.ok).toBe(false);
    const root = repository();
    const missing = await gitEvidenceCapability().open(item, at(root), { kind: "git", tree: "0".repeat(40), head: null, files: 0, bytes: 0 });
    expect(!missing.ok && missing.problem).toContain("no longer in");
  });

  it("captures a repository with no commit yet", async () => {
    const root = mkdtempSync(join(tmpdir(), "eo-git-evidence-empty-"));
    scratch.push(root);
    git(root, "init", "-q");
    writeFileSync(join(root, "first.txt"), "hello\n");
    const captured = await gitEvidenceCapability().capture(item, at(root));
    if (!captured.ok) throw new Error(captured.problem);
    expect(captured.evidence.source).toMatchObject({ kind: "git", head: null, files: 1 });
    expect(await text(captured.evidence, "first.txt")).toBe("hello\n");
  });
});
