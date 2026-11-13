import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { lstat, readdir, readFile, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { uuidv7 } from "@eo/core";

/**
 * A Codex agent's own Codex home (EO-378).
 *
 * Codex reads everything a person has set up for it out of one
 * directory, `$CODEX_HOME` (`~/.codex` unless they say otherwise): their
 * `config.toml` and the MCP servers in it, a global `AGENTS.md`, their
 * skills. A Claude agent is locked down to what was attached to it unless
 * "Let this agent use your own Claude setup" is ticked (EO-107); a Codex
 * agent used to load all of the above on every turn. The only way to stop
 * that is to point `CODEX_HOME` somewhere else — there is no flag that
 * skips the user layer — so each locked-down Codex agent gets a directory
 * of its own under EO's data folder.
 *
 * **What it carries, and only that.** The design measured
 * what a bare redirect breaks and what has to go with it: the sign-in
 * (`auth.json`) and the rollouts EO resumes threads from (`sessions`).
 * Both are *links* to the person's own, never copies:
 *
 * - `auth.json` because a ChatGPT credential rotates. Codex rewrites the
 *   file when it refreshes, through the link, so a refresh during a run
 *   lands in the person's own file. A copy would strand the new refresh
 *   token in this directory and leave the person's one revoked. Up to
 *   0.166.0 it truncated and wrote in place; from 0.167.0 it writes a
 *   temporary file beside the link's *target* and renames it over the
 *   target, which a symlink survives and a hard link does not — Codex
 *   refuses a credential file with more than one link outright
 *   ("atomic credential replacement does not support hard-linked
 *   files"), after the refresh token has already been spent (EO-774).
 * - `sessions` because a thread is found by its rollout file. Shared, a
 *   thread started under any home — the person's own, before this story
 *   existed, or another agent's — resumes under this one, and rollouts go
 *   on landing exactly where they always did. No migration.
 *
 * `config.toml` is deliberately **not** carried, which is where this
 * departs from carrying the whole home: carrying it would carry the person's MCP
 * servers and model settings, which is the thing being locked out.
 *
 * **Windows.** `sessions` is a directory *junction*, which needs no
 * privilege, and `auth.json` a file symlink, as everywhere else. Windows
 * makes a file symlink only for an administrator or where Developer Mode
 * is on; where neither holds, a locked-down Codex agent's dispatch is
 * refused, saying to turn Developer Mode on or to tick the agent over to
 * the person's own setup (`DEVELOPER_MODE_PROBLEM`, `codexHomeRefusal`).
 * Until EO-774 `auth.json` was a hard link there, which needs no
 * privilege; Codex 0.167.0 refuses to save a credential through one (see
 * above), and a person decided on EO-774 that a symlink or a refusal
 * replaces it. The hard links earlier versions left are removed — by
 * preparing the home, and from every home by the sweep
 * (`sweepCodexHomes`) — because while one exists the person's own
 * `auth.json` has two links, and their own Codex refuses it too.
 *
 * Where a home cannot be made under the first root, the next is tried
 * (`chooseCodexHome`): EO's folder in the person's profile,
 * `~/.eo/codex-homes`. Where no root can carry the sign-in at all, the
 * agent dispatch is refused with the reason (`codexHomeRefusal`): running
 * an agent nobody ticked over in the person's own home is the keyring's
 * way out, which a person agreed to, and not a link failure's.
 *
 * **And nothing an agent writes into its home is configuration next
 * turn.** `prepareCodexHome` clears the home down to Codex's own state
 * before every turn (`KEPT_IN_HOME`), so a `config.toml`, an `AGENTS.md`
 * or a skill a turn left behind never reaches the one after it.
 *
 * **Except for a sign-in kept in the OS keyring.** Codex files a keyring
 * credential under a name derived from the home's own path (`cli|` and
 * the start of a SHA-256 of it), so a different home looks under a
 * different name and finds nothing — and a copy would be the rotation
 * hazard above. The one route across homes is an app-server login type
 * Codex marks internal-only. So a person whose `config.toml` puts the
 * sign-in in the keyring has their Codex agents run in their own home,
 * as if the tickbox were ticked, and EO says so on the agent and on the
 * item (`signInIsInKeyring`, `keyringNotice`). Decided on EO-378.
 *
 * `auto` counts as the keyring whether or not an `auth.json` is there:
 * Codex on `auto` reads the keyring first and the file only as a
 * fallback, so a file left beside a live keyring entry is stale, and
 * nothing EO can read says which of the two is live.
 *
 * Synchronous on purpose: it runs where a Codex client is constructed,
 * which is synchronous, and it is a handful of `lstat`s.
 */

/** The credential file Codex reads in its default `file` storage mode. */
export const CODEX_CREDENTIAL_FILE = "auth.json";
/** The rollout directory threads are resumed from. */
export const CODEX_SESSIONS_DIRECTORY = "sessions";

/**
 * The person's own Codex home: whatever `CODEX_HOME` they set, `~/.codex`
 * otherwise. This is the home an agent with the tickbox ticked runs in,
 * and the one a locked-down agent's links point into.
 */
export function personCodexHome(environment: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const named = environment["CODEX_HOME"]?.trim();
  return named ? resolve(named) : join(home, ".codex");
}

/** An agent id is a UUID; anything else must not become a path segment. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * The home side calls run in (EO-477): one for the installation, beside
 * the agents' and made the same way — the person's credential and
 * sessions linked, nothing of their configuration. Not a UUID, so no
 * agent's id can ever name it.
 */
export const SIDE_CALL_CODEX_HOME = "side-calls";

/** Where one agent's own Codex home is, under `root`. */
export function agentCodexHomePath(root: string, agentId: string): string {
  if (!SAFE_SEGMENT.test(agentId)) throw new Error(`Not an agent id EO would name a directory after: ${JSON.stringify(agentId)}`);
  return join(root, agentId);
}

/**
 * Whether an agent's config asks for the person's own setup — the
 * tickbox, under the key Claude agents already use for theirs (EO-107).
 */
export function inheritsAmbientConfig(config: Readonly<Record<string, unknown>>): boolean {
  return config["inheritAmbientConfig"] === true;
}

/** What `lstat` answers that this module reads. */
export interface LinkStat {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
}

/**
 * The filesystem calls this module makes, as a seam.
 *
 * Production passes nothing and gets `node:fs`. The Windows tests pass
 * the real thing wrapped so that a junction is made the way Windows
 * makes one, and a file symlink fails the way it does on a Windows
 * account without admin rights or Developer Mode, or works as it does
 * with Developer Mode on — which is how both are asserted on a machine
 * that is not Windows.
 */
export interface CodexHomeFs {
  existsSync: typeof existsSync;
  lstatSync: (path: string) => LinkStat;
  mkdirSync: typeof mkdirSync;
  readdirSync: (path: string) => string[];
  readlinkSync: (path: string) => string;
  rmSync: typeof rmSync;
  symlinkSync: typeof symlinkSync;
  unlinkSync: typeof unlinkSync;
}

const NODE_FS: CodexHomeFs = {
  existsSync,
  lstatSync: (path) => lstatSync(path),
  mkdirSync,
  readdirSync: (path) => readdirSync(path),
  readlinkSync: (path) => readlinkSync(path),
  rmSync,
  symlinkSync,
  unlinkSync,
};

export interface CodexHomeOptions {
  /** `userData/codex-homes` in production. */
  root: string;
  agentId: string;
  /** The person's own home. Defaults to `personCodexHome()`. */
  personHome?: string;
  /** Defaults to `process.platform`. Only `win32` changes anything. */
  platform?: NodeJS.Platform;
  fs?: CodexHomeFs;
}

/**
 * What preparing a home came to.
 *
 * `credential` says whether there was a credential file to carry. Absent
 * is not a failure here — a signed-out person has none either — and the
 * dispatch preflight is what decides whether it matters, because only it
 * knows what the Runtimes card says (`codexHomeRefusal`).
 */
export type CodexHomePreparation =
  | { ok: true; path: string; credential: "carried" | "absent"; credentialPath: string }
  | { ok: false; path: string; problem: string; developerMode?: true };

/**
 * Makes sure `root/<agentId>` exists and carries the person's sign-in and
 * saved conversations, and nothing else of theirs. Idempotent: a link
 * that is already right is left alone.
 */
export function prepareCodexHome(options: CodexHomeOptions): CodexHomePreparation {
  const fs = options.fs ?? NODE_FS;
  const windows = (options.platform ?? process.platform) === "win32";
  const person = options.personHome ?? personCodexHome();
  const path = agentCodexHomePath(options.root, options.agentId);
  const credentialPath = join(person, CODEX_CREDENTIAL_FILE);

  // The home path itself, before anything reads through it. The agent
  // that runs here has full access and can replace its home with a link
  // to the person's own — and everything below, the scrub first of all,
  // would then be working on *their* directory. `mkdir` accepts a link to
  // a directory as the directory, so this is asked with `lstat`, and a
  // link (or a stray file) is unlinked by name, target untouched, and a
  // real directory made in its place.
  try {
    const existing = lstatOrNull(fs, path);
    if (existing !== null && (existing.isSymbolicLink() || !existing.isDirectory())) fs.unlinkSync(path);
    fs.mkdirSync(path, { recursive: true });
    const made = lstatOrNull(fs, path);
    if (made === null || made.isSymbolicLink() || !made.isDirectory()) throw new Error("it is not a real directory");
  } catch (error) {
    return { ok: false, path, problem: `EO could not create ${path}: ${messageOf(error)}` };
  }

  // Before anything is linked, and before every turn: whatever an earlier
  // turn left in this home that Codex would read as configuration.
  const scrubbed = scrubCodexHome(fs, path);
  if (scrubbed !== null) return { ok: false, path, problem: scrubbed };

  // A step of its own (EO-774): an `auth.json` here that is not a symlink
  // — the hard link EO made on Windows before EO-774 — goes before
  // anything is linked, whether or not a symlink can then be made. While
  // it exists the person's own `auth.json` has two links, and Codex
  // 0.167.0 and later will not save a refreshed sign-in into it, in this
  // home or in theirs.
  const dropped = dropCredentialThatIsNotALinkSync(fs, join(path, CODEX_CREDENTIAL_FILE));
  if (dropped !== null) return { ok: false, path, problem: dropped };

  const sessions = linkSessions(fs, windows, join(person, CODEX_SESSIONS_DIRECTORY), join(path, CODEX_SESSIONS_DIRECTORY));
  if (sessions !== null) return { ok: false, path, problem: sessions };

  const credential = symlinkCredential(fs, windows, credentialPath, join(path, CODEX_CREDENTIAL_FILE));
  if (typeof credential === "object") return { ok: false, path, ...credential };
  return { ok: true, path, credential, credentialPath };
}

/**
 * What may stay in an agent's home from one turn to the next: Codex's
 * own state, and nothing it reads as configuration.
 *
 * An allowlist, because the home is writable by the agent that runs in
 * it. EO pins `danger-full-access`, so a turn can write a `config.toml`
 * naming an MCP server, an `AGENTS.md`, a skill, a profile, a hook —
 * and without this the *next* turn would load what the agent gave
 * itself, which is the lockdown undone and invariant 11 broken: no
 * step-owning agent may widen its own tool surface. A list of what to
 * delete would have to name every file a future Codex learns to read; a
 * list of what to keep fails the other way, by deleting a cache.
 *
 * What is kept is what Codex 0.161.0 writes into a home on its own:
 * its SQLite databases (thread index, logs, goals, memories, queue),
 * its installation id, its model and version caches, its prompt
 * history and session index, and its scratch directories. Keeping the
 * databases matters: the thread index is rebuilt from every rollout in
 * the shared `sessions` when it is missing, which is tens of megabytes.
 *
 * Re-checked at 0.163.0 (EO-453) with one real turn in an empty home:
 * besides the links, `sessions` and `skills/`, it wrote only names this
 * list keeps — one more database, `thread_history_1.sqlite`, which the
 * first pattern already covers — and a `config.toml` holding a
 * `[projects."<cwd>"] trust_level = "trusted"` entry, which 0.161.0
 * writes the same way and which goes with the rest of `config.toml`.
 *
 * Re-checked at 0.165.0 (EO-599) with one real turn in an empty home,
 * beside 0.163.0 doing the same: both wrote the same names, all of them
 * links, `sessions`, `skills/` or names this list keeps. 0.165.0 turns a
 * second memory store on for a fresh home whose memories are on
 * (`memories_v2/`, `memories_v2_1.sqlite`); with EO's switches off it
 * writes neither (`CODEX_MEMORY_OFF`, codex.ts). And both versions, left
 * running a few seconds longer, also write `plugins/` — a cache of
 * curated remote plugins, not new at either pin — which is not kept, for
 * the reason `skills/` is not.
 *
 * Re-checked at 0.166.0 (EO-644) the same way, beside 0.165.0: the
 * same names but for SQLite's `-wal` and `-shm` files, which 0.165.0
 * left beside its databases after the turn and 0.166.0 did not (the
 * pattern keeps both either way), and with EO's switches still neither
 * memory store.
 *
 * Re-checked at 0.167.1 (EO-774) the same way, beside 0.166.0: the same
 * names, fewer of SQLite's `-wal` and `-shm` files left after the turn,
 * and with EO's switches still neither memory store.
 *
 * `skills/` is *not* kept, though Codex makes it — it unpacks its own
 * bundled skills there on every start, and it is also exactly where an
 * agent would put one of its own.
 */
const KEPT_IN_HOME: readonly RegExp[] = [
  /\.sqlite(?:-shm|-wal)?$/,
  /^installation_id$/,
  /^models_cache\.json$/,
  /^version\.json$/,
  /^history\.jsonl$/,
  /^session_index\.jsonl$/,
  /^\.sandbox_migration$/,
  /^(?:cache|log|tmp|\.tmp|shell_snapshots|thread-writer-locks)$/,
];

/**
 * Removes everything from an agent's home that is neither one of the two
 * links nor on the list above. Null when the home is clean.
 *
 * A symbolic link is unlinked, never followed — an agent that links its
 * home's `config.toml` to the person's loses the link and the person
 * keeps the file. The two link names are left to the functions that own
 * them, which is what keeps a real `sessions` directory from being
 * deleted here.
 */
function scrubCodexHome(fs: CodexHomeFs, path: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(path);
  } catch (error) {
    return `EO could not read ${path}: ${messageOf(error)}`;
  }
  for (const name of names) {
    if (name === CODEX_SESSIONS_DIRECTORY || name === CODEX_CREDENTIAL_FILE) continue;
    if (KEPT_IN_HOME.some((kept) => kept.test(name))) continue;
    const entry = join(path, name);
    try {
      const stat = fs.lstatSync(entry);
      if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(entry, { recursive: true, force: true });
      else fs.unlinkSync(entry);
    } catch (error) {
      return (
        `EO could not remove ${entry}, which an earlier turn left in this agent's Codex home and Codex would read as configuration: ` +
        `${messageOf(error)}`
      );
    }
  }
  return null;
}

/**
 * `sessions`, as a link to the person's rollout directory: a symlink, or
 * a junction on Windows. Null when it is in place.
 *
 * The person's directory is created when it is not there yet — it is
 * where Codex would put it on its first run anyway, and a link has to
 * point at something for a junction to be made.
 */
function linkSessions(fs: CodexHomeFs, windows: boolean, target: string, link: string): string | null {
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (error) {
    return `EO could not create ${target}, where Codex keeps the conversations it resumes: ${messageOf(error)}`;
  }
  const existing = lstatOrNull(fs, link);
  if (existing !== null) {
    // Junctions read as symbolic links too, which is what makes this one test.
    if (!existing.isSymbolicLink()) {
      return (
        `${link} is a real directory rather than a link to ${target}, so threads started elsewhere would not resume ` +
        `there. EO did not make it and will not delete it; move it aside and reply here to retry.`
      );
    }
    if (samePath(readlinkOrNull(fs, link), target, windows)) return null;
    try {
      fs.unlinkSync(link);
    } catch (error) {
      return `EO could not replace the stale link at ${link}: ${messageOf(error)}`;
    }
  }
  try {
    fs.symlinkSync(target, link, windows ? "junction" : "dir");
    return null;
  } catch (error) {
    return `EO could not link ${link} to ${target}, where Codex keeps the conversations it resumes: ${messageOf(error)}`;
  }
}

/**
 * What a locked-down Codex agent's dispatch is refused with on Windows
 * where a file symlink cannot be made (EO-774): no Developer Mode, and EO
 * not running as an administrator. `codexHomeRefusal` adds the other way
 * out, ticking the agent over to the person's own setup.
 */
export const DEVELOPER_MODE_PROBLEM =
  "Windows lets EO link your Codex sign-in into it only where Developer Mode is on, and it is not. " +
  "Turn Developer Mode on in Windows Settings (System, For developers).";

/**
 * `auth.json`: a symlink to the person's, on every platform, made whether
 * or not their file exists yet, so signing in later needs nothing from
 * EO. A symlink that names something else is replaced; anything that is
 * not a symlink has already gone (`dropCredentialThatIsNotALinkSync`).
 */
function symlinkCredential(
  fs: CodexHomeFs,
  windows: boolean,
  target: string,
  link: string,
): "carried" | "absent" | { problem: string; developerMode?: true } {
  const existing = lstatOrNull(fs, link);
  if (existing === null || !existing.isSymbolicLink() || !samePath(readlinkOrNull(fs, link), target, windows)) {
    try {
      if (existing !== null) fs.unlinkSync(link);
    } catch (error) {
      return { problem: `EO could not replace ${link} with a link to your Codex sign-in at ${target}: ${messageOf(error)}` };
    }
    try {
      fs.symlinkSync(target, link, "file");
    } catch (error) {
      if (windows && errorCode(error) === "EPERM") return { problem: DEVELOPER_MODE_PROBLEM, developerMode: true };
      return { problem: `EO could not link ${link} to your Codex sign-in at ${target}: ${messageOf(error)}` };
    }
  }
  return fs.existsSync(target) ? "carried" : "absent";
}

/**
 * Removes an `auth.json` from a home that is not a symlink (EO-774): a
 * hard link to the person's file an EO before EO-774 made on Windows,
 * which keeps their own `auth.json` at two links and so unwritable to
 * Codex 0.167.0 and later, or a stale copy. Only ever by name, so the
 * person's file is untouched. Null when there is none left.
 */
function dropCredentialThatIsNotALinkSync(fs: { lstatSync: (path: string) => LinkStat; unlinkSync: (path: string) => void }, credential: string): string | null {
  const stat = lstatOrNull(fs, credential);
  if (stat === null || stat.isSymbolicLink() || !stat.isFile()) return null;
  try {
    fs.unlinkSync(credential);
    return null;
  } catch (error) {
    return `EO could not remove ${credential}, a hard link to your Codex sign-in that an earlier version of EO made: ${messageOf(error)}`;
  }
}

/**
 * `dropCredentialThatIsNotALinkSync` for the sweep, on every home it keeps.
 *
 * **The decision and the unlink are one synchronous step.** The sweep
 * awaits, and while it does a dispatch can prepare this very home —
 * synchronously — and replace the hard link it saw with the symlink the
 * agent is about to sign in through. So what the awaited look found is
 * only a reason to look again: the home and its `auth.json` are asked
 * once more, and the file unlinked, with nothing awaited in between. A
 * symlink made while the sweep was waiting is left alone.
 */
async function dropCredentialThatIsNotALink(fs: CodexHomeSweepFs, home: string): Promise<void> {
  const credential = join(home, CODEX_CREDENTIAL_FILE);
  const seen = await lstatOrNullAsync(fs, credential);
  if (seen === null || seen.isSymbolicLink() || !seen.isFile()) return;
  // From here on, nothing is awaited.
  const now = lstatOrNull(fs, home);
  if (now === null || now.isSymbolicLink() || !now.isDirectory()) return;
  const dropped = dropCredentialThatIsNotALinkSync(fs, credential);
  // Left for the next sweep, or for preparing the home, which refuses
  // the dispatch with the same sentence.
  if (dropped !== null) console.warn(`[eo] ${dropped}`);
}

/**
 * Removes one agent's home without reaching through its links.
 *
 * The two links are unlinked by name first — a symlink, a junction or a
 * hard link all go with `unlink` and take nothing of the person's with
 * them — and only then is the rest removed.
 *
 * **A home that is itself a link is unlinked, and that is all.** Its
 * target is never read, so a link to a directory with a real `sessions`
 * — the person's own home, say — is removed and the target left whole.
 *
 * **A home whose `sessions` is a real directory is not touched at all.**
 * It should be a link; a real one holds rollouts that exist nowhere
 * else, and removing the home would take them with it. This throws
 * instead, before anything is unlinked, and the caller reports it.
 */
export function removeCodexHome(path: string, fs: CodexHomeFs = NODE_FS): void {
  // A link where the home should be — an agent can leave one — is the
  // entry to remove, and it goes by name. Nothing is asked of what it
  // points at: looking through it would be judging, and then deleting,
  // somebody else's directory.
  const home = lstatOrNull(fs, path);
  if (home === null) return;
  if (home.isSymbolicLink() || !home.isDirectory()) {
    fs.unlinkSync(path);
    return;
  }
  const sessionsPath = join(path, CODEX_SESSIONS_DIRECTORY);
  const sessions = lstatOrNull(fs, sessionsPath);
  if (sessions !== null && !sessions.isSymbolicLink()) {
    throw new Error(realSessionsProblem(sessionsPath, sessions, path));
  }
  if (sessions !== null) fs.unlinkSync(sessionsPath);
  const credential = join(path, CODEX_CREDENTIAL_FILE);
  const stat = lstatOrNull(fs, credential);
  if (stat !== null && (stat.isSymbolicLink() || stat.isFile())) fs.unlinkSync(credential);
  // Belt and braces: nothing by that name may be left to recurse into.
  if (lstatOrNull(fs, sessionsPath) !== null) throw new Error(`${sessionsPath} could not be unlinked`);
  fs.rmSync(path, { recursive: true, force: true });
}

/**
 * The filesystem calls the sweep makes, as a seam: asynchronous, but for
 * the two steps that must not let a preparation run in the middle of
 * them — the rename that claims a home (`sweepCodexHomes`), and the last
 * look at a kept home's `auth.json` with its unlink
 * (`dropCredentialThatIsNotALink`). Production passes nothing and gets
 * `node:fs`; a test holds a call open to prove that a home brought back
 * into use mid-sweep is not the one the sweep changes.
 */
export interface CodexHomeSweepFs {
  readdir: (path: string) => Promise<string[]>;
  lstat: (path: string) => Promise<LinkStat>;
  unlink: (path: string) => Promise<void>;
  rm: (path: string, options: { recursive: true; force: true }) => Promise<void>;
  renameSync: (from: string, to: string) => void;
  lstatSync: (path: string) => LinkStat;
  unlinkSync: (path: string) => void;
}

const NODE_SWEEP_FS: CodexHomeSweepFs = {
  readdir: (path) => readdir(path),
  lstat: (path) => lstat(path),
  unlink: (path) => unlink(path),
  rm: (path, options) => rm(path, options),
  renameSync: (from, to) => renameSync(from, to),
  lstatSync: (path) => lstatSync(path),
  unlinkSync: (path) => unlinkSync(path),
};

/**
 * What a home the sweep has taken out of use is renamed to begin with,
 * before anything in it is removed (EO-566). A dot, so it can never be an
 * agent's id; a later sweep removes one a crash left behind.
 */
export const RETIRING_CODEX_HOME_PREFIX = ".retiring-";

/**
 * The retired homes this process is removing right now, so a second
 * sweep running beside the first — the dispatch preflight's, beside the
 * one after the window opens — leaves them to it.
 */
const retiringNow = new Set<string>();

/**
 * `removeCodexHome`, step for step and with the same refusals, without
 * holding the event loop (EO-566). The sweep's, which only ever hands it
 * a home it has already renamed out of use, so nothing can be preparing
 * the directory this is removing.
 *
 * A link already gone is as good as unlinked.
 */
export async function removeCodexHomeAsync(path: string, fs: CodexHomeSweepFs = NODE_SWEEP_FS): Promise<void> {
  const home = await lstatOrNullAsync(fs, path);
  if (home === null) return;
  if (home.isSymbolicLink() || !home.isDirectory()) {
    await unlinkIfPresent(fs, path);
    return;
  }
  const sessionsPath = join(path, CODEX_SESSIONS_DIRECTORY);
  const sessions = await lstatOrNullAsync(fs, sessionsPath);
  if (sessions !== null && !sessions.isSymbolicLink()) {
    throw new Error(realSessionsProblem(sessionsPath, sessions, path));
  }
  if (sessions !== null) await unlinkIfPresent(fs, sessionsPath);
  const credential = join(path, CODEX_CREDENTIAL_FILE);
  const stat = await lstatOrNullAsync(fs, credential);
  if (stat !== null && (stat.isSymbolicLink() || stat.isFile())) await unlinkIfPresent(fs, credential);
  if ((await lstatOrNullAsync(fs, sessionsPath)) !== null) throw new Error(`${sessionsPath} could not be unlinked`);
  await fs.rm(path, { recursive: true, force: true });
}

function realSessionsProblem(sessionsPath: string, sessions: LinkStat, home: string): string {
  return `${sessionsPath} is a real ${sessions.isDirectory() ? "directory" : "file"} rather than a link, so EO left ${home} alone rather than delete what is in it`;
}

/**
 * Removes every home under `root` that no agent uses (EO-378): an agent
 * deleted, moved to another backend, or ticked over to the person's own
 * setup. Answers what it removed.
 *
 * **A home is claimed before anything in it is removed** (EO-566). The
 * walk awaits, and while it does an agent can be switched back to a
 * locked-down Codex and dispatched, which makes its home ready again —
 * synchronously, at the path the sweep is working on. So `keep` is asked
 * and the home renamed to a `RETIRING_CODEX_HOME_PREFIX` name in one
 * synchronous step, with nothing awaited between them: no preparation
 * can run between the decision and the claim, and once claimed the
 * home's path is free. A preparation that runs while the removal awaits
 * builds a new home there, and the removal only ever touches the renamed
 * one. That rename is a single synchronous call.
 *
 * A home whose `sessions` is a real directory is refused where it stands,
 * looked at before it is claimed so its rollouts are never moved.
 *
 * A home that cannot be removed now — on Windows, one a running Codex
 * still holds open, which also refuses the rename — is reported and left
 * for the next sweep.
 *
 * **Every home it keeps loses an `auth.json` that is not a symlink**
 * (EO-774, `dropCredentialThatIsNotALink`): the hard links EO made on
 * Windows before then, in the homes of agents that are not dispatched
 * again, and in the side calls' own. Each would keep the person's own
 * credential file at more than one link, which Codex 0.167.0 refuses to
 * save a refreshed sign-in into. The last look and the unlink are again
 * one synchronous step, so the symlink a dispatch makes while the sweep
 * awaits is never the file it removes.
 */
export async function sweepCodexHomes(root: string, keep: () => ReadonlySet<string>, fs: CodexHomeSweepFs = NODE_SWEEP_FS): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names) {
    // EO's own side calls' home is nobody's agent and always kept: it is
    // made ready again before every call, and a sweep that removed it
    // mid-call would sign the call out (EO-477).
    const path = join(root, name);
    if (retiringNow.has(path)) continue;
    try {
      let retiring = path;
      if (!name.startsWith(RETIRING_CODEX_HOME_PREFIX)) {
        if (name === SIDE_CALL_CODEX_HOME || keep().has(name)) {
          const home = await lstatOrNullAsync(fs, path);
          if (home !== null && home.isDirectory() && !home.isSymbolicLink()) await dropCredentialThatIsNotALink(fs, path);
          continue;
        }
        // Looked at in place: nothing is removed by this, and a refusal
        // leaves the home exactly where it is.
        const sessionsPath = join(path, CODEX_SESSIONS_DIRECTORY);
        const home = await lstatOrNullAsync(fs, path);
        const sessions = home !== null && home.isDirectory() && !home.isSymbolicLink() ? await lstatOrNullAsync(fs, sessionsPath) : null;
        if (sessions !== null && !sessions.isSymbolicLink()) throw new Error(realSessionsProblem(sessionsPath, sessions, path));
        // The claim: asked again and renamed in one synchronous step.
        if (keep().has(name)) continue;
        retiring = join(root, `${RETIRING_CODEX_HOME_PREFIX}${name}-${uuidv7()}`);
        try {
          fs.renameSync(path, retiring);
        } catch (error) {
          // Another sweep claimed it first.
          if (isMissing(error)) continue;
          throw error;
        }
      }
      retiringNow.add(retiring);
      try {
        await removeCodexHomeAsync(retiring, fs);
      } finally {
        retiringNow.delete(retiring);
      }
      removed.push(name);
    } catch (error) {
      console.warn(`[eo] could not remove the unused Codex home ${path}: ${messageOf(error)}`);
    }
  }
  return removed;
}

/**
 * Where the person's Codex says it keeps its sign-in: the top-level
 * `cli_auth_credentials_store` in their `config.toml` — `file`, Codex's
 * own default, when it says nothing or cannot be read.
 *
 * Read with a pattern rather than a TOML parser, which EO does not
 * carry: a top-level key is a line before the first `[table]` header,
 * and that is all this looks at.
 */
export function codexCredentialStore(personHome: string = personCodexHome(), read: (path: string) => string | null = readOrNull): string {
  const text = read(join(personHome, "config.toml"));
  if (text === null) return "file";
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*cli_auth_credentials_store\s*=\s*["']([^"']*)["']/.exec(line);
    if (match) return (match[1] ?? "file").trim().toLowerCase();
  }
  return "file";
}

/**
 * Whether the person's Codex sign-in is in the OS keyring, where no home
 * but theirs can reach it (EO-378).
 *
 * `keyring` always is. **So is `auto`, with or without an `auth.json`
 * beside it.** Codex on `auto` loads the keyring first and falls back to
 * the file, so where both exist the keyring entry is the live credential
 * and the file is whatever was left behind — and a home of the agent's
 * own, which reads only the file, would run on the stale one while the
 * Runtimes card, asking the person's home, said signed in. EO cannot
 * look in the keyring to tell the two cases apart, so it takes the one
 * reading that is never wrong about the sign-in: `auto` runs in the
 * person's own home. The cost is a person on `auto` whose machine has no
 * keyring, who is not locked down until they say `file`; the notice
 * tells them that.
 */
export function signInIsInKeyring(personHome: string = personCodexHome(), read: (path: string) => string | null = readOrNull): boolean {
  const store = codexCredentialStore(personHome, read);
  return store === "keyring" || store === "auto";
}

/** `signInIsInKeyring`, with the person's `config.toml` read without holding the event loop (EO-566). */
export async function signInIsInKeyringAsync(personHome: string = personCodexHome()): Promise<boolean> {
  const text = await readFile(join(personHome, "config.toml"), "utf8").catch(() => null);
  return signInIsInKeyring(personHome, () => text);
}

/**
 * What EO says on an item when a Codex agent that should have been
 * locked down ran with the person's own setup because their sign-in is
 * in the keyring (EO-378, invariant 8). The same sentence every time, so
 * the supervisor's dispatch notices say it once per item.
 */
export function keyringNotice(agentName: string, personHome: string = personCodexHome()): string {
  return (
    `Codex is set to keep your sign-in in your operating system's keyring, which EO cannot carry into a Codex home of ${agentName}'s own, ` +
    `so ${agentName} runs with your own Codex setup in ${personHome}: its config.toml, AGENTS.md, skills and MCP servers reach the agent, ` +
    `not only what is attached to it in EO. To lock it down, set cli_auth_credentials_store = "file" in ${join(personHome, "config.toml")} ` +
    `and sign in to Codex again.`
  );
}

/**
 * Where a locked-down Codex agent runs.
 *
 * `own` is the lockdown. `person` is the person's own home, for the one
 * reason a person agreed to on EO-378: their sign-in is in the keyring,
 * and `notice` is what the item is told. `unavailable` is neither — no
 * root EO has could be linked to their sign-in and conversations — and
 * the dispatch is refused: an agent nobody ticked over must not run with
 * the person's configuration because a link failed.
 */
export type CodexHomeChoice =
  | { kind: "own"; path: string; credential: "carried" | "absent"; credentialPath: string }
  | { kind: "person"; reason: "keyring"; personHome: string; notice: (agentName: string) => string }
  | { kind: "unavailable"; problem: string };

/**
 * Decides where a locked-down Codex agent runs, and makes that home
 * ready (EO-378).
 *
 * The roots are tried in order and the first that can be linked wins:
 * `userData/codex-homes`, then EO's folder in the person's profile. A
 * symlink and a junction both cross drives, so the second is for a first
 * that cannot be made at all; before EO-774 it was also where a Windows
 * hard link to a sign-in on another drive went. An agent has one home:
 * once a root works, a home it had under another is removed.
 *
 * Where no root works the answer is `unavailable`, and nothing runs. On
 * Windows without Developer Mode no root can hold the symlink, so the
 * others are not tried and the answer is that one reason
 * (`DEVELOPER_MODE_PROBLEM`), said once.
 */
export function chooseCodexHome(options: Omit<CodexHomeOptions, "root"> & { roots: readonly string[] }): CodexHomeChoice {
  const fs = options.fs ?? NODE_FS;
  const personHome = options.personHome ?? personCodexHome();
  if (signInIsInKeyring(personHome)) {
    return { kind: "person", reason: "keyring", personHome, notice: (agentName) => keyringNotice(agentName, personHome) };
  }
  const problems: string[] = [];
  for (const root of options.roots) {
    const prepared = prepareCodexHome({ ...options, root, personHome });
    if (!prepared.ok) {
      if (prepared.developerMode) return { kind: "unavailable", problem: prepared.problem };
      problems.push(prepared.problem);
      continue;
    }
    for (const other of options.roots) {
      if (other === root) continue;
      const stale = agentCodexHomePath(other, options.agentId);
      try {
        if (fs.existsSync(stale)) removeCodexHome(stale, fs);
      } catch (error) {
        console.warn(`[eo] could not remove the superseded Codex home ${stale}: ${messageOf(error)}`);
      }
    }
    return { kind: "own", path: prepared.path, credential: prepared.credential, credentialPath: prepared.credentialPath };
  }
  return { kind: "unavailable", problem: problems.join(" ") };
}

/** The agents that keep a home: Codex, not deleted, and not using the person's own setup. */
export function agentsWithCodexHomes(
  agents: readonly { id: string; provider: string; config: Readonly<Record<string, unknown>>; deletedAt?: number | null }[],
): Set<string> {
  return new Set(
    agents
      .filter((agent) => agent.provider === "codex" && (agent.deletedAt ?? null) === null && !inheritsAmbientConfig(agent.config))
      .map((agent) => agent.id),
  );
}

/**
 * Why a locked-down Codex agent must not be dispatched, or null.
 *
 * This is what keeps the Runtimes card and a dispatch from disagreeing.
 * The card asks the person's own home; a dispatch runs in the agent's.
 * Where the card says signed in and there was no credential file to
 * carry across — and the configuration says `file`, so it is not the
 * keyring either — the dispatch would spend its first eleven seconds on
 * 401s and then fail without saying why (`ARCHITECTURE.md`, "Codex homes") — so it is
 * refused before it starts, with the reason, instead.
 *
 * And where no home of the agent's own could be made at all, it is
 * refused for that: the alternative would be running an agent nobody
 * ticked over with the person's own configuration.
 *
 * Never about an agent running in the person's home for the keyring:
 * that one asks the home the card asks.
 */
export function codexHomeRefusal(
  choice: CodexHomeChoice,
  cardSays: "signed_in" | "signed_out" | "unknown",
  agentName: string,
): string | null {
  if (choice.kind === "person") return null;
  const optOut = `Tick "Let this agent use your own Codex setup" on ${agentName} to run it with your own Codex home instead.`;
  if (choice.kind === "unavailable") {
    return (
      `${agentName} runs with a Codex home of its own, which carries your sign-in and saved conversations and none of your other Codex setup, ` +
      `and EO could not make one: ${choice.problem} ${optOut} Then reply here to retry.`
    );
  }
  const prepared = choice;
  if (prepared.credential === "absent" && cardSays === "signed_in") {
    return (
      `Codex is signed in, but not with a credential file EO can carry into ${agentName}'s own Codex home: ` +
      `there is nothing at ${prepared.credentialPath}, and Codex's configuration does not say the sign-in is in the keyring. ` +
      `${optOut} Then reply here to retry.`
    );
  }
  return null;
}

function lstatOrNull(fs: Pick<CodexHomeFs, "lstatSync">, path: string): LinkStat | null {
  try {
    return fs.lstatSync(path);
  } catch {
    return null;
  }
}

async function lstatOrNullAsync(fs: CodexHomeSweepFs, path: string): Promise<LinkStat | null> {
  try {
    return await fs.lstat(path);
  } catch {
    return null;
  }
}

/** Gone already is as good as unlinked: another sweep may have got there first. */
async function unlinkIfPresent(fs: CodexHomeSweepFs, path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function readlinkOrNull(fs: CodexHomeFs, path: string): string | null {
  try {
    return fs.readlinkSync(path);
  } catch {
    return null;
  }
}

function samePath(actual: string | null, expected: string, windows: boolean): boolean {
  if (actual === null) return false;
  // Windows hands a junction's target back with the `\\?\` prefix.
  const clean = (path: string) => resolve(path.replace(/^\\\\\?\\/, ""));
  return windows ? clean(actual).toLowerCase() === clean(expected).toLowerCase() : clean(actual) === clean(expected);
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why EO's memory calls on Codex were not made: the person's Codex keeps
 * its sign-in in the operating system's keyring, or on `auto` (EO-509).
 *
 * It names the one fix there is. These calls have no backend of their
 * own to change — selection and extraction run on the dispatched agent's,
 * consolidation on the system agent's — so the sentence says nothing
 * about choosing another one; it says how to keep the sign-in in a file
 * a home of the side calls' own can carry.
 */
export function sideCallKeyringRefusal(personHome: string = personCodexHome()): string {
  return (
    "EO's memory calls on Codex — choosing which memory an agent is given, writing notes from its runs, and tidying them — run only in a Codex home of their own, " +
    "and your Codex is set to keep its sign-in in your operating system's keyring (`keyring` or `auto`), which no other home can reach. " +
    "Running them in your own Codex home would hand them your own MCP servers and settings, so this call was not made. " +
    `To make these calls, set cli_auth_credentials_store = "file" in ${join(personHome, "config.toml")} and sign in to Codex again.`
  );
}

/**
 * The home a Codex side call runs in (EO-477), or why there is none.
 *
 * Unlike an agent's, there is no fallback to the person's own home. An
 * agent whose person keeps their Codex sign-in in the OS keyring runs in
 * their home, and says so on the item, because that is the only home the
 * sign-in reaches; but the person's home is also their `config.toml`,
 * with their own MCP servers, hooks and instructions, and a side call has
 * to start with none of those. So where the sign-in cannot be carried
 * into a home of the side calls' own — the keyring, `auto`, or no root
 * that can be linked — the call is refused, and the sentence says why.
 * `keyring` is the one a person can fix (`sideCallKeyringRefusal`);
 * `unavailable` is a home that could not be made.
 */
export function sideCallCodexHome(
  options: Omit<CodexHomeOptions, "root" | "agentId"> & { roots: readonly string[] },
): { ok: true; path: string } | { ok: false; reason: "keyring" | "unavailable"; problem: string } {
  const choice = chooseCodexHome({ ...options, agentId: SIDE_CALL_CODEX_HOME });
  if (choice.kind === "own") return { ok: true, path: choice.path };
  if (choice.kind === "person") return { ok: false, reason: "keyring", problem: sideCallKeyringRefusal(choice.personHome) };
  return { ok: false, reason: "unavailable", problem: choice.problem };
}
