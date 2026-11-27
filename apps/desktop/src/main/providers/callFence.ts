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
 *   more than one (`--all`, `--mirror`, `--tags`, `--delete`);
 * - on a turn that may not (`pushBranch` null, the reviewer's): every
 *   `git push`;
 * - on both: `gh pr merge`, because merging is EO's;
 * - on both: a structured file write — Claude's `Write`, `Edit`,
 *   `MultiEdit` and `NotebookEdit`, Codex's `apply_patch` — whose target
 *   is outside `root`.
 *
 * **A guard against accidents, not a sandbox.** A shell command is read as
 * words: quotes, `&&`, `;`, pipes, redirections, `env` and `sh -c` are
 * understood, and an alias, a variable holding `push`, a script file or a
 * second language are not. A write made through the shell (`echo > /x`,
 * `cp`, `sed -i`) is not looked at for its path at all. ARCHITECTURE.md
 * says so where the fence is described.
 */

/** Which of the fence's rules refused a call. Stored on the run's `call_refused` event. */
export type FenceRule = "push_on_review" | "push_forced" | "push_without_lease" | "push_elsewhere" | "pr_merge" | "write_outside_worktree" | "unreadable_patch";

/** A call the fence refused: which rule, what it refused, and what the agent is told. */
export interface FenceRefusal {
  rule: FenceRule;
  /** The command line, or the path the write named. */
  call: string;
  reason: string;
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
 * which a relative path is read against, and `fence.root` where it says
 * none.
 */
export function fencedCall(tool: string, input: unknown, fence: CallFence, cwd?: string): FenceRefusal | null {
  const fields = asRecord(input);
  if (tool === SHELL_TOOL) {
    const command = fields?.["command"];
    if (typeof command === "string") return shellRefusal(command, fence);
    if (Array.isArray(command) && command.every((word) => typeof word === "string")) return commandsRefusal([command as string[]], command.join(" "), fence, 0);
    return null;
  }
  const base = cwd ?? fence.root;
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

/** The fence's answer to one command line. */
export function shellRefusal(command: string, fence: CallFence): FenceRefusal | null {
  return commandsRefusal(simpleCommands(command), command, fence, 0);
}

/** How deep `sh -c '…'` is read into. A command nested further than this is not looked at. */
const DEEPEST_NESTING = 4;

function commandsRefusal(commands: readonly string[][], line: string, fence: CallFence, depth: number): FenceRefusal | null {
  const call = line.length > LONGEST_CALL ? `${line.slice(0, LONGEST_CALL)}…` : line;
  for (const words of commands) {
    const argv = withoutPrefixes(words);
    const program = basename(argv[0] ?? "");
    if (program === "git") {
      const rule = gitRefusal(argv.slice(1), fence);
      if (rule !== null) return { rule, call, reason: pushReason(rule, fence) };
    } else if (program === "gh") {
      if (isPrMerge(argv.slice(1))) {
        return { rule: "pr_merge", call, reason: `EO refused this call: \`gh pr merge\` is refused on this turn, because merging a pull request is EO's to do. ${FENCE_NOTE}` };
      }
    } else if (SHELLS.has(program) && depth < DEEPEST_NESTING) {
      const script = shellScript(argv.slice(1));
      if (script !== null) {
        const nested = commandsRefusal(simpleCommands(script), line, fence, depth + 1);
        if (nested !== null) return nested;
      }
    }
  }
  return null;
}

function pushReason(rule: FenceRule, fence: CallFence): string {
  switch (rule) {
    case "push_on_review":
      return `EO refused this call: this turn may not push at all — EO pushes the item's branch itself. ${FENCE_NOTE}`;
    case "push_forced":
      return `EO refused this call: on this turn \`git push\` may only overwrite with \`--force-with-lease\`, so a bare \`--force\`, \`-f\` or a \`+refspec\` is refused. ${FENCE_NOTE}`;
    case "push_without_lease":
      return `EO refused this call: on this turn \`git push\` is only allowed as \`git push --force-with-lease\` to the item's own branch, ${fence.pushBranch ?? ""}, and only when an engine note says the remote branch diverged — otherwise EO does the pushing. ${FENCE_NOTE}`;
    default:
      return `EO refused this call: on this turn \`git push\` may only update the item's own branch, ${fence.pushBranch ?? ""}, and this push names another branch or more than one. ${FENCE_NOTE}`;
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

/** Words before the program that do not change which program runs: assignments, `env`, `sudo`, `command`, a group's brace. */
const TRANSPARENT = new Set(["{", "}", "(", "!", "then", "do", "else", "elif", "if", "while", "until", "time", "nohup", "exec", "command", "builtin", "sudo", "env", "xargs"]);

function withoutPrefixes(words: readonly string[]): string[] {
  let index = 0;
  let afterWrapper = false;
  while (index < words.length) {
    const word = words[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || TRANSPARENT.has(word)) {
      afterWrapper = afterWrapper || ["sudo", "env", "xargs", "command", "exec", "nohup", "time"].includes(word);
      index++;
    } else if (afterWrapper && word.startsWith("-")) {
      index++;
    } else break;
  }
  return words.slice(index);
}

function basename(program: string): string {
  const slash = Math.max(program.lastIndexOf("/"), program.lastIndexOf("\\"));
  const name = slash === -1 ? program : program.slice(slash + 1);
  return name.toLowerCase().endsWith(".exe") ? name.slice(0, -4) : name;
}

/** git's own options before the subcommand that take a value as the next word. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path", "--super-prefix"]);
/** Those that point git at another repository or checkout. */
const GIT_RELOCATING = new Set(["-C", "--git-dir", "--work-tree"]);

/** Which rule refuses this `git …` (its words after `git`), or null. */
function gitRefusal(args: readonly string[], fence: CallFence): FenceRule | null {
  let index = 0;
  let relocated = false;
  while (index < args.length && (args[index] ?? "").startsWith("-")) {
    const option = args[index] ?? "";
    const name = option.includes("=") ? option.slice(0, option.indexOf("=")) : option;
    if (GIT_RELOCATING.has(name)) relocated = true;
    index += GIT_VALUE_OPTIONS.has(option) ? 2 : 1;
  }
  if (args[index] !== "push") return null;
  return pushRefusal(args.slice(index + 1), fence, relocated);
}

/** Push options that update refs other than the one named, or remove one. */
const WIDE_PUSH = new Set(["--all", "--branches", "--mirror", "--tags", "--follow-tags", "--delete", "--prune"]);
/** Push options that take a value as the next word. */
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec"]);

function pushRefusal(args: readonly string[], fence: CallFence, relocated: boolean): FenceRule | null {
  if (fence.pushBranch === null) return "push_on_review";
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
  // No refspec pushes the branch checked out where git runs, which is the
  // item's own in its worktree — unless git was pointed somewhere else.
  if (refspecs.length === 0) return relocated ? "push_elsewhere" : null;
  for (const refspec of refspecs) {
    const colon = refspec.indexOf(":");
    if (colon === -1 && refspec === "HEAD") {
      if (relocated) return "push_elsewhere";
      continue;
    }
    if (colon === 0) return "push_elsewhere";
    const destination = colon === -1 ? refspec : refspec.slice(colon + 1);
    if (branchName(destination) !== fence.pushBranch) return "push_elsewhere";
  }
  return null;
}

function branchName(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

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

/**
 * A command line as the simple commands in it, each as its words with
 * quoting removed (EO-926).
 *
 * Enough of a POSIX shell's grammar to find the commands a line runs:
 * single and double quotes, backslashes, comments, the separators `;`,
 * `&&`, `||`, `|`, `&` and newlines, subshells and `$(…)`, redirections
 * (dropped with their targets, so `2>&1` is not an argument) and
 * heredocs (whose body is text, not commands). Nothing is expanded.
 */
export function simpleCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  /** The next word is a redirection's target, or a heredoc's delimiter. */
  let redirect: "target" | "heredoc" | null = null;
  const heredocs: { delimiter: string; strip: boolean }[] = [];
  let stripNext = false;

  const endWord = (): void => {
    if (!inWord) return;
    if (redirect === "heredoc") heredocs.push({ delimiter: word, strip: stripNext });
    else if (redirect === null) words.push(word);
    redirect = null;
    word = "";
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? "";
    if (char === "'") {
      const close = line.indexOf("'", index + 1);
      const end = close === -1 ? line.length : close;
      word += line.slice(index + 1, end);
      inWord = true;
      index = end;
      continue;
    }
    if (char === '"') {
      inWord = true;
      index++;
      while (index < line.length && line[index] !== '"') {
        if (line[index] === "\\" && index + 1 < line.length && '"\\$`\n'.includes(line[index + 1] ?? "")) index++;
        word += line[index] ?? "";
        index++;
      }
      continue;
    }
    if (char === "\\") {
      if (index + 1 < line.length && line[index + 1] !== "\n") {
        word += line[index + 1] ?? "";
        inWord = true;
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
    if (char === "<" || char === ">" || (char === "&" && line[index + 1] === ">")) {
      // A file descriptor's number belongs to the redirection.
      if (inWord && /^\d+$/.test(word)) {
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
      // A heredoc's body runs from here to its delimiter's line.
      for (const { delimiter, strip } of heredocs.splice(0)) {
        let next = line.indexOf("\n", index + 1);
        while (true) {
          const end = next === -1 ? line.length : next;
          const text = line.slice(index + 1, end);
          index = end;
          if ((strip ? text.replace(/^\t+/, "") : text) === delimiter || next === -1) break;
          next = line.indexOf("\n", index + 1);
        }
      }
      continue;
    }
    if (char === "$" && line[index + 1] === "(") {
      endCommand();
      index++;
      continue;
    }
    if (";&|()`".includes(char)) {
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
