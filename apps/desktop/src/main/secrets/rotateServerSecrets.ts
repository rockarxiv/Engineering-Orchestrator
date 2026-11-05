import { closeSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { lockDataDirectory } from "../server/dataDirectoryLock.js";
import { createServerSecretStore, hasServerSecretMagic, SERVER_SECRET_PROBE_BYTES } from "./serverStore.js";

/**
 * Re-encrypting every value on a server's volume under a new key
 * (EO-320).
 *
 * The admin's half of the bargain `serverKey.ts` makes. EO will not
 * generate a key, so the key is the operator's to hold — and a secret
 * an operator holds is one they will one day need to replace, because
 * somebody left, or it was pasted into a chat, or their policy says so
 * every ninety days. Without this, replacing it means every stored value
 * becoming unreadable at once, which is not rotation, it is a deletion
 * with extra steps.
 *
 * ### How it finds the values
 *
 * By walking the data directory and reading six bytes of every file,
 * not from a list. Five different modules decide their own layout under
 * `userData` today — `credentials/`, `mcp/<serverId>/`, module secrets
 * per step, the host's `token.bin` — and each is free to invent another
 * tomorrow. A list of paths here would be a list that silently falls
 * behind, and a value it missed would be a value the old key still
 * opens after an operator has been told it does not. The magic in every
 * ciphertext (`serverStore.ts`) is what makes "every value" answerable
 * from the volume itself.
 *
 * ### Why nothing may be skipped, and nothing may be running
 *
 * "Every value" is a promise, so everything that could hide one is a
 * failure rather than a shrug. A directory EO cannot list may hold a
 * secret — mode `0o111` is traversable and unlistable, and its contents
 * are perfectly readable to anything that knows their names — and a
 * file it cannot open may be one. Both refuse the whole rotation and
 * name the path, because the alternative is reporting success over a
 * volume the old key still opens in a corner nobody looked in.
 *
 * For the same reason rotation is offline, and enforced to be:
 * `lockDataDirectory` is held for the whole run, so a server cannot
 * write a secret with the old key in the window between the scan and
 * the rename. See that module for why the lock is the mechanism rather
 * than a line in a runbook.
 *
 * ### What counts as proof that a value is already rotated
 *
 * Decrypting it under the new key, and nothing weaker. The header
 * carries four bytes identifying the key a value was written under,
 * which is enough to make an error message specific and to keep the
 * scan cheap — but two distinct keys can share those four bytes. A
 * rotation that read the label and believed it would, for such a pair,
 * file every old-key value under "already done" and report success over
 * a volume the old key still opens whole. So the label is never a
 * decision: GCM's tag is.
 *
 * ### All or nothing
 *
 * Everything is decrypted and re-encrypted in memory first, written to
 * siblings second, and renamed into place last. A crash halfway through
 * a plain rewrite would leave a volume where some values open with the
 * old key and some with the new, which is a state no key can read
 * whole — and the operator would have no way to know which half. If
 * anything at all cannot be read, nothing is written and the paths are
 * named.
 *
 * A file already under the new key is counted and skipped rather than
 * refused, so a rotation that died between renames can simply be run
 * again.
 */

/** The suffix a rewritten value wears between being written and being renamed. */
const PENDING_SUFFIX = ".rotating";

export interface RotationRequest {
  /** The server's data directory — `EO_SERVER_DATA`, the one holding `eo.db`. */
  directory: string;
  /** The key every value is encrypted under now. */
  from: Buffer;
  /** The key they should be encrypted under after this. */
  to: Buffer;
}

export type RotationResult =
  | {
      ok: true;
      /** Paths, relative to the data directory, that were re-encrypted. */
      rotated: string[];
      /** Paths that were already under the new key — a re-run of an interrupted rotation. */
      alreadyRotated: string[];
    }
  | { ok: false; problem: string; unreadable: string[] };

export function rotateServerSecrets(request: RotationRequest): RotationResult {
  const { directory, from, to } = request;

  if (from.equals(to)) {
    // Not a no-op worth performing quietly: an operator who asks for
    // this has just decided the old key is compromised, and a cheerful
    // "0 rotated" would read as success.
    return { ok: false, problem: "The new key is the same as the old one, so there is nothing to rotate onto.", unreadable: [] };
  }

  // Taken before anything is read and held until everything is renamed.
  // A server that starts halfway through would be reading values this
  // run is replacing; a server already serving holds the old key in
  // memory and writes with it, which is the race that made the promise
  // below untrue.
  const lock = lockDataDirectory(directory, "a secret rotation");
  if (!lock.ok) return { ok: false, problem: lock.problem, unreadable: [] };

  try {
    return rotateUnderLock(directory, from, to);
  } finally {
    lock.lock.release();
  }
}

function rotateUnderLock(directory: string, from: Buffer, to: Buffer): RotationResult {
  const scan = secretFiles(directory);
  if (scan.unreadable.length > 0) {
    // Before a single byte is written. Rotation's whole claim is about
    // *every* value, and a path EO could not look inside is a path that
    // may hold one — so this is a failure with a name on it rather than
    // a success with a hole in it.
    return {
      ok: false,
      problem:
        `EO could not read everything under ${directory}, so nothing was rotated. ` +
        `Rotation promises the old key opens nothing afterwards, and it cannot promise that about a path it was not allowed to look in. ` +
        `Fix the permissions and run it again.`,
      unreadable: scan.unreadable,
    };
  }

  const oldStore = createServerSecretStore(from);
  const newStore = createServerSecretStore(to);

  const rewritten: Array<{ path: string; contents: Buffer }> = [];
  const alreadyRotated: string[] = [];
  const unreadable: string[] = [];

  for (const path of scan.files) {
    let contents: Buffer;
    try {
      contents = readFileSync(path);
    } catch {
      // It had a header a moment ago. Something else is writing to this
      // volume, which is the one situation rotation must not push on
      // through.
      unreadable.push(relative(directory, path));
      continue;
    }

    // Which key a value is under is decided by decrypting it, and by
    // nothing else. The four-byte id in the header is a label — it
    // makes an error message specific and it lets `secretFiles` be
    // cheap — and two distinct keys can share one, at which point a
    // rotation that trusted it would file every old-key value under
    // "already done" and report success over a volume the old key still
    // opens. GCM's tag is the only thing here that constitutes proof.
    //
    // The new key is tried first, so a value that is already under it is
    // recognised however its label reads.
    let plainText: string;
    try {
      newStore.decryptString(contents);
      alreadyRotated.push(relative(directory, path));
      continue;
    } catch {
      // Not under the new key. Which is the ordinary case: almost
      // everything on the volume is under the old one.
    }

    try {
      plainText = oldStore.decryptString(contents);
    } catch {
      // Under a third key, or edited on disk. Both mean the same thing
      // to an operator — this volume is not the one the old key belongs
      // to — and neither is worth a stack trace.
      unreadable.push(relative(directory, path));
      continue;
    }
    rewritten.push({ path, contents: newStore.encryptString(plainText) });
  }

  if (unreadable.length > 0) {
    return {
      ok: false,
      problem: `${String(unreadable.length)} stored value(s) could not be read with the old key, so nothing was rotated.`,
      unreadable,
    };
  }

  return commit(directory, rewritten, alreadyRotated);
}

/**
 * Writes every rewritten value beside its original, then renames them
 * all.
 *
 * `renameSync` within a directory is atomic on every filesystem EO runs
 * on, so the window in which a value is half-written does not exist.
 * The window in which *some* values are renamed and some are not still
 * does — nothing short of a transactional filesystem removes it — and
 * that is the window `alreadyRotated` above exists to make survivable.
 */
function commit(directory: string, rewritten: Array<{ path: string; contents: Buffer }>, alreadyRotated: string[]): RotationResult {
  const pending: string[] = [];
  try {
    for (const { path, contents } of rewritten) {
      const temporary = `${path}${PENDING_SUFFIX}`;
      writeFileSync(temporary, contents, { mode: 0o600 });
      pending.push(temporary);
    }
  } catch (error) {
    for (const temporary of pending) rmSync(temporary, { force: true });
    return {
      ok: false,
      problem: `EO could not write the re-encrypted values, so nothing was rotated: ${error instanceof Error ? error.message : String(error)}`,
      unreadable: [],
    };
  }

  for (const [index, temporary] of pending.entries()) {
    const target = rewritten[index];
    if (target !== undefined) renameSync(temporary, target.path);
  }

  return { ok: true, rotated: rewritten.map(({ path }) => relative(directory, path)), alreadyRotated };
}

interface Scan {
  /** Every file under the directory whose first bytes are EO's. */
  files: string[];
  /**
   * Every path the walk was not allowed to look inside.
   *
   * Relative to the data directory, and fatal — see `rotateUnderLock`.
   * A directory that cannot be listed is the dangerous one: `0o111` is
   * traversable without being listable, so its secrets are still there,
   * still readable by anything holding their names, and invisible to a
   * walk that shrugged.
   */
  unreadable: string[];
}

/**
 * The files worth opening, and the paths that refused to be looked at.
 *
 * Six bytes read rather than the file, because a data directory also
 * holds the database, its write-ahead log and whatever a pack has put
 * beside them, and reading all of that to find a handful of tokens
 * would make the cost of this command the size of the volume.
 *
 * A leftover `.rotating` file from a crashed run is skipped: it is a
 * copy of a value whose original is still there, and re-encrypting it
 * would only make a second one. Anything that is not a plain file —
 * a socket, a fifo, a symlink — is skipped as well: a symlink's target
 * is rotated if it is on this volume, and is not this volume's business
 * if it is not. (A symlinked directory is therefore not descended into,
 * which is also what keeps this walk out of a loop.)
 *
 * **No directory is excluded by name.** `node_modules` was, as an
 * obvious place for no secrets and a great many files — but
 * `<userData>/runtimes` is an installed package tree
 * (`runtimes/install.ts`), so that exclusion was a region of the data
 * directory this command silently did not look at while reporting that
 * it had rotated everything. Probing six bytes of every file under a
 * package tree costs seconds on a command an admin runs twice a year,
 * and the alternative costs a promise.
 */
function secretFiles(directory: string): Scan {
  const found: string[] = [];
  const unreadable: string[] = [];
  const probe = Buffer.alloc(SERVER_SECRET_PROBE_BYTES);
  /** The root itself, named as itself rather than as the empty string `relative` makes of it. */
  const name = (path: string): string => relative(directory, path) || ".";

  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      unreadable.push(name(current));
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith(PENDING_SUFFIX)) continue;
      const looked = startsWithMagic(path, probe);
      if (looked === "unreadable") unreadable.push(name(path));
      else if (looked) found.push(path);
    }
  };

  walk(directory);
  return { files: found.sort(), unreadable: unreadable.sort() };
}

/**
 * Whether the file starts with EO's magic — or `"unreadable"` when EO
 * was not allowed to find out.
 *
 * The third answer is the point. A file that cannot be opened might be
 * a secret, and "might be" is not something a promise about every value
 * survives.
 */
function startsWithMagic(path: string, probe: Buffer): boolean | "unreadable" {
  let handle: number;
  try {
    handle = openSync(path, "r");
  } catch {
    return "unreadable";
  }
  try {
    const read = readSync(handle, probe, 0, probe.length, 0);
    // A file shorter than the magic cannot be one of ours, and that is
    // an answer rather than a failure: it was read, and it said no.
    return read === probe.length && hasServerSecretMagic(probe);
  } catch {
    return "unreadable";
  } finally {
    closeSync(handle);
  }
}
