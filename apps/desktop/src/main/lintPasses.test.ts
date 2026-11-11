import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Plan {
  heapMb: number;
  passes: { name: string; args: string[] }[];
}

function plan(): Plan {
  return JSON.parse(execFileSync(process.execPath, [join(appRoot, "scripts", "lint.mjs"), "--plan"], { encoding: "utf8" })) as Plan;
}

/** A pass's positional arguments: the paths it lints. */
function pathsOf(pass: { args: string[] }): string[] {
  const paths: string[] = [];
  for (let i = 0; i < pass.args.length; i++) {
    const arg = pass.args[i]!;
    if (arg === "--ignore-pattern") i++;
    else if (!arg.startsWith("--")) paths.push(arg);
  }
  return paths;
}

/** The tree a path belongs to, as eslint.config.js's type-aware entries divide the app. */
function treeOf(path: string): string {
  if (path === "playwright.config.ts" || path === "e2e" || path.startsWith("e2e/")) return "e2e";
  const [first, second] = path.split("/");
  return first === "src" && second !== undefined ? `src/${second}` : path;
}

/**
 * `pnpm lint` runs eslint in passes so that no process holds more than
 * one TypeScript program (EO-737). These checks make sure the split does
 * not lose files: every file the single `eslint .` linted is still in
 * exactly one pass, and no pass mixes trees that belong to different
 * tsconfigs.
 */
describe("lint passes", () => {
  it("is what pnpm lint runs, with no pass allowed more than 2,560 MB of heap", () => {
    const manifest = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts.lint).toBe("node scripts/lint.mjs");
    expect(plan().heapMb).toBeLessThanOrEqual(2560);
  });

  it("gives each type-aware tree in eslint.config.js passes of its own", () => {
    const config = readFileSync(join(appRoot, "eslint.config.js"), "utf8");
    const typedTrees = new Set(
      [...config.matchAll(/withTypeAwareRules\(\{[^\n]*files: \[([^\]]*)\]/g)].flatMap((match) =>
        [...match[1]!.matchAll(/"([^"]+)"/g)].map((glob) => treeOf(glob[1]!.replace(/\/\*\*.*$/, ""))),
      ),
    );
    // Non-vacuous: main, preload, renderer and e2e.
    expect([...typedTrees].sort()).toEqual(["e2e", "src/main", "src/preload", "src/renderer"]);

    const passTrees = new Set<string>();
    for (const pass of plan().passes.filter((pass) => pass.name !== "rest")) {
      const trees = new Set(pathsOf(pass).map(treeOf));
      expect(trees.size, pass.name).toBe(1);
      passTrees.add([...trees][0]!);
    }
    // A typed tree left to the last pass would put its program in the
    // same process as anything else typed that ends up there.
    expect([...passTrees].sort()).toEqual([...typedTrees].sort());
  });

  it("lints every top-level entry of src/main eslint would lint, in exactly one pass", () => {
    const expected = readdirSync(join(appRoot, "src", "main"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || [".ts", ".js", ".mjs", ".cjs", ".tsx", ".mts", ".cts"].includes(extname(entry.name)))
      .map((entry) => `src/main/${entry.name}`)
      .sort();
    const linted = plan()
      .passes.filter((pass) => pass.name.startsWith("main "))
      .flatMap(pathsOf);
    expect(linted.length).toBeGreaterThan(1);
    expect([...linted].sort()).toEqual(expected);
  });

  it("ends with everything else: the whole app minus exactly the trees the other passes lint", () => {
    const { passes } = plan();
    const rest = passes.at(-1)!;
    expect(rest.name).toBe("rest");
    expect(pathsOf(rest)).toEqual(["."]);
    const ignored = rest.args.flatMap((arg, i) => (rest.args[i - 1] === "--ignore-pattern" ? [arg] : []));
    const covered = new Set(
      passes
        .slice(0, -1)
        .flatMap(pathsOf)
        .map((path) => (path.startsWith("src/main/") ? "src/main" : path)),
    );
    expect(ignored.map((pattern) => pattern.replace(/\/\*\*$/, "")).sort()).toEqual([...covered].sort());
  });
});
