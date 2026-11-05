import type { RepositoryIndexAnswers, RepositoryIndexHit, RepositoryIndexQuestion } from "@eo/core";

/**
 * Deciding whether a tool call an agent is about to make is a broad
 * search of the checkout, and what to say back (EO-165).
 *
 * **Why a decision rather than a sentence in a prompt.** EO-164 measured
 * the prompt route and it does not work: on EO-162 the implementer made
 * one index call and 176 Bash calls, and eight of the index's nine tools
 * had never been called by anybody, ever. A bullet asking an agent to
 * prefer the index competes with an ingrained habit once per run and
 * loses. This fires on the call instead, so it arrives at the moment the
 * habit does.
 *
 * **Why matching on a command line rather than on a tool name.** The
 * tool that solves this problem elsewhere matches its assistant's own
 * `Glob` and `Grep`. EO's agents barely use those — EO-162 was 176
 * *Bash* calls with `grep -rn` inside them — so a hook keyed on tool
 * names would never fire for an EO agent at all. That leaves reading the
 * command, which is strictly harder and is where every false positive
 * lives.
 *
 * **So the bar is precision, not recall.** A false positive costs more
 * than a true positive gains: the agent still has to do its job with
 * something interrupting it, and an interception that fires on `pnpm
 * test` teaches an agent to ignore interceptions. Four rules keep it
 * narrow, and each of them is a way of saying "we are not sure, so we
 * say nothing":
 *
 *  1. **An allowlist of programs, never a denylist of ones to skip.**
 *     Only `grep`, `rg`, `find`, `ls` and their relatives are looked at.
 *     Running the check suite, `git` anything, a build, a package
 *     install, `cat`ting a file you already found, `sed -i` writing one —
 *     none of them reach the classifier at all, because none of them
 *     leads with a search program. A denylist would have had to
 *     enumerate every tool a repository might use and would be wrong the
 *     first time one was added.
 *  2. **Breadth is read off the paths.** A search that names a directory
 *     two segments deep is an agent working somewhere it already knows,
 *     and is left alone. Only a search of the whole tree — no path at
 *     all, `.`, the worktree root, or a single top-level directory like
 *     `apps` — counts.
 *  3. **Only questions a symbol index can actually answer.** A
 *     `grep -rn "every agent has always had"` is a search for prose, and
 *     no index of declarations will ever answer it; interrupting it
 *     would be advice that cannot be taken. The needle has to read as an
 *     identifier, or a filename, or the command has to be a bare tree
 *     walk.
 *  4. **And then the index is asked whether it holds the thing**
 *     (EO-173). The three rules above decide from the text alone whether
 *     a search *looks* answerable, and text is not enough: `quota` reads
 *     as an identifier whether or not anything is declared under that
 *     name. So the last word belongs to the index, and a needle it has
 *     never heard of is not worth interrupting anyone about.
 *
 * **Why that rule was not here from the start, and what it cost.**
 * EO-165 shipped the first three and measured the result. On run
 * `01a0491b`, seven of eight interceptions named a call that could not
 * have helped: a field that does not exist, a short word searched as a
 * substring, a name whose only declaration was in an unrelated
 * component, and two searches that were not of this checkout at all. The
 * agent took the eighth — the one genuine declared type — and ignored
 * the rest, which is the correct response to advice that is wrong seven
 * times out of eight. An interception that fires where it should not
 * does not merely waste a turn; it spends the credibility of every later
 * one. So this now costs a question and an answer before it says
 * anything, and every way that question can fail — an index that is not
 * there, one that will not answer, one that answers with something else
 * — comes back as silence.
 *
 * **The decision is therefore no longer pure, and only at the end.**
 * Classification is still a function of the command line and still
 * testable as one; `broadSearchIn` and `broadSearchInCommand` have not
 * moved. It is `repositorySearchNudge` that waits, and it waits with a
 * deadline, because what is waiting on *it* is a tool call the agent
 * made.
 *
 * **It never blocks.** The nudge is context handed back beside a call
 * that goes on to run. Blocking mode is deliberately not built here —
 * EO-165 says to build the nudge, measure it, and let the numbers argue
 * for anything stronger.
 *
 * **It says nothing when there is nothing to suggest.** The vocabulary
 * comes from the provider through `RepositoryIndexAnswers`, and so does
 * the way of asking it anything; no vocabulary or no way to ask, no
 * interception. That is the same answer the whole subsystem gives when
 * the feature is off, the binary is missing or the index failed to build
 * — the agent runs with the tools it has always had and hears nothing
 * about it.
 *
 * **This file names no implementation.** It is handed tool names and a
 * way to qualify them. The names themselves are spelled once, in the
 * implementation's own directory, which is the only place entitled to
 * say them — `architecturalInvariants.test.ts` is what keeps that true.
 *
 * A near-twin of this classifier lives in `scripts/index-adoption.mjs`,
 * which censuses `run_events` for the same shapes. They are deliberately
 * separate rather than shared: the census must count what an agent *did*
 * as loosely as possible so a run's exploration is not undercounted,
 * and this must interrupt as tightly as possible so an agent is not
 * interrupted wrongly. Same subject, opposite error to prefer.
 */

/** What a broad search was asking for, which decides what is named back. */
export type BroadSearchKind =
  /** A name, matched across the tree: `grep -rn transitionItem .` */
  | "symbol"
  /** A filename, matched across the tree: `find . -name '*.test.ts'` */
  | "file"
  /** The tree itself: `ls -R`, `find apps -type d`. */
  | "layout";

export interface BroadSearch {
  kind: BroadSearchKind;
  /** What it was looking for, when the command said. Null for a bare tree walk. */
  needle: string | null;
  /**
   * The paths the search named, relative to the checkout — the nearest
   * thing there is to a statement of where the agent is looking
   * (EO-173).
   *
   * Empty when it named none, or named the whole tree, which mean the
   * same thing: everywhere. Used for one judgement and no other — an
   * index whose single answer sits outside every path the agent asked
   * about has not answered the question that was asked, and saying so
   * would be an interruption about somewhere else.
   */
  within: string[];
}

/**
 * Programs whose whole purpose is to search a tree.
 *
 * The allowlist rule from the header, as data. `git` is absent
 * deliberately and is not an oversight: EO-165 requires git operations
 * never to be intercepted, and `git grep` arrives as a `git` call. It is
 * exploration, and it is exempt anyway — the criterion is a promise to
 * the agent about a whole family of commands, and a promise with one
 * exception carved out of it is not one.
 */
const SEARCH_PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack", "ack-grep", "find", "fd", "fdfind", "ls"]);

/** Recursive by construction — there is no non-searching spelling of these. */
const ALWAYS_RECURSIVE = new Set(["rg", "ripgrep", "ag", "ack", "ack-grep", "fd", "fdfind"]);

/** Searches whose needle is a filename rather than something in a file. */
const FILENAME_SEARCH = new Set(["fd", "fdfind"]);

/** Prefixes that run something else and are not themselves the command. */
const TRANSPARENT = new Set(["env", "time", "command", "nohup", "sudo"]);

/**
 * Short options that consume the next word, per family.
 *
 * Per family and not a union, which one bug made non-negotiable. `-r` is
 * ripgrep's `--replace` and takes a value; it is also how every grep in
 * this codebase's history was told to recurse. A shared set containing
 * it reads `grep -r transitionItem .` as "`-r` eats
 * `transitionItem`", leaving `.` as the pattern — so the single most
 * common broad search there is would have been classified as a search
 * for a full stop and waved through. The same trap sits in `-E`
 * (ripgrep's `--encoding`, grep's extended-regexp switch) and `-S`.
 *
 * Only flags whose argument is *mandatory* belong here. `--color` and
 * grep's `-NUM` take an optional one, and a parser that eats the next
 * word on those turns a pattern into a flag value.
 */
const SHORT_FLAGS_WITH_VALUE: Record<string, ReadonlySet<string>> = {
  grep: new Set(["e", "f", "m", "A", "B", "C", "D", "d"]),
  rg: new Set(["e", "f", "m", "A", "B", "C", "g", "t", "T", "M", "r", "j", "E"]),
  ack: new Set(["e", "f", "m", "A", "B", "C", "G"]),
  fd: new Set(["e", "t", "E", "d"]),
};

/** Which of the sets above a program reads its flags with. */
const FAMILY: Record<string, keyof typeof SHORT_FLAGS_WITH_VALUE> = {
  grep: "grep", egrep: "grep", fgrep: "grep",
  rg: "rg", ripgrep: "rg",
  ag: "ack", ack: "ack", "ack-grep": "ack",
  fd: "fd", fdfind: "fd",
};

/**
 * Long options that consume the next word when not written with `=`.
 *
 * Same rule: mandatory arguments only. `--color` is deliberately absent
 * — `grep --color foo .` is a pattern, not a colour.
 */
const LONG_FLAGS_WITH_VALUE = new Set([
  "regexp", "file", "max-count", "after-context", "before-context", "context", "include", "exclude", "exclude-dir", "exclude-from",
  "binary-files", "devices", "directories", "label", "glob", "iglob", "type", "type-not", "replace", "max-depth",
  "max-columns", "colors", "sort", "engine", "pre", "ignore-file", "extension", "threads", "encoding", "changed-within", "changed-before",
]);

/**
 * `fd` flags that run something rather than report something.
 *
 * The same rule as `find`'s actions below, and here for the same reason:
 * a command that is doing work is not exploration, and answering it with
 * advice about the index is the loudest kind of false positive.
 */
const FD_ACTIONS = new Set(["-x", "-X", "--exec", "--exec-batch"]);

/** `find` predicates that name what is being looked for. */
const FIND_NAME_PREDICATES = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex"]);

/**
 * `find` predicates that make the call an action rather than a question.
 *
 * A `find … -delete` or `find … -exec` is doing work, and work is not
 * what this intercepts. Answering an agent mid-deletion with advice
 * about the index would be the loudest possible false positive.
 */
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fls"]);

/** A name a symbol index could hold. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * One command line as its separate commands.
 *
 * Quote-aware, because `grep -rn "a|b" .` is one command and a naive
 * split on `|` turns it into two — the second of which starts with a
 * stray `b"` and is read as some unknown program. Each segment is
 * classified on its own and the first one that is a broad search wins,
 * so `grep -rn Foo . | head -20` is intercepted on the grep and
 * `cat file | wc -l` is not intercepted at all.
 */
function segmentsOf(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < command.length; index++) {
    const character = command[index] as string;
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "\\" && index + 1 < command.length) {
      current += character + (command[++index] as string);
      continue;
    }
    if (character === "|" || character === ";" || character === "&" || character === "\n") {
      // `||` and `&&` are one separator, not two empty commands.
      if ((character === "|" || character === "&") && command[index + 1] === character) index++;
      segments.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments.filter((segment) => segment.trim() !== "");
}

/**
 * One command as words, with its quoting removed.
 *
 * Whether a word *was* quoted is not kept, and that is a deliberate
 * simplification: the only thing quoting decides here is where a word
 * ends, and a quoted `"-r"` meant as a literal pattern is a command
 * nobody writes.
 */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  for (let index = 0; index < segment.length; index++) {
    const character = segment[index] as string;
    if (quote !== null) {
      if (character === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && character === "\\" && index + 1 < segment.length) {
        current += segment[++index] as string;
        started = true;
        continue;
      }
      current += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\" && index + 1 < segment.length) {
      current += segment[++index] as string;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** The program a command actually runs, without its path or its `VAR=value` prefixes. */
function programOf(tokens: string[]): { name: string; rest: string[] } | null {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    const name = token.split("/").pop() ?? token;
    if (TRANSPARENT.has(name)) continue;
    return { name, rest: tokens.slice(index + 1) };
  }
  return null;
}

interface Parsed {
  /** Words that were not flags and not flag values. */
  operands: string[];
  /** Every flag as written, so recursion and actions can be read off them. */
  flags: string[];
  /** The value of `-e` / `--regexp`, which displaces the first operand as the pattern. */
  explicitPattern: string | null;
}

/**
 * A search command's flags and operands, told apart.
 *
 * Not a general shell option parser and not trying to be. It knows which
 * flags eat the next word, because getting *that* wrong is what turns a
 * pattern into a path or a path into nothing — and both of those change
 * whether an agent is interrupted.
 */
function parseOptions(rest: string[], shortWithValue: ReadonlySet<string>): Parsed {
  const operands: string[] = [];
  const flags: string[] = [];
  let explicitPattern: string | null = null;
  let endOfFlags = false;

  for (let index = 0; index < rest.length; index++) {
    const token = rest[index] as string;
    if (endOfFlags || !token.startsWith("-") || token === "-") {
      operands.push(token);
      continue;
    }
    if (token === "--") {
      endOfFlags = true;
      continue;
    }
    flags.push(token);

    if (token.startsWith("--")) {
      const [name = "", ...valueParts] = token.slice(2).split("=");
      if (valueParts.length > 0) {
        if (name === "regexp") explicitPattern = valueParts.join("=");
        continue;
      }
      if (LONG_FLAGS_WITH_VALUE.has(name)) {
        const value = rest[++index];
        if (name === "regexp" && value !== undefined) explicitPattern = value;
      }
      continue;
    }

    // A short bundle: `-rn`, `-rni`. Only its last letter can take a
    // value, and `-m5` carries its own.
    const bundle = token.slice(1);
    const last = bundle.at(-1);
    if (last !== undefined && shortWithValue.has(last) && /^[A-Za-z]+$/.test(bundle)) {
      const value = rest[++index];
      if (last === "e" && value !== undefined) explicitPattern = value;
    }
  }

  return { operands, flags, explicitPattern };
}

/** Was this grep told to walk a tree? */
function isRecursiveGrep(flags: string[]): boolean {
  return flags.some(
    (flag) =>
      /^-[A-Za-z]*[rR][A-Za-z]*$/.test(flag) ||
      flag === "--recursive" ||
      flag === "--dereference-recursive" ||
      flag.startsWith("--include") ||
      flag.startsWith("--exclude-dir") ||
      flag === "--directories=recurse",
  );
}

/** Was this `ls` told to walk a tree? */
function isRecursiveLs(flags: string[]): boolean {
  return flags.some((flag) => /^-[A-Za-z]*R[A-Za-z]*$/.test(flag) || flag === "--recursive");
}

/** An absolute path, in either of the two spellings this runs on. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;

/**
 * Is this path the whole checkout, as far as the agent is concerned?
 *
 * The line EO-165 draws is between "I do not know where this is, so I
 * will search everywhere" and an agent searching somewhere it has
 * already decided on. A single top-level directory is on the wide side
 * of it — `rg Foo apps packages` is the shape EO-162 actually ran — and
 * anything two segments deep is on the narrow side and is left alone.
 *
 * A leading `*.ts` or `package.json` is a file glob rather than a
 * directory, and is treated as scope the agent chose.
 *
 * **An absolute path is the checkout or it is nowhere** (EO-173). The
 * worktree spelled out in full is the whole tree; anything else absolute
 * is somewhere else on the machine, and an index of this checkout has
 * nothing to say about it. That distinction was missing, and `find /
 * -name '*.d.ts' -path '*claude-agent-sdk*'` — a search of the entire
 * filesystem for a dependency's typings, on run `01a0491b` — was read as
 * a search of the checkout, because stripping the trailing slash off `/`
 * leaves the empty string that means "no path was given at all".
 */
function isBroadPath(path: string, root: string | undefined): boolean {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (root !== undefined && trimmed === root.replace(/[\\/]+$/, "")) return true;
  if (ABSOLUTE.test(path)) return false;
  if (trimmed === "" || trimmed === "." || trimmed === "./" || trimmed === "*" || trimmed === "**") return true;
  const segments = trimmed.replace(/^\.\//, "").split("/").filter((segment) => segment !== "");
  if (segments.length !== 1) return false;
  const only = segments[0] as string;
  return !only.includes(".");
}

/** Was every path this search named the whole checkout? */
function isBroadScope(operands: string[], root: string | undefined): boolean {
  if (operands.length === 0) return true;
  return operands.some((operand) => isBroadPath(operand, root));
}

/**
 * The paths a search named, as `BroadSearch.within` reports them.
 *
 * Checkout-relative and without their decoration, so they can be
 * compared against where an index says something is. A path that means
 * the whole tree — `.`, the worktree itself, nothing at all — is dropped
 * rather than kept as `.`: the list is read as "the places the agent
 * asked about", and "everywhere" is the absence of a place.
 */
function namedScope(operands: string[], root: string | undefined): string[] {
  const bare = root === undefined ? undefined : root.replace(/[\\/]+$/, "");
  const named: string[] = [];
  for (const operand of operands) {
    let path = operand.replace(/[\\/]+$/, "");
    if (bare !== undefined && path.startsWith(`${bare}/`)) path = path.slice(bare.length + 1);
    path = path.replace(/^\.\//, "");
    if (path === "" || path === "." || path === "*" || path === "**" || path === bare) return [];
    if (!named.includes(path)) named.push(path);
  }
  return named;
}

/**
 * Is what the index answered with somewhere the agent actually asked
 * about?
 *
 * True whenever the search named nowhere in particular, which is most of
 * them and is the honest answer: an agent searching the whole tree
 * asked about the whole tree.
 */
function insideNamedScope(within: string[], path: string): boolean {
  if (within.length === 0) return true;
  const normalised = path.replace(/^\.\//, "");
  return within.some((named) => normalised === named || normalised.startsWith(`${named}/`));
}

/**
 * The needle, if it reads as a name a symbol index could hold.
 *
 * Null for anything else, and that is the third precision rule: an index
 * of declarations cannot answer a search for a sentence, a CSS class or
 * a string literal, so interrupting one would be advice that cannot be
 * taken. An alternation of identifiers survives, because that is one
 * question about several names.
 */
function symbolNeedle(pattern: string | null | undefined): string | null {
  if (pattern === undefined || pattern === null) return null;
  const stripped = pattern
    .trim()
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .trim();
  if (stripped === "") return null;
  const parts = stripped
    .split(/\\\||\|/)
    .map((part) =>
      part
        .trim()
        .replace(/^\\b/, "")
        .replace(/\\b$/, "")
        .replace(/\\?\($/, "")
        .trim(),
    )
    .filter((part) => part !== "");
  if (parts.length === 0) return null;
  if (!parts.every((part) => IDENTIFIER.test(part))) return null;
  return parts[0] as string;
}

/** A filename pattern worth naming back. Anything non-empty qualifies; `files` takes a glob. */
function fileNeedle(pattern: string | null | undefined): string | null {
  const trimmed = (pattern ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Shells that run a command handed to them as a string.
 *
 * `command_execution` on the Codex backend arrives as
 * `/usr/bin/bash -lc "sed -n '1,80p' file"`, so the program a naive read
 * finds is `bash` on every single call. A census that stopped there
 * would report that backend as having made no searches and no reads at
 * all, ever — which is the shape of a wrong measurement that looks like
 * a finding.
 */
const WRAPPING_SHELLS = new Set(["sh", "bash", "zsh", "ksh", "dash", "ash", "busybox"]);

/** How many `sh -c "sh -c …"` layers to unwrap before giving up. Two is already contrived. */
const MAX_SHELL_DEPTH = 3;

/**
 * One command a command line runs: what it ran, and what it was given.
 *
 * `args` is everything after the program, quoting removed and flag
 * values still in place. It is here for exactly one caller and one
 * question — `git` is not a program that does one thing, and whether a
 * `git` call was a search of the tree or a question about history is
 * only answerable from its subcommand.
 */
export interface Invocation {
  name: string;
  args: string[];
}

/**
 * Every command a command line actually runs, in order (EO-155).
 *
 * Here rather than in the measurement that wanted it because the hard
 * half is already here: splitting a command line into its separate
 * commands without being fooled by a quoted `|`, and finding the
 * program in each without being fooled by a `VAR=value` prefix or a
 * `/usr/bin/` path. A second copy of that parser is a second thing to
 * be subtly wrong, and the two would disagree about the same command
 * with nothing to say which was right.
 *
 * What this adds on top is unwrapping: a shell told to run a string
 * reports the commands of that string rather than itself. Deliberately
 * *not* used by `broadSearchInCommand` — the interception fires only on
 * the backend that hands it a bare command, and widening what it
 * matches is a change to when an agent is interrupted, which is EO-165's
 * question and not this one.
 *
 * A caller that keeps anything out of `args` is keeping words that came
 * off somebody's command line, and the one caller there is reads them
 * to answer a yes-or-no question and keeps none of them.
 */
export function invocationsIn(command: string): Invocation[] {
  return invocationsInSegments(command, 0);
}

function invocationsInSegments(command: string, depth: number): Invocation[] {
  return segmentsOf(command).flatMap((segment) => {
    const program = programOf(tokenize(segment));
    if (program === null) return [];
    if (depth >= MAX_SHELL_DEPTH || !WRAPPING_SHELLS.has(program.name)) return [{ name: program.name, args: program.rest }];

    const script = wrappedScript(program.rest);
    // A shell with no `-c` is an interactive invocation or a script
    // file, and neither has a command line inside it to read.
    return script === null ? [{ name: program.name, args: program.rest }] : invocationsInSegments(script, depth + 1);
  });
}

/**
 * The string a shell was told to run, if it was told to run one.
 *
 * `-c` may arrive bundled with anything else that takes no value —
 * `-lc`, `-lic`, `-euxc` — and the script is the first operand after it.
 */
function wrappedScript(rest: string[]): string | null {
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index] as string;
    if (token === "-c" || (/^-[A-Za-z]+$/.test(token) && token.includes("c"))) {
      return rest[index + 1] ?? null;
    }
    if (token === "--command") return rest[index + 1] ?? null;
  }
  return null;
}

/**
 * Is this shell command a broad search of the checkout?
 *
 * Null for everything else, which is nearly everything: a command whose
 * program is not a search tool, a search that was told where to look, a
 * search for prose, and a `find` that is deleting rather than asking.
 */
export function broadSearchInCommand(command: string, root?: string): BroadSearch | null {
  for (const segment of segmentsOf(command)) {
    const program = programOf(tokenize(segment));
    if (program === null) continue;
    // A `cd` ends what a reading of the text can know (EO-173). Every
    // path after it means something this cannot see, so `.` may be the
    // checkout, a subdirectory of it, or another repository entirely —
    // and on run `01a0491b` it was the third: `cd <elsewhere>/node_modules/… &&
    // find . -type f` was read as a walk of this tree. Searches *before*
    // the `cd` have already been answered by the time this returns.
    if (DIRECTORY_CHANGES.has(program.name)) return null;
    const found = broadSearchInInvocation(program, root);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Commands that move the ground a relative path is measured from.
 *
 * `pushd` alongside `cd` because it does the same thing; neither is a
 * search program, so this list exists only to stop reading the rest of
 * the line.
 */
const DIRECTORY_CHANGES = new Set(["cd", "pushd", "popd", "chdir"]);

function broadSearchInInvocation(program: { name: string; rest: string[] }, root: string | undefined): BroadSearch | null {
  if (!SEARCH_PROGRAMS.has(program.name)) return null;

  if (program.name === "find") return findSearch(program.rest, root);
  if (program.name === "ls") {
    const parsed = parseOptions(program.rest, new Set());
    if (!isRecursiveLs(parsed.flags)) return null;
    return isBroadScope(parsed.operands, root) ? { kind: "layout", needle: null, within: namedScope(parsed.operands, root) } : null;
  }

  const family = FAMILY[program.name] ?? "grep";
  const parsed = parseOptions(program.rest, SHORT_FLAGS_WITH_VALUE[family] ?? new Set());
  if (!ALWAYS_RECURSIVE.has(program.name) && !isRecursiveGrep(parsed.flags)) return null;
  if (family === "fd" && parsed.flags.some((flag) => FD_ACTIONS.has(flag))) return null;

  // The pattern is `-e`'s value when there is one, otherwise the first
  // operand — and then the *rest* of the operands are the paths.
  const pattern = parsed.explicitPattern ?? parsed.operands[0] ?? null;
  const paths = parsed.explicitPattern === null ? parsed.operands.slice(1) : parsed.operands;
  if (!isBroadScope(paths, root)) return null;
  const within = namedScope(paths, root);

  if (FILENAME_SEARCH.has(program.name)) {
    const needle = fileNeedle(pattern);
    return needle === null ? { kind: "layout", needle: null, within } : { kind: "file", needle, within };
  }

  const needle = symbolNeedle(pattern);
  return needle === null ? null : { kind: "symbol", needle, within };
}

function findSearch(rest: string[], root: string | undefined): BroadSearch | null {
  // `find`'s own grammar: paths come first, predicates follow, and a
  // predicate that *does* something takes the call out of scope.
  const paths: string[] = [];
  let index = 0;
  while (index < rest.length && !(rest[index] as string).startsWith("-")) paths.push(rest[index++] as string);
  const predicates = rest.slice(index);
  if (predicates.some((token) => FIND_ACTIONS.has(token))) return null;
  if (!isBroadScope(paths, root)) return null;
  const within = namedScope(paths, root);

  const at = predicates.findIndex((token) => FIND_NAME_PREDICATES.has(token));
  if (at === -1) return { kind: "layout", needle: null, within };
  const needle = fileNeedle(predicates[at + 1]);
  return needle === null ? { kind: "layout", needle: null, within } : { kind: "file", needle, within };
}

/** A single tool call, as much of it as this decision needs. */
export interface SearchCandidate {
  /** The tool name the backend reports — `Bash`, `Grep`, `Glob`. */
  tool: string;
  /** Its arguments, unvalidated, straight off the wire. */
  input: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {});
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Is this tool call a broad search of the checkout?
 *
 * `Bash` is the case this feature exists for — EO-162's 176 shell calls —
 * and it is classified on its command text. Claude's own `Grep` and
 * `Glob` are here too because an agent that reaches for them is asking
 * the identical question through a tidier door, and because their
 * arguments make the scope question trivial: a `path` decides it
 * outright.
 */
export function broadSearchIn(candidate: SearchCandidate, root?: string): BroadSearch | null {
  const input = asRecord(candidate.input);
  if (candidate.tool === "Bash") {
    const command = asString(input["command"]);
    return command === null ? null : broadSearchInCommand(command, root);
  }
  if (candidate.tool === "Grep") {
    const path = asString(input["path"]);
    if (path !== null && !isBroadPath(path, root)) return null;
    const needle = symbolNeedle(asString(input["pattern"]));
    return needle === null ? null : { kind: "symbol", needle, within: namedScope(path === null ? [] : [path], root) };
  }
  if (candidate.tool === "Glob") {
    const path = asString(input["path"]);
    if (path !== null && !isBroadPath(path, root)) return null;
    const needle = fileNeedle(asString(input["pattern"]));
    return needle === null ? null : { kind: "file", needle, within: namedScope(path === null ? [] : [path], root) };
  }
  return null;
}

/**
 * What to say back, in the index's own tool names.
 *
 * Short on purpose. It goes into the conversation beside a call that ran
 * anyway, and it is re-sent on every turn after that, so the whole of it
 * has to be the one thing the agent could not have worked out: the name
 * of the call, and what that call returns.
 *
 * It names a call rather than a capability, which is the specific thing
 * EO-164 found missing. "Prefer the index over broad filesystem
 * exploration" was in the prompt for the whole of EO-162 and produced
 * one index call in 186 turns.
 *
 * `reach` is in the symbol sentence even though nothing in a `grep -rn`
 * asked for it, and that is the one piece of advice here that is not a
 * substitution. It is the half a text search cannot do at all — across
 * every run in EO's database `callers`, `callees` and `impact` have
 * never been invoked once — so the moment an agent is looking up a name
 * is the only moment at which saying so is useful rather than noise.
 */
export function nudgeFor(search: BroadSearch, answers: RepositoryIndexAnswers, qualify: (tool: string) => string): string {
  const closing = "Your command was not blocked and has run.";
  switch (search.kind) {
    case "symbol": {
      const reach = answers.reach.map(qualify).join(" and ");
      const callers = answers.reach.length === 0 ? "" : ` ${reach} then answer what calls it and what changing it would reach, which no search of the text can.`;
      return `That searched the whole checkout for \`${search.needle}\`. This repository has an index: \`${qualify(answers.symbol)}\` for \`${search.needle}\` returns where it is declared — file, line, signature and doc — in one call, and \`${qualify(answers.area)}\` answers a question in prose when you do not have a name yet.${callers} ${closing}`;
    }
    case "file":
      return `That walked the whole checkout looking for \`${search.needle}\`. This repository has an index: \`${qualify(answers.files)}\` answers which files exist and where, and \`${qualify(answers.area)}\` returns the files and symbols for an area from a question in prose. ${closing}`;
    case "layout":
      return `That walked the whole checkout to see what is in it. This repository has an index: \`${qualify(answers.files)}\` returns the file tree it holds, and \`${qualify(answers.area)}\` returns the symbols, files and callers for one area in a single call. ${closing}`;
  }
}

export interface NudgeRequest extends SearchCandidate {
  /**
   * The index's own tool names, from the provider that supplied the
   * server. Absent means there is nothing to suggest, and nothing is
   * said.
   */
  answers: RepositoryIndexAnswers | undefined;
  /**
   * How to ask the index whether it holds what this search is after
   * (EO-173).
   *
   * Absent means the same as absent vocabulary: nothing is said. A
   * suggestion that could not be checked is the one this story exists to
   * stop being made.
   */
  knows: ((question: RepositoryIndexQuestion) => Promise<RepositoryIndexHit[]>) | undefined;
  /** Turns a bare tool name into the id this backend's model actually sees. */
  qualify: (tool: string) => string;
  /** The checkout the agent works in, so a path naming it reads as the whole tree. */
  root?: string | undefined;
}

/**
 * An interception that is going to happen, as the thing that happened.
 *
 * The nudge and the classification that produced it, together, because
 * EO-168 needs both: the sentence goes to the model and the whole lot
 * goes to the run's event log, where counting interceptions and telling
 * a hook that fired from one that never did stops being an inference.
 *
 * Returned as one object rather than left for the adapter to recompute,
 * which is the same rule the rest of this file is written to: two
 * classifications of one command that have to agree is the bug this
 * codebase writes comments about.
 */
export interface SearchInterception {
  /** What the search was asking for. */
  kind: BroadSearchKind;
  /** What it was looking for, when the command said. Null for a bare tree walk. */
  needle: string | null;
  /** What the agent is told, verbatim — the sentence and nothing about the tree. */
  nudge: string;
}

/**
 * How long this waits for the index before giving up on it (EO-173).
 *
 * A tool call is parked on the answer, so the deadline is what keeps a
 * slow or wedged index from becoming a slow agent. It is an outer bound
 * and not a budget: the implementation has its own, tighter, and the
 * question is a lookup in a local database — 7ms for a hit and 34ms for
 * a miss, measured against this repository's own index. Anything near
 * three seconds is a fault, and the answer to a fault here is silence.
 */
const LOOKUP_DEADLINE_MS = 3_000;

/** The pattern that means "any file at all", for a walk that named nothing. */
const ANY_FILE = "*";

/** What to ask the index about this search. */
function questionOf(search: BroadSearch): RepositoryIndexQuestion {
  if (search.kind === "symbol") return { of: "symbol", name: search.needle ?? "" };
  // A tree walk has no needle: what it wants to know is what is in the
  // tree, so what the index is asked is whether it holds any of it.
  return { of: "file", pattern: search.needle ?? ANY_FILE };
}

/**
 * What the index says, or nothing at all.
 *
 * Every way of failing lands on the same answer, deliberately: a
 * provider that threw, one that never came back, one with no index
 * behind it. None of them is a judgement about whether repository
 * intelligence is available — that was settled when this run was handed
 * a server — and all of them mean the same thing to the only caller,
 * which is that there is nothing to suggest.
 */
async function whatItHolds(
  knows: (question: RepositoryIndexQuestion) => Promise<RepositoryIndexHit[]>,
  question: RepositoryIndexQuestion,
): Promise<RepositoryIndexHit[]> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // Wrapped, so that a provider throwing before it returns a promise
      // lands in the catch below rather than past this function.
      Promise.resolve(knows(question)),
      new Promise<RepositoryIndexHit[]>((resolve) => {
        deadline = setTimeout(() => resolve([]), LOOKUP_DEADLINE_MS);
      }),
    ]);
  } catch {
    return [];
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

/**
 * Is what the index came back with worth interrupting somebody about?
 *
 * Two ways it is not, and both were paid for on run `01a0491b`:
 *
 * **A loose match is not a match.** An index that answers `quota` with
 * `QuotaEvent`, or `snooze` with `snoozePrompt`, has not said where
 * `quota` is declared — it has said the word appears in some names.
 * That is the substring question the agent was already asking, answered
 * worse, so a symbol counts only when the index holds that exact name.
 * The needle a broad `grep` carries is an identifier by rule 3, so this
 * is comparing like with like rather than being strict about spelling.
 *
 * **One answer in a part of the tree nobody asked about is not an
 * answer.** `rg Foo apps packages` says where the agent is looking, and
 * an index whose only hit is somewhere else has found something else.
 * The cost of this rule is a real suggestion it will not make — "it is
 * not where you are looking, it is over here" — and that is the trade
 * EO-173 asks for: a wrong-looking interruption is paid for by every
 * later one. Two or more hits are not judged this way, because a name
 * that is declared in several places is a name the index genuinely
 * knows.
 */
function worthSuggesting(search: BroadSearch, hits: RepositoryIndexHit[]): boolean {
  const held = search.kind === "symbol" ? hits.filter((hit) => hit.name === search.needle) : hits;
  if (held.length === 0) return false;
  if (held.length > 1) return true;
  return insideNamedScope(search.within, (held[0] as RepositoryIndexHit).path);
}

/**
 * The whole decision, as one call: what to say about this tool call, or
 * nothing.
 *
 * The entry point an adapter's hook uses, and the only one it should —
 * every way of answering "say nothing" is behind it, so an adapter
 * cannot forget one. Null is the answer to all of them, which is also
 * what an adapter records: no interception, no event (EO-168).
 *
 * Asynchronous since EO-173, and that is the shape of the change rather
 * than a detail of it: the last thing this does before speaking is ask
 * the index whether it has anything to say. The classification above it
 * is unchanged and still decides from the text alone; what has moved is
 * that a search which *looks* answerable is no longer taken for one.
 */
export async function repositorySearchNudge(request: NudgeRequest): Promise<SearchInterception | null> {
  if (request.answers === undefined || request.knows === undefined) return null;
  const search = broadSearchIn({ tool: request.tool, input: request.input }, request.root);
  if (search === null) return null;
  if (!worthSuggesting(search, await whatItHolds(request.knows, questionOf(search)))) return null;
  return { kind: search.kind, needle: search.needle, nudge: nudgeFor(search, request.answers, request.qualify) };
}
