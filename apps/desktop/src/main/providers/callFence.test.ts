import { describe, expect, it } from "vitest";
import type { CallFence } from "@eo/core";
import { fencedCall, patchTargets, shellRefusal, simpleCommands } from "./callFence.js";

const ROOT = "/home/me/.eo/worktrees/EO-1";
const IMPLEMENTER: CallFence = { root: ROOT, pushBranch: "eo/EO-1" };
const REVIEWER: CallFence = { root: ROOT, pushBranch: null };

const ruleOf = (command: string, fence: CallFence = IMPLEMENTER) => shellRefusal(command, fence)?.rule ?? null;

describe("the fence's push rules (EO-926)", () => {
  it.each([
    "git push --force-with-lease",
    "git push --force-with-lease origin",
    "git push --force-with-lease origin eo/EO-1",
    "git push --force-with-lease origin HEAD",
    "git push --force-with-lease origin HEAD:eo/EO-1",
    "git push --force-with-lease origin HEAD:refs/heads/eo/EO-1",
    "git push --force-with-lease=eo/EO-1:abc123 origin eo/EO-1",
    "git push --force-with-lease --force-if-includes -u origin eo/EO-1",
    "git fetch origin && git rebase origin/main && git push --force-with-lease 2>&1",
    "cd /home/me/.eo/worktrees/EO-1 && git push --force-with-lease origin eo/EO-1 | tail -5",
    "GIT_TRACE=1 git push --force-with-lease",
    "git status; git log --oneline -3",
    "echo 'git push --force'",
    "git commit -F - <<'EOF'\nDo not git push --force here\nEOF\ngit status",
  ])("lets an implementer run %s", (command) => {
    expect(ruleOf(command)).toBeNull();
  });

  it.each([
    ["git push --force", "push_forced"],
    ["git push -f origin eo/EO-1", "push_forced"],
    ["git push -uf origin eo/EO-1", "push_forced"],
    ["git push --force-with-lease --force origin eo/EO-1", "push_forced"],
    ["git push --force-with-lease origin +eo/EO-1", "push_forced"],
    ["git push origin +HEAD:eo/EO-1", "push_forced"],
    ["git push origin eo/EO-1", "push_without_lease"],
    ["git push", "push_without_lease"],
    ["git push --force-with-lease origin main", "push_elsewhere"],
    ["git push --force-with-lease origin HEAD:main", "push_elsewhere"],
    ["git push --force-with-lease origin eo/EO-1 eo/EO-2", "push_elsewhere"],
    ["git push --force-with-lease origin :eo/EO-1", "push_elsewhere"],
    ["git push --force-with-lease --all origin", "push_elsewhere"],
    ["git push --force-with-lease --tags origin", "push_elsewhere"],
    ["git push --force-with-lease --delete origin eo/EO-1", "push_elsewhere"],
    ["git -C /elsewhere push --force-with-lease", "push_elsewhere"],
    ["git status && git push --force origin eo/EO-1", "push_forced"],
    ["bash -lc 'git push --force origin eo/EO-1'", "push_forced"],
    ['sh -c "cd x; git push -f"', "push_forced"],
    ["env GIT_SSH_COMMAND=ssh /usr/bin/git push --force", "push_forced"],
    ['git "push" "--force"', "push_forced"],
  ])("refuses an implementer's %s as %s", (command, rule) => {
    expect(ruleOf(command)).toBe(rule);
  });

  it.each(["git push --force-with-lease", "git push --force-with-lease origin eo/EO-1", "git push --dry-run origin eo/EO-1"])("refuses a reviewer's %s", (command) => {
    expect(ruleOf(command, REVIEWER)).toBe("push_on_review");
  });

  it.each(["gh pr merge 12 --squash", "gh -R owner/repo pr merge", "gh pr merge --auto --merge", "git status && gh pr merge"])("refuses %s on either turn", (command) => {
    expect(ruleOf(command)).toBe("pr_merge");
    expect(ruleOf(command, REVIEWER)).toBe("pr_merge");
  });

  it("lets gh's other commands through", () => {
    expect(ruleOf("gh pr view 12 --json state")).toBeNull();
    expect(ruleOf("gh pr checks 12")).toBeNull();
  });

  it("tells the agent why, and that it is EO's fence rather than a failure", () => {
    const refusal = shellRefusal("git push -f", IMPLEMENTER);
    expect(refusal).toMatchObject({ rule: "push_forced", call: "git push -f" });
    expect(refusal?.reason).toContain("--force-with-lease");
    expect(refusal?.reason).toContain("EO's fence");
    expect(shellRefusal("git push origin main", IMPLEMENTER)?.reason).toContain("eo/EO-1");
  });
});

describe("the fence's file rules (EO-926)", () => {
  it.each(["Write", "Edit", "MultiEdit"])("lets Claude's %s write inside the worktree and refuses outside it", (tool) => {
    expect(fencedCall(tool, { file_path: `${ROOT}/src/a.ts` }, IMPLEMENTER)).toBeNull();
    expect(fencedCall(tool, { file_path: "src/a.ts" }, IMPLEMENTER, ROOT)).toBeNull();
    expect(fencedCall(tool, { file_path: "/etc/hosts" }, IMPLEMENTER)).toMatchObject({ rule: "write_outside_worktree", call: "/etc/hosts" });
    expect(fencedCall(tool, { file_path: "../EO-2/a.ts" }, REVIEWER, ROOT)).toMatchObject({ rule: "write_outside_worktree", call: "/home/me/.eo/worktrees/EO-2/a.ts" });
    expect(fencedCall(tool, { file_path: `${ROOT}-other/a.ts` }, IMPLEMENTER)).toMatchObject({ rule: "write_outside_worktree" });
  });

  it("reads NotebookEdit's own field", () => {
    expect(fencedCall("NotebookEdit", { notebook_path: "/tmp/n.ipynb" }, IMPLEMENTER)?.rule).toBe("write_outside_worktree");
  });

  it("reads every file a Codex patch touches, relative to the call's directory", () => {
    const patch = (lines: string[]) => ({ command: ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n") });
    expect(fencedCall("apply_patch", patch(["*** Update File: src/a.ts", "@@", "-a", "+b"]), IMPLEMENTER, ROOT)).toBeNull();
    expect(fencedCall("apply_patch", patch(["*** Add File: src/b.ts", "+b", "*** Add File: /tmp/outside.txt", "+x"]), IMPLEMENTER, ROOT)).toMatchObject({ rule: "write_outside_worktree", call: "/tmp/outside.txt" });
    expect(fencedCall("apply_patch", patch(["*** Update File: src/a.ts", "*** Move to: ../../elsewhere.ts"]), IMPLEMENTER, ROOT)?.rule).toBe("write_outside_worktree");
    expect(fencedCall("apply_patch", { command: "not a patch" }, IMPLEMENTER, ROOT)?.rule).toBe("unreadable_patch");
  });

  it("leaves reads and other tools alone", () => {
    expect(fencedCall("Read", { file_path: "/etc/hosts" }, IMPLEMENTER)).toBeNull();
    expect(fencedCall("mcp__eo__comment", { body: "git push --force" }, IMPLEMENTER)).toBeNull();
    expect(fencedCall("Bash", { command: "cat /etc/hosts > /tmp/copy" }, IMPLEMENTER)).toBeNull();
  });
});

describe("simpleCommands", () => {
  it("splits on separators, drops redirections and heredoc bodies, and unquotes", () => {
    expect(simpleCommands(`a 'b c' "d \\"e\\"" && f | g; h 2>&1 > out.txt\ncat <<EOF\ngit push -f\nEOF\ni $(j k)`)).toEqual([
      ["a", "b c", 'd "e"'],
      ["f"],
      ["g"],
      ["h"],
      ["cat"],
      ["i"],
      ["j", "k"],
    ]);
  });

  it("reads patch targets", () => {
    expect(patchTargets("*** Begin Patch\n*** Delete File: x\n*** End Patch")).toEqual(["x"]);
  });
});
