/**
 * Working out which forge a repository lives on (F-06).
 *
 * Pure: a remote url in, a host and a path out. Everything that talks to
 * git or to a CLI is somewhere else, which is what makes the awkward
 * cases — and there are five of them — cheap to test.
 */

export type ForgeKind = "github" | "gitlab";

export interface ParsedRemote {
  host: string;
  /** `owner/repo`, or `group/subgroup/repo` on GitLab, without a trailing `.git`. */
  path: string;
}

/**
 * Parses the forms git actually accepts.
 *
 * | Form | Example |
 * |---|---|
 * | SCP-style SSH | `git@github.com:owner/repo.git` |
 * | `ssh://` with a port | `ssh://git@gitlab.example.com:2222/group/sub/repo.git` |
 * | HTTPS | `https://github.com/owner/repo` |
 * | HTTPS with a user | `https://user@gitlab.com/group/repo.git` |
 * | `git://` | `git://github.com/owner/repo.git` |
 *
 * GitLab subgroups mean the path can have three or more segments, so it
 * is kept whole rather than split into owner and repo.
 */
export function parseRemoteUrl(url: string): ParsedRemote | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;

  // SCP-style is not a URL and `new URL` will not have it: `host:path`,
  // with no slash after the colon. A colon followed by digits is a port
  // in an ssh:// url, not this.
  const scp = /^(?:([^@/]+)@)?([^/:]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    return normalise(scp[2]!, scp[3]!);
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === "") return null;
    return normalise(parsed.hostname, parsed.pathname);
  } catch {
    return null;
  }
}

function normalise(host: string, rawPath: string): ParsedRemote | null {
  const path = rawPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  // A host with nothing after it is a remote to a bare host, which is
  // not something a forge can act on.
  if (path === "" || !path.includes("/")) return null;
  return { host: host.toLowerCase(), path };
}

/**
 * Which forge a host is, when it is obvious.
 *
 * Only the two canonical hosts are recognised. Self-hosted GitHub
 * Enterprise and GitLab hostnames are arbitrary — matching a substring
 * is how you post a merge request to a GitHub host — so anything else
 * returns null and the repository says which it is.
 */
export function guessForge(host: string): ForgeKind | null {
  const lower = host.toLowerCase();
  if (lower === "github.com" || lower === "www.github.com") return "github";
  if (lower === "gitlab.com" || lower === "www.gitlab.com") return "gitlab";
  return null;
}
