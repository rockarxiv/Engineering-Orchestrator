import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushBranch } from "./git.js";
import { initRepo, run } from "../../../testing/git.js";

// Lets a test act between two of pushBranch's git commands: `before` is
// awaited ahead of every git invocation git.ts makes through its
// promisified execFile. Everything else passes straight through to the
// real git — the push goes to a real bare remote, with no hooks.
const between = vi.hoisted(() => ({ before: null as ((args: readonly string[]) => Promise<void>) | null }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const real = promisify(actual.execFile);
  const execFile = Object.assign((...args: Parameters<typeof actual.execFile>) => actual.execFile(...args), {
    [promisify.custom]: async (file: string, args: readonly string[], options: object) => {
      const before = between.before;
      if (before) await before(args);
      return real(file, args, options);
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
