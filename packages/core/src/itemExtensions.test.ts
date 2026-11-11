import { describe, expect, it } from "vitest";
import {
  branchInGit,
  branchNameProblem,
  effectiveReference,
  effectiveReviewers,
  gitExtension,
  gitStateOf,
  isDefaultGitState,
  namedBranchOf,
  isDefaultJiraState,
  jiraExtension,
  jiraStateOf,
  NO_GIT_STATE,
  NO_ITEM_EXTENSIONS,
  NO_JIRA_STATE,
  readGitState,
  readJiraState,
  referenceProblem,
  REVIEWERS_FROM_REPOSITORY,
} from "./itemExtensions.js";

/**
 * The accessor the four Jira columns became (KAN-148).
 *
 * Its whole job is that nothing else ever reads the JSON, so what these
 * check is the two things a reader is entitled to assume: an item that
 * says nothing answers exactly as the dropped columns' defaults did, and
 * a payload that is wrong in any way still answers rather than throwing.
 */
describe("the jira extension", () => {
  it("reads an item with no extensions as one that has never been near Jira", () => {
    // `sync: true` is the load-bearing half. It was the column's default
    // since 0054, and an absent row reading as `false` would silence
    // every item on the installation at once.
    expect(jiraStateOf({ extensions: NO_ITEM_EXTENSIONS })).toEqual({ key: null, id: null, sync: true, pullPending: false });
    expect(NO_JIRA_STATE).toEqual({ key: null, id: null, sync: true, pullPending: false });
  });

  it("reads what a row holds", () => {
    expect(jiraStateOf({ extensions: { jira: { key: "KAN-7", id: "10001", sync: false, pullPending: true } } })).toEqual({
      key: "KAN-7",
      id: "10001",
      sync: false,
      pullPending: true,
    });
  });

  it("fills in a field a row was written before", () => {
    // An older payload is not a broken one. Each field defaults on its
    // own, so an extension that gains a field does not have to migrate
    // every row that predates it.
    expect(jiraStateOf({ extensions: { jira: { key: "KAN-7" } } })).toEqual({ key: "KAN-7", id: null, sync: true, pullPending: false });
  });

  it("answers with the defaults rather than throwing on something that is not this shape", () => {
    // Every caller is in the middle of doing something else — queueing a
    // push, drawing a rail, rendering an item for an agent — and none of
    // them can do anything useful with an exception about a JSON column.
    expect(readJiraState("not an object")).toEqual(NO_JIRA_STATE);
    expect(readJiraState({ key: 7 })).toEqual(NO_JIRA_STATE);
    expect(readJiraState(undefined)).toEqual(NO_JIRA_STATE);
  });

  it("knows a state that is not worth a row", () => {
    // What the migration filtered on and what the write path deletes on:
    // the absence of a row already means all of this.
    expect(isDefaultJiraState(NO_JIRA_STATE)).toBe(true);
    expect(isDefaultJiraState({ ...NO_JIRA_STATE, sync: false })).toBe(false);
    expect(isDefaultJiraState({ ...NO_JIRA_STATE, key: "KAN-7" })).toBe(false);
    expect(isDefaultJiraState({ ...NO_JIRA_STATE, id: "10001" })).toBe(false);
    expect(isDefaultJiraState({ ...NO_JIRA_STATE, pullPending: true })).toBe(false);
  });

  it("builds the map back the same way it reads it", () => {
    expect(jiraStateOf({ extensions: jiraExtension({ key: "KAN-7" }) })).toEqual({ key: "KAN-7", id: null, sync: true, pullPending: false });
  });
});

/**
 * The accessor the two git columns became (KAN-169,
 * `ARCHITECTURE.md`, "One work entity").
 *
 * Same job and the same two guarantees as the `jira` accessor above: an
 * item nothing git-shaped has happened to answers exactly as the dropped
 * columns' NULLs did, and a payload that is wrong in any way still
 * answers rather than throwing. What is different is who has no row —
 * every item on a `none`, `folder` or `scratch` workspace, which is the
 * whole reason the columns left the item row.
 */
describe("the git extension", () => {
  it("reads an item with no extensions as one no git workspace has touched", () => {
    expect(gitStateOf({ extensions: NO_ITEM_EXTENSIONS })).toEqual({ branch: null, pullRequest: null, baseBranch: null, namedBranch: false, attachedAt: null, reference: null, reviewers: null });
    expect(NO_GIT_STATE).toEqual({ branch: null, pullRequest: null, baseBranch: null, namedBranch: false, attachedAt: null, reference: null, reviewers: null });
  });

  it("reads what a row holds", () => {
    expect(gitStateOf({ extensions: { git: { branch: "eo/EO-1", pullRequest: "https://github.com/acme/api/pull/7" } } })).toEqual({
      branch: "eo/EO-1",
      pullRequest: "https://github.com/acme/api/pull/7",
      baseBranch: null,
      namedBranch: false,
      attachedAt: null,
      reference: null,
      reviewers: null,
    });
  });

  it("fills in a field a row was written before", () => {
    // A branch cut before anything opened a pull request is the ordinary
    // state, and the row written then names only the branch.
    expect(gitStateOf({ extensions: { git: { branch: "eo/EO-1" } } })).toEqual({ branch: "eo/EO-1", pullRequest: null, baseBranch: null, namedBranch: false, attachedAt: null, reference: null, reviewers: null });
    // And a row written before a base branch could be named (EO-364)
    // reads as one that named none.
    expect(gitStateOf({ extensions: { git: { branch: "eo/EO-1", pullRequest: null } } }).baseBranch).toBeNull();
  });

  it("answers with the defaults rather than throwing on something that is not this shape", () => {
    expect(readGitState("not an object")).toEqual(NO_GIT_STATE);
    expect(readGitState({ branch: 7 })).toEqual(NO_GIT_STATE);
    expect(readGitState(undefined)).toEqual(NO_GIT_STATE);
  });

  it("knows a state that is not worth a row", () => {
    // What the migration filtered on and what the write path deletes on.
    expect(isDefaultGitState(NO_GIT_STATE)).toBe(true);
    expect(isDefaultGitState({ ...NO_GIT_STATE, branch: "eo/EO-1" })).toBe(false);
    // A pull request with no branch is not a state EO writes, and it is
    // one a database can hold — so it is worth a row, or the only link
    // to an open pull request would be dropped.
    expect(isDefaultGitState({ ...NO_GIT_STATE, pullRequest: "https://github.com/acme/api/pull/7" })).toBe(false);
    // A base branch named before anything was cut is the whole of what
    // the row has to say, and it has to survive until the branch is cut
    // from it (EO-364).
    expect(isDefaultGitState({ ...NO_GIT_STATE, baseBranch: "release/2.4" })).toBe(false);
    // And so is a Reference named on an item nothing has been cut for (EO-637).
    expect(isDefaultGitState({ ...NO_GIT_STATE, reference: "PROJ-123" })).toBe(false);
  });

  it("builds the map back the same way it reads it", () => {
    expect(gitStateOf({ extensions: gitExtension({ branch: "eo/EO-1" }) })).toEqual({ branch: "eo/EO-1", pullRequest: null, baseBranch: null, namedBranch: false, attachedAt: null, reference: null, reviewers: null });
  });

  it("leaves the other extension's slot alone", () => {
    // One item, two extensions: the point of the mechanism is that a
    // pack and a workspace kind can both have something to say without
    // either needing to know about the other.
    const extensions = { ...jiraExtension({ key: "KAN-7" }), ...gitExtension({ branch: "eo/EO-1" }) };
    expect(jiraStateOf({ extensions })).toEqual({ key: "KAN-7", id: null, sync: true, pullPending: false });
    expect(gitStateOf({ extensions })).toEqual({ branch: "eo/EO-1", pullRequest: null, baseBranch: null, namedBranch: false, attachedAt: null, reference: null, reviewers: null });
  });
});

/**
 * The check every door a base branch arrives through shares (EO-364):
 * a name git would take is accepted whether or not it exists — the
 * remote is asked that when the branch is cut — and a sentence, a path
 * fragment or a stray character is refused saying what is wrong.
 */
describe("branchNameProblem", () => {
  it("accepts the names people actually give", () => {
    for (const name of ["main", "release/2.4", "feature/rate-limits", "rockarxiv/EO-363", "v2.x", "hotfix_1"]) {
      expect(branchNameProblem(name)).toBeNull();
    }
  });

  it("refuses what git would not take, naming what is wrong", () => {
    expect(branchNameProblem("")).toMatch(/empty/);
    expect(branchNameProblem("   ")).toMatch(/empty/);
    expect(branchNameProblem("the release branch")).toMatch(/space/);
    expect(branchNameProblem("main..dev")).toMatch(/"\.\."/);
    expect(branchNameProblem("-main")).toMatch(/starts with/);
    expect(branchNameProblem("release/")).toMatch(/ends with/);
    expect(branchNameProblem("main.lock")).toMatch(/ends with/);
    expect(branchNameProblem("main~1")).toMatch(/one of/);
    expect(branchNameProblem("a\u0007b")).toMatch(/control character/);
  });
});

/**
 * A branch a person named (EO-365): a name on the item until Worktree
 * attaches it, and a branch in git from then on.
 */
describe("a named branch", () => {
  it("is a branch in git the moment EO cuts one, and not before", () => {
    expect(branchInGit(NO_GIT_STATE)).toBeNull();
    expect(branchInGit({ ...NO_GIT_STATE, branch: "eo/EO-1" })).toBe("eo/EO-1");
  });

  it("is only a name until EO has attached it, and a branch in git after", () => {
    const named = { ...NO_GIT_STATE, branch: "feature/limits", namedBranch: true };
    expect(branchInGit(named)).toBeNull();
    expect(branchInGit({ ...named, attachedAt: "abc123" })).toBe("feature/limits");
    expect(namedBranchOf(named)).toBe("feature/limits");
    expect(namedBranchOf({ ...NO_GIT_STATE, branch: "eo/EO-1" })).toBeNull();
  });

  it("is worth a row on its own, and reads back from a row written before it existed", () => {
    expect(isDefaultGitState({ ...NO_GIT_STATE, branch: "feature/limits", namedBranch: true })).toBe(false);
    expect(gitStateOf({ extensions: { git: { branch: "eo/EO-1", pullRequest: null, baseBranch: null } } })).toMatchObject({ namedBranch: false, attachedAt: null, reference: null });
  });
});

/**
 * What may be an item's Reference (EO-637): a single token that can stand
 * in a git branch name, since that is where it ends up.
 */
describe("referenceProblem", () => {
  it("accepts the labels people actually give, and reads a blank one as no problem", () => {
    for (const value of ["PROJ-123", " PROJ-123 ", "gh-42", "acme/api#7", "release_2.4", "", "   "]) {
      expect(referenceProblem(value)).toBeNull();
    }
  });

  it("refuses what could not appear in a branch name, naming what is wrong", () => {
    expect(referenceProblem("PROJ 123")).toMatch(/a space/);
    expect(referenceProblem("PROJ\t123")).toMatch(/whitespace/);
    expect(referenceProblem("a..b")).toMatch(/"\.\."/);
    expect(referenceProblem("-x")).toMatch(/starts with "-"/);
    expect(referenceProblem("x.")).toMatch(/ends with "\."/);
    expect(referenceProblem("x/")).toMatch(/ends with "\/"/);
    expect(referenceProblem("a@{b")).toMatch(/"@\{"/);
    expect(referenceProblem("a//b")).toMatch(/"\/\/"/);
    expect(referenceProblem("/a")).toMatch(/starts with "\/"/);
    expect(referenceProblem(".foo")).toMatch(/part "\.foo" starts with "\."/);
    expect(referenceProblem("a/.b")).toMatch(/part "\.b" starts with "\."/);
    expect(referenceProblem("a.lock/b")).toMatch(/part "a\.lock" ends with "\.lock"/);
    for (const character of ["~", "^", ":", "?", "*", "[", "\\"]) {
      expect(referenceProblem(`a${character}b`)).toContain(`"${character}"`);
    }
  });
});

describe("effectiveReference", () => {
  const feature = { key: "EO-1", extensions: gitExtension({ reference: "PROJ-123" }) };

  it("answers with the item's own, which wins over its parent's", () => {
    expect(effectiveReference({ extensions: gitExtension({ reference: "PROJ-456" }) }, feature)).toEqual({ value: "PROJ-456", inheritedFrom: null });
  });

  it("answers with the parent's when the item has none, naming the parent", () => {
    expect(effectiveReference({ extensions: NO_ITEM_EXTENSIONS }, feature)).toEqual({ value: "PROJ-123", inheritedFrom: "EO-1" });
  });

  it("answers null when neither names one", () => {
    expect(effectiveReference({ extensions: NO_ITEM_EXTENSIONS }, undefined)).toBeNull();
    expect(effectiveReference({ extensions: NO_ITEM_EXTENSIONS }, { key: "EO-1", extensions: NO_ITEM_EXTENSIONS })).toBeNull();
  });
});

describe("effectiveReviewers (EO-742)", () => {
  const repository = ["alice", "bob"];
  const feature = { key: "EO-1", extensions: gitExtension({ reviewers: ["dave"] }) };
  const bare = { key: "EO-2", extensions: NO_ITEM_EXTENSIONS };

  it("answers with the item's own, which wins over its parent's and the repository's", () => {
    expect(effectiveReviewers({ extensions: gitExtension({ reviewers: ["carol"] }) }, feature, repository)).toEqual({ value: ["carol"], inheritedFrom: null });
  });

  it("answers with an empty own list as nobody, not as nothing said", () => {
    expect(effectiveReviewers({ extensions: gitExtension({ reviewers: [] }) }, feature, repository)).toEqual({ value: [], inheritedFrom: null });
  });

  it("answers with the parent's own when the item has none, naming the parent", () => {
    expect(effectiveReviewers({ extensions: NO_ITEM_EXTENSIONS }, feature, repository)).toEqual({ value: ["dave"], inheritedFrom: "EO-1" });
    expect(effectiveReviewers({ extensions: NO_ITEM_EXTENSIONS }, { key: "EO-1", extensions: gitExtension({ reviewers: [] }) }, repository)).toEqual({ value: [], inheritedFrom: "EO-1" });
  });

  it("answers with the repository's default when neither names a list", () => {
    expect(effectiveReviewers({ extensions: NO_ITEM_EXTENSIONS }, bare, repository)).toEqual({ value: ["alice", "bob"], inheritedFrom: REVIEWERS_FROM_REPOSITORY });
    expect(effectiveReviewers({ extensions: NO_ITEM_EXTENSIONS }, undefined, [])).toEqual({ value: [], inheritedFrom: REVIEWERS_FROM_REPOSITORY });
  });

  it("is part of what makes git state worth a row", () => {
    expect(isDefaultGitState({ ...NO_GIT_STATE, reviewers: [] })).toBe(false);
    expect(isDefaultGitState({ ...NO_GIT_STATE, reviewers: null })).toBe(true);
  });
});
