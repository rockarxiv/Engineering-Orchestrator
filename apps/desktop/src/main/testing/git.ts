import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, statusPorcelain } from "../packs/developer/workspace/git.js";

/**
 * Git fixtures for tests, in one place.
 *
 * Thirty-three test files initialise a repository. Fifteen of them
 * carried a byte-identical `run` wrapper and seven their own `makeRepo`,
 * and those now come from here. The rest build their repositories in
 * shapes of their own — a clone of a fixture, a bare `execFileSync` in
 * an opt-in live test, a shim with its own recipe — and are left as
 * they are; a helper general enough to absorb all of them would be a
 * second thing to understand rather than one thing to reuse.
 *
 * What every one of them shares is the signing switch, and that is the
 * part that was drifting dangerously: most set `commit.gpgsign false`
 * without `tag.gpgsign`, and a developer machine that signs globally
 * (1Password, gpg) turns a fixture that tags into "failed to write
 * commit object" the moment the signing agent is away. That is the
 * failure that killed EO-204's first implementation run, reproduced
 * inside the suite. `HERMETIC_GIT_CONFIG` is the one place the full set
 * is written down; the inline recipes set both switches beside it.
 *
 * Only tests import this module. It ships nowhere: electron-vite bundles
 * from entry points, and nothing under `src/main` outside a test reaches
 * for it — `testing.test.ts` holds that as an invariant.
 */

/** Everything a fixture repository sets so it behaves the same on every machine. */
export const HERMETIC_GIT_CONFIG: ReadonlyArray<readonly [key: string, value: string]> = [
  ["user.email", "eo@example.com"],
  ["user.name", "EO Test"],
  // A developer machine may sign commits and tags globally, and a
  // signing agent that is absent or rate-limited turns into "failed to
  // write commit object". Both switches, because they are separate
  // settings and a fixture that tags needs the second.
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
];

/**
 * Run git and unwrap the outcome, throwing on failure.
 *
 * Returns stdout, which the callers that only wanted the side effect
 * ignore and the callers that read `rev-parse HEAD` need.
 */
export async function run(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.error}`);
  return result.stdout;
}

/** `git status --porcelain`, unwrapped — a failure here is a broken fixture, not a finding. */
export async function status(path: string): Promise<string> {
  const result = await statusPorcelain(path);
  if (!result.ok) throw new Error(`git status failed: ${result.error}`);
  return result.stdout;
}

/**
 * An empty repository on `main`, configured hermetically, with no commit.
 *
 * For fixtures that go on to commit something specific, or that only need
 * a directory git recognises (Codex refuses to run outside one).
 */
export async function initRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  await run(["init", "-b", "main"], path);
  for (const [key, value] of HERMETIC_GIT_CONFIG) await run(["config", key, value], path);
}

export interface MakeRepoOptions {
  /** The README's content. Defaults to a heading naming the repository. */
  readme?: string;
  /** The initial commit's message. */
  message?: string;
}

/**
 * A repository under `scratch/<name>` with one commit on `main`, and its path.
 *
 * The shape most fixtures want: something to branch from, something a
 * worktree can check out, something with a history of exactly one.
 */
export async function makeRepo(scratch: string, name: string, options: MakeRepoOptions = {}): Promise<string> {
  const path = join(scratch, name);
  await initRepo(path);
  writeFileSync(join(path, "README.md"), options.readme ?? `# ${name}\n`);
  await run(["add", "-A"], path);
  await run(["commit", "-m", options.message ?? "initial"], path);
  return path;
}
