import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEWIKI } from "../binary/catalog.js";
import { resolveCodeWiki, type ResolveOptions } from "../binary/resolve.js";
import { runCodeWiki } from "./run.js";

/**
 * The binary EO fetched is the binary EO pinned (A-08).
 *
 * Everything else in `binary/` proves EO asks for v0.2.1 and refuses
 * bytes that do not match the published digest. None of it proves the
 * thing that actually came down the wire *is* v0.2.1 — only running it
 * does that, and the checksum says nothing about what the publisher
 * put behind the hash.
 *
 * So this runs it, through `runCodeWiki` (EO-143). Not `execFileSync`,
 * which is what this test used to do: there is exactly one place in
 * this codebase that spawns the CodeWiki binary, a test is not a
 * licence to be the second, and `importSites.test.ts` beside it scans
 * this file along with every other. It is also simply a better test
 * this way — what runs here is now the same wrapper a dispatch would
 * have used, argument handling and all, rather than something that
 * merely resembles it.
 *
 * Which is also why it sits here rather than beside the catalogue it
 * checks against: importing `run.js` is reaching for the
 * implementation, and `architecturalInvariants.test.ts` allows exactly
 * one directory to do that. A test that has to spawn CodeWiki is a
 * test that belongs in CodeWiki's own directory.
 *
 * It is skipped rather than failed when there is no binary, because
 * `pnpm test` must not require a 46 MB download and CI must not reach
 * the network. Point it at one to make it run:
 *
 *     EO_CODEWIKI_BIN=/path/to/codewiki pnpm exec vitest run --root apps/desktop \
 *       src/main/packs/developer/repositoryIntelligence/codewiki/version.test.ts
 *
 * or, against a real managed install, `EO_CODEWIKI_ROOT=<userData>/repositoryIntelligence`.
 */
const binary: ResolveOptions = {
  // An explicit path is exactly what `configured` is for, and it wins
  // here for the same reason it wins in production.
  configuredPath: process.env["EO_CODEWIKI_BIN"] ?? null,
  // Somewhere that reliably holds nothing, so an unset environment
  // resolves `absent` instead of picking up a stray directory.
  root: process.env["EO_CODEWIKI_ROOT"] ?? join(tmpdir(), "eo-codewiki-no-such-root"),
};

/**
 * Whether there is anything to run.
 *
 * Resolution is consulted directly for this and for nothing else — the
 * same options object is then handed to `runCodeWiki`, which resolves
 * again for itself, so what gets spawned is what a dispatch would have
 * spawned rather than a path this file picked out and passed along.
 */
const found = resolveCodeWiki(binary);
const present = found.path !== null && existsSync(found.path);

describe("the installed binary", () => {
  it.skipIf(!present)("answers --version with the version the catalogue pins", async () => {
    const result = await runCodeWiki({ binary, args: ["--version"], cwd: tmpdir(), timeoutMs: 30_000 });

    expect(result.status).toBe("ok");
    // Built from the catalogue rather than written out, so bumping the
    // pin is one edit and this fails if the download did not follow it.
    expect(result.stdout.trim()).toBe(`${CODEWIKI.id} ${CODEWIKI.version}`);
  });

  it.skipIf(!present)("was found by resolution rather than by looking on PATH", () => {
    // If this ever reports `absent` while `present` is true, resolution
    // and the spawn have drifted apart and the test above is proving
    // something about a binary EO would never run.
    expect(found.source).toBe(process.env["EO_CODEWIKI_BIN"] ? "configured" : "cache");
  });
});
