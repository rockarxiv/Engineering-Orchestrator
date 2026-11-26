import { describe, expect, it } from "vitest";
import { classifyForgeError, classifyPushError, missingCli } from "./errors.js";

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

describe("a failed push, whose divergence git's status for the ref settles (EO-910)", () => {
  const hook =
    "remote: refusing https://tok:SECRET@example.com/acme/api.git\nerror: failed to push some refs to 'origin'\n!\tabc:refs/heads/eo/non-fast-forward-API-4\t[remote rejected] (pre-receive hook declined)";

  it("is divergence when the ref's status says so", () => {
    expect(classifyPushError("error: failed to push some refs to 'origin'", true, "[rejected] (fetch first)")).toMatchObject({ final: true, diverged: true });
  });

  it("is not divergence for a hook's refusal, whatever the branch is called, and says it from the ref's status alone", () => {
    const classified = classifyPushError(hook, false, "[remote rejected] (pre-receive hook declined)");
    expect(classified).toMatchObject({ final: true, diverged: false });
    expect(classified.message).not.toContain("moved on");
    expect(classified.message).toContain("[remote rejected] (pre-receive hook declined)");
    expect(classified.message).not.toContain("SECRET");
  });

  it("names a local pre-push hook, and repeats nothing it printed, where the ref has no status", () => {
    const classified = classifyPushError("refusing a push to ssh://tok:SECRET@host/~/api.git\nerror: failed to push some refs to 'origin'", false, null);
    expect(classified).toMatchObject({ final: true, diverged: false });
    expect(classified.message).toContain("pre-push hook");
    expect(classified.message).not.toContain("SECRET");
  });

  it.each([
    ["a hook that says a command was not found", "hook: command not found: SYNTHETIC_SECRET\nerror: failed to push some refs to 'origin'"],
    ["a hook that says the credentials failed", "remote: Authentication failed for https://tok:SYNTHETIC_SECRET@example.com/acme/api.git"],
    ["a git that speaks French", "Total 3 (delta 0)\nremote: refus de https://tok:SYNTHETIC_SECRET@example.com\nerreur : impossible de pousser des références vers 'origin'"],
    ["a remote that cannot be reached", "fatal: unable to access 'https://tok:SYNTHETIC_SECRET@example.com/': Could not resolve host"],
  ])("repeats nothing git printed where the ref has no status: %s", (_, raw) => {
    const classified = classifyPushError(raw, false, null);
    expect(classified.diverged).toBe(false);
    expect(classified.message).not.toContain("SYNTHETIC");
    expect(classified.message).not.toContain("example.com");
  });

  it("tries again where it does not recognise what git said, a git in another language included", () => {
    expect(classifyPushError("erreur : impossible de pousser des références vers 'origin'", false, null)).toMatchObject({ final: false, diverged: false });
    expect(classifyPushError("fatal: unable to access: Could not resolve host", false, null)).toMatchObject({ final: false, diverged: false });
  });

  it("stops where the credentials were refused, or the source is ambiguous, saying which in its own words", () => {
    expect(classifyPushError("fatal: Authentication failed for 'https://example.com/'", false, null).message).toContain("credentials");
    expect(classifyPushError("error: src refspec refs/heads/eo/API-4 matches more than one\nerror: failed to push some refs", false, null)).toMatchObject({
      final: true,
      message: expect.stringContaining("same name"),
    });
  });
});
