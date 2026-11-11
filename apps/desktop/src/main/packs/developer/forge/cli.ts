import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { searchPath } from "../../../process/searchPath.js";
import type { ForgeKind } from "./remote.js";

const execFileAsync = promisify(execFile);

/**
 * The only file in this codebase that spawns `gh` or `glab` (F-06).
 *
 * `execFile` with an argument array, never a shell — the same discipline
 * `workspace/git.ts` documents, and for a sharper reason here: a pull
 * request body is arbitrary markdown an agent wrote. Through a shell
 * that is a command-injection hole and an unwinnable quoting problem,
 * and on Windows the quoting rules differ again.
 */

export interface CliResult {
  ok: boolean;
  stdout: string;
  error: string;
  /** The binary is not installed. Distinct from "the binary said no". */
  notFound: boolean;
}

/**
 * `options` is optional on purpose: a stub in a test that ignores it is
 * still a valid runner, and every existing call site that has nothing to
 * say about cancellation keeps reading as it did. The one thing it
 * carries is the signal, so cancelling a run actually kills the `gh`
 * that is waiting on a forge rather than leaving it behind a run the UI
 * has already called cancelled.
 */
export type CliRunner = (cli: string, args: string[], cwd: string, options?: { signal?: AbortSignal }) => Promise<CliResult>;

/**
 * Nothing here may sit waiting on a prompt nobody can see.
 *
 * A CLI that wants to page its output, notify about an update, or ask
 * for confirmation will otherwise block for as long as the process
 * lives, and the only symptom is a pull request that never appears.
 */
const NON_INTERACTIVE_ENV: Record<string, string> = {
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PAGER: "",
  GH_PROMPT_DISABLED: "1",
  GLAB_PAGER: "",
  PAGER: "cat",
  NO_COLOR: "1",
  CLICOLOR: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "echo",
  SSH_ASKPASS: "echo",
  SSH_ASKPASS_REQUIRE: "never",
};

export function createCliRunner(timeoutMs = 120_000): CliRunner {
  return async (cli, args, cwd, options) => {
    try {
      const { stdout } = await execFileAsync(cli, args, {
        cwd,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        // Read at the call, not when the runner was made: a runner built
        // before the login shell answered still finds Homebrew once it has
        // (EO-655).
        env: { ...process.env, ...NON_INTERACTIVE_ENV, PATH: searchPath() },
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return { ok: true, stdout: stdout.trim(), error: "", notFound: false };
    } catch (error) {
      const detail = error as { code?: string; stderr?: string; stdout?: string; message?: string };
      return {
        ok: false,
        stdout: (detail.stdout ?? "").trim(),
        error: (detail.stderr ?? "").trim() || detail.message || String(error),
        notFound: detail.code === "ENOENT",
      };
    }
  };
}

export const CLI_FOR: Record<ForgeKind, string> = { github: "gh", gitlab: "glab" };

export interface ExistingPullRequest {
  url: string;
  state: string;
  /**
   * Who opened it, by forge handle — read only by the read-back that
   * asks for reviewers (EO-741), since a forge will not have an author
   * review their own. Null when the answer did not say.
   */
  author: string | null;
}

export interface CreatePullRequestArgs {
  branch: string;
  base: string;
  title: string;
  /** Where the body was written. GitHub reads it from a file; GitLab has no such flag. */
  bodyFile: string;
  body: string;
  draft: boolean;
}

/**
 * The argv each forge wants, and how to read what it answers.
 *
 * Verified against `gh` 2.97 and `glab` 1.112 — the differences are
 * real and none of them is guessable:
 *
 * - `glab` has **no `--description-file`**, so the body travels as an
 *   argument. Fine under `execFile` on POSIX; the reason the body is
 *   capped for Windows.
 * - `glab` uses `--output json` where `gh` uses `--json <fields>`, and
 *   `--all` where `gh` uses `--state all`.
 * - GitLab calls the link `web_url`; GitHub calls it `url`.
 * - `--yes` is required on `glab mr create` or it waits for a
 *   confirmation nobody can answer.
 * - Reviewers are asked for after the create, by a command of their
 *   own (EO-741): `gh pr edit <url> --add-reviewer a,b`, and
 *   `glab mr update <iid> --reviewer +a,+b`, where the `+` is what adds
 *   rather than replaces. Checked against `gh` 2.103 and `glab` 1.128's
 *   help as well, which spell both the same way.
 */
export const FORGE_COMMANDS: Record<
  ForgeKind,
  {
    /**
     * `withAuthor` asks for who opened it as well, which only `gh` needs
     * telling — `glab`'s JSON carries the author whatever is asked. Only
     * the read-back that goes on to ask for reviewers sets it, so a
     * repository with none runs exactly the commands it always did.
     */
    find(branch: string, withAuthor?: boolean): string[];
    create(args: CreatePullRequestArgs): string[];
    parseFind(stdout: string): ExistingPullRequest | null;
    /**
     * Asks `reviewers` to review the pull request at `url`, adding to
     * whoever is already asked (EO-741). Null when `url` does not name
     * one this forge's CLI can be pointed at.
     */
    requestReviewers(url: string, reviewers: readonly string[]): string[] | null;
  }
> = {
  github: {
    find: (branch, withAuthor = false) => ["pr", "list", "--head", branch, "--state", "all", "--json", withAuthor ? "url,state,author" : "url,state", "--limit", "1"],
    create: ({ branch, base, title, bodyFile, draft }) => [
      "pr",
      "create",
      // Load-bearing: with an explicit head that already exists on the
      // remote, `gh` skips its interactive push-or-fork behaviour.
      "--head",
      branch,
      "--base",
      base,
      "--title",
      title,
      "--body-file",
      bodyFile,
      ...(draft ? ["--draft"] : []),
    ],
    parseFind: (stdout) =>
      firstOf(stdout, (entry) => ({ url: String(entry["url"] ?? ""), state: String(entry["state"] ?? ""), author: handleIn(entry["author"], "login") })),
    // `gh pr edit` takes the url itself, and `--add-reviewer` a
    // comma-separated list of logins and `org/team`s.
    requestReviewers: (url, reviewers) => ["pr", "edit", url, "--add-reviewer", reviewers.join(",")],
  },
  gitlab: {
    // `mr list` rather than `mr view`: an absent merge request comes back
    // as an empty array instead of a non-zero exit, so "none yet" and
    // "something went wrong" stay distinguishable.
    find: (branch) => ["mr", "list", "--source-branch", branch, "--all", "--output", "json"],
    create: ({ branch, base, title, body, draft }) => [
      "mr",
      "create",
      "--source-branch",
      branch,
      "--target-branch",
      base,
      "--title",
      title,
      "--description",
      body,
      // Without this it waits on a confirmation prompt forever.
      "--yes",
      ...(draft ? ["--draft"] : []),
    ],
    parseFind: (stdout) =>
      firstOf(stdout, (entry) => ({
        url: String(entry["web_url"] ?? entry["url"] ?? ""),
        state: String(entry["state"] ?? ""),
        author: handleIn(entry["author"], "username"),
      })),
    // By the merge request's iid, which its url ends in: `glab` 1.112
    // selects one by id or branch, not by url. Each name is prefixed `+`,
    // because an unprefixed `--reviewer` *replaces* whoever is asked.
    requestReviewers: (url, reviewers) => {
      const iid = /\/merge_requests\/(\d+)(?:[/?#]|$)/.exec(url)?.[1];
      return iid === undefined ? null : ["mr", "update", iid, "--reviewer", reviewers.map((reviewer) => `+${reviewer}`).join(",")];
    },
  },
};

/** The handle in an author object — `gh`'s `{ login }`, `glab`'s `{ username }` — or null. */
function handleIn(author: unknown, key: string): string | null {
  if (typeof author !== "object" || author === null) return null;
  const handle = (author as Record<string, unknown>)[key];
  return typeof handle === "string" && handle !== "" ? handle : null;
}

function firstOf(stdout: string, map: (entry: Record<string, unknown>) => ExistingPullRequest): ExistingPullRequest | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const mapped = map(entry as Record<string, unknown>);
      if (mapped.url !== "") return mapped;
    }
    return null;
  } catch {
    // A CLI that printed something other than JSON has not told us there
    // is no pull request; it has told us nothing.
    return null;
  }
}
