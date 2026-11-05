import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { getSetting } from "../../../db/repos/index.js";
import { openMigratedTestDb } from "../../../db/testHelpers.js";
import {
  BRANCH_PREFIX_KEY,
  DEFAULT_BRANCH_PREFIX,
  branchPrefix,
  defaultBranchPrefixFromEmail,
  sanitizeBranchPrefix,
  setBranchPrefix,
} from "./branchPrefix.js";
import { globalUserEmail } from "./git.js";

/**
 * The global branch prefix (EO-14 / EO-15): seeded once from git config,
 * then a plain preference like `jiraPullMinutes` or `archiveAfterDays`.
 */
describe("sanitizeBranchPrefix", () => {
  it("leaves a clean lowercase local-part alone", () => {
    expect(sanitizeBranchPrefix("lyudvig")).toBe("lyudvig");
  });

  it("lowercases, and keeps dots and plus-addressing that are valid ref characters", () => {
    expect(sanitizeBranchPrefix("Lyudvig.P+test")).toBe("lyudvig.p+test");
  });

  it("strips spaces and the characters git refuses in a ref: ~^:?*[\\", () => {
    expect(sanitizeBranchPrefix("a b~c^d:e?f*g[h\\i")).toBe("abcdefghi");
  });

  it("collapses doubled . and / rather than deleting them outright", () => {
    expect(sanitizeBranchPrefix("a..b//c")).toBe("a.b/c");
  });

  it("trims leading, trailing and doubled . or / from the whole segment", () => {
    expect(sanitizeBranchPrefix("../.foo./..")).toBe("foo");
  });

  it("returns empty for empty input", () => {
    expect(sanitizeBranchPrefix("")).toBe("");
  });
});

describe("defaultBranchPrefixFromEmail", () => {
  it("takes the local part before @ and sanitizes it", () => {
    expect(defaultBranchPrefixFromEmail("Lyudvig.P+test@example.com")).toBe("lyudvig.p+test");
  });

  it("falls back to the eo default when there is no email", () => {
    expect(defaultBranchPrefixFromEmail(null)).toBe(DEFAULT_BRANCH_PREFIX);
  });

  it("falls back when the email is empty", () => {
    expect(defaultBranchPrefixFromEmail("")).toBe(DEFAULT_BRANCH_PREFIX);
  });

  it("falls back when the local part sanitizes away to nothing", () => {
    expect(defaultBranchPrefixFromEmail("~^:@example.com")).toBe(DEFAULT_BRANCH_PREFIX);
  });
});

describe("branchPrefix()", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("derives, persists and returns a default on the first read", async () => {
    const prefix = await branchPrefix(handle.db, async () => "Lyudvig.P+test@example.com");

    expect(prefix).toBe("lyudvig.p+test");
    expect(getSetting<{ prefix: string | null }>(handle.db, BRANCH_PREFIX_KEY, { prefix: null })).toEqual({
      prefix: "lyudvig.p+test",
    });
  });

  it("falls back to eo when git has no usable user.email", async () => {
    expect(await branchPrefix(handle.db, async () => null)).toBe(DEFAULT_BRANCH_PREFIX);
  });

  it("seeds once — a second read with a different (or unavailable) git config returns the persisted value unchanged", async () => {
    const first = await branchPrefix(handle.db, async () => "first@example.com");
    expect(first).toBe("first");

    // A different git config on the next read must not move it...
    expect(await branchPrefix(handle.db, async () => "second@example.com")).toBe("first");
    // ...and neither must git becoming unavailable.
    expect(await branchPrefix(handle.db, async () => null)).toBe("first");
  });

  it("is editable independently of git once set explicitly", async () => {
    await branchPrefix(handle.db, async () => "seeded@example.com");
    setBranchPrefix(handle.db, "acme");

    expect(await branchPrefix(handle.db, async () => "ignored@example.com")).toBe("acme");
  });
});

/**
 * The default wiring, against real git rather than a stub — same
 * discipline as `workspace/git.test.ts`: G-01 is specifically about these
 * invocations behaving against the real binary.
 *
 * `GIT_CONFIG_GLOBAL` (git 2.32+) points "global" config at a file in the
 * scratch directory instead of the real machine's, so this controls what
 * `git config --global user.email` reports without touching anything
 * outside the test.
 */
describe("branchPrefix() against real git", () => {
  let handle: DbHandle;
  let scratch: string;
  let configPath: string;

  beforeEach(() => {
    handle = openMigratedTestDb();
    scratch = mkdtempSync(join(tmpdir(), "eo-branch-prefix-"));
    configPath = join(scratch, "gitconfig");
  });

  afterEach(() => {
    handle.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("derives the prefix from a real global git config", async () => {
    writeFileSync(configPath, "[user]\n\temail = Lyudvig.P+test@example.com\n");
    const env = { GIT_CONFIG_GLOBAL: configPath };

    const prefix = await branchPrefix(handle.db, () => globalUserEmail(env));

    expect(prefix).toBe("lyudvig.p+test");
  });

  it("falls back to eo when the global config has no user.email", async () => {
    writeFileSync(configPath, "[core]\n\teditor = vi\n");
    const env = { GIT_CONFIG_GLOBAL: configPath };

    const prefix = await branchPrefix(handle.db, () => globalUserEmail(env));

    expect(prefix).toBe(DEFAULT_BRANCH_PREFIX);
  });
});
