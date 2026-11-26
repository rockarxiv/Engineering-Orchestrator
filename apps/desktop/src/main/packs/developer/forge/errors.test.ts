import { describe, expect, it } from "vitest";
import { classifyForgeError, missingCli } from "./errors.js";

/**
 * Whether a failure is worth trying again (F-06).
 *
 * The asymmetry is the whole design: retrying a permanent error six
 * times costs half an hour of nothing, and dropping a transient one
 * loses the pull request while telling someone their work is up for
 * review when it is not.
 */
describe("failures that retrying cannot fix", () => {
  it("a diverged remote branch, which EO will not force over", () => {
    const result = classifyForgeError("! [rejected]  eo/API-4 -> eo/API-4 (non-fast-forward)\nerror: failed to push some refs");

    expect(result.final).toBe(true);
    expect(result.message).toContain("will not force-push over work it did not write");
  });

  it("credentials the forge refused", () => {
    for (const raw of ["fatal: Authentication failed for 'https://github.com/acme/api.git/'", "HTTP 403: Forbidden", "git@github.com: Permission denied (publickey)."]) {
      expect(classifyForgeError(raw).final, raw).toBe(true);
    }
  });

  it("a repository that is not there", () => {
    expect(classifyForgeError("GraphQL: Could not resolve to a Repository with the name 'acme/nope'. (404 Not Found)").final).toBe(true);
  });

  it("a protected base branch", () => {
    expect(classifyForgeError("remote: GitLab: You are not allowed to push code to protected branches on this repository.").final).toBe(true);
  });

  it("a CLI that is not installed", () => {
    const result = missingCli("glab");

    expect(result.final).toBe(true);
    expect(result.message).toContain("not on PATH");
    expect(result.message).toContain("turn this off");
  });
});

/**
 * The one failure the pull request step sends back to the implementer
 * rather than to a person (EO-429), so the one it must not over-match:
 * what follows it is an instruction to rebase and push with a lease.
 */
describe("which rejected pushes are a diverged branch", () => {
  it("git's two names for a remote holding commits the local branch does not", () => {
    for (const raw of [
      "! [rejected]  eo/API-4 -> eo/API-4 (non-fast-forward)\nerror: failed to push some refs",
      "! [rejected]  eo/API-4 -> eo/API-4 (fetch first)\nerror: failed to push some refs to 'origin'",
    ]) {
      expect(classifyForgeError(raw), raw).toMatchObject({ final: true, diverged: true });
    }
  });

  it("not a push refused for any other reason, though git ends them all the same way", () => {
    for (const raw of [
      "! [remote rejected] eo/API-4 -> eo/API-4 (pre-receive hook declined)\nerror: failed to push some refs to 'origin'",
      "remote: GitLab: You are not allowed to push code to protected branches on this repository.\nerror: failed to push some refs",
      "error: src refspec eo/API-4 does not match any\nerror: failed to push some refs to 'origin'",
    ]) {
      expect(classifyForgeError(raw), raw).toMatchObject({ final: true, diverged: false });
    }
  });

  it("nothing that is not final", () => {
    expect(classifyForgeError("HTTP 502: Bad Gateway").diverged).toBe(false);
    expect(missingCli("gh").diverged).toBe(false);
  });
});

describe("failures worth another go", () => {
  it("the network", () => {
    for (const raw of [
      "fatal: unable to access 'https://github.com/acme/api.git/': Could not resolve host: github.com",
      "error: RPC failed; curl 56 Recv failure: Connection reset by peer",
      "HTTP 502: Bad Gateway",
      "HTTP 429: too many requests",
    ]) {
      expect(classifyForgeError(raw).final, raw).toBe(false);
    }
  });

  it("and anything it has never seen", () => {
    // The case that actually matters. An unrecognised error is far more
    // likely to be weather than a wall.
    expect(classifyForgeError("gh: something nobody has written a matcher for yet").final).toBe(false);
  });

  it("keeps the original text, so the item says what the CLI said", () => {
    expect(classifyForgeError("HTTP 502: Bad Gateway").message).toBe("HTTP 502: Bad Gateway");
  });
});

describe("the awkward overlap", () => {
  it("does not read 'repository not found' as a missing binary", () => {
    // Both contain "not found"; only one of them means the CLI is absent.
    expect(classifyForgeError("GraphQL: Could not resolve to a Repository (404 Not Found)").message).not.toContain("PATH");
  });
});
