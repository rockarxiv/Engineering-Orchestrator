import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Item } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { listGitWorkspaces } from "../../../db/repos/index.js";
import type { MemberCopyOutcome } from "../../../supervisor/teamEvidence.js";
import { codeSpan } from "../../../codeSpan.js";
import { git, samePath } from "./git.js";
import { defaultWorktreeRoot } from "./worktrees.js";

/**
 * An isolated team member's own copy of an item's repository (EO-867,
 * EO-872): the item's worktree exactly, as the team's evidence baseline
 * captured it.
 *
 * **The item's worktree, exactly.** The copy is a detached worktree at
 * the item's own HEAD commit. Every difference the captured tree has from
 * that HEAD — a modified, added or deleted file — is an uncommitted change
 * in it; a file the item's index does not track stays untracked (an added
 * one is marked intent-to-add, so `git diff` shows it). EO makes no commit
 * for it: `git log` in the copy lists exactly the branch's commits, and a
 * reviewer judges the branch's commits and nothing EO made.
 *
 * **Outside every checkout**, at `<EO's directory>/team-copies/<KEY>/<attempt>`,
 * beside the items' own worktrees (`~/.eo/worktrees`). Nothing that
 * searches parent directories — a `CLAUDE.md`, `node_modules` — reaches the
 * person's checkout from it. Copies made before EO-872 sit at
 * `<git common dir>/eo-team-copies/<KEY>/<attempt>`; every sweep looks in
 * both places.
 *
 * **Detached, and its own.** A detached HEAD moves no branch: a commit, a
 * reset or a checkout in the copy changes the copy's HEAD and index and
 * nothing else of the item's.
 *
 * **Refs are shared, so they are watched.** A worktree shares its
 * repository's branches, tags and stash. What they were when the attempt
 * started is recorded; what was created, moved or deleted since is said
 * on the member's report. A member's own writes are told apart from
 * anybody else's — a sibling member's, the person's — by what its
 * processes carry (`memberEnvironment`): a committer email of its
 * attempt's, and a reflog kept for every ref, tags included. A branch or
 * tag created under a name that did not exist at the start is deleted when
 * the copy goes, by its own turn or by a sweep, only where every entry of
 * its reflog is that member's — so never another member's, never one the
 * person made or has written to since, and never one a worktree has
 * checked out. A stash entry is named and never dropped: the stash is
 * every worktree's.
 *
 * **Changes are said, then discarded.** Members run unsandboxed, as the
 * step's own agent does, so nothing here stops a write. What EO handed the
 * member is recorded beside the worktree's own metadata, so `git worktree
 * remove` takes it too; before the copy goes, what differs from it is
 * handed back to be said. Nothing a member changed is merged anywhere.
 */

/** Where copies lived before EO-872, under a repository's git common dir. Swept, never made. */
const LEGACY_COPIES_DIRECTORY = "eo-team-copies";
/** EO's record of what it handed the member, beside the worktree's own metadata. */
const RECORD_FILE = "eo-team-copy.json";
/** How many paths a sentence names before it says "and N more". */
const LISTED_PATHS = 10;
/** How many paths one `git add` is handed. */
const PATHS_PER_CALL = 100;
/** What an attempt's id may be, as a directory name: never anything that climbs out. */
const ATTEMPT = /^[A-Za-z0-9_-]+$/;
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Branches and tags by full ref name, and stash entries newest first. */
interface RefState {
  refs: Record<string, string>;
  stash: { oid: string; subject: string }[];
}

interface CopyRecord {
  attemptId: string;
  /** The HEAD EO checked out. */
  head: string;
  /** The tree EO laid over it. */
  tree: string;
  /** The repository's refs when the attempt started; absent on a copy made before EO-872. */
  before?: RefState;
}

/** Where member copies live: `team-copies` beside the items' worktrees. */
export function teamCopiesRoot(worktreeRoot?: string): string {
  return join(dirname(worktreeRoot ?? defaultWorktreeRoot()), "team-copies");
}

/**
 * A member's copy of `source`, captured from the repository at `repoPath`
 * (the item's worktree), made under `root` for `attemptId` alone.
 */
export async function makeMemberCopy(repoPath: string, itemKey: string, source: { tree: string; head: string | null; added?: readonly string[] | undefined }, attemptId: string, root: string): Promise<MemberCopyOutcome> {
  if (!ATTEMPT.test(attemptId) || itemKey === "" || itemKey.includes("/") || itemKey.includes("\\") || itemKey.includes("..")) return { ok: false, problem: "EO could not name a copy for that attempt." };
  if (source.head === null) return { ok: false, problem: "The item's repository has no commit yet, so there is no HEAD to give the member a copy of." };
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoPath);
  if (!common.ok) return { ok: false, problem: `EO could not find the repository's git directory to make the member a copy: ${codeSpan(common.error)}` };
  const before = await refState(common.stdout);
  if (!before.ok) return { ok: false, problem: `EO could not read the repository's branches, tags and stash before the member's attempt: ${codeSpan(before.error)}` };

  const path = join(root, itemKey, attemptId);
  if (existsSync(path)) await removeCopy(path, common.stdout);
  await mkdir(dirname(path), { recursive: true });
  const fail = async (what: string, error: string): Promise<MemberCopyOutcome> => {
    await removeCopy(path, common.stdout);
    return { ok: false, problem: `EO could not ${what}: ${codeSpan(error)}` };
  };
  const checkedOut = await git(["worktree", "add", "--detach", "--no-checkout", path, source.head], common.stdout);
  if (!checkedOut.ok) return fail("check out the member's copy", checkedOut.error);
  // The captured tree onto the index and the disk, then the index back to
  // HEAD: the tree's differences from HEAD are left uncommitted on disk.
  const laid = await git(["read-tree", "-u", "--reset", source.tree], path);
  if (!laid.ok) return fail("lay the captured tree into the member's copy", laid.error);
  const reset = await git(["reset", "-q"], path);
  if (!reset.ok) return fail("leave the captured changes uncommitted in the member's copy", reset.error);
  // A file the item's index tracked and HEAD does not, as the capture
  // recorded it, is an added file, not an untracked one — whatever the
  // item's index says now.
  const added = new Set(source.added ?? []);
  if (added.size > 0) {
    const newInTree = await git(["diff-tree", "-r", "--name-only", "-z", "--no-renames", "--diff-filter=A", source.head, source.tree], path);
    if (!newInTree.ok) return fail("read which files the captured tree adds", newInTree.error);
    const intended = newInTree.stdout.split("\0").filter((one) => one !== "" && added.has(one));
    for (let at = 0; at < intended.length; at += PATHS_PER_CALL) {
      const marked = await git(["add", "--intent-to-add", "--", ...intended.slice(at, at + PATHS_PER_CALL)], path);
      if (!marked.ok) return fail("mark the item's added files in the member's copy", marked.error);
    }
  }
  const adminDir = await git(["rev-parse", "--absolute-git-dir"], path);
  if (!adminDir.ok) return fail("find the member's copy's git metadata", adminDir.error);
  const record: CopyRecord = { attemptId, head: source.head, tree: source.tree, before: before.state };
  try {
    await writeFile(join(adminDir.stdout, RECORD_FILE), JSON.stringify(record));
  } catch (error) {
    return fail("record what it handed the member", error instanceof Error ? error.message : String(error));
  }
  return {
    ok: true,
    copy: { cwd: path, changes: () => inspectCopy(path), remove: () => removeCopy(path, common.stdout), environment: (variables) => memberEnvironment(attemptId, variables) },
  };
}

/** The committer email a member's processes carry, which its reflog entries are told apart by. */
function memberEmail(attemptId: string): string {
  return `team-member-${attemptId}@eo.invalid`;
}

/**
 * What a member's processes carry, laid over the run's own variables
 * (EO-872): its attempt's committer email, and `core.logAllRefUpdates`
 * set to `always` through Git's environment configuration — after any the
 * run's variables already give — so every ref it writes, a tag included,
 * keeps a reflog entry naming it.
 */
export function memberEnvironment(attemptId: string, variables: Readonly<Record<string, string>> = {}): Record<string, string> {
  const given = Number(variables["GIT_CONFIG_COUNT"]);
  const at = Number.isInteger(given) && given >= 0 ? given : 0;
  return {
    ...variables,
    GIT_COMMITTER_EMAIL: memberEmail(attemptId),
    GIT_CONFIG_COUNT: String(at + 1),
    [`GIT_CONFIG_KEY_${at}`]: "core.logAllRefUpdates",
    [`GIT_CONFIG_VALUE_${at}`]: "always",
  };
}

/**
 * Is `ref` the member's alone: created by it, and written to by nobody
 * else since? Read from the ref's reflog, entry by entry. A ref with no
 * reflog to read — a backend that keeps none on disk — is nobody's EO can
 * name, so it is kept.
 */
async function ownedBy(commonDir: string, ref: string, email: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(commonDir, "logs", ...ref.split("/")), "utf8");
  } catch {
    return false;
  }
  const entries = lines(text);
  if (entries.length === 0 || !/^0+ /.test(entries[0]!)) return false;
  return entries.every((entry) => {
    const ident = entry.split("\t")[0] ?? "";
    return ident.slice(ident.indexOf("<") + 1, ident.indexOf(">")) === email;
  });
}

/**
 * What was done since EO handed the member its copy, as phrases: files
 * changed, added or deleted against the captured tree (the item's own
 * uncommitted changes are what it was handed, never the member's), a HEAD
 * that is no longer the one EO checked out, and the shared repository's
 * branches, tags and stash entries created, moved or deleted during the
 * attempt. Ignored files are not counted: a build's output is not a
 * change anyone reads.
 */
export async function inspectCopy(path: string): Promise<string[]> {
  const located = await locate(path);
  if (located === null) return [];
  const record = await readRecord(located.adminDir);
  if (record === null) return ["EO's record of what it handed the member is missing, so what changed in its copy cannot be said"];
  const found: string[] = [];

  const now = await workingTree(path, located.adminDir, record.head);
  if (!now.ok) found.push(`its files could not be read (${codeSpan(now.error)})`);
  else if (now.tree !== record.tree) {
    const diff = await git(["diff-tree", "-r", "--name-status", "-z", "--no-renames", record.tree, now.tree], path);
    if (!diff.ok) found.push(`its files could not be compared with what EO handed it (${codeSpan(diff.error)})`);
    else {
      const byStatus: Record<string, string[]> = { M: [], A: [], D: [] };
      const fields = diff.stdout.split("\0");
      for (let at = 0; at + 1 < fields.length; at += 2) {
        const status = fields[at]!.trim().charAt(0);
        (byStatus[status === "A" || status === "D" ? status : "M"] ??= []).push(fields[at + 1]!);
      }
      if (byStatus.M!.length > 0) found.push(`${count(byStatus.M!.length, "file")} changed: ${listPaths(byStatus.M!)}`);
      if (byStatus.A!.length > 0) found.push(`${count(byStatus.A!.length, "file")} added: ${listPaths(byStatus.A!)}`);
      if (byStatus.D!.length > 0) found.push(`${count(byStatus.D!.length, "file")} deleted: ${listPaths(byStatus.D!)}`);
    }
  }

  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], path);
  const at = head.ok && head.stdout !== "" ? head.stdout : null;
  if (at !== record.head) found.push(`HEAD moved from ${record.head.slice(0, 12)} to ${at === null ? "nothing" : at.slice(0, 12)}`);

  if (record.before !== undefined) found.push(...(await refsSaid(located.commonDir, { ...record, before: record.before }, path)));
  return found;
}

/** The tree of the copy's working tree as `git add -A` sees it, built in a scratch index so the copy's own is left alone. */
async function workingTree(path: string, adminDir: string, head: string): Promise<{ ok: true; tree: string } | { ok: false; error: string }> {
  const scratch = await mkdtemp(join(tmpdir(), "eo-team-copy-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    // Starting from the copy's own index keeps its stat data, so only files touched since are read again.
    const seeded = await copyFile(join(adminDir, "index"), env.GIT_INDEX_FILE).then(
      () => true,
      () => false,
    );
    if (!seeded) {
      const read = await git(["read-tree", head], path, { env });
      if (!read.ok) return { ok: false, error: read.error };
    }
    const added = await git(["add", "-A", "--", "."], path, { env });
    if (!added.ok) return { ok: false, error: added.error };
    const tree = await git(["write-tree"], path, { env });
    return tree.ok && OID.test(tree.stdout) ? { ok: true, tree: tree.stdout } : { ok: false, error: tree.ok ? "git named no tree" : tree.error };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function refState(commonDir: string): Promise<{ ok: true; state: RefState } | { ok: false; error: string }> {
  const listed = await git(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/tags"], commonDir);
  if (!listed.ok) return { ok: false, error: listed.error };
  const refs: Record<string, string> = {};
  for (const line of lines(listed.stdout)) {
    const [name, oid] = line.split("\0");
    if (name !== undefined && oid !== undefined) refs[name] = oid;
  }
  const stash: RefState["stash"] = [];
  const hasStash = await git(["rev-parse", "--verify", "--quiet", "refs/stash"], commonDir);
  if (hasStash.ok && hasStash.stdout !== "") {
    const entries = await git(["log", "-g", "--format=%H%x00%gs", "refs/stash"], commonDir);
    if (!entries.ok) return { ok: false, error: entries.error };
    for (const line of lines(entries.stdout)) {
      const [oid, subject] = line.split("\0");
      if (oid !== undefined) stash.push({ oid, subject: subject ?? "" });
    }
  }
  return { ok: true, state: { refs, stash } };
}

/** Branches checked out in some worktree other than `except`, which EO never deletes. */
async function checkedOut(commonDir: string, except: string | null): Promise<Set<string>> {
  const listed = await git(["worktree", "list", "--porcelain"], commonDir);
  const held = new Set<string>();
  if (!listed.ok) return held;
  let at: string | null = null;
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) at = line.slice("worktree ".length);
    else if (line.startsWith("branch ") && (except === null || at === null || !samePath(at, except))) held.add(line.slice("branch ".length));
  }
  return held;
}

/**
 * The refs EO deletes with a member's copy: created under a name new since
 * its attempt started, the member's alone by their reflogs, and checked
 * out in no worktree but its own. The rest of what is new since, and why.
 */
async function created(commonDir: string, record: CopyRecord & { before: RefState }, now: RefState, copyPath: string | null): Promise<{ goes: Set<string>; kept: Map<string, string> }> {
  const held = await checkedOut(commonDir, copyPath);
  const goes = new Set<string>();
  const kept = new Map<string, string>();
  for (const name of Object.keys(now.refs)) {
    if (record.before.refs[name] !== undefined) continue;
    if (!(await ownedBy(commonDir, name, memberEmail(record.attemptId)))) kept.set(name, "not every write to it was this member's");
    else if (held.has(name)) kept.set(name, "a worktree has it checked out");
    else goes.add(name);
  }
  return { goes, kept };
}

async function refsSaid(commonDir: string, record: CopyRecord & { before: RefState }, copyPath: string): Promise<string[]> {
  const before = record.before;
  const now = await refState(commonDir);
  if (!now.ok) return [`the repository's branches, tags and stash could not be read after its attempt (${codeSpan(now.error)})`];
  const { goes, kept } = await created(commonDir, record, now.state, copyPath);
  const said: string[] = [];
  const names = [...new Set([...Object.keys(before.refs), ...Object.keys(now.state.refs)])].sort();
  for (const name of names) {
    const was = before.refs[name];
    const is = now.state.refs[name];
    if (was === is) continue;
    const what = refLabel(name);
    if (was === undefined) said.push(`in the repository it shares with the item, ${what} was created at ${is!.slice(0, 12)} since its attempt started, ${goes.has(name) ? "by this member, and EO deletes it with the copy" : `and EO left it, since ${kept.get(name) ?? "it is not this member's alone"}`}`);
    else if (is === undefined) said.push(`in the repository it shares with the item, ${what} was deleted since its attempt started (it was at ${was.slice(0, 12)})`);
    else said.push(`in the repository it shares with the item, ${what} moved from ${was.slice(0, 12)} to ${is.slice(0, 12)} since its attempt started`);
  }
  const had = new Set(before.stash.map((entry) => entry.oid));
  const has = new Set(now.state.stash.map((entry) => entry.oid));
  for (const entry of now.state.stash) {
    if (!had.has(entry.oid)) said.push(`a stash entry ${entry.oid.slice(0, 12)} (${codeSpan(entry.subject)}) was pushed since its attempt started, and EO left it: the stash is shared with every worktree`);
  }
  for (const entry of before.stash) {
    if (!has.has(entry.oid)) said.push(`the stash entry ${entry.oid.slice(0, 12)} (${codeSpan(entry.subject)}) was dropped since its attempt started`);
  }
  return said;
}

function refLabel(name: string): string {
  if (name.startsWith("refs/heads/")) return `branch \`${name.slice("refs/heads/".length)}\``;
  if (name.startsWith("refs/tags/")) return `tag \`${name.slice("refs/tags/".length)}\``;
  return `\`${name}\``;
}

/** The copy's own git metadata and its repository's common dir — or null where `path` is not a worktree of its own. */
async function locate(path: string): Promise<{ adminDir: string; commonDir: string } | null> {
  // Never a repository found further up: `~` may be one.
  if (!existsSync(join(path, ".git"))) return null;
  const top = await git(["rev-parse", "--show-toplevel"], path);
  if (!top.ok || !samePath(top.stdout, path)) return null;
  const adminDir = await git(["rev-parse", "--absolute-git-dir"], path);
  const commonDir = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], path);
  return adminDir.ok && commonDir.ok ? { adminDir: adminDir.stdout, commonDir: commonDir.stdout } : null;
}

async function readRecord(adminDir: string): Promise<CopyRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(adminDir, RECORD_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const raw = parsed as { attemptId?: unknown; head?: unknown; tree?: unknown; commit?: unknown; before?: unknown };
    if (typeof raw.head === "string" && typeof raw.tree === "string") return parsed as CopyRecord;
    // Made before EO-872: a commit EO wrapped the captured tree in, checked out; no refs recorded.
    if (typeof raw.commit === "string") {
      const tree = await git(["rev-parse", `${raw.commit}^{tree}`], adminDir);
      return tree.ok ? { attemptId: typeof raw.attemptId === "string" ? raw.attemptId : "", head: raw.commit, tree: tree.stdout } : null;
    }
  } catch {
    // Missing or unreadable is the same answer.
  }
  return null;
}

/**
 * Removes a copy, whatever is in it, and the branches and tags its member
 * created under new names and alone wrote to (`created`) — by its own
 * turn and by a sweep alike, since a reflog says whose a ref is however
 * long after. Never throws.
 */
async function removeCopy(path: string, knownCommonDir: string | null): Promise<void> {
  try {
    const located = await locate(path);
    const commonDir = located?.commonDir ?? knownCommonDir;
    const record = located === null ? null : await readRecord(located.adminDir);
    if (commonDir !== null) {
      const removed = await git(["worktree", "remove", "--force", "--force", path], commonDir);
      if (!removed.ok || existsSync(path)) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
        await git(["worktree", "prune"], commonDir);
      }
      if (record?.before !== undefined) {
        const now = await refState(commonDir);
        if (now.ok) {
          const { goes } = await created(commonDir, { ...record, before: record.before }, now.state, null);
          for (const name of goes) await git(["update-ref", "-d", name, now.state.refs[name]!], commonDir);
        }
      }
    } else {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
    // The item's folder goes with its last copy; `rmdir` refuses one that is not empty.
    await rmdir(dirname(path)).catch(() => undefined);
  } catch {
    // Said by what is left on disk, which the next sweep takes.
  }
}

/** One member copy found on disk. */
export interface FoundMemberCopy {
  itemKey: string;
  attemptId: string;
  path: string;
}

/**
 * Every member copy of the repository at `repoPath`, optionally only one
 * item's: those under `root` that are its worktrees, and those in the old
 * place under its git common dir.
 */
export async function listMemberCopies(repoPath: string, root: string, itemKey?: string): Promise<FoundMemberCopy[]> {
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoPath);
  if (!common.ok) return [];
  const found = await copiesUnder(join(common.stdout, LEGACY_COPIES_DIRECTORY), itemKey);
  for (const candidate of await copiesUnder(root, itemKey)) {
    const located = await locate(candidate.path);
    if (located !== null && samePath(located.commonDir, common.stdout)) found.push(candidate);
  }
  return found;
}

async function copiesUnder(root: string, itemKey?: string): Promise<FoundMemberCopy[]> {
  const keys = itemKey === undefined ? await directoriesIn(root) : existsSync(join(root, itemKey)) ? [itemKey] : [];
  const found: FoundMemberCopy[] = [];
  for (const key of keys) {
    for (const attemptId of await directoriesIn(join(root, key))) found.push({ itemKey: key, attemptId, path: join(root, key, attemptId) });
  }
  return found;
}

async function directoriesIn(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Removes the member copies left of every repository EO knows: one
 * item's, or — with no item — every one whose attempt `keep` does not
 * name. What was done in each is handed to `report` before it goes.
 * Every repository rather than the item's project's: one taken off the
 * project since still holds its copies. A folder under `root` that is no
 * worktree at all — a copy half made — is removed too.
 */
export async function releaseMemberCopies(
  db: Db,
  request: { item?: Pick<Item, "key">; keep?: (attemptId: string) => boolean; report: (attemptId: string, changed: string[]) => void },
  root: string,
): Promise<string[]> {
  const removed: string[] = [];
  const take = async (found: FoundMemberCopy, commonDir: string | null) => {
    if (request.keep?.(found.attemptId) === true) return;
    const changed = await inspectCopy(found.path).catch(() => []);
    if (changed.length > 0) request.report(found.attemptId, changed);
    await removeCopy(found.path, commonDir);
    if (!existsSync(found.path)) removed.push(found.path);
    else console.error(`[eo] could not remove the team member's copy ${found.path} for ${found.itemKey}`);
  };
  for (const workspace of listGitWorkspaces(db)) {
    const repoPath = workspace.config.repoPath;
    const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoPath);
    for (const found of await listMemberCopies(repoPath, root, request.item?.key)) await take(found, common.ok ? common.stdout : null);
  }
  for (const found of await copiesUnder(root, request.item?.key)) {
    if (existsSync(found.path) && !existsSync(join(found.path, ".git"))) await take(found, null);
  }
  return removed;
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, LISTED_PATHS).map((path) => `\`${path}\``).join(", ");
  return paths.length > LISTED_PATHS ? `${shown} and ${paths.length - LISTED_PATHS} more` : shown;
}
