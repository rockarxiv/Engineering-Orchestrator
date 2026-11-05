import { spawn, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockDataDirectory, type LockResult } from "./dataDirectoryLock.js";

/**
 * One process at a time on a data directory (EO-320).
 *
 * The lock exists for rotation's sake — see `secrets/rotateServerSecrets.ts`
 * — so what has to be true is narrow and absolute: **two processes must
 * never both believe they hold it.** Everything else here is in service
 * of that, including the cases where EO refuses something it could have
 * allowed.
 *
 * The contention tests at the bottom are real processes rather than an
 * imagined interleaving, because the two defects this file exists to
 * prevent were both invisible to single-process tests: a lock file that
 * was created before it was written, and a stale lock two contenders
 * each felt entitled to delete. A test that calls the function twice in
 * a row cannot see either.
 */
let directory = "";
const held: Array<{ release: () => void }> = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eo-lock-"));
});
afterEach(() => {
  for (const lock of held.splice(0)) lock.release();
  rmSync(directory, { recursive: true, force: true });
});

/** Takes it, and registers the release so a failing assertion cannot wedge the next test. */
function take(holder: string): ReturnType<typeof lockDataDirectory> {
  const result = lockDataDirectory(directory, holder);
  if (result.ok) held.push(result.lock);
  return result;
}

/** A pid that certainly belongs to nobody: a process that has run and been reaped. */
function deadPid(): number {
  const finished = spawnSync(process.execPath, ["-e", ""]);
  if (finished.pid === undefined) throw new Error("could not spawn a process to get a dead pid from");
  return finished.pid;
}

const lockFile = (): string => join(directory, "eo.lock");

/** What is written inside it, as much of it as these tests read. */
const lockContents = (): { id?: string; pid?: number } => JSON.parse(readFileSync(lockFile(), "utf8")) as { id?: string; pid?: number };

/** A complete lock file, as `link()` publication guarantees one always is. */
function writeLock(values: { id?: string; pid: number; holder?: string }): void {
  writeFileSync(
    lockFile(),
    JSON.stringify({ id: values.id ?? "an-earlier-run", pid: values.pid, holder: values.holder ?? "a server", since: "2026-01-01T00:00:00.000Z" }),
  );
}

describe("holding a server's data directory", () => {
  it("is taken by the first and refused to the second, which is told what has it", () => {
    expect(take("a server").ok).toBe(true);

    const second = take("a secret rotation");

    expect(second.ok).toBe(false);
    // The refusal has to be actionable: what is holding it, which
    // process, and the two ways out.
    expect(second.ok === false && second.problem).toContain("A server");
    expect(second.ok === false && second.problem).toContain(String(process.pid));
    expect(second.ok === false && second.problem).toContain(directory);
    expect(second.ok === false && second.problem).toContain("Stop it first");
  });

  it("lets the next one in once it is released", () => {
    const first = lockDataDirectory(directory, "a server");
    expect(first.ok).toBe(true);
    if (first.ok) first.lock.release();

    expect(take("a secret rotation").ok).toBe(true);
    expect(existsSync(lockFile())).toBe(true);
  });

  it("takes over a lock whose holder is gone, rather than wedging the directory for ever", () => {
    // What a `kill -9` leaves behind. A lock nobody can take is a server
    // that never starts again, which is a worse failure than the one
    // this guards against.
    writeLock({ pid: deadPid() });

    expect(take("a server").ok).toBe(true);
    expect(lockContents().pid).toBe(process.pid);
  });

  it("takes over a lock left by a previous container that ran as this pid", () => {
    // The case that would otherwise wedge a container for good: a
    // restarted container runs its server as pid 1 again, so the lock
    // the killed one left names a pid that is alive — itself. A pid that
    // is this process, holding an id this process never issued, is a
    // holder whose pid we inherited.
    writeLock({ pid: process.pid, id: "from-the-container-that-was-killed" });

    expect(take("a server").ok).toBe(true);
    expect(lockContents().id).not.toBe("from-the-container-that-was-killed");
  });

  it("refuses a lock file it cannot read, rather than deciding the directory is free", () => {
    // Publication is atomic — the name appears only once the bytes are
    // complete — so EO cannot produce a half-written lock file. Anything
    // unparseable was therefore written by something else, and the
    // previous version's rule ("cannot read it, so nobody holds it") is
    // exactly how two processes came to hold the same directory.
    writeFileSync(lockFile(), "");

    const result = take("a server");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toContain("EO did not write");
  });

  it("refuses when a takeover was killed halfway, and names both files", () => {
    // The one state this cannot resolve on its own: somebody claimed the
    // right to remove an abandoned lock and died before removing it. The
    // alternative to refusing is a rule that reopens the race, so it
    // fails closed and says what to delete.
    writeLock({ pid: deadPid(), id: "abandoned" });
    // The claim, which is a second name for the abandoned lock.
    linkSync(lockFile(), `${lockFile()}.abandoned.dead`);

    const result = take("a server");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toContain("abandoned.dead");
    expect(result.ok === false && result.problem).toContain("If nothing is running");
  });

  it("does not release a lock that is no longer ours", () => {
    const ours = lockDataDirectory(directory, "a server");
    // Somebody took over after deciding we were gone. Releasing now
    // would hand the directory to a third while they are still using it.
    writeLock({ pid: process.pid, id: "somebody-else", holder: "a secret rotation" });

    if (ours.ok) ours.lock.release();

    expect(lockContents().id).toBe("somebody-else");
  });

  it("survives its directory being removed underneath it", () => {
    const lock = lockDataDirectory(directory, "a server");
    rmSync(directory, { recursive: true, force: true });

    // A test's teardown, or a volume unmounted. A release that threw
    // would turn that into a failed shutdown.
    expect(() => {
      if (lock.ok) lock.lock.release();
    }).not.toThrow();
  });

  it("says there is nothing to lock when the directory does not exist", () => {
    const result = lockDataDirectory(join(directory, "no-such-place"), "a secret rotation");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toContain("no data directory");
  });

  it("can be released twice", () => {
    const lock = lockDataDirectory(directory, "a server");
    if (lock.ok) lock.lock.release();

    expect(() => {
      if (lock.ok) lock.lock.release();
    }).not.toThrow();
  });

  it("leaves no working files behind", () => {
    writeLock({ pid: deadPid(), id: "abandoned" });

    const lock = take("a server");

    // The temporary the contents were written to before they were
    // linked into place, and the claim on the abandoned lock. Both are
    // this module's business and neither should outlive it.
    expect(existsSync(`${lockFile()}.abandoned.dead`)).toBe(false);
    expect(readFileSync(lockFile(), "utf8")).toContain(String(process.pid));
    if (lock.ok) lock.lock.release();
    expect(existsSync(lockFile())).toBe(false);
  });
});

/**
 * The two instants at which two acquisitions can collide (EO-320,
 * review).
 *
 * Driven rather than hoped for. Both of these windows are a few
 * syscalls wide, and the multi-process tests below catch a failure in
 * them only when the scheduler obliges — which it did not, the first
 * time these were written. Here the second acquisition runs *inside*
 * the first, at the exact instant that matters, synchronously, every
 * run.
 *
 * The assertion is the same in both and is the only thing this module
 * promises: however the two interleave, exactly one of them ends up
 * holding the directory.
 */
describe("two acquisitions colliding at the instant that matters", () => {
  /**
   * The second acquisition's answer.
   *
   * On an object rather than in a `let`, because TypeScript does not
   * follow an assignment made inside a callback and would narrow the
   * variable to `null` for the rest of the test.
   */
  interface Competitor {
    result: LockResult | null;
  }

  /** Runs a whole competing acquisition, once, at whichever instant it is hooked to. */
  function competitorAt(): Competitor {
    return { result: null };
  }

  /** Whichever of the pair succeeded, and nothing else, has to be the one named in the file. */
  function exactlyOneHolds(first: LockResult, second: Competitor): void {
    expect(second.result).not.toBeNull();
    const winners = [first, second.result].filter((result) => result?.ok === true);
    expect(winners).toHaveLength(1);
    expect(existsSync(lockFile())).toBe(true);
  }

  it("cannot let a second in while the first is preparing its lock file", () => {
    const other = competitorAt();

    // The window the previous implementation left open the other way
    // round: it created the lock file and then wrote it, so a contender
    // arriving here saw an empty file and called the directory free.
    // Publication is now a write followed by `link()`, so a contender
    // arriving here finds nothing at all, takes the lock properly, and
    // the `link()` below fails.
    const mine = lockDataDirectory(directory, "a server", {
      whilePublishing: () => (other.result ??= lockDataDirectory(directory, "a secret rotation")),
    });

    exactlyOneHolds(mine, other);
    // The one that lost is the one that was still preparing, and it is
    // told who has it rather than being handed a lock it does not hold.
    expect(mine.ok).toBe(false);
    expect(mine.ok === false && mine.problem).toContain("A secret rotation");
    if (other.result?.ok === true) other.result.lock.release();
  });

  it("cannot let two of them clear the same abandoned lock", () => {
    writeLock({ pid: deadPid(), id: "abandoned" });
    const other = competitorAt();

    // Both have now diagnosed the same dead holder and both want to
    // remove its file. The previous implementation let each of them do
    // it: this one would have deleted the lock the other had just
    // published and taken the directory a second time.
    const mine = lockDataDirectory(directory, "a server", {
      beforeClearing: () => (other.result ??= lockDataDirectory(directory, "a secret rotation")),
    });

    exactlyOneHolds(mine, other);
    expect(mine.ok).toBe(false);
    expect(mine.ok === false && mine.problem).toContain("A secret rotation");
    if (other.result?.ok === true) other.result.lock.release();
  });

  it("leaves the winner's lock untouched when the loser gives up", () => {
    writeLock({ pid: deadPid(), id: "abandoned" });
    const other = competitorAt();

    lockDataDirectory(directory, "a server", {
      beforeClearing: () => (other.result ??= lockDataDirectory(directory, "a secret rotation")),
    });

    // The loser reaches for the abandoned lock's name and finds the
    // winner's there instead. It has to put that down and walk away —
    // both the lock and the winner's ability to release it survive.
    expect(lockContents().id).toBeDefined();
    if (other.result?.ok === true) {
      other.result.lock.release();
      expect(existsSync(lockFile())).toBe(false);
    }
  });
});

/**
 * Real processes, contending at the same instant on the same directory
 * (EO-320, review).
 *
 * Both defects these cover were races between two acquisitions, and
 * neither is reachable from one process: the first needed a contender
 * to look at a lock file in the instant after it was created and before
 * it was written, and the second needed two contenders to each decide
 * they were entitled to delete the same abandoned lock. So this spawns
 * children that all start acquiring at a wall-clock instant agreed in
 * advance, and asserts the only thing that matters — **exactly one of
 * them holds it.**
 *
 * Against the previous implementation both of these produce several
 * winners. They are not a proof of correctness, which no test of a race
 * can be; they are the difference between a claim that was argued and
 * one that was tried.
 */
describe("several processes arriving at once", () => {
  const CHILDREN = 8;
  const here = dirname(fileURLToPath(import.meta.url));

  /**
   * The child: it waits for the agreed instant, tries once, and says
   * what happened.
   *
   * A winner then stays alive until the parent closes its input, rather
   * than for a chosen number of milliseconds. The difference matters on
   * a loaded machine: a winner that exited while a slow sibling was
   * still starting would leave a lock whose holder is dead, the sibling
   * would take it over — correctly — and the test would report two
   * winners for a reason that is not a bug. The timer is only a
   * backstop against a child nothing ever reads.
   */
  const CHILD = `
import { lockDataDirectory } from ${JSON.stringify(pathToFileURL(join(here, "dataDirectoryLock.ts")).href)};
const [directory, holder, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) { /* spin, so every child arrives together */ }
const result = lockDataDirectory(directory, holder);
process.stdout.write(result.ok ? "ok" : "refused");
if (result.ok) {
  setTimeout(() => process.exit(0), 20_000).unref();
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
}
`;

  let childScript = "";
  let scriptDirectory = "";

  beforeEach(() => {
    scriptDirectory = mkdtempSync(join(tmpdir(), "eo-lock-child-"));
    childScript = join(scriptDirectory, "contend.ts");
    writeFileSync(childScript, CHILD);
  });
  afterEach(() => {
    rmSync(scriptDirectory, { recursive: true, force: true });
  });

  /** Spawns them all, hears from every one of them, and only then lets the winner go. */
  async function contend(): Promise<string[]> {
    // Far enough ahead that every child is spinning on `Date.now()`
    // before any of them tries, which is what makes this a race rather
    // than a sequence.
    const startAt = Date.now() + 700;
    const children = Array.from({ length: CHILDREN }, (_, index) =>
      // The flag is explicit rather than assumed: Node strips types
      // without it from 22.18, and this repository's `engines` allows
      // 22.15.
      spawn(process.execPath, ["--experimental-strip-types", childScript, directory, `child ${String(index)}`, String(startAt)], {
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );

    // Registered now, at spawn time, and not in the `finally` below: a
    // child that has already exited never emits `close` again, and a
    // listener attached after the fact would wait for ever.
    const complaints = children.map(() => "");
    const closed = children.map((child) => new Promise((resolve) => child.on("close", resolve)));
    const said = children.map(
      (child, index) =>
        new Promise<string>((resolve, reject) => {
          child.stderr.on("data", (chunk: Buffer) => (complaints[index] += chunk.toString()));
          child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString()));
          child.on("error", reject);
          // A child that dies without saying anything is a broken test,
          // not a refusal, and has to look like one.
          child.on("close", () => reject(new Error(`child ${String(index)} said nothing: ${complaints[index]}`)));
        }),
    );

    try {
      return await Promise.all(said);
    } finally {
      for (const child of children) child.stdin.end();
      await Promise.all(closed);
    }
  }

  it("lets exactly one of them take an unheld directory", async () => {
    const said = await contend();

    // The publication race. The previous implementation created the lock
    // file and then wrote it, so a contender that looked in between saw
    // an empty file, called it nobody's, deleted it and took a lock the
    // first one also held.
    expect(said.filter((answer) => answer === "ok")).toHaveLength(1);
    expect(said).toHaveLength(CHILDREN);
  }, 30_000);

  it("lets exactly one of them take over an abandoned one", async () => {
    // Every child will find the same dead holder and want to clear it.
    // Only one may.
    writeLock({ pid: deadPid(), id: "abandoned-by-a-killed-container" });

    const said = await contend();

    expect(said.filter((answer) => answer === "ok")).toHaveLength(1);
  }, 30_000);

  it("refuses all of them while a live holder has it", async () => {
    const mine = take("a server");
    expect(mine.ok).toBe(true);

    const said = await contend();

    // The uninteresting direction, asserted because it is the one that
    // would break if "is that pid alive" ever stopped working.
    expect(said.filter((answer) => answer === "ok")).toHaveLength(0);
  }, 30_000);
});
