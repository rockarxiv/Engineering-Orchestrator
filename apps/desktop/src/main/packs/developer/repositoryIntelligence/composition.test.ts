import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { openMigratedTestDb } from "../../../db/testHelpers.js";
import { CODEWIKI } from "./binary/catalog.js";
import { repositoryIntelligenceFor } from "./composition.js";
import { writeRepositoryIntelligenceConfig } from "./gate.js";
import type { FetchLike } from "./binary/install.js";

/**
 * The second place a superseded copy is collected (EO-158).
 *
 * The install that supersedes one prunes it, and that is the ordinary
 * path. This file is about the one that refuses: on Windows a
 * superseded executable is locked open by the `serve --mcp` process of
 * a run that has not finished, so the delete fails and the copy is
 * still there afterwards. Without somewhere else to try, it would sit
 * on disk until the *next* version bump — which is the bug again, one
 * release later. `ensureInstalled` is that somewhere else, and it runs
 * on every item.
 *
 * The other half is the property that makes the collection safe, and it
 * is asserted here rather than assumed: nothing is removed until a
 * complete current version is actually on disk. A machine that pruned
 * before the replacement arrived would answer an offline update with no
 * repository intelligence at all, when the copy it deleted was working.
 *
 * Nothing here reaches the network: `fetchImpl` is a parameter, and the
 * cached-hit path is not supposed to use it at all.
 */

let handle: DbHandle;
let root: string;
let scratch: string;

/** A binary EO would resolve: right name for this platform, and executable. */
function install(version: string): string {
  const directory = join(root, `codewiki@${version}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, CODEWIKI.binaryName(process.platform)), "#!/bin/sh\n", { mode: 0o755 });
  return directory;
}

function leftovers(): string[] {
  return existsSync(root) ? readdirSync(root).sort() : [];
}

/** A network that would fail the test if anything asked it for bytes. */
const offline: FetchLike = () => {
  throw new Error("nothing on this path is allowed to reach the network");
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo codewiki composition "));
  root = join(scratch, "repositoryIntelligence");
  handle = openMigratedTestDb();
  writeRepositoryIntelligenceConfig(handle.db, { enabled: true });
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("ensuring the binary is installed", () => {
  it("collects a superseded copy the install that replaced it could not delete", async () => {
    install(CODEWIKI.version);
    install("0.1.9");

    const runtime = repositoryIntelligenceFor({ db: handle.db, root, fetchImpl: offline });
    const result = await runtime?.ensureInstalled();

    expect(result).toEqual({ ok: true });
    expect(leftovers()).toEqual([`codewiki@${CODEWIKI.version}`]);
  });

  it("leaves a superseded copy where it is when the pinned version is not on disk", async () => {
    // The precondition, as control flow: there is nothing to fall back
    // to yet, so an update that cannot be downloaded must leave the
    // machine with the repository intelligence it already had.
    const stale = install("0.1.9");

    const runtime = repositoryIntelligenceFor({
      db: handle.db,
      root,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const result = await runtime?.ensureInstalled();

    expect(result).toMatchObject({ ok: false });
    expect(existsSync(join(stale, CODEWIKI.binaryName(process.platform)))).toBe(true);
  });

  it("collects nothing and says nothing when the pinned version is the only one there", async () => {
    install(CODEWIKI.version);
    const said: string[] = [];

    const runtime = repositoryIntelligenceFor({ db: handle.db, root, fetchImpl: offline, onProgress: (text) => said.push(text) });

    expect(await runtime?.ensureInstalled()).toEqual({ ok: true });
    expect(leftovers()).toEqual([`codewiki@${CODEWIKI.version}`]);
    // Housekeeping that removed nothing has no business in an item's
    // transcript, and neither has a download that did not happen.
    expect(said).toEqual([]);
  });
});
