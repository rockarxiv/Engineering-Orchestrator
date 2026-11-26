import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushBranch, pushDestination } from "./git.js";
import { initRepo, run } from "../../../testing/git.js";

// Lets a test act between two of pushBranch's git commands: `before` is
// awaited ahead of every git invocation git.ts makes through its
// promisified execFile. Everything else passes straight through to the
// real git — the push goes to a real bare remote, with no hooks.
// `args`, where set, rewrites a command's arguments before it runs.
const between = vi.hoisted(() => ({
  before: null as ((args: readonly string[]) => Promise<void>) | null,
  args: null as ((args: readonly string[]) => readonly string[]) | null,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const real = promisify(actual.execFile);
  const execFile = Object.assign((...args: Parameters<typeof actual.execFile>) => actual.execFile(...args), {
    [promisify.custom]: async (file: string, args: readonly string[], options: object) => {
      const before = between.before;
      if (before) await before(args);
      return real(file, between.args ? between.args(args) : args, options);
    },
  });
  return { ...actual, execFile };
});

let scratch: string;
let repoPath: string;
let barePath: string;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo push race "));
  repoPath = join(scratch, "repo");
  barePath = join(scratch, "bare.git");
  await initRepo(repoPath);
  await run(["init", "--bare", barePath], scratch);
  await run(["remote", "add", "bare", barePath], repoPath);
  await run(["checkout", "-b", "eo/EO-1"], repoPath);
  for (const file of ["one.ts", "two.ts"]) {
    writeFileSync(join(repoPath, file), `export const x = "${file}";\n`);
    await run(["add", file], repoPath);
    await run(["commit", "-m", `add ${file}`], repoPath);
  }
});

afterEach(() => {
  between.before = null;
  between.args = null;
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
});

describe("pushBranch, while the local branch moves", () => {
  it("records the commit git sent, which is the one it read, however the branch moves before git runs", async () => {
    const read = await run(["rev-parse", "refs/heads/eo/EO-1"], repoPath);
    const parent = await run(["rev-parse", "refs/heads/eo/EO-1~1"], repoPath);

    // After pushBranch has read the branch's tip, and before the push
    // runs, the branch moves back to its parent.
    between.before = async (args) => {
      if (!args.includes("get-url")) return;
      between.before = null;
      await run(["update-ref", "refs/heads/eo/EO-1", parent], repoPath);
    };

    const pushed = await pushBranch(repoPath, "bare", "eo/EO-1");

    expect(pushed).toMatchObject({ ok: true, updated: read });
    expect(await run(["rev-parse", "refs/heads/eo/EO-1"], barePath)).toBe(read);
  });
});

describe("pushBranch, while the push URL changes", () => {
  let other: string;
  let before: string;

  beforeEach(async () => {
    // EO's push, then the branch rewritten by its agent; `other` holds
    // the very commit EO pushed, so a lease naming it would succeed there.
    other = join(scratch, "other.git");
    await run(["init", "--bare", other], scratch);
    expect(await pushBranch(repoPath, "bare", "eo/EO-1")).toMatchObject({ ok: true, updated: expect.any(String) });
    before = await run(["rev-parse", "refs/heads/eo/EO-1"], barePath);
    await run(["push", other, "eo/EO-1"], repoPath);
    await run(["commit", "--amend", "-m", "rebased"], repoPath);
  });

  /** The push URL moves to `other` after EO read it, just before the push runs. */
  function moveThePushUrlBeforeThePush(): void {
    between.before = async (args) => {
      if (!args.includes("push")) return;
      between.before = null;
      await run(["remote", "set-url", "--push", "bare", other], repoPath);
    };
  }

  it("still pushes where EO read, and records it, where the URL changes between EO's read and git's", async () => {
    const destination = await pushDestination(repoPath, "bare");
    // A fast-forward from what `bare` holds, so the plain push goes.
    await run(["reset", "--hard", before], repoPath);
    await run(["commit", "--allow-empty", "-m", "more"], repoPath);
    const sent = await run(["rev-parse", "refs/heads/eo/EO-1"], repoPath);
    moveThePushUrlBeforeThePush();

    const pushed = await pushBranch(repoPath, "bare", "eo/EO-1");

    expect(pushed).toEqual({ ok: true, updated: sent, destination });
    expect(await run(["rev-parse", "refs/heads/eo/EO-1"], barePath)).toBe(sent);
    expect(await run(["rev-parse", "refs/heads/eo/EO-1"], other)).toBe(before);
  });

  it("sends a leased push only to the URL it checked, however the remote's URL changes before git runs", async () => {
    const destination = (await pushDestination(repoPath, "bare"))!;
    const rewritten = await run(["rev-parse", "refs/heads/eo/EO-1"], repoPath);
    moveThePushUrlBeforeThePush();

    const pushed = await pushBranch(repoPath, "bare", "eo/EO-1", { lease: { commit: before, destination: destination.fingerprint } });

    expect(pushed).toEqual({ ok: true, updated: rewritten, destination });
    expect(await run(["rev-parse", "refs/heads/eo/EO-1"], barePath)).toBe(rewritten);
    expect(await run(["rev-parse", "refs/heads/eo/EO-1"], other)).toBe(before);
  });

  /** Git before 2.46, which adds an empty push URL where newer git empties the list. */
  function gitThatCannotEmptyTheList(): void {
    between.args = (args) => args.map((arg) => (arg === "remote.bare.pushurl=" ? `remote.bare.pushurl=${other}` : arg));
  }

  it("records nothing for a push it cannot hold to the URL it read", async () => {
    await run(["reset", "--hard", before], repoPath);
    await run(["commit", "--allow-empty", "-m", "more"], repoPath);
    gitThatCannotEmptyTheList();

    const pushed = await pushBranch(repoPath, "bare", "eo/EO-1");

    expect(pushed).toMatchObject({ ok: true, updated: null });
    expect(await run(["rev-parse", "refs/heads/eo/EO-1"], other)).toBe(before);
  });

  it("refuses a lease, and pushes nothing, where it cannot hold the push to the URL it checked", async () => {
    const destination = (await pushDestination(repoPath, "bare"))!;
    gitThatCannotEmptyTheList();

    const pushed = await pushBranch(repoPath, "bare", "eo/EO-1", { lease: { commit: before, destination: destination.fingerprint } });

    expect(pushed).toMatchObject({ ok: false, diverged: false, leaseRefused: true });
    expect(await run(["rev-parse", "refs/heads/eo/EO-1"], barePath)).toBe(before);
    expect(await run(["rev-parse", "refs/heads/eo/EO-1"], other)).toBe(before);
  });
});
