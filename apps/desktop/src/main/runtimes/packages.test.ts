import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureTar } from "../testing/tar.js";
import type { FetchLike } from "./install.js";
import { CLAUDE_SDK, installPackageSet, resolvePackageSet, type PackageSetSpec } from "./packages.js";

/**
 * Fetching the SDK rather than shipping it (A-08).
 *
 * The library half of the story. Removing the 275 MB binary took the
 * weight out of the installer but not the legal question — the SDK's own
 * JavaScript is "© Anthropic PBC. All rights reserved" too — so this
 * path has to work before anything can be sold.
 *
 * What is worth testing is not the download. It is that the result is
 * *loadable*: a library that lands in the wrong shape fails later, from
 * inside a file nobody here wrote.
 */
let scratch: string;
let root: string;

function tarballOf(files: Record<string, string>): Buffer {
  const source = join(scratch, "pkg", "package");
  rmSync(join(scratch, "pkg"), { recursive: true, force: true });
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(source, path, ".."), { recursive: true });
    writeFileSync(join(source, path), contents);
  }
  execFileSync(fixtureTar(), ["-czf", join(scratch, "p.tgz"), "-C", join(scratch, "pkg"), "package"]);
  return execFileSync("cat", [join(scratch, "p.tgz")], { encoding: "buffer" });
}

/** A registry serving a different body per package, with honest hashes. */
function registry(bodies: Record<string, Buffer>, tamper?: string): FetchLike {
  return async (url) => {
    for (const [name, bytes] of Object.entries(bodies)) {
      if (url.endsWith(`/${encodeURIComponent(name)}.tgz`)) {
        return new Response(name === tamper ? Buffer.concat([bytes, Buffer.from("x")]) : bytes, { status: 200 });
      }
      if (url.includes(name.replace("/", "%2F")) && !url.endsWith(".tgz")) {
        return new Response(
          JSON.stringify({
            versions: {
              "1.0.0": {
                dist: {
                  tarball: `https://registry.npmjs.org/${encodeURIComponent(name)}.tgz`,
                  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
                  unpackedSize: bytes.length,
                },
              },
            },
          }),
          { status: 200 },
        );
      }
    }
    return new Response("no such package", { status: 404 });
  };
}

const SPEC: PackageSetSpec = {
  id: "test-sdk",
  label: "Test SDK",
  publisher: "Nobody",
  termsUrl: "https://example.com/terms",
  version: "1.0.0",
  entry: join("node_modules", "@scope", "main", "index.mjs"),
  packages: [
    { name: "@scope/main", version: "1.0.0" },
    { name: "helper", version: "1.0.0" },
  ],
};

const BODIES = () => ({
  "@scope/main": tarballOf({ "index.mjs": "export { value } from 'helper';\n", "package.json": '{"name":"@scope/main","type":"module"}' }),
  helper: tarballOf({ "index.mjs": "export const value = 42;\n", "package.json": '{"name":"helper","type":"module","main":"index.mjs"}' }),
});

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo pkgset "));
  root = join(scratch, "runtimes");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("installing a set", () => {
  it("lays the packages out so Node can actually resolve between them", async () => {
    // The whole point of installing a closure rather than one package:
    // sdk.mjs imports ajv by bare specifier, and a lone package in a
    // directory produces a module that throws on import. Proved by
    // importing the result, not by inspecting the directory.
    const bodies = BODIES();
    const result = await installPackageSet({ spec: SPEC, root, fetchImpl: registry(bodies) });

    expect(result).toMatchObject({ ok: true, problem: null });
    const loaded = (await import(result.entryPath!)) as { value: number };
    expect(loaded.value).toBe(42);
  });

  it("reports where the entry landed, and finds it again afterwards", async () => {
    const result = await installPackageSet({ spec: SPEC, root, fetchImpl: registry(BODIES()) });

    expect(result.entryPath).toBe(join(root, "test-sdk@1.0.0", SPEC.entry));
    expect(resolvePackageSet(root, SPEC)).toBe(result.entryPath);
  });

  it("finds nothing before anything is installed", () => {
    expect(resolvePackageSet(root, SPEC)).toBeNull();
  });

  it("reports progress per package, so a seven-package fetch is not a frozen dialog", async () => {
    const seen: [number, number][] = [];
    await installPackageSet({ spec: SPEC, root, fetchImpl: registry(BODIES()), onProgress: (d, t) => seen.push([d, t]) });

    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

describe("when something is wrong", () => {
  it("discards the whole set when any one package fails its checksum", async () => {
    // Not just the bad package: a set missing one member resolves and
    // then throws from inside someone else's code, which is a worse
    // failure than not being installed at all.
    const result = await installPackageSet({ spec: SPEC, root, fetchImpl: registry(BODIES(), "helper") });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("checksum");
    expect(existsSync(join(root, "test-sdk@1.0.0"))).toBe(false);
  });

  it("refuses a set whose entry module is not where the spec says", async () => {
    const spec = { ...SPEC, entry: join("node_modules", "@scope", "main", "nope.mjs") };

    const result = await installPackageSet({ spec, root, fetchImpl: registry(BODIES()) });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("did not contain");
  });

  it("leaves nothing a later resolve would mistake for a working install", async () => {
    await installPackageSet({ spec: SPEC, root, fetchImpl: registry(BODIES(), "helper") });

    const leftovers = existsSync(root) ? readdirSync(root) : [];
    expect(leftovers).toEqual([]);
  });

  it("reports a registry that will not answer rather than throwing", async () => {
    const result = await installPackageSet({ spec: SPEC, root, fetchImpl: async () => new Response("", { status: 503 }) });

    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/503|registry/);
  });
});

describe("the Claude set", () => {
  it("pins every package, because an unpinned one lands on users untested", () => {
    for (const pin of CLAUDE_SDK.packages) {
      expect(pin.version, pin.name).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("carries the dependencies sdk.mjs imports by bare specifier", () => {
    // These are not declared dependencies of the SDK — they arrive
    // through @modelcontextprotocol/sdk, which is a peer. Once the SDK
    // no longer lives in EO's tree, providing them becomes this list's
    // job, and dropping one produces a module that will not import.
    const names = CLAUDE_SDK.packages.map((pin) => pin.name);

    expect(names).toContain("@anthropic-ai/claude-agent-sdk");
    expect(names).toContain("ajv");
    expect(names).toContain("ajv-formats");
  });

  it("points at the SDK's real entry point", () => {
    expect(CLAUDE_SDK.entry).toContain(join("@anthropic-ai", "claude-agent-sdk", "sdk.mjs"));
  });
});
