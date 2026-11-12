import { gitStateOf } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Item } from "@eo/core";
import type { DbHandle } from "../../../db/client.js";
import { addDependency, asGitWorkspace, postComment, updateWorkspace, type GitWorkspace } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import type { CliRunner } from "../forge/cli.js";
import type { RemoteRefResolution, RemoteRefResolver } from "./remoteRef.js";
import { setBranchPrefix } from "./branchPrefix.js";
import { baseRefFor, branchFor, resolveItemStackTarget } from "./stackTarget.js";
import { itemBranchName } from "./workName.js";

/**
 * A recorded `gh` runner — same JSON shape `dispatchWorkspace.test.ts`
 * and `sender.test.ts` use.
 */
function forgeRunnerFor(states: Record<string, "OPEN" | "MERGED" | "CLOSED">): CliRunner {
  return async (_cli, args) => {
    const branch = args[args.indexOf("--head") + 1];
    const state = branch ? states[branch] : undefined;
    if (!state) return { ok: true, stdout: "[]", error: "", notFound: false };
    return { ok: true, stdout: JSON.stringify([{ url: "https://github.com/acme/api/pull/1", state }]), error: "", notFound: false };
  };
}

let handle: DbHandle;
let repository: GitWorkspace;

beforeEach(() => {
  handle = openMigratedTestDb();
  repository = attachWorkspace(handle.db, { name: "the repo", keyPrefix: "EO", repoPath: "/does/not/matter", baseBranch: "main" });
  // The update keeps the row's kind, so what comes back is the same
  // repository; the fallback is unreachable (EO-299).
  repository = asGitWorkspace(updateWorkspace(handle.db, repository.id, { config: { forgeKind: "github" } })) ?? repository;
});

afterEach(() => {
  handle.close();
});

/**
 * EO-16: a same-feature dependency's branch must come from its own
 * stored `item.branch`, never recomputed from `dep.key`/its Jira key
 * — a dependency linked to Jira after its branch was already cut keeps
 * that branch for its lifetime (EO-14's pinned decision), and stacking
 * must keep targeting it.
 */
describe("resolveItemStackTarget / branchFor — dependency branch resolution (EO-16)", () => {
  it("targets a same-feature dependency's stored branch, not one recomputed from its (now-set) jiraKey", async () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
    const dependency = createTestItem(handle.db, {
      type: "story",
      title: "Dependency",
      stepId: "todo",
      workspaceId: repository.id,
      parentId: feature.id,
      // Cut under the old prefix, before this dependency had a Jira link.
      git: { branch: "eo-prefix/EO-9" },
      // Linked to Jira after the branch already existed.
      jiraKey: "KAN-99",
    });
    const dependent = createTestItem(handle.db, { type: "story", title: "Dependent", stepId: "todo", workspaceId: repository.id, parentId: feature.id });
    addDependency(handle.db, dependent.id, dependency.id);

    // The runner only recognises the *stored* branch name. If either
    // function recomputed a jiraKey-based name instead, the lookup would
    // miss and the dependency would be (wrongly) treated as merged.
    const runner = forgeRunnerFor({ "eo-prefix/EO-9": "OPEN" });
    const decision = await resolveItemStackTarget(handle.db, repository, dependent, runner);

    expect(decision.kind).toBe("stack");
    if (decision.kind !== "stack") return;
    expect(gitStateOf(decision.dependency).branch).toBe("eo-prefix/EO-9");
    expect(branchFor(decision, repository)).toBe("eo-prefix/EO-9");
  });

  it("escalates rather than treating the dependency as merged, proving the merge-state lookup used the stored branch", async () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
    const dependency = createTestItem(handle.db, {
      type: "story",
      title: "Dependency",
      stepId: "todo",
      workspaceId: repository.id,
      parentId: feature.id,
      git: { branch: "eo-prefix/EO-9" },
      jiraKey: "KAN-99",
    });
    const dependent = createTestItem(handle.db, { type: "story", title: "Dependent", stepId: "todo", workspaceId: repository.id, parentId: feature.id });
    addDependency(handle.db, dependent.id, dependency.id);

    // Only a jiraKey-based name ("eo-prefix/KAN-99" or similar) answers
    // CLOSED here — the stored branch is unrecognised by this runner, so
    // a correct lookup falls through to the git fallback (open) rather
    // than tripping the closed-dependency escalation.
    const runner = forgeRunnerFor({ "eo-prefix/KAN-99": "CLOSED" });
    const decision = await resolveItemStackTarget(handle.db, repository, dependent, runner);

    expect(decision.kind).not.toBe("escalate");
  });

  it("falls back to computing a branch only when a dependency has no stored branch yet", async () => {
    // Pinned: the default prefix comes from the machine's git email.
    setBranchPrefix(handle.db, "eo");
    const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
    const dependency = createTestItem(handle.db, {
      type: "story",
      title: "Dependency",
      stepId: "todo",
      workspaceId: repository.id,
      parentId: feature.id,
      // Not yet dispatched — nothing stored yet.
    });
    const dependent = createTestItem(handle.db, { type: "story", title: "Dependent", stepId: "todo", workspaceId: repository.id, parentId: feature.id });
    addDependency(handle.db, dependent.id, dependency.id);

    const runner = forgeRunnerFor({ [`eo/${dependency.key}`]: "OPEN" });
    const decision = await resolveItemStackTarget(handle.db, repository, dependent, runner);

    expect(decision.kind).toBe("stack");
    if (decision.kind !== "stack") return;
    expect(branchFor(decision, repository)).toBe(`eo/${dependency.key}`);
  });

  it("computes an undispatched dependency's branch the way dispatch will cut it: Reference, EO key and the configured prefix (EO-638)", async () => {
    setBranchPrefix(handle.db, "feat");
    const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id, git: { reference: "PROJ-123" } });
    const dependency = createTestItem(handle.db, { type: "story", title: "Dependency", stepId: "todo", workspaceId: repository.id, parentId: feature.id });
    const dependent = createTestItem(handle.db, { type: "story", title: "Dependent", stepId: "todo", workspaceId: repository.id, parentId: feature.id });
    addDependency(handle.db, dependent.id, dependency.id);
    const expected = `feat/PROJ-123-${dependency.key}`;
    expect(await itemBranchName(handle.db, dependency)).toBe(expected);

    // An unrelated branch under the bare key says MERGED. Asking it would
    // read the dependency as merged and stack on nothing; the lookup has
    // to ask for the name dispatch would cut, which is still open.
    const asked: string[] = [];
    const states = forgeRunnerFor({ [expected]: "OPEN", [`eo/${dependency.key}`]: "MERGED", [`feat/${dependency.key}`]: "MERGED" });
    const runner: CliRunner = async (cli, args, cwd) => {
      asked.push(args[args.indexOf("--head") + 1] ?? "");
      return states(cli, args, cwd);
    };
    const decision = await resolveItemStackTarget(handle.db, repository, dependent, runner);

    expect(asked).toContain(expected);
    expect(asked).not.toContain(`eo/${dependency.key}`);
    expect(decision.kind).toBe("stack");
    if (decision.kind !== "stack") return;
    expect(branchFor(decision, repository)).toBe(expected);
  });

  it("still takes a dependency's stored branch over its Reference (EO-638)", async () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id, git: { reference: "PROJ-123" } });
    const dependency = createTestItem(handle.db, { type: "story", title: "Dependency", stepId: "todo", workspaceId: repository.id, parentId: feature.id, git: { branch: "eo/EO-9" } });
    const dependent = createTestItem(handle.db, { type: "story", title: "Dependent", stepId: "todo", workspaceId: repository.id, parentId: feature.id });
    addDependency(handle.db, dependent.id, dependency.id);

    const decision = await resolveItemStackTarget(handle.db, repository, dependent, forgeRunnerFor({ "eo/EO-9": "OPEN" }));

    expect(decision.kind).toBe("stack");
    if (decision.kind !== "stack") return;
    expect(branchFor(decision, repository)).toBe("eo/EO-9");
  });

  it("targets the repository's base branch when there is no same-feature dependency", async () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
    const dependent = createTestItem(handle.db, { type: "story", title: "Dependent", stepId: "todo", workspaceId: repository.id, parentId: feature.id });

    const decision = await resolveItemStackTarget(handle.db, repository, dependent);

    expect(decision).toEqual({ kind: "base" });
    if (decision.kind !== "base") return;
    expect(branchFor(decision, repository)).toBe("main");
  });
});

/**
 * Two unmerged dependencies at once, end to end: what EO can work out
 * for itself, and what it asks a person — and, crucially, that the
 * answer to what it asks is read back rather than the same question
 * being posted again.
 */
describe("resolveItemStackTarget — more than one unmerged dependency", () => {
  const openRunner = forgeRunnerFor({ "eo/A": "OPEN", "eo/B": "OPEN", "eo/C": "OPEN" });

  /** A feature with three stories on branches the runner knows about. */
  function feature() {
    const parent = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
    const common = { type: "story" as const, stepId: "todo", workspaceId: repository.id, parentId: parent.id };
    return {
      a: createTestItem(handle.db, { ...common, title: "A", git: { branch: "eo/A" } }),
      b: createTestItem(handle.db, { ...common, title: "B", git: { branch: "eo/B" } }),
      c: createTestItem(handle.db, { ...common, title: "C", git: { branch: "eo/C" } }),
    };
  }

  function askedAndAnswered(item: Item, answer: string): void {
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "escalation",
      body: "which one?",
      options: ["A", "B"],
      mentions: [{ type: "human" }],
    });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: answer });
  }

  it("stacks on the dependency that already builds on the other, without asking anyone", async () => {
    // C depends on A and B; B depends on A. B's branch was cut from A's,
    // so stacking C on B stacks it on both — a chain, not a tie.
    const { a, b, c } = feature();
    addDependency(handle.db, c.id, a.id);
    addDependency(handle.db, c.id, b.id);
    addDependency(handle.db, b.id, a.id);

    const decision = await resolveItemStackTarget(handle.db, repository, c, openRunner);

    expect(decision.kind).toBe("stack");
    if (decision.kind !== "stack") return;
    expect(branchFor(decision, repository)).toBe("eo/B");
  });

  it("asks, naming the dependencies as the answers, when they are genuine siblings", async () => {
    const { a, b, c } = feature();
    addDependency(handle.db, c.id, a.id);
    addDependency(handle.db, c.id, b.id);

    const decision = await resolveItemStackTarget(handle.db, repository, c, openRunner);

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.choices.map((choice) => choice.key)).toEqual([a.key, b.key]);
  });

  it("stacks on the dependency a person picked, instead of asking again", async () => {
    // The whole point: answering "EO-32" and being handed the identical
    // escalation back is the behaviour this replaces.
    const { a, b, c } = feature();
    addDependency(handle.db, c.id, a.id);
    addDependency(handle.db, c.id, b.id);
    askedAndAnswered(c, b.key);

    const decision = await resolveItemStackTarget(handle.db, repository, c, openRunner);

    expect(decision.kind).toBe("stack");
    if (decision.kind !== "stack") return;
    expect(branchFor(decision, repository)).toBe("eo/B");
  });

  it("cuts from a branch a person named instead of either dependency", async () => {
    const { a, b, c } = feature();
    addDependency(handle.db, c.id, a.id);
    addDependency(handle.db, c.id, b.id);
    askedAndAnswered(c, "release/24.3");

    const decision = await resolveItemStackTarget(handle.db, repository, c, openRunner, async (_repo, ref) => ref === "release/24.3");

    expect(decision).toEqual({ kind: "branch", branch: "release/24.3" });
    if (decision.kind !== "branch") return;
    expect(branchFor(decision, repository)).toBe("release/24.3");
  });

  it("asks again, quoting the reply, when the branch a person named does not exist", async () => {
    const { a, b, c } = feature();
    addDependency(handle.db, c.id, a.id);
    addDependency(handle.db, c.id, b.id);
    askedAndAnswered(c, "release/typo");

    const decision = await resolveItemStackTarget(handle.db, repository, c, openRunner, async () => false);

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toContain("release/typo");
    expect(decision.reason).toContain("no branch or ref");
  });
});

/**
 * `baseRefFor` — the ref a decision actually resolves to, as opposed to
 * the branch it names.
 *
 * The resolver is injected rather than hitting a real remote: what these
 * assert is the *policy* around a resolution, not git's behaviour, which
 * `remoteRef.test.ts` covers against a real bare remote.
 */
describe("baseRefFor — the remote is the authority", () => {
  const resolver = (answers: Record<string, RemoteRefResolution>): RemoteRefResolver => {
    return async (_repoPath, _remote, branch) => answers[branch] ?? { kind: "unresolved", problem: `no ${branch}` };
  };

  it("resolves the base branch to the remote-tracking ref, not the local branch", async () => {
    const resolved = await baseRefFor({ kind: "base" }, repository, resolver({ main: { kind: "remote", ref: "origin/main" } }));

    expect(resolved).toEqual({ ok: true, value: "origin/main" });
  });

  it("resolves a stacked dependency's branch on the remote too", async () => {
    // A dependency that is being stacked on has an open MR, so its branch
    // is pushed — and its remote tip is the one its own reviewer is
    // looking at, while the local ref may predate a force-push.
    const dependency = createTestItem(handle.db, { type: "story", title: "Dependency", stepId: "review", workspaceId: repository.id, git: { branch: "eo/EO-9" } });

    const resolved = await baseRefFor({ kind: "stack", dependency, branch: "eo/EO-9" }, repository, resolver({ "eo/EO-9": { kind: "remote", ref: "origin/eo/EO-9" } }));

    expect(resolved).toEqual({ ok: true, value: "origin/eo/EO-9" });
  });

  it("falls back to a stacked dependency's local branch when it has not been pushed yet", async () => {
    // Not an error: a dependency whose branch exists only here is a
    // normal state, and its local branch is then the only account of it.
    const dependency = createTestItem(handle.db, { type: "story", title: "Dependency", stepId: "todo", workspaceId: repository.id, git: { branch: "eo/EO-9" } });

    const resolved = await baseRefFor({ kind: "stack", dependency, branch: "eo/EO-9" }, repository, resolver({}));

    expect(resolved).toEqual({ ok: true, value: "eo/EO-9" });
  });

  it("refuses rather than cutting from a local base branch that may be behind", async () => {
    const resolved = await baseRefFor({ kind: "base" }, repository, resolver({}));

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain("main");
    expect(resolved.reason).toContain(repository.config.forgeRemote);
  });

  it("uses the local branch when the repository has no remote", async () => {
    const resolved = await baseRefFor({ kind: "base" }, repository, async () => ({ kind: "no-remote" }));

    expect(resolved).toEqual({ ok: true, value: "main" });
  });
});

/**
 * A base a person set on the item (EO-364): it wins over stacking, costs
 * no forge lookup to find out, and is refused — naming the branch and the
 * remote — when the remote does not have it.
 */
describe("a base branch set on the item", () => {
  it("is the target, without asking the forge about any dependency", async () => {
    const parent = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
    const common = { type: "story" as const, stepId: "todo", workspaceId: repository.id, parentId: parent.id };
    const open = createTestItem(handle.db, { ...common, title: "Open", git: { branch: "eo/A" } });
    const named = createTestItem(handle.db, { ...common, title: "Named", git: { baseBranch: "release/2.4" } });
    addDependency(handle.db, named.id, open.id);

    let asked = 0;
    const runner: CliRunner = async (...args) => {
      asked += 1;
      return forgeRunnerFor({ "eo/A": "OPEN" })(...args);
    };

    const decision = await resolveItemStackTarget(handle.db, repository, named, runner);

    expect(decision).toEqual({ kind: "named-base", branch: "release/2.4" });
    expect(asked).toBe(0);
    expect(branchFor({ kind: "named-base", branch: "release/2.4" }, repository)).toBe("release/2.4");
  });

  it("resolves on the remote, like the repository's base", async () => {
    const resolved = await baseRefFor({ kind: "named-base", branch: "release/2.4" }, repository, async (_path, remote, branch) => ({
      kind: "remote",
      ref: `${remote}/${branch}`,
    }));

    expect(resolved).toEqual({ ok: true, value: `${repository.config.forgeRemote}/release/2.4` });
  });

  it("refuses, naming the branch and the remote, rather than falling back to a local copy", async () => {
    const resolved = await baseRefFor({ kind: "named-base", branch: "release/2.4" }, repository, async (_path, remote, branch) => ({
      kind: "unresolved",
      problem: `\`${remote}\` has no branch \`${branch}\`.`,
    }));

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain("`release/2.4`");
    expect(resolved.reason).toContain(`\`${repository.config.forgeRemote}\``);
    expect(resolved.reason).toContain("No branch or worktree was created");
  });

  it("refuses a tracking ref this call could not refresh, which is what a branch deleted upstream leaves", async () => {
    const resolved = await baseRefFor({ kind: "named-base", branch: "release/2.4" }, repository, async (_path, remote, branch) => ({
      kind: "remote",
      ref: `${remote}/${branch}`,
      unconfirmed: "fatal: couldn't find remote ref release/2.4",
    }));

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain("`release/2.4`");
    expect(resolved.reason).toContain(`\`${repository.config.forgeRemote}\``);
    expect(resolved.reason).toContain("couldn't find remote ref");
  });

  it("leaves the repository's own base accepting an unrefreshed tracking ref, as before", async () => {
    const resolved = await baseRefFor({ kind: "base" }, repository, async (_path, remote, branch) => ({
      kind: "remote",
      ref: `${remote}/${branch}`,
      unconfirmed: "unreachable",
    }));

    expect(resolved).toEqual({ ok: true, value: `${repository.config.forgeRemote}/main` });
  });

  it("refuses, naming the branch and the remote, when the repository has no such remote — never falling back to a local branch", async () => {
    const resolved = await baseRefFor({ kind: "named-base", branch: "release/2.4" }, repository, async () => ({ kind: "no-remote" }));

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain("`release/2.4`");
    expect(resolved.reason).toContain(`\`${repository.config.forgeRemote}\``);
    expect(resolved.reason).toContain("No branch or worktree was created");
  });
});
