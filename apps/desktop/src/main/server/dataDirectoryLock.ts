import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One process at a time on a server's data directory (EO-320).
 *
 * Rotation promises something about *every* value on a volume: after it
 * succeeds, the old key opens nothing. Without this that promise was
 * only true of the values that existed when the scan ran. A server
 * holding the old key in memory writes secrets whenever somebody saves
 * one — an API key, an MCP server's token — and one written after the
 * scan and before the rename is a value the old key still reads, on a
 * volume EO has just told an admin is rotated. The window is small and
 * the failure is silent, which is the worst pair.
 *
 * So rotation is offline, and this is what makes it so rather than a
 * sentence in a runbook: a server takes this lock while it serves, a
 * rotation takes it for its whole run, and whichever arrives second is
 * refused with what is holding it. It guards the database and
 * everything beside it, not only the secrets, because "this data
 * directory is in use" is the fact being stated.
 *
 * ### The two things a lock file has to get right
 *
 * Node has no `flock`, and EO adds no dependency for one
 * (ARCHITECTURE.md, "The stack"), so this is built from the one atomic primitive the
 * filesystem offers: **create-this-name-or-fail**. Everything below is
 * about using only that, because a lock assembled out of
 * check-then-act is not a lock.
 *
 * **Publication is atomic.** The contents are written to a private
 * temporary file and the lock file is then *linked* into place with
 * `link()`, which either creates the name or fails with `EEXIST`. So
 * `eo.lock` never exists in a half-written state: the name appears only
 * once the bytes behind it are already complete. The earlier version
 * created the file and then wrote it, which left a window where a
 * second process saw an empty file, concluded nobody held it, deleted
 * it and took a lock the first process also believed it held. That
 * window is why an unreadable lock file is now *refused* rather than
 * treated as free — EO cannot produce one, so anything that cannot be
 * parsed was written by something else, and failing closed is the only
 * safe direction.
 *
 * **Taking over a dead holder is serialised.** A lock whose holder is
 * gone has to be removable, or a `SIGKILL` leaves a directory nothing
 * can ever open again. But "remove it and create mine" is two steps,
 * and two processes that both find the same dead lock would each delete
 * the other's new one. So the right to remove a particular dead lock is
 * itself claimed with `link()`: the dead file is linked to a second
 * name derived from *its own* id, exactly one contender can win that,
 * and only the winner unlinks it. Everyone else is refused — which is
 * the correct answer anyway, since only one of them may end up running.
 *
 * ### Where it fails closed
 *
 * A process killed in the few microseconds between claiming the right
 * to remove a dead lock and removing it leaves both files behind. The
 * next contender is refused and told to remove them, rather than being
 * given a rule that would reopen the race it was refused by. It never
 * fails open.
 *
 * ### What it is not
 *
 * Not a network lock and not a claim about two machines. An NFS volume
 * mounted into two containers is outside what a pid means, and nothing
 * here pretends otherwise — the case it closes is the one that actually
 * happens, which is an admin running the rotation command against the
 * directory their server is still serving.
 */

/** Beside `eo.db`, and named for the directory rather than for the secrets: it guards both. */
const LOCK_FILE = "eo.lock";

/** What is written inside, for whoever finds one and wonders. */
interface LockContents {
  /** This acquisition, distinct from every other — see `release` and `graveyardFor`. */
  id: string;
  pid: number;
  /** "a server", "a secret rotation" — what to call the holder in a refusal. */
  holder: string;
  since: string;
}

export interface DataDirectoryLock {
  /**
   * Gives it up.
   *
   * Only if it is still ours: a lock taken over by somebody else after
   * this process stopped being able to hold it is theirs, and removing
   * it would hand the directory to a third. Safe to call twice, and safe
   * after the directory has been removed.
   */
  release(): void;
}

export type LockResult = { ok: true; lock: DataDirectoryLock } | { ok: false; problem: string };

/**
 * Two points at which a test may run a second acquisition, to prove
 * that two of them cannot both succeed.
 *
 * Seams in the production code, which wants a justification. This
 * module's whole claim is about what happens when two acquisitions
 * interleave at one of exactly two instants — while a lock is being
 * prepared but has no name yet, and after a dead holder has been
 * diagnosed but before its file has been cleared. Both windows are a
 * few syscalls wide. Spawning processes and hoping they collide there
 * catches the bug *sometimes*, which is how the first version of this
 * module passed its own tests; these two hooks let a test put the
 * second acquisition exactly where it has to be, every run, in one
 * synchronous process.
 *
 * Never passed in production: `startServer` and `rotateServerSecrets`
 * call this with two arguments. The multi-process tests stay beside the
 * ones that use these, because a seam proves the algorithm and real
 * processes prove the syscalls.
 */
export interface LockInterleaving {
  /** After this acquisition's contents exist and before the lock file has its name. */
  whilePublishing?: (() => void) | undefined;
  /** After a holder is found to be gone and before the right to clear it is claimed. */
  beforeClearing?: (() => void) | undefined;
}

/**
 * The acquisitions this process is holding right now.
 *
 * Read by `alive`, and the reason is containers. A restarted container
 * runs its server as pid 1 again, so a lock left behind by the killed
 * one names a pid that is alive — it is *us*. Without this, a server
 * that was `SIGKILL`ed would never start again, which is precisely the
 * failure the takeover path exists to prevent. A pid that is this
 * process, holding an id this process did not write, is a dead holder
 * whose pid we inherited.
 */
const ours = new Set<string>();

/**
 * How many times an acquisition re-reads a directory that is changing
 * underneath it.
 *
 * Every retry here is a state that lasts a handful of syscalls: a
 * contender that removed an abandoned lock and has not published its
 * own yet, or one that is between the two. Waiting the moment out and
 * looking again turns "something odd happened" into the accurate
 * answer — "a server is already using this" — which is the sentence an
 * operator can act on. Four attempts because the window is measured in
 * microseconds and this is not a queue: a directory genuinely in use is
 * refused, not waited for.
 */
const ATTEMPTS = 4;
const PAUSE_MS = 5;

/**
 * Takes the directory, or says what already has it.
 *
 * @param directory the data directory — `EO_SERVER_DATA`, the one holding `eo.db`
 * @param holder what to call this process in the refusal the next one reads
 */
export function lockDataDirectory(directory: string, holder: string, interleaving: LockInterleaving = {}): LockResult {
  const path = join(directory, LOCK_FILE);

  let last: LockResult = { ok: false, problem: `EO could not take the lock at ${path}.` };
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) pause(PAUSE_MS);
    // A fresh id per attempt, so a temporary file left behind by an
    // attempt that lost cannot collide with the one that wins.
    const mine: LockContents = { id: randomUUID(), pid: process.pid, holder, since: new Date().toISOString() };
    const outcome = attemptLock(path, directory, mine, interleaving);
    if (outcome.settled) return outcome.result;
    last = outcome.result;
  }
  return last;
}

/**
 * One go at it.
 *
 * `settled: false` means the directory changed under us — somebody
 * else's takeover was in flight — and the answer is worth asking again
 * rather than reporting. Everything else is final.
 */
function attemptLock(path: string, directory: string, mine: LockContents, interleaving: LockInterleaving): { settled: boolean; result: LockResult } {
  const settled = (result: LockResult): { settled: boolean; result: LockResult } => ({ settled: true, result });
  const again = (problem: string): { settled: boolean; result: LockResult } => ({ settled: false, result: { ok: false, problem } });

  const first = publish(path, mine, interleaving.whilePublishing);
  if (first !== "held") return settled(finish(path, mine, first));

  // Somebody has it. Who, and are they still there?
  const current = read(path);
  if (current === "missing") {
    // Removed between the failed `link` and this read, which only a
    // takeover in flight does. Ask again in a moment.
    return again(`The lock at ${path} was removed while EO was reading it.`);
  }
  if (current === "unreadable") {
    return settled({
      ok: false,
      problem:
        `There is a file at ${path} that EO did not write, or cannot read. EO will not assume a data directory is free on the strength of a file it does not understand. ` +
        `If you are certain no server and no rotation is running, remove it.`,
    });
  }
  if (alive(current)) {
    return settled({
      ok: false,
      problem:
        `${capitalise(current.holder)} (process ${String(current.pid)}) is already using ${directory}, so EO will not start ${mine.holder} on it as well. ` +
        `Stop it first. If you are certain nothing is running, remove ${path}.`,
    });
  }

  // The holder is gone. Exactly one contender may remove this lock, and
  // this is where that is decided.
  interleaving.beforeClearing?.();
  const graveyard = graveyardFor(path, current.id);
  const claim = claimTheRightToRemove(path, graveyard, current.id);
  if (claim === "contended") {
    // Somebody else is clearing the same abandoned lock right now, or
    // was killed while doing so. Told apart by looking again: the first
    // resolves itself within microseconds and the second does not.
    return again(
      `Another process is already clearing the abandoned lock at ${path}, or was killed while doing so. ` +
        `If nothing is running, remove ${path} and ${graveyard}.`,
    );
  }
  if (claim !== "claimed") return again(claim);

  unlinkQuietly(path);
  const second = publish(path, mine, undefined);
  unlinkQuietly(graveyard);
  if (second === "held") {
    // Only reachable if a human removed the abandoned lock by hand in
    // the same instant. Their lock stands; ours does not.
    return again(`${capitalise(mine.holder)} lost a race for ${directory} to another process.`);
  }
  return settled(finish(path, mine, second));
}

/** A synchronous wait, which is what a synchronous acquisition needs between looks. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The result for anything `publish` answered that was not "somebody has it". */
function finish(path: string, mine: LockContents, outcome: Exclude<PublishOutcome, "held">): LockResult {
  if (outcome === "taken") {
    ours.add(mine.id);
    return { ok: true, lock: { release: () => release(path, mine.id) } };
  }
  if (outcome === "missing") return { ok: false, problem: `EO found no data directory at ${dirOf(path)}, so there is nothing to lock.` };
  return { ok: false, problem: `EO could not take the lock at ${path}: ${outcome}` };
}

type PublishOutcome = "taken" | "held" | "missing" | string;

/**
 * Writes the whole lock somewhere private, then gives it its real name
 * in one atomic step.
 *
 * `link()` is the primitive the whole module rests on: it creates the
 * name or fails with `EEXIST`, and it can only name an inode that
 * already holds every byte. A reader therefore never sees a lock that
 * is still being written, which is what lets `read` returning nothing
 * mean "not ours" instead of "not finished yet".
 */
function publish(path: string, contents: LockContents, whilePublishing?: (() => void) | undefined): PublishOutcome {
  const temporary = `${path}.${contents.id}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    return error instanceof Error ? error.message : String(error);
  }

  try {
    whilePublishing?.();
    linkSync(temporary, path);
    return "taken";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? "held" : ((error as Error).message ?? String(error));
  } finally {
    // The inode survives under its real name; this was only ever a way
    // to have the bytes before the name existed.
    unlinkQuietly(temporary);
  }
}

/**
 * Claims the sole right to remove one particular dead lock.
 *
 * The claim is a hard link from the dead lock to a name derived from
 * the id *inside* it, so two contenders looking at the same dead lock
 * compete for the same name and `link()` picks one. The link is also
 * the proof: it can only have attached to whatever `path` was at that
 * instant, so reading it back and finding the id we expected is how we
 * know we did not just claim somebody's newly published lock.
 */
function claimTheRightToRemove(path: string, graveyard: string, deadId: string): "claimed" | "contended" | string {
  try {
    linkSync(path, graveyard);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "Another process removed the lock while EO was reading it. Try again.";
    if (code === "EEXIST") return "contended";
    return error instanceof Error ? error.message : String(error);
  }

  const claimed = read(graveyard);
  if (claimed === "missing" || claimed === "unreadable" || claimed.id !== deadId) {
    // We linked something other than the dead lock: it was replaced
    // between the read and the claim. Drop our extra name — the owner's
    // own name for it is untouched — and let the caller be refused.
    unlinkQuietly(graveyard);
    return `Another process took ${path} while EO was clearing the abandoned lock on it. Try again.`;
  }
  return "claimed";
}

/** `eo.lock.<the dead lock's id>.dead` — one name per dead lock, which is what makes the claim exclusive. */
function graveyardFor(path: string, deadId: string): string {
  return `${path}.${deadId}.dead`;
}

/**
 * The lock's contents, or which kind of nothing is there.
 *
 * "Missing" and "unreadable" are worth telling apart, and only became
 * worth telling apart once publication was atomic: a file that is there
 * and cannot be parsed is now impossible for EO to have produced, so it
 * is somebody else's and the answer is to refuse. A file that is not
 * there at all is a takeover in flight, and the answer is to look
 * again.
 */
function read(path: string): LockContents | "missing" | "unreadable" {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }

  let parsed: Partial<LockContents>;
  try {
    parsed = JSON.parse(raw) as Partial<LockContents>;
  } catch {
    return "unreadable";
  }
  const { id, pid, holder, since } = parsed;
  if (typeof id !== "string" || id.length === 0) return "unreadable";
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "unreadable";
  return { id, pid, holder: typeof holder === "string" && holder.length > 0 ? holder : "another process", since: since ?? "" };
}

/**
 * Whether that holder is still there.
 *
 * Signal 0 checks without sending anything. `EPERM` means it exists and
 * belongs to somebody else — a server started by another user, which is
 * exactly a holder — so only `ESRCH` is gone.
 *
 * The first clause is the container case. See `ours`.
 */
function alive(contents: LockContents): boolean {
  if (contents.pid === process.pid) return ours.has(contents.id);
  try {
    process.kill(contents.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes the lock file only when it still says what we wrote.
 *
 * The id rather than the pid, because a pid is not unique enough for
 * the case this is protecting against: a test process takes, loses and
 * retakes the lock within one pid, and a release holding the earlier
 * acquisition would otherwise drop the later one's.
 */
function release(path: string, id: string): void {
  ours.delete(id);
  const current = read(path);
  if (current === "missing" || current === "unreadable" || current.id !== id) {
    // Gone, taken over, or unreadable. Either way there is nothing of
    // ours to remove — a data directory deleted by a test's teardown is
    // the ordinary case — and a release that threw would fail a
    // shutdown over it.
    return;
  }
  unlinkQuietly(path);
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or the directory with it.
  }
}

function dirOf(path: string): string {
  return path.slice(0, Math.max(0, path.length - LOCK_FILE.length - 1));
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}
