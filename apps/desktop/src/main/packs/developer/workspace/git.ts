// The only file in this codebase that spawns `git` (G-01: "all git calls
// shell out to the git binary, no libgit2 dependency"). Everything else
// goes through the functions here, which keeps the argument-quoting rule
// below enforceable in one place.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { codeSpan } from "../../../codeSpan.js";

const execFileAsync = promisify(execFile);

/**
 * Resolves a path to the same canonical form git reports, so our paths
 * and git's can be compared.
 *
 * They differ on two of the three platforms we support, in ways that are
 * invisible on Linux: macOS's /tmp is a symlink to /private/tmp, and
 * Windows hands out 8.3 short names (RUNNER~1) for long directory
 * names. git always prints the fully resolved path, so a naive ===
 * against a path we built ourselves is false on macOS and Windows and
 * true on Linux — which is exactly the kind of bug that ships.
 *
 * Falls back to a plain resolve() when the path doesn't exist yet;
 * there's nothing to canonicalise in that case.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Path equality that holds across platforms — canonical form, and case-insensitive on Windows. */
export function samePath(a: string, b: string): boolean {
  const left = canonicalPath(a);
  const right = canonicalPath(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

export type GitOutcome = { ok: true; stdout: string } | { ok: false; error: string };

/**
 * Runs git with an explicit argument array — never a shell string.
 *
 * That's what makes paths with spaces work (an acceptance criterion):
 * execFile passes argv straight to the process, so no quoting or
 * escaping is involved and there's no shell to misinterpret anything.
 * Building a command string and passing it to a shell would reintroduce
 * both problems, and on Windows the quoting rules differ again.
 */
export interface GitOptions {
  /** Merged over the inherited environment. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Kills the process when a person cancels the run this is part of.
   *
   * Passed straight to `execFile`, which sends the signal itself — so
   * cancelling actually stops the `git fetch`, rather than leaving it
   * running behind a run the UI has already called cancelled. Only
   * plumbed through the calls that can block for a noticeable time;
   * `show-ref` and `rev-parse` return in milliseconds and are guarded by
   * an abort check between steps instead.
   */
  signal?: AbortSignal;
}

/**
 * The argument array git is actually spawned with.
 *
 * Windows refuses a path over 260 characters unless the caller opts in,
 * and Git for Windows only opts in when `core.longpaths` is set. EO
 * never set it, so any worktree an agent had run `npm install` inside
 * became unremovable: `git worktree remove` failed with "Filename too
 * long" and the checkout was stranded on disk (issue #131). Setting the
 * key with `-c` covers `worktree add`, `status` and `worktree remove`
 * alike, for this invocation only — `git config` would help only repos
 * EO had already touched, and would mutate somebody's repository config
 * to do it.
 *
 * Gated on the platform even though git ignores the key elsewhere: the
 * array stays byte-identical on macOS and Linux, so nothing about
 * existing behaviour there is up for debate. The platform is a parameter
 * rather than read from `process` so both shapes can be asserted from
 * any machine; `git()` below passes the real one.
 */
export function composeGitArgs(args: string[], platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["-c", "core.longpaths=true", ...args] : args;
}

export async function git(args: string[], cwd: string, options: GitOptions = {}): Promise<GitOutcome> {
  try {
    const { stdout } = await execFileAsync("git", composeGitArgs(args, process.platform), {
      cwd,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, error: extractGitError(error) };
  }
}

/**
 * What a caller may say about a git command that reaches the network.
 *
 * The environment is not one of them: every such command gets
 * `NON_INTERACTIVE_GIT_ENV` whether the caller thought about it or not,
 * which is the point of having this type rather than passing `GitOptions`
 * around.
 */
export type NetworkGitOptions = Pick<GitOptions, "timeoutMs" | "signal">;

/**
 * How long a git command that reaches the network may take.
 *
 * Every one of them needs a number, and the number matters more than
 * which number it is: `git fetch` against an unreachable host does not
 * fail, it waits — and a fetch with no timeout inside `create_worktree`
 * left the run sitting on `running` with nothing on screen and no way
 * out but cancelling. Two minutes is longer than a healthy fetch of one
 * branch by orders of magnitude and shorter than anyone's patience.
 */
export const NETWORK_TIMEOUT_MS = 120_000;

/**
 * Anything that reaches the network must not be able to sit waiting on a
 * prompt nobody can see (F-06).
 *
 * A push against a remote whose credentials have expired will otherwise
 * block on a terminal that does not exist, for as long as the process
 * lives. These turn that into a failure with a message.
 */
export const NON_INTERACTIVE_GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "echo",
  SSH_ASKPASS: "echo",
  SSH_ASKPASS_REQUIRE: "never",
};

/** Where a remote points, so the forge can be worked out from its host (F-06). */
export async function remoteUrl(repoPath: string, remote: string): Promise<GitOutcome> {
  return git(["remote", "get-url", remote], repoPath);
}

/** One file's contents at a ref, without touching the working tree (F-06). */
export async function showFile(repoPath: string, ref: string, path: string): Promise<GitOutcome> {
  return git(["show", `${ref}:${path}`], repoPath);
}

/** What is under a directory at a ref — for template directories holding several choices. */
export async function listTree(repoPath: string, ref: string, path: string): Promise<GitOutcome> {
  return git(["ls-tree", "-r", "--name-only", ref, "--", path], repoPath);
}

/**
 * Publishes a branch.
 *
 * Never `--force`: a remote branch that has diverged is a human's
 * decision, and the only thing EO could do by forcing is destroy work it
 * did not write. Re-pushing an unchanged branch is a no-op that exits 0,
 * which is what makes a retry safe.
 *
 * The branch is pushed by its full name onto the same name —
 * `refs/heads/<branch>:refs/heads/<branch>` — so a `pre-push` hook reads
 * the branch on its stdin as it always did, git can take the source for
 * nothing else (a tag named like a commit's hash would win over the hash
 * itself; a ref that shares the name makes git refuse rather than guess),
 * and it lands on that ref whatever a `remote.<name>.push` would map it
 * to (EO-910). The commit is read before the push and again after it:
 * git reads the branch once, before any hook runs, so where it has not
 * moved in between, `head` is what git sent (`confirmed`); where it has,
 * which commit went cannot be said, and nothing is recorded as EO's.
 * Only that ref: `--no-follow-tags`, so a tag the destination refuses
 * cannot fail a push whose branch went through. The branch's upstream is
 * then set as `--set-upstream` would have.
 *
 * Pinned to one destination, and still pushed by the remote's name, so
 * that what git does for a push to that remote — its `receivepack`, the
 * local `pre-push` hook told the remote's name, the remote-tracking ref
 * moved by its fetch refspec — is what it always was (`pinPush`). The
 * URL is never on git's command line, where a timeout's error would
 * repeat it. Where the pin cannot be shown to hold the push goes by the
 * remote's name unpinned, as it always did, with `destination` null.
 *
 * `updated` is whether the remote's branch actually moved, read off
 * `--porcelain`: an up-to-date push changes nothing, and its `head` may
 * be a commit somebody else put there — so it is not EO's to record as
 * its own. A push that failed says in `published` the commit it sent if
 * it moved the branch at any of its URLs all the same — several push
 * URLs can each answer differently — and in `rejection` whether git
 * refused the ref because the remote's branch has commits the local one
 * lacks (`diverged`), read off the ref's own status rather than anything
 * git printed, which names the branch.
 *
 * `forceWithLease` is the one exception to never forcing, and it is
 * always EO's own push it replaces: the head EO itself last pushed for
 * the item (EO-910), so the lease is that exact commit, checked by the
 * server the push reaches, and anything anybody else pushed since is
 * refused rather than lost. It sends only the commit the rejected push
 * sent (`send`), and only to the destination it names — the fingerprint
 * EO recorded with that head. Where the branch is at another commit now,
 * or the remote no longer pushes to exactly that one place, nothing is
 * pushed at all (`rejection: "changed"`, `"destination"`).
 */
export async function pushBranch(
  repoPath: string,
  remote: string,
  branch: string,
  options: NetworkGitOptions & { forceWithLease?: { expect: string; destination: string; send: string } } = {},
): Promise<PushOutcome> {
  const ref = `refs/heads/${branch}`;
  const tip = (): Promise<GitOutcome> => git(["rev-parse", "--verify", `${ref}^{commit}`], repoPath);
  const head = await tip();
  if (!head.ok) return { ok: false, error: head.error, head: null, confirmed: false, published: null, destination: null, rejection: "other", status: null };
  if (options.forceWithLease && head.stdout !== options.forceWithLease.send) {
    return {
      ok: false,
      error: `${branch} is no longer at the commit whose push was rejected, so nothing was pushed.`,
      head: head.stdout,
      confirmed: false,
      published: null,
      destination: null,
      rejection: "changed",
      status: null,
    };
  }
  const pin = await pinPush(repoPath, remote);
  const pinned = pin === null ? null : destinationKey(pin.url);
  if (options.forceWithLease && pinned !== options.forceWithLease.destination) {
    return {
      ok: false,
      error: `${remote} does not push to exactly the one place EO last pushed this branch to, so nothing was pushed.`,
      head: head.stdout,
      confirmed: false,
      published: null,
      destination: pinned,
      rejection: "destination",
      status: null,
    };
  }
  const refspec = `${ref}:${ref}`;
  const lease = options.forceWithLease ? [`--force-with-lease=${branch}:${options.forceWithLease.expect}`] : [];
  const env = { ...process.env, ...NON_INTERACTIVE_GIT_ENV, ...(pin === null ? {} : pin.env) };
  // Still where it was read: then that is the commit git sent.
  const confirm = async (): Promise<boolean> => {
    const after = await tip();
    return after.ok && after.stdout === head.stdout;
  };
  try {
    const { stdout } = await execFileAsync("git", composeGitArgs(["push", "--porcelain", "--no-follow-tags", ...lease, remote, refspec], process.platform), {
      cwd: repoPath,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env,
      timeout: options.timeoutMs ?? NETWORK_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const confirmed = await confirm();
    // Best effort: the push has happened, and a missing upstream costs a
    // person's `git status` its ahead/behind, nothing of EO's.
    await git(["config", `branch.${branch}.remote`, remote], repoPath);
    await git(["config", `branch.${branch}.merge`, ref], repoPath);
    return { ok: true, stdout: stdout.trim(), head: head.stdout, confirmed, updated: pushUpdated(stdout, refspec), destination: wentTo(stdout, pinned) };
  } catch (error) {
    // `--porcelain` prints each ref's status on stdout, and that status
    // is what tells divergence from any other refusal. Read untrimmed:
    // the first line's flag may be a space.
    const raw = typeof error === "object" && error !== null ? (error as { stdout?: unknown }).stdout : undefined;
    const stdout = typeof raw === "string" ? raw : "";
    const stderr = extractGitError(error);
    return {
      ok: false,
      error: stdout.trim() ? `${stderr}\n${stdout.trim()}` : stderr,
      head: head.stdout,
      confirmed: await confirm(),
      published: pushUpdated(stdout, refspec) ? head.stdout : null,
      destination: wentTo(stdout, pinned),
      rejection: pushDiverged(stdout, refspec) ? "diverged" : "other",
      status: pushRefusal(stdout, refspec),
    };
  }
}

/**
 * The pinned destination, unless git says it pushed to more than one
 * place — which a pin that held cannot do, and one a git too old to
 * clear a remote's push URLs held only until the remote was given one
 * more (`pinPush`).
 */
function wentTo(porcelain: string, pinned: string | null): string | null {
  return porcelain.split("\n").filter((line) => line.startsWith("To ")).length > 1 ? null : pinned;
}

/**
 * The one place a push to `remote` goes, and the environment that holds
 * it there (`pushBranch`), or null where that cannot be shown to hold.
 *
 * The remote's push URL is read once, exactly (`pushDestination`), and
 * made into the place it reaches (`reachedBy`). The environment git is
 * given then comes after any configuration the environment already gives
 * git, and after every configuration file: an empty
 * `remote.<name>.pushurl` clears the remote's push URLs, the next gives
 * it a name made up for this push alone, and `url.<that place>.insteadOf`
 * maps the name back onto it. Git applies a rewrite once, and nothing
 * configured can name a rewrite of a name it never saw — so neither a
 * second rewrite of the URL nor a change to the remote's push URLs while
 * EO works reaches another server.
 *
 * Asked of git again under exactly that environment, the remote must
 * push to exactly that place and nothing else. A git older than 2.46
 * cannot clear the list from the environment — it keeps the URLs it had
 * beside an empty one — so where the remote has no push URL of its own,
 * which is the usual `origin`, the environment only gives it one, and
 * asked again git must say the same. A remote with push URLs of its own,
 * on such a git, is not pinned at all. Nor is one with a `receivepack`
 * or a remote helper (`vcs`), either of which decides for itself where
 * the push lands, whatever the URL.
 */
async function pinPush(repoPath: string, remote: string): Promise<{ url: string; env: Record<string, string> } | null> {
  const resolved = await pushDestination(repoPath, remote);
  if (resolved === null) return null;
  for (const key of ["receivepack", "vcs"]) {
    const set = await git(["config", "--get-all", `remote.${remote}.${key}`], repoPath);
    if (set.ok) return null;
  }
  const url = await reachedBy(repoPath, resolved);
  if (url === null) return null;
  const alias = `eo-push-${randomUUID()}:`;
  const given = Number.parseInt(process.env["GIT_CONFIG_COUNT"] ?? "", 10);
  const index = Number.isInteger(given) && given > 0 ? given : 0;
  const pinsFor = (clear: boolean): [string, string][] => [
    ...(clear ? ([[`remote.${remote}.pushurl`, ""]] as [string, string][]) : []),
    [`remote.${remote}.pushurl`, alias],
    [`url.${url}.insteadOf`, alias],
  ];
  const ownPushUrls = (await git(["config", "--get-all", `remote.${remote}.pushurl`], repoPath)).ok;
  for (const clear of ownPushUrls ? [true] : [true, false]) {
    const pins = pinsFor(clear);
    const env: Record<string, string> = { GIT_CONFIG_COUNT: String(index + pins.length) };
    pins.forEach(([key, value], offset) => {
      env[`GIT_CONFIG_KEY_${index + offset}`] = key;
      env[`GIT_CONFIG_VALUE_${index + offset}`] = value;
    });
    if ((await pushDestination(repoPath, remote, env)) === url) return { url, env };
  }
  return null;
}

/** The transports whose URL alone names the repository a push reaches. */
const ROUTED_SCHEMES = new Set(["https", "http", "ssh", "git", "git+ssh", "ssh+git"]);

/**
 * The place a push to `url` reaches, as EO pins and records it, or null
 * where the URL alone does not say (EO-910).
 *
 * A network URL — `https://`, `ssh://`, `git://`, `user@host:path` — is
 * its own answer: the server it names is the one that takes the push. A
 * local path is not. A symlink anywhere in it can be pointed at another
 * repository with nothing in git's configuration changing, so a path is
 * pinned and recorded as the repository it resolves to now
 * (`localRepository`), and a push to the same path once the symlink
 * points elsewhere is a push to somewhere else. Anything else — a remote
 * helper (`<transport>::<address>`, a scheme git hands to
 * `git-remote-<scheme>`), a `file://` URL git would decode, a path git
 * would expand (`~`) — decides where it lands by means EO cannot check,
 * and is pinned to nothing.
 */
async function reachedBy(repoPath: string, url: string): Promise<string | null> {
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  if (scheme === "file") return url.startsWith("file:///") && !url.includes("%") ? localRepository(url.slice("file://".length)) : null;
  if (scheme !== undefined) return ROUTED_SCHEMES.has(scheme) ? url : null;
  // Git's own test: a path unless a colon comes before any slash, which
  // makes it `host:path` over SSH — a drive letter aside, on Windows.
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  const drive = process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(url);
  if (colon !== -1 && !(slash !== -1 && slash < colon) && !drive) return url;
  if (url.startsWith("~")) return null;
  return localRepository(resolve(repoPath, url));
}

/**
 * The repository a push to the local path `path` reaches, by a path with
 * no symlink in it, or null where git might reach another (EO-910).
 *
 * Git looks for `<path>/.git` before `<path>`, and for `<path>.git` where
 * `<path>` is not a repository, so the resolved path is taken only where
 * it is itself a bare repository with no `.git` inside it. Its refs must
 * be its own: no `commondir` sending them to another repository, and
 * none of `HEAD`, `refs`, `packed-refs` or `reftable` a symlink.
 */
async function localRepository(path: string): Promise<string | null> {
  let real: string;
  try {
    real = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await realpath(path, { encoding: "buffer" }));
  } catch {
    return null;
  }
  const entry = async (name: string): Promise<"file" | "directory" | "other" | "absent"> => {
    try {
      const stat = await lstat(join(real, name));
      return stat.isSymbolicLink() ? "other" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "other";
    }
  };
  if ((await entry(".git")) !== "absent" || (await entry("commondir")) !== "absent") return null;
  if ((await entry("HEAD")) !== "file" || (await entry("objects")) !== "directory" || (await entry("refs")) !== "directory") return null;
  if (!["absent", "file"].includes(await entry("packed-refs")) || !["absent", "directory"].includes(await entry("reftable"))) return null;
  return real;
}

/** This refspec's porcelain status lines, one per URL the push went to. */
function refStatuses(porcelain: string, refspec: string): string[] {
  return porcelain.split("\n").filter((entry) => entry.split("\t")[1] === refspec);
}

/**
 * Did the porcelain push move the remote ref at any URL it went to? Each
 * URL prints its own line for `refspec`, flagged ` ` (fast-forward), `+`
 * (forced) or `*` (new) where it did, and `=` where it was already there.
 */
export function pushUpdated(porcelain: string, refspec: string): boolean {
  return refStatuses(porcelain, refspec).some((line) => [" ", "+", "*"].includes(line[0] ?? ""));
}

/**
 * Did git refuse `refspec` at any URL because the remote's branch holds
 * commits the local one does not? Its `!` line says `[rejected]` with
 * `(fetch first)` or `(non-fast-forward)`; a hook's or the server's
 * refusal says `[remote rejected]`, and a lease that no longer holds
 * `(stale info)`, neither of which is divergence.
 */
export function pushDiverged(porcelain: string, refspec: string): boolean {
  return refStatuses(porcelain, refspec).some((line) => {
    const [flag, , summary] = line.split("\t");
    return flag === "!" && /^\[rejected\] \((fetch first|non-fast-forward)\)$/.test(summary ?? "");
  });
}

/** The statuses git gives a refused ref, as `pushRefusal` may repeat them. */
const REFUSED_STATUSES = new Set(["[rejected]", "[remote rejected]", "[remote failure]"]);

/**
 * The reasons beside a refused ref's status that are git's own words —
 * its own client's, or the ones `git receive-pack` sends — and so may be
 * repeated. Anything else there is the server's to choose, and a server
 * or its hook can choose to say anything.
 */
const REFUSED_REASONS = new Set([
  "non-fast-forward",
  "fetch first",
  "stale info",
  "already exists",
  "needs force",
  "atomic push failed",
  "hook declined",
  "pre-receive hook declined",
  "deny updating a hidden ref",
  "failed to update ref",
  "shallow update not allowed",
  "branch is currently checked out",
  "missing necessary objects",
  "unpacker error",
]);

/**
 * How git refused `refspec`, from its own status line, in words that
 * cannot carry anything a hook or a server chose to print: one of git's
 * statuses (`[remote rejected]`), and the reason beside it only where
 * that is one git itself gives (`pre-receive hook declined`), never one a
 * server made up. Null where git gave the ref no status — a local
 * `pre-push` hook that refused, a remote that could not be reached.
 */
export function pushRefusal(porcelain: string, refspec: string): string | null {
  for (const line of refStatuses(porcelain, refspec)) {
    const [flag, , summary = ""] = line.split("\t");
    if (flag !== "!") continue;
    const status = /^\[[a-z ]+\]/.exec(summary)?.[0];
    if (status === undefined || !REFUSED_STATUSES.has(status)) return "[rejected]";
    const reason = /^ \((.*)\)$/.exec(summary.slice(status.length))?.[1];
    return reason !== undefined && REFUSED_REASONS.has(reason) ? `${status} (${reason})` : status;
  }
  return null;
}

/**
 * A push that went through says which commit it read to send (`head`),
 * whether the branch was still there once git had pushed, so that this
 * is the commit git sent (`confirmed`), whether that moved the remote's
 * branch, and where it went (`destinationKey`, or null). One that failed
 * says the same of what it tried to send, what git said, which commit it
 * published anyway, if any, where it was going, and why it was refused:
 * `diverged`, refused for the ref by every account git gave;
 * `destination`, never sent, because a lease's destination no longer
 * holds; `changed`, never sent, because the branch is no longer at the
 * commit a lease was to send; anything else `other` — and, in `status`,
 * how git refused the ref (`pushRefusal`).
 */
export type PushOutcome =
  | { ok: true; stdout: string; head: string; confirmed: boolean; updated: boolean; destination: string | null }
  | {
      ok: false;
      error: string;
      head: string | null;
      confirmed: boolean;
      published: string | null;
      destination: string | null;
      rejection: "diverged" | "destination" | "changed" | "other";
      status: string | null;
    };

/**
 * The one URL a push to `remote` goes to right now — `remote.<name>.
 * pushurl` where set, else its URL, with the rewrites git applies to a
 * push — byte for byte, or null where that is not one place git can name
 * exactly: a remote with several push URLs, none, or one that cannot be
 * read back unambiguously (a line break in it, bytes that are not
 * UTF-8) (EO-910). A fetch can read from somewhere else entirely, which
 * is why a push is never checked against the remote's fetch URL.
 * Handed back to git only as `pushBranch` pins it, never as a URL git
 * would rewrite again.
 */
export async function pushDestination(repoPath: string, remote: string, env?: Record<string, string>): Promise<string | null> {
  let stdout: Buffer;
  try {
    ({ stdout } = await execFileAsync("git", composeGitArgs(["remote", "get-url", "--push", "--all", remote], process.platform), {
      cwd: repoPath,
      windowsHide: true,
      encoding: "buffer",
      maxBuffer: 1024 * 1024,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    }));
  } catch {
    return null;
  }
  let text: string;
  try {
    // Every byte, a leading byte-order mark too: `\uFEFFa.git` is not `a.git`.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout);
  } catch {
    return null;
  }
  // Exactly one line, ended by the one line break git writes after it.
  if (!text.endsWith("\n")) return null;
  const url = text.slice(0, -1);
  if (url === "" || url.includes("\n") || url.includes("\r")) return null;
  return url;
}

/**
 * A push URL as EO keeps it on an item: a SHA-256 fingerprint of the
 * whole URL, exactly as git resolved it — for a local path, of the
 * repository it resolves to (`reachedBy`). Two URLs that differ anywhere —
 * an SSH user who picks the repository, a host, a path — never share
 * one, and a credential written into the URL (`https://user:token@…`)
 * never reaches the database. A changed credential makes it another
 * destination, which only means EO refuses to force where it would have.
 */
export function destinationKey(url: string): string {
  return `sha256:${createHash("sha256").update(url).digest("hex")}`;
}

/**
 * How many commits `branch` has that `base` does not. Zero means there
 * is nothing to open.
 *
 * A failure is *not* zero, which is what this used to report. `rev-list`
 * exits non-zero for a ref it cannot resolve, and folding that into the
 * count told the caller "this branch has no commits the base does not
 * already have" — a sentence about the work, offered as final, when what
 * actually happened was that git could not read one of the two refs. The
 * two need different answers, so they are two different outcomes.
 */
export async function commitsAhead(repoPath: string, base: string, branch: string): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const result = await git(["rev-list", "--count", `${base}..${branch}`], repoPath);
  if (!result.ok) return { ok: false, error: result.error };

  const count = Number.parseInt(result.stdout, 10);
  if (Number.isNaN(count)) return { ok: false, error: `\`git rev-list --count ${base}..${branch}\` printed "${result.stdout}", which is not a number.` };
  return { ok: true, count };
}

/** What `fetchBranch` brought back: the remote-tracking ref it wrote, and the commit that ref named once it had. */
export type FetchedBranch = { ok: true; ref: string; commit: string } | { ok: false; error: string };

/**
 * Fetches one branch from `remote` into its remote-tracking ref,
 * `refs/remotes/<remote>/<branch>`, without touching the working tree or
 * any local branch (EO-10 / KAN-42's git fallback for merge-state).
 *
 * Into that ref, by an explicit refspec, rather than read back off
 * `FETCH_HEAD` (EO-755). `FETCH_HEAD` is one file shared by the
 * repository and every worktree of it, and EO runs builtin steps for
 * different items at the same time, so any fetch that lands between this
 * one and the read replaces it — which is how a named branch was once
 * checked out from `main`'s tip. The tracking ref can only be moved by a
 * fetch of this same branch, which puts it at this branch's tip again.
 * The refspec also moves the tracking ref where the remote's own fetch
 * refspec does not cover the branch, so it is never left stale behind
 * what this fetch saw.
 */
export async function fetchBranch(repoPath: string, remote: string, branch: string, options: NetworkGitOptions = {}): Promise<FetchedBranch> {
  const ref = `refs/remotes/${remote}/${branch}`;
  const fetched = await git(["fetch", remote, `+refs/heads/${branch}:${ref}`], repoPath, {
    env: NON_INTERACTIVE_GIT_ENV,
    timeoutMs: options.timeoutMs ?? NETWORK_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!fetched.ok) return fetched;
  const commit = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath);
  if (!commit.ok || commit.stdout === "") return { ok: false, error: `\`git fetch ${remote} ${branch}\` succeeded, but wrote no commit to \`${ref}\`.` };
  return { ok: true, ref, commit: commit.stdout };
}

/**
 * Is `ancestor` an ancestor of `descendant` — i.e. already fully
 * contained in its history? Used to tell whether a branch (typically the
 * commit `fetchBranch` just brought back) has landed on a base branch.
 *
 * A non-zero exit means "not an ancestor" here, same as everywhere else
 * in this file — it does not distinguish "diverged" from "unknown ref"
 * from "not yet merged", and callers must not read more into it than
 * that (EO-10 / KAN-42: the git fallback can tell merged from
 * not-yet-merged, never a closed MR from an open one).
 */
export async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await git(["merge-base", "--is-ancestor", ancestor, descendant], repoPath);
  return result.ok;
}

/**
 * What a caller may say about a rebase, on top of the usual two.
 *
 * `worktreePath` is the whole of it, and it is not optional in spirit:
 * without it this function has no way to tell EO's own checkout of a
 * branch from a person's, and the safe thing to do with a checkout EO
 * does not own is nothing at all.
 */
export interface RebaseOptions extends NetworkGitOptions {
  /**
   * EO's own worktree for the item whose branch this is —
   * `~/.eo/worktrees/<KEY>`, resolved by the caller against whatever
   * root it is configured with, whether or not it currently exists.
   *
   * The one place `branch` may be rebased where it is already checked
   * out. Everything else that might hold it — `repoPath`, a worktree a
   * person cut themselves, a stale registration — is somebody else's,
   * and gets a refusal rather than a rebase.
   */
  worktreePath?: string;
  /**
   * Replay only the commits after this one (EO-780): `git rebase --onto
   * <baseBranch> <from>`. What a restack passes — the commit the branch
   * was cut from its dependency at — so the dependency's own commits,
   * rewritten or squash-merged since, are left behind rather than
   * replayed. Absent, every commit `baseBranch` lacks is replayed.
   */
  from?: string;
}

/**
 * A rebase that did not happen, and the files it stopped on where it
 * stopped on a conflict — read before the rebase was taken back, because
 * afterwards nothing says which they were. Empty where it failed for any
 * other reason.
 */
export type RebaseOutcome = { ok: true; stdout: string } | { ok: false; error: string; conflicts: string[] };

/**
 * Rebases `branch` onto `baseBranch`, without ever checking `branch` out
 * in `repoPath` itself (EO-10 / KAN-42: by the time a same-feature
 * dependency has merged, `repoPath` is typically the *shared* checkout
 * other items' sends may still be using — checking this item's
 * branch out there, or leaving it mid-rebase, would corrupt somebody
 * else's run).
 *
 * Which leaves *where* it runs (EO-156). Git will not check a branch out
 * in two worktrees at once, so for as long as anything holds it there is
 * no throwaway worktree to be had, and at the one moment this is called
 * something usually does: the item's own `~/.eo/worktrees/<KEY>`, cut
 * for the implementer and not yet released. That checkout is EO's, it is
 * not shared, and `verify.ts` runs `git rebase` straight inside it for
 * exactly this reason — so `options.worktreePath` is rebased in when it
 * is what holds the branch, and nothing else ever is:
 *
 * - `repoPath` holding it is the case the first paragraph forbids.
 * - A worktree somebody cut themselves is not EO's to rewrite. It can
 *   genuinely hold this branch — releasing the item's worktree leaves
 *   the branch behind for anyone to check out — and rebasing there would
 *   move a stranger's HEAD and rewrite their working tree.
 * - Nothing holding it at all is the case the throwaway worktree exists
 *   for: mkdtemp, rebase, remove, win or lose, mirroring the pattern
 *   `openPullRequest.ts` uses for the pull request body file.
 *
 * Every refusal is returned rather than thrown, because the caller's job
 * is to escalate it as a comment (invariant #8) — a rebase that cannot
 * be done safely still has to end in something a person can read.
 *
 * Because a linked worktree shares the parent repository's object
 * database and refs, rebasing inside one moves `branch`'s ref in
 * `repoPath` too — there is nothing to copy back, and `repoPath`'s own
 * checked-out branch, HEAD and working tree are never touched.
 */
export async function rebaseOntoBase(repoPath: string, branch: string, baseBranch: string, options: RebaseOptions = {}): Promise<RebaseOutcome> {
  // The signal reaches the two commands that do the work. Cleanup does
  // not take it, deliberately: the abort is what leaves a throwaway
  // worktree behind, and a `worktree remove` that declines to run because
  // the run was cancelled would leave it there for good.
  const running = options.signal ? { signal: options.signal } : {};
  const from = options.from;

  // A listing git could not produce establishes nothing, so it reads as
  // an empty one: every path out of here then ends at the `worktree add`
  // below, which fails with whatever git has to say about the real
  // state — more than could be guessed at from here.
  const listed = await listWorktrees(repoPath);
  const entries = listed.ok ? listed.worktrees : [];
  // Bound once so the narrowing survives into the callback — and so
  // "EO's worktree for this item" is a name rather than a lookup
  // repeated in three refusals below.
  const ownPath = options.worktreePath;
  const ours = ownPath === undefined ? undefined : entries.find((entry) => samePath(entry.path, ownPath));
  const holder = entries.find((entry) => entry.branch === branch);

  if (holder && samePath(holder.path, repoPath)) {
    return {
      ok: false,
      conflicts: [],
      error:
        `\`${branch}\` is checked out in ${codeSpan(repoPath)} itself, and EO will not rebase there — ` +
        `that is the shared checkout another ticket's send may still be using. ` +
        `Check something else out there, then reply to retry.`,
    };
  }

  if (holder && !(ours && samePath(holder.path, ours.path))) {
    return {
      ok: false,
      conflicts: [],
      error:
        `\`${branch}\` is checked out at ${codeSpan(holder.path)}, which is not EO's worktree for this ticket` +
        `${ownPath === undefined ? "" : ` (${codeSpan(ownPath)})`}. ` +
        `EO will not rebase in a checkout it did not create — that would move somebody else's HEAD and rewrite their working tree. ` +
        `Remove that worktree, or move it back where EO expects it, then reply to retry.`,
    };
  }

  if (holder) {
    // Ours, and it is really there: a registration whose checkout has
    // been deleted is not somewhere to run git — the working directory
    // does not exist, and the ENOENT that comes back would say nothing
    // about what is wrong. Falling through to the add puts git's own
    // "already used by worktree at <path>" in the escalation instead,
    // which names the stale entry to be removed.
    if (await isGitRepo(holder.path)) return rebaseIn(holder.path, branch, baseBranch, from, running);
  } else if (ours && (await rebaseInProgress(ours.path))) {
    // Nothing reports the branch, yet EO's own worktree may still be
    // holding it: a rebase detaches HEAD, so a checkout stopped in the
    // middle of one lists as `detached` while git goes on refusing to
    // check that branch out anywhere else. Said plainly here, because
    // what git says about it names a temporary worktree that has
    // nothing to do with the problem.
    return { ok: false, conflicts: [], error: midRebaseRefusal(ours.path, branch, baseBranch) };
  }

  const directory = await mkdtemp(join(tmpdir(), "eo-rebase-"));
  try {
    const added = await git(["worktree", "add", directory, branch], repoPath, running);
    if (!added.ok) {
      return { ok: false, conflicts: [], error: `Could not create a temporary worktree to rebase \`${branch}\` onto \`${baseBranch}\`: ${codeSpan(added.error)}` };
    }

    try {
      return await rebaseIn(directory, branch, baseBranch, from, running);
    } finally {
      // --force: a completed rebase leaves the worktree clean, but an
      // aborted one may not, and this worktree is throwaway either way.
      await git(["worktree", "remove", "--force", directory], repoPath);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Why a worktree with work stopped part-way through is left exactly as it is. */
function midRebaseRefusal(directory: string, branch: string, baseBranch: string): string {
  return (
    `The worktree at ${codeSpan(directory)} has a rebase stopped part-way through — or a \`git am\`, which parks its work in the same place — ` +
    `so EO did not rebase \`${branch}\` onto \`${baseBranch}\` over the top of it. ` +
    `That state is somebody's half-finished work, conflicts resolved and commits picked, and EO will not discard it to make room for its own. ` +
    `Finish it (\`--continue\`) or drop it (\`--abort\`), then reply to retry.`
  );
}

/**
 * The rebase itself, in a worktree that has `branch` checked out —
 * whichever kind it is.
 *
 * The guard and the abort are two halves of one rule: nothing that was
 * already in progress here is ever touched. Checking first is what makes
 * the abort afterwards safe to reach for at all — with nothing running
 * when this began, anything mid-rebase when it ends is this call's own
 * doing, and taking that back leaves the worktree exactly as it was
 * found rather than parked in a state every later git command refuses
 * to run in (the same reason `verify.ts` aborts).
 */
async function rebaseIn(directory: string, branch: string, baseBranch: string, from: string | undefined, running: NetworkGitOptions): Promise<RebaseOutcome> {
  if (await rebaseInProgress(directory)) return { ok: false, conflicts: [], error: midRebaseRefusal(directory, branch, baseBranch) };

  const rebased = await git(["rebase", ...(from === undefined ? [baseBranch] : ["--onto", baseBranch, from])], directory, running);
  if (rebased.ok) return { ok: true, stdout: rebased.stdout };

  // A rebase can also fail without starting: an unstaged change, a ref
  // that does not resolve. There is nothing to take back then, and
  // `--abort` would only add its own confusing failure to the reason.
  if (!(await rebaseInProgress(directory))) {
    return { ok: false, conflicts: [], error: `Rebasing \`${branch}\` onto \`${baseBranch}\` failed: ${codeSpan(rebased.error)}` };
  }

  // Which files it stopped on, while the stopped rebase still says.
  const unmerged = await git(["diff", "--name-only", "--diff-filter=U"], directory);
  const conflicts = unmerged.ok ? unmerged.stdout.split("\n").filter((line) => line !== "") : [];

  const aborted = await git(["rebase", "--abort"], directory);
  return {
    ok: false,
    conflicts,
    error: aborted.ok
      ? `Rebasing \`${branch}\` onto \`${baseBranch}\` failed and was aborted: ${codeSpan(rebased.error)}`
      : `Rebasing \`${branch}\` onto \`${baseBranch}\` failed, and aborting it afterwards failed too — ${codeSpan(directory)} is still mid-rebase: ${codeSpan(rebased.error)} (${codeSpan(aborted.error)})`,
  };
}

/**
 * Is a rebase — or an `am`, which shares its state directory — stopped
 * part-way through in this worktree?
 *
 * The two state directories are what git's own status reads, and asking
 * git where they are is what makes this work in a linked worktree, where
 * they live under `.git/worktrees/<name>/` rather than beside the
 * checkout. `--git-path` answers relative to the working directory on
 * some versions and absolutely on others, which `resolve` settles either
 * way; a path git could not report is read as "nothing in progress",
 * since a worktree git cannot answer questions about is one the caller
 * is about to fail on anyway.
 */
async function rebaseInProgress(directory: string): Promise<boolean> {
  for (const state of ["rebase-merge", "rebase-apply"]) {
    const path = await git(["rev-parse", "--git-path", state], directory);
    if (path.ok && path.stdout !== "" && existsSync(resolve(directory, path.stdout))) return true;
  }
  return false;
}

function extractGitError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { stderr?: string; message?: string };
    const stderr = candidate.stderr?.trim();
    if (stderr) return stderr;
    if (candidate.message) return candidate.message;
  }
  return String(error);
}

/**
 * Is the `git` binary present and runnable? G-01 asks for this at
 * startup: every workspace operation depends on it, and a clear message
 * once at boot beats an opaque ENOENT on the first dispatch.
 */
export async function checkGitAvailable(): Promise<GitOutcome> {
  const result = await git(["--version"], process.cwd());
  if (!result.ok) {
    return { ok: false, error: `git is not available on PATH — EO needs it for worktrees. (${result.error})` };
  }
  return result;
}

/** Is `path` inside a git working tree? */
export async function isGitRepo(path: string): Promise<boolean> {
  const result = await git(["rev-parse", "--is-inside-work-tree"], path);
  return result.ok && result.stdout === "true";
}

/**
 * `git config --global user.email`, read once to seed the default branch
 * prefix (EO-15). Not tied to any repository — global config has none —
 * so this runs from the current working directory.
 *
 * Null covers every reason there might be nothing to read: the key was
 * never set, it was set to an empty string, or git itself is not on
 * PATH. Callers fall back to a fixed default in all three cases alike.
 */
export async function globalUserEmail(env?: Record<string, string>): Promise<string | null> {
  const result = await git(["config", "--global", "user.email"], process.cwd(), env ? { env } : {});
  if (!result.ok) return null;
  return result.stdout.trim() || null;
}

/** Uncommitted changes, staged or not, including untracked files. Empty string means clean. */
export async function statusPorcelain(repoPath: string): Promise<GitOutcome> {
  return git(["status", "--porcelain"], repoPath);
}

export async function currentBranch(repoPath: string): Promise<GitOutcome> {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
}

/** Does a local branch of this exact name exist? */
export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const result = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoPath);
  return result.ok;
}

/**
 * Does `ref` resolve to a commit in this repository — a local branch, a
 * remote-tracking branch, a tag, or a raw SHA?
 *
 * Broader than `branchExists` on purpose. It answers a different
 * question: not "has EO already made this branch" (where only
 * `refs/heads` counts) but "is what a person just named something this
 * repository actually has" (where `origin/main` is a perfectly good
 * answer). `^{commit}` is what makes a tag resolve to something a
 * worktree can be cut from.
 */
export async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const result = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath);
  return result.ok && result.stdout !== "";
}

export interface WorktreeEntry {
  path: string;
  branch: string | null; // null when detached
  head: string | null;
}

/**
 * Parses `git worktree list --porcelain`. The porcelain form is the
 * documented stable one — the human-readable listing aligns columns with
 * spaces, which is unparseable for paths that contain spaces.
 */
export async function listWorktrees(repoPath: string): Promise<{ ok: true; worktrees: WorktreeEntry[] } | { ok: false; error: string }> {
  const result = await git(["worktree", "list", "--porcelain"], repoPath);
  if (!result.ok) return result;

  const worktrees: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push({ path: current.path, branch: current.branch ?? null, head: current.head ?? null });
      // Git for Windows writes forward slashes in porcelain output even
      // though the paths supplied to EO and shown to its user use native
      // separators. Normalise at the process boundary so diagnostics do
      // not contain two spellings of the same worktree (and so callers
      // need not special-case Git for Windows).
      current = { path: normalize(line.slice("worktree ".length)) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.branch = null;
    }
  }
  if (current.path) worktrees.push({ path: current.path, branch: current.branch ?? null, head: current.head ?? null });

  return { ok: true, worktrees };
}
