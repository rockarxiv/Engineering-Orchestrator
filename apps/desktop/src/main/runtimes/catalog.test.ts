import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNTIMES, versionFor } from "./catalog.js";
import { CLAUDE_SDK } from "./packages.js";

/**
 * That the pins agree with each other (EO-179).
 *
 * A backend is pinned in more places than one, and they are not
 * independent choices. For Claude they are three copies of a single
 * version line: `@anthropic-ai/claude-agent-sdk` in the workspace
 * catalog is the library EO compiles against,
 * `@anthropic-ai/claude-agent-sdk-<platform>` in `catalog.ts` is the CLI
 * binary that library drives, and `CLAUDE_SDK` in `packages.ts` is the
 * copy of that same library EO downloads and `import()`s at runtime
 * (because it may not be redistributed inside the installer). Anthropic
 * publishes them in lockstep. EO can still pin them apart, and did —
 * EO-179 found a 0.3.245 type surface over a 0.3.227 library over a
 * 0.3.227 binary, a combination nothing had ever run.
 *
 * Nothing catches that. The types come from `node_modules` and compile;
 * the library and the binary are fetched at runtime on a user's machine,
 * so a mismatch surfaces as someone else's stack trace long after the
 * release. The drift is silent by construction, which is why it is
 * asserted here rather than left to whoever does the next bump
 * remembering that there are three numbers and not one.
 *
 * The workspace catalog is read off `pnpm-workspace.yaml` rather than
 * imported: it is the one of the three that lives outside TypeScript, so
 * a test that does not read the file cannot see it drift.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

/** The pinned version of one catalog entry, straight out of the YAML. */
function workspaceCatalogPin(packageName: string): string {
  const yaml = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const match = new RegExp(`^\\s+"?${packageName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}"?:\\s*(\\S+)$`, "m").exec(yaml);
  if (!match?.[1]) throw new Error(`${packageName} is not pinned in pnpm-workspace.yaml`);
  return match[1].replace(/^["']|["']$/g, "");
}

describe("the pinned versions", () => {
  it("drives the Claude CLI with the library version it was published beside", () => {
    // The runtime pair: the library EO downloads and the binary it
    // drives. These are the two that actually run together on a user's
    // machine.
    expect(CLAUDE_SDK.version).toBe(RUNTIMES.claude.version);
    expect(CLAUDE_SDK.packages.find((pin) => pin.name === "@anthropic-ai/claude-agent-sdk")?.version).toBe(RUNTIMES.claude.version);
  });

  it("compiles against the Claude version it runs", () => {
    // The third copy, and the one that drifted: types that describe a
    // release EO never loads are types that describe nothing.
    expect(workspaceCatalogPin("@anthropic-ai/claude-agent-sdk")).toBe(RUNTIMES.claude.version);
  });

  it("pins Codex once, as the CLI it runs, with no library beside it to drift", () => {
    // Codex used to have two names for one release: `@openai/codex-sdk`
    // the library and `@openai/codex` the CLI, pinned in two files that
    // had to move together. EO speaks the CLI's app-server itself now
    // (EO-372), so the library is gone and the runtime pin is the only
    // one. A catalog entry coming back would be a second pin with nothing
    // holding it to the first.
    expect(() => workspaceCatalogPin("@openai/codex-sdk")).toThrow(/is not pinned/);
    // `versionFor` encodes the platform into the CLI's version rather
    // than its name.
    expect(versionFor(RUNTIMES.codex, "linux", "x64")).toBe(`${RUNTIMES.codex.version}-linux-x64`);
  });

  it("asks for the Codex pin's own build on every platform EO supports", () => {
    // Every one of these is a version of `@openai/codex` that has to
    // exist on the registry at the pin (EO-370 checked all six at
    // 0.161.0, EO-453 at 0.163.0, EO-599 at 0.165.0, EO-644 at 0.166.0).
    // Linux alone above
    // would let a platform
    // drift unseen.
    for (const platform of ["linux", "darwin", "win32"] as const) {
      for (const arch of ["x64", "arm64"]) {
        expect(versionFor(RUNTIMES.codex, platform, arch)).toBe(`${RUNTIMES.codex.version}-${platform}-${arch}`);
      }
    }
  });

  it("pins a stable release for every runtime", () => {
    // Both projects publish prereleases on the line EO pins —
    // `@openai/codex-sdk` had 0.152.0-alpha.4 out while 0.151.0 was
    // latest, back when EO still pinned it — and `versionFor` builds a platform suffix that looks like
    // one. A pin is a promise that somebody ran this build; an alpha is
    // the opposite of that promise.
    for (const spec of Object.values(RUNTIMES)) {
      expect(spec.version, `${spec.id} is pinned at a prerelease`).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(CLAUDE_SDK.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const pin of CLAUDE_SDK.packages) {
      expect(pin.version, `${pin.name} is pinned at a prerelease`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("names an exact version rather than a dist-tag, everywhere it fetches", () => {
    // `latest` is what the comment in catalog.ts exists to forbid: it
    // would put someone else's release schedule in charge of what every
    // user runs. Asserted as a property of the pins themselves, since
    // `resolveRelease` looks up `versions[version]` and a dist-tag would
    // simply not be found.
    for (const spec of Object.values(RUNTIMES)) {
      expect(spec.version).not.toBe("latest");
    }
    for (const pin of CLAUDE_SDK.packages) {
      expect(pin.version).not.toBe("latest");
    }
  });
});
