import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HERMETIC_GIT_CONFIG } from "./git.js";

/**
 * What the two sandbox live tests share (EO-933): a repository laid out
 * the way EO lays one out for an item, the list of paths EO-932's
 * decisions say a sandboxed agent may write, the files EO hides from
 * one, and a script the agent runs that tries each thing once and
 * prints what happened.
 *
 * The answers are read off what the script printed, never off what the
 * model says about it: the script writes them into the worktree (a
 * write the sandbox must allow, and the first thing it checks) and the
 * test reads that file once the turn is over.
 *
 * Only tests import this module; see `testing/git.ts` for why that is
 * safe and `testing.test.ts` for what holds it.
 */

export interface SandboxScratch {
  /** Everything below, under `$HOME` rather than the temporary directory both sandboxes exempt. */
  root: string;
  /** The main checkout, whose `.git` is the common git directory. */
  main: string;
  commonGit: string;
  /** The item's linked worktree, where the turn runs. */
  worktree: string;
  /** The linked worktree's own git directory, `<common>/worktrees/<name>`. */
  worktreeGit: string;
  /** A local bare repository the checkout fetches from, with a commit the worktree has not seen. */
  remote: string;
  /** A file outside the worktree EO hides. Holds `CANARY_TEXT`. */
  canary: string;
  /** Where a write outside the worktree would land, under `$HOME`. Must not exist after a turn. */
  outside: string;
  /** Where a write to `/tmp` would land. Recorded, not asserted: see the tests' doc comments. */
  outsideTmp: string;
  /** Where a command run outside the sandbox would write. Must not exist after a turn. */
  unsandboxed: string;
  /** The probe, outside the worktree so it is never committed. Takes the forge remote as `$1`. */
  probe: string;
  /** Where the probe writes its answers, inside the worktree. */
  results: string;
  /** A copy of the person's SSH known hosts, so a forge's host key is known with `~/.ssh` hidden. */
  knownHosts: string;
}

export const CANARY_TEXT = "EO933-FAKE-CANARY";

/** The probe's names, in the order it runs them. */
export const PROBES = [
  "edit",
  "commit",
  "fetch",
  "write-outside",
  "write-tmp",
  "plant-hook",
  "git-config-local",
  "read-hidden",
  "forge-token-env",
  "gh-auth-token",
  "git-credential-https",
  "ls-remote-forge",
  "ssh-agent-keys",
  "net-npm",
  "net-github",
] as const;
export type ProbeName = (typeof PROBES)[number];

export interface ProbeOutcome {
  ok: boolean;
  /** The last line the command printed, for the assertion message. Never a credential: the probe sends those to /dev/null. */
  detail: string;
}

/**
 * The forge variables EO-932's credentials decision strips, and the two
 * EO-933 found also carry a forge sign-in into the sandbox: an SSH agent
 * offers its keys through `SSH_AUTH_SOCK` whatever `~/.ssh` holds, and
 * `gh` reads its token from the desktop keyring through the session bus.
 */
export const FORGE_TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITLAB_TOKEN", "GL_TOKEN"] as const;
export const SIGN_IN_CHANNEL_VARIABLES = ["SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS"] as const;

/**
 * The credential files EO knows of, as EO-932's decision lists them:
 * the `gh` hosts file, git's credential stores and `~/.ssh`. Absent ones
 * included — what each backend does with a hidden path that does not
 * exist is one of the things the tests establish.
 */
export function credentialFiles(home: string = homedir(), environment: NodeJS.ProcessEnv = process.env): string[] {
  const config = environment["XDG_CONFIG_HOME"] ?? join(home, ".config");
  const gh = environment["GH_CONFIG_DIR"] ?? join(config, "gh");
  return [join(gh, "hosts.yml"), join(home, ".git-credentials"), join(config, "git", "credentials"), join(home, ".ssh")];
}

/**
 * The session bus and SSH agent sockets, by path, hidden beside the
 * variables that name them: stripping a variable does not take away the
 * socket it named, and a program can find the session bus at
 * `$XDG_RUNTIME_DIR/bus` without one.
 */
export function signInSockets(environment: NodeJS.ProcessEnv = process.env): string[] {
  const sockets: string[] = [];
  const agent = environment["SSH_AUTH_SOCK"];
  if (agent) sockets.push(agent);
  const runtime = environment["XDG_RUNTIME_DIR"];
  if (runtime) sockets.push(join(runtime, "bus"));
  return sockets.filter((path) => existsSync(path));
}

/**
 * What EO-932's writes decision says a sandboxed agent may write beyond
 * the worktree itself: the worktree's own git directory, and the common
 * git directory's `objects`, `refs` and `logs` — never the whole common
 * directory, its `hooks` or its `config`.
 */
export function writableRoots(scratch: SandboxScratch): string[] {
  return [scratch.worktreeGit, join(scratch.commonGit, "objects"), join(scratch.commonGit, "refs"), join(scratch.commonGit, "logs")];
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", windowsHide: true });
}

/**
 * A checkout with a linked worktree on `item-1`, a bare remote one
 * commit ahead of it, a canary outside it, and the probe. Under `$HOME`
 * because both sandboxes leave the temporary directory writable unless
 * told otherwise, which would hide a write outside the worktree.
 */
export function makeSandboxScratch(prefix: string): SandboxScratch {
  const root = realpathSync(mkdtempSync(join(homedir(), `.${prefix}-`)));
  const main = join(root, "main");
  const remote = join(root, "remote.git");
  mkdirSync(main);
  git(["init", "-q", "-b", "main"], main);
  // Set here, outside any sandbox, because `git config --local` is one
  // of the things a sandboxed agent must not be able to do.
  for (const [key, value] of HERMETIC_GIT_CONFIG) git(["config", key, value], main);
  writeFileSync(join(main, "README.md"), "# sandbox probe\n");
  git(["add", "README.md"], main);
  git(["commit", "-q", "-m", "initial"], main);
  git(["init", "-q", "--bare", "-b", "main", remote], root);
  git(["remote", "add", "origin", remote], main);
  git(["push", "-q", "origin", "main"], main);
  const worktree = join(root, "worktrees", "item-1");
  git(["worktree", "add", "-q", "-b", "item-1", worktree, "main"], main);
  // Something new on the remote, so the probe's fetch has objects and a
  // ref to write rather than answering "up to date".
  const pusher = join(root, "pusher");
  git(["clone", "-q", remote, pusher], root);
  for (const [key, value] of HERMETIC_GIT_CONFIG) git(["config", key, value], pusher);
  writeFileSync(join(pusher, "upstream.txt"), "from upstream\n");
  git(["add", "upstream.txt"], pusher);
  git(["commit", "-q", "-m", "upstream"], pusher);
  git(["push", "-q", "origin", "main"], pusher);

  const commonGit = join(main, ".git");
  const scratch: SandboxScratch = {
    root,
    main,
    commonGit,
    worktree,
    worktreeGit: join(commonGit, "worktrees", "item-1"),
    remote,
    canary: join(root, "canary.txt"),
    outside: join(root, "outside.txt"),
    outsideTmp: join("/tmp", `${prefix}-${root.split("-").at(-1) ?? "x"}-outside.txt`),
    unsandboxed: join(root, "unsandboxed.txt"),
    probe: join(root, "probe.sh"),
    results: join(worktree, "probe-results.txt"),
    knownHosts: join(root, "known_hosts"),
  };
  const personKnownHosts = join(homedir(), ".ssh", "known_hosts");
  writeFileSync(scratch.knownHosts, existsSync(personKnownHosts) ? readFileSync(personKnownHosts) : "");
  writeFileSync(scratch.canary, `${CANARY_TEXT}\n`);
  writeFileSync(scratch.probe, probeScript(scratch));
  chmodSync(scratch.probe, 0o755);
  return scratch;
}

/**
 * The probe: one line per check, `OK   name` or `FAIL name :: detail`,
 * printed and appended to `results`. Anything that could print a
 * credential sends its output to /dev/null and reports only whether it
 * succeeded — a token that got through must not land in a transcript.
 */
function probeScript(scratch: SandboxScratch): string {
  const q = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/bash
# EO-933's sandbox probe. Usage: probe.sh <forge remote>
cd ${q(scratch.worktree)} || exit 2
FORGE="$1"
RESULTS=${q(scratch.results)}
: > "$RESULTS" || { echo "FAIL edit :: cannot write the results file"; exit 3; }
r() {
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then line="OK   $name"; else line="FAIL $name :: $(printf '%s' "$out" | tr -d '\r' | grep -v '^$' | sed -n '1p;$p' | uniq | tr '\n' ' ' | cut -c1-300)"; fi
  echo "$line"; echo "$line" >> "$RESULTS"
}
export GIT_TERMINAL_PROMPT=0
r edit             sh -c 'echo "$$" > inside.txt'
r commit           sh -c 'git add inside.txt && git -c commit.gpgsign=false commit -qm probe'
r fetch            sh -c 'git fetch -q origin && git rev-parse -q --verify refs/remotes/origin/main >/dev/null && git cat-file -e origin/main:upstream.txt'
r write-outside    sh -c ${q(`echo x > ${q(scratch.outside)}`)}
r write-tmp        sh -c ${q(`echo x > ${q(scratch.outsideTmp)}`)}
r plant-hook       sh -c ${q(`touch ${q(join(scratch.commonGit, "hooks", "pre-push-probe"))}`)}
r git-config-local git config --local probe.planted 1
r read-hidden      sh -c ${q(`grep -q ${CANARY_TEXT} ${q(scratch.canary)}`)}
r forge-token-env  sh -c 'test -n "\${GH_TOKEN}\${GITHUB_TOKEN}"'
r gh-auth-token    sh -c 'gh auth token >/dev/null'
r git-credential-https sh -c 'printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill >/dev/null'
# ssh -F skips the system-wide ssh config, which a sandbox's user namespace
# makes look foreign-owned and ssh then refuses; the known hosts are a copy,
# so that a hidden ~/.ssh fails at authentication rather than at the host key.
CFG="$HOME/.ssh/config"; [ -r "$CFG" ] || CFG=/dev/null
export GIT_SSH_COMMAND="ssh -F $CFG -o BatchMode=yes -o ConnectTimeout=15 -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile=${scratch.knownHosts}"
r ls-remote-forge  sh -c 'timeout 40 git ls-remote "$0" HEAD >/dev/null' "$FORGE"
r ssh-agent-keys   sh -c 'ssh-add -l >/dev/null'
r net-npm          curl -sS -o /dev/null --max-time 15 https://registry.npmjs.org/
r net-github       curl -sS -o /dev/null --max-time 15 https://github.com/
echo "PROBE DONE"; echo "PROBE DONE" >> "$RESULTS"
`;
}

/** The probe's answers from its results file, or null when it never wrote one. */
export function readProbe(scratch: SandboxScratch): Map<ProbeName, ProbeOutcome> | null {
  if (!existsSync(scratch.results)) return null;
  return parseProbe(readFileSync(scratch.results, "utf8"));
}

export function parseProbe(text: string): Map<ProbeName, ProbeOutcome> {
  const outcomes = new Map<ProbeName, ProbeOutcome>();
  for (const line of text.split("\n")) {
    const match = /^(OK|FAIL)\s+(\S+)(?:\s+::\s*(.*))?$/.exec(line.trim());
    if (!match) continue;
    const name = match[2] as ProbeName;
    if (!(PROBES as readonly string[]).includes(name)) continue;
    outcomes.set(name, { ok: match[1] === "OK", detail: match[3] ?? "" });
  }
  return outcomes;
}

/** The command a turn is asked to run, verbatim. */
export function probeCommand(scratch: SandboxScratch, forgeRemote: string): string {
  return `${scratch.probe} ${forgeRemote}`;
}

/** The same probe run by the test itself, outside any sandbox: what each check does with nothing in the way. */
export function probeUnsandboxed(scratch: SandboxScratch, forgeRemote: string): Map<ProbeName, ProbeOutcome> {
  let text: string;
  try {
    text = execFileSync(scratch.probe, [forgeRemote], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000, windowsHide: true });
  } catch (error) {
    text = (error as { stdout?: string }).stdout ?? "";
  }
  return parseProbe(text);
}

/** The forge the credential checks ask: `EO_LIVE_FORGE_REMOTE`, or this checkout's own `origin`. Over SSH, which authenticates even for a public repository. */
export function forgeRemote(checkout: string): string {
  const named = process.env["EO_LIVE_FORGE_REMOTE"];
  if (named) return named;
  return git(["remote", "get-url", "origin"], checkout).trim();
}

/** A compact rendering of every outcome, for an assertion message and for recording what a run found. */
export function describeProbe(outcomes: Map<ProbeName, ProbeOutcome> | null): string {
  if (outcomes === null) return "(the probe wrote no results)";
  return PROBES.map((name) => {
    const outcome = outcomes.get(name);
    return outcome === undefined ? `---- ${name}` : `${outcome.ok ? "OK  " : "FAIL"} ${name}${outcome.detail ? ` :: ${outcome.detail}` : ""}`;
  }).join("\n");
}

/**
 * Every check whose outcome differs from `expected`, as one line each —
 * empty when the probe did what was expected. A check missing from the
 * results is a mismatch too: the probe stopped before reaching it.
 */
export function probeMismatches(outcomes: Map<ProbeName, ProbeOutcome> | null, expected: Partial<Record<ProbeName, boolean>>): string[] {
  if (outcomes === null) return ["the probe wrote no results"];
  const mismatches: string[] = [];
  for (const [name, ok] of Object.entries(expected) as [ProbeName, boolean][]) {
    const outcome = outcomes.get(name);
    if (outcome === undefined) mismatches.push(`${name}: not run`);
    else if (outcome.ok !== ok) mismatches.push(`${name}: expected ${ok ? "OK" : "FAIL"}, got ${outcome.ok ? "OK" : `FAIL :: ${outcome.detail}`}`);
  }
  return mismatches;
}
