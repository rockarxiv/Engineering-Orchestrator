import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallFence } from "@eo/core";
import { fencedCall, patchTargets, readCheckout, shellRefusal, simpleCommands, type CheckoutState, type FenceGit } from "./callFence.js";

const ROOT = "/home/me/.eo/worktrees/EO-1";
const IMPLEMENTER: CallFence = { root: ROOT, pushBranch: "eo/EO-1" };
const REVIEWER: CallFence = { root: ROOT, pushBranch: null };

/** A checkout git would describe as `state` — the item's branch with its own upstream unless a case says otherwise. */
function checkout(state: { branch?: string | null; config?: Record<string, string[]> } | null = {}): FenceGit {
  if (state === null) return { state: async () => null };
  const described: CheckoutState = {
    branch: state.branch === undefined ? "eo/EO-1" : state.branch,
    config: new Map(Object.entries(state.config ?? { "branch.eo/EO-1.merge": ["refs/heads/eo/EO-1"], "remote.origin.url": ["git@example.com:acme/app.git"] })),
  };
  return { state: async () => described };
}

const ruleOf = async (command: string, fence: CallFence = IMPLEMENTER, git: FenceGit = checkout(), cwd: string = ROOT) => (await shellRefusal(command, fence, cwd, git))?.rule ?? null;

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
    "cd packages/core && git push --force-with-lease",
    "git -C /home/me/.eo/worktrees/EO-1 push --force-with-lease",
    "GIT_TRACE=1 git push --force-with-lease",
    "git status; git log --oneline -3",
    "echo 'git push --force'",
    "echo \"\\$(git push --force)\"",
    "git commit -F - <<'EOF'\nDo not $(git push --force) here\nEOF\ngit status",
  ])("lets an implementer run %s", async (command) => {
    expect(await ruleOf(command)).toBeNull();
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
    ["git status && git push --force origin eo/EO-1", "push_forced"],
    ["bash -lc 'git push --force origin eo/EO-1'", "push_forced"],
    ['sh -c "cd x; git push -f"', "push_forced"],
    ["env GIT_SSH_COMMAND=ssh /usr/bin/git push --force", "push_forced"],
    ['git "push" "--force"', "push_forced"],
    ["echo x | xargs -n 1 git push -f", "push_forced"],
    ["timeout 30 git push -f", "push_forced"],
    ['eval "git push -f"', "push_forced"],
  ])("refuses an implementer's %s as %s", async (command, rule) => {
    expect(await ruleOf(command)).toBe(rule);
  });

  describe("wherever the command runs", () => {
    it.each([
      "cd /elsewhere && git push --force-with-lease",
      "cd /elsewhere && git push --force-with-lease origin HEAD:refs/heads/eo/EO-1",
      "cd .. && git push --force-with-lease",
      "cd - && git push --force-with-lease",
      'cd "$OTHER" && git push --force-with-lease',
      "pushd /elsewhere; git push --force-with-lease",
      "(cd /elsewhere && git push --force-with-lease)",
      "env -C /elsewhere git push --force-with-lease",
      "git -C /elsewhere push --force-with-lease",
      "git -C .. push --force-with-lease",
      "git --git-dir=/other/.git push --force-with-lease origin HEAD:refs/heads/eo/EO-1",
      "GIT_DIR=/other/.git git push --force-with-lease origin HEAD:refs/heads/eo/EO-1",
    ])("refuses an implementer's %s, which runs outside the worktree", async (command) => {
      expect(await ruleOf(command)).toBe("push_outside_worktree");
    });

    it("starts from the directory the hook says the call runs in", async () => {
      expect(await ruleOf("git push --force-with-lease", IMPLEMENTER, checkout(), "/elsewhere")).toBe("push_outside_worktree");
      expect(await ruleOf("git push --force-with-lease", IMPLEMENTER, checkout(), `${ROOT}/src`)).toBeNull();
      expect(await ruleOf(`cd ${ROOT} && git push --force-with-lease`, IMPLEMENTER, checkout(), "/elsewhere")).toBeNull();
      expect((await fencedCall("Bash", { command: "git push --force-with-lease" }, IMPLEMENTER, "/elsewhere", checkout()))?.rule).toBe("push_outside_worktree");
    });

    it("asks git about the directory the push runs in", async () => {
      const asked: string[] = [];
      const git: FenceGit = { state: async (dir) => (asked.push(dir), checkout().state(dir)) };
      await ruleOf("cd packages/core && git push --force-with-lease", IMPLEMENTER, git);
      expect(asked).toEqual([`${ROOT}/packages/core`]);
    });
  });

  describe("where git works the destination out for itself", () => {
    const remapped = checkout({ config: { "branch.eo/EO-1.merge": ["refs/heads/eo/EO-1"], "remote.origin.push": ["refs/heads/eo/EO-1:refs/heads/main"] } });

    it("refuses a push with no explicit destination where the checkout configures a push refspec, and allows a named one", async () => {
      expect(await ruleOf("git push --force-with-lease origin eo/EO-1", IMPLEMENTER, remapped)).toBe("push_unverified");
      expect(await ruleOf("git push --force-with-lease", IMPLEMENTER, remapped)).toBe("push_unverified");
      expect(await ruleOf("git push --force-with-lease origin HEAD", IMPLEMENTER, remapped)).toBe("push_unverified");
      expect(await ruleOf("git push --force-with-lease origin HEAD:refs/heads/eo/EO-1", IMPLEMENTER, remapped)).toBeNull();
    });

    it("refuses a push of the current branch when that is not the item's", async () => {
      const elsewhere = checkout({ branch: "main" });
      expect(await ruleOf("git push --force-with-lease", IMPLEMENTER, elsewhere)).toBe("push_unverified");
      expect(await ruleOf("git push --force-with-lease origin HEAD", IMPLEMENTER, elsewhere)).toBe("push_unverified");
      expect(await ruleOf("git push --force-with-lease origin eo/EO-1", IMPLEMENTER, elsewhere)).toBeNull();
      expect(await ruleOf("git push --force-with-lease", IMPLEMENTER, checkout({ branch: null }))).toBe("push_unverified");
    });

    it.each([
      [{}, null],
      [{ "push.default": ["current"] }, null],
      [{ "push.default": ["simple"], "branch.eo/EO-1.merge": ["refs/heads/eo/EO-1"] }, null],
      [{ "push.default": ["upstream"], "branch.eo/EO-1.merge": ["refs/heads/eo/EO-1"] }, null],
      [{ "push.default": ["upstream"], "branch.eo/EO-1.merge": ["refs/heads/main"] }, "push_unverified"],
      [{ "push.default": ["upstream"] }, "push_unverified"],
      [{ "branch.eo/EO-1.merge": ["refs/heads/main"] }, "push_unverified"],
      [{ "push.default": ["matching"] }, "push_unverified"],
    ])("decides a bare push by push.default and the upstream: %j", async (config, rule) => {
      expect(await ruleOf("git push --force-with-lease", IMPLEMENTER, checkout({ config }))).toBe(rule);
    });

    it("refuses every push from a checkout that mirrors or follows tags", async () => {
      expect(await ruleOf("git push --force-with-lease origin HEAD:refs/heads/eo/EO-1", IMPLEMENTER, checkout({ config: { "remote.origin.mirror": ["true"] } }))).toBe("push_elsewhere");
      expect(await ruleOf("git push --force-with-lease origin HEAD:refs/heads/eo/EO-1", IMPLEMENTER, checkout({ config: { "push.followtags": [""] } }))).toBe("push_elsewhere");
    });

    it("refuses where git cannot say", async () => {
      expect(await ruleOf("git push --force-with-lease origin HEAD:refs/heads/eo/EO-1", IMPLEMENTER, checkout(null))).toBe("push_unverified");
    });
  });

  describe("with git configured on the command line", () => {
    it.each([
      "git -c push.followTags=true push --force-with-lease origin HEAD:refs/heads/eo/EO-1",
      "git -c remote.origin.push=refs/heads/eo/EO-1:refs/heads/main push --force-with-lease origin eo/EO-1",
      "git --config-env=push.followTags=FOLLOW push --force-with-lease origin HEAD:refs/heads/eo/EO-1",
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.followTags GIT_CONFIG_VALUE_0=true git push --force-with-lease origin HEAD:refs/heads/eo/EO-1",
      "env GIT_CONFIG_PARAMETERS=\"'push.followtags=true'\" git push --force-with-lease origin HEAD:refs/heads/eo/EO-1",
      "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.followTags GIT_CONFIG_VALUE_0=true; git push --force-with-lease origin HEAD:refs/heads/eo/EO-1",
      "GIT_CONFIG_GLOBAL=/tmp/g; export GIT_CONFIG_GLOBAL; git push --force-with-lease origin HEAD:refs/heads/eo/EO-1",
      "GIT_EXEC_PATH=/tmp/x git push --force-with-lease",
    ])("refuses %s, explicit destination or not", async (command) => {
      expect(await ruleOf(command)).toBe("push_reconfigured");
    });

    it("lets variables that cannot change a push through", async () => {
      expect(await ruleOf("GIT_TRACE=1 GIT_TERMINAL_PROMPT=0 git push --force-with-lease origin HEAD:refs/heads/eo/EO-1")).toBeNull();
    });
  });

  describe("in subshells", () => {
    const ELSEWHERE = "/elsewhere";
    it.each([
      `(cd ${ROOT} && git status --short); git push --force-with-lease`,
      `(cd ${ROOT}); git push --force-with-lease origin HEAD:refs/heads/eo/EO-1`,
      `echo $(cd ${ROOT}); git push --force-with-lease`,
      `echo "\`cd ${ROOT}\`"; git push --force-with-lease`,
      `bash -c "cd ${ROOT}"; git push --force-with-lease`,
      `cd ${ROOT} | true; git push --force-with-lease`,
      `cd ${ROOT} & git push --force-with-lease`,
    ])("refuses a push left outside the worktree when only a subshell moved: %s", async (command) => {
      expect(await ruleOf(command, IMPLEMENTER, checkout(), ELSEWHERE)).toBe("push_outside_worktree");
    });

    it.each([
      `cd ${ROOT} && (git push --force-with-lease)`,
      `(cd ${ROOT} && git push --force-with-lease)`,
      `bash -c "cd ${ROOT} && git push --force-with-lease"`,
      `cd ${ROOT} && git push --force-with-lease 2>&1 | tee push.log`,
      `{ cd ${ROOT}; }; git push --force-with-lease`,
      `eval "cd ${ROOT}"; git push --force-with-lease`,
    ])("lets a push through where the shell that runs it is in the worktree: %s", async (command) => {
      expect(await ruleOf(command, IMPLEMENTER, checkout(), ELSEWHERE)).toBeNull();
    });
  });

  describe("inside substitutions", () => {
    it.each([
      ['echo "$(git push --force origin eo/EO-1)"', "push_forced"],
      ["echo \"`git push -f`\"", "push_forced"],
      ["echo $(git push -f)", "push_forced"],
      ['echo "result: $(cd x; echo "$(git push -f)")"', "push_forced"],
      ["x=$(git push -f)", "push_forced"],
      ["cat <(git push -f)", "push_forced"],
      ["cat <<EOF\n$(git push -f)\nEOF", "push_forced"],
      ["cat <<EOF\n`git push -f`\nEOF\necho done", "push_forced"],
    ])("refuses %s", async (command, rule) => {
      expect(await ruleOf(command)).toBe(rule);
    });

    it("refuses a reviewer's push and either turn's merge inside one", async () => {
      expect(await ruleOf('echo "$(git push --force-with-lease)"', REVIEWER)).toBe("push_on_review");
      for (const fence of [IMPLEMENTER, REVIEWER]) {
        expect(await ruleOf('echo "$(gh pr merge 12 --squash)"', fence)).toBe("pr_merge");
        expect(await ruleOf("echo `gh pr merge 12`", fence)).toBe("pr_merge");
      }
    });
  });

  it.each(["git push --force-with-lease", "git push --force-with-lease origin eo/EO-1", "git push --dry-run origin eo/EO-1"])("refuses a reviewer's %s", async (command) => {
    expect(await ruleOf(command, REVIEWER)).toBe("push_on_review");
  });

  it.each(["gh pr merge 12 --squash", "gh -R owner/repo pr merge", "gh pr merge --auto --merge", "git status && gh pr merge"])("refuses %s on either turn", async (command) => {
    expect(await ruleOf(command)).toBe("pr_merge");
    expect(await ruleOf(command, REVIEWER)).toBe("pr_merge");
  });

  it("lets gh's other commands through", async () => {
    expect(await ruleOf("gh pr view 12 --json state")).toBeNull();
    expect(await ruleOf("gh pr checks 12")).toBeNull();
  });

  it("tells the agent why, and that it is EO's fence rather than a failure", async () => {
    const refusal = await shellRefusal("git push -f", IMPLEMENTER, ROOT, checkout());
    expect(refusal).toMatchObject({ rule: "push_forced", call: "git push -f" });
    expect(refusal?.reason).toContain("--force-with-lease");
    expect(refusal?.reason).toContain("EO's fence");
    expect((await shellRefusal("git push origin main", IMPLEMENTER, ROOT, checkout()))?.reason).toContain("eo/EO-1");
    expect((await shellRefusal("git push --force-with-lease", IMPLEMENTER, ROOT, checkout(null)))?.reason).toContain("HEAD:refs/heads/eo/EO-1");
  });
});

describe("the fence's file rules (EO-926)", () => {
  it.each(["Write", "Edit", "MultiEdit"])("lets Claude's %s write inside the worktree and refuses outside it", async (tool) => {
    expect(await fencedCall(tool, { file_path: `${ROOT}/src/a.ts` }, IMPLEMENTER)).toBeNull();
    expect(await fencedCall(tool, { file_path: "src/a.ts" }, IMPLEMENTER, ROOT)).toBeNull();
    expect(await fencedCall(tool, { file_path: "/etc/hosts" }, IMPLEMENTER)).toMatchObject({ rule: "write_outside_worktree", call: "/etc/hosts" });
    expect(await fencedCall(tool, { file_path: "../EO-2/a.ts" }, REVIEWER, ROOT)).toMatchObject({ rule: "write_outside_worktree", call: "/home/me/.eo/worktrees/EO-2/a.ts" });
    expect(await fencedCall(tool, { file_path: `${ROOT}-other/a.ts` }, IMPLEMENTER)).toMatchObject({ rule: "write_outside_worktree" });
  });

  it("reads NotebookEdit's own field", async () => {
    expect((await fencedCall("NotebookEdit", { notebook_path: "/tmp/n.ipynb" }, IMPLEMENTER))?.rule).toBe("write_outside_worktree");
  });

  it("reads every file a Codex patch touches, relative to the call's directory", async () => {
    const patch = (lines: string[]) => ({ command: ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n") });
    expect(await fencedCall("apply_patch", patch(["*** Update File: src/a.ts", "@@", "-a", "+b"]), IMPLEMENTER, ROOT)).toBeNull();
    expect(await fencedCall("apply_patch", patch(["*** Add File: src/b.ts", "+b", "*** Add File: /tmp/outside.txt", "+x"]), IMPLEMENTER, ROOT)).toMatchObject({ rule: "write_outside_worktree", call: "/tmp/outside.txt" });
    expect((await fencedCall("apply_patch", patch(["*** Update File: src/a.ts", "*** Move to: ../../elsewhere.ts"]), IMPLEMENTER, ROOT))?.rule).toBe("write_outside_worktree");
    expect((await fencedCall("apply_patch", { command: "not a patch" }, IMPLEMENTER, ROOT))?.rule).toBe("unreadable_patch");
  });

  it("leaves reads and other tools alone", async () => {
    expect(await fencedCall("Read", { file_path: "/etc/hosts" }, IMPLEMENTER)).toBeNull();
    expect(await fencedCall("mcp__eo__comment", { body: "git push --force" }, IMPLEMENTER)).toBeNull();
    expect(await fencedCall("Bash", { command: "cat /etc/hosts > /tmp/copy" }, IMPLEMENTER, ROOT, checkout())).toBeNull();
  });
});

describe("simpleCommands", () => {
  it("splits on separators, drops redirections and quoted heredoc bodies, lists substitutions, and unquotes", () => {
    expect(simpleCommands(`a 'b c' "d \\"e\\"" && f | g; h 2>&1 > out.txt\ncat <<'EOF'\ngit push -f\nEOF\ni $(j k)`)).toEqual([
      ["a", "b c", 'd "e"'],
      ["f"],
      ["g"],
      ["h"],
      ["cat"],
      ["j", "k"],
      ["i", "$(j k)"],
    ]);
  });

  it("keeps single-quoted and escaped substitutions as text", () => {
    expect(simpleCommands(`echo '$(git push -f)' "\\$(git push -f)" \\\`git push -f\\\``)).toEqual([["echo", "$(git push -f)", "$(git push -f)", "`git", "push", "-f`"]]);
  });

  it("reads patch targets", () => {
    expect(patchTargets("*** Begin Patch\n*** Delete File: x\n*** End Patch")).toEqual(["x"]);
  });
});

/**
 * The fence against real git (EO-926 review): a push git would remap, or
 * run in another checkout, is refused, so the branches it would have
 * moved stay where they were — and the one push the fence lets through
 * updates the item's branch and nothing else.
 */
describe("the fence over a real checkout", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
  }

  function remoteBranch(remote: string, name: string): string | null {
    try {
      return git(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`);
    } catch {
      return null;
    }
  }

  it("refuses the pushes git would send to another branch, and the leased push it allows moves only the item's", async () => {
    const root = mkdtempSync(join(tmpdir(), "eo-926-fence-git-"));
    scratch.push(root);
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const other = join(root, "other");
    git(root, "init", "--bare", "-b", "main", remote);
    for (const [dir, branch] of [
      [work, "eo/EO-1"],
      [other, "other"],
    ] as const) {
      mkdirSync(dir);
      git(dir, "init", "-b", branch);
      git(dir, "config", "user.email", "eo@example.com");
      git(dir, "config", "user.name", "EO Fence");
      git(dir, "config", "commit.gpgsign", "false");
      git(dir, "remote", "add", "origin", remote);
      writeFileSync(join(dir, `${branch.replace("/", "-")}.txt`), `${branch}\n`);
      git(dir, "add", "-A");
      git(dir, "commit", "-m", branch);
      git(dir, "push", "-u", "origin", branch);
    }
    const otherAtFirst = remoteBranch(remote, "other");
    // The item's branch is rewritten locally, as after a rebase…
    git(work, "commit", "--amend", "-m", "eo/EO-1, rebased");
    // …and the checkout maps its branch onto main when pushed.
    git(work, "config", "remote.origin.push", "refs/heads/eo/EO-1:refs/heads/main");
    git(other, "commit", "--amend", "-m", "other, rewritten");

    const fence: CallFence = { root: work, pushBranch: "eo/EO-1" };
    const refused = [
      "git push --force-with-lease origin eo/EO-1",
      "git push --force-with-lease",
      "git push --force-with-lease origin HEAD",
      "cd ../other && git push --force-with-lease",
      `echo "$(git push --force origin eo/EO-1:main)"`,
    ];
    for (const command of refused) {
      const refusal = await shellRefusal(command, fence, work, readCheckout);
      expect(refusal, command).not.toBeNull();
      // Run anything the fence let through, as the agent's shell would.
      if (refusal === null) execFileSync("sh", ["-c", command], { cwd: work, stdio: "pipe" });
    }
    expect(remoteBranch(remote, "main")).toBeNull();
    expect(remoteBranch(remote, "other")).toBe(otherAtFirst);

    // The push that names its destination is let through, and moves only the item's branch.
    const allowed = "git push --force-with-lease origin HEAD:refs/heads/eo/EO-1";
    expect(await shellRefusal(allowed, fence, work, readCheckout)).toBeNull();
    execFileSync("sh", ["-c", allowed], { cwd: work, stdio: "pipe" });
    expect(remoteBranch(remote, "eo/EO-1")).toBe(git(work, "rev-parse", "HEAD"));
    expect(remoteBranch(remote, "main")).toBeNull();
    expect(remoteBranch(remote, "other")).toBe(otherAtFirst);

    // And without the remapping, the prompt's bare leased push is verified and allowed.
    git(work, "config", "--unset", "remote.origin.push");
    expect(await shellRefusal("git push --force-with-lease", fence, work, readCheckout)).toBeNull();
    expect(await shellRefusal("git push --force-with-lease", fence, other, readCheckout)).toMatchObject({ rule: "push_outside_worktree" });
  });

  /** A bare remote and a checkout of `branch` pushed to it, with signing off. */
  function pushedCheckout(root: string, remote: string, name: string, branch: string): string {
    const dir = join(root, name);
    mkdirSync(dir);
    git(dir, "init", "-b", branch);
    git(dir, "config", "user.email", "eo@example.com");
    git(dir, "config", "user.name", "EO Fence");
    git(dir, "config", "commit.gpgsign", "false");
    git(dir, "config", "tag.gpgsign", "false");
    git(dir, "remote", "add", "origin", remote);
    writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", name);
    return dir;
  }

  /** Runs, as the agent's shell would from `cwd`, every command the fence lets through, and says which it refused. */
  async function throughTheFence(commands: readonly string[], fence: CallFence, cwd: string): Promise<Record<string, string | null>> {
    const rules: Record<string, string | null> = {};
    for (const command of commands) {
      const refusal = await shellRefusal(command, fence, cwd, readCheckout);
      rules[command] = refusal?.rule ?? null;
      if (refusal === null) execFileSync("sh", ["-c", command], { cwd, stdio: "pipe" });
    }
    return rules;
  }

  it("refuses a push that configures git for itself, so no tag goes with it, and lets the same push through without the override", async () => {
    const root = mkdtempSync(join(tmpdir(), "eo-926-fence-config-"));
    scratch.push(root);
    const remote = join(root, "remote.git");
    git(root, "init", "--bare", "-b", "main", remote);
    const work = pushedCheckout(root, remote, "work", "eo/EO-1");
    git(work, "push", "-u", "origin", "eo/EO-1");
    git(work, "commit", "--amend", "-m", "work, rebased");
    git(work, "tag", "-a", "v1", "-m", "a tag push.followTags would send");
    const fence: CallFence = { root: work, pushBranch: "eo/EO-1" };
    const explicit = "git push --force-with-lease origin HEAD:refs/heads/eo/EO-1";

    const rules = await throughTheFence(
      [
        `git -c push.followTags=true push --force-with-lease origin HEAD:refs/heads/eo/EO-1`,
        `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.followTags GIT_CONFIG_VALUE_0=true ${explicit}`,
        `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.followTags GIT_CONFIG_VALUE_0=true; ${explicit}`,
        `GIT_CONFIG_PARAMETERS="'push.followtags=true'" ${explicit}`,
      ],
      fence,
      work,
    );
    expect(Object.values(rules)).toEqual(["push_reconfigured", "push_reconfigured", "push_reconfigured", "push_reconfigured"]);
    expect(remoteBranch(remote, "eo/EO-1")).not.toBe(git(work, "rev-parse", "HEAD"));
    expect(git(remote, "tag", "--list")).toBe("");

    // The same push without the override goes through, and sends no tag.
    expect(await throughTheFence([explicit], fence, work)).toEqual({ [explicit]: null });
    expect(remoteBranch(remote, "eo/EO-1")).toBe(git(work, "rev-parse", "HEAD"));
    expect(git(remote, "tag", "--list")).toBe("");
  });

  it("refuses a push from another checkout that only a subshell moved out of, so that checkout's branch is not pushed", async () => {
    const root = mkdtempSync(join(tmpdir(), "eo-926-fence-subshell-"));
    scratch.push(root);
    const remote = join(root, "remote.git");
    git(root, "init", "--bare", "-b", "trunk", remote);
    const work = pushedCheckout(root, remote, "work", "eo/EO-1");
    git(work, "push", "-u", "origin", "eo/EO-1");
    // The hook says the call runs here: another checkout, on main, whose
    // bare push goes to main.
    const outer = pushedCheckout(root, remote, "outer", "main");
    git(outer, "config", "push.default", "current");
    const fence: CallFence = { root: work, pushBranch: "eo/EO-1" };

    const rules = await throughTheFence(
      [
        `(cd ${work} && git status --short); git push --force-with-lease`,
        `echo "$(cd ${work})"; git push --force-with-lease`,
        `sh -c "cd ${work}"; git push --force-with-lease`,
        `cd ${work} | true; git push --force-with-lease`,
      ],
      fence,
      outer,
    );
    expect(Object.values(rules)).toEqual(["push_outside_worktree", "push_outside_worktree", "push_outside_worktree", "push_outside_worktree"]);
    expect(remoteBranch(remote, "main")).toBeNull();

    // Where the shell that pushes really is in the worktree, it is let through, and pushes the item's branch alone.
    git(work, "commit", "--amend", "-m", "work, rebased");
    const inside = `(cd ${work} && git push --force-with-lease)`;
    expect(await throughTheFence([inside], fence, outer)).toEqual({ [inside]: null });
    expect(remoteBranch(remote, "eo/EO-1")).toBe(git(work, "rev-parse", "HEAD"));
    expect(remoteBranch(remote, "main")).toBeNull();
  });
});
