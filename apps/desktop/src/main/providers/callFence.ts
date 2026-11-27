import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
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
    if (Array.isArray(command) && command.every((word) => typeof word === "string")) return commandsRefusal([command as string[]], command.join(" "), fence, { dir: base }, git, 0);
    return null;
  }
  const field = FILE_TOOLS[tool];
  if (field !== undefined) {
    const path = fields?.[field];
    if (typeof path !== "string" || path === "") return null;
    const target = resolve(base, path);
    return inside(fence.root, target) ? null : outside(target, fence);
  }
  if (tool === PATCH_TOOL) {
    const text = typeof input === "string" ? input : [fields?.["command"], fields?.["input"], fields?.["patch"]].find((value): value is string => typeof value === "string");
    const targets = text === undefined ? [] : patchTargets(text);
    if (targets.length === 0) {
      return { rule: "unreadable_patch", call: (text ?? "").slice(0, LONGEST_CALL), reason: `EO refused this call: it could not tell which files this patch writes, and on this turn a patch may only write inside ${fence.root}. ${FENCE_NOTE}` };
    }
    for (const path of targets) {
      const target = resolve(base, path);
      if (!inside(fence.root, target)) return outside(target, fence);
    }
  }
  return null;
}

function outside(target: string, fence: CallFence): FenceRefusal {
  return {
    rule: "write_outside_worktree",
    call: target,
    reason: `EO refused this call: on this turn files may only be written inside the item's worktree, ${fence.root}, and \`${target}\` is outside it. ${FENCE_NOTE}`,
  };
}

/** Whether `target` is `root` or under it. Read as paths, without following links. */
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
  return commandsRefusal(simpleCommands(command), command, fence, { dir: cwd }, git, 0);
}

/** How deep `sh -c '…'` and `eval` are read into. A command nested further than this is not looked at. */
const DEEPEST_NESTING = 4;

/** Where the shell is as a line runs: a directory, or null once it cannot be told (`cd -`, `cd "$X"`, `popd`). */
interface ShellScope {
  dir: string | null;
}

async function commandsRefusal(commands: readonly string[][], line: string, fence: CallFence, scope: ShellScope, git: FenceGit, depth: number): Promise<FenceRefusal | null> {
  const call = line.length > LONGEST_CALL ? `${line.slice(0, LONGEST_CALL)}…` : line;
  for (const words of commands) {
    const { argv, assigned, chdir } = withoutPrefixes(words);
    // `env -C <dir>` runs the one command there; the line goes on where it was.
    const dir = chdir === undefined ? scope.dir : moved(scope.dir, chdir);
    const program = basename(argv[0] ?? "");
    if (program === "cd" || program === "pushd") {
      scope.dir = moved(scope.dir, argv.slice(1).find((arg) => !arg.startsWith("-") || arg === "-") ?? null);
    } else if (program === "popd") {
      scope.dir = null;
    } else if (program === "git") {
      const rule = await gitRefusal(argv.slice(1), fence, dir, assigned, git);
      if (rule !== null) return { rule, call, reason: pushReason(rule, fence) };
    } else if (program === "gh") {
      if (isPrMerge(argv.slice(1))) {
        return { rule: "pr_merge", call, reason: `EO refused this call: \`gh pr merge\` is refused on this turn, because merging a pull request is EO's to do. ${FENCE_NOTE}` };
      }
    } else if (depth < DEEPEST_NESTING && (SHELLS.has(program) || program === "eval")) {
      const script = program === "eval" ? argv.slice(1).join(" ") : shellScript(argv.slice(1));
      if (script !== null) {
        const nested = await commandsRefusal(simpleCommands(script), line, fence, scope, git, depth + 1);
        if (nested !== null) return nested;
      }
    }
  }
  return null;
}

/** Where `cd <to>` leaves a shell that was at `from`: null where that cannot be told without running it. */
function moved(from: string | null, to: string | null): string | null {
  if (from === null || to === null || to === "-" || to.includes("$") || to.includes("`")) return null;
  if (to === "~") return homedir();
  if (to.startsWith("~/")) return resolve(homedir(), to.slice(2));
  if (to.startsWith("~")) return null;
  return resolve(from, to);
}

function pushReason(rule: FenceRule, fence: CallFence): string {
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
const GIT_RELOCATING_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_INDEX_FILE"]);
const GIT_CONFIGURING_ENV = /^GIT_CONFIG/;

/** Which rule refuses this `git …` (its words after `git`), run in `dir`, or null. */
async function gitRefusal(args: readonly string[], fence: CallFence, dir: string | null, assigned: readonly string[], git: FenceGit): Promise<FenceRule | null> {
  let index = 0;
  let relocated = assigned.some((name) => GIT_RELOCATING_ENV.has(name));
  let configured = assigned.some((name) => GIT_CONFIGURING_ENV.test(name));
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
  return pushRefusal(args.slice(index + 1), fence.pushBranch, fence.root, { dir: at, relocated, configured }, git);
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
  if (place.relocated || place.dir === null || !inside(root, place.dir)) return "push_outside_worktree";
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
  if (place.configured) return "push_unverified";
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
        execFile("git", ["-C", dir, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => done({ ok: error === null, stdout }));
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

/**
 * The commands a heredoc's body runs: its `$(…)` and backticks, which the
 * shell runs in an unquoted heredoc as in double quotes.
 */
function substitutionsIn(text: string): string[][] {
  const commands: string[][] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === "$" && text[index + 1] === "(") {
      const end = closingParen(text, index + 1);
      commands.push(...simpleCommands(text.slice(index + 2, end)));
      index = end;
    } else if (char === "`") {
      const end = closingBacktick(text, index + 1);
      commands.push(...simpleCommands(text.slice(index + 1, end)));
      index = end;
    }
  }
  return commands;
}

/**
 * A command line as the simple commands in it, each as its words with
 * quoting removed (EO-926).
 *
 * Enough of a POSIX shell's grammar to find the commands a line runs:
 * single and double quotes, backslashes, comments, the separators `;`,
 * `&&`, `||`, `|`, `&` and newlines, subshells, redirections (dropped with
 * their targets, so `2>&1` is not an argument) and heredocs (whose body is
 * text, except for the substitutions an unquoted one still runs). A
 * command substitution — `$(…)` or backticks, bare or inside double
 * quotes — and a process substitution `<(…)` are commands of their own,
 * listed before the command they are part of, which keeps their text as
 * a word. Nothing is expanded.
 */
export function simpleCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  /** The word being read had quoting in it, which for a heredoc's delimiter means its body is literal. */
  let quoted = false;
  /** The next word is a redirection's target, or a heredoc's delimiter. */
  let redirect: "target" | "heredoc" | null = null;
  const heredocs: { delimiter: string; strip: boolean; literal: boolean }[] = [];
  let stripNext = false;

  const endWord = (): void => {
    if (!inWord) return;
    if (redirect === "heredoc") heredocs.push({ delimiter: word, strip: stripNext, literal: quoted });
    else if (redirect === null) words.push(word);
    redirect = null;
    word = "";
    inWord = false;
    quoted = false;
  };
  const endCommand = (): void => {
    endWord();
    redirect = null;
    if (words.length > 0) commands.push(words);
    words = [];
  };
  /** A substitution at `open` (`$(`'s or `<(`'s parenthesis): its commands listed, its text kept in the word. */
  const substitution = (start: number, open: number): number => {
    const end = closingParen(line, open);
    commands.push(...simpleCommands(line.slice(open + 1, end)));
    word += line.slice(start, end + 1);
    inWord = true;
    return end;
  };
  const backticks = (start: number): number => {
    const end = closingBacktick(line, start + 1);
    commands.push(...simpleCommands(line.slice(start + 1, end)));
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
        if (!literal) commands.push(...substitutionsIn(body.join("\n")));
      }
      continue;
    }
    if (";&|()".includes(char)) {
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
