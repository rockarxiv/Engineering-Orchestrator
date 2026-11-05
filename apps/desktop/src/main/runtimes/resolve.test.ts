import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUNTIMES, versionFor } from "./catalog.js";
import { resolveRuntime } from "./resolve.js";

/**
 * Finding an agent's executable (A-08).
 *
 * The order is the whole design: an explicit setting beats EO's exact
 * managed download, while PATH and provider-owned home installs are
 * deliberately ignored.
 */
let scratch: string;
let root: string;
let home: string;
let pathDir: string;

// The pinned versions, read off the catalog. Resolution's whole job is
// to find *the version EO pins* and ignore every other one, so naming it
// twice would let the two drift and quietly turn these into tests that
// the wrong directory is found.
const CLAUDE_VERSION = versionFor(RUNTIMES.claude, "linux", "x64")!;
const CODEX_VERSION = versionFor(RUNTIMES.codex, "linux", "x64")!;

function place(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const full = join(directory, name);
  writeFileSync(full, "#!/bin/sh\n");
  chmodSync(full, 0o755);
  return full;
}

function resolve(overrides: Parameters<typeof resolveRuntime>[0] extends infer T ? Partial<T> : never = {}) {
  return resolveRuntime({
    spec: RUNTIMES.claude,
    root,
    platform: "linux",
    arch: "x64",
    env: { PATH: pathDir },
    home,
    ...overrides,
  });
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo resolve "));
  root = join(scratch, "runtimes");
  home = join(scratch, "home");
  pathDir = join(scratch, "bin");
  mkdirSync(pathDir, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the order", () => {
  it("takes an explicit setting over everything else", () => {
    // The air-gapped answer, and the "I know better than you" answer.
    // Silently ignoring someone's own setting is worse than failing.
    place(join(root, `claude@${CLAUDE_VERSION}`), "claude");
    place(pathDir, "claude");

    const found = resolve({ configuredPath: "/opt/corp/claude" });

    expect(found).toEqual({ source: "configured", path: "/opt/corp/claude", version: null });
  });

  it("skips the managed copy when disabled without hiding an explicit setting", () => {
    place(join(root, `claude@${CLAUDE_VERSION}`), "claude");

    expect(resolve({ managedEnabled: false })).toEqual({ source: "absent", path: null, version: null });
    expect(resolve({ managedEnabled: false, configuredPath: "/opt/corp/claude" })).toEqual({
      source: "configured",
      path: "/opt/corp/claude",
      version: null,
    });
  });

  it("takes what EO downloaded over what is on PATH", () => {
    const cached = place(join(root, `claude@${CLAUDE_VERSION}`), "claude");
    place(pathDir, "claude");

    expect(resolve()).toEqual({ source: "cache", path: cached, version: CLAUDE_VERSION });
  });

  it("ignores a CLI on PATH so EO always uses its tested managed version", () => {
    place(pathDir, "claude");

    expect(resolve()).toEqual({ source: "absent", path: null, version: null });
  });

  it("reports absent rather than guessing", () => {
    expect(resolve()).toEqual({ source: "absent", path: null, version: null });
  });
});

describe("finding the binary", () => {
  it("digs it out of a vendor directory", () => {
    // Codex buries its executable several levels down, which is why
    // resolution searches for a name instead of a path.
    const codexRoot = join(root, `codex@${CODEX_VERSION}`, "vendor", "x86_64-unknown-linux-musl", "bin");
    const binary = place(codexRoot, "codex");

    const found = resolveRuntime({ spec: RUNTIMES.codex, root, platform: "linux", arch: "x64", env: { PATH: "" }, home });

    expect(found).toEqual({ source: "cache", path: binary, version: CODEX_VERSION });
  });

  // Unix only, and not an oversight: `isExecutable` falls back to plain
  // existence on Windows precisely because the bit it would test does not
  // exist there. "Present but not executable" is not a state Windows has.
  it.skipIf(process.platform === "win32")("ignores a file of the right name that is not executable", () => {
    mkdirSync(join(root, `claude@${CLAUDE_VERSION}`), { recursive: true });
    writeFileSync(join(root, `claude@${CLAUDE_VERSION}`, "claude"), "not executable");
    chmodSync(join(root, `claude@${CLAUDE_VERSION}`, "claude"), 0o644);

    expect(resolve().source).toBe("absent");
  });

  it("ignores provider-owned home-directory installs", () => {
    place(join(home, ".claude", "local"), "claude");

    expect(resolve()).toEqual({ source: "absent", path: null, version: null });
  });

  it("ignores a cache directory for a different version", () => {
    // A version EO no longer pins must not be silently used — that is
    // how someone ends up running a CLI nobody tested against.
    place(join(root, "claude@0.1.0"), "claude");

    expect(resolve().source).toBe("absent");
  });

  it("survives an unreadable directory instead of throwing", () => {
    const blocked = join(root, `claude@${CLAUDE_VERSION}`);
    mkdirSync(blocked, { recursive: true });
    chmodSync(blocked, 0o000);

    expect(() => resolve()).not.toThrow();

    chmodSync(blocked, 0o755);
  });
});
