import { describe, expect, it } from "vitest";
import { guessForge, parseRemoteUrl } from "./remote.js";

/**
 * Which forge a repository lives on (F-06).
 *
 * All of this is pure, and all of it is the awkward cases: git accepts
 * five different shapes of remote url and only one of them is a URL.
 */
describe("parsing a remote url", () => {
  it("reads the SCP-style form git writes by default", () => {
    // `git@github.com:owner/repo.git` is not a URL — `new URL` throws on
    // it — and it is what `git clone git@…` leaves behind.
    expect(parseRemoteUrl("git@github.com:owner/repo.git")).toEqual({ host: "github.com", path: "owner/repo" });
  });

  it("reads ssh:// with a port", () => {
    expect(parseRemoteUrl("ssh://git@gitlab.example.com:2222/group/sub/repo.git")).toEqual({
      host: "gitlab.example.com",
      path: "group/sub/repo",
    });
  });

  it("reads https, with or without a user and a .git", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo")).toEqual({ host: "github.com", path: "owner/repo" });
    expect(parseRemoteUrl("https://user@gitlab.com/group/repo.git")).toEqual({ host: "gitlab.com", path: "group/repo" });
    expect(parseRemoteUrl("git://github.com/owner/repo.git")).toEqual({ host: "github.com", path: "owner/repo" });
  });

  it("keeps a GitLab subgroup path whole", () => {
    // Splitting into owner and repo loses the middle, and the middle is
    // where the repository actually lives.
    expect(parseRemoteUrl("https://gitlab.com/acme/platform/api.git")?.path).toBe("acme/platform/api");
  });

  it("is not fooled by a colon that is a port", () => {
    expect(parseRemoteUrl("ssh://git@example.com:22/owner/repo")).toEqual({ host: "example.com", path: "owner/repo" });
  });

  it("lower-cases the host but not the path", () => {
    // Hostnames are case-insensitive; repository names are not.
    expect(parseRemoteUrl("https://GitHub.com/Owner/Repo.git")).toEqual({ host: "github.com", path: "Owner/Repo" });
  });

  it("returns null rather than guessing at anything else", () => {
    for (const input of ["", "   ", "not a url", "https://github.com", "https://github.com/owner", "/srv/git/repo.git"]) {
      expect(parseRemoteUrl(input), input).toBeNull();
    }
  });
});

describe("guessing the forge from the host", () => {
  it("recognises the two canonical hosts", () => {
    expect(guessForge("github.com")).toBe("github");
    expect(guessForge("GitLab.com")).toBe("gitlab");
  });

  it("refuses to guess at a self-hosted one", () => {
    // Matching a substring is how you post a merge request to a GitHub
    // Enterprise host. The repository says which it is instead.
    expect(guessForge("github.acme-internal.com")).toBeNull();
    expect(guessForge("git.acme.com")).toBeNull();
    expect(guessForge("gitlab.acme.io")).toBeNull();
  });
});
