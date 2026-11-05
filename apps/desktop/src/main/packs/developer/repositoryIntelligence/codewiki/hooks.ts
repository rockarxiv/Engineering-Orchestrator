import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { git } from "../../workspace/git.js";

/**
 * Keeping `codewiki init` out of a repository EO does not own (EO-141).
 *
 * `codewiki init` installs `post-commit`, `post-merge` and
 * `post-checkout` hooks that run `codewiki sync` in the background, and
 * there is no flag to decline them
 * (`crates/codewiki-cli/src/commands/init.rs`). EO writes nothing into
 * anybody's repository, and a block of shell in their `hooks/` is as
 * plain a violation of that as there is — so the hooks have to go
 * somewhere else. (EO-207 has since added two lines to
 * `.git/info/exclude`, which is a narrower thing: untracked, in nobody's
 * diff, and naming only directories EO itself generates. `workspace/excludes.ts`
 * argues it. A hook that runs on every commit is not in that class.)
 *
 * They can be sent somewhere else, and the route is entirely through
 * git. CodeWiki finds the hooks directory by shelling out to `git
 * rev-parse --git-path hooks` (`crates/codewiki-sync/src/git_hooks.rs`),
 * which honours `core.hooksPath`; and git reads `core.hooksPath` from
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` in its
 * environment, at a precedence above any config file. So a child
 * process spawned with those three variables resolves its hooks
 * directory to whatever EO points them at, without a line being written
 * to anyone's config and without `git config` ever being run against
 * their repository.
 *
 * The throwaway directory is a fresh `mkdtemp` per invocation, deleted
 * when the invocation ends. Not somewhere under the worktree: a
 * directory of executable shell scripts that a `git status` might trip
 * over, or that a later story has to teach another check to ignore, is
 * a worse neighbour than a temporary directory that stops existing.
 *
 * And then it is checked rather than assumed (invariant #5). Two things
 * make the check worth its cost even though the redirection demonstrably
 * works: the version EO pins can be replaced by a person's own
 * `configuredPath`, and upstream can change where it looks. Both are
 * silent — a hook block appears in somebody's repository and nothing
 * says so — which is exactly the failure this codebase answers by
 * verifying rather than trusting.
 *
 * What EO does having found one is put the file back the way it was:
 * byte for byte from the snapshot taken before the run, or deleted when
 * there was no file there before. Restoring the bytes rather than
 * editing out the marked block is the difference between undoing a
 * change and making a second one — a hook somebody wrote themselves
 * comes back exactly as they wrote it, whatever CodeWiki did to it.
 */

/**
 * The first line of CodeWiki's block, and the whole of what EO looks
 * for.
 *
 * Upstream's own constant, copied rather than guessed
 * (`crates/codewiki-sync/src/git_hooks.rs`), because a marker EO
 * invented would be a marker EO checks for and CodeWiki never writes —
 * a test that passes because it is looking for the wrong string is
 * worse than no test.
 */
export const CODEWIKI_HOOK_MARKER = "# >>> codewiki sync hook >>>";

/**
 * The environment that sends a child's hook resolution elsewhere.
 *
 * Appended to whatever the parent already had rather than assuming it
 * had none: `GIT_CONFIG_COUNT=1` written blindly over an inherited
 * `GIT_CONFIG_COUNT=2` would not add a setting, it would silently drop
 * the other two — and the whole reason for reaching for this mechanism
 * is that it changes one thing about one child process.
 *
 * Pure, and takes the inherited environment as an argument, so the
 * arithmetic can be asserted without a subprocess.
 */
export function hookRedirectEnv(hooksPath: string, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const declared = Number.parseInt(inherited["GIT_CONFIG_COUNT"] ?? "", 10);
  const next = Number.isInteger(declared) && declared > 0 ? declared : 0;
  return {
    GIT_CONFIG_COUNT: String(next + 1),
    [`GIT_CONFIG_KEY_${next}`]: "core.hooksPath",
    [`GIT_CONFIG_VALUE_${next}`]: hooksPath,
  };
}

/** What the repository's hooks directory looked like after EO cleaned up after CodeWiki. */
export interface HookContainmentOutcome {
  /** The repository's own hooks directory, or null when git would not name one. */
  hooksPath: string | null;
  /**
   * Hook files that carried the marker and are now exactly as they were
   * before. Absolute paths — a hook file's contents are never carried.
   */
  restored: string[];
  /** Hook files that still carry the marker: EO could not undo what was written. */
  leaked: string[];
}

export interface HookContainment {
  /** Merge this into the environment of every CodeWiki invocation that might write. */
  env: Record<string, string>;
  /** Where redirected hooks land. Deleted by `release`. */
  decoyPath: string;
  /**
   * Checks what happened to the repository's hooks, puts back anything
   * CodeWiki touched, and deletes the throwaway directory.
   *
   * Call it exactly once, from a `finally`: an invocation that threw or
   * timed out is precisely the one that may have left something behind.
   */
  release(): Promise<HookContainmentOutcome>;
}

/**
 * The hooks directory git would use for a checkout, resolved by asking
 * git.
 *
 * `--git-path hooks` rather than `<root>/.git/hooks` composed by hand,
 * for two reasons that both matter here. A linked worktree — which is
 * every checkout EO makes — has a `.git` *file*, and its hooks live in
 * the main repository's common directory, so the naive path is not
 * merely wrong, it is wrong in the direction of "EO wrote into the
 * person's own checkout and never looked at it". And a repository with
 * `core.hooksPath` already set has its hooks somewhere else entirely,
 * which is the same question CodeWiki asks git and so has to be the same
 * answer EO checks.
 */
async function repositoryHooksPath(workspacePath: string): Promise<string | null> {
  const resolved = await git(["rev-parse", "--git-path", "hooks"], workspacePath);
  if (!resolved.ok || resolved.stdout === "") return null;
  return isAbsolute(resolved.stdout) ? resolved.stdout : join(workspacePath, resolved.stdout);
}

/** Every readable file in a directory, by name, with its contents. Missing directory reads as empty. */
function readDirectoryFiles(path: string | null): Map<string, string> {
  const files = new Map<string, string>();
  if (path === null) return files;
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    // No hooks directory at all — nothing to protect and nothing to
    // check, which is the ordinary case for a repository that has never
    // had one.
    return files;
  }
  for (const name of names) {
    try {
      if (!statSync(join(path, name)).isFile()) continue;
      files.set(name, readFileSync(join(path, name), "utf8"));
    } catch {
      // A hook that cannot be read cannot be checked for the marker
      // either. Left alone deliberately: guessing at a file EO cannot
      // read is how a repository gets damaged by something meant to
      // protect it.
    }
  }
  return files;
}

function markedHooks(path: string | null): string[] {
  return [...readDirectoryFiles(path)].filter(([, contents]) => contents.includes(CODEWIKI_HOOK_MARKER)).map(([name]) => name);
}

/**
 * Points a CodeWiki invocation's git hooks somewhere disposable, and
 * gives back the means to prove it worked.
 */
export async function containHooks(workspacePath: string): Promise<HookContainment> {
  const decoyPath = mkdtempSync(join(tmpdir(), "eo-codewiki-hooks-"));
  const hooksPath = await repositoryHooksPath(workspacePath);
  // Taken before anything runs, because "was this file here before?" is
  // not a question the filesystem can answer afterwards.
  const before = readDirectoryFiles(hooksPath);

  return {
    env: hookRedirectEnv(decoyPath),
    decoyPath,
    async release(): Promise<HookContainmentOutcome> {
      // Nothing git would call a hooks directory, so there is nowhere
      // for a hook to have landed and nothing to check.
      if (hooksPath === null) {
        rmSync(decoyPath, { recursive: true, force: true });
        return { hooksPath: null, restored: [], leaked: [] };
      }

      const touched = markedHooks(hooksPath);
      for (const name of touched) {
        const original = before.get(name);
        const file = join(hooksPath, name);
        try {
          if (original === undefined) rmSync(file, { force: true });
          else writeFileSync(file, original);
        } catch {
          // Reported as leaked by the re-read below rather than here:
          // what matters is the state of the file, not whether one
          // attempt to fix it threw.
        }
      }

      const leaked = markedHooks(hooksPath);
      rmSync(decoyPath, { recursive: true, force: true });
      return {
        hooksPath,
        restored: touched.filter((name) => !leaked.includes(name)).map((name) => join(hooksPath, name)),
        leaked: leaked.map((name) => join(hooksPath, name)),
      };
    },
  };
}

/**
 * What to tell a person when CodeWiki reached the repository anyway, or
 * null when it did not.
 *
 * A sentence rather than a flag because it ends up on a card and in a
 * comment, and it names files by path and never by content — this
 * module reads hook scripts and none of them goes any further than the
 * disk it came from.
 *
 * Reported as a failure even when every file was put back. The index
 * that was built is probably fine; the containment that is supposed to
 * make this impossible is not, and an EO that quietly repaired
 * somebody's repository on every dispatch would go on doing it until
 * the day a repair failed. A build that says so is how that gets fixed
 * instead.
 */
export function describeHookEscape(outcome: HookContainmentOutcome): string | null {
  if (outcome.leaked.length > 0) {
    return `CodeWiki installed git hooks into this repository at ${outcome.leaked.join(", ")} and EO could not remove them. Remove the block marked "${CODEWIKI_HOOK_MARKER}" from those files.`;
  }
  if (outcome.restored.length > 0) {
    return `CodeWiki installed git hooks into this repository at ${outcome.restored.join(", ")} despite being pointed elsewhere. EO put those files back as they were and stopped, rather than indexing a repository it had just written to.`;
  }
  return null;
}
