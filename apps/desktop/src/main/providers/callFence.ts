import { execFile } from "node:child_process";
import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename as lastPart, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { CallFence } from "@eo/core";

/**
 * The fence around an implementer's or a reviewer's turn (EO-926), decided
 * once for both backends.
 *
 * Those turns run with the backend's sandbox off (`bypassPermissions` on
 * Claude, `danger-full-access` on Codex), and since EO-910 EO pushes an
 * item's branch itself: an implementer pushes only when an engine note
 * says the remote branch diverged, and then only `--force-with-lease` to
 * the item's own branch. So the turn's calls are held here, at the call,
 * by the same delivery the learning review's refusals use
 * (`callRefusal.ts`): each backend's `PreToolUse` hook asks this about
 * every call and refuses the ones it answers for — Claude's in EO's own
 * process (`claude.ts`), Codex's through the listener its hook command
 * posts to (`codexSearchHook.ts`).
 *
 * What it refuses:
 * - on a turn that may push (`pushBranch` set): a `git push` without
 *   `--force-with-lease`, one with a bare `--force`, `-f` or a
 *   `+refspec`, one that names any branch but `pushBranch` or pushes
 *   more than one (`--all`, `--mirror`, `--tags`, `--delete`), one run
 *   from outside the worktree or pointed at another repository, and one
 *   whose destination git would work out for itself — no refspec, or one
 *   with no `:<dst>` — unless the checkout's own state says that
 *   destination is `pushBranch` (`FenceGit`): git maps such a push
 *   through `remote.<name>.push`, `push.default` and the branch's
 *   upstream, so the words alone do not say where it goes;
 * - on a turn that may not (`pushBranch` null, the reviewer's): every
 *   `git push`;
 * - on both: `gh pr merge`, because merging is EO's;
 * - on both: a structured file write — Claude's `Write`, `Edit`,
 *   `MultiEdit` and `NotebookEdit`, Codex's `apply_patch` — whose target
 *   is outside `root`.
 *
 * Every command a line runs is looked at, wherever it is: after `&&`, `;`
 * or a pipe, inside `$(…)` and backticks — in double quotes and unquoted
 * heredocs too, where the shell still runs them — inside `<(…)`, behind
 * `env`, `sudo`, `xargs` or `eval`, and in a `sh -c` script. The directory
 * a command runs in starts where the hook says the call runs (Claude's
 * session directory, Codex's `workdir`) and follows `cd`, `pushd`,
 * `env -C` and `git -C`.
 *
 * **A guard against accidents, not a sandbox.** A shell command is read as
 * words: an alias, a variable holding `push`, a script file or a second
 * language are not understood. A write made through the shell (`echo > /x`,
 * `cp`, `sed -i`) is not looked at for its path at all. ARCHITECTURE.md
 * says so where the fence is described.
 */

/** Which of the fence's rules refused a call. Stored on the run's `call_refused` event. */
export type FenceRule =
  | "push_on_review"
  | "push_forced"
  | "push_without_lease"
  | "push_elsewhere"
  | "push_outside_worktree"
  | "push_unverified"
  | "push_reconfigured"
  | "push_after_git_change"
  | "pr_merge"
  | "write_outside_worktree"
  | "unreadable_patch";

/** A call the fence refused: which rule, what it refused, and what the agent is told. */
export interface FenceRefusal {
  rule: FenceRule;
  /** The command line, or the path the write named. */
  call: string;
  reason: string;
}

/** What the fence reads of a checkout to know where a push with no explicit destination goes. */
export interface CheckoutState {
  /** The branch checked out there, or null where `HEAD` is detached. */
  branch: string | null;
  /** Its configuration as `git config --list` gives it: section and key lowercased, a subsection as written. */
  config: ReadonlyMap<string, readonly string[]>;
}

/** How the fence asks git about a checkout. A seam for tests; `readCheckout` is the real one. */
export interface FenceGit {
  /** The checkout at `dir`, or null where git cannot say — not a repository, no git, too slow. */
  state(dir: string): Promise<CheckoutState | null>;
}

/** Said at the end of every refusal, so the agent reads it as the fence and not as a fault. */
const FENCE_NOTE = "This is EO's fence around this turn, not a failure to work around: nothing the call would have done happened.";

/** The longest command line a refusal records. A heredoc can be a whole file. */
const LONGEST_CALL = 2000;

/** The tools that write one file named by a field of their input, by each backend's name, and that field. */
const FILE_TOOLS: Readonly<Record<string, string>> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/** The shell tool's name in both backends' hook payloads. */
const SHELL_TOOL = "Bash";
/** Codex's patch tool, whose input is the patch text. */
const PATCH_TOOL = "apply_patch";

/**
 * Why the fence refuses this call, or null for one it lets through.
 *
 * `tool` and `input` are what the hook was handed (`tool_name`,
 * `tool_input`); `cwd` is the directory the hook says the call runs in,
 * which a relative path and a shell command start from, and `fence.root`
 * where it says none.
 */
export async function fencedCall(tool: string, input: unknown, fence: CallFence, cwd?: string, git: FenceGit = readCheckout): Promise<FenceRefusal | null> {
  const fields = asRecord(input);
  const base = cwd ?? fence.root;
  if (tool === SHELL_TOOL) {
    const command = fields?.["command"];
    if (typeof command === "string") return shellRefusal(command, fence, base, git);
    if (Array.isArray(command) && command.every((word) => typeof word === "string")) {
      return commandsRefusal([{ words: command as string[], frame: [], detached: false, targets: [] }], command.join(" "), fence, shellScope(base), git, 0);
    }
    return null;
  }
  const field = FILE_TOOLS[tool];
  if (field !== undefined) {
    const path = fields?.[field];
    if (typeof path !== "string" || path === "") return null;
    return writeRefusal(rawJoin(base, path), fence);
  }
  if (tool === PATCH_TOOL) {
    const text = typeof input === "string" ? input : [fields?.["command"], fields?.["input"], fields?.["patch"]].find((value): value is string => typeof value === "string");
    const targets = text === undefined ? [] : patchTargets(text);
    if (targets.length === 0) {
      return { rule: "unreadable_patch", call: (text ?? "").slice(0, LONGEST_CALL), reason: `EO refused this call: it could not tell which files this patch writes, and on this turn a patch may only write inside ${fence.root}. ${FENCE_NOTE}` };
    }
    for (const path of targets) {
      const refused = await writeRefusal(rawJoin(base, path), fence);
      if (refused !== null) return refused;
    }
  }
  return null;
}

/**
 * Why a write to `target` is refused, or null where it lands in the
 * worktree — judged where it really lands (EO-926 review): through any
 * link on the way, so `<worktree>/linked/x` with `linked` pointing at
 * another checkout is a write to that checkout.
 */
async function writeRefusal(raw: string, fence: CallFence): Promise<FenceRefusal | null> {
  const target = resolve(raw);
  const landing = await whereItLands(raw).catch(() => null);
  const root = await whereItLands(fence.root).catch(() => resolve(fence.root));
  if (landing !== null && inside(root, landing)) return null;
  return outside(target, fence, landing);
}

/** The most links the fence follows for one path before calling it unknowable. */
const MOST_LINKS = 40;

/**
 * Where a path really is (EO-926 review): every link in it followed, a
 * dangling one included — a write through it creates its target — for a
 * path whose last parts need not exist yet, which is what a new file is.
 *
 * Walked a component at a time, as the kernel does: a link's target is
 * read as it is met and its own components walked in its place, so a
 * `..` applies to where the link really led. `pivot/../x` with `pivot` a
 * link to `/elsewhere/nested` is `/elsewhere/x`, which collapsing the
 * text first would have called `./x`. So `path` must not be normalised
 * before it is handed here (`rawJoin`). Throws where it cannot be told:
 * a link loop, or no access.
 */
export async function whereItLands(path: string): Promise<string> {
  const start = isAbsolute(path) ? path : rawJoin(process.cwd(), path);
  let current = rootOf(start);
  const pending = components(start.slice(parse(start).root.length));
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift() ?? "";
    if (part === "" || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let isLink = false;
    try {
      isLink = (await lstat(next)).isSymbolicLink();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    if (!isLink) {
      current = next;
      continue;
    }
    if (++links > MOST_LINKS) throw new Error(`more than ${String(MOST_LINKS)} links`);
    const target = await readlink(next);
    if (isAbsolute(target)) {
      current = rootOf(target);
      pending.unshift(...components(target.slice(parse(target).root.length)));
    } else {
      pending.unshift(...components(target));
    }
  }
  return canonical(current);
}

/**
 * The root an absolute path starts from, with its drive: on Windows
 * `/etc` is on the current drive, which `parse` alone would leave off.
 */
function rootOf(path: string): string {
  return parse(resolve(parse(path).root)).root;
}

/**
 * The same path as the filesystem spells it: its deepest existing part
 * through `realpath`, the rest as it is. The walk has already followed
 * every link, so all this changes is spelling — a Windows short name
 * (`RUNNER~1`) or a letter's case — which would otherwise make one
 * directory read as two.
 */
async function canonical(path: string): Promise<string> {
  let existing = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(existing), ...rest);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(existing);
      if (parent === existing) return path;
      rest.unshift(lastPart(existing));
      existing = parent;
    }
  }
}

/** A path's components, split on this platform's separators only: a backslash is a name's on POSIX. */
function components(path: string): string[] {
  return path.split(sep === "\\" ? /[\\/]+/ : /\/+/);
}

/** `relative` under `base`, as text, with nothing collapsed: a `..` in it is for `whereItLands` to apply. */
function rawJoin(base: string, relative: string): string {
  // `/` on every platform: Windows takes it as a separator too.
  return isAbsolute(relative) ? relative : `${base}/${relative}`;
}

/** Whether `dir` really is in the worktree, through any link on the way. */
async function reallyInside(root: string, dir: string): Promise<boolean> {
  if (!inside(root, resolve(dir))) return false;
  const landing = await whereItLands(dir).catch(() => null);
  const realRoot = await whereItLands(root).catch(() => resolve(root));
  return landing !== null && inside(realRoot, landing);
}

function outside(target: string, fence: CallFence, landing: string | null = target): FenceRefusal {
  const where = landing === null ? ", or EO cannot tell where it lands" : landing === target ? "" : ` (through a link, it is \`${landing}\`)`;
  return {
    rule: "write_outside_worktree",
    call: target,
    reason: `EO refused this call: on this turn files may only be written inside the item's worktree, ${fence.root}, and \`${target}\` is outside it${where}. ${FENCE_NOTE}`,
  };
}

/** Whether `target` is `root` or under it, as paths. Links are followed before this is asked (`whereItLands`). */
function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The files a patch in Codex's format adds, updates, deletes or moves to. */
export function patchTargets(text: string): string[] {
  const targets: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (match?.[1] !== undefined) targets.push(match[1].trim());
  }
  return targets;
}

/** The fence's answer to one command line, run from `cwd`. */
export function shellRefusal(command: string, fence: CallFence, cwd: string = fence.root, git: FenceGit = readCheckout): Promise<FenceRefusal | null> {
  const scope = shellScope(cwd);
  return commandsRefusal(parseCommands(command, [], scope.frames), command, fence, scope, git, 0);
}

/** How deep `sh -c '…'` and `eval` are read into. A command nested further than this is not looked at. */
const DEEPEST_NESTING = 4;

/**
 * Where each part of a shell is as a line runs (EO-926 review).
 *
 * A `cd` moves the shell it runs in and no other: one inside `( … )`,
 * `$( … )`, backticks or `<( … )` moves that subshell, which is a frame of
 * its own here, and never the line around it. A frame's directory is its
 * own once it has `cd`'d and its parent's until then; null once it cannot
 * be told (`cd -`, `cd "$X"`, `popd`, or a `cd` in a pipeline or in the
 * background, which some shells run in the current shell and some do not).
 */
interface ShellScope {
  /** Where the line starts: the directory the hook says the call runs in. */
  base: string | null;
  /** Each frame's own directory, keyed by its path, once it has moved. */
  dirs: Map<string, string | null>;
  /** Variables the line has set or exported for everything after them — conservatively, in every frame. */
  exported: Set<string>;
  /** Hands out frame ids, shared with every parse of this line. */
  frames: { next: number };
  /**
   * An earlier command in the line may have changed git's configuration
   * or which branch is checked out (`changesGit`). The checkout the fence
   * reads is as it was before the call, so a push after that is not
   * checked against what it will meet. Shared by every frame and nested
   * shell: configuration outlives the process that wrote it.
   */
  gitChanged: { since: string | null };
}

function shellScope(base: string | null): ShellScope {
  return { base, dirs: new Map(), exported: new Set(), frames: { next: 1 }, gitChanged: { since: null } };
}

const frameKey = (frame: readonly number[]): string => frame.join(".");

/** The directory a command in `frame` runs in: its own frame's, or the nearest enclosing one's. */
function dirIn(scope: ShellScope, frame: readonly number[]): string | null {
  for (let depth = frame.length; depth >= 0; depth--) {
    const key = frameKey(frame.slice(0, depth));
    if (scope.dirs.has(key)) return scope.dirs.get(key) ?? null;
  }
  return scope.base;
}

/** Programs that set a variable for the commands after them. */
const EXPORTING = new Set(["export", "declare", "typeset", "readonly", "local"]);

async function commandsRefusal(commands: readonly ShellCommand[], line: string, fence: CallFence, scope: ShellScope, git: FenceGit, depth: number): Promise<FenceRefusal | null> {
  const call = line.length > LONGEST_CALL ? `${line.slice(0, LONGEST_CALL)}…` : line;
  for (const { words, frame, detached, targets } of commands) {
    const { argv, assigned, chdir } = withoutPrefixes(words);
    const here = dirIn(scope, frame);
    // `env -C <dir>` runs the one command there; the line goes on where it was.
    const dir = chdir === undefined ? here : moved(here, chdir);
    const program = basename(argv[0] ?? "");
    // A bare assignment, or `export NAME=…`, reaches every command after it.
    if (argv.length === 0) for (const name of assigned) scope.exported.add(name);
    if (EXPORTING.has(program)) for (const arg of argv.slice(1)) if (!arg.startsWith("-")) scope.exported.add(arg.split("=")[0] ?? arg);
    const environment = [...assigned, ...scope.exported];
    if (program === "cd" || program === "pushd" || program === "popd") {
      const to = program === "popd" ? null : (argv.slice(1).find((arg) => !arg.startsWith("-") || arg === "-") ?? null);
      // In a pipeline or the background, whether the move outlives the
      // command depends on the shell: the frame's directory is unknown.
      scope.dirs.set(frameKey(frame), detached ? null : moved(here, to));
    } else if (program === "git") {
      const rule = await gitRefusal(argv.slice(1), fence, dir, environment, git, scope.gitChanged.since !== null);
      if (rule !== null) return { rule, call, reason: pushReason(rule, fence, scope.gitChanged.since) };
    } else if (program === "gh") {
      if (isPrMerge(argv.slice(1))) {
        return { rule: "pr_merge", call, reason: `EO refused this call: \`gh pr merge\` is refused on this turn, because merging a pull request is EO's to do. ${FENCE_NOTE}` };
      }
    } else if (depth < DEEPEST_NESTING && program === "eval") {
      // `eval` runs its words in this very shell: its `cd` moves this frame.
      const nested = await commandsRefusal(parseCommands(argv.slice(1).join(" "), frame, scope.frames), line, fence, scope, git, depth + 1);
      if (nested !== null) return nested;
    } else if (depth < DEEPEST_NESTING && SHELLS.has(program)) {
      // `sh -c` is another process: it starts where this command runs, and
      // nothing it does to its directory comes back.
      const script = shellScript(argv.slice(1));
      if (script !== null) {
        const child: ShellScope = { base: dir, dirs: new Map(), exported: scope.exported, frames: scope.frames, gitChanged: scope.gitChanged };
        const nested = await commandsRefusal(parseCommands(script, [], child.frames), line, fence, child, git, depth + 1);
        if (nested !== null) return nested;
      }
    }
    if (scope.gitChanged.since === null && changesGit(program, argv.slice(1), targets)) scope.gitChanged.since = words.join(" ");
  }
  return null;
}

/** git subcommands that change what a later push would meet: configuration, remotes, upstreams, which branch is checked out, refs. */
const GIT_STATE_CHANGING = new Set(["checkout", "switch", "update-ref", "init", "clone", "worktree", "submodule", "filter-branch", "replace"]);
/** `git config` options that only read. */
const CONFIG_READING = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "-l", "--list"]);
/** `git config` options that write. */
const CONFIG_WRITING = /^(--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|--edit|-e)$/;
/** `git branch` options that change an upstream, a name or the current branch's ref. */
const BRANCH_CHANGING = /^(-u|--set-upstream-to(=.*)?|--set-upstream|--unset-upstream|-t|--track(=.*)?|-m|-M|--move|-c|-C|--copy|--edit-description)$/;
/** `git remote` subcommands that only read. */
const REMOTE_READING = new Set(["show", "get-url"]);
/** A path that is git's configuration: a `.git` directory's contents, `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`. */
const GIT_CONFIG_PATH = /(^|[/\\])\.git([/\\]|$)|\.gitconfig|(^|[/\\])git[/\\]config$/;
/** Programs that read the files they are given and write none. */
const READING_PROGRAMS = new Set(["cat", "less", "more", "head", "tail", "grep", "egrep", "fgrep", "rg", "ls", "stat", "wc", "file", "diff", "cmp", "test", "[", "echo", "printf", "cd", "pushd", "realpath", "readlink"]);

/**
 * Whether a command may change what a later push in the same call meets
 * (EO-926 review): git's configuration, its remotes, an upstream, which
 * branch is checked out, or a ref — through git itself, or by writing a
 * file that is git's configuration (a redirection's target included).
 * Conservative: a command it cannot tell about, it counts.
 */
function changesGit(program: string, args: readonly string[], targets: readonly string[]): boolean {
  if (targets.some((target) => GIT_CONFIG_PATH.test(target))) return true;
  if (program === "git") {
    let index = 0;
    while (index < args.length && (args[index] ?? "").startsWith("-")) index += GIT_VALUE_OPTIONS.has(args[index] ?? "") ? 2 : 1;
    const subcommand = args[index] ?? "";
    const rest = args.slice(index + 1);
    const positional = rest.filter((arg) => !arg.startsWith("-"));
    if (GIT_STATE_CHANGING.has(subcommand)) return true;
    if (subcommand === "config") {
      if (rest.some((arg) => CONFIG_READING.has(arg)) || positional[0] === "get" || positional[0] === "list") return false;
      return rest.some((arg) => CONFIG_WRITING.test(arg)) || positional.length !== 1;
    }
    if (subcommand === "remote") return positional.length > 0 && !REMOTE_READING.has(positional[0] ?? "");
    if (subcommand === "branch") return rest.some((arg) => BRANCH_CHANGING.test(arg));
    if (subcommand === "symbolic-ref") return positional.length >= 2 || rest.some((arg) => arg === "-d" || arg === "--delete");
    return false;
  }
  if (READING_PROGRAMS.has(program)) return false;
  return args.some((arg) => GIT_CONFIG_PATH.test(arg));
}

/** Where `cd <to>` leaves a shell that was at `from`: null where that cannot be told without running it. */
function moved(from: string | null, to: string | null): string | null {
  if (from === null || to === null || to === "-" || to.includes("$") || to.includes("`")) return null;
  if (to === "~") return homedir();
  if (to.startsWith("~/")) return rawJoin(homedir(), to.slice(2));
  if (to.startsWith("~")) return null;
  // As text: `cd pivot/..` is wherever `pivot` leads, then up (`whereItLands`).
  return rawJoin(from, to);
}

function pushReason(rule: FenceRule, fence: CallFence, gitChangedBy: string | null = null): string {
  const branch = fence.pushBranch ?? "";
  switch (rule) {
    case "push_on_review":
      return `EO refused this call: this turn may not push at all — EO pushes the item's branch itself. ${FENCE_NOTE}`;
    case "push_forced":
      return `EO refused this call: on this turn \`git push\` may only overwrite with \`--force-with-lease\`, so a bare \`--force\`, \`-f\` or a \`+refspec\` is refused. ${FENCE_NOTE}`;
    case "push_without_lease":
      return `EO refused this call: on this turn \`git push\` is only allowed as \`git push --force-with-lease\` to the item's own branch, ${branch}, and only when an engine note says the remote branch diverged — otherwise EO does the pushing. ${FENCE_NOTE}`;
    case "push_outside_worktree":
      return `EO refused this call: on this turn \`git push\` may only be run in the item's worktree, ${fence.root}, and this one runs elsewhere, in another repository, or somewhere EO cannot tell. ${FENCE_NOTE}`;
    case "push_after_git_change":
      return `EO refused this call: an earlier command in it (\`${gitChangedBy ?? ""}\`) may change git's configuration, remotes or checked-out branch, so EO cannot check where this push goes before the call runs. Run the push as a call of its own. ${FENCE_NOTE}`;
    case "push_reconfigured":
      return `EO refused this call: this push changes git's configuration for itself — with \`-c\`, \`--config-env\` or a \`GIT_*\` variable set on the command or earlier in it — which can change what a push sends, and EO cannot see it. Push without the override. ${FENCE_NOTE}`;
    case "push_unverified":
      return `EO refused this call: this push leaves its destination for git to work out, and EO could not establish from this checkout's branch and configuration that it is ${branch}. Name the destination instead: \`git push --force-with-lease <remote> HEAD:refs/heads/${branch}\`. ${FENCE_NOTE}`;
    default:
      return `EO refused this call: on this turn \`git push\` may only update the item's own branch, ${branch}, and this push names another branch or more than one. ${FENCE_NOTE}`;
  }
}

/** The shells whose `-c` script is read as commands too. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** The script a shell is handed with `-c`, or null where it is handed none. */
function shellScript(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const word = args[index] ?? "";
    if (!word.startsWith("-") || word.startsWith("--")) return null;
    if (word.slice(1).includes("c")) return args[index + 1] ?? null;
  }
  return null;
}

/** Words before the program that do not change which program runs. */
const TRANSPARENT = new Set(["{", "}", "(", "!", "then", "do", "else", "elif", "if", "while", "until"]);
/** Programs that run the rest of their words as a command, and those of their options that take a value. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir"]),
  xargs: new Set(["-I", "-n", "-L", "-P", "-d", "-E", "-s", "-a", "--max-args", "--max-lines", "--max-procs", "--delimiter", "--arg-file"]),
  time: new Set(["-f", "-o", "--format", "--output"]),
  nohup: new Set(),
  exec: new Set(["-a"]),
  command: new Set(),
  builtin: new Set(),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
};

/** A command's words without what comes before its program: the program and its arguments, the names assigned for it, and `env -C`'s directory. */
function withoutPrefixes(words: readonly string[]): { argv: string[]; assigned: string[]; chdir?: string } {
  const assigned: string[] = [];
  let chdir: string | undefined;
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? "";
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word);
    if (assignment?.[1] !== undefined) {
      assigned.push(assignment[1]);
      index++;
      continue;
    }
    if (TRANSPARENT.has(word)) {
      index++;
      continue;
    }
    const valued = WRAPPERS[basename(word)];
    if (valued === undefined) break;
    const wrapper = basename(word);
    index++;
    // The wrapper's own options, until its command.
    while (index < words.length) {
      const option = words[index] ?? "";
      if (!option.startsWith("-") || option === "-") break;
      index++;
      if (option === "--") break;
      const name = option.includes("=") ? option.slice(0, option.indexOf("=")) : option;
      const value = option.includes("=") ? option.slice(option.indexOf("=") + 1) : valued.has(option) ? (words[index++] ?? "") : undefined;
      if (wrapper === "env" && (name === "-C" || name === "--chdir") && value !== undefined) chdir = value;
    }
    // `timeout`'s first word is its duration.
    if (wrapper === "timeout" && index < words.length) index++;
  }
  return { argv: words.slice(index), assigned, ...(chdir === undefined ? {} : { chdir }) };
}

function basename(program: string): string {
  const slash = Math.max(program.lastIndexOf("/"), program.lastIndexOf("\\"));
  const name = slash === -1 ? program : program.slice(slash + 1);
  return name.toLowerCase().endsWith(".exe") ? name.slice(0, -4) : name;
}

/** git's own options before the subcommand that take a value as the next word. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path", "--super-prefix"]);
/** Those that point git at another repository or checkout. */
const GIT_RELOCATING = new Set(["--git-dir", "--work-tree", "--namespace"]);
/** Those that change git's configuration for this one command. */
const GIT_CONFIGURING = new Set(["-c", "--config-env"]);
/** Environment variables that do either, set on the command itself. */
const GIT_RELOCATING_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]);
/**
 * `GIT_*` variables that cannot change what a push sends or where. Any other
 * — `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, `GIT_CONFIG_PARAMETERS`,
 * `GIT_CONFIG_GLOBAL`, `GIT_EXEC_PATH` and the rest — counts as configuring
 * git for the push.
 */
const GIT_HARMLESS_ENV = /^GIT_(TRACE\w*|TERMINAL_PROMPT|PAGER|EDITOR|ASKPASS|SSH|SSH_COMMAND|AUTHOR_\w+|COMMITTER_\w+|MERGE_AUTOEDIT|PROGRESS_DELAY)$/;

/** Which rule refuses this `git …` (its words after `git`), run in `dir`, or null. */
async function gitRefusal(args: readonly string[], fence: CallFence, dir: string | null, assigned: readonly string[], git: FenceGit, gitChanged: boolean): Promise<FenceRule | null> {
  let index = 0;
  let relocated = assigned.some((name) => GIT_RELOCATING_ENV.has(name));
  let configured = assigned.some((name) => name.startsWith("GIT_") && !GIT_RELOCATING_ENV.has(name) && !GIT_HARMLESS_ENV.test(name));
  let at = dir;
  while (index < args.length && (args[index] ?? "").startsWith("-")) {
    const option = args[index] ?? "";
    const name = option.includes("=") ? option.slice(0, option.indexOf("=")) : option;
    if (GIT_RELOCATING.has(name)) relocated = true;
    if (GIT_CONFIGURING.has(name)) configured = true;
    if (option === "-C") at = moved(at, args[index + 1] ?? null);
    index += GIT_VALUE_OPTIONS.has(option) ? 2 : 1;
  }
  if (args[index] !== "push") return null;
  if (fence.pushBranch === null) return "push_on_review";
  return pushRefusal(args.slice(index + 1), fence.pushBranch, fence.root, { dir: at, relocated, configured, gitChanged }, git);
}

/** Push options that update refs other than the one named, or remove one. */
const WIDE_PUSH = new Set(["--all", "--branches", "--mirror", "--tags", "--follow-tags", "--delete", "--prune"]);
/** Push options that take a value as the next word. */
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec"]);

/** Where a push runs: its directory, and whether git was pointed elsewhere or configured for it on the command line. */
interface PushPlace {
  dir: string | null;
  relocated: boolean;
  configured: boolean;
  /** An earlier command in the call may have changed git's configuration or branch. */
  gitChanged: boolean;
}

async function pushRefusal(args: readonly string[], branch: string, root: string, place: PushPlace, git: FenceGit): Promise<FenceRule | null> {
  let lease = false;
  let forced = false;
  let wide = false;
  let repositoryNamed = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--force") forced = true;
    else if (arg === "--force-with-lease" || arg.startsWith("--force-with-lease=")) lease = true;
    else if (arg === "--no-force-with-lease") lease = false;
    else if (WIDE_PUSH.has(arg)) wide = true;
    else if (arg === "--repo") {
      repositoryNamed = true;
      index++;
    } else if (arg.startsWith("--repo=")) repositoryNamed = true;
    else if (PUSH_VALUE_OPTIONS.has(arg)) index++;
    else if (arg.startsWith("--")) continue;
    else if (arg.startsWith("-") && arg.length > 1) {
      // A group of short flags, `-fu` as much as `-f`. `-o` takes the
      // rest of the group, or the next word, as its value.
      for (let at = 1; at < arg.length; at++) {
        const flag = arg[at];
        if (flag === "f") forced = true;
        else if (flag === "d") wide = true;
        else if (flag === "o") {
          if (at === arg.length - 1) index++;
          break;
        }
      }
    } else positional.push(arg);
  }
  const refspecs = repositoryNamed ? positional : positional.slice(1);
  if (forced || refspecs.some((refspec) => refspec.startsWith("+"))) return "push_forced";
  if (wide) return "push_elsewhere";
  if (!lease) return "push_without_lease";
  // Only from the item's worktree, and only into its repository.
  if (place.relocated || place.dir === null || !(await reallyInside(root, place.dir))) return "push_outside_worktree";
  // Configuration set for this command alone — `push.followTags`, a push
  // refspec, a mirror — widens even an explicit push, and the checkout
  // EO reads does not hold it.
  if (place.configured) return "push_reconfigured";
  // What EO reads below is the checkout before this call ran; a command
  // before the push may have changed it, so its destination is not known.
  if (place.gitChanged) return "push_after_git_change";
  // An explicit destination is the one git updates, whatever is configured.
  for (const refspec of refspecs) {
    const colon = refspec.indexOf(":");
    if (colon === -1) {
      if (refspec !== "HEAD" && branchName(refspec) !== branch) return "push_elsewhere";
      continue;
    }
    if (colon === 0 || branchName(refspec.slice(colon + 1)) !== branch) return "push_elsewhere";
  }
  // What the checkout adds to every push: a mirroring remote pushes every
  // ref, and `push.followTags` the tags beside the branch.
  const state = await git.state(place.dir);
  if (state === null) return "push_unverified";
  for (const [key, values] of state.config) {
    if (/^remote\..+\.mirror$/.test(key) && values.some(isTrue)) return "push_elsewhere";
  }
  if ((state.config.get("push.followtags") ?? []).some(isTrue)) return "push_elsewhere";
  // A push with no `:<dst>` — none at all, a branch's name, `HEAD` — goes
  // where git maps it: through `remote.<name>.push` (which remaps even a
  // named branch), `push.default` and the branch's upstream. Allowed only
  // where the checkout says that is the item's branch.
  const implicit = refspecs.length === 0 || refspecs.some((refspec) => !refspec.includes(":"));
  if (!implicit) return null;
  for (const key of state.config.keys()) {
    if (/^remote\..+\.push$/.test(key)) return "push_unverified";
  }
  if (state.branch !== branch) return refspecs.length === 0 || refspecs.includes("HEAD") ? "push_unverified" : null;
  if (refspecs.length > 0) return null;
  const pushDefault = (state.config.get("push.default") ?? []).at(-1) ?? "simple";
  const upstream = (state.config.get(`branch.${branch}.merge`) ?? []).at(-1);
  if (pushDefault === "current") return null;
  if (pushDefault === "simple") return upstream === undefined || branchName(upstream) === branch ? null : "push_unverified";
  if (pushDefault === "upstream" || pushDefault === "tracking") return upstream !== undefined && branchName(upstream) === branch ? null : "push_unverified";
  return "push_unverified";
}

function branchName(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/** git's spelling of true. A key with no value at all is true as well. */
function isTrue(value: string): boolean {
  return ["", "true", "yes", "on", "1"].includes(value.trim().toLowerCase());
}

/** How long the fence waits for git, which is waiting on a tool call. */
const GIT_TIMEOUT_MS = 5_000;

/** The real `FenceGit`: two git commands in the checkout, neither of which writes anything. */
export const readCheckout: FenceGit = {
  async state(dir) {
    const run = (args: string[]) =>
      new Promise<{ ok: boolean; stdout: string }>((done) => {
        execFile("git", ["-C", dir, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", windowsHide: true }, (error, stdout) => done({ ok: error === null, stdout }));
      });
    const [config, head] = await Promise.all([run(["config", "--null", "--list"]), run(["symbolic-ref", "--quiet", "--short", "HEAD"])]);
    if (!config.ok) return null;
    const entries = new Map<string, string[]>();
    for (const entry of config.stdout.split("\0")) {
      if (entry === "") continue;
      const newline = entry.indexOf("\n");
      const key = newline === -1 ? entry : entry.slice(0, newline);
      entries.set(key, [...(entries.get(key) ?? []), newline === -1 ? "" : entry.slice(newline + 1)]);
    }
    return { branch: head.ok && head.stdout.trim() !== "" ? head.stdout.trim() : null, config: entries };
  },
};

/** gh's options before the subcommand that take a value as the next word. */
const GH_VALUE_OPTIONS = new Set(["-R", "--repo", "--hostname"]);

/** Whether `gh …` (its words after `gh`) is `gh pr merge`, with any options between. */
function isPrMerge(args: readonly string[]): boolean {
  const words: string[] = [];
  for (let index = 0; index < args.length && words.length < 2; index++) {
    const arg = args[index] ?? "";
    if (GH_VALUE_OPTIONS.has(arg)) index++;
    else if (!arg.startsWith("-")) words.push(arg);
  }
  return words[0] === "pr" && words[1] === "merge";
}

/** The index of the `)` closing the `(` at `open`, reading quotes and escapes, or the line's end. */
function closingParen(line: string, open: number): number {
  let depth = 1;
  for (let index = open + 1; index < line.length; index++) {
    const char = line[index];
    if (char === "\\") index++;
    else if (char === "'") {
      const close = line.indexOf("'", index + 1);
      index = close === -1 ? line.length : close;
    } else if (char === '"') {
      index++;
      while (index < line.length && line[index] !== '"') index += line[index] === "\\" ? 2 : 1;
    } else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index;
  }
  return line.length;
}

/** The index of the backtick closing the one before `from`, reading escapes, or the line's end. */
function closingBacktick(line: string, from: number): number {
  for (let index = from; index < line.length; index++) {
    if (line[index] === "\\") index++;
    else if (line[index] === "`") return index;
  }
  return line.length;
}

/** One simple command: its words, the shell frame it runs in, and whether it runs in a pipeline or the background. */
export interface ShellCommand {
  words: string[];
  /** The subshells it is inside, outermost first: `[]` is the line's own shell. */
  frame: readonly number[];
  /** Part of a pipeline, or ended by `&`: whether a `cd` in it outlives it depends on the shell. */
  detached: boolean;
  /** The files its redirections name (`> x`, `>> x`, `< x`), which are not words. */
  targets: string[];
}

/**
 * The commands a heredoc's body runs: its `$(…)` and backticks, which the
 * shell runs in an unquoted heredoc as in double quotes, each in a
 * subshell of its own.
 */
function substitutionsIn(text: string, frame: readonly number[], frames: { next: number }): ShellCommand[] {
  const commands: ShellCommand[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === "$" && text[index + 1] === "(") {
      const end = closingParen(text, index + 1);
      commands.push(...parseCommands(text.slice(index + 2, end), [...frame, frames.next++], frames));
      index = end;
    } else if (char === "`") {
      const end = closingBacktick(text, index + 1);
      commands.push(...parseCommands(text.slice(index + 1, end), [...frame, frames.next++], frames));
      index = end;
    }
  }
  return commands;
}

/** A command line as the words of the simple commands in it (`parseCommands`, without where each runs). */
export function simpleCommands(line: string): string[][] {
  return parseCommands(line).map((command) => command.words);
}

/**
 * A command line as the simple commands in it, each as its words with
 * quoting removed and the shell it runs in (EO-926).
 *
 * Enough of a POSIX shell's grammar to find the commands a line runs and
 * where: single and double quotes, backslashes, comments, the separators
 * `;`, `&&`, `||`, `|`, `&` and newlines, redirections (dropped with their
 * targets, so `2>&1` is not an argument) and heredocs (whose body is text,
 * except for the substitutions an unquoted one still runs). A subshell
 * `( … )`, a command substitution — `$(…)` or backticks, bare or inside
 * double quotes — and a process substitution `<(…)` each run in a frame of
 * their own, nested in the one around them; a substitution's commands are
 * listed before the command they are part of, which keeps their text as a
 * word. A command in a pipeline, or ended by `&`, is marked `detached`.
 * Nothing is expanded.
 */
export function parseCommands(line: string, frame: readonly number[] = [], frames: { next: number } = { next: 1 }): ShellCommand[] {
  const commands: ShellCommand[] = [];
  const stack: (readonly number[])[] = [frame];
  const current = (): readonly number[] => stack[stack.length - 1] ?? frame;
  let words: string[] = [];
  let targets: string[] = [];
  let word = "";
  let inWord = false;
  /** The word being read had quoting in it, which for a heredoc's delimiter means its body is literal. */
  let quoted = false;
  /** The next word is a redirection's target, or a heredoc's delimiter. */
  let redirect: "target" | "heredoc" | null = null;
  const heredocs: { delimiter: string; strip: boolean; literal: boolean }[] = [];
  let stripNext = false;
  /** The command being read follows a `|`: it is a pipeline's later part. */
  let piped = false;

  const endWord = (): void => {
    if (!inWord) return;
    if (redirect === "heredoc") heredocs.push({ delimiter: word, strip: stripNext, literal: quoted });
    else if (redirect === null) words.push(word);
    else targets.push(word);
    redirect = null;
    word = "";
    inWord = false;
    quoted = false;
  };
  const endCommand = (ending: "sequence" | "pipe" | "background" = "sequence"): void => {
    endWord();
    redirect = null;
    if (words.length > 0 || targets.length > 0) commands.push({ words, frame: current(), detached: piped || ending !== "sequence", targets });
    words = [];
    targets = [];
    piped = ending === "pipe";
  };
  /** A substitution at `open` (`$(`'s or `<(`'s parenthesis): its commands listed in a frame of their own, its text kept in the word. */
  const substitution = (start: number, open: number): number => {
    const end = closingParen(line, open);
    commands.push(...parseCommands(line.slice(open + 1, end), [...current(), frames.next++], frames));
    word += line.slice(start, end + 1);
    inWord = true;
    return end;
  };
  const backticks = (start: number): number => {
    const end = closingBacktick(line, start + 1);
    commands.push(...parseCommands(line.slice(start + 1, end), [...current(), frames.next++], frames));
    word += line.slice(start, end + 1);
    inWord = true;
    return end;
  };

  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? "";
    if (char === "'") {
      const close = line.indexOf("'", index + 1);
      const end = close === -1 ? line.length : close;
      word += line.slice(index + 1, end);
      inWord = true;
      quoted = true;
      index = end;
      continue;
    }
    if (char === '"') {
      inWord = true;
      quoted = true;
      index++;
      while (index < line.length && line[index] !== '"') {
        const inner = line[index] ?? "";
        if (inner === "\\" && index + 1 < line.length && '"\\$`\n'.includes(line[index + 1] ?? "")) {
          // An escaped `$` or backtick is text, and runs nothing.
          word += line[index + 1] ?? "";
          index += 2;
        } else if (inner === "$" && line[index + 1] === "(") {
          index = substitution(index, index + 1) + 1;
        } else if (inner === "`") {
          index = backticks(index) + 1;
        } else {
          word += inner;
          index++;
        }
      }
      continue;
    }
    if (char === "\\") {
      if (index + 1 < line.length && line[index + 1] !== "\n") {
        word += line[index + 1] ?? "";
        inWord = true;
        quoted = true;
      }
      index++;
      continue;
    }
    if (char === "#" && !inWord) {
      const newline = line.indexOf("\n", index);
      index = newline === -1 ? line.length : newline - 1;
      continue;
    }
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    if (char === "$" && line[index + 1] === "(") {
      index = substitution(index, index + 1);
      continue;
    }
    if (char === "`") {
      index = backticks(index);
      continue;
    }
    if ((char === "<" || char === ">") && line[index + 1] === "(") {
      // A process substitution is a command, not a redirection.
      index = substitution(index, index + 1);
      continue;
    }
    if (char === "<" || char === ">" || (char === "&" && line[index + 1] === ">")) {
      // A file descriptor's number belongs to the redirection.
      if (inWord && !quoted && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      if (char === "<" && line[index + 1] === "<" && line[index + 2] !== "<") {
        index++;
        stripNext = line[index + 1] === "-";
        if (stripNext) index++;
        redirect = "heredoc";
        continue;
      }
      while (index + 1 < line.length && "<>&|".includes(line[index + 1] ?? "")) index++;
      redirect = "target";
      continue;
    }
    if (char === "\n") {
      endCommand();
      // A heredoc's body runs from here to its delimiter's line. Text,
      // except that an unquoted delimiter's body still runs substitutions.
      for (const { delimiter, strip, literal } of heredocs.splice(0)) {
        const body: string[] = [];
        let next = line.indexOf("\n", index + 1);
        while (true) {
          const end = next === -1 ? line.length : next;
          const text = line.slice(index + 1, end);
          index = end;
          if ((strip ? text.replace(/^\t+/, "") : text) === delimiter) break;
          body.push(text);
          if (next === -1) break;
          next = line.indexOf("\n", index + 1);
        }
        if (!literal) commands.push(...substitutionsIn(body.join("\n"), current(), frames));
      }
      continue;
    }
    if (char === "&") {
      if (line[index + 1] === "&") {
        endCommand();
        index++;
      } else endCommand("background");
      continue;
    }
    if (char === "|") {
      if (line[index + 1] === "|") {
        endCommand();
        index++;
      } else {
        if (line[index + 1] === "&") index++;
        endCommand("pipe");
      }
      continue;
    }
    if (char === "(") {
      // A subshell: a frame of its own until its `)`.
      endCommand();
      stack.push([...current(), frames.next++]);
      continue;
    }
    if (char === ")") {
      endCommand();
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (char === ";") {
      endCommand();
      continue;
    }
    word += char;
    inWord = true;
  }
  endCommand();
  return commands;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
